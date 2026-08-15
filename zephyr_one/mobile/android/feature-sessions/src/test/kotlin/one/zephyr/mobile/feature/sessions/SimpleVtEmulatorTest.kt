package one.zephyr.mobile.feature.sessions

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SimpleVtEmulatorTest {

    @Test
    fun printsPlainTextAndMovesTheCursor() {
        val emulator = SimpleVtEmulator()
        emulator.resize(40, 8)
        emulator.feed("hi\r\nthere".toByteArray())
        val lines = emulator.snapshot(0, 2)
        assertEquals("hi", lines[0].cells.joinToString("") { it.text }.trimEnd())
        assertEquals("there", lines[1].cells.joinToString("") { it.text }.trimEnd())
        assertEquals(5, emulator.cursor().column)
        assertEquals(1, emulator.cursor().row)
    }

    @Test
    fun stripsSgrAndKeepsTheGlyph() {
        val emulator = SimpleVtEmulator()
        emulator.resize(20, 4)
        emulator.feed("\u001B[32mok\u001B[0m".toByteArray())
        val first = emulator.snapshot(0, 1).first().cells.take(2).joinToString("") { it.text }
        assertEquals("ok", first)
        assertTrue(emulator.snapshot(0, 1).first().cells[0].foreground != 0)
    }

    @Test
    fun cupMovesTheCursorBeforePrinting() {
        val emulator = SimpleVtEmulator()
        emulator.resize(20, 6)
        emulator.feed("\u001B[3;4HX".toByteArray())
        assertEquals(4, emulator.cursor().column)
        assertEquals(2, emulator.cursor().row)
        assertEquals("X", emulator.snapshot(0, 3)[2].cells[3].text)
    }
}
