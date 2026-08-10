import XCTest
@testable import ZephyrUI

/// Scripted platform-authentication fake: the state machine under test must
/// never depend on a real LocalAuthentication prompt.
private final class FakeAuthenticator: DeviceAuthenticator {
    var availabilityValue: BiometricAvailability = .available
    var results: [AuthResult] = []
    var authenticateCalls = 0

    func availability() -> BiometricAvailability {
        availabilityValue
    }

    func authenticate(title: String, subtitle: String) async -> AuthResult {
        authenticateCalls += 1
        if results.isEmpty { return .success }
        return results.removeFirst()
    }
}

private final class RecordingSink: LockSensitiveSink {
    var lockCount = 0

    func onLocked() {
        lockCount += 1
    }
}

/// The S01 lock policy, mirrored from the Kotlin core-security behaviour.
final class AppLockTests: XCTestCase {

    private func makeLock(
        authenticator: FakeAuthenticator,
        clock: @escaping () -> Int64 = { 0 }
    ) -> AppLock {
        AppLock(authenticator: authenticator, clock: clock)
    }

    func testEnableRefusedWhenPlatformCannotAuthenticate() {
        let authenticator = FakeAuthenticator()
        authenticator.availabilityValue = .noneEnrolled
        let lock = makeLock(authenticator: authenticator)
        XCTAssertFalse(lock.enable(.immediate))
        XCTAssertEqual(.disabled, lock.state)
    }

    func testEnableLeavesTheAppUnlocked() {
        let lock = makeLock(authenticator: FakeAuthenticator())
        XCTAssertTrue(lock.enable(.immediate))
        XCTAssertEqual(.unlocked, lock.state)
        XCTAssertTrue(lock.isEnabled)
    }

    func testImmediateDelayLocksOnBackground() {
        let lock = makeLock(authenticator: FakeAuthenticator())
        lock.enable(.immediate)
        lock.onEnterBackground()
        XCTAssertEqual(.locked, lock.state)
    }

    func testOneMinuteDelayLocksOnlyAfterTheWindow() {
        var now: Int64 = 1_000
        let lock = makeLock(authenticator: FakeAuthenticator(), clock: { now })
        lock.enable(.oneMinute)
        lock.onEnterBackground()
        XCTAssertEqual(.unlocked, lock.state)

        now += 59_000
        lock.onEnterForeground()
        XCTAssertEqual(.unlocked, lock.state)

        lock.onEnterBackground()
        now += 60_000
        lock.onEnterForeground()
        XCTAssertEqual(.locked, lock.state)
    }

    func testFiveMinuteDelay() {
        var now: Int64 = 0
        let lock = makeLock(authenticator: FakeAuthenticator(), clock: { now })
        lock.enable(.fiveMinutes)
        lock.onEnterBackground()
        now += 299_999
        lock.onEnterForeground()
        XCTAssertEqual(.unlocked, lock.state)

        lock.onEnterBackground()
        now += 300_000
        lock.onEnterForeground()
        XCTAssertEqual(.locked, lock.state)
    }

    func testLockNowNotifiesSinks() {
        let lock = makeLock(authenticator: FakeAuthenticator())
        lock.enable(.immediate)
        let sink = RecordingSink()
        lock.register(sink)
        lock.lockNow()
        XCTAssertEqual(1, sink.lockCount)

        lock.unregister(sink)
        lock.clearSensitiveMaterial()
        XCTAssertEqual(1, sink.lockCount)
    }

    func testLockNowOnADisabledLockIsANoOp() {
        let lock = makeLock(authenticator: FakeAuthenticator())
        let sink = RecordingSink()
        lock.register(sink)
        lock.lockNow()
        XCTAssertEqual(.disabled, lock.state)
        XCTAssertEqual(0, sink.lockCount)
    }

    func testUnlockSuccessUnlocks() async {
        let lock = makeLock(authenticator: FakeAuthenticator())
        lock.enable(.immediate)
        lock.lockNow()
        let result = await lock.unlock(title: "t", subtitle: "s")
        XCTAssertEqual(.success, result)
        XCTAssertEqual(.unlocked, lock.state)
    }

    func testUnlockCancelledStaysLocked() async {
        let authenticator = FakeAuthenticator()
        authenticator.results = [.cancelled]
        let lock = makeLock(authenticator: authenticator)
        lock.enable(.immediate)
        lock.lockNow()
        let result = await lock.unlock(title: "t", subtitle: "s")
        XCTAssertEqual(.cancelled, result)
        XCTAssertEqual(.locked, lock.state)
    }

    func testUnlockWhenNotLockedIsASuccessNoOp() async {
        let authenticator = FakeAuthenticator()
        let lock = makeLock(authenticator: authenticator)
        lock.enable(.immediate)
        let result = await lock.unlock(title: "t", subtitle: "s")
        XCTAssertEqual(.success, result)
        XCTAssertEqual(0, authenticator.authenticateCalls)
    }

    func testConfirmLocalRevealRequiresPlatformAuth() async {
        let authenticator = FakeAuthenticator()
        authenticator.availabilityValue = .noHardware
        let lock = makeLock(authenticator: authenticator)
        let result = await lock.confirmLocalReveal(title: "t", subtitle: "s")
        guard case let .failed(availability, _) = result else {
            return XCTFail("expected failed, got \(result)")
        }
        XCTAssertEqual(.noHardware, availability)
        XCTAssertEqual(0, authenticator.authenticateCalls)
    }

    func testSetDelayOnlyAppliesWhenEnabled() {
        let lock = makeLock(authenticator: FakeAuthenticator())
        lock.setDelay(.fiveMinutes)
        XCTAssertEqual(.immediate, lock.lockDelay)
        lock.enable(.immediate)
        lock.setDelay(.fiveMinutes)
        XCTAssertEqual(.fiveMinutes, lock.lockDelay)
    }

    func testDisableResetsEverything() {
        let lock = makeLock(authenticator: FakeAuthenticator())
        lock.enable(.fiveMinutes)
        lock.disable()
        XCTAssertEqual(.disabled, lock.state)
        XCTAssertEqual(.immediate, lock.lockDelay)
        XCTAssertFalse(lock.isEnabled)
    }
}
