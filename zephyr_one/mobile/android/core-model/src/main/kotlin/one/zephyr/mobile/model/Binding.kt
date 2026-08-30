package one.zephyr.mobile.model

import one.zephyr.mobile.contracts.BindingState

/** A Zephyr main-end deployment One can bind to. Portable metadata only. */
data class ServerProfile(
    val id: String,
    val baseUrl: String,
    val displayName: String,
    val tlsPolicy: TlsPolicy,
    val createdAt: Long,
    val lastUsedAt: Long?,
) {
    init {
        require(baseUrl.startsWith("https://")) { "Zephyr One only accepts HTTPS base URLs" }
    }
}

/**
 * TLS trust for this profile.
 *
 * Default is the system CA store. A self-signed host can either pin an SPKI or,
 * with an explicit bind-time switch, accept the presented certificate for this
 * bound URL only. The insecure switch is never the default.
 */
sealed interface TlsPolicy {
    /** System trust store, strict validation. The only default. */
    data object SystemTrust : TlsPolicy

    /** Explicit SHA-256 SPKI pin for a private CA or self-signed deployment. */
    data class PinnedSpki(val sha256Pins: List<String>) : TlsPolicy {
        init {
            require(sha256Pins.isNotEmpty()) { "pinned policy needs at least one pin" }
        }
    }

    /**
     * User-confirmed trust of the bound host's presented certificate. Hostname
     * still has to match. Not a global "ignore TLS" flag.
     */
    data object InsecureTrust : TlsPolicy

    val isStrict: Boolean get() = this !is InsecureTrust
}

/**
 * The account + token + device binding produced by the S02 flow. Device identity material lives
 * in the SecretStore, never in this row.
 */
data class AccountBinding(
    val serverProfileId: String,
    val userId: String,
    val username: String,
    val deviceId: String,
    val deviceName: String,
    val tokenId: String,
    val tokenName: String,
    val state: BindingState,
    val registryHash: String,
    val boundAt: Long,
    val lastSyncAt: Long?,
    /** Bumped by a main-end backup restore; invalidates every cursor and credential. */
    val instanceEpoch: Long,
) {
    val isLive: Boolean get() = state.isBound && state != BindingState.REVOKED
}

/** Result of the bind handshake, before anything is persisted. */
sealed interface BindOutcome {
    data class Success(val binding: AccountBinding) : BindOutcome
    data object TotpRequired : BindOutcome
    data class TokenChoiceRequired(val tokens: List<ClientToken>) : BindOutcome
    data object NoTokenOnServer : BindOutcome
    data class Failed(val error: MobileError) : BindOutcome
}

/** One-shot grant for a sensitive action, bound to action + target. */
data class SensitiveGrant(
    val grantId: String,
    val action: String,
    val targetId: String?,
    val expiresAt: Long,
) {
    fun matches(action: String, targetId: String?): Boolean =
        this.action == action && this.targetId == targetId

    fun isValidAt(nowMs: Long): Boolean = nowMs < expiresAt
}

/** Which credential proved the sensitive action. */
enum class SensitiveVerificationMode { PASSWORD, TOTP }
