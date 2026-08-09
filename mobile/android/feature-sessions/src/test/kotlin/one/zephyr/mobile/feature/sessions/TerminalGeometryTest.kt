package one.zephyr.mobile.feature.sessions

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Rows/columns, the chrome drop order and font stepping (TERMINAL_EXPERIENCE.md 6, 8.2). */
class TerminalGeometryTest {

    @Test
    fun sizeFloorsToWholeCells() {
        val size = TerminalGeometry.sizeFor(widthPx = 800f, heightPx = 410f, cellWidthPx = 10f, lineHeightPx = 20f)
        assertEquals(80, size.columns)
        assertEquals(20, size.rows)
    }

    @Test
    fun sizeNeverFallsBelowTheFloor() {
        val tiny = TerminalGeometry.sizeFor(1f, 1f, 10f, 20f)
        assertEquals(TerminalGeometry.MIN_COLUMNS, tiny.columns)
        assertEquals(TerminalGeometry.MIN_ROWS, tiny.rows)
    }

    @Test
    fun unmeasuredCellMetricsReturnTheFloorInsteadOfDividingByZero() {
        val size = TerminalGeometry.sizeFor(800f, 400f, 0f, 0f)
        assertEquals(TerminalGeometry.MIN_COLUMNS, size.columns)
        assertEquals(TerminalGeometry.MIN_ROWS, size.rows)
    }

    @Test
    fun allChromeSurvivesOnATallViewport() {
        val chrome = TerminalGeometry.chromeFor(
            totalHeightPx = 1000f,
            imeHeightPx = 0f,
            shortcutMatrixHeightPx = 100f,
            dockHeightPx = 80f,
            lineHeightPx = 20f,
        )
        assertTrue(chrome.shortcutMatrix)
        assertTrue(chrome.dock)
        assertTrue(chrome.island)
    }

    /** The frozen IME layout: the island and the dock go, the matrix stays hugging the keyboard. */
    @Test
    fun openImeHidesTheIslandAndTheDockButKeepsTheMatrix() {
        val chrome = TerminalGeometry.chromeFor(
            totalHeightPx = 1000f,
            imeHeightPx = 400f,
            shortcutMatrixHeightPx = 100f,
            dockHeightPx = 80f,
            lineHeightPx = 20f,
        )
        assertTrue(chrome.shortcutMatrix)
        assertFalse(chrome.dock)
        assertFalse(chrome.island)
    }

    @Test
    fun theMatrixIsDroppedBeforeTheDockWhenSpaceRunsOut() {
        val chrome = TerminalGeometry.chromeFor(
            totalHeightPx = 200f,
            imeHeightPx = 0f,
            shortcutMatrixHeightPx = 100f,
            dockHeightPx = 80f,
            lineHeightPx = 20f,
        )
        assertFalse(chrome.shortcutMatrix)
        assertTrue(chrome.dock)
        assertFalse(chrome.island)
    }

    @Test
    fun everythingIsDroppedRatherThanGoingBelowTheFloor() {
        val chrome = TerminalGeometry.chromeFor(
            totalHeightPx = 100f,
            imeHeightPx = 0f,
            shortcutMatrixHeightPx = 100f,
            dockHeightPx = 80f,
            lineHeightPx = 20f,
        )
        assertFalse(chrome.shortcutMatrix)
        assertFalse(chrome.dock)
        assertFalse(chrome.island)
    }

    @Test
    fun heightIsNeverNegativeBecauseNawsWouldInheritIt() {
        val height = TerminalGeometry.terminalHeightPx(
            totalHeightPx = 100f,
            imeHeightPx = 0f,
            shortcutMatrixHeightPx = 100f,
            dockHeightPx = 80f,
            lineHeightPx = 20f,
        )
        assertTrue(height >= TerminalGeometry.MIN_ROWS * 20f)
    }

    @Test
    fun fontCommitsInHalfPointSteps() {
        assertEquals(14.5f, TerminalGeometry.commitFontSp(14.3f), 0.001f)
        assertEquals(14.0f, TerminalGeometry.commitFontSp(14.2f), 0.001f)
    }

    @Test
    fun fontClampsToTheLegibleRange() {
        assertEquals(TerminalGeometry.MAX_FONT_SP, TerminalGeometry.commitFontSp(100f), 0.001f)
        assertEquals(TerminalGeometry.MIN_FONT_SP, TerminalGeometry.commitFontSp(1f), 0.001f)
    }

    @Test
    fun aPinchInsideOneStepDoesNotTriggerAResize() {
        assertFalse(TerminalGeometry.fontChanged(14f, 14.2f))
        assertTrue(TerminalGeometry.fontChanged(14f, 14.3f))
    }
}
