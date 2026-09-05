package one.zephyr.mobile.ui.island

import android.view.HapticFeedbackConstants
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.DpOffset
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
import one.zephyr.mobile.ui.glass.lens
import one.zephyr.mobile.ui.glass.rememberCombinedBackdrop
import one.zephyr.mobile.ui.glass.rememberLayerBackdrop
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
    val position = remember { Animatable(selectedIndex.toFloat()) }

    LaunchedEffect(selectedIndex, motion.reduceMotion) {
        if (motion.reduceMotion) {
            position.snapTo(selectedIndex.toFloat())
        } else {
            position.animateTo(
                targetValue = selectedIndex.toFloat(),
                animationSpec = tween(
                    durationMillis = motion.scale(IslandSpec.SELECTION_MS),
                    easing = ZephyrMotionTokens.easeOut,
                ),
            )
        }
    }

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
        val outerShape = RoundedCornerShape(IslandSpec.outerHeight / 2)
        val pillShape = RoundedCornerShape(IslandSpec.selectedPillRadius)
        val isDark = palette.dark

        Box(
            modifier = Modifier
                .width(outerWidth.dp)
                .height(IslandSpec.outerHeight)
                .drawBackdrop(
                    backdrop = contentBackdrop,
                    shape = { outerShape },
                    effects = {
                        blur(8f.dp.toPx())
                        lens(
                            refractionHeight = 12f.dp.toPx(),
                            refractionAmount = 24f.dp.toPx(),
                            chromaticAberration = true,
                        )
                    },
                    highlight = {
                        Highlight.Default.copy(alpha = if (isDark) 0.6f else 1f)
                    },
                    shadow = {
                        Shadow(
                            radius = 32f.dp,
                            offset = DpOffset(0f.dp, 16f.dp),
                            color = Color.Black.copy(alpha = if (isDark) 0.4f else 0.16f),
                        )
                    },
                    innerShadow = {
                        InnerShadow(
                            radius = 8f.dp,
                            color = Color.Black.copy(alpha = if (isDark) 0.5f else 0.2f),
                        )
                    },
                    onDrawSurface = {
                        val tint = if (isDark) {
                            Color(0xFF202020).copy(alpha = 0.10f)
                        } else {
                            Color.White.copy(alpha = 0.10f)
                        }
                        drawRect(tint)
                    },
                    exportedBackdrop = capsuleBackdrop,
                )
                .clip(outerShape)
                .padding(IslandSpec.innerPadding),
        ) {
            Box(
                modifier = Modifier
                    .offset {
                        IntOffset(
                            x = (position.value * slotWidth * density.density).roundToInt(),
                            y = 0,
                        )
                    }
                    .width(slotWidth.dp)
                    .height(IslandSpec.selectedPillHeight)
                    .graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }
                    .drawBackdrop(
                        backdrop = selectedBackdrop,
                        shape = { pillShape },
                        effects = {
                            lens(
                                refractionHeight = 10f.dp.toPx(),
                                refractionAmount = 14f.dp.toPx(),
                                chromaticAberration = true,
                            )
                        },
                        highlight = { Highlight.Default },
                        shadow = null,
                        innerShadow = {
                            InnerShadow(
                                radius = 8f.dp,
                                color = Color.Black.copy(alpha = 0.8f),
                            )
                        },
                        onDrawSurface = {
                            drawRect(Color.White.copy(alpha = 0.08f))
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
                            .selectable(
                                selected = isSelected,
                                interactionSource = interaction,
                                indication = null,
                                role = Role.Tab,
                                onClick = {
                                    if (!isSelected) {
                                        view.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
                                        onSelect(destination)
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
