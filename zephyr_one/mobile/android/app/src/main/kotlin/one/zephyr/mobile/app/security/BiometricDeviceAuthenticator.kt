package one.zephyr.mobile.app.security

import android.content.Context
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import java.lang.ref.WeakReference
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine
import one.zephyr.mobile.security.AuthResult
import one.zephyr.mobile.security.BiometricAvailability
import one.zephyr.mobile.security.DeviceAuthenticator

/**
 * [DeviceAuthenticator] on BiometricPrompt.
 *
 * The platform credential is the only one One accepts: DEVELOPMENT.md 1028 forbids an app-built
 * unlock password, so when the platform cannot authenticate this reports why rather than offering a
 * fallback. DEVICE_CREDENTIAL is included alongside BIOMETRIC_STRONG because a device with a PIN and
 * no enrolled fingerprint must still be able to unlock.
 */
class BiometricDeviceAuthenticator(private val context: Context) : DeviceAuthenticator {

    /**
     * Weak, and replaced per resume.
     *
     * A prompt needs a live FragmentActivity, but this object is process-scoped. A strong reference
     * would outlive the activity across every rotation.
     */
    private var host: WeakReference<FragmentActivity>? = null

    fun attach(activity: FragmentActivity) {
        host = WeakReference(activity)
    }

    fun detach(activity: FragmentActivity) {
        if (host?.get() === activity) host = null
    }

    override fun availability(): BiometricAvailability =
        when (BiometricManager.from(context).canAuthenticate(ALLOWED)) {
            BiometricManager.BIOMETRIC_SUCCESS -> BiometricAvailability.AVAILABLE
            BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE -> BiometricAvailability.NO_HARDWARE
            BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE -> BiometricAvailability.HARDWARE_UNAVAILABLE
            BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED -> BiometricAvailability.NONE_ENROLLED
            BiometricManager.BIOMETRIC_ERROR_SECURITY_UPDATE_REQUIRED ->
                BiometricAvailability.SECURITY_UPDATE_REQUIRED
            BiometricManager.BIOMETRIC_ERROR_UNSUPPORTED -> BiometricAvailability.UNSUPPORTED
            else -> BiometricAvailability.UNKNOWN
        }

    override suspend fun authenticate(title: String, subtitle: String): AuthResult {
        val activity = host?.get()
            ?: return AuthResult.Failed(availability(), "没有可用的界面来显示验证提示")

        return suspendCancellableCoroutine { continuation ->
            val prompt = BiometricPrompt(
                activity,
                ContextCompat.getMainExecutor(activity),
                object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                        if (continuation.isActive) continuation.resume(AuthResult.Success)
                    }

                    override fun onAuthenticationError(code: Int, message: CharSequence) {
                        if (!continuation.isActive) return
                        // A user-initiated dismissal is Cancelled, not Failed: the settings page must
                        // not claim the hardware is broken because someone tapped outside the sheet.
                        val cancelled = code == BiometricPrompt.ERROR_USER_CANCELED ||
                            code == BiometricPrompt.ERROR_NEGATIVE_BUTTON ||
                            code == BiometricPrompt.ERROR_CANCELED
                        continuation.resume(
                            if (cancelled) {
                                AuthResult.Cancelled
                            } else {
                                AuthResult.Failed(availability(), message.toString())
                            },
                        )
                    }

                    // onAuthenticationFailed is deliberately not resumed: one rejected finger is not
                    // the end of the attempt, and the prompt stays up until the user or the platform
                    // ends it.
                },
            )

            val info = BiometricPrompt.PromptInfo.Builder()
                .setTitle(title)
                .setSubtitle(subtitle)
                .setAllowedAuthenticators(ALLOWED)
                .build()

            continuation.invokeOnCancellation { prompt.cancelAuthentication() }
            prompt.authenticate(info)
        }
    }

    private companion object {
        const val ALLOWED = BiometricManager.Authenticators.BIOMETRIC_STRONG or
            BiometricManager.Authenticators.DEVICE_CREDENTIAL
    }
}
