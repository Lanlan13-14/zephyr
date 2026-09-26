package one.zephyr.mobile.feature.ai

import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
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
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.gestures.drag
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.navigationBars
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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State as ComposeState
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.TextStyle
import one.zephyr.mobile.ui.glass.liquidGlass
import one.zephyr.mobile.ui.glass.Highlight
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import one.zephyr.mobile.ui.component.Icon
import one.zephyr.mobile.ui.component.Surface
import one.zephyr.mobile.ui.component.Text
import one.zephyr.mobile.ui.component.pressScale
import one.zephyr.mobile.ui.icon.ZephyrIcons
import one.zephyr.mobile.ui.theme.ZephyrMotionTokens
import one.zephyr.mobile.ui.theme.ZephyrRadius
import one.zephyr.mobile.ui.theme.ZephyrTheme
import kotlin.math.roundToInt

@Composable
fun AiWorkspaceOverlay(
    enabled: Boolean,
    chrome: AiWorkspaceChrome,
    context: AiContextHeader,
    controller: AiRuntimeController,
    onOpenSettings: () -> Unit,
    onNotice: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val runtime by controller.state.collectAsState()
    var sheet by remember { mutableStateOf(AiSheetState()) }
    var lastOpen by remember { mutableStateOf(AiDetent.HALF) }
    var dragHeightPx by remember { mutableStateOf<Float?>(null) }
    var releaseVelocityPxPerSecond by remember { mutableStateOf(0f) }
    var handlePressed by remember { mutableStateOf(false) }
    var seedHeightPx by remember { mutableStateOf<Float?>(null) }
    var picker by remember { mutableStateOf<AiPicker?>(null) }
    var confirmDeleteTargetId by remember { mutableStateOf<String?>(null) }
    var fabOffset by remember { mutableStateOf(Offset.Zero) }
    val heightAnim = remember { Animatable(0f) }
    val motion = ZephyrTheme.motion
    val palette = ZephyrTheme.palette
    val density = LocalDensity.current
    val scope = rememberCoroutineScope()
    val appContext = LocalContext.current

    val filePicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        scope.launch {
            val upload = withContext(Dispatchers.IO) {
                val resolver = appContext.contentResolver
                val name = resolver.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)
                    ?.use { cursor ->
                        val index = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
                        if (cursor.moveToFirst() && index >= 0) cursor.getString(index) else null
                    } ?: uri.lastPathSegment ?: "file"
                val mime = resolver.getType(uri) ?: "application/octet-stream"
                val bytes = resolver.openInputStream(uri)?.use { input ->
                    val output = java.io.ByteArrayOutputStream()
                    val buffer = ByteArray(32 * 1024)
                    var total = 0
                    while (true) {
                        val read = input.read(buffer)
                        if (read < 0) break
                        total += read
                        if (total > 12 * 1024 * 1024) throw java.io.IOException("单文件不能超过 12MB")
                        output.write(buffer, 0, read)
                    }
                    buffer.fill(0)
                    output.toByteArray()
                } ?: throw java.io.IOException("无法读取所选文件")
                AiUpload(name, mime, bytes)
            }
            runCatching { controller.upload(upload) }
                .onFailure { onNotice(it.message ?: "附件上传失败") }
        }
    }

    LaunchedEffect(enabled) { sheet = AiSheetMotion.disable(enabled, sheet) }
    LaunchedEffect(sheet.detent) { sheet.detent?.let { lastOpen = it } }
    // Do not boot the packaged process while composing the application's first frame. The AI
    // workspace is an overlay: its runtime is needed only after the user opens it.
    LaunchedEffect(sheet.isOpen) { if (sheet.isOpen) controller.refresh() }
    LaunchedEffect(runtime.error) { runtime.error?.let(onNotice) }

    BackHandler(enabled = sheet.isOpen) {
        if (picker != null) picker = null else sheet = AiSheetMotion.back(sheet)
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
            if (sheet.detent == null) return@LaunchedEffect
            if (motion.reduceMotion) {
                heightAnim.snapTo(restHeightPx)
            } else {
                heightAnim.animateTo(
                    restHeightPx,
                    spring(
                        dampingRatio = AiSheetGeometry.SPRING_DAMPING_RATIO,
                        stiffness = AiSheetGeometry.SPRING_STIFFNESS,
                        visibilityThreshold = 0.5f,
                    ),
                    initialVelocity = -releaseVelocityPxPerSecond,
                )
            }
            releaseVelocityPxPerSecond = 0f
        }
        val sheetHeightPx = dragHeightPx ?: if (heightAnim.value == 0f) restHeightPx else heightAnim.value
        val slide by animateFloatAsState(
            if (sheet.isOpen) 0f else AiSheetGeometry.CLOSED_TRANSLATE,
            tween(motion.scale(AiSheetGeometry.SHEET_MS), easing = ZephyrMotionTokens.easeDrawer),
            label = "aiSheetSlide",
        )
        val scrimOn = AiSheetMotion.showScrim(sheet.detent, layout)
        val scrimAlpha by animateFloatAsState(
            if (scrimOn) 1f else 0f,
            tween(motion.scale(AiSheetGeometry.SHEET_MS)),
            label = "aiScrim",
        )
        val padWidth = AiSheetGeometry.padWidthDp(maxWidth.value).dp
        val padWidthPx = with(density) { padWidth.toPx() }
        val sheetHeight = with(density) { sheetHeightPx.toDp() }
        val phoneShape = RoundedCornerShape(topStart = ZephyrRadius.xl, topEnd = ZephyrRadius.xl)
        val padShape = RoundedCornerShape(topStart = ZephyrRadius.xl, bottomStart = ZephyrRadius.xl)

        if (scrimAlpha > 0f) {
            Box(
                Modifier.fillMaxSize().graphicsLayer { alpha = scrimAlpha }
                    .background(palette.surfaces.scrim)
                    .then(
                        if (scrimOn) Modifier.clickable(
                            indication = null,
                            interactionSource = remember { MutableInteractionSource() },
                        ) { sheet = sheet.copy(detent = AiDetent.PEEK) } else Modifier,
                    ),
            )
        }

        val sheetModifier = if (layout == AiLayout.PAD) {
            Modifier.align(Alignment.CenterEnd).width(padWidth).fillMaxHeight()
                .offset { IntOffset((padWidthPx * slide).roundToInt(), 0) }
                .shadow(24.dp, padShape).clip(padShape).background(palette.surfaces.elevated)
        } else {
            Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(sheetHeight)
                .offset { IntOffset(0, (sheetHeightPx * slide).roundToInt()) }
                .shadow(24.dp, phoneShape).clip(phoneShape).background(palette.surfaces.elevated)
        }

        AiMainEndPanel(
            modifier = sheetModifier,
            chrome = chrome,
            runtime = runtime,
            onClose = { sheet = AiSheetMotion.hidePanel(sheet) },
            onOpenSettings = onOpenSettings,
            onNotice = onNotice,
            onPick = { picker = it },
            onAttach = { filePicker.launch(arrayOf("*/*")) },
            onNew = { controller.newConversation() },
            onSelectConversation = { controller.selectConversation(it) },
            onDeleteConversation = { confirmDeleteTargetId = it },
            onClear = { controller.clearConversation() },
            onCompress = { controller.compressConversation() },
            onStop = { scope.launch { controller.stop() } },
            onDecide = { scope.launch { controller.decide(it) } },
            onRemoveAttachment = { id -> scope.launch { controller.removeAttachment(id) } },
            onSend = { text -> scope.launch { controller.send(text) } },
            dragHandle = if (layout == AiLayout.PHONE) {
                {
                AiHandle(
                    containerHeightPx = containerHeightPx,
                    pressed = handlePressed,
                    currentHeightPx = { dragHeightPx ?: if (heightAnim.value == 0f) restHeightPx else heightAnim.value },
                    onPressChange = { handlePressed = it },
                    onDrag = { dragHeightPx = it },
                ) { height, velocityPxPerSecond, deltaY ->
                    seedHeightPx = height
                    releaseVelocityPxPerSecond = velocityPxPerSecond
                    dragHeightPx = null
                    sheet = sheet.copy(
                        detent = AiSheetMotion.settle(
                            height,
                            containerHeightPx,
                            velocityPxPerSecond / 1_000f,
                            deltaY,
                            layout,
                        ),
                    )
                }
                }
            } else null,
        )

        picker?.let { active ->
            AiPickerOverlay(
                picker = active,
                chrome = chrome,
                runtime = runtime,
                onDismiss = { picker = null },
                onSelected = { value ->
                    when (active) {
                        AiPicker.PROVIDER -> controller.selectProvider(value)
                        AiPicker.MODEL -> controller.selectModel(value)
                        AiPicker.MODE -> controller.selectMode(value)
                        AiPicker.RUN_PROFILE -> controller.selectRunProfile(value)
                        AiPicker.PERMISSION -> controller.selectPermission(value)
                        AiPicker.THINKING -> controller.selectThinking(value)
                    }
                    picker = null
                },
            )
        }

                onDismissRequest = { confirmDeleteTargetId = null },
                title = { Text("删除对话") },
                text = { Text("将从同账号的所有设备删除此对话及其消息。") },
                confirmButton = {
                    one.zephyr.mobile.ui.component.TextButton(
                        onClick = {
                            confirmDeleteTargetId = null
                            scope.launch {
                                controller.deleteConversation(targetId)
                            }
                        },
                    ) {
                        Text("删除", color = palette.status.error)
                    }
                },
                dismissButton = {
                    one.zephyr.mobile.ui.component.TextButton(onClick = { confirmDeleteTargetId = null }) {
                        Text("取消")
                    }
                },
            )
        }

        AnimatedVisibility(
            visible = AiSheetMotion.fabVisible(enabled, sheet.detent),
            modifier = Modifier.align(Alignment.BottomEnd),
            enter = fadeIn(tween(motion.scale(AiSheetGeometry.FAB_OPACITY_MS))) +
                scaleIn(
                    animationSpec = tween(motion.scale(AiSheetGeometry.FAB_SCALE_MS), easing = ZephyrMotionTokens.easeOut),
                    initialScale = AiSheetGeometry.FAB_GONE_SCALE,
                ),
            exit = fadeOut(tween(motion.scale(AiSheetGeometry.FAB_OPACITY_MS))) +
                scaleOut(
                    animationSpec = tween(motion.scale(AiSheetGeometry.FAB_SCALE_MS), easing = ZephyrMotionTokens.easeOut),
                    targetScale = AiSheetGeometry.FAB_GONE_SCALE,
                ),
        ) {
            val interaction = remember { MutableInteractionSource() }
            val fabSizePx = with(density) { AiSheetGeometry.FAB_SIZE_DP.dp.toPx() }
            val navBarPx = with(density) {
                WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding().toPx()
            }
            Surface(
                modifier = Modifier
                    .align(Alignment.BottomEnd)
                    .offset { IntOffset(fabOffset.x.roundToInt(), fabOffset.y.roundToInt()) }
                    .navigationBarsPadding()
                    .padding(end = AiSheetGeometry.fabEndDp(layout).dp, bottom = AiSheetGeometry.FAB_BOTTOM_DP.dp)
                    .size(AiSheetGeometry.FAB_SIZE_DP.dp)
                    .shadow(12.dp, CircleShape, ambientColor = palette.islandShadow, spotColor = palette.islandShadow)
                    .pressScale(AiSheetGeometry.FAB_PRESS_SCALE, interaction = interaction)
                    .clip(CircleShape)
                    .pointerInput(maxWidth, containerHeightPx, fabSizePx, navBarPx) {
                        detectDragGesturesAfterLongPress(
                            onDragStart = { },
                            onDrag = { change, dragAmount ->
                                change.consume()
                                fabOffset = Offset(
                                    x = (fabOffset.x + dragAmount.x).coerceIn(
                                        -maxWidth.value,
                                        0f,
                                    ),
                                    y = (fabOffset.y + dragAmount.y).coerceIn(
                                        -containerHeightPx,
                                        0f,
                                    ),
                                )
                            },
                            onDragEnd = {
                                val snapX = if (fabOffset.x < -maxWidth.value / 2f) {
                                    -maxWidth.value + fabSizePx + with(density) {
                                        AiSheetGeometry.fabEndDp(layout).dp.toPx()
                                    } + navBarPx
                                } else {
                                    0f
                                }
                                fabOffset = Offset(snapX, fabOffset.y)
                            },
                        )
                    }
                    .clickable(interactionSource = interaction, indication = null, role = Role.Button) {
                        sheet = sheet.copy(detent = AiSheetMotion.open())
                    },
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

private enum class AiPicker { PROVIDER, MODEL, MODE, RUN_PROFILE, PERMISSION, THINKING }

@Composable
private fun AiHandle(
    containerHeightPx: Float,
    pressed: Boolean,
    currentHeightPx: () -> Float,
    onPressChange: (Boolean) -> Unit,
    onDrag: (Float) -> Unit,
    onSettle: (Float, Float, Float) -> Unit,
) {
    val palette = ZephyrTheme.palette
    val motion = ZephyrTheme.motion
    val handleScaleX by animateFloatAsState(
        targetValue = if (pressed) AiSheetGeometry.HANDLE_ACTIVE_WIDTH_DP / AiSheetGeometry.HANDLE_WIDTH_DP else 1f,
        animationSpec = tween(motion.scale(AiSheetGeometry.HANDLE_PRESS_MS), easing = ZephyrMotionTokens.easeOut),
        label = "aiHandleScaleX",
    )
    Box(
        Modifier.fillMaxWidth().padding(top = AiSheetGeometry.HANDLE_TOP_PAD_DP.dp, bottom = AiSheetGeometry.HANDLE_BOTTOM_PAD_DP.dp)
            .height(AiSheetGeometry.HANDLE_TOUCH_HEIGHT_DP.dp)
            .pointerInput(containerHeightPx) {
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    onPressChange(true)
                    val tracker = AiHandleVelocityEstimator()
                    tracker.reset(down.uptimeMillis, down.position.y)
                    val startY = down.position.y
                    val base = currentHeightPx()
                    var lastY = startY
                    var height = base
                    var releaseVelocity = 0f
                    try {
                        drag(down.id) { change ->
                            tracker.add(change.uptimeMillis, change.position.y)
                            lastY = change.position.y
                            height = AiSheetGeometry.dragHeightPx(
                                rawHeightPx = base - (lastY - startY),
                                containerHeightPx = containerHeightPx,
                            )
                            onDrag(height)
                            if (change.positionChange() != Offset.Zero) change.consume()
                        }
                        releaseVelocity = tracker.velocityPxPerSecond()
                    } finally {
                        onPressChange(false)
                        onSettle(height, releaseVelocity, lastY - startY)
                    }
                }
            },
        contentAlignment = Alignment.Center,
    ) {
        Box(
            Modifier.width(AiSheetGeometry.HANDLE_WIDTH_DP.dp).height(AiSheetGeometry.HANDLE_BAR_HEIGHT_DP.dp)
                .graphicsLayer { scaleX = handleScaleX }
                .clip(RoundedCornerShape(3.dp))
                .background(
                    if (pressed) palette.brand.accent.copy(alpha = 0.86f)
                    else palette.onFloatingSubtle.copy(alpha = 0.5f),
                ),
        )
    }
}

@Composable
private fun AiPermissionCard(pending: AiPendingPermission, onApprove: () -> Unit, onDeny: () -> Unit) {
    val palette = ZephyrTheme.palette
    Column(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(bottom = 10.dp)
            .clip(RoundedCornerShape(14.dp)).background(palette.status.warning.copy(alpha = 0.10f))
            .border(BorderStroke(1.dp, palette.status.warning.copy(alpha = 0.45f)), RoundedCornerShape(14.dp))
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(7.dp),
    ) {
        Text("需要确认 · ${pending.tool}", color = palette.status.warning, fontSize = 12.5.sp, fontWeight = FontWeight.Bold)
        Text(pending.summary, color = palette.onBackground, style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp))
        if (pending.args.isNotEmpty()) Text(pending.args.toString().take(900), color = palette.onFloatingMuted, fontSize = 11.sp, fontFamily = FontFamily.Monospace)
        Row(Modifier.align(Alignment.End), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            AiInlineAction("拒绝", palette.status.error, onDeny)
            AiInlineAction("仅本次允许", palette.status.success, onApprove)
        }
    }
}

@Composable
private fun AiSpinner(color: Color) {
    val spin by rememberInfiniteSpin()
    Canvas(Modifier.size(12.dp).graphicsLayer { rotationZ = spin }) {
        drawArc(color, 0f, 270f, false, style = Stroke(2.dp.toPx(), cap = StrokeCap.Butt))
    }
}

@Composable
private fun rememberInfiniteSpin(): ComposeState<Float> = rememberInfiniteTransition(label = "aiSpin").animateFloat(
    0f, 360f, infiniteRepeatable(tween(800, easing = LinearEasing)), label = "aiSpinValue",
)

@Composable
private fun AiInlineAction(label: String, color: Color, onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    Box(
        Modifier.pressScale(0.96f, interaction = interaction).clip(RoundedCornerShape(8.dp))
            .background(ZephyrTheme.palette.surfaces.content)
            .clickable(interactionSource = interaction, indication = null, onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 5.dp),
    ) { Text(label, color = color, fontSize = 12.sp, fontWeight = FontWeight.Bold) }
}

@Composable
private fun AiEmptyTranscript(runtime: Boolean) {
    val palette = ZephyrTheme.palette
    Column(Modifier.fillMaxWidth().padding(top = 18.dp, bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(AiWorkspaceCopy.EMPTY_TITLE, color = palette.onFloatingMuted, fontSize = 13.5.sp, fontWeight = FontWeight.SemiBold)
        Text(
            if (runtime) "选择 Provider/模型后发送消息；工具调用、确认、执行结果和附件都会显示在这里。" else "主端没有启用 Go AI Runtime，或当前绑定无法访问它。",
            color = palette.onFloatingSubtle,
            style = TextStyle(fontSize = 13.sp, lineHeight = 19.sp),
        )
    }
}

@Composable
private fun AiMessage(text: String, user: Boolean, modifier: Modifier = Modifier, caption: String? = null) {
    val palette = ZephyrTheme.palette
    val shape = RoundedCornerShape(16.dp, 16.dp, if (user) 16.dp else 6.dp, if (user) 6.dp else 16.dp)
    Box(modifier.padding(bottom = 10.dp), contentAlignment = if (user) Alignment.CenterEnd else Alignment.CenterStart) {
        Column(
            Modifier.fillMaxWidth(if (user) 0.86f else 0.96f).clip(shape).background(if (user) palette.brand.accent else palette.surfaces.content)
                .then(if (user) Modifier else Modifier.border(BorderStroke(1.dp, palette.surfaces.outlineSoft), shape))
                .padding(horizontal = 14.dp, vertical = 10.dp),
        ) {
            caption?.let { Text(it, color = palette.onFloatingSubtle, fontSize = 12.sp); Spacer(Modifier.height(3.dp)) }
            if (user) {
                Text(text, color = Color.White, style = TextStyle(fontSize = 13.5.sp, lineHeight = 20.sp))
            } else {
                one.zephyr.mobile.ui.component.MarkdownView(
                    source = text,
                )
            }
        }
    }
}

@Composable
private fun AiToolTraceCard(item: AiTranscriptItem.ToolTrace) {
    val palette = ZephyrTheme.palette
    val shape = RoundedCornerShape(14.dp)
    Column(
        Modifier.fillMaxWidth().padding(bottom = 10.dp)
            .liquidGlass(
                shape = shape,
                blurRadius = 12.dp,
                refractionHeight = 8.dp,
                refractionAmount = 10.dp,
                highlight = Highlight.Default,
            )
            .background(palette.surfaces.content.copy(alpha = 0.75f))
            .border(BorderStroke(1.dp, palette.surfaces.outlineSoft.copy(alpha = 0.5f)), shape)
            .padding(horizontal = 13.dp, vertical = 11.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(item.title, color = when (item.status) { "error", "denied" -> palette.status.error; "success" -> palette.status.success; else -> palette.onFloatingMuted }, fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold)
        if (item.command.isNotBlank()) {
            Text(item.command, color = palette.onFloatingMuted, fontFamily = FontFamily.Monospace, fontSize = 11.5.sp, maxLines = 5, overflow = TextOverflow.Ellipsis)
        }
        item.result?.let { Text(it, color = palette.onBackground, fontFamily = FontFamily.Monospace, fontSize = 11.5.sp, maxLines = 12, overflow = TextOverflow.Ellipsis) }
        item.durationMs?.let { Text("${it}ms", color = palette.onFloatingSubtle, fontSize = 10.5.sp) }
    }
}


@Composable
private fun AiMainEndPanel(
    modifier: Modifier,
    chrome: AiWorkspaceChrome,
    runtime: AiRuntimeState,
    onClose: () -> Unit,
    onOpenSettings: () -> Unit,
    onNotice: (String) -> Unit,
    onPick: (AiPicker) -> Unit,
    onAttach: () -> Unit,
    onNew: () -> Unit,
    onSelectConversation: (String) -> Unit,
    onDeleteConversation: (String) -> Unit,
    onClear: () -> Unit,
    onCompress: () -> Unit,
    onStop: () -> Unit,
    onDecide: (Boolean) -> Unit,
    onRemoveAttachment: (String) -> Unit,
    onSend: (String) -> Unit,
    dragHandle: (@Composable () -> Unit)?,
) {
    val palette = ZephyrTheme.palette
    var drawerOpen by remember { mutableStateOf(false) }
    var sheetOpen by remember { mutableStateOf(false) }
    var thinkingOpen by remember { mutableStateOf(false) }
    Box(modifier) {
        Column(Modifier.fillMaxSize()) {
            dragHandle?.invoke()
            AiTitleBar(
                title = runtime.conversationTitle,
                model = chrome.model.ifBlank { "模型" },
                onOpenDrawer = { drawerOpen = true },
                onPickModel = { onPick(AiPicker.MODEL) },
                onNew = onNew,
                onClose = onClose,
            )
            Box(Modifier.weight(1f).fillMaxWidth()) {
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 14.dp, vertical = 12.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    if (runtime.conversation.isEmpty) item { AiEmptyTranscript(runtime.runtimeEnabled) }
                    itemsIndexed(runtime.conversation.items, key = { index, item -> "$index:${item::class.simpleName}" }) { _, item ->
                        when (item) {
                            is AiTranscriptItem.User -> AiMessage(item.text, true, Modifier.fillMaxWidth())
                            is AiTranscriptItem.Assistant -> AiMessage(item.text, false, Modifier.fillMaxWidth(), item.caption)
                            is AiTranscriptItem.ToolTrace -> AiToolTraceCard(item)
                        }
                    }
                    if (runtime.running || runtime.loading) item { AiTypingRow() }
                }
            }
            runtime.waitingPermission?.let { pending ->
                AiPermissionCard(pending, { onDecide(true) }, { onDecide(false) })
            }
            if (runtime.attachments.isNotEmpty()) {
                AiAttachmentTray(runtime.attachments, onRemoveAttachment)
            }
            AiCapsuleComposer(
                model = chrome.model,
                running = runtime.running,
                enabled = runtime.waitingPermission == null,
                thinkingOpen = thinkingOpen,
                onSend = onSend,
                onStop = onStop,
                onOpenSheet = { sheetOpen = true },
                onToggleThinking = { thinkingOpen = !thinkingOpen },
            )
        }
        if (drawerOpen) {
            AiHistoryDrawer(
                conversations = runtime.conversations,
                currentId = runtime.conversationId,
                onSelect = { onSelectConversation(it); drawerOpen = false },
                onNew = { onNew(); drawerOpen = false },
                onDelete = onDeleteConversation,
                onDismiss = { drawerOpen = false },
            )
        }
        if (sheetOpen) {
            AiActionSheet(
                onAttach = { sheetOpen = false; onAttach() },
                onUsage = { sheetOpen = false; onNotice("Token 用量在主端统计，移动端暂不单独计算") },
                onCompress = { sheetOpen = false; onCompress(); onNotice("上下文已压缩") },
                onClear = { sheetOpen = false; onClear() },
                onSettings = { sheetOpen = false; onOpenSettings() },
                onDismiss = { sheetOpen = false },
            )
        }
        if (thinkingOpen) {
            AiThinkingPopover(
                chrome = chrome,
                onPick = onPick,
                onDismiss = { thinkingOpen = false },
            )
        }
    }
}

@Composable
private fun AiTitleBar(
    title: String,
    model: String,
    onOpenDrawer: () -> Unit,
    onPickModel: () -> Unit,
    onNew: () -> Unit,
    onClose: () -> Unit,
) {
    val palette = ZephyrTheme.palette
    Row(
        Modifier.fillMaxWidth().height(56.dp).padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        AiRoundButton(ZephyrIcons.More, "对话列表", onOpenDrawer)
        Row(
            Modifier
                .padding(start = 4.dp)
                .clip(RoundedCornerShape(999.dp))
                .background(palette.surfaces.content)
                .clickable(onClick = onPickModel)
                .padding(horizontal = 12.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(model, color = palette.onBackground, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Icon(ZephyrIcons.Chevron, null, tint = palette.onFloatingSubtle, modifier = Modifier.size(12.dp))
        }
        Text(
            title.ifBlank { "新对话" },
            color = palette.onBackground,
            fontSize = 14.sp,
            fontWeight = FontWeight.Bold,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
            modifier = Modifier.weight(1f).padding(horizontal = 8.dp),
        )
        AiRoundButton(ZephyrIcons.Plus, "新建对话", onNew)
        AiRoundButton(ZephyrIcons.Close, "关闭", onClose)
    }
}

@Composable
private fun AiRoundButton(icon: ImageVector, description: String, onClick: () -> Unit) {
    val palette = ZephyrTheme.palette
    Box(
        Modifier.size(36.dp).clip(CircleShape).clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, description, tint = palette.onBackground, modifier = Modifier.size(18.dp))
    }
}

@Composable
private fun AiHistoryDrawer(
    conversations: List<AiConversationBrief>,
    currentId: String?,
    onSelect: (String) -> Unit,
    onNew: () -> Unit,
    onDelete: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    val palette = ZephyrTheme.palette
    Row(Modifier.fillMaxSize()) {
        Column(
            Modifier.fillMaxHeight().fillMaxWidth(0.78f).background(palette.surfaces.elevated),
        ) {
            Row(
                Modifier.fillMaxWidth().height(56.dp).padding(horizontal = 14.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text("对话历史", color = palette.onBackground, fontWeight = FontWeight.Bold, fontSize = 15.sp)
                AiRoundButton(ZephyrIcons.Plus, "新建对话", onNew)
            }
            if (conversations.isEmpty()) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Text("暂无历史对话", color = palette.onFloatingSubtle, fontSize = 13.sp)
                }
            } else {
                LazyColumn(Modifier.fillMaxSize()) {
                    items(conversations.size, key = { conversations[it].id }) { index ->
                        val item = conversations[index]
                        val selected = item.id == currentId
                        Row(
                            Modifier.fillMaxWidth()
                                .background(if (selected) palette.brand.accent else Color.Transparent)
                                .clickable { onSelect(item.id) }
                                .padding(horizontal = 14.dp, vertical = 12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                item.title.ifBlank { "新对话" },
                                color = if (selected) Color.White else palette.onBackground,
                                fontSize = 13.5.sp,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f),
                            )
                            Icon(
                                ZephyrIcons.Delete,
                                "删除",
                                tint = if (selected) Color.White else palette.onFloatingSubtle,
                                modifier = Modifier.size(16.dp).clickable { onDelete(item.id) },
                            )
                        }
                    }
                }
            }
        }
        Box(
            Modifier.weight(1f).fillMaxHeight().background(palette.surfaces.scrim).clickable(onClick = onDismiss),
        )
    }
}

@Composable
private fun AiTypingRow() {
    val palette = ZephyrTheme.palette
    Row(horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically) {
        repeat(3) { AiSpinner(palette.brand.accent) }
        Text("正在回复", color = palette.onFloatingSubtle, fontSize = 12.sp)
    }
}

@Composable
private fun AiAttachmentTray(attachments: List<AiAttachment>, onRemove: (String) -> Unit) {
    val palette = ZephyrTheme.palette
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        attachments.forEach { attachment ->
            Row(
                Modifier.clip(RoundedCornerShape(12.dp)).background(palette.surfaces.content)
                    .padding(horizontal = 10.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text("${attachment.name} · ${formatBytes(attachment.size)}", color = palette.onBackground, fontSize = 12.sp, maxLines = 1)
                Icon(ZephyrIcons.Close, "移除", tint = palette.onFloatingSubtle, modifier = Modifier.size(14.dp).clickable { onRemove(attachment.id) })
            }
        }
    }
}

@Composable
private fun AiCapsuleComposer(
    model: String,
    running: Boolean,
    enabled: Boolean,
    thinkingOpen: Boolean,
    onSend: (String) -> Unit,
    onStop: () -> Unit,
    onOpenSheet: () -> Unit,
    onToggleThinking: () -> Unit,
) {
    val palette = ZephyrTheme.palette
    var text by remember { mutableStateOf("") }
    val canSend = enabled && text.isNotBlank() && !running
    Row(
        Modifier.fillMaxWidth()
            .navigationBarsPadding().imePadding()
            .padding(horizontal = 12.dp, vertical = 8.dp)
            .clip(RoundedCornerShape(26.dp))
            .background(palette.surfaces.content.copy(alpha = 0.92f))
            .border(BorderStroke(1.dp, palette.surfaces.outlineSoft), RoundedCornerShape(26.dp))
            .padding(horizontal = 6.dp, vertical = 6.dp),
        verticalAlignment = Alignment.Bottom,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        AiRoundButton(ZephyrIcons.Plus, "功能与附件", onOpenSheet)
        BasicTextField(
            value = text,
            onValueChange = { text = it.take(40_000) },
            enabled = enabled && !running,
            modifier = Modifier.weight(1f).padding(vertical = 8.dp),
            textStyle = TextStyle(color = palette.onBackground, fontSize = 14.sp),
            cursorBrush = SolidColor(palette.brand.accent),
            maxLines = 6,
            decorationBox = { input ->
                Box(contentAlignment = Alignment.CenterStart) {
                    if (text.isEmpty()) Text(AiWorkspaceCopy.askPlaceholder(model), color = palette.onFloatingSubtle, fontSize = 14.sp, maxLines = 1)
                    input()
                }
            },
        )
        val buttonColor = when {
            running -> palette.status.error
            canSend -> palette.brand.accent
            else -> palette.surfaces.outlineSoft
        }
        Box(
            Modifier.size(36.dp).clip(CircleShape).background(buttonColor)
                .pointerInput(running, thinkingOpen) {
                    detectDragGesturesAfterLongPress(
                        onDragStart = { onToggleThinking() },
                        onDrag = { _, _ -> },
                        onDragEnd = {},
                    )
                }
                .clickable {
                    if (running) onStop()
                    else if (canSend) {
                        val prompt = text.trim()
                        text = ""
                        onSend(prompt)
                    }
                },
            contentAlignment = Alignment.Center,
        ) {
            if (running) {
                Box(Modifier.size(12.dp).clip(RoundedCornerShape(2.dp)).background(Color.White))
            } else {
                Icon(ZephyrIcons.ArrowUp, "发送", tint = Color.White, modifier = Modifier.size(16.dp))
            }
        }
    }
}

@Composable
private fun AiActionSheet(
    onAttach: () -> Unit,
    onUsage: () -> Unit,
    onCompress: () -> Unit,
    onClear: () -> Unit,
    onSettings: () -> Unit,
    onDismiss: () -> Unit,
) {
    val palette = ZephyrTheme.palette
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.BottomCenter) {
        Box(Modifier.fillMaxSize().background(palette.surfaces.scrim).clickable(onClick = onDismiss))
        Column(
            Modifier.fillMaxWidth().navigationBarsPadding()
                .clip(RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp))
                .background(palette.surfaces.elevated)
                .padding(horizontal = 16.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Box(Modifier.align(Alignment.CenterHorizontally).padding(bottom = 8.dp).size(width = 38.dp, height = 5.dp).clip(RoundedCornerShape(999.dp)).background(palette.surfaces.outlineSoft))
            Row(Modifier.fillMaxWidth().padding(bottom = 6.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Text("工具与能力", color = palette.onBackground, fontWeight = FontWeight.Bold, fontSize = 15.sp)
                AiRoundButton(ZephyrIcons.Close, "关闭", onDismiss)
            }
            AiSheetRow("添加附件", "图片与文件", onAttach)
            AiSheetRow("Token 用量统计", "查看消耗", onUsage)
            AiSheetRow("压缩上下文摘要", "节省 Token", onCompress)
            AiSheetRow("AI 设置", "供应商与模型", onSettings)
            AiSheetRow("清空当前对话", "不可撤销", onClear, danger = true)
        }
    }
}

@Composable
private fun AiSheetRow(title: String, hint: String, onClick: () -> Unit, danger: Boolean = false) {
    val palette = ZephyrTheme.palette
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).clickable(onClick = onClick).padding(horizontal = 8.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(title, color = if (danger) palette.status.error else palette.onBackground, fontSize = 14.sp)
        Text(hint, color = palette.onFloatingSubtle, fontSize = 12.sp)
    }
}

@Composable
private fun AiThinkingPopover(
    chrome: AiWorkspaceChrome,
    onPick: (AiPicker) -> Unit,
    onDismiss: () -> Unit,
) {
    val palette = ZephyrTheme.palette
    Box(Modifier.fillMaxSize()) {
        Box(Modifier.fillMaxSize().clickable(onClick = onDismiss))
        Column(
            Modifier.align(Alignment.BottomEnd)
                .padding(end = 16.dp, bottom = 72.dp)
                .width(300.dp)
                .clip(RoundedCornerShape(20.dp))
                .background(palette.surfaces.elevated)
                .border(BorderStroke(1.dp, palette.surfaces.outlineSoft), RoundedCornerShape(20.dp))
                .padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Text("模型推理与模式配置", color = palette.onBackground, fontWeight = FontWeight.SemiBold, fontSize = 13.sp)
                Text(chrome.thinking, color = palette.brand.accent, fontSize = 11.sp, fontWeight = FontWeight.Bold)
            }
            AiThinkingSection("思考深度") { onPick(AiPicker.THINKING) }
            AiThinkingSection("协作模式 · ${chrome.collaboration}") { onPick(AiPicker.MODE) }
            AiThinkingSection("运行模式 · ${chrome.runProfile}") { onPick(AiPicker.RUN_PROFILE) }
            AiThinkingSection("权限模式 · ${chrome.permission}") { onPick(AiPicker.PERMISSION) }
            AiThinkingSection("供应商与模型") { onPick(AiPicker.PROVIDER) }
        }
    }
}

@Composable
private fun AiThinkingSection(label: String, onClick: () -> Unit) {
    val palette = ZephyrTheme.palette
    Text(
        label,
        color = palette.onBackground,
        fontSize = 13.sp,
        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).clickable(onClick = onClick).padding(vertical = 6.dp),
    )
}
