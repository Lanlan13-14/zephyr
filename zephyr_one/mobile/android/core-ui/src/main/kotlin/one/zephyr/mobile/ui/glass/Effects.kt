package one.zephyr.mobile.ui.glass

import android.os.Build
import androidx.annotation.FloatRange
import androidx.annotation.RequiresApi
import androidx.compose.foundation.shape.AbsoluteRoundedCornerShape
import androidx.compose.foundation.shape.CornerBasedShape
import androidx.compose.ui.graphics.BlurEffect
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.ColorMatrix
import androidx.compose.ui.graphics.ColorMatrixColorFilter
import androidx.compose.ui.graphics.RenderEffect
import androidx.compose.ui.graphics.TileMode
import androidx.compose.ui.graphics.asAndroidColorFilter
import androidx.compose.ui.graphics.asComposeRenderEffect
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.util.fastCoerceAtLeast
import androidx.compose.ui.util.fastCoerceAtMost
import org.intellij.lang.annotations.Language

@RequiresApi(Build.VERSION_CODES.S)
internal fun RenderEffect?.chain(other: RenderEffect): RenderEffect {
    return if (this != null) {
        android.graphics.RenderEffect.createChainEffect(
            other.asAndroidRenderEffect(),
            this.asAndroidRenderEffect(),
        ).asComposeRenderEffect()
    } else {
        other
    }
}

@RequiresApi(Build.VERSION_CODES.TIRAMISU)
internal fun createRuntimeShaderEffect(
    runtimeShader: RuntimeShader,
    uniformShaderName: String,
): RenderEffect {
    val androidShader = runtimeShader.asAndroidRuntimeShader()
        ?: throw IllegalStateException("RuntimeShader must be AndroidRuntimeShader on API 33+")
    return android.graphics.RenderEffect.createRuntimeShaderEffect(
        androidShader,
        uniformShaderName,
    ).asComposeRenderEffect()
}

@RequiresApi(Build.VERSION_CODES.S)
internal fun createColorFilterRenderEffect(
    renderEffect: RenderEffect? = null,
    colorFilter: ColorFilter,
): RenderEffect {
    return if (renderEffect != null) {
        android.graphics.RenderEffect.createColorFilterEffect(
            colorFilter.asAndroidColorFilter(),
            renderEffect.asAndroidRenderEffect(),
        ).asComposeRenderEffect()
    } else {
        android.graphics.RenderEffect.createColorFilterEffect(
            colorFilter.asAndroidColorFilter(),
        ).asComposeRenderEffect()
    }
}

fun BackdropEffectScope.blur(
    @FloatRange(from = 0.0) radius: Float,
    edgeTreatment: TileMode = TileMode.Clamp,
) {
    if (!isRenderEffectSupported()) return
    if (radius <= 0f) return

    if (edgeTreatment != TileMode.Clamp || renderEffect != null) {
        if (radius > padding) {
            padding = radius
        }
    }

    renderEffect = BlurEffect(
        renderEffect,
        radius,
        radius,
        edgeTreatment,
    )
}

fun BackdropEffectScope.lens(
    @FloatRange(from = 0.0) refractionHeight: Float,
    @FloatRange(from = 0.0) refractionAmount: Float,
    depthEffect: Boolean = false,
    chromaticAberration: Boolean = false,
) {
    if (!isRuntimeShaderSupported()) return
    if (refractionHeight <= 0f || refractionAmount <= 0f) return

    if (padding > 0f) {
        padding = (padding - refractionHeight).fastCoerceAtLeast(0f)
    }

    val radii = cornerRadii
    if (radii != null) {
        val shader = if (!chromaticAberration) {
            obtainRuntimeShader("Refraction", RoundedRectRefractionShaderString)
        } else {
            obtainRuntimeShader("RefractionWithDispersion", RoundedRectRefractionWithDispersionShaderString)
        }
        shader.apply {
            setFloatUniform("size", size.width, size.height)
            setFloatUniform("offset", -padding, -padding)
            setFloatUniform("cornerRadii", radii)
            setFloatUniform("refractionHeight", refractionHeight)
            setFloatUniform("refractionAmount", -refractionAmount)
            setFloatUniform("depthEffect", if (depthEffect) 1f else 0f)
            if (chromaticAberration) {
                setFloatUniform("chromaticAberration", 1f)
            }
        }
        effect(createRuntimeShaderEffect(shader, "content"))
    }
}

fun BackdropEffectScope.colorFilter(colorFilter: ColorFilter) {
    if (!isRenderEffectSupported()) return
    renderEffect = createColorFilterRenderEffect(renderEffect, colorFilter)
}

fun BackdropEffectScope.opacity(@FloatRange(from = 0.0, to = 1.0) alpha: Float) {
    val matrix = ColorMatrix(
        floatArrayOf(
            1f, 0f, 0f, 0f, 0f,
            0f, 1f, 0f, 0f, 0f,
            0f, 0f, 1f, 0f, 0f,
            0f, 0f, 0f, alpha, 0f,
        ),
    )
    colorFilter(ColorMatrixColorFilter(matrix))
}

fun BackdropEffectScope.colorControls(
    brightness: Float = 0f,
    contrast: Float = 1f,
    saturation: Float = 1f,
) {
    if (brightness == 0f && contrast == 1f && saturation == 1f) return
    colorFilter(colorControlsColorFilter(brightness, contrast, saturation))
}

private val VibrantColorFilter = colorControlsColorFilter(saturation = 1.5f)

fun BackdropEffectScope.vibrancy() {
    colorFilter(VibrantColorFilter)
}

fun BackdropEffectScope.effect(effect: RenderEffect) {
    if (!isRenderEffectSupported()) return
    renderEffect = renderEffect.chain(effect)
}

fun BackdropEffectScope.runtimeShaderEffect(
    key: String,
    @Language("AGSL") shaderString: String,
    uniformShaderName: String,
    block: RuntimeShader.() -> Unit,
) {
    if (!isRuntimeShaderSupported()) return
    val shader = obtainRuntimeShader(key, shaderString).apply(block)
    val effect = createRuntimeShaderEffect(shader, uniformShaderName)
    renderEffect = renderEffect.chain(effect)
}

private val BackdropEffectScope.cornerRadii: FloatArray?
    get() = when (val s = shape) {
        is AbsoluteRoundedCornerShape -> {
            val sz = size
            val maxRadius = sz.minDimension / 2f
            val tl = s.topStart.toPx(sz, this)
            val tr = s.topEnd.toPx(sz, this)
            val br = s.bottomEnd.toPx(sz, this)
            val bl = s.bottomStart.toPx(sz, this)
            floatArrayOf(
                tl.fastCoerceAtMost(maxRadius),
                tr.fastCoerceAtMost(maxRadius),
                br.fastCoerceAtMost(maxRadius),
                bl.fastCoerceAtMost(maxRadius),
            )
        }
        is CornerBasedShape -> {
            val sz = size
            val maxRadius = sz.minDimension / 2f
            val isLtr = layoutDirection == LayoutDirection.Ltr
            val tl = if (isLtr) s.topStart.toPx(sz, this) else s.topEnd.toPx(sz, this)
            val tr = if (isLtr) s.topEnd.toPx(sz, this) else s.topStart.toPx(sz, this)
            val br = if (isLtr) s.bottomEnd.toPx(sz, this) else s.bottomStart.toPx(sz, this)
            val bl = if (isLtr) s.bottomStart.toPx(sz, this) else s.bottomEnd.toPx(sz, this)
            floatArrayOf(
                tl.fastCoerceAtMost(maxRadius),
                tr.fastCoerceAtMost(maxRadius),
                br.fastCoerceAtMost(maxRadius),
                bl.fastCoerceAtMost(maxRadius),
            )
        }
        else -> {
            val maxRadius = size.minDimension / 2f
            floatArrayOf(maxRadius, maxRadius, maxRadius, maxRadius)
        }
    }

private fun colorControlsColorFilter(
    brightness: Float = 0f,
    contrast: Float = 1f,
    saturation: Float = 1f,
): ColorFilter {
    val invSat = 1f - saturation
    val r = 0.213f * invSat
    val g = 0.715f * invSat
    val b = 0.072f * invSat

    val c = contrast
    val t = (0.5f - c * 0.5f + brightness) * 255f
    val s = saturation

    val cr = c * r
    val cg = c * g
    val cb = c * b
    val cs = c * s

    val colorMatrix = ColorMatrix(
        floatArrayOf(
            cr + cs, cg, cb, 0f, t,
            cr, cg + cs, cb, 0f, t,
            cr, cg, cb + cs, 0f, t,
            0f, 0f, 0f, 1f, 0f,
        ),
    )
    return ColorMatrixColorFilter(colorMatrix)
}
