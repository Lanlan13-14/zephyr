package one.zephyr.mobile.ui.back

import androidx.activity.compose.PredictiveBackHandler
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import one.zephyr.mobile.ui.theme.IslandSpec
import one.zephyr.mobile.ui.theme.LocalZephyrMotion
import one.zephyr.mobile.ui.theme.ZephyrRadius

/**
 * Progress-driven in-app back.
 *
 * DEVELOPMENT.md 2.3 draws a hard line: the *visual* is Zephyr's own, but the *signal* is the
 * platform's. So this wraps [PredictiveBackHandler] rather than a custom drag detector, which is
 * what keeps 3-button back, a hardware Escape and the accessibility "go back" action working
 * identically to an edge swipe.
 *
 * Two rules are structural rather than cosmetic:
 *  - [onCommit] fires the moment the gesture completes, never from an animation end callback, so a
 *    slow exit animation can never delay or lose the navigation;
 *  - a cancelled gesture animates back from wherever it currently is, so it never snaps to a
 *    keyframe start.
 */
@Composable
fun ZephyrPredictiveBack(
    enabled: Boolean = true,
    onCommit: () -> Unit,
    content: @Composable (BackProgress) -> Unit,
) {
    val motion = LocalZephyrMotion.current
    val progress = remember { Animatable(0f) }
    val edge = remember { androidx.compose.runtime.mutableStateOf(BackEdge.LEFT) }

    PredictiveBackHandler(enabled = enabled) { events ->
        try {
            events.collect { event ->
                edge.value = if (event.swipeEdge == 1) BackEdge.RIGHT else BackEdge.LEFT
                // snapTo, not animateTo: the gesture is the animation clock, 1:1 with the finger.
                progress.snapTo(event.progress)
            }
            // Commit first, animate second. The destination change must not wait for pixels.
            onCommit()
            progress.snapTo(0f)
        } catch (cancelled: CancellationException) {
            // Continues from the current presentation value, so a cancel rebounds instead of jumping.
            // Cancel rebound reuses the reduced-motion budget: a cancel is a correction, not a
            // transition, so it must not linger. Scaled so "remove animations" snaps instead.
            progress.animateTo(0f, tween(durationMillis = motion.scale(IslandSpec.REDUCED_MOTION_MS)))
        }
    }

    content(BackProgress(fraction = progress.value, edge = edge.value))
}

enum class BackEdge { LEFT, RIGHT }

/** Live back gesture state handed to the page so it can map progress onto its own hierarchy. */
data class BackProgress(val fraction: Float, val edge: BackEdge) {
    val isActive: Boolean get() = fraction > 0f
}

/**
 * The house mapping for a page being popped: it shrinks and slides slightly toward the swiped edge,
 * revealing the destination beneath from the first frame rather than after release.
 */
fun Modifier.zephyrBackTransform(progress: BackProgress, reduceMotion: Boolean): Modifier {
    if (!progress.isActive) return this
    if (reduceMotion) return this.alpha(1f - progress.fraction * 0.35f)
    val scale = 1f - progress.fraction * 0.08f
    val shift = progress.fraction * 24f
    return this
        .graphicsLayer {
            scaleX = scale
            scaleY = scale
            translationX = if (progress.edge == BackEdge.LEFT) shift.dp.toPx() else -shift.dp.toPx()
        }
        .clip(androidx.compose.foundation.shape.RoundedCornerShape(ZephyrRadius.lg * progress.fraction))
}
