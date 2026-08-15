package one.zephyr.mobile.feature.sessions

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.zIndex
import kotlin.math.roundToInt
import one.zephyr.mobile.model.Note
import one.zephyr.mobile.model.Snippet
import one.zephyr.mobile.ui.component.Icon
import one.zephyr.mobile.ui.component.Text
import one.zephyr.mobile.ui.icon.ZephyrIcons
import one.zephyr.mobile.ui.theme.ZephyrTheme

@Composable
internal fun TerminalToolBody(
    kind: TerminalToolKind,
    colors: TerminalChromeColors,
    notes: List<Note>,
    snippets: List<Snippet>,
    workspace: TerminalWorkspaceState,
    onWorkspace: (TerminalWorkspaceState) -> Unit,
    onInsert: (String) -> Unit,
    onOpenNote: (String) -> Unit,
    onOpenDocker: () -> Unit,
    onMessage: (String) -> Unit,
) {
    when (kind) {
        TerminalToolKind.FILES -> FilesToolBody(colors, onMessage)
        TerminalToolKind.SNIPPET -> SnippetToolBody(colors, snippets, onInsert)
        TerminalToolKind.NOTES -> NotesToolBody(colors, notes, onOpenNote)
        TerminalToolKind.STATS -> StatsToolBody(colors, onOpenDocker, onMessage)
        TerminalToolKind.THEME -> ThemeToolBody(colors, workspace, onWorkspace, onMessage)
    }
}

@Composable
private fun FilesToolBody(colors: TerminalChromeColors, onMessage: (String) -> Unit) {
    val blockedMsg = stringResource(R.string.terminal_sftp_blocked)
    Column {
        ToolRow(colors, "nginx.conf", "12K") { onMessage(blockedMsg) }
        ToolRow(colors, "access.log", "210M") { onMessage(blockedMsg) }
        ToolRow(colors, "releases/", "dir") { onMessage(blockedMsg) }
        ToolRow(colors, "上传到此目录…", null, icon = ZephyrIcons.Download) {
            onMessage(blockedMsg)
        }
    }
}

@Composable
private fun SnippetToolBody(
    colors: TerminalChromeColors,
    snippets: List<Snippet>,
    onInsert: (String) -> Unit,
) {
    val rows = snippets.take(8).ifEmpty {
        listOf(
            Snippet(id = "demo-1", ownerUserId = "", name = "du", command = "du -x --max-depth=1 / | sort -rn"),
            Snippet(id = "demo-2", ownerUserId = "", name = "nginx", command = "systemctl reload nginx"),
            Snippet(id = "demo-3", ownerUserId = "", name = "journal", command = "journalctl -u zephyr -n 200"),
        )
    }
    Column {
        rows.forEach { snippet ->
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(9.dp))
                    .padding(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = snippet.command,
                    color = colors.text,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 11.sp,
                    modifier = Modifier.weight(1f),
                    maxLines = 2,
                )
                MiniButton(colors, stringResource(R.string.terminal_insert)) { onInsert(snippet.command) }
            }
        }
    }
}

@Composable
private fun NotesToolBody(
    colors: TerminalChromeColors,
    notes: List<Note>,
    onOpenNote: (String) -> Unit,
) {
    Column {
        if (notes.isEmpty()) {
            Text("没有关联笔记", color = colors.dim, fontSize = 12.sp, modifier = Modifier.padding(12.dp))
        } else {
            notes.take(12).forEach { note ->
                ToolRow(colors, note.title, null, icon = ZephyrIcons.Notes) { onOpenNote(note.noteId) }
            }
        }
    }
}

@Composable
private fun StatsToolBody(
    colors: TerminalChromeColors,
    onOpenDocker: () -> Unit,
    onMessage: (String) -> Unit,
) {
    val dockerLabel = stringResource(R.string.terminal_open_docker)
    val statsBlockedMsg = stringResource(R.string.terminal_stats_blocked)
    Column {
        Meter(colors, "CPU", "—", 0f)
        Meter(colors, "内存", "—", 0f)
        Meter(colors, "磁盘 /", "—", 0f, warn = true)
        Text(
            text = "DOCKER · $dockerLabel",
            color = colors.accent,
            fontSize = 10.sp,
            fontWeight = FontWeight.Bold,
            letterSpacing = 0.8.sp,
            modifier = Modifier
                .padding(horizontal = 8.dp, vertical = 8.dp)
                .then(Modifier),
        )
        TermPressable(onClick = onOpenDocker, modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp), scale = 0.99f) {
            Text(dockerLabel, color = colors.accent, fontSize = 12.sp)
        }
        Spacer(Modifier.height(6.dp))
        TermPressable(
            onClick = { onMessage(statsBlockedMsg) },
            modifier = Modifier.fillMaxWidth(),
            scale = 0.99f,
        ) {
            Text(
                text = statsBlockedMsg,
                color = colors.dim,
                fontSize = 11.sp,
                modifier = Modifier.padding(8.dp),
            )
        }
    }
}

@Composable
private fun ThemeToolBody(
    colors: TerminalChromeColors,
    workspace: TerminalWorkspaceState,
    onWorkspace: (TerminalWorkspaceState) -> Unit,
    onMessage: (String) -> Unit,
) {
    var customBg by remember { mutableStateOf(false) }
    var customSel by remember { mutableStateOf(false) }
    Column {
        Text(
            text = stringResource(R.string.terminal_theme_source),
            color = colors.dim,
            fontSize = 10.sp,
            fontWeight = FontWeight.Bold,
            letterSpacing = 0.8.sp,
            modifier = Modifier.padding(start = 8.dp, end = 8.dp, top = 8.dp, bottom = 4.dp),
        )
        BgRow(colors, stringResource(R.string.terminal_bg_none), workspace.background == TermBackgroundKind.NONE) {
            onWorkspace(workspace.copy(background = TermBackgroundKind.NONE))
        }
        BgRow(colors, stringResource(R.string.terminal_bg_image), workspace.background == TermBackgroundKind.IMAGE) {
            onWorkspace(workspace.copy(background = TermBackgroundKind.IMAGE))
        }
        BgRow(colors, stringResource(R.string.terminal_bg_big), workspace.background == TermBackgroundKind.BIG) {
            onWorkspace(workspace.copy(background = TermBackgroundKind.BIG))
        }
        SliderRow(
            colors,
            stringResource(R.string.terminal_bg_blur),
            "${workspace.backgroundBlurPx.roundToInt()}px",
            workspace.backgroundBlurPx / 20f,
        ) { onWorkspace(workspace.copy(backgroundBlurPx = it * 20f)) }
        SliderRow(
            colors,
            stringResource(R.string.terminal_bg_opacity),
            "${(workspace.backgroundOpacity * 100f).roundToInt()}%",
            (workspace.backgroundOpacity - 0.10f) / 0.90f,
        ) { onWorkspace(workspace.copy(backgroundOpacity = 0.10f + it * 0.90f)) }
        Text(
            text = stringResource(R.string.terminal_theme_override),
            color = colors.dim,
            fontSize = 10.sp,
            fontWeight = FontWeight.Bold,
            letterSpacing = 0.8.sp,
            modifier = Modifier.padding(start = 8.dp, end = 8.dp, top = 8.dp, bottom = 4.dp),
        )
        BgRow(colors, stringResource(R.string.terminal_custom_bg_color), customBg, toggle = true) {
            customBg = !customBg
            onMessage(if (customBg) "已启用自定义背景色" else "已关闭")
        }
        BgRow(colors, stringResource(R.string.terminal_custom_sel_color), customSel, toggle = true) {
            customSel = !customSel
        }
    }
}

@Composable
private fun BgRow(
    colors: TerminalChromeColors,
    label: String,
    on: Boolean,
    toggle: Boolean = false,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(9.dp))
            .padding(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, color = colors.text, fontSize = 12.sp, modifier = Modifier.weight(1f))
        MiniButton(colors, if (toggle) "开关" else stringResource(R.string.terminal_bg_apply), on) { onClick() }
    }
}

@Composable
private fun SliderRow(
    colors: TerminalChromeColors,
    label: String,
    value: String,
    fraction: Float,
    onChange: (Float) -> Unit,
) {
    Column(Modifier.padding(8.dp)) {
        Row(Modifier.fillMaxWidth()) {
            Text(label, color = Color(0xFF8B949E), fontFamily = FontFamily.Monospace, fontSize = 11.sp, modifier = Modifier.weight(1f))
            Text(value, color = Color(0xFF8B949E), fontFamily = FontFamily.Monospace, fontSize = 11.sp)
        }
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 6.dp)
                .height(18.dp)
                .pointerInput(Unit) {
                    detectDragGestures { change, _ ->
                        val next = (change.position.x / size.width.toFloat()).coerceIn(0f, 1f)
                        onChange(next)
                    }
                }
                .clip(RoundedCornerShape(3.dp))
                .background(Color(0xFF262C36)),
        ) {
            Box(
                Modifier
                    .fillMaxWidth(fraction.coerceIn(0f, 1f))
                    .fillMaxHeight()
                    .background(colors.accent),
            )
        }
    }
}

@Composable
private fun Meter(colors: TerminalChromeColors, label: String, value: String, fraction: Float, warn: Boolean = false) {
    Column(Modifier.padding(8.dp)) {
        Row(Modifier.fillMaxWidth()) {
            Text(label, color = Color(0xFF8B949E), fontFamily = FontFamily.Monospace, fontSize = 11.sp, modifier = Modifier.weight(1f))
            Text(value, color = Color(0xFF8B949E), fontFamily = FontFamily.Monospace, fontSize = 11.sp)
        }
        Box(
            Modifier
                .fillMaxWidth()
                .padding(top = 5.dp)
                .height(5.dp)
                .clip(RoundedCornerShape(3.dp))
                .background(Color(0xFF262C36)),
        ) {
            Box(
                Modifier
                    .fillMaxWidth(fraction.coerceIn(0f, 1f))
                    .fillMaxHeight()
                    .background(if (warn) Color(0xFFFFD60A) else colors.accent),
            )
        }
    }
}

@Composable
private fun ToolRow(
    colors: TerminalChromeColors,
    title: String,
    meta: String?,
    icon: androidx.compose.ui.graphics.vector.ImageVector = ZephyrIcons.File,
    onClick: () -> Unit,
) {
    TermPressable(onClick = onClick, modifier = Modifier.fillMaxWidth(), scale = 0.99f) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(9.dp))
                .padding(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(icon, contentDescription = null, tint = Color(0xFF8B949E), modifier = Modifier.size(15.dp))
            Spacer(Modifier.width(9.dp))
            Text(title, color = colors.text, fontFamily = FontFamily.Monospace, fontSize = 12.sp, modifier = Modifier.weight(1f), maxLines = 1)
            if (meta != null) {
                Text(meta, color = colors.dim, fontFamily = FontFamily.Monospace, fontSize = 10.5.sp)
            }
        }
    }
}

@Composable
private fun MiniButton(colors: TerminalChromeColors, label: String, on: Boolean = false, onClick: () -> Unit) {
    TermPressable(
        onClick = onClick,
        modifier = Modifier
            .clip(RoundedCornerShape(8.dp))
            .background(if (on) Color(0xFF2B4A38) else Color(0xFF2B323D))
            .padding(horizontal = 9.dp, vertical = 3.dp),
        scale = 0.92f,
    ) {
        Text(label, color = if (on) Color(0xFF7EE787) else Color(0xFFC9D1D9), fontSize = 10.5.sp, fontWeight = FontWeight.Bold)
    }
}

@Composable
internal fun SideToolDock(
    workspace: TerminalWorkspaceState,
    colors: TerminalChromeColors,
    hostName: String,
    notes: List<Note>,
    snippets: List<Snippet>,
    onWorkspace: (TerminalWorkspaceState) -> Unit,
    onInsert: (String) -> Unit,
    onOpenNote: (String) -> Unit,
    onOpenDocker: () -> Unit,
    onMessage: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier
            .fillMaxHeight()
            .background(colors.chrome),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 8.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            workspace.docked.forEach { kind ->
                val on = kind == workspace.dockCurrent
                TermPressable(
                    onClick = { onWorkspace(workspace.copy(dockCurrent = kind)) },
                    modifier = Modifier
                        .padding(end = 4.dp)
                        .clip(RoundedCornerShape(8.dp))
                        .background(if (on) colors.accent.copy(alpha = 0.30f) else colors.chrome2)
                        .padding(horizontal = 10.dp)
                        .height(28.dp),
                    scale = 0.95f,
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(toolIcon(kind), null, tint = if (on) Color.White else colors.dim, modifier = Modifier.size(12.dp))
                        Spacer(Modifier.width(5.dp))
                        Text(
                            text = toolTitle(kind, hostName).substringBefore('·').trim(),
                            color = if (on) Color.White else colors.dim,
                            fontSize = 11.5.sp,
                            fontWeight = FontWeight.SemiBold,
                        )
                        TermPressable(
                            onClick = { onWorkspace(TerminalWorkspace.undock(workspace, kind)) },
                            modifier = Modifier.padding(start = 4.dp),
                            scale = 0.9f,
                        ) {
                            Text("×", color = (if (on) Color.White else colors.dim).copy(alpha = 0.7f), fontSize = 13.sp)
                        }
                    }
                }
            }
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(colors.line))
        Box(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(6.dp)) {
            val current = workspace.dockCurrent
            if (current == null) {
                Text(
                    text = stringResource(R.string.terminal_dock_empty),
                    color = colors.dim,
                    fontSize = 12.5.sp,
                    modifier = Modifier.padding(28.dp),
                )
            } else {
                TerminalToolBody(
                    kind = current,
                    colors = colors,
                    notes = notes,
                    snippets = snippets,
                    workspace = workspace,
                    onWorkspace = onWorkspace,
                    onInsert = onInsert,
                    onOpenNote = onOpenNote,
                    onOpenDocker = onOpenDocker,
                    onMessage = onMessage,
                )
            }
        }
    }
}

@Composable
internal fun FloatingToolLayer(
    workspace: TerminalWorkspaceState,
    colors: TerminalChromeColors,
    hostName: String,
    notes: List<Note>,
    snippets: List<Snippet>,
    onWorkspace: (TerminalWorkspaceState) -> Unit,
    onInsert: (String) -> Unit,
    onOpenNote: (String) -> Unit,
    onOpenDocker: () -> Unit,
    onMessage: (String) -> Unit,
) {
    var parent by remember { mutableStateOf(IntSize.Zero) }
    val density = LocalDensity.current
    Box(Modifier.fillMaxSize().onSizeChanged { parent = it }) {
        workspace.floating.sortedBy { it.z }.forEachIndexed { index, panel ->
            val (staggerX, staggerY) = TerminalWorkspace.floatingOffset(index)
            val defaultW = with(density) {
                (parent.width * TerminalWorkspace.FLOAT_DEFAULT_WIDTH_FRACTION)
                    .coerceAtMost(TerminalWorkspace.FLOAT_DEFAULT_MAX_WIDTH_DP.dp.toPx())
                    .coerceAtLeast(TerminalWorkspace.FLOAT_MIN_WIDTH_DP.dp.toPx())
            }
            val defaultH = (parent.height * TerminalWorkspace.FLOAT_DEFAULT_HEIGHT_FRACTION)
                .coerceAtLeast(with(density) { TerminalWorkspace.FLOAT_MIN_HEIGHT_DP.dp.toPx() })
            var x by remember(panel.kind, parent) {
                mutableFloatStateOf(
                    if (!panel.offsetXPx.isNaN()) panel.offsetXPx
                    else parent.width * (staggerX / 100f),
                )
            }
            var y by remember(panel.kind, parent) {
                mutableFloatStateOf(
                    if (!panel.offsetYPx.isNaN()) panel.offsetYPx
                    else parent.height * (staggerY / 100f),
                )
            }
            var w by remember(panel.kind, parent) {
                mutableFloatStateOf(if (!panel.widthPx.isNaN()) panel.widthPx else defaultW)
            }
            var h by remember(panel.kind, parent) {
                mutableFloatStateOf(if (!panel.heightPx.isNaN()) panel.heightPx else defaultH)
            }
            val laid = when (panel.layout) {
                TermPanelLayout.FREE -> null
                TermPanelLayout.LEFT_HALF -> Quad(0f, 0f, parent.width * 0.5f, parent.height.toFloat())
                TermPanelLayout.RIGHT_HALF -> Quad(parent.width * 0.5f, 0f, parent.width * 0.5f, parent.height.toFloat())
                TermPanelLayout.BOTTOM -> Quad(0f, parent.height * 0.55f, parent.width.toFloat(), parent.height * 0.45f)
            }
            val left = laid?.x ?: x
            val top = laid?.y ?: y
            val width = laid?.w ?: w
            val height = laid?.h ?: h
            Column(
                modifier = Modifier
                    .zIndex(panel.z.toFloat())
                    .offset { IntOffset(left.roundToInt(), top.roundToInt()) }
                    .width(with(density) { width.toDp() })
                    .height(with(density) { height.toDp() })
                    .shadow(18.dp, RoundedCornerShape(16.dp))
                    .clip(RoundedCornerShape(16.dp))
                    .background(ZephyrPaletteMix(colors.accent, Color(0xEB12161C), 0.07f))
                    .border(1.dp, colors.accent.copy(alpha = 0.22f), RoundedCornerShape(16.dp))
                    .pointerInput(panel.kind) {
                        detectDragGestures(
                            onDragStart = { onWorkspace(TerminalWorkspace.raiseFloating(workspace, panel.kind)) },
                            onDrag = { _, _ -> },
                        )
                    },
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .pointerInput(panel.kind, panel.layout) {
                            if (panel.layout != TermPanelLayout.FREE) return@pointerInput
                            detectDragGestures { _, drag ->
                                x = (x + drag.x).coerceIn(-40f, (parent.width - 80).toFloat())
                                y = (y + drag.y).coerceIn(0f, (parent.height - 90).toFloat())
                            }
                        }
                        .padding(start = 12.dp, end = 6.dp, top = 8.dp, bottom = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(toolIcon(panel.kind), null, tint = colors.accent, modifier = Modifier.size(14.dp))
                    Spacer(Modifier.width(7.dp))
                    Text(
                        text = toolTitle(panel.kind, hostName),
                        color = Color(0xFFDBE2EA),
                        fontSize = 12.5.sp,
                        fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.weight(1f),
                        maxLines = 1,
                    )
                    TermPressable(
                        onClick = { onWorkspace(TerminalWorkspace.cycleLayout(workspace, panel.kind)) },
                        modifier = Modifier
                            .size(26.dp)
                            .clip(CircleShape)
                            .background(if (panel.layout != TermPanelLayout.FREE) colors.accent.copy(alpha = 0.18f) else Color.Transparent),
                        scale = 0.88f,
                    ) {
                        Icon(ZephyrIcons.GridTools, stringResource(R.string.terminal_layout), tint = if (panel.layout != TermPanelLayout.FREE) colors.accent else Color(0xFF8B949E), modifier = Modifier.size(13.dp))
                    }
                    TermPressable(
                        onClick = { onWorkspace(TerminalWorkspace.closeFloating(workspace, panel.kind)) },
                        modifier = Modifier.size(26.dp).clip(CircleShape),
                        scale = 0.88f,
                    ) {
                        Text("×", color = Color(0xFF8B949E), fontSize = 15.sp)
                    }
                }
                Box(Modifier.fillMaxWidth().height(1.dp).background(Color.White.copy(alpha = 0.07f)))
                Box(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(6.dp)) {
                    TerminalToolBody(
                        kind = panel.kind,
                        colors = colors,
                        notes = notes,
                        snippets = snippets,
                        workspace = workspace,
                        onWorkspace = onWorkspace,
                        onInsert = onInsert,
                        onOpenNote = onOpenNote,
                        onOpenDocker = onOpenDocker,
                        onMessage = onMessage,
                    )
                }
                Box(
                    modifier = Modifier
                        .align(Alignment.End)
                        .size(28.dp)
                        .pointerInput(panel.kind) {
                            detectDragGestures { _, drag ->
                                val minW = with(density) { TerminalWorkspace.FLOAT_MIN_WIDTH_DP.dp.toPx() }
                                val minH = with(density) { TerminalWorkspace.FLOAT_MIN_HEIGHT_DP.dp.toPx() }
                                w = (w + drag.x).coerceIn(minW, (parent.width - left).toFloat())
                                h = (h + drag.y).coerceIn(minH, (parent.height - top).toFloat())
                            }
                        },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(ZephyrIcons.Fit, null, tint = Color(0xFF5D6773), modifier = Modifier.size(12.dp))
                }
            }
        }
    }
}

private data class Quad(val x: Float, val y: Float, val w: Float, val h: Float)

private fun ZephyrPaletteMix(accent: Color, base: Color, fraction: Float): Color =
    Color(
        red = base.red + (accent.red - base.red) * fraction,
        green = base.green + (accent.green - base.green) * fraction,
        blue = base.blue + (accent.blue - base.blue) * fraction,
        alpha = base.alpha,
    )
