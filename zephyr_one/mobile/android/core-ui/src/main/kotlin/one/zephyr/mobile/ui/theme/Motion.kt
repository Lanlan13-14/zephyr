package one.zephyr.mobile.ui.theme

import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.Easing
import androidx.compose.animation.core.tween

/**
 * Motion tokens transcribed from demo.html `:root`.
 *
 * `--ease-out: cubic-bezier(0.23, 1, 0.32, 1)`
 * `--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1)`
 * `--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1)`
 * `--dur-press: 120ms; --dur-fast: 160ms; --dur-med: 240ms; --dur-sheet: 420ms`
 */
object ZephyrMotionTokens {
    val easeOut: Easing = CubicBezierEasing(0.23f, 1f, 0.32f, 1f)
    val easeInOut: Easing = CubicBezierEasing(0.77f, 0f, 0.175f, 1f)
    val easeDrawer: Easing = CubicBezierEasing(0.32f, 0.72f, 0f, 1f)

    const val PRESS_MS: Int = 120
    const val FAST_MS: Int = 160
    const val MED_MS: Int = 240
    const val SHEET_MS: Int = 420
    const val TOAST_MS: Int = 300
    const val ISLAND_PILL_MS: Int = 340
    const val ISLAND_LABEL_MS: Int = 180
    const val TPANEL_MS: Int = 180
    const val REMOTE_PANEL_MS: Int = 200
    const val CURSOR_BLINK_MS: Int = 1060
    const val CLICK_RIPPLE_MS: Int = 320

    const val PRESS_SCALE: Float = 0.98f
    const val PRESS_SCALE_HARD: Float = 0.92f
    const val CHIP_PRESS_SCALE: Float = 0.95f
    const val ISLAND_PRESS_SCALE: Float = 0.94f
    const val BACK_PRESS_SCALE: Float = 0.92f
    const val HEAD_PRESS_SCALE: Float = 0.90f
    const val KEY_PRESS_SCALE: Float = 0.93f
    const val PAGE_BEHIND_X: Float = -0.28f
    const val PAGE_BEHIND_SCALE: Float = 0.995f
    const val PAGE_BEHIND_ALPHA: Float = 0.55f

    fun press(durationMs: Int = PRESS_MS) = tween<Float>(durationMs, easing = easeOut)
    fun fast(durationMs: Int = FAST_MS) = tween<Float>(durationMs, easing = easeOut)
    fun med(durationMs: Int = MED_MS) = tween<Float>(durationMs, easing = easeOut)
    fun sheet(durationMs: Int = SHEET_MS) = tween<Float>(durationMs, easing = easeDrawer)
}
