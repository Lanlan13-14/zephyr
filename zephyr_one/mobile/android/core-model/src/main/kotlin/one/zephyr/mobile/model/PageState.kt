package one.zephyr.mobile.model

import one.zephyr.mobile.contracts.Capability

/**
 * Every list, detail and editor screen implements this contract (SCREEN_CATALOG.md 2).
 * Modelling it as a type stops screens from inventing partial state sets.
 */
sealed interface PageState<out T> {
    data object InitialLoading : PageState<Nothing>

    data class Content<T>(
        val value: T,
        val pendingSync: Boolean = false,
        val conflict: Boolean = false,
        val savingLocal: Boolean = false,
    ) : PageState<T>

    data class Empty(val reason: EmptyReason) : PageState<Nothing>

    /** Owned data has a local mirror, so offline still shows content. */
    data class OfflineWithCache<T>(val value: T, val lastSyncedAt: Long?) : PageState<T>

    /**
     * Shared-to-me resources have no mirror, so offline is terminal for them
     * (SHARED_RESOURCE_RESIDENCY.md).
     */
    data object OfflineNoCache : PageState<Nothing>

    data class PermissionDenied(val missing: Capability, val reason: String?) : PageState<Nothing>

    data object NotFoundOrRevoked : PageState<Nothing>

    data class RetryableError(val error: MobileError) : PageState<Nothing>

    data class FatalIncompatible(val error: MobileError) : PageState<Nothing>

    val isTerminal: Boolean
        get() = this is NotFoundOrRevoked || this is FatalIncompatible || this is OfflineNoCache
}

enum class EmptyReason { NO_DATA, NO_MATCHING_FILTER, NOT_YET_SYNCED }

/** Capability gate outcome for a single action. */
sealed interface ActionGate {
    data object Allowed : ActionGate

    /** Hidden entirely: the user has no business knowing the action exists. */
    data class Hidden(val missing: Capability) : ActionGate

    /** Visible but disabled, with a reason the UI must show. */
    data class Disabled(val missing: Capability, val reason: String) : ActionGate

    val isAllowed: Boolean get() = this is Allowed
    val isVisible: Boolean get() = this !is Hidden
}
