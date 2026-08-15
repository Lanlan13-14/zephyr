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
import androidx.compose.runtime.LaunchedEffect
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
    viewModel: TerminalViewModel? = null,
) {
    when (kind) {
        TerminalToolKind.FILES -> FilesToolBody(colors, viewModel, onMessage)
        TerminalToolKind.SNIPPET -> SnippetToolBody(colors, snippets, onInsert)
        TerminalToolKind.NOTES -> NotesToolBody(colors, notes, onOpenNote)
        TerminalToolKind.STATS -> StatsToolBody(colors, viewModel, onOpenDocker)
        TerminalToolKind.THEME -> ThemeToolBody(colors, workspace, onWorkspace, onMessage)
    }
}

@Composable
private fun FilesToolBody(
    colors: TerminalChromeColors,
    viewModel: TerminalViewModel?,
    onMessage: (String) -> Unit,
) {
    var path by remember { mutableStateOf(".") }
    var loading by remember { mutableStateOf(false) }
    var entries by remember { mutableStateOf<List<one.zephyr.mobile.protocol.ssh.SftpEntry>>(emptyList()) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(viewModel, path) {
        if (viewModel == null) {
            error = "当前没有已连接的 SSH 会话"
            return@LaunchedEffect
        }
        loading = true
        viewModel.listRemoteDirectory(path).fold(
            onSuccess = { entries = it.entries; error = null },
            onFailure = { error = it.message ?: "SFTP 目录加载失败" },
        )
        loading = false
    }
    Column {
        when {
            loading -> EmptyToolBody(colors, "正在读取 SFTP · $path")
            error != null -> EmptyToolBody(colors, error ?: "SFTP 失败")
            entries.isEmpty() -> EmptyToolBody(colors, "$path · 空目录")
            else -> entries.forEach { entry ->
                ToolRow(colors, entry.name, if (entry.isDirectory) "dir" else formatBytes(entry.size)) {
                    if (entry.isDirectory) path = entry.path else onMessage("${entry.path} · ${formatBytes(entry.size)}")
                }
            }
        }
    }
}

@Composable
private fun EmptyToolBody(colors: TerminalChromeColors, message: String) {
    Text(
        text = message,
        color = colors.dim,
        fontSize = 12.sp,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 28.dp),
    )
}

private fun formatBytes(bytes: Long): String = when {
    bytes >= 1024L * 1024L * 1024L -> "${bytes / (1024L * 1024L * 1024L)}G"
    bytes >= 1024L * 1024L -> "${bytes / (1024L * 1024L)}M"
    bytes >= 1024L -> "${bytes / 1024L}K"
    else -> "${bytes}B"
}

@Composable
private fun SnippetToolBody(
    colors: TerminalChromeColors,
    snippets: List<Snippet>,
    onInsert: (String) -> Unit,
) {
    if (snippets.isEmpty()) {
        EmptyToolBody(colors, "还没有代码片段")
        return
    }
    val rows = snippets.take(8)
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
    viewModel: TerminalViewModel?,
    onOpenDocker: () -> Unit,
) {
    val dockerLabel = stringResource(R.string.terminal_open_docker)
    var loading by remember { mutableStateOf(true) }
    var metrics by remember { mutableStateOf<RemoteMetrics?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(viewModel) {
        if (viewModel == null) {
            loading = false
            error = "当前没有已连接的 SSH 会话"
            return@LaunchedEffect
        }
        viewModel.remoteMetrics().fold(
            onSuccess = { metrics = it; error = null },
            onFailure = { error = it.message ?: "读取远端监控失败" },
        )
        loading = false
    }
    Column {
        when {
            loading -> EmptyToolBody(colors, "正在读取远端监控…")
            error != null -> EmptyToolBody(colors, error ?: "监控失败")
            metrics != null -> {
                val value = metrics ?: return@Column
                Meter(colors, "CPU", "${value.cpuPercent}%", value.cpuPercent / 100f)
                Meter(colors, "内存", "${value.memoryPercent}%", value.memoryPercent / 100f)
                Meter(colors, "磁盘 /", "${value.diskPercent}%", value.diskPercent / 100f, warn = value.diskPercent >= 80)
            }
        }
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
    }
}

@Composable
private fun ThemeToolBody(
    colors: TerminalChromeColors,
    workspace: TerminalWorkspaceState,
    onWorkspace: (TerminalWorkspaceState) -> Unit,
    onMessage: (String) -> Unit,
) {
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
        BgRow(colors, stringResource(R.string.terminal_custom_bg_color), workspace.customBackgroundColor, toggle = true) {
            val enabled = !workspace.customBackgroundColor
            onWorkspace(workspace.copy(customBackgroundColor = enabled))
            onMessage(if (enabled) "已启用自定义背景色" else "已关闭")
        }
        BgRow(colors, stringResource(R.string.terminal_custom_sel_color), workspace.customSelectionColor, toggle = true) {
            onWorkspace(workspace.copy(customSelectionColor = !workspace.customSelectionColor))
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
