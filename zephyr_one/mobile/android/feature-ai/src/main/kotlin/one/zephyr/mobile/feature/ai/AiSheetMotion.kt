package one.zephyr.mobile.feature.ai

import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * Demo `#ai-sheet` detents.
 *
 * `const DETENTS = { expanded:0.92, half:0.55, peek:0.30 }`
 * Closed is not a height detent — the sheet translates off-screen at its last height.
 */
enum class AiDetent(val fraction: Float) {
    PEEK(0.30f),
    HALF(0.55f),
    EXPANDED(0.92f),
    ;

    companion object {
        val snapTargets: List<AiDetent> = entries.toList()
    }
}

/** Phone sheet vs pad right rail. Demo `isPad = matchMedia('(min-width:768px)')`. */
enum class AiLayout {
    PHONE,
    PAD,
}

data class AiSheetState(
    val detent: AiDetent? = null,
    val pickerOpen: Boolean = false,
    val runActive: Boolean = false,
) {
    val isOpen: Boolean get() = detent != null
}

/**
 * Geometry transcribed from demo.html `#ai-fab` / `#ai-sheet` / pad media query.
 *
 * Keep every number here so a JVM test can fail the overlay without a device.
 */
object AiSheetGeometry {
    const val PAD_BREAKPOINT_DP: Float = 768f
    const val PAD_MAX_WIDTH_DP: Float = 420f
    const val PAD_WIDTH_FRACTION: Float = 0.42f
    const val CLOSED_TRANSLATE: Float = 1.05f
    const val PEEK_DRAG_FLOOR: Float = 0.70f
    const val FLICK_VELOCITY_PX_PER_MS: Float = 0.9f
    const val FLICK_MIN_DELTA_Y_PX: Float = 40f
    const val VELOCITY_PROJECTION_MS: Float = 140f
    const val SHEET_MS: Int = 420
    const val FAB_OPACITY_MS: Int = 240
    const val FAB_SCALE_MS: Int = 120
    const val FAB_PRESS_SCALE: Float = 0.92f
    const val FAB_GONE_SCALE: Float = 0.9f
    const val FAB_SIZE_DP: Float = 50f
    const val FAB_END_DP: Float = 16f
    const val FAB_END_PAD_DP: Float = 22f
    const val FAB_BOTTOM_DP: Float = 96f

    fun fabEndDp(layout: AiLayout): Float =
        if (layout == AiLayout.PAD) FAB_END_PAD_DP else FAB_END_DP
    const val HANDLE_WIDTH_DP: Float = 38f
    const val HANDLE_BAR_HEIGHT_DP: Float = 5f
    const val HANDLE_TOP_PAD_DP: Float = 10f
    const val HANDLE_BOTTOM_PAD_DP: Float = 6f
    const val CORNER_DP: Float = 28f
    const val CHIP_HEIGHT_DP: Float = 28f
    const val CHIP_PRESS_SCALE: Float = 0.94f
    const val SEND_SIZE_DP: Float = 40f
    const val SEND_PRESS_SCALE: Float = 0.9f
    const val INPUT_HEIGHT_DP: Float = 40f
    const val TRACE_BUTTON_HEIGHT_DP: Float = 34f
    const val TRACE_BUTTON_PRESS: Float = 0.96f

    fun layout(widthDp: Float): AiLayout =
        if (widthDp >= PAD_BREAKPOINT_DP) AiLayout.PAD else AiLayout.PHONE

    fun padWidthDp(containerWidthDp: Float): Float =
        minOf(PAD_MAX_WIDTH_DP, containerWidthDp * PAD_WIDTH_FRACTION)

    fun heightPx(detent: AiDetent, containerHeightPx: Float): Float =
        (containerHeightPx * detent.fraction).roundToInt().toFloat()

    fun minDragHeightPx(containerHeightPx: Float): Float =
        heightPx(AiDetent.PEEK, containerHeightPx) * PEEK_DRAG_FLOOR

    fun maxDragHeightPx(containerHeightPx: Float): Float =
        heightPx(AiDetent.EXPANDED, containerHeightPx)

    fun clampHeightPx(heightPx: Float, containerHeightPx: Float): Float =
        heightPx.coerceIn(minDragHeightPx(containerHeightPx), maxDragHeightPx(containerHeightPx))
}

/**
 * Pointer-driven sheet motion. Matches demo `aiTo` / handle listeners, not a nearest-only snap.
 *
 * Velocity is px per millisecond — the same unit as `performance.now()` in the prototype.
 */
object AiSheetMotion {

    fun open(): AiDetent = AiDetent.HALF

    fun showScrim(detent: AiDetent?, layout: AiLayout): Boolean =
        layout == AiLayout.PHONE && detent == AiDetent.EXPANDED

    fun fabVisible(enabled: Boolean, detent: AiDetent?): Boolean =
        enabled && detent == null

    /**
     * Android back / Escape: picker first, then one detent, then close.
     * Demo: `aiTo(aiState==='expanded'?'half':aiState==='half'?'peek':'closed')`.
     */
    fun back(state: AiSheetState): AiSheetState {
        if (state.pickerOpen) return state.copy(pickerOpen = false)
        val next = when (state.detent) {
            AiDetent.EXPANDED -> AiDetent.HALF
            AiDetent.HALF -> AiDetent.PEEK
            AiDetent.PEEK -> null
            null -> null
        }
        return state.copy(detent = next)
    }

    fun disable(enabled: Boolean, state: AiSheetState): AiSheetState =
        if (enabled) state else state.copy(detent = null, pickerOpen = false)

    /** Hiding the panel must not cancel a run. */
    fun hidePanel(state: AiSheetState): AiSheetState =
        state.copy(detent = null, pickerOpen = false, runActive = state.runActive)

    fun stopRun(state: AiSheetState): AiSheetState = state.copy(runActive = false)

    fun takeover(state: AiSheetState): AiSheetState = state.copy(runActive = false)

    /**
     * @param velocityPxPerMs positive when the finger moves down
     * @param dragDeltaYPx finger travel since pointerdown; positive is down
     */
    fun settle(
        currentHeightPx: Float,
        containerHeightPx: Float,
        velocityPxPerMs: Float,
        dragDeltaYPx: Float,
        layout: AiLayout,
    ): AiDetent? {
        if (layout == AiLayout.PAD) return AiDetent.HALF
        if (
            velocityPxPerMs > AiSheetGeometry.FLICK_VELOCITY_PX_PER_MS &&
            dragDeltaYPx > AiSheetGeometry.FLICK_MIN_DELTA_Y_PX
        ) {
            return null
        }
        val projected = currentHeightPx - velocityPxPerMs * AiSheetGeometry.VELOCITY_PROJECTION_MS
        var best = AiDetent.PEEK
        var bestDist = Float.POSITIVE_INFINITY
        for (target in AiDetent.snapTargets) {
            val dist = abs(AiSheetGeometry.heightPx(target, containerHeightPx) - projected)
            if (dist < bestDist) {
                bestDist = dist
                best = target
            }
        }
        return best
    }

    /** The broken nearest-only snap the previous overlay shipped. Kept so a test can kill it. */
    fun nearestWithoutVelocity(currentHeightPx: Float, containerHeightPx: Float): AiDetent {
        var best = AiDetent.PEEK
        var bestDist = Float.POSITIVE_INFINITY
        for (target in AiDetent.snapTargets) {
            val dist = abs(AiSheetGeometry.heightPx(target, containerHeightPx) - currentHeightPx)
            if (dist < bestDist) {
                bestDist = dist
                best = target
            }
        }
        return best
    }
}
