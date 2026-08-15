package one.zephyr.mobile.feature.connections

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ConnectionPasswordRevealPolicyTest {
    @Test
    fun allowsOnlyEnabledStoredAndCapable() {
        assertTrue(ConnectionPasswordRevealPolicy.allowed(true, true, true))
    }

    @Test
    fun disabledLocalUnlockAlwaysRefuses() {
        assertFalse(ConnectionPasswordRevealPolicy.allowed(false, true, true))
    }

    @Test
    fun missingStoredPasswordRefuses() {
        assertFalse(ConnectionPasswordRevealPolicy.allowed(true, false, true))
    }

    @Test
    fun missingRevealCapabilityRefuses() {
        assertFalse(ConnectionPasswordRevealPolicy.allowed(true, true, false))
    }
}
