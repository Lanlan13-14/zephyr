package one.zephyr.mobile.security

import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PlatformUnlockPolicyTest {

    @Test
    fun `pre-R uses weak plus device credential`() {
        assertEquals(
            BiometricManager.Authenticators.BIOMETRIC_WEAK or
                BiometricManager.Authenticators.DEVICE_CREDENTIAL,
            PlatformUnlockPolicy.allowedAuthenticators(26),
        )
        assertEquals(
            PlatformUnlockPolicy.PRE_R_ALLOWED,
            PlatformUnlockPolicy.allowedAuthenticators(29),
        )
    }

    @Test
    fun `R and above use strong plus device credential`() {
        assertEquals(
            BiometricManager.Authenticators.BIOMETRIC_STRONG or
                BiometricManager.Authenticators.DEVICE_CREDENTIAL,
            PlatformUnlockPolicy.allowedAuthenticators(30),
        )
        assertEquals(
            PlatformUnlockPolicy.R_PLUS_ALLOWED,
            PlatformUnlockPolicy.allowedAuthenticators(35),
        )
    }

    @Test
    fun `user cancel is interactive but framework cancel is not`() {
        assertTrue(PlatformUnlockPolicy.isInteractiveCancellation(BiometricPrompt.ERROR_USER_CANCELED))
        assertTrue(PlatformUnlockPolicy.isInteractiveCancellation(BiometricPrompt.ERROR_NEGATIVE_BUTTON))
        assertFalse(PlatformUnlockPolicy.isInteractiveCancellation(BiometricPrompt.ERROR_CANCELED))
        assertFalse(PlatformUnlockPolicy.isInteractiveCancellation(BiometricPrompt.ERROR_LOCKOUT))
        assertFalse(PlatformUnlockPolicy.isInteractiveCancellation(BiometricPrompt.ERROR_HW_UNAVAILABLE))
    }
}
