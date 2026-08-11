import Foundation
import XCTest
@testable import ZephyrCore

final class KeychainMobileBindingRecordStoreTests: XCTestCase {
    func testInsertUsesThisDeviceOnlyAccessibilityAndRejectsSecondStore() throws {
        let items = MemoryBindingRecordKeychain()
        let first = makeStore(items)
        let second = makeStore(items)
        let record = makeRecord()

        XCTAssertNotNil(try first.insertIfAbsent(record))
        XCTAssertNil(try second.insertIfAbsent(makeRecord(accountID: "account-b")))
        XCTAssertEqual(try second.load()?.record, record)
        XCTAssertEqual(items.insertAccessibilities, [.whenUnlockedThisDeviceOnly])
    }

    func testTwoStoresRaceToInsertAndOnlyOneWins() throws {
        let items = MemoryBindingRecordKeychain()
        let stores = [makeStore(items), makeStore(items)]
        let records = [
            makeRecord(accountID: "account-a", generation: "generation-a"),
            makeRecord(accountID: "account-b", generation: "generation-b"),
        ]
        let outcomes = ConcurrentOutcomes(count: stores.count)

        DispatchQueue.concurrentPerform(iterations: stores.count) { index in
            do {
                outcomes.set(try stores[index].insertIfAbsent(records[index]) != nil, at: index)
            } catch {
                outcomes.set(error, at: index)
            }
        }

        XCTAssertTrue(outcomes.errors.allSatisfy { $0 == nil })
        XCTAssertEqual(outcomes.values.compactMap { $0 }.filter { $0 }.count, 1)
        let stored = try XCTUnwrap(try stores[0].load())
        XCTAssertTrue(records.contains(stored.record))
    }

    func testTwoStoresRaceToReplaceAndOnlyOneExactVersionWins() throws {
        let items = MemoryBindingRecordKeychain()
        let seedStore = makeStore(items)
        let original = makeRecord()
        let originalSnapshot = try XCTUnwrap(try seedStore.insertIfAbsent(original))

        let stores = [makeStore(items), makeStore(items)]
        let replacements = [
            makeRecord(phase: .active, boundAtMilliseconds: 1_725_000_000_000),
            makeRecord(phase: .cleanupPending),
        ]
        let outcomes = ConcurrentOutcomes(count: stores.count)

        DispatchQueue.concurrentPerform(iterations: stores.count) { index in
            do {
                outcomes.set(
                    try stores[index].replace(replacements[index], expected: originalSnapshot) != nil,
                    at: index
                )
            } catch {
                outcomes.set(error, at: index)
            }
        }

        XCTAssertTrue(outcomes.errors.allSatisfy { $0 == nil })
        XCTAssertEqual(outcomes.values.compactMap { $0 }.filter { $0 }.count, 1)
        let stored = try XCTUnwrap(try seedStore.load())
        XCTAssertTrue(replacements.contains(stored.record))
    }

    func testStaleAccountCannotClearReplacementBinding() throws {
        let items = MemoryBindingRecordKeychain()
        let storeA = makeStore(items)
        let storeB = makeStore(items)
        let recordA = makeRecord(accountID: "account-a", generation: "generation-a")
        let recordB = makeRecord(accountID: "account-b", generation: "generation-b")

        let snapshotA = try XCTUnwrap(try storeA.insertIfAbsent(recordA))
        XCTAssertTrue(try storeA.clear(expected: snapshotA))
        let snapshotB = try XCTUnwrap(try storeB.insertIfAbsent(recordB))
        XCTAssertFalse(try storeA.clear(expected: snapshotA))
        XCTAssertEqual(try storeA.load(), snapshotB)
    }

    func testOldGenerationCannotReplaceOrClearSameAccountNewGeneration() throws {
        let items = MemoryBindingRecordKeychain()
        let staleStore = makeStore(items)
        let currentStore = makeStore(items)
        let oldRecord = makeRecord(generation: "generation-1")
        let newRecord = makeRecord(generation: "generation-2")

        let oldSnapshot = try XCTUnwrap(try staleStore.insertIfAbsent(oldRecord))
        XCTAssertTrue(try currentStore.clear(expected: oldSnapshot))
        let newSnapshot = try XCTUnwrap(try currentStore.insertIfAbsent(newRecord))
        XCTAssertNil(
            try staleStore.replace(
                oldRecord.replacingPhase(.cleanupPending),
                expected: oldSnapshot
            )
        )
        XCTAssertFalse(try staleStore.clear(expected: oldSnapshot))
        XCTAssertEqual(try currentStore.load(), newSnapshot)
    }

    func testSameIdentityStaleActiveCannotOverwriteOrClearCleanupPending() throws {
        let items = MemoryBindingRecordKeychain()
        let activeWriter = makeStore(items)
        let cleanupWriter = makeStore(items)
        let binding = makeRecord()
        let active = makeRecord(phase: .active, boundAtMilliseconds: 1_725_000_000_000)

        let bindingSnapshot = try XCTUnwrap(try activeWriter.insertIfAbsent(binding))
        _ = try XCTUnwrap(try activeWriter.replace(active, expected: bindingSnapshot))
        let staleActive = try XCTUnwrap(try activeWriter.load())
        let cleanupExpected = try XCTUnwrap(try cleanupWriter.load())
        let cleanup = active.replacingPhase(.cleanupPending)
        let cleanupSnapshot = try XCTUnwrap(
            try cleanupWriter.replace(cleanup, expected: cleanupExpected)
        )

        XCTAssertNil(
            try activeWriter.replace(
                active.replacingPhase(.restoring),
                expected: staleActive
            )
        )
        XCTAssertFalse(try activeWriter.clear(expected: staleActive))
        XCTAssertEqual(try activeWriter.load(), cleanupSnapshot)
    }

    func testCleanupPendingCannotTransitionBackToActiveEvenWithCurrentVersion() throws {
        let items = MemoryBindingRecordKeychain()
        let store = makeStore(items)
        let cleanup = makeRecord(phase: .cleanupPending)
        let cleanupSnapshot = try XCTUnwrap(try store.insertIfAbsent(cleanup))
        let active = makeRecord(phase: .active, boundAtMilliseconds: 1_725_000_000_000)

        XCTAssertThrowsError(try store.replace(active, expected: cleanupSnapshot)) { error in
            XCTAssertEqual(error as? MobileBindingRecordStoreError, .invalidPhaseTransition)
        }
        XCTAssertEqual(try store.load(), cleanupSnapshot)
    }

    func testActiveCannotTransitionToActiveEvenWithCurrentVersion() throws {
        let items = MemoryBindingRecordKeychain()
        let store = makeStore(items)
        let binding = try XCTUnwrap(try store.insertIfAbsent(makeRecord()))
        let active = makeRecord(phase: .active, boundAtMilliseconds: 1_725_000_000_000)
        let activeSnapshot = try XCTUnwrap(try store.replace(active, expected: binding))

        XCTAssertThrowsError(try store.replace(active, expected: activeSnapshot)) { error in
            XCTAssertEqual(error as? MobileBindingRecordStoreError, .invalidPhaseTransition)
        }
        XCTAssertEqual(try store.load(), activeSnapshot)
    }

    func testOnlyOneStoreCanAcquireRestoringLeaseFromExactActiveSnapshot() throws {
        let items = MemoryBindingRecordKeychain()
        let first = makeStore(items)
        let second = makeStore(items)
        let binding = try XCTUnwrap(try first.insertIfAbsent(makeRecord()))
        let activeRecord = makeRecord(
            phase: .active,
            boundAtMilliseconds: 1_725_000_000_000
        )
        _ = try XCTUnwrap(try first.replace(activeRecord, expected: binding))
        let firstRead = try XCTUnwrap(try first.load())
        let secondRead = try XCTUnwrap(try second.load())
        let restoring = activeRecord.replacingPhase(.restoring)

        let lease = try XCTUnwrap(try first.replace(restoring, expected: firstRead))
        XCTAssertNil(try second.replace(restoring, expected: secondRead))
        XCTAssertEqual(try second.load(), lease)
        XCTAssertEqual(lease.phase, .restoring)
    }

    func testRestoringCannotAcquireASecondLease() throws {
        let items = MemoryBindingRecordKeychain()
        let store = makeStore(items)
        let binding = try XCTUnwrap(try store.insertIfAbsent(makeRecord()))
        let active = makeRecord(phase: .active, boundAtMilliseconds: 1_725_000_000_000)
        let activeSnapshot = try XCTUnwrap(try store.replace(active, expected: binding))
        let lease = try XCTUnwrap(
            try store.replace(active.replacingPhase(.restoring), expected: activeSnapshot)
        )

        XCTAssertThrowsError(try store.replace(lease.record, expected: lease)) { error in
            XCTAssertEqual(error as? MobileBindingRecordStoreError, .invalidPhaseTransition)
        }
        XCTAssertEqual(try store.load(), lease)
    }

    func testActiveToRestoringLeaseAcquisitionCannotMutateTheRecord() throws {
        let items = MemoryBindingRecordKeychain()
        let store = makeStore(items)
        let binding = try XCTUnwrap(try store.insertIfAbsent(makeRecord()))
        let active = makeRecord(phase: .active, boundAtMilliseconds: 1_725_000_000_000)
        let activeSnapshot = try XCTUnwrap(try store.replace(active, expected: binding))
        let changedRestoring = makeRecord(
            phase: .restoring,
            boundAtMilliseconds: active.boundAtMilliseconds,
            registryHash: "changed-registry-hash"
        )

        XCTAssertThrowsError(try store.replace(changedRestoring, expected: activeSnapshot)) {
            error in
            XCTAssertEqual(error as? MobileBindingRecordStoreError, .invalidPhaseTransition)
        }
        XCTAssertEqual(try store.load(), activeSnapshot)
    }

    func testCurrentRestoringLeaseCanPublishActiveAndStaleLeaseCannotMutateIt() throws {
        let items = MemoryBindingRecordKeychain()
        let store = makeStore(items)
        let binding = try XCTUnwrap(try store.insertIfAbsent(makeRecord()))
        let active = makeRecord(phase: .active, boundAtMilliseconds: 1_725_000_000_000)
        let activeSnapshot = try XCTUnwrap(try store.replace(active, expected: binding))
        let lease = try XCTUnwrap(
            try store.replace(active.replacingPhase(.restoring), expected: activeSnapshot)
        )

        let published = try XCTUnwrap(try store.replace(active, expected: lease))
        XCTAssertNotEqual(published.recordVersion, lease.recordVersion)
        XCTAssertFalse(try store.clear(expected: lease))
        XCTAssertNil(
            try store.replace(
                lease.record.replacingPhase(.cleanupPending),
                expected: lease
            )
        )
        XCTAssertEqual(try store.load(), published)
    }

    func testRestoringLeaseCannotPublishAnotherIdentity() throws {
        let items = MemoryBindingRecordKeychain()
        let store = makeStore(items)
        let binding = try XCTUnwrap(try store.insertIfAbsent(makeRecord()))
        let active = makeRecord(phase: .active, boundAtMilliseconds: 1_725_000_000_000)
        let activeSnapshot = try XCTUnwrap(try store.replace(active, expected: binding))
        let lease = try XCTUnwrap(
            try store.replace(active.replacingPhase(.restoring), expected: activeSnapshot)
        )
        let otherActive = makeRecord(
            phase: .active,
            accountID: "account-b",
            generation: "generation-b",
            boundAtMilliseconds: 1_725_000_000_000
        )

        XCTAssertThrowsError(try store.replace(otherActive, expected: lease)) { error in
            XCTAssertEqual(error as? MobileBindingRecordStoreError, .invalidPhaseTransition)
        }
        XCTAssertEqual(try store.load(), lease)
    }

    func testRestoringCrashStateCanOnlyFailClosedToCleanup() throws {
        let items = MemoryBindingRecordKeychain()
        let firstProcess = makeStore(items)
        let binding = try XCTUnwrap(try firstProcess.insertIfAbsent(makeRecord()))
        let active = makeRecord(phase: .active, boundAtMilliseconds: 1_725_000_000_000)
        let activeSnapshot = try XCTUnwrap(try firstProcess.replace(active, expected: binding))
        _ = try XCTUnwrap(
            try firstProcess.replace(active.replacingPhase(.restoring), expected: activeSnapshot)
        )

        let restartedProcess = makeStore(items)
        let recoveredLease = try XCTUnwrap(try restartedProcess.load())
        let cleanup = recoveredLease.record.replacingPhase(.cleanupPending)
        let cleanupSnapshot = try XCTUnwrap(
            try restartedProcess.replace(cleanup, expected: recoveredLease)
        )

        XCTAssertEqual(cleanupSnapshot.phase, .cleanupPending)
        XCTAssertThrowsError(
            try restartedProcess.replace(active, expected: cleanupSnapshot)
        ) { error in
            XCTAssertEqual(error as? MobileBindingRecordStoreError, .invalidPhaseTransition)
        }
        XCTAssertEqual(try restartedProcess.load(), cleanupSnapshot)
    }

    func testRestoringCannotBeInsertedWithoutAnActiveSnapshot() throws {
        let items = MemoryBindingRecordKeychain()
        let store = makeStore(items)
        let restoring = makeRecord(
            phase: .restoring,
            boundAtMilliseconds: 1_725_000_000_000
        )

        XCTAssertThrowsError(try store.insertIfAbsent(restoring)) { error in
            XCTAssertEqual(error as? MobileBindingRecordStoreError, .invalidPhaseTransition)
        }
        XCTAssertNil(try store.load())
    }

    func testCleanupPendingCannotSwitchIdentityWhileRemainingCleanupPending() throws {
        let items = MemoryBindingRecordKeychain()
        let store = makeStore(items)
        let cleanupSnapshot = try XCTUnwrap(
            try store.insertIfAbsent(makeRecord(phase: .cleanupPending))
        )
        let otherCleanup = makeRecord(
            phase: .cleanupPending,
            accountID: "account-b",
            generation: "generation-b"
        )

        XCTAssertThrowsError(try store.replace(otherCleanup, expected: cleanupSnapshot)) { error in
            XCTAssertEqual(error as? MobileBindingRecordStoreError, .invalidPhaseTransition)
        }
        XCTAssertEqual(try store.load(), cleanupSnapshot)
    }

    func testRecordVersionCannotAuthorizeAChangedExpectedRecord() throws {
        let items = MemoryBindingRecordKeychain()
        let store = makeStore(items)
        let snapshot = try XCTUnwrap(try store.insertIfAbsent(makeRecord()))
        let forgedExpected = MobileBindingRecordSnapshot(
            record: snapshot.record.replacingPhase(.cleanupPending),
            recordVersion: snapshot.recordVersion
        )

        XCTAssertFalse(try store.clear(expected: forgedExpected))
        XCTAssertEqual(try store.load(), snapshot)
    }

    func testReplaceFailsClosedWhenVersionGeneratorRepeats() throws {
        let items = MemoryBindingRecordKeychain()
        let version = MobileBindingRecordVersion(data: Data(repeating: 0x5a, count: 32))
        let store = KeychainMobileBindingRecordStore(
            baseURL: "https://example.test/root/",
            items: items,
            versions: FixedBindingRecordVersionGenerator(version: version)
        )
        let snapshot = try XCTUnwrap(try store.insertIfAbsent(makeRecord()))

        XCTAssertThrowsError(
            try store.replace(makeRecord(phase: .cleanupPending), expected: snapshot)
        ) { error in
            XCTAssertEqual(error as? MobileBindingRecordStoreError, .versionCollision)
        }
        XCTAssertEqual(try store.load(), snapshot)
    }

    func testMatchingIdentityCanReplaceAndClear() throws {
        let items = MemoryBindingRecordKeychain()
        let store = makeStore(items)
        let binding = makeRecord()
        let active = makeRecord(phase: .active, boundAtMilliseconds: 1_725_000_000_000)

        let bindingSnapshot = try XCTUnwrap(try store.insertIfAbsent(binding))
        let activeSnapshot = try XCTUnwrap(try store.replace(active, expected: bindingSnapshot))
        XCTAssertNotEqual(bindingSnapshot.recordVersion, activeSnapshot.recordVersion)
        XCTAssertEqual(activeSnapshot.recordVersion.data.count, MobileBindingRecordVersion.byteCount)
        XCTAssertEqual(try store.load(), activeSnapshot)
        XCTAssertEqual(items.replaceAccessibilities, [.whenUnlockedThisDeviceOnly])
        XCTAssertTrue(try store.clear(expected: activeSnapshot))
        XCTAssertNil(try store.load())
    }

    func testIOFailuresThrowAndLeaveTheCurrentRecordIntact() throws {
        let items = MemoryBindingRecordKeychain()
        let store = makeStore(items)
        let original = makeRecord()
        let replacement = makeRecord(phase: .active, boundAtMilliseconds: 1_725_000_000_000)
        let originalSnapshot = try XCTUnwrap(try store.insertIfAbsent(original))

        items.failNext(.read)
        XCTAssertThrowsError(try store.load()) { error in
            XCTAssertEqual(error as? BindingRecordKeychainTestError, .injected)
        }

        items.failNext(.insert)
        XCTAssertThrowsError(try store.insertIfAbsent(replacement)) { error in
            XCTAssertEqual(error as? BindingRecordKeychainTestError, .injected)
        }

        items.failNext(.replace)
        XCTAssertThrowsError(try store.replace(replacement, expected: originalSnapshot)) {
            error in
            XCTAssertEqual(error as? BindingRecordKeychainTestError, .injected)
        }

        items.failNext(.delete)
        XCTAssertThrowsError(try store.clear(expected: originalSnapshot)) { error in
            XCTAssertEqual(error as? BindingRecordKeychainTestError, .injected)
        }

        XCTAssertEqual(try store.load(), originalSnapshot)
    }

    func testMismatchedPersistedComparisonTokenFailsClosed() throws {
        let items = MemoryBindingRecordKeychain()
        let store = makeStore(items)
        XCTAssertNotNil(try store.insertIfAbsent(makeRecord()))
        items.corruptComparisonToken()

        XCTAssertThrowsError(try store.load()) { error in
            XCTAssertEqual(error as? MobileBindingRecordStoreError, .corruptRecord)
        }
    }

    private func makeStore(
        _ items: MemoryBindingRecordKeychain
    ) -> KeychainMobileBindingRecordStore {
        KeychainMobileBindingRecordStore(baseURL: "https://example.test/root/", items: items)
    }

    private func makeRecord(
        phase: MobileBindingRecordPhase = .binding,
        accountID: String = "account-a",
        generation: String = "generation-a",
        boundAtMilliseconds: Int64 = 0,
        registryHash: String = "registry-hash"
    ) -> MobileBindingRecord {
        MobileBindingRecord(
            phase: phase,
            baseURL: "https://example.test/root/",
            serverID: "server-1",
            accountID: accountID,
            username: "andy",
            deviceID: "device-1",
            deviceName: "Phone",
            tokenID: "token-1",
            tokenName: "Primary",
            registryHash: registryHash,
            generation: generation,
            syncIntervalSeconds: 60,
            boundAtMilliseconds: boundAtMilliseconds
        )
    }
}

private enum BindingRecordKeychainTestError: Error, Equatable {
    case injected
}

private enum BindingRecordKeychainOperation: Hashable {
    case read
    case insert
    case replace
    case delete
}

private struct FixedBindingRecordVersionGenerator: MobileBindingRecordVersionGenerating {
    let version: MobileBindingRecordVersion

    func nextVersion() throws -> MobileBindingRecordVersion { version }
}

private final class MemoryBindingRecordKeychain: BindingRecordKeychainAccessing, @unchecked Sendable {
    private let lock = NSLock()
    private var item: BindingRecordKeychainItem?
    private var failingOperations = Set<BindingRecordKeychainOperation>()
    private var insertProtections: [KeychainItemAccessibility] = []
    private var replaceProtections: [KeychainItemAccessibility] = []

    var insertAccessibilities: [KeychainItemAccessibility] {
        synchronized { insertProtections }
    }

    var replaceAccessibilities: [KeychainItemAccessibility] {
        synchronized { replaceProtections }
    }

    func failNext(_ operation: BindingRecordKeychainOperation) {
        synchronized { _ = failingOperations.insert(operation) }
    }

    func corruptComparisonToken() {
        synchronized {
            guard let item else { return }
            self.item = BindingRecordKeychainItem(
                data: item.data,
                comparisonToken: Data(repeating: 0xff, count: 32)
            )
        }
    }

    func read(service: String, account: String) throws -> BindingRecordKeychainItem? {
        try synchronized {
            try throwIfRequested(.read)
            return item
        }
    }

    func insertIfAbsent(
        _ item: BindingRecordKeychainItem,
        service: String,
        account: String,
        accessibility: KeychainItemAccessibility
    ) throws -> Bool {
        try synchronized {
            try throwIfRequested(.insert)
            guard self.item == nil else { return false }
            self.item = item
            insertProtections.append(accessibility)
            return true
        }
    }

    func replace(
        _ item: BindingRecordKeychainItem,
        matchingComparisonToken expectedComparisonToken: Data,
        service: String,
        account: String,
        accessibility: KeychainItemAccessibility
    ) throws -> Bool {
        try synchronized {
            try throwIfRequested(.replace)
            guard self.item?.comparisonToken == expectedComparisonToken else { return false }
            self.item = item
            replaceProtections.append(accessibility)
            return true
        }
    }

    func delete(
        service: String,
        account: String,
        matchingComparisonToken expectedComparisonToken: Data
    ) throws -> Bool {
        try synchronized {
            try throwIfRequested(.delete)
            guard item?.comparisonToken == expectedComparisonToken else { return false }
            item = nil
            return true
        }
    }

    private func throwIfRequested(_ operation: BindingRecordKeychainOperation) throws {
        if failingOperations.remove(operation) != nil {
            throw BindingRecordKeychainTestError.injected
        }
    }

    private func synchronized<T>(_ operation: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try operation()
    }
}

private final class ConcurrentOutcomes: @unchecked Sendable {
    private let lock = NSLock()
    private var storedValues: [Bool?]
    private var storedErrors: [Error?]

    init(count: Int) {
        storedValues = Array(repeating: nil, count: count)
        storedErrors = Array(repeating: nil, count: count)
    }

    var values: [Bool?] {
        synchronized { storedValues }
    }

    var errors: [Error?] {
        synchronized { storedErrors }
    }

    func set(_ value: Bool, at index: Int) {
        synchronized { storedValues[index] = value }
    }

    func set(_ error: Error, at index: Int) {
        synchronized { storedErrors[index] = error }
    }

    private func synchronized<T>(_ operation: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return operation()
    }
}
