import Combine
import Foundation

/// S10 首页/连接库.
///
/// Unidirectional by construction: the only mutable state is the filter and
/// the snapshot inputs, and the rendered ``PageState`` is always a pure
/// function of the mirror plus the filter (SCREEN_CATALOG.md 27.2).
///
/// The owned list and the shared list are merged here rather than in the store
/// because they have different lifetimes: owned rows come from the local
/// mirror and survive offline, shared rows live only in memory for as long as
/// the grant is fresh (SHARED_RESOURCE_RESIDENCY.md 2).
public final class ConnectionListViewModel: ObservableObject {

    @Published public private(set) var state: PageState<[Connection]> = .initialLoading
    @Published public private(set) var recents: [Connection] = []
    @Published public private(set) var availableTags: [String] = []
    @Published public private(set) var favouriteIds: Set<String> = []
    @Published public var filter = ConnectionFilter() {
        didSet { recompute() }
    }

    /// One-shot user feedback. Local-first wording, never a network verdict.
    /// The screen consumes and clears it.
    @Published public private(set) var message: String?

    /* Snapshot inputs. The app layer pushes mirror emissions in through the
     * update methods; the nil sentinel on `ownedRows` is what distinguishes
     * "the mirror has not answered yet" from "the mirror is empty", which is
     * the difference between initialLoading and empty. */
    private var ownedRows: [Connection]?
    private var sharedRows: [SharedResourceSummary] = []
    private var online = true
    private var bound = true
    private var lastSyncedAt: Int64?

    private let ownerUserId: String
    private let connections: ConnectionStore?
    private let preferences: PreferenceStore?
    private let syncNowAction: (() async -> Void)?

    /// Manual sync is optional. Local browsing and writes never depend on it.
    public var canSync: Bool { syncNowAction != nil }
    public var canDeleteLocally: Bool { connections != nil }

    public init(
        ownerUserId: String,
        connections: ConnectionStore? = nil,
        preferences: PreferenceStore? = nil,
        syncNowAction: (() async -> Void)? = nil
    ) {
        self.ownerUserId = ownerUserId
        self.connections = connections
        self.preferences = preferences
        self.syncNowAction = syncNowAction
        if let preferences {
            favouriteIds = FavouriteConnections.decode(preferences.preference(FavouriteConnections.preferenceKey))
        }
    }

    // ---- snapshot inputs ------------------------------------------------------

    public func updateOwnedRows(_ rows: [Connection]?) {
        ownedRows = rows
        recompute()
    }

    public func updateSharedRows(_ rows: [SharedResourceSummary]) {
        sharedRows = rows
        recompute()
    }

    public func updateConnectivity(online: Bool) {
        self.online = online
        recompute()
    }

    public func updateBinding(bound: Bool, lastSyncedAt: Int64?) {
        self.bound = bound
        self.lastSyncedAt = lastSyncedAt
        recompute()
    }

    public func updateFavourites(_ ids: Set<String>) {
        favouriteIds = ids
        recompute()
    }

    private func mergedRows() -> [Connection]? {
        guard let ownedRows else { return nil }
        return ownedRows + SharedConnectionRows.rowsFrom(sharedRows, ownerUserId: ownerUserId)
    }

    private func recompute() {
        let rows = mergedRows()
        /* The recents strip and the tag facets are derived from the same rows
         * so they can never disagree with the list. */
        state = ConnectionListStates.derive(
            connections: rows ?? [],
            filter: filter,
            favouriteIds: favouriteIds,
            loaded: rows != nil,
            online: online,
            bound: bound,
            lastSyncedAt: lastSyncedAt
        )
        recents = ConnectionFilters.recents(rows ?? [])
        availableTags = ConnectionFilters.availableTags(rows ?? [])
    }

    // ---- filter intents ---------------------------------------------------------

    public func setQuery(_ query: String) {
        filter.query = query
    }

    public func toggleProtocol(_ value: ConnectionProtocol) {
        filter = filter.withProtocolToggled(value)
    }

    public func toggleTag(_ tag: String) {
        filter = filter.withTagToggled(tag)
    }

    public func setOwnership(_ facet: OwnershipFacet) {
        filter.ownership = facet
    }

    public func setFavouritesOnly(_ enabled: Bool) {
        filter.favouritesOnly = enabled
    }

    public func clearFilters() {
        filter = filter.cleared()
    }

    /// Empty-search recovery clears both the query and facets. The normal
    /// facet reset deliberately preserves the query while this intent cannot.
    public func resetSearchAndFilters() {
        filter = ConnectionFilter()
    }

    // ---- write intents -----------------------------------------------------------

    public func toggleFavourite(_ connectionId: String) {
        let next = FavouriteConnections.toggled(favouriteIds, connectionId: connectionId)
        preferences?.putPreference(FavouriteConnections.preferenceKey, FavouriteConnections.encode(next))
        favouriteIds = next
        recompute()
    }

    /// Deletes one connection.
    ///
    /// The confirmation is the screen's job; by the time this runs the user
    /// has already agreed. The completion wording is local-first: the row is
    /// gone from this device and the tombstone is queued, which is true
    /// whether or not the network is up.
    public func delete(_ connection: Connection) async {
        guard let connections else {
            message = ConnectionListViewModel.msgDeleteUnavailable
            return
        }
        do {
            try await connections.delete(connection, ownerUserId: ownerUserId)
            message = ConnectionListViewModel.msgDeleted
        } catch is LocalWriteRejected {
            message = ConnectionListViewModel.msgDeleteDenied
        } catch {
            message = ConnectionListViewModel.msgDeleteFailed
        }
    }

    public func syncNow() async {
        await syncNowAction?()
    }

    public func consumeMessage() {
        message = nil
    }

    public static let msgDeleted = "已删除，待同步"
    public static let msgDeleteUnavailable = "此版本未配置本地连接存储，无法删除"
    public static let msgDeleteDenied = "你没有删除此连接的权限"
    public static let msgDeleteFailed = "删除未完成，请重试"
}
