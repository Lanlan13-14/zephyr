package one.zephyr.mobile.feature.sessions

/**
 * Picks a paint colour that stays readable on the chrome background.
 *
 * Termux's default scheme is white-on-black. Frost's terminal surface is a pale grey. A snapshot
 * that still carries `0xFFFFFFFF` / `0` therefore paints invisible glyphs. The live [TerminalView]
 * path applies [TermuxColorScheme] first; this helper is the Compose fallback and any host that
 * draws [TerminalCell] without that scheme.
 */
object TerminalCellPaint {

    fun foreground(cellArgb: Int, fallbackArgb: Int, backgroundArgb: Int): Int {
        if (cellArgb == 0) return fallbackArgb
        if (contrast(cellArgb, backgroundArgb) < MIN_CONTRAST) return fallbackArgb
        return cellArgb
    }

    fun background(cellArgb: Int, fallbackArgb: Int): Int {
        if (cellArgb == 0) return fallbackArgb
        return cellArgb
    }

    fun contrast(fgArgb: Int, bgArgb: Int): Float {
        val fg = luminance(fgArgb)
        val bg = luminance(bgArgb)
        val lighter = maxOf(fg, bg)
        val darker = minOf(fg, bg)
        return (lighter + 0.05f) / (darker + 0.05f)
    }

    private fun luminance(argb: Int): Float {
        fun channel(value: Int): Float {
            val c = value / 255f
            return if (c <= 0.03928f) c / 12.92f else ((c + 0.055f) / 1.055f).let { it * it * it }
        }
        val r = channel((argb ushr 16) and 0xFF)
        val g = channel((argb ushr 8) and 0xFF)
        val b = channel(argb and 0xFF)
        return 0.2126f * r + 0.7152f * g + 0.0722f * b
    }

    /**
     * Only the near-invisible cases: white-on-Frost is ~1.09, ANSI green-on-Frost is ~1.97.
     * A WCAG-sized floor would wash every bright SGR colour into chrome ink.
     */
    private const val MIN_CONTRAST = 1.5f
}
