package one.zephyr.mobile.feature.sessions

import one.zephyr.mobile.data.session.SessionGroup
import one.zephyr.mobile.data.session.SessionGrouping
import one.zephyr.mobile.data.session.SessionRow
import one.zephyr.mobile.model.EmptyReason
import one.zephyr.mobile.model.PageState

/**
 * What S20 renders.
 *
 * Carries the grouped map rather than a flat list so the screen cannot regroup and disagree with
 * [SessionGrouping]. The counts travel with it because the bulk-close confirmation must state a
 * truthful number and the island badge must not count history.
 */
data class SessionListContent(
    val groups: Map<SessionGroup, List<SessionRow>>,
    val liveCount: Int,
    val closableCount: Int,
    val unreadCount: Int,
    /** False while offline: a resumable tab cannot dial, so 重连 is disabled with a reason. */
    val online: Boolean,
) {
    val total: Int get() = groups.values.sumOf { it.size }
}

/**
 * Page state for the session list.
 *
 * SCREEN_CATALOG.md 2 requires every list to implement the frozen state contract, but sessions are
 * process-local runtime state rather than mirrored entities, so only a subset can actually occur:
 * there is no pending-sync, no conflict and no permission-denied for the *list* itself. Rather than
 * fabricate unreachable branches, this derives exactly the three that can happen and lets the row
 * gates carry the per-row capability story.
 */
object SessionListStates {

    /**
     * @param restoreComplete false only during app start, while the persisted workspace is still
     *   being read. Without it an empty registry would render 无会话 for a frame and then flash the
     *   restored tabs in, which reads as a bug.
     */
    fun derive(
        rows: List<SessionRow>,
        restoreComplete: Boolean,
        online: Boolean,
    ): PageState<SessionListContent> {
        if (!restoreComplete) return PageState.InitialLoading
        if (rows.isEmpty()) return PageState.Empty(EmptyReason.NO_DATA)
        return PageState.Content(
            SessionListContent(
                groups = SessionGrouping.grouped(rows),
                liveCount = SessionGrouping.liveCount(rows),
                closableCount = SessionGrouping.closableRows(rows).size,
                unreadCount = SessionGrouping.unreadCount(rows),
                online = online,
            ),
        )
    }

    /** Chinese group headers. Kept beside the derivation so a group cannot ship without a label. */
    fun labelFor(group: SessionGroup): String = when (group) {
        SessionGroup.CONNECTING -> "连接中"
        SessionGroup.CONNECTED -> "已连接"
        SessionGroup.RESUMABLE -> "断线可恢复"
        SessionGroup.MINIMISED -> "已最小化"
        SessionGroup.HISTORY -> "历史任务"
    }
}
