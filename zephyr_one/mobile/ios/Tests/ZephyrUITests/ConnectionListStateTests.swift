import XCTest
@testable import ZephyrUI

/// The S10 page-state derivation: the branch order IS the specification
/// (SCREEN_CATALOG.md 2), so each branch gets its own test.
final class ConnectionListStateTests: XCTestCase {

    func testNotLoadedIsInitialLoading() {
        let state = ConnectionListStates.derive(
            connections: [UiTestData.connection()],
            filter: ConnectionFilter(),
            loaded: false
        )
        guard case .initialLoading = state else {
            return XCTFail("expected initialLoading, got \(state)")
        }
    }

    func testVisibleRowsAreContent() {
        let state = ConnectionListStates.derive(
            connections: [UiTestData.connection()],
            filter: ConnectionFilter()
        )
        guard case let .content(rows, pendingSync, conflict, _) = state else {
            return XCTFail("expected content, got \(state)")
        }
        XCTAssertEqual(rows.count, 1)
        XCTAssertFalse(pendingSync)
        XCTAssertFalse(conflict)
    }

    func testContentCarriesPendingAndConflictFlags() {
        var pending = UiTestData.connection(id: "c-1")
        pending.syncState = .pendingLocal
        var conflicted = UiTestData.connection(id: "c-2")
        conflicted.syncState = .conflicted
        let state = ConnectionListStates.derive(
            connections: [pending, conflicted],
            filter: ConnectionFilter()
        )
        guard case let .content(_, pendingSync, conflict, _) = state else {
            return XCTFail("expected content, got \(state)")
        }
        XCTAssertTrue(pendingSync)
        XCTAssertTrue(conflict)
    }

    func testOfflineWithVisibleRowsIsOfflineWithCache() {
        let state = ConnectionListStates.derive(
            connections: [UiTestData.connection()],
            filter: ConnectionFilter(),
            online: false,
            lastSyncedAt: 42
        )
        guard case let .offlineWithCache(rows, lastSyncedAt) = state else {
            return XCTFail("expected offlineWithCache, got \(state)")
        }
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(lastSyncedAt, 42)
    }

    func testActiveFilterWithNoMatchIsNoMatchingFilter() {
        let state = ConnectionListStates.derive(
            connections: [UiTestData.connection()],
            filter: ConnectionFilter(query: "no-such-host")
        )
        XCTAssertEqual(state, .empty(.noMatchingFilter))
    }

    func testUnboundEmptyLibraryIsNotYetSynced() {
        let state = ConnectionListStates.derive(
            connections: [],
            filter: ConnectionFilter(),
            bound: false
        )
        XCTAssertEqual(state, .empty(.notYetSynced))
    }

    func testBoundEmptyLibraryIsNoData() {
        let state = ConnectionListStates.derive(
            connections: [],
            filter: ConnectionFilter()
        )
        XCTAssertEqual(state, .empty(.noData))
    }

    func testAllDeletedRowsReadAsEmptyLibrary() {
        let state = ConnectionListStates.derive(
            connections: [UiTestData.connection(deletedAt: 1)],
            filter: ConnectionFilter(query: "anything")
        )
        // No visible row exists at all, so this is no-data, not a filter
        // outcome.
        XCTAssertEqual(state, .empty(.noData))
    }

    func testTerminalFlags() {
        XCTAssertTrue(PageState<[Connection]>.offlineNoCache.isTerminal)
        XCTAssertTrue(PageState<[Connection]>.notFoundOrRevoked.isTerminal)
        XCTAssertTrue(
            PageState<[Connection]>.fatalIncompatible(.offline).isTerminal
        )
        XCTAssertFalse(PageState<[Connection]>.initialLoading.isTerminal)
        XCTAssertFalse(
            PageState<[Connection]>.content([], pendingSync: false, conflict: false, savingLocal: false).isTerminal
        )
    }
}
