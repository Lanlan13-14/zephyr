import CryptoKit
import Foundation
import Security

enum KeychainResourceLeaseError: Error, Equatable {
    case corruptRecord
}

enum KeychainResourceLeaseState: String, Codable {
    case active
    case terminated
}

struct KeychainResourceLeaseScope: Equatable, Sendable {
    let resource: String
    let identity: SyncBindingIdentity

    var components: [String] {
        [
            resource,
            identity.serverID,
            identity.accountID,
            identity.deviceID,
            identity.generation,
        ]
    }
}

/// Cross-process ownership record for one generation-scoped Keychain resource.
/// Active payloads may contain only a non-secret Keychain locator. Termination
/// retains the exact random version while requiring the payload to be absent.
struct KeychainResourceLeaseEnvelope: Codable, Equatable, Sendable {
    static let formatVersion = 1
    static let resourceVersionBytes = 32

    let version: Int
    let state: KeychainResourceLeaseState
    let resource: String
    let serverID: String
    let accountID: String
    let deviceID: String
    let generation: String
    let resourceVersion: Data
    let payload: Data?

    init(
        state: KeychainResourceLeaseState,
        scope: KeychainResourceLeaseScope,
        resourceVersion: Data,
        payload: Data?
    ) throws {
        guard resourceVersion.count == Self.resourceVersionBytes,
              scope.components.allSatisfy(Self.validComponent),
              state == .active || payload == nil else {
            throw KeychainResourceLeaseError.corruptRecord
        }
        self.version = Self.formatVersion
        self.state = state
        self.resource = scope.resource
        self.serverID = scope.identity.serverID
        self.accountID = scope.identity.accountID
        self.deviceID = scope.identity.deviceID
        self.generation = scope.identity.generation
        self.resourceVersion = resourceVersion
        self.payload = payload
    }

    var scope: KeychainResourceLeaseScope {
        KeychainResourceLeaseScope(
            resource: resource,
            identity: SyncBindingIdentity(
                serverID: serverID,
                accountID: accountID,
                deviceID: deviceID,
                generation: generation
            )
        )
    }

    func terminated() throws -> KeychainResourceLeaseEnvelope {
        try KeychainResourceLeaseEnvelope(
            state: .terminated,
            scope: scope,
            resourceVersion: resourceVersion,
            payload: nil
        )
    }

    fileprivate static func validComponent(_ value: String) -> Bool {
        !value.isEmpty && !value.unicodeScalars.contains(where: { scalar in
            scalar.value == 0 || scalar.value == 10 || scalar.value == 13
        })
    }
}

struct KeychainResourceLeaseItem: Equatable, Sendable {
    let data: Data
    let comparisonToken: Data
}

struct KeychainResourceLeaseSnapshot: Equatable, Sendable {
    let envelope: KeychainResourceLeaseEnvelope
    let item: KeychainResourceLeaseItem
}

enum KeychainResourceLeaseCodec {
    private static let tokenDomain = Data("one.zephyr.mobile.resource-lease-cas.v1\0".utf8)

    static func makeItem(for envelope: KeychainResourceLeaseEnvelope) throws -> KeychainResourceLeaseItem {
        guard envelope.version == KeychainResourceLeaseEnvelope.formatVersion,
              envelope.resourceVersion.count == KeychainResourceLeaseEnvelope.resourceVersionBytes,
              envelope.scope.components.allSatisfy(KeychainResourceLeaseEnvelope.validComponent),
              envelope.state == .active || envelope.payload == nil else {
            throw KeychainResourceLeaseError.corruptRecord
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(envelope) else {
            throw KeychainResourceLeaseError.corruptRecord
        }
        return KeychainResourceLeaseItem(
            data: data,
            comparisonToken: comparisonToken(for: data)
        )
    }

    static func decode(
        _ item: KeychainResourceLeaseItem,
        expectedScope: KeychainResourceLeaseScope
    ) throws -> KeychainResourceLeaseSnapshot {
        guard let envelope = try? JSONDecoder().decode(
            KeychainResourceLeaseEnvelope.self,
            from: item.data
        ),
        envelope.version == KeychainResourceLeaseEnvelope.formatVersion,
        envelope.scope == expectedScope,
        envelope.resourceVersion.count == KeychainResourceLeaseEnvelope.resourceVersionBytes,
        envelope.scope.components.allSatisfy(KeychainResourceLeaseEnvelope.validComponent),
        envelope.state == .active || envelope.payload == nil,
        let canonical = try? makeItem(for: envelope),
        canonical.data == item.data,
        canonical.comparisonToken == item.comparisonToken else {
            throw KeychainResourceLeaseError.corruptRecord
        }
        return KeychainResourceLeaseSnapshot(envelope: envelope, item: item)
    }

    static func randomResourceVersion() throws -> Data {
        var value = Data(
            repeating: 0,
            count: KeychainResourceLeaseEnvelope.resourceVersionBytes
        )
        let status = value.withUnsafeMutableBytes {
            (buffer: UnsafeMutableRawBufferPointer) -> OSStatus in
            guard let baseAddress = buffer.baseAddress else { return errSecParam }
            return SecRandomCopyBytes(kSecRandomDefault, buffer.count, baseAddress)
        }
        guard status == errSecSuccess else { throw KeychainStorageError.status(status) }
        return value
    }

    private static func comparisonToken(for data: Data) -> Data {
        var material = tokenDomain
        material.append(data)
        return Data(SHA256.hash(data: material))
    }
}

protocol KeychainResourceLeaseAccessing: AnyObject, Sendable {
    func read(service: String, account: String) throws -> KeychainResourceLeaseItem?

    func insertIfAbsent(
        _ item: KeychainResourceLeaseItem,
        service: String,
        account: String
    ) throws -> Bool

    func replace(
        _ item: KeychainResourceLeaseItem,
        matchingComparisonToken expectedComparisonToken: Data,
        service: String,
        account: String
    ) throws -> Bool
}

final class SystemKeychainResourceLeases: KeychainResourceLeaseAccessing, @unchecked Sendable {
    func read(service: String, account: String) throws -> KeychainResourceLeaseItem? {
        var query = baseQuery(service: service, account: account)
        query[kSecReturnAttributes] = true
        query[kSecReturnData] = true
        query[kSecMatchLimit] = kSecMatchLimitOne

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        switch status {
        case errSecSuccess:
            guard let attributes = result as? NSDictionary,
                  let data = attributes.object(forKey: kSecValueData) as? Data,
                  let token = attributes.object(forKey: kSecAttrGeneric) as? Data else {
                throw KeychainStorageError.status(errSecDecode)
            }
            return KeychainResourceLeaseItem(data: data, comparisonToken: token)
        case errSecItemNotFound:
            return nil
        default:
            throw KeychainStorageError.status(status)
        }
    }

    func insertIfAbsent(
        _ item: KeychainResourceLeaseItem,
        service: String,
        account: String
    ) throws -> Bool {
        var attributes = baseQuery(service: service, account: account)
        attributes[kSecValueData] = item.data
        attributes[kSecAttrGeneric] = item.comparisonToken
        attributes[kSecAttrAccessible] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let status = SecItemAdd(attributes as CFDictionary, nil)
        switch status {
        case errSecSuccess: return true
        case errSecDuplicateItem: return false
        default: throw KeychainStorageError.status(status)
        }
    }

    func replace(
        _ item: KeychainResourceLeaseItem,
        matchingComparisonToken expectedComparisonToken: Data,
        service: String,
        account: String
    ) throws -> Bool {
        var query = baseQuery(service: service, account: account)
        query[kSecAttrGeneric] = expectedComparisonToken
        let status = SecItemUpdate(
            query as CFDictionary,
            [
                kSecValueData: item.data,
                kSecAttrGeneric: item.comparisonToken,
                kSecAttrAccessible: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            ] as CFDictionary
        )
        switch status {
        case errSecSuccess: return true
        case errSecItemNotFound: return false
        default: throw KeychainStorageError.status(status)
        }
    }

    private func baseQuery(service: String, account: String) -> [CFString: Any] {
        [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
            kSecAttrSynchronizable: kCFBooleanFalse as Any,
            kSecUseDataProtectionKeychain: true,
        ]
    }
}

/// Keeps dependency-injected unit fakes away from the real Keychain. Production
/// initializers always use `SystemKeychainResourceLeases`.
final class EphemeralKeychainResourceLeases: KeychainResourceLeaseAccessing, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: KeychainResourceLeaseItem] = [:]

    func read(service: String, account: String) throws -> KeychainResourceLeaseItem? {
        synchronized { values[key(service, account)] }
    }

    func insertIfAbsent(
        _ item: KeychainResourceLeaseItem,
        service: String,
        account: String
    ) throws -> Bool {
        synchronized {
            let itemKey = key(service, account)
            guard values[itemKey] == nil else { return false }
            values[itemKey] = item
            return true
        }
    }

    func replace(
        _ item: KeychainResourceLeaseItem,
        matchingComparisonToken expectedComparisonToken: Data,
        service: String,
        account: String
    ) throws -> Bool {
        synchronized {
            let itemKey = key(service, account)
            guard values[itemKey]?.comparisonToken == expectedComparisonToken else { return false }
            values[itemKey] = item
            return true
        }
    }

    private func key(_ service: String, _ account: String) -> String {
        service + "\0" + account
    }

    private func synchronized<T>(_ operation: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return operation()
    }
}
