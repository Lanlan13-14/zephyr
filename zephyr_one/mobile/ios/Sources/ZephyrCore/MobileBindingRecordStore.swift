import CryptoKit
import Foundation
import Security

enum MobileBindingRecordPhase: String, Codable, Equatable, Sendable {
    case binding
    case active
    case restoring
    case cleanupPending
}

struct MobileBindingRecord: Codable, Equatable, Sendable {
    let phase: MobileBindingRecordPhase
    let baseURL: String
    let serverID: String
    let accountID: String
    let username: String
    let deviceID: String
    let deviceName: String
    let tokenID: String
    let tokenName: String
    let registryHash: String
    let generation: String
    let syncIntervalSeconds: Int
    let boundAtMilliseconds: Int64

    var identity: SyncBindingIdentity {
        SyncBindingIdentity(
            serverID: serverID,
            accountID: accountID,
            deviceID: deviceID,
            generation: generation
        )
    }

    var summary: MobileBindingSummary {
        MobileBindingSummary(
            baseURL: baseURL,
            serverID: serverID,
            accountID: accountID,
            username: username,
            deviceID: deviceID,
            deviceName: deviceName,
            tokenID: tokenID,
            tokenName: tokenName,
            registryHash: registryHash,
            generation: generation,
            syncIntervalSeconds: syncIntervalSeconds,
            boundAtMilliseconds: boundAtMilliseconds
        )
    }

    func replacing(device: MobileDevice, registryHash: String) -> MobileBindingRecord {
        MobileBindingRecord(
            phase: phase,
            baseURL: baseURL,
            serverID: serverID,
            accountID: accountID,
            username: username,
            deviceID: device.deviceId,
            deviceName: device.deviceName,
            tokenID: device.tokenId,
            tokenName: tokenName,
            registryHash: registryHash,
            generation: generation,
            syncIntervalSeconds: device.syncIntervalSec,
            boundAtMilliseconds: boundAtMilliseconds
        )
    }

    func replacingPhase(_ phase: MobileBindingRecordPhase) -> MobileBindingRecord {
        MobileBindingRecord(
            phase: phase,
            baseURL: baseURL,
            serverID: serverID,
            accountID: accountID,
            username: username,
            deviceID: deviceID,
            deviceName: deviceName,
            tokenID: tokenID,
            tokenName: tokenName,
            registryHash: registryHash,
            generation: generation,
            syncIntervalSeconds: syncIntervalSeconds,
            boundAtMilliseconds: boundAtMilliseconds
        )
    }
}

struct MobileBindingRecordVersion: Equatable, Hashable, Sendable {
    static let byteCount = 32
    let data: Data

    init(data: Data) {
        self.data = data
    }
}

struct MobileBindingRecordSnapshot: Equatable, Sendable {
    let record: MobileBindingRecord
    let recordVersion: MobileBindingRecordVersion

    var identity: SyncBindingIdentity { record.identity }
    var phase: MobileBindingRecordPhase { record.phase }
    var summary: MobileBindingSummary { record.summary }
}

protocol MobileBindingRecordStoring: Sendable {
    func load() throws -> MobileBindingRecordSnapshot?

    /// Returns nil when a binding already owns the active-record slot.
    @discardableResult
    func insertIfAbsent(_ record: MobileBindingRecord) throws -> MobileBindingRecordSnapshot?

    /// Replaces the record only while its complete record and opaque version still match.
    @discardableResult
    func replace(
        _ record: MobileBindingRecord,
        expected: MobileBindingRecordSnapshot
    ) throws -> MobileBindingRecordSnapshot?

    /// Clears the record only while its complete record and opaque version still match.
    @discardableResult
    func clear(expected: MobileBindingRecordSnapshot) throws -> Bool
}

enum MobileBindingRecordStoreError: Error, Equatable {
    case corruptRecord
    case invalidPhaseTransition
    case versionCollision
}

protocol MobileBindingRecordVersionGenerating: Sendable {
    func nextVersion() throws -> MobileBindingRecordVersion
}

struct SecureMobileBindingRecordVersionGenerator: MobileBindingRecordVersionGenerating {
    func nextVersion() throws -> MobileBindingRecordVersion {
        var data = Data(repeating: 0, count: MobileBindingRecordVersion.byteCount)
        let status = data.withUnsafeMutableBytes { (buffer: UnsafeMutableRawBufferPointer) -> OSStatus in
            guard let baseAddress = buffer.baseAddress else { return errSecParam }
            return SecRandomCopyBytes(kSecRandomDefault, buffer.count, baseAddress)
        }
        guard status == errSecSuccess else { throw KeychainStorageError.status(status) }
        return MobileBindingRecordVersion(data: data)
    }
}

/// A tamper-resistant active-binding index. Every successful write installs a
/// fresh opaque version. The Keychain query token binds that version and the
/// complete record, so compare-and-set remains atomic across scenes, store
/// instances and processes and cannot suffer an identity-level ABA race.
final class KeychainMobileBindingRecordStore: MobileBindingRecordStoring, @unchecked Sendable {
    private struct PersistedRecord: Codable, Equatable {
        let formatVersion: Int
        let record: MobileBindingRecord
        let recordVersion: Data
    }

    private static let persistedFormatVersion = 1
    private static let servicePrefix = "one.zephyr.mobile.binding-index.v1"
    private static let account = "active"
    private static let tokenDomain = Data("one.zephyr.mobile.binding-record-cas.v2\0".utf8)

    private let service: String
    private let items: BindingRecordKeychainAccessing
    private let versions: any MobileBindingRecordVersionGenerating

    convenience init(baseURL: String) {
        self.init(
            baseURL: baseURL,
            items: SystemBindingRecordKeychain(),
            versions: SecureMobileBindingRecordVersionGenerator()
        )
    }

    init(
        baseURL: String,
        items: BindingRecordKeychainAccessing,
        versions: any MobileBindingRecordVersionGenerating = SecureMobileBindingRecordVersionGenerator()
    ) {
        let digest = SHA256.hash(data: Data(baseURL.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
        self.service = Self.servicePrefix + "." + digest
        self.items = items
        self.versions = versions
    }

    func load() throws -> MobileBindingRecordSnapshot? {
        guard let item = try items.read(service: service, account: Self.account) else {
            return nil
        }
        let snapshot = try Self.decode(item.data)
        guard item.comparisonToken == Self.comparisonToken(for: item.data) else {
            throw MobileBindingRecordStoreError.corruptRecord
        }
        return snapshot
    }

    @discardableResult
    func insertIfAbsent(_ record: MobileBindingRecord) throws -> MobileBindingRecordSnapshot? {
        guard record.phase != .restoring else {
            throw MobileBindingRecordStoreError.invalidPhaseTransition
        }
        let candidate = try makeCandidate(for: record)
        let inserted = try items.insertIfAbsent(
            candidate.item,
            service: service,
            account: Self.account,
            accessibility: .whenUnlockedThisDeviceOnly
        )
        return inserted ? candidate.snapshot : nil
    }

    @discardableResult
    func replace(
        _ record: MobileBindingRecord,
        expected: MobileBindingRecordSnapshot
    ) throws -> MobileBindingRecordSnapshot? {
        let expectedItem = try Self.item(for: expected)
        guard Self.isAllowedTransition(from: expected.record, to: record) else {
            throw MobileBindingRecordStoreError.invalidPhaseTransition
        }
        let candidate = try makeCandidate(for: record)
        guard candidate.snapshot.recordVersion != expected.recordVersion else {
            throw MobileBindingRecordStoreError.versionCollision
        }
        let replaced = try items.replace(
            candidate.item,
            matchingComparisonToken: expectedItem.comparisonToken,
            service: service,
            account: Self.account,
            accessibility: .whenUnlockedThisDeviceOnly
        )
        return replaced ? candidate.snapshot : nil
    }

    @discardableResult
    func clear(expected: MobileBindingRecordSnapshot) throws -> Bool {
        let expectedItem = try Self.item(for: expected)
        return try items.delete(
            service: service,
            account: Self.account,
            matchingComparisonToken: expectedItem.comparisonToken
        )
    }

    private func makeCandidate(
        for record: MobileBindingRecord
    ) throws -> (snapshot: MobileBindingRecordSnapshot, item: BindingRecordKeychainItem) {
        guard Self.isValid(record) else {
            throw MobileBindingRecordStoreError.corruptRecord
        }
        let version = try versions.nextVersion()
        guard Self.isValid(version) else {
            throw MobileBindingRecordStoreError.corruptRecord
        }
        let snapshot = MobileBindingRecordSnapshot(record: record, recordVersion: version)
        return (snapshot, try Self.item(for: snapshot))
    }

    private static func item(
        for snapshot: MobileBindingRecordSnapshot
    ) throws -> BindingRecordKeychainItem {
        guard isValid(snapshot.record), isValid(snapshot.recordVersion) else {
            throw MobileBindingRecordStoreError.corruptRecord
        }
        let persisted = PersistedRecord(
            formatVersion: persistedFormatVersion,
            record: snapshot.record,
            recordVersion: snapshot.recordVersion.data
        )
        let data = try encode(persisted)
        return BindingRecordKeychainItem(
            data: data,
            comparisonToken: comparisonToken(for: data)
        )
    }

    private static func decode(_ data: Data) throws -> MobileBindingRecordSnapshot {
        guard let persisted = try? JSONDecoder().decode(PersistedRecord.self, from: data),
              persisted.formatVersion == persistedFormatVersion,
              isValid(persisted.record),
              persisted.recordVersion.count == MobileBindingRecordVersion.byteCount,
              let canonical = try? encode(persisted),
              canonical == data else {
            throw MobileBindingRecordStoreError.corruptRecord
        }
        return MobileBindingRecordSnapshot(
            record: persisted.record,
            recordVersion: MobileBindingRecordVersion(data: persisted.recordVersion)
        )
    }

    private static func encode(_ persisted: PersistedRecord) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        do { return try encoder.encode(persisted) }
        catch { throw MobileBindingRecordStoreError.corruptRecord }
    }

    private static func comparisonToken(for data: Data) -> Data {
        var tokenMaterial = tokenDomain
        tokenMaterial.append(data)
        return Data(SHA256.hash(data: tokenMaterial))
    }

    private static func isValid(_ version: MobileBindingRecordVersion) -> Bool {
        version.data.count == MobileBindingRecordVersion.byteCount
    }

    private static func isValid(_ record: MobileBindingRecord) -> Bool {
        let values = [
            record.baseURL, record.serverID, record.accountID, record.username,
            record.deviceID, record.deviceName, record.tokenID,
            record.registryHash, record.generation,
        ]
        let requiresBoundTimestamp = record.phase == .active || record.phase == .restoring
        return values.allSatisfy(isValidField) &&
            (!requiresBoundTimestamp || record.boundAtMilliseconds > 0)
    }

    private static func isAllowedTransition(
        from current: MobileBindingRecord,
        to next: MobileBindingRecord
    ) -> Bool {
        guard current.identity == next.identity else { return false }
        switch (current.phase, next.phase) {
        case (.binding, .active),
             (.binding, .cleanupPending),
             (.active, .cleanupPending),
             (.restoring, .active),
             (.restoring, .cleanupPending),
             (.cleanupPending, .cleanupPending):
            return true
        case (.active, .restoring):
            return next == current.replacingPhase(.restoring)
        default:
            return false
        }
    }

    private static func isValidField(_ value: String) -> Bool {
        !value.isEmpty && !value.unicodeScalars.contains(where: {
            $0.value == 0 || $0.value == 10 || $0.value == 13
        })
    }
}

struct BindingRecordKeychainItem: Equatable, Sendable {
    let data: Data
    let comparisonToken: Data
}

protocol BindingRecordKeychainAccessing: AnyObject, Sendable {
    func read(service: String, account: String) throws -> BindingRecordKeychainItem?

    func insertIfAbsent(
        _ item: BindingRecordKeychainItem,
        service: String,
        account: String,
        accessibility: KeychainItemAccessibility
    ) throws -> Bool

    func replace(
        _ item: BindingRecordKeychainItem,
        matchingComparisonToken expectedComparisonToken: Data,
        service: String,
        account: String,
        accessibility: KeychainItemAccessibility
    ) throws -> Bool

    func delete(
        service: String,
        account: String,
        matchingComparisonToken expectedComparisonToken: Data
    ) throws -> Bool
}

final class SystemBindingRecordKeychain: BindingRecordKeychainAccessing, @unchecked Sendable {
    func read(service: String, account: String) throws -> BindingRecordKeychainItem? {
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
                  let comparisonToken = attributes.object(forKey: kSecAttrGeneric) as? Data else {
                throw KeychainStorageError.status(errSecDecode)
            }
            return BindingRecordKeychainItem(data: data, comparisonToken: comparisonToken)
        case errSecItemNotFound:
            return nil
        default:
            throw KeychainStorageError.status(status)
        }
    }

    func insertIfAbsent(
        _ item: BindingRecordKeychainItem,
        service: String,
        account: String,
        accessibility: KeychainItemAccessibility
    ) throws -> Bool {
        var attributes = baseQuery(service: service, account: account)
        attributes[kSecValueData] = item.data
        attributes[kSecAttrGeneric] = item.comparisonToken
        attributes[kSecAttrAccessible] = securityAccessibility(accessibility)
        let status = SecItemAdd(attributes as CFDictionary, nil)
        switch status {
        case errSecSuccess:
            return true
        case errSecDuplicateItem:
            return false
        default:
            throw KeychainStorageError.status(status)
        }
    }

    func replace(
        _ item: BindingRecordKeychainItem,
        matchingComparisonToken expectedComparisonToken: Data,
        service: String,
        account: String,
        accessibility: KeychainItemAccessibility
    ) throws -> Bool {
        var query = baseQuery(service: service, account: account)
        query[kSecAttrGeneric] = expectedComparisonToken
        let status = SecItemUpdate(
            query as CFDictionary,
            [
                kSecValueData: item.data,
                kSecAttrGeneric: item.comparisonToken,
                kSecAttrAccessible: securityAccessibility(accessibility),
            ] as CFDictionary
        )
        switch status {
        case errSecSuccess:
            return true
        case errSecItemNotFound:
            return false
        default:
            throw KeychainStorageError.status(status)
        }
    }

    func delete(
        service: String,
        account: String,
        matchingComparisonToken expectedComparisonToken: Data
    ) throws -> Bool {
        var query = baseQuery(service: service, account: account)
        query[kSecAttrGeneric] = expectedComparisonToken
        let status = SecItemDelete(query as CFDictionary)
        switch status {
        case errSecSuccess:
            return true
        case errSecItemNotFound:
            return false
        default:
            throw KeychainStorageError.status(status)
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

    private func securityAccessibility(_ accessibility: KeychainItemAccessibility) -> CFString {
        switch accessibility {
        case .whenUnlockedThisDeviceOnly:
            return kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        }
    }
}
