package one.zephyr.mobile.feature.sessions

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.blur
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.flow.StateFlow
import one.zephyr.mobile.data.session.SessionRow
import one.zephyr.mobile.data.session.SessionTransport
import one.zephyr.mobile.model.Connection
import one.zephyr.mobile.model.Note
import one.zephyr.mobile.model.PageState
import one.zephyr.mobile.model.Protocol
import one.zephyr.mobile.model.Snippet
import one.zephyr.mobile.model.TerminalEncoding
import one.zephyr.mobile.ui.component.ActionSheet
import one.zephyr.mobile.ui.component.ActionSheetGroup
import one.zephyr.mobile.ui.component.ActionSheetItem
import one.zephyr.mobile.ui.component.AlertDialog
import one.zephyr.mobile.ui.component.AlertDialogLayout
import one.zephyr.mobile.ui.component.Text
import one.zephyr.mobile.ui.component.TextButton
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.foundation.border
import androidx.compose.foundation.shape.RoundedCornerShape
import one.zephyr.mobile.ui.theme.ZephyrRadius
import one.zephyr.mobile.ui.component.CleartextProtocolWarning
import one.zephyr.mobile.ui.state.PageStateScaffold
import one.zephyr.mobile.ui.theme.ZephyrSpacing
import one.zephyr.mobile.ui.theme.ZephyrTheme
import one.zephyr.mobile.ui.theme.ZephyrTextStyles

/**
 * S21 SSH/Telnet terminal. Chrome is a 1:1 lift of demo `#page-terminal`.
 * The viewport is Termux's TerminalView; the keyboard is the system IME.
 */
@Composable
fun TerminalScreen(
    state: PageState<TerminalContent>,
    surfaceRevision: StateFlow<Int>,
    readFrame: (topRow: Int, rows: Int) -> TerminalRenderFrame,
    remoteTitle: String?,
    keyboardVisible: Boolean,
    onIntent: (TerminalIntent) -> Unit,
    modifier: Modifier = Modifier,
    viewModel: TerminalViewModel? = null,
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
    onCreateConnection: () -> Unit = {},
    onOpenNote: (String) -> Unit = {},
    onOpenDocker: () -> Unit = {},
    sftpPort: one.zephyr.mobile.feature.notes.SftpPort? = null,
    onMessage: (String) -> Unit = {},
    onCopy: () -> Unit = {},
    onPaste: () -> Unit = {},
) {
    PageStateScaffold(
        state = state,
        modifier = modifier,
        onRetry = { onIntent(TerminalIntent.Reconnect) },
    ) { content ->
        DemoTerminalSurface(
            content = content,
            surfaceRevision = surfaceRevision,
            readFrame = readFrame,
            remoteTitle = remoteTitle,
            keyboardVisible = keyboardVisible,
            onIntent = onIntent,
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
            onCreateConnection = onCreateConnection,
            onOpenNote = onOpenNote,
            onOpenDocker = onOpenDocker,
            sftpPort = sftpPort,
            onMessage = onMessage,
            onCopy = onCopy,
            onPaste = onPaste,
        )
    }
}

@Composable
private fun DemoTerminalSurface(
    content: TerminalContent,
    surfaceRevision: StateFlow<Int>,
    readFrame: (topRow: Int, rows: Int) -> TerminalRenderFrame,
    remoteTitle: String?,
    keyboardVisible: Boolean,
    onIntent: (TerminalIntent) -> Unit,
    viewModel: TerminalViewModel?,
    workspace: TerminalWorkspaceState?,
    onWorkspace: (TerminalWorkspaceState) -> Unit,
    sessions: List<SessionRow>,
    connections: List<Connection>,
    notes: List<Note>,
    snippets: List<Snippet>,
    paneViewModels: Map<String, TerminalViewModel>,
    onSelectSession: (String) -> Unit,
    onCloseSession: (String) -> Unit,
    onAddSession: (Connection) -> Unit,
    onCreateConnection: () -> Unit,
    onOpenNote: (String) -> Unit,
    onOpenDocker: () -> Unit,
    sftpPort: one.zephyr.mobile.feature.notes.SftpPort?,
    onMessage: (String) -> Unit,
    onCopy: () -> Unit,
    onPaste: () -> Unit,
) {
    val palette = ZephyrTheme.palette
    val baseColors = remember(palette) { terminalChromeColors(palette) }
    val colors = remember(baseColors, workspace?.customBackgroundColor, workspace?.customSelectionColor) {
        baseColors.copy(
            termBg = if (workspace?.customBackgroundColor == true) {
                if (palette.dark) Color(0xFF101820) else Color(0xFFE7EDF4)
            } else baseColors.termBg,
            selectionBackground = if (workspace?.customSelectionColor == true) baseColors.accent.copy(alpha = 0.72f) else null,
            selectionForeground = if (workspace?.customSelectionColor == true) Color.White else null,
        )
    }
    val density = LocalDensity.current
    val imeHeightPx = WindowInsets.ime.getBottom(density).toFloat()
    // keyboardVisible is a request; only the real inset proves that the system IME is onscreen.
    // Treating a pending request as open made the context dock alpha=0 while it still occupied
    // height, producing the blank band reported on device.
    val imeOpen = imeHeightPx > 8f
    val surface = content.surface
    val ws = workspace ?: TerminalWorkspaceState(activeSessionId = content.connection.id)
    val liveSessions = sessions.filter { it.protocol.isTerminal && it.transport != SessionTransport.CLOSED }
    val focusedRow = liveSessions.firstOrNull { it.sessionId == ws.focusedSessionId }
        ?: liveSessions.firstOrNull { it.sessionId == content.connection.id }
    val focusedVm = paneViewModels[ws.focusedSessionId] ?: viewModel
    val focusedSurface = focusedVm?.controller?.state?.collectAsStateWithLifecycle()?.value ?: surface
    val cols = focusedSurface.size.columns
    val rows = focusedSurface.size.rows
    val name = focusedRow?.name ?: content.connection.name
    val subtitle = sessionSubtitle(content.connection.copy(
        name = name,
        host = focusedRow?.host ?: content.connection.host,
        port = focusedRow?.port ?: content.connection.port,
        username = content.connection.username,
    ), cols, rows, imeOpen)
    var containerW by remember { mutableStateOf(0) }
    var containerH by remember { mutableStateOf(0) }

    val insertToastMsg = stringResource(R.string.terminal_insert_toast)
    val openConnectionIds = liveSessions.mapTo(mutableSetOf()) { it.connectionId }.apply {
        add(content.connection.id)
    }
    val addableConnections = connections.filter { connection ->
        connection.protocol.isTerminal && connection.id !in openConnectionIds
    }

    LaunchedEffect(containerW, containerH, focusedSurface.fontSp) {
        if (containerW <= 0 || containerH <= 0) return@LaunchedEffect
        val cellW = (focusedSurface.fontSp * 0.6f) * density.density
        val lineH = (focusedSurface.fontSp * 1.55f) * density.density
        onIntent(
            TerminalIntent.Geometry(
                totalWidthPx = containerW.toFloat(),
                totalHeightPx = containerH.toFloat(),
                // containerH is the measured terminal canvas only. Chrome and IME are outside it.
                imeHeightPx = 0f,
                shortcutMatrixHeightPx = 0f,
                dockHeightPx = 0f,
                cellWidthPx = cellW,
                lineHeightPx = lineH,
            ),
        )
    }

    Box(Modifier.fillMaxSize()) {
        BoxWithConstraints(Modifier.fillMaxSize().background(colors.termBg)) {
        val pad = maxWidth >= TerminalWorkspace.PAD_RAIL_MIN_DP.dp
        DemoTermBackground(ws, colors)
        Row(Modifier.fillMaxSize()) {
            if (pad) {
                DemoPadRail(
                    connections = connections.filter { it.protocol.isTerminal },
                    liveNames = liveSessions.map { it.name }.toSet(),
                    colors = colors,
                    onOpen = onAddSession,
                )
            }
            Column(
                Modifier
                    .weight(1f)
                    .fillMaxHeight()
                    // The activity uses adjustNothing so the terminal owns IME avoidance. Lift the
                    // complete terminal stack above the system keyboard: viewport -> shortcut row.
                    // The context dock is removed while IME is open, matching demo `.ime-on`.
                    .imePadding(),
            ) {
                if (content.cleartextWarning != null) {
                    CleartextProtocolWarning(protocol = content.connection.protocol)
                }
                DemoTermHead(
                    name = name,
                    subtitle = subtitle,
                    latency = latencyLabel(focusedRow),
                    transport = focusedRow?.transport ?: content.transport,
                    colors = colors,
                    padSwapSide = if (pad) {
                        {
                            onWorkspace(
                                ws.copy(
                                    padTermSide = if (ws.padTermSide == PadTermSide.LEFT) PadTermSide.RIGHT else PadTermSide.LEFT,
                                ),
                            )
                        }
                    } else {
                        null
                    },
                )
                DemoSessRail(
                    sessions = liveSessions.ifEmpty {
                        listOf(
                            SessionRow(
                                sessionId = content.connection.id,
                                connectionId = content.connection.id,
                                protocol = content.connection.protocol,
                                name = content.connection.name,
                                host = content.connection.host,
                                port = content.connection.port,
                                transport = content.transport,
                                execution = one.zephyr.mobile.data.session.SessionExecution.LOCAL,
                                capabilities = content.connection.capabilities,
                            ),
                        )
                    },
                    focusedId = ws.focusedSessionId,
                    otherId = null,
                    colors = colors,
                    onSelect = onSelectSession,
                    onClose = onCloseSession,
                    onAdd = { onWorkspace(ws.copy(addSheetOpen = true)) },
                )
                Box(
                    Modifier
                        .weight(1f)
                        .fillMaxWidth()
                        .onSizeChanged {
                            containerW = it.width
                            containerH = it.height
                        },
                ) {
                    TerminalSplitArea(
                        content = content,
                        workspace = ws,
                        colors = colors,
                        keyboardVisible = keyboardVisible,
                        focusedVm = focusedVm,
                        paneViewModels = paneViewModels,
                        notes = notes,
                        snippets = snippets,
                        onWorkspace = onWorkspace,
                        onIntent = onIntent,
                        onInsert = { text -> onIntent(TerminalIntent.Commit(text)); onMessage(insertToastMsg) },
                        onOpenNote = onOpenNote,
                        onOpenDocker = {
                            onWorkspace(TerminalWorkspace.openTool(ws, TerminalToolKind.DOCKER, phone = !pad))
                        },
                        onMessage = onMessage,
                    )
                }
                // Row 1 is permanent and hugs the system IME. Row 2 is the context dock and is
                // removed while IME is open, matching the demo/Termux stack exactly.
                DemoKeyRow(latches = focusedSurface.latches, colors = colors, onIntent = onIntent)
                if (!imeOpen) {
                    DemoContextDock(
                        items = content.dock,
                        colors = colors,
                        onIntent = { intent ->
                            when (intent) {
                                is TerminalIntent.Dock -> when (intent.item) {
                                    TerminalDockItem.COPY -> onCopy()
                                    TerminalDockItem.PASTE -> onPaste()
                                    TerminalDockItem.KEYBOARD -> {
                                        onWorkspace(TerminalWorkspace.closeSheet(ws))
                                        onIntent(intent)
                                    }
                                    TerminalDockItem.DISCONNECT -> onWorkspace(ws.copy(disconnectSheetOpen = true))
                                    else -> {
                                        TerminalToolKind.fromDock(intent.item)?.let { kind ->
                                            onWorkspace(TerminalWorkspace.openTool(ws, kind, phone = !pad))
                                        } ?: onIntent(intent)
                                    }
                                }
                                else -> onIntent(intent)
                            }
                        },
                    )
                }
                if (!pad && ws.sheetCurrent != null &&
                    (!imeOpen || ws.sheetCurrent?.keepsIme == true || ws.sheetFraction == 0f)
                ) {
                    TerminalToolSheet(
                        workspace = ws,
                        colors = colors,
                        hostName = name,
                        viewModel = focusedVm,
                        connectionId = content.connection.id,
                        sftpPort = sftpPort,
                        notes = notes,
                        snippets = snippets,
                        onWorkspace = onWorkspace,
                        onInsert = { text -> onIntent(TerminalIntent.Commit(text)); onMessage(insertToastMsg) },
                        onOpenNote = onOpenNote,
                        onOpenDocker = {
                            onWorkspace(TerminalWorkspace.openTool(ws, TerminalToolKind.DOCKER, phone = true))
                        },
                        onMessage = onMessage,
                    )
                }
            }
        }
    }

    content.surface.pendingPaste?.let { pending ->
        PasteConfirmation(pending = pending, onIntent = onIntent)
    }
    content.hostKeyPrompt?.let { prompt ->
        HostKeyConfirmation(prompt = prompt, onIntent = onIntent)
    }

    ActionSheet(
        visible = ws.addSheetOpen,
        onDismiss = { onWorkspace(ws.copy(addSheetOpen = false)) },
        groups = listOf(
            ActionSheetGroup(
                title = stringResource(R.string.terminal_new_session_title),
                items = addableConnections.map { connection ->
                    ActionSheetItem(
                        label = connection.name,
                        subtitle = connection.displayAddress,
                        onClick = {
                            onWorkspace(ws.copy(addSheetOpen = false))
                            onAddSession(connection)
                        },
                    )
                },
            ),
            ActionSheetGroup(
                items = listOf(
                    ActionSheetItem(
                        label = stringResource(R.string.terminal_cancel),
                        cancel = true,
                        onClick = { onWorkspace(ws.copy(addSheetOpen = false)) },
                    ),
                ),
            ),
        ),
    )
    ActionSheet(
        visible = ws.disconnectSheetOpen,
        onDismiss = { onWorkspace(ws.copy(disconnectSheetOpen = false)) },
        groups = listOf(
            ActionSheetGroup(title = stringResource(R.string.terminal_disconnect_title, name), items = emptyList()),
            ActionSheetGroup(
                items = listOf(
                    ActionSheetItem(
                        label = stringResource(R.string.terminal_disconnect_confirm),
                        danger = true,
                        onClick = {
                            onWorkspace(ws.copy(disconnectSheetOpen = false))
                            onIntent(TerminalIntent.Disconnect)
                        },
                    ),
                ),
            ),
            ActionSheetGroup(
                items = listOf(
                    ActionSheetItem(
                        label = stringResource(R.string.terminal_cancel),
                        cancel = true,
                        onClick = { onWorkspace(ws.copy(disconnectSheetOpen = false)) },
                    ),
                ),
            ),
        ),
    )
    }
    @Suppress("UNUSED_VARIABLE", "UNUSED_PARAMETER")
    val keep = Triple(surfaceRevision, readFrame, remoteTitle)
}

@Composable
private fun DemoTermBackground(workspace: TerminalWorkspaceState, colors: TerminalChromeColors) {
    if (workspace.background == TermBackgroundKind.NONE) return
    val brush = if (workspace.background == TermBackgroundKind.BIG) {
        Brush.verticalGradient(listOf(Color(0xFF0D1F18), colors.termBg))
    } else {
        Brush.linearGradient(listOf(Color(0xFF12233A), Color(0xFF0A1420)))
    }
    Box(
        Modifier
            .fillMaxSize()
            .blur(workspace.backgroundBlurPx.dp)
            .graphicsLayer { alpha = workspace.backgroundOpacity }
            .background(brush),
    )
}

@Composable
private fun TerminalSplitArea(
    content: TerminalContent,
    workspace: TerminalWorkspaceState,
    colors: TerminalChromeColors,
    keyboardVisible: Boolean,
    focusedVm: TerminalViewModel?,
    paneViewModels: Map<String, TerminalViewModel>,
    notes: List<Note>,
    snippets: List<Snippet>,
    onWorkspace: (TerminalWorkspaceState) -> Unit,
    onIntent: (TerminalIntent) -> Unit,
    onInsert: (String) -> Unit,
    onOpenNote: (String) -> Unit,
    onOpenDocker: () -> Unit,
    onMessage: (String) -> Unit,
) {
    /* Single terminal pane. On a pad in landscape the pane sits on
     * [TerminalWorkspaceState.padTermSide] and the opposite side hosts either
     * the open tool panel or a quiet placeholder; a gutter between them drags
     * the terminal from [TerminalWorkspace.PAD_MIN_TERM_FRACTION] up to full
     * width. On a phone the pane is always full-width and tools live in the
     * bottom sheet. */
    val vmA = paneViewModels[workspace.activeSessionId] ?: focusedVm
    Row(Modifier.fillMaxSize()) {
        val terminalFirst = workspace.padTermSide == PadTermSide.LEFT
        val panelVisible = workspace.padPanelTool != null &&
            workspace.padTermFraction < TerminalWorkspace.PAD_MAX_TERM_FRACTION

        val terminal: @Composable () -> Unit = {
            Box(Modifier.fillMaxSize()) {
                if (vmA != null) {
                    TermuxTerminalPane(
                        viewModel = vmA,
                        keyboardVisible = keyboardVisible,
                        colors = colors,
                        focused = true,
                        onTap = { onIntent(TerminalIntent.Dock(TerminalDockItem.KEYBOARD)) },
                        modifier = Modifier.fillMaxSize(),
                    )
                }
                if (!content.transport.isLive) {
                    ConnectPrompt(transport = content.transport, onIntent = onIntent)
                }
            }
        }
        val panel: @Composable () -> Unit = {
            if (workspace.padPanelTool != null) {
                SideToolDock(
                    workspace = workspace,
                    colors = colors,
                    hostName = content.connection.name,
                    notes = notes,
                    snippets = snippets,
                    onWorkspace = onWorkspace,
                    onInsert = onInsert,
                    onOpenNote = onOpenNote,
                    onOpenDocker = onOpenDocker,
                    onMessage = onMessage,
                    viewModel = focusedVm,
                    modifier = Modifier.fillMaxSize(),
                )
            }
        }

        /* Full-width terminal: nothing else to lay out. */
        if (!panelVisible) {
            Box(Modifier.weight(1f).fillMaxHeight()) { terminal() }
            return@Row
        }

        val panelFraction = (1f - workspace.padTermFraction).coerceAtLeast(0.05f)
        if (!terminalFirst) {
            Box(Modifier.weight(1f - panelFraction).fillMaxHeight()) { terminal() }
            PadGutter(colors, workspace, onWorkspace)
            Box(Modifier.weight(panelFraction).fillMaxHeight()) { panel() }
        } else {
            Box(Modifier.weight(panelFraction).fillMaxHeight()) { panel() }
            PadGutter(colors, workspace, onWorkspace)
            Box(Modifier.weight(1f - panelFraction).fillMaxHeight()) { terminal() }
        }
    }
}

@Composable
private fun PadGutter(
    colors: TerminalChromeColors,
    workspace: TerminalWorkspaceState,
    onWorkspace: (TerminalWorkspaceState) -> Unit,
) {
    var dragging by remember { mutableStateOf(false) }
    var start by remember { mutableStateOf(workspace.padTermFraction) }
    var rowWidthPx by remember { mutableStateOf(0f) }
    Box(
        modifier = Modifier
            .width(TerminalWorkspace.GUTTER_WIDTH_DP.dp)
            .fillMaxHeight()
            .onSizeChanged { rowWidthPx = it.width.toFloat() * 40f }
            .pointerInput(workspace.padTermSide) {
                detectDragGestures(
                    onDragStart = {
                        dragging = true
                        start = workspace.padTermFraction
                    },
                    onDragEnd = { dragging = false },
                    onDragCancel = { dragging = false },
                    onDrag = { change, drag ->
                        change.consume()
                        val next = TerminalWorkspace.dragPadTermFraction(
                            startFraction = start,
                            dxPx = drag.x,
                            rowWidthPx = rowWidthPx,
                            side = workspace.padTermSide,
                        )
                        start = next
                        onWorkspace(workspace.copy(padTermFraction = next))
                    },
                )
            },
    ) {
        Box(
            Modifier
                .fillMaxHeight()
                .width(if (dragging) 2.dp else 1.dp)
                .padding(start = 5.dp)
                .background(if (dragging) colors.accent else colors.line),
        )
    }
}

@Composable
private fun ConnectPrompt(transport: SessionTransport, onIntent: (TerminalIntent) -> Unit) {
    val palette = ZephyrTheme.palette
    Row(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 8.dp)) {
        Text(
            text = when (transport) {
                SessionTransport.DISCONNECTED -> stringResource(R.string.terminal_disconnected_hint)
                SessionTransport.CLOSED -> stringResource(R.string.terminal_closed_hint)
                else -> ""
            },
            style = ZephyrTextStyles.caption,
            color = palette.onFloatingMuted,
            modifier = Modifier.weight(1f),
        )
        TextButton(onClick = { onIntent(TerminalIntent.Reconnect) }) {
            Text(stringResource(R.string.terminal_reconnect))
        }
    }
}

@Composable
private fun PasteConfirmation(
    pending: PasteDecision.NeedsConfirmation,
    onIntent: (TerminalIntent) -> Unit,
) {
    AlertDialog(
        onDismissRequest = { onIntent(TerminalIntent.CancelPaste) },
        title = { Text(stringResource(R.string.terminal_paste_title)) },
        text = {
            Column {
                Text(stringResource(R.string.terminal_paste_summary, pending.lineCount, pending.byteCount))
                Text(
                    text = pending.text.take(512),
                    style = ZephyrTextStyles.monoCaption,
                    maxLines = 8,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        },
        confirmButton = {
            TextButton(onClick = { onIntent(TerminalIntent.ConfirmPaste(keepTrailingNewline = true)) }) {
                Text(stringResource(R.string.terminal_paste_confirm))
            }
        },
        dismissButton = {
            Row {
                if (pending.endsWithNewline) {
                    TextButton(onClick = { onIntent(TerminalIntent.ConfirmPaste(keepTrailingNewline = false)) }) {
                        Text(stringResource(R.string.terminal_paste_without_newline))
                    }
                }
                TextButton(onClick = { onIntent(TerminalIntent.CancelPaste) }) {
                    Text(stringResource(R.string.terminal_cancel))
                }
            }
        },
    )
}

@Composable
private fun HostKeyConfirmation(prompt: HostKeyPrompt, onIntent: (TerminalIntent) -> Unit) {
    val palette = ZephyrTheme.palette
    AlertDialog(
        onDismissRequest = { onIntent(TerminalIntent.RejectHostKey) },
        title = {
            Text(
                if (prompt.changed) stringResource(R.string.terminal_host_key_changed_title)
                else stringResource(R.string.terminal_host_key_new_title),
            )
        },
        text = {
            Column(modifier = Modifier.fillMaxWidth()) {
                Text(
                    text = if (prompt.changed) stringResource(R.string.terminal_host_key_changed_body)
                    else stringResource(R.string.terminal_host_key_new_body),
                    color = if (prompt.changed) palette.status.error else palette.onBackground,
                )
                Text(
                    text = AlertDialogLayout.wrapFingerprint(prompt.fingerprint),
                    style = ZephyrTextStyles.mono,
                    textAlign = TextAlign.Start,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = ZephyrSpacing.sm)
                        .border(1.dp, palette.surfaces.outline, RoundedCornerShape(ZephyrRadius.sm))
                        .padding(ZephyrSpacing.sm),
                )
            }
        },
        confirmButton = {
            if (prompt.changed) {
                TextButton(onClick = { onIntent(TerminalIntent.RejectHostKey) }) {
                    Text(stringResource(R.string.terminal_host_key_reject))
                }
            } else {
                TextButton(onClick = { onIntent(TerminalIntent.TrustHostKey) }) {
                    Text(stringResource(R.string.terminal_host_key_trust))
                }
            }
        },
        dismissButton = {
            if (prompt.changed) {
                TextButton(onClick = { onIntent(TerminalIntent.TrustHostKey) }) {
                    Text(stringResource(R.string.terminal_host_key_trust_anyway))
                }
            } else {
                TextButton(onClick = { onIntent(TerminalIntent.RejectHostKey) }) {
                    Text(stringResource(R.string.terminal_cancel))
                }
            }
        },
    )
}
