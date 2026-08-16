package one.zephyr.mobile.feature.sessions

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class TerminalToolSheetTest {
    private fun state() = TerminalWorkspaceState(paneA = "s1")

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
    fun tabletToolUsesInPageSideDock() {
        val opened = TerminalWorkspace.openTool(state(), TerminalToolKind.NOTES, phone = false)
        assertEquals(TerminalSplitMode.RIGHT, opened.split)
        assertEquals(TerminalToolKind.NOTES, opened.dockCurrent)
        assertTrue(opened.docked.contains(TerminalToolKind.NOTES))
        assertEquals(0f, opened.sheetFraction, 0.001f)
    }
}
