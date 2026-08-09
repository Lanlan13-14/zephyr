@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package one.zephyr.mobile.feature.sessions

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDownward
import androidx.compose.material.icons.filled.Code
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Keyboard
import androidx.compose.material.icons.filled.Layers
import androidx.compose.material.icons.filled.LinkOff
import androidx.compose.material.icons.filled.Remove
import androidx.compose.material.icons.filled.Translate
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.PointerEvent
import androidx.compose.ui.input.pointer.PointerEventType
import androidx.compose.ui.input.pointer.PointerInputChange
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import kotlin.math.abs
import one.zephyr.mobile.data.session.SessionTransport
import one.zephyr.mobile.model.PageState
import one.zephyr.mobile.model.TerminalEncoding
import one.zephyr.mobile.ui.component.CleartextProtocolWarning
import one.zephyr.mobile.ui.state.PageStateScaffold
import one.zephyr.mobile.ui.theme.ZephyrPalette
import one.zephyr.mobile.ui.theme.ZephyrRadius
import one.zephyr.mobile.ui.theme.ZephyrSpacing
import one.zephyr.mobile.ui.theme.ZephyrTheme

/** Cell advance width and line height, measured once from the live monospace style. */
data class TerminalCellMetrics(val cellWidthPx: Float, val lineHeightPx: Float)

/** Long press threshold. Matches the platform default so it feels like every other Android view. */
private const val LONG_PRESS_MS = 500L

/** Movement below this is a tap, not a drag. GestureArbiter uses the same slop for ownership. */
private const val TAP_SLOP_PX = 12f

/** Below this a lift is a slow drag ending, not a fling. */
private const val FLING_MIN_PX_PER_SECOND = 300f

/** Widened so a proportional fallback font cannot make the measured advance width too small. */
private const val CELL_SAMPLE = "MMMMMMMMMM"

/**
 * S21 SSH/Telnet 终端.
 *
 * Stateless. The emulator grid arrives as [lines] rather than being read from a controller here,
 * because TERMINAL_EXPERIENCE.md 3 requires that UI state may recompose freely while the emulator and
 * its scrollback are never rebuilt: a screen that owned the emulator could not honour that. Every
 * event leaves as a [TerminalIntent], so a Compose test can assert routing with no transport at all.
 *
 * @param lines the rows under the viewport, already windowed by the caller.
 * @param cursor null when the engine is unavailable or the cursor is hidden.
 * @param keyboardVisible drives the IME rather than being read from it, so the shortcut key, a tap on
 *   the viewport and the system state cannot disagree.
 */
@Composable
fun TerminalScreen(
    state: PageState<TerminalContent>,
    lines: List<TerminalLine>,
    cursor: TerminalCursor?,
    remoteTitle: String?,
    keyboardVisible: Boolean,
    onIntent: (TerminalIntent) -> Unit,
    modifier: Modifier = Modifier,
) {
    PageStateScaffold(
        state = state,
        modifier = modifier,
        onRetry = { onIntent(TerminalIntent.Reconnect) },
    ) { content ->
        TerminalSurface(
            content = content,
            lines = lines,
            cursor = cursor,
            remoteTitle = remoteTitle,
            keyboardVisible = keyboardVisible,
            onIntent = onIntent,
        )
    }
}

@Composable
private fun TerminalSurface(
    content: TerminalContent,
    lines: List<TerminalLine>,
    cursor: TerminalCursor?,
    remoteTitle: String?,
    keyboardVisible: Boolean,
    onIntent: (TerminalIntent) -> Unit,
) {
    val palette = ZephyrTheme.palette
    val density = LocalDensity.current
    val surface = content.surface

    val cellStyle = ZephyrTheme.typography.mono.copy(fontSize = surface.fontSp.sp)
    val measurer = rememberTextMeasurer()
    // Measured rather than derived from the font size: the advance width of a monospace cell is a
    // font metric, and guessing it would make the last column fit on one device and not another.
    val metrics = remember(measurer, cellStyle) {
        val laid = measurer.measure(AnnotatedString(CELL_SAMPLE), cellStyle)
        TerminalCellMetrics(
            cellWidthPx = laid.size.width.toFloat() / CELL_SAMPLE.length,
            lineHeightPx = laid.size.height.toFloat(),
        )
    }

    val matrixHeight = TerminalChromeSpec.matrixHeight(ExtraKeysLayout.default.size)
    val matrixHeightPx = with(density) { matrixHeight.toPx() }
    val dockHeightPx = with(density) { TerminalChromeSpec.dockHeight.toPx() }
    // Read rather than applied as padding: TerminalGeometry subtracts it, and an imePadding here
    // would subtract it a second time and lose a screenful of rows.
    val imeHeightPx = WindowInsets.ime.getBottom(density).toFloat()
    val imeHeightDp = with(density) { imeHeightPx.toDp() }

    var imeView by remember { mutableStateOf<TerminalImeView?>(null) }
    var containerWidthPx by remember { mutableStateOf(0) }
    var containerHeightPx by remember { mutableStateOf(0) }

    // One report for every input to the frozen geometry rule, so the chrome the screen draws below is
    // the chrome TerminalGeometry decided could survive.
    LaunchedEffect(containerWidthPx, containerHeightPx, imeHeightPx, matrixHeightPx, dockHeightPx, metrics) {
        if (containerWidthPx <= 0 || containerHeightPx <= 0) return@LaunchedEffect
        onIntent(
            TerminalIntent.Geometry(
                totalWidthPx = containerWidthPx.toFloat(),
                totalHeightPx = containerHeightPx.toFloat(),
                imeHeightPx = imeHeightPx,
                shortcutMatrixHeightPx = matrixHeightPx,
                dockHeightPx = dockHeightPx,
                cellWidthPx = metrics.cellWidthPx,
                lineHeightPx = metrics.lineHeightPx,
            ),
        )
    }

    // Keyed on the flag rather than applied on every recomposition: re-showing on each frame would
    // fight a user who just dismissed the keyboard with the system gesture.
    LaunchedEffect(imeView, keyboardVisible) {
        imeView?.setKeyboardVisible(keyboardVisible)
    }

    Column(Modifier.fillMaxSize()) {
        // The cleartext warning is above everything and never scrolls away: TERMINAL_EXPERIENCE.md 10
        // requires it to stay visible for the whole session, not just at connect time.
        if (content.cleartextWarning != null) {
            CleartextProtocolWarning(protocol = content.connection.protocol)
        }

        TerminalTopBar(
            content = content,
            remoteTitle = remoteTitle,
            onIntent = onIntent,
        )

        content.autoLoginStatus?.let { status ->
            Text(
                text = status,
                style = ZephyrTheme.typography.caption,
                color = palette.onFloatingMuted,
                modifier = Modifier
                    .padding(horizontal = ZephyrSpacing.lg)
                    .semantics { liveRegion = LiveRegionMode.Polite },
            )
        }

        content.executionDisclosure?.let { disclosure ->
            Text(
                text = disclosure,
                style = ZephyrTheme.typography.caption,
                color = palette.brand.accent,
                modifier = Modifier.padding(horizontal = ZephyrSpacing.lg),
            )
        }

        Box(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f)
                .onSizeChanged { size ->
                    containerWidthPx = size.width
                    containerHeightPx = size.height
                },
        ) {
            // Padded by exactly what TerminalGeometry subtracted, so the rows it computed are the
            // rows that are actually visible above the IME.
            Column(Modifier.fillMaxSize().padding(bottom = imeHeightDp)) {
                Box(Modifier.fillMaxWidth().weight(1f)) {
                    TerminalViewport(
                        lines = lines,
                        cursor = cursor,
                        topRow = surface.topRow,
                        cellStyle = cellStyle,
                        metrics = metrics,
                        onIntent = onIntent,
                    )

                    if (!content.followingBottom) {
                        MissedOutputBadge(
                            rows = content.missedOutputRows,
                            onIntent = onIntent,
                            modifier = Modifier
                                .align(Alignment.BottomEnd)
                                .padding(ZephyrSpacing.lg),
                        )
                    }
                }

                if (!content.transport.isLive) {
                    ConnectPrompt(transport = content.transport, onIntent = onIntent)
                }

                if (surface.chrome.shortcutMatrix) {
                    ShortcutMatrix(
                        latches = surface.latches,
                        height = matrixHeight,
                        onIntent = onIntent,
                    )
                }

                if (surface.chrome.dock) {
                    TerminalDock(items = content.dock, onIntent = onIntent)
                }
            }

            // Zero-sized on purpose: it owns the InputConnection and nothing else. Placing it inside
            // the measured container keeps it in the same window as the viewport it types into.
            AndroidView(
                factory = { context -> TerminalImeView(context).also { created -> imeView = created } },
                modifier = Modifier.size(1.dp).align(Alignment.TopStart),
                update = { view -> view.onIntent = onIntent },
            )
        }
    }

    surface.pendingPaste?.let { pending ->
        PasteConfirmation(pending = pending, onIntent = onIntent)
    }

    content.hostKeyPrompt?.let { prompt ->
        HostKeyConfirmation(prompt = prompt, onIntent = onIntent)
    }
}


// ---- viewport ------------------------------------------------------------------------------------

/**
 * The cell grid.
 *
 * A Column of Text rows rather than a Canvas: at 40-50 rows the composition cost is irrelevant, and
 * text nodes give TalkBack real content to read and the platform its own text selection, both of
 * which a drawText canvas would have to reimplement badly.
 *
 * Every row is given the measured line height explicitly, so the grid the user sees is exactly the
 * grid TerminalGeometry counted when it decided the row count it sent to NAWS.
 */
@Composable
private fun TerminalViewport(
    lines: List<TerminalLine>,
    cursor: TerminalCursor?,
    topRow: Int,
    cellStyle: TextStyle,
    metrics: TerminalCellMetrics,
    onIntent: (TerminalIntent) -> Unit,
) {
    val palette = ZephyrTheme.palette
    val density = LocalDensity.current
    val rowHeight = with(density) { metrics.lineHeightPx.toDp() }

    // The snapshot is windowed by topRow, so the live cursor row sits topRow further down inside it.
    // Deriving it here rather than passing a screen coordinate keeps the caller free of the offset.
    val cursorIndex = if (cursor != null && cursor.visible) cursor.row + topRow else -1

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(palette.surfaces.background)
            .terminalGestures(metrics, onIntent)
            .terminalWheel(metrics, onIntent),
    ) {
        Column(Modifier.fillMaxSize()) {
            for ((index, line) in lines.withIndex()) {
                Text(
                    text = annotatedLine(
                        line = line,
                        cursorColumn = if (index == cursorIndex) cursor?.column ?: -1 else -1,
                        defaultForeground = palette.onBackground,
                        defaultBackground = palette.surfaces.background,
                    ),
                    style = cellStyle,
                    maxLines = 1,
                    softWrap = false,
                    modifier = Modifier.height(rowHeight),
                )
            }
        }

        if (lines.isEmpty()) {
            Text(
                text = stringResource(R.string.terminal_viewport_empty),
                style = ZephyrTheme.typography.caption,
                color = palette.onFloatingMuted,
                modifier = Modifier.align(Alignment.Center),
            )
        }
    }
}

/**
 * One row of cells as styled text.
 *
 * @param cursorColumn 0-based column of the block cursor on this row, or -1. Inverting the cell is
 *   how a text-node renderer draws a cursor without a second drawing pass.
 */
private fun annotatedLine(
    line: TerminalLine,
    cursorColumn: Int,
    defaultForeground: Color,
    defaultBackground: Color,
): AnnotatedString = buildAnnotatedString {
    for ((column, cell) in line.cells.withIndex()) {
        // A wide glyph occupies two cells but carries its text in the first: appending the
        // continuation would double every CJK character on the row.
        if (cell.wideContinuation) continue

        val underCursor = column == cursorColumn
        // XOR, not OR: a cell that is already inverse renders normally under the cursor, which is
        // what keeps the cursor visible inside a selected or highlighted region.
        val inverse = cell.inverse != underCursor

        val foreground = colorOr(cell.foreground, defaultForeground)
        val background = colorOr(cell.background, defaultBackground)

        withStyle(
            SpanStyle(
                color = if (inverse) background else foreground,
                background = if (inverse) foreground else Color.Transparent,
                fontWeight = if (cell.bold) FontWeight.Bold else null,
                fontStyle = if (cell.italic) FontStyle.Italic else null,
                textDecoration = if (cell.underline) TextDecoration.Underline else null,
            ),
        ) {
            append(cell.text)
        }
    }
}

/**
 * An emulator colour, or the theme colour when the engine reported none.
 *
 * A fully transparent value means "unset" rather than "invisible": rendering it literally would
 * produce a blank screen on any engine that leaves default cells at zero.
 */
private fun colorOr(argb: Int, fallback: Color): Color =
    if ((argb ushr 24) == 0) fallback else Color(argb)

// ---- gestures ------------------------------------------------------------------------------------

/** 1-based cell coordinates, the convention terminal mouse reports use. */
private data class TerminalCellPosition(val column: Int, val row: Int)

/**
 * The whole touch story in one gesture loop.
 *
 * Deliberately not detectTapGestures plus detectTransformGestures: two detectors on one node race
 * over the same down event, and the arbiter in [GestureArbiter] must see a single ordered stream to
 * decide an owner once per gesture. Written as one loop, the ordering is readable against the frozen
 * arbitration table.
 */
private fun Modifier.terminalGestures(
    metrics: TerminalCellMetrics,
    onIntent: (TerminalIntent) -> Unit,
): Modifier = pointerInput(metrics) {
    awaitEachGesture {
        val down = awaitFirstDown(requireUnconsumed = false)
        val velocity = VelocityTracker()
        velocity.addPosition(down.uptimeMillis, down.position)
        onIntent(TerminalIntent.PointerDown(pointerCount = 1))

        var centroid = down.position
        var span = 0f
        var pointerCount = 1
        var travel = 0f
        var longPressed = false
        var released = false
        var last = down.position

        /** Feeds one event into the arbiter, tracking the pointer count and pinch span. */
        fun consume(event: PointerEvent) {
            val pressed = event.changes.filter { it.pressed }
            if (pressed.isEmpty()) {
                released = true
                return
            }

            val nextCentroid = centroidOf(pressed)
            val nextSpan = spanOf(pressed, nextCentroid)
            val countChanged = pressed.size != pointerCount

            // A finger arriving or leaving moves the centroid and the span discontinuously. Rebasing
            // instead of accumulating stops a second finger from reading as a full-screen pinch.
            val dx = if (countChanged) 0f else nextCentroid.x - centroid.x
            val dyRaw = if (countChanged) 0f else nextCentroid.y - centroid.y
            val spanDelta = if (countChanged) 0f else nextSpan - span

            centroid = nextCentroid
            span = nextSpan
            pointerCount = pressed.size
            last = nextCentroid
            travel += abs(dx) + abs(dyRaw)
            pressed.forEach { velocity.addPosition(it.uptimeMillis, it.position) }

            if (dx != 0f || dyRaw != 0f || spanDelta != 0f) {
                val cell = cellAt(nextCentroid, metrics)
                onIntent(
                    TerminalIntent.PointerMove(
                        pointerCount = pressed.size,
                        dxPx = dx,
                        // Negated into the platform convention ScrollbackViewport.drag documents:
                        // positive means the finger moved up, which reveals newer rows.
                        dyPx = -dyRaw,
                        spanDeltaPx = spanDelta,
                        column = cell.column,
                        row = cell.row,
                    ),
                )
            }
        }

        // A long press is a timeout with no qualifying movement, so it is detected by racing the
        // pointer stream against the platform threshold rather than by a second detector.
        val settled = withTimeoutOrNull(LONG_PRESS_MS) {
            var interrupted = false
            while (!interrupted) {
                consume(awaitPointerEvent())
                if (released || travel > TAP_SLOP_PX || pointerCount > 1) interrupted = true
            }
            true
        }
        if (settled == null) {
            longPressed = true
            onIntent(TerminalIntent.LongPress)
        }

        while (!released) {
            consume(awaitPointerEvent())
        }

        if (!longPressed && travel <= TAP_SLOP_PX) {
            val cell = cellAt(last, metrics)
            onIntent(TerminalIntent.Tap(column = cell.column, row = cell.row))
        } else {
            val vy = velocity.calculateVelocity().y
            // Same negation as the drag: Compose reports positive downward, the viewport expects
            // positive upward.
            if (abs(vy) >= FLING_MIN_PX_PER_SECOND) onIntent(TerminalIntent.Fling(-vy))
        }

        onIntent(TerminalIntent.GestureEnd)
    }
}

/**
 * A physical wheel or trackpad.
 *
 * Separate from the touch loop because a scroll event has no down and no up: folding it into
 * awaitEachGesture would make it wait for a press that never arrives.
 */
private fun Modifier.terminalWheel(
    metrics: TerminalCellMetrics,
    onIntent: (TerminalIntent) -> Unit,
): Modifier = pointerInput(metrics) {
    awaitPointerEventScope {
        while (true) {
            val event = awaitPointerEvent()
            if (event.type != PointerEventType.Scroll) continue
            val change = event.changes.firstOrNull() ?: continue
            // Positive scrollDelta.y is a scroll toward newer content, which is the same direction a
            // positive notch count means to TerminalMouseEncoder.wheel.
            val notches = change.scrollDelta.y.toInt()
            if (notches == 0) continue
            val cell = cellAt(change.position, metrics)
            onIntent(TerminalIntent.Wheel(notches = notches, column = cell.column, row = cell.row))
        }
    }
}

private fun cellAt(offset: Offset, metrics: TerminalCellMetrics): TerminalCellPosition {
    if (metrics.cellWidthPx <= 0f || metrics.lineHeightPx <= 0f) return TerminalCellPosition(1, 1)
    return TerminalCellPosition(
        column = (offset.x / metrics.cellWidthPx).toInt() + 1,
        row = (offset.y / metrics.lineHeightPx).toInt() + 1,
    )
}

private fun centroidOf(changes: List<PointerInputChange>): Offset {
    if (changes.isEmpty()) return Offset.Zero
    var x = 0f
    var y = 0f
    for (change in changes) {
        x += change.position.x
        y += change.position.y
    }
    return Offset(x / changes.size, y / changes.size)
}

/**
 * Pinch magnitude as the mean distance from the centroid.
 *
 * Monotone in the finger separation for any pointer count, so a three-finger pinch does not produce
 * a discontinuity the way a first-to-second-pointer distance would.
 */
private fun spanOf(changes: List<PointerInputChange>, centroid: Offset): Float {
    if (changes.size < 2) return 0f
    var total = 0f
    for (change in changes) {
        val dx = change.position.x - centroid.x
        val dy = change.position.y - centroid.y
        total += kotlin.math.sqrt(dx * dx + dy * dy)
    }
    return total / changes.size
}


// ---- chrome --------------------------------------------------------------------------------------

/**
 * The frozen two-row shortcut matrix (TERMINAL_EXPERIENCE.md 8.1).
 *
 * Given the height the caller already reported to TerminalGeometry, so the matrix cannot draw taller
 * than the space the row count was computed against.
 */
@Composable
private fun ShortcutMatrix(
    latches: ModifierLatches,
    height: Dp,
    onIntent: (TerminalIntent) -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .height(height)
            .background(ZephyrTheme.palette.surfaces.elevated)
            .padding(TerminalChromeSpec.matrixPadding),
        verticalArrangement = Arrangement.spacedBy(TerminalChromeSpec.keySpacing),
    ) {
        for (row in ExtraKeysLayout.default) {
            Row(
                modifier = Modifier.fillMaxWidth().weight(1f),
                horizontalArrangement = Arrangement.spacedBy(TerminalChromeSpec.keySpacing),
            ) {
                for (key in row) {
                    ShortcutKey(key = key, latches = latches, onIntent = onIntent)
                }
            }
        }
    }
}

/**
 * One shortcut key.
 *
 * The latch is shown as a caption and a border weight, never as colour alone: SCREEN_CATALOG.md 26
 * forbids colour-only state, and a locked Ctrl that only looks different is invisible to a
 * colour-blind user and to TalkBack alike.
 */
@Composable
private fun RowScope.ShortcutKey(
    key: ExtraKey,
    latches: ModifierLatches,
    onIntent: (TerminalIntent) -> Unit,
) {
    val palette = ZephyrTheme.palette
    val latch = if (key is ExtraKey.Modifier) latches.stateOf(key.modifier) else LatchState.OFF

    val stateLabel = when (latch) {
        LatchState.OFF -> null
        LatchState.ONE_SHOT -> stringResource(R.string.terminal_latch_one_shot)
        LatchState.LOCKED -> stringResource(R.string.terminal_latch_locked)
    }
    val shape = RoundedCornerShape(ZephyrRadius.sm)
    val borderWidth = when (latch) {
        LatchState.LOCKED -> 2.dp
        LatchState.ONE_SHOT -> 1.dp
        LatchState.OFF -> 0.dp
    }

    Box(
        modifier = Modifier
            .weight(1f)
            .fillMaxHeight()
            .background(if (latch.isActive) palette.brand.mid else palette.surfaces.floating, shape)
            .border(borderWidth, palette.brand.accent, shape)
            .clickable(role = Role.Button) { onIntent(TerminalIntent.Shortcut(key)) }
            .semantics { stateLabel?.let { stateDescription = it } },
        contentAlignment = Alignment.Center,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
                text = key.label,
                style = ZephyrTheme.typography.monoCaption,
                color = palette.onFloating,
                maxLines = 1,
            )
            stateLabel?.let { label ->
                Text(text = label, style = ZephyrTheme.typography.caption, color = palette.onFloatingMuted)
            }
        }
    }
}

/** The context dock from SCREEN_CATALOG.md 8. Absent entries are absent, not disabled. */
@Composable
private fun TerminalDock(items: List<TerminalDockItem>, onIntent: (TerminalIntent) -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(TerminalChromeSpec.dockHeight)
            .background(ZephyrTheme.palette.surfaces.floating),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceEvenly,
    ) {
        for (item in items) {
            DockButton(item = item, onIntent = onIntent)
        }
    }
}

@Composable
private fun DockButton(item: TerminalDockItem, onIntent: (TerminalIntent) -> Unit) {
    val label = dockLabel(item)
    val palette = ZephyrTheme.palette
    val tint = if (item == TerminalDockItem.DISCONNECT) palette.status.error else palette.onFloating
    Column(
        modifier = Modifier
            .size(width = 56.dp, height = TerminalChromeSpec.dockHeight)
            .clickable(role = Role.Button) { onIntent(TerminalIntent.Dock(item)) }
            .semantics { contentDescription = label },
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Icon(imageVector = dockIcon(item), contentDescription = null, tint = tint, modifier = Modifier.size(20.dp))
        Text(text = label, style = ZephyrTheme.typography.caption, color = tint, maxLines = 1)
    }
}

/**
 * Missed output while the user reads back.
 *
 * The count is the point: TERMINAL_EXPERIENCE.md 2.3 forbids output pulling the viewport, so the user
 * needs to know how much arrived and get one tap back to the live bottom.
 */
@Composable
private fun MissedOutputBadge(rows: Int, onIntent: (TerminalIntent) -> Unit, modifier: Modifier = Modifier) {
    val palette = ZephyrTheme.palette
    val label = if (rows > 0) {
        stringResource(R.string.terminal_missed_output, rows)
    } else {
        stringResource(R.string.terminal_jump_to_bottom)
    }
    Row(
        modifier = modifier
            .background(palette.brand.dark, RoundedCornerShape(ZephyrRadius.pill))
            .clickable(role = Role.Button) { onIntent(TerminalIntent.JumpToBottom) }
            .padding(horizontal = ZephyrSpacing.md, vertical = ZephyrSpacing.sm)
            .semantics { contentDescription = label },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = Icons.Filled.ArrowDownward,
            contentDescription = null,
            tint = palette.onFloating,
            modifier = Modifier.size(16.dp),
        )
        Spacer(Modifier.width(ZephyrSpacing.xs))
        Text(text = label, style = ZephyrTheme.typography.caption, color = palette.onFloating)
    }
}

/**
 * Explicit reconnect for a tab that is not live.
 *
 * A restored workspace tab arrives disconnected by design (SCREEN_CATALOG.md 7), so this bar is the
 * only path back to a transport. Rendered below the viewport rather than over it, because the last
 * screen of a dropped session is still the information the user wants to read.
 */
@Composable
private fun ConnectPrompt(transport: SessionTransport, onIntent: (TerminalIntent) -> Unit) {
    val palette = ZephyrTheme.palette
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(palette.surfaces.elevated)
            .padding(horizontal = ZephyrSpacing.lg, vertical = ZephyrSpacing.sm)
            .semantics { liveRegion = LiveRegionMode.Polite },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = if (transport == SessionTransport.CLOSED) {
                stringResource(R.string.terminal_closed_hint)
            } else {
                stringResource(R.string.terminal_disconnected_hint)
            },
            style = ZephyrTheme.typography.caption,
            color = palette.onFloatingMuted,
            modifier = Modifier.weight(1f),
        )
        TextButton(onClick = { onIntent(TerminalIntent.Reconnect) }) {
            Text(stringResource(R.string.terminal_reconnect))
        }
    }
}

@Composable
private fun TerminalTopBar(
    content: TerminalContent,
    remoteTitle: String?,
    onIntent: (TerminalIntent) -> Unit,
) {
    var encodingMenu by remember { mutableStateOf(false) }
    val palette = ZephyrTheme.palette

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = ZephyrSpacing.lg, vertical = ZephyrSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            // The connection name owns the primary line. A remote shell can set any window title it
            // likes, so letting OSC 0 own this would let the far end impersonate another host.
            Text(
                text = content.connection.name,
                style = MaterialTheme.typography.titleMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = transportLabel(content.transport),
                    style = ZephyrTheme.typography.caption,
                    color = transportColor(content.transport, palette),
                    modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                )
                remoteTitle?.takeIf { it.isNotBlank() }?.let { title ->
                    Spacer(Modifier.width(ZephyrSpacing.sm))
                    Text(
                        text = title,
                        style = ZephyrTheme.typography.caption,
                        color = palette.onFloatingMuted,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }

        // Only Telnet negotiates a code page, so the picker is absent rather than disabled for SSH:
        // a greyed-out control would still suggest the setting means something there.
        if (content.encodingSelectable) {
            val encodingLabel = stringResource(R.string.terminal_encoding_action, content.encoding.wireName)
            Box {
                IconButton(
                    onClick = { encodingMenu = true },
                    modifier = Modifier.semantics { contentDescription = encodingLabel },
                ) {
                    Icon(Icons.Filled.Translate, contentDescription = null)
                }
                DropdownMenu(expanded = encodingMenu, onDismissRequest = { encodingMenu = false }) {
                    for (encoding in TerminalEncoding.entries) {
                        DropdownMenuItem(
                            text = { Text(encoding.wireName) },
                            onClick = {
                                encodingMenu = false
                                onIntent(TerminalIntent.SetEncoding(encoding))
                            },
                        )
                    }
                }
            }
        }

        val minimiseLabel = stringResource(R.string.terminal_minimise)
        IconButton(
            onClick = { onIntent(TerminalIntent.Minimise) },
            modifier = Modifier.semantics { contentDescription = minimiseLabel },
        ) {
            Icon(Icons.Filled.Remove, contentDescription = null)
        }
    }
}

// ---- dialogs -------------------------------------------------------------------------------------

/**
 * Paste preview.
 *
 * TERMINAL_EXPERIENCE.md 4.3 requires the preview and the without-newline option, because a blind
 * paste into a shell executes whatever the clipboard happened to hold.
 */
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
                Spacer(Modifier.height(ZephyrSpacing.sm))
                Text(
                    text = pending.text.take(PASTE_PREVIEW_CHARS),
                    style = ZephyrTheme.typography.monoCaption,
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
                // Offered only when there is a trailing newline to drop, so the button never claims
                // to change something about this particular paste that it would not change.
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

/**
 * Host-key decision.
 *
 * A changed key is not presented as an equal yes/no: the safe action occupies the confirm slot and a
 * dismissal rejects, so no accidental tap outside the dialog can trust a key that changed.
 */
@Composable
private fun HostKeyConfirmation(prompt: HostKeyPrompt, onIntent: (TerminalIntent) -> Unit) {
    val palette = ZephyrTheme.palette
    AlertDialog(
        onDismissRequest = { onIntent(TerminalIntent.RejectHostKey) },
        title = {
            Text(
                if (prompt.changed) {
                    stringResource(R.string.terminal_host_key_changed_title)
                } else {
                    stringResource(R.string.terminal_host_key_new_title)
                },
            )
        },
        text = {
            Column {
                Text(
                    text = if (prompt.changed) {
                        stringResource(R.string.terminal_host_key_changed_body)
                    } else {
                        stringResource(R.string.terminal_host_key_new_body)
                    },
                    color = if (prompt.changed) palette.status.error else palette.onBackground,
                )
                Spacer(Modifier.height(ZephyrSpacing.sm))
                Text(text = prompt.fingerprint, style = ZephyrTheme.typography.mono)
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

// ---- labels --------------------------------------------------------------------------------------

@Composable
private fun transportLabel(transport: SessionTransport): String = when (transport) {
    SessionTransport.CONNECTING -> stringResource(R.string.terminal_transport_connecting)
    SessionTransport.CONNECTED -> stringResource(R.string.terminal_transport_connected)
    SessionTransport.DISCONNECTED -> stringResource(R.string.terminal_transport_disconnected)
    SessionTransport.CLOSED -> stringResource(R.string.terminal_transport_closed)
}

private fun transportColor(transport: SessionTransport, palette: ZephyrPalette): Color = when (transport) {
    SessionTransport.CONNECTING -> palette.status.pendingSync
    SessionTransport.CONNECTED -> palette.status.success
    SessionTransport.DISCONNECTED -> palette.status.offline
    SessionTransport.CLOSED -> palette.onFloatingMuted
}

@Composable
private fun dockLabel(item: TerminalDockItem): String = when (item) {
    TerminalDockItem.KEYBOARD -> stringResource(R.string.terminal_dock_keyboard)
    TerminalDockItem.FILES -> stringResource(R.string.terminal_dock_files)
    TerminalDockItem.SNIPPETS -> stringResource(R.string.terminal_dock_snippets)
    TerminalDockItem.NOTES -> stringResource(R.string.terminal_dock_notes)
    TerminalDockItem.SESSIONS -> stringResource(R.string.terminal_dock_sessions)
    TerminalDockItem.DISCONNECT -> stringResource(R.string.terminal_dock_disconnect)
}

private fun dockIcon(item: TerminalDockItem): ImageVector = when (item) {
    TerminalDockItem.KEYBOARD -> Icons.Filled.Keyboard
    TerminalDockItem.FILES -> Icons.Filled.Folder
    TerminalDockItem.SNIPPETS -> Icons.Filled.Code
    TerminalDockItem.NOTES -> Icons.Filled.Description
    TerminalDockItem.SESSIONS -> Icons.Filled.Layers
    TerminalDockItem.DISCONNECT -> Icons.Filled.LinkOff
}
