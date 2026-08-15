package one.zephyr.mobile.app

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.ContentTransform
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import one.zephyr.mobile.ui.component.Button
import one.zephyr.mobile.ui.component.Surface
import one.zephyr.mobile.ui.component.Text
import one.zephyr.mobile.ui.component.TextButton
import one.zephyr.mobile.ui.theme.ZephyrTextStyles
import one.zephyr.mobile.ui.theme.ZephyrTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.activity.compose.BackHandler
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import one.zephyr.mobile.app.di.AccountContainer
import one.zephyr.mobile.app.di.AppContainer
import one.zephyr.mobile.data.repository.ActivityRepository
import one.zephyr.mobile.data.session.SessionRow
import one.zephyr.mobile.data.session.SessionTransport
import one.zephyr.mobile.feature.connections.ConnectionEditorRoute
import one.zephyr.mobile.feature.connections.ConnectionEditorViewModel
import one.zephyr.mobile.feature.connections.ConnectionListRoute
import one.zephyr.mobile.feature.connections.ConnectionListViewModel
import one.zephyr.mobile.feature.connections.ProtocolPickerScreen
import one.zephyr.mobile.feature.tools.OpsSection
import one.zephyr.mobile.feature.tools.ResourceKind
import one.zephyr.mobile.feature.tools.OneSettingsAnchor
import androidx.compose.foundation.clickable
import one.zephyr.mobile.feature.filesync.DirectoryAuthorizationResult
import one.zephyr.mobile.feature.filesync.rememberDirectoryAuthorizer
import one.zephyr.mobile.feature.notes.LibraryRootContent
import one.zephyr.mobile.feature.notes.LibraryRootRoute
import one.zephyr.mobile.feature.notes.RecentFileRecord
import one.zephyr.mobile.feature.notes.RecentResourceFiles
import one.zephyr.mobile.feature.notes.ResourceHomeSummary
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
import one.zephyr.mobile.feature.sessions.SshTerminalHost
import one.zephyr.mobile.feature.sessions.productionTerminalEmulator
import one.zephyr.mobile.feature.sessions.TerminalWorkspaceState
import one.zephyr.mobile.feature.tools.BatchExecutionScreen
import one.zephyr.mobile.feature.tools.BatchExecutionViewModel
import one.zephyr.mobile.feature.tools.BatchIntent
import one.zephyr.mobile.feature.tools.NoopBatchAuditSink
import one.zephyr.mobile.feature.tools.ServerHubScreen
import one.zephyr.mobile.feature.tools.UnavailableRemotePorts
import one.zephyr.mobile.feature.tools.ToolEntry
import one.zephyr.mobile.feature.tools.ToolsInventory
import one.zephyr.mobile.feature.tools.ToolsRootRoute
import one.zephyr.mobile.feature.tools.ToolsRootSummaries
import one.zephyr.mobile.R
import one.zephyr.mobile.model.Connection
import one.zephyr.mobile.model.MobileError
import one.zephyr.mobile.model.Note
import one.zephyr.mobile.model.Protocol
import one.zephyr.mobile.model.Residency
import one.zephyr.mobile.model.SecretRef
import one.zephyr.mobile.model.SecretPresence
import one.zephyr.mobile.model.SyncStatus
import one.zephyr.mobile.model.SyncState
import one.zephyr.mobile.model.Snippet
import one.zephyr.mobile.security.AuthResult
import one.zephyr.mobile.security.UnlockPresentation
import one.zephyr.mobile.data.session.SessionExecution
import one.zephyr.mobile.ui.chrome.PushedPageHeader
import one.zephyr.mobile.ui.island.FloatingIsland
import one.zephyr.mobile.ui.island.IslandDestination
import one.zephyr.mobile.ui.island.islandContentBottomInset
import one.zephyr.mobile.ui.theme.ZephyrSpacing
import one.zephyr.mobile.ui.theme.ZephyrMotionTokens
import java.util.UUID
import kotlin.math.roundToInt

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
    onUnlockRequested: suspend () -> AuthResult,
    modifier: Modifier = Modifier,
    integrations: ZephyrOneIntegrations = ZephyrOneIntegrations(),
) {
    Surface(modifier = modifier.fillMaxSize(), color = ZephyrTheme.palette.surfaces.background) {
        val account by container.accounts.collectAsState()
        when {
            /* The lock gate outranks everything, including a bound account: AppLock is the product
             * gate, and drawing a screen behind it would expose content to the recents screenshot. */
            locked -> LockGate(onUnlockRequested = onUnlockRequested)

            /* Startup recovery is still opening the local workspace. The window already matches
             * the dashboard colour, so this is a same-colour hold rather than a black flash. */
            account == null -> Box(Modifier.fillMaxSize())

            else -> account?.let { activeAccount ->
                key(activeAccount.generation) {
                    BoundRoot(
                        account = activeAccount,
                        appContainer = container,
                        integrations = integrations,
                        vncEngine = container.vncEngine,
                        rdpEngine = container.rdpEngine,
                        sshEngine = container.sshEngine,
                    )
                }
            }
        }
    }
}

/** Optional destinations owned by host modules that are not part of this Android UI slice. */
data class ZephyrOneIntegrations(
    val onTestConnection: ((Connection) -> Unit)? = null,
    val onShareConnection: ((Connection) -> Unit)? = null,
    val onOpenAccount: (() -> Unit)? = null,
    val onOpenServerBinding: (() -> Unit)? = null,
    val onLibraryAction: ((LibraryAction) -> Unit)? = null,
    val onOpenTool: ((ToolEntry) -> Unit)? = null,
)

sealed interface LibraryAction {
    data object Create : LibraryAction
    data object CreateNote : LibraryAction
    data object CreateSnippet : LibraryAction
    data object Files : LibraryAction
    data object Notes : LibraryAction
    data object Snippets : LibraryAction
    data object Downloads : LibraryAction
    data class RecentFile(val value: RecentFileRecord) : LibraryAction
    data class OpenNote(val value: Note) : LibraryAction
    data class OpenSnippet(val value: Snippet) : LibraryAction
}

/** Where the user currently is: one root destination, or one full-screen surface above it. */
private sealed interface RootRoute {

    /** One of the four island destinations. */
    data class Root(val destination: IslandDestination) : RootRoute

    /** Null [connectionId] means a new connection. */
    data class ConnectionEditor(
        val connectionId: String?,
        val duplicateSourceId: String? = null,
        val protocol: Protocol = Protocol.SSH,
    ) : RootRoute

    data object ProtocolPicker : RootRoute

    data class SessionDetails(val sessionId: String) : RootRoute

    data object BatchExecution : RootRoute

    data object Notes : RootRoute
    data class NoteEditor(val noteId: String?) : RootRoute
    data object Snippets : RootRoute
    data class SnippetEditor(val snippetId: String?) : RootRoute
    data object Files : RootRoute
    data object Downloads : RootRoute
    data object LibraryCreate : RootRoute

    data object Appearance : RootRoute
    data object Language : RootRoute
    data object AppLock : RootRoute
    data object Network : RootRoute
    data object Diagnostics : RootRoute
    data object FileSync : RootRoute
    data object ClientToken : RootRoute
    data object Conflicts : RootRoute
    data object Devices : RootRoute
    data object LocalShares : RootRoute
    data object ServerBinding : RootRoute
    data object ServerHub : RootRoute
    data object ServerSettings : RootRoute
    data object Backup : RootRoute
    data object RuntimeStatus : RootRoute
    data object AiSettings : RootRoute
    data class Ops(val section: OpsSection) : RootRoute
    data class ResourceList(val kind: ResourceKind) : RootRoute
    data class ResourceEditor(val kind: ResourceKind, val entityId: String?) : RootRoute

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
            is RootRoute.ConnectionEditor ->
                listOf(TAG_EDITOR, route.connectionId ?: "", route.duplicateSourceId ?: "", route.protocol.name)
            RootRoute.ProtocolPicker -> listOf(TAG_PROTOCOL)
            is RootRoute.SessionDetails -> listOf(TAG_SESSION_DETAILS, route.sessionId)
            RootRoute.BatchExecution -> listOf(TAG_BATCH)
            is RootRoute.Terminal -> listOf(TAG_TERMINAL, route.sessionId, route.connectionId)
            is RootRoute.Remote ->
                listOf(TAG_REMOTE, route.sessionId, route.connectionId, route.protocol.name)
            RootRoute.Notes -> listOf(TAG_NOTES)
            is RootRoute.NoteEditor -> listOf(TAG_NOTE_EDITOR, route.noteId ?: "")
            RootRoute.Snippets -> listOf(TAG_SNIPPETS)
            is RootRoute.SnippetEditor -> listOf(TAG_SNIPPET_EDITOR, route.snippetId ?: "")
            RootRoute.Files -> listOf(TAG_FILES)
            RootRoute.Downloads -> listOf(TAG_DOWNLOADS)
            RootRoute.LibraryCreate -> listOf(TAG_LIBRARY_CREATE)
            RootRoute.Appearance -> listOf(TAG_APPEARANCE)
            RootRoute.Language -> listOf(TAG_LANGUAGE)
            RootRoute.AppLock -> listOf(TAG_APP_LOCK)
            RootRoute.Network -> listOf(TAG_NETWORK)
            RootRoute.Diagnostics -> listOf(TAG_DIAGNOSTICS)
            RootRoute.FileSync -> listOf(TAG_FILE_SYNC)
            RootRoute.ClientToken -> listOf(TAG_CLIENT_TOKEN)
            RootRoute.Conflicts -> listOf(TAG_CONFLICTS)
            RootRoute.Devices -> listOf(TAG_DEVICES)
            RootRoute.LocalShares -> listOf(TAG_SHARES)
            RootRoute.ServerBinding -> listOf(TAG_BINDING)
            RootRoute.ServerHub -> listOf(TAG_SERVER)
            RootRoute.ServerSettings -> listOf(TAG_SERVER_SETTINGS)
            RootRoute.Backup -> listOf(TAG_BACKUP)
            RootRoute.RuntimeStatus -> listOf(TAG_RUNTIME)
            RootRoute.AiSettings -> listOf(TAG_AI)
            is RootRoute.Ops -> listOf(TAG_OPS, route.section.name)
            is RootRoute.ResourceList -> listOf(TAG_RESOURCE_LIST, route.kind.name)
            is RootRoute.ResourceEditor -> listOf(TAG_RESOURCE_EDITOR, route.kind.name, route.entityId ?: "")
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

            TAG_EDITOR -> RootRoute.ConnectionEditor(
                connectionId = saved.getOrNull(1)?.takeIf { it.isNotEmpty() },
                duplicateSourceId = saved.getOrNull(2)?.takeIf { it.isNotEmpty() },
                protocol = Protocol.entries.firstOrNull { it.name == saved.getOrNull(3) } ?: Protocol.SSH,
            )

            TAG_PROTOCOL -> RootRoute.ProtocolPicker

            TAG_NOTES -> RootRoute.Notes
            TAG_NOTE_EDITOR -> RootRoute.NoteEditor(saved.getOrNull(1)?.takeIf { it.isNotEmpty() })
            TAG_SNIPPETS -> RootRoute.Snippets
            TAG_SNIPPET_EDITOR -> RootRoute.SnippetEditor(saved.getOrNull(1)?.takeIf { it.isNotEmpty() })
            TAG_FILES -> RootRoute.Files
            TAG_DOWNLOADS -> RootRoute.Downloads
            TAG_LIBRARY_CREATE -> RootRoute.LibraryCreate
            TAG_APPEARANCE -> RootRoute.Appearance
            TAG_LANGUAGE -> RootRoute.Language
            TAG_APP_LOCK -> RootRoute.AppLock
            TAG_NETWORK -> RootRoute.Network
            TAG_DIAGNOSTICS -> RootRoute.Diagnostics
            TAG_FILE_SYNC -> RootRoute.FileSync
            TAG_CLIENT_TOKEN -> RootRoute.ClientToken
            TAG_CONFLICTS -> RootRoute.Conflicts
            TAG_DEVICES -> RootRoute.Devices
            TAG_SHARES -> RootRoute.LocalShares
            TAG_BINDING -> RootRoute.ServerBinding
            TAG_SERVER -> RootRoute.ServerHub
            TAG_SERVER_SETTINGS -> RootRoute.ServerSettings
            TAG_BACKUP -> RootRoute.Backup
            TAG_RUNTIME -> RootRoute.RuntimeStatus
            TAG_AI -> RootRoute.AiSettings
            TAG_OPS -> RootRoute.Ops(
                OpsSection.entries.firstOrNull { it.name == saved.getOrNull(1) } ?: OpsSection.DOCKER,
            )
            TAG_RESOURCE_LIST -> ResourceKind.entries.firstOrNull { it.name == saved.getOrNull(1) }
                ?.let(RootRoute::ResourceList)
                ?: RootRoute.Root(IslandDestination.TOOLS)
            TAG_RESOURCE_EDITOR -> ResourceKind.entries.firstOrNull { it.name == saved.getOrNull(1) }
                ?.let { RootRoute.ResourceEditor(it, saved.getOrNull(2)?.takeIf { id -> id.isNotEmpty() }) }
                ?: RootRoute.Root(IslandDestination.TOOLS)

            TAG_SESSION_DETAILS -> saved.getOrNull(1)?.takeIf { it.isNotEmpty() }
                ?.let(RootRoute::SessionDetails)
                ?: RootRoute.Root(IslandDestination.SESSIONS)

            TAG_BATCH -> RootRoute.BatchExecution

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
private fun BoundRoot(
    account: AccountContainer,
    appContainer: AppContainer,
    integrations: ZephyrOneIntegrations,
    vncEngine: one.zephyr.mobile.protocol.vnc.VncEngine,
    rdpEngine: one.zephyr.mobile.protocol.rdp.RdpEngine,
    sshEngine: one.zephyr.mobile.protocol.ssh.SshEngine,
) {
    var route: RootRoute by rememberSaveable(stateSaver = RootRouteSaver) {
        mutableStateOf(RootRoute.Root(IslandDestination.HOME))
    }

    val ownerUserId = account.binding.userId
    val syncStatus = account.syncEngine.status

    /* One message channel for the whole tree. Every route takes a `suspend (String) -> Unit`, and
     * routing them all here means a message raised by a screen that is being navigated away from
     * still reaches the user. */
    val messages = remember { MutableSharedFlow<String>(extraBufferCapacity = 8) }
    var toastMessage by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val motion = ZephyrTheme.motion
    val islandHiddenOffsetPx = with(LocalDensity.current) { 120.dp.roundToPx() }
    var lastRoot by rememberSaveable { mutableStateOf(IslandDestination.HOME) }

    LaunchedEffect(messages) {
        messages.collect { message -> toastMessage = message }
    }

    /* Non-suspend entry point for callbacks that are not suspend (island taps, click handlers). */
    val notice: (String) -> Unit = { message -> scope.launch { messages.emit(message) } }

    LaunchedEffect(route) {
        (route as? RootRoute.Root)?.let { lastRoot = it.destination }
    }

    BackHandler(enabled = route !is RootRoute.Root) {
        route = popRoute(route)
    }

    Box(modifier = Modifier.fillMaxSize()) {
        val current = route

        AnimatedContent(
            targetState = current,
            modifier = Modifier.fillMaxSize(),
            contentKey = ::routeContentKey,
            transitionSpec = {
                routeTransition(
                    initial = initialState,
                    target = targetState,
                    durationMillis = motion.scale(ZephyrMotionTokens.SHEET_MS),
                    reduceMotion = motion.reduceMotion,
                )
            },
            label = "pageStack",
        ) { current ->
            Surface(
                modifier = Modifier.fillMaxSize(),
                color = ZephyrTheme.palette.surfaces.background,
            ) {
                when (current) {
            is RootRoute.Root -> RootDestination(
                destination = current.destination,
                account = account,
                ownerUserId = ownerUserId,
                syncStatus = syncStatus,
                onOpenEditor = { id ->
                    route = if (id == null) RootRoute.ProtocolPicker else RootRoute.ConnectionEditor(id)
                },
                onDuplicateConnection = { id -> route = RootRoute.ConnectionEditor(null, id) },
                onOpenSession = { sessionId, connectionId, protocol ->
                    route = routeForProtocol(sessionId, connectionId, protocol)
                },
                onMessage = { messages.emit(it) },
                onNotice = notice,
                integrations = integrations,
                onOpenSessionDetails = { sessionId -> route = RootRoute.SessionDetails(sessionId) },
                onOpenBatch = { route = RootRoute.BatchExecution },
                onLibraryAction = { action ->
                    route = when (action) {
                        LibraryAction.Create -> RootRoute.LibraryCreate
                        LibraryAction.CreateNote -> RootRoute.NoteEditor(null)
                        LibraryAction.CreateSnippet -> RootRoute.SnippetEditor(null)
                        LibraryAction.Files, is LibraryAction.RecentFile -> RootRoute.Files
                        LibraryAction.Notes -> RootRoute.Notes
                        is LibraryAction.OpenNote -> RootRoute.NoteEditor(action.value.noteId)
                        LibraryAction.Snippets -> RootRoute.Snippets
                        is LibraryAction.OpenSnippet -> RootRoute.SnippetEditor(action.value.id)
                        LibraryAction.Downloads -> RootRoute.Downloads
                    }
                },
                onOpenBinding = { route = RootRoute.ServerBinding },
                onOpenTool = { entry ->
                    route = when (entry) {
                        ToolEntry.BATCH_EXEC -> RootRoute.BatchExecution
                        ToolEntry.DOCKER -> RootRoute.Ops(OpsSection.DOCKER)
                        ToolEntry.MONITOR -> RootRoute.Ops(OpsSection.METRICS)
                        ToolEntry.LOGS -> RootRoute.Ops(OpsSection.LOGS)
                        ToolEntry.PROXY -> RootRoute.ResourceList(ResourceKind.PROXY)
                        ToolEntry.SSH_KEY -> RootRoute.ResourceList(ResourceKind.SSH_KEY)
                        ToolEntry.JUMP_HOST -> RootRoute.ResourceList(ResourceKind.JUMP_HOST)
                        ToolEntry.AI_WORKSPACE -> RootRoute.AiSettings
                        ToolEntry.FILE_SYNC -> RootRoute.FileSync
                        ToolEntry.CLIENT_TOKEN -> RootRoute.ClientToken
                        ToolEntry.SERVER_SETTINGS -> RootRoute.ServerHub
                        ToolEntry.BACKUP_RESTORE -> RootRoute.Backup
                        ToolEntry.RUNTIME_STATUS -> RootRoute.RuntimeStatus
                        ToolEntry.APPEARANCE -> RootRoute.Appearance
                        ToolEntry.LANGUAGE -> RootRoute.Language
                        ToolEntry.APP_LOCK -> RootRoute.AppLock
                        ToolEntry.NETWORK -> RootRoute.Network
                        ToolEntry.DIAGNOSTICS -> RootRoute.Diagnostics
                    }
                },
                vncEngine = vncEngine,
                rdpEngine = rdpEngine,
            )

            is RootRoute.ConnectionEditor -> ConnectionEditorRoute(
                viewModel = viewModel(
                    key = "editor:" + (current.connectionId ?: ("new:" + current.protocol.name)),
                    factory = ConnectionEditorViewModel.factory(
                        connections = account.connections,
                        resources = account.resources,
                        ownerUserId = ownerUserId,
                        connectionId = current.connectionId,
                        duplicateSourceId = current.duplicateSourceId,
                        initialProtocol = current.protocol,
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

            RootRoute.ProtocolPicker -> ProtocolPickerScreen(
                onSelect = { protocol -> route = RootRoute.ConnectionEditor(null, protocol = protocol) },
                onBack = { route = RootRoute.Root(IslandDestination.HOME) },
            )

            RootRoute.Notes -> NotesDestination(
                account = account,
                ownerUserId = ownerUserId,
                onBack = { route = RootRoute.Root(IslandDestination.LIBRARY) },
                onOpen = { note -> route = RootRoute.NoteEditor(note.noteId) },
                onCreate = { route = RootRoute.NoteEditor(null) },
            )
            is RootRoute.NoteEditor -> NoteEditorDestination(
                account = account,
                ownerUserId = ownerUserId,
                noteId = current.noteId,
                onBack = { route = RootRoute.Notes },
                onMessage = { messages.emit(it) },
            )
            RootRoute.Snippets -> SnippetsDestination(
                account = account,
                ownerUserId = ownerUserId,
                onBack = { route = RootRoute.Root(IslandDestination.LIBRARY) },
                onOpen = { snippet -> route = RootRoute.SnippetEditor(snippet.id) },
                onCreate = { route = RootRoute.SnippetEditor(null) },
                onInsert = { notice("插入需要一个已打开的终端会话") },
                onRun = { notice("执行需要 SSH 引擎（ADR-002）和 execute 权限") },
            )
            is RootRoute.SnippetEditor -> SnippetEditorDestination(
                account = account,
                ownerUserId = ownerUserId,
                snippetId = current.snippetId,
                onBack = { route = RootRoute.Snippets },
                onMessage = { messages.emit(it) },
            )
            RootRoute.Files -> FilesDestination(
                account = account,
                ownerUserId = ownerUserId,
                onBack = { route = RootRoute.Root(IslandDestination.LIBRARY) },
                onOpenConnection = { notice(UnavailableSftpMessage) },
            )
            RootRoute.Downloads -> DownloadsDestination(onBack = { route = RootRoute.Root(IslandDestination.LIBRARY) })
            RootRoute.LibraryCreate -> {
                Box(Modifier.fillMaxSize()) {
                    LibraryDestination(
                        account = account,
                        ownerUserId = ownerUserId,
                        nowMs = System.currentTimeMillis(),
                        onAction = { action ->
                            route = when (action) {
                                LibraryAction.Create -> RootRoute.LibraryCreate
                                LibraryAction.CreateNote -> RootRoute.NoteEditor(null)
                                LibraryAction.CreateSnippet -> RootRoute.SnippetEditor(null)
                                LibraryAction.Files, is LibraryAction.RecentFile -> RootRoute.Files
                                LibraryAction.Notes -> RootRoute.Notes
                                is LibraryAction.OpenNote -> RootRoute.NoteEditor(action.value.noteId)
                                LibraryAction.Snippets -> RootRoute.Snippets
                                is LibraryAction.OpenSnippet -> RootRoute.SnippetEditor(action.value.id)
                                LibraryAction.Downloads -> RootRoute.Downloads
                            }
                        },
                    )
                    LibraryCreateDialog(
                        onDismiss = { route = RootRoute.Root(IslandDestination.LIBRARY) },
                        onNote = { route = RootRoute.NoteEditor(null) },
                        onSnippet = { route = RootRoute.SnippetEditor(null) },
                        onFiles = { route = RootRoute.Files },
                    )
                }
            }
            RootRoute.Appearance -> AppearanceDestination(account, onBack = { route = RootRoute.Root(IslandDestination.TOOLS) })
            RootRoute.Language -> LanguageDestination(account, onBack = { route = RootRoute.Root(IslandDestination.TOOLS) })
            RootRoute.AppLock -> AppLockDestination(account, appContainer, onBack = { route = RootRoute.Root(IslandDestination.TOOLS) })
            RootRoute.Network -> NetworkDestination(account, onBack = { route = RootRoute.Root(IslandDestination.TOOLS) })
            RootRoute.Diagnostics -> DiagnosticsLiveDestination(
                account = account,
                onBack = { route = RootRoute.Root(IslandDestination.TOOLS) },
                onCheckUpdate = {
                    appContainer.aboutActions.open(AboutDestination.CHECK_UPDATE)
                        .onFailure { notice("无法打开更新页面") }
                },
                onOpenGitHub = {
                    appContainer.aboutActions.open(AboutDestination.GITHUB)
                        .onFailure { notice("无法打开 GitHub") }
                },
                onOpenLicenses = {
                    appContainer.aboutActions.open(AboutDestination.OPEN_SOURCE_LICENSES)
                        .onFailure { notice("无法打开开源许可证") }
                },
                onExport = { notice(diagnosticExport(account)) },
            )
            RootRoute.FileSync -> FileSyncDestination(
                account = account,
                onBack = { route = RootRoute.Root(IslandDestination.TOOLS) },
                onOpenTokens = { route = RootRoute.ClientToken },
                onOpenConflicts = { route = RootRoute.Conflicts },
                onOpenDevices = { route = RootRoute.Devices },
                onOpenShares = { route = RootRoute.LocalShares },
                onOpenDiagnostics = { route = RootRoute.Diagnostics },
                onUnbind = if (account.isLocalMode) null else ({ route = RootRoute.ServerBinding }),
                onSyncNow = { if (!account.isLocalMode) scope.launch { account.syncEngine.syncNow() } },
            )
            RootRoute.ClientToken -> ClientTokenLiveDestination(
                account = account,
                ownerUserId = ownerUserId,
                onBack = { route = RootRoute.FileSync },
                onMessage = { messages.emit(it) },
            )
            RootRoute.Conflicts -> ConflictCenterDestination(
                account = account,
                onBack = { route = RootRoute.FileSync },
                onMessage = notice,
            )
            RootRoute.Devices -> DeviceListDestination(
                account = account,
                onBack = { route = RootRoute.FileSync },
                onMessage = notice,
            )
            RootRoute.LocalShares -> LocalSharesDestination(
                account = account,
                onBack = { route = RootRoute.FileSync },
                onMessage = notice,
            )
            RootRoute.ServerBinding -> BindingScreen(
                container = appContainer,
                onBack = { route = RootRoute.Root(if (account.isLocalMode) IslandDestination.HOME else IslandDestination.TOOLS) },
                onBound = { route = RootRoute.Root(IslandDestination.HOME) },
                onMessage = notice,
            )
            RootRoute.ServerHub -> ServerHubScreen(
                onOpenSettings = { route = RootRoute.ServerSettings },
                onOpenBackup = { route = RootRoute.Backup },
                onBack = { route = RootRoute.Root(IslandDestination.TOOLS) },
            )
            RootRoute.ServerSettings -> ServerSettingsLiveDestination(
                account = account,
                ownerUserId = ownerUserId,
                onBack = { route = RootRoute.ServerHub },
                onMessage = notice,
            )
            RootRoute.Backup -> BackupDestination(
                account = account,
                onUnavailable = { notice("当前 Mobile v1 没有可用的备份或 WebDAV 接口") },
                onBack = { route = RootRoute.ServerHub },
            )
            RootRoute.RuntimeStatus -> RuntimeDestination(account, onBack = { route = RootRoute.Root(IslandDestination.TOOLS) })
            RootRoute.AiSettings -> AiSettingsLiveDestination(
                account = account,
                ownerUserId = ownerUserId,
                onBack = { route = RootRoute.Root(IslandDestination.TOOLS) },
            )
            is RootRoute.Ops -> OpsDestination(
                account = account,
                ownerUserId = ownerUserId,
                section = current.section,
                onBack = { route = RootRoute.Root(IslandDestination.TOOLS) },
            )
            is RootRoute.ResourceList -> ResourceListDestination(
                account = account,
                ownerUserId = ownerUserId,
                kind = current.kind,
                onBack = { route = RootRoute.Root(IslandDestination.TOOLS) },
                onCreate = { route = RootRoute.ResourceEditor(current.kind, null) },
                onOpen = { id -> route = RootRoute.ResourceEditor(current.kind, id) },
            )
            is RootRoute.ResourceEditor -> ResourceEditorDestination(
                account = account,
                ownerUserId = ownerUserId,
                kind = current.kind,
                entityId = current.entityId,
                onBack = { route = RootRoute.ResourceList(current.kind) },
                onMessage = { messages.emit(it) },
            )

            is RootRoute.Terminal -> {
                val termSessions by account.sessions.rows.collectAsState(initial = emptyList())
                val termConnections by account.connections.observeAll(ownerUserId).collectAsState(initial = emptyList())
                val termNotes by account.notes.observeNotes(ownerUserId).collectAsState(initial = emptyList())
                val termSnippets by account.notes.observeSnippets(ownerUserId).collectAsState(initial = emptyList())
                var termWorkspace by remember(current.sessionId) {
                    mutableStateOf(TerminalWorkspaceState(paneA = current.sessionId))
                }
                TerminalRoute(
                    viewModel = viewModel(
                        key = "terminal:" + current.sessionId,
                        factory = TerminalViewModel.Factory(
                            sessionId = current.sessionId,
                            connectionId = current.connectionId,
                            registry = account.sessions,
                            connections = account.connections,
                            host = SshTerminalHost(
                                engine = sshEngine,
                                findConnection = { id -> account.connections.find(id) },
                            ),
                            emulator = productionTerminalEmulator(),
                            secretProvider = { connection -> account.terminalCredentials(connection) },
                        ),
                    ),
                    onDock = { item -> onTerminalDock(item, notice) { route = it } },
                    onMessage = { messages.emit(it) },
                    autoConnect = true,
                    workspace = termWorkspace,
                    onWorkspace = { termWorkspace = it },
                    sessions = termSessions,
                    connections = termConnections,
                    notes = termNotes,
                    snippets = termSnippets,
                    onSelectSession = { id ->
                        val target = termSessions.firstOrNull { it.sessionId == id }
                        if (target != null) route = RootRoute.Terminal(target.sessionId, target.connectionId)
                    },
                    onCloseSession = { id ->
                        account.sessions.close(id, System.currentTimeMillis())
                        if (id == current.sessionId) {
                            val remaining = termSessions.filter { it.protocol.isTerminal && it.transport.isLive && it.sessionId != id }
                            if (remaining.isEmpty()) {
                                route = RootRoute.Root(IslandDestination.SESSIONS)
                                notice("所有会话已关闭")
                            } else {
                                route = RootRoute.Terminal(remaining.first().sessionId, remaining.first().connectionId)
                            }
                        }
                    },
                    onAddSession = { connection ->
                        route = routeForProtocol(UUID.randomUUID().toString(), connection.id, connection.protocol)
                    },
                    onOpenNote = { id -> route = RootRoute.NoteEditor(id) },
                    onOpenDocker = { route = RootRoute.Ops(OpsSection.DOCKER) },
                )
            }

            is RootRoute.Remote -> RemoteDestination(
                route = current,
                account = account,
                onBack = { route = RootRoute.Root(IslandDestination.SESSIONS) },
                onMessage = { messages.emit(it) },
                onNotice = notice,
                vncEngine = vncEngine,
                rdpEngine = rdpEngine,
            )

            is RootRoute.SessionDetails -> SessionDetailsScreen(
                row = account.sessions.find(current.sessionId),
                onBack = { route = RootRoute.Root(IslandDestination.SESSIONS) },
            )

                RootRoute.BatchExecution -> BatchExecutionDestination(
                    account = account,
                    ownerUserId = ownerUserId,
                    onBack = { route = RootRoute.Root(IslandDestination.TOOLS) },
                    onMessage = { messages.emit(it) },
                )
            }
            }
        }

        AnimatedVisibility(
            visible = current is RootRoute.Root,
            modifier = Modifier.align(Alignment.BottomCenter),
            enter = slideInVertically(
                initialOffsetY = { islandHiddenOffsetPx },
                animationSpec = tween(
                    durationMillis = motion.scale(ZephyrMotionTokens.MED_MS),
                    easing = ZephyrMotionTokens.easeOut,
                ),
            ) + fadeIn(tween(motion.scale(ZephyrMotionTokens.MED_MS))),
            exit = slideOutVertically(
                targetOffsetY = { islandHiddenOffsetPx },
                animationSpec = tween(
                    durationMillis = motion.scale(ZephyrMotionTokens.MED_MS),
                    easing = ZephyrMotionTokens.easeOut,
                ),
            ) + fadeOut(tween(motion.scale(ZephyrMotionTokens.MED_MS))),
        ) {
            FloatingIsland(
                selected = lastRoot,
                onSelect = { destination -> route = RootRoute.Root(destination) },
            )
        }

        val sessions by account.sessions.rows.collectAsState()
        val overlaySession = when (val currentRoute = current) {
            is RootRoute.Terminal -> sessions.firstOrNull { it.sessionId == currentRoute.sessionId }
            is RootRoute.Remote -> sessions.firstOrNull { it.sessionId == currentRoute.sessionId }
            else -> sessions.firstOrNull { it.transport == SessionTransport.CONNECTED }
                ?: sessions.firstOrNull { it.transport.isLive }
        }
        BoundAiWorkspace(
            account = account,
            destination = lastRoot,
            session = overlaySession,
            onOpenSettings = { route = RootRoute.AiSettings },
            onNotice = notice,
        )

        one.zephyr.mobile.ui.component.ZephyrToast(
            message = toastMessage,
            modifier = Modifier.align(Alignment.BottomCenter),
            onDismiss = { toastMessage = null },
        )
    }
}

private fun routeContentKey(route: RootRoute): Any = when (route) {
    is RootRoute.Root -> route.destination
    is RootRoute.ConnectionEditor -> "editor:${route.connectionId}:${route.protocol.name}"
    is RootRoute.NoteEditor -> "note:${route.noteId}"
    is RootRoute.SnippetEditor -> "snippet:${route.snippetId}"
    is RootRoute.ResourceList -> "resources:${route.kind.name}"
    is RootRoute.ResourceEditor -> "resource-editor:${route.kind.name}:${route.entityId}"
    is RootRoute.Terminal -> "terminal:${route.sessionId}"
    is RootRoute.Remote -> "remote:${route.sessionId}:${route.protocol.name}"
    is RootRoute.SessionDetails -> "session:${route.sessionId}"
    else -> route
}

private fun routeDepth(route: RootRoute): Int = when (route) {
    is RootRoute.Root -> 0
    RootRoute.Notes,
    RootRoute.Snippets,
    RootRoute.Files,
    RootRoute.Downloads,
    RootRoute.FileSync,
    RootRoute.ServerHub,
    is RootRoute.ResourceList -> 1
    is RootRoute.NoteEditor,
    is RootRoute.SnippetEditor,
    RootRoute.ClientToken,
    RootRoute.Conflicts,
    RootRoute.Devices,
    RootRoute.LocalShares,
    RootRoute.ServerSettings,
    RootRoute.Backup,
    is RootRoute.ResourceEditor -> 2
    else -> 1
}

private fun routeTransition(
    initial: RootRoute,
    target: RootRoute,
    durationMillis: Int,
    reduceMotion: Boolean,
): ContentTransform {
    if (
        reduceMotion ||
        (initial is RootRoute.Root && target is RootRoute.Root) ||
        (initial is RootRoute.Root && target is RootRoute.LibraryCreate) ||
        (initial is RootRoute.LibraryCreate && target is RootRoute.Root)
    ) {
        return ContentTransform(
            targetContentEnter = EnterTransition.None,
            initialContentExit = ExitTransition.None,
            sizeTransform = null,
        )
    }
    val pushing = routeDepth(target) >= routeDepth(initial)
    val enter = if (pushing) {
        slideInHorizontally(
            initialOffsetX = { it },
            animationSpec = tween(durationMillis, easing = ZephyrMotionTokens.easeDrawer),
        )
    } else {
        slideInHorizontally(
            initialOffsetX = { (-it * 0.28f).roundToInt() },
            animationSpec = tween(durationMillis, easing = ZephyrMotionTokens.easeDrawer),
        ) + fadeIn(
            initialAlpha = ZephyrMotionTokens.PAGE_BEHIND_ALPHA,
            animationSpec = tween(durationMillis, easing = ZephyrMotionTokens.easeDrawer),
        ) + scaleIn(
            initialScale = ZephyrMotionTokens.PAGE_BEHIND_SCALE,
            animationSpec = tween(durationMillis, easing = ZephyrMotionTokens.easeDrawer),
        )
    }
    val exit = if (pushing) {
        slideOutHorizontally(
            targetOffsetX = { (-it * 0.28f).roundToInt() },
            animationSpec = tween(durationMillis, easing = ZephyrMotionTokens.easeDrawer),
        ) + fadeOut(
            targetAlpha = ZephyrMotionTokens.PAGE_BEHIND_ALPHA,
            animationSpec = tween(durationMillis, easing = ZephyrMotionTokens.easeDrawer),
        ) + scaleOut(
            targetScale = ZephyrMotionTokens.PAGE_BEHIND_SCALE,
            animationSpec = tween(durationMillis, easing = ZephyrMotionTokens.easeDrawer),
        )
    } else {
        slideOutHorizontally(
            targetOffsetX = { it },
            animationSpec = tween(durationMillis, easing = ZephyrMotionTokens.easeDrawer),
        )
    }
    // Every route fills the window. AnimatedContent's default SizeTransform would still remeasure
    // and clip both full-screen trees on every frame, unlike demo.html's fixed absolute pages.
    return ContentTransform(
        targetContentEnter = enter,
        initialContentExit = exit,
        targetContentZIndex = if (pushing) 1f else 0f,
        sizeTransform = null,
    )
}

@Composable
private fun RootDestination(
    destination: IslandDestination,
    account: AccountContainer,
    ownerUserId: String,
    syncStatus: Flow<SyncStatus>,
    onOpenEditor: (String?) -> Unit,
    onDuplicateConnection: (String) -> Unit,
    onOpenSession: (String, String, Protocol) -> Unit,
    onMessage: suspend (String) -> Unit,
    onNotice: (String) -> Unit,
    integrations: ZephyrOneIntegrations,
    onOpenSessionDetails: (String) -> Unit,
    onOpenBatch: () -> Unit,
    onLibraryAction: (LibraryAction) -> Unit,
    onOpenTool: (ToolEntry) -> Unit,
    onOpenBinding: () -> Unit,
    vncEngine: one.zephyr.mobile.protocol.vnc.VncEngine,
    rdpEngine: one.zephyr.mobile.protocol.rdp.RdpEngine,
) {
    val nowMs = System.currentTimeMillis()

    when (destination) {
        IslandDestination.HOME -> {
            val activityRepository = remember(account) { ActivityRepository(account.database) }
            val activity by activityRepository.observeRecent(ownerUserId)
                .collectAsState(initial = emptyList())
            /* Local mode has no server, so the honest sync status is "unbound" and the sync
             * action is a no-op; the banner above the list explains the mode. */
            val listSyncStatus: Flow<SyncStatus> =
                if (account.isLocalMode) remember { flowOf(SyncStatus.unbound()) } else syncStatus
            val status by listSyncStatus.collectAsState(initial = SyncStatus.unbound())

            ConnectionListRoute(
                viewModel = viewModel(
                    key = "connections",
                    factory = ConnectionListViewModel.factory(
                        connections = account.connections,
                        settings = account.settings,
                        shared = account.sharedResources,
                        ownerUserId = ownerUserId,
                        syncStatus = listSyncStatus,
                        network = account.network,
                        localMode = account.isLocalMode,
                        syncNowAction = if (account.isLocalMode) {
                            { /* Local mode has no server to sync with. */ }
                        } else {
                            { account.syncEngine.syncNow() }
                        },
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
                onDuplicateConnection = { connection -> onDuplicateConnection(connection.id) },
                onTestConnection = integrations.onTestConnection,
                onShareConnection = integrations.onShareConnection,
                onCreate = { onOpenEditor(null) },
                onOpenAccount = null,
                localMode = account.isLocalMode,
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
                    closeTransport = { row ->
                        when (row.protocol) {
                            Protocol.VNC -> vncEngine.disconnect(row.sessionId)
                            Protocol.RDP -> rdpEngine.disconnect(row.sessionId)
                            Protocol.SSH, Protocol.TELNET -> Unit
                        }
                    },
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
            onDetails = onOpenSessionDetails,
            onMessage = onMessage,
        )

        IslandDestination.LIBRARY -> LibraryDestination(
            account = account,
            ownerUserId = ownerUserId,
            nowMs = nowMs,
            onAction = onLibraryAction,
        )

        IslandDestination.TOOLS -> ToolsDestination(
            account = account,
            ownerUserId = ownerUserId,
            onOpenBatch = onOpenBatch,
            onOpenTool = onOpenTool,
        )
    }
}

@Composable
private fun LibraryDestination(
    account: AccountContainer,
    ownerUserId: String,
    nowMs: Long,
    onAction: (LibraryAction) -> Unit,
) {
    val notes by account.notes.observeNotes(ownerUserId).collectAsState(initial = emptyList())
    val snippets by account.notes.observeSnippets(ownerUserId).collectAsState(initial = emptyList())
    val recentFilesFlow = remember(account) {
        account.settings.observePreferences().map { preferences ->
            RecentResourceFiles.decode(preferences[RecentResourceFiles.PREFERENCE_KEY])
        }
    }
    val recentFiles by recentFilesFlow.collectAsState(initial = emptyList())
    val activeNotes = notes.filterNot(Note::isTrashed)
    val summary = ResourceHomeSummary(
        noteCount = activeNotes.size,
        snippetCount = snippets.count { it.deletedAt == null },
        trashedNoteCount = notes.count(Note::isTrashed),
        activeDownloadCount = 0,
        recentFiles = recentFiles,
        pendingCount = notes.count { it.syncState == SyncState.PENDING_LOCAL } +
            snippets.count { it.syncState == SyncState.PENDING_LOCAL },
        conflictCount = notes.count { it.syncState == SyncState.CONFLICTED } +
            snippets.count { it.syncState == SyncState.CONFLICTED },
    )
    LibraryRootRoute(
        content = LibraryRootContent(summary, activeNotes, snippets.filter { it.deletedAt == null }),
        nowMs = nowMs,
        onCreateResource = { onAction(LibraryAction.Create) },
        onOpenFiles = { onAction(LibraryAction.Files) },
        onOpenNotes = { onAction(LibraryAction.Notes) },
        onOpenSnippets = { onAction(LibraryAction.Snippets) },
        onOpenDownloads = { onAction(LibraryAction.Downloads) },
        onOpenRecentFile = { onAction(LibraryAction.RecentFile(it)) },
        onOpenNote = { onAction(LibraryAction.OpenNote(it)) },
        onOpenSnippet = { onAction(LibraryAction.OpenSnippet(it)) },
    )
}

@Composable
private fun ToolsDestination(
    account: AccountContainer,
    ownerUserId: String,
    onOpenBatch: () -> Unit,
    onOpenTool: (ToolEntry) -> Unit,
) {
    val connections by account.connections.observeAll(ownerUserId).collectAsState(initial = emptyList())
    val prefs by account.settings.observePreferences().collectAsState(initial = emptyMap())
    val language = one.zephyr.mobile.ui.locale.AppLanguage.fromStored(
        prefs[one.zephyr.mobile.data.repository.SettingsRepository.PREF_LANGUAGE]?.let {
            one.zephyr.mobile.data.EntityCodec.string(it, "value")
        },
    )
    val languageLabel = when (language) {
        one.zephyr.mobile.ui.locale.AppLanguage.SYSTEM ->
            androidx.compose.ui.res.stringResource(one.zephyr.mobile.feature.tools.R.string.tools_language_system)
        one.zephyr.mobile.ui.locale.AppLanguage.ZH_HANS ->
            androidx.compose.ui.res.stringResource(one.zephyr.mobile.feature.tools.R.string.tools_language_zh)
        one.zephyr.mobile.ui.locale.AppLanguage.ZH_HANT -> language.nativeLabel
        one.zephyr.mobile.ui.locale.AppLanguage.EN ->
            androidx.compose.ui.res.stringResource(one.zephyr.mobile.feature.tools.R.string.tools_language_en)
    }
    val inventory = ToolsInventory(
        executableSshCount = connections.count { it.protocol == Protocol.SSH && it.capabilities.canExecute },
        observableSshCount = connections.count { it.protocol == Protocol.SSH && it.capabilities.canObserve },
    )
    ToolsRootRoute(
        inventory = inventory,
        summaries = ToolsRootSummaries(
            language = languageLabel,
            ai = AiWorkspaceBinding.settingsSummary(prefs),
        ),
        onAddTool = { onOpenTool(ToolEntry.PROXY) },
        onOpenBatchExecution = onOpenBatch,
        onOpenDocker = { onOpenTool(ToolEntry.DOCKER) },
        onOpenMonitor = { onOpenTool(ToolEntry.MONITOR) },
        onOpenLogs = { onOpenTool(ToolEntry.LOGS) },
        onOpenProxies = { onOpenTool(ToolEntry.PROXY) },
        onOpenSshKeys = { onOpenTool(ToolEntry.SSH_KEY) },
        onOpenJumpHosts = { onOpenTool(ToolEntry.JUMP_HOST) },
        onOpenAiWorkspace = { onOpenTool(ToolEntry.AI_WORKSPACE) },
        onOpenFileSync = { onOpenTool(ToolEntry.FILE_SYNC) },
        onOpenClientToken = { onOpenTool(ToolEntry.CLIENT_TOKEN) },
        onOpenServerSettings = { onOpenTool(ToolEntry.SERVER_SETTINGS) },
        onOpenBackupRestore = { onOpenTool(ToolEntry.BACKUP_RESTORE) },
        onOpenRuntimeStatus = { onOpenTool(ToolEntry.RUNTIME_STATUS) },
        onOpenAppearance = { onOpenTool(ToolEntry.APPEARANCE) },
        onOpenLanguage = { onOpenTool(ToolEntry.LANGUAGE) },
        onOpenAppLock = { onOpenTool(ToolEntry.APP_LOCK) },
        onOpenNetwork = { onOpenTool(ToolEntry.NETWORK) },
        onOpenDiagnostics = { onOpenTool(ToolEntry.DIAGNOSTICS) },
        onUnavailableTool = { entry, _ -> onOpenTool(entry) },
    )
}

@Composable
private fun BatchExecutionDestination(
    account: AccountContainer,
    ownerUserId: String,
    onBack: () -> Unit,
    onMessage: suspend (String) -> Unit,
) {
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
    Column(Modifier.fillMaxSize()) {
        PushedPageHeader(title = "远程批量", onBack = onBack)
        BatchExecutionScreen(
            state = state,
            onIntent = { toolsViewModel.dispatch(it) },
            onRetry = toolsViewModel::clearSelection,
            modifier = Modifier.weight(1f),
        )
    }
}

@Composable
private fun SessionDetailsScreen(row: SessionRow?, onBack: () -> Unit) {
    BackHandler(onBack = onBack)
    Column(Modifier.fillMaxSize()) {
        PushedPageHeader(title = "会话详情", onBack = onBack)
        Column(Modifier.padding(horizontal = ZephyrSpacing.lg)) {
        if (row == null) {
            Text("会话已关闭或不存在", color = one.zephyr.mobile.ui.theme.ZephyrTheme.palette.onFloatingMuted)
        } else {
            DetailLine("连接", row.name)
            DetailLine("协议", row.protocol.wireName)
            DetailLine("地址", row.displayAddress, mono = true)
            DetailLine("会话 ID", row.sessionId, mono = true)
            DetailLine("执行位置", if (row.execution == SessionExecution.LOCAL) "本机" else "主端")
            row.latencyMs?.let { DetailLine("延迟", it.toString() + " ms", mono = true) }
            row.detail?.let { DetailLine("状态", it) }
            row.revokedReason?.let { DetailLine("权限", it) }
        }
        }
    }
}

@Composable
private fun DetailLine(label: String, value: String, mono: Boolean = false) {
    Text(label, color = one.zephyr.mobile.ui.theme.ZephyrTheme.palette.onFloatingSubtle, fontSize = 12.sp)
    Text(
        value,
        fontFamily = if (mono) FontFamily.Monospace else FontFamily.Default,
        modifier = Modifier.padding(top = 3.dp, bottom = 14.dp),
    )
}

@Composable
private fun RemoteDestination(
    route: RootRoute.Remote,
    account: AccountContainer,
    onBack: () -> Unit,
    onMessage: suspend (String) -> Unit,
    onNotice: (String) -> Unit,
    vncEngine: one.zephyr.mobile.protocol.vnc.VncEngine,
    rdpEngine: one.zephyr.mobile.protocol.rdp.RdpEngine,
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
                    engine = vncEngine,
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
                engine = rdpEngine,
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
private fun LockGate(onUnlockRequested: suspend () -> AuthResult) {
    val scope = rememberCoroutineScope()
    val lifecycleOwner = LocalLifecycleOwner.current
    var authenticating by remember { mutableStateOf(false) }
    var autoPrompted by remember { mutableStateOf(false) }
    var failureMessage by remember { mutableStateOf<String?>(null) }
    val unavailable = stringResource(R.string.unlock_unavailable)
    LaunchedEffect(lifecycleOwner) {
        lifecycleOwner.lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            if (autoPrompted || authenticating) return@repeatOnLifecycle
            autoPrompted = true
            authenticating = true
            failureMessage = UnlockPresentation.failureMessage(onUnlockRequested(), unavailable)
            authenticating = false
        }
    }
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(ZephyrSpacing.lg),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = stringResource(R.string.unlock_title),
            style = ZephyrTextStyles.rootTitle,
        )
        Text(
            text = stringResource(R.string.unlock_subtitle),
            style = ZephyrTextStyles.body,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = ZephyrSpacing.sm),
        )
        if (failureMessage != null) {
            Text(
                text = failureMessage!!,
                style = ZephyrTextStyles.body,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(top = ZephyrSpacing.sm),
            )
        }
        Button(
            onClick = {
                scope.launch {
                    authenticating = true
                    failureMessage = UnlockPresentation.failureMessage(onUnlockRequested(), unavailable)
                    authenticating = false
                }
            },
            modifier = Modifier.padding(top = ZephyrSpacing.lg),
        ) {
            Text(
                text = stringResource(
                    if (authenticating) R.string.unlock_in_progress else R.string.unlock_retry,
                ),
            )
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
private fun LocalModeBanner(
    onBindServer: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Surface(
        color = ZephyrTheme.palette.surfaces.content,
        modifier = modifier.fillMaxWidth(),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.padding(
                horizontal = ZephyrSpacing.lg,
                vertical = ZephyrSpacing.sm,
            ),
        ) {
            Text(
                text = "本地模式 · 未连接服务器",
                style = ZephyrTextStyles.body,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = onBindServer) {
                Text(text = "连接服务器")
            }
        }
    }
}

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
            style = ZephyrTextStyles.body,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

private fun popRoute(route: RootRoute): RootRoute = when (route) {
    is RootRoute.Root -> route
    is RootRoute.ConnectionEditor, RootRoute.ProtocolPicker -> RootRoute.Root(IslandDestination.HOME)
    is RootRoute.Terminal, is RootRoute.Remote, is RootRoute.SessionDetails ->
        RootRoute.Root(IslandDestination.SESSIONS)
    is RootRoute.NoteEditor -> RootRoute.Notes
    is RootRoute.SnippetEditor -> RootRoute.Snippets
    RootRoute.Notes, RootRoute.Snippets, RootRoute.Files, RootRoute.Downloads, RootRoute.LibraryCreate ->
        RootRoute.Root(IslandDestination.LIBRARY)
    is RootRoute.ResourceEditor -> RootRoute.ResourceList(route.kind)
    RootRoute.ClientToken, RootRoute.Conflicts, RootRoute.Devices, RootRoute.LocalShares -> RootRoute.FileSync
    RootRoute.ServerSettings, RootRoute.Backup -> RootRoute.ServerHub
    RootRoute.ServerBinding -> RootRoute.Root(IslandDestination.HOME)
    else -> RootRoute.Root(IslandDestination.TOOLS)
}

private fun routeForProtocol(sessionId: String, connectionId: String, protocol: Protocol): RootRoute =
    if (protocol.isTerminal) {
        RootRoute.Terminal(sessionId, connectionId)
    } else {
        RootRoute.Remote(sessionId, connectionId, protocol)
    }

/**
 * Where a dock tap goes if the terminal itself did not consume it.
 *
 * Demo dock items either stay on the terminal (clipboard / IME / disconnect) or open an in-session
 * tool. This mapper is the fallback for ExtraKeys and hosts that have no workspace yet. Exhaustive
 * on [TerminalDockItem] so a new dock entry cannot compile until someone decides.
 */
internal enum class TerminalDockLeave {
    STAY,
    FILES,
    SNIPPETS,
    NOTES,
    STATS,
    APPEARANCE,
}

internal fun terminalDockLeave(item: TerminalDockItem): TerminalDockLeave = when (item) {
    TerminalDockItem.FILES -> TerminalDockLeave.FILES
    TerminalDockItem.SNIPPETS -> TerminalDockLeave.SNIPPETS
    TerminalDockItem.NOTES -> TerminalDockLeave.NOTES
    TerminalDockItem.STATS -> TerminalDockLeave.STATS
    TerminalDockItem.THEME -> TerminalDockLeave.APPEARANCE
    TerminalDockItem.COPY,
    TerminalDockItem.PASTE,
    TerminalDockItem.KEYBOARD,
    TerminalDockItem.DISCONNECT -> TerminalDockLeave.STAY
}

/**
 * Terminal dock routing.
 *
 * In-session tools are opened by [TerminalWorkspace] first. This is only the host fallback.
 */
private fun onTerminalDock(
    item: TerminalDockItem,
    onNotice: (String) -> Unit,
    navigate: (RootRoute) -> Unit,
) {
    when (terminalDockLeave(item)) {
        TerminalDockLeave.STAY -> Unit
        TerminalDockLeave.FILES -> navigate(RootRoute.Files)
        TerminalDockLeave.SNIPPETS -> navigate(RootRoute.Snippets)
        TerminalDockLeave.NOTES -> navigate(RootRoute.Notes)
        TerminalDockLeave.STATS -> navigate(RootRoute.Ops(OpsSection.DOCKER))
        TerminalDockLeave.APPEARANCE -> navigate(RootRoute.Appearance)
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

private suspend fun AccountContainer.terminalCredentials(connection: Connection): TerminalCredentials {
    val inlineKey = secretRefForPresence(
        presence = connection.privateKey,
        entityType = Connection.ENTITY_TYPE,
        entityId = connection.id,
        fieldName = FIELD_PRIVATE_KEY,
    )?.let { secretStore.getText(it)?.toCharArray() }
    val saved = connection.sshKeyId?.let { keyId ->
        val key = resources.findSshKey(keyId) ?: return@let null
        Triple(
            secretRefForPresence(key.privateKey, one.zephyr.mobile.model.SshKey.ENTITY_TYPE, key.id, "privateKey")
                ?.let { secretStore.getText(it)?.toCharArray() },
            secretRefForPresence(key.passphrase, one.zephyr.mobile.model.SshKey.ENTITY_TYPE, key.id, "passphrase")
                ?.let { secretStore.getText(it)?.toCharArray() },
            key,
        )
    }
    return TerminalCredentials(
        password = passwordChars(connection),
        privateKey = inlineKey ?: saved?.first,
        passphrase = saved?.second,
    )
}

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
private const val TAG_PROTOCOL = "protocol"
private const val TAG_SESSION_DETAILS = "session-details"
private const val TAG_BATCH = "batch"
private const val TAG_TERMINAL = "terminal"
private const val TAG_REMOTE = "remote"
private const val TAG_NOTES = "notes"
private const val TAG_NOTE_EDITOR = "note-editor"
private const val TAG_SNIPPETS = "snippets"
private const val TAG_SNIPPET_EDITOR = "snippet-editor"
private const val TAG_FILES = "files"
private const val TAG_DOWNLOADS = "downloads"
private const val TAG_LIBRARY_CREATE = "library-create"
private const val TAG_APPEARANCE = "appearance"
private const val TAG_LANGUAGE = "language"
private const val TAG_APP_LOCK = "app-lock"
private const val TAG_NETWORK = "network"
private const val TAG_DIAGNOSTICS = "diagnostics"
private const val TAG_FILE_SYNC = "file-sync"
private const val TAG_CLIENT_TOKEN = "client-token"
private const val TAG_CONFLICTS = "conflicts"
private const val TAG_DEVICES = "devices"
private const val TAG_SHARES = "shares"
private const val TAG_BINDING = "binding"
private const val TAG_SERVER = "server"
private const val TAG_SERVER_SETTINGS = "server-settings"
private const val TAG_BACKUP = "backup"
private const val TAG_RUNTIME = "runtime"
private const val TAG_AI = "ai"
private const val TAG_OPS = "ops"
private const val TAG_RESOURCE_LIST = "resource-list"
private const val TAG_RESOURCE_EDITOR = "resource-editor"
private const val UnavailableSftpMessage = "此版本尚未内置 SFTP 引擎，无法访问远程文件"

private const val FIELD_PASSWORD = "password"
private const val FIELD_PRIVATE_KEY = "privateKey"

/* The SAF picker is wired (see RemoteDestination), so the placeholder is gone. These two report
 * its outcomes; cancelling deliberately has no message. */
private const val DRIVE_AUTHORIZED = "已授权目录，远端共享名："
private const val DRIVE_REFUSED = "系统未能保留该目录授权，请重新选择目录。"
