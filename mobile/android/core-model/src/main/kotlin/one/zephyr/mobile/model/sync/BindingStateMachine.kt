package one.zephyr.mobile.model.sync

import one.zephyr.mobile.contracts.BindingState
import one.zephyr.mobile.contracts.SyncContract
import one.zephyr.mobile.contracts.SyncPhase

/** Events that drive the binding state machine (SYNC_STATE_MACHINE.md 3). */
enum class SyncEvent(val wireName: String) {
    BIND_SUCCESS("bind_success"),
    RUN("run"),
    SNAPSHOT_COMPLETE("snapshot_complete"),
    BOOTSTRAP_EXPIRED("bootstrap_expired"),
    SUCCESS("success"),
    TRIGGER("trigger"),
    CONFLICT_ONLY("conflict_only"),
    CONFLICTS_RESOLVED("conflicts_resolved"),
    REBIND_SUCCESS("rebind_success"),
    REFRESH_INVALID("refresh_invalid"),
    TOKEN_MISSING("token_missing"),
    TOKEN_ROTATED("token_rotated"),
    DEVICE_REVOKED("device_revoked"),
    ACCOUNT_UNAVAILABLE("account_unavailable"),
    REGISTRY_INCOMPATIBLE("registry_incompatible"),
    PROTOCOL_INCOMPATIBLE("protocol_incompatible"),
    CURSOR_EXPIRED("cursor_expired"),
    SID_EXPIRED("sid_expired"),
    ;

    companion object {
        private val byWire = entries.associateBy { it.wireName }
        fun fromWire(value: String): SyncEvent? = byWire[value]
    }
}

object BindingStateMachine {

    private val transitions: Map<BindingState, Map<SyncEvent, BindingState>> = mapOf(
        BindingState.UNBOUND to mapOf(SyncEvent.BIND_SUCCESS to BindingState.BOUND_NEEDS_BOOTSTRAP),
        BindingState.BOUND_NEEDS_BOOTSTRAP to mapOf(SyncEvent.RUN to BindingState.BOOTSTRAPPING),
        BindingState.BOOTSTRAPPING to mapOf(
            SyncEvent.SNAPSHOT_COMPLETE to BindingState.CATCHING_UP,
            SyncEvent.BOOTSTRAP_EXPIRED to BindingState.BOUND_NEEDS_BOOTSTRAP,
        ),
        BindingState.CATCHING_UP to mapOf(SyncEvent.SUCCESS to BindingState.IDLE),
        BindingState.IDLE to mapOf(SyncEvent.TRIGGER to BindingState.RUNNING),
        BindingState.RUNNING to mapOf(
            SyncEvent.SUCCESS to BindingState.IDLE,
            SyncEvent.CONFLICT_ONLY to BindingState.CONFLICTED,
        ),
        BindingState.CONFLICTED to mapOf(
            SyncEvent.CONFLICTS_RESOLVED to BindingState.IDLE,
            SyncEvent.TRIGGER to BindingState.RUNNING,
        ),
        BindingState.REAUTH_REQUIRED to mapOf(SyncEvent.REBIND_SUCCESS to BindingState.BOUND_NEEDS_BOOTSTRAP),
        BindingState.REVOKED to mapOf(SyncEvent.REBIND_SUCCESS to BindingState.BOUND_NEEDS_BOOTSTRAP),
    )

    /**
     * Events that win from any bound state. cursor_expired lands on BOUND_NEEDS_BOOTSTRAP rather
     * than an error state because the mirror is still valid; only the cursor is unusable, and
     * pushing must stop until a fresh snapshot exists.
     */
    private val boundOverrides: Map<SyncEvent, BindingState> = mapOf(
        SyncEvent.REFRESH_INVALID to BindingState.REAUTH_REQUIRED,
        SyncEvent.TOKEN_MISSING to BindingState.REAUTH_REQUIRED,
        SyncEvent.TOKEN_ROTATED to BindingState.REAUTH_REQUIRED,
        SyncEvent.DEVICE_REVOKED to BindingState.REVOKED,
        SyncEvent.ACCOUNT_UNAVAILABLE to BindingState.REVOKED,
        SyncEvent.REGISTRY_INCOMPATIBLE to BindingState.FATAL_INCOMPATIBLE,
        SyncEvent.PROTOCOL_INCOMPATIBLE to BindingState.FATAL_INCOMPATIBLE,
        SyncEvent.CURSOR_EXPIRED to BindingState.BOUND_NEEDS_BOOTSTRAP,
    )

    /**
     * SID expiry is a management-plane event only: the data plane keeps running on the device
     * access credential, so the binding state is deliberately unchanged.
     */
    fun next(current: BindingState, event: SyncEvent): BindingState {
        if (event == SyncEvent.SID_EXPIRED) return current
        if (current != BindingState.UNBOUND) {
            boundOverrides[event]?.let { return it }
        }
        return transitions[current]?.get(event) ?: current
    }

    /** A never-bootstrapped binding must run the snapshot phases before it may push. */
    fun phasesFor(state: BindingState): List<SyncPhase> =
        if (state == BindingState.BOUND_NEEDS_BOOTSTRAP || state == BindingState.BOOTSTRAPPING) {
            SyncContract.firstBindPhases
        } else {
            SyncContract.normalPhases
        }

    /**
     * "立即同步" stays tappable whenever the device is bound, including while conflicted or
     * awaiting re-auth: hiding it is an explicit release blocker in PRODUCT_REQUIREMENTS.md 12.
     */
    fun canRunManualSync(state: BindingState): Boolean =
        state != BindingState.UNBOUND &&
            state != BindingState.REVOKED &&
            state != BindingState.FATAL_INCOMPATIBLE

    /**
     * Automatic rounds additionally require a binding that can authenticate unattended.
     * REAUTH_REQUIRED must not burn background retries, but manual sync still works so the user
     * can surface the re-auth prompt.
     */
    fun canRunAutomaticSync(state: BindingState, automaticEnabled: Boolean): Boolean =
        automaticEnabled && canRunManualSync(state) && state != BindingState.REAUTH_REQUIRED

    /**
     * @param jitter clamped to 0.5..1.5 so a thundering herd cannot form, per SYNC_STATE_MACHINE.md 9.
     */
    fun backoffMs(attempt: Int, jitter: Double = 1.0): Long {
        val steps = SyncContract.retryBackoffMs
        val index = attempt.coerceIn(0, steps.size - 1)
        val clamped = jitter.coerceIn(0.5, 1.5)
        return Math.round(steps[index] * clamped)
    }
}
