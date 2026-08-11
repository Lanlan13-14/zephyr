import Foundation
import CryptoKit
import Security

public enum DeviceIdentityStoreError: Error, Equatable, CustomStringConvertible {
    case invalidScope
    case invalidProofInput(String)
    case invalidPublicKey
    case keyUnavailable
    case signingFailed

    public var description: String {
        switch self {
        case .invalidScope:
            return "device identity scope is invalid"
        case .invalidProofInput(let field):
            return "device proof field \(field) is invalid"
        case .invalidPublicKey:
            return "device signing public key is invalid"
        case .keyUnavailable:
            return "device signing key is unavailable; rebind is required"
        case .signingFailed:
            return "device proof signing failed"
        }
    }
}

/// The binding identity namespace. Including the account and generation makes
/// key reuse across account replacement impossible even if a device identifier
/// is accidentally retained.
public struct DeviceIdentityScope: Equatable, Sendable {
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
        guard values.allSatisfy({ !$0.isEmpty && !$0.unicodeScalars.contains(where: { $0.value == 0 }) }) else {
            throw DeviceIdentityStoreError.invalidScope
        }
        self.serverID = serverID
        self.accountID = accountID
        self.deviceID = deviceID
        self.generation = generation
    }

    var legacyApplicationTag: Data {
        Data(
            [
                "one.zephyr.mobile.device.es256.v1",
                KeychainNamespace.encode(serverID),
                KeychainNamespace.encode(accountID),
                KeychainNamespace.encode(deviceID),
                KeychainNamespace.encode(generation),
            ].joined(separator: ".").utf8
        )
    }

    func applicationTag(resourceVersion: Data) -> Data {
        var tag = legacyApplicationTag
        tag.append(Data(".".utf8))
        let encodedVersion = resourceVersion.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        tag.append(Data(encodedVersion.utf8))
        return tag
    }
}

public enum DeviceSigningKeyProtection: String, Equatable, Sendable {
    case secureEnclave
    case softwareKeychain

    public var isHardwareBacked: Bool { self == .secureEnclave }
}

/// Public half of the device proof identity sent during bind.
public struct DeviceSigningIdentity: Equatable, Sendable {
    public let algorithm: String
    public let jwk: [String: String]
    public let protection: DeviceSigningKeyProtection

    public var isHardwareBacked: Bool { protection.isHardwareBacked }

    public init(
        algorithm: String,
        jwk: [String: String],
        protection: DeviceSigningKeyProtection
    ) {
        self.algorithm = algorithm
        self.jwk = jwk
        self.protection = protection
    }
}

/// Persistent ES256 device identity.
///
/// The first choice is a non-exportable Secure Enclave P-256 key. Simulator,
/// Intel Mac and devices without a usable enclave fall back to a P-256 private
/// key held by Keychain. Both paths are permanent, non-synchronizable and use
/// `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`; the returned protection flag
/// keeps the fallback visible to security UI rather than pretending it is
/// hardware backed.
public final class DeviceIdentityStore: @unchecked Sendable {
    public static let signingAlgorithm = "ES256"

    private static let proofPrefix = "zephyr-one-device-proof-v1"
    private static let leaseResource = "device-signing-es256"
    private static let leaseServicePrefix = "one.zephyr.mobile.device.es256.lease.v1"

    private let scope: DeviceIdentityScope
    private let keys: DeviceIdentityKeyManaging
    private let leaseItems: any KeychainResourceLeaseAccessing
    private let resourceVersion: () throws -> Data

    public convenience init(scope: DeviceIdentityScope) {
        self.init(
            scope: scope,
            keys: SystemDeviceIdentityKeys(),
            leaseItems: SystemKeychainResourceLeases()
        )
    }

    init(scope: DeviceIdentityScope, keys: DeviceIdentityKeyManaging) {
        self.scope = scope
        self.keys = keys
        self.leaseItems = EphemeralKeychainResourceLeases()
        self.resourceVersion = KeychainResourceLeaseCodec.randomResourceVersion
    }

    init(
        scope: DeviceIdentityScope,
        keys: DeviceIdentityKeyManaging,
        leaseItems: any KeychainResourceLeaseAccessing,
        resourceVersion: @escaping () throws -> Data = KeychainResourceLeaseCodec.randomResourceVersion
    ) {
        self.scope = scope
        self.keys = keys
        self.leaseItems = leaseItems
        self.resourceVersion = resourceVersion
    }

    /// Idempotently obtains the current public identity. The durable active
    /// marker is claimed before a permanent key can be created. A creator that
    /// loses a concurrent delete rechecks the exact marker and erases its late
    /// key before returning.
    public func ensureIdentity() throws -> DeviceSigningIdentity {
        let lease = try activeLease(createIfAbsent: true)
        let applicationTag = try activeApplicationTag(for: lease)
        let key: ManagedDeviceSigningKey
        if let existing = try keys.existing(tag: applicationTag) {
            key = existing
        } else {
            do {
                key = try createOrReturnWinner(
                    tag: applicationTag,
                    protection: .secureEnclave
                )
            } catch let error as KeychainStorageError {
                throw error
            } catch {
                // Secure Enclave is intentionally preferred, not required:
                // background sync must still work on simulator and hardware
                // without one. The fallback remains ThisDeviceOnly.
                key = try createOrReturnWinner(
                    tag: applicationTag,
                    protection: .softwareKeychain
                )
            }
        }
        do {
            try requireStillActive(lease)
        } catch {
            try keys.delete(tag: applicationTag)
            throw error
        }
        return try Self.publicIdentity(for: key)
    }

    public func hasIdentity() throws -> Bool {
        guard let lease = try readLease() else {
            // Existing v1 installs did not have a lease item. Reporting the
            // legacy key allows the next ensure/sign call to adopt it.
            return try keys.existing(tag: scope.legacyApplicationTag) != nil
        }
        guard lease.envelope.state == .active else { return false }
        return try keys.existing(tag: activeApplicationTag(for: lease)) != nil
    }

    public var deviceID: String { scope.deviceID }

    func signDeviceProofPayloadReturningDER(_ payload: Data) throws -> Data {
        try signature(for: payload)
    }

    /// Signs the frozen DeviceProof message and returns a standard Base64 DER
    /// ECDSA signature, matching Java `SHA256withECDSA`.
    public func signRequestProof(
        method: String,
        path: String,
        body: Data,
        timestampSeconds: Int64,
        serverNonce: String
    ) throws -> String {
        let message = try Self.proofMessage(
            deviceID: scope.deviceID,
            method: method,
            path: path,
            body: body,
            timestampSeconds: timestampSeconds,
            serverNonce: serverNonce
        )
        let signature = try signature(for: message)
        return signature.base64EncodedString()
    }

    /// Unbind, device revoke and instance-epoch replacement first publish an
    /// exact, secret-free terminal marker. The marker remains after private-key
    /// erasure so a stale scene or restarted process cannot recreate the key.
    public func deleteIdentity() throws {
        var applicationTags = [scope.legacyApplicationTag]
        while true {
            guard let current = try readLease() else {
                let tombstone = try makeLease(state: .terminated)
                applicationTags.append(
                    scope.applicationTag(resourceVersion: tombstone.envelope.resourceVersion)
                )
                if try leaseItems.insertIfAbsent(
                    tombstone.item,
                    service: leaseService,
                    account: leaseAccount
                ) {
                    break
                }
                continue
            }
            if current.envelope.state == .terminated {
                applicationTags.append(
                    scope.applicationTag(resourceVersion: current.envelope.resourceVersion)
                )
                break
            }
            applicationTags.append(try activeApplicationTag(for: current))
            let tombstone = try snapshot(for: current.envelope.terminated())
            if try leaseItems.replace(
                tombstone.item,
                matchingComparisonToken: current.item.comparisonToken,
                service: leaseService,
                account: leaseAccount
            ) {
                break
            }
        }
        for tag in Set(applicationTags) {
            try keys.delete(tag: tag)
        }
    }

    public func removeForUnbind() throws { try deleteIdentity() }

    public func removeForRevocation() throws { try deleteIdentity() }

    static func proofMessage(
        deviceID: String,
        method: String,
        path: String,
        body: Data,
        timestampSeconds: Int64,
        serverNonce: String
    ) throws -> Data {
        for (field, value) in [
            ("deviceID", deviceID),
            ("method", method),
            ("path", path),
            ("serverNonce", serverNonce),
        ] {
            guard !value.isEmpty,
                  !value.unicodeScalars.contains(where: { $0.value == 0 }) else {
                throw DeviceIdentityStoreError.invalidProofInput(field)
            }
        }
        guard timestampSeconds >= 0 else {
            throw DeviceIdentityStoreError.invalidProofInput("timestampSeconds")
        }

        let bodyHash = Data(SHA256.hash(data: body)).base64EncodedString()
        let fields = [
            proofPrefix,
            deviceID,
            method.uppercased(),
            path,
            bodyHash,
            String(timestampSeconds),
            serverNonce,
        ]
        return Data(fields.joined(separator: "\0").utf8)
    }

    private static func publicIdentity(for managed: ManagedDeviceSigningKey) throws -> DeviceSigningIdentity {
        let raw = try managed.key.publicKeyX963Representation()
        guard raw.count == 65, raw.first == 0x04 else {
            throw DeviceIdentityStoreError.invalidPublicKey
        }
        let x = Data(raw[1..<33])
        let y = Data(raw[33..<65])
        return DeviceSigningIdentity(
            algorithm: signingAlgorithm,
            jwk: [
                "kty": "EC",
                "crv": "P-256",
                "x": base64URL(x),
                "y": base64URL(y),
            ],
            protection: managed.protection
        )
    }

    private static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private var leaseScope: KeychainResourceLeaseScope {
        KeychainResourceLeaseScope(
            resource: Self.leaseResource,
            identity: SyncBindingIdentity(
                serverID: scope.serverID,
                accountID: scope.accountID,
                deviceID: scope.deviceID,
                generation: scope.generation
            )
        )
    }

    private var leaseService: String {
        [
            Self.leaseServicePrefix,
            KeychainNamespace.encode(scope.serverID),
            KeychainNamespace.encode(scope.accountID),
            KeychainNamespace.encode(scope.deviceID),
        ].joined(separator: ".")
    }

    private var leaseAccount: String {
        "generation." + KeychainNamespace.encode(scope.generation)
    }

    private func activeLease(createIfAbsent: Bool) throws -> KeychainResourceLeaseSnapshot {
        while true {
            if let current = try readLease() {
                guard current.envelope.state == .active else {
                    // Retry erasure in case another process terminated while a
                    // creator was inside SecKeyCreateRandomKey.
                    try keys.delete(
                        tag: scope.applicationTag(
                            resourceVersion: current.envelope.resourceVersion
                        )
                    )
                    try keys.delete(tag: scope.legacyApplicationTag)
                    throw DeviceIdentityStoreError.keyUnavailable
                }
                return current
            }
            guard createIfAbsent else { throw DeviceIdentityStoreError.keyUnavailable }
            let candidate = try makeLease(state: .active)
            if try leaseItems.insertIfAbsent(
                candidate.item,
                service: leaseService,
                account: leaseAccount
            ) {
                return candidate
            }
        }
    }

    private func requireStillActive(_ expected: KeychainResourceLeaseSnapshot) throws {
        guard let current = try readLease(),
              current.item.comparisonToken == expected.item.comparisonToken,
              current.envelope.state == .active else {
            throw DeviceIdentityStoreError.keyUnavailable
        }
    }

    private func readLease() throws -> KeychainResourceLeaseSnapshot? {
        guard let item = try leaseItems.read(service: leaseService, account: leaseAccount) else {
            return nil
        }
        do {
            let snapshot = try KeychainResourceLeaseCodec.decode(item, expectedScope: leaseScope)
            if snapshot.envelope.state == .active {
                _ = try activeApplicationTag(for: snapshot)
            }
            return snapshot
        } catch let error as KeychainStorageError {
            throw error
        } catch {
            throw DeviceIdentityStoreError.keyUnavailable
        }
    }

    private func makeLease(
        state: KeychainResourceLeaseState
    ) throws -> KeychainResourceLeaseSnapshot {
        do {
            let version = try resourceVersion()
            let payload: Data?
            if state == .active {
                payload = try keys.existing(tag: scope.legacyApplicationTag) == nil
                    ? scope.applicationTag(resourceVersion: version)
                    : scope.legacyApplicationTag
            } else {
                payload = nil
            }
            return try snapshot(
                for: KeychainResourceLeaseEnvelope(
                    state: state,
                    scope: leaseScope,
                    resourceVersion: version,
                    payload: payload
                )
            )
        } catch let error as KeychainStorageError {
            throw error
        } catch {
            throw DeviceIdentityStoreError.keyUnavailable
        }
    }

    private func snapshot(
        for envelope: KeychainResourceLeaseEnvelope
    ) throws -> KeychainResourceLeaseSnapshot {
        do {
            let item = try KeychainResourceLeaseCodec.makeItem(for: envelope)
            return KeychainResourceLeaseSnapshot(envelope: envelope, item: item)
        } catch {
            throw DeviceIdentityStoreError.keyUnavailable
        }
    }

    private func activeApplicationTag(
        for lease: KeychainResourceLeaseSnapshot
    ) throws -> Data {
        let versioned = scope.applicationTag(
            resourceVersion: lease.envelope.resourceVersion
        )
        guard lease.envelope.state == .active,
              let tag = lease.envelope.payload,
              tag == versioned || tag == scope.legacyApplicationTag else {
            throw DeviceIdentityStoreError.keyUnavailable
        }
        return tag
    }

    private func signature(for payload: Data) throws -> Data {
        let lease = try activeLease(createIfAbsent: true)
        guard let key = try keys.existing(tag: activeApplicationTag(for: lease)) else {
            throw DeviceIdentityStoreError.keyUnavailable
        }
        try requireStillActive(lease)
        do {
            return try key.key.signature(for: payload)
        } catch let error as DeviceIdentityStoreError {
            throw error
        } catch {
            throw DeviceIdentityStoreError.signingFailed
        }
    }

    private func createOrReturnWinner(
        tag: Data,
        protection: DeviceSigningKeyProtection
    ) throws -> ManagedDeviceSigningKey {
        do {
            return try keys.create(tag: tag, protection: protection)
        } catch let error as KeychainStorageError {
            guard error == .status(errSecDuplicateItem),
                  let winner = try keys.existing(tag: tag) else {
                throw error
            }
            return winner
        } catch {
            if let winner = try keys.existing(tag: tag) { return winner }
            throw error
        }
    }

}

protocol DeviceSigningKey: AnyObject {
    func publicKeyX963Representation() throws -> Data
    func signature(for message: Data) throws -> Data
}

struct ManagedDeviceSigningKey {
    let key: DeviceSigningKey
    let protection: DeviceSigningKeyProtection
}

protocol DeviceIdentityKeyManaging: AnyObject {
    func existing(tag: Data) throws -> ManagedDeviceSigningKey?
    func create(tag: Data, protection: DeviceSigningKeyProtection) throws -> ManagedDeviceSigningKey
    func delete(tag: Data) throws
}

final class SystemDeviceIdentityKeys: DeviceIdentityKeyManaging {
    func existing(tag: Data) throws -> ManagedDeviceSigningKey? {
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query(tag: tag, returnRef: true) as CFDictionary, &item)
        switch status {
        case errSecSuccess:
            guard let item else {
                throw DeviceIdentityStoreError.keyUnavailable
            }
            let key = item as! SecKey
            return ManagedDeviceSigningKey(
                key: SecKeySigningKey(key),
                protection: protection(of: key)
            )
        case errSecItemNotFound:
            return nil
        default:
            throw KeychainStorageError.status(status)
        }
    }

    func create(tag: Data, protection: DeviceSigningKeyProtection) throws -> ManagedDeviceSigningKey {
        var accessError: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(
            nil,
            kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            .privateKeyUsage,
            &accessError
        ) else {
            throw DeviceIdentityStoreError.keyUnavailable
        }

        var privateAttributes: [CFString: Any] = [
            kSecAttrIsPermanent: true,
            kSecAttrApplicationTag: tag,
            kSecAttrAccessControl: access,
            kSecAttrSynchronizable: kCFBooleanFalse as Any,
        ]
        // A label is non-sensitive and makes the item recognizable in Keychain
        // diagnostics without exposing the account/device namespace.
        privateAttributes[kSecAttrLabel] = "Zephyr One device signing key"

        var attributes: [CFString: Any] = [
            kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits: 256,
            kSecPrivateKeyAttrs: privateAttributes,
            kSecUseDataProtectionKeychain: true,
        ]
        if protection == .secureEnclave {
            attributes[kSecAttrTokenID] = kSecAttrTokenIDSecureEnclave
        }

        var error: Unmanaged<CFError>?
        guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else {
            throw DeviceIdentityStoreError.keyUnavailable
        }
        return ManagedDeviceSigningKey(key: SecKeySigningKey(key), protection: protection)
    }

    func delete(tag: Data) throws {
        let status = SecItemDelete(query(tag: tag, returnRef: false) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainStorageError.status(status)
        }
    }

    private func query(tag: Data, returnRef: Bool) -> [CFString: Any] {
        var value: [CFString: Any] = [
            kSecClass: kSecClassKey,
            kSecAttrApplicationTag: tag,
            kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeyClass: kSecAttrKeyClassPrivate,
            kSecAttrSynchronizable: kCFBooleanFalse as Any,
            kSecUseDataProtectionKeychain: true,
        ]
        if returnRef {
            value[kSecReturnRef] = true
            value[kSecMatchLimit] = kSecMatchLimitOne
        }
        return value
    }

    private func protection(of key: SecKey) -> DeviceSigningKeyProtection {
        guard let attributes = SecKeyCopyAttributes(key) as NSDictionary?,
              let token = attributes[kSecAttrTokenID] as? String,
              token == (kSecAttrTokenIDSecureEnclave as String) else {
            return .softwareKeychain
        }
        return .secureEnclave
    }
}

private final class SecKeySigningKey: DeviceSigningKey {
    private let key: SecKey

    init(_ key: SecKey) {
        self.key = key
    }

    func publicKeyX963Representation() throws -> Data {
        guard let publicKey = SecKeyCopyPublicKey(key) else {
            throw DeviceIdentityStoreError.invalidPublicKey
        }
        var error: Unmanaged<CFError>?
        guard let data = SecKeyCopyExternalRepresentation(publicKey, &error) as Data? else {
            throw DeviceIdentityStoreError.invalidPublicKey
        }
        return data
    }

    func signature(for message: Data) throws -> Data {
        guard SecKeyIsAlgorithmSupported(key, .sign, .ecdsaSignatureMessageX962SHA256) else {
            throw DeviceIdentityStoreError.signingFailed
        }
        var error: Unmanaged<CFError>?
        guard let signature = SecKeyCreateSignature(
            key,
            .ecdsaSignatureMessageX962SHA256,
            message as CFData,
            &error
        ) as Data? else {
            throw DeviceIdentityStoreError.signingFailed
        }
        return signature
    }
}
