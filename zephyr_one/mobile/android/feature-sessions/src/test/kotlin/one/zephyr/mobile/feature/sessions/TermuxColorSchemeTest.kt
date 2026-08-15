package one.zephyr.mobile.feature.sessions

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TermuxColorSchemeTest {
    @Test
    fun frostAnsiColorsMeetReadableContrastFloor() {
        val background = 0xFFF3F5F7.toInt()
        val palette = readableAnsiPalette(background)
        assertEquals(16, palette.size)
        palette.forEachIndexed { index, color ->
            assertTrue(
                "ANSI $index contrast was ${TerminalCellPaint.contrast(color, background)}",
                TerminalCellPaint.contrast(color, background) >= 4.45f,
            )
        }
    }

    @Test
    fun darkTerminalKeepsXtermSemanticColors() {
        val palette = readableAnsiPalette(0xFF07090C.toInt())
        assertEquals(0xFF00CD00.toInt(), palette[2])
        assertEquals(0xFF6495ED.toInt(), palette[4])
        assertEquals(0xFFFFFFFF.toInt(), palette[15])
    }
}
