package one.zephyr.mobile.ui.glass

import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.isSpecified
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import one.zephyr.mobile.ui.theme.ZephyrRadius
import one.zephyr.mobile.ui.theme.ZephyrTheme

fun Capsule(): Shape = RoundedCornerShape(percent = 50)

/**
 * Convenient modifier applying the complete Liquid Glass effect stack:
 * backdrop sampling -> lens refraction -> blur -> vibrancy -> surface tint -> specular highlight -> ambient shadow.
 */
@Composable
fun Modifier.liquidGlass(
    backdrop: Backdrop = LocalBackdrop.current,
    shape: Shape = RoundedCornerShape(ZephyrRadius.pill),
    tint: Color = Color.Unspecified,
    surfaceColor: Color = Color.Unspecified,
    blurRadius: Dp = 12.dp,
    refractionHeight: Dp = 16.dp,
    refractionAmount: Dp = 20.dp,
    depthEffect: Boolean = false,
    chromaticAberration: Boolean = false,
    highlight: Highlight? = Highlight.Default,
    shadow: Shadow? = Shadow.Default,
    innerShadow: InnerShadow? = null,
): Modifier {
    val palette = ZephyrTheme.palette
    val resolvedSurface = if (surfaceColor.isSpecified) {
        surfaceColor
    } else {
        palette.surfaces.floating.copy(alpha = if (palette.dark) 0.70f else 0.82f)
    }

    return this.drawBackdrop(
        backdrop = backdrop,
        shape = { shape },
        effects = {
            vibrancy()
            if (blurRadius > 0.dp) {
                blur(blurRadius.toPx())
            }
            if (refractionHeight > 0.dp && refractionAmount > 0.dp) {
                lens(
                    refractionHeight = refractionHeight.toPx(),
                    refractionAmount = refractionAmount.toPx(),
                    depthEffect = depthEffect,
                    chromaticAberration = chromaticAberration,
                )
            }
        },
        highlight = if (highlight != null) { { highlight } } else null,
        shadow = if (shadow != null) { { shadow } } else null,
        innerShadow = if (innerShadow != null) { { innerShadow } } else null,
        onDrawSurface = {
            drawRect(resolvedSurface)
            if (tint.isSpecified) {
                drawRect(tint, blendMode = BlendMode.Hue)
                drawRect(tint.copy(alpha = 0.6f))
            }
        },
    )
}

/**
 * High-level interactive Liquid Glass button.
 */
@Composable
fun LiquidButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    backdrop: Backdrop = LocalBackdrop.current,
    shape: Shape = Capsule(),
    tint: Color = Color.Unspecified,
    surfaceColor: Color = Color.Unspecified,
    enabled: Boolean = true,
    content: @Composable RowScope.() -> Unit,
) {
    val interactionSource = remember { MutableInteractionSource() }

    Row(
        modifier = modifier
            .liquidGlass(
                backdrop = backdrop,
                shape = shape,
                tint = tint,
                surfaceColor = surfaceColor,
                refractionHeight = 12.dp,
                refractionAmount = 18.dp,
            )
            .clip(shape)
            .clickable(
                interactionSource = interactionSource,
                indication = null,
                enabled = enabled,
                role = Role.Button,
                onClick = onClick,
            )
            .height(48.dp)
            .padding(horizontal = 16.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
        verticalAlignment = Alignment.CenterVertically,
        content = content,
    )
}

/**
 * Liquid Glass container surface.
 */
@Composable
fun LiquidSurface(
    modifier: Modifier = Modifier,
    backdrop: Backdrop = LocalBackdrop.current,
    shape: Shape = RoundedCornerShape(ZephyrRadius.lg),
    tint: Color = Color.Unspecified,
    surfaceColor: Color = Color.Unspecified,
    content: @Composable BoxScope.() -> Unit,
) {
    Box(
        modifier = modifier
            .liquidGlass(
                backdrop = backdrop,
                shape = shape,
                tint = tint,
                surfaceColor = surfaceColor,
            )
            .clip(shape),
        content = content,
    )
}
