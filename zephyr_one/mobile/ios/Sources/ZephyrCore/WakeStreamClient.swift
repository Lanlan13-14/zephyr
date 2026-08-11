import Foundation
import ZephyrContracts

public enum WakeReason: String, Codable, Equatable, Sendable {
    case change
    case manual
    case reconcile
    case connected
    case reconnect
    case epochChanged = "epoch_changed"
}

/// Payload-free hint from the authenticated, owner-scoped wake stream.
public struct WakeStreamEvent: Equatable, Sendable {
    public let cursor: Int64
    public let epoch: String
    public let reason: WakeReason
    public let eventID: String

    public init(cursor: Int64, epoch: String, reason: WakeReason, eventID: String) {
        self.cursor = cursor
        self.epoch = epoch
        self.reason = reason
        self.eventID = eventID
    }
}

/// Why a stream ended and which server-provided delay should win on reconnect.
public struct WakeStreamOutcome: Equatable, Sendable {
    public let connected: Bool
    public let retryAfterMilliseconds: Int64?
    public let serverRetryMilliseconds: Int64?
    public let failureCode: String?

    public init(
        connected: Bool = false,
        retryAfterMilliseconds: Int64? = nil,
        serverRetryMilliseconds: Int64? = nil,
        failureCode: String? = nil
    ) {
        self.connected = connected
        self.retryAfterMilliseconds = retryAfterMilliseconds
        self.serverRetryMilliseconds = serverRetryMilliseconds
        self.failureCode = failureCode
    }
}

public protocol WakeStreamTransport: Sendable {
    func open(
        lastEventID: String?,
        onWake: @escaping @Sendable (WakeStreamEvent) async -> Void
    ) async -> WakeStreamOutcome
}

public enum WakeStreamConfigurationError: Error, Equatable, Sendable {
    case invalidHeartbeatTimeout
}

/// Long-lived SSE transport for the mobile wake endpoint.
///
/// Every connection obtains a new v2 proof through `MobileApiClient`; this type
/// never handles private key material or converts signatures. The target request
/// is then sent through that client's same-origin, redirect-refusing pinned session.
public final class WakeStreamClient: WakeStreamTransport, @unchecked Sendable {
    public static let maximumLineBytes = 64 * 1024
    public static let maximumEventDataBytes = 16 * 1024
    public static let maximumErrorBodyBytes = 64 * 1024

    private let apiClient: MobileApiClient
    private let heartbeatTimeout: TimeInterval
    private let now: @Sendable () -> Date

    public init(
        apiClient: MobileApiClient,
        heartbeatTimeout: TimeInterval = 45,
        now: @escaping @Sendable () -> Date = { Date() }
    ) throws {
        guard heartbeatTimeout.isFinite, heartbeatTimeout > 0 else {
            throw WakeStreamConfigurationError.invalidHeartbeatTimeout
        }
        self.apiClient = apiClient
        self.heartbeatTimeout = heartbeatTimeout
        self.now = now
    }

    public func open(
        lastEventID: String?,
        onWake: @escaping @Sendable (WakeStreamEvent) async -> Void
    ) async -> WakeStreamOutcome {
        do {
            var request = URLRequest(url: wakeURL())
            request.httpMethod = "GET"
            request.cachePolicy = .reloadIgnoringLocalCacheData
            request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
            request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
            if let lastEventID, Self.isSafeEventID(lastEventID) {
                request.setValue(lastEventID, forHTTPHeaderField: "Last-Event-ID")
            }

            var authorized = try await apiClient.authorizeDeviceProofRequest(request)
            authorized.timeoutInterval = heartbeatTimeout
            let (bytes, response) = try await apiClient.streamingSession.bytes(for: authorized)
            guard let http = response as? HTTPURLResponse else {
                return WakeStreamOutcome(failureCode: "malformed_wake_response")
            }

            let retryAfter = Self.retryAfterMilliseconds(http, now: now())
            if (300..<400).contains(http.statusCode) {
                return WakeStreamOutcome(
                    retryAfterMilliseconds: retryAfter,
                    failureCode: "unexpected_redirect"
                )
            }
            guard (200..<300).contains(http.statusCode) else {
                var body = Data()
                for try await byte in bytes {
                    guard body.count < Self.maximumErrorBodyBytes else { break }
                    body.append(byte)
                }
                let code = (try? JSONDecoder().decode(MobileErrorEnvelope.self, from: body))?.error.code
                return WakeStreamOutcome(
                    retryAfterMilliseconds: retryAfter,
                    failureCode: code ?? Self.failureCode(for: http.statusCode)
                )
            }

            let contentType = http.value(forHTTPHeaderField: "Content-Type")?.lowercased() ?? ""
            guard contentType.hasPrefix("text/event-stream") else {
                return WakeStreamOutcome(
                    retryAfterMilliseconds: retryAfter,
                    failureCode: "malformed_wake_stream"
                )
            }

            var lineDecoder = WakeSSELineDecoder(maximumBytes: Self.maximumLineBytes)
            var parser = WakeSSEParser(maximumDataBytes: Self.maximumEventDataBytes)
            for try await byte in bytes {
                if let line = try lineDecoder.append(byte) {
                    if let event = parser.accept(line) { await onWake(event) }
                }
            }
            if let line = try lineDecoder.finish(), let event = parser.accept(line) {
                await onWake(event)
            }
            return WakeStreamOutcome(
                connected: true,
                retryAfterMilliseconds: retryAfter,
                serverRetryMilliseconds: parser.retryMilliseconds
            )
        } catch is CancellationError {
            return WakeStreamOutcome(failureCode: "cancelled")
        } catch let error as MobileApiError {
            return WakeStreamOutcome(
                retryAfterMilliseconds: error.retryAfterSeconds.map(Self.milliseconds),
                failureCode: error.code
            )
        } catch {
            return WakeStreamOutcome(failureCode: Task.isCancelled ? "cancelled" : "wake_transport_failed")
        }
    }

    private func wakeURL() -> URL {
        var url = apiClient.baseURL
        for segment in MobileApiPaths.getMobileV1SyncWake.split(separator: "/", omittingEmptySubsequences: true) {
            url = url.appendingPathComponent(String(segment), isDirectory: false)
        }
        return url
    }

    private static func failureCode(for status: Int) -> String {
        switch status {
        case 401, 403: return "wake_unauthorized"
        case 429: return "wake_rate_limited"
        case 500...599: return "wake_server_error"
        default: return "unexpected_wake_status"
        }
    }

    fileprivate static func isSafeEventID(_ value: String) -> Bool {
        guard !value.isEmpty, value.utf8.count <= 160,
              let separator = value.lastIndex(of: ":"), separator != value.startIndex else {
            return false
        }
        let epoch = String(value[..<separator])
        let cursor = value[value.index(after: separator)...]
        return WakeSSEParser.isSafeEpoch(epoch) && !cursor.isEmpty &&
            cursor.utf8.allSatisfy { (48...57).contains($0) } && Int64(cursor) != nil
    }

    private static func milliseconds(_ seconds: Int64) -> Int64 {
        let nonnegative = max(0, seconds)
        return nonnegative > Int64.max / 1_000 ? Int64.max : nonnegative * 1_000
    }

    private static func retryAfterMilliseconds(_ response: HTTPURLResponse, now: Date) -> Int64? {
        guard let raw = response.value(forHTTPHeaderField: "Retry-After")?
            .trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else {
            return nil
        }
        if raw.utf8.allSatisfy({ (48...57).contains($0) }), let seconds = Int64(raw) {
            return milliseconds(seconds)
        }

        for format in [
            "EEE',' dd MMM yyyy HH':'mm':'ss z",
            "EEEE',' dd-MMM-yy HH':'mm':'ss z",
            "EEE MMM d HH':'mm':'ss yyyy",
        ] {
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.timeZone = TimeZone(secondsFromGMT: 0)
            formatter.dateFormat = format
            if let date = formatter.date(from: raw) {
                return Int64(max(0, (date.timeIntervalSince(now) * 1_000).rounded(.up)))
            }
        }
        return nil
    }
}

enum WakeSSEParseError: Error, Equatable {
    case lineTooLong
    case invalidUTF8
}

struct WakeSSELineDecoder {
    private let maximumBytes: Int
    private var bytes = [UInt8]()

    init(maximumBytes: Int) {
        self.maximumBytes = maximumBytes
    }

    mutating func append(_ byte: UInt8) throws -> String? {
        if byte == 0x0a {
            if bytes.last == 0x0d { bytes.removeLast() }
            defer { bytes.removeAll(keepingCapacity: true) }
            guard let line = String(bytes: bytes, encoding: .utf8) else {
                throw WakeSSEParseError.invalidUTF8
            }
            return line
        }
        guard bytes.count < maximumBytes else { throw WakeSSEParseError.lineTooLong }
        bytes.append(byte)
        return nil
    }

    mutating func finish() throws -> String? {
        guard !bytes.isEmpty else { return nil }
        if bytes.last == 0x0d { bytes.removeLast() }
        defer { bytes.removeAll(keepingCapacity: true) }
        guard let line = String(bytes: bytes, encoding: .utf8) else {
            throw WakeSSEParseError.invalidUTF8
        }
        return line
    }
}

struct WakeSSEParser {
    private struct Payload: Codable {
        let cursor: Int64
        let epoch: String
        let reason: WakeReason
    }

    private static let minimumRetryMilliseconds: Int64 = 100
    private static let maximumRetryMilliseconds: Int64 = 5 * 60 * 1_000

    private let maximumDataBytes: Int
    private var eventType = "message"
    private var eventID: String?
    private var data = Data()
    private var discardData = false

    private(set) var retryMilliseconds: Int64?

    init(maximumDataBytes: Int = WakeStreamClient.maximumEventDataBytes) {
        self.maximumDataBytes = maximumDataBytes
    }

    mutating func accept(_ line: String) -> WakeStreamEvent? {
        if line.isEmpty {
            defer {
                eventType = "message"
                data.removeAll(keepingCapacity: true)
                discardData = false
            }
            return dispatch()
        }
        if line.hasPrefix(":") { return nil }

        let pieces = line.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
        let field = String(pieces[0])
        let rawValue = pieces.count == 2 ? String(pieces[1]) : ""
        let value = rawValue.hasPrefix(" ") ? String(rawValue.dropFirst()) : rawValue
        switch field {
        case "event":
            eventType = value
        case "id":
            if WakeStreamClient.isSafeEventID(value) { eventID = value }
        case "retry":
            if value.utf8.allSatisfy({ (48...57).contains($0) }),
               let parsed = Int64(value),
               (Self.minimumRetryMilliseconds...Self.maximumRetryMilliseconds).contains(parsed) {
                retryMilliseconds = parsed
            }
        case "data":
            guard !discardData else { return nil }
            let valueBytes = Data(value.utf8)
            let separatorBytes = data.isEmpty ? 0 : 1
            guard valueBytes.count <= maximumDataBytes - min(maximumDataBytes, data.count) - separatorBytes else {
                data.removeAll(keepingCapacity: true)
                discardData = true
                return nil
            }
            if !data.isEmpty { data.append(0x0a) }
            data.append(valueBytes)
        default:
            break
        }
        return nil
    }

    private func dispatch() -> WakeStreamEvent? {
        guard eventType == "wake", !data.isEmpty, !discardData,
              let eventID,
              let object = try? JSONSerialization.jsonObject(with: data),
              let dictionary = object as? [String: Any],
              Set(dictionary.keys) == Set(["cursor", "epoch", "reason"]),
              let payload = try? JSONDecoder().decode(Payload.self, from: data),
              payload.cursor >= 0,
              Self.isSafeEpoch(payload.epoch),
              eventID == payload.epoch + ":" + String(payload.cursor) else {
            return nil
        }
        return WakeStreamEvent(
            cursor: payload.cursor,
            epoch: payload.epoch,
            reason: payload.reason,
            eventID: eventID
        )
    }

    fileprivate static func isSafeEpoch(_ value: String) -> Bool {
        let bytes = value.utf8
        guard (1...120).contains(bytes.count) else { return false }
        return bytes.allSatisfy {
            (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) ||
                $0 == 0x2e || $0 == 0x5f || $0 == 0x2d
        }
    }
}
