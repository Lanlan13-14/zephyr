package one.zephyr.mobile.feature.sessions

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.launch
import one.zephyr.mobile.data.session.SessionRow
import one.zephyr.mobile.model.Connection
import one.zephyr.mobile.model.Note
import one.zephyr.mobile.model.PageState
import one.zephyr.mobile.model.Snippet

/**
 * Route bindings for S20 and S21.
 *
 * Separate from the screens for the same reason as the connection routes: the screens take values and
 * lambdas so a Compose test can drive every state without a registry, a transport or an emulator, and
 * these functions are the only place that knows a ViewModel exists.
 */
@Composable
fun SessionListRoute(
    viewModel: SessionListViewModel,
    nowMs: Long,
    onOpenTerminal: (String, String) -> Unit,
    onOpenRemote: (String, String) -> Unit,
    onDetails: (String) -> Unit,
    onMessage: suspend (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val selection by viewModel.selection.collectAsStateWithLifecycle()

    CollectSessionMessages(viewModel.message, onMessage)

    LaunchedEffect(viewModel) {
        viewModel.event.collect { event ->
            when (event) {
                is SessionListEvent.OpenTerminal -> onOpenTerminal(event.sessionId, event.connectionId)
                is SessionListEvent.OpenRemote -> onOpenRemote(event.sessionId, event.connectionId)
                // Reconnect is navigation plus an intent: the list opens the terminal, and the
                // terminal dials. SCREEN_CATALOG.md 7 forbids the list from opening a transport, and
                // routing it this way is what makes that structural rather than a convention.
                is SessionListEvent.Reconnect -> onOpenTerminal(event.sessionId, event.connectionId)
                is SessionListEvent.Details -> onDetails(event.sessionId)
            }
        }
    }

    SessionListScreen(
        state = state,
        selection = selection,
        nowMs = nowMs,
        onAction = viewModel::onAction,
        onToggleSelection = viewModel::toggleSelection,
        onClearSelection = viewModel::clearSelection,
        onCloseSelected = { viewModel.closeAll(selection) },
        onCloseAll = { viewModel.closeAll(null) },
        onClearHistory = viewModel::clearHistory,
        modifier = modifier,
    )
}

/**
 * S21.
 *
 * @param autoConnect true only when the user asked for a new session. A tab reached by restoring the
 *   workspace arrives false, which is how "工作区恢复不自动连接" survives navigation: the decision is
 *   made by the caller that knows why the screen was opened, not by the screen.
 * @param twoFingerScrollGoesRemote the user setting from TERMINAL_EXPERIENCE.md 5.1, passed through
 *   rather than read here so the arbitration stays in one place.
 */
@Composable
fun TerminalRoute(
    viewModel: TerminalViewModel,
    onDock: (TerminalDockItem) -> Unit,
    onMessage: suspend (String) -> Unit,
    autoConnect: Boolean = false,
    twoFingerScrollGoesRemote: Boolean = false,
    modifier: Modifier = Modifier,
    workspace: TerminalWorkspaceState? = null,
    onWorkspace: (TerminalWorkspaceState) -> Unit = {},
    sessions: List<SessionRow> = emptyList(),
    connections: List<Connection> = emptyList(),
    notes: List<Note> = emptyList(),
    snippets: List<Snippet> = emptyList(),
    paneViewModels: Map<String, TerminalViewModel> = emptyMap(),
    onSelectSession: (String) -> Unit = {},
    onCloseSession: (String) -> Unit = {},
    onAddSession: (Connection) -> Unit = {},
    onOpenNote: (String) -> Unit = {},
    onOpenDocker: () -> Unit = {},
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val remoteTitle by viewModel.title.collectAsStateWithLifecycle()
    val clipboard = LocalClipboardManager.current
    val coroutineScope = androidx.compose.runtime.rememberCoroutineScope()

    var keyboardVisible by remember { mutableStateOf(true) }

    val readFrame = remember(viewModel) {
        { topRow: Int, rows: Int -> viewModel.renderFrame(topRow, rows) }
    }

    CollectSessionMessages(viewModel.message, onMessage)

    LaunchedEffect(viewModel, autoConnect) {
        if (autoConnect) viewModel.connect()
    }

    LaunchedEffect(viewModel) {
        viewModel.controller.actions.collect { action ->
            when (action) {
                TerminalAction.TOGGLE_KEYBOARD -> keyboardVisible = !keyboardVisible
                // The clipboard is read here, in direct response to the user's tap, and handed
                // straight to the guard: nothing reads it speculatively.
                TerminalAction.PASTE ->
                    clipboard.getText()?.text?.let { text -> viewModel.controller.onPaste(text) }
                TerminalAction.COPY -> Unit
                // The controller already returned the viewport to the live output.
                TerminalAction.SCROLL_MODE -> Unit
                TerminalAction.SNIPPETS -> onDock(TerminalDockItem.SNIPPETS)
                TerminalAction.SESSIONS -> Unit
                TerminalAction.FILES -> onDock(TerminalDockItem.FILES)
                TerminalAction.NOTES -> onDock(TerminalDockItem.NOTES)
                TerminalAction.STATS -> onDock(TerminalDockItem.STATS)
                TerminalAction.THEME -> onDock(TerminalDockItem.THEME)
                TerminalAction.DISCONNECT -> viewModel.disconnect()
            }
        }
    }

    LaunchedEffect(viewModel) {
        viewModel.dockEvent.collect { item ->
            if (item == TerminalDockItem.KEYBOARD) keyboardVisible = !keyboardVisible else onDock(item)
        }
    }

    TerminalScreen(
        state = state,
        surfaceRevision = viewModel.surfaceRevision,
        readFrame = readFrame,
        remoteTitle = remoteTitle,
        keyboardVisible = keyboardVisible,
        onIntent = { intent ->
            dispatch(
                viewModel = viewModel,
                intent = intent,
                twoFingerScrollGoesRemote = twoFingerScrollGoesRemote,
                onKeyboardVisible = { visible -> keyboardVisible = visible },
            )
        },
        modifier = modifier,
        viewModel = viewModel,
        workspace = workspace,
        onWorkspace = onWorkspace,
        sessions = sessions,
        connections = connections,
        notes = notes,
        snippets = snippets,
        paneViewModels = paneViewModels,
        onSelectSession = onSelectSession,
        onCloseSession = onCloseSession,
        onAddSession = onAddSession,
        onOpenNote = onOpenNote,
        onOpenDocker = onOpenDocker,
        onMessage = { msg -> coroutineScope.launch { onMessage(msg) } },
        onCopy = {
            val selected = viewModel.readScrollback(0, 24)
            if (selected.isNotBlank()) {
                clipboard.setText(androidx.compose.ui.text.AnnotatedString(selected))
                coroutineScope.launch { onMessage("已复制 · " + (state as? PageState.Content)?.value?.connection?.name.orEmpty()) }
            } else {
                coroutineScope.launch { onMessage("已复制 · " + (state as? PageState.Content)?.value?.connection?.name.orEmpty()) }
            }
        },
        onPaste = {
            clipboard.getText()?.text?.let { text ->
                viewModel.controller.onPaste(text)
                coroutineScope.launch { onMessage("已粘贴到 " + (state as? PageState.Content)?.value?.connection?.name.orEmpty()) }
            }
        },
    )
}

/**
 * The single dispatch point for [TerminalIntent].
 *
 * One exhaustive when rather than a bag of lambdas: adding a capability to the surface then fails to
 * compile here until it is wired to exactly one owner, which is the property the frozen single-owner
 * rule in TERMINAL_EXPERIENCE.md 3 needs from the code and not just from a review.
 */
private fun dispatch(
    viewModel: TerminalViewModel,
    intent: TerminalIntent,
    twoFingerScrollGoesRemote: Boolean,
    onKeyboardVisible: (Boolean) -> Unit,
) {
    val controller = viewModel.controller
    when (intent) {
        is TerminalIntent.Geometry -> controller.onGeometry(
            totalWidthPx = intent.totalWidthPx,
            totalHeightPx = intent.totalHeightPx,
            imeHeightPx = intent.imeHeightPx,
            shortcutMatrixHeightPx = intent.shortcutMatrixHeightPx,
            dockHeightPx = intent.dockHeightPx,
            cellWidthPx = intent.cellWidthPx,
            lineHeightPx = intent.lineHeightPx,
        )

        is TerminalIntent.KeyStroke -> controller.onKey(intent.stroke)
        is TerminalIntent.Shortcut -> controller.onExtraKey(intent.key)
        is TerminalIntent.Composing -> controller.onComposing(intent.text, intent.cursor)
        is TerminalIntent.Commit -> controller.onCommit(intent.text)
        TerminalIntent.FinishComposing -> controller.onFinishComposing()
        TerminalIntent.CancelComposing -> controller.onCancelComposing()

        is TerminalIntent.Paste -> controller.onPaste(intent.text)
        is TerminalIntent.ConfirmPaste -> controller.onPasteConfirmed(intent.keepTrailingNewline)
        TerminalIntent.CancelPaste -> controller.onPasteCancelled()

        is TerminalIntent.PointerDown -> controller.onPointerDown(intent.pointerCount)
        is TerminalIntent.PointerMove -> controller.onPointerMove(
            pointerCount = intent.pointerCount,
            dxPx = intent.dxPx,
            dyPx = intent.dyPx,
            spanDeltaPx = intent.spanDeltaPx,
            column = intent.column,
            row = intent.row,
            twoFingerScrollGoesRemote = twoFingerScrollGoesRemote,
        )
        TerminalIntent.GestureEnd -> controller.onGestureEnd()
        TerminalIntent.LongPress -> controller.onLongPress()
        // A tap with no mouse mode is a focus request, and the controller says so by emitting
        // TOGGLE_KEYBOARD rather than by returning a flag the caller might ignore.
        is TerminalIntent.Tap -> controller.onTap(intent.column, intent.row)
        is TerminalIntent.Wheel -> controller.onWheel(intent.notches, intent.column, intent.row)
        is TerminalIntent.Fling -> controller.onFling(intent.velocityPxPerSecond)
        is TerminalIntent.SelectionActive -> controller.setSelectionActive(intent.active)

        is TerminalIntent.ScrollPages -> controller.scrollPages(intent.pages)
        TerminalIntent.JumpToBottom -> controller.jumpToBottom()

        TerminalIntent.Connect -> viewModel.connect()
        TerminalIntent.Reconnect -> viewModel.reconnect()
        TerminalIntent.Disconnect -> viewModel.disconnect()
        TerminalIntent.Minimise -> viewModel.minimise()
        TerminalIntent.TrustHostKey -> viewModel.onHostKeyAccepted()
        TerminalIntent.RejectHostKey -> viewModel.onHostKeyRejected()
        is TerminalIntent.SetEncoding -> viewModel.setEncoding(intent.encoding)
        is TerminalIntent.Dock -> {
            // The keyboard is the screen's own state: routing it through the ViewModel would make the
            // IME flag survive the screen it belongs to.
            if (intent.item == TerminalDockItem.KEYBOARD) onKeyboardVisible(true) else viewModel.onDock(intent.item)
        }
    }
}

/**
 * Bridges the one-shot message flow to the host's snackbar.
 *
 * Keyed on the flow so a recomposition does not resubscribe and replay the same message twice.
 */
@Composable
private fun CollectSessionMessages(messages: Flow<String>, onMessage: suspend (String) -> Unit) {
    LaunchedEffect(messages) { messages.collect { onMessage(it) } }
}
