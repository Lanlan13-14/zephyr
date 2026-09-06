package one.zephyr.mobile.ui.island

import android.view.HapticFeedbackConstants
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectable
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.util.fastCoerceIn
import androidx.compose.ui.util.fastRoundToInt
import androidx.compose.ui.util.lerp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import one.zephyr.mobile.ui.component.Icon
import one.zephyr.mobile.ui.component.Text
import one.zephyr.mobile.ui.glass.Highlight
import one.zephyr.mobile.ui.glass.InnerShadow
import one.zephyr.mobile.ui.glass.LocalBackdrop
import one.zephyr.mobile.ui.glass.Shadow
import one.zephyr.mobile.ui.glass.blur
import one.zephyr.mobile.ui.glass.drawBackdrop
import one.zephyr.mobile.ui.glass.interactive.DampedDragAnimation
import one.zephyr.mobile.ui.glass.lens
import one.zephyr.mobile.ui.glass.rememberCombinedBackdrop
import one.zephyr.mobile.ui.glass.rememberLayerBackdrop
import one.zephyr.mobile.ui.glass.shape.Capsule
import one.zephyr.mobile.ui.glass.vibrancy
import one.zephyr.mobile.ui.theme.IslandSpec
import one.zephyr.mobile.ui.theme.ZephyrMotionTokens
import one.zephyr.mobile.ui.theme.ZephyrTextStyles
import one.zephyr.mobile.ui.theme.ZephyrTheme
import kotlin.math.roundToInt

/** Demo `#island`: 62-high chrome capsule, 340ms ease-out pill, 23→17 icon, label 180ms. */
@Composable
fun FloatingIsland(
    selected: IslandDestination,
    onSelect: (IslandDestination) -> Unit,
    modifier: Modifier = Modifier,
    destinations: List<IslandDestination> = IslandDestination.ordered,
) {
    val palette = ZephyrTheme.palette
    val motion = ZephyrTheme.motion
    val view = LocalView.current
    val density = LocalDensity.current
    val labels = destinations.map { stringResource(it.labelRes) }
    val selectedIndex = destinations.indexOf(selected).coerceAtLeast(0)

    val safeBottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    val bottomGap = IslandGeometry.bottomGap(safeBottom.value, IslandSpec.bottomGap.value).dp

    BoxWithConstraints(
        modifier = modifier
            .fillMaxWidth()
            .padding(bottom = bottomGap),
        contentAlignment = Alignment.BottomCenter,
    ) {
        val outerWidth = IslandGeometry.outerWidth(
            screenWidthDp = maxWidth.value,
            widthFraction = IslandSpec.widthFraction,
            maxWidthDp = IslandSpec.maxWidth.value,
        )
        val innerWidth = IslandGeometry.innerWidth(outerWidth, IslandSpec.innerPadding.value)
        val slotWidth = IslandGeometry.slotWidth(innerWidth, destinations.size)
        val contentBackdrop = LocalBackdrop.current
        val capsuleBackdrop = rememberLayerBackdrop()
        val selectedBackdrop = rememberCombinedBackdrop(contentBackdrop, capsuleBackdrop)
        val outerShape = Capsule()
        val pillShape = Capsule()
        val isDark = palette.dark
        val containerColor = if (isDark) {
            Color(0xFF121212).copy(alpha = 0.4f)
        } else {
            Color(0xFFFAFAFA).copy(alpha = 0.4f)
        }
        val animationScope = rememberCoroutineScope()
        val dampedDragAnimation = remember(animationScope, destinations.size) {
            DampedDragAnimation(
                animationScope = animationScope,
                initialValue = selectedIndex.toFloat(),
                valueRange = 0f..(destinations.size - 1).coerceAtLeast(0).toFloat(),
                visibilityThreshold = 0.001f,
                initialScale = 1f,
                pressedScale = 78f / 56f,
                onDragStarted = {},
                onDragStopped = {
                    val targetIndex = targetValue
                        .fastRoundToInt()
                        .fastCoerceIn(0, destinations.size - 1)
                    if (targetIndex != selectedIndex) {
                        onSelect(destinations[targetIndex])
                    }
                    animateToValue(targetIndex.toFloat())
                },
                onDrag = { _, dragAmount ->
                    updateValue(
                        (targetValue + dragAmount.x / (slotWidth * density.density))
                            .fastCoerceIn(0f, (destinations.size - 1).coerceAtLeast(0).toFloat()),
                    )
                },
            )
        }
        LaunchedEffect(selectedIndex) {
            if (dampedDragAnimation.targetValue != selectedIndex.toFloat()) {
                dampedDragAnimation.animateToValue(selectedIndex.toFloat())
            }
        }

        Box(
            modifier = Modifier
                .width(outerWidth.dp)
                .height(IslandSpec.outerHeight)
                .drawBackdrop(
                    backdrop = contentBackdrop,
                    shape = { outerShape },
                    effects = {
                        vibrancy()
                        blur(8f.dp.toPx())
                        lens(
                            refractionHeight = 24f.dp.toPx(),
                            refractionAmount = 24f.dp.toPx(),
                        )
                    },
                    layerBlock = {
                        val progress = dampedDragAnimation.pressProgress
                        val scale = lerp(1f, 1f + 16f.dp.toPx() / size.width, progress)
                        scaleX = scale
                        scaleY = scale
                    },
                    onDrawSurface = { drawRect(containerColor) },
                    exportedBackdrop = capsuleBackdrop,
                )
                .clip(outerShape)
                .padding(IslandSpec.innerPadding),
        ) {
            Box(
                modifier = Modifier
                    .offset {
                        IntOffset(
                            x = (dampedDragAnimation.value * slotWidth * density.density).roundToInt(),
                            y = 0,
                        )
                    }
                    .then(dampedDragAnimation.gesturelessModifier)
                    .width(slotWidth.dp)
                    .height(IslandSpec.selectedPillHeight)
                    .drawBackdrop(
                        backdrop = selectedBackdrop,
                        shape = { pillShape },
                        effects = {
                            val progress = dampedDragAnimation.pressProgress
                            lens(
                                refractionHeight = 10f.dp.toPx() * progress,
                                refractionAmount = 14f.dp.toPx() * progress,
                                chromaticAberration = true,
                            )
                        },
                        highlight = {
                            Highlight.Default.copy(alpha = dampedDragAnimation.pressProgress)
                        },
                        shadow = {
                            Shadow(alpha = dampedDragAnimation.pressProgress)
                        },
                        innerShadow = {
                            InnerShadow(
                                radius = 8f.dp * dampedDragAnimation.pressProgress,
                                alpha = dampedDragAnimation.pressProgress,
                            )
                        },
                        layerBlock = {
                            scaleX = dampedDragAnimation.scaleX
                            scaleY = dampedDragAnimation.scaleY
                            val velocity = dampedDragAnimation.velocity / 10f
                            scaleX /= 1f - (velocity * 0.75f).fastCoerceIn(-0.2f, 0.2f)
                            scaleY *= 1f - (velocity * 0.25f).fastCoerceIn(-0.2f, 0.2f)
                        },
                        onDrawSurface = {
                            val progress = dampedDragAnimation.pressProgress
                            drawRect(Color.White.copy(alpha = 0.1f * (1f - progress)))
                            drawRect(Color.Black.copy(alpha = 0.03f * progress))
                        },
                    )
                    .clip(pillShape),
            )

            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                destinations.forEachIndexed { index, destination ->
                    val isSelected = index == selectedIndex
                    val interaction = remember { MutableInteractionSource() }
                    val pressed by interaction.collectIsPressedAsState()
                    val pressScale by animateFloatAsState(
                        targetValue = if (pressed) IslandSpec.PRESS_SCALE else 1f,
                        animationSpec = tween(
                            motion.scale(IslandSpec.PRESS_FEEDBACK_MS),
                            easing = ZephyrMotionTokens.easeOut,
                        ),
                        label = "islandPress",
                    )
                    val iconSize by animateDpAsState(
                        targetValue = if (isSelected) IslandSpec.selectedIconSize else IslandSpec.iconSize,
                        animationSpec = tween(
                            motion.scale(ZephyrMotionTokens.MED_MS),
                            easing = ZephyrMotionTokens.easeOut,
                        ),
                        label = "islandIconSize",
                    )
                    val labelAlpha by animateFloatAsState(
                        targetValue = if (isSelected) 1f else 0f,
                        animationSpec = tween(motion.scale(IslandSpec.LABEL_CROSSFADE_MS)),
                        label = "islandLabel",
                    )

                    Column(
                        modifier = Modifier
                            .width(slotWidth.dp)
                            .height(IslandSpec.selectedPillHeight)
                            .sizeIn(minWidth = IslandSpec.minTouchTarget, minHeight = IslandSpec.minTouchTarget)
                            .scale(pressScale)
                            .pointerInput(index, destinations.size) {
                                detectHorizontalDragGestures(
                                    onDragStart = {
                                        dampedDragAnimation.press()
                                    },
                                    onDragEnd = {
                                        dampedDragAnimation.onDragStopped()
                                        dampedDragAnimation.release()
                                    },
                                    onDragCancel = {
                                        dampedDragAnimation.onDragStopped()
                                        dampedDragAnimation.release()
                                    },
                                ) { change, dragAmount ->
                                    change.consume()
                                    dampedDragAnimation.onDrag(size, Offset(dragAmount.x, 0f))
                                }
                            }
                            .selectable(
                                selected = isSelected,
                                interactionSource = interaction,
                                indication = null,
                                role = Role.Tab,
                                onClick = {
                                    if (!isSelected) {
                                        view.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
                                        onSelect(destination)
                                        dampedDragAnimation.animateToValue(index.toFloat())
                                    }
                                },
                            ),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.Center,
                    ) {
                        Icon(
                            imageVector = destination.icon,
                            contentDescription = labels[index],
                            tint = if (isSelected) palette.brand.accent else palette.onFloatingSubtle,
                            modifier = Modifier.size(iconSize),
                        )
                        if (isSelected) {
                            Text(
                                text = labels[index],
                                style = ZephyrTextStyles.islandLabel,
                                color = palette.brand.accent,
                                maxLines = 1,
                                overflow = TextOverflow.Visible,
                                modifier = Modifier
                                    .padding(top = IslandSpec.iconLabelGap)
                                    .alpha(labelAlpha),
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun islandContentBottomInset(): androidx.compose.ui.unit.Dp {
    val safeBottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    return IslandGeometry.contentBottomInset(
        outerHeightDp = IslandSpec.outerHeight.value,
        contentGapDp = IslandSpec.contentGap.value,
        safeAreaBottomDp = safeBottom.value,
        fixedGapDp = IslandSpec.bottomGap.value,
    ).dp
}
