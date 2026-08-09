package one.zephyr.mobile.feature.sessions

import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * Scrollback position with sub-row accumulation.
 *
 * TERMINAL_EXPERIENCE.md 2.3 is explicit that a slow drag must not lose sub-row distance: Termux
 * accumulates the residual pixels and only converts whole rows. Reproducing that is the difference
 * between a terminal that feels attached to the finger and one that ignores small movements.
 *
 * @param topRow how far back in the transcript the viewport is, in rows above the bottom. 0 means
 *   the viewport is pinned to the live output.
 */
class ScrollbackViewport(
    private var lineHeightPx: Float,
    private var visibleRows: Int = 24,
) {

    var topRow: Int = 0
        private set

    private var residualPx: Float = 0f

    /** True while the viewport follows new output. The only state that may auto-scroll. */
    val followingBottom: Boolean get() = topRow == 0

    /**
     * Drags the viewport.
     *
     * @param dyPx scroll distance in the platform's gesture convention: positive means the finger
     *   moved *up*, which scrolls toward the live bottom and reveals newer rows. This matches
     *   Android's onScroll distanceY (previousY - currentY) and Termux's mScrollRemainder, so the
     *   host passes the platform value straight through instead of negating it at the call site.
     * @param transcriptRows total rows available above the bottom.
     * @return rows actually moved, for the renderer's dirty-region calculation.
     */
    fun drag(dyPx: Float, transcriptRows: Int): Int {
        if (lineHeightPx <= 0f) return 0
        residualPx += dyPx
        val wholeRows = (residualPx / lineHeightPx).toInt()
        if (wholeRows == 0) return 0
        residualPx -= wholeRows * lineHeightPx
        // Dragging down (positive dy) moves toward the bottom, i.e. decreases topRow.
        return scrollBy(-wholeRows, transcriptRows)
    }

    /**
     * Moves by whole rows, clamped to the transcript.
     *
     * @return the applied delta, which differs from the request at the boundaries
     *   (TERMINAL_EXPERIENCE.md 2.4).
     */
    fun scrollBy(rows: Int, transcriptRows: Int): Int {
        val maxTop = maxOf(0, transcriptRows)
        val next = (topRow + rows).coerceIn(0, maxTop)
        val applied = next - topRow
        topRow = next
        // Clearing the residual at a boundary stops a long overscroll drag from storing pixels that
        // would later snap the viewport when the direction reverses.
        if (applied == 0) residualPx = 0f
        return applied
    }

    /** Shift+PageUp/PageDown move a whole screen (TERMINAL_EXPERIENCE.md 2.12). */
    fun scrollPages(pages: Int, transcriptRows: Int): Int =
        scrollBy(pages * visibleRows, transcriptRows)

    /** Called when the user asks to return to live output, and after an explicit jump-to-bottom. */
    fun jumpToBottom() {
        topRow = 0
        residualPx = 0f
    }

    /**
     * New output arrived.
     *
     * The frozen rule (TERMINAL_EXPERIENCE.md 2.3 and the reverse test in 12) is that remote output
     * must not steal the viewport while the user is reading back. Following the bottom is therefore
     * a state, not a heuristic: if the user has scrolled up, the topRow is *increased* so the same
     * text stays under the finger.
     *
     * @return true when the renderer should follow the new output.
     */
    fun onOutput(newRows: Int, transcriptRows: Int): Boolean {
        if (followingBottom) return true
        if (newRows > 0) scrollBy(newRows, transcriptRows)
        return false
    }

    /**
     * Fling deceleration, in rows.
     *
     * Uses the same exponential decay a platform Scroller applies, expressed in rows so the caller
     * can drive it from either an Android Scroller or a SwiftUI animation without the two
     * disagreeing about distance.
     */
    fun flingRows(velocityPxPerSecond: Float, decelerationPxPerSecondSquared: Float = DEFAULT_DECELERATION): Int {
        if (lineHeightPx <= 0f || decelerationPxPerSecondSquared <= 0f) return 0
        val distancePx = velocityPxPerSecond * velocityPxPerSecond / (2f * decelerationPxPerSecondSquared)
        val rows = (distancePx / lineHeightPx).roundToInt()
        return if (velocityPxPerSecond < 0f) rows else -rows
    }

    fun onGeometryChanged(lineHeightPx: Float, visibleRows: Int) {
        if (lineHeightPx > 0f) this.lineHeightPx = lineHeightPx
        if (visibleRows > 0) this.visibleRows = visibleRows
        residualPx = 0f
    }

    /** Exposed for the renderer and for tests that assert no sub-row distance was dropped. */
    fun residualPx(): Float = residualPx

    fun hasResidual(): Boolean = abs(residualPx) > 0.001f

    companion object {
        const val DEFAULT_DECELERATION = 3000f
    }
}
