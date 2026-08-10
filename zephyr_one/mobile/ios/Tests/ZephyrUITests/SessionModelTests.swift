import XCTest
@testable import ZephyrUI

/// S20 row grouping, gating and grouping semantics (SCREEN_CATALOG.md 7).
final class SessionModelTests: XCTestCase {

    func testGroupAssignment() {
        XCTAssertEqual(
            SessionTestSupport.row(transport: .connecting).group, .connecting
        )
        XCTAssertEqual(
            SessionTestSupport.row(transport: .connected).group, .connected
        )
        XCTAssertEqual(
            SessionTestSupport.row(transport: .disconnected).group, .resumable
        )
        XCTAssertEqual(
            SessionTestSupport.row(transport: .closed).group, .history
        )
    }

    func testMinimisedWinsOverDisconnected() {
        let row = SessionTestSupport.row(
            transport: .disconnected,
            minimised: true
        )
        XCTAssertEqual(row.group, .minimised)
    }

    func testHistoryWinsOverMinimised() {
        let row = SessionTestSupport.row(
            transport: .closed,
            minimised: true
        )
        XCTAssertEqual(row.group, .history)
    }

    func testRestorableExcludesClosedAndRevoked() {
        XCTAssertTrue(SessionTestSupport.row(transport: .connected).restorable)
        XCTAssertTrue(SessionTestSupport.row(transport: .disconnected).restorable)
        XCTAssertFalse(SessionTestSupport.row(transport: .closed).restorable)
        XCTAssertFalse(SessionTestSupport.row(revoked: true).restorable)
    }

    func testRestoreGateOnRevokedIsDisabledWithReason() {
        let revoked = SessionTestSupport.row(revoked: true, revokedReason: "resource_revoked")
        let gate = SessionActions.gate(revoked, action: .restore)
        guard case let .disabled(_, reason) = gate else {
            return XCTFail("expected disabled, got \(gate)")
        }
        XCTAssertEqual(reason, "resource_revoked")
    }

    func testReconnectHiddenWhileConnected() {
        let gate = SessionActions.gate(SessionTestSupport.row(transport: .connected), action: .reconnect)
        guard case .hidden = gate else {
            return XCTFail("expected hidden, got \(gate)")
        }
    }

    func testReconnectNeedsUse() {
        let noUse = SessionTestSupport.row(
            transport: .disconnected,
            capabilities: CapabilitySet([.view])
        )
        let gate = SessionActions.gate(noUse, action: .reconnect)
        guard case let .disabled(_, reason) = gate else {
            return XCTFail("expected disabled, got \(gate)")
        }
        XCTAssertEqual(reason, SessionActions.reasonUseRevoked)
    }

    func testCloseAlwaysAllowedOnLiveRow() {
        XCTAssertTrue(
            SessionActions.gate(SessionTestSupport.row(transport: .connected), action: .close).isAllowed
        )
        XCTAssertTrue(
            SessionActions.gate(SessionTestSupport.row(transport: .connecting), action: .close).isAllowed
        )
        XCTAssertFalse(
            SessionActions.gate(SessionTestSupport.row(transport: .closed), action: .close).isVisible
        )
    }

    func testGroupingOrderAndSorting() {
        let rows = [
            SessionTestSupport.row(sessionId: "h1", transport: .closed, startedAt: 5, endedAt: 20),
            SessionTestSupport.row(sessionId: "h2", transport: .closed, startedAt: 5, endedAt: 30),
            SessionTestSupport.row(sessionId: "live-old", transport: .connected, startedAt: 1),
            SessionTestSupport.row(sessionId: "live-new", transport: .connected, startedAt: 2),
        ]
        let grouped = SessionGrouping.grouped(rows)
        XCTAssertEqual(grouped.map { $0.group }, [.connected, .history])
        // Connected sorts oldest-first.
        XCTAssertEqual(grouped[0].rows.map { $0.sessionId }, ["live-old", "live-new"])
        // History sorts newest-first.
        XCTAssertEqual(grouped[1].rows.map { $0.sessionId }, ["h2", "h1"])
    }

    func testGroupingCounts() {
        let rows = [
            SessionTestSupport.row(sessionId: "a", transport: .connected, unreadOutput: true),
            SessionTestSupport.row(sessionId: "b", transport: .connecting),
            SessionTestSupport.row(sessionId: "c", transport: .disconnected),
            SessionTestSupport.row(sessionId: "d", transport: .closed),
        ]
        XCTAssertEqual(SessionGrouping.liveCount(rows), 2)
        XCTAssertEqual(SessionGrouping.closableRows(rows).count, 3)
        XCTAssertEqual(SessionGrouping.unreadCount(rows), 1)
    }

    func testSharedExecutionDisclosure() {
        let relay = SessionTestSupport.row(residency: .sharedOnlineOnly, execution: .relay)
        XCTAssertEqual(SessionActions.executionDisclosure(relay), SessionActions.disclosureRelay)
        let direct = SessionTestSupport.row(residency: .sharedOnlineOnly, execution: .local)
        XCTAssertEqual(SessionActions.executionDisclosure(direct), SessionActions.disclosureDirect)
        XCTAssertNil(SessionActions.executionDisclosure(SessionTestSupport.row(residency: .owned)))
    }
}