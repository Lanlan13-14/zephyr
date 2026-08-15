package one.zephyr.mobile.feature.sessions

import androidx.activity.compose.LocalOnBackPressedDispatcherOwner
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clip
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import one.zephyr.mobile.data.session.SessionRow
import one.zephyr.mobile.data.session.SessionTransport
import one.zephyr.mobile.model.Connection
import one.zephyr.mobile.model.Protocol
import one.zephyr.mobile.ui.component.Icon
import one.zephyr.mobile.ui.component.Text
import one.zephyr.mobile.ui.icon.ZephyrIcons
import one.zephyr.mobile.ui.theme.ZephyrMotionTokens
import one.zephyr.mobile.ui.theme.ZephyrPalette
import one.zephyr.mobile.ui.theme.ZephyrTheme

/** Demo `#page-terminal` chrome tokens. Accent-tinted, ANSI output stays on Termux. */
data class TerminalChromeColors(
    val chrome: Color,
    val chrome2: Color,
    val line: Color,
    val text: Color,
    val dim: Color,
    val termBg: Color,
    val accent: Color,
    val ok: Color,
    val pending: Color,
    val err: Color,
    val offline: Color,
)

fun terminalChromeColors(palette: ZephyrPalette): TerminalChromeColors {
    val dark = palette.dark
    val accent = palette.brand.accent
    return TerminalChromeColors(
        chrome = ZephyrPalette.mix(if (dark) Color(0xFF12161C) else Color(0xFFE8EDF2), accent, 0.08f),
        chrome2 = ZephyrPalette.mix(if (dark) Color(0xFF1E242E) else Color(0xFFDCE3EA), accent, if (dark) 0.13f else 0.11f),
        line = accent.copy(alpha = if (dark) 0.14f else 0.18f),
        text = if (dark) Color(0xFFC9D1D9) else Color(0xFF1C232B),
        dim = if (dark) Color(0xFF7D8794) else Color(0xFF66707C),
        termBg = palette.surfaces.termBackground,
        accent = accent,
        ok = palette.status.success,
        pending = palette.status.pendingSync,
        err = palette.status.error,
        offline = palette.status.offline,
    )
}

fun sessionDotColor(transport: SessionTransport, colors: TerminalChromeColors): Color = when (transport) {
    SessionTransport.CONNECTED -> colors.ok
    SessionTransport.CONNECTING -> colors.pending
    SessionTransport.DISCONNECTED -> colors.err
    SessionTransport.CLOSED -> colors.offline
}

@Composable
internal fun Modifier.termPress(scale: Float = ZephyrMotionTokens.KEY_PRESS_SCALE): Modifier {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val animated by animateFloatAsState(
        targetValue = if (pressed) scale else 1f,
        animationSpec = tween(ZephyrMotionTokens.PRESS_MS, easing = ZephyrMotionTokens.easeOut),
        label = "termPress",
    )
    return this
        .graphicsLayer { scaleX = animated; scaleY = animated }
        .clickable(interactionSource = interaction, indication = null, role = Role.Button) {}
}

@Composable
internal fun TermPressable(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    scale: Float = ZephyrMotionTokens.KEY_PRESS_SCALE,
    enabled: Boolean = true,
    content: @Composable () -> Unit,
) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val animated by animateFloatAsState(
        targetValue = if (pressed) scale else 1f,
        animationSpec = tween(ZephyrMotionTokens.PRESS_MS, easing = ZephyrMotionTokens.easeOut),
        label = "termPressable",
    )
    Box(
        modifier
            .graphicsLayer { scaleX = animated; scaleY = animated }
            .clickable(
                interactionSource = interaction,
                indication = null,
                enabled = enabled,
                role = Role.Button,
                onClick = onClick,
            ),
        contentAlignment = Alignment.Center,
    ) { content() }
}

@Composable
internal fun DemoTermHead(
    name: String,
    subtitle: String,
    latency: String,
    transport: SessionTransport,
    colors: TerminalChromeColors,
    splitOn: Boolean,
    onSplit: () -> Unit,
) {
    val onBack = LocalOnBackPressedDispatcherOwner.current?.onBackPressedDispatcher
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(colors.chrome)
            .statusBarsPadding()
            .padding(
                start = TerminalWorkspace.HEAD_PAD_H_DP.dp,
                end = TerminalWorkspace.HEAD_PAD_H_DP.dp,
                top = TerminalWorkspace.HEAD_PAD_TOP_EXTRA_DP.dp,
                bottom = TerminalWorkspace.HEAD_PAD_BOTTOM_DP.dp,
            ),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TermPressable(
            onClick = { onBack?.onBackPressed() },
            modifier = Modifier
                .size(TerminalWorkspace.BACK_SIZE_DP.dp)
                .clip(CircleShape),
            scale = ZephyrMotionTokens.BACK_PRESS_SCALE,
        ) {
            Icon(ZephyrIcons.Back, contentDescription = "返回", tint = colors.dim, modifier = Modifier.size(16.dp))
        }
        Column(Modifier.weight(1f).padding(start = 8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier
                        .size(6.dp)
                        .clip(CircleShape)
                        .background(sessionDotColor(transport, colors)),
                )
                Spacer(Modifier.width(7.dp))
                Text(
                    text = name,
                    color = if (ZephyrTheme.palette.dark) Color(0xFFE6EBF0) else Color(0xFF1C232B),
                    fontSize = 14.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Text(
                text = subtitle,
                color = colors.dim,
                fontFamily = FontFamily.Monospace,
                fontSize = 10.5.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = 2.dp),
            )
        }
        Text(
            text = latency,
            color = colors.dim,
            fontFamily = FontFamily.Monospace,
            fontSize = 11.sp,
            modifier = Modifier
                .padding(end = 6.dp)
                .semantics { liveRegion = LiveRegionMode.Polite },
        )
        val splitLabel = stringResource(R.string.terminal_split)
        TermPressable(
            onClick = onSplit,
            modifier = Modifier
                .size(TerminalWorkspace.SPLIT_BTN_SIZE_DP.dp)
                .clip(RoundedCornerShape(8.dp))
                .background(if (splitOn) colors.accent.copy(alpha = 0.16f) else Color.Transparent)
                .semantics { contentDescription = splitLabel },
            scale = 0.9f,
        ) {
            Icon(
                imageVector = ZephyrIcons.Fit,
                contentDescription = null,
                tint = if (splitOn) colors.accent else colors.dim,
                modifier = Modifier.size(15.dp),
            )
        }
    }
}

@Composable
internal fun DemoSessRail(
    sessions: List<SessionRow>,
    focusedId: String,
    otherId: String?,
    colors: TerminalChromeColors,
    onSelect: (String) -> Unit,
    onClose: (String) -> Unit,
    onAdd: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(colors.chrome)
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        sessions.forEach { row ->
            val on = row.sessionId == focusedId
            val sideB = otherId != null && row.sessionId == otherId && !on
            TermPressable(
                onClick = { onSelect(row.sessionId) },
                modifier = Modifier
                    .height(TerminalWorkspace.RAIL_CHIP_HEIGHT_DP.dp)
                    .padding(end = 2.dp),
                scale = 1f,
            ) {
                Row(
                    modifier = Modifier
                        .height(TerminalWorkspace.RAIL_CHIP_HEIGHT_DP.dp)
                        .padding(horizontal = 12.dp)
                        .then(
                            if (on) Modifier.border(width = 0.dp, color = Color.Transparent)
                            else Modifier,
                        ),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Box(
                                Modifier
                                    .size(6.dp)
                                    .clip(CircleShape)
                                    .background(sessionDotColor(row.transport, colors)),
                            )
                            Spacer(Modifier.width(7.dp))
                            Text(
                                text = row.name,
                                color = if (on) colors.text else colors.dim,
                                fontFamily = FontFamily.Monospace,
                                fontSize = 12.sp,
                                fontWeight = if (on) FontWeight.SemiBold else FontWeight.Medium,
                                maxLines = 1,
                            )
                            TermPressable(
                                onClick = { onClose(row.sessionId) },
                                modifier = Modifier.padding(start = 4.dp),
                                scale = 0.9f,
                            ) {
                                Text("×", color = colors.dim.copy(alpha = 0.55f), fontSize = 13.sp)
                            }
                        }
                        Box(
                            Modifier
                                .padding(top = 2.dp)
                                .fillMaxWidth()
                                .height(2.dp)
                                .background(
                                    when {
                                        on -> colors.accent
                                        sideB -> colors.accent.copy(alpha = 0.35f)
                                        else -> Color.Transparent
                                    },
                                ),
                        )
                    }
                }
            }
        }
        TermPressable(
            onClick = onAdd,
            modifier = Modifier.size(34.dp),
            scale = 0.9f,
        ) {
            Icon(ZephyrIcons.Plus, contentDescription = stringResource(R.string.terminal_add_session), tint = colors.dim, modifier = Modifier.size(14.dp))
        }
    }
}

@Composable
internal fun DemoKeyRow(
    latches: ModifierLatches,
    colors: TerminalChromeColors,
    onIntent: (TerminalIntent) -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(colors.chrome)
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = 10.dp, vertical = TerminalWorkspace.KEY_PADDING_V_DP.dp),
        horizontalArrangement = Arrangement.spacedBy(TerminalWorkspace.KEY_GAP_DP.dp),
    ) {
        ExtraKeysLayout.demoRow.forEach { key ->
            val latch = if (key is ExtraKey.Modifier) latches.stateOf(key.modifier) else LatchState.OFF
            val latched = latch.isActive
            TermPressable(
                onClick = { onIntent(TerminalIntent.Shortcut(key)) },
                modifier = Modifier
                    .height(TerminalWorkspace.KEY_HEIGHT_DP.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .background(if (latched) Color(red = (colors.accent.red * 0.4f + colors.chrome2.red * 0.6f), green = (colors.accent.green * 0.4f + colors.chrome2.green * 0.6f), blue = (colors.accent.blue * 0.4f + colors.chrome2.blue * 0.6f), alpha = 1f) else colors.chrome2)
                    .padding(horizontal = 12.dp)
                    .semantics {
                        if (latch == LatchState.ONE_SHOT) stateDescription = "单次生效"
                        if (latch == LatchState.LOCKED) stateDescription = "已锁定"
                    },
            ) {
                Text(
                    text = key.label,
                    color = if (latched) Color.White else colors.text,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 12.5.sp,
                )
            }
        }
    }
}

@Composable
internal fun DemoContextDock(
    items: List<TerminalDockItem>,
    colors: TerminalChromeColors,
    imeOpen: Boolean,
    onIntent: (TerminalIntent) -> Unit,
) {
    val hidden by animateFloatAsState(
        targetValue = if (imeOpen) 1f else 0f,
        animationSpec = tween(180, easing = ZephyrMotionTokens.easeOut),
        label = "dockHide",
    )
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .graphicsLayer {
                translationY = 90f * hidden
                alpha = 1f - hidden
            }
            .background(colors.chrome)
            .padding(start = 8.dp, end = 8.dp, top = TerminalWorkspace.DOCK_PAD_TOP_DP.dp)
            .navigationBarsPadding()
            .padding(bottom = TerminalWorkspace.DOCK_PAD_BOTTOM_DP.dp)
            .horizontalScroll(rememberScrollState()),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        items.forEach { item ->
            val danger = item == TerminalDockItem.DISCONNECT
            val tint = if (danger) Color(0xFFFF7B72) else colors.dim
            TermPressable(
                onClick = { onIntent(TerminalIntent.Dock(item)) },
                modifier = Modifier
                    .weight(1f, fill = false)
                    .width(56.dp)
                    .padding(vertical = 4.dp),
                scale = ZephyrMotionTokens.PRESS_SCALE_HARD,
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(demoDockIcon(item), contentDescription = null, tint = tint, modifier = Modifier.size(20.dp))
                    Spacer(Modifier.height(3.dp))
                    Text(demoDockLabel(item), color = tint, fontSize = 10.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
                }
            }
        }
    }
}

@Composable
internal fun demoDockLabel(item: TerminalDockItem): String = when (item) {
    TerminalDockItem.KEYBOARD -> stringResource(R.string.terminal_dock_keyboard)
    TerminalDockItem.COPY -> stringResource(R.string.terminal_dock_copy)
    TerminalDockItem.PASTE -> stringResource(R.string.terminal_dock_paste)
    TerminalDockItem.FILES -> stringResource(R.string.terminal_dock_files)
    TerminalDockItem.SNIPPETS -> stringResource(R.string.terminal_dock_snippets)
    TerminalDockItem.NOTES -> stringResource(R.string.terminal_dock_notes)
    TerminalDockItem.STATS -> stringResource(R.string.terminal_dock_stats)
    TerminalDockItem.THEME -> stringResource(R.string.terminal_dock_theme)
    TerminalDockItem.DISCONNECT -> stringResource(R.string.terminal_dock_disconnect)
}

internal fun demoDockIcon(item: TerminalDockItem): ImageVector = when (item) {
    TerminalDockItem.KEYBOARD -> ZephyrIcons.Keyboard
    TerminalDockItem.COPY -> ZephyrIcons.Copy
    TerminalDockItem.PASTE -> ZephyrIcons.Paste
    TerminalDockItem.FILES -> ZephyrIcons.File
    TerminalDockItem.SNIPPETS -> ZephyrIcons.Bolt
    TerminalDockItem.NOTES -> ZephyrIcons.Notes
    TerminalDockItem.STATS -> ZephyrIcons.Stats
    TerminalDockItem.THEME -> ZephyrIcons.Theme
    TerminalDockItem.DISCONNECT -> ZephyrIcons.Disconnect
}

internal fun toolIcon(kind: TerminalToolKind): ImageVector = when (kind) {
    TerminalToolKind.FILES -> ZephyrIcons.File
    TerminalToolKind.SNIPPET -> ZephyrIcons.Bolt
    TerminalToolKind.NOTES -> ZephyrIcons.Notes
    TerminalToolKind.STATS -> ZephyrIcons.Stats
    TerminalToolKind.THEME -> ZephyrIcons.Theme
}

@Composable
internal fun toolTitle(kind: TerminalToolKind, hostName: String): String = when (kind) {
    TerminalToolKind.FILES -> "SFTP · $hostName"
    TerminalToolKind.SNIPPET -> "代码片段"
    TerminalToolKind.NOTES -> "笔记 · 关联 $hostName"
    TerminalToolKind.STATS -> "监控 · $hostName"
    TerminalToolKind.THEME -> stringResource(R.string.terminal_theme_title)
}

@Composable
internal fun DemoPadRail(
    connections: List<Connection>,
    liveNames: Set<String>,
    colors: TerminalChromeColors,
    onOpen: (Connection) -> Unit,
) {
    Column(
        modifier = Modifier
            .width(TerminalWorkspace.PAD_RAIL_WIDTH_DP.dp)
            .fillMaxHeight()
            .background(colors.chrome)
            .border(width = 0.dp, color = Color.Transparent),
    ) {
        Text(
            text = stringResource(R.string.terminal_pad_rail),
            color = colors.dim,
            fontSize = 11.sp,
            fontWeight = FontWeight.Bold,
            letterSpacing = 0.8.sp,
            modifier = Modifier
                .statusBarsPadding()
                .padding(start = 14.dp, end = 14.dp, top = 14.dp, bottom = 8.dp),
        )
        Column(Modifier.padding(horizontal = 8.dp)) {
            connections.forEach { connection ->
                TermPressable(
                    onClick = { onOpen(connection) },
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(bottom = 2.dp)
                        .clip(RoundedCornerShape(9.dp))
                        .padding(horizontal = 9.dp, vertical = 8.dp),
                    scale = 0.99f,
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        ProtocolGlyph(connection.protocol)
                        Spacer(Modifier.width(9.dp))
                        Column(Modifier.weight(1f)) {
                            Text(connection.name, color = colors.text, fontSize = 12.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(
                                text = connection.displayAddress,
                                color = colors.dim,
                                fontFamily = FontFamily.Monospace,
                                fontSize = 10.sp,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                        if (connection.name in liveNames) {
                            Box(Modifier.size(7.dp).clip(CircleShape).background(colors.ok))
                        }
                    }
                }
            }
        }
    }
}

@Composable
internal fun ProtocolGlyph(protocol: Protocol) {
    val palette = ZephyrTheme.palette
    val color = palette.protocolOf(protocol.name.lowercase())
    Box(
        modifier = Modifier
            .size(26.dp)
            .clip(RoundedCornerShape(7.dp))
            .background(color.copy(alpha = 0.16f)),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = if (protocol == Protocol.TELNET) "TEL" else protocol.name.take(3),
            color = color,
            fontSize = 8.sp,
            fontWeight = FontWeight.ExtraBold,
            fontFamily = FontFamily.Monospace,
        )
    }
}

internal fun sessionSubtitle(connection: Connection, columns: Int, rows: Int, imeOpen: Boolean): String {
    val user = connection.username
    val host = buildString {
        if (user.isNotBlank()) append(user).append('@')
        append(connection.host).append(':').append(connection.port)
    }
    val size = if (imeOpen && columns > 0 && rows > 0) {
        "$columns×$rows (resized)"
    } else if (columns > 0 && rows > 0) {
        "$columns×$rows"
    } else {
        "80×24"
    }
    return "$host · $size"
}

internal fun latencyLabel(row: SessionRow?): String {
    val ms = row?.latencyMs
    return if (row?.transport?.isLive == true && ms != null) "$ms ms" else "— ms"
}
