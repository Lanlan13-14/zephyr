package one.zephyr.mobile.ui.theme

import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * Spacing and radius ladder from MOBILE_EXPERIENCE.md 2.1.
 *
 * A fixed ladder exists so screens compose by picking a level instead of inventing one-off values,
 * which is what keeps the two platforms visually related without sharing pixel layout.
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
    val sm: Dp = 8.dp
    val md: Dp = 12.dp
    val lg: Dp = 20.dp
    val pill: Dp = 999.dp
}

/**
 * Frozen bottom-island geometry (DEVELOPMENT.md 6.1.1).
 *
 * These are contract values, not taste: the reference render 1000069462.jpg is part of the frozen
 * spec, so each constant is transcribed with the rule it came from. Deriving them at call sites
 * would let one screen drift from the reference.
 */
object IslandSpec {
    /** Outer capsule height on phones. */
    val outerHeight: Dp = 62.dp

    /** The frozen prototype uses 88% of the viewport until the phone-width cap is reached. */
    const val widthFraction: Float = 0.88f

    val maxWidth: Dp = 340.dp

    /** Added after, rather than replacing, the navigation-bar inset. */
    val bottomGap: Dp = 18.dp

    /** Padding between the outer capsule and the item row. */
    val innerPadding: Dp = 5.dp

    val selectedPillHeight: Dp = 52.dp
    val selectedPillRadius: Dp = 26.dp

    val iconSize: Dp = 23.dp
    val selectedIconSize: Dp = 17.dp

    /** Gap between the icon and the label inside the selected pill. */
    val iconLabelGap: Dp = 2.dp

    /** Android accessibility floor for every item hit area. */
    val minTouchTarget: Dp = 48.dp

    /** Gap between island and scrollable content, used to compute list bottom inset. */
    val contentGap: Dp = 12.dp

    /** A FAB sits at least this far above the island and must not cover the fourth item. */
    val fabClearance: Dp = 12.dp

    /** Press feedback scale. */
    const val PRESS_SCALE: Float = 0.94f

    /** Press feedback must be visible within this budget. */
    const val PRESS_FEEDBACK_MS: Int = 120

    /** Target spring response for the selection pill, in seconds. */
    const val SELECTION_RESPONSE_SEC: Float = 0.34f

    /** Critically damped: the spec forbids overshoot on selection. */
    const val SELECTION_DAMPING_RATIO: Float = 1.0f

    /** Label crossfade ceiling. */
    const val LABEL_CROSSFADE_MS: Int = 180

    /** Reduce Motion replaces the positional spring with this crossfade. */
    const val REDUCED_MOTION_MS: Int = 120

    /**
     * Compose springs are parameterised by stiffness, the reference by response time.
     *
     * For a critically damped spring, response = 2*pi / sqrt(stiffness), so stiffness is derived
     * rather than hand-tuned; hard-coding a number would silently drift from the frozen 0.28s.
     */
    val selectionStiffness: Float =
        ((2f * Math.PI.toFloat()) / SELECTION_RESPONSE_SEC).let { it * it }
}
