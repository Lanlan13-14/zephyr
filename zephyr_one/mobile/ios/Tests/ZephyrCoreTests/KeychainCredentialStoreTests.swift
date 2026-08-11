import Foundation
import XCTest
@testable import ZephyrCore

final class KeychainCredentialStoreTests: XCTestCase {
    func testInitialStoreAndRefreshRotationUseExactThisDeviceOnlyLease() throws {
        let items = MemoryCredentialKeychain()
        let store = try makeStore(items: items)
        let lease = try makeLease(version: 1)
        try store.activateLease(lease)
        try store.storeInitial(
            KeychainCredentials(
                accessCredential: "access-1",
                accessExpiresAtMilliseconds: 100_000,
                refreshCredential: "refresh-1",
                sid: "sid-1"
            ),
            for: lease
        )

        XCTAssertEqual(items.insertAccessibilities, [.whenUnlockedThisDeviceOnly])
        XCTAssertEqual(items.replaceAccessibilities, [.whenUnlockedThisDeviceOnly])

        try store.rotate(
            accessCredential: "access-2",
            accessExpiresAtMilliseconds: 200_000,
            refreshCredential: "refresh-2",
            for: lease
        )

        XCTAssertEqual(items.insertCount, 1, "rotation must never use add")
        XCTAssertEqual(
            try store.credentials(for: lease),
            KeychainCredentials(
                accessCredential: "access-2",
                accessExpiresAtMilliseconds: 200_000,
                refreshCredential: "refresh-2",
                sid: "sid-1"
            )
        )
    }

    func testCompleteIdentityAndGenerationNamespacesCannotReadEachOther() throws {
        let items = MemoryCredentialKeychain()
        let first = try makeStore(items: items, account: "account-a", device: "device-a", generation: "one")
        let second = try makeStore(items: items, account: "account-a", device: "device-a", generation: "two")
        let otherDevice = try makeStore(items: items, account: "account-a", device: "device-b", generation: "one")
        let otherAccount = try makeStore(items: items, account: "account-b", device: "device-a", generation: "one")
        let firstLease = try makeLease(account: "account-a", device: "device-a", generation: "one", version: 1)

        try first.activateLease(firstLease)
        try first.storeInitial(credentials(), for: firstLease)

        XCTAssertNotNil(try first.credentials(for: firstLease))
        XCTAssertNil(try second.activeLease())
        XCTAssertNil(try otherDevice.activeLease())
        XCTAssertNil(try otherAccount.activeLease())
    }

    func testRotateVersusDeleteCannotRecreateRefreshCredential() throws {
        let items = MemoryCredentialKeychain()
        let store = try makeStore(items: items)
        let lease = try makeLease(version: 1)
        try store.activateLease(lease)
        try store.storeInitial(credentials(), for: lease)

        // Interleave termination after rotate reads its exact token and before
        // that token is presented to the backend CAS. This is the delete/
        // rotate ABA window without scheduler-dependent test timing.
        items.runBeforeNextReplace {
            try store.terminateLease(lease)
        }
        assertStoreError(.leaseTerminated) {
            try store.rotate(
                accessCredential: "stale-access",
                accessExpiresAtMilliseconds: nil,
                refreshCredential: "stale-refresh",
                for: lease
            )
        }
        XCTAssertEqual(items.insertCount, 1, "a stale rotate must not add after its CAS misses")
        XCTAssertNil(try store.activeLease())
        XCTAssertFalse(items.rawDataContains("stale-refresh"))
        XCTAssertFalse(items.rawDataContains("refresh"))

        let restarted = try makeStore(items: items)
        XCTAssertNil(try restarted.activeLease())
        assertStoreError(.leaseTerminated) {
            try restarted.activateLease(lease)
        }
    }

    func testUpdateMissRetriesCASWithoutUsingUpdateMissAdd() throws {
        let items = MemoryCredentialKeychain()
        let store = try makeStore(items: items)
        let lease = try makeLease(version: 1)
        try store.activateLease(lease)
        try store.storeInitial(credentials(), for: lease)
        items.failNextReplace()

        try store.rotate(
            accessCredential: "access-after-miss",
            accessExpiresAtMilliseconds: nil,
            refreshCredential: "refresh-after-miss",
            for: lease
        )

        XCTAssertEqual(items.insertCount, 1)
        XCTAssertEqual(try store.credentials(for: lease)?.refreshCredential, "refresh-after-miss")
    }

    func testLockedRotateFailsClosedWithoutAnUpdateMissAddFallback() throws {
        let items = MemoryCredentialKeychain()
        let store = try makeStore(items: items)
        let lease = try makeLease(version: 1)
        try store.activateLease(lease)
        try store.storeInitial(credentials(), for: lease)

        items.failNextReplaceWithIOError(KeychainStorageError.status(-25308))
        XCTAssertThrowsError(
            try store.rotate(
                accessCredential: "rotated-access",
                accessExpiresAtMilliseconds: 200_000,
                refreshCredential: "rotated-refresh",
                for: lease
            )
        ) { error in
            XCTAssertEqual(error as? KeychainStorageError, .status(-25308))
        }

        XCTAssertEqual(items.insertCount, 1, "a locked Keychain must not trigger an add fallback")
        XCTAssertEqual(try store.activeLease(), lease)
        XCTAssertEqual(try store.credentials(for: lease), credentials())
    }

    func testSameIdentityGenerationADeleteCannotAffectGenerationB() throws {
        let items = MemoryCredentialKeychain()
        let storeA = try makeStore(items: items, generation: "generation-a")
        let storeB = try makeStore(items: items, generation: "generation-b")
        let leaseA = try makeLease(generation: "generation-a", version: 1)
        let leaseB = try makeLease(generation: "generation-b", version: 2)
        try storeA.activateLease(leaseA)
        try storeB.activateLease(leaseB)
        try storeA.storeInitial(credentials(access: "access-a", refresh: "refresh-a"), for: leaseA)
        try storeB.storeInitial(credentials(access: "access-b", refresh: "refresh-b"), for: leaseB)

        try storeA.terminateLease(leaseA)
        try storeA.terminateLease(leaseA)

        XCTAssertNil(try storeA.activeLease())
        XCTAssertEqual(try storeB.credentials(for: leaseB)?.refreshCredential, "refresh-b")
    }

    func testStaleRecordVersionCannotWriteRotateOrDeleteWinner() throws {
        let items = MemoryCredentialKeychain()
        let store = try makeStore(items: items)
        let stale = try makeLease(version: 1)
        let winner = try makeLease(version: 2)
        try store.activateLease(stale)
        try store.storeInitial(credentials(), for: stale)
        try store.replaceLease(winner, expected: stale)
        try store.replaceLease(winner, expected: stale)

        assertStoreError(.staleLease) {
            try store.storeInitial(self.credentials(access: "bad", refresh: "bad"), for: stale)
        }
        assertStoreError(.staleLease) {
            try store.rotate(
                accessCredential: "bad",
                accessExpiresAtMilliseconds: nil,
                refreshCredential: "bad",
                for: stale
            )
        }
        assertStoreError(.staleLease) { try store.terminateLease(stale) }

        XCTAssertEqual(try store.activeLease(), winner)
        XCTAssertEqual(try store.credentials(for: winner)?.refreshCredential, "refresh")
    }

    func testCleanupReconcileClaimsMissingItemThenTerminatesIdempotently() throws {
        let items = MemoryCredentialKeychain()
        let store = try makeStore(items: items)
        let source = try makeLease(version: 1)
        let cleanup = try makeLease(version: 2)

        try store.reconcileLease(cleanup, replacing: source)
        XCTAssertEqual(try store.activeLease(), cleanup)
        try store.terminateLease(cleanup)
        try store.reconcileLease(cleanup, replacing: source)
        try store.terminateLease(cleanup)

        XCTAssertNil(try store.activeLease())
        XCTAssertEqual(items.insertCount, 1)
    }

    func testCleanupReconcilesExactSourceLeaseBeforeTerminatingSecrets() throws {
        let items = MemoryCredentialKeychain()
        let store = try makeStore(items: items)
        let source = try makeLease(version: 1)
        let cleanup = try makeLease(version: 2)
        try store.activateLease(source)
        try store.storeInitial(credentials(), for: source)

        try store.reconcileLease(cleanup, replacing: source)
        assertStoreError(.staleLease) { try store.terminateLease(source) }
        XCTAssertEqual(try store.activeLease(), cleanup)
        XCTAssertEqual(try store.credentials(for: cleanup)?.refreshCredential, "refresh")

        try store.terminateLease(cleanup)
        let restarted = try makeStore(items: items)
        XCTAssertNil(try restarted.activeLease())
        XCTAssertFalse(items.rawDataContains("access"))
        XCTAssertFalse(items.rawDataContains("refresh"))
    }

    func testLockedTerminationFailsClosedUntilTheExactLeaseCanBeTombstoned() throws {
        let items = MemoryCredentialKeychain()
        let store = try makeStore(items: items)
        let lease = try makeLease(version: 1)
        try store.activateLease(lease)
        try store.storeInitial(credentials(), for: lease)

        items.failNextReplaceWithIOError(KeychainStorageError.status(-25308))
        XCTAssertThrowsError(try store.terminateLease(lease)) { error in
            XCTAssertEqual(error as? KeychainStorageError, .status(-25308))
        }
        XCTAssertEqual(try store.activeLease(), lease)
        XCTAssertEqual(try store.credentials(for: lease), credentials())
        XCTAssertEqual(items.insertCount, 1)

        try store.terminateLease(lease)
        XCTAssertNil(try store.activeLease())
        XCTAssertFalse(items.rawDataContains("access"))
        XCTAssertFalse(items.rawDataContains("refresh"))
    }

    func testReconcileRejectsUnexpectedSameGenerationWinner() throws {
        let items = MemoryCredentialKeychain()
        let store = try makeStore(items: items)
        let stale = try makeLease(version: 1)
        let winner = try makeLease(version: 2)
        let cleanup = try makeLease(version: 3)
        try store.activateLease(winner)
        try store.storeInitial(credentials(), for: winner)

        assertStoreError(.staleLease) {
            try store.reconcileLease(cleanup, replacing: stale)
        }

        XCTAssertEqual(try store.activeLease(), winner)
        XCTAssertNotNil(try store.credentials(for: winner))
    }

    func testRestartedStaleCleanupCannotRebuildOrDeleteWinnerLease() throws {
        let items = MemoryCredentialKeychain()
        let original = try makeStore(items: items)
        let stale = try makeLease(version: 1)
        let winner = try makeLease(version: 2)
        let staleCleanup = try makeLease(version: 3)
        try original.activateLease(stale)
        try original.storeInitial(credentials(), for: stale)
        try original.replaceLease(winner, expected: stale)

        let restarted = try makeStore(items: items)
        assertStoreError(.staleLease) {
            try restarted.reconcileLease(staleCleanup, replacing: stale)
        }
        assertStoreError(.staleLease) {
            try restarted.terminateLease(stale)
        }
        assertStoreError(.staleLease) {
            try restarted.rotate(
                accessCredential: "stale-access",
                accessExpiresAtMilliseconds: nil,
                refreshCredential: "stale-refresh",
                for: stale
            )
        }

        XCTAssertEqual(items.insertCount, 1)
        XCTAssertEqual(try restarted.activeLease(), winner)
        XCTAssertEqual(try restarted.credentials(for: winner)?.refreshCredential, "refresh")
        XCTAssertFalse(items.rawDataContains("stale-refresh"))
    }

    func testCleanupRestartReconcilesUnknownPredecessorAfterMarkerRevalidation() throws {
        let items = MemoryCredentialKeychain()
        let beforeCrash = try makeStore(items: items)
        let predecessor = try makeLease(version: 1)
        let cleanup = try makeLease(version: 9)
        try beforeCrash.activateLease(predecessor)
        try beforeCrash.storeInitial(credentials(), for: predecessor)

        // A restarted coordinator has reloaded exact cleanup marker version 9,
        // but the predecessor version was only in the crashed process memory.
        let restarted = try makeStore(items: items)
        try restarted.reconcileLease(cleanup, replacing: nil)
        try restarted.terminateLease(cleanup)

        XCTAssertNil(try restarted.activeLease())
        assertStoreError(.leaseTerminated) {
            try restarted.activateLease(predecessor)
        }
        XCTAssertFalse(items.rawDataContains("refresh"))
    }

    func testCrashRestartRecoversActiveLeaseAndTombstonePreventsReactivation() throws {
        let items = MemoryCredentialKeychain()
        let original = try makeStore(items: items)
        let lease = try makeLease(version: 1)
        try original.activateLease(lease)
        try original.storeInitial(credentials(), for: lease)

        let restarted = try makeStore(items: items)
        XCTAssertEqual(try restarted.activeLease(), lease)
        XCTAssertEqual(try restarted.credentials(for: lease)?.refreshCredential, "refresh")
        try restarted.terminateLease(lease)

        let restartedAfterCleanup = try makeStore(items: items)
        XCTAssertNil(try restartedAfterCleanup.activeLease())
        assertStoreError(.leaseTerminated) {
            try restartedAfterCleanup.activateLease(lease)
        }
        assertStoreError(.leaseTerminated) {
            try restartedAfterCleanup.activateLease(self.makeLease(version: 2))
        }
        XCTAssertFalse(items.rawDataContains("access"))
        XCTAssertFalse(items.rawDataContains("refresh"))
    }

    func testSIDLifecycleAndRefreshSkewRemainLeaseBound() throws {
        let items = MemoryCredentialKeychain()
        let store = try makeStore(items: items)
        let lease = try makeLease(version: 1)
        try store.activateLease(lease)
        XCTAssertTrue(try store.accessNeedsRefresh(nowMilliseconds: 0, for: lease))
        try store.storeInitial(
            KeychainCredentials(
                accessCredential: "access",
                accessExpiresAtMilliseconds: 100_000,
                refreshCredential: "refresh"
            ),
            for: lease
        )
        XCTAssertFalse(try store.accessNeedsRefresh(nowMilliseconds: 39_999, for: lease))
        XCTAssertTrue(try store.accessNeedsRefresh(nowMilliseconds: 40_000, for: lease))

        try store.storeSID("management-sid", for: lease)
        XCTAssertEqual(try store.sid(for: lease), "management-sid")
        try store.clearSID(for: lease)
        XCTAssertNil(try store.sid(for: lease))
        XCTAssertEqual(try store.credentials(for: lease)?.refreshCredential, "refresh")
    }

    func testMissingRefreshFailsClosedWithoutChangingLease() throws {
        let items = MemoryCredentialKeychain()
        let store = try makeStore(items: items)
        let lease = try makeLease(version: 1)
        try store.activateLease(lease)
        try store.storeSID("sid", for: lease)

        assertStoreError(.missingRefreshCredential) {
            try store.rotate(
                accessCredential: "new-access",
                accessExpiresAtMilliseconds: nil,
                refreshCredential: "new-refresh",
                for: lease
            )
        }
        XCTAssertEqual(try store.activeLease(), lease)
    }

    private func makeStore(
        items: MemoryCredentialKeychain,
        account: String = "account",
        device: String = "device",
        generation: String = "generation"
    ) throws -> KeychainCredentialStore {
        try KeychainCredentialStore(
            scope: KeychainCredentialScope(
                serverID: "server",
                accountID: account,
                deviceID: device,
                generation: generation
            ),
            servicePrefix: "test.credentials",
            items: items
        )
    }

    private func makeLease(
        account: String = "account",
        device: String = "device",
        generation: String = "generation",
        version: UInt8
    ) throws -> GenerationSideEffectLease {
        try GenerationSideEffectLease(
            identity: SyncBindingIdentity(
                serverID: "server",
                accountID: account,
                deviceID: device,
                generation: generation
            ),
            recordVersion: Data(repeating: version, count: MobileBindingRecordVersion.byteCount)
        )
    }

    private func credentials(
        access: String = "access",
        refresh: String = "refresh"
    ) -> KeychainCredentials {
        KeychainCredentials(
            accessCredential: access,
            accessExpiresAtMilliseconds: nil,
            refreshCredential: refresh
        )
    }

    private func assertStoreError(
        _ expected: KeychainCredentialStoreError,
        file: StaticString = #filePath,
        line: UInt = #line,
        _ operation: () throws -> Void
    ) {
        XCTAssertThrowsError(try operation(), file: file, line: line) { error in
            XCTAssertEqual(error as? KeychainCredentialStoreError, expected, file: file, line: line)
        }
    }
}

private final class MemoryCredentialKeychain: CredentialKeychainAccessing, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: CredentialKeychainItem] = [:]
    private var nextReplaceHook: (() throws -> Void)?
    private var shouldFailNextReplace = false
    private var nextReplaceIOError: Error?
    private var inserts: [KeychainItemAccessibility] = []
    private var replacements: [KeychainItemAccessibility] = []

    var insertCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return inserts.count
    }

    var insertAccessibilities: [KeychainItemAccessibility] {
        lock.lock()
        defer { lock.unlock() }
        return inserts
    }

    var replaceAccessibilities: [KeychainItemAccessibility] {
        lock.lock()
        defer { lock.unlock() }
        return replacements
    }

    func runBeforeNextReplace(_ hook: @escaping () throws -> Void) {
        lock.lock()
        nextReplaceHook = hook
        lock.unlock()
    }

    func failNextReplace() {
        lock.lock()
        shouldFailNextReplace = true
        lock.unlock()
    }

    func failNextReplaceWithIOError(_ error: Error) {
        lock.lock()
        nextReplaceIOError = error
        lock.unlock()
    }

    func rawDataContains(_ value: String) -> Bool {
        let needle = Data(("\"" + value + "\"").utf8)
        lock.lock()
        defer { lock.unlock() }
        return values.values.contains { item in
            item.data.range(of: needle) != nil
        }
    }

    func read(service: String, account: String) throws -> CredentialKeychainItem? {
        lock.lock()
        defer { lock.unlock() }
        return values[key(service, account)]
    }

    func insertIfAbsent(
        _ item: CredentialKeychainItem,
        service: String,
        account: String,
        accessibility: KeychainItemAccessibility
    ) throws -> Bool {
        lock.lock()
        defer { lock.unlock() }
        let itemKey = key(service, account)
        guard values[itemKey] == nil else { return false }
        values[itemKey] = item
        inserts.append(accessibility)
        return true
    }

    func replace(
        _ item: CredentialKeychainItem,
        matchingComparisonToken expectedComparisonToken: Data,
        service: String,
        account: String,
        accessibility: KeychainItemAccessibility
    ) throws -> Bool {
        let hook: (() throws -> Void)?
        lock.lock()
        hook = nextReplaceHook
        nextReplaceHook = nil
        lock.unlock()
        try hook?()

        lock.lock()
        defer { lock.unlock() }
        if let error = nextReplaceIOError {
            nextReplaceIOError = nil
            throw error
        }
        if shouldFailNextReplace {
            shouldFailNextReplace = false
            return false
        }
        let itemKey = key(service, account)
        guard values[itemKey]?.comparisonToken == expectedComparisonToken else { return false }
        values[itemKey] = item
        replacements.append(accessibility)
        return true
    }

    private func key(_ service: String, _ account: String) -> String {
        service + "\0" + account
    }
}
