package one.zephyr.mobile.feature.connections

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.outlined.AccountCircle
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import one.zephyr.mobile.contracts.BindingState
import one.zephyr.mobile.model.ActionGate
import one.zephyr.mobile.model.ActivityEvent
import one.zephyr.mobile.model.Connection
import one.zephyr.mobile.model.PageState
import one.zephyr.mobile.model.Protocol
import one.zephyr.mobile.model.Residency
import one.zephyr.mobile.model.SyncState
import one.zephyr.mobile.model.SyncStatus
import one.zephyr.mobile.ui.format.RelativeTime
import one.zephyr.mobile.ui.island.islandContentBottomInset
import one.zephyr.mobile.ui.state.PageStateScaffold
import one.zephyr.mobile.ui.theme.ZephyrTheme

/** Compact S10 dashboard, retaining the local mirror and action contracts behind the frozen UI. */
@Composable
fun ConnectionListScreen(
    state: PageState<List<Connection>>,
    filter: ConnectionFilter,
    availableTags: List<String>,
    favouriteIds: Set<String>,
    syncStatus: SyncStatus,
    activity: List<ActivityEvent>,
    nowMs: Long,
    localMode: Boolean,
    availableActions: Set<ConnectionAction>,
    onQueryChange: (String) -> Unit,
    onToggleProtocol: (Protocol) -> Unit,
    onToggleTag: (String) -> Unit,
    onOwnershipChange: (OwnershipFacet) -> Unit,
    onFavouritesOnlyChange: (Boolean) -> Unit,
    onClearFilters: () -> Unit,
    onToggleFavourite: (String) -> Unit,
    onAction: (ConnectionAction, Connection) -> Unit,
    onCreate: () -> Unit,
    onSyncNow: (() -> Unit)?,
    onOpenAccount: (() -> Unit)?,
    onRetry: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var pendingDelete by remember { mutableStateOf<Connection?>(null) }

    Column(modifier.fillMaxSize()) {
        DashboardHeader(
            query = filter.query,
            syncStatus = syncStatus,
            localMode = localMode,
            onQueryChange = onQueryChange,
            onCreate = onCreate,
            onSyncNow = onSyncNow,
            onOpenAccount = onOpenAccount,
        )
        FilterStrip(
            filter = filter,
            availableTags = availableTags,
            onToggleProtocol = onToggleProtocol,
            onToggleTag = onToggleTag,
            onOwnershipChange = onOwnershipChange,
            onFavouritesOnlyChange = onFavouritesOnlyChange,
            onClearFilters = onClearFilters,
        )

        PageStateScaffold(state = state, onRetry = onRetry, modifier = Modifier.fillMaxSize()) { rows ->
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(
                    start = PAGE_GUTTER,
                    end = PAGE_GUTTER,
                    top = 22.dp,
                    bottom = islandContentBottomInset(),
                ),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                item(key = "connections-title") {
                    SectionTitle(stringResource(R.string.connections_recents))
                }
                items(rows, key = { it.id }) { connection ->
                    ConnectionCard(
                        connection = connection,
                        isFavourite = connection.id in favouriteIds,
                        nowMs = nowMs,
                        availableActions = availableActions,
                        onToggleFavourite = { onToggleFavourite(connection.id) },
                        onAction = { action ->
                            if (action == ConnectionAction.DELETE) pendingDelete = connection
                            else onAction(action, connection)
                        },
                    )
                }
                item(key = "activity-summary") {
                    ActivitySummary(rows = rows, activity = activity, nowMs = nowMs)
                }
            }
        }
    }

    pendingDelete?.let { target ->
        AlertDialog(
            onDismissRequest = { pendingDelete = null },
            title = { Text(stringResource(R.string.connection_delete_title)) },
            text = { Text(stringResource(R.string.connection_delete_message, target.name)) },
            confirmButton = {
                TextButton(onClick = {
                    pendingDelete = null
                    onAction(ConnectionAction.DELETE, target)
                }) { Text(stringResource(R.string.connection_delete_confirm)) }
            },
            dismissButton = {
                TextButton(onClick = { pendingDelete = null }) {
                    Text(stringResource(R.string.dialog_cancel))
                }
            },
        )
    }
}

@Composable
private fun DashboardHeader(
    query: String,
    syncStatus: SyncStatus,
    localMode: Boolean,
    onQueryChange: (String) -> Unit,
    onCreate: () -> Unit,
    onSyncNow: (() -> Unit)?,
    onOpenAccount: (() -> Unit)?,
) {
    Column(
        Modifier.padding(start = PAGE_GUTTER, end = PAGE_GUTTER, top = 14.dp, bottom = 4.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = stringResource(R.string.connections_title),
                color = ZephyrTheme.palette.onBackground,
                fontSize = 23.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 0.sp,
                modifier = Modifier.weight(1f),
            )
            HeaderIconButton(
                description = stringResource(R.string.connections_create),
                onClick = onCreate,
            ) {
                Icon(Icons.Filled.Add, contentDescription = null, modifier = Modifier.size(18.dp))
            }
            Spacer(Modifier.width(8.dp))
            SyncPill(status = syncStatus, localMode = localMode, onClick = onSyncNow)
            if (onOpenAccount != null) {
                Spacer(Modifier.width(8.dp))
                HeaderIconButton(
                    description = stringResource(R.string.connections_account_menu),
                    onClick = onOpenAccount,
                ) {
                    Icon(Icons.Outlined.AccountCircle, contentDescription = null, modifier = Modifier.size(18.dp))
                }
            }
        }
        Spacer(Modifier.height(10.dp))
        SearchField(query = query, onQueryChange = onQueryChange)
    }
}

@Composable
private fun HeaderIconButton(
    description: String,
    onClick: () -> Unit,
    content: @Composable () -> Unit,
) {
    Surface(
        modifier = Modifier
            .size(38.dp)
            .semantics { contentDescription = description }
            .clickable(role = Role.Button, onClick = onClick),
        shape = CircleShape,
        color = ZephyrTheme.palette.surfaces.elevated,
        contentColor = ZephyrTheme.palette.brand.accent,
        content = { Box(contentAlignment = Alignment.Center) { content() } },
    )
}

@Composable
private fun SyncPill(status: SyncStatus, localMode: Boolean, onClick: (() -> Unit)?) {
    val palette = ZephyrTheme.palette
    val (label, color) = when {
        localMode -> stringResource(R.string.connections_local_mode) to palette.status.offline
        status.conflictCount > 0 -> stringResource(R.string.connection_conflict) to palette.status.conflict
        status.isRunning -> stringResource(R.string.connections_syncing) to palette.status.pendingSync
        status.pendingCount > 0 -> stringResource(R.string.connection_pending) to palette.status.pendingSync
        status.lastError != null -> stringResource(R.string.connections_sync_failed) to palette.status.error
        status.lastSuccessAt != null -> stringResource(R.string.connections_synced) to palette.status.success
        else -> stringResource(R.string.connections_not_synced) to palette.status.offline
    }
    val clickModifier = if (onClick != null) {
        Modifier.clickable(role = Role.Button, onClick = onClick)
    } else {
        Modifier
    }
    Row(
        modifier = clickModifier
            .height(36.dp)
            .clip(RoundedCornerShape(19.dp))
            .background(palette.surfaces.elevated)
            .padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Box(Modifier.size(7.dp).clip(CircleShape).background(color))
        Text(label, color = palette.onFloatingMuted, fontSize = 12.sp, fontWeight = FontWeight.Medium)
        if (onClick != null) {
            Icon(Icons.Filled.Refresh, contentDescription = null, modifier = Modifier.size(14.dp))
        }
    }
}

@Composable
private fun SearchField(query: String, onQueryChange: (String) -> Unit) {
    val palette = ZephyrTheme.palette
    val searchLabel = stringResource(R.string.connections_search_label)
    BasicTextField(
        value = query,
        onValueChange = onQueryChange,
        singleLine = true,
        textStyle = TextStyle(color = palette.onBackground, fontSize = 13.5.sp),
        cursorBrush = androidx.compose.ui.graphics.SolidColor(palette.brand.accent),
        modifier = Modifier
            .fillMaxWidth()
            .height(36.dp)
            .semantics { contentDescription = searchLabel },
        decorationBox = { inner ->
            Row(
                modifier = Modifier
                    .fillMaxSize()
                    .clip(RoundedCornerShape(10.dp))
                    .background(palette.surfaces.elevated)
                    .padding(horizontal = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    Icons.Filled.Search,
                    contentDescription = null,
                    tint = palette.onFloatingSubtle,
                    modifier = Modifier.size(15.dp),
                )
                Spacer(Modifier.width(8.dp))
                Box(Modifier.weight(1f)) {
                    if (query.isEmpty()) {
                        Text(
                            stringResource(R.string.connections_search_hint),
                            color = palette.onFloatingSubtle,
                            fontSize = 13.5.sp,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    inner()
                }
                if (query.isNotEmpty()) {
                    Icon(
                        Icons.Filled.Close,
                        contentDescription = stringResource(R.string.connections_search_clear),
                        tint = palette.onFloatingSubtle,
                        modifier = Modifier
                            .size(18.dp)
                            .clickable { onQueryChange("") },
                    )
                }
            }
        },
    )
}

@Composable
private fun FilterStrip(
    filter: ConnectionFilter,
    availableTags: List<String>,
    onToggleProtocol: (Protocol) -> Unit,
    onToggleTag: (String) -> Unit,
    onOwnershipChange: (OwnershipFacet) -> Unit,
    onFavouritesOnlyChange: (Boolean) -> Unit,
    onClearFilters: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = PAGE_GUTTER, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        DashboardChip(
            label = stringResource(R.string.connections_filter_all),
            selected = !filter.hasFacets,
            onClick = onClearFilters,
        )
        Protocol.entries.forEach { protocol ->
            DashboardChip(
                label = if (protocol == Protocol.TELNET) "Telnet" else protocol.wireName,
                selected = protocol in filter.protocols,
                onClick = { onToggleProtocol(protocol) },
            )
        }
        DashboardChip(
            label = stringResource(R.string.connections_filter_favourites),
            selected = filter.favouritesOnly,
            onClick = { onFavouritesOnlyChange(!filter.favouritesOnly) },
        )
        DashboardChip(
            label = stringResource(R.string.connections_filter_shared),
            selected = filter.ownership == OwnershipFacet.SHARED,
            onClick = {
                onOwnershipChange(
                    if (filter.ownership == OwnershipFacet.SHARED) OwnershipFacet.ALL else OwnershipFacet.SHARED,
                )
            },
        )
        availableTags.forEach { tag ->
            DashboardChip(
                label = tag,
                selected = tag in filter.tags,
                onClick = { onToggleTag(tag) },
            )
        }
    }
}

@Composable
private fun DashboardChip(label: String, selected: Boolean, onClick: () -> Unit) {
    Surface(
        modifier = Modifier
            .height(32.dp)
            .clickable(role = Role.Button, onClick = onClick),
        shape = RoundedCornerShape(16.dp),
        color = if (selected) ZephyrTheme.palette.brand.accent else ZephyrTheme.palette.surfaces.elevated,
        contentColor = if (selected) Color.White else ZephyrTheme.palette.onFloatingMuted,
    ) {
        Box(Modifier.padding(horizontal = 13.dp), contentAlignment = Alignment.Center) {
            Text(label, fontSize = 12.5.sp, fontWeight = FontWeight.Medium, maxLines = 1)
        }
    }
}

@Composable
private fun SectionTitle(title: String) {
    Text(
        text = title.uppercase(),
        color = ZephyrTheme.palette.onFloatingSubtle,
        fontSize = 12.sp,
        fontWeight = FontWeight.SemiBold,
        letterSpacing = 0.sp,
        modifier = Modifier.padding(start = 4.dp, bottom = 1.dp),
    )
}

@Composable
private fun ConnectionCard(
    connection: Connection,
    isFavourite: Boolean,
    nowMs: Long,
    availableActions: Set<ConnectionAction>,
    onToggleFavourite: () -> Unit,
    onAction: (ConnectionAction) -> Unit,
) {
    var menuOpen by remember { mutableStateOf(false) }
    val moreActionDescription = stringResource(R.string.connection_action_more)
    val palette = ZephyrTheme.palette
    val protocolColor = protocolColor(connection.protocol)
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 90.dp)
            .clickable(
                enabled = ConnectionActions.gate(connection, ConnectionAction.USE).isAllowed,
                role = Role.Button,
            ) { onAction(ConnectionAction.USE) },
        shape = RoundedCornerShape(14.dp),
        color = palette.surfaces.content,
        border = BorderStroke(1.dp, palette.surfaces.outline.copy(alpha = 0.55f)),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier
                    .size(40.dp)
                    .clip(RoundedCornerShape(11.dp))
                    .background(protocolColor.copy(alpha = 0.16f)),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = if (connection.protocol == Protocol.TELNET) "TEL" else connection.protocol.wireName,
                    color = protocolColor,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 10.5.sp,
                    fontWeight = FontWeight.ExtraBold,
                )
            }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = connection.name,
                        color = palette.onBackground,
                        fontSize = 14.5.sp,
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                    if (isFavourite) {
                        Spacer(Modifier.width(5.dp))
                        Icon(
                            Icons.Filled.Star,
                            contentDescription = null,
                            tint = palette.status.warning,
                            modifier = Modifier.size(13.dp),
                        )
                    }
                }
                Spacer(Modifier.height(3.dp))
                Text(
                    text = endpointText(connection),
                    color = palette.onFloatingMuted,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 11.5.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                val labels = cardLabels(connection)
                if (labels.isNotEmpty()) {
                    Spacer(Modifier.height(6.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        labels.take(MAX_CARD_LABELS).forEach { label -> MetaBadge(label.text, label.color) }
                    }
                }
            }
            Spacer(Modifier.width(8.dp))
            Column(horizontalAlignment = Alignment.End) {
                Text(
                    text = connection.lastConnectedAt?.let { RelativeTime.format(nowMs, it) }
                        ?: stringResource(R.string.connection_never_connected),
                    color = palette.onFloatingSubtle,
                    fontSize = 11.sp,
                    maxLines = 1,
                )
                Spacer(Modifier.height(5.dp))
                Box {
                    Box(
                        modifier = Modifier
                            .size(30.dp)
                            .clip(CircleShape)
                            .semantics {
                                contentDescription = moreActionDescription
                            }
                            .clickable {
                                menuOpen = true
                            },
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            Icons.Filled.MoreVert,
                            contentDescription = null,
                            tint = palette.onFloatingSubtle,
                            modifier = Modifier.size(18.dp),
                        )
                    }
                    ActionMenu(
                        expanded = menuOpen,
                        connection = connection,
                        isFavourite = isFavourite,
                        availableActions = availableActions,
                        onDismiss = { menuOpen = false },
                        onToggleFavourite = {
                            menuOpen = false
                            onToggleFavourite()
                        },
                        onAction = { action ->
                            menuOpen = false
                            onAction(action)
                        },
                    )
                }
            }
        }
    }
}

private data class CardLabel(val text: String, val color: Color? = null)

@Composable
private fun cardLabels(connection: Connection): List<CardLabel> = buildList {
    connection.tags.forEach { add(CardLabel(it)) }
    when (connection.syncState) {
        SyncState.PENDING_LOCAL -> add(
            CardLabel(stringResource(R.string.connection_pending), ZephyrTheme.palette.status.pendingSync),
        )
        SyncState.CONFLICTED -> add(
            CardLabel(stringResource(R.string.connection_conflict), ZephyrTheme.palette.status.conflict),
        )
        else -> Unit
    }
    if (connection.residency == Residency.SHARED_ONLINE_ONLY) {
        add(CardLabel(stringResource(R.string.connections_shared_badge)))
    }
}

@Composable
private fun MetaBadge(text: String, color: Color?) {
    val foreground = color ?: ZephyrTheme.palette.onFloatingMuted
    val background = color?.copy(alpha = 0.14f) ?: ZephyrTheme.palette.surfaces.elevated
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(8.dp))
            .background(background)
            .padding(horizontal = 8.dp, vertical = 2.dp),
    ) {
        Text(text, color = foreground, fontSize = 11.sp, fontWeight = if (color != null) FontWeight.SemiBold else FontWeight.Normal)
    }
}

@Composable
private fun endpointText(connection: Connection): String =
    if (connection.residency == Residency.OWNED) {
        (connection.username.takeIf { it.isNotBlank() }?.plus("@") ?: "") + connection.displayAddress
    } else {
        stringResource(R.string.connection_shared_row, connection.sharedOwnerLabel.orEmpty())
    }

@Composable
private fun protocolColor(protocol: Protocol): Color = when (protocol) {
    Protocol.SSH -> ZephyrTheme.palette.protocol.ssh
    Protocol.TELNET -> ZephyrTheme.palette.protocol.telnet
    Protocol.RDP -> ZephyrTheme.palette.protocol.rdp
    Protocol.VNC -> ZephyrTheme.palette.protocol.vnc
}

@Composable
private fun ActionMenu(
    expanded: Boolean,
    connection: Connection,
    isFavourite: Boolean,
    availableActions: Set<ConnectionAction>,
    onDismiss: () -> Unit,
    onToggleFavourite: () -> Unit,
    onAction: (ConnectionAction) -> Unit,
) {
    DropdownMenu(expanded = expanded, onDismissRequest = onDismiss) {
        DropdownMenuItem(
            onClick = onToggleFavourite,
            text = {
                Text(
                    stringResource(
                        if (isFavourite) R.string.connection_favourite_remove
                        else R.string.connection_favourite_add,
                    ),
                )
            },
        )
        ConnectionAction.entries.forEach { action ->
            if (action !in availableActions || action == ConnectionAction.USE) return@forEach
            when (val gate = ConnectionActions.gate(connection, action)) {
                is ActionGate.Hidden -> Unit
                is ActionGate.Disabled -> DropdownMenuItem(
                    enabled = false,
                    onClick = {},
                    text = {
                        Column {
                            Text(actionLabel(action))
                            Text(gate.reason, color = ZephyrTheme.palette.onFloatingMuted, fontSize = 12.sp)
                        }
                    },
                )
                ActionGate.Allowed -> DropdownMenuItem(
                    onClick = { onAction(action) },
                    text = { Text(actionLabel(action)) },
                )
            }
        }
    }
}

@Composable
private fun actionLabel(action: ConnectionAction): String = when (action) {
    ConnectionAction.USE -> stringResource(R.string.connection_action_use)
    ConnectionAction.EDIT -> stringResource(R.string.connection_action_edit)
    ConnectionAction.DUPLICATE -> stringResource(R.string.connection_action_duplicate)
    ConnectionAction.DELETE -> stringResource(R.string.connection_action_delete)
    ConnectionAction.TEST -> stringResource(R.string.connection_action_test)
    ConnectionAction.SHARE -> stringResource(R.string.connection_action_share)
}

@Composable
private fun ActivitySummary(rows: List<Connection>, activity: List<ActivityEvent>, nowMs: Long) {
    Column(Modifier.padding(top = 10.dp)) {
        SectionTitle(stringResource(R.string.connections_activity_summary))
        Spacer(Modifier.height(9.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            StatCard(activity.size.toString(), stringResource(R.string.connections_activity_count), Modifier.weight(1f))
            StatCard(
                rows.count { it.syncState == SyncState.PENDING_LOCAL }.toString(),
                stringResource(R.string.connections_pending_count),
                Modifier.weight(1f),
                ZephyrTheme.palette.status.pendingSync,
            )
            StatCard(
                rows.count { it.syncState == SyncState.CONFLICTED }.toString(),
                stringResource(R.string.connections_conflict_count),
                Modifier.weight(1f),
                ZephyrTheme.palette.status.conflict,
            )
        }
        activity.take(ACTIVITY_PREVIEW).forEach { event ->
            Row(Modifier.fillMaxWidth().padding(top = 9.dp, start = 4.dp, end = 4.dp)) {
                Text(
                    event.message,
                    color = ZephyrTheme.palette.onFloatingMuted,
                    fontSize = 12.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    RelativeTime.format(nowMs, event.occurredAt),
                    color = ZephyrTheme.palette.onFloatingSubtle,
                    fontSize = 11.sp,
                )
            }
        }
    }
}

@Composable
private fun StatCard(value: String, label: String, modifier: Modifier, valueColor: Color? = null) {
    Surface(
        modifier = modifier,
        color = ZephyrTheme.palette.surfaces.content,
        border = BorderStroke(1.dp, ZephyrTheme.palette.surfaces.outline.copy(alpha = 0.55f)),
        shape = RoundedCornerShape(14.dp),
    ) {
        Column(Modifier.padding(14.dp)) {
            Text(value, color = valueColor ?: ZephyrTheme.palette.onBackground, fontSize = 20.sp, fontWeight = FontWeight.Bold)
            Text(label, color = ZephyrTheme.palette.onFloatingSubtle, fontSize = 12.sp)
        }
    }
}

private val ConnectionFilter.hasFacets: Boolean
    get() = protocols.isNotEmpty() || tags.isNotEmpty() || ownership != OwnershipFacet.ALL || favouritesOnly

private val DEFAULT_ACTIONS = setOf(ConnectionAction.USE, ConnectionAction.EDIT, ConnectionAction.DELETE)
private val PAGE_GUTTER = 16.dp
private const val MAX_CARD_LABELS = 3
private const val ACTIVITY_PREVIEW = 3
