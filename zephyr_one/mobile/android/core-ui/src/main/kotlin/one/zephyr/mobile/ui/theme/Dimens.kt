package one.zephyr.mobile.ui.theme

import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * Spacing and radius ladder from demo.html.
 *
 * `--r-sm:10px; --r-md:14px; --r-lg:20px; --r-xl:28px`
 * Page gutter is 16. Section titles sit at 22/4/10.
 */
object ZephyrSpacing {
    val xs: Dp = 4.dp
    val sm: Dp = 8.dp
    val md: Dp = 12.dp
    val lg: Dp = 16.dp
    val xl: Dp = 24.dp
    val xxl: Dp = 32.dp
}

object ZephyrRadius {
    val sm: Dp = 10.dp
    val md: Dp = 14.dp
    val lg: Dp = 20.dp
    val xl: Dp = 28.dp
    val pill: Dp = 999.dp
}

/**
 * Frozen bottom-island geometry from demo.html `#island`.
 *
 * height 62 / width min(88%, 340) / bottom 18 / inner pad 5 / pill radius 26
 * unselected icon 23, selected icon 17, label 10/600, press 0.94 / 120ms
 * pill slide 340ms ease-out, label 180ms
 */
object IslandSpec {
    val outerHeight: Dp = 62.dp
    const val widthFraction: Float = 0.88f
    val maxWidth: Dp = 340.dp
    val bottomGap: Dp = 18.dp
    val innerPadding: Dp = 5.dp
    val selectedPillHeight: Dp = 52.dp
    val selectedPillRadius: Dp = 26.dp
    val iconSize: Dp = 23.dp
    val selectedIconSize: Dp = 17.dp
    val iconLabelGap: Dp = 2.dp
    val minTouchTarget: Dp = 48.dp
    val contentGap: Dp = 12.dp
    val fabClearance: Dp = 12.dp
    const val PRESS_SCALE: Float = 0.94f
    const val PRESS_FEEDBACK_MS: Int = 120
    const val SELECTION_MS: Int = 340
    const val SELECTION_RESPONSE_SEC: Float = 0.34f
    const val SELECTION_DAMPING_RATIO: Float = 1.0f
    const val LABEL_CROSSFADE_MS: Int = 180
    const val REDUCED_MOTION_MS: Int = 120
    val selectionStiffness: Float =
        ((2f * Math.PI.toFloat()) / SELECTION_RESPONSE_SEC).let { it * it }
}
