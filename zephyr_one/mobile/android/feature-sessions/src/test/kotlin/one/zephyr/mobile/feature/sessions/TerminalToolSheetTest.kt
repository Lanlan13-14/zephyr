package one.zephyr.mobile.feature.sessions

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TerminalToolSheetTest {
    private fun state() = TerminalWorkspaceState(paneA = "s1")

    @Test
    fun phoneToolUsesInFlowSheetNeverFloatingState() {
        val opened = TerminalWorkspace.openTool(state(), TerminalToolKind.FILES, phone = true)
        assertEquals(listOf(TerminalToolKind.FILES), opened.sheetTools)
        assertEquals(TerminalToolKind.FILES, opened.sheetCurrent)
        assertEquals(TerminalWorkspace.SHEET_MID_FRACTION, opened.sheetFraction, 0.001f)
    }

    @Test
    fun tappingCurrentToolAgainClosesTheSheet() {
        val opened = TerminalWorkspace.openTool(state(), TerminalToolKind.FILES, phone = true)
        val closed = TerminalWorkspace.openTool(opened, TerminalToolKind.FILES, phone = true)
        assertEquals(0f, closed.sheetFraction, 0.001f)
        assertTrue(closed.sheetTools.isEmpty())
    }

    @Test
    fun fastDownwardDragDismisses() {
        assertEquals(0f, TerminalWorkspace.settleSheet(0.60f, 0.71f), 0.001f)
    }

    @Test
    fun shortSheetDismissesEvenAtLowVelocity() {
        assertEquals(0f, TerminalWorkspace.settleSheet(0.19f, 0f), 0.001f)
    }

    @Test
    fun projectedPositionSnapsToNearestDetent() {
        assertEquals(
            TerminalWorkspace.SHEET_MAX_FRACTION,
            TerminalWorkspace.settleSheet(0.88f, -0.20f),
            0.001f,
        )
        assertEquals(
            TerminalWorkspace.SHEET_MID_FRACTION,
            TerminalWorkspace.settleSheet(0.48f, 0.10f),
            0.001f,
        )
    }

    @Test
    fun tabletToolUsesInPageSideDock() {
        val opened = TerminalWorkspace.openTool(state(), TerminalToolKind.NOTES, phone = false)
        assertEquals(TerminalSplitMode.RIGHT, opened.split)
        assertEquals(TerminalToolKind.NOTES, opened.dockCurrent)
        assertTrue(opened.docked.contains(TerminalToolKind.NOTES))
        assertEquals(0f, opened.sheetFraction, 0.001f)
    }
}
