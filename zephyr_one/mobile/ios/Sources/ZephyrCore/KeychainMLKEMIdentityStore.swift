import CryptoKit
import Foundation
@_implementationOnly import OpenSSL
import Security

public enum MobileMLKEMIdentityError: Error, Equatable, CustomStringConvertible {
    case invalidScope
    case implementationUnavailable
    case keyGenerationFailed
    case keyImportFailed
    case invalidPublicKey
    case invalidPrivateKey
    case invalidCiphertext
    case invalidSharedSecret
    case corruptRecord
    case decapsulationFailed

    public var description: String {
        switch self {
        case .invalidScope: return "ML-KEM identity scope is invalid"
        case .implementationUnavailable: return "ML-KEM-768 is unavailable"
        case .keyGenerationFailed: return "ML-KEM-768 key generation failed"
        case .keyImportFailed: return "ML-KEM-768 key import failed"
        case .invalidPublicKey: return "ML-KEM-768 public key is invalid"
        case .invalidPrivateKey: return "ML-KEM-768 private key is invalid"
        case .invalidCiphertext: return "ML-KEM-768 ciphertext is invalid"
        case .invalidSharedSecret: return "ML-KEM-768 shared secret is invalid"
        case .corruptRecord: return "stored ML-KEM-768 identity is corrupt"
        case .decapsulationFailed: return "ML-KEM-768 decapsulation failed"
        }
    }
}

/// Opens device secret envelopes without exposing the decapsulation key.
public protocol MobileMLKEMDecapsulating: Sendable {
    func decapsulate(ciphertext: Data, for identity: SyncBindingIdentity) throws -> Data
}

/// A device-local ML-KEM-768 identity backed by OpenSSL 3.6 and Keychain.
///
/// OpenSSL owns the FIPS 203 primitive. This type persists only the standard
/// 1,184-byte encapsulation key and 2,400-byte decapsulation key. The Keychain
/// item is non-synchronizable, ThisDeviceOnly and scoped to the complete
/// server/account/device/generation tuple. A separate exact-CAS lease item
/// fences creation and retains a secret-free terminal tombstone after erasure.
public final class KeychainMLKEMIdentityStore:
    MobileEncryptionIdentityManaging,
    MobileMLKEMDecapsulating,
    @unchecked Sendable
{
    public static let algorithm = "ML-KEM-768"
    public static let publicKeyBytes = 1_184
    public static let privateKeyBytes = 2_400
    public static let ciphertextBytes = 1_088
    public static let sharedSecretBytes = 32
    public static let defaultServicePrefix = "one.zephyr.mobile.mlkem768.v1"
    private static let leaseResource = "device-encryption-mlkem768"

    private let servicePrefix: String
    private let engine: any MLKEM768Engine
    private let keychain: any MLKEMKeychainAccessing
    private let leaseItems: any KeychainResourceLeaseAccessing
    private let resourceVersion: () throws -> Data

    public convenience init(
        servicePrefix: String = KeychainMLKEMIdentityStore.defaultServicePrefix
    ) throws {
        try self.init(
            servicePrefix: servicePrefix,
            engine: OpenSSLMLKEM768Engine(),
            keychain: SystemMLKEMKeychain(),
            leaseItems: SystemKeychainResourceLeases()
        )
    }

    init(
        servicePrefix: String,
        engine: any MLKEM768Engine,
        keychain: any MLKEMKeychainAccessing
    ) throws {
        try self.init(
            servicePrefix: servicePrefix,
            engine: engine,
            keychain: keychain,
            leaseItems: EphemeralKeychainResourceLeases()
        )
    }

    init(
        servicePrefix: String,
        engine: any MLKEM768Engine,
        keychain: any MLKEMKeychainAccessing,
        leaseItems: any KeychainResourceLeaseAccessing,
        resourceVersion: @escaping () throws -> Data = KeychainResourceLeaseCodec.randomResourceVersion
    ) throws {
        guard Self.validComponent(servicePrefix) else {
            throw MobileMLKEMIdentityError.invalidScope
        }
        self.servicePrefix = servicePrefix
        self.engine = engine
        self.keychain = keychain
        self.leaseItems = leaseItems
        self.resourceVersion = resourceVersion
    }

    public func publicIdentity(for identity: SyncBindingIdentity) throws -> MobileDeviceEncryptionKey {
        let locator = try locator(for: identity)
        let lease = try activeLease(for: identity, at: locator)
        let identityAccount = try activeIdentityAccount(for: lease, at: locator)
        if var stored = try readIdentity(at: locator, account: identityAccount) {
            defer { stored.destroy() }
            try validate(stored)
            do {
                try requireStillActive(lease, for: identity, at: locator)
            } catch {
                try destroyIdentity(at: locator, account: identityAccount)
                throw error
            }
            return Self.publicIdentity(stored.publicKey)
        }

        var pair = try engine.generateKeyPair()
        defer { pair.destroy() }
        try validate(pair)

        var encoded = StoredMLKEMIdentity(
            publicKey: pair.publicKey,
            privateKey: pair.privateKey
        ).encoded()
        defer { secureZero(&encoded) }

        if try keychain.insertIfAbsent(
            encoded,
            service: locator.service,
            account: identityAccount
        ) {
            do {
                try requireStillActive(lease, for: identity, at: locator)
            } catch {
                try destroyIdentity(at: locator, account: identityAccount)
                throw error
            }
            return Self.publicIdentity(pair.publicKey)
        }

        // An app extension can win the atomic add. Always return the
        // persisted winner so the server never binds an orphaned key.
        guard var winner = try readIdentity(at: locator, account: identityAccount) else {
            throw MobileMLKEMIdentityError.corruptRecord
        }
        defer { winner.destroy() }
        try validate(winner)
        do {
            try requireStillActive(lease, for: identity, at: locator)
        } catch {
            try destroyIdentity(at: locator, account: identityAccount)
            throw error
        }
        return Self.publicIdentity(winner.publicKey)
    }

    /// Read-only recovery check. Missing state is reported as `false`; a
    /// malformed or mismatched key is an error and is never replaced here.
    public func hasIdentity(for identity: SyncBindingIdentity) throws -> Bool {
        let locator = try locator(for: identity)
        if let lease = try readLease(for: identity, at: locator) {
            guard lease.envelope.state == .active else { return false }
            let identityAccount = try activeIdentityAccount(for: lease, at: locator)
            guard var stored = try readIdentity(at: locator, account: identityAccount) else {
                return false
            }
            defer { stored.destroy() }
            try validate(stored)
            return true
        }
        guard var stored = try readIdentity(
            at: locator,
            account: locator.legacyIdentityAccount
        ) else { return false }
        defer { stored.destroy() }
        try validate(stored)
        return true
    }

    public func decapsulate(
        ciphertext: Data,
        for identity: SyncBindingIdentity
    ) throws -> Data {
        guard ciphertext.count == Self.ciphertextBytes else {
            throw MobileMLKEMIdentityError.invalidCiphertext
        }
        let locator = try locator(for: identity)
        let lease = try activeLease(for: identity, at: locator)
        let identityAccount = try activeIdentityAccount(for: lease, at: locator)
        guard var stored = try readIdentity(at: locator, account: identityAccount) else {
            throw MobileMLKEMIdentityError.corruptRecord
        }
        defer { stored.destroy() }
        try validate(stored)
        try requireStillActive(lease, for: identity, at: locator)

        var sharedSecret = try engine.decapsulate(
            privateKey: stored.privateKey,
            ciphertext: [UInt8](ciphertext)
        )
        defer { secureZero(&sharedSecret) }
        guard sharedSecret.count == Self.sharedSecretBytes else {
            throw MobileMLKEMIdentityError.invalidSharedSecret
        }
        return Data(sharedSecret)
    }

    public func deleteIdentity(for identity: SyncBindingIdentity) throws {
        let locator = try locator(for: identity)
        var identityAccounts = [locator.legacyIdentityAccount]
        while true {
            guard let current = try readLease(for: identity, at: locator) else {
                let tombstone = try makeLease(
                    state: .terminated,
                    for: identity,
                    at: locator
                )
                identityAccounts.append(
                    locator.identityAccount(
                        resourceVersion: tombstone.envelope.resourceVersion
                    )
                )
                if try leaseItems.insertIfAbsent(
                    tombstone.item,
                    service: locator.leaseService,
                    account: locator.leaseAccount
                ) {
                    break
                }
                continue
            }
            if current.envelope.state == .terminated {
                identityAccounts.append(
                    locator.identityAccount(
                        resourceVersion: current.envelope.resourceVersion
                    )
                )
                break
            }
            identityAccounts.append(try activeIdentityAccount(for: current, at: locator))
            let tombstone = try leaseSnapshot(for: current.envelope.terminated())
            if try leaseItems.replace(
                tombstone.item,
                matchingComparisonToken: current.item.comparisonToken,
                service: locator.leaseService,
                account: locator.leaseAccount
            ) {
                break
            }
        }
        for account in Set(identityAccounts) {
            try destroyIdentity(at: locator, account: account)
        }
    }

    private func activeLease(
        for identity: SyncBindingIdentity,
        at locator: MLKEMKeychainLocator
    ) throws -> KeychainResourceLeaseSnapshot {
        while true {
            if let current = try readLease(for: identity, at: locator) {
                guard current.envelope.state == .active else {
                    try destroyIdentity(
                        at: locator,
                        account: locator.identityAccount(
                            resourceVersion: current.envelope.resourceVersion
                        )
                    )
                    try destroyIdentity(at: locator, account: locator.legacyIdentityAccount)
                    throw MobileMLKEMIdentityError.corruptRecord
                }
                return current
            }
            let candidate = try makeLease(state: .active, for: identity, at: locator)
            if try leaseItems.insertIfAbsent(
                candidate.item,
                service: locator.leaseService,
                account: locator.leaseAccount
            ) {
                return candidate
            }
        }
    }

    private func requireStillActive(
        _ expected: KeychainResourceLeaseSnapshot,
        for identity: SyncBindingIdentity,
        at locator: MLKEMKeychainLocator
    ) throws {
        guard let current = try readLease(for: identity, at: locator),
              current.item.comparisonToken == expected.item.comparisonToken,
              current.envelope.state == .active else {
            throw MobileMLKEMIdentityError.corruptRecord
        }
    }

    private func readLease(
        for identity: SyncBindingIdentity,
        at locator: MLKEMKeychainLocator
    ) throws -> KeychainResourceLeaseSnapshot? {
        guard let item = try leaseItems.read(
            service: locator.leaseService,
            account: locator.leaseAccount
        ) else {
            return nil
        }
        do {
            let snapshot = try KeychainResourceLeaseCodec.decode(
                item,
                expectedScope: leaseScope(for: identity)
            )
            if snapshot.envelope.state == .active {
                _ = try activeIdentityAccount(for: snapshot, at: locator)
            }
            return snapshot
        } catch let error as KeychainStorageError {
            throw error
        } catch {
            throw MobileMLKEMIdentityError.corruptRecord
        }
    }

    private func makeLease(
        state: KeychainResourceLeaseState,
        for identity: SyncBindingIdentity,
        at locator: MLKEMKeychainLocator
    ) throws -> KeychainResourceLeaseSnapshot {
        do {
            let version = try resourceVersion()
            let payload: Data?
            if state == .active {
                var legacy = try keychain.read(
                    service: locator.service,
                    account: locator.legacyIdentityAccount
                )
                let hasLegacy = legacy != nil
                if var legacyData = legacy {
                    secureZero(&legacyData)
                    legacy = nil
                }
                let account = hasLegacy
                    ? locator.legacyIdentityAccount
                    : locator.identityAccount(resourceVersion: version)
                payload = Data(account.utf8)
            } else {
                payload = nil
            }
            return try leaseSnapshot(
                for: KeychainResourceLeaseEnvelope(
                    state: state,
                    scope: leaseScope(for: identity),
                    resourceVersion: version,
                    payload: payload
                )
            )
        } catch let error as KeychainStorageError {
            throw error
        } catch {
            throw MobileMLKEMIdentityError.corruptRecord
        }
    }

    private func leaseSnapshot(
        for envelope: KeychainResourceLeaseEnvelope
    ) throws -> KeychainResourceLeaseSnapshot {
        do {
            let item = try KeychainResourceLeaseCodec.makeItem(for: envelope)
            return KeychainResourceLeaseSnapshot(envelope: envelope, item: item)
        } catch {
            throw MobileMLKEMIdentityError.corruptRecord
        }
    }

    private func leaseScope(for identity: SyncBindingIdentity) -> KeychainResourceLeaseScope {
        KeychainResourceLeaseScope(resource: Self.leaseResource, identity: identity)
    }

    private func activeIdentityAccount(
        for lease: KeychainResourceLeaseSnapshot,
        at locator: MLKEMKeychainLocator
    ) throws -> String {
        let versioned = locator.identityAccount(
            resourceVersion: lease.envelope.resourceVersion
        )
        guard lease.envelope.state == .active,
              let payload = lease.envelope.payload,
              let account = String(data: payload, encoding: .utf8),
              account == versioned || account == locator.legacyIdentityAccount else {
            throw MobileMLKEMIdentityError.corruptRecord
        }
        return account
    }

    private func destroyIdentity(
        at locator: MLKEMKeychainLocator,
        account: String
    ) throws {
        guard var existing = try keychain.read(
            service: locator.service,
            account: account
        ) else {
            try keychain.delete(service: locator.service, account: account)
            return
        }
        defer { secureZero(&existing) }

        var zeros = Data(repeating: 0, count: existing.count)
        defer { secureZero(&zeros) }
        try keychain.overwrite(
            zeros,
            service: locator.service,
            account: account
        )
        try keychain.delete(service: locator.service, account: account)
    }

    private func readIdentity(
        at locator: MLKEMKeychainLocator,
        account: String
    ) throws -> StoredMLKEMIdentity? {
        guard var data = try keychain.read(service: locator.service, account: account) else {
            return nil
        }
        defer { secureZero(&data) }
        return try StoredMLKEMIdentity(decoding: data)
    }

    private func validate(_ stored: StoredMLKEMIdentity) throws {
        guard stored.publicKey.count == Self.publicKeyBytes else {
            throw MobileMLKEMIdentityError.invalidPublicKey
        }
        guard stored.privateKey.count == Self.privateKeyBytes else {
            throw MobileMLKEMIdentityError.invalidPrivateKey
        }
        let derived = try engine.publicKey(fromPrivateKey: stored.privateKey)
        guard derived.count == Self.publicKeyBytes, derived == stored.publicKey else {
            throw MobileMLKEMIdentityError.corruptRecord
        }
    }

    private func validate(_ pair: MLKEM768KeyPair) throws {
        guard pair.publicKey.count == Self.publicKeyBytes else {
            throw MobileMLKEMIdentityError.invalidPublicKey
        }
        guard pair.privateKey.count == Self.privateKeyBytes else {
            throw MobileMLKEMIdentityError.invalidPrivateKey
        }
        let derived = try engine.publicKey(fromPrivateKey: pair.privateKey)
        guard derived.count == Self.publicKeyBytes, derived == pair.publicKey else {
            throw MobileMLKEMIdentityError.keyGenerationFailed
        }
    }

    private func locator(for identity: SyncBindingIdentity) throws -> MLKEMKeychainLocator {
        let components = [
            identity.serverID,
            identity.accountID,
            identity.deviceID,
            identity.generation,
        ]
        guard components.allSatisfy(Self.validComponent) else {
            throw MobileMLKEMIdentityError.invalidScope
        }
        let namespace = [identity.serverID, identity.accountID, identity.deviceID]
            .joined(separator: "\0")
        let digest = SHA256.hash(data: Data(namespace.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
        return MLKEMKeychainLocator(
            service: servicePrefix + "." + digest,
            leaseService: servicePrefix + ".lease." + digest,
            leaseAccount: "generation." + KeychainNamespace.encode(identity.generation),
            legacyIdentityAccount: "generation." + KeychainNamespace.encode(identity.generation)
        )
    }

    private static func publicIdentity(_ publicKey: [UInt8]) -> MobileDeviceEncryptionKey {
        MobileDeviceEncryptionKey(
            alg: algorithm,
            publicKey: Data(publicKey).base64EncodedString()
        )
    }

    private static func validComponent(_ value: String) -> Bool {
        !value.isEmpty && !value.unicodeScalars.contains(where: { scalar in
            scalar.value == 0 || scalar.value == 10 || scalar.value == 13
        })
    }

}

private struct MLKEMKeychainLocator {
    let service: String
    let leaseService: String
    let leaseAccount: String
    let legacyIdentityAccount: String

    func identityAccount(resourceVersion: Data) -> String {
        let encodedVersion = resourceVersion.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        return legacyIdentityAccount + ".resource." + encodedVersion
    }
}

private struct StoredMLKEMIdentity {
    private static let magic = Array("ZMLKEM1\0".utf8)
    private static let encodedBytes =
        magic.count + KeychainMLKEMIdentityStore.publicKeyBytes + KeychainMLKEMIdentityStore.privateKeyBytes

    var publicKey: [UInt8]
    var privateKey: [UInt8]

    init(publicKey: [UInt8], privateKey: [UInt8]) {
        self.publicKey = publicKey
        self.privateKey = privateKey
    }

    init(decoding data: Data) throws {
        guard data.count == Self.encodedBytes else {
            throw MobileMLKEMIdentityError.corruptRecord
        }
        var bytes = [UInt8](data)
        defer { secureZero(&bytes) }
        guard bytes.starts(with: Self.magic) else {
            throw MobileMLKEMIdentityError.corruptRecord
        }
        let publicStart = Self.magic.count
        let privateStart = publicStart + KeychainMLKEMIdentityStore.publicKeyBytes
        self.publicKey = Array(bytes[publicStart..<privateStart])
        self.privateKey = Array(bytes[privateStart..<Self.encodedBytes])
    }

    func encoded() -> Data {
        var bytes = Self.magic + publicKey + privateKey
        defer { secureZero(&bytes) }
        return Data(bytes)
    }

    mutating func destroy() {
        secureZero(&privateKey)
        publicKey.removeAll(keepingCapacity: false)
    }
}

struct MLKEM768KeyPair {
    var publicKey: [UInt8]
    var privateKey: [UInt8]

    mutating func destroy() {
        secureZero(&privateKey)
        publicKey.removeAll(keepingCapacity: false)
    }
}

struct MLKEM768Encapsulation {
    var ciphertext: [UInt8]
    var sharedSecret: [UInt8]

    mutating func destroy() {
        ciphertext.removeAll(keepingCapacity: false)
        secureZero(&sharedSecret)
    }
}

protocol MLKEM768Engine: Sendable {
    func generateKeyPair() throws -> MLKEM768KeyPair
    func publicKey(fromPrivateKey privateKey: [UInt8]) throws -> [UInt8]
    func encapsulate(publicKey: [UInt8]) throws -> MLKEM768Encapsulation
    func decapsulate(privateKey: [UInt8], ciphertext: [UInt8]) throws -> [UInt8]
}

struct OpenSSLMLKEM768Engine: MLKEM768Engine {
    private static let algorithm = "ML-KEM-768"
    private static let publicParameter = "pub"
    private static let privateParameter = "priv"

    func generateKeyPair() throws -> MLKEM768KeyPair {
        ERR_clear_error()
        let context = try Self.makeAlgorithmContext()
        defer { EVP_PKEY_CTX_free(context) }
        guard EVP_PKEY_keygen_init(context) == 1 else {
            throw Self.failure(.keyGenerationFailed)
        }
        var key: OpaquePointer?
        guard EVP_PKEY_keygen(context, &key) == 1, let key else {
            throw Self.failure(.keyGenerationFailed)
        }
        defer { EVP_PKEY_free(key) }

        let publicKey = try Self.export(
            Self.publicParameter,
            expectedBytes: KeychainMLKEMIdentityStore.publicKeyBytes,
            from: key,
            error: .invalidPublicKey
        )
        let privateKey = try Self.export(
            Self.privateParameter,
            expectedBytes: KeychainMLKEMIdentityStore.privateKeyBytes,
            from: key,
            error: .invalidPrivateKey
        )
        return MLKEM768KeyPair(publicKey: publicKey, privateKey: privateKey)
    }

    func publicKey(fromPrivateKey privateKey: [UInt8]) throws -> [UInt8] {
        guard privateKey.count == KeychainMLKEMIdentityStore.privateKeyBytes else {
            throw MobileMLKEMIdentityError.invalidPrivateKey
        }
        return try Self.withImportedKey(
            privateKey,
            parameter: Self.privateParameter,
            selection: EVP_PKEY_KEYPAIR,
            importError: .invalidPrivateKey
        ) { key in
            try Self.export(
                Self.publicParameter,
                expectedBytes: KeychainMLKEMIdentityStore.publicKeyBytes,
                from: key,
                error: .invalidPublicKey
            )
        }
    }

    func encapsulate(publicKey: [UInt8]) throws -> MLKEM768Encapsulation {
        guard publicKey.count == KeychainMLKEMIdentityStore.publicKeyBytes else {
            throw MobileMLKEMIdentityError.invalidPublicKey
        }
        return try Self.withImportedKey(
            publicKey,
            parameter: Self.publicParameter,
            selection: EVP_PKEY_PUBLIC_KEY,
            importError: .invalidPublicKey
        ) { key in
            guard let context = EVP_PKEY_CTX_new_from_pkey(nil, key, nil) else {
                throw Self.failure(.implementationUnavailable)
            }
            defer { EVP_PKEY_CTX_free(context) }
            guard EVP_PKEY_encapsulate_init(context, nil) == 1 else {
                throw Self.failure(.keyImportFailed)
            }

            var ciphertextBytes = 0
            var sharedSecretBytes = 0
            guard EVP_PKEY_encapsulate(
                context,
                nil,
                &ciphertextBytes,
                nil,
                &sharedSecretBytes
            ) == 1,
            ciphertextBytes == KeychainMLKEMIdentityStore.ciphertextBytes,
            sharedSecretBytes == KeychainMLKEMIdentityStore.sharedSecretBytes else {
                throw Self.failure(.keyImportFailed)
            }

            var ciphertext = [UInt8](repeating: 0, count: ciphertextBytes)
            var sharedSecret = [UInt8](repeating: 0, count: sharedSecretBytes)
            let result = ciphertext.withUnsafeMutableBufferPointer { ciphertextBuffer in
                sharedSecret.withUnsafeMutableBufferPointer { secretBuffer in
                    EVP_PKEY_encapsulate(
                        context,
                        ciphertextBuffer.baseAddress,
                        &ciphertextBytes,
                        secretBuffer.baseAddress,
                        &sharedSecretBytes
                    )
                }
            }
            guard result == 1,
                  ciphertextBytes == ciphertext.count,
                  sharedSecretBytes == sharedSecret.count else {
                secureZero(&sharedSecret)
                throw Self.failure(.keyImportFailed)
            }
            return MLKEM768Encapsulation(
                ciphertext: ciphertext,
                sharedSecret: sharedSecret
            )
        }
    }

    func decapsulate(privateKey: [UInt8], ciphertext: [UInt8]) throws -> [UInt8] {
        guard privateKey.count == KeychainMLKEMIdentityStore.privateKeyBytes else {
            throw MobileMLKEMIdentityError.invalidPrivateKey
        }
        guard ciphertext.count == KeychainMLKEMIdentityStore.ciphertextBytes else {
            throw MobileMLKEMIdentityError.invalidCiphertext
        }
        return try Self.withImportedKey(
            privateKey,
            parameter: Self.privateParameter,
            selection: EVP_PKEY_KEYPAIR,
            importError: .invalidPrivateKey
        ) { key in
            guard let context = EVP_PKEY_CTX_new_from_pkey(nil, key, nil) else {
                throw Self.failure(.implementationUnavailable)
            }
            defer { EVP_PKEY_CTX_free(context) }
            guard EVP_PKEY_decapsulate_init(context, nil) == 1 else {
                throw Self.failure(.decapsulationFailed)
            }

            var sharedSecretBytes = KeychainMLKEMIdentityStore.sharedSecretBytes
            var sharedSecret = [UInt8](repeating: 0, count: sharedSecretBytes)
            let result = sharedSecret.withUnsafeMutableBufferPointer { secretBuffer in
                ciphertext.withUnsafeBufferPointer { ciphertextBuffer in
                    EVP_PKEY_decapsulate(
                        context,
                        secretBuffer.baseAddress,
                        &sharedSecretBytes,
                        ciphertextBuffer.baseAddress,
                        ciphertextBuffer.count
                    )
                }
            }
            guard result == 1, sharedSecretBytes == sharedSecret.count else {
                secureZero(&sharedSecret)
                throw Self.failure(.decapsulationFailed)
            }
            return sharedSecret
        }
    }

    private static func makeAlgorithmContext() throws -> OpaquePointer {
        let context = algorithm.withCString { name in
            EVP_PKEY_CTX_new_from_name(nil, name, nil)
        }
        guard let context else {
            throw failure(.implementationUnavailable)
        }
        return context
    }

    private static func withImportedKey<T>(
        _ rawKey: [UInt8],
        parameter: String,
        selection: Int32,
        importError: MobileMLKEMIdentityError,
        operation: (OpaquePointer) throws -> T
    ) throws -> T {
        ERR_clear_error()
        let context = try makeAlgorithmContext()
        defer { EVP_PKEY_CTX_free(context) }
        guard EVP_PKEY_fromdata_init(context) == 1 else {
            throw failure(.keyImportFailed)
        }

        var mutableKey = rawKey
        defer { secureZero(&mutableKey) }
        var key: OpaquePointer?
        let status = parameter.withCString { name in
            mutableKey.withUnsafeMutableBufferPointer { keyBuffer in
                var parameters = [
                    OSSL_PARAM_construct_octet_string(
                        name,
                        keyBuffer.baseAddress.map(UnsafeMutableRawPointer.init),
                        keyBuffer.count
                    ),
                    OSSL_PARAM_construct_end(),
                ]
                return parameters.withUnsafeMutableBufferPointer { parameterBuffer in
                    EVP_PKEY_fromdata(
                        context,
                        &key,
                        selection,
                        parameterBuffer.baseAddress
                    )
                }
            }
        }
        guard status == 1, let key else {
            throw failure(importError)
        }
        defer { EVP_PKEY_free(key) }
        return try operation(key)
    }

    private static func export(
        _ parameter: String,
        expectedBytes: Int,
        from key: OpaquePointer,
        error: MobileMLKEMIdentityError
    ) throws -> [UInt8] {
        var actualBytes = 0
        let measured = parameter.withCString { name in
            EVP_PKEY_get_octet_string_param(key, name, nil, 0, &actualBytes)
        }
        guard measured == 1, actualBytes == expectedBytes else {
            throw failure(error)
        }

        var output = [UInt8](repeating: 0, count: expectedBytes)
        let exported = output.withUnsafeMutableBufferPointer { buffer in
            parameter.withCString { name in
                EVP_PKEY_get_octet_string_param(
                    key,
                    name,
                    buffer.baseAddress,
                    buffer.count,
                    &actualBytes
                )
            }
        }
        guard exported == 1, actualBytes == expectedBytes else {
            if parameter == privateParameter { secureZero(&output) }
            throw failure(error)
        }
        return output
    }

    private static func failure(_ error: MobileMLKEMIdentityError) -> MobileMLKEMIdentityError {
        ERR_clear_error()
        return error
    }
}

private func secureZero(_ bytes: inout [UInt8]) {
    bytes.withUnsafeMutableBytes { buffer in
        guard let baseAddress = buffer.baseAddress, !buffer.isEmpty else { return }
        OPENSSL_cleanse(baseAddress, buffer.count)
    }
    bytes.removeAll(keepingCapacity: false)
}

private func secureZero(_ data: inout Data) {
    data.withUnsafeMutableBytes { buffer in
        guard let baseAddress = buffer.baseAddress, !buffer.isEmpty else { return }
        OPENSSL_cleanse(baseAddress, buffer.count)
    }
    data.removeAll(keepingCapacity: false)
}

protocol MLKEMKeychainAccessing: AnyObject, Sendable {
    func read(service: String, account: String) throws -> Data?
    func insertIfAbsent(_ data: Data, service: String, account: String) throws -> Bool
    func overwrite(_ data: Data, service: String, account: String) throws
    func delete(service: String, account: String) throws
}

final class SystemMLKEMKeychain: MLKEMKeychainAccessing, @unchecked Sendable {
    func read(service: String, account: String) throws -> Data? {
        var query = baseQuery(service: service, account: account)
        query[kSecReturnData] = true
        query[kSecMatchLimit] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        switch status {
        case errSecSuccess:
            guard let data = item as? Data else {
                throw KeychainStorageError.status(errSecDecode)
            }
            return data
        case errSecItemNotFound:
            return nil
        default:
            throw KeychainStorageError.status(status)
        }
    }

    func insertIfAbsent(
        _ data: Data,
        service: String,
        account: String
    ) throws -> Bool {
        var attributes = baseQuery(service: service, account: account)
        attributes[kSecValueData] = data
        attributes[kSecAttrAccessible] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let status = SecItemAdd(attributes as CFDictionary, nil)
        switch status {
        case errSecSuccess: return true
        case errSecDuplicateItem: return false
        default: throw KeychainStorageError.status(status)
        }
    }

    func overwrite(_ data: Data, service: String, account: String) throws {
        let status = SecItemUpdate(
            baseQuery(service: service, account: account) as CFDictionary,
            [kSecValueData: data] as CFDictionary
        )
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainStorageError.status(status)
        }
    }

    func delete(service: String, account: String) throws {
        let status = SecItemDelete(baseQuery(service: service, account: account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
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
}
