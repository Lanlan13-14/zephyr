package one.zephyr.mobile.security

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Local app lock.
 *
 * DEVELOPMENT.md 1028 is explicit: One must never ask the user to create a Zephyr One unlock
 * password. The only credential is the platform one (BiometricPrompt: fingerprint, face, or device
 * credential). When platform authentication is unavailable the feature reports unavailable rather
 * than degrading to an app-built password.
 *
 * App lock is a local convenience only. It never substitutes for main-end sensitive verification
 * (DEVELOPMENT.md 617), which still requires the account password or TOTP.
 */
enum class LockDelay(val millis: Long) {
    IMMEDIATE(0L),
    ONE_MINUTE(60_000L),
    FIVE_MINUTES(300_000L),
    ;

    companion object {
        val default: LockDelay = IMMEDIATE
    }
}

/** Why the platform cannot authenticate, so the settings page can say so precisely. */
enum class BiometricAvailability {
    AVAILABLE,
    NO_HARDWARE,
    HARDWARE_UNAVAILABLE,
    NONE_ENROLLED,
    SECURITY_UPDATE_REQUIRED,
    UNSUPPORTED,
    UNKNOWN,
    ;

    val canAuthenticate: Boolean get() = this == AVAILABLE
}

sealed interface AuthResult {
    data object Success : AuthResult

    /** User dismissed the prompt. The app stays locked; no fallback credential is offered. */
    data object Cancelled : AuthResult

    data class Failed(val availability: BiometricAvailability, val message: String) : AuthResult
}

/**
 * Platform authentication port. The BiometricPrompt implementation lives in the app module because
 * it needs a FragmentActivity; keeping it behind an interface lets the lock state machine be unit
 * tested without an emulator.
 */
interface DeviceAuthenticator {
    fun availability(): BiometricAvailability
    suspend fun authenticate(title: String, subtitle: String): AuthResult
}

enum class LockState { DISABLED, UNLOCKED, LOCKED }

/**
 * Anything holding decrypted material must register here so a lock event drops it. Registered
 * sinks are also cleared on unbind and on device revocation.
 */
interface LockSensitiveSink {
    fun onLocked()
}

class AppLock(
    private val authenticator: DeviceAuthenticator,
    private val clock: () -> Long = System::currentTimeMillis,
) {

    private val sinks = mutableListOf<LockSensitiveSink>()
    private val stateFlow = MutableStateFlow(LockState.DISABLED)
    private var delay: LockDelay = LockDelay.default
    private var backgroundedAt: Long? = null

    val state: StateFlow<LockState> get() = stateFlow.asStateFlow()
    val lockDelay: LockDelay get() = delay
    val isEnabled: Boolean get() = stateFlow.value != LockState.DISABLED

    fun register(sink: LockSensitiveSink) {
        synchronized(sinks) { sinks.add(sink) }
    }

    fun unregister(sink: LockSensitiveSink) {
        synchronized(sinks) { sinks.remove(sink) }
    }

    fun availability(): BiometricAvailability = authenticator.availability()

    /**
     * @return false when the platform cannot authenticate; the caller must show the unavailable
     *   reason instead of enabling a weaker local gate.
     */
    fun enable(delay: LockDelay): Boolean {
        if (!authenticator.availability().canAuthenticate) return false
        this.delay = delay
        // Enabling from inside the app leaves it unlocked; the delay applies from the next
        // background transition.
        stateFlow.value = LockState.UNLOCKED
        backgroundedAt = null
        return true
    }

    fun disable() {
        delay = LockDelay.default
        backgroundedAt = null
        stateFlow.value = LockState.DISABLED
    }

    fun setDelay(delay: LockDelay) {
        if (!isEnabled) return
        this.delay = delay
    }

    fun onEnterBackground() {
        // Backgrounding always drops plaintext, even when app lock is disabled or has a delay.
        // The delay controls only when the UI becomes locked; it is not permission to keep a warm
        // credential or form cache while this process is no longer visible.
        notifySinks()
        if (stateFlow.value != LockState.UNLOCKED) return
        if (delay == LockDelay.IMMEDIATE) {
            backgroundedAt = null
            stateFlow.value = LockState.LOCKED
        } else {
            backgroundedAt = clock()
        }
    }

    fun onEnterForeground() {
        if (stateFlow.value != LockState.UNLOCKED) return
        val since = backgroundedAt ?: return
        if (clock() - since >= delay.millis) lockNow()
        backgroundedAt = null
    }

    /** Locking hides the UI and clears decrypted secrets; ciphertext at rest is untouched. */
    fun lockNow() {
        if (!isEnabled) return
        backgroundedAt = null
        stateFlow.value = LockState.LOCKED
        notifySinks()
    }

    suspend fun unlock(title: String, subtitle: String): AuthResult {
        if (stateFlow.value != LockState.LOCKED) return AuthResult.Success
        val result = authenticator.authenticate(title, subtitle)
        if (result is AuthResult.Success) stateFlow.value = LockState.UNLOCKED
        return result
    }

    /**
     * Sensitive local reveals reuse the platform prompt, but callers must still hold a main-end
     * grant for the actions listed in DEVELOPMENT.md 617.
     */
    suspend fun confirmLocalReveal(title: String, subtitle: String): AuthResult {
        if (!authenticator.availability().canAuthenticate) {
            return AuthResult.Failed(authenticator.availability(), "platform authentication unavailable")
        }
        return authenticator.authenticate(title, subtitle)
    }

    /** Unbind and device revoke clear in-memory material regardless of lock configuration. */
    fun clearSensitiveMaterial() {
        notifySinks()
    }

    private fun notifySinks() {
        val snapshot = synchronized(sinks) { sinks.toList() }
        for (sink in snapshot) sink.onLocked()
    }
}
