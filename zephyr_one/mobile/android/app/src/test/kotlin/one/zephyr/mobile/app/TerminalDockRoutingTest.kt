package one.zephyr.mobile.app

import one.zephyr.mobile.feature.sessions.TerminalDockItem
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

/**
 * Pins the host fallback for the demo context dock.
 *
 * CI failed on :app:compilePrereleaseKotlin because [onTerminalDock] still switched on
 * `TerminalDockItem.SESSIONS` after the dock dropped that item for COPY/PASTE/STATS/THEME.
 * The mapper is exhaustive on the enum, so a new dock entry is a compile error here too.
 */
class TerminalDockRoutingTest {

    @Test
    fun everyDockItemHasALeaveDecision() {
        val expected = mapOf(
            TerminalDockItem.KEYBOARD to TerminalDockLeave.STAY,
            TerminalDockItem.COPY to TerminalDockLeave.STAY,
            TerminalDockItem.PASTE to TerminalDockLeave.STAY,
            TerminalDockItem.FILES to TerminalDockLeave.FILES,
            TerminalDockItem.SNIPPETS to TerminalDockLeave.SNIPPETS,
            TerminalDockItem.NOTES to TerminalDockLeave.NOTES,
            TerminalDockItem.STATS to TerminalDockLeave.STATS,
            TerminalDockItem.THEME to TerminalDockLeave.APPEARANCE,
            TerminalDockItem.DISCONNECT to TerminalDockLeave.STAY,
        )
        assertEquals(TerminalDockItem.entries.toSet(), expected.keys)
        for ((item, leave) in expected) {
            assertEquals(item.name, leave, terminalDockLeave(item))
        }
    }

    @Test
    fun sessionsIsNotADockItem() {
        assertFalse(TerminalDockItem.entries.any { it.name == "SESSIONS" })
    }
}
