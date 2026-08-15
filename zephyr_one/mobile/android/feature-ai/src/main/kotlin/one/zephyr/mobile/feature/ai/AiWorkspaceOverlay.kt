package one.zephyr.mobile.feature.ai

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.animateFloat
import androidx.compose.ui.geometry.Offset
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.drag
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.unit.IntOffset
import kotlin.math.roundToInt
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.State as ComposeState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import one.zephyr.mobile.ui.component.Icon
import one.zephyr.mobile.ui.component.Surface
import one.zephyr.mobile.ui.component.Text
import one.zephyr.mobile.ui.component.pressScale
import one.zephyr.mobile.ui.icon.ZephyrIcons
import one.zephyr.mobile.ui.theme.ZephyrMotionTokens
import one.zephyr.mobile.ui.theme.ZephyrRadius
import one.zephyr.mobile.ui.theme.ZephyrTheme

@Composable
fun AiWorkspaceOverlay(
    enabled: Boolean,
    chrome: AiWorkspaceChrome,
    context: AiContextHeader,
    conversation: AiConversation = AiConversation(),
    onChromeChange: (AiWorkspaceChrome) -> Unit,
    onOpenSettings: () -> Unit,
    onNotice: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    var sheet by remember { mutableStateOf(AiSheetState()) }
    var lastOpen by remember { mutableStateOf(AiDetent.HALF) }
    var dragHeightPx by remember { mutableStateOf<Float?>(null) }
    var seedHeightPx by remember { mutableStateOf<Float?>(null) }
    val heightAnim = remember { Animatable(0f) }
    val motion = ZephyrTheme.motion
    val palette = ZephyrTheme.palette
    val density = LocalDensity.current

    LaunchedEffect(enabled) {
        sheet = AiSheetMotion.disable(enabled, sheet)
    }
    LaunchedEffect(sheet.detent) {
        sheet.detent?.let { lastOpen = it }
    }

    BackHandler(enabled = sheet.isOpen) {
        sheet = AiSheetMotion.back(sheet)
    }

    BoxWithConstraints(modifier.fillMaxSize()) {
        val layout = AiSheetGeometry.layout(maxWidth.value)
        val containerHeightPx = with(density) { maxHeight.toPx() }
        val restHeightPx = AiSheetGeometry.heightPx(sheet.detent ?: lastOpen, containerHeightPx)
        LaunchedEffect(containerHeightPx, sheet.detent, lastOpen, dragHeightPx == null, motion.reduceMotion) {
            if (containerHeightPx <= 0f || dragHeightPx != null) return@LaunchedEffect
            val seed = seedHeightPx
            if (seed != null) {
                heightAnim.snapTo(seed)
                seedHeightPx = null
            } else if (heightAnim.value == 0f) {
                heightAnim.snapTo(restHeightPx)
                if (sheet.detent == null) return@LaunchedEffect
            }
            /* Closed uses lastOpen only as the off-screen height. Demo keeps the live height
             * while translating 105% — do not snap back to half mid-dismiss. */
            if (sheet.detent == null) return@LaunchedEffect
            heightAnim.animateTo(
                restHeightPx,
                tween(
                    durationMillis = motion.scale(AiSheetGeometry.SHEET_MS),
                    easing = ZephyrMotionTokens.easeDrawer,
                ),
            )
        }
        val sheetHeightPx = dragHeightPx
            ?: if (heightAnim.value == 0f) restHeightPx else heightAnim.value
        val openFraction = if (sheet.isOpen) 0f else AiSheetGeometry.CLOSED_TRANSLATE
        val slide by animateFloatAsState(
            targetValue = openFraction,
            animationSpec = tween(
                durationMillis = motion.scale(AiSheetGeometry.SHEET_MS),
                easing = ZephyrMotionTokens.easeDrawer,
            ),
            label = "aiSheetSlide",
        )
        val scrimOn = AiSheetMotion.showScrim(sheet.detent, layout)
        val scrimAlpha by animateFloatAsState(
            targetValue = if (scrimOn) 1f else 0f,
            animationSpec = tween(motion.scale(AiSheetGeometry.SHEET_MS)),
            label = "aiScrim",
        )
        val padWidth = AiSheetGeometry.padWidthDp(maxWidth.value).dp
        val padWidthPx = with(density) { padWidth.toPx() }
        val sheetHeight = with(density) { sheetHeightPx.toDp() }
        val phoneShape = RoundedCornerShape(topStart = ZephyrRadius.xl, topEnd = ZephyrRadius.xl)
        val padShape = RoundedCornerShape(topStart = ZephyrRadius.xl, bottomStart = ZephyrRadius.xl)

        if (scrimAlpha > 0f) {
            Box(
                Modifier
                    .fillMaxSize()
                    .graphicsLayer { alpha = scrimAlpha }
                    .background(palette.surfaces.scrim)
                    .then(
                        if (scrimOn) {
                            Modifier.clickable(
                                indication = null,
                                interactionSource = remember { MutableInteractionSource() },
                            ) { sheet = sheet.copy(detent = AiDetent.PEEK) }
                        } else {
                            Modifier
                        },
                    ),
            )
        }

        val sheetModifier = if (layout == AiLayout.PAD) {
            Modifier
                .align(Alignment.CenterEnd)
                .width(padWidth)
                .fillMaxHeight()
                .offset { IntOffset(x = (padWidthPx * slide).roundToInt(), y = 0) }
                .shadow(24.dp, padShape)
                .clip(padShape)
                .background(palette.surfaces.elevated)
        } else {
            Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .height(sheetHeight)
                .offset { IntOffset(x = 0, y = (sheetHeightPx * slide).roundToInt()) }
                .shadow(24.dp, phoneShape)
                .clip(phoneShape)
                .background(palette.surfaces.elevated)
        }

        Column(sheetModifier) {
            if (layout == AiLayout.PHONE) {
                AiHandle(
                    containerHeightPx = containerHeightPx,
                    currentHeightPx = {
                        dragHeightPx
                            ?: if (heightAnim.value == 0f) restHeightPx else heightAnim.value
                    },
                    onDrag = { dragHeightPx = it },
                    onSettle = { height, velocity, deltaY ->
                        seedHeightPx = height
                        dragHeightPx = null
                        sheet = sheet.copy(
                            detent = AiSheetMotion.settle(
                                currentHeightPx = height,
                                containerHeightPx = containerHeightPx,
                                velocityPxPerMs = velocity,
                                dragDeltaYPx = deltaY,
                                layout = layout,
                            ),
                        )
                    },
                )
            } else {
                Spacer(Modifier.height(AiSheetGeometry.HANDLE_TOP_PAD_DP.dp))
            }

            AiContextBanner(context)

            AiToolStrip(
                chrome = chrome,
                onChromeChange = onChromeChange,
                onOpenSettings = onOpenSettings,
                onNotice = onNotice,
            )

            if (sheet.runActive) {
                AiRunBar(
                    onStop = {
                        sheet = AiSheetMotion.stopRun(sheet)
                        onNotice(AiWorkspaceCopy.STOP)
                    },
                    onTakeover = {
                        sheet = AiSheetMotion.takeover(sheet)
                        onNotice(AiWorkspaceCopy.TAKEOVER)
                    },
                )
            }

            Column(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 16.dp, vertical = 2.dp),
            ) {
                if (conversation.isEmpty) {
                    AiEmptyTranscript()
                } else {
                    conversation.items.forEach { item ->
                        when (item) {
                            is AiTranscriptItem.User -> AiMessage(item.text, user = true, modifier = Modifier.align(Alignment.End))
                            is AiTranscriptItem.Assistant -> AiMessage(
                                text = item.text,
                                user = false,
                                caption = item.caption,
                                modifier = Modifier.align(Alignment.Start),
                            )
                            is AiTranscriptItem.ToolTrace -> AiToolTraceCard(item)
                        }
                    }
                }
            }

            AiComposer(
                model = chrome.model,
                onSend = { onNotice(AiWorkspaceCopy.sendNotice(chrome.online)) },
            )
        }

        AnimatedVisibility(
            visible = AiSheetMotion.fabVisible(enabled, sheet.detent),
            modifier = Modifier.align(Alignment.BottomEnd),
            enter = fadeIn(tween(motion.scale(AiSheetGeometry.FAB_OPACITY_MS))) +
                scaleIn(
                    initialScale = AiSheetGeometry.FAB_GONE_SCALE,
                    animationSpec = tween(motion.scale(AiSheetGeometry.FAB_SCALE_MS), easing = ZephyrMotionTokens.easeOut),
                ),
            exit = fadeOut(tween(motion.scale(AiSheetGeometry.FAB_OPACITY_MS))) +
                scaleOut(
                    targetScale = AiSheetGeometry.FAB_GONE_SCALE,
                    animationSpec = tween(motion.scale(AiSheetGeometry.FAB_SCALE_MS), easing = ZephyrMotionTokens.easeOut),
                ),
        ) {
            val interaction = remember { MutableInteractionSource() }
            Surface(
                modifier = Modifier
                    .navigationBarsPadding()
                    .padding(end = AiSheetGeometry.fabEndDp(layout).dp, bottom = AiSheetGeometry.FAB_BOTTOM_DP.dp)
                    .size(AiSheetGeometry.FAB_SIZE_DP.dp)
                    .shadow(12.dp, CircleShape, ambientColor = palette.islandShadow, spotColor = palette.islandShadow)
                    .pressScale(AiSheetGeometry.FAB_PRESS_SCALE, interaction = interaction)
                    .clip(CircleShape)
                    .clickable(
                        interactionSource = interaction,
                        indication = null,
                        role = Role.Button,
                    ) { sheet = sheet.copy(detent = AiSheetMotion.open()) },
                shape = CircleShape,
                color = palette.surfaces.floating,
                contentColor = palette.brand.accent,
            ) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Icon(ZephyrIcons.AiSpark, contentDescription = "Zephyr AI", modifier = Modifier.size(22.dp))
                }
            }
        }
    }
}

@Composable
private fun AiHandle(
    containerHeightPx: Float,
    currentHeightPx: () -> Float,
    onDrag: (Float) -> Unit,
    onSettle: (heightPx: Float, velocityPxPerMs: Float, dragDeltaYPx: Float) -> Unit,
) {
    val palette = ZephyrTheme.palette
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = AiSheetGeometry.HANDLE_TOP_PAD_DP.dp, bottom = AiSheetGeometry.HANDLE_BOTTOM_PAD_DP.dp)
            .height(AiSheetGeometry.HANDLE_BAR_HEIGHT_DP.dp + 16.dp)
            .pointerInput(containerHeightPx) {
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    var lastY = down.position.y
                    var lastT = System.nanoTime()
                    var velocity = 0f
                    val startY = down.position.y
                    val base = currentHeightPx()
                    var height = base
                    try {
                        drag(down.id) { change ->
                            val now = System.nanoTime()
                            val dtMs = ((now - lastT) / 1_000_000f).coerceAtLeast(1f)
                            velocity = (change.position.y - lastY) / dtMs
                            lastY = change.position.y
                            lastT = now
                            height = AiSheetGeometry.clampHeightPx(
                                base - (change.position.y - startY),
                                containerHeightPx,
                            )
                            onDrag(height)
                            if (change.positionChange() != Offset.Zero) change.consume()
                        }
                    } finally {
                        onSettle(height, velocity, lastY - startY)
                    }
                }
            },
        contentAlignment = Alignment.Center,
    ) {
        Box(
            Modifier
                .width(AiSheetGeometry.HANDLE_WIDTH_DP.dp)
                .height(AiSheetGeometry.HANDLE_BAR_HEIGHT_DP.dp)
                .clip(RoundedCornerShape(3.dp))
                .background(palette.onFloatingSubtle.copy(alpha = 0.5f)),
        )
    }
}

@Composable
private fun AiContextBanner(context: AiContextHeader) {
    val palette = ZephyrTheme.palette
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp)
            .padding(bottom = 10.dp)
            .clip(RoundedCornerShape(ZephyrRadius.sm))
            .background(palette.brand.accent.copy(alpha = 0.10f))
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(ZephyrIcons.Sessions, contentDescription = null, tint = palette.brand.accent, modifier = Modifier.size(13.dp))
        Text("上下文", color = palette.brand.accent, fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold)
        Text(
            context.label,
            color = palette.brand.accent.copy(alpha = 0.85f),
            fontSize = 12.5.sp,
            fontFamily = FontFamily.Monospace,
            fontWeight = FontWeight.Medium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
        if (context.trailing.isNotEmpty()) {
            Text(
                "· ${context.trailing}",
                color = palette.brand.accent,
                fontSize = 12.5.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Clip,
            )
        }
    }
}

@Composable
private fun AiToolStrip(
    chrome: AiWorkspaceChrome,
    onChromeChange: (AiWorkspaceChrome) -> Unit,
    onOpenSettings: () -> Unit,
    onNotice: (String) -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(start = 16.dp, end = 16.dp, bottom = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        AiChipCycle.chips(chrome).forEach { spec ->
            AiChip(spec.label, spec.value) {
                when (spec.kind) {
                    AiChipKind.SETTINGS -> onOpenSettings()
                    else -> {
                        val next = AiChipCycle.cycle(chrome, spec.kind)
                        if (next != chrome) onChromeChange(next)
                        AiWorkspaceCopy.chipToast(spec.kind, if (next != chrome) next else chrome)?.let(onNotice)
                    }
                }
            }
        }
    }
}

@Composable
private fun AiChip(label: String, value: String?, onClick: () -> Unit) {
    val palette = ZephyrTheme.palette
    val interaction = remember { MutableInteractionSource() }
    Row(
        modifier = Modifier
            .height(AiSheetGeometry.CHIP_HEIGHT_DP.dp)
            .pressScale(AiSheetGeometry.CHIP_PRESS_SCALE, interaction = interaction)
            .clip(RoundedCornerShape(14.dp))
            .background(palette.surfaces.content)
            .border(BorderStroke(1.dp, palette.surfaces.outlineSoft), RoundedCornerShape(14.dp))
            .clickable(interactionSource = interaction, indication = null, onClick = onClick)
            .padding(horizontal = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        Text(label, color = palette.onFloatingMuted, fontSize = 11.5.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
        if (value != null) {
            Text(value, color = palette.onBackground, fontSize = 11.5.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
        }
    }
}

@Composable
private fun AiRunBar(onStop: () -> Unit, onTakeover: () -> Unit) {
    val palette = ZephyrTheme.palette
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp)
            .padding(bottom = 10.dp)
            .clip(RoundedCornerShape(ZephyrRadius.sm))
            .background(palette.status.pendingSync.copy(alpha = 0.10f))
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        AiSpinner(color = palette.status.pendingSync)
        Text(
            AiRunBanner().label,
            color = palette.status.pendingSync,
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.weight(1f),
        )
        AiInlineAction("停止", palette.status.error, onStop)
        AiInlineAction("接管", palette.onFloatingMuted, onTakeover)
    }
}

@Composable
private fun AiSpinner(color: Color) {
    val spin by rememberInfiniteSpin()
    Canvas(Modifier.size(12.dp).graphicsLayer { rotationZ = spin }) {
        drawArc(
            color = color,
            startAngle = 0f,
            sweepAngle = 270f,
            useCenter = false,
            style = Stroke(width = 2.dp.toPx(), cap = StrokeCap.Butt),
        )
    }
}

@Composable
private fun rememberInfiniteSpin(): ComposeState<Float> {
    val transition = rememberInfiniteTransition(label = "aiSpin")
    return transition.animateFloat(
        initialValue = 0f,
        targetValue = 360f,
        animationSpec = infiniteRepeatable(animation = tween(800, easing = LinearEasing)),
        label = "aiSpinValue",
    )
}

@Composable
private fun AiInlineAction(label: String, color: Color, onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    Box(
        Modifier
            .pressScale(0.96f, interaction = interaction)
            .clip(RoundedCornerShape(8.dp))
            .background(ZephyrTheme.palette.surfaces.content)
            .clickable(interactionSource = interaction, indication = null, onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 3.dp),
    ) {
        Text(label, color = color, fontSize = 12.sp, fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun AiEmptyTranscript() {
    val palette = ZephyrTheme.palette
    Column(
        Modifier
            .fillMaxWidth()
            .padding(top = 18.dp, bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(AiWorkspaceCopy.EMPTY_TITLE, color = palette.onFloatingMuted, fontSize = 13.5.sp, fontWeight = FontWeight.SemiBold)
        Text(
            AiWorkspaceCopy.EMPTY_BODY,
            color = palette.onFloatingSubtle,
            style = TextStyle(fontSize = 13.sp, lineHeight = 19.sp),
        )
    }
}

@Composable
private fun AiMessage(
    text: String,
    user: Boolean,
    modifier: Modifier = Modifier,
    caption: String? = null,
) {
    val palette = ZephyrTheme.palette
    val shape = RoundedCornerShape(
        topStart = 16.dp,
        topEnd = 16.dp,
        bottomStart = if (user) 16.dp else 5.dp,
        bottomEnd = if (user) 5.dp else 16.dp,
    )
    Column(
        modifier = modifier
            .fillMaxWidth(0.86f)
            .padding(bottom = 10.dp)
            .clip(shape)
            .background(if (user) palette.brand.accent else palette.surfaces.content)
            .then(
                if (user) Modifier else Modifier.border(BorderStroke(1.dp, palette.surfaces.outlineSoft), shape),
            )
            .padding(horizontal = 13.dp, vertical = 10.dp),
    ) {
        if (caption != null) {
            Text(caption, color = palette.onFloatingSubtle, fontSize = 12.sp)
            Spacer(Modifier.height(2.dp))
        }
        Text(
            text,
            color = if (user) Color.White else palette.onBackground,
            style = TextStyle(fontSize = 13.5.sp, lineHeight = 20.sp),
        )
    }
}

@Composable
private fun AiToolTraceCard(item: AiTranscriptItem.ToolTrace) {
    val palette = ZephyrTheme.palette
    val title = when {
        item.denied -> AiWorkspaceCopy.TOOL_DENIED
        item.approved -> AiWorkspaceCopy.TOOL_DONE
        else -> "${AiWorkspaceCopy.TOOL_PENDING} · ${item.title} · 风险：${item.risk}"
    }
    Column(
        Modifier
            .fillMaxWidth()
            .padding(bottom = 10.dp)
            .clip(RoundedCornerShape(14.dp))
            .background(palette.surfaces.content)
            .border(BorderStroke(1.dp, palette.surfaces.outlineSoft), RoundedCornerShape(14.dp))
            .padding(horizontal = 13.dp, vertical = 11.dp),
    ) {
        Text(
            title,
            color = if (item.approved) palette.status.success else palette.onFloatingMuted,
            fontSize = 12.5.sp,
            fontWeight = FontWeight.SemiBold,
        )
        Box(
            Modifier
                .fillMaxWidth()
                .padding(top = 6.dp)
                .clip(RoundedCornerShape(8.dp))
                .background(palette.surfaces.termBackground)
                .padding(horizontal = 10.dp, vertical = 8.dp),
        ) {
            Text(
                item.command,
                color = Color(0xFF7EE787),
                fontFamily = FontFamily.Monospace,
                fontSize = 11.5.sp,
                maxLines = 1,
                overflow = TextOverflow.Clip,
            )
        }
    }
}

@Composable
private fun AiComposer(model: String, onSend: () -> Unit) {
    val palette = ZephyrTheme.palette
    val sendInteraction = remember { MutableInteractionSource() }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(palette.surfaces.elevated)
            .padding(start = 16.dp, end = 16.dp, top = 10.dp, bottom = 12.dp)
            .navigationBarsPadding()
            .imePadding(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .weight(1f)
                .height(AiSheetGeometry.INPUT_HEIGHT_DP.dp)
                .clip(RoundedCornerShape(20.dp))
                .background(palette.surfaces.content)
                .border(BorderStroke(1.dp, palette.surfaces.outlineSoft), RoundedCornerShape(20.dp))
                .padding(horizontal = 16.dp),
            contentAlignment = Alignment.CenterStart,
        ) {
            Text(AiWorkspaceCopy.askPlaceholder(model), color = palette.onFloatingSubtle, fontSize = 14.sp, maxLines = 1)
        }
        Box(
            Modifier
                .size(AiSheetGeometry.SEND_SIZE_DP.dp)
                .pressScale(AiSheetGeometry.SEND_PRESS_SCALE, interaction = sendInteraction)
                .clip(CircleShape)
                .background(palette.brand.accent)
                .clickable(interactionSource = sendInteraction, indication = null, onClick = onSend),
            contentAlignment = Alignment.Center,
        ) {
            Icon(ZephyrIcons.ArrowUp, contentDescription = "发送", tint = Color.White, modifier = Modifier.size(16.dp))
        }
    }
}
