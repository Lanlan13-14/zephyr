package one.zephyr.mobile.app.security

import android.content.Context
import android.os.Build
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import java.lang.ref.WeakReference
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resume
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.suspendCancellableCoroutine
import one.zephyr.mobile.security.AuthResult
import one.zephyr.mobile.security.BiometricAvailability
import one.zephyr.mobile.security.DeviceAuthenticator
import one.zephyr.mobile.security.PlatformUnlockPolicy

/**
 * [DeviceAuthenticator] on BiometricPrompt.
 *
 * The platform credential is the only one One accepts: DEVELOPMENT.md 1028 forbids an app-built
 * unlock password, so when the platform cannot authenticate this reports why rather than offering a
 * fallback. DEVICE_CREDENTIAL is included because a device with a PIN and no enrolled fingerprint
 * must still be able to unlock.
 *
 * Allowed authenticators are versioned: STRONG + DEVICE_CREDENTIAL is illegal before API 30, so
 * those devices use WEAK + DEVICE_CREDENTIAL instead of claiming the hardware cannot authenticate.
 */
class BiometricDeviceAuthenticator(
    private val context: Context,
    private val sdkInt: Int = Build.VERSION.SDK_INT,
) : DeviceAuthenticator {

    /**
     * Weak, and replaced per resume.
     *
     * A prompt needs a live FragmentActivity, but this object is process-scoped. A strong reference
     * would outlive the activity across every rotation.
     */
    private var host: WeakReference<FragmentActivity>? = null

    /**
     * Only one prompt may be live. A retry, or a second confirm from settings, must cancel the
     * previous continuation; otherwise ERROR_CANCELED from the first sheet leaves it hanging and
     * the retry button looks dead.
     */
    private var inFlight: Attempt? = null

    fun attach(activity: FragmentActivity) {
        host = WeakReference(activity)
    }

    fun detach(activity: FragmentActivity) {
        if (host?.get() === activity) host = null
    }

    override fun availability(): BiometricAvailability =
        mapAvailability(BiometricManager.from(context).canAuthenticate(allowedAuthenticators()))

    override suspend fun authenticate(title: String, subtitle: String): AuthResult {
        val activity = host?.get()
            ?: return AuthResult.Failed(availability(), "没有可用的界面来显示验证提示")
        if (activity.isFinishing || activity.isDestroyed) {
            return AuthResult.Failed(availability(), "没有可用的界面来显示验证提示")
        }

        val allowed = allowedAuthenticators()
        val status = BiometricManager.from(activity).canAuthenticate(allowed)
        if (status != BiometricManager.BIOMETRIC_SUCCESS) {
            return AuthResult.Failed(mapAvailability(status), "platform authentication unavailable")
        }

        cancelInFlight(AuthResult.Cancelled)

        return suspendCancellableCoroutine { continuation ->
            val completed = AtomicBoolean(false)

            fun finish(result: AuthResult) {
                if (completed.compareAndSet(false, true) && continuation.isActive) {
                    if (inFlight?.continuation === continuation) inFlight = null
                    continuation.resume(result)
                }
            }

            val prompt = BiometricPrompt(
                activity,
                ContextCompat.getMainExecutor(activity),
                object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                        finish(AuthResult.Success)
                    }

                    override fun onAuthenticationError(code: Int, message: CharSequence) {
                        // A user-initiated dismissal is Cancelled, not Failed: the settings page
                        // must not claim the hardware is broken because someone tapped outside the
                        // sheet. Framework ERROR_CANCELED is ignored: the host pauses to show the
                        // device-credential activity and the prompt is still the live attempt.
                        if (PlatformUnlockPolicy.isInteractiveCancellation(code)) {
                            finish(AuthResult.Cancelled)
                            return
                        }
                        if (code == BiometricPrompt.ERROR_CANCELED) {
                            if (activity.isFinishing || activity.isDestroyed) {
                                finish(AuthResult.Cancelled)
                            }
                            return
                        }
                        finish(AuthResult.Failed(availability(), message.toString()))
                    }

                    // onAuthenticationFailed is deliberately not resumed: one rejected finger is
                    // not the end of the attempt, and the prompt stays up until the user or the
                    // platform ends it.
                },
            )

            val attempt = Attempt(prompt, continuation)
            inFlight = attempt
            continuation.invokeOnCancellation {
                prompt.cancelAuthentication()
                if (inFlight === attempt) inFlight = null
            }
            try {
                prompt.authenticate(
                    BiometricPrompt.PromptInfo.Builder()
                        .setTitle(title)
                        .setSubtitle(subtitle)
                        .setAllowedAuthenticators(allowed)
                        .build(),
                )
            } catch (error: IllegalArgumentException) {
                finish(AuthResult.Failed(availability(), error.message ?: "illegal authenticator combination"))
            }
        }
    }

    private fun cancelInFlight(result: AuthResult) {
        val current = inFlight ?: return
        inFlight = null
        if (current.continuation.isActive) current.continuation.resume(result)
        current.prompt.cancelAuthentication()
    }

    private fun allowedAuthenticators(): Int = PlatformUnlockPolicy.allowedAuthenticators(sdkInt)

    private fun mapAvailability(status: Int): BiometricAvailability = when (status) {
        BiometricManager.BIOMETRIC_SUCCESS -> BiometricAvailability.AVAILABLE
        BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE -> BiometricAvailability.NO_HARDWARE
        BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE -> BiometricAvailability.HARDWARE_UNAVAILABLE
        BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED -> BiometricAvailability.NONE_ENROLLED
        BiometricManager.BIOMETRIC_ERROR_SECURITY_UPDATE_REQUIRED ->
            BiometricAvailability.SECURITY_UPDATE_REQUIRED
        BiometricManager.BIOMETRIC_ERROR_UNSUPPORTED -> BiometricAvailability.UNSUPPORTED
        else -> BiometricAvailability.UNKNOWN
    }

    private class Attempt(
        val prompt: BiometricPrompt,
        val continuation: CancellableContinuation<AuthResult>,
    )
}
