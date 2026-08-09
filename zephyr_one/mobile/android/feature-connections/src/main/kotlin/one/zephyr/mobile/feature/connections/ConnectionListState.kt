package one.zephyr.mobile.feature.connections

import one.zephyr.mobile.model.Connection
import one.zephyr.mobile.model.EmptyReason
import one.zephyr.mobile.model.PageState
import one.zephyr.mobile.model.SyncState

/**
 * The S10 page state, as a pure function.
 *
 * SCREEN_CATALOG.md 2 freezes nine states and MOBILE_EXPERIENCE.md 6 forbids collapsing them into
 * "loading or content". Deriving them here rather than inside the composable is what makes the
 * contract testable: the branch order below *is* the specification, and a test can assert it without
 * an emulator.
 */
object ConnectionListStates {

    /**
     * @param loaded false only before the first mirror emission. A cold flow that has not emitted is
     *   genuinely unknown, which is different from having emitted an empty list.
     * @param online drives the offline branch. Owned rows have a mirror, so offline still shows
     *   content with its age rather than an error (SHARED_RESOURCE_RESIDENCY.md 3).
     * @param bound false when no account is attached yet, which is why an empty library says
     *   "not yet synced" instead of "no data".
     */
    fun derive(
        connections: List<Connection>,
        filter: ConnectionFilter,
        favouriteIds: Set<String> = emptySet(),
        loaded: Boolean = true,
        online: Boolean = true,
        bound: Boolean = true,
        lastSyncedAt: Long? = null,
    ): PageState<List<Connection>> {
        if (!loaded) return PageState.InitialLoading

        val visible = ConnectionFilters.apply(connections, filter, favouriteIds)
        if (visible.isNotEmpty()) {
            // Offline is reported before the pending/conflict banners because it is the stronger
            // statement about the data the user is looking at: it is a mirror, not live.
            if (!online) return PageState.OfflineWithCache(visible, lastSyncedAt)
            return PageState.Content(
                value = visible,
                pendingSync = visible.any { it.syncState == SyncState.PENDING_LOCAL },
                conflict = visible.any { it.syncState == SyncState.CONFLICTED },
            )
        }

        // An empty result with a non-empty library is a filter outcome, not an empty library. The
        // distinction decides whether the screen offers "clear filters" or "create a connection".
        val anyVisibleRow = connections.any { !it.isDeleted }
        return when {
            filter.isActive && anyVisibleRow -> PageState.Empty(EmptyReason.NO_MATCHING_FILTER)
            !bound -> PageState.Empty(EmptyReason.NOT_YET_SYNCED)
            else -> PageState.Empty(EmptyReason.NO_DATA)
        }
    }
}
