import Foundation
import CZephyrLink
import ZephyrContracts

/// A binding owns one in-process Go node. No child process, listener, raw key or exporter is
/// exposed to Swift. The serial queue preserves native handle lifetime while C/network work runs.
protocol AppleLinkCalling: Sendable {
    func call(path: String, body: [String: MobileJSONValue]) async throws -> [String: MobileJSONValue]
    func close() async
}

final class AppleLinkNativeRuntime: AppleLinkCalling, @unchecked Sendable {
    private let queue = DispatchQueue(label: "one.zephyr.link.native", qos: .utility)
    private var handle: UInt64

    init() throws {
        handle = ZephyrLinkCreate()
        guard handle != 0 else { throw LinkChannelError(message: "Link runtime capacity exhausted", retryable: false) }
    }

    func call(path: String, body: [String: MobileJSONValue]) async throws -> [String: MobileJSONValue] {
        try Task.checkCancellation()
        return try await withCheckedThrowingContinuation { continuation in
            queue.async {
                do {
                    guard self.handle != 0 else { throw LinkChannelError(message: "Link runtime closed", retryable: false) }
                    var data = try JSONEncoder().encode(body)
                    defer { data.resetBytes(in: data.startIndex..<data.endIndex) }
                    guard data.count <= 8 * 1024 * 1024 else { throw LinkChannelError(message: "Link request too large", retryable: false) }
                    let pointer = path.withCString { route in
                        data.withUnsafeBytes { bytes in
                            ZephyrLinkCall(self.handle, route, bytes.bindMemory(to: CChar.self).baseAddress, Int32(data.count))
                        }
                    }
                    guard let pointer else { throw LinkChannelError(message: "Link runtime rejected request", retryable: false) }
                    defer { ZephyrLinkFree(pointer) }
                    let envelope = try JSONDecoder().decode(NativeReply.self, from: Data(bytes: pointer, count: strlen(pointer)))
                    guard (200..<300).contains(envelope.status) else {
                        throw Self.failure(envelope.body)
                    }
                    continuation.resume(returning: envelope.body)
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    func close() async {
        await withCheckedContinuation { continuation in
            queue.async {
                if self.handle != 0 { ZephyrLinkDestroy(self.handle); self.handle = 0 }
                continuation.resume()
            }
        }
    }

    deinit {
        // Outstanding queue closures retain self; the last release cannot race an in-flight call.
        if handle != 0 { ZephyrLinkDestroy(handle) }
    }

    static func buildInfo() throws -> [String: MobileJSONValue] {
        guard let pointer = ZephyrLinkBuildInfo() else { throw LinkChannelError(message: "Missing native build identity", retryable: false) }
        defer { ZephyrLinkFree(pointer) }
        return try JSONDecoder().decode([String: MobileJSONValue].self, from: Data(bytes: pointer, count: strlen(pointer)))
    }

    private struct NativeReply: Decodable {
        let status: Int
        let body: [String: MobileJSONValue]
    }

    private static func failure(_ body: [String: MobileJSONValue]) -> LinkChannelError {
        guard case .object(let detail)? = body["error"] else { return LinkChannelError(message: "Invalid Link native response", retryable: false) }
        let code: String
        if case .string(let value)? = detail["code"] { code = value } else { code = "link_unavailable" }
        let retryable = detail["retryable"] == .boolean(true)
        // No native provider/TLS errors or body contents are surfaced to UI/logs.
        return LinkChannelError(message: "Link request failed", code: code, retryable: retryable)
    }
}

/// Shared synchronous fence is checked before/after every suspension and by the signing closure.
private final class AppleLinkFence: @unchecked Sendable {
    private let lock = NSLock()
    private var accepting = true
    private var established = false
    func requireLive() throws {
        lock.lock(); defer { lock.unlock() }
        guard accepting else { throw LinkChannelError(message: "Link binding ended", retryable: false) }
    }
    var isEstablished: Bool { lock.lock(); defer { lock.unlock() }; return accepting && established }
    func setEstablished(_ value: Bool) { lock.lock(); established = value; lock.unlock() }
    func disable() { lock.lock(); accepting = false; established = false; lock.unlock() }
}

public final class AppleLinkChannel: LinkChannel, @unchecked Sendable {
    private let fence: AppleLinkFence
    private let state: AppleLinkChannelState
    public var isEstablished: Bool { fence.isEstablished }

    init(serverURL: String, deviceID: String, pins: [String],
         native: any AppleLinkCalling,
         sign: @escaping @Sendable (Data) throws -> String) throws {
        guard let base = URL(string: serverURL), base.scheme == "https", base.host != nil,
              base.user == nil, base.password == nil, base.query == nil, base.fragment == nil else {
            throw LinkChannelError(message: "Canonical HTTPS Link origin required", retryable: false)
        }
        let root = base.appendingPathComponent("api/link/v2").absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let gate = AppleLinkFence()
        fence = gate
        state = AppleLinkChannelState(peerURL: root, deviceID: deviceID, pins: pins, native: native, fence: gate, sign: sign)
    }

    public func syncOp(op: String, body: [String: MobileJSONValue]) async throws -> [String: MobileJSONValue] {
        try fence.requireLive()
        return try await state.syncOp(op: op, body: body)
    }
    func disable() { fence.disable() }
    func close() async { fence.disable(); await state.close() }
}

private actor AppleLinkChannelState {
    private let peerURL: String
    private let deviceID: String
    private let pins: [String]
    private let native: any AppleLinkCalling
    private let fence: AppleLinkFence
    private let sign: @Sendable (Data) throws -> String
    private var sessionID: String?
    // Actors are reentrant across await. An explicit FIFO tail serializes the whole dial/push,
    // not just individual actor segments, so two requests cannot race sequence numbers.
    private var tail: Task<Void, Never>?

    init(peerURL: String, deviceID: String, pins: [String], native: any AppleLinkCalling,
         fence: AppleLinkFence, sign: @escaping @Sendable (Data) throws -> String) {
        self.peerURL = peerURL; self.deviceID = deviceID; self.pins = pins
        self.native = native; self.fence = fence; self.sign = sign
    }

    func syncOp(op: String, body: [String: MobileJSONValue]) async throws -> [String: MobileJSONValue] {
        let previous = tail
        let next = Task { () throws -> [String: MobileJSONValue] in
            await previous?.value
            try Task.checkCancellation()
            return try await self.perform(op: op, body: body)
        }
        tail = Task { _ = try? await next.value }
        return try await withTaskCancellationHandler(operation: { try await next.value }, onCancel: { next.cancel() })
    }

    private func perform(op: String, body: [String: MobileJSONValue]) async throws -> [String: MobileJSONValue] {
        try fence.requireLive()
        try Task.checkCancellation()
        guard ["bootstrap", "changes", "push", "ack"].contains(op), body["op"] == .string(op) else {
            throw LinkChannelError(message: "Invalid owned-sync operation", retryable: false)
        }
        let id: String
        if let sessionID { id = sessionID } else {
            let hello = try await native.call(path: "/link/dial", body: [
                "serverUrl": .string(peerURL), "deviceId": .string(deviceID),
                "spkiPins": .array(pins.map(MobileJSONValue.string)), "insecure": .boolean(false),
            ])
            try fence.requireLive()
            try Task.checkCancellation()
            let pendingID = try Self.string(hello, "sessionId")
            // Enrolled production server must require proof. An unproven server is not silently
            // accepted even if a test/legacy Node is willing to finish in one round trip.
            guard hello["pending"] == .boolean(true) else {
                throw LinkChannelError(message: "Link server did not require device proof", code: "proof_required", retryable: false)
            }
            let encoded = try Self.string(hello, "transcript")
            var padded = encoded.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
            padded += String(repeating: "=", count: (4 - padded.count % 4) % 4)
            guard let transcript = Data(base64Encoded: padded), transcript.count == 32 else {
                throw LinkChannelError(message: "Invalid Link transcript", retryable: false)
            }
            let proof = try sign(transcript)
            let finished = try await native.call(path: "/link/dial/finish", body: ["sessionId": .string(pendingID), "proof": .string(proof)])
            try fence.requireLive()
            try Task.checkCancellation()
            id = try Self.string(finished, "sessionId")
            guard id == pendingID else { throw LinkChannelError(message: "Link handshake identity changed", retryable: false) }
            sessionID = id
            fence.setEstablished(true)
        }
        do {
            let result = try await native.call(path: "/link/push", body: [
                "sessionId": .string(id), "peerUrl": .string(peerURL),
                "kind": .integer(Int64(LinkKinds.syncOp)), "body": .object(body), "secret": .boolean(false),
            ])
            try fence.requireLive()
            try Task.checkCancellation()
            guard result["ackKind"] == .integer(Int64(LinkKinds.syncAck)), case .object(let ack)? = result["ack"] else {
                throw LinkChannelError(message: "Invalid Link acknowledgement", retryable: false)
            }
            return ack
        } catch {
            // Do not replay an ambiguous push automatically. The next sync round redials and uses
            // the persisted operation IDs/batch identity for business-level deduplication.
            sessionID = nil
            fence.setEstablished(false)
            throw error
        }
    }

    func close() async {
        fence.disable()
        await tail?.value
        sessionID = nil
        tail = nil
        await native.close()
    }

    private static func string(_ body: [String: MobileJSONValue], _ key: String) throws -> String {
        guard body["ok"] == .boolean(true), case .string(let value)? = body[key], !value.isEmpty else {
            throw LinkChannelError(message: "Invalid Link handshake response", retryable: false)
        }
        return value
    }
}
