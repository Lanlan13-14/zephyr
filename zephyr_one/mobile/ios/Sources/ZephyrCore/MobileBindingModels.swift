import Foundation
import ZephyrContracts

public enum MobileBindingConfigurationError: Error, Equatable, Sendable, CustomStringConvertible {
    case invalidServerURL
    case invalidAppVersion
    case invalidDeviceID
    case invalidDatabaseDirectory
    case invalidRegistration

    public var description: String {
        switch self {
        case .invalidServerURL: return "a canonical HTTPS server URL is required"
        case .invalidAppVersion: return "the application version is invalid"
        case .invalidDeviceID: return "the device identifier is invalid"
        case .invalidDatabaseDirectory: return "the sync database directory is invalid"
        case .invalidRegistration: return "the device registration is invalid"
        }
    }
}

/// Immutable, non-secret inputs for one Zephyr main-end deployment.
///
/// WSS is accepted as a user-facing alias and canonicalized to HTTPS. The
/// canonical URL has no credentials, query or fragment, and always ends in a
/// slash so every API client derives the same origin and base path.
public struct MobileBindingConfiguration: Equatable, Sendable {
    public let baseURL: String
    public let appVersion: String
    public let sha256SPKIPins: [String]
    public let databaseDirectory: URL
    public let deviceID: String

    public init(
        baseURL: String,
        appVersion: String,
        sha256SPKIPins: [String] = [],
        databaseDirectory: URL,
        deviceID: String
    ) throws {
        self.baseURL = try Self.normalize(baseURL)
        guard !appVersion.isEmpty, appVersion.utf8.count <= 40,
              Self.isSafeText(appVersion) else {
            throw MobileBindingConfigurationError.invalidAppVersion
        }
        guard (16...80).contains(deviceID.utf8.count),
              deviceID.utf8.allSatisfy({
                  (48...57).contains($0) || (65...90).contains($0) ||
                      (97...122).contains($0) || $0 == 45 || $0 == 95
              }) else {
            throw MobileBindingConfigurationError.invalidDeviceID
        }
        guard databaseDirectory.isFileURL, !databaseDirectory.path.isEmpty else {
            throw MobileBindingConfigurationError.invalidDatabaseDirectory
        }
        self.appVersion = appVersion
        self.sha256SPKIPins = sha256SPKIPins
        self.databaseDirectory = databaseDirectory.standardizedFileURL
        self.deviceID = deviceID
    }

    private static func normalize(_ value: String) throws -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var components = URLComponents(string: trimmed),
              let originalScheme = components.scheme?.lowercased(),
              originalScheme == "https" || originalScheme == "wss",
              components.host?.isEmpty == false,
              components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil else {
            throw MobileBindingConfigurationError.invalidServerURL
        }
        components.scheme = "https"
        if !components.path.hasSuffix("/") { components.path += "/" }
        guard let url = components.url?.standardized else {
            throw MobileBindingConfigurationError.invalidServerURL
        }
        guard let checked = URLComponents(url: url, resolvingAgainstBaseURL: false),
              checked.scheme?.lowercased() == "https", checked.host?.isEmpty == false,
              checked.user == nil, checked.password == nil,
              checked.query == nil, checked.fragment == nil else {
            throw MobileBindingConfigurationError.invalidServerURL
        }
        return url.absoluteString
    }

    private static func isSafeText(_ value: String) -> Bool {
        !value.unicodeScalars.contains { $0.value == 0 || $0.value == 10 || $0.value == 13 }
    }
}

public struct MobileBindingRegistration: Equatable, Sendable {
    public let tokenID: String
    public let tokenName: String
    public let deviceName: String
    public let syncIntervalSeconds: Int

    public init(
        tokenID: String,
        tokenName: String = "",
        deviceName: String,
        syncIntervalSeconds: Int = SyncContract.defaultIntervalSec
    ) throws {
        let trimmedDeviceName = deviceName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !tokenID.isEmpty, Self.isSafeText(tokenID),
              !trimmedDeviceName.isEmpty, trimmedDeviceName.count <= 120,
              Self.isSafeText(trimmedDeviceName),
              (SyncContract.minIntervalSec...SyncContract.maxIntervalSec).contains(syncIntervalSeconds) else {
            throw MobileBindingConfigurationError.invalidRegistration
        }
        self.tokenID = tokenID
        self.tokenName = tokenName
        self.deviceName = trimmedDeviceName
        self.syncIntervalSeconds = syncIntervalSeconds
    }

    private static func isSafeText(_ value: String) -> Bool {
        !value.unicodeScalars.contains { $0.value == 0 || $0.value == 10 || $0.value == 13 }
    }
}

/// Safe token metadata. A token credential or reveal value never enters this
/// model and therefore cannot be passed to presentation code by accident.
public struct MobileBindingToken: Equatable, Sendable {
    public let id: String
    public let name: String
    public let ownerAccountID: String
    public let enabled: Bool

    public init(id: String, name: String, ownerAccountID: String, enabled: Bool = true) {
        self.id = id
        self.name = name
        self.ownerAccountID = ownerAccountID
        self.enabled = enabled
    }
}

public enum MobileBindingLoginStep: Equatable, Sendable {
    case totpRequired
    case passwordChangeRequired
    case ready(accountID: String, username: String)
}

public struct MobileBindingSummary: Equatable, Sendable {
    public let baseURL: String
    public let serverID: String
    public let accountID: String
    public let username: String
    public let deviceID: String
    public let deviceName: String
    public let tokenID: String
    public let tokenName: String
    public let registryHash: String
    public let generation: String
    public let syncIntervalSeconds: Int
    public let boundAtMilliseconds: Int64

    public init(
        baseURL: String,
        serverID: String,
        accountID: String,
        username: String,
        deviceID: String,
        deviceName: String,
        tokenID: String,
        tokenName: String,
        registryHash: String,
        generation: String,
        syncIntervalSeconds: Int,
        boundAtMilliseconds: Int64
    ) {
        self.baseURL = baseURL
        self.serverID = serverID
        self.accountID = accountID
        self.username = username
        self.deviceID = deviceID
        self.deviceName = deviceName
        self.tokenID = tokenID
        self.tokenName = tokenName
        self.registryHash = registryHash
        self.generation = generation
        self.syncIntervalSeconds = syncIntervalSeconds
        self.boundAtMilliseconds = boundAtMilliseconds
    }
}

public enum MobileBindingCleanupComponent: String, Codable, Equatable, Hashable, Sendable {
    case scheduler
    case repository
    case credentials
    case signingIdentity
    case encryptionIdentity
    case bindingRecord
}

public enum MobileBindingCoordinatorError: Error, Equatable, Sendable, CustomStringConvertible {
    case invalidState
    case authenticationCancelled
    case passwordChangeRequired
    case tokenLoaderUnavailable
    case unsupportedProtocol
    case unsupportedSyncFeatures
    case identityMismatch
    case grantExpired
    case incompleteBinding
    case cleanupFailed([MobileBindingCleanupComponent])

    public var description: String {
        switch self {
        case .invalidState: return "the binding flow is not in the required state"
        case .authenticationCancelled: return "authentication was cancelled"
        case .passwordChangeRequired: return "the account password must be changed before binding"
        case .tokenLoaderUnavailable: return "client token metadata is unavailable"
        case .unsupportedProtocol: return "the server does not support this sync protocol"
        case .unsupportedSyncFeatures: return "the server does not support secure realtime sync"
        case .identityMismatch: return "the restored binding identity does not match the server"
        case .grantExpired: return "the sensitive grant expired before it could be used"
        case .incompleteBinding: return "the stored binding is incomplete"
        case .cleanupFailed(let components):
            return "binding cleanup failed for " + components.map(\.rawValue).joined(separator: ",")
        }
    }
}

public protocol MobileBindingTokenLoading: Sendable {
    /// Called only inside ``MobileBindingCoordinator``. Implementations must
    /// treat `sid` as an ephemeral credential and must not persist or log it.
    func tokens(sid: String, accountID: String) async throws -> [MobileBindingToken]
}

/// The device-local ML-KEM identity. ZephyrCore targets iOS 15, where CryptoKit
/// cannot create an ML-KEM-768 key, so Core supplies its pinned OpenSSL backend
/// and owns the binding-scoped persistence and lifecycle ordering.
public protocol MobileEncryptionIdentityManaging: Sendable {
    func publicIdentity(for identity: SyncBindingIdentity) throws -> MobileDeviceEncryptionKey
    func hasIdentity(for identity: SyncBindingIdentity) throws -> Bool
    func deleteIdentity(for identity: SyncBindingIdentity) throws
}

public protocol MobileBindingClock: SyncClock {}

extension SystemSyncClock: MobileBindingClock {}
