import Foundation
import CryptoKit

public struct DeviceProofChallengeRequest: Codable, Equatable, Sendable {
    public let method: String
    public let path: String
    public let bodySha256: String
    public let usage: String

    public init(method: String, path: String, bodySha256: String, usage: String) {
        self.method = method
        self.path = path
        self.bodySha256 = bodySha256
        self.usage = usage
    }
}

public struct DeviceProofChallenge: Codable, Equatable, Sendable {
    public let nonce: String
    public let timestamp: Int64
    public let expiresAt: Int64
    public let method: String
    public let canonicalPath: String
    public let bodySha256: String
    public let usage: String
    public let algorithm: String
    public let signatureFormat: String
    public let proofVersion: String

    public init(
        nonce: String,
        timestamp: Int64,
        expiresAt: Int64,
        method: String,
        canonicalPath: String,
        bodySha256: String,
        usage: String,
        algorithm: String,
        signatureFormat: String,
        proofVersion: String
    ) {
        self.nonce = nonce
        self.timestamp = timestamp
        self.expiresAt = expiresAt
        self.method = method
        self.canonicalPath = canonicalPath
        self.bodySha256 = bodySha256
        self.usage = usage
        self.algorithm = algorithm
        self.signatureFormat = signatureFormat
        self.proofVersion = proofVersion
    }
}

public struct DeviceProofChallengeResponse: Codable, Equatable, Sendable {
    public let ok: Bool
    public let challenge: DeviceProofChallenge

    public init(ok: Bool, challenge: DeviceProofChallenge) {
        self.ok = ok
        self.challenge = challenge
    }
}

public struct DeviceProofAuthorization: Equatable, Sendable, CustomStringConvertible {
    public let nonce: String
    public let timestamp: Int64
    public let proof: String

    public init(nonce: String, timestamp: Int64, proof: String) {
        self.nonce = nonce
        self.timestamp = timestamp
        self.proof = proof
    }

    public var description: String {
        "device proof authorization timestamp=\(timestamp)"
    }
}

public enum DeviceProofCoordinatorError: Error, Equatable, Sendable, CustomStringConvertible {
    case unsupportedRequest
    case invalidChallenge(String)
    case challengeExpired
    case challengeReplayed
    case invalidSignature

    public var description: String {
        switch self {
        case .unsupportedRequest:
            return "request is not a device-proof data-plane operation"
        case .invalidChallenge(let field):
            return "device proof challenge field \(field) is invalid"
        case .challengeExpired:
            return "device proof challenge expired"
        case .challengeReplayed:
            return "device proof challenge was already used"
        case .invalidSignature:
            return "device proof signature is invalid"
        }
    }
}

/// The exact target bytes and server-owned purpose covered by a proof.
public struct DeviceProofRequestBinding: Equatable, Sendable {
    public let method: String
    public let canonicalPath: String
    public let bodySha256: String
    public let usage: String

    public init(method: String, url: URL, body: Data) throws {
        let normalizedMethod = method.uppercased()
        let target = try Self.canonicalTarget(url)
        guard let usage = Self.proofUsage(method: normalizedMethod, canonicalPath: target) else {
            throw DeviceProofCoordinatorError.unsupportedRequest
        }
        self.method = normalizedMethod
        self.canonicalPath = target
        self.bodySha256 = Data(SHA256.hash(data: body)).base64EncodedString()
        self.usage = usage
    }

    var challengeRequest: DeviceProofChallengeRequest {
        DeviceProofChallengeRequest(
            method: method,
            path: canonicalPath,
            bodySha256: bodySha256,
            usage: usage
        )
    }

    static func canonicalTarget(_ url: URL) throws -> String {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.user == nil,
              components.password == nil,
              components.fragment == nil else {
            throw DeviceProofCoordinatorError.unsupportedRequest
        }
        let path = components.percentEncodedPath
        guard path.hasPrefix("/"), !path.hasPrefix("//"), !path.isEmpty else {
            throw DeviceProofCoordinatorError.unsupportedRequest
        }
        guard let rawQuery = components.percentEncodedQuery, !rawQuery.isEmpty else {
            return path
        }

        var pairs = [(key: String, value: String)]()
        var keys = Set<String>()
        for item in rawQuery.split(separator: "&", omittingEmptySubsequences: false) {
            let parts = item.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            guard let key = formDecode(String(parts[0])) else {
                throw DeviceProofCoordinatorError.unsupportedRequest
            }
            let value = parts.count == 2 ? String(parts[1]) : ""
            guard let decodedValue = formDecode(value), keys.insert(key).inserted else {
                throw DeviceProofCoordinatorError.unsupportedRequest
            }
            pairs.append((key, decodedValue))
        }
        pairs.sort { left, right in
            if left.key != right.key { return utf16Less(left.key, right.key) }
            return utf16Less(left.value, right.value)
        }
        let query = pairs.map { formEncode($0.key) + "=" + formEncode($0.value) }.joined(separator: "&")
        return query.isEmpty ? path : path + "?" + query
    }

    static func proofUsage(method: String, canonicalPath: String) -> String? {
        let pathname = canonicalPath.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)[0]
        let route = String(pathname)
        let exact: [String: String] = [
            "GET /api/mobile/v1/sync/bootstrap": "sync.bootstrap",
            "GET /api/mobile/v1/sync/changes": "sync.changes",
            "GET /api/mobile/v1/sync/wake": "sync.wake",
            "POST /api/mobile/v1/sync/push": "sync.push",
            "POST /api/mobile/v1/sync/ack": "sync.ack",
            "POST /api/mobile/v1/sync/now": "sync.now",
            "GET /api/mobile/v1/sync/status": "sync.status",
            "POST /api/mobile/v1/blobs/uploads": "blob.upload.create",
            "GET /api/mobile/v1/shared": "shared.list",
            "POST /api/mobile/v1/file-bridge/lease": "file-bridge.lease",
        ]
        if let usage = exact[method.uppercased() + " " + route] { return usage }

        let segments = route.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
        guard segments.count >= 4, Array(segments.prefix(3)) == ["api", "mobile", "v1"] else {
            return nil
        }
        let verb = method.uppercased()
        if segments.count == 6, segments[3] == "blobs", segments[4] == "uploads", verb == "GET" {
            return "blob.upload.status"
        }
        if segments.count == 8, segments[3] == "blobs", segments[4] == "uploads",
           segments[6] == "chunks", verb == "PUT" {
            return "blob.chunk.upload"
        }
        if segments.count == 7, segments[3] == "blobs", segments[5] == "chunks", verb == "GET" {
            return "blob.chunk.download"
        }
        if segments.count == 5, segments[3] == "blobs", verb == "GET" {
            return "blob.download"
        }
        if segments.count == 6, segments[3] == "shared", verb == "GET" {
            return "shared.read"
        }
        if segments.count == 7, segments[3] == "shared", segments[6] == "invoke", verb == "POST" {
            return "shared.invoke"
        }
        if segments.count == 7, segments[3] == "shared", segments[4] == "connections",
           segments[6] == "sessions", verb == "POST" {
            return "shared.session.open"
        }
        if segments.count == 7, segments[3] == "shared", segments[4] == "sessions",
           segments[6] == "refresh", verb == "POST" {
            return "shared.session.refresh"
        }
        if segments.count == 6, segments[3] == "shared", segments[4] == "sessions", verb == "DELETE" {
            return "shared.session.close"
        }
        return nil
    }

    private static func formDecode(_ value: String) -> String? {
        value.replacingOccurrences(of: "+", with: "%20").removingPercentEncoding
    }

    private static func formEncode(_ value: String) -> String {
        let hex = Array("0123456789ABCDEF".utf8)
        var encoded = [UInt8]()
        for byte in value.utf8 {
            switch byte {
            case 0x30...0x39, 0x41...0x5a, 0x61...0x7a, 0x2a, 0x2d, 0x2e, 0x5f:
                encoded.append(byte)
            case 0x20:
                encoded.append(0x2b)
            default:
                encoded.append(0x25)
                encoded.append(hex[Int(byte >> 4)])
                encoded.append(hex[Int(byte & 0x0f)])
            }
        }
        return String(decoding: encoded, as: UTF8.self)
    }

    private static func utf16Less(_ left: String, _ right: String) -> Bool {
        left.utf16.lexicographicallyPrecedes(right.utf16)
    }
}

/// Mints and spends one challenge per authorization. Only nonce digests are
/// retained locally, until expiry, to stop a repeated response being signed.
public final class DeviceProofCoordinator: @unchecked Sendable {
    public typealias ChallengeProvider = @Sendable (DeviceProofChallengeRequest) async throws -> DeviceProofChallengeResponse

    public static let proofVersion = "zephyr-one-device-proof-v2"
    public static let algorithm = "ES256"
    public static let signatureFormat = "P1363"

    private let signer: DeviceProofSigning
    private let nowMilliseconds: @Sendable () -> Int64
    private let lock = NSLock()
    private var usedNonceDigests = [Data: Int64]()

    public init(
        signer: DeviceProofSigning,
        nowMilliseconds: @escaping @Sendable () -> Int64 = {
            Int64(Date().timeIntervalSince1970 * 1_000)
        }
    ) {
        self.signer = signer
        self.nowMilliseconds = nowMilliseconds
    }

    public func authorize(
        binding: DeviceProofRequestBinding,
        challengeProvider: ChallengeProvider
    ) async throws -> DeviceProofAuthorization {
        try Task.checkCancellation()
        let response = try await challengeProvider(binding.challengeRequest)
        try Task.checkCancellation()
        let challenge = response.challenge
        guard response.ok else { throw DeviceProofCoordinatorError.invalidChallenge("ok") }
        try validate(challenge, against: binding)
        try claim(challenge)
        try Task.checkCancellation()

        let proof = try signer.sign(challenge)
        guard Self.isP1363Base64(proof) else { throw DeviceProofCoordinatorError.invalidSignature }
        return DeviceProofAuthorization(nonce: challenge.nonce, timestamp: challenge.timestamp, proof: proof)
    }

    private func validate(_ challenge: DeviceProofChallenge, against binding: DeviceProofRequestBinding) throws {
        let expected: [(String, String, String)] = [
            ("method", challenge.method, binding.method),
            ("canonicalPath", challenge.canonicalPath, binding.canonicalPath),
            ("bodySha256", challenge.bodySha256, binding.bodySha256),
            ("usage", challenge.usage, binding.usage),
            ("algorithm", challenge.algorithm, Self.algorithm),
            ("signatureFormat", challenge.signatureFormat, Self.signatureFormat),
            ("proofVersion", challenge.proofVersion, Self.proofVersion),
        ]
        for (field, actual, required) in expected where actual != required {
            throw DeviceProofCoordinatorError.invalidChallenge(field)
        }
        guard challenge.timestamp > 0, String(challenge.timestamp).count == 10 else {
            throw DeviceProofCoordinatorError.invalidChallenge("timestamp")
        }
        guard Self.isNonce(challenge.nonce) else {
            throw DeviceProofCoordinatorError.invalidChallenge("nonce")
        }
        guard challenge.expiresAt > nowMilliseconds() else {
            throw DeviceProofCoordinatorError.challengeExpired
        }
    }

    private func claim(_ challenge: DeviceProofChallenge) throws {
        let digest = Data(SHA256.hash(data: Data(challenge.nonce.utf8)))
        let now = nowMilliseconds()
        lock.lock()
        defer { lock.unlock() }
        usedNonceDigests = usedNonceDigests.filter { $0.value > now }
        guard usedNonceDigests[digest] == nil else {
            throw DeviceProofCoordinatorError.challengeReplayed
        }
        usedNonceDigests[digest] = challenge.expiresAt
    }

    private static func isNonce(_ value: String) -> Bool {
        value.utf8.count == 43 && value.utf8.allSatisfy {
            (0x30...0x39).contains($0) || (0x41...0x5a).contains($0) ||
                (0x61...0x7a).contains($0) || $0 == 0x5f || $0 == 0x2d
        }
    }

    private static func isP1363Base64(_ value: String) -> Bool {
        guard value.utf8.count == 88, value.hasSuffix("=="),
              let decoded = Data(base64Encoded: value), decoded.count == 64 else {
            return false
        }
        return decoded.base64EncodedString() == value
    }
}
