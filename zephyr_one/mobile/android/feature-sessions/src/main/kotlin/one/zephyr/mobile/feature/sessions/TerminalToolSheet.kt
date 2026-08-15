package one.zephyr.mobile.feature.sessions

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.max
import one.zephyr.mobile.model.Note
import one.zephyr.mobile.model.Snippet
import one.zephyr.mobile.ui.component.Icon
import one.zephyr.mobile.ui.component.Text
import one.zephyr.mobile.ui.theme.ZephyrMotionTokens

/** Latest demo phone terminal tool drawer: in-flow, draggable, snap-based, never floating. */
@Composable
internal fun TerminalToolSheet(
    workspace: TerminalWorkspaceState,
    colors: TerminalChromeColors,
    hostName: String,
    viewModel: TerminalViewModel?,
    notes: List<Note>,
    snippets: List<Snippet>,
    onWorkspace: (TerminalWorkspaceState) -> Unit,
    onInsert: (String) -> Unit,
    onOpenNote: (String) -> Unit,
    onOpenDocker: () -> Unit,
    onMessage: (String) -> Unit,
) {
    val current = workspace.sheetCurrent ?: return
    val density = LocalDensity.current
    var dragging by remember { mutableStateOf(false) }
    var liveFraction by remember { mutableFloatStateOf(workspace.sheetFraction) }
    var velocityPxPerMs by remember { mutableFloatStateOf(0f) }
    var lastMoveAtNanos by remember { mutableStateOf(0L) }

    LaunchedEffect(workspace.sheetFraction, dragging) {
        if (!dragging) liveFraction = workspace.sheetFraction
    }
    val animatedFraction by animateFloatAsState(
        targetValue = if (dragging) liveFraction else workspace.sheetFraction,
        animationSpec = tween(260, easing = ZephyrMotionTokens.easeDrawer),
        label = "terminalToolSheetHeight",
    )

    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val hostHeightPx = with(density) { maxHeight.toPx() }.coerceAtLeast(1f)
        Column(
            Modifier
                .fillMaxWidth()
                .height(maxHeight * animatedFraction)
                .background(colors.chrome)
                .border(width = 1.dp, color = colors.line),
        ) {
            Box(
                Modifier
                    .fillMaxWidth()
                    .pointerInput(hostHeightPx, workspace.sheetFraction) {
                        detectDragGestures(
                            onDragStart = {
                                dragging = true
                                liveFraction = workspace.sheetFraction
                                velocityPxPerMs = 0f
                                lastMoveAtNanos = System.nanoTime()
                            },
                            onDrag = { change, amount ->
                                change.consume()
                                val now = System.nanoTime()
                                val elapsedMs = max(1f, (now - lastMoveAtNanos) / 1_000_000f)
                                velocityPxPerMs = amount.y / elapsedMs
                                lastMoveAtNanos = now
                                liveFraction = (liveFraction - amount.y / hostHeightPx)
                                    .coerceIn(0f, TerminalWorkspace.SHEET_MAX_FRACTION)
                            },
                            onDragEnd = {
                                dragging = false
                                val settled = TerminalWorkspace.settleSheet(liveFraction, velocityPxPerMs)
                                onWorkspace(
                                    if (settled == 0f) TerminalWorkspace.closeSheet(workspace)
                                    else TerminalWorkspace.setSheetFraction(workspace, settled),
                                )
                            },
                            onDragCancel = {
                                dragging = false
                                liveFraction = workspace.sheetFraction
                            },
                        )
                    }
                    .padding(top = 8.dp, bottom = 5.dp),
                contentAlignment = Alignment.Center,
            ) {
                Box(
                    Modifier
                        .width(38.dp)
                        .height(5.dp)
                        .clip(RoundedCornerShape(3.dp))
                        .background(if (dragging) colors.accent else colors.dim.copy(alpha = 0.55f)),
                )
            }

            Row(
                Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState())
                    .padding(start = 10.dp, end = 10.dp, bottom = 7.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                workspace.sheetTools.forEach { kind ->
                    val selected = kind == current
                    Row(
                        Modifier
                            .height(30.dp)
                            .clip(CircleShape)
                            .background(if (selected) colors.accent.copy(alpha = 0.32f) else colors.chrome2)
                            .padding(start = 11.dp, end = 5.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        TermPressable(
                            onClick = { onWorkspace(TerminalWorkspace.selectSheetTool(workspace, kind)) },
                            modifier = Modifier.height(30.dp),
                            scale = 0.94f,
                        ) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Icon(toolIcon(kind), null, tint = if (selected) Color.White else colors.dim, modifier = Modifier.size(13.dp))
                                Spacer(Modifier.width(6.dp))
                                Text(
                                    toolTitle(kind, hostName).substringBefore('·').trim(),
                                    color = if (selected) Color.White else colors.dim,
                                    fontSize = 12.sp,
                                )
                            }
                        }
                        TermPressable(
                            onClick = { onWorkspace(TerminalWorkspace.closeSheetTool(workspace, kind)) },
                            modifier = Modifier.size(24.dp),
                            scale = 0.90f,
                        ) {
                            Text("×", color = (if (selected) Color.White else colors.dim).copy(alpha = 0.65f), fontSize = 15.sp)
                        }
                    }
                }
            }

            Box(
                Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .padding(start = 8.dp, end = 8.dp, bottom = 14.dp),
            ) {
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
                    viewModel = viewModel,
                )
            }
        }
    }
}
