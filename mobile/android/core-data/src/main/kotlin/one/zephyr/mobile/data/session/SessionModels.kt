package one.zephyr.mobile.data.session

import one.zephyr.mobile.contracts.Capability
import one.zephyr.mobile.model.ActionGate
import one.zephyr.mobile.model.CapabilitySet
import one.zephyr.mobile.model.Protocol
import one.zephyr.mobile.model.Residency

/**
 * Transport-level session state.
 *
 * Deliberately *only* transport: "已最小化" and "ACL 已撤销" are not transport states, they are
 * orthogonal flags, and folding them into this enum is what would make a minimised-and-disconnected
 * session appear in two groups of the S20 list at once.
 */
enum class SessionTransport {
    /** Handshake, auth, host-key decision, jump chain. */
    CONNECTING,

    CONNECTED,

    /**
     * The transport dropped but the session record survives, so 重连 is offered.
     *
     * SCREEN_CATALOG.md 7 calls this 断线可恢复. It is distinct from [CLOSED] because a closed
     * session is history and must never offer a reconnect that silently makes a new session.
     */
    DISCONNECTED,

    /** Ended by the user, by the peer, or by a fatal error. Terminal. */
    CLOSED,
    ;

    val isLive: Boolean get() = this == CONNECTING || this == CONNECTED
}

/**
 * The five S20 groups.
 *
 * Ordered as the spec lists them, because [SessionGrouping.grouped] renders in enum order and a
 * reordering here would silently reorder the screen.
 */
enum class SessionGroup {
    CONNECTING,
    CONNECTED,
    RESUMABLE,
    MINIMISED,
    HISTORY,
}

/**
 * Where the bytes actually flow.
 *
 * SCREEN_CATALOG.md 7 requires the row to state 本地/主端执行, and 2.1 explains why: a shared
 * connection may be relayed by the main end with the credential never reaching this device, or run
 * natively with connection material in session memory. The user is entitled to know which.
 */
enum class SessionExecution {
    /** Native transport opened by this device. */
    LOCAL,

    /** Main-end relay; credentials stay on the server. */
    RELAY,
}

/**
 * One row of the S20 session list.
 *
 * A value type with no engine handle: the list must be able to render a session whose engine is
 * blocked or already gone, and a screen holding a live transport reference would keep a dead
 * session's buffers alive.
 *
 * @param sessionId stable for the lifetime of the row, including after a reconnect, so the S20 row
 *   and the terminal tab cannot disagree about identity.
 * @param revokedReason set together with [revoked]. SCREEN_CATALOG.md 7 freezes the wire value
 *   `resource_revoked`, and the row must keep explaining itself after it stops being restorable.
 */
data class SessionRow(
    val sessionId: String,
    val connectionId: String,
    val protocol: Protocol,
    val name: String,
    val host: String,
    val port: Int,
    val transport: SessionTransport,
    val execution: SessionExecution,
    val capabilities: CapabilitySet,
    val residency: Residency = Residency.OWNED,
    val minimised: Boolean = false,
    val revoked: Boolean = false,
    val revokedReason: String? = null,
    val startedAt: Long = 0L,
    val endedAt: Long? = null,
    /** Last measured round trip. Null while connecting or once the transport is gone. */
    val latencyMs: Long? = null,
    /** Unread output since the user last looked, for the session badge (TERMINAL_EXPERIENCE.md 9). */
    val unreadOutput: Boolean = false,
    /** True when this row came back from a persisted workspace and has never been connected. */
    val restoredFromWorkspace: Boolean = false,
    val detail: String? = null,
) {
    val displayAddress: String get() = host + ":" + port

    /**
     * Which group the row belongs to.
     *
     * Checked in a fixed order so every row lands in exactly one group. History wins over minimised
     * because a closed session is no longer a live tab, and minimised wins over disconnected because
     * the user's own explicit action is the more informative fact.
     */
    val group: SessionGroup
        get() = when {
            transport == SessionTransport.CLOSED -> SessionGroup.HISTORY
            minimised -> SessionGroup.MINIMISED
            transport == SessionTransport.DISCONNECTED -> SessionGroup.RESUMABLE
            transport == SessionTransport.CONNECTING -> SessionGroup.CONNECTING
            else -> SessionGroup.CONNECTED
        }

    /**
     * Whether the tab can be brought back at all.
     *
     * A revoked tab is explicitly *not* restorable even though it is still in the list: the frozen
     * rule is that it keeps its explanation and loses its actions.
     */
    val restorable: Boolean
        get() = !revoked && transport != SessionTransport.CLOSED

    /** Wall-clock duration, for the row's 延迟/时长 column once latency is meaningless. */
    fun durationMs(nowMs: Long): Long = (endedAt ?: nowMs) - startedAt
}

/** The row actions from SCREEN_CATALOG.md 7. */
enum class SessionAction {
    /** Bring a minimised or backgrounded tab back to the foreground. Opens no transport. */
    RESTORE,

    /** Open a new transport for a session that dropped, keeping the same row identity. */
    RECONNECT,

    CLOSE,

    DETAILS,
}

/**
 * Capability and state gating for session rows.
 *
 * The two interesting rules both come from SCREEN_CATALOG.md 7: a revoked tab is disabled *with its
 * reason* rather than hidden, and 恢复 is not the same action as 重连 - conflating them is how a
 * "restore" ends up dialling a host the user did not ask to dial.
 */
object SessionActions {

    fun gate(row: SessionRow, action: SessionAction): ActionGate = when (action) {
        // Restoring is a pure UI move, so it needs no capability - only a live-or-resumable row.
        SessionAction.RESTORE -> when {
            row.revoked -> ActionGate.Disabled(Capability.USE, reasonFor(row))
            row.transport == SessionTransport.CLOSED -> ActionGate.Hidden(Capability.USE)
            else -> ActionGate.Allowed
        }

        // Reconnecting opens a transport, so the grant must still be there. A revoked grant is the
        // common case and gets the explicit reason rather than a vanished button.
        SessionAction.RECONNECT -> when {
            row.revoked -> ActionGate.Disabled(Capability.USE, reasonFor(row))
            !row.capabilities.canUse -> ActionGate.Disabled(Capability.USE, REASON_USE_REVOKED)
            row.transport == SessionTransport.CONNECTED -> ActionGate.Hidden(Capability.USE)
            row.transport == SessionTransport.CONNECTING -> ActionGate.Hidden(Capability.USE)
            else -> ActionGate.Allowed
        }

        // Closing is always permitted on a live row: the user must be able to end a session even
        // after the grant is gone, otherwise a revoked tab could not be dismissed.
        SessionAction.CLOSE ->
            if (row.transport == SessionTransport.CLOSED) ActionGate.Hidden(Capability.USE)
            else ActionGate.Allowed

        SessionAction.DETAILS -> ActionGate.Allowed
    }

    fun visibleActions(row: SessionRow): List<SessionAction> =
        SessionAction.entries.filter { gate(row, it).isVisible }

    /**
     * Disclosure for a shared session.
     *
     * Mirrors the connection-library disclosure so the same connection cannot be described one way
     * before connecting and another way afterwards (SCREEN_CATALOG.md 2.1).
     */
    fun executionDisclosure(row: SessionRow): String? {
        if (row.residency != Residency.SHARED_ONLINE_ONLY) return null
        return when (row.execution) {
            SessionExecution.RELAY -> DISCLOSURE_RELAY
            SessionExecution.LOCAL -> DISCLOSURE_DIRECT
        }
    }

    private fun reasonFor(row: SessionRow): String = row.revokedReason ?: REASON_REVOKED

    /** The frozen wire reason for a revoked tab. */
    const val WIRE_RESOURCE_REVOKED = "resource_revoked"

    const val REASON_REVOKED = "资源权限已撤销，此标签保留说明但不能恢复"
    const val REASON_USE_REVOKED = "已失去该连接的使用权限"
    const val DISCLOSURE_RELAY = "主端 relay：凭据保留在主端"
    const val DISCLOSURE_DIRECT = "本次原生直连：加密连接材料仅驻留会话内存"
}

/** Grouping for the S20 list. */
object SessionGrouping {

    /**
     * Groups and orders the rows.
     *
     * Live rows sort oldest-first so a long-running session keeps its place in the list instead of
     * jumping whenever a new one appears; history sorts newest-first because the most recently
     * closed session is the one a user looks for.
     */
    fun grouped(rows: List<SessionRow>): Map<SessionGroup, List<SessionRow>> {
        val byGroup = rows.groupBy { it.group }
        val result = LinkedHashMap<SessionGroup, List<SessionRow>>()
        for (group in SessionGroup.entries) {
            val bucket = byGroup[group] ?: continue
            if (bucket.isEmpty()) continue
            result[group] = if (group == SessionGroup.HISTORY) {
                bucket.sortedByDescending { it.endedAt ?: it.startedAt }
            } else {
                bucket.sortedBy { it.startedAt }
            }
        }
        return result
    }

    fun liveCount(rows: List<SessionRow>): Int = rows.count { it.transport.isLive }

    /** Rows a bulk close would actually affect, so the confirmation can state a real number. */
    fun closableRows(rows: List<SessionRow>): List<SessionRow> =
        rows.filter { SessionActions.gate(it, SessionAction.CLOSE).isAllowed }

    fun unreadCount(rows: List<SessionRow>): Int = rows.count { it.unreadOutput && it.transport.isLive }
}
