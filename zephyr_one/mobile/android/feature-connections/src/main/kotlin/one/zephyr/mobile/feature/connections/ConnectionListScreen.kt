@file:OptIn(
    androidx.compose.material3.ExperimentalMaterial3Api::class,
    androidx.compose.foundation.layout.ExperimentalLayoutApi::class,
)

package one.zephyr.mobile.feature.connections

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountCircle
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.filled.StarBorder
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Card
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
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
import one.zephyr.mobile.model.ActionGate
import one.zephyr.mobile.model.ActivityEvent
import one.zephyr.mobile.model.Connection
import one.zephyr.mobile.model.PageState
import one.zephyr.mobile.model.Protocol
import one.zephyr.mobile.model.Residency
import one.zephyr.mobile.model.SyncState
import one.zephyr.mobile.model.SyncStatus
import one.zephyr.mobile.ui.component.CleartextProtocolWarning
import one.zephyr.mobile.ui.component.MonoEndpoint
import one.zephyr.mobile.ui.component.ProtocolChip
import one.zephyr.mobile.ui.component.SectionHeader
import one.zephyr.mobile.ui.component.SyncStatusPill
import one.zephyr.mobile.ui.island.islandContentBottomInset
import one.zephyr.mobile.ui.state.PageStateScaffold
import one.zephyr.mobile.ui.theme.ZephyrSpacing
import one.zephyr.mobile.ui.theme.ZephyrTheme
import one.zephyr.mobile.ui.format.RelativeTime

/**
 * S10 首页/连接库.
 *
 * Stateless on purpose: every input is a value and every output is a lambda, so a Compose UI test
 * can drive the whole screen without a ViewModel, a database or a network. [ConnectionListRoute]
 * is the thin binding that supplies the real ones.
 */
@Composable
fun ConnectionListScreen(
    state: PageState<List<Connection>>,
    filter: ConnectionFilter,
    recents: List<Connection>,
    availableTags: List<String>,
    favouriteIds: Set<String>,
    syncStatus: SyncStatus,
    activity: List<ActivityEvent>,
    nowMs: Long,
    onQueryChange: (String) -> Unit,
    onToggleProtocol: (Protocol) -> Unit,
    onToggleTag: (String) -> Unit,
    onOwnershipChange: (OwnershipFacet) -> Unit,
    onFavouritesOnlyChange: (Boolean) -> Unit,
    onClearFilters: () -> Unit,
    onToggleFavourite: (String) -> Unit,
    onAction: (ConnectionAction, Connection) -> Unit,
    onCreate: () -> Unit,
    onSyncNow: () -> Unit,
    onOpenAccount: () -> Unit,
    onRetry: () -> Unit,
    modifier: Modifier = Modifier,
) {
    // The dialog is screen state, not ViewModel state: it has no meaning after process death, and
    // hoisting it would make the ViewModel responsible for a purely visual decision.
    var pendingDelete by remember { mutableStateOf<Connection?>(null) }

    Column(modifier.fillMaxSize()) {
        ListHeader(
            query = filter.query,
            syncStatus = syncStatus,
            onQueryChange = onQueryChange,
            onSyncNow = onSyncNow,
            onOpenAccount = onOpenAccount,
        )

        FilterRow(
            filter = filter,
            availableTags = availableTags,
            onToggleProtocol = onToggleProtocol,
            onToggleTag = onToggleTag,
            onOwnershipChange = onOwnershipChange,
            onFavouritesOnlyChange = onFavouritesOnlyChange,
            onClearFilters = onClearFilters,
        )

        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            ExtendedFloatingActionButton(
                onClick = onCreate,
                modifier = Modifier.padding(horizontal = ZephyrSpacing.lg),
            ) {
                Icon(Icons.Filled.Add, contentDescription = null)
                Spacer(Modifier.width(ZephyrSpacing.sm))
                Text(stringResource(R.string.connections_create))
            }
        }

        PageStateScaffold(state = state, onRetry = onRetry, modifier = Modifier.fillMaxSize()) { rows ->
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                // The island floats above the content, so the last row needs the frozen inset or it
                // would sit under it (DEVELOPMENT.md 6.1).
                contentPadding = androidx.compose.foundation.layout.PaddingValues(
                    start = ZephyrSpacing.lg,
                    end = ZephyrSpacing.lg,
                    top = ZephyrSpacing.sm,
                    bottom = islandContentBottomInset(),
                ),
                verticalArrangement = Arrangement.spacedBy(ZephyrSpacing.sm),
            ) {
                if (recents.isNotEmpty()) {
                    item(key = "recents") {
                        RecentsStrip(recents = recents, onUse = { onAction(ConnectionAction.USE, it) })
                    }
                }
                items(rows, key = { it.id }) { connection ->
                    ConnectionCard(
                        connection = connection,
                        isFavourite = connection.id in favouriteIds,
                        nowMs = nowMs,
                        onToggleFavourite = { onToggleFavourite(connection.id) },
                        onAction = { action ->
                            if (action == ConnectionAction.DELETE) {
                                pendingDelete = connection
                            } else {
                                onAction(action, connection)
                            }
                        },
                    )
                }
                if (activity.isNotEmpty()) {
                    item(key = "activity") { ActivitySummary(activity = activity, nowMs = nowMs) }
                }
            }
        }
    }

    // Destructive confirmation is a native dialog, never a browser confirm (SCREEN_CATALOG.md 2).
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
private fun ListHeader(
    query: String,
    syncStatus: SyncStatus,
    onQueryChange: (String) -> Unit,
    onSyncNow: () -> Unit,
    onOpenAccount: () -> Unit,
) {
    Column(Modifier.padding(horizontal = ZephyrSpacing.lg, vertical = ZephyrSpacing.sm)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = stringResource(R.string.connections_title),
                style = MaterialTheme.typography.titleLarge,
                modifier = Modifier.weight(1f),
            )
            // The pill is the sync affordance itself: tapping it runs 立即同步, which
            // PRODUCT_REQUIREMENTS.md 12 makes a release blocker if it is missing.
            val syncNowLabel = stringResource(R.string.connections_sync_now)
            IconButton(
                onClick = onSyncNow,
                modifier = Modifier.semantics { contentDescription = syncNowLabel },
            ) { SyncStatusPill(status = syncStatus) }
            IconButton(onClick = onOpenAccount) {
                Icon(
                    Icons.Filled.AccountCircle,
                    contentDescription = stringResource(R.string.connections_account_menu),
                )
            }
        }
        Spacer(Modifier.height(ZephyrSpacing.sm))
        val searchLabel = stringResource(R.string.connections_search_label)
        OutlinedTextField(
            value = query,
            onValueChange = onQueryChange,
            modifier = Modifier
                .fillMaxWidth()
                .semantics { contentDescription = searchLabel },
            label = { Text(stringResource(R.string.connections_search_hint)) },
            singleLine = true,
        )
    }
}

@Composable
private fun FilterRow(
    filter: ConnectionFilter,
    availableTags: List<String>,
    onToggleProtocol: (Protocol) -> Unit,
    onToggleTag: (String) -> Unit,
    onOwnershipChange: (OwnershipFacet) -> Unit,
    onFavouritesOnlyChange: (Boolean) -> Unit,
    onClearFilters: () -> Unit,
) {
    FlowRow(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = ZephyrSpacing.lg),
        horizontalArrangement = Arrangement.spacedBy(ZephyrSpacing.xs),
    ) {
        for (facet in OwnershipFacet.entries) {
            FilterChip(
                selected = filter.ownership == facet,
                onClick = { onOwnershipChange(facet) },
                label = { Text(ownershipLabel(facet)) },
            )
        }
        FilterChip(
            selected = filter.favouritesOnly,
            onClick = { onFavouritesOnlyChange(!filter.favouritesOnly) },
            label = { Text(stringResource(R.string.connections_filter_favourites)) },
        )
        for (protocol in Protocol.entries) {
            FilterChip(
                selected = protocol in filter.protocols,
                onClick = { onToggleProtocol(protocol) },
                label = { Text(protocol.wireName) },
            )
        }
        for (tag in availableTags) {
            FilterChip(
                selected = tag in filter.tags,
                onClick = { onToggleTag(tag) },
                label = { Text(tag) },
            )
        }
        if (filter.isActive) {
            AssistChip(
                onClick = onClearFilters,
                label = { Text(stringResource(R.string.connections_filter_clear)) },
            )
        }
    }
}

@Composable
private fun ownershipLabel(facet: OwnershipFacet): String = when (facet) {
    OwnershipFacet.ALL -> stringResource(R.string.connections_filter_all)
    OwnershipFacet.OWNED -> stringResource(R.string.connections_filter_owned)
    OwnershipFacet.SHARED -> stringResource(R.string.connections_filter_shared)
}

@Composable
private fun RecentsStrip(recents: List<Connection>, onUse: (Connection) -> Unit) {
    Column {
        SectionHeader(stringResource(R.string.connections_recents))
        LazyRow(horizontalArrangement = Arrangement.spacedBy(ZephyrSpacing.sm)) {
            items(recents, key = { it.id }) { connection ->
                AssistChip(
                    onClick = { onUse(connection) },
                    label = { Text(connection.name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    leadingIcon = { ProtocolChip(connection.protocol) },
                )
            }
        }
    }
}

/**
 * One connection row.
 *
 * The shared branch is not cosmetic: SHARED_RESOURCE_RESIDENCY.md 2 forbids One from holding a
 * shared resource's endpoint, so a shared row has no host:port to render and shows the owner
 * disclosure instead. A card that printed host:port for both origins would be displaying data the
 * device is not allowed to have.
 */
@Composable
private fun ConnectionCard(
    connection: Connection,
    isFavourite: Boolean,
    nowMs: Long,
    onToggleFavourite: () -> Unit,
    onAction: (ConnectionAction) -> Unit,
) {
    var menuOpen by remember { mutableStateOf(false) }
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(ZephyrSpacing.md)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                ProtocolChip(connection.protocol)
                Spacer(Modifier.width(ZephyrSpacing.sm))
                Text(
                    text = connection.name,
                    style = MaterialTheme.typography.titleMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                IconButton(onClick = onToggleFavourite) {
                    Icon(
                        imageVector = if (isFavourite) Icons.Filled.Star else Icons.Filled.StarBorder,
                        contentDescription = stringResource(
                            if (isFavourite) R.string.connection_favourite_remove
                            else R.string.connection_favourite_add,
                        ),
                    )
                }
                Box {
                    IconButton(onClick = { menuOpen = true }) {
                        Icon(
                            Icons.Filled.MoreVert,
                            contentDescription = stringResource(R.string.connection_action_more),
                        )
                    }
                    ActionMenu(
                        expanded = menuOpen,
                        connection = connection,
                        onDismiss = { menuOpen = false },
                        onAction = { action ->
                            menuOpen = false
                            onAction(action)
                        },
                    )
                }
            }

            Spacer(Modifier.height(ZephyrSpacing.xs))

            if (connection.residency == Residency.OWNED) {
                MonoEndpoint(host = connection.host, port = connection.port)
            } else {
                Text(
                    text = stringResource(
                        R.string.connection_shared_row,
                        connection.sharedOwnerLabel ?: "",
                    ),
                    style = ZephyrTheme.typography.caption,
                    color = ZephyrTheme.palette.onFloatingMuted,
                )
                ConnectionActions.sharedUseDisclosure(connection)?.let { disclosure ->
                    Text(disclosure, style = ZephyrTheme.typography.caption)
                }
                connection.grantExpiresAt?.let { expiry ->
                    Text(
                        text = stringResource(
                            R.string.connection_grant_expires,
                            RelativeTime.absolute(expiry),
                        ),
                        style = ZephyrTheme.typography.caption,
                    )
                }
            }

            if (connection.protocol.isCleartext) {
                Spacer(Modifier.height(ZephyrSpacing.xs))
                CleartextProtocolWarning(connection.protocol)
            }

            if (connection.remark.isNotEmpty()) {
                Spacer(Modifier.height(ZephyrSpacing.xs))
                Text(
                    connection.remark,
                    style = ZephyrTheme.typography.caption,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }

            if (connection.tags.isNotEmpty()) {
                Spacer(Modifier.height(ZephyrSpacing.xs))
                Text(
                    connection.tags.joinToString(" · "),
                    style = ZephyrTheme.typography.caption,
                    color = ZephyrTheme.palette.onFloatingMuted,
                )
            }

            Spacer(Modifier.height(ZephyrSpacing.xs))
            Row(verticalAlignment = Alignment.CenterVertically) {
                // Status is words, not only a colour (SCREEN_CATALOG.md 26).
                when (connection.syncState) {
                    SyncState.PENDING_LOCAL -> StatusText(
                        stringResource(R.string.connection_pending),
                        ZephyrTheme.palette.status.pendingSync,
                    )
                    SyncState.CONFLICTED -> StatusText(
                        stringResource(R.string.connection_conflict),
                        ZephyrTheme.palette.status.conflict,
                    )
                    else -> Unit
                }
                Spacer(Modifier.weight(1f))
                Text(
                    text = connection.lastConnectedAt?.let {
                        stringResource(R.string.connection_last_connected, RelativeTime.format(nowMs, it))
                    } ?: stringResource(R.string.connection_never_connected),
                    style = ZephyrTheme.typography.caption,
                    color = ZephyrTheme.palette.onFloatingMuted,
                )
            }
        }
    }
}

@Composable
private fun StatusText(text: String, color: androidx.compose.ui.graphics.Color) {
    Text(text, style = ZephyrTheme.typography.caption, color = color)
}

/**
 * Row actions, gated.
 *
 * Hidden actions are absent from the menu, disabled ones are present with their reason on a second
 * line. SCREEN_CATALOG.md 2 requires exactly this split rather than an action that fails on tap.
 */
@Composable
private fun ActionMenu(
    expanded: Boolean,
    connection: Connection,
    onDismiss: () -> Unit,
    onAction: (ConnectionAction) -> Unit,
) {
    DropdownMenu(expanded = expanded, onDismissRequest = onDismiss) {
        for (action in ConnectionAction.entries) {
            when (val gate = ConnectionActions.gate(connection, action)) {
                is ActionGate.Hidden -> Unit
                is ActionGate.Disabled -> DropdownMenuItem(
                    enabled = false,
                    onClick = { },
                    text = {
                        Column {
                            Text(actionLabel(action))
                            Text(gate.reason, style = ZephyrTheme.typography.caption)
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
private fun ActivitySummary(activity: List<ActivityEvent>, nowMs: Long) {
    Column {
        SectionHeader(stringResource(R.string.connections_activity_summary))
        for (event in activity.take(ACTIVITY_PREVIEW)) {
            Row(Modifier.fillMaxWidth().padding(vertical = ZephyrSpacing.xs)) {
                Text(
                    text = event.message,
                    style = ZephyrTheme.typography.caption,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    text = RelativeTime.format(nowMs, event.occurredAt),
                    style = ZephyrTheme.typography.caption,
                    color = ZephyrTheme.palette.onFloatingMuted,
                )
            }
        }
    }
}

private const val ACTIVITY_PREVIEW = 5
