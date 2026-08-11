import XCTest
@testable import ZephyrUI

/// S22/S23 phase policy: the per-phase timeout, the auto-reconnect decision
/// and the phase labels (REMOTE_DESKTOP_EXPERIENCE.md 13).
final class RemoteSessionPhaseTests: XCTestCase {

    func testPhaseHasSurfaceAndProgressing() {
        XCTAssertTrue(RemotePhase.connected.hasSurface)
        XCTAssertTrue(RemotePhase.degraded.hasSurface)
        XCTAssertFalse(RemotePhase.connecting.hasSurface)
        XCTAssertTrue(RemotePhase.connecting.isProgressing)
        XCTAssertTrue(RemotePhase.reconnecting.isProgressing)
        XCTAssertTrue(RemotePhase.disconnected.isTerminal)
    }

    func testAdvanceKeepsPhaseSinceAndClearsError() {
        var status = RemoteSessionStatus(phase: .resolving, phaseSince: 10, error: MobileError.offline)
        status = status.advance(.connected, 20)
        XCTAssertEqual(status.phase, .connected)
        XCTAssertEqual(status.phaseSince, 20)
        XCTAssertNil(status.error)
    }

    func testElapsedMs() {
        let status = RemoteSessionStatus(phase: .connecting, phaseSince: 100)
        XCTAssertEqual(status.elapsedMs(250), 150)
        XCTAssertEqual(RemoteSessionStatus().elapsedMs(999), 0)
    }

    func testTimeoutPerPhase() {
        XCTAssertEqual(RemotePhasePolicy.timeoutMs(.resolving), 10_000)
        XCTAssertEqual(RemotePhasePolicy.timeoutMs(.firstFrame), 30_000)
        XCTAssertNil(RemotePhasePolicy.timeoutMs(.connected))
        XCTAssertNil(RemotePhasePolicy.timeoutMs(.disconnected))
    }

    func testHasTimedOut() {
        let status = RemoteSessionStatus(phase: .connecting, phaseSince: 100)
        XCTAssertTrue(RemotePhasePolicy.hasTimedOut(status, 100 + RemotePhasePolicy.connectTimeoutMs))
        XCTAssertFalse(RemotePhasePolicy.hasTimedOut(status, 100))
    }

    func testCanAutoReconnect() {
        XCTAssertTrue(RemotePhasePolicy.canAutoReconnect(nil))
        XCTAssertTrue(RemotePhasePolicy.canAutoReconnect(MobileError.offline))
        let revoked = MobileError.local(code: "resource_revoked", message: "revoked")
        XCTAssertFalse(RemotePhasePolicy.canAutoReconnect(revoked))
        let authFailed = MobileError.local(code: "auth_failed", message: "bad")
        XCTAssertFalse(RemotePhasePolicy.canAutoReconnect(authFailed))
    }

    func testReconnectDelayBackoff() {
        XCTAssertEqual(RemotePhasePolicy.reconnectDelayMs(1), 1_000)
        XCTAssertEqual(RemotePhasePolicy.reconnectDelayMs(3), 5_000)
        XCTAssertEqual(RemotePhasePolicy.reconnectDelayMs(9), 15_000)
    }

    func testTimeoutErrorIsRetryable() {
        let error = RemotePhasePolicy.timeoutError(.connecting)
        XCTAssertEqual(error.code, RemotePhasePolicy.phaseTimeoutCode)
        XCTAssertTrue(error.retryable)
    }
}