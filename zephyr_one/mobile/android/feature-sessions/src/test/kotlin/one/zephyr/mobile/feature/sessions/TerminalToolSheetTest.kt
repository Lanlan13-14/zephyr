package one.zephyr.mobile.feature.sessions

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class TerminalToolSheetTest {
    private fun state() = TerminalWorkspaceState(activeSessionId = "s1")

    private fun codeOnly(source: String): String =
        source
            .replace(Regex("/\\*[\\s\\S]*?\\*/"), " ")
            .replace(Regex("//[^\\n]*"), " ")

    private val sheetSource: String by lazy {
        val relative = "src/main/kotlin/one/zephyr/mobile/feature/sessions/TerminalToolSheet.kt"
        val start = File(".").canonicalFile
        val file = generateSequence(start) { it.parentFile }
            .flatMap { root -> sequenceOf(File(root, relative), File(root, "feature-sessions/$relative")) }
            .first { it.exists() }
        file.readText()
    }

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
        val closing = TerminalWorkspace.openTool(opened, TerminalToolKind.FILES, phone = true)
        assertEquals(0f, closing.sheetFraction, 0.001f)
        assertEquals(TerminalToolKind.FILES, closing.sheetCurrent)
        assertEquals(listOf(TerminalToolKind.FILES), closing.sheetTools)
        val gone = TerminalWorkspace.finishClose(closing)
        assertTrue(gone.sheetTools.isEmpty())
        assertEquals(null, gone.sheetCurrent)
    }

    @Test
    fun finishCloseDoesNotDropAnOpenSheet() {
        val opened = TerminalWorkspace.openTool(state(), TerminalToolKind.FILES, phone = true)
        val same = TerminalWorkspace.finishClose(opened)
        assertEquals(TerminalToolKind.FILES, same.sheetCurrent)
        assertEquals(TerminalWorkspace.SHEET_MID_FRACTION, same.sheetFraction, 0.001f)
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
    fun dockerAndMonitorDrawersKeepTheIme() {
        assertTrue(TerminalToolKind.FILES.keepsIme)
        assertTrue(TerminalToolKind.STATS.keepsIme)
        assertTrue(TerminalToolKind.DOCKER.keepsIme)
        assertTrue(!TerminalToolKind.THEME.keepsIme)
        val opened = TerminalWorkspace.openTool(state(), TerminalToolKind.DOCKER, phone = true)
        assertEquals(TerminalToolKind.DOCKER, opened.sheetCurrent)
    }

    @Test
    fun phoneSheetIsASquareChromeFillNotARoundedCard() {
        val source = codeOnly(sheetSource)
        assertTrue(source.contains(".background(colors.chrome)"))
        assertFalse(source.contains("RoundedCornerShape(topStart"))
        assertFalse(source.contains(".border("))
        assertTrue(source.contains("clip(RoundedCornerShape(3.dp))"))
    }

    @Test
    fun tabletToolUsesOppositePanel() {
        /* Pad landscape: the tool takes the side opposite the terminal instead
         * of a bottom sheet. Tapping the same tool again hands the side back
         * to the home surface. */
        val opened = TerminalWorkspace.openTool(state(), TerminalToolKind.NOTES, phone = false)
        assertEquals(TerminalToolKind.NOTES, opened.padPanelTool)
        assertEquals(0f, opened.sheetFraction, 0.001f)
        val closed = TerminalWorkspace.openTool(opened, TerminalToolKind.NOTES, phone = false)
        assertEquals(null, closed.padPanelTool)
    }

    @Test
    fun padGutterDragWidensAndNarrowsTheTerminal() {
        /* Terminal on the right: dragging left (negative dx) grows it. */
        val grown = TerminalWorkspace.dragPadTermFraction(0.5f, -200f, 1000f, PadTermSide.RIGHT)
        assertEquals(0.7f, grown, 0.001f)
        val shrunk = TerminalWorkspace.dragPadTermFraction(0.5f, 200f, 1000f, PadTermSide.RIGHT)
        assertEquals(0.3f, shrunk, 0.001f)
        /* Terminal on the left mirrors the direction. */
        val grownLeft = TerminalWorkspace.dragPadTermFraction(0.5f, 200f, 1000f, PadTermSide.LEFT)
        assertEquals(0.7f, grownLeft, 0.001f)
        /* The drag can push the terminal to full width, hiding the panel. */
        val full = TerminalWorkspace.dragPadTermFraction(0.9f, -400f, 1000f, PadTermSide.RIGHT)
        assertEquals(TerminalWorkspace.PAD_MAX_TERM_FRACTION, full, 0.001f)
        /* …and clamps at a readable minimum rather than collapsing the pane. */
        val min = TerminalWorkspace.dragPadTermFraction(0.4f, 400f, 1000f, PadTermSide.RIGHT)
        assertEquals(TerminalWorkspace.PAD_MIN_TERM_FRACTION, min, 0.001f)
    }

    @Test
    fun openingAPadToolFromFullScreenRestoresTheDefaultHalf() {
        val fullScreen = state().copy(padTermFraction = TerminalWorkspace.PAD_MAX_TERM_FRACTION)
        val opened = TerminalWorkspace.openTool(fullScreen, TerminalToolKind.STATS, phone = false)
        assertEquals(TerminalToolKind.STATS, opened.padPanelTool)
        assertEquals(TerminalWorkspace.PAD_DEFAULT_TERM_FRACTION, opened.padTermFraction, 0.001f)
    }
}
