package one.zephyr.mobile.ui.component

import android.graphics.Typeface
import android.os.Build
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.BlurEffect
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.TileMode
import androidx.compose.ui.graphics.Paint
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import one.zephyr.mobile.ui.theme.ZephyrTheme
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.util.lerp
import one.zephyr.mobile.ui.theme.ZephyrPalette
import one.zephyr.mobile.ui.theme.ZephyrThemeId
import kotlin.math.min

/**
 * The desktop fluid launch, drawn while the process is still recovering.
 *
 * Timing is the normal (2.2s) sequence from zephyr-one-launch-transition:
 * the squircle floats in, a seed ignites at (145, 115), three wind ribbons
 * draw out of that point, the "One" wordmark settles into the crook, and a
 * hairline progress track eases toward — but never invents — completion.
 * [ready] is the only thing that fills the track.
 */
internal object FluidLaunchTiming {
    const val CARD_START_MS = 50L
    const val CARD_DURATION_MS = 1_100L
    const val BLOSSOM_START_MS = 200L
    const val SEED_IGNITE_MS = 750L
    const val SEED_SUBSUME_DELAY_MS = 580L
    const val SEED_SUBSUME_MS = 500L
    const val RIBBON_1_DELAY_MS = 80L
    const val RIBBON_2_DELAY_MS = 220L
    const val RIBBON_3_DELAY_MS = 360L
    const val RIBBON_1_MS = 950L
    const val RIBBON_2_MS = 950L
    const val RIBBON_3_MS = 900L
    const val WORD_DELAY_MS = 560L
    const val WORD_MS = 600L
    const val PROGRESS_START_MS = 320L
    const val PROGRESS_DURATION_MS = 1_050L
    const val PROGRESS_EASE_MS = 420L
    const val STEP_CREDENTIALS_MS = 450L
    const val STEP_CHANNEL_MS = 1_100L
    const val STEP_ALMOST_MS = 1_750L

    const val CAPTION_WAKE = "正在唤醒本地核心…"
    const val CAPTION_CREDENTIALS = "校验本地安全凭据…"
    const val CAPTION_CHANNEL = "建立安全通道…"
    const val CAPTION_ALMOST = "即将完成…"
    const val CAPTION_READY = "准备就绪"

    /** View-box lengths of the three official ribbons, sampled at 256 steps. */
    const val RIBBON_1_LENGTH = 221.39f
    const val RIBBON_2_LENGTH = 220.09f
    const val RIBBON_3_LENGTH = 103.60f
}

internal data class FluidLaunchMetrics(
    val card: Dp,
    val mark: Dp,
    val radius: Dp,
    val track: Dp,
    val trackGap: Dp,
)

internal data class FluidLaunchFrame(
    val cardAlpha: Float,
    val cardScale: Float,
    val cardOffsetY: Dp,
    val cardBlur: Dp,
    val seedScale: Float,
    val seedAlpha: Float,
    val ribbon1: Float,
    val ribbon2: Float,
    val ribbon3: Float,
    val ribbon1Alpha: Float,
    val ribbon2Alpha: Float,
    val ribbon3Alpha: Float,
    val wordScale: Float,
    val wordAlpha: Float,
    val progressAlpha: Float,
    val progressOffsetY: Dp,
    val progressBlur: Dp,
    val progressFraction: Float,
    val caption: String,
)

internal fun fluidLaunchMetrics(shortestDp: Int): FluidLaunchMetrics = when {
    shortestDp < 640 -> FluidLaunchMetrics(128.dp, 102.dp, 30.dp, 200.dp, 28.dp)
    shortestDp < 820 -> FluidLaunchMetrics(156.dp, 128.dp, 36.dp, 228.dp, 32.dp)
    shortestDp < 1100 -> FluidLaunchMetrics(184.dp, 156.dp, 42.dp, 256.dp, 38.dp)
    else -> FluidLaunchMetrics(216.dp, 182.dp, 50.dp, 280.dp, 44.dp)
}

/**
 * Apple's launch ease, cubic-bezier(0.16, 1, 0.3, 1), solved for y at x.
 * The control points never loop, so a few Newton steps land on the curve.
 */
internal fun appleEase(progress: Float): Float {
    val x = progress.coerceIn(0f, 1f)
    if (x <= 0f || x >= 1f) return x
    var t = x
    repeat(6) {
        val xEst = cubicBezier(t, 0.16f, 0.3f)
        val slope = cubicBezierSlope(t, 0.16f, 0.3f)
        if (slope == 0f) return@repeat
        t = (t - (xEst - x) / slope).coerceIn(0f, 1f)
    }
    return cubicBezier(t, 1f, 1f)
}

private fun cubicBezier(t: Float, c1: Float, c2: Float): Float {
    val u = 1f - t
    return 3f * u * u * t * c1 + 3f * u * t * t * c2 + t * t * t
}

private fun cubicBezierSlope(t: Float, c1: Float, c2: Float): Float {
    val u = 1f - t
    return 3f * u * u * c1 + 6f * u * t * (c2 - c1) + 3f * t * t * (1f - c2)
}

private fun unit(start: Long, duration: Long, elapsed: Long): Float {
    if (elapsed <= start) return 0f
    if (duration <= 0L || elapsed >= start + duration) return 1f
    return (elapsed - start).toFloat() / duration.toFloat()
}

private fun fadeIn(start: Long, duration: Long, elapsed: Long): Float =
    appleEase(unit(start, duration, elapsed))

internal fun fluidLaunchFrame(elapsedMs: Long, reducedMotion: Boolean, ready: Boolean): FluidLaunchFrame {
    if (reducedMotion) {
        return FluidLaunchFrame(
            cardAlpha = 1f,
            cardScale = 1f,
            cardOffsetY = 0.dp,
            cardBlur = 0.dp,
            seedScale = 0f,
            seedAlpha = 0f,
            ribbon1 = 1f,
            ribbon2 = 1f,
            ribbon3 = 1f,
            ribbon1Alpha = 0.98f,
            ribbon2Alpha = 0.92f,
            ribbon3Alpha = 0.82f,
            wordScale = 1f,
            wordAlpha = 0.96f,
            progressAlpha = 1f,
            progressOffsetY = 0.dp,
            progressBlur = 0.dp,
            progressFraction = if (ready) 1f else 0.35f,
            caption = if (ready) FluidLaunchTiming.CAPTION_READY else FluidLaunchTiming.CAPTION_WAKE,
        )
    }
    val card = fadeIn(FluidLaunchTiming.CARD_START_MS, FluidLaunchTiming.CARD_DURATION_MS, elapsedMs)
    val seed = seedMotion(elapsedMs)
    val ribbon1Start = FluidLaunchTiming.BLOSSOM_START_MS + FluidLaunchTiming.RIBBON_1_DELAY_MS
    val ribbon2Start = FluidLaunchTiming.BLOSSOM_START_MS + FluidLaunchTiming.RIBBON_2_DELAY_MS
    val ribbon3Start = FluidLaunchTiming.BLOSSOM_START_MS + FluidLaunchTiming.RIBBON_3_DELAY_MS
    val wordStart = FluidLaunchTiming.BLOSSOM_START_MS + FluidLaunchTiming.WORD_DELAY_MS
    val progress = fadeIn(FluidLaunchTiming.PROGRESS_START_MS, FluidLaunchTiming.PROGRESS_DURATION_MS, elapsedMs)
    val word = fadeIn(wordStart, FluidLaunchTiming.WORD_MS, elapsedMs)
    return FluidLaunchFrame(
        cardAlpha = card,
        cardScale = lerp(0.92f, 1f, card),
        cardOffsetY = lerp(12f, 0f, card).dp,
        cardBlur = lerp(14f, 0f, card).dp,
        seedScale = seed.first,
        seedAlpha = seed.second,
        ribbon1 = fadeIn(ribbon1Start, FluidLaunchTiming.RIBBON_1_MS, elapsedMs),
        ribbon2 = fadeIn(ribbon2Start, FluidLaunchTiming.RIBBON_2_MS, elapsedMs),
        ribbon3 = fadeIn(ribbon3Start, FluidLaunchTiming.RIBBON_3_MS, elapsedMs),
        ribbon1Alpha = ribbonAlpha(ribbon1Start, elapsedMs, 0.98f),
        ribbon2Alpha = ribbonAlpha(ribbon2Start, elapsedMs, 0.92f),
        ribbon3Alpha = ribbonAlpha(ribbon3Start, elapsedMs, 0.82f),
        wordScale = lerp(0.65f, 1f, word),
        wordAlpha = 0.96f * word,
        progressAlpha = progress,
        progressOffsetY = lerp(12f, 0f, progress).dp,
        progressBlur = lerp(8f, 0f, progress).dp,
        progressFraction = scriptedProgress(elapsedMs, ready),
        caption = scriptedCaption(elapsedMs, ready),
    )
}

/** Ignite, hold, then sink into the wordmark. The pulse never outlives the subsume. */
private fun seedMotion(elapsedMs: Long): Pair<Float, Float> {
    val igniteStart = FluidLaunchTiming.CARD_START_MS
    val subsumeStart = FluidLaunchTiming.BLOSSOM_START_MS + FluidLaunchTiming.SEED_SUBSUME_DELAY_MS
    val subsumeEnd = subsumeStart + FluidLaunchTiming.SEED_SUBSUME_MS
    if (elapsedMs >= subsumeEnd) return 0.3f to 0f
    if (elapsedMs >= subsumeStart) {
        val t = appleEase(unit(subsumeStart, FluidLaunchTiming.SEED_SUBSUME_MS, elapsedMs))
        return lerp(1f, 0.3f, t) to lerp(1f, 0f, t)
    }
    val igniteEnd = igniteStart + FluidLaunchTiming.SEED_IGNITE_MS
    if (elapsedMs >= igniteEnd) return 1f to 1f
    val t = unit(igniteStart, FluidLaunchTiming.SEED_IGNITE_MS, elapsedMs)
    val scale = if (t < 0.65f) lerp(0f, 1.2f, appleEase(t / 0.65f)) else lerp(1.2f, 1f, appleEase((t - 0.65f) / 0.35f))
    val alpha = appleEase(min(1f, t / 0.35f))
    return scale to alpha
}

private fun ribbonAlpha(start: Long, elapsedMs: Long, peak: Float): Float {
    val shown = unit(start, 1L, elapsedMs)
    if (shown <= 0f) return 0f
    val fade = appleEase(unit(start, (FluidLaunchTiming.RIBBON_1_MS * 0.25f).toLong(), elapsedMs))
    return peak * fade
}

private fun scriptedProgress(elapsedMs: Long, ready: Boolean): Float {
    if (ready) return 1f
    val steps = listOf(
        0L to 0f,
        FluidLaunchTiming.STEP_CREDENTIALS_MS to 0.35f,
        FluidLaunchTiming.STEP_CHANNEL_MS to 0.75f,
        FluidLaunchTiming.STEP_ALMOST_MS to 0.92f,
    )
    var fromTime = 0L
    var fromValue = 0f
    for ((time, value) in steps) {
        if (elapsedMs < time) break
        fromTime = time
        fromValue = value
    }
    val next = steps.firstOrNull { it.first > fromTime } ?: return fromValue
    val local = unit(fromTime, FluidLaunchTiming.PROGRESS_EASE_MS, elapsedMs)
    return lerp(fromValue, next.second, appleEase(local)).coerceAtMost(next.second)
}

private fun scriptedCaption(elapsedMs: Long, ready: Boolean): String = when {
    ready -> FluidLaunchTiming.CAPTION_READY
    elapsedMs >= FluidLaunchTiming.STEP_ALMOST_MS -> FluidLaunchTiming.CAPTION_ALMOST
    elapsedMs >= FluidLaunchTiming.STEP_CHANNEL_MS -> FluidLaunchTiming.CAPTION_CHANNEL
    elapsedMs >= FluidLaunchTiming.STEP_CREDENTIALS_MS -> FluidLaunchTiming.CAPTION_CREDENTIALS
    else -> FluidLaunchTiming.CAPTION_WAKE
}

internal data class LaunchPlate(
    val top: Color,
    val bottom: Color,
    val flat: Boolean,
)

/** Plates from the launch transition, not the app surface tokens. Light is a flat card. */
internal fun launchPlate(id: ZephyrThemeId, dark: Boolean): LaunchPlate = when (id) {
    ZephyrThemeId.FROST -> if (dark) LaunchPlate(Color(0xFF1E242C), Color(0xFF101419), false) else LaunchPlate(Color.White, Color.White, true)
    ZephyrThemeId.LAVA -> if (dark) LaunchPlate(Color(0xFF241C17), Color(0xFF15100C), false) else LaunchPlate(Color.White, Color.White, true)
    ZephyrThemeId.ASAGI -> if (dark) LaunchPlate(Color(0xFF17221F), Color(0xFF0E1614), false) else LaunchPlate(Color.White, Color.White, true)
    ZephyrThemeId.CYBER -> if (dark) LaunchPlate(Color(0xFF152024), Color(0xFF0D1417), false) else LaunchPlate(Color.White, Color.White, true)
}

internal fun launchCanvas(id: ZephyrThemeId, dark: Boolean): Color = when (id) {
    ZephyrThemeId.FROST -> if (dark) Color(0xFF090B0E) else Color(0xFFF5F5F7)
    ZephyrThemeId.LAVA -> if (dark) Color(0xFF100E0C) else Color(0xFFF7F3EF)
    ZephyrThemeId.ASAGI -> if (dark) Color(0xFF090F0E) else Color(0xFFF2F6F5)
    ZephyrThemeId.CYBER -> if (dark) Color(0xFF090E12) else Color(0xFFF2F5F7)
}

internal fun launchCaptionColor(id: ZephyrThemeId, dark: Boolean): Color = when (id) {
    ZephyrThemeId.FROST -> Color(0xFF86868B)
    ZephyrThemeId.LAVA -> if (dark) Color(0xFFA39D95) else Color(0xFF746860)
    ZephyrThemeId.ASAGI -> if (dark) Color(0xFF93A09E) else Color(0xFF657270)
    ZephyrThemeId.CYBER -> if (dark) Color(0xFF909AA3) else Color(0xFF667078)
}

@Composable
fun FluidLaunchScreen(
    palette: ZephyrPalette,
    ready: Boolean,
    modifier: Modifier = Modifier,
) {
    val reducedMotion = ZephyrTheme.motion.reduceMotion
    val configuration = LocalConfiguration.current
    val metrics = fluidLaunchMetrics(min(configuration.screenWidthDp, configuration.screenHeightDp))
    var elapsedMs by remember { mutableLongStateOf(0L) }
    LaunchedEffect(reducedMotion) {
        if (reducedMotion) return@LaunchedEffect
        val origin = withFrameNanos { it }
        while (true) {
            withFrameNanos { frame -> elapsedMs = (frame - origin) / 1_000_000L }
        }
    }
    val frame = fluidLaunchFrame(elapsedMs, reducedMotion, ready)
    val plate = launchPlate(palette.id, palette.dark)
    val canvas = launchCanvas(palette.id, palette.dark)
    val shape = RoundedCornerShape(metrics.radius)
    val cardBrush = if (plate.flat) {
        Brush.linearGradient(listOf(plate.top, plate.bottom))
    } else {
        Brush.verticalGradient(listOf(plate.top, plate.bottom))
    }
    val border = if (palette.dark) Color.White.copy(alpha = 0.12f) else Color.Black.copy(alpha = 0.08f)
    val trackColor = if (palette.dark) Color.White.copy(alpha = 0.12f) else Color.Black.copy(alpha = 0.08f)
    Box(
        modifier.fillMaxSize().background(canvas),
        contentAlignment = Alignment.Center,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Box(
                Modifier
                    .offset(y = frame.cardOffsetY)
                    .graphicsLaunch(frame.cardAlpha, frame.cardScale, frame.cardBlur)
                    .size(metrics.card)
                    .shadow(
                        elevation = if (palette.dark) 24.dp else 18.dp,
                        shape = shape,
                        clip = false,
                        ambientColor = Color.Black.copy(alpha = if (palette.dark) 0.72f else 0.14f),
                        spotColor = Color.Black.copy(alpha = if (palette.dark) 0.72f else 0.14f),
                    )
                    .clip(shape)
                    .background(cardBrush)
                    .border(0.5.dp, border, shape),
                contentAlignment = Alignment.Center,
            ) {
                WindMark(
                    metrics = metrics,
                    frame = frame,
                    palette = palette,
                )
            }
            Column(
                Modifier
                    .padding(top = metrics.trackGap)
                    .offset(y = frame.progressOffsetY)
                    .width(metrics.track)
                    .graphicsLaunch(frame.progressAlpha, 1f, frame.progressBlur),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Box(
                    Modifier
                        .fillMaxWidth()
                        .height(3.dp)
                        .clip(RoundedCornerShape(999.dp))
                        .background(trackColor),
                ) {
                    val fraction = frame.progressFraction.coerceIn(0f, 1f)
                    if (fraction > 0f) {
                        Box(
                            Modifier
                                .fillMaxHeight()
                                .fillMaxWidth(fraction)
                                .clip(RoundedCornerShape(999.dp))
                                .background(palette.brand.accent),
                        )
                    }
                }
                BasicText(
                    text = frame.caption,
                    modifier = Modifier.padding(top = 12.dp),
                    style = TextStyle(
                        color = launchCaptionColor(palette.id, palette.dark),
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Normal,
                        letterSpacing = (-0.01).sp,
                    ),
                )
            }
        }
    }
}

private fun Modifier.graphicsLaunch(alpha: Float, scale: Float, blur: Dp): Modifier =
    this.then(
        Modifier.graphicsLayer {
            this.alpha = alpha
            scaleX = scale
            scaleY = scale
            val radius = blur.toPx()
            // RenderEffect blur is API 31. Below that the card still fades and scales.
            renderEffect = if (radius > 0.5f && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                BlurEffect(radius, radius, TileMode.Decal)
            } else {
                null
            }
        },
    )

@Composable
private fun WindMark(
    metrics: FluidLaunchMetrics,
    frame: FluidLaunchFrame,
    palette: ZephyrPalette,
) {
    val density = LocalDensity.current
    val textPaint = remember(palette.brand.accent, density) {
        Paint().asFrameworkPaint().apply {
            isAntiAlias = true
            typeface = Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD)
            color = palette.brand.accent.toArgb()
        }
    }
    Canvas(Modifier.size(metrics.mark)) {
        val scale = size.minDimension / 200f
        val gradient = Brush.linearGradient(
            colors = listOf(palette.brand.main, palette.brand.mid, palette.brand.dark),
            start = Offset(size.width * 0.15f, size.height * 0.15f),
            end = Offset(size.width * 0.85f, size.height * 0.85f),
        )
        if (frame.seedAlpha > 0.01f) {
            drawCircle(
                color = palette.brand.accent,
                radius = 5f * scale * frame.seedScale,
                center = Offset(145f * scale, 115f * scale),
                alpha = frame.seedAlpha,
            )
        }
        drawRibbon(windRibbon1(scale), gradient, 10f * scale, frame.ribbon1, frame.ribbon1Alpha, FluidLaunchTiming.RIBBON_1_LENGTH * scale)
        drawRibbon(windRibbon2(scale), gradient, 6f * scale, frame.ribbon2, frame.ribbon2Alpha, FluidLaunchTiming.RIBBON_2_LENGTH * scale, maskSeed = true, scale = scale)
        drawRibbon(windRibbon3(scale), gradient, 3.5f * scale, frame.ribbon3, frame.ribbon3Alpha, FluidLaunchTiming.RIBBON_3_LENGTH * scale)
        if (frame.wordAlpha > 0.01f) {
            drawIntoCanvas { canvas ->
                val native = canvas.nativeCanvas
                textPaint.textSize = 15f * scale
                textPaint.alpha = (frame.wordAlpha * 255f).toInt().coerceIn(0, 255)
                native.save()
                native.scale(frame.wordScale, frame.wordScale, 142.6f * scale, 120f * scale)
                val oWidth = textPaint.measureText("O")
                native.drawText("O", 142.6f * scale - oWidth / 2f, 120.7f * scale, textPaint)
                // The Android launch mark follows the desktop anchors, but the
                // whole One wordmark sits 2.4 viewBox units left so the blue O
                // closes the small gap to the grey ribbon instead of floating
                // beside it. `ne` moves by the same amount, keeping One intact.
                native.drawText("ne", 150f * scale, 120.7f * scale, textPaint)
                native.restore()
            }
        }
    }
}

private fun DrawScope.drawRibbon(
    path: Path,
    brush: Brush,
    strokeWidth: Float,
    drawn: Float,
    alpha: Float,
    length: Float,
    maskSeed: Boolean = false,
    scale: Float = 1f,
) {
    if (drawn <= 0.001f || alpha <= 0.001f || length <= 0f) return
    val effect = PathEffect.dashPathEffect(floatArrayOf(length, length), length * (1f - drawn))
    val stroke = Stroke(width = strokeWidth, cap = StrokeCap.Round, join = StrokeJoin.Round, pathEffect = effect)
    val paint = {
        drawPath(path = path, brush = brush, alpha = alpha, style = stroke)
    }
    if (!maskSeed) {
        paint()
        return
    }
    val hole = Path().apply {
        fillType = PathFillType.EvenOdd
        addRect(Rect(0f, 0f, size.width, size.height))
        addOval(Rect(center = Offset(145f * scale, 115f * scale), radius = 6f * scale))
    }
    drawContext.canvas.save()
    drawContext.canvas.clipPath(hole)
    paint()
    drawContext.canvas.restore()
}

private fun windRibbon1(scale: Float): Path = Path().apply {
    moveTo(43f * scale, 64f * scale)
    cubicTo(84f * scale, 44f * scale, 138f * scale, 52f * scale, 160f * scale, 77f * scale)
    cubicTo(148f * scale, 94f * scale, 108f * scale, 104f * scale, 76f * scale, 123f * scale)
}

private fun windRibbon2(scale: Float): Path = Path().apply {
    moveTo(49f * scale, 76f * scale)
    cubicTo(89f * scale, 74f * scale, 126f * scale, 89f * scale, 145f * scale, 115f * scale)
    cubicTo(120f * scale, 134f * scale, 76f * scale, 153f * scale, 40f * scale, 135f * scale)
}

private fun windRibbon3(scale: Float): Path = Path().apply {
    moveTo(78f * scale, 88f * scale)
    cubicTo(108f * scale, 106f * scale, 137f * scale, 137f * scale, 170f * scale, 128f * scale)
}
