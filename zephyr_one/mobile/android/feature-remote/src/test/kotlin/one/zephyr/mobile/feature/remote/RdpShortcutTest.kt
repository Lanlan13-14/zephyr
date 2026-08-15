package one.zephyr.mobile.feature.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RdpShortcutTest {

    @Test
    fun winIsASingleKeyTap() {
        val events = RdpShortcut.WIN.inputs()
        assertEquals(2, events.size)
        assertEquals(RemoteInput.Key(RemoteKey.Modifier(RemoteModifier.META), down = true), events[0])
        assertEquals(RemoteInput.Key(RemoteKey.Modifier(RemoteModifier.META), down = false), events[1])
    }

    @Test
    fun cadUsesRightAltAndDelete() {
        val events = RdpShortcut.CAD.inputs()
        assertEquals(6, events.size)
        assertEquals(RemoteInput.Key(RemoteKey.Modifier(RemoteModifier.CTRL), down = true), events[0])
        assertEquals(RemoteInput.Key(RemoteKey.Modifier(RemoteModifier.ALT, right = true), down = true), events[1])
        assertEquals(RemoteInput.Key(RemoteKey.Delete, down = true), events[2])
        assertEquals(RemoteInput.Key(RemoteKey.Delete, down = false), events[3])
        assertEquals(RemoteInput.Key(RemoteKey.Modifier(RemoteModifier.ALT, right = true), down = false), events[4])
        assertEquals(RemoteInput.Key(RemoteKey.Modifier(RemoteModifier.CTRL), down = false), events[5])
    }

    @Test
    fun winRSendsAPrintableCharacterNotAScanGuess() {
        val events = RdpShortcut.WIN_R.inputs()
        assertTrue(events.contains(RemoteInput.Key(RemoteKey.Character('r'.code), down = true)))
        assertTrue(events.contains(RemoteInput.Key(RemoteKey.Character('r'.code), down = false)))
    }

    @Test
    fun altF4UsesFunctionFour() {
        val events = RdpShortcut.ALT_F4.inputs()
        assertTrue(events.contains(RemoteInput.Key(RemoteKey.Function(4), down = true)))
        assertEquals(RemoteInput.Key(RemoteKey.Function(4), down = false), events[events.lastIndex - 1])
    }

    @Test
    fun sheetListsTheFiveDemoChords() {
        assertEquals(
            listOf(RdpShortcut.WIN, RdpShortcut.CAD, RdpShortcut.ALT_TAB, RdpShortcut.WIN_R, RdpShortcut.ALT_F4),
            RdpShortcut.sheetItems,
        )
    }
}
