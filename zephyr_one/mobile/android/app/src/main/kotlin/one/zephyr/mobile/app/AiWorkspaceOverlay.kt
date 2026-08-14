package one.zephyr.mobile.app

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import one.zephyr.mobile.ui.component.Icon
import one.zephyr.mobile.ui.component.Surface
import one.zephyr.mobile.ui.component.Text
import one.zephyr.mobile.ui.component.pressScale
import one.zephyr.mobile.ui.icon.ZephyrIcons
import one.zephyr.mobile.ui.theme.ZephyrMotionTokens
import one.zephyr.mobile.ui.theme.ZephyrRadius
import one.zephyr.mobile.ui.theme.ZephyrTheme

private enum class AiDetent(val fraction: Float) {
    CLOSED(0.55f),
    PEEK(0.30f),
    HALF(0.55f),
    EXPANDED(0.92f),
}

@Composable
internal fun AiWorkspaceOverlay(
    onOpenSettings: () -> Unit,
    onNotice: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    var detent by remember { mutableStateOf(AiDetent.CLOSED) }
    var dragHeight by remember { mutableStateOf<Dp?>(null) }
    var approved by remember { mutableStateOf(false) }
    var runVisible by remember { mutableStateOf(false) }
    val motion = ZephyrTheme.motion
    val palette = ZephyrTheme.palette
    val density = LocalDensity.current

    BackHandler(enabled = detent != AiDetent.CLOSED) {
        detent = AiDetent.CLOSED
    }

    LaunchedEffect(approved) {
        if (!approved) return@LaunchedEffect
        runVisible = true
        delay(4_000)
        runVisible = false
    }

    Box(modifier.fillMaxSize()) {
        AnimatedVisibility(
            visible = detent != AiDetent.CLOSED,
            modifier = Modifier.fillMaxSize(),
            enter = fadeIn(tween(durationMillis = 1)),
            exit = fadeOut(
                tween(
                    durationMillis = 1,
                    delayMillis = motion.scale(ZephyrMotionTokens.SHEET_MS),
                ),
            ),
        ) {
            BoxWithConstraints(Modifier.fillMaxSize()) {
                val containerHeight = maxHeight
                val targetHeight = containerHeight * detent.fraction
                val animatedHeight by animateDpAsState(
                    targetValue = targetHeight,
                    animationSpec = tween(
                        durationMillis = motion.scale(ZephyrMotionTokens.SHEET_MS),
                        easing = ZephyrMotionTokens.easeDrawer,
                    ),
                    label = "aiSheetHeight",
                )
                val sheetHeight = dragHeight ?: animatedHeight

        AnimatedVisibility(
            visible = detent == AiDetent.EXPANDED,
            enter = fadeIn(tween(motion.scale(ZephyrMotionTokens.SHEET_MS))),
            exit = fadeOut(tween(motion.scale(ZephyrMotionTokens.SHEET_MS))),
        ) {
            Box(
                Modifier
                    .fillMaxSize()
                    .background(palette.surfaces.scrim)
                    .clickable(
                        indication = null,
                        interactionSource = remember { MutableInteractionSource() },
                    ) { detent = AiDetent.PEEK },
            )
        }

        val open = detent != AiDetent.CLOSED
        val slide by androidx.compose.animation.core.animateFloatAsState(
            targetValue = if (open) 0f else 1.05f,
            animationSpec = tween(
                durationMillis = motion.scale(ZephyrMotionTokens.SHEET_MS),
                easing = ZephyrMotionTokens.easeDrawer,
            ),
            label = "aiSheetSlide",
        )

                Column(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .height(sheetHeight)
                .graphicsLayer { translationY = size.height * slide }
                .shadow(24.dp, RoundedCornerShape(topStart = ZephyrRadius.xl, topEnd = ZephyrRadius.xl))
                .clip(RoundedCornerShape(topStart = ZephyrRadius.xl, topEnd = ZephyrRadius.xl))
                .background(palette.surfaces.elevated),
                ) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(21.dp)
                    .pointerInput(containerHeight) {
                        detectVerticalDragGestures(
                            onDragStart = { dragHeight = sheetHeight },
                            onVerticalDrag = { change, dragAmount ->
                                change.consume()
                                val delta = with(density) { dragAmount.toDp() }
                                dragHeight = ((dragHeight ?: sheetHeight) - delta)
                                    .coerceIn(containerHeight * 0.21f, containerHeight * AiDetent.EXPANDED.fraction)
                            },
                            onDragCancel = { dragHeight = null },
                            onDragEnd = {
                                val fraction = (dragHeight ?: sheetHeight).value / containerHeight.value
                                detent = listOf(AiDetent.PEEK, AiDetent.HALF, AiDetent.EXPANDED)
                                    .minBy { kotlin.math.abs(it.fraction - fraction) }
                                dragHeight = null
                            },
                        )
                    },
                contentAlignment = Alignment.Center,
            ) {
                Box(
                    Modifier
                        .width(38.dp)
                        .height(5.dp)
                        .clip(RoundedCornerShape(3.dp))
                        .background(palette.onFloatingSubtle.copy(alpha = 0.5f)),
                )
            }

            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp)
                    .clip(RoundedCornerShape(ZephyrRadius.sm))
                    .background(palette.brand.accent.copy(alpha = 0.10f))
                    .padding(horizontal = 12.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Icon(ZephyrIcons.Sessions, contentDescription = null, tint = palette.brand.accent, modifier = Modifier.size(13.dp))
                Text("上下文", color = palette.brand.accent, fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold)
                Text(
                    "SSH · prod-web-01",
                    color = palette.brand.accent.copy(alpha = 0.85f),
                    fontSize = 12.sp,
                    fontFamily = FontFamily.Monospace,
                )
                Text(
                    "· 底层页面持续可见",
                    color = palette.brand.accent,
                    fontSize = 12.5.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Clip,
                )
            }

            AiToolStrip(
                onOpenSettings = {
                    detent = AiDetent.CLOSED
                    onOpenSettings()
                },
                onNotice = onNotice,
            )

            if (runVisible) {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 0.dp)
                        .clip(RoundedCornerShape(ZephyrRadius.sm))
                        .background(palette.status.pendingSync.copy(alpha = 0.10f))
                        .padding(horizontal = 12.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text("正在执行 · terminal.execute", color = palette.status.pendingSync, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                    Text("停止", color = palette.status.error, fontSize = 12.sp, fontWeight = FontWeight.Bold, modifier = Modifier.clickable { runVisible = false })
                    Text("接管", color = palette.onFloatingMuted, fontSize = 12.sp, fontWeight = FontWeight.Bold, modifier = Modifier.clickable { runVisible = false })
                }
                Spacer(Modifier.height(10.dp))
            }

            Column(
                modifier = Modifier
                    .weight(1f)
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 16.dp, vertical = 2.dp),
            ) {
                AiMessage(
                    text = "看下 prod-web-01 磁盘为什么涨到 82%",
                    user = true,
                    modifier = Modifier.align(Alignment.End),
                )
                AiMessage(
                    text = "我先跑只读命令定位大户。计划：\n1. du -x --max-depth=1 /\n2. 找出 7 天内增长最快的目录\n全程只读，不需要写权限。",
                    user = false,
                    modifier = Modifier.align(Alignment.Start),
                )
                AiToolTrace(
                    approved = approved,
                    onDeny = { onNotice("已拒绝 · 未执行") },
                    onApprove = { approved = true },
                )
                if (approved) {
                    AiMessage(
                        text = "执行完成 · 已验证输出\n/var/log 涨了 9.4G，元凶是 nginx access.log 未轮转。要我生成 logrotate 配置片段吗？（写操作会再单独确认）",
                        user = false,
                        modifier = Modifier.align(Alignment.Start),
                    )
                }
            }

            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(palette.surfaces.elevated)
                    .padding(start = 16.dp, end = 16.dp, top = 10.dp, bottom = 12.dp)
                    .navigationBarsPadding(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(
                    Modifier
                        .weight(1f)
                        .height(40.dp)
                        .clip(RoundedCornerShape(20.dp))
                        .background(palette.surfaces.content)
                        .border(BorderStroke(1.dp, palette.surfaces.outlineSoft), RoundedCornerShape(20.dp))
                        .padding(horizontal = 16.dp),
                    contentAlignment = Alignment.CenterStart,
                ) {
                    Text("向 Zephyr AI 提问 · Claude Opus", color = palette.onFloatingSubtle, fontSize = 14.sp, maxLines = 1)
                }
                val sendInteraction = remember { MutableInteractionSource() }
                Box(
                    Modifier
                        .size(40.dp)
                        .pressScale(0.9f, interaction = sendInteraction)
                        .clip(CircleShape)
                        .background(palette.brand.accent)
                        .clickable(interactionSource = sendInteraction, indication = null) { onNotice("需要联网才能发送") },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(ZephyrIcons.ArrowUp, contentDescription = "发送", tint = androidx.compose.ui.graphics.Color.White, modifier = Modifier.size(16.dp))
                }
            }
                }
            }
        }

        AnimatedVisibility(
            visible = detent == AiDetent.CLOSED,
            modifier = Modifier.align(Alignment.BottomEnd),
            enter = fadeIn(tween(motion.scale(ZephyrMotionTokens.MED_MS))) +
                scaleIn(
                    initialScale = 0.9f,
                    animationSpec = tween(motion.scale(ZephyrMotionTokens.MED_MS), easing = ZephyrMotionTokens.easeOut),
                ),
            exit = fadeOut(tween(motion.scale(ZephyrMotionTokens.MED_MS))) +
                scaleOut(
                    targetScale = 0.9f,
                    animationSpec = tween(motion.scale(ZephyrMotionTokens.MED_MS), easing = ZephyrMotionTokens.easeOut),
                ),
        ) {
            val interaction = remember { MutableInteractionSource() }
            Surface(
                modifier = Modifier
                    .navigationBarsPadding()
                    .padding(end = 16.dp, bottom = 96.dp)
                    .size(50.dp)
                    .shadow(12.dp, CircleShape, ambientColor = palette.islandShadow, spotColor = palette.islandShadow)
                    .pressScale(ZephyrMotionTokens.PRESS_SCALE_HARD, interaction = interaction)
                    .clip(CircleShape)
                    .clickable(
                        interactionSource = interaction,
                        indication = null,
                        role = Role.Button,
                    ) { detent = AiDetent.HALF },
                shape = CircleShape,
                color = palette.surfaces.floating,
                contentColor = palette.brand.accent,
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(ZephyrIcons.AiSpark, contentDescription = "Zephyr AI", modifier = Modifier.size(22.dp))
                }
            }
        }
    }
}

@Composable
private fun AiToolStrip(onOpenSettings: () -> Unit, onNotice: (String) -> Unit) {
    var model by remember { mutableStateOf("Claude Opus") }
    var collaboration by remember { mutableStateOf("协作") }
    var permission by remember { mutableStateOf("按能力确认") }
    var thinking by remember { mutableStateOf("medium") }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = 16.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        AiChip("模型", model) { model = next(model, listOf("Claude Opus", "Claude Sonnet", "GPT-5", "Gemini 3 Pro")) }
        AiChip("协作", collaboration) { collaboration = next(collaboration, listOf("协作", "自动", "只读")) }
        AiChip("权限", permission) { permission = next(permission, listOf("按能力确认", "自动确认", "全部询问")) }
        AiChip("思考", thinking) { thinking = next(thinking, listOf("关闭", "low", "medium", "high")) }
        AiChip("附件") { onNotice("附件 · 图片/文件，RDP/VNC 走图片输入") }
        AiChip("计划") { onNotice("计划 · 复杂任务先规划") }
        AiChip("Memory/Skills") { onNotice("Memory 12 条 · Skills 启用 · Env 仅变量名") }
        AiChip("设置", onClick = onOpenSettings)
    }
}

@Composable
private fun AiChip(label: String, value: String? = null, onClick: () -> Unit) {
    val palette = ZephyrTheme.palette
    val interaction = remember { MutableInteractionSource() }
    Row(
        modifier = Modifier
            .height(28.dp)
            .pressScale(0.94f, interaction = interaction)
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
private fun AiMessage(text: String, user: Boolean, modifier: Modifier = Modifier) {
    val palette = ZephyrTheme.palette
    Box(
        modifier = modifier
            .fillMaxWidth(0.86f)
            .padding(bottom = 10.dp)
            .clip(
                RoundedCornerShape(
                    topStart = 16.dp,
                    topEnd = 16.dp,
                    bottomStart = if (user) 16.dp else 5.dp,
                    bottomEnd = if (user) 5.dp else 16.dp,
                ),
            )
            .background(if (user) palette.brand.accent else palette.surfaces.content)
            .then(
                if (user) Modifier else Modifier.border(
                    BorderStroke(1.dp, palette.surfaces.outlineSoft),
                    RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp, bottomStart = 5.dp, bottomEnd = 16.dp),
                ),
            )
            .padding(horizontal = 13.dp, vertical = 10.dp),
    ) {
        Text(
            text,
            color = if (user) androidx.compose.ui.graphics.Color.White else palette.onBackground,
            style = TextStyle(fontSize = 13.5.sp, lineHeight = 20.sp),
        )
    }
}

@Composable
private fun AiToolTrace(approved: Boolean, onDeny: () -> Unit, onApprove: () -> Unit) {
    val palette = ZephyrTheme.palette
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
            if (approved) "已执行 · 退出码 0 · 1.2s" else "待确认 · terminal.execute · 风险：低",
            color = if (approved) palette.status.success else palette.onFloatingMuted,
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
                "du -x --max-depth=1 / 2>/dev/null | sort -rn | head -12",
                color = androidx.compose.ui.graphics.Color(0xFF7EE787),
                fontFamily = FontFamily.Monospace,
                fontSize = 11.5.sp,
                maxLines = 1,
                overflow = TextOverflow.Clip,
            )
        }
        if (!approved) {
            Row(Modifier.fillMaxWidth().padding(top = 9.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                AiTraceButton("拒绝", palette.status.error, palette.surfaces.elevated, onDeny, Modifier.weight(1f))
                AiTraceButton("允许执行", androidx.compose.ui.graphics.Color.White, palette.brand.accent, onApprove, Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun AiTraceButton(
    label: String,
    foreground: androidx.compose.ui.graphics.Color,
    background: androidx.compose.ui.graphics.Color,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val interaction = remember { MutableInteractionSource() }
    Box(
        modifier
            .height(34.dp)
            .pressScale(0.96f, interaction = interaction)
            .clip(RoundedCornerShape(9.dp))
            .background(background)
            .clickable(interactionSource = interaction, indication = null, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(label, color = foreground, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
    }
}

private fun next(value: String, values: List<String>): String =
    values[(values.indexOf(value).coerceAtLeast(0) + 1) % values.size]
