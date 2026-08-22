package one.zephyr.mobile.feature.connections

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.flow.Flow
import one.zephyr.mobile.model.ActivityEvent
import one.zephyr.mobile.model.Connection
import one.zephyr.mobile.model.PageState
import one.zephyr.mobile.model.SyncStatus

/**
 * Route bindings.
 *
 * Deliberately separate from the screens: the screens take values and lambdas so a Compose test can
 * drive every state without a ViewModel, and these functions are the only place that knows a
 * ViewModel exists. That split is what makes SCREEN_CATALOG.md 27.7's UI test requirement reachable
 * without a database.
 */
@Composable
fun ConnectionListRoute(
    viewModel: ConnectionListViewModel,
    syncStatus: SyncStatus,
    activity: List<ActivityEvent>,
    nowMs: Long,
    onOpenConnection: (Connection) -> Unit,
    onEditConnection: (Connection) -> Unit,
    onDuplicateConnection: ((Connection) -> Unit)?,
    onTestConnection: ((Connection) -> Unit)?,
    onShareConnection: ((Connection) -> Unit)?,
    onCreate: () -> Unit,
    onOpenAccount: (() -> Unit)?,
    localMode: Boolean,
    onMessage: suspend (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val state by viewModel.state.collectAsState()
    val filter by viewModel.filter.collectAsState()
    val tags by viewModel.availableTags.collectAsState()
    val favourites by viewModel.favouriteIds.collectAsState()

    CollectMessages(viewModel.message, onMessage)

    ConnectionListScreen(
        state = state,
        filter = filter,
        availableTags = tags,
        favouriteIds = favourites,
        syncStatus = syncStatus,
        activity = activity,
        nowMs = nowMs,
        localMode = localMode,
        availableActions = buildSet {
            add(ConnectionAction.USE)
            add(ConnectionAction.EDIT)
            add(ConnectionAction.DELETE)
            if (onDuplicateConnection != null) add(ConnectionAction.DUPLICATE)
            if (onTestConnection != null) add(ConnectionAction.TEST)
            if (onShareConnection != null) add(ConnectionAction.SHARE)
        },
        onQueryChange = viewModel::setQuery,
        onToggleProtocol = viewModel::toggleProtocol,
        onToggleTag = viewModel::toggleTag,
        onOwnershipChange = viewModel::setOwnership,
        onFavouritesOnlyChange = viewModel::setFavouritesOnly,
        onClearFilters = viewModel::clearFilters,
        onToggleFavourite = viewModel::toggleFavourite,
        onAction = { action, connection ->
            when (action) {
                ConnectionAction.USE -> onOpenConnection(connection)
                ConnectionAction.EDIT -> onEditConnection(connection)
                ConnectionAction.DUPLICATE -> onDuplicateConnection?.invoke(connection)
                ConnectionAction.TEST -> onTestConnection?.invoke(connection)
                ConnectionAction.SHARE -> onShareConnection?.invoke(connection)
                // The screen already confirmed; the ViewModel queues the tombstone.
                ConnectionAction.DELETE -> viewModel.delete(connection)
            }
        },
        onCreate = onCreate,
        onSyncNow = if (localMode) null else viewModel::syncNow,
        onOpenAccount = onOpenAccount,
        onRetry = viewModel::syncNow,
        modifier = modifier,
    )
}

@Composable
fun ConnectionEditorRoute(
    viewModel: ConnectionEditorViewModel,
    onDismiss: () -> Unit,
    onConnect: (Connection, Boolean) -> Unit,
    onMessage: suspend (String) -> Unit,
    onPickDriveDirectory: () -> Unit = {},
    onRequestAllFilesAccess: () -> Unit = {},
    onClearDriveDirectory: () -> Unit = {},
    modifier: Modifier = Modifier,
) {
    val state by viewModel.state.collectAsState()
    val lifecycleOwner = LocalLifecycleOwner.current

    LaunchedEffect(lifecycleOwner, viewModel) {
        lifecycleOwner.lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            try {
                kotlinx.coroutines.awaitCancellation()
            } finally {
                viewModel.hidePassword()
            }
        }
    }

    // The route leaves composition when the app lock covers it, the process backgrounds or the
    // account graph is revoked. Do not let its ViewModel retain typed password/private-key buffers.
    DisposableEffect(viewModel) {
        onDispose(viewModel::clearSecretBuffers)
    }

    CollectMessages(viewModel.message, onMessage)

    LaunchedEffect(viewModel) {
        viewModel.event.collect { event ->
            when (event) {
                ConnectionEditorEvent.Dismissed -> onDismiss()
                is ConnectionEditorEvent.Connect -> onConnect(event.connection, event.persisted)
            }
        }
    }

    ConnectionEditorScreen(
        state = state,
        isCreate = (state as? PageState.Content)?.value?.draft?.isCreate ?: false,
        onIntent = { intent -> dispatch(viewModel, intent, onPickDriveDirectory, onRequestAllFilesAccess, onClearDriveDirectory) },
        onBack = viewModel::dismiss,
        modifier = modifier,
    )
}

/**
 * Single dispatch point for [EditorIntent].
 *
 * One exhaustive `when` rather than a lambda per field: adding a field to the editor then fails to
 * compile here until it is wired, which is the property a bag of 24 lambdas does not have.
 */
private fun dispatch(
    viewModel: ConnectionEditorViewModel,
    intent: EditorIntent,
    onPickDriveDirectory: () -> Unit = {},
    onRequestAllFilesAccess: () -> Unit = {},
    onClearDriveDirectory: () -> Unit = {},
) {
    when (intent) {
        is EditorIntent.Name -> viewModel.setName(intent.value)
        is EditorIntent.Host -> viewModel.setHost(intent.value)
        is EditorIntent.Port -> viewModel.setPort(intent.value)
        is EditorIntent.Username -> viewModel.setUsername(intent.value)
        is EditorIntent.Remark -> viewModel.setRemark(intent.value)
        is EditorIntent.Tags -> viewModel.setTags(intent.value)
        is EditorIntent.ProtocolChanged -> viewModel.setProtocol(intent.value)
        is EditorIntent.Encoding -> viewModel.setEncoding(intent.value)
        is EditorIntent.Mode -> viewModel.setConnectionMode(intent.value)
        is EditorIntent.ProxySelected -> viewModel.setProxy(intent.value)
        is EditorIntent.SshKeySelected -> viewModel.setSshKey(intent.value)
        is EditorIntent.JumpAdded -> viewModel.addJumpHost(intent.value)
        is EditorIntent.JumpRemoved -> viewModel.removeJumpHost(intent.value)
        is EditorIntent.JumpMoved -> viewModel.moveJumpHost(intent.from, intent.to)
        is EditorIntent.Password -> viewModel.setPassword(intent.value)
        is EditorIntent.EditRevealedPassword -> viewModel.editPasswordFromReveal(intent.value)
        EditorIntent.RevealPassword -> viewModel.revealPassword()
        EditorIntent.HidePassword -> viewModel.hidePassword()
        is EditorIntent.PrivateKey -> viewModel.setPrivateKey(intent.value)
        // The Windows domain lives inside RdpSettings, so the editor edits it through this intent
        // rather than through a field of its own.
        is EditorIntent.Rdp -> viewModel.setRdp(intent.value)
        is EditorIntent.FileSync -> viewModel.setFileSyncIntent(intent.value)
        EditorIntent.PickDriveDirectory -> onPickDriveDirectory()
        EditorIntent.ClearDriveDirectory -> {
            onClearDriveDirectory()
            viewModel.clearDriveMapping()
        }
        EditorIntent.RequestAllFilesAccess -> onRequestAllFilesAccess()
        is EditorIntent.Visibility -> viewModel.setVisibility(intent.value)
        is EditorIntent.RepairRoute -> viewModel.repairRoute(intent.field)
        EditorIntent.Test -> viewModel.test()
        EditorIntent.Save -> viewModel.save(thenConnect = false)
        EditorIntent.SaveAndConnect -> viewModel.save(thenConnect = true)
        EditorIntent.ConnectWithoutSaving -> viewModel.connectWithoutSaving()
    }
}

/**
 * Bridges the one-shot message flow to the host's snackbar.
 *
 * Keyed on the flow so a recomposition does not resubscribe and replay, which would show the same
 * "已保存，待同步" twice.
 */
@Composable
private fun CollectMessages(messages: Flow<String>, onMessage: suspend (String) -> Unit) {
    LaunchedEffect(messages) { messages.collect { onMessage(it) } }
}
