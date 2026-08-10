import XCTest
@testable import ZephyrUI

/// SessionRegistry lifecycle: row identity, close, bulk close, history and
/// the never-auto-connect workspace restore.
final class SessionRegistryTests: XCTestCase {

    func testUpsertKeepsRowIdentityAcrossTransports() {
        let registry = SessionRegistry()
        registry.upsert(SessionTestSupport.row(sessionId: "s-1", transport: .connected))
        registry.setTransport("s-1", .disconnected, 50)
        registry.setTransport("s-1", .connected, 60)
        XCTAssertEqual(registry.rows.count, 1)
        XCTAssertEqual(registry.rows[0].transport, .connected)
    }

    func testCloseMovesToHistoryAndStampsEndedAt() {
        let registry = SessionRegistry()
        registry.upsert(SessionTestSupport.row(sessionId: "s-1", transport: .connected))
        registry.close("s-1", 99)
        guard let row = registry.row("s-1") else {
            return XCTFail("row should remain as history")
        }
        XCTAssertEqual(row.transport, .closed)
        XCTAssertEqual(row.endedAt, 99)
    }

    func testMarkRevokedKeepsRowAndStripsRestorability() {
        let registry = SessionRegistry()
        registry.upsert(SessionTestSupport.row(sessionId: "s-1", transport: .connected))
        registry.markRevoked("s-1", reason: SessionActions.wireResourceRevoked)
        guard let row = registry.row("s-1") else { return XCTFail("row must remain") }
        XCTAssertTrue(row.revoked)
        XCTAssertEqual(row.revokedReason, SessionActions.wireResourceRevoked)
        XCTAssertFalse(row.restorable)
    }

    func testCloseAllOnlyClosesClosableRows() {
        let registry = SessionRegistry()
        registry.upsert(SessionTestSupport.row(sessionId: "live", transport: .connected))
        registry.upsert(SessionTestSupport.row(sessionId: "connecting", transport: .connecting))
        registry.upsert(SessionTestSupport.row(sessionId: "history", transport: .closed))
        let closed = registry.closeAll(10)
        XCTAssertEqual(Set(closed), ["live", "connecting"])
        XCTAssertEqual(registry.row("live")?.transport, .closed)
        XCTAssertEqual(registry.row("connecting")?.transport, .closed)
        XCTAssertEqual(registry.row("history")?.transport, .closed)
    }

    func testCloseAllHonoursSelection() {
        let registry = SessionRegistry()
        registry.upsert(SessionTestSupport.row(sessionId: "a", transport: .connected))
        registry.upsert(SessionTestSupport.row(sessionId: "b", transport: .connected))
        let closed = registry.closeAll(10, sessionIds: ["a"])
        XCTAssertEqual(closed, ["a"])
        XCTAssertEqual(registry.row("a")?.transport, .closed)
        XCTAssertEqual(registry.row("b")?.transport, .connected)
    }

    func testClearHistoryKeepsLiveRows() {
        let registry = SessionRegistry()
        registry.upsert(SessionTestSupport.row(sessionId: "live", transport: .connected))
        registry.upsert(SessionTestSupport.row(sessionId: "dead", transport: .closed))
        registry.clearHistory()
        XCTAssertEqual(registry.rows.map { $0.sessionId }, ["live"])
    }

    func testRestoreNeverConnects() {
        let registry = SessionRegistry()
        registry.restore(
            [
                SessionTestSupport.row(sessionId: "w-1", connectionId: "c-1", transport: .connected)
            ],
            capabilitiesFor: { _ in .owner },
            residencyFor: { _ in .owned }
        )
        guard let row = registry.row("w-1") else { return XCTFail("restored row must exist") }
        XCTAssertEqual(row.transport, .disconnected)
        XCTAssertTrue(row.restoredFromWorkspace)
        XCTAssertFalse(row.minimised)
    }

    func testRestoreRevokesWhenUseLost() {
        let registry = SessionRegistry()
        registry.restore(
            [SessionTestSupport.row(sessionId: "w-1", connectionId: "c-1", transport: .connected)],
            capabilitiesFor: { _ in CapabilitySet([.view]) },
            residencyFor: { _ in .owned }
        )
        guard let row = registry.row("w-1") else { return XCTFail("restored row must exist") }
        XCTAssertTrue(row.revoked)
        XCTAssertFalse(row.restorable)
    }
}