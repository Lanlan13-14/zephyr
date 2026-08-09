package one.zephyr.mobile.sync

import one.zephyr.mobile.contracts.ErrorRegistry
import one.zephyr.mobile.model.MobileError
import one.zephyr.mobile.model.sync.BindingStateMachine
import one.zephyr.mobile.model.sync.SyncEvent

/**
 * Error code to state-machine event.
 *
 * The registry decides retryability; this decides *persistence*. The distinction matters because a
 * wrong mapping here is the difference between a device that retries and one that silently stops
 * syncing, so every branch below cites the rule it implements.
 */
object SyncErrorMapping {

    fun eventFor(code: String): SyncEvent? = when (code) {
        // The mirror is still valid, only the cursor is unusable: SYNC_STATE_MACHINE.md 3 sends this
        // back to BOUND_NEEDS_BOOTSTRAP and requires pushing to stop until a fresh snapshot exists.
        "cursor_expired", "cursor_invalid" -> SyncEvent.CURSOR_EXPIRED

        "bootstrap_expired" -> SyncEvent.BOOTSTRAP_EXPIRED

        // Only an explicit revocation or an unusable account wipes the binding. A missing device row
        // is deliberately *not* treated as revocation: that would discard the local mirror over a
        // server-side misconfiguration, while REAUTH_REQUIRED keeps the data and asks the user.
        "client_revoked" -> SyncEvent.DEVICE_REVOKED
        "account_unavailable", "account_suspended" -> SyncEvent.ACCOUNT_UNAVAILABLE

        "token_missing", "token_not_found", "token_required", "client_disabled", "client_not_found",
        "client_owned_by_other" -> SyncEvent.TOKEN_MISSING
        "token_rotated" -> SyncEvent.TOKEN_ROTATED

        // The single automatic refresh in MobileApiClient has already been tried and lost by the time
        // the actor sees these, so the only remaining move is re-auth.
        "refresh_replayed", "device_proof_invalid" -> SyncEvent.REFRESH_INVALID

        // Management-plane only. The data plane runs on the device access credential, so the binding
        // state is deliberately left alone (SYNC_STATE_MACHINE.md 3).
        "app_session_expired", "must_change_password" -> SyncEvent.SID_EXPIRED

        "registry_mismatch", "unknown_entity_type" -> SyncEvent.REGISTRY_INCOMPATIBLE
        "unsupported_protocol_version" -> SyncEvent.PROTOCOL_INCOMPATIBLE

        else -> null
    }

    /**
     * A residency violation is never retried or degraded: SHARED_RESOURCE_RESIDENCY.md requires the
     * round to abort and every shared artefact to be purged from memory, because the alternative is
     * shared-to-me data reaching disk.
     */
    fun requiresSharedPurge(code: String): Boolean = code == "shared_residency_violation"

    /** True when the round must stop rather than continue to the next phase. */
    fun abortsRound(error: MobileError): Boolean {
        if (requiresSharedPurge(error.code)) return true
        val event = eventFor(error.code)
        // SID expiry only affects management calls, so a data-plane round keeps going.
        if (event == SyncEvent.SID_EXPIRED) return false
        if (event != null) return true
        return !ErrorRegistry.retryable(error.code) || error.retryable
    }

    /**
     * Next retry delay.
     *
     * A server-supplied Retry-After always wins over the local ladder: the main end knows its own
     * rate-limit window, and ignoring it is how a client gets itself banned.
     */
    fun retryDelayMs(error: MobileError?, attempt: Int, jitter: Double = 1.0): Long {
        val serverHint = error?.retryAfterSeconds
        if (serverHint != null && serverHint > 0) return serverHint * 1_000L
        return BindingStateMachine.backoffMs(attempt, jitter)
    }

    /** Whether another automatic attempt is worth making at all. */
    fun isRetryable(error: MobileError): Boolean =
        error.retryable || ErrorRegistry.retryable(error.code)
}
