import CryptoKit
import Foundation
import Security

/// A Keychain failure that is safe to surface in diagnostics.
///
/// It contains only the Security framework status, never the service, account,
/// query or secret value involved in the operation.
public enum KeychainStorageError: Error, Equatable, CustomStringConvertible {
    case status(OSStatus)

    public var description: String {
        switch self {
        case .status(let status):
            return "Keychain operation failed (OSStatus \(status))"
        }
    }
}

public enum KeychainCredentialStoreError: Error, Equatable, CustomStringConvertible {
    case invalidScope
    case invalidLease
    case emptyCredential
    case missingRefreshCredential
    case inactiveLease
    case staleLease
    case leaseTerminated
    case corruptRecord

    public var description: String {
        switch self {
        case .invalidScope:
            return "credential scope is invalid"
        case .invalidLease:
            return "the generation side-effect lease is invalid"
        case .emptyCredential:
            return "credential values must be non-empty"
        case .missingRefreshCredential:
            return "the binding has no refresh credential"
        case .inactiveLease:
            return "the generation side-effect lease is not active"
        case .staleLease:
            return "the generation side-effect lease is stale"
        case .leaseTerminated:
            return "the binding generation has been permanently terminated"
        case .corruptRecord:
            return "the stored credential record is invalid"
        }
    }
}

/// The exact binding-record generation authorized to mutate device side effects.
///
/// The opaque record version prevents an older binding snapshot from writing
/// after ownership has moved forward, while the complete identity prevents a
/// lease from being replayed across an account, device or binding generation.
public struct GenerationSideEffectLease: Equatable, Hashable, Sendable {
    public let identity: SyncBindingIdentity
    public let recordVersion: Data

    public init(identity: SyncBindingIdentity, recordVersion: Data) throws {
        guard Self.isValid(identity),
              recordVersion.count == MobileBindingRecordVersion.byteCount else {
            throw KeychainCredentialStoreError.invalidLease
        }
        self.identity = identity
        self.recordVersion = recordVersion
    }

    init(snapshot: MobileBindingRecordSnapshot) throws {
        try self.init(
            identity: snapshot.identity,
            recordVersion: snapshot.recordVersion.data
        )
    }

    private static func isValid(_ identity: SyncBindingIdentity) -> Bool {
        [identity.serverID, identity.accountID, identity.deviceID, identity.generation]
            .allSatisfy { value in
                !value.isEmpty && !value.unicodeScalars.contains(where: {
                    $0.value == 0 || $0.value == 10 || $0.value == 13
                })
            }
    }
}

/// Names exactly one binding generation without putting a user-controlled
/// value directly into a Keychain attribute.
public struct KeychainCredentialScope: Equatable, Sendable {
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
        let values = [serverID, accountID, deviceID, generation]
        guard values.allSatisfy(Self.isValid) else {
            throw KeychainCredentialStoreError.invalidScope
        }
        self.serverID = serverID
        self.accountID = accountID
        self.deviceID = deviceID
        self.generation = generation
    }

    public init(identity: SyncBindingIdentity) throws {
        try self.init(
            serverID: identity.serverID,
            accountID: identity.accountID,
            deviceID: identity.deviceID,
            generation: identity.generation
        )
    }

    fileprivate var identity: SyncBindingIdentity {
        SyncBindingIdentity(
            serverID: serverID,
            accountID: accountID,
            deviceID: deviceID,
            generation: generation
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

/// The three credential planes for one account binding.
///
/// Access and refresh are returned together because a successful refresh must
/// replace both values as one Keychain record. The refresh value is never used
/// as a bearer credential by this type.
public struct KeychainCredentials: Equatable, Sendable {
    public let accessCredential: String
    public let accessExpiresAtMilliseconds: Int64?
    public let refreshCredential: String
    public let sid: String?

    public init(
        accessCredential: String,
        accessExpiresAtMilliseconds: Int64?,
        refreshCredential: String,
        sid: String? = nil
    ) {
        self.accessCredential = accessCredential
        self.accessExpiresAtMilliseconds = accessExpiresAtMilliseconds
        self.refreshCredential = refreshCredential
        self.sid = sid
    }
}

/// Device-local credential storage and durable generation side-effect fence.
///
/// The Keychain item is either an active exact lease with credentials or a
/// secret-free terminal tombstone. Every mutation compares the complete item
/// token in the same Security operation that writes the replacement. Cleanup
/// therefore orders atomically against refresh rotation: if rotation wins,
/// cleanup retries and erases it; if cleanup wins, the stale rotation cannot
/// update or add the item back.
public final class KeychainCredentialStore: @unchecked Sendable {
    public static let defaultServicePrefix = "one.zephyr.mobile.credentials.v2"
    public static let refreshSkewMilliseconds: Int64 = 60_000

    private enum State: String, Codable {
        case active
        case terminated
    }

    private struct Record: Codable, Equatable {
        let formatVersion: Int
        var state: State
        let serverID: String
        let accountID: String
        let deviceID: String
        let generation: String
        var recordVersion: Data
        var accessCredential: String? = nil
        var accessExpiresAtMilliseconds: Int64? = nil
        var refreshCredential: String? = nil
        var sid: String? = nil

        var identity: SyncBindingIdentity {
            SyncBindingIdentity(
                serverID: serverID,
                accountID: accountID,
                deviceID: deviceID,
                generation: generation
            )
        }

        var lease: GenerationSideEffectLease? {
            try? GenerationSideEffectLease(
                identity: identity,
                recordVersion: recordVersion
            )
        }
    }

    private static let persistedFormatVersion = 2
    private static let tokenDomain = Data("one.zephyr.mobile.credentials-cas.v2\0".utf8)

    private let scope: KeychainCredentialScope
    private let service: String
    private let items: CredentialKeychainAccessing

    public convenience init(
        scope: KeychainCredentialScope,
        servicePrefix: String = KeychainCredentialStore.defaultServicePrefix
    ) throws {
        try self.init(scope: scope, servicePrefix: servicePrefix, items: SystemKeychainItems())
    }

    init(
        scope: KeychainCredentialScope,
        servicePrefix: String,
        items: CredentialKeychainAccessing
    ) throws {
        guard !servicePrefix.isEmpty,
              !servicePrefix.unicodeScalars.contains(where: { $0.value == 0 }) else {
            throw KeychainCredentialStoreError.invalidScope
        }
        self.scope = scope
        self.service = scope.service(prefix: servicePrefix)
        self.items = items
    }

    /// Creates the active placeholder before any credential or key side effect.
    /// Repeating the exact activation is safe; a tombstoned generation can
    /// never be activated again.
    public func activateLease(_ lease: GenerationSideEffectLease) throws {
        try requireScope(lease)
        let candidate = try item(for: activeRecord(lease: lease))
        while true {
            if try items.insertIfAbsent(
                candidate,
                service: service,
                account: scope.account,
                accessibility: .whenUnlockedThisDeviceOnly
            ) {
                return
            }
            guard let current = try readItem() else { continue }
            let record = try decode(current)
            switch record.state {
            case .terminated:
                throw KeychainCredentialStoreError.leaseTerminated
            case .active:
                guard record.lease == lease else {
                    throw KeychainCredentialStoreError.staleLease
                }
                return
            }
        }
    }

    /// Moves ownership to a newer binding-record version without changing the
    /// credential payload. Both exact-version success states are idempotent.
    public func replaceLease(
        _ replacement: GenerationSideEffectLease,
        expected: GenerationSideEffectLease
    ) throws {
        try requireScope(expected)
        try requireScope(replacement)
        guard replacement.identity == expected.identity else {
            throw KeychainCredentialStoreError.invalidLease
        }
        while true {
            guard let current = try readItem() else {
                throw KeychainCredentialStoreError.inactiveLease
            }
            var record = try decode(current)
            guard record.state == .active else {
                throw KeychainCredentialStoreError.leaseTerminated
            }
            if record.lease == replacement { return }
            guard record.lease == expected else {
                throw KeychainCredentialStoreError.staleLease
            }
            record.recordVersion = replacement.recordVersion
            if try items.replace(
                try item(for: record),
                matchingComparisonToken: current.comparisonToken,
                service: service,
                account: scope.account,
                accessibility: .whenUnlockedThisDeviceOnly
            ) {
                return
            }
        }
    }

    /// Reconciles a durable binding-record transition with this side-effect
    /// item. Normally `expected` is the exact source snapshot from the
    /// successful record CAS. A nil expected lease is reserved for restart
    /// recovery after the caller has revalidated that `replacement` is the
    /// current durable cleanup marker; it may adopt any older active version
    /// of this complete identity because the predecessor was lost in the
    /// crash.
    ///
    /// An absent item is claimed for `replacement` so cleanup can fence a bind
    /// that crashed after inserting its binding record but before activating
    /// side effects. An exact replacement or exact tombstone is idempotent.
    public func reconcileLease(
        _ replacement: GenerationSideEffectLease,
        replacing expected: GenerationSideEffectLease?
    ) throws {
        try requireScope(replacement)
        if let expected {
            try requireScope(expected)
            guard expected.identity == replacement.identity else {
                throw KeychainCredentialStoreError.invalidLease
            }
        }
        while true {
            guard let current = try readItem() else {
                let candidate = try item(for: activeRecord(lease: replacement))
                if try items.insertIfAbsent(
                    candidate,
                    service: service,
                    account: scope.account,
                    accessibility: .whenUnlockedThisDeviceOnly
                ) {
                    return
                }
                continue
            }
            var record = try decode(current)
            if record.lease == replacement {
                return
            }
            guard record.state == .active else {
                throw KeychainCredentialStoreError.leaseTerminated
            }
            guard expected == nil || record.lease == expected else {
                throw KeychainCredentialStoreError.staleLease
            }
            record.recordVersion = replacement.recordVersion
            if try items.replace(
                try item(for: record),
                matchingComparisonToken: current.comparisonToken,
                service: service,
                account: scope.account,
                accessibility: .whenUnlockedThisDeviceOnly
            ) {
                return
            }
        }
    }

    /// Returns the durable active lease for crash recovery. A terminal
    /// tombstone intentionally returns nil and remains on disk.
    public func activeLease() throws -> GenerationSideEffectLease? {
        guard let current = try readItem() else { return nil }
        let record = try decode(current)
        return record.state == .active ? record.lease : nil
    }

    public func credentials(for lease: GenerationSideEffectLease) throws -> KeychainCredentials? {
        let record = try readActiveRecord(for: lease)
        guard let access = record.accessCredential,
              !access.isEmpty,
              let refresh = record.refreshCredential,
              !refresh.isEmpty else {
            return nil
        }
        return KeychainCredentials(
            accessCredential: access,
            accessExpiresAtMilliseconds: record.accessExpiresAtMilliseconds,
            refreshCredential: refresh,
            sid: record.sid
        )
    }

    public func sid(for lease: GenerationSideEffectLease) throws -> String? {
        try readActiveRecord(for: lease).sid
    }

    /// Stores the credentials returned by a successful bind only while the
    /// exact binding-record lease remains active.
    public func storeInitial(
        _ credentials: KeychainCredentials,
        for lease: GenerationSideEffectLease
    ) throws {
        try Self.validate(credentials)
        try mutateActiveRecord(for: lease) { record in
            record.accessCredential = credentials.accessCredential
            record.accessExpiresAtMilliseconds = credentials.accessExpiresAtMilliseconds
            record.refreshCredential = credentials.refreshCredential
            record.sid = credentials.sid
        }
    }

    /// Atomically replaces access and refresh credentials under an exact lease.
    public func rotate(
        accessCredential: String,
        accessExpiresAtMilliseconds: Int64?,
        refreshCredential: String,
        for lease: GenerationSideEffectLease
    ) throws {
        guard !accessCredential.isEmpty, !refreshCredential.isEmpty else {
            throw KeychainCredentialStoreError.emptyCredential
        }
        try mutateActiveRecord(for: lease) { record in
            guard record.refreshCredential?.isEmpty == false else {
                throw KeychainCredentialStoreError.missingRefreshCredential
            }
            record.accessCredential = accessCredential
            record.accessExpiresAtMilliseconds = accessExpiresAtMilliseconds
            record.refreshCredential = refreshCredential
        }
    }

    public func storeSID(_ sid: String, for lease: GenerationSideEffectLease) throws {
        guard !sid.isEmpty else { throw KeychainCredentialStoreError.emptyCredential }
        try mutateActiveRecord(for: lease) { $0.sid = sid }
    }

    public func clearSID(for lease: GenerationSideEffectLease) throws {
        try mutateActiveRecord(for: lease) { $0.sid = nil }
    }

    public func accessNeedsRefresh(
        nowMilliseconds: Int64,
        for lease: GenerationSideEffectLease
    ) throws -> Bool {
        guard let credentials = try credentials(for: lease) else { return true }
        guard let expiry = credentials.accessExpiresAtMilliseconds else { return false }
        let threshold = expiry.subtractingReportingOverflow(Self.refreshSkewMilliseconds)
        return nowMilliseconds >= (threshold.overflow ? Int64.min : threshold.partialValue)
    }

    /// Atomically terminates the exact lease and erases all secret fields.
    /// The tombstone is retained so a stale process cannot recreate the same
    /// generation after cleanup or after a crash/restart.
    public func terminateLease(_ lease: GenerationSideEffectLease) throws {
        try requireScope(lease)
        while true {
            guard let current = try readItem() else {
                throw KeychainCredentialStoreError.inactiveLease
            }
            var record = try decode(current)
            guard record.lease == lease else {
                throw KeychainCredentialStoreError.staleLease
            }
            if record.state == .terminated { return }
            record.state = .terminated
            record.accessCredential = nil
            record.accessExpiresAtMilliseconds = nil
            record.refreshCredential = nil
            record.sid = nil
            if try items.replace(
                try item(for: record),
                matchingComparisonToken: current.comparisonToken,
                service: service,
                account: scope.account,
                accessibility: .whenUnlockedThisDeviceOnly
            ) {
                return
            }
        }
    }

    private func mutateActiveRecord(
        for lease: GenerationSideEffectLease,
        _ mutation: (inout Record) throws -> Void
    ) throws {
        try requireScope(lease)
        while true {
            guard let current = try readItem() else {
                throw KeychainCredentialStoreError.inactiveLease
            }
            var record = try decode(current)
            guard record.state == .active else {
                throw KeychainCredentialStoreError.leaseTerminated
            }
            guard record.lease == lease else {
                throw KeychainCredentialStoreError.staleLease
            }
            try mutation(&record)
            if try items.replace(
                try item(for: record),
                matchingComparisonToken: current.comparisonToken,
                service: service,
                account: scope.account,
                accessibility: .whenUnlockedThisDeviceOnly
            ) {
                return
            }
        }
    }

    private func readActiveRecord(for lease: GenerationSideEffectLease) throws -> Record {
        try requireScope(lease)
        guard let current = try readItem() else {
            throw KeychainCredentialStoreError.inactiveLease
        }
        let record = try decode(current)
        guard record.state == .active else {
            throw KeychainCredentialStoreError.leaseTerminated
        }
        guard record.lease == lease else {
            throw KeychainCredentialStoreError.staleLease
        }
        return record
    }

    private func readItem() throws -> CredentialKeychainItem? {
        try items.read(service: service, account: scope.account)
    }

    private func decode(_ item: CredentialKeychainItem) throws -> Record {
        guard let record = try? JSONDecoder().decode(Record.self, from: item.data),
              record.formatVersion == Self.persistedFormatVersion,
              record.identity == scope.identity,
              record.lease != nil,
              Self.isValid(record),
              let canonical = try? Self.encode(record),
              canonical == item.data,
              item.comparisonToken == Self.comparisonToken(for: item.data) else {
            throw KeychainCredentialStoreError.corruptRecord
        }
        return record
    }

    private func item(for record: Record) throws -> CredentialKeychainItem {
        guard record.identity == scope.identity, record.lease != nil, Self.isValid(record) else {
            throw KeychainCredentialStoreError.corruptRecord
        }
        let data = try Self.encode(record)
        return CredentialKeychainItem(
            data: data,
            comparisonToken: Self.comparisonToken(for: data)
        )
    }

    private func activeRecord(lease: GenerationSideEffectLease) -> Record {
        Record(
            formatVersion: Self.persistedFormatVersion,
            state: .active,
            serverID: lease.identity.serverID,
            accountID: lease.identity.accountID,
            deviceID: lease.identity.deviceID,
            generation: lease.identity.generation,
            recordVersion: lease.recordVersion
        )
    }

    private func requireScope(_ lease: GenerationSideEffectLease) throws {
        guard lease.identity == scope.identity,
              lease.recordVersion.count == MobileBindingRecordVersion.byteCount else {
            throw KeychainCredentialStoreError.invalidLease
        }
    }

    private static func encode(_ record: Record) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        do { return try encoder.encode(record) }
        catch { throw KeychainCredentialStoreError.corruptRecord }
    }

    private static func comparisonToken(for data: Data) -> Data {
        var material = tokenDomain
        material.append(data)
        return Data(SHA256.hash(data: material))
    }

    private static func validate(_ credentials: KeychainCredentials) throws {
        guard !credentials.accessCredential.isEmpty,
              !credentials.refreshCredential.isEmpty,
              credentials.sid?.isEmpty != true else {
            throw KeychainCredentialStoreError.emptyCredential
        }
    }

    private static func isValid(_ record: Record) -> Bool {
        guard record.recordVersion.count == MobileBindingRecordVersion.byteCount,
              record.lease != nil else { return false }
        if record.state == .terminated {
            return record.accessCredential == nil &&
                record.accessExpiresAtMilliseconds == nil &&
                record.refreshCredential == nil &&
                record.sid == nil
        }
        return record.accessCredential?.isEmpty != true &&
            record.refreshCredential?.isEmpty != true &&
            record.sid?.isEmpty != true
    }
}

enum KeychainItemAccessibility: Equatable {
    case whenUnlockedThisDeviceOnly
}

/// Shared primitive operations used by independently fenced Keychain stores.
protocol KeychainItemAccessing: AnyObject {
    func readGenericPassword(service: String, account: String) throws -> Data?

    func writeGenericPassword(
        _ data: Data,
        service: String,
        account: String,
        accessibility: KeychainItemAccessibility
    ) throws

    func addGenericPasswordIfAbsent(
        _ data: Data,
        service: String,
        account: String,
        accessibility: KeychainItemAccessibility
    ) throws -> Bool

    func deleteGenericPassword(service: String, account: String) throws

    func deleteGenericPasswords(service: String) throws
}

struct CredentialKeychainItem: Equatable, Sendable {
    let data: Data
    let comparisonToken: Data
}

protocol CredentialKeychainAccessing: AnyObject {
    func read(service: String, account: String) throws -> CredentialKeychainItem?

    func insertIfAbsent(
        _ item: CredentialKeychainItem,
        service: String,
        account: String,
        accessibility: KeychainItemAccessibility
    ) throws -> Bool

    func replace(
        _ item: CredentialKeychainItem,
        matchingComparisonToken expectedComparisonToken: Data,
        service: String,
        account: String,
        accessibility: KeychainItemAccessibility
    ) throws -> Bool
}

final class SystemKeychainItems: KeychainItemAccessing, CredentialKeychainAccessing {
    func readGenericPassword(service: String, account: String) throws -> Data? {
        var query = baseQuery(service: service, account: account)
        query[kSecReturnData] = true
        query[kSecMatchLimit] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        switch status {
        case errSecSuccess:
            guard let data = item as? Data else { throw KeychainStorageError.status(errSecDecode) }
            return data
        case errSecItemNotFound:
            return nil
        default:
            throw KeychainStorageError.status(status)
        }
    }

    func writeGenericPassword(
        _ data: Data,
        service: String,
        account: String,
        accessibility: KeychainItemAccessibility
    ) throws {
        let query = baseQuery(service: service, account: account)
        let updateAttributes: [CFString: Any] = [
            kSecValueData: data,
            kSecAttrAccessible: securityAccessibility(accessibility),
        ]
        let status = SecItemUpdate(query as CFDictionary, updateAttributes as CFDictionary)
        if status == errSecSuccess { return }
        guard status == errSecItemNotFound else { throw KeychainStorageError.status(status) }

        var attributes = query
        attributes[kSecValueData] = data
        attributes[kSecAttrAccessible] = securityAccessibility(accessibility)
        let addStatus = SecItemAdd(attributes as CFDictionary, nil)
        if addStatus == errSecSuccess { return }
        if addStatus == errSecDuplicateItem {
            let retry = SecItemUpdate(query as CFDictionary, updateAttributes as CFDictionary)
            guard retry == errSecSuccess else { throw KeychainStorageError.status(retry) }
            return
        }
        throw KeychainStorageError.status(addStatus)
    }

    func addGenericPasswordIfAbsent(
        _ data: Data,
        service: String,
        account: String,
        accessibility: KeychainItemAccessibility
    ) throws -> Bool {
        var attributes = baseQuery(service: service, account: account)
        attributes[kSecValueData] = data
        attributes[kSecAttrAccessible] = securityAccessibility(accessibility)
        let status = SecItemAdd(attributes as CFDictionary, nil)
        switch status {
        case errSecSuccess: return true
        case errSecDuplicateItem: return false
        default: throw KeychainStorageError.status(status)
        }
    }

    func deleteGenericPassword(service: String, account: String) throws {
        try delete(baseQuery(service: service, account: account))
    }

    func deleteGenericPasswords(service: String) throws {
        try delete([
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrSynchronizable: kCFBooleanFalse as Any,
            kSecUseDataProtectionKeychain: true,
        ])
    }

    func read(service: String, account: String) throws -> CredentialKeychainItem? {
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
            return CredentialKeychainItem(data: data, comparisonToken: comparisonToken)
        case errSecItemNotFound:
            return nil
        default:
            throw KeychainStorageError.status(status)
        }
    }

    func insertIfAbsent(
        _ item: CredentialKeychainItem,
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
        case errSecSuccess: return true
        case errSecDuplicateItem: return false
        default: throw KeychainStorageError.status(status)
        }
    }

    func replace(
        _ item: CredentialKeychainItem,
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

    private func securityAccessibility(_ accessibility: KeychainItemAccessibility) -> CFString {
        switch accessibility {
        case .whenUnlockedThisDeviceOnly:
            return kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        }
    }

    private func delete(_ query: [CFString: Any]) throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainStorageError.status(status)
        }
    }
}

enum KeychainNamespace {
    static func encode(_ value: String) -> String {
        Data(value.utf8)
            .base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
