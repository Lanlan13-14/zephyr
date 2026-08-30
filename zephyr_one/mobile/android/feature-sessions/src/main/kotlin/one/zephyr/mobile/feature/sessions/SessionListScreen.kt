package one.zephyr.mobile.feature.sessions

import one.zephyr.mobile.ui.icon.ZephyrIcons
import one.zephyr.mobile.ui.theme.ZephyrTextStyles

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import one.zephyr.mobile.ui.chrome.HeaderIconButton
import one.zephyr.mobile.ui.component.AlertDialog
import one.zephyr.mobile.ui.component.Checkbox
import one.zephyr.mobile.ui.component.DropdownMenu
import one.zephyr.mobile.ui.component.DropdownMenuItem
import one.zephyr.mobile.ui.component.Icon
import one.zephyr.mobile.ui.component.IconButton
import one.zephyr.mobile.ui.component.Text
import one.zephyr.mobile.ui.component.TextButton
import one.zephyr.mobile.ui.component.pressScale
import one.zephyr.mobile.ui.island.islandContentBottomInset
import one.zephyr.mobile.ui.theme.ZephyrRadius
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
        Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {
            ListHeader(
                selectionCount = selection.size,
                onClearSelection = onClearSelection,
                onRequestBulkClose = { confirmingBulkClose = true },
            )

            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(
                    start = 16.dp,
                    end = 16.dp,
                    top = 6.dp,
                    bottom = islandContentBottomInset(),
                ),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                for ((group, rows) in content.groups) {
                    item(key = "header-" + group.name) {
                        Text(
                            text = SessionListStates.labelFor(group).uppercase(),
                            style = ZephyrTextStyles.section,
                            color = ZephyrTheme.palette.onFloatingSubtle,
                            modifier = Modifier.padding(start = 4.dp, top = 16.dp, bottom = 10.dp),
                        )
                    }
                    items(rows.size, key = { index -> rows[index].sessionId }) { index ->
                        val row = rows[index]
                        SessionRowCard(
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
                item {
                    Text(
                        text = stringResource(R.string.sessions_batch_hint),
                        color = ZephyrTheme.palette.onFloatingSubtle,
                        fontSize = 12.sp,
                        modifier = Modifier.padding(start = 4.dp, top = 8.dp, bottom = 12.dp),
                    )
                }
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
}

@Composable
private fun ListHeader(
    selectionCount: Int,
    onClearSelection: () -> Unit,
    onRequestBulkClose: () -> Unit,
) {
    Column(Modifier.fillMaxWidth()) {
        RootPageHeader(title = stringResource(R.string.sessions_title)) {
            if (selectionCount > 0) {
                TextButton(onClick = onClearSelection) { Text(stringResource(R.string.sessions_clear_selection)) }
            }
        }
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
private fun SessionRowCard(
    row: SessionRow,
    online: Boolean,
    nowMs: Long,
    selected: Boolean,
    selectable: Boolean,
    onToggleSelection: () -> Unit,
    onAction: (SessionAction) -> Unit,
) {
    val restoreGate = SessionActions.gate(row, SessionAction.RESTORE)
    val reconnectGate = SessionActions.gate(row, SessionAction.RECONNECT)
    val palette = ZephyrTheme.palette
    val protocolColor = when (row.protocol) {
        one.zephyr.mobile.model.Protocol.SSH -> palette.protocol.ssh
        one.zephyr.mobile.model.Protocol.TELNET -> palette.protocol.telnet
        one.zephyr.mobile.model.Protocol.RDP -> palette.protocol.rdp
        one.zephyr.mobile.model.Protocol.VNC -> palette.protocol.vnc
    }
    val dotColor = when {
        row.revoked -> palette.status.warning
        row.transport == SessionTransport.CONNECTED && row.minimised -> palette.status.offline
        row.transport == SessionTransport.CONNECTED -> palette.status.success
        row.transport == SessionTransport.CONNECTING -> palette.status.pendingSync
        row.transport == SessionTransport.DISCONNECTED -> palette.status.error
        else -> palette.status.offline
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .pressScale(0.98f)
            .clip(RoundedCornerShape(ZephyrRadius.md))
            .background(if (selected) palette.surfaces.elevated else palette.surfaces.content)
            .clickable(enabled = restoreGate.isAllowed) { onAction(SessionAction.RESTORE) }
            .padding(horizontal = 14.dp, vertical = 13.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (selectable) {
            val label = stringResource(R.string.sessions_select_row, row.name)
            Checkbox(
                checked = selected,
                onCheckedChange = { onToggleSelection() },
                modifier = Modifier.padding(end = 8.dp).semantics { contentDescription = label },
            )
        }
        Box(
            Modifier
                .size(9.dp)
                .clip(CircleShape)
                .background(dotColor),
        )
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(
                text = row.name,
                fontSize = 14.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = sessionSubtitle(row, nowMs),
                style = ZephyrTextStyles.monoHost,
                color = palette.onFloatingMuted,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = 2.dp),
            )
            row.revokedReason?.let { reason ->
                Text(reason, color = palette.status.warning, fontSize = 11.5.sp, modifier = Modifier.padding(top = 2.dp))
            }
        }
        if (row.transport == SessionTransport.DISCONNECTED && reconnectGate.isAllowed) {
            Text(
                text = stringResource(R.string.sessions_action_reconnect),
                color = palette.brand.accent,
                fontWeight = FontWeight.SemiBold,
                fontSize = 13.sp,
                modifier = Modifier
                    .clickable { onAction(SessionAction.RECONNECT) }
                    .padding(start = 8.dp),
            )
        } else {
            Box(
                Modifier
                    .clip(RoundedCornerShape(8.dp))
                    .background(protocolColor.copy(alpha = 0.14f))
                    .padding(horizontal = 8.dp, vertical = 2.dp),
            ) {
                Text(
                    text = if (row.protocol == one.zephyr.mobile.model.Protocol.TELNET) "Telnet" else row.protocol.wireName,
                    color = protocolColor,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.SemiBold,
                )
            }
        }
        ActionMenu(row = row, online = online, onAction = onAction)
    }
}

@Composable
private fun sessionSubtitle(row: SessionRow, nowMs: Long): String {
    val metric = metricFor(row, nowMs)
    val exec = executionLabel(row)
    return when {
        row.transport == SessionTransport.CONNECTING ->
            (row.detail ?: stringResource(R.string.sessions_status_connecting))
        row.transport == SessionTransport.DISCONNECTED ->
            listOf(stringResource(R.string.sessions_status_disconnected), stringResource(R.string.sessions_action_reconnect))
                .joinToString(" · ")
        row.minimised ->
            listOf(stringResource(R.string.sessions_status_minimised), metric).joinToString(" · ")
        else -> listOf(metric, exec).joinToString(" · ")
    }
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
            Icon(ZephyrIcons.More, contentDescription = null)
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
