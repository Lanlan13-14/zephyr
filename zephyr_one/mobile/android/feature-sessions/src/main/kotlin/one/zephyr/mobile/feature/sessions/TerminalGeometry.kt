package one.zephyr.mobile.feature.sessions

import kotlin.math.floor
import kotlin.math.max

/** A negotiated terminal size. */
data class TerminalSize(val columns: Int, val rows: Int) {
    init {
        require(columns >= TerminalGeometry.MIN_COLUMNS) { "columns below floor" }
        require(rows >= TerminalGeometry.MIN_ROWS) { "rows below floor" }
    }
}

/**
 * Viewport to rows/columns.
 *
 * TERMINAL_EXPERIENCE.md 6 freezes the floor at 4x4 cells and forbids computing a negative height
 * when chrome would not fit: the correct response is to drop chrome, never to hand the emulator an
 * impossible size. Keeping the arithmetic here means the Android and iOS hosts cannot disagree.
 */
object TerminalGeometry {

    const val MIN_COLUMNS = 4
    const val MIN_ROWS = 4

    const val MIN_FONT_SP = 8f
    const val MAX_FONT_SP = 32f

    /** Font size commits in half-point steps so a pinch cannot produce jitter (6). */
    const val FONT_STEP_SP = 0.5f

    /** Resize debounce window; the last value must still be sent (6). */
    const val RESIZE_DEBOUNCE_MIN_MS = 16L
    const val RESIZE_DEBOUNCE_MAX_MS = 50L

    /**
     * @param widthPx viewport width after insets and chrome.
     * @param cellWidthPx advance width of the monospace cell, not the glyph bounding box.
     */
    fun sizeFor(widthPx: Float, heightPx: Float, cellWidthPx: Float, lineHeightPx: Float): TerminalSize {
        if (cellWidthPx <= 0f || lineHeightPx <= 0f) return TerminalSize(MIN_COLUMNS, MIN_ROWS)
        val columns = max(MIN_COLUMNS, floor(widthPx / cellWidthPx).toInt())
        val rows = max(MIN_ROWS, floor(heightPx / lineHeightPx).toInt())
        return TerminalSize(columns, rows)
    }

    /**
     * Height available to the terminal.
     *
     * Chrome is dropped in a fixed order when the terminal would fall below its floor: the shortcut
     * matrix goes before the dock, because the dock is navigation and the matrix has a hardware
     * keyboard alternative.
     */
    fun terminalHeightPx(
        totalHeightPx: Float,
        imeHeightPx: Float,
        shortcutMatrixHeightPx: Float,
        dockHeightPx: Float,
        lineHeightPx: Float,
    ): Float {
        val floorPx = lineHeightPx * MIN_ROWS
        val withAll = totalHeightPx - imeHeightPx - shortcutMatrixHeightPx - dockHeightPx
        if (withAll >= floorPx) return withAll
        val withoutMatrix = totalHeightPx - imeHeightPx - dockHeightPx
        if (withoutMatrix >= floorPx) return withoutMatrix
        val withoutChrome = totalHeightPx - imeHeightPx
        // Never negative: a negative height would propagate into rows and then into NAWS.
        return max(floorPx, withoutChrome)
    }

    /** Which chrome survives at this height, so the host renders the same decision it measured. */
    fun chromeFor(
        totalHeightPx: Float,
        imeHeightPx: Float,
        shortcutMatrixHeightPx: Float,
        dockHeightPx: Float,
        lineHeightPx: Float,
    ): TerminalChrome {
        val floorPx = lineHeightPx * MIN_ROWS
        val imeOpen = imeHeightPx > 0f
        return when {
            totalHeightPx - imeHeightPx - shortcutMatrixHeightPx - dockHeightPx >= floorPx ->
                // The frozen IME layout hides the root island and the dock while the IME is open
                // (TERMINAL_EXPERIENCE.md 8.2), so the dock is only shown when the IME is closed.
                TerminalChrome(shortcutMatrix = true, dock = !imeOpen, island = !imeOpen)
            totalHeightPx - imeHeightPx - dockHeightPx >= floorPx ->
                TerminalChrome(shortcutMatrix = false, dock = !imeOpen, island = false)
            else -> TerminalChrome(shortcutMatrix = false, dock = false, island = false)
        }
    }

    /** Commits a pinch preview to a stable font size. */
    fun commitFontSp(previewSp: Float): Float {
        val stepped = Math.round(previewSp / FONT_STEP_SP) * FONT_STEP_SP
        return stepped.coerceIn(MIN_FONT_SP, MAX_FONT_SP)
    }

    /** True when a pinch changed the size enough to be worth a resize round trip. */
    fun fontChanged(currentSp: Float, previewSp: Float): Boolean =
        commitFontSp(previewSp) != commitFontSp(currentSp)
}

data class TerminalChrome(
    val shortcutMatrix: Boolean,
    val dock: Boolean,
    val island: Boolean,
)
