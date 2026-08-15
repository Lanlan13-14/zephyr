package one.zephyr.mobile.security

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AppLockTest {

    @Test
    fun `background clears plaintext even when app lock is disabled`() {
        val lock = AppLock(FakeAuthenticator())
        val sink = CountingSink()
        lock.register(sink)

        lock.onEnterBackground()

        assertEquals(1, sink.clears)
        assertEquals(LockState.DISABLED, lock.state.value)
    }

    @Test
    fun `delayed background clears plaintext immediately but delays UI lock`() {
        var now = 1_000L
        val lock = AppLock(FakeAuthenticator()) { now }
        val sink = CountingSink()
        lock.register(sink)
        assertTrue(lock.enable(LockDelay.ONE_MINUTE))

        lock.onEnterBackground()
        assertEquals(1, sink.clears)
        assertEquals(LockState.UNLOCKED, lock.state.value)

        now += LockDelay.ONE_MINUTE.millis
        lock.onEnterForeground()
        assertEquals(LockState.LOCKED, lock.state.value)
        assertEquals(2, sink.clears)
    }

    @Test
    fun `immediate background locks and clears each sink once`() {
        val lock = AppLock(FakeAuthenticator())
        val sink = CountingSink()
        lock.register(sink)
        assertTrue(lock.enable(LockDelay.IMMEDIATE))

        lock.onEnterBackground()

        assertEquals(LockState.LOCKED, lock.state.value)
        assertEquals(1, sink.clears)
    }

    @Test
    fun `enable is refused when the platform cannot authenticate`() {
        val lock = AppLock(FakeAuthenticator(availability = BiometricAvailability.NONE_ENROLLED))
        assertFalse(lock.enable(LockDelay.IMMEDIATE))
        assertEquals(LockState.DISABLED, lock.state.value)
    }

    @Test
    fun `unlock success asks the authenticator and unlocks`() = runTest {
        val authenticator = FakeAuthenticator()
        val lock = AppLock(authenticator)
        assertTrue(lock.enable(LockDelay.IMMEDIATE))
        lock.lockNow()

        val result = lock.unlock("解锁 Zephyr One", "使用设备凭据继续")

        assertEquals(AuthResult.Success, result)
        assertEquals(LockState.UNLOCKED, lock.state.value)
        assertEquals(1, authenticator.authenticateCalls)
        assertEquals("解锁 Zephyr One", authenticator.lastTitle)
    }

    @Test
    fun `unlock cancelled stays locked`() = runTest {
        val authenticator = FakeAuthenticator(result = AuthResult.Cancelled)
        val lock = AppLock(authenticator)
        assertTrue(lock.enable(LockDelay.IMMEDIATE))
        lock.lockNow()

        val result = lock.unlock("t", "s")

        assertEquals(AuthResult.Cancelled, result)
        assertEquals(LockState.LOCKED, lock.state.value)
        assertEquals(1, authenticator.authenticateCalls)
    }

    @Test
    fun `unlock when not locked is a success no-op`() = runTest {
        val authenticator = FakeAuthenticator()
        val lock = AppLock(authenticator)
        assertTrue(lock.enable(LockDelay.IMMEDIATE))

        val result = lock.unlock("t", "s")

        assertEquals(AuthResult.Success, result)
        assertEquals(0, authenticator.authenticateCalls)
    }

    @Test
    fun `enable confirmation refuses unavailable hardware`() = runTest {
        val authenticator = FakeAuthenticator(availability = BiometricAvailability.NO_HARDWARE)
        val lock = AppLock(authenticator)

        val result = lock.confirmEnable("t", "s")

        assertTrue(result is AuthResult.Failed)
        assertEquals(BiometricAvailability.NO_HARDWARE, (result as AuthResult.Failed).availability)
        assertEquals(0, authenticator.authenticateCalls)
    }

    @Test
    fun `enable confirmation authenticates before lock is enabled`() = runTest {
        val authenticator = FakeAuthenticator()
        val lock = AppLock(authenticator)

        val result = lock.confirmEnable("t", "s")

        assertEquals(AuthResult.Success, result)
        assertEquals(1, authenticator.authenticateCalls)
        assertFalse(lock.isEnabled)
    }

    @Test
    fun `confirm local reveal refuses when local unlock is disabled`() = runTest {
        val authenticator = FakeAuthenticator()
        val lock = AppLock(authenticator)

        val result = lock.confirmLocalReveal("t", "s")

        assertTrue(result is AuthResult.Failed)
        assertEquals(0, authenticator.authenticateCalls)
    }

    @Test
    fun `confirm local reveal authenticates when local unlock is enabled`() = runTest {
        val authenticator = FakeAuthenticator()
        val lock = AppLock(authenticator)
        assertTrue(lock.enable(LockDelay.IMMEDIATE))

        val result = lock.confirmLocalReveal("t", "s")

        assertEquals(AuthResult.Success, result)
        assertEquals(1, authenticator.authenticateCalls)
    }

    @Test
    fun `settings enable leaves the session unlocked`() {
        val lock = AppLock(FakeAuthenticator())
        val result = AppLockPreferences.apply(
            lock = lock,
            enabled = true,
            delay = LockDelay.FIVE_MINUTES,
            lockOnEnable = false,
        )
        assertEquals(AppLockApplyResult.UNLOCKED, result)
        assertEquals(LockState.UNLOCKED, lock.state.value)
        assertEquals(LockDelay.FIVE_MINUTES, lock.lockDelay)
    }

    @Test
    fun `process restore locks immediately`() {
        val lock = AppLock(FakeAuthenticator())
        val sink = CountingSink()
        lock.register(sink)
        val result = AppLockPreferences.apply(
            lock = lock,
            enabled = true,
            delay = LockDelay.IMMEDIATE,
            lockOnEnable = true,
        )
        assertEquals(AppLockApplyResult.LOCKED, result)
        assertEquals(LockState.LOCKED, lock.state.value)
        assertEquals(1, sink.clears)
    }

    @Test
    fun `already enabled only updates the delay`() {
        val lock = AppLock(FakeAuthenticator())
        assertTrue(lock.enable(LockDelay.IMMEDIATE))
        lock.lockNow()
        val result = AppLockPreferences.apply(
            lock = lock,
            enabled = true,
            delay = LockDelay.ONE_MINUTE,
            lockOnEnable = true,
        )
        assertEquals(AppLockApplyResult.ALREADY_ENABLED, result)
        assertEquals(LockState.LOCKED, lock.state.value)
        assertEquals(LockDelay.ONE_MINUTE, lock.lockDelay)
    }

    @Test
    fun `disable preference turns the lock off`() {
        val lock = AppLock(FakeAuthenticator())
        assertTrue(lock.enable(LockDelay.ONE_MINUTE))
        val result = AppLockPreferences.apply(
            lock = lock,
            enabled = false,
            delay = LockDelay.ONE_MINUTE,
            lockOnEnable = true,
        )
        assertEquals(AppLockApplyResult.DISABLED, result)
        assertEquals(LockState.DISABLED, lock.state.value)
        assertFalse(lock.isEnabled)
    }

    @Test
    fun `unavailable hardware does not enable a weaker gate`() {
        val lock = AppLock(FakeAuthenticator(availability = BiometricAvailability.UNSUPPORTED))
        val result = AppLockPreferences.apply(
            lock = lock,
            enabled = true,
            delay = LockDelay.IMMEDIATE,
            lockOnEnable = true,
        )
        assertEquals(AppLockApplyResult.UNAVAILABLE, result)
        assertEquals(LockState.DISABLED, lock.state.value)
    }
}

class UnlockPresentationTest {

    @Test
    fun `success and cancel hide the failure copy`() {
        assertNull(UnlockPresentation.failureMessage(AuthResult.Success, "不可用"))
        assertNull(UnlockPresentation.failureMessage(AuthResult.Cancelled, "不可用"))
    }

    @Test
    fun `available hardware keeps the platform message`() {
        assertEquals(
            "指纹不匹配",
            UnlockPresentation.failureMessage(
                AuthResult.Failed(BiometricAvailability.AVAILABLE, "指纹不匹配"),
                "不可用",
            ),
        )
    }

    @Test
    fun `unavailable hardware uses the precise copy`() {
        assertEquals(
            "不可用",
            UnlockPresentation.failureMessage(
                AuthResult.Failed(BiometricAvailability.NONE_ENROLLED, "none"),
                "不可用",
            ),
        )
    }
}

private class CountingSink : LockSensitiveSink {
    var clears = 0
    override fun onLocked() {
        clears += 1
    }
}

private class FakeAuthenticator(
    private val availability: BiometricAvailability = BiometricAvailability.AVAILABLE,
    private val result: AuthResult = AuthResult.Success,
) : DeviceAuthenticator {
    var authenticateCalls = 0
    var lastTitle: String? = null

    override fun availability(): BiometricAvailability = availability

    override suspend fun authenticate(title: String, subtitle: String): AuthResult {
        authenticateCalls += 1
        lastTitle = title
        return result
    }
}
