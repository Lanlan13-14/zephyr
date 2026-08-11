import Foundation
import ZephyrContracts

public struct MobileApiError: Error, Equatable, Sendable, CustomStringConvertible {
    public let code: String
    public let message: String
    public let retryable: Bool
    public let requestId: String?
    public let details: [String: String]
    public let httpStatus: Int?
    public let retryAfterSeconds: Int64?

    public init(
        code: String,
        message: String,
        retryable: Bool,
        requestId: String?,
        details: [String: String] = [:],
        httpStatus: Int? = nil,
        retryAfterSeconds: Int64? = nil
    ) {
        self.code = code
        self.message = message
        self.retryable = retryable
        self.requestId = requestId
        self.details = details
        self.httpStatus = httpStatus
        self.retryAfterSeconds = retryAfterSeconds
    }

    /// The stable client action from the frozen registry. Unknown codes read as
    /// "report_unknown_error" and are never silently retried.
    public var clientAction: String { ErrorRegistry.clientAction(code) }

    public var isRegistryRetryable: Bool { ErrorRegistry.isRetryable(code) }

    /// Rebind is the only recovery for a rotated token, a revoked device or a
    /// missing client token.
    public var requiresRebind: Bool {
        clientAction == "rebind" || code == "token_rotated" || code == "client_revoked" || code == "token_missing"
    }

    /// These codes mean the local mirror can no longer catch up and must
    /// bootstrap again from scratch.
    public var requiresBootstrapRestart: Bool {
        code == "cursor_expired" || code == "cursor_invalid" || code == "bootstrap_expired"
    }

    /// Deliberately excludes the server message, details, URL and credentials.
    public var description: String {
        var text = "code=" + code
        if let httpStatus { text += " status=\(httpStatus)" }
        if let requestId { text += " requestId=" + requestId }
        return text
    }

    public static func local(code: String, message: String, retryable: Bool = false) -> MobileApiError {
        MobileApiError(code: code, message: message, retryable: retryable, requestId: nil)
    }

    /// Offline is an environment fact, not a server judgement. It is always
    /// retryable and never a reason to rebind.
    public static let offline = MobileApiError.local(
        code: "network_offline",
        message: "No network connection",
        retryable: true
    )
}

/// A JSON value used for schema fields whose members are entity-specific.
/// Keeping it Codable avoids placing untyped `Any` values on the API boundary.
public enum MobileJSONValue: Codable, Equatable, Sendable {
    case string(String)
    case integer(Int64)
    case number(Double)
    case boolean(Bool)
    case object([String: MobileJSONValue])
    case array([MobileJSONValue])
    case null

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .boolean(value)
        } else if let value = try? container.decode(Int64.self) {
            self = .integer(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([String: MobileJSONValue].self) {
            self = .object(value)
        } else if let value = try? container.decode([MobileJSONValue].self) {
            self = .array(value)
        } else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Unsupported JSON value"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .integer(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .boolean(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }

    fileprivate var diagnosticString: String {
        switch self {
        case .string(let value): return value
        case .integer(let value): return String(value)
        case .number(let value): return String(value)
        case .boolean(let value): return value ? "true" : "false"
        case .null: return "null"
        case .object, .array: return "<structured>"
        }
    }
}

public struct MobileErrorEnvelope: Codable, Equatable, Sendable {
    public let ok: Bool
    public let error: MobileErrorBody
}

public struct MobileErrorBody: Codable, Equatable, Sendable {
    public let code: String
    public let message: String
    public let retryable: Bool
    public let requestId: String?
    public let details: [String: MobileJSONValue]?
}

public struct MobileLoginRequest: Encodable, Equatable, Sendable, CustomStringConvertible {
    public let username: String
    public let password: String
    public let captchaToken: String?
    public let remember: Bool
    public let returnSid: Bool

    public init(
        username: String,
        password: String,
        captchaToken: String? = nil,
        remember: Bool = false
    ) {
        self.username = username
        self.password = password
        self.captchaToken = captchaToken
        self.remember = remember
        self.returnSid = true
    }

    private enum CodingKeys: String, CodingKey {
        case username, password, captchaToken, remember, returnSid
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(username, forKey: .username)
        try container.encode(password, forKey: .password)
        try container.encodeIfPresent(captchaToken, forKey: .captchaToken)
        if remember { try container.encode(true, forKey: .remember) }
        try container.encode(true, forKey: .returnSid)
    }

    public var description: String {
        "MobileLoginRequest(username=[REDACTED], password=[REDACTED], " +
            "captchaToken=[REDACTED], remember=\(remember), returnSid=true)"
    }
}

public struct MobileTotpRequest: Encodable, Equatable, Sendable, CustomStringConvertible {
    public let tempToken: String
    public let code: String
    public let returnSid: Bool

    public init(tempToken: String, code: String) {
        self.tempToken = tempToken
        self.code = code
        self.returnSid = true
    }

    public var description: String {
        "MobileTotpRequest(tempToken=[REDACTED], code=[REDACTED], returnSid=true)"
    }
}

public struct MobileAuthUser: Codable, Equatable, Sendable {
    public let userId: String
    public let username: String

    public init(userId: String, username: String) {
        self.userId = userId
        self.username = username
    }
}

public struct MobileAuthenticatedSession: Equatable, Sendable, CustomStringConvertible {
    public let sid: String
    public let user: MobileAuthUser

    public init(sid: String, user: MobileAuthUser) {
        self.sid = sid
        self.user = user
    }

    public var description: String {
        "MobileAuthenticatedSession(sid=[REDACTED], userId=\(user.userId))"
    }
}

/// Login has exactly one challenge or authenticated outcome. Keeping these as
/// enum cases prevents stale flattened fields from being treated as a session.
public enum MobileLoginResponse: Decodable, Equatable, Sendable, CustomStringConvertible {
    case totpRequired(tempToken: String)
    case authenticated(session: MobileAuthenticatedSession)
    case mustChangePassword(session: MobileAuthenticatedSession)

    private enum CodingKeys: String, CodingKey {
        case ok, requireTotp, tempToken, sid, user, mustChangePassword
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        guard try container.decode(Bool.self, forKey: .ok) else {
            throw DecodingError.dataCorruptedError(forKey: .ok, in: container, debugDescription: "ok must be true")
        }

        let requiresTotp = try container.decodeIfPresent(Bool.self, forKey: .requireTotp)
        let tempToken = try container.decodeIfPresent(String.self, forKey: .tempToken)
        let sid = try container.decodeIfPresent(String.self, forKey: .sid)
        let user = try container.decodeIfPresent(MobileAuthUser.self, forKey: .user)
        let mustChangePassword = try container.decodeIfPresent(Bool.self, forKey: .mustChangePassword)

        if requiresTotp == true {
            guard let tempToken, !tempToken.isEmpty,
                  sid == nil, user == nil, mustChangePassword == nil else {
                throw DecodingError.dataCorruptedError(
                    forKey: .requireTotp,
                    in: container,
                    debugDescription: "challenge and session fields must not be mixed"
                )
            }
            self = .totpRequired(tempToken: tempToken)
            return
        }

        guard tempToken == nil, let sid, !sid.isEmpty, let user, let mustChangePassword else {
            throw DecodingError.dataCorruptedError(
                forKey: .sid,
                in: container,
                debugDescription: "authenticated session fields are incomplete"
            )
        }
        let session = MobileAuthenticatedSession(sid: sid, user: user)
        self = mustChangePassword
            ? .mustChangePassword(session: session)
            : .authenticated(session: session)
    }

    public var description: String {
        switch self {
        case .totpRequired:
            return "MobileLoginResponse.totpRequired(tempToken=[REDACTED])"
        case .authenticated(let session):
            return "MobileLoginResponse.authenticated(\(session))"
        case .mustChangePassword(let session):
            return "MobileLoginResponse.mustChangePassword(\(session))"
        }
    }
}

public struct MobileMinimumAppVersions: Codable, Equatable, Sendable {
    public let android: String
    public let ios: String
}

public struct MobileCapabilityLimits: Codable, Equatable, Sendable {
    public let maxOpsPerBatch: Int64
    public let maxPageSize: Int64
    public let defaultPageSize: Int64
    public let minIntervalSec: Int64
    public let maxIntervalSec: Int64
    public let blobChunkBytes: Int64
    public let maxBlobBytes: Int64
    public let tombstoneRetentionDays: Int64
    public let appliedOpRetentionDays: Int64
}

public struct MobileAuthCapabilities: Codable, Equatable, Sendable {
    public let sidHeader: String
    public let accessScheme: String
    public let proofHeader: String
    public let nonceHeader: String
    public let timestampHeader: String
    public let challengePath: String
    public let proofVersion: String
    public let proofSkewSec: Int
    public let challengeTtlSec: Int
    public let challengeMaxActivePerDevice: Int
    public let challengeMaxIssuesPerMinute: Int
    public let signatureFormat: String
    public let encryptionAlg: String
    public let signingAlg: String

    fileprivate var isSupported: Bool {
        sidHeader == "X-Zephyr-Sid" && accessScheme == "Bearer" &&
            proofHeader == "X-Zephyr-Device-Proof" && nonceHeader == "X-Zephyr-Server-Nonce" &&
            timestampHeader == "X-Zephyr-Proof-Timestamp" &&
            challengePath == MobileApiPaths.postMobileV1DevicesProofChallenge &&
            proofVersion == DeviceProofCoordinator.proofVersion && proofSkewSec > 0 &&
            challengeTtlSec > 0 && challengeMaxActivePerDevice > 0 &&
            challengeMaxIssuesPerMinute > 0 && signatureFormat == DeviceProofCoordinator.signatureFormat &&
            encryptionAlg == "ML-KEM-768" && signingAlg == DeviceProofCoordinator.algorithm
    }
}

public struct MobileServerEncryption: Codable, Equatable, Sendable {
    public let alg: String
    public let keyVersion: Int
    public let publicKey: String

    fileprivate var isValid: Bool {
        alg == "ML-KEM-768" && keyVersion > 0 &&
            Data(base64Encoded: publicKey)?.count == 1184
    }
}

public struct MobileFeatureCapabilities: Codable, Equatable, Sendable {
    public let bidirectionalSync: Bool
    public let sharedResources: Bool
    public let fileBridge: Bool
    public let blobTransfer: Bool
    public let nearRealtimeWake: Bool
}

public struct MobileWakeCapabilities: Codable, Equatable, Sendable {
    public let enabled: Bool
    public let transport: String
    public let path: String
    public let event: String
    public let payloadFields: [String]
    public let heartbeatSec: Int
    public let retryMs: Int64
    public let supportsLastEventId: Bool
    public let requiresDeviceAccess: Bool
    public let requiresDeviceProof: Bool
    public let maxConnections: Int
    public let maxConnectionsPerOwner: Int
    public let maxBufferedBytes: Int64

    fileprivate var isSupported: Bool {
        enabled && transport == "sse" && path == MobileApiPaths.getMobileV1SyncWake &&
            event == "wake" && payloadFields == ["cursor", "epoch", "reason"] &&
            heartbeatSec > 0 && retryMs > 0 && supportsLastEventId && requiresDeviceAccess &&
            requiresDeviceProof && maxConnections > 0 && maxConnectionsPerOwner > 0 &&
            maxBufferedBytes > 0
    }
}

public struct MobileCapabilitiesResponse: Codable, Equatable, Sendable {
    public let ok: Bool
    public let protocolVersions: [Int]
    public let registryHash: String
    public let minimumAppVersions: MobileMinimumAppVersions?
    public let limits: MobileCapabilityLimits
    public let serverId: String
    public let auth: MobileAuthCapabilities
    public let serverEncryption: MobileServerEncryption?
    public let features: MobileFeatureCapabilities
    public let wake: MobileWakeCapabilities

    private enum CodingKeys: String, CodingKey {
        case ok, protocolVersions, registryHash, minimumAppVersions, limits, serverId
        case auth, serverEncryption, features, wake
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        ok = try container.decode(Bool.self, forKey: .ok)
        protocolVersions = try container.decode([Int].self, forKey: .protocolVersions)
        registryHash = try container.decode(String.self, forKey: .registryHash)
        minimumAppVersions = try container.decodeIfPresent(MobileMinimumAppVersions.self, forKey: .minimumAppVersions)
        limits = try container.decode(MobileCapabilityLimits.self, forKey: .limits)
        serverId = try container.decode(String.self, forKey: .serverId)
        auth = try container.decode(MobileAuthCapabilities.self, forKey: .auth)
        guard container.contains(.serverEncryption) else {
            throw DecodingError.keyNotFound(
                CodingKeys.serverEncryption,
                DecodingError.Context(
                    codingPath: container.codingPath,
                    debugDescription: "serverEncryption is required even when null"
                )
            )
        }
        serverEncryption = try container.decodeIfPresent(MobileServerEncryption.self, forKey: .serverEncryption)
        features = try container.decode(MobileFeatureCapabilities.self, forKey: .features)
        wake = try container.decode(MobileWakeCapabilities.self, forKey: .wake)

        guard ok, !protocolVersions.isEmpty, !registryHash.isEmpty, !serverId.isEmpty,
              auth.isSupported, serverEncryption?.isValid ?? true, wake.isSupported else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(
                    codingPath: container.codingPath,
                    debugDescription: "capabilities contain unsupported security metadata"
                )
            )
        }
    }

    public func supports(protocolVersion: Int) -> Bool {
        protocolVersions.contains(protocolVersion)
    }
}

public enum MobileSensitiveAction: String, Codable, Equatable, Sendable {
    case deviceBind = "device.bind"
    case deviceRevoke = "device.revoke"
}

public struct MobileSensitiveVerifyRequest: Encodable, Equatable, Sendable, CustomStringConvertible {
    public let action: String
    public let secret: String
    public let targetIds: [String]

    public init(secret: String, tokenId: String, deviceId: String) {
        self.init(action: .deviceBind, secret: secret, targetIds: [tokenId, deviceId])
    }

    public init(action: MobileSensitiveAction, secret: String, targetIds: [String]) {
        self.action = action.rawValue
        self.secret = secret
        self.targetIds = targetIds
    }

    public var description: String {
        "MobileSensitiveVerifyRequest(action=\(action), secret=[REDACTED], targetCount=\(targetIds.count))"
    }
}

public struct MobileSensitiveGrantResponse: Codable, Equatable, Sendable, CustomStringConvertible {
    public let ok: Bool
    public let grant: String
    public let expiresAt: Int64
    public let action: String
    public let targetHash: String
    public let bindingProtocolVersion: Int?
    public let bindAttempt: MobileBindAttempt?

    private enum CodingKeys: String, CodingKey {
        case ok, grant, expiresAt, action, targetHash, bindingProtocolVersion, bindAttempt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        ok = try container.decode(Bool.self, forKey: .ok)
        grant = try container.decode(String.self, forKey: .grant)
        expiresAt = try container.decode(Int64.self, forKey: .expiresAt)
        action = try container.decode(String.self, forKey: .action)
        targetHash = try container.decode(String.self, forKey: .targetHash)
        bindingProtocolVersion = try container.decodeIfPresent(Int.self, forKey: .bindingProtocolVersion)
        bindAttempt = try container.decodeIfPresent(MobileBindAttempt.self, forKey: .bindAttempt)
        guard ok, !grant.isEmpty, expiresAt > 0, !action.isEmpty, !targetHash.isEmpty else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(codingPath: container.codingPath, debugDescription: "sensitive grant is invalid")
            )
        }
    }

    public var description: String {
        "MobileSensitiveGrantResponse(ok=\(ok), grant=[REDACTED], expiresAt=\(expiresAt), action=\(action))"
    }
}

public struct MobileBindAttempt: Codable, Equatable, Sendable, CustomStringConvertible {
    public let receipt: String
    public let expectedBindingRevision: Int
    public let expectedRefreshGeneration: Int
    public let expiresAt: Int64

    private enum CodingKeys: String, CodingKey {
        case receipt, expectedBindingRevision, expectedRefreshGeneration, expiresAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        receipt = try container.decode(String.self, forKey: .receipt)
        expectedBindingRevision = try container.decode(Int.self, forKey: .expectedBindingRevision)
        expectedRefreshGeneration = try container.decode(Int.self, forKey: .expectedRefreshGeneration)
        expiresAt = try container.decode(Int64.self, forKey: .expiresAt)
        guard Self.isValidReceipt(receipt), expectedBindingRevision >= 0,
              expectedBindingRevision < Int.max,
              expectedRefreshGeneration >= 0, expiresAt > 0 else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(
                    codingPath: container.codingPath,
                    debugDescription: "bind attempt is invalid"
                )
            )
        }
    }

    public var description: String {
        "MobileBindAttempt(receipt=[REDACTED], expectedBindingRevision=\(expectedBindingRevision), " +
            "expectedRefreshGeneration=\(expectedRefreshGeneration), expiresAt=\(expiresAt))"
    }

    static func isValidReceipt(_ value: String) -> Bool {
        value.utf8.count == 43 && value.utf8.allSatisfy {
            ($0 >= 48 && $0 <= 57) || ($0 >= 65 && $0 <= 90) ||
                ($0 >= 97 && $0 <= 122) || $0 == 45 || $0 == 95
        }
    }
}

public struct MobileDeviceEncryptionKey: Codable, Equatable, Sendable {
    public let alg: String
    public let publicKey: String

    public init(alg: String = "ML-KEM-768", publicKey: String) {
        self.alg = alg
        self.publicKey = publicKey
    }
}

public struct MobileDeviceSigningKey: Codable, Equatable, Sendable {
    public let alg: String
    public let jwk: [String: MobileJSONValue]

    public init(alg: String = "ES256", jwk: [String: MobileJSONValue]) {
        self.alg = alg
        self.jwk = jwk
    }
}

public struct MobileDeviceKeys: Codable, Equatable, Sendable {
    public let encryption: MobileDeviceEncryptionKey
    public let signing: MobileDeviceSigningKey

    public init(encryption: MobileDeviceEncryptionKey, signing: MobileDeviceSigningKey) {
        self.encryption = encryption
        self.signing = signing
    }
}

public struct MobileDeviceBindRequest: Encodable, Equatable, Sendable, CustomStringConvertible {
    public let deviceId: String
    public let deviceName: String
    public let platform: String
    public let appVersion: String
    public let tokenId: String
    public let keys: MobileDeviceKeys
    public let syncIntervalSec: Int
    public let bindingProtocolVersion: Int
    public let bindReceipt: String

    public init(
        deviceId: String,
        deviceName: String,
        appVersion: String,
        tokenId: String,
        keys: MobileDeviceKeys,
        syncIntervalSec: Int,
        bindReceipt: String
    ) {
        self.deviceId = deviceId
        self.deviceName = deviceName
        self.platform = "ios"
        self.appVersion = appVersion
        self.tokenId = tokenId
        self.keys = keys
        self.syncIntervalSec = syncIntervalSec
        self.bindingProtocolVersion = 2
        self.bindReceipt = bindReceipt
    }

    public var description: String {
        "MobileDeviceBindRequest(deviceId=\(deviceId), platform=ios, keys=[REDACTED])"
    }
}

public struct MobileDevice: Codable, Equatable, Sendable {
    public let deviceId: String
    public let ownerUserId: String
    public let deviceName: String
    public let platform: String
    public let appVersion: String
    public let tokenId: String
    public let enabled: Bool
    public let automaticEnabled: Bool
    public let syncIntervalSec: Int
    public let bindingRevision: Int?
    public let lastSyncAt: Int64?
    public let lastSeenAt: Int64?
    public let createdAt: Int64
    public let revokedAt: Int64?
}

public struct MobileDeviceBindResponse: Decodable, Equatable, Sendable, CustomStringConvertible {
    public let ok: Bool
    public let device: MobileDevice
    public let accessCredential: String
    public let accessExpiresAt: Int64
    public let refreshCredential: String
    public let registryHash: String
    public let bindingProtocolVersion: Int
    public let bindingRevision: Int
    public let bindingToken: String
    public let bootstrapRequired: Bool

    private enum CodingKeys: String, CodingKey {
        case ok, device, accessCredential, accessExpiresAt, refreshCredential, registryHash
        case bindingProtocolVersion, bindingRevision, bindingToken, bootstrapRequired
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        ok = try container.decode(Bool.self, forKey: .ok)
        device = try container.decode(MobileDevice.self, forKey: .device)
        accessCredential = try container.decode(String.self, forKey: .accessCredential)
        accessExpiresAt = try container.decode(Int64.self, forKey: .accessExpiresAt)
        refreshCredential = try container.decode(String.self, forKey: .refreshCredential)
        registryHash = try container.decode(String.self, forKey: .registryHash)
        bindingProtocolVersion = try container.decode(Int.self, forKey: .bindingProtocolVersion)
        bindingRevision = try container.decode(Int.self, forKey: .bindingRevision)
        bindingToken = try container.decode(String.self, forKey: .bindingToken)
        bootstrapRequired = try container.decode(Bool.self, forKey: .bootstrapRequired)
        guard ok, !accessCredential.isEmpty, accessExpiresAt > 0, !refreshCredential.isEmpty,
              !registryHash.isEmpty, bindingProtocolVersion == 2, bindingRevision > 0,
              MobileBindAttempt.isValidReceipt(bindingToken), bootstrapRequired else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(codingPath: container.codingPath, debugDescription: "binding credentials are invalid")
            )
        }
    }

    public var description: String {
        "MobileDeviceBindResponse(ok=\(ok), deviceId=\(device.deviceId), " +
            "accessCredential=[REDACTED], refreshCredential=[REDACTED])"
    }
}

public struct MobileDeviceRefreshRequest: Encodable, Equatable, Sendable, CustomStringConvertible {
    public let deviceId: String
    public let refreshCredential: String

    public init(deviceId: String, refreshCredential: String) {
        self.deviceId = deviceId
        self.refreshCredential = refreshCredential
    }

    public var description: String {
        "MobileDeviceRefreshRequest(deviceId=\(deviceId), refreshCredential=[REDACTED])"
    }
}

public struct MobileDeviceRefreshResponse: Decodable, Equatable, Sendable, CustomStringConvertible {
    public let ok: Bool
    public let device: MobileDevice
    public let accessCredential: String
    public let accessExpiresAt: Int64
    public let refreshCredential: String
    public let registryHash: String

    private enum CodingKeys: String, CodingKey {
        case ok, device, accessCredential, accessExpiresAt, refreshCredential, registryHash
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        ok = try container.decode(Bool.self, forKey: .ok)
        device = try container.decode(MobileDevice.self, forKey: .device)
        accessCredential = try container.decode(String.self, forKey: .accessCredential)
        accessExpiresAt = try container.decode(Int64.self, forKey: .accessExpiresAt)
        refreshCredential = try container.decode(String.self, forKey: .refreshCredential)
        registryHash = try container.decode(String.self, forKey: .registryHash)
        guard ok, !accessCredential.isEmpty, accessExpiresAt > 0, !refreshCredential.isEmpty,
              !registryHash.isEmpty else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(codingPath: container.codingPath, debugDescription: "refreshed credentials are invalid")
            )
        }
    }

    public var description: String {
        "MobileDeviceRefreshResponse(ok=\(ok), deviceId=\(device.deviceId), " +
            "accessCredential=[REDACTED], refreshCredential=[REDACTED])"
    }
}

public struct MobileDevicePatchRequest: Encodable, Equatable, Sendable {
    public let deviceName: String?
    public let enabled: Bool?
    public let automaticEnabled: Bool?
    public let syncIntervalSec: Int?

    public init(
        deviceName: String? = nil,
        enabled: Bool? = nil,
        automaticEnabled: Bool? = nil,
        syncIntervalSec: Int? = nil
    ) {
        self.deviceName = deviceName
        self.enabled = enabled
        self.automaticEnabled = automaticEnabled
        self.syncIntervalSec = syncIntervalSec
    }
}

public struct MobileDeviceRevokeResponse: Decodable, Equatable, Sendable {
    public let ok: Bool

    private enum CodingKeys: String, CodingKey { case ok }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        ok = try container.decode(Bool.self, forKey: .ok)
        guard ok else {
            throw DecodingError.dataCorruptedError(forKey: .ok, in: container, debugDescription: "ok must be true")
        }
    }
}

public struct MobileSecretEnvelope: Codable, Equatable, Sendable {
    public let v: Int
    public let alg: String
    public let kem: String
    public let aead: String
    public let ct: String
    public let iv: String
    public let tag: String
    public let data: String
    public let aad: String
    public let keyVersion: Int
    public let entityRevision: Int64

    public init(
        v: Int = 1,
        alg: String = "ML-KEM-768+HKDF-SHA256+AES-256-GCM",
        kem: String = "ML-KEM-768",
        aead: String = "AES-256-GCM",
        ct: String,
        iv: String,
        tag: String,
        data: String,
        aad: String,
        keyVersion: Int,
        entityRevision: Int64
    ) {
        self.v = v
        self.alg = alg
        self.kem = kem
        self.aead = aead
        self.ct = ct
        self.iv = iv
        self.tag = tag
        self.data = data
        self.aad = aad
        self.keyVersion = keyVersion
        self.entityRevision = entityRevision
    }
}

public struct MobileSyncOperation: Codable, Equatable, Sendable {
    public let opId: String
    public let entityType: String
    public let entityId: String
    public let action: SyncAction
    public let baseRevision: Int64
    public let clientModifiedAt: Int64?
    public let fieldMask: [String]
    public let payload: [String: MobileJSONValue]
    public let secretEnvelopes: [String: MobileSecretEnvelope]?

    public init(
        opId: String,
        entityType: String,
        entityId: String,
        action: SyncAction,
        baseRevision: Int64,
        clientModifiedAt: Int64? = nil,
        fieldMask: [String],
        payload: [String: MobileJSONValue],
        secretEnvelopes: [String: MobileSecretEnvelope]? = nil
    ) {
        self.opId = opId
        self.entityType = entityType
        self.entityId = entityId
        self.action = action
        self.baseRevision = baseRevision
        self.clientModifiedAt = clientModifiedAt
        self.fieldMask = fieldMask
        self.payload = payload
        self.secretEnvelopes = secretEnvelopes
    }
}

public enum MobileSyncChangeAction: String, Codable, Equatable, Sendable {
    case upsert
    case delete
}

public struct MobileSyncChange: Codable, Equatable, Sendable {
    public let changeSeq: Int64
    public let entityType: String
    public let entityId: String
    public let action: MobileSyncChangeAction
    public let revision: Int64
    public let actorDeviceId: String?
    public let changedAt: Int64
    public let fieldMask: [String]
    public let payload: [String: MobileJSONValue]
    public let secretEnvelopes: [String: MobileSecretEnvelope]?
    public let tombstone: [String: MobileJSONValue]?

    private enum CodingKeys: String, CodingKey {
        case changeSeq, entityType, entityId, action, revision, actorDeviceId
        case changedAt, fieldMask, payload, secretEnvelopes, tombstone
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        changeSeq = try container.decode(Int64.self, forKey: .changeSeq)
        entityType = try container.decode(String.self, forKey: .entityType)
        entityId = try container.decode(String.self, forKey: .entityId)
        action = try container.decode(MobileSyncChangeAction.self, forKey: .action)
        revision = try container.decode(Int64.self, forKey: .revision)
        actorDeviceId = try container.decodeIfPresent(String.self, forKey: .actorDeviceId)
        changedAt = try container.decode(Int64.self, forKey: .changedAt)
        fieldMask = try container.decodeIfPresent([String].self, forKey: .fieldMask) ?? []
        payload = try container.decodeIfPresent([String: MobileJSONValue].self, forKey: .payload) ?? [:]
        secretEnvelopes = try container.decodeIfPresent(
            [String: MobileSecretEnvelope].self,
            forKey: .secretEnvelopes
        )
        tombstone = try container.decodeIfPresent([String: MobileJSONValue].self, forKey: .tombstone)
    }
}

public struct MobileBootstrapResponse: Codable, Equatable, Sendable {
    public let ok: Bool
    public let bootstrapId: String
    public let snapshotCursor: Int64
    public let nextPageToken: String?
    public let complete: Bool
    public let entities: [MobileSyncChange]
}

public struct MobileChangesResponse: Codable, Equatable, Sendable {
    public let ok: Bool
    public let fromCursor: Int64
    public let nextCursor: Int64
    public let hasMore: Bool
    public let changes: [MobileSyncChange]
}

public struct MobilePushRequest: Codable, Equatable, Sendable {
    public let protocolVersion: Int
    public let deviceId: String
    public let batchId: String
    public let baseCursor: Int64
    public let registryHash: String
    public let operations: [MobileSyncOperation]

    public init(
        protocolVersion: Int = MobileApiPaths.protocolVersion,
        deviceId: String,
        batchId: String,
        baseCursor: Int64,
        registryHash: String,
        operations: [MobileSyncOperation]
    ) {
        self.protocolVersion = protocolVersion
        self.deviceId = deviceId
        self.batchId = batchId
        self.baseCursor = baseCursor
        self.registryHash = registryHash
        self.operations = operations
    }
}

public struct MobilePushResult: Codable, Equatable, Sendable {
    public let opId: String
    public let status: PushStatus
    public let entityId: String?
    public let revision: Int64?
    public let changeSeq: Int64?
    public let error: MobileErrorEnvelope?
    public let conflict: [String: MobileJSONValue]?
}

public struct MobilePushResponse: Codable, Equatable, Sendable {
    public let ok: Bool
    public let batchId: String
    public let serverCursor: Int64
    public let results: [MobilePushResult]
    public let changesAvailable: Bool
}

public struct MobileAckRequest: Codable, Equatable, Sendable {
    public let cursor: Int64

    public init(cursor: Int64) {
        self.cursor = cursor
    }
}

/// The OpenAPI ack response is an open object. Current servers return `ok`.
public struct MobileAckResponse: Codable, Equatable, Sendable {
    public let ok: Bool?
}

/// The OpenAPI sync-now request is an empty object.
public struct MobileSyncNowRequest: Codable, Equatable, Sendable {
    public init() {}
}

public struct MobileSyncStatusResponse: Codable, Equatable, Sendable {
    public let ok: Bool
    public let state: String
    public let lastAttemptAt: Int64?
    public let lastSuccessAt: Int64?
    public let cursor: Int64
    public let pendingCount: Int
    public let conflictCount: Int
    public let lastError: MobileErrorEnvelope?
}

private struct LoadedMobileHTTPResponse {
    let data: Data
    let response: HTTPURLResponse
    let responseRequestId: String
}

private struct MobileLogoutResponse: Decodable {
    let ok: Bool
}

private struct DeviceProofChallengeTransportFailure: Error {
    let error: MobileApiError
}

private enum MobileRequestAuthorization {
    case none
    case sid(value: String, sensitiveGrant: String?)
    case sidCookie(value: String)
    case device
    case deviceProof
}

public enum MobileApiConfigurationError: Error, Equatable, Sendable, CustomStringConvertible {
    case invalidBaseURL
    case httpsRequired
    case credentialsInBaseURL
    case queryOrFragmentInBaseURL
    case invalidAppVersion
    case invalidTimeout
    case invalidResponseByteLimit
    case invalidTLSPin

    public var description: String {
        switch self {
        case .invalidBaseURL: return "The mobile API base URL is invalid"
        case .httpsRequired: return "The mobile API base URL must use HTTPS"
        case .credentialsInBaseURL: return "The mobile API base URL must not contain credentials"
        case .queryOrFragmentInBaseURL: return "The mobile API base URL must not contain a query or fragment"
        case .invalidAppVersion: return "The app version is not valid for an HTTP header"
        case .invalidTimeout: return "The request timeout must be finite and greater than zero"
        case .invalidResponseByteLimit:
            return "The response byte limit must be between zero and 33554432 bytes"
        case .invalidTLSPin: return "TLS SPKI pins must be SHA-256 digests in Base64"
        }
    }
}

/// The HTTP boundary for the mobile sync API.
///
/// `URLSession` is injected so production can provide its session configuration
/// and tests can install a `URLProtocol`. TLS trust and optional pinning remain
/// owned here so authenticated requests cannot bypass them. Credential storage,
/// refresh, persistence and scheduling deliberately remain outside this type.
public final class MobileApiClient: @unchecked Sendable {
    public typealias CredentialProvider = @Sendable () -> String?
    public typealias RequestIdProvider = @Sendable () -> String

    public let baseURL: URL
    public let requestTimeout: TimeInterval
    public let responseByteLimit: Int

    /// The same-origin, redirect-refusing, TLS-pinned session used by the API
    /// client. Exposed narrowly for long-lived streaming tasks, whose bodies
    /// cannot use the finite response collector.
    public var streamingSession: URLSession { session }

    /// Generous enough for a full bootstrap page, while bounding memory well
    /// below the point where one response could destabilize a mobile process.
    public static let defaultResponseByteLimit = 32 * 1024 * 1024

    private let appVersion: String
    private let session: URLSession
    private let sessionDelegate: PinnedURLSessionDelegate
    private let credentialProvider: CredentialProvider
    private let requestIdProvider: RequestIdProvider
    private let proofCoordinator: DeviceProofCoordinator?
    private let legacyCookieStorage: HTTPCookieStorage

    public init(
        baseURL: String,
        appVersion: String,
        session: URLSession = .shared,
        requestTimeout: TimeInterval = 120,
        responseByteLimit: Int = MobileApiClient.defaultResponseByteLimit,
        sha256SPKIPins: [String] = [],
        proofCoordinator: DeviceProofCoordinator? = nil,
        legacyCookieStorage: HTTPCookieStorage = .shared,
        credentialProvider: @escaping CredentialProvider = { nil },
        requestIdProvider: @escaping RequestIdProvider = { UUID().uuidString }
    ) throws {
        guard let components = URLComponents(string: baseURL),
              let scheme = components.scheme,
              components.host?.isEmpty == false,
              let parsedURL = components.url else {
            throw MobileApiConfigurationError.invalidBaseURL
        }
        guard scheme.lowercased() == "https" else {
            throw MobileApiConfigurationError.httpsRequired
        }
        guard components.user == nil, components.password == nil else {
            throw MobileApiConfigurationError.credentialsInBaseURL
        }
        guard components.query == nil, components.fragment == nil else {
            throw MobileApiConfigurationError.queryOrFragmentInBaseURL
        }
        guard !appVersion.isEmpty, Self.isSafeHeaderValue(appVersion) else {
            throw MobileApiConfigurationError.invalidAppVersion
        }
        guard requestTimeout.isFinite, requestTimeout > 0 else {
            throw MobileApiConfigurationError.invalidTimeout
        }
        guard (0...Self.defaultResponseByteLimit).contains(responseByteLimit) else {
            throw MobileApiConfigurationError.invalidResponseByteLimit
        }

        self.baseURL = parsedURL
        self.appVersion = appVersion
        self.requestTimeout = requestTimeout
        self.responseByteLimit = responseByteLimit
        self.proofCoordinator = proofCoordinator
        self.legacyCookieStorage = legacyCookieStorage
        self.credentialProvider = credentialProvider
        self.requestIdProvider = requestIdProvider

        // Releases written by older builds used URLSession.shared and could
        // leave the native SID in the process-wide persistent cookie store.
        // Limit migration cleanup to cookies applicable to this server origin.
        Self.removeLegacySIDCookie(for: parsedURL, from: legacyCookieStorage)

        // One delegate composes strict trust/pinning with the bounded streaming
        // collector. The supplied session remains a transport/testing template;
        // credentials, cookies and cached payloads never inherit its storage.
        let sessionDelegate: PinnedURLSessionDelegate
        do {
            sessionDelegate = try PinnedURLSessionDelegate(
                expectedURL: parsedURL,
                sha256SPKIPins: sha256SPKIPins
            )
        } catch {
            throw MobileApiConfigurationError.invalidTLSPin
        }
        self.sessionDelegate = sessionDelegate
        self.session = URLSession(
            configuration: Self.sensitiveSessionConfiguration(from: session.configuration),
            delegate: sessionDelegate,
            delegateQueue: session.delegateQueue
        )
    }

    deinit {
        session.invalidateAndCancel()
    }

    public func login(
        username: String,
        password: String,
        captchaToken: String? = nil,
        remember: Bool = false
    ) async throws -> MobileLoginResponse {
        let request = MobileLoginRequest(
            username: username,
            password: password,
            captchaToken: captchaToken,
            remember: remember
        )
        return try await perform(
            path: MobileApiPaths.postAuthLogin,
            method: "POST",
            body: try encode(request),
            authorization: .none,
            sensitiveValues: [username, password, captchaToken].compactMap { $0 }
        )
    }

    public func verifyTotp(tempToken: String, code: String) async throws -> MobileLoginResponse {
        guard !tempToken.isEmpty, (6...8).contains(code.utf8.count),
              code.utf8.allSatisfy({ (48...57).contains($0) }) else {
            throw MobileApiError.local(
                code: "invalid_request",
                message: "The TOTP continuation is invalid"
            )
        }
        let request = MobileTotpRequest(tempToken: tempToken, code: code)
        return try await perform(
            path: MobileApiPaths.postAuthTotpVerify,
            method: "POST",
            body: try encode(request),
            authorization: .none,
            sensitiveValues: [tempToken, code]
        )
    }

    /// Revokes the browser-compatible app session without enabling a cookie
    /// jar. The legacy logout endpoint accepts only its cookie contract, so the
    /// SID is percent-encoded into one explicit request and is never persisted.
    public func logout(sid: String) async throws {
        defer { Self.removeLegacySIDCookie(for: baseURL, from: legacyCookieStorage) }
        guard !sid.isEmpty, Self.isSafeHeaderValue(sid) else {
            throw MobileApiError.local(
                code: "invalid_credential",
                message: "The session credential is not valid"
            )
        }
        let response: MobileLogoutResponse = try await perform(
            path: "/api/auth/logout",
            method: "POST",
            authorization: .sidCookie(value: sid),
            sensitiveValues: [sid]
        )
        guard response.ok else {
            throw MobileApiError.local(
                code: "malformed_response",
                message: "The server returned an invalid logout response"
            )
        }
    }

    /// Unauthenticated by contract so compatibility can be checked before bind.
    public func capabilities() async throws -> MobileCapabilitiesResponse {
        try await perform(
            path: MobileApiPaths.getMobileV1Capabilities,
            method: "GET",
            authorization: .none
        )
    }

    public func verifySensitive(
        secret: String,
        tokenId: String,
        deviceId: String,
        sid: String
    ) async throws -> MobileSensitiveGrantResponse {
        try await verifySensitive(
            action: .deviceBind,
            secret: secret,
            targetIds: [tokenId, deviceId],
            sid: sid
        )
    }

    public func verifySensitive(
        action: MobileSensitiveAction,
        secret: String,
        targetIds: [String],
        sid: String
    ) async throws -> MobileSensitiveGrantResponse {
        guard !secret.isEmpty, !targetIds.isEmpty, targetIds.count <= 200,
              targetIds.allSatisfy({ !$0.isEmpty }) else {
            throw MobileApiError.local(
                code: "invalid_request",
                message: "Sensitive verification fields must not be empty"
            )
        }
        let request = MobileSensitiveVerifyRequest(action: action, secret: secret, targetIds: targetIds)
        let response: MobileSensitiveGrantResponse = try await perform(
            path: MobileApiPaths.postMobileV1SensitiveVerify,
            method: "POST",
            body: try encode(request),
            authorization: .sid(value: sid, sensitiveGrant: nil),
            sensitiveValues: [secret] + targetIds
        )
        guard response.action == action.rawValue else {
            throw MobileApiError.local(
                code: "malformed_response",
                message: "The server returned a grant for the wrong action"
            )
        }
        return response
    }

    public func bind(
        _ request: MobileDeviceBindRequest,
        sid: String,
        sensitiveGrant: String
    ) async throws -> MobileDeviceBindResponse {
        try Self.validateDeviceId(request.deviceId)
        guard (16...80).contains(request.deviceId.utf8.count), !request.tokenId.isEmpty,
              request.appVersion == appVersion, (30...86_400).contains(request.syncIntervalSec),
              request.keys.encryption.alg == "ML-KEM-768", request.keys.signing.alg == "ES256",
              request.bindingProtocolVersion == 2,
              MobileBindAttempt.isValidReceipt(request.bindReceipt) else {
            throw MobileApiError.local(
                code: "invalid_request",
                message: "The device binding request is invalid"
            )
        }
        return try await perform(
            path: MobileApiPaths.postMobileV1DevicesBind,
            method: "POST",
            body: try encode(request),
            authorization: .sid(value: sid, sensitiveGrant: sensitiveGrant),
            sensitiveValues: [request.tokenId, request.bindReceipt]
        )
    }

    public func refresh(
        deviceId: String,
        refreshCredential: String
    ) async throws -> MobileDeviceRefreshResponse {
        try Self.validateDeviceId(deviceId)
        guard !refreshCredential.isEmpty else {
            throw MobileApiError.local(
                code: "invalid_request",
                message: "The refresh credential must not be empty"
            )
        }
        let request = MobileDeviceRefreshRequest(
            deviceId: deviceId,
            refreshCredential: refreshCredential
        )
        return try await perform(
            path: MobileApiPaths.postMobileV1DevicesRefresh,
            method: "POST",
            body: try encode(request),
            authorization: .none,
            sensitiveValues: [deviceId, refreshCredential]
        )
    }

    public func patchDevice(
        deviceId: String,
        patch: MobileDevicePatchRequest,
        sid: String
    ) async throws -> MobileDevice {
        try Self.validateDeviceId(deviceId)
        return try await perform(
            path: MobileApiPaths.deviceById(deviceId),
            method: "PATCH",
            body: try encode(patch),
            authorization: .sid(value: sid, sensitiveGrant: nil),
            sensitiveValues: [deviceId]
        )
    }

    public func revokeDevice(
        deviceId: String,
        sid: String,
        sensitiveGrant: String
    ) async throws -> MobileDeviceRevokeResponse {
        try Self.validateDeviceId(deviceId)
        return try await perform(
            path: MobileApiPaths.deviceById(deviceId),
            method: "DELETE",
            authorization: .sid(value: sid, sensitiveGrant: sensitiveGrant),
            sensitiveValues: [deviceId]
        )
    }

    public func bootstrap(pageToken: String? = nil, limit: Int? = nil) async throws -> MobileBootstrapResponse {
        if let limit, !(1...500).contains(limit) {
            throw MobileApiError.local(code: "invalid_request", message: "Bootstrap limit must be between 1 and 500")
        }
        var query = [URLQueryItem]()
        if let pageToken { query.append(URLQueryItem(name: "pageToken", value: pageToken)) }
        if let limit { query.append(URLQueryItem(name: "limit", value: String(limit))) }
        return try await perform(
            path: MobileApiPaths.getMobileV1SyncBootstrap,
            method: "GET",
            query: query,
            authorization: .deviceProof
        )
    }

    public func changes(cursor: Int64, limit: Int? = nil) async throws -> MobileChangesResponse {
        guard cursor >= 0 else {
            throw MobileApiError.local(code: "invalid_request", message: "Cursor must be non-negative")
        }
        if let limit, !(1...500).contains(limit) {
            throw MobileApiError.local(code: "invalid_request", message: "Changes limit must be between 1 and 500")
        }
        var query = [URLQueryItem(name: "cursor", value: String(cursor))]
        if let limit { query.append(URLQueryItem(name: "limit", value: String(limit))) }
        return try await perform(
            path: MobileApiPaths.getMobileV1SyncChanges,
            method: "GET",
            query: query,
            authorization: .deviceProof
        )
    }

    public func push(_ request: MobilePushRequest) async throws -> MobilePushResponse {
        try await perform(
            path: MobileApiPaths.postMobileV1SyncPush,
            method: "POST",
            body: try encode(request),
            authorization: .deviceProof
        )
    }

    public func ack(_ request: MobileAckRequest) async throws -> MobileAckResponse {
        guard request.cursor >= 0 else {
            throw MobileApiError.local(code: "invalid_request", message: "Cursor must be non-negative")
        }
        return try await perform(
            path: MobileApiPaths.postMobileV1SyncAck,
            method: "POST",
            body: try encode(request),
            authorization: .deviceProof
        )
    }

    public func now(_ request: MobileSyncNowRequest = MobileSyncNowRequest()) async throws -> MobileSyncStatusResponse {
        try await perform(
            path: MobileApiPaths.postMobileV1SyncNow,
            method: "POST",
            body: try encode(request),
            authorization: .deviceProof
        )
    }

    public func status() async throws -> MobileSyncStatusResponse {
        try await perform(
            path: MobileApiPaths.getMobileV1SyncStatus,
            method: "GET",
            authorization: .deviceProof
        )
    }

    /// Adds a fresh one-use proof to a data-plane request without sending it.
    /// Streaming transports use this to share the challenge, signing and
    /// credential path while retaining control of their long-lived task.
    public func authorizeDeviceProofRequest(_ request: URLRequest) async throws -> URLRequest {
        try Task.checkCancellation()
        guard let coordinator = proofCoordinator else {
            throw MobileApiError.local(
                code: "device_proof_unavailable",
                message: "Device proof signing is unavailable"
            )
        }
        guard let url = request.url, sameOrigin(url, baseURL), request.httpBodyStream == nil,
              let method = request.httpMethod, !method.isEmpty else {
            throw MobileApiError.local(code: "invalid_request", message: "The proof request is invalid")
        }
        let credential = credentialProvider()
        guard credential.map(Self.isSafeHeaderValue) ?? true else {
            throw MobileApiError.local(
                code: "invalid_credential",
                message: "The access credential is not valid for an HTTP header"
            )
        }
        let binding: DeviceProofRequestBinding
        do {
            binding = try DeviceProofRequestBinding(
                method: method,
                url: url,
                body: request.httpBody ?? Data()
            )
        } catch {
            throw MobileApiError.local(code: "invalid_request", message: "The proof request is invalid")
        }
        let authorization = try await proofAuthorization(
            coordinator: coordinator,
            binding: binding,
            credential: credential
        )

        var authorized = request
        let requestId = safeRequestId()
        authorized.timeoutInterval = requestTimeout
        authorized.cachePolicy = .reloadIgnoringLocalCacheData
        authorized.httpShouldHandleCookies = false
        authorized.setValue(nil, forHTTPHeaderField: "Cookie")
        authorized.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        authorized.setValue("no-cache", forHTTPHeaderField: "Pragma")
        authorized.setValue("1", forHTTPHeaderField: "X-Zephyr-One-Client")
        authorized.setValue("ios", forHTTPHeaderField: "X-Zephyr-One-Platform")
        authorized.setValue(appVersion, forHTTPHeaderField: "X-Zephyr-One-Version")
        authorized.setValue(String(MobileApiPaths.protocolVersion), forHTTPHeaderField: "X-Zephyr-Protocol-Version")
        authorized.setValue(requestId, forHTTPHeaderField: "X-Zephyr-Request-Id")
        if let credential, !credential.isEmpty {
            authorized.setValue("Bearer " + credential, forHTTPHeaderField: "Authorization")
        } else {
            authorized.setValue(nil, forHTTPHeaderField: "Authorization")
        }
        authorized.setValue(authorization.nonce, forHTTPHeaderField: "X-Zephyr-Server-Nonce")
        authorized.setValue(String(authorization.timestamp), forHTTPHeaderField: "X-Zephyr-Proof-Timestamp")
        authorized.setValue(authorization.proof, forHTTPHeaderField: "X-Zephyr-Device-Proof")
        return authorized
    }

    private func encode<Value: Encodable>(_ value: Value) throws -> Data {
        do {
            return try JSONEncoder().encode(value)
        } catch {
            throw MobileApiError.local(
                code: "invalid_request",
                message: "The request could not be encoded"
            )
        }
    }

    private func perform<Value: Decodable>(
        path: String,
        method: String,
        query: [URLQueryItem] = [],
        body: Data? = nil,
        authorization: MobileRequestAuthorization,
        sensitiveValues additionalSensitiveValues: [String] = []
    ) async throws -> Value {
        try Task.checkCancellation()

        let credential: String?
        let sid: String?
        let sidCookie: String?
        let sensitiveGrant: String?
        switch authorization {
        case .none:
            credential = nil
            sid = nil
            sidCookie = nil
            sensitiveGrant = nil
        case .sid(let value, let grant):
            credential = nil
            sid = value
            sidCookie = nil
            sensitiveGrant = grant
        case .sidCookie(let value):
            credential = nil
            sid = nil
            sidCookie = value
            sensitiveGrant = nil
        case .device, .deviceProof:
            credential = credentialProvider()
            sid = nil
            sidCookie = nil
            sensitiveGrant = nil
        }

        let baseSensitiveValues = additionalSensitiveValues +
            [credential, sid, sidCookie, sensitiveGrant].compactMap { $0 }
        let initialRequestId = safeRequestId()
        let headersAreValid = [credential, sid, sidCookie, sensitiveGrant].compactMap { $0 }.allSatisfy {
            !$0.isEmpty && Self.isSafeHeaderValue($0)
        }
        guard headersAreValid else {
            throw MobileApiError(
                code: "invalid_credential",
                message: "A credential is not valid for an HTTP header",
                retryable: false,
                requestId: Self.redact(initialRequestId, sensitiveValues: baseSensitiveValues)
            )
        }

        let url = try endpointURL(path: path, query: query)
        let proofBinding: DeviceProofRequestBinding?
        switch authorization {
        case .deviceProof:
            guard proofCoordinator != nil else {
                throw MobileApiError(
                    code: "device_proof_unavailable",
                    message: "Device proof signing is unavailable",
                    retryable: false,
                    requestId: Self.redact(initialRequestId, sensitiveValues: baseSensitiveValues)
                )
            }
            do {
                proofBinding = try DeviceProofRequestBinding(method: method, url: url, body: body ?? Data())
            } catch {
                throw MobileApiError(
                    code: "invalid_request",
                    message: "The data-plane request cannot be authorized",
                    retryable: false,
                    requestId: Self.redact(initialRequestId, sensitiveValues: baseSensitiveValues)
                )
            }
        case .none, .sid, .sidCookie, .device:
            proofBinding = nil
        }

        let attemptCount = proofBinding == nil ? 1 : 2
        for attempt in 0..<attemptCount {
            try Task.checkCancellation()
            let requestId = attempt == 0 ? initialRequestId : safeRequestId()
            var request = makeRequest(
                url: url,
                method: method,
                body: body,
                bearerCredential: credential,
                sid: sid,
                sidCookie: sidCookie,
                sensitiveGrant: sensitiveGrant,
                requestId: requestId
            )
            var sensitiveValues = baseSensitiveValues
            if let proofBinding, let proofCoordinator {
                let authorization = try await proofAuthorization(
                    coordinator: proofCoordinator,
                    binding: proofBinding,
                    credential: credential
                )
                request.setValue(authorization.nonce, forHTTPHeaderField: "X-Zephyr-Server-Nonce")
                request.setValue(String(authorization.timestamp), forHTTPHeaderField: "X-Zephyr-Proof-Timestamp")
                request.setValue(authorization.proof, forHTTPHeaderField: "X-Zephyr-Device-Proof")
                sensitiveValues.append(authorization.nonce)
                sensitiveValues.append(authorization.proof)
            }

            let loaded = try await loadHTTP(
                request,
                requestId: requestId,
                sensitiveValues: sensitiveValues
            )
            guard (200..<300).contains(loaded.response.statusCode) else {
                let error = decodeError(
                    status: loaded.response.statusCode,
                    data: loaded.data,
                    requestId: loaded.responseRequestId,
                    retryAfterSeconds: Self.retryAfterSeconds(
                        loaded.response.value(forHTTPHeaderField: "Retry-After")
                    ),
                    sensitiveValues: sensitiveValues
                )
                if proofBinding != nil, attempt == 0, error.code == "device_proof_invalid" {
                    continue
                }
                throw error
            }

            do {
                return try JSONDecoder().decode(Value.self, from: loaded.data)
            } catch {
                throw MobileApiError(
                    code: "malformed_response",
                    message: "The server returned malformed JSON",
                    retryable: false,
                    requestId: loaded.responseRequestId,
                    httpStatus: loaded.response.statusCode
                )
            }
        }

        throw MobileApiError(
            code: "device_proof_invalid",
            message: "The device proof was rejected",
            retryable: false,
            requestId: Self.redact(initialRequestId, sensitiveValues: baseSensitiveValues),
            httpStatus: 401
        )
    }

    private func proofAuthorization(
        coordinator: DeviceProofCoordinator,
        binding: DeviceProofRequestBinding,
        credential: String?
    ) async throws -> DeviceProofAuthorization {
        for attempt in 0..<2 {
            do {
                return try await coordinator.authorize(binding: binding) { challengeRequest in
                    do {
                        let requestId = self.safeRequestId()
                        let body = try self.encode(challengeRequest)
                        let request = self.makeRequest(
                            url: try self.endpointURL(
                                path: MobileApiPaths.postMobileV1DevicesProofChallenge,
                                query: []
                            ),
                            method: "POST",
                            body: body,
                            bearerCredential: credential,
                            sid: nil,
                            sidCookie: nil,
                            sensitiveGrant: nil,
                            requestId: requestId
                        )
                        let sensitiveValues = [credential].compactMap { $0 }
                        let loaded = try await self.loadHTTP(
                            request,
                            requestId: requestId,
                            sensitiveValues: sensitiveValues
                        )
                        guard (200..<300).contains(loaded.response.statusCode) else {
                            throw self.decodeError(
                                status: loaded.response.statusCode,
                                data: loaded.data,
                                requestId: loaded.responseRequestId,
                                retryAfterSeconds: Self.retryAfterSeconds(
                                    loaded.response.value(forHTTPHeaderField: "Retry-After")
                                ),
                                sensitiveValues: sensitiveValues
                            )
                        }
                        do {
                            return try JSONDecoder().decode(DeviceProofChallengeResponse.self, from: loaded.data)
                        } catch {
                            throw MobileApiError(
                                code: "malformed_response",
                                message: "The server returned malformed JSON",
                                retryable: false,
                                requestId: loaded.responseRequestId,
                                httpStatus: loaded.response.statusCode
                            )
                        }
                    } catch is CancellationError {
                        throw CancellationError()
                    } catch let error as MobileApiError {
                        throw DeviceProofChallengeTransportFailure(error: error)
                    } catch {
                        throw DeviceProofChallengeTransportFailure(error: MobileApiError.local(
                            code: "network_unreachable",
                            message: "The server could not be reached",
                            retryable: true
                        ))
                    }
                }
            } catch is CancellationError {
                throw CancellationError()
            } catch let failure as DeviceProofChallengeTransportFailure {
                throw failure.error
            } catch DeviceProofCoordinatorError.challengeExpired where attempt == 0 {
                continue
            } catch DeviceProofCoordinatorError.invalidSignature {
                throw MobileApiError.local(
                    code: "device_key_unavailable",
                    message: "The device signing key is unavailable"
                )
            } catch is DeviceProofCoordinatorError {
                throw MobileApiError.local(
                    code: "malformed_response",
                    message: "The server returned an invalid device proof challenge"
                )
            } catch {
                throw MobileApiError.local(
                    code: "device_key_unavailable",
                    message: "The device signing key is unavailable"
                )
            }
        }
        throw MobileApiError.local(
            code: "malformed_response",
            message: "The server returned an invalid device proof challenge"
        )
    }

    private func makeRequest(
        url: URL,
        method: String,
        body: Data?,
        bearerCredential: String?,
        sid: String?,
        sidCookie: String?,
        sensitiveGrant: String?,
        requestId: String
    ) -> URLRequest {
        var request = URLRequest(
            url: url,
            cachePolicy: .reloadIgnoringLocalCacheData,
            timeoutInterval: requestTimeout
        )
        request.httpMethod = method
        request.httpShouldHandleCookies = false
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        request.setValue("no-cache", forHTTPHeaderField: "Pragma")
        request.setValue("1", forHTTPHeaderField: "X-Zephyr-One-Client")
        request.setValue("ios", forHTTPHeaderField: "X-Zephyr-One-Platform")
        request.setValue(appVersion, forHTTPHeaderField: "X-Zephyr-One-Version")
        request.setValue(String(MobileApiPaths.protocolVersion), forHTTPHeaderField: "X-Zephyr-Protocol-Version")
        request.setValue(requestId, forHTTPHeaderField: "X-Zephyr-Request-Id")
        if body != nil { request.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type") }
        if let bearerCredential, !bearerCredential.isEmpty {
            request.setValue("Bearer " + bearerCredential, forHTTPHeaderField: "Authorization")
        }
        if let sid, !sid.isEmpty {
            request.setValue(sid, forHTTPHeaderField: "X-Zephyr-Sid")
        }
        if let sidCookie, let encodedSID = Self.encodedCookieValue(sidCookie) {
            request.setValue("zephyr_sid=" + encodedSID, forHTTPHeaderField: "Cookie")
        }
        if let sensitiveGrant, !sensitiveGrant.isEmpty {
            request.setValue(sensitiveGrant, forHTTPHeaderField: "X-Zephyr-Sensitive-Grant")
        }
        return request
    }

    static func sensitiveSessionConfiguration(
        from template: URLSessionConfiguration
    ) -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral

        // Preserve transport choices and test URLProtocols, but never inherit
        // process-wide HTTP state from URLSession.shared or another session.
        configuration.protocolClasses = template.protocolClasses
        configuration.connectionProxyDictionary = template.connectionProxyDictionary
        configuration.waitsForConnectivity = template.waitsForConnectivity
        configuration.allowsCellularAccess = template.allowsCellularAccess
        configuration.allowsConstrainedNetworkAccess = template.allowsConstrainedNetworkAccess
        configuration.allowsExpensiveNetworkAccess = template.allowsExpensiveNetworkAccess
        configuration.networkServiceType = template.networkServiceType
        configuration.multipathServiceType = template.multipathServiceType
        configuration.httpMaximumConnectionsPerHost = template.httpMaximumConnectionsPerHost
        configuration.httpShouldUsePipelining = template.httpShouldUsePipelining
        configuration.timeoutIntervalForResource = template.timeoutIntervalForResource

        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.httpAdditionalHeaders = nil
        return configuration
    }

    static func removeLegacySIDCookie(for baseURL: URL, from storage: HTTPCookieStorage) {
        guard var origin = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            return
        }
        origin.query = nil
        origin.fragment = nil

        // Querying cookies only for `/` misses a legacy SID scoped to `/api`
        // or another narrower path. Ask the system cookie matcher about each
        // candidate at its own path so host-only and Domain cookies retain
        // their native applicability rules.
        for cookie in storage.cookies ?? [] where cookie.name == "zephyr_sid" {
            origin.path = cookie.path.hasPrefix("/") ? cookie.path : "/"
            guard let candidateURL = origin.url else { continue }
            let appliesToOrigin = storage.cookies(for: candidateURL)?.contains {
                $0.name == cookie.name && $0.value == cookie.value &&
                    $0.domain.caseInsensitiveCompare(cookie.domain) == .orderedSame &&
                    $0.path == cookie.path
            } == true
            guard appliesToOrigin else { continue }
            storage.deleteCookie(cookie)
        }
    }

    private static func encodedCookieValue(_ value: String) -> String? {
        let allowed = CharacterSet(
            charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
        )
        return value.addingPercentEncoding(withAllowedCharacters: allowed)
    }

    private func loadHTTP(
        _ request: URLRequest,
        requestId: String,
        sensitiveValues: [String]
    ) async throws -> LoadedMobileHTTPResponse {
        let sanitizedRequestId = Self.redact(requestId, sensitiveValues: sensitiveValues)
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await sessionDelegate.load(
                request,
                using: session,
                byteLimit: responseByteLimit
            )
        } catch let tooLarge as BoundedURLSessionDelegate.ResponseTooLargeError {
            let http = tooLarge.response
            let responseRequestId = Self.redact(
                http?.value(forHTTPHeaderField: "X-Zephyr-Request-Id") ?? requestId,
                sensitiveValues: sensitiveValues
            )
            throw MobileApiError(
                code: "response_too_large",
                message: "response exceeds the \(responseByteLimit) byte limit",
                retryable: false,
                requestId: responseRequestId,
                httpStatus: http?.statusCode
            )
        } catch is CancellationError {
            throw CancellationError()
        } catch let urlError as URLError {
            if urlError.code == .cancelled { throw CancellationError() }
            if urlError.code == .notConnectedToInternet {
                throw MobileApiError(
                    code: MobileApiError.offline.code,
                    message: MobileApiError.offline.message,
                    retryable: true,
                    requestId: sanitizedRequestId
                )
            }
            if urlError.code == .timedOut {
                throw MobileApiError(
                    code: "network_timeout",
                    message: "The request timed out",
                    retryable: true,
                    requestId: sanitizedRequestId
                )
            }
            throw MobileApiError(
                code: "network_unreachable",
                message: "The server could not be reached",
                retryable: true,
                requestId: sanitizedRequestId
            )
        } catch {
            throw MobileApiError(
                code: "network_unreachable",
                message: "The server could not be reached",
                retryable: true,
                requestId: sanitizedRequestId
            )
        }

        try Task.checkCancellation()
        guard let http = response as? HTTPURLResponse else {
            throw MobileApiError(
                code: "malformed_response",
                message: "The server response was not HTTP",
                retryable: false,
                requestId: sanitizedRequestId
            )
        }

        let responseRequestId = Self.redact(
            http.value(forHTTPHeaderField: "X-Zephyr-Request-Id") ?? requestId,
            sensitiveValues: sensitiveValues
        )
        if (300..<400).contains(http.statusCode) {
            throw MobileApiError(
                code: "unexpected_redirect",
                message: "The server attempted an unexpected redirect",
                retryable: false,
                requestId: responseRequestId,
                httpStatus: http.statusCode
            )
        }
        return LoadedMobileHTTPResponse(
            data: data,
            response: http,
            responseRequestId: responseRequestId
        )
    }

    private func endpointURL(path: String, query: [URLQueryItem]) throws -> URL {
        var url = baseURL
        for segment in path.split(separator: "/", omittingEmptySubsequences: true) {
            guard segment != ".", segment != ".." else {
                throw MobileApiError.local(code: "invalid_request", message: "The API path is invalid")
            }
            url = url.appendingPathComponent(String(segment), isDirectory: false)
        }
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            throw MobileApiError.local(code: "invalid_request", message: "The API URL is invalid")
        }
        if !query.isEmpty { components.queryItems = query }
        guard let result = components.url else {
            throw MobileApiError.local(code: "invalid_request", message: "The API URL is invalid")
        }
        return result
    }

    private func sameOrigin(_ candidate: URL, _ expected: URL) -> Bool {
        guard candidate.scheme?.lowercased() == "https",
              candidate.user == nil,
              candidate.password == nil,
              candidate.host?.lowercased() == expected.host?.lowercased() else {
            return false
        }
        return (candidate.port ?? 443) == (expected.port ?? 443)
    }

    private func decodeError(
        status: Int,
        data: Data,
        requestId: String,
        retryAfterSeconds: Int64?,
        sensitiveValues: [String]
    ) -> MobileApiError {
        if let envelope = try? JSONDecoder().decode(MobileErrorEnvelope.self, from: data),
           envelope.ok == false,
           !envelope.error.code.isEmpty {
            let body = envelope.error
            var details = [String: String]()
            for (key, value) in body.details ?? [:] {
                details[Self.redact(key, sensitiveValues: sensitiveValues)] = Self.redact(
                    value.diagnosticString,
                    sensitiveValues: sensitiveValues
                )
            }
            let envelopeRequestId = body.requestId
                .flatMap { $0.isEmpty ? nil : $0 }
                .map { Self.redact($0, sensitiveValues: sensitiveValues) }
            return MobileApiError(
                code: Self.redact(body.code, sensitiveValues: sensitiveValues),
                message: Self.redact(body.message, sensitiveValues: sensitiveValues),
                retryable: body.retryable,
                requestId: envelopeRequestId ?? requestId,
                details: details,
                httpStatus: status,
                retryAfterSeconds: retryAfterSeconds
            )
        }

        let code: String
        switch status {
        case 401: code = "access_expired"
        case 403: code = "forbidden_unstructured"
        case 404: code = "not_found_unstructured"
        case 409: code = "conflict_unstructured"
        case 429: code = "rate_limited"
        case 500...599: code = "server_error"
        default: code = "http_" + String(status)
        }
        return MobileApiError(
            code: code,
            message: "The server returned an unstructured HTTP error",
            retryable: status == 429 || status >= 500,
            requestId: requestId,
            httpStatus: status,
            retryAfterSeconds: retryAfterSeconds
        )
    }

    private func safeRequestId() -> String {
        let candidate = requestIdProvider()
        if !candidate.isEmpty, Self.isSafeHeaderValue(candidate) { return candidate }
        return UUID().uuidString
    }

    private static func isSafeHeaderValue(_ value: String) -> Bool {
        !value.contains("\r") && !value.contains("\n")
    }

    private static func validateDeviceId(_ deviceId: String) throws {
        guard !deviceId.isEmpty,
              !deviceId.contains("/"),
              !deviceId.contains("\\"),
              !deviceId.contains(".") else {
            throw MobileApiError.local(
                code: "invalid_request",
                message: "The device identifier is not safe for an API path"
            )
        }
    }

    private static func redact(_ text: String, sensitiveValues: [String]) -> String {
        sensitiveValues.reduce(text) { value, sensitive in
            sensitive.isEmpty ? value : value.replacingOccurrences(of: sensitive, with: "[REDACTED]")
        }
    }

    private static func retryAfterSeconds(_ value: String?) -> Int64? {
        guard let value else { return nil }
        if let seconds = Int64(value.trimmingCharacters(in: .whitespaces)), seconds >= 0 {
            return seconds
        }

        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "EEE',' dd MMM yyyy HH':'mm':'ss z"
        guard let target = formatter.date(from: value) else { return nil }
        let delta = Int64(target.timeIntervalSinceNow.rounded(.down))
        return delta > 0 ? delta : nil
    }
}
