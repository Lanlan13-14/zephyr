import XCTest
@testable import ZephyrUI

/// S20 list view model: workspace restore, page-state derivation, row action
/// routing and bulk close.
final class SessionListViewModelTests: XCTestCase {

    func testInitialLoadingUntilRestoreCompletes() {
        let vm = SessionListViewModel(registry: SessionRegistry())
        if case .initialLoading = vm.state {} else {
            return XCTFail("expected initialLoading, got \(vm.state)")
        }
        vm.markRestoreComplete()
        guard case .empty(.noData) = vm.state else {
            return XCTFail("expected empty noData, got \(vm.state)")
        }
    }

    func testRestoreWorkspaceProducesContent() {
        let registry = SessionRegistry()
        let vm = SessionListViewModel(registry: registry)
        vm.restoreWorkspace(
            [SessionTestSupport.row(sessionId: "w-1", connectionId: "c-1", transport: .connected)]
        )
        guard case let .content(value, _, _, _) = vm.state else {
            return XCTFail("expected content, got \(vm.state)")
        }
        XCTAssertEqual(value.total, 1)
        XCTAssertFalse(value.online)
    }

    func testConnectivityFlowsIntoContent() {
        let registry = SessionRegistry()
        registry.upsert(SessionTestSupport.row(sessionId: "s-1", transport: .connected))
        let vm = SessionListViewModel(registry: registry)
        vm.markRestoreComplete()
        vm.updateConnectivity(online: true)
        guard case let .content(value, _, _, _) = vm.state else {
            return XCTFail("expected content, got \(vm.state)")
        }
        XCTAssertTrue(value.online)
    }

    func testRestoreEmitsOpenTerminalAndMarksRead() {
        let registry = SessionRegistry()
        registry.upsert(SessionTestSupport.row(sessionId: "s-1", transport: .disconnected, unreadOutput: true))
        let vm = SessionListViewModel(registry: registry)
        vm.markRestoreComplete()
        vm.onAction(registry.row("s-1")!, action: .restore)
        XCTAssertEqual(
            vm.event,
            .openTerminal(sessionId: "s-1", connectionId: "c-1")
        )
        XCTAssertFalse(registry.row("s-1")!.unreadOutput)
    }

    func testRestoreEmitsOpenRemoteForRdp() {
        let registry = SessionRegistry()
        registry.upsert(SessionTestSupport.row(sessionId: "s-1", `protocol`: .rdp, transport: .disconnected))
        let vm = SessionListViewModel(registry: registry)
        vm.markRestoreComplete()
        vm.onAction(registry.row("s-1")!, action: .restore)
        XCTAssertEqual(vm.event, .openRemote(sessionId: "s-1", connectionId: "c-1"))
    }

    func testReconnectOfflineIsRejected() {
        let registry = SessionRegistry()
        registry.upsert(SessionTestSupport.row(sessionId: "s-1", transport: .disconnected))
        let vm = SessionListViewModel(registry: registry)
        vm.markRestoreComplete()
        vm.updateConnectivity(online: false)
        vm.onAction(registry.row("s-1")!, action: .reconnect)
        XCTAssertNil(vm.event)
        XCTAssertEqual(vm.message, SessionListViewModel.msgOfflineReconnect)
    }

    func testReconnectOnlineEmitsEvent() {
        let registry = SessionRegistry()
        registry.upsert(SessionTestSupport.row(sessionId: "s-1", transport: .disconnected))
        let vm = SessionListViewModel(registry: registry)
        vm.markRestoreComplete()
        vm.updateConnectivity(online: true)
        vm.onAction(registry.row("s-1")!, action: .reconnect)
        XCTAssertEqual(vm.event, .reconnect(sessionId: "s-1", connectionId: "c-1", protocol: .ssh))
    }

    func testCloseMovesRowToHistoryAndCallsTeardown() {
        let registry = SessionRegistry()
        registry.upsert(SessionTestSupport.row(sessionId: "s-1", transport: .connected))
        var tornDown: [String] = []
        let vm = SessionListViewModel(
            registry: registry,
            closeTransport: { tornDown.append($0.sessionId) }
        )
        vm.markRestoreComplete()
        vm.close(registry.row("s-1")!)
        XCTAssertEqual(registry.row("s-1")?.transport, .closed)
        XCTAssertEqual(tornDown, ["s-1"])
    }

    func testBulkCloseConfirmationClosesSelection() {
        let registry = SessionRegistry()
        registry.upsert(SessionTestSupport.row(sessionId: "a", transport: .connected))
        registry.upsert(SessionTestSupport.row(sessionId: "b", transport: .connected))
        var tornDown: [String] = []
        let vm = SessionListViewModel(
            registry: registry,
            closeTransport: { tornDown.append($0.sessionId) }
        )
        vm.markRestoreComplete()
        vm.toggleSelection("a")
        vm.closeAll(sessionIds: ["a"])
        XCTAssertEqual(registry.row("a")?.transport, .closed)
        XCTAssertEqual(registry.row("b")?.transport, .connected)
        XCTAssertEqual(Set(tornDown), ["a"])
        XCTAssertTrue(vm.selection.isEmpty)
    }

    func testRevokedRowRestoreIsBlockedWithMessage() {
        let registry = SessionRegistry()
        registry.upsert(SessionTestSupport.row(sessionId: "s-1", transport: .connected, revoked: true))
        let vm = SessionListViewModel(registry: registry)
        vm.markRestoreComplete()
        vm.onAction(registry.row("s-1")!, action: .restore)
        XCTAssertNil(vm.event)
        XCTAssertEqual(vm.message, SessionActions.reasonRevoked)
    }
}