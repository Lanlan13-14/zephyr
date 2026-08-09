package one.zephyr.mobile.feature.sessions

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Sub-row accumulation and the no-steal rule (TERMINAL_EXPERIENCE.md 2.3, 2.4 and the reverse test
 * in 12).
 */
class ScrollbackViewportTest {

    private fun viewport() = ScrollbackViewport(lineHeightPx = 10f, visibleRows = 24)

    @Test
    fun slowDragKeepsSubRowDistanceInsteadOfDroppingIt() {
        val subject = viewport()
        // Three drags that are each less than one row still add up to one row.
        assertEquals(0, subject.drag(-4f, transcriptRows = 1000))
        assertEquals(0, subject.drag(-4f, 1000))
        assertEquals(1, subject.drag(-4f, 1000))
        assertEquals(1, subject.topRow)
    }

    @Test
    fun dragConvertsWholeRowsAndCarriesTheRemainder() {
        val subject = viewport()
        assertEquals(2, subject.drag(-25f, 1000))
        assertEquals(2, subject.topRow)
        assertTrue(subject.hasResidual())
        // The carried -5px plus another -5px completes the third row.
        assertEquals(1, subject.drag(-5f, 1000))
        assertEquals(3, subject.topRow)
    }

    @Test
    fun dragTowardNewerRowsReturnsTowardTheBottom() {
        val subject = viewport()
        subject.drag(-30f, 1000)
        assertEquals(3, subject.topRow)
        subject.drag(25f, 1000)
        assertEquals(1, subject.topRow)
    }

    @Test
    fun boundaryClampsAndClearsTheResidualSoDirectionChangesDoNotSnap() {
        val subject = viewport()
        assertEquals(0, subject.drag(25f, 1000))
        assertEquals(0, subject.topRow)
        assertFalse(subject.hasResidual())
    }

    @Test
    fun scrollByClampsToTheTranscript() {
        val subject = viewport()
        assertEquals(50, subject.scrollBy(200, transcriptRows = 50))
        assertEquals(50, subject.topRow)
        assertEquals(-50, subject.scrollBy(-200, 50))
        assertEquals(0, subject.topRow)
    }

    @Test
    fun outputFollowsTheBottomOnlyWhenAlreadyThere() {
        val subject = viewport()
        assertTrue(subject.followingBottom)
        assertTrue(subject.onOutput(newRows = 5, transcriptRows = 1000))
        assertEquals(0, subject.topRow)
    }

    /** The reverse test: remote output must not pull a reading user back to the bottom. */
    @Test
    fun outputDoesNotStealTheViewportFromAUserWhoScrolledUp() {
        val subject = viewport()
        subject.scrollBy(25, 1000)
        assertFalse(subject.followingBottom)
        assertFalse(subject.onOutput(newRows = 5, transcriptRows = 1005))
        // Shifted by exactly the appended rows, so the same text stays under the finger.
        assertEquals(30, subject.topRow)
    }

    @Test
    fun pageScrollMovesAWholeScreen() {
        val subject = viewport()
        subject.scrollPages(1, 1000)
        assertEquals(24, subject.topRow)
        subject.scrollPages(-1, 1000)
        assertEquals(0, subject.topRow)
    }

    @Test
    fun jumpToBottomClearsPositionAndResidual() {
        val subject = viewport()
        subject.drag(-25f, 1000)
        subject.jumpToBottom()
        assertEquals(0, subject.topRow)
        assertFalse(subject.hasResidual())
    }

    @Test
    fun flingDistanceFollowsTheScrollerDecayAndSignConvention() {
        val subject = viewport()
        // 3000^2 / (2*3000) = 1500px, at 10px per row.
        assertEquals(150, subject.flingRows(-3000f))
        assertEquals(-150, subject.flingRows(3000f))
        assertEquals(0, subject.flingRows(0f))
    }

    @Test
    fun geometryChangeResetsTheResidualSoTheOldLineHeightIsNotReused() {
        val subject = viewport()
        subject.drag(-4f, 1000)
        subject.onGeometryChanged(lineHeightPx = 20f, visibleRows = 40)
        assertFalse(subject.hasResidual())
        subject.scrollPages(1, 1000)
        assertEquals(40, subject.topRow)
    }

    @Test
    fun zeroLineHeightCannotDivideByZero() {
        val subject = ScrollbackViewport(lineHeightPx = 0f)
        assertEquals(0, subject.drag(100f, 1000))
        assertEquals(0, subject.flingRows(3000f))
    }
}
