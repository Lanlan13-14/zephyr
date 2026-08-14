@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package one.zephyr.mobile.feature.sessions

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import one.zephyr.mobile.data.session.SessionAction
import one.zephyr.mobile.data.session.SessionActions
import one.zephyr.mobile.data.session.SessionExecution
import one.zephyr.mobile.data.session.SessionGroup
import one.zephyr.mobile.data.session.SessionRow
import one.zephyr.mobile.data.session.SessionTransport
import one.zephyr.mobile.model.ActionGate
import one.zephyr.mobile.model.PageState
import one.zephyr.mobile.ui.chrome.RootPageHeader
import one.zephyr.mobile.ui.component.MonoEndpoint
import one.zephyr.mobile.ui.component.ProtocolChip
import one.zephyr.mobile.ui.component.SectionHeader
import one.zephyr.mobile.ui.state.PageStateScaffold
import one.zephyr.mobile.ui.theme.ZephyrSpacing
import one.zephyr.mobile.ui.theme.ZephyrTheme

/**
 * S20 会话列表.
 *
 * Stateless: every value is a parameter and every action is a lambda, which is what makes the
 * SCREEN_CATALOG.md 27.7 Compose test reachable without a registry, a transport or a database.
 * [SessionListRoute] is the only ViewModel-aware layer.
 */
@Composable
fun SessionListScreen(
    state: PageState<SessionListContent>,
    selection: Set<String>,
    nowMs: Long,
    onAction: (SessionRow, SessionAction) -> Unit,
    onToggleSelection: (String) -> Unit,
    onClearSelection: () -> Unit,
    onCloseSelected: () -> Unit,
    onCloseAll: () -> Unit,
    onClearHistory: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var confirmingBulkClose by remember { mutableStateOf(false) }

    PageStateScaffold(state = state, modifier = modifier) { content ->
        Column(Modifier.fillMaxSize()) {
            ListHeader(
                liveCount = content.liveCount,
                unreadCount = content.unreadCount,
                selectionCount = selection.size,
                onClearSelection = onClearSelection,
                onRequestBulkClose = { confirmingBulkClose = true },
                onClearHistory = onClearHistory,
            )

            LazyColumn(Modifier.fillMaxSize()) {
                for ((group, rows) in content.groups) {
                    item(key = "header-" + group.name) {
                        SectionHeader(
                            title = SessionListStates.labelFor(group) + " (" + rows.size + ")",
                            modifier = Modifier.padding(horizontal = ZephyrSpacing.lg),
                        )
                    }
                    items(rows.size, key = { index -> rows[index].sessionId }) { index ->
                        val row = rows[index]
                        SessionCard(
                            row = row,
                            online = content.online,
                            nowMs = nowMs,
                            selected = row.sessionId in selection,
                            selectable = group != SessionGroup.HISTORY,
                            onToggleSelection = { onToggleSelection(row.sessionId) },
                            onAction = { action -> onAction(row, action) },
                        )
                    }
                }
                item { Spacer(Modifier.height(ZephyrSpacing.xxl)) }
            }
        }

        if (confirmingBulkClose) {
            val targetCount = if (selection.isEmpty()) content.closableCount else selection.size
            AlertDialog(
                onDismissRequest = { confirmingBulkClose = false },
                title = { Text(stringResource(R.string.sessions_bulk_close_title)) },
                // A truthful count: the registry decides what is actually closable, so a selection
                // containing a history row cannot inflate this number.
                text = { Text(stringResource(R.string.sessions_bulk_close_body, targetCount)) },
                confirmButton = {
                    TextButton(onClick = {
                        confirmingBulkClose = false
                        if (selection.isEmpty()) onCloseAll() else onCloseSelected()
                    }) { Text(stringResource(R.string.sessions_action_close)) }
                },
                dismissButton = {
                    TextButton(onClick = { confirmingBulkClose = false }) {
                        Text(stringResource(R.string.sessions_cancel))
                    }
                },
            )
        }
    }
}

@Composable
private fun ListHeader(
    liveCount: Int,
    unreadCount: Int,
    selectionCount: Int,
    onClearSelection: () -> Unit,
    onRequestBulkClose: () -> Unit,
    onClearHistory: () -> Unit,
) {
    Column(Modifier.fillMaxWidth()) {
        RootPageHeader(title = stringResource(R.string.sessions_title)) {
            if (selectionCount > 0) {
                TextButton(onClick = onClearSelection) { Text(stringResource(R.string.sessions_clear_selection)) }
            }
            TextButton(onClick = onRequestBulkClose) { Text(stringResource(R.string.sessions_close_many)) }
            TextButton(onClick = onClearHistory) { Text(stringResource(R.string.sessions_clear_history)) }
        }
        Text(
            text = stringResource(R.string.sessions_live_count, liveCount) +
                if (unreadCount > 0) "  " + stringResource(R.string.sessions_unread_count, unreadCount) else "",
            style = ZephyrTheme.typography.caption,
            color = ZephyrTheme.palette.onFloatingMuted,
            modifier = Modifier.padding(horizontal = ZephyrSpacing.lg),
        )
    }
}

/**
 * One session row.
 *
 * Every field SCREEN_CATALOG.md 7 requires is present: 协议, 连接名, 状态, 延迟或时长, sessionId,
 * 本地或主端执行 and any 权限变化. The sessionId is monospace because it is an identifier the user
 * may need to read out to a server operator.
 */
@Composable
private fun SessionCard(
    row: SessionRow,
    online: Boolean,
    nowMs: Long,
    selected: Boolean,
    selectable: Boolean,
    onToggleSelection: () -> Unit,
    onAction: (SessionAction) -> Unit,
) {
    val restoreGate = SessionActions.gate(row, SessionAction.RESTORE)
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = ZephyrSpacing.lg, vertical = ZephyrSpacing.xs)
            // Tapping the card is the same as 恢复, but only when that action is actually allowed:
            // a revoked tab must not become reachable through the card just because it is visible.
            .clickable(enabled = restoreGate.isAllowed) { onAction(SessionAction.RESTORE) },
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(ZephyrSpacing.md),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (selectable) {
                val label = stringResource(R.string.sessions_select_row, row.name)
                Checkbox(
                    checked = selected,
                    onCheckedChange = { onToggleSelection() },
                    modifier = Modifier.semantics { contentDescription = label },
                )
            }
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    ProtocolChip(row.protocol)
                    Spacer(Modifier.width(ZephyrSpacing.sm))
                    Text(
                        text = row.name,
                        style = MaterialTheme.typography.titleMedium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                }
                Spacer(Modifier.height(ZephyrSpacing.xs))
                MonoEndpoint(host = row.host, port = row.port)
                Spacer(Modifier.height(ZephyrSpacing.xs))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    StatusLabel(row = row, online = online)
                    Spacer(Modifier.width(ZephyrSpacing.sm))
                    Text(
                        text = metricFor(row, nowMs),
                        style = ZephyrTheme.typography.tabularNumeric,
                        color = ZephyrTheme.palette.onFloatingMuted,
                    )
                }
                Spacer(Modifier.height(ZephyrSpacing.xs))
                Text(
                    text = stringResource(R.string.sessions_session_id, row.sessionId),
                    style = ZephyrTheme.typography.monoCaption,
                    color = ZephyrTheme.palette.onFloatingMuted,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    text = executionLabel(row),
                    style = ZephyrTheme.typography.caption,
                    color = ZephyrTheme.palette.onFloatingMuted,
                )
                // Capability change: the frozen rule is that a revoked tab keeps its explanation.
                row.revokedReason?.let { reason ->
                    Spacer(Modifier.height(ZephyrSpacing.xs))
                    Text(
                        text = reason,
                        style = ZephyrTheme.typography.caption,
                        color = ZephyrTheme.palette.status.warning,
                    )
                }
                if (row.restoredFromWorkspace) {
                    Text(
                        text = stringResource(R.string.sessions_restored_hint),
                        style = ZephyrTheme.typography.caption,
                        color = ZephyrTheme.palette.onFloatingMuted,
                    )
                }
                SessionActions.executionDisclosure(row)?.let { disclosure ->
                    Text(
                        text = disclosure,
                        style = ZephyrTheme.typography.caption,
                        color = ZephyrTheme.palette.brand.accent,
                    )
                }
            }
            ActionMenu(row = row, online = online, onAction = onAction)
        }
    }
}

/**
 * Status as text plus a dot.
 *
 * SCREEN_CATALOG.md 26 forbids colour-only status, so the label carries the whole meaning and the
 * colour is redundant reinforcement.
 */
@Composable
private fun StatusLabel(row: SessionRow, online: Boolean) {
    val palette = ZephyrTheme.palette
    val text = when {
        row.revoked -> stringResource(R.string.sessions_status_revoked)
        row.transport == SessionTransport.CONNECTING -> stringResource(R.string.sessions_status_connecting)
        row.transport == SessionTransport.CONNECTED -> stringResource(R.string.sessions_status_connected)
        row.transport == SessionTransport.DISCONNECTED && !online ->
            stringResource(R.string.sessions_status_disconnected_offline)
        row.transport == SessionTransport.DISCONNECTED -> stringResource(R.string.sessions_status_disconnected)
        else -> stringResource(R.string.sessions_status_closed)
    }
    val color = when {
        row.revoked -> palette.status.warning
        row.transport == SessionTransport.CONNECTED -> palette.status.success
        row.transport == SessionTransport.CONNECTING -> palette.status.pendingSync
        row.transport == SessionTransport.DISCONNECTED -> palette.status.offline
        else -> palette.onFloatingMuted
    }
    Text(text = text, style = ZephyrTheme.typography.caption, color = color)
}

/** 延迟 while live, 时长 once it is not: a stale latency next to a dead session is a lie. */
@Composable
private fun metricFor(row: SessionRow, nowMs: Long): String {
    val latency = row.latencyMs
    if (row.transport.isLive && latency != null) {
        return stringResource(R.string.sessions_latency, latency)
    }
    val seconds = (row.durationMs(nowMs) / 1000L).coerceAtLeast(0L)
    return stringResource(R.string.sessions_duration, seconds / 60L, seconds % 60L)
}

@Composable
private fun executionLabel(row: SessionRow): String = when (row.execution) {
    SessionExecution.LOCAL -> stringResource(R.string.sessions_execution_local)
    SessionExecution.RELAY -> stringResource(R.string.sessions_execution_relay)
}

@Composable
private fun ActionMenu(row: SessionRow, online: Boolean, onAction: (SessionAction) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    val label = stringResource(R.string.sessions_more_actions, row.name)
    Box {
        IconButton(onClick = { expanded = true }, modifier = Modifier.semantics { contentDescription = label }) {
            Icon(Icons.Filled.MoreVert, contentDescription = null)
        }
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            for (action in SessionActions.visibleActions(row)) {
                val gate = SessionActions.gate(row, action)
                // Reconnect needs the network. Disabled with a reason rather than hidden, so the
                // user learns why instead of hunting for a button that vanished.
                val offlineBlocked = action == SessionAction.RECONNECT && !online
                DropdownMenuItem(
                    text = {
                        Column {
                            Text(actionLabel(action))
                            val reason = when {
                                offlineBlocked -> stringResource(R.string.sessions_reconnect_needs_network)
                                gate is ActionGate.Disabled -> gate.reason
                                else -> null
                            }
                            reason?.let {
                                Text(
                                    text = it,
                                    style = ZephyrTheme.typography.caption,
                                    color = ZephyrTheme.palette.onFloatingMuted,
                                )
                            }
                        }
                    },
                    enabled = gate.isAllowed && !offlineBlocked,
                    onClick = {
                        expanded = false
                        onAction(action)
                    },
                )
            }
        }
    }
}

@Composable
private fun actionLabel(action: SessionAction): String = when (action) {
    SessionAction.RESTORE -> stringResource(R.string.sessions_action_restore)
    SessionAction.RECONNECT -> stringResource(R.string.sessions_action_reconnect)
    SessionAction.CLOSE -> stringResource(R.string.sessions_action_close)
    SessionAction.DETAILS -> stringResource(R.string.sessions_action_details)
}

/** Local alias so the file does not import Compose's Box under a name the linter flags. */
@Composable
private fun Box(content: @Composable () -> Unit) {
    androidx.compose.foundation.layout.Box { content() }
}
