package one.zephyr.mobile.app

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.launch
import one.zephyr.mobile.app.di.AccountContainer
import one.zephyr.mobile.app.di.AppContainer
import one.zephyr.mobile.data.repository.ActivityRepository
import one.zephyr.mobile.data.session.SessionRow
import one.zephyr.mobile.feature.connections.ConnectionEditorRoute
import one.zephyr.mobile.feature.connections.ConnectionEditorViewModel
import one.zephyr.mobile.feature.connections.ConnectionListRoute
import one.zephyr.mobile.feature.connections.ConnectionListViewModel
import one.zephyr.mobile.feature.filesync.DirectoryAuthorizationResult
import one.zephyr.mobile.feature.filesync.rememberDirectoryAuthorizer
import one.zephyr.mobile.feature.remote.RdpRemoteRoute
import one.zephyr.mobile.feature.remote.RdpViewModel
import one.zephyr.mobile.feature.remote.RemoteCredentials
import one.zephyr.mobile.feature.remote.VncRemoteRoute
import one.zephyr.mobile.feature.remote.VncViewModel
import one.zephyr.mobile.feature.sessions.SessionListRoute
import one.zephyr.mobile.feature.sessions.SessionListViewModel
import one.zephyr.mobile.feature.sessions.TerminalCredentials
import one.zephyr.mobile.feature.sessions.TerminalDockItem
import one.zephyr.mobile.feature.sessions.TerminalRoute
import one.zephyr.mobile.feature.sessions.TerminalViewModel
import one.zephyr.mobile.feature.sessions.UnavailableTerminalEmulator
import one.zephyr.mobile.feature.sessions.UnavailableTerminalHost
import one.zephyr.mobile.feature.tools.BatchExecutionScreen
import one.zephyr.mobile.feature.tools.BatchExecutionViewModel
import one.zephyr.mobile.feature.tools.BatchIntent
import one.zephyr.mobile.feature.tools.NoopBatchAuditSink
import one.zephyr.mobile.feature.tools.UnavailableRemotePorts
import one.zephyr.mobile.R
import one.zephyr.mobile.model.Connection
import one.zephyr.mobile.model.MobileError
import one.zephyr.mobile.model.Protocol
import one.zephyr.mobile.model.Residency
import one.zephyr.mobile.model.SecretRef
import one.zephyr.mobile.model.SecretPresence
import one.zephyr.mobile.model.SyncStatus
import one.zephyr.mobile.protocol.rdp.UnavailableRdpEngine
import one.zephyr.mobile.protocol.vnc.UnavailableVncEngine
import one.zephyr.mobile.ui.island.FloatingIsland
import one.zephyr.mobile.ui.island.IslandDestination
import one.zephyr.mobile.ui.island.islandContentBottomInset
import one.zephyr.mobile.ui.theme.ZephyrSpacing
import java.util.UUID

/**
 * The root composable, and the app's only navigation authority.
 *
 * Navigation is a saved [RootRoute] value rather than a NavHost. Two reasons, both structural:
 *
 *  - **An immersive session is not "a destination with the bottom bar hidden".** DEVELOPMENT.md 6.1
 *    freezes the island at exactly four root destinations, and 6.4 says a terminal or remote surface
 *    replaces the root chrome entirely. Keeping "which root destination is selected" separate from
 *    "is a full-screen surface open" makes that a type-level fact rather than a per-screen flag some
 *    screen can forget to set.
 *  - **A session is two ids, not a string argument.** A terminal route needs the session id *and*
 *    the connection id; in a route template a typo surfaces at runtime as a blank screen, whereas a
 *    sealed type makes it a compile error.
 *
 * Selecting a root destination replaces rather than pushes, so back from a root destination leaves
 * the app instead of walking a history the island never showed.
 */
@Composable
fun ZephyrOneRoot(
    container: AppContainer,
    locked: Boolean,
    onUnlockRequested: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Surface(modifier = modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        val account = container.account
        when {
            /* The lock gate outranks everything, including a bound account: AppLock is the product
             * gate, and drawing a screen behind it would expose content to the recents screenshot. */
            locked -> LockGate(onUnlockRequested = onUnlockRequested)

            /* S01/S02 (unlock + server binding) have no Compose implementation yet, so this says so
             * instead of rendering an empty dashboard that merely looks broken. */
            account == null -> NoticeScreen(text = NOT_BOUND)

            else -> BoundRoot(account = account)
        }
    }
}

/** Where the user currently is: one root destination, or one full-screen surface above it. */
private sealed interface RootRoute {

    /** One of the four island destinations. */
    data class Root(val destination: IslandDestination) : RootRoute

    /** Null [connectionId] means a new connection. */
    data class ConnectionEditor(val connectionId: String?) : RootRoute

    data class Terminal(val sessionId: String, val connectionId: String) : RootRoute

    data class Remote(
        val sessionId: String,
        val connectionId: String,
        val protocol: Protocol,
    ) : RootRoute
}

/**
 * Survives configuration changes.
 *
 * Worth saving rather than rebuilding from HOME: the activity is recreated on rotation, and dropping
 * back to the dashboard mid-session would look like the app had closed the session.
 */
private val RootRouteSaver = listSaver<RootRoute, String>(
    save = { route ->
        when (route) {
            is RootRoute.Root -> listOf(TAG_ROOT, route.destination.name)
            is RootRoute.ConnectionEditor -> listOf(TAG_EDITOR, route.connectionId ?: "")
            is RootRoute.Terminal -> listOf(TAG_TERMINAL, route.sessionId, route.connectionId)
            is RootRoute.Remote ->
                listOf(TAG_REMOTE, route.sessionId, route.connectionId, route.protocol.name)
        }
    },
    restore = { saved ->
        /* An unreadable payload falls back to HOME rather than throwing. A saved-state format from
         * an older build must not crash the app on first launch after an update. */
        when (saved.firstOrNull()) {
            TAG_ROOT -> RootRoute.Root(
                IslandDestination.entries.firstOrNull { it.name == saved.getOrNull(1) }
                    ?: IslandDestination.HOME,
            )

            TAG_EDITOR -> RootRoute.ConnectionEditor(saved.getOrNull(1)?.takeIf { it.isNotEmpty() })

            TAG_TERMINAL -> {
                val sessionId = saved.getOrNull(1)
                val connectionId = saved.getOrNull(2)
                if (sessionId.isNullOrEmpty() || connectionId.isNullOrEmpty()) {
                    RootRoute.Root(IslandDestination.HOME)
                } else {
                    RootRoute.Terminal(sessionId, connectionId)
                }
            }

            TAG_REMOTE -> {
                val sessionId = saved.getOrNull(1)
                val connectionId = saved.getOrNull(2)
                val protocol = Protocol.entries.firstOrNull { it.name == saved.getOrNull(3) }
                if (sessionId.isNullOrEmpty() || connectionId.isNullOrEmpty() || protocol == null) {
                    RootRoute.Root(IslandDestination.HOME)
                } else {
                    RootRoute.Remote(sessionId, connectionId, protocol)
                }
            }

            else -> RootRoute.Root(IslandDestination.HOME)
        }
    },
)

@Composable
private fun BoundRoot(account: AccountContainer) {
    var route: RootRoute by rememberSaveable(stateSaver = RootRouteSaver) {
        mutableStateOf(RootRoute.Root(IslandDestination.HOME))
    }

    val ownerUserId = account.binding.userId
    val syncStatus = account.syncEngine.status

    /* One message channel for the whole tree. Every route takes a `suspend (String) -> Unit`, and
     * routing them all here means a message raised by a screen that is being navigated away from
     * still reaches the user. */
    val messages = remember { MutableSharedFlow<String>(extraBufferCapacity = 8) }
    val snackbarHostState = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()

    LaunchedEffect(messages, snackbarHostState) {
        messages.collect { message -> snackbarHostState.showSnackbar(message) }
    }

    /* Non-suspend entry point for callbacks that are not suspend (island taps, click handlers). */
    val notice: (String) -> Unit = { message -> scope.launch { messages.emit(message) } }

    Box(modifier = Modifier.fillMaxSize()) {
        val current = route

        when (current) {
            is RootRoute.Root -> RootDestination(
                destination = current.destination,
                account = account,
                ownerUserId = ownerUserId,
                syncStatus = syncStatus,
                onOpenEditor = { id -> route = RootRoute.ConnectionEditor(id) },
                onOpenSession = { sessionId, connectionId, protocol ->
                    route = routeForProtocol(sessionId, connectionId, protocol)
                },
                onMessage = { messages.emit(it) },
                onNotice = notice,
            )

            is RootRoute.ConnectionEditor -> ConnectionEditorRoute(
                viewModel = viewModel(
                    key = "editor:" + (current.connectionId ?: "new"),
                    factory = ConnectionEditorViewModel.factory(
                        connections = account.connections,
                        resources = account.resources,
                        ownerUserId = ownerUserId,
                        connectionId = current.connectionId,
                        newIdFactory = { UUID.randomUUID().toString() },
                        registerSensitiveSink = account::registerSensitiveSink,
                        unregisterSensitiveSink = account::unregisterSensitiveSink,
                    ),
                ),
                onDismiss = { route = RootRoute.Root(IslandDestination.HOME) },
                onConnect = { connection, _ ->
                    route = routeForProtocol(
                        sessionId = UUID.randomUUID().toString(),
                        connectionId = connection.id,
                        protocol = connection.protocol,
                    )
                },
                onMessage = { messages.emit(it) },
            )

            is RootRoute.Terminal -> TerminalRoute(
                viewModel = viewModel(
                    key = "terminal:" + current.sessionId,
                    factory = TerminalViewModel.Factory(
                        sessionId = current.sessionId,
                        connectionId = current.connectionId,
                        registry = account.sessions,
                        connections = account.connections,
                        /* No SSH/Telnet engine is linked yet (ADR-002 has not passed its M0 gate), so
                         * the host reports unavailable with a structured error. A stub that appeared
                         * to connect would be worse than none: the user would believe the session was
                         * live and type credentials into it. */
                        host = UnavailableTerminalHost(TERMINAL_ENGINE_MISSING),
                        emulator = UnavailableTerminalEmulator(),
                        secretProvider = { connection -> account.terminalCredentials(connection) },
                    ),
                ),
                onDock = { item -> onTerminalDock(item, notice) { route = it } },
                onMessage = { messages.emit(it) },
            )

            is RootRoute.Remote -> RemoteDestination(
                route = current,
                account = account,
                onBack = { route = RootRoute.Root(IslandDestination.SESSIONS) },
                onMessage = { messages.emit(it) },
                onNotice = notice,
            )
        }

        /* Drawn last so it floats above content, and only over a root destination. The editor is a
         * full-screen form and a session is immersive, so both hide the island (DEVELOPMENT.md 6.4). */
        if (current is RootRoute.Root) {
            FloatingIsland(
                selected = current.destination,
                onSelect = { destination -> route = RootRoute.Root(destination) },
                modifier = Modifier.align(Alignment.BottomCenter),
            )
        }

        SnackbarHost(
            hostState = snackbarHostState,
            modifier = Modifier.align(Alignment.BottomCenter),
        ) { data -> Snackbar(snackbarData = data) }
    }
}

@Composable
private fun RootDestination(
    destination: IslandDestination,
    account: AccountContainer,
    ownerUserId: String,
    syncStatus: Flow<SyncStatus>,
    onOpenEditor: (String?) -> Unit,
    onOpenSession: (String, String, Protocol) -> Unit,
    onMessage: suspend (String) -> Unit,
    onNotice: (String) -> Unit,
) {
    val nowMs = System.currentTimeMillis()

    when (destination) {
        IslandDestination.HOME -> {
            val activityRepository = remember(account) { ActivityRepository(account.database) }
            val activity by activityRepository.observeRecent(ownerUserId)
                .collectAsState(initial = emptyList())
            val status by syncStatus.collectAsState(initial = SyncStatus.unbound())

            ConnectionListRoute(
                viewModel = viewModel(
                    key = "connections",
                    factory = ConnectionListViewModel.factory(
                        connections = account.connections,
                        settings = account.settings,
                        shared = account.sharedResources,
                        ownerUserId = ownerUserId,
                        syncStatus = syncStatus,
                        network = account.network,
                        syncNowAction = { account.syncEngine.syncNow() },
                    ),
                ),
                syncStatus = status,
                activity = activity,
                nowMs = nowMs,
                onOpenConnection = { connection ->
                    onOpenSession(UUID.randomUUID().toString(), connection.id, connection.protocol)
                },
                onEditConnection = { connection -> onOpenEditor(connection.id) },
                /* Opens the source row rather than pre-filling a copy: the editor has no duplicate
                 * mode, and silently editing the original would be the wrong write. */
                onDuplicateConnection = { onNotice(PENDING_DUPLICATE) },
                onTestConnection = { onNotice(PENDING_TEST) },
                onShareConnection = { onNotice(PENDING_SHARE) },
                onCreate = { onOpenEditor(null) },
                onOpenAccount = { onNotice(PENDING_ACCOUNT) },
                onMessage = onMessage,
            )
        }

        IslandDestination.SESSIONS -> SessionListRoute(
            viewModel = viewModel(
                key = "sessions",
                factory = SessionListViewModel.Factory(
                    registry = account.sessions,
                    connections = account.connections,
                    ownerUserId = ownerUserId,
                    network = account.network,
                    /* Nothing to close at transport level while the engines are unavailable. The
                     * ViewModel still updates the registry, so the row moves to 已关闭 either way. */
                    closeTransport = { _: SessionRow -> },
                    /* Restores directly into the registry, which is what the persistence class does;
                     * the empty list means "no extra snapshots beyond what was restored". */
                    loadWorkspace = {
                        account.workspaceState.restore(
                            registry = account.sessions,
                            capabilitiesFor = { null },
                            residencyFor = { Residency.OWNED },
                        )
                        emptyList()
                    },
                ),
            ),
            nowMs = nowMs,
            onOpenTerminal = { sessionId, connectionId ->
                onOpenSession(sessionId, connectionId, Protocol.SSH)
            },
            onOpenRemote = { sessionId, connectionId ->
                /* The registry row knows the real protocol; RDP is the fallback when the row is gone. */
                val protocol = account.sessions.find(sessionId)?.protocol ?: Protocol.RDP
                onOpenSession(sessionId, connectionId, protocol)
            },
            onDetails = { onNotice(PENDING_SESSION_DETAILS) },
            onMessage = onMessage,
        )

        /* 资料 (notes / recent files / snippets). feature-notes has its state and reducers but no
         * Composable yet, so this names the gap instead of rendering an empty list, which would be a
         * false claim that the user has no notes. */
        IslandDestination.LIBRARY -> NoticeScreen(text = PENDING_LIBRARY)

        IslandDestination.TOOLS -> {
            val toolsViewModel: BatchExecutionViewModel = viewModel(
                key = "tools:batch",
                factory = BatchExecutionViewModel.factory(
                    connections = account.connections,
                    exec = UnavailableRemotePorts,
                    audit = NoopBatchAuditSink,
                    ownerUserId = ownerUserId,
                    network = account.network,
                ),
            )
            val state by toolsViewModel.state.collectAsState()

            BatchExecutionScreen(
                state = state,
                onIntent = { intent -> toolsViewModel.dispatch(intent) },
                /* The page state is derived from a Room flow that re-emits on its own, so there is no
                 * fetch to repeat. Clearing the selection is the one recovery the ViewModel offers
                 * for a plan that references rows the mirror no longer has. */
                onRetry = { toolsViewModel.clearSelection() },
            )
        }
    }
}

@Composable
private fun RemoteDestination(
    route: RootRoute.Remote,
    account: AccountContainer,
    onBack: () -> Unit,
    onMessage: suspend (String) -> Unit,
    onNotice: (String) -> Unit,
) {
    val nowMs = System.currentTimeMillis()
    val networkState by account.network.collectAsState(initial = null)
    val online = networkState?.connected == true

    if (route.protocol == Protocol.VNC) {
        VncRemoteRoute(
            viewModel = viewModel(
                key = "vnc:" + route.sessionId,
                factory = VncViewModel.Factory(
                    sessionId = route.sessionId,
                    connectionId = route.connectionId,
                    registry = account.sessions,
                    connections = account.connections,
                    engine = UnavailableVncEngine(),
                    secretProvider = { connection ->
                        RemoteCredentials(password = account.passwordChars(connection))
                    },
                    registerSensitiveSink = account::registerSensitiveSink,
                    unregisterSensitiveSink = account::unregisterSensitiveSink,
                ),
            ),
            nowMs = nowMs,
            online = online,
            onBack = onBack,
            onMessage = onMessage,
        )
    } else {
        /* Observed rather than fetched once: the connection's file-write capability decides how much
         * authority the picker asks the system for, and a shared connection's grant can be narrowed
         * while the session is open. */
        val connection by account.connections.observe(route.connectionId).collectAsState(initial = null)

        /* The SAF picker, which is what stopped onPickDriveDirectory from being a placeholder.
         *
         * requestWrite follows the connection instead of always asking for write: FILE_WRITE on a
         * shared connection is the ACL's answer, and asking the user's document provider for more
         * authority than the connection can use would make a read-only share indistinguishable from
         * a writable one at the permission layer. SafShareGrants narrows the result again to what
         * the system actually granted (DEVELOPMENT.md 13.2 takes the strictest of the layers).
         *
         * A fresh profile id per authorisation, not one derived from the connection: several
         * connections may share one directory, and DEVELOPMENT.md 13.2 keeps the id device-local and
         * the choice per connection. Reusing the connection id as a profile id would conflate the
         * two and make one connection's re-pick silently move another's share.
         */
        val pickDirectory = rememberDirectoryAuthorizer(
            grants = account.shareGrants,
            requestWrite = connection?.capabilities?.canWriteFiles == true,
            profileIdFactory = { UUID.randomUUID().toString() },
            shareNameFactory = { connection?.name.orEmpty() },
            onResult = { result ->
                when (result) {
                    is DirectoryAuthorizationResult.Authorized -> {
                        account.connectionShares.choose(route.connectionId, result.grant.profileId)
                        onNotice(DRIVE_AUTHORIZED + result.grant.shareName)
                    }
                    /* Silent on cancel. The user backed out of the picker; nothing changed and a
                     * message would report a failure that did not happen. */
                    DirectoryAuthorizationResult.Cancelled -> Unit
                    DirectoryAuthorizationResult.Refused -> onNotice(DRIVE_REFUSED)
                }
            },
        )

        val rdpViewModel: RdpViewModel = viewModel(
            key = "rdp:" + route.sessionId,
            factory = RdpViewModel.Factory(
                sessionId = route.sessionId,
                connectionId = route.connectionId,
                registry = account.sessions,
                connections = account.connections,
                engine = UnavailableRdpEngine(),
                secretProvider = { candidate -> account.passwordChars(candidate) },
                /* The real grant, re-derived on every resolution.
                 *
                 * Previously a hardcoded null, which made RdpDrivePolicy answer
                 * file_share_unavailable no matter what the user had authorised and left the SAF
                 * provider unreachable. The coordinator returns null only when no directory is
                 * chosen, and a profile with grantValid=false when one is chosen but its grant
                 * died -- the policy renders those differently, and the second is the one that
                 * tells the user to re-authorise. */
                driveProfileProvider = { candidate ->
                    account.fileSyncShares.profile(candidate.id)
                },
            ),
        )
        val permissionActions = rememberRdpChannelPermissionActions(
            onObserved = rdpViewModel::onPermissionStateObserved,
            onResult = rdpViewModel::onPermissionResult,
        )

        // Querying existing grants is safe on entry; only the channel-row actions below launch UI.
        LaunchedEffect(rdpViewModel, permissionActions) {
            permissionActions.refreshExisting()
        }

        RdpRemoteRoute(
            viewModel = rdpViewModel,
            nowMs = nowMs,
            online = online,
            onBack = onBack,
            onRequestPermission = permissionActions.request,
            onOpenAppSettings = permissionActions.openSettings,
            onPickDriveDirectory = pickDirectory,
            onMessage = onMessage,
        )
    }
}

@Composable
private fun LockGate(onUnlockRequested: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(ZephyrSpacing.lg),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = stringResource(R.string.unlock_title),
            style = MaterialTheme.typography.headlineSmall,
        )
        Text(
            text = stringResource(R.string.unlock_subtitle),
            style = MaterialTheme.typography.bodyMedium,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = ZephyrSpacing.sm),
        )
        Button(onClick = onUnlockRequested, modifier = Modifier.padding(top = ZephyrSpacing.lg)) {
            Text(text = stringResource(R.string.unlock_retry))
        }
    }
}

/**
 * Names a screen or action that is specified but not implemented.
 *
 * Deliberately not an empty state: "you have nothing here" is a false statement about a screen that
 * was never written, and it is indistinguishable from real data loss.
 */
@Composable
private fun NoticeScreen(text: String) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .padding(
                start = ZephyrSpacing.lg,
                end = ZephyrSpacing.lg,
                top = ZephyrSpacing.lg,
                bottom = islandContentBottomInset(),
            ),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = text,
            style = MaterialTheme.typography.bodyLarge,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

private fun routeForProtocol(sessionId: String, connectionId: String, protocol: Protocol): RootRoute =
    if (protocol.isTerminal) {
        RootRoute.Terminal(sessionId, connectionId)
    } else {
        RootRoute.Remote(sessionId, connectionId, protocol)
    }

/**
 * Terminal dock routing.
 *
 * 会话 is the only item with a destination that exists. The rest are enumerated rather than handled
 * by an `else` so that adding a dock item forces a decision here instead of silently doing nothing.
 */
private fun onTerminalDock(
    item: TerminalDockItem,
    onNotice: (String) -> Unit,
    navigate: (RootRoute) -> Unit,
) {
    when (item) {
        TerminalDockItem.SESSIONS -> navigate(RootRoute.Root(IslandDestination.SESSIONS))
        TerminalDockItem.FILES -> onNotice(PENDING_SFTP)
        TerminalDockItem.SNIPPETS -> onNotice(PENDING_SNIPPETS)
        TerminalDockItem.NOTES -> onNotice(PENDING_NOTES)
        /* Handled inside the terminal itself: KEYBOARD toggles the IME and DISCONNECT is consumed by
         * the ViewModel before it reaches this callback. */
        TerminalDockItem.KEYBOARD, TerminalDockItem.DISCONNECT -> Unit
    }
}

/**
 * Applies one [BatchIntent] to the ViewModel.
 *
 * The ViewModel exposes one method per action rather than a single `dispatch`, and the screen speaks
 * in intents, so the mapping lives here. An exhaustive `when` means a new intent is a compile error
 * rather than a button that does nothing.
 */
private fun BatchExecutionViewModel.dispatch(intent: BatchIntent) {
    when (intent) {
        is BatchIntent.Command -> this.setCommand(intent.value)
        is BatchIntent.Timeout -> this.setTimeout(intent.seconds)
        is BatchIntent.Concurrency -> this.setConcurrency(intent.value)
        is BatchIntent.FailFast -> this.setFailFast(intent.enabled)
        is BatchIntent.ToggleTarget -> this.toggleTarget(intent.connectionId)
        BatchIntent.SelectAllEligible -> this.selectAllEligible()
        BatchIntent.ClearSelection -> this.clearSelection()
        BatchIntent.Run -> this.run()
        BatchIntent.CancelRun -> this.cancelRun()
        is BatchIntent.CancelTarget -> this.cancelTarget(intent.connectionId)
        BatchIntent.Export -> this.export()
    }
}

/**
 * Reads one decrypted password for a single open attempt.
 *
 * Prefers the ref the mirror recorded and falls back to the conventional field ref, because a row
 * written before the ref was persisted still has its secret under the derived name.
 */
private fun AccountContainer.passwordChars(connection: Connection): CharArray? {
    val ref = secretRefForPresence(
        presence = connection.password,
        entityType = Connection.ENTITY_TYPE,
        entityId = connection.id,
        fieldName = FIELD_PASSWORD,
    ) ?: return null
    return secretStore.getText(ref)?.toCharArray()
}

private fun AccountContainer.terminalCredentials(connection: Connection): TerminalCredentials =
    TerminalCredentials(
        password = passwordChars(connection),
        privateKey = secretRefForPresence(
            presence = connection.privateKey,
            entityType = Connection.ENTITY_TYPE,
            entityId = connection.id,
            fieldName = FIELD_PRIVATE_KEY,
        )?.let { secretStore.getText(it)?.toCharArray() },
    )

/** Presence is the authorization gate; an explicit ref must also name this exact field. */
internal fun secretRefForPresence(
    presence: SecretPresence,
    entityType: String,
    entityId: String,
    fieldName: String,
): SecretRef? {
    if (!presence.hasValue) return null
    val explicit = presence.secretRef?.let(::SecretRef) ?: return SecretRef.of(entityType, entityId, fieldName)
    val parts = explicit.partsOrNull() ?: return null
    if (parts.entityType != entityType || parts.entityId != entityId || parts.fieldName != fieldName) return null
    return explicit.canonical()
}

private const val TAG_ROOT = "root"
private const val TAG_EDITOR = "editor"
private const val TAG_TERMINAL = "terminal"
private const val TAG_REMOTE = "remote"

private const val FIELD_PASSWORD = "password"
private const val FIELD_PRIVATE_KEY = "privateKey"

private const val NOT_BOUND =
    "尚未绑定账号。请先在主端创建 Client Token，再在本机完成绑定（S01/S02 界面尚未实现）。"
private const val PENDING_LIBRARY = "资料（笔记 / 最近文件 / 代码片段）界面尚未实现。"
private const val PENDING_DUPLICATE = "复制连接尚未实现。"
private const val PENDING_TEST = "连接测试尚未实现：原生协议引擎未链接。"
private const val PENDING_SHARE = "共享权限界面尚未实现。"
private const val PENDING_ACCOUNT = "账号界面尚未实现。"
private const val PENDING_SESSION_DETAILS = "会话详情界面尚未实现。"
private const val PENDING_SFTP = "SFTP 浏览界面尚未实现。"
private const val PENDING_SNIPPETS = "代码片段界面尚未实现。"
private const val PENDING_NOTES = "笔记界面尚未实现。"
/* The SAF picker is wired (see RemoteDestination), so the placeholder is gone. These two report
 * its outcomes; cancelling deliberately has no message. */
private const val DRIVE_AUTHORIZED = "已授权目录，远端共享名："
private const val DRIVE_REFUSED = "系统未能保留该目录授权，请重新选择目录。"

private val TERMINAL_ENGINE_MISSING: MobileError = MobileError.local(
    code = "engine_unavailable",
    message = "原生 SSH/Telnet 引擎尚未链接（ADR-002 未过 M0 门）",
)
