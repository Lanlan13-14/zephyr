package one.zephyr.mobile.security

import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt

/**
 * Combinations BiometricPrompt will actually accept.
 *
 * `BIOMETRIC_STRONG or DEVICE_CREDENTIAL` is the product default (Class 3 biometric or the
 * device PIN/pattern/password). It is illegal before API 30: PromptInfo.Builder throws
 * IllegalArgumentException, and canAuthenticate reports BIOMETRIC_STATUS_UNKNOWN. A device that
 * only has a PIN would then look like it cannot unlock at all.
 *
 * Pre-R the supported equivalent is WEAK + DEVICE_CREDENTIAL. WEAK still covers fingerprint and
 * face on the devices this app ships to; DEVICE_CREDENTIAL keeps PIN-only phones working.
 */
object PlatformUnlockPolicy {

    const val PRE_R_SDK = 30

    const val PRE_R_ALLOWED: Int =
        BiometricManager.Authenticators.BIOMETRIC_WEAK or
            BiometricManager.Authenticators.DEVICE_CREDENTIAL

    const val R_PLUS_ALLOWED: Int =
        BiometricManager.Authenticators.BIOMETRIC_STRONG or
            BiometricManager.Authenticators.DEVICE_CREDENTIAL

    fun allowedAuthenticators(sdkInt: Int): Int =
        if (sdkInt >= PRE_R_SDK) R_PLUS_ALLOWED else PRE_R_ALLOWED

    /**
     * User-initiated dismissals. [BiometricPrompt.ERROR_CANCELED] is deliberately excluded: the
     * framework fires it when the host pauses to show the device-credential activity, and treating
     * that as the end of the attempt drops the PIN/pattern result on the floor.
     */
    fun isInteractiveCancellation(code: Int): Boolean =
        code == BiometricPrompt.ERROR_USER_CANCELED ||
            code == BiometricPrompt.ERROR_NEGATIVE_BUTTON
}
