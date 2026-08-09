package one.zephyr.mobile.data.session

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.map
import one.zephyr.mobile.model.CapabilitySet
import one.zephyr.mobile.model.Protocol
import one.zephyr.mobile.model.Residency

/**
 * A workspace snapshot row.
 *
 * Only enough to rebuild a *disconnected* tab. Deliberately carries no credential, no scrollback and
 * no command history: SCREEN_CATALOG.md 7 freezes that a workspace restore neither connects nor
 * replays, so anything that would enable a replay has no business being persisted.
 */
data class SessionSnapshot(
    val sessionId: String,
    val connectionId: String,
    val protocol: Protocol,
    val name: String,
    val host: String,
    val port: Int,
    val startedAt: Long,
    val endedAt: Long?,
)

/**
 * The live session list.
 *
 * In-memory and process-scoped on purpose: a session is a transport, and a transport does not
 * survive a process death. The persisted half is [snapshot]/[restore], which produce rows that are
 * explicitly disconnected.
 *
 * Shared by SSH/Telnet and RDP/VNC because S20 is one list across all four protocols. It lives in
 * core-data rather than in a feature module for exactly that reason: two registries would let the
 * session count on the island disagree with the list.
 */
class SessionRegistry {

    private val rowsState = MutableStateFlow<List<SessionRow>>(emptyList())

    val rows: StateFlow<List<SessionRow>> = rowsState.asStateFlow()

    val grouped: Flow<Map<SessionGroup, List<SessionRow>>> = rows.map(SessionGrouping::grouped)

    /** Drives the 会话 badge on the island. Live only: history must not inflate the count. */
    val liveCount: Flow<Int> = rows.map(SessionGrouping::liveCount)

    fun find(sessionId: String): SessionRow? = rowsState.value.firstOrNull { it.sessionId == sessionId }

    fun observe(sessionId: String): Flow<SessionRow?> =
        rows.map { list -> list.firstOrNull { it.sessionId == sessionId } }

    /**
     * Adds or replaces a row.
     *
     * Replacing by id rather than appending is what lets a reconnect keep the same row: the terminal
     * tab holds the sessionId, so a second row with the same id would orphan the open surface.
     */
    fun register(row: SessionRow) = mutate { list ->
        val index = list.indexOfFirst { it.sessionId == row.sessionId }
        if (index < 0) list + row else list.toMutableList().also { it[index] = row }
    }

    fun update(sessionId: String, transform: (SessionRow) -> SessionRow) = mutate { list ->
        list.map { if (it.sessionId == sessionId) transform(it) else it }
    }

    fun setTransport(sessionId: String, transport: SessionTransport, nowMs: Long) =
        update(sessionId) { row ->
            row.copy(
                transport = transport,
                // Latency is a property of a live transport, so it is dropped rather than left to
                // display a stale number next to a dead session.
                latencyMs = if (transport.isLive) row.latencyMs else null,
                endedAt = if (transport == SessionTransport.CLOSED) nowMs else row.endedAt,
                // A row that has actually connected is no longer a workspace placeholder.
                restoredFromWorkspace = if (transport == SessionTransport.CONNECTED) false else row.restoredFromWorkspace,
            )
        }

    fun setLatency(sessionId: String, latencyMs: Long?) = update(sessionId) { it.copy(latencyMs = latencyMs) }

    fun setMinimised(sessionId: String, minimised: Boolean) = update(sessionId) { it.copy(minimised = minimised) }

    /** Called when the user opens the tab: the badge clears, the transport is untouched. */
    fun markRead(sessionId: String) = update(sessionId) { it.copy(unreadOutput = false, minimised = false) }

    fun markOutput(sessionId: String, foreground: Boolean) = update(sessionId) { row ->
        if (foreground) row else row.copy(unreadOutput = true)
    }

    /**
     * ACL revocation.
     *
     * Keeps the row and its capabilities visible but strips the ability to use it, which is what
     * "保留说明但不可恢复" requires. The capability set is replaced with [CapabilitySet.none] so any
     * gate consulted afterwards agrees with the flag.
     */
    fun markRevoked(sessionId: String, reason: String = SessionActions.REASON_REVOKED) =
        update(sessionId) { row ->
            row.copy(
                revoked = true,
                revokedReason = reason,
                capabilities = CapabilitySet.none,
                detail = reason,
            )
        }

    fun setDetail(sessionId: String, detail: String?) = update(sessionId) { it.copy(detail = detail) }

    /** Moves a row to history. The row survives so the user can still read why it ended. */
    fun close(sessionId: String, nowMs: Long, detail: String? = null) = update(sessionId) { row ->
        row.copy(
            transport = SessionTransport.CLOSED,
            minimised = false,
            latencyMs = null,
            endedAt = nowMs,
            unreadOutput = false,
            detail = detail ?: row.detail,
        )
    }

    /**
     * Bulk close.
     *
     * @return the ids actually closed, so the caller can tell the transports to shut down and the
     *   confirmation dialog can report a truthful count.
     */
    fun closeAll(nowMs: Long, sessionIds: Collection<String>? = null): List<String> {
        val target = rowsState.value
            .filter { sessionIds == null || it.sessionId in sessionIds }
            .filter { SessionActions.gate(it, SessionAction.CLOSE).isAllowed }
            .map { it.sessionId }
        for (id in target) close(id, nowMs)
        return target
    }

    /** Removes history rows. Live rows are untouched, so this can never drop a running session. */
    fun clearHistory() = mutate { list -> list.filter { it.transport != SessionTransport.CLOSED } }

    fun remove(sessionId: String) = mutate { list -> list.filterNot { it.sessionId == sessionId } }

    fun clear() {
        rowsState.value = emptyList()
    }

    /** Live rows worth persisting. History is not restored: it would come back as fake tabs. */
    fun snapshot(): List<SessionSnapshot> = rowsState.value
        .filter { it.transport != SessionTransport.CLOSED && !it.revoked }
        .map {
            SessionSnapshot(
                sessionId = it.sessionId,
                connectionId = it.connectionId,
                protocol = it.protocol,
                name = it.name,
                host = it.host,
                port = it.port,
                startedAt = it.startedAt,
                endedAt = it.endedAt,
            )
        }

    /**
     * Rebuilds tabs from a snapshot.
     *
     * Every restored row is [SessionTransport.DISCONNECTED] and carries [SessionRow.restoredFromWorkspace],
     * so the UI offers 重连 as an explicit user action. This is the frozen "不自动连接、不自动重放"
     * rule expressed as a type rather than as a comment.
     *
     * @param capabilitiesFor resolved from the current mirror at restore time, never persisted: a
     *   grant may have been revoked while the app was dead, and a stale capability set would show a
     *   reconnect button that the server would then refuse.
     */
    fun restore(
        snapshots: List<SessionSnapshot>,
        capabilitiesFor: (String) -> CapabilitySet?,
        residencyFor: (String) -> Residency = { Residency.OWNED },
    ) {
        for (snapshot in snapshots) {
            val capabilities = capabilitiesFor(snapshot.connectionId)
            val residency = residencyFor(snapshot.connectionId)
            register(
                SessionRow(
                    sessionId = snapshot.sessionId,
                    connectionId = snapshot.connectionId,
                    protocol = snapshot.protocol,
                    name = snapshot.name,
                    host = snapshot.host,
                    port = snapshot.port,
                    transport = SessionTransport.DISCONNECTED,
                    execution = SessionExecution.LOCAL,
                    capabilities = capabilities ?: CapabilitySet.none,
                    residency = residency,
                    // A connection that vanished or lost its grant while the app was dead comes back
                    // as a revoked tab rather than as a reconnect button that cannot work.
                    revoked = capabilities == null,
                    revokedReason = if (capabilities == null) SessionActions.REASON_REVOKED else null,
                    startedAt = snapshot.startedAt,
                    endedAt = snapshot.endedAt,
                    restoredFromWorkspace = true,
                ),
            )
        }
    }

    private fun mutate(transform: (List<SessionRow>) -> List<SessionRow>) {
        rowsState.value = transform(rowsState.value)
    }
}
