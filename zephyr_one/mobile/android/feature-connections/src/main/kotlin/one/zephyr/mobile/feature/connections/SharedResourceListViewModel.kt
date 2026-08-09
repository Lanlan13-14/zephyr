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
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import one.zephyr.mobile.data.repository.SharedResourceSummary
import one.zephyr.mobile.model.PageState
import one.zephyr.mobile.network.ApiResult
import one.zephyr.mobile.network.NetworkState
import one.zephyr.mobile.sync.SharedResourceCoordinator

/**
 * S11 shared-to-me list.
 *
 * The screen that makes the /shared endpoints reachable at all. Before this there was no caller for
 * SharedResourceCoordinator.refresh(), so the store stayed empty even though the coordinator, the
 * client and the three server endpoints all existed.
 *
 * Two things are deliberately different from [ConnectionListViewModel]. There is no local write
 * intent of any kind -- no delete, no favourite, no queued edit -- because a shared resource has no
 * mirror row to write to and no write queue to hold an operation. And the list is fetched rather
 * than observed: [refresh] is called on entry and on pull-to-refresh, because
 * SHARED_RESOURCE_RESIDENCY.md 2 gives these rows no cache that could be observed across a restart.
 */
class SharedResourceListViewModel(
    private val coordinator: SharedResourceCoordinator,
    network: Flow<NetworkState>,
) : ViewModel() {

    private val queryState = MutableStateFlow("")
    private val refreshing = MutableStateFlow(false)
    private val messages = MutableSharedFlow<String>(extraBufferCapacity = 4)

    val query: StateFlow<String> = queryState.asStateFlow()

    /** True while a fetch is in flight, for the pull-to-refresh indicator only. */
    val isRefreshing: StateFlow<Boolean> = refreshing.asStateFlow()

    val message: SharedFlow<String> = messages

    val state: StateFlow<PageState<List<SharedResourceSummary>>> = combine(
        coordinator.resources,
        coordinator.hasLoaded,
        coordinator.error,
        queryState,
        network,
    ) { rows, loaded, error, currentQuery, networkState ->
        SharedResourceListStates.derive(
            resources = rows,
            query = currentQuery,
            loaded = loaded,
            online = networkState.connected,
            error = error,
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(STOP_TIMEOUT_MS), PageState.InitialLoading)

    fun setQuery(value: String) {
        queryState.value = value
    }

    /**
     * Fetches the list.
     *
     * Guarded against overlap: a second call while one is in flight is dropped rather than queued.
     * Two concurrent full-replace refreshes would race on the store, and the loser would install a
     * list the server has already superseded.
     */
    fun refresh() {
        if (refreshing.value) return
        refreshing.value = true
        viewModelScope.launch {
            try {
                val result = coordinator.refresh()
                /* Only a revocation gets a message. Everything else is already visible in the page
                 * state -- a retryable error renders its own banner with a request id, and
                 * duplicating it in a snackbar would report one failure twice. */
                if (result is ApiResult.Failure && result.error.dismissesSharedResource) {
                    messages.tryEmit(MSG_REVOKED)
                }
            } finally {
                /* In a finally block so a cancelled scope cannot strand the spinner: this screen is
                 * refreshed on every entry, and a stuck flag would disable the next pull. */
                refreshing.value = false
            }
        }
    }

    /**
     * Re-reads one row, for when the user opens a detail sheet.
     *
     * Worth doing even though the row is already in memory: the list projection carries only the
     * seven frozen summary properties, and the detail response is where the client learns the grant
     * has been withdrawn since the list was fetched.
     */
    fun refreshOne(summary: SharedResourceSummary) {
        viewModelScope.launch {
            val result = coordinator.refreshOne(summary.resourceType, summary.resourceId)
            if (result is ApiResult.Failure && result.error.dismissesSharedResource) {
                messages.tryEmit(MSG_REVOKED)
            }
        }
    }

    companion object {
        private const val STOP_TIMEOUT_MS = 5_000L

        /* Names the consequence rather than the code. The row is gone from the list because the
         * owner withdrew access, and there is nothing the user can retry. */
        const val MSG_REVOKED = "\u5171\u4eab\u5df2\u88ab\u6536\u56de"

        fun factory(
            coordinator: SharedResourceCoordinator,
            network: Flow<NetworkState>,
        ): ViewModelProvider.Factory = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T =
                SharedResourceListViewModel(coordinator = coordinator, network = network) as T
        }
    }
}
