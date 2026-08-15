package one.zephyr.mobile.app

import android.content.SharedPreferences
import one.zephyr.mobile.security.LockDelay

/**
 * Process-start cache for the lock switch.
 *
 * Room preferences arrive after the first frame. Without a synchronous store the dashboard would
 * flash unlocked, then lock. Screenshot protection already lives in this same prefs file.
 */
internal object AppLockCache {
    const val PREFS = "zephyr-one-appearance"
    const val KEY_ENABLED = "app-lock-enabled"
    const val KEY_TIMEOUT = "app-lock-timeout"

    fun timeoutWire(delay: LockDelay): String = when (delay) {
        LockDelay.ONE_MINUTE -> "1m"
        LockDelay.FIVE_MINUTES -> "5m"
        LockDelay.IMMEDIATE -> "immediate"
    }

    fun timeoutFromWire(raw: String?): LockDelay = when (raw) {
        "1m" -> LockDelay.ONE_MINUTE
        "5m" -> LockDelay.FIVE_MINUTES
        else -> LockDelay.IMMEDIATE
    }

    fun readEnabled(prefs: SharedPreferences): Boolean = prefs.getBoolean(KEY_ENABLED, false)

    fun readDelay(prefs: SharedPreferences): LockDelay =
        timeoutFromWire(prefs.getString(KEY_TIMEOUT, "immediate"))

    fun write(prefs: SharedPreferences, enabled: Boolean, delay: LockDelay) {
        prefs.edit()
            .putBoolean(KEY_ENABLED, enabled)
            .putString(KEY_TIMEOUT, timeoutWire(delay))
            .apply()
    }
}
