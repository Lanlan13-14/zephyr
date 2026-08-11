package one.zephyr.mobile.security

import org.junit.Assert.assertEquals
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
}

private class CountingSink : LockSensitiveSink {
    var clears = 0
    override fun onLocked() {
        clears += 1
    }
}

private class FakeAuthenticator : DeviceAuthenticator {
    override fun availability(): BiometricAvailability = BiometricAvailability.AVAILABLE

    override suspend fun authenticate(title: String, subtitle: String): AuthResult = AuthResult.Success
}
