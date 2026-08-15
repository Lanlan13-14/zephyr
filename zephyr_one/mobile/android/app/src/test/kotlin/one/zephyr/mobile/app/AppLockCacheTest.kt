package one.zephyr.mobile.app

import one.zephyr.mobile.data.repository.SettingsRepository
import one.zephyr.mobile.security.LockDelay
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AppLockCacheTest {

    @Test
    fun `timeout wire round-trips every delay`() {
        for (delay in LockDelay.entries) {
            assertEquals(delay, AppLockCache.timeoutFromWire(AppLockCache.timeoutWire(delay)))
        }
    }

    @Test
    fun `unknown timeout falls back to immediate`() {
        assertEquals(LockDelay.IMMEDIATE, AppLockCache.timeoutFromWire(null))
        assertEquals(LockDelay.IMMEDIATE, AppLockCache.timeoutFromWire(""))
        assertEquals(LockDelay.IMMEDIATE, AppLockCache.timeoutFromWire("tomorrow"))
    }

    @Test
    fun `room lock flag is recorded when the key exists`() {
        val empty = appearanceFromPrefs(emptyMap())
        assertFalse(empty.lockEnabled)
        assertFalse(empty.lockRecorded)

        val stored = appearanceFromPrefs(
            mapOf(
                SettingsRepository.PREF_APP_LOCK_ENABLED to kotlinx.serialization.json.JsonObject(
                    mapOf("value" to kotlinx.serialization.json.JsonPrimitive(true)),
                ),
                SettingsRepository.PREF_APP_LOCK_TIMEOUT to kotlinx.serialization.json.JsonObject(
                    mapOf("value" to kotlinx.serialization.json.JsonPrimitive("1m")),
                ),
            ),
        )
        assertTrue(stored.lockEnabled)
        assertTrue(stored.lockRecorded)
        assertEquals(LockDelay.ONE_MINUTE, stored.lockTimeout)
    }

    @Test
    fun `empty room emission is not applied over a cache restore`() {
        assertFalse(shouldApplyLockPreference(AppearancePrefs()))
        assertTrue(shouldApplyLockPreference(AppearancePrefs(lockRecorded = true)))
        assertTrue(shouldApplyLockPreference(AppearancePrefs(lockEnabled = true)))
    }

    @Test
    fun `settings enable stays unlocked but a cold restore locks`() {
        assertFalse(shouldLockWhenApplying(alreadyEnabled = true, enabled = true, lockOnEnable = false))
        assertTrue(shouldLockWhenApplying(alreadyEnabled = false, enabled = true, lockOnEnable = false))
        assertTrue(shouldLockWhenApplying(alreadyEnabled = false, enabled = true, lockOnEnable = true))
        assertFalse(shouldLockWhenApplying(alreadyEnabled = false, enabled = false, lockOnEnable = false))
    }
}
