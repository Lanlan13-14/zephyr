import Foundation
import Security

public enum SyncDatabaseKeyStoreError: Error, Equatable, CustomStringConvertible {
    case invalidScope
    case invalidStoredKey
    case randomFailure(OSStatus)

    public var description: String {
        switch self {
        case .invalidScope:
            return "database key scope is invalid"
        case .invalidStoredKey:
            return "the stored database key is invalid"
        case .randomFailure(let status):
            return "database key generation failed (OSStatus \(status))"
        }
    }
}

/// Names one encrypted mirror. Every binding generation receives an independent
/// key, even when the same account binds the same physical device again.
public struct SyncDatabaseKeyScope: Equatable, Sendable {
    public let serverID: String
    public let accountID: String
    public let deviceID: String
    public let generation: String

    public init(
        serverID: String,
        accountID: String,
        deviceID: String,
        generation: String
    ) throws {
        let components = [serverID, accountID, deviceID, generation]
        guard components.allSatisfy(Self.isValid) else {
            throw SyncDatabaseKeyStoreError.invalidScope
        }
        self.serverID = serverID
        self.accountID = accountID
        self.deviceID = deviceID
        self.generation = generation
    }

    init(identity: SyncBindingIdentity) throws {
        try self.init(
            serverID: identity.serverID,
            accountID: identity.accountID,
            deviceID: identity.deviceID,
            generation: identity.generation
        )
    }

    fileprivate func service(prefix: String) -> String {
        [
            prefix,
            KeychainNamespace.encode(serverID),
            KeychainNamespace.encode(accountID),
            KeychainNamespace.encode(deviceID),
        ].joined(separator: ".")
    }

    fileprivate var account: String {
        "generation." + KeychainNamespace.encode(generation)
    }

    private static func isValid(_ value: String) -> Bool {
        !value.isEmpty && !value.unicodeScalars.contains(where: {
            $0.value == 0 || $0.value == 10 || $0.value == 13
        })
    }
}

public protocol SyncDatabaseKeyStoring: Sendable {
    func loadKey(for scope: SyncDatabaseKeyScope) throws -> Data?
    func loadOrCreateKey(for scope: SyncDatabaseKeyScope) throws -> Data
    func deleteKey(for scope: SyncDatabaseKeyScope) throws
}

/// Stores a raw 256-bit SQLCipher key in a non-synchronizable, unlocked-only,
/// ThisDeviceOnly generic-password item.
public final class KeychainSyncDatabaseKeyStore: SyncDatabaseKeyStoring, @unchecked Sendable {
    public static let keyByteCount = 32
    public static let defaultServicePrefix = "one.zephyr.mobile.sync-database-key.v1"
    public static let shared = KeychainSyncDatabaseKeyStore(
        uncheckedServicePrefix: defaultServicePrefix,
        items: SystemKeychainItems(),
        randomBytes: secureRandomBytes
    )

    private let servicePrefix: String
    private let items: KeychainItemAccessing
    private let randomBytes: @Sendable (Int) throws -> Data
    private let lock = NSLock()

    public convenience init(
        servicePrefix: String = KeychainSyncDatabaseKeyStore.defaultServicePrefix
    ) throws {
        try self.init(
            servicePrefix: servicePrefix,
            items: SystemKeychainItems(),
            randomBytes: Self.secureRandomBytes
        )
    }

    init(
        servicePrefix: String,
        items: KeychainItemAccessing,
        randomBytes: @escaping @Sendable (Int) throws -> Data
    ) throws {
        guard !servicePrefix.isEmpty,
              !servicePrefix.unicodeScalars.contains(where: { $0.value == 0 }) else {
            throw SyncDatabaseKeyStoreError.invalidScope
        }
        self.servicePrefix = servicePrefix
        self.items = items
        self.randomBytes = randomBytes
    }

    private init(
        uncheckedServicePrefix servicePrefix: String,
        items: KeychainItemAccessing,
        randomBytes: @escaping @Sendable (Int) throws -> Data
    ) {
        self.servicePrefix = servicePrefix
        self.items = items
        self.randomBytes = randomBytes
    }

    public func loadKey(for scope: SyncDatabaseKeyScope) throws -> Data? {
        try synchronized {
            try readValidatedKey(for: scope)
        }
    }

    public func loadOrCreateKey(for scope: SyncDatabaseKeyScope) throws -> Data {
        try synchronized {
            if let existing = try readValidatedKey(for: scope) {
                return existing
            }

            let candidate = try randomBytes(Self.keyByteCount)
            guard candidate.count == Self.keyByteCount else {
                throw SyncDatabaseKeyStoreError.invalidStoredKey
            }
            let inserted = try items.addGenericPasswordIfAbsent(
                candidate,
                service: scope.service(prefix: servicePrefix),
                account: scope.account,
                accessibility: .whenUnlockedThisDeviceOnly
            )
            if inserted { return candidate }

            // A second process won the insert race. Always use the durable
            // winner rather than the candidate generated by this process.
            guard let winner = try readValidatedKey(for: scope) else {
                throw SyncDatabaseKeyStoreError.invalidStoredKey
            }
            return winner
        }
    }

    public func deleteKey(for scope: SyncDatabaseKeyScope) throws {
        try synchronized {
            try items.deleteGenericPassword(
                service: scope.service(prefix: servicePrefix),
                account: scope.account
            )
        }
    }

    private func readValidatedKey(for scope: SyncDatabaseKeyScope) throws -> Data? {
        guard let key = try items.readGenericPassword(
            service: scope.service(prefix: servicePrefix),
            account: scope.account
        ) else { return nil }
        guard key.count == Self.keyByteCount else {
            throw SyncDatabaseKeyStoreError.invalidStoredKey
        }
        return key
    }

    private static func secureRandomBytes(count: Int) throws -> Data {
        var bytes = Data(count: count)
        let status = bytes.withUnsafeMutableBytes { buffer in
            SecRandomCopyBytes(kSecRandomDefault, count, buffer.baseAddress!)
        }
        guard status == errSecSuccess else {
            throw SyncDatabaseKeyStoreError.randomFailure(status)
        }
        return bytes
    }

    private func synchronized<T>(_ operation: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try operation()
    }
}
