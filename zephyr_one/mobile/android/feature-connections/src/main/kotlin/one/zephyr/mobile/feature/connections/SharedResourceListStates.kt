package one.zephyr.mobile.feature.connections

import one.zephyr.mobile.contracts.Capability
import one.zephyr.mobile.data.repository.SharedResourceSummary
import one.zephyr.mobile.model.EmptyReason
import one.zephyr.mobile.model.MobileError
import one.zephyr.mobile.model.PageState

/**
 * The shared-to-me list state, as a pure function.
 *
 * Split out from [ConnectionListStates] because the two lists disagree on the one question that
 * matters most here: what offline means. Owned rows have a Room mirror, so offline shows the cache
 * with its age. Shared rows have no mirror at all, so offline is terminal -- there is nothing to
 * fall back on, and rendering a remembered list would be displaying data this device is not allowed
 * to keep (SHARED_RESOURCE_RESIDENCY.md 2-3).
 *
 * That is why this returns [PageState.OfflineNoCache] rather than [PageState.OfflineWithCache], and
 * why there is no `lastSyncedAt` parameter: an age would imply a cache exists.
 */
object SharedResourceListStates {

    /**
     * @param loaded false before the first fetch resolves. Distinct from "fetched and empty":
     *   the first says nothing is known yet, the second says the owner shared nothing.
     * @param online drives the terminal offline branch.
     * @param error the last fetch failure, if any. A revoked or expired grant is not an error the
     *   user can retry, so it resolves to [PageState.NotFoundOrRevoked] instead.
     */
    fun derive(
        resources: List<SharedResourceSummary>,
        query: String = "",
        loaded: Boolean = true,
        online: Boolean = true,
        error: MobileError? = null,
    ): PageState<List<SharedResourceSummary>> {
        /* Offline first, ahead of both the error and the loaded checks.
         *
         * A failed fetch while offline is not a server error and must not be reported as one: the
         * cause is known, and "check your connection" is actionable where a request id is not. */
        if (!online) return PageState.OfflineNoCache

        if (error != null) {
            /* A vanished grant is terminal. Offering retry would invite the user to hammer an
             * endpoint that will keep answering 404 (SHARED_RESOURCE_RESIDENCY.md 3.4). */
            if (error.dismissesSharedResource) return PageState.NotFoundOrRevoked
            return if (error.retryable || error.isRegistryRetryable) {
                PageState.RetryableError(error)
            } else {
                /* Non-retryable and not a revocation: a protocol or contract mismatch. Retry
                 * cannot fix it, so the screen must offer an upgrade path instead. */
                PageState.FatalIncompatible(error)
            }
        }

        if (!loaded) return PageState.InitialLoading

        val visible = filter(resources, query)
        if (visible.isNotEmpty()) {
            /* No pendingSync or conflict flags, ever. Both describe a local write queue, and a
             * shared resource has none: every write goes straight to the owner's main end through
             * invoke, so there is nothing local that could be pending or conflicted. */
            return PageState.Content(visible)
        }

        /* An empty result with a non-empty list is a search outcome, not an empty share set. The
         * difference decides whether the screen offers "clear search" or explains that nobody has
         * shared anything. */
        return PageState.Empty(
            if (query.isNotBlank() && resources.isNotEmpty()) {
                EmptyReason.NO_MATCHING_FILTER
            } else {
                EmptyReason.NO_DATA
            },
        )
    }

    /**
     * Local filtering over the in-memory list.
     *
     * Deliberately not a server query: a search term typed against shared resources would put the
     * owner's resource names into request logs on the main end. Matching in memory keeps the term
     * on this device, and the list is bounded by what one owner shared.
     */
    fun filter(resources: List<SharedResourceSummary>, query: String): List<SharedResourceSummary> {
        val needle = query.trim()
        if (needle.isEmpty()) return resources
        return resources.filter { item ->
            item.displayName.contains(needle, ignoreCase = true) ||
                item.ownerLabel.contains(needle, ignoreCase = true)
        }
    }
}

/**
 * What a shared row is allowed to offer.
 *
 * Client-side gating is presentation only -- the server recomputes every capability on every call
 * (ZEPHYR_PARITY.md 4.2) -- but presenting an action the grant does not carry is its own bug: the
 * user taps it, the server refuses, and the refusal reads as a fault rather than as a boundary.
 */
object SharedResourceActions {

    /**
     * True when the row can be opened at all.
     *
     * VIEW alone is not enough to open a session: it permits seeing that the resource exists.
     */
    fun canOpenSession(summary: SharedResourceSummary): Boolean =
        Capability.USE in summary.capabilities || Capability.OBSERVE in summary.capabilities

    /** Notes are read through invoke; the body never arrives in a list response. */
    fun canReadContent(summary: SharedResourceSummary): Boolean =
        Capability.VIEW in summary.capabilities

    /**
     * True only with an explicit EDIT grant.
     *
     * Never implied by sharing: [one.zephyr.mobile.model.CapabilitySet.implicitShare] carries
     * discover/view/use/observe and nothing else, so a shared note is read-only unless the owner
     * granted edit deliberately.
     */
    fun canEditContent(summary: SharedResourceSummary): Boolean =
        Capability.EDIT in summary.capabilities

    /**
     * Whether opening this resource puts the owner's connection material into this device's memory.
     *
     * Surfaced so the screen can say which of the two happened. A relay session keeps the
     * credential on the main end; a direct session decrypts it here. Both are legitimate, and
     * MOBILE_EXPERIENCE.md forbids implying the stronger guarantee when the weaker one applies.
     */
    fun materialTouchesDevice(summary: SharedResourceSummary): Boolean =
        summary.usePolicy.materialTouchesDevice

    /**
     * Whether the grant is still inside its window.
     *
     * A null expiry means the owner set no deadline, not that the grant expired. Reading it the
     * other way would make every open-ended share look dead.
     */
    fun isWithinGrantWindow(summary: SharedResourceSummary, nowMs: Long): Boolean =
        summary.grantExpiresAt?.let { it > nowMs } ?: true
}
