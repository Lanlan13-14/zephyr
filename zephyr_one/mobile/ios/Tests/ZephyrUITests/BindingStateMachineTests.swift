import XCTest
import ZephyrContracts
@testable import ZephyrUI

/// The binding state machine against the same frozen transition table the
/// Kotlin and Node suites are checked against.
final class BindingStateMachineTests: XCTestCase {

    func testMatchesGeneratedTransitions() throws {
        let fixture = try UiFixtures.json("sync-cases.json")
        let cases = try XCTUnwrap(fixture["transitions"] as? [[String: Any]])
        XCTAssertFalse(cases.isEmpty)
        for entry in cases {
            let fromRaw = try XCTUnwrap(entry["from"] as? String)
            let eventRaw = try XCTUnwrap(entry["event"] as? String)
            let expectedRaw = try XCTUnwrap(entry["expected"] as? String)
            let from = try XCTUnwrap(BindingState(rawValue: fromRaw), "unknown state \(fromRaw)")
            let event = try XCTUnwrap(SyncEvent.fromWire(eventRaw), "fixture uses unknown event \(eventRaw)")
            let expected = try XCTUnwrap(BindingState(rawValue: expectedRaw), "unknown state \(expectedRaw)")
            XCTAssertEqual(
                expected,
                BindingStateMachine.next(from, event),
                "\(fromRaw) + \(eventRaw)"
            )
        }
    }

    func testSidExpiryLeavesTheDataPlaneAlone() {
        for state in BindingState.allCases {
            XCTAssertEqual(state, BindingStateMachine.next(state, .sidExpired))
        }
    }

    func testCursorExpiryForcesBootstrapAndBlocksPush() {
        let next = BindingStateMachine.next(.idle, .cursorExpired)
        XCTAssertEqual(.boundNeedsBootstrap, next)
        // Push may only run after the snapshot, so the phase list must start
        // with bootstrap.
        let phases = BindingStateMachine.phasesFor(next)
        XCTAssertEqual(.bootstrapPage, phases[1])
        let bootstrapIndex = phases.firstIndex(of: .bootstrapPage)
        let pushIndex = phases.firstIndex(of: .pushPending)
        XCTAssertNotNil(bootstrapIndex)
        XCTAssertNotNil(pushIndex)
        if let bootstrapIndex, let pushIndex {
            XCTAssertLessThan(bootstrapIndex, pushIndex)
        }
    }

    func testManualSyncStaysAvailableWhileBound() {
        // Removing 立即同步 is a release blocker, so it must survive conflict
        // and re-auth states.
        XCTAssertTrue(BindingStateMachine.canRunManualSync(.conflicted))
        XCTAssertTrue(BindingStateMachine.canRunManualSync(.reauthRequired))
        XCTAssertFalse(BindingStateMachine.canRunManualSync(.unbound))
        XCTAssertFalse(BindingStateMachine.canRunManualSync(.revoked))
        XCTAssertFalse(BindingStateMachine.canRunManualSync(.fatalIncompatible))
    }

    func testAutomaticSyncStopsWhenReauthIsNeeded() {
        XCTAssertFalse(BindingStateMachine.canRunAutomaticSync(.reauthRequired, automaticEnabled: true))
        XCTAssertFalse(BindingStateMachine.canRunAutomaticSync(.idle, automaticEnabled: false))
        XCTAssertTrue(BindingStateMachine.canRunAutomaticSync(.idle, automaticEnabled: true))
    }

    func testFirstBindRunsBootstrapBeforeNormalRounds() {
        XCTAssertEqual(SyncContract.firstBindPhases, BindingStateMachine.phasesFor(.boundNeedsBootstrap))
        XCTAssertEqual(SyncContract.firstBindPhases, BindingStateMachine.phasesFor(.bootstrapping))
        XCTAssertEqual(SyncContract.normalPhases, BindingStateMachine.phasesFor(.idle))
    }

    func testBackoffIsClampedAndJittered() {
        XCTAssertEqual(1_000, BindingStateMachine.backoffMs(0))
        XCTAssertEqual(900_000, BindingStateMachine.backoffMs(99))
        XCTAssertEqual(500, BindingStateMachine.backoffMs(0, jitter: 0.1))
        XCTAssertEqual(1_500, BindingStateMachine.backoffMs(0, jitter: 9.0))
    }

    func testUnknownEventsLeaveTheStateAlone() {
        XCTAssertEqual(.unbound, BindingStateMachine.next(.unbound, .trigger))
        XCTAssertEqual(.idle, BindingStateMachine.next(.idle, .success))
        // Overrides never fire from UNBOUND.
        XCTAssertEqual(.unbound, BindingStateMachine.next(.unbound, .deviceRevoked))
    }
}
