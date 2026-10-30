import Foundation
import ZephyrContracts

/// The Link v2 wire kind registry values this transport uses. These are business frame kinds, not
/// cryptographic primitives — the Swift side names the lane, the embedded Go core owns sealing.
/// The integers must match zephyr-link/internal/codec/codec.go and link-v2-codec.js exactly.
public enum LinkKinds {
    public static let syncOp = 1
    public static let syncAck = 2
}

/// The narrow channel a Link-backed transport needs. The app layer implements this over the
/// embedded Go Link process (dial + push on an established ZSL/2 session). ZephyrCore depends only
/// on this abstraction, so the dependency direction stays app -> ZephyrCore, never the reverse.
///
/// Wire shape: one SYNC_OP frame whose body carries an `op` discriminator plus the operation
/// payload, answered by a sealed SYNC_ACK carrying the business result. Every client (browser,
/// mobile, desktop) runs the same op vocabulary against the same server-side sync core, so the
/// interface stays standard.
public protocol LinkChannel: Sendable {
    /// Whether a ZSL/2 session to the server is currently established.
    var isEstablished: Bool { get }

    /// Push one owned-sync verb and return the business ack body. Throws ``LinkChannelError`` on a
    /// transport/sealing failure; a business rejection arrives as a normal ack body the transport
    /// maps onto ``MobileApiError``.
    func syncOp(op: String, body: [String: MobileJSONValue]) async throws -> [String: MobileJSONValue]
}

/// Transport/sealing failure on the Link channel. A business rejection is not this type: those
/// arrive as `{ok:false,error:{code,...}}` ack bodies and become ``MobileApiError`` with the
/// original code.
public struct LinkChannelError: Error, Equatable, Sendable, LocalizedError {
    public let message: String
    public let code: String
    public let retryable: Bool
    public let details: [String: String]

    public init(
        message: String,
        code: String = "link_unavailable",
        retryable: Bool = true,
        details: [String: String] = [:]
    ) {
        self.message = message
        self.code = code
        self.retryable = retryable
        self.details = details
    }

    public var errorDescription: String? { message }
}

/// ``SyncTransport`` over the Zephyr Link channel (ZSL/2). One clients carry data sync on the
/// encrypted channel end to end rather than plaintext HTTPS, satisfying the security model: the
/// browser is the only client that falls back to HTTPS. The ``SyncEngine`` state machine is reused
/// unchanged — only the transport differs — and every verb encodes/decodes the SAME DTO wire shape
/// as the HTTP path, so there is exactly one sync implementation and one wire contract.
///
/// Capabilities remains HTTPS discovery because it precedes a session. Bootstrap, changes, push
/// and ack all ride owned-sync so every account payload and every business error stays inside ZSL.
///
/// Field-name exception: iOS HTTPS `changes` uses the query key `cursor`, but the Go/Node Link
/// bridge (`link-v2-sync-bridge.js` → `executeChangesForDevice`) reads `sinceCursor`. The ZSL body
/// therefore uses the Android/server name. Bootstrap uses `pageSize` for the same reason (HTTP GET
/// on iOS sends `limit`).
public final class LinkSyncTransport: SyncTransport, @unchecked Sendable {
    private let channel: any LinkChannel
    private let deviceId: String
    private let httpFallback: any SyncTransport

    public init(
        channel: any LinkChannel,
        deviceId: String,
        httpFallback: any SyncTransport
    ) {
        self.channel = channel
        self.deviceId = deviceId
        self.httpFallback = httpFallback
    }

    public func capabilities() async throws -> MobileCapabilitiesResponse {
        try await httpFallback.capabilities()
    }

    public func bootstrap(pageToken: String?, limit: Int?) async throws -> MobileBootstrapResponse {
        try await runLink {
            var body: [String: MobileJSONValue] = [:]
            if let pageToken { body["pageToken"] = .string(pageToken) }
            if let limit { body["pageSize"] = .integer(Int64(limit)) }
            let ack = try Self.requireSuccessAck(
                try await channel.syncOp(op: "bootstrap", body: Self.wireBody(op: "bootstrap", body: body))
            )
            return try Self.decode(MobileBootstrapResponse.self, from: ack)
        }
    }

    public func changes(cursor: Int64, limit: Int?) async throws -> MobileChangesResponse {
        try await runLink {
            var body: [String: MobileJSONValue] = [
                "sinceCursor": .integer(cursor),
            ]
            if let limit { body["limit"] = .integer(Int64(limit)) }
            let ack = try Self.requireSuccessAck(
                try await channel.syncOp(op: "changes", body: Self.wireBody(op: "changes", body: body))
            )
            return try Self.decode(MobileChangesResponse.self, from: ack)
        }
    }

    public func push(_ request: MobilePushRequest) async throws -> MobilePushResponse {
        try await runLink {
            // Align deviceId with the bound identity the same way Android rebuilds PushRequestDto
            // from the constructor deviceId. Remaining fields are the exact HTTPS DTO.
            let aligned = MobilePushRequest(
                protocolVersion: request.protocolVersion,
                deviceId: self.deviceId,
                batchId: request.batchId,
                baseCursor: request.baseCursor,
                registryHash: request.registryHash,
                operations: request.operations
            )
            let body = try Self.jsonObject(from: aligned)
            let ack = try Self.requireSuccessAck(
                try await channel.syncOp(op: "push", body: Self.wireBody(op: "push", body: body))
            )
            return try Self.decode(MobilePushResponse.self, from: ack)
        }
    }

    public func ack(_ request: MobileAckRequest) async throws -> MobileAckResponse {
        try await runLink {
            let body = try Self.jsonObject(from: request)
            let ack = try Self.requireSuccessAck(
                try await channel.syncOp(op: "ack", body: Self.wireBody(op: "ack", body: body))
            )
            return try Self.decode(MobileAckResponse.self, from: ack)
        }
    }

    /// `{ok:false}` is the only failure shape. Missing `ok` is treated as success so a business
    /// payload that omitted the flag still decodes — matching Android `ack["ok"] != false`.
    private static func requireSuccessAck(
        _ ack: [String: MobileJSONValue]
    ) throws -> [String: MobileJSONValue] {
        if ack["ok"] != .boolean(false) { return ack }
        guard case .object(let error)? = ack["error"] else {
            throw LinkSyncTransportError.unparseable
        }
        guard case .string(let code)? = error["code"], !code.isEmpty else {
            throw LinkSyncTransportError.unparseable
        }
        let message: String
        if case .string(let text)? = error["message"], !text.isEmpty {
            message = text
        } else {
            message = "同步请求失败"
        }
        let retryable: Bool
        switch error["retryable"] {
        case .boolean(let flag)?:
            retryable = flag
        case .string("true")?:
            retryable = true
        case .string("false")?:
            retryable = false
        default:
            retryable = false
        }
        var details: [String: String] = [:]
        if case .object(let raw)? = error["details"] {
            for (key, value) in raw {
                details[key] = diagnosticString(value)
            }
        }
        throw LinkChannelError(message: message, code: code, retryable: retryable, details: details)
    }

    private static func wireBody(
        op: String,
        body: [String: MobileJSONValue]
    ) throws -> [String: MobileJSONValue] {
        var wired: [String: MobileJSONValue] = ["op": .string(op)]
        for (key, value) in body {
            if key == "op", value != .string(op) {
                throw LinkSyncTransportError.unparseable
            }
            wired[key] = value
        }
        return wired
    }

    private func runLink<T>(_ body: () async throws -> T) async throws -> T {
        // Do NOT gate on channel.isEstablished here. The channel dials lazily inside syncOp —
        // checking isEstablished before calling it would reject the first-ever sync round
        // (session starts as null) and the Link transport would never dial at all.
        do {
            return try await body()
        } catch let error as CancellationError {
            throw error
        } catch let error as MobileApiError {
            throw error
        } catch let error as LinkChannelError {
            throw MobileApiError(
                code: error.code,
                message: error.message.isEmpty ? "Link 通道失败" : error.message,
                retryable: error.retryable,
                requestId: nil,
                details: error.details
            )
        } catch is LinkSyncTransportError {
            throw Self.unparseableError
        } catch is DecodingError {
            throw Self.unparseableError
        } catch {
            throw MobileApiError.local(
                code: "link_unavailable",
                message: error.localizedDescription.isEmpty ? "Link 通道失败" : error.localizedDescription,
                retryable: true
            )
        }
    }

    private static var unparseableError: MobileApiError {
        MobileApiError.local(
            code: "link_unavailable",
            message: "Link 返回了无法解析的响应",
            retryable: false
        )
    }

    private static func jsonObject(from value: some Encodable) throws -> [String: MobileJSONValue] {
        let data: Data
        do {
            data = try JSONEncoder().encode(value)
        } catch {
            throw MobileApiError.local(
                code: "invalid_request",
                message: "The request could not be encoded",
                retryable: false
            )
        }
        return try JSONDecoder().decode([String: MobileJSONValue].self, from: data)
    }

    private static func decode<Value: Decodable>(
        _ type: Value.Type,
        from object: [String: MobileJSONValue]
    ) throws -> Value {
        let data = try JSONEncoder().encode(object)
        return try JSONDecoder().decode(type, from: data)
    }

    private static func diagnosticString(_ value: MobileJSONValue) -> String {
        switch value {
        case .string(let text): return text
        case .integer(let number): return String(number)
        case .number(let number): return String(number)
        case .boolean(let flag): return flag ? "true" : "false"
        case .null: return "null"
        case .object, .array:
            if let data = try? JSONEncoder().encode(value),
               let text = String(data: data, encoding: .utf8) {
                return text
            }
            return "<structured>"
        }
    }
}

private enum LinkSyncTransportError: Error {
    case unparseable
}
