import Foundation
import XCTest
@testable import ZephyrCore

final class KeychainMLKEMIdentityStoreTests: XCTestCase {
    func testOpenSSLGeneratesStandardFIPS203KeysAndRoundTrips() throws {
        let engine = OpenSSLMLKEM768Engine()
        var pair = try engine.generateKeyPair()
        defer { pair.destroy() }

        XCTAssertEqual(pair.publicKey.count, KeychainMLKEMIdentityStore.publicKeyBytes)
        XCTAssertEqual(pair.privateKey.count, KeychainMLKEMIdentityStore.privateKeyBytes)
        XCTAssertEqual(try engine.publicKey(fromPrivateKey: pair.privateKey), pair.publicKey)

        var encapsulation = try engine.encapsulate(publicKey: pair.publicKey)
        defer { encapsulation.destroy() }
        XCTAssertEqual(
            encapsulation.ciphertext.count,
            KeychainMLKEMIdentityStore.ciphertextBytes
        )
        XCTAssertEqual(
            encapsulation.sharedSecret.count,
            KeychainMLKEMIdentityStore.sharedSecretBytes
        )
        XCTAssertEqual(
            try engine.decapsulate(
                privateKey: pair.privateKey,
                ciphertext: encapsulation.ciphertext
            ),
            encapsulation.sharedSecret
        )
    }

    func testIdentityIsStableAndScopedToCompleteBindingIdentity() throws {
        let keychain = MemoryMLKEMKeychain()
        let engine = DeterministicMLKEMEngine()
        let store = try KeychainMLKEMIdentityStore(
            servicePrefix: "test.mlkem",
            engine: engine,
            keychain: keychain
        )
        let first = identity(generation: "generation-1")
        let identities = [
            first,
            identity(serverID: "server-2"),
            identity(accountID: "account-2"),
            identity(deviceID: "device-2"),
            identity(generation: "generation-2"),
        ]

        XCTAssertFalse(try store.hasIdentity(for: first))
        let firstPublic = try store.publicIdentity(for: first)
        XCTAssertTrue(try store.hasIdentity(for: first))
        XCTAssertEqual(try store.publicIdentity(for: first), firstPublic)
        let publicIdentities = try identities.map { try store.publicIdentity(for: $0) }

        XCTAssertEqual(Set(publicIdentities.map(\.publicKey)).count, identities.count)
        XCTAssertEqual(publicIdentities.first, firstPublic)
        XCTAssertEqual(engine.generatedCount, identities.count)
        XCTAssertEqual(keychain.items.count, identities.count)
        XCTAssertTrue(keychain.insertAccessibility.allSatisfy { $0 == .whenUnlockedThisDeviceOnly })
        XCTAssertEqual(Data(base64Encoded: firstPublic.publicKey)?.count, 1_184)
    }

    func testAtomicCreateReturnsAnotherProcessWinner() throws {
        let keychain = MemoryMLKEMKeychain()
        let engine = DeterministicMLKEMEngine()
        let store = try KeychainMLKEMIdentityStore(
            servicePrefix: "test.mlkem",
            engine: engine,
            keychain: keychain
        )
        let identity = identity()
        let winner = try makeEncodedIdentity(seed: 91)
        keychain.insertWinner = winner

        let result = try store.publicIdentity(for: identity)

        XCTAssertEqual(Data(base64Encoded: result.publicKey), Data(repeating: 91, count: 1_184))
        XCTAssertEqual(engine.generatedCount, 1)
    }

    func testCorruptRecordFailsClosedWithoutRotation() throws {
        let keychain = MemoryMLKEMKeychain()
        keychain.defaultRead = Data("not-an-identity".utf8)
        let engine = DeterministicMLKEMEngine()
        let store = try KeychainMLKEMIdentityStore(
            servicePrefix: "test.mlkem",
            engine: engine,
            keychain: keychain
        )

        XCTAssertThrowsError(try store.publicIdentity(for: identity())) { error in
            XCTAssertEqual(error as? MobileMLKEMIdentityError, .corruptRecord)
        }
        XCTAssertThrowsError(try store.hasIdentity(for: identity())) { error in
            XCTAssertEqual(error as? MobileMLKEMIdentityError, .corruptRecord)
        }
        XCTAssertEqual(engine.generatedCount, 0)
    }

    func testLegacyIdentityIsAdoptedWithoutChangingPublicKey() throws {
        let keychain = MemoryMLKEMKeychain()
        keychain.defaultRead = try makeEncodedIdentity(seed: 91)
        let leases = MemoryResourceLeaseKeychain()
        let engine = DeterministicMLKEMEngine()
        let store = try KeychainMLKEMIdentityStore(
            servicePrefix: "test.mlkem",
            engine: engine,
            keychain: keychain,
            leaseItems: leases
        )

        let result = try store.publicIdentity(for: identity())

        XCTAssertEqual(Data(base64Encoded: result.publicKey), Data(repeating: 91, count: 1_184))
        XCTAssertEqual(engine.generatedCount, 0)
        XCTAssertEqual(try leases.onlyEnvelope().state, .active)
        XCTAssertNotNil(try leases.onlyEnvelope().payload)
    }

    func testDecapsulationValidatesCiphertextAndDoesNotExposePrivateKey() throws {
        let keychain = MemoryMLKEMKeychain()
        let engine = DeterministicMLKEMEngine()
        let store = try KeychainMLKEMIdentityStore(
            servicePrefix: "test.mlkem",
            engine: engine,
            keychain: keychain
        )
        let identity = identity()
        _ = try store.publicIdentity(for: identity)

        XCTAssertThrowsError(
            try store.decapsulate(ciphertext: Data(repeating: 0, count: 1_087), for: identity)
        ) { error in
            XCTAssertEqual(error as? MobileMLKEMIdentityError, .invalidCiphertext)
        }

        let secret = try store.decapsulate(
            ciphertext: Data(repeating: 7, count: 1_088),
            for: identity
        )
        XCTAssertEqual(secret.count, 32)
        XCTAssertEqual(secret.first, 6)
    }

    func testDeleteOverwritesThenRemovesOnlyRequestedGeneration() throws {
        let keychain = MemoryMLKEMKeychain()
        let store = try KeychainMLKEMIdentityStore(
            servicePrefix: "test.mlkem",
            engine: DeterministicMLKEMEngine(),
            keychain: keychain
        )
        let first = identity(generation: "generation-1")
        let second = identity(generation: "generation-2")
        _ = try store.publicIdentity(for: first)
        let secondPublic = try store.publicIdentity(for: second)

        try store.deleteIdentity(for: first)

        XCTAssertEqual(keychain.overwrites.count, 1)
        XCTAssertEqual(keychain.overwrites[0].count, 3_592)
        XCTAssertTrue(keychain.overwrites[0].allSatisfy { $0 == 0 })
        XCTAssertEqual(keychain.items.count, 1)
        XCTAssertEqual(try store.publicIdentity(for: second), secondPublic)
    }

    func testInvalidScopeNeverTouchesKeychain() throws {
        let keychain = MemoryMLKEMKeychain()
        let store = try KeychainMLKEMIdentityStore(
            servicePrefix: "test.mlkem",
            engine: DeterministicMLKEMEngine(),
            keychain: keychain
        )
        let invalid = SyncBindingIdentity(
            serverID: "",
            accountID: "account-1",
            deviceID: "device-1",
            generation: "generation-1"
        )

        XCTAssertThrowsError(try store.publicIdentity(for: invalid)) { error in
            XCTAssertEqual(error as? MobileMLKEMIdentityError, .invalidScope)
        }
        XCTAssertTrue(keychain.items.isEmpty)
    }

    func testLateCreateIsErasedAfterAnotherSceneTerminatesLease() throws {
        let keychain = MemoryMLKEMKeychain()
        let leases = MemoryResourceLeaseKeychain()
        let engine = DeterministicMLKEMEngine()
        let creator = try KeychainMLKEMIdentityStore(
            servicePrefix: "test.mlkem",
            engine: engine,
            keychain: keychain,
            leaseItems: leases
        )
        let deleter = try KeychainMLKEMIdentityStore(
            servicePrefix: "test.mlkem",
            engine: engine,
            keychain: keychain,
            leaseItems: leases
        )
        let identity = identity()
        keychain.beforeNextInsert = { try deleter.deleteIdentity(for: identity) }

        XCTAssertThrowsError(try creator.publicIdentity(for: identity)) { error in
            XCTAssertEqual(error as? MobileMLKEMIdentityError, .corruptRecord)
        }

        XCTAssertTrue(keychain.items.isEmpty)
        XCTAssertEqual(try leases.onlyEnvelope().state, .terminated)
        XCTAssertNil(try leases.onlyEnvelope().payload)

        let restarted = try KeychainMLKEMIdentityStore(
            servicePrefix: "test.mlkem",
            engine: engine,
            keychain: keychain,
            leaseItems: leases
        )
        XCTAssertThrowsError(try restarted.publicIdentity(for: identity)) { error in
            XCTAssertEqual(error as? MobileMLKEMIdentityError, .corruptRecord)
        }
        XCTAssertEqual(engine.generatedCount, 1)
        XCTAssertTrue(keychain.items.isEmpty)
    }

    func testCompetingCreatorReturnsPersistedWinnerWithoutReplacement() throws {
        let keychain = MemoryMLKEMKeychain()
        let leases = MemoryResourceLeaseKeychain()
        let engine = DeterministicMLKEMEngine()
        let first = try KeychainMLKEMIdentityStore(
            servicePrefix: "test.mlkem",
            engine: engine,
            keychain: keychain,
            leaseItems: leases
        )
        let second = try KeychainMLKEMIdentityStore(
            servicePrefix: "test.mlkem",
            engine: engine,
            keychain: keychain,
            leaseItems: leases
        )
        let identity = identity()
        var winner: MobileDeviceEncryptionKey?
        keychain.beforeNextInsert = {
            winner = try second.publicIdentity(for: identity)
        }

        let result = try first.publicIdentity(for: identity)

        XCTAssertEqual(result, try XCTUnwrap(winner))
        XCTAssertEqual(Data(base64Encoded: result.publicKey), Data(repeating: 2, count: 1_184))
        XCTAssertEqual(engine.generatedCount, 2)
        XCTAssertEqual(keychain.items.count, 1)
        XCTAssertEqual(try leases.onlyEnvelope().state, .active)
    }

    func testStaleCreatorCannotOverwriteOrEraseReplacementLeaseWinner() throws {
        let keychain = MemoryMLKEMKeychain()
        let leases = MemoryResourceLeaseKeychain()
        let engine = DeterministicMLKEMEngine()
        let staleCreator = try KeychainMLKEMIdentityStore(
            servicePrefix: "test.mlkem",
            engine: engine,
            keychain: keychain,
            leaseItems: leases
        )
        let winnerStore = try KeychainMLKEMIdentityStore(
            servicePrefix: "test.mlkem",
            engine: engine,
            keychain: keychain,
            leaseItems: leases
        )
        let identity = identity()
        let winnerVersion = Data(repeating: 0x6b, count: 32)
        var winner: MobileDeviceEncryptionKey?
        keychain.beforeNextInsert = {
            let current = try leases.onlyEnvelope()
            let currentAccount = try XCTUnwrap(
                current.payload.flatMap { String(data: $0, encoding: .utf8) }
            )
            let marker = try XCTUnwrap(currentAccount.range(of: ".resource.", options: .backwards))
            let accountPrefix = String(currentAccount[..<marker.lowerBound])
            let encodedVersion = winnerVersion.base64EncodedString()
                .replacingOccurrences(of: "+", with: "-")
                .replacingOccurrences(of: "/", with: "_")
                .replacingOccurrences(of: "=", with: "")
            let winnerAccount = accountPrefix + ".resource." + encodedVersion
            try leases.forceReplaceOnlyEnvelope(
                KeychainResourceLeaseEnvelope(
                    state: .active,
                    scope: current.scope,
                    resourceVersion: winnerVersion,
                    payload: Data(winnerAccount.utf8)
                )
            )
            winner = try winnerStore.publicIdentity(for: identity)
        }

        XCTAssertThrowsError(try staleCreator.publicIdentity(for: identity)) { error in
            XCTAssertEqual(error as? MobileMLKEMIdentityError, .corruptRecord)
        }

        XCTAssertEqual(
            try winnerStore.publicIdentity(for: identity),
            try XCTUnwrap(winner)
        )
        XCTAssertEqual(engine.generatedCount, 2)
        XCTAssertEqual(keychain.items.count, 1)
        XCTAssertEqual(try leases.onlyEnvelope().resourceVersion, winnerVersion)
    }

    func testRestartRecoversWinnerAndDurableTombstonePreventsRecreation() throws {
        let keychain = MemoryMLKEMKeychain()
        let leases = MemoryResourceLeaseKeychain()
        let engine = DeterministicMLKEMEngine()
        let identity = identity()
        let original = try KeychainMLKEMIdentityStore(
            servicePrefix: "test.mlkem",
            engine: engine,
            keychain: keychain,
            leaseItems: leases
        )
        let expected = try original.publicIdentity(for: identity)

        let restarted = try KeychainMLKEMIdentityStore(
            servicePrefix: "test.mlkem",
            engine: engine,
            keychain: keychain,
            leaseItems: leases
        )
        XCTAssertEqual(try restarted.publicIdentity(for: identity), expected)
        XCTAssertEqual(engine.generatedCount, 1)
        try restarted.deleteIdentity(for: identity)

        XCTAssertEqual(try leases.onlyEnvelope().state, .terminated)
        XCTAssertEqual(try leases.onlyEnvelope().resourceVersion.count, 32)
        XCTAssertNil(try leases.onlyEnvelope().payload)
        XCTAssertTrue(keychain.items.isEmpty)

        let restartedAfterDelete = try KeychainMLKEMIdentityStore(
            servicePrefix: "test.mlkem",
            engine: engine,
            keychain: keychain,
            leaseItems: leases
        )
        XCTAssertFalse(try restartedAfterDelete.hasIdentity(for: identity))
        XCTAssertThrowsError(try restartedAfterDelete.publicIdentity(for: identity)) { error in
            XCTAssertEqual(error as? MobileMLKEMIdentityError, .corruptRecord)
        }
        XCTAssertEqual(engine.generatedCount, 1)
    }

    func testLockedLeaseIOFailsClosedWithoutGeneratingOrDeleteMissAdd() throws {
        let keychain = MemoryMLKEMKeychain()
        let leases = MemoryResourceLeaseKeychain()
        let engine = DeterministicMLKEMEngine()
        let store = try KeychainMLKEMIdentityStore(
            servicePrefix: "test.mlkem",
            engine: engine,
            keychain: keychain,
            leaseItems: leases
        )
        let locked = KeychainStorageError.status(-25308)
        leases.failNextRead(with: locked)

        XCTAssertThrowsError(try store.publicIdentity(for: identity())) { error in
            XCTAssertEqual(error as? KeychainStorageError, locked)
        }
        XCTAssertEqual(engine.generatedCount, 0)
        XCTAssertEqual(leases.insertCount, 0)

        _ = try store.publicIdentity(for: identity())
        leases.failNextReplace(with: locked)
        XCTAssertThrowsError(try store.deleteIdentity(for: identity())) { error in
            XCTAssertEqual(error as? KeychainStorageError, locked)
        }
        XCTAssertTrue(try store.hasIdentity(for: identity()))
        XCTAssertEqual(leases.insertCount, 1)
        XCTAssertEqual(try leases.onlyEnvelope().state, .active)
    }

    func testTerminatedLeaseSurvivesLockedSecretErasureAndRetry() throws {
        let keychain = MemoryMLKEMKeychain()
        let leases = MemoryResourceLeaseKeychain()
        let store = try KeychainMLKEMIdentityStore(
            servicePrefix: "test.mlkem",
            engine: DeterministicMLKEMEngine(),
            keychain: keychain,
            leaseItems: leases
        )
        let locked = KeychainStorageError.status(-25308)
        _ = try store.publicIdentity(for: identity())
        keychain.failNextOverwrite(with: locked)

        XCTAssertThrowsError(try store.deleteIdentity(for: identity())) { error in
            XCTAssertEqual(error as? KeychainStorageError, locked)
        }
        XCTAssertEqual(try leases.onlyEnvelope().state, .terminated)
        XCTAssertFalse(keychain.items.isEmpty)
        XCTAssertFalse(try store.hasIdentity(for: identity()))

        try store.deleteIdentity(for: identity())
        XCTAssertTrue(keychain.items.isEmpty)
        XCTAssertEqual(try leases.onlyEnvelope().state, .terminated)
    }

    func testDeleteRetriesComparisonMissWithoutAddingAnotherLease() throws {
        let keychain = MemoryMLKEMKeychain()
        let leases = MemoryResourceLeaseKeychain()
        let store = try KeychainMLKEMIdentityStore(
            servicePrefix: "test.mlkem",
            engine: DeterministicMLKEMEngine(),
            keychain: keychain,
            leaseItems: leases
        )
        _ = try store.publicIdentity(for: identity())
        leases.failNextReplaceAsComparisonMiss()

        try store.deleteIdentity(for: identity())

        XCTAssertEqual(leases.insertCount, 1)
        XCTAssertEqual(leases.replaceCount, 1)
        XCTAssertEqual(try leases.onlyEnvelope().state, .terminated)
        XCTAssertTrue(keychain.items.isEmpty)
    }

    private func identity(
        serverID: String = "server-1",
        accountID: String = "account-1",
        deviceID: String = "device-1",
        generation: String = "generation-1"
    ) -> SyncBindingIdentity {
        SyncBindingIdentity(
            serverID: serverID,
            accountID: accountID,
            deviceID: deviceID,
            generation: generation
        )
    }

    private func makeEncodedIdentity(seed: UInt8) throws -> Data {
        let keychain = MemoryMLKEMKeychain()
        let engine = DeterministicMLKEMEngine(startingSeed: seed)
        let store = try KeychainMLKEMIdentityStore(
            servicePrefix: "fixture.mlkem",
            engine: engine,
            keychain: keychain
        )
        _ = try store.publicIdentity(for: identity())
        return try XCTUnwrap(keychain.items.values.first)
    }
}

private final class DeterministicMLKEMEngine: MLKEM768Engine, @unchecked Sendable {
    private let lock = NSLock()
    private var nextSeed: UInt8
    private(set) var generatedCount = 0

    init(startingSeed: UInt8 = 1) {
        self.nextSeed = startingSeed
    }

    func generateKeyPair() throws -> MLKEM768KeyPair {
        lock.lock()
        defer { lock.unlock() }
        let seed = nextSeed
        nextSeed &+= 1
        generatedCount += 1
        return MLKEM768KeyPair(
            publicKey: [UInt8](repeating: seed, count: 1_184),
            privateKey: [UInt8](repeating: seed, count: 2_400)
        )
    }

    func publicKey(fromPrivateKey privateKey: [UInt8]) throws -> [UInt8] {
        guard let seed = privateKey.first, privateKey.count == 2_400 else {
            throw MobileMLKEMIdentityError.invalidPrivateKey
        }
        return [UInt8](repeating: seed, count: 1_184)
    }

    func encapsulate(publicKey: [UInt8]) throws -> MLKEM768Encapsulation {
        guard let seed = publicKey.first, publicKey.count == 1_184 else {
            throw MobileMLKEMIdentityError.invalidPublicKey
        }
        return MLKEM768Encapsulation(
            ciphertext: [UInt8](repeating: 7, count: 1_088),
            sharedSecret: [UInt8](repeating: seed ^ 7, count: 32)
        )
    }

    func decapsulate(privateKey: [UInt8], ciphertext: [UInt8]) throws -> [UInt8] {
        guard let seed = privateKey.first, privateKey.count == 2_400 else {
            throw MobileMLKEMIdentityError.invalidPrivateKey
        }
        guard let first = ciphertext.first, ciphertext.count == 1_088 else {
            throw MobileMLKEMIdentityError.invalidCiphertext
        }
        return [UInt8](repeating: seed ^ first, count: 32)
    }
}

private final class MemoryMLKEMKeychain: MLKEMKeychainAccessing, @unchecked Sendable {
    private let lock = NSLock()
    var items = [String: Data]()
    var insertAccessibility = [KeychainItemAccessibility]()
    var overwrites = [Data]()
    var insertWinner: Data?
    var defaultRead: Data?
    var beforeNextInsert: (() throws -> Void)?
    private var nextOverwriteError: Error?

    func failNextOverwrite(with error: Error) {
        synchronized { nextOverwriteError = error }
    }

    func read(service: String, account: String) throws -> Data? {
        synchronized { items[key(service, account)] ?? defaultRead }
    }

    func insertIfAbsent(_ data: Data, service: String, account: String) throws -> Bool {
        let hook = synchronized { () -> (() throws -> Void)? in
            let value = beforeNextInsert
            beforeNextInsert = nil
            return value
        }
        try hook?()
        return synchronized {
            let key = key(service, account)
            if items[key] != nil { return false }
            insertAccessibility.append(.whenUnlockedThisDeviceOnly)
            if let insertWinner {
                items[key] = insertWinner
                self.insertWinner = nil
                return false
            }
            items[key] = data
            return true
        }
    }

    func overwrite(_ data: Data, service: String, account: String) throws {
        try synchronized {
            if let error = nextOverwriteError {
                nextOverwriteError = nil
                throw error
            }
            let key = key(service, account)
            guard items[key] != nil else { return }
            overwrites.append(data)
            items[key] = data
        }
    }

    func delete(service: String, account: String) throws {
        synchronized { items.removeValue(forKey: key(service, account)) }
    }

    private func key(_ service: String, _ account: String) -> String {
        service + "\0" + account
    }

    private func synchronized<T>(_ operation: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try operation()
    }
}
