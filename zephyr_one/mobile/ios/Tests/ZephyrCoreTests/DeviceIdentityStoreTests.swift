import Foundation
import XCTest
@testable import ZephyrCore

final class DeviceIdentityStoreTests: XCTestCase {
    func testSecureEnclaveFailureUsesExplicitSoftwareFallback() throws {
        let keys = FakeIdentityKeys()
        keys.secureEnclaveFailure = DeviceIdentityStoreError.keyUnavailable
        let store = DeviceIdentityStore(scope: try scope(), keys: keys)

        let identity = try store.ensureIdentity()

        XCTAssertEqual(identity.algorithm, "ES256")
        XCTAssertEqual(identity.protection, .softwareKeychain)
        XCTAssertFalse(identity.isHardwareBacked)
        XCTAssertEqual(keys.createAttempts, [.secureEnclave, .softwareKeychain])
        XCTAssertEqual(identity.jwk["kty"], "EC")
        XCTAssertEqual(identity.jwk["crv"], "P-256")
        XCTAssertEqual(identity.jwk["x"], "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE")
        XCTAssertEqual(identity.jwk["y"], "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI")
    }

    func testExistingIdentityIsIdempotentAndProofBytesMatchAndroidLayout() throws {
        let keys = FakeIdentityKeys()
        keys.current = ManagedDeviceSigningKey(
            key: FakeSigningKey(),
            protection: .secureEnclave
        )
        let store = DeviceIdentityStore(scope: try scope(), keys: keys)

        XCTAssertEqual(try store.ensureIdentity().protection, .secureEnclave)
        XCTAssertTrue(try store.hasIdentity())
        XCTAssertTrue(keys.createAttempts.isEmpty)

        let proof = try store.signRequestProof(
            method: "post",
            path: "/api/mobile/v1/sync/push",
            body: Data("{}".utf8),
            timestampSeconds: 1_723_456_789,
            serverNonce: "nonce-1"
        )
        XCTAssertEqual(proof, "MAA=")
        let expectedMessage = [
            "zephyr-one-device-proof-v1",
            "device-1",
            "POST",
            "/api/mobile/v1/sync/push",
            "RBNvo1WzZ4oRRq0W9+hknpT7T8If536DEMBg9hyq/4o=",
            "1723456789",
            "nonce-1",
        ].joined(separator: "\0")
        XCTAssertEqual(
            String(data: try XCTUnwrap((keys.current?.key as? FakeSigningKey)?.signedMessage), encoding: .utf8),
            expectedMessage
        )
    }

    func testUnbindAndRevokeDeleteThePrivateKey() throws {
        let keys = FakeIdentityKeys()
        keys.current = ManagedDeviceSigningKey(key: FakeSigningKey(), protection: .secureEnclave)
        let store = DeviceIdentityStore(scope: try scope(), keys: keys)

        try store.removeForUnbind()
        XCTAssertFalse(try store.hasIdentity())
        XCTAssertEqual(keys.deleteCount, 2)

        keys.current = ManagedDeviceSigningKey(key: FakeSigningKey(), protection: .softwareKeychain)
        try store.removeForRevocation()
        XCTAssertFalse(try store.hasIdentity())
        XCTAssertEqual(keys.deleteCount, 4)
    }

    func testProofFieldsRejectSeparatorInjection() throws {
        let keys = FakeIdentityKeys()
        keys.current = ManagedDeviceSigningKey(key: FakeSigningKey(), protection: .secureEnclave)
        let store = DeviceIdentityStore(scope: try scope(), keys: keys)

        XCTAssertThrowsError(
            try store.signRequestProof(
                method: "GET\0POST",
                path: "/path",
                body: Data(),
                timestampSeconds: 1,
                serverNonce: "nonce"
            )
        ) { error in
            XCTAssertEqual(error as? DeviceIdentityStoreError, .invalidProofInput("method"))
        }
    }

    func testLatePermanentCreateIsErasedAfterAnotherSceneTerminatesLease() throws {
        let keys = FakeIdentityKeys()
        let leases = MemoryResourceLeaseKeychain()
        let scope = try scope()
        let creator = DeviceIdentityStore(scope: scope, keys: keys, leaseItems: leases)
        let deleter = DeviceIdentityStore(scope: scope, keys: keys, leaseItems: leases)
        keys.beforeNextCreate = { _ in try deleter.deleteIdentity() }

        XCTAssertThrowsError(try creator.ensureIdentity()) { error in
            XCTAssertEqual(error as? DeviceIdentityStoreError, .keyUnavailable)
        }

        XCTAssertNil(keys.current, "the post-create exact lease check must erase the late key")
        XCTAssertEqual(try leases.onlyEnvelope().state, .terminated)
        XCTAssertNil(try leases.onlyEnvelope().payload)

        let restarted = DeviceIdentityStore(scope: scope, keys: keys, leaseItems: leases)
        XCTAssertThrowsError(try restarted.ensureIdentity()) { error in
            XCTAssertEqual(error as? DeviceIdentityStoreError, .keyUnavailable)
        }
        XCTAssertNil(keys.current)
    }

    func testCompetingCreatorReturnsThePermanentKeyWinnerWithoutReplacement() throws {
        let keys = FakeIdentityKeys()
        let leases = MemoryResourceLeaseKeychain()
        let scope = try scope()
        let first = DeviceIdentityStore(scope: scope, keys: keys, leaseItems: leases)
        let second = DeviceIdentityStore(scope: scope, keys: keys, leaseItems: leases)
        var winner: DeviceSigningKey?
        keys.beforeNextCreate = { _ in
            _ = try second.ensureIdentity()
            winner = keys.current?.key
        }

        _ = try first.ensureIdentity()

        XCTAssertEqual(keys.successfulCreateCount, 1)
        XCTAssertTrue(try XCTUnwrap(keys.current?.key) === try XCTUnwrap(winner))
        XCTAssertEqual(try leases.onlyEnvelope().state, .active)
    }

    func testCompetingSoftwareFallbackCreatorAlsoReturnsWinner() throws {
        let keys = FakeIdentityKeys()
        keys.secureEnclaveFailure = DeviceIdentityStoreError.keyUnavailable
        let leases = MemoryResourceLeaseKeychain()
        let scope = try scope()
        let first = DeviceIdentityStore(scope: scope, keys: keys, leaseItems: leases)
        let second = DeviceIdentityStore(scope: scope, keys: keys, leaseItems: leases)
        keys.beforeNextCreate = { protection in
            guard protection == .softwareKeychain else { return }
            _ = try second.ensureIdentity()
        }

        let identity = try first.ensureIdentity()

        XCTAssertEqual(identity.protection, .softwareKeychain)
        XCTAssertEqual(keys.successfulCreateCount, 1)
        XCTAssertEqual(
            keys.createAttempts,
            [.secureEnclave, .softwareKeychain, .secureEnclave, .softwareKeychain]
        )
    }

    func testStaleCreatorCannotDeleteReplacementLeaseWinner() throws {
        let keys = FakeIdentityKeys()
        let leases = MemoryResourceLeaseKeychain()
        let scope = try scope()
        let staleCreator = DeviceIdentityStore(scope: scope, keys: keys, leaseItems: leases)
        let winnerStore = DeviceIdentityStore(scope: scope, keys: keys, leaseItems: leases)
        let winnerVersion = Data(repeating: 0x5a, count: 32)
        var winner: DeviceSigningKey?
        keys.beforeNextCreate = { _ in
            let current = try leases.onlyEnvelope()
            try leases.forceReplaceOnlyEnvelope(
                KeychainResourceLeaseEnvelope(
                    state: .active,
                    scope: current.scope,
                    resourceVersion: winnerVersion,
                    payload: scope.applicationTag(resourceVersion: winnerVersion)
                )
            )
            _ = try winnerStore.ensureIdentity()
            winner = keys.current?.key
        }

        XCTAssertThrowsError(try staleCreator.ensureIdentity()) { error in
            XCTAssertEqual(error as? DeviceIdentityStoreError, .keyUnavailable)
        }

        XCTAssertTrue(try XCTUnwrap(keys.current?.key) === try XCTUnwrap(winner))
        XCTAssertEqual(keys.successfulCreateCount, 2)
        XCTAssertEqual(try winnerStore.ensureIdentity().protection, .secureEnclave)
        XCTAssertEqual(keys.successfulCreateCount, 2)
        XCTAssertEqual(try leases.onlyEnvelope().resourceVersion, winnerVersion)
    }

    func testRestartRecoversActiveLeaseAndTombstonePreventsRecreation() throws {
        let keys = FakeIdentityKeys()
        let leases = MemoryResourceLeaseKeychain()
        let scope = try scope()
        let original = DeviceIdentityStore(scope: scope, keys: keys, leaseItems: leases)
        let expected = try original.ensureIdentity()

        let restarted = DeviceIdentityStore(scope: scope, keys: keys, leaseItems: leases)
        XCTAssertEqual(try restarted.ensureIdentity(), expected)
        XCTAssertEqual(keys.successfulCreateCount, 1)

        try restarted.deleteIdentity()
        XCTAssertEqual(try leases.onlyEnvelope().state, .terminated)
        XCTAssertEqual(try leases.onlyEnvelope().resourceVersion.count, 32)
        XCTAssertNil(try leases.onlyEnvelope().payload)

        let restartedAfterDelete = DeviceIdentityStore(
            scope: scope,
            keys: keys,
            leaseItems: leases
        )
        XCTAssertFalse(try restartedAfterDelete.hasIdentity())
        XCTAssertThrowsError(try restartedAfterDelete.ensureIdentity()) { error in
            XCTAssertEqual(error as? DeviceIdentityStoreError, .keyUnavailable)
        }
        XCTAssertEqual(keys.successfulCreateCount, 1)
    }

    func testLockedLeaseReadAndTerminationFailClosedWithoutCreatingOrAdding() throws {
        let keys = FakeIdentityKeys()
        let leases = MemoryResourceLeaseKeychain()
        let scope = try scope()
        let store = DeviceIdentityStore(scope: scope, keys: keys, leaseItems: leases)
        let locked = KeychainStorageError.status(-25308)
        leases.failNextRead(with: locked)

        XCTAssertThrowsError(try store.ensureIdentity()) { error in
            XCTAssertEqual(error as? KeychainStorageError, locked)
        }
        XCTAssertTrue(keys.createAttempts.isEmpty)
        XCTAssertEqual(leases.insertCount, 0)

        _ = try store.ensureIdentity()
        leases.failNextReplace(with: locked)
        XCTAssertThrowsError(try store.deleteIdentity()) { error in
            XCTAssertEqual(error as? KeychainStorageError, locked)
        }
        XCTAssertTrue(try store.hasIdentity())
        XCTAssertEqual(try leases.onlyEnvelope().state, .active)
        XCTAssertEqual(leases.insertCount, 1, "a failed exact update must not fall back to add")
    }

    func testLockedPermanentKeyCreateDoesNotFallBackToSoftware() throws {
        let keys = FakeIdentityKeys()
        let leases = MemoryResourceLeaseKeychain()
        let locked = KeychainStorageError.status(-25308)
        keys.secureEnclaveFailure = locked
        let store = DeviceIdentityStore(
            scope: try scope(),
            keys: keys,
            leaseItems: leases
        )

        XCTAssertThrowsError(try store.ensureIdentity()) { error in
            XCTAssertEqual(error as? KeychainStorageError, locked)
        }

        XCTAssertEqual(keys.createAttempts, [.secureEnclave])
        XCTAssertEqual(keys.successfulCreateCount, 0)
        XCTAssertEqual(try leases.onlyEnvelope().state, .active)

        keys.secureEnclaveFailure = nil
        XCTAssertEqual(try store.ensureIdentity().protection, .secureEnclave)
        XCTAssertEqual(keys.successfulCreateCount, 1)
    }

    func testTerminatedLeaseSurvivesLockedPrivateKeyErasureAndRetry() throws {
        let keys = FakeIdentityKeys()
        let leases = MemoryResourceLeaseKeychain()
        let store = DeviceIdentityStore(
            scope: try scope(),
            keys: keys,
            leaseItems: leases
        )
        let locked = KeychainStorageError.status(-25308)
        _ = try store.ensureIdentity()
        keys.failNextDelete(with: locked)

        XCTAssertThrowsError(try store.deleteIdentity()) { error in
            XCTAssertEqual(error as? KeychainStorageError, locked)
        }
        XCTAssertEqual(try leases.onlyEnvelope().state, .terminated)
        XCTAssertNotNil(keys.current)
        XCTAssertFalse(try store.hasIdentity())

        try store.deleteIdentity()
        XCTAssertNil(keys.current)
        XCTAssertEqual(try leases.onlyEnvelope().state, .terminated)
    }

    func testDeleteRetriesComparisonMissWithoutDeleteMissAddABA() throws {
        let keys = FakeIdentityKeys()
        let leases = MemoryResourceLeaseKeychain()
        let store = DeviceIdentityStore(
            scope: try scope(),
            keys: keys,
            leaseItems: leases
        )
        _ = try store.ensureIdentity()
        leases.failNextReplaceAsComparisonMiss()

        try store.deleteIdentity()

        XCTAssertEqual(leases.insertCount, 1)
        XCTAssertEqual(leases.replaceCount, 1)
        XCTAssertEqual(try leases.onlyEnvelope().state, .terminated)
        XCTAssertNil(keys.current)
    }

    private func scope() throws -> DeviceIdentityScope {
        try DeviceIdentityScope(
            serverID: "server-1",
            accountID: "account-1",
            deviceID: "device-1",
            generation: "generation-1"
        )
    }
}

private final class FakeSigningKey: DeviceSigningKey {
    var signedMessage: Data?

    func publicKeyX963Representation() throws -> Data {
        Data([0x04] + [UInt8](repeating: 0x01, count: 32) + [UInt8](repeating: 0x02, count: 32))
    }

    func signature(for message: Data) throws -> Data {
        signedMessage = message
        return Data([0x30, 0x00])
    }
}

private final class FakeIdentityKeys: DeviceIdentityKeyManaging {
    private static let legacyFixtureTag = Data()
    private var values: [Data: ManagedDeviceSigningKey] = [:]
    private var lastTag: Data?

    var current: ManagedDeviceSigningKey? {
        get {
            if let lastTag, let value = values[lastTag] { return value }
            return values.values.first
        }
        set {
            values.removeAll()
            if let newValue {
                values[Self.legacyFixtureTag] = newValue
                lastTag = Self.legacyFixtureTag
            } else {
                lastTag = nil
            }
        }
    }
    var secureEnclaveFailure: Error?
    var beforeNextCreate: ((DeviceSigningKeyProtection) throws -> Void)?
    var createAttempts: [DeviceSigningKeyProtection] = []
    var successfulCreateCount = 0
    var deleteCount = 0
    private var nextDeleteError: Error?

    func failNextDelete(with error: Error) {
        nextDeleteError = error
    }

    func existing(tag: Data) throws -> ManagedDeviceSigningKey? {
        values[tag] ?? values[Self.legacyFixtureTag]
    }

    func create(
        tag: Data,
        protection: DeviceSigningKeyProtection
    ) throws -> ManagedDeviceSigningKey {
        createAttempts.append(protection)
        if protection == .secureEnclave, let secureEnclaveFailure {
            throw secureEnclaveFailure
        }
        let hook = beforeNextCreate
        beforeNextCreate = nil
        try hook?(protection)
        guard values[tag] == nil else {
            // SecKeyCreateRandomKey with an existing permanent application tag
            // cannot replace the winner.
            throw DeviceIdentityStoreError.keyUnavailable
        }
        let created = ManagedDeviceSigningKey(key: FakeSigningKey(), protection: protection)
        values[tag] = created
        lastTag = tag
        successfulCreateCount += 1
        return created
    }

    func delete(tag: Data) throws {
        deleteCount += 1
        if let error = nextDeleteError {
            nextDeleteError = nil
            throw error
        }
        values.removeValue(forKey: tag)
        values.removeValue(forKey: Self.legacyFixtureTag)
        if lastTag == tag || lastTag == Self.legacyFixtureTag {
            lastTag = values.keys.first
        }
    }
}
