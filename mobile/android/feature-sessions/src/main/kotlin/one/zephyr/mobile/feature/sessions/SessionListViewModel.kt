package one.zephyr.mobile.feature.sessions

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import one.zephyr.mobile.data.repository.ConnectionRepository
import one.zephyr.mobile.data.session.SessionAction
import one.zephyr.mobile.data.session.SessionActions
import one.zephyr.mobile.data.session.SessionRegistry
import one.zephyr.mobile.data.session.SessionRow
import one.zephyr.mobile.data.session.SessionSnapshot
import one.zephyr.mobile.model.Connection
import one.zephyr.mobile.model.PageState
import one.zephyr.mobile.network.NetworkState

/**
 * Where a row action wants to go.
 *
 * Navigation is an event rather than a call so the ViewModel never opens a transport: the frozen rule
 * in SCREEN_CATALOG.md 7 is that restoring a workspace connects nothing, and a list that could dial
 * would be one refactor away from breaking it. [Reconnect] therefore carries an *intent* that the
 * terminal screen acts on after the user is looking at it.
 */
sealed interface SessionListEvent {
    data class OpenTerminal(val sessionId: String, val connectionId: String) : SessionListEvent
    data class OpenRemote(val sessionId: String, val connectionId: String) : SessionListEvent
    data class Reconnect(val sessionId: String, val connectionId: String) : SessionListEvent
    data class Details(val sessionId: String) : SessionListEvent
}

/**
 * S20 会话列表.
 *
 * Owns no transport. Closing a session is delegated to [closeTransport] because the registry is a
 * list of rows, not a list of sockets, and the row must disappear from 已连接 even if the socket
 * teardown fails.
 */
class SessionListViewModel(
    private val registry: SessionRegistry,
    /**
     * Resolves one connection from the mirror.
     *
     * Narrowed from ConnectionRepository to the single lookup this class performs, so restoring a
     * workspace is unit testable without a database. The Factory still takes the repository, so the
     * host wiring is unchanged and the narrowing cannot leak into the app module.
     */
    private val findConnection: suspend (String) -> Connection?,
    private val ownerUserId: String,
    network: Flow<NetworkState>,
    private val closeTransport: suspend (SessionRow) -> Unit,
    private val loadWorkspace: suspend () -> List<SessionSnapshot> = { emptyList() },
    private val clock: () -> Long = System::currentTimeMillis,
) : ViewModel() {

    private val restoreComplete = MutableStateFlow(false)

    private val events = MutableSharedFlow<SessionListEvent>(extraBufferCapacity = 4)
    val event: SharedFlow<SessionListEvent> = events

    private val messages = MutableSharedFlow<String>(extraBufferCapacity = 4)
    val message: SharedFlow<String> = messages

    /** Rows the user selected for a bulk close. Kept here so a recomposition cannot lose it. */
    private val selectionState = MutableStateFlow<Set<String>>(emptySet())
    val selection: StateFlow<Set<String>> = selectionState

    val state: StateFlow<PageState<SessionListContent>> = combine(
        registry.rows,
        restoreComplete,
        network,
    ) { rows, restored, networkState ->
        SessionListStates.derive(rows = rows, restoreComplete = restored, online = networkState.connected)
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(STOP_TIMEOUT_MS), PageState.InitialLoading)

    init {
        // Restoring is the only thing this ViewModel does unprompted, and it deliberately produces
        // disconnected rows: capabilities are resolved from the current mirror so a grant revoked
        // while the app was dead comes back as a revoked tab, not as a button that cannot work.
        viewModelScope.launch {
            val snapshots = runCatching { loadWorkspace() }.getOrDefault(emptyList())
            if (snapshots.isNotEmpty()) {
                val resolved = snapshots.associate { snapshot ->
                    snapshot.connectionId to findConnection(snapshot.connectionId)
                }
                registry.restore(
                    snapshots = snapshots,
                    capabilitiesFor = { id -> resolved[id]?.capabilities },
                    residencyFor = { id -> resolved[id]?.residency ?: one.zephyr.mobile.model.Residency.OWNED },
                )
            }
            restoreComplete.value = true
        }
    }

    // ---- row actions -----------------------------------------------------------------------------

    /**
     * A row action.
     *
     * The gate is re-checked here rather than trusted from the screen: the row may have been revoked
     * between the render and the tap, and a disabled button is a presentation detail, not a
     * permission check.
     */
    fun onAction(row: SessionRow, action: SessionAction) {
        val gate = SessionActions.gate(row, action)
        if (!gate.isAllowed) {
            messages.tryEmit(reasonOf(gate))
            return
        }
        when (action) {
            SessionAction.RESTORE -> {
                registry.markRead(row.sessionId)
                events.tryEmit(navigationFor(row))
            }
            SessionAction.RECONNECT -> events.tryEmit(
                SessionListEvent.Reconnect(row.sessionId, row.connectionId),
            )
            SessionAction.CLOSE -> close(row)
            SessionAction.DETAILS -> events.tryEmit(SessionListEvent.Details(row.sessionId))
        }
    }

    private fun navigationFor(row: SessionRow): SessionListEvent =
        if (row.protocol.isRemoteDesktop) {
            SessionListEvent.OpenRemote(row.sessionId, row.connectionId)
        } else {
            SessionListEvent.OpenTerminal(row.sessionId, row.connectionId)
        }

    /**
     * Closes one session.
     *
     * The row moves to history first and the transport is torn down afterwards: a socket that hangs
     * on close must not leave a session sitting in 已连接 that the user cannot get rid of.
     */
    fun close(row: SessionRow) {
        registry.close(row.sessionId, clock())
        selectionState.value = selectionState.value - row.sessionId
        viewModelScope.launch { runCatching { closeTransport(row) } }
    }

    // ---- bulk close ------------------------------------------------------------------------------

    fun toggleSelection(sessionId: String) {
        val current = selectionState.value
        selectionState.value = if (sessionId in current) current - sessionId else current + sessionId
    }

    fun clearSelection() {
        selectionState.value = emptySet()
    }

    /**
     * Bulk close, after the confirmation the spec requires.
     *
     * @param sessionIds null closes every closable row. The registry decides what is actually
     *   closable, so a history row already in the selection cannot be double-closed.
     */
    fun closeAll(sessionIds: Collection<String>? = null) {
        val rows = registry.rows.value
        val closed = registry.closeAll(clock(), sessionIds)
        selectionState.value = emptySet()
        viewModelScope.launch {
            for (id in closed) {
                val row = rows.firstOrNull { it.sessionId == id } ?: continue
                runCatching { closeTransport(row) }
            }
        }
    }

    fun clearHistory() = registry.clearHistory()

    /** Persisted by the host on stop. Live rows only; history would come back as fake tabs. */
    fun snapshot(): List<SessionSnapshot> = registry.snapshot()

    private fun reasonOf(gate: one.zephyr.mobile.model.ActionGate): String = when (gate) {
        is one.zephyr.mobile.model.ActionGate.Disabled -> gate.reason
        is one.zephyr.mobile.model.ActionGate.Hidden -> SessionActions.REASON_USE_REVOKED
        one.zephyr.mobile.model.ActionGate.Allowed -> ""
    }

    class Factory(
        private val registry: SessionRegistry,
        private val connections: ConnectionRepository,
        private val ownerUserId: String,
        private val network: Flow<NetworkState>,
        private val closeTransport: suspend (SessionRow) -> Unit,
        private val loadWorkspace: suspend () -> List<SessionSnapshot> = { emptyList() },
    ) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T = SessionListViewModel(
            registry = registry,
            findConnection = { id -> connections.find(id) },
            ownerUserId = ownerUserId,
            network = network,
            closeTransport = closeTransport,
            loadWorkspace = loadWorkspace,
        ) as T
    }

    private companion object {
        const val STOP_TIMEOUT_MS = 5_000L
    }
}
