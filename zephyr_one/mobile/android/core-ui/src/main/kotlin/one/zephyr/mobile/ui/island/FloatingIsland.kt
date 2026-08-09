package one.zephyr.mobile.ui.island

import android.view.HapticFeedbackConstants
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
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
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import one.zephyr.mobile.ui.theme.IslandSpec
import one.zephyr.mobile.ui.theme.ZephyrTheme
import kotlin.math.roundToInt

/**
 * The bottom floating island.
 *
 * Implements DEVELOPMENT.md 6.1.1 and 6.1.2 literally. The parts that are easy to get wrong, and the
 * reason each is done this way:
 *
 *  - **Interruptible selection.** The pill position is a single [Animatable] over a *fractional*
 *    destination index, animated with [Animatable.animateTo], which always continues from the current
 *    value. The spec forbids a keyframe animation that replays from the start when the user taps
 *    twice quickly, and this is the only structure that cannot accidentally do that.
 *  - **Critical damping.** dampingRatio 1.0 with stiffness derived from the frozen 0.28s response
 *    (see [IslandSpec.selectionStiffness]), so there is no overshoot on a navigation control.
 *  - **Label crossfade is separate.** Labels fade on their own 140ms tween rather than riding the
 *    280ms positional spring, because the spec caps the crossfade independently.
 *  - **Haptic only on real change.** Re-tapping the current destination must not buzz, so the
 *    feedback call sits behind an index comparison rather than inside the click handler.
 *  - **Never auto-hides.** There is no scroll connection here at all. Hiding is the caller's job and
 *    only for an immersive session or an open IME.
 */
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
    val measurer = rememberTextMeasurer()
    val labelStyle = ZephyrTheme.typography.islandLabel

    // Resolved here rather than inside the measure block: stringResource is composable, and the
    // labels are needed by the pill geometry, the icon description and the visible text alike.
    val labels = destinations.map { destination -> stringResource(destination.labelRes) }

    val selectedIndex = destinations.indexOf(selected).coerceAtLeast(0)
    val position = remember { Animatable(selectedIndex.toFloat()) }

    LaunchedEffect(selectedIndex, motion.reduceMotion) {
        if (motion.reduceMotion) {
            // Reduce Motion removes the positional spring entirely; the pill simply appears at the
            // new slot and only the colour/label crossfade communicates the change.
            position.snapTo(selectedIndex.toFloat())
        } else {
            position.animateTo(
                targetValue = selectedIndex.toFloat(),
                animationSpec = spring(
                    dampingRatio = IslandSpec.SELECTION_DAMPING_RATIO,
                    stiffness = IslandSpec.selectionStiffness,
                ),
            )
        }
    }

    val safeBottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    val bottomGap = IslandGeometry.bottomGap(safeBottom.value, IslandSpec.minBottomGap.value).dp

    BoxWithConstraints(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = IslandSpec.sideInset)
            .padding(bottom = bottomGap),
        contentAlignment = Alignment.BottomCenter,
    ) {
        val outerWidthDp = IslandGeometry.outerWidth(
            screenWidthDp = maxWidth.value + IslandSpec.sideInset.value * 2f,
            sideInsetDp = IslandSpec.sideInset.value,
            maxWidthDp = IslandSpec.maxWidth.value,
        )
        val innerWidthDp = IslandGeometry.innerWidth(outerWidthDp, IslandSpec.innerPadding.value)
        val slotWidthDp = IslandGeometry.slotWidth(innerWidthDp, destinations.size)

        // Measured once per label set, not per frame: the pill width is content-driven and a
        // re-measure inside the animation loop would make the spring stutter.
        val labelWidthsDp = remember(labels, labelStyle, density) {
            labels.map { label ->
                val measured = measurer.measure(text = label, style = labelStyle)
                measured.size.width / density.density
            }
        }

        val pillWidthsDp = labelWidthsDp.map { labelWidth ->
            IslandGeometry.pillWidth(
                slotWidthDp = slotWidthDp,
                labelWidthDp = labelWidth,
                iconSizeDp = IslandSpec.iconSize.value,
                iconLabelGapDp = IslandSpec.iconLabelGap.value,
                horizontalPaddingDp = IslandSpec.pillHorizontalPadding.value,
            )
        }
        val labelsVisible = labelWidthsDp.mapIndexed { index, labelWidth ->
            IslandGeometry.labelFits(
                slotWidthDp = slotWidthDp,
                labelWidthDp = labelWidth,
                iconSizeDp = IslandSpec.iconSize.value,
                iconLabelGapDp = IslandSpec.iconLabelGap.value,
                horizontalPaddingDp = IslandSpec.pillHorizontalPadding.value,
            )
        }

        val fraction = position.value.coerceIn(0f, (destinations.size - 1).toFloat())
        val lowIndex = fraction.toInt().coerceIn(0, destinations.size - 1)
        val highIndex = (lowIndex + 1).coerceAtMost(destinations.size - 1)
        val blend = fraction - lowIndex

        // Interpolating both edges rather than just the offset is what makes a wide pill grow into a
        // narrow one continuously instead of snapping its width at the end of the travel.
        val pillWidthDp = pillWidthsDp[lowIndex] + (pillWidthsDp[highIndex] - pillWidthsDp[lowIndex]) * blend
        val pillLeftLow = IslandGeometry.pillLeft(lowIndex, slotWidthDp, pillWidthsDp[lowIndex])
        val pillLeftHigh = IslandGeometry.pillLeft(highIndex, slotWidthDp, pillWidthsDp[highIndex])
        val pillLeftDp = pillLeftLow + (pillLeftHigh - pillLeftLow) * blend

        Box(
            modifier = Modifier
                .width(outerWidthDp.dp)
                .height(IslandSpec.outerHeight)
                .shadow(
                    elevation = 10.dp,
                    shape = RoundedCornerShape(IslandGeometry.outerCornerRadius(IslandSpec.outerHeight.value).dp),
                    ambientColor = palette.islandShadow,
                    spotColor = palette.islandShadow,
                )
                .clip(RoundedCornerShape(IslandGeometry.outerCornerRadius(IslandSpec.outerHeight.value).dp))
                // A high-opacity tonal surface, never a blurred screenshot: DEVELOPMENT.md 6.1.1
                // forbids faking glass where reliable background sampling is unavailable.
                .background(palette.surfaces.floating)
                .padding(IslandSpec.innerPadding),
        ) {
            Box(
                modifier = Modifier
                    .offset { IntOffset(x = (pillLeftDp * density.density).roundToInt(), y = 0) }
                    .width(pillWidthDp.dp)
                    .height(IslandSpec.selectedPillHeight)
                    .align(Alignment.CenterStart)
                    .clip(RoundedCornerShape(IslandSpec.selectedPillRadius))
                    .background(palette.islandSelection),
            )

            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceEvenly,
            ) {
                destinations.forEachIndexed { index, destination ->
                    val isSelected = index == selectedIndex
                    val interaction = remember { MutableInteractionSource() }
                    val pressed by interaction.collectIsPressedAsState()

                    val pressScale by animateFloatAsState(
                        targetValue = if (pressed) IslandSpec.PRESS_SCALE else 1f,
                        animationSpec = tween(durationMillis = IslandSpec.PRESS_FEEDBACK_MS),
                        label = "islandPressScale",
                    )
                    val labelAlpha by animateFloatAsState(
                        targetValue = if (isSelected && labelsVisible[index]) 1f else 0f,
                        animationSpec = tween(
                            durationMillis = if (motion.reduceMotion) {
                                IslandSpec.REDUCED_MOTION_MS
                            } else {
                                IslandSpec.LABEL_CROSSFADE_MS
                            },
                        ),
                        label = "islandLabelAlpha",
                    )

                    Row(
                        modifier = Modifier
                            .width(slotWidthDp.dp)
                            // The floor is enforced on the whole slot, so a wide selected pill can
                            // never shrink a neighbour's target below 48dp.
                            .sizeIn(minWidth = IslandSpec.minTouchTarget, minHeight = IslandSpec.minTouchTarget)
                            .height(IslandSpec.selectedPillHeight)
                            .scale(pressScale)
                            .selectable(
                                selected = isSelected,
                                interactionSource = interaction,
                                indication = null,
                                role = Role.Tab,
                                onClick = {
                                    if (!isSelected) {
                                        // CLOCK_TICK is Android's selection tick; a long-press
                                        // constant would be too heavy for a navigation change.
                                        view.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
                                        onSelect(destination)
                                    }
                                },
                            ),
                        horizontalArrangement = Arrangement.Center,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(
                            imageVector = destination.icon,
                            // Always present, even when the label is hidden on a very narrow window:
                            // the spec requires the accessibility label to survive that degradation.
                            contentDescription = labels[index],
                            tint = if (isSelected) palette.onIslandSelection else palette.onFloatingMuted,
                            modifier = Modifier.size(IslandSpec.iconSize),
                        )
                        if (labelAlpha > 0f) {
                            Box(modifier = Modifier.width(IslandSpec.iconLabelGap))
                            Text(
                                text = labels[index],
                                style = labelStyle,
                                color = palette.onIslandSelection,
                                maxLines = 1,
                                overflow = TextOverflow.Clip,
                                modifier = Modifier.alpha(labelAlpha),
                            )
                        }
                    }
                }
            }
        }
    }
}

/** Bottom inset a scrollable page must reserve so its last row clears the island. */
@Composable
fun islandContentBottomInset(): androidx.compose.ui.unit.Dp {
    val safeBottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    return IslandGeometry.contentBottomInset(
        outerHeightDp = IslandSpec.outerHeight.value,
        contentGapDp = IslandSpec.contentGap.value,
        safeAreaBottomDp = safeBottom.value,
        minGapDp = IslandSpec.minBottomGap.value,
    ).dp
}
