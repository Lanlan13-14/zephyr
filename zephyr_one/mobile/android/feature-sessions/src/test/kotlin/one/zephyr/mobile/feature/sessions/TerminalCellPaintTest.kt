package one.zephyr.mobile.feature.sessions

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TerminalCellPaintTest {

    @Test
    fun transparentCellsFallBackToChromeInk() {
        val frostBg = 0xFFF2F4F7.toInt()
        val frostInk = 0xFF1C232B.toInt()
        assertEquals(frostInk, TerminalCellPaint.foreground(0, frostInk, frostBg))
        assertEquals(frostBg, TerminalCellPaint.background(0, frostBg))
    }

    @Test
    fun whiteOnFrostIsReplacedBecauseItIsInvisible() {
        val frostBg = 0xFFF2F4F7.toInt()
        val frostInk = 0xFF1C232B.toInt()
        val painted = TerminalCellPaint.foreground(0xFFFFFFFF.toInt(), frostInk, frostBg)
        assertEquals(frostInk, painted)
        assertTrue(TerminalCellPaint.contrast(0xFFFFFFFF.toInt(), frostBg) < 2.2f)
    }

    @Test
    fun greenOnFrostStaysBecauseItIsReadable() {
        val frostBg = 0xFFF2F4F7.toInt()
        val frostInk = 0xFF1C232B.toInt()
        val green = 0xFF00CD00.toInt()
        assertEquals(green, TerminalCellPaint.foreground(green, frostInk, frostBg))
    }
}
