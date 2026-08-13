package one.zephyr.mobile.feature.connections

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.onStart
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import one.zephyr.mobile.data.LocalWriteRejected
import one.zephyr.mobile.data.repository.ConnectionRepository
import one.zephyr.mobile.data.repository.SettingsRepository
import one.zephyr.mobile.data.repository.SharedResourceStore
import one.zephyr.mobile.data.repository.SharedResourceSummary
import one.zephyr.mobile.model.Connection
import one.zephyr.mobile.model.PageState
import one.zephyr.mobile.model.Protocol
import one.zephyr.mobile.model.SyncStatus
import one.zephyr.mobile.network.NetworkState

/**
 * S10 首页/连接库.
 *
 * Unidirectional by construction: the only mutable state is the filter and the only writes go
 * through the repository, so the rendered [PageState] is always a pure function of the mirror plus
 * the filter (SCREEN_CATALOG.md 27.2).
 *
 * The owned list and the shared list are merged here rather than in the repository because they have
 * different lifetimes: owned rows come from the Room mirror and survive offline, shared rows live
 * only in memory for as long as the grant is fresh (SHARED_RESOURCE_RESIDENCY.md 2).
 */
class ConnectionListViewModel(
    private val connections: ConnectionRepository,
    private val settings: SettingsRepository,
    private val shared: SharedResourceStore,
    private val ownerUserId: String,
    syncStatus: Flow<SyncStatus>,
    network: Flow<NetworkState>,
    private val localMode: Boolean,
    private val syncNowAction: suspend () -> Unit,
    private val clock: () -> Long = System::currentTimeMillis,
) : ViewModel() {

    private val filterState = MutableStateFlow(ConnectionFilter())
    val filter: StateFlow<ConnectionFilter> = filterState.asStateFlow()

    private val messages = MutableSharedFlow<String>(extraBufferCapacity = 4)

    /** One-shot user feedback. Local-first wording, never a network verdict. */
    val message: SharedFlow<String> = messages

    private val favourites: Flow<Set<String>> = settings.observePreferences()
        .map { FavouriteConnections.decode(it[FavouriteConnections.PREFERENCE_KEY]) }

    /**
     * Owned plus shared, as one list.
     *
     * [onStart] emits nothing; the null sentinel is what distinguishes "the mirror has not answered
     * yet" from "the mirror is empty", which is the difference between InitialLoading and Empty.
     */
    private val merged: Flow<List<Connection>?> =
        combine<List<Connection>, List<SharedResourceSummary>, List<Connection>?>(
            connections.observeAll(ownerUserId),
            shared.resources,
        ) { owned, sharedSummaries ->
            owned + SharedConnectionRows.rowsFrom(sharedSummaries, ownerUserId)
        }.onStart { emit(null) }

    val state: StateFlow<PageState<List<Connection>>> = combine(
        merged,
        favourites,
        filterState,
        syncStatus,
        network,
    ) { rows, favouriteIds, currentFilter, status, networkState ->
        ConnectionListStates.derive(
            connections = rows ?: emptyList(),
            filter = currentFilter,
            favouriteIds = favouriteIds,
            loaded = rows != null,
            online = networkState.connected,
            bound = localMode || status.bindingState.isBound,
            lastSyncedAt = status.lastSuccessAt,
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(STOP_TIMEOUT_MS), PageState.InitialLoading)

    /** The recents strip is derived from the same rows so it can never disagree with the list. */
    val recents: StateFlow<List<Connection>> = merged
        .map { rows -> ConnectionFilters.recents(rows ?: emptyList()) }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(STOP_TIMEOUT_MS), emptyList())

    val availableTags: StateFlow<List<String>> = merged
        .map { rows -> ConnectionFilters.availableTags(rows ?: emptyList()) }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(STOP_TIMEOUT_MS), emptyList())

    val favouriteIds: StateFlow<Set<String>> = favourites
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(STOP_TIMEOUT_MS), emptySet())

    // ---- filter intents ----------------------------------------------------------------------

    fun setQuery(query: String) {
        filterState.value = filterState.value.copy(query = query)
    }

    fun toggleProtocol(protocol: Protocol) {
        filterState.value = filterState.value.withProtocolToggled(protocol)
    }

    fun toggleTag(tag: String) {
        filterState.value = filterState.value.withTagToggled(tag)
    }

    fun setOwnership(facet: OwnershipFacet) {
        filterState.value = filterState.value.copy(ownership = facet)
    }

    fun setFavouritesOnly(enabled: Boolean) {
        filterState.value = filterState.value.copy(favouritesOnly = enabled)
    }

    /** Keeps the query: clearing facets while wiping what the user typed reads as a bug. */
    fun clearFilters() {
        filterState.value = filterState.value.cleared()
    }

    // ---- write intents -----------------------------------------------------------------------

    fun toggleFavourite(connectionId: String) {
        viewModelScope.launch {
            val current = FavouriteConnections.decode(settings.preference(FavouriteConnections.PREFERENCE_KEY))
            settings.putPreference(
                key = FavouriteConnections.PREFERENCE_KEY,
                value = FavouriteConnections.encode(FavouriteConnections.toggled(current, connectionId)),
                nowMs = clock(),
            )
        }
    }

    /**
     * Deletes one connection.
     *
     * The confirmation is the screen's job; by the time this runs the user has already agreed. The
     * completion wording is local-first: the row is gone from this device and the tombstone is
     * queued, which is true whether or not the network is up.
     */
    fun delete(connection: Connection) {
        viewModelScope.launch {
            runCatching { connections.delete(connection, ownerUserId) }
                .onSuccess { messages.tryEmit(MSG_DELETED) }
                .onFailure { failure ->
                    messages.tryEmit(
                        if (failure is LocalWriteRejected) MSG_DELETE_DENIED else MSG_DELETE_FAILED,
                    )
                }
        }
    }

    fun syncNow() {
        viewModelScope.launch { runCatching { syncNowAction() } }
    }

    companion object {
        private const val STOP_TIMEOUT_MS = 5_000L

        const val MSG_DELETED = "已删除，待同步"
        const val MSG_DELETE_DENIED = "你没有删除此连接的权限"
        const val MSG_DELETE_FAILED = "删除未完成，请重试"

        fun factory(
            connections: ConnectionRepository,
            settings: SettingsRepository,
            shared: SharedResourceStore,
            ownerUserId: String,
            syncStatus: Flow<SyncStatus>,
            network: Flow<NetworkState>,
            localMode: Boolean = false,
            syncNowAction: suspend () -> Unit,
        ): ViewModelProvider.Factory = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T = ConnectionListViewModel(
                connections = connections,
                settings = settings,
                shared = shared,
                ownerUserId = ownerUserId,
                syncStatus = syncStatus,
                network = network,
                localMode = localMode,
                syncNowAction = syncNowAction,
            ) as T
        }
    }
}
