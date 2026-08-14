package one.zephyr.mobile.ui.component

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import one.zephyr.mobile.ui.theme.ZephyrMotionTokens
import one.zephyr.mobile.ui.theme.ZephyrTheme

/** Demo `.press:active { transform:scale(.98) }` with 120ms ease-out. */
@Composable
fun Modifier.pressScale(
    scale: Float = ZephyrMotionTokens.PRESS_SCALE,
    enabled: Boolean = true,
    interaction: MutableInteractionSource? = null,
): Modifier {
    val source = interaction ?: remember { MutableInteractionSource() }
    val pressed by source.collectIsPressedAsState()
    val motion = ZephyrTheme.motion
    val animated by animateFloatAsState(
        targetValue = if (enabled && pressed) scale else 1f,
        animationSpec = tween(motion.scale(ZephyrMotionTokens.PRESS_MS), easing = ZephyrMotionTokens.easeOut),
        label = "pressScale",
    )
    return this.graphicsLayer {
        scaleX = animated
        scaleY = animated
    }
}

@Composable
fun rememberPressInteraction(): MutableInteractionSource = remember { MutableInteractionSource() }
