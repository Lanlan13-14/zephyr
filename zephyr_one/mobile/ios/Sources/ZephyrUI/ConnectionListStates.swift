import Foundation

/// The S10 page state, as a pure function.
///
/// SCREEN_CATALOG.md 2 freezes nine states and MOBILE_EXPERIENCE.md 6 forbids
/// collapsing them into "loading or content". Deriving them here rather than
/// inside the view is what makes the contract testable: the branch order below
/// *is* the specification, and a test can assert it without a simulator.
public enum ConnectionListStates {

    /// - Parameters:
    ///   - loaded: false only before the first mirror emission. A cold store
    ///     that has not answered is genuinely unknown, which is different from
    ///     having answered with an empty list.
    ///   - online: drives the offline branch. Owned rows have a mirror, so
    ///     offline still shows content with its age rather than an error
    ///     (SHARED_RESOURCE_RESIDENCY.md 3).
    ///   - bound: false when no account is attached yet, which is why an empty
    ///     library says "not yet synced" instead of "no data".
    public static func derive(
        connections: [Connection],
        filter: ConnectionFilter,
        favouriteIds: Set<String> = [],
        loaded: Bool = true,
        online: Bool = true,
        bound: Bool = true,
        lastSyncedAt: Int64? = nil
    ) -> PageState<[Connection]> {
        if !loaded { return .initialLoading }

        let visible = ConnectionFilters.apply(connections, filter: filter, favouriteIds: favouriteIds)
        if !visible.isEmpty {
            // Offline is reported before the pending/conflict banners because
            // it is the stronger statement about the data the user is looking
            // at: it is a mirror, not live.
            if !online { return .offlineWithCache(value: visible, lastSyncedAt: lastSyncedAt) }
            return .content(
                visible,
                pendingSync: visible.contains { $0.syncState == .pendingLocal },
                conflict: visible.contains { $0.syncState == .conflicted }
            )
        }

        // An empty result with a non-empty library is a filter outcome, not an
        // empty library. The distinction decides whether the screen offers
        // "clear filters" or "create a connection".
        let anyVisibleRow = connections.contains { !$0.isDeleted }
        if filter.isActive && anyVisibleRow { return .empty(.noMatchingFilter) }
        if !bound { return .empty(.notYetSynced) }
        return .empty(.noData)
    }
}
