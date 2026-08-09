package one.zephyr.mobile.feature.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The input hand-off from REMOTE_DESKTOP_EXPERIENCE.md 2.
 *
 * The counterpart to [FrameMailbox] and deliberately the opposite: video may be dropped, input may
 * not. The bound is achieved by coalescing superseded *positions* - a later move already carries the
 * truthful pointer location - while every transition survives, because a dropped key-up leaves a
 * modifier stuck down on the remote desktop with nothing on screen to explain it.
 */
class RemoteInputQueueTest {

    // ---- coalescing ------------------------------------------------------------------------------

    @Test
    fun consecutiveMovesWithTheSameButtonMaskCollapseToTheLatest() {
        val subject = RemoteInputQueue()
        subject.offer(RemoteInput.PointerMove(1, 1, RemoteButton.NONE))
        subject.offer(RemoteInput.PointerMove(2, 2, RemoteButton.NONE))
        subject.offer(RemoteInput.PointerMove(3, 3, RemoteButton.NONE))

        assertEquals(1, subject.pendingCount)
        assertEquals(2, subject.coalescedMoves)
        assertEquals(listOf(RemoteInput.PointerMove(3, 3, RemoteButton.NONE)), subject.drain())
    }

    @Test
    fun aMoveWithADifferentButtonMaskIsANewEvent() {
        // The mask change is the drag: merging a pressed move into a hovering one would lose the fact
        // that the button was down for that part of the path.
        val subject = RemoteInputQueue()
        subject.offer(RemoteInput.PointerMove(1, 1, RemoteButton.NONE))
        subject.offer(RemoteInput.PointerMove(2, 2, RemoteButton.PRIMARY))

        assertEquals(2, subject.pendingCount)
        assertEquals(0, subject.coalescedMoves)
    }

    @Test
    fun aMoveDoesNotMergeAcrossAnInterveningTransition() {
        val subject = RemoteInputQueue()
        subject.offer(RemoteInput.PointerMove(1, 1, RemoteButton.NONE))
        subject.offer(RemoteInput.PointerButton(1, 1, RemoteButton.PRIMARY, RemoteButton.PRIMARY, true))
        subject.offer(RemoteInput.PointerMove(2, 2, RemoteButton.NONE))

        assertEquals(3, subject.pendingCount)
        assertEquals(0, subject.coalescedMoves)
    }

    @Test
    fun buttonTransitionsAreNeverMergedEvenWhenIdentical() {
        val subject = RemoteInputQueue()
        val press = RemoteInput.PointerButton(5, 5, RemoteButton.PRIMARY, RemoteButton.PRIMARY, true)
        subject.offer(press)
        subject.offer(press)

        assertEquals(2, subject.pendingCount)
        assertEquals(0, subject.coalescedMoves)
    }

    @Test
    fun wheelNotchesAreNeverMergedBecauseTheyAccumulate() {
        // Two notches are twice the scroll, not the same scroll twice.
        val subject = RemoteInputQueue()
        subject.offer(RemoteInput.Wheel(0, 0, 1))
        subject.offer(RemoteInput.Wheel(0, 0, 1))

        assertEquals(2, subject.pendingCount)
    }

    @Test
    fun keysAndTextAreNeverMerged() {
        val subject = RemoteInputQueue()
        subject.offer(RemoteInput.Key(RemoteKey.Escape, true))
        subject.offer(RemoteInput.Key(RemoteKey.Escape, false))
        subject.offer(RemoteInput.Text("ab"))
        subject.offer(RemoteInput.Text("ab"))

        assertEquals(4, subject.pendingCount)
        assertEquals(0, subject.coalescedMoves)
    }

    // ---- the bound -------------------------------------------------------------------------------

    @Test
    fun aFullQueueSacrificesTheOldestPositionRatherThanATransition() {
        val subject = RemoteInputQueue(capacity = 2)
        subject.offer(RemoteInput.PointerMove(1, 1, RemoteButton.NONE))
        subject.offer(RemoteInput.Key(RemoteKey.Escape, true))

        assertTrue(subject.offer(RemoteInput.Key(RemoteKey.Tab, true)))

        assertEquals(2, subject.pendingCount)
        assertEquals(1, subject.coalescedMoves)
        assertEquals(
            listOf(RemoteInput.Key(RemoteKey.Escape, true), RemoteInput.Key(RemoteKey.Tab, true)),
            subject.drain(),
        )
    }

    @Test
    fun aQueueFullOfTransitionsReportsBackPressureInsteadOfLosingAKeyUp() {
        val subject = RemoteInputQueue(capacity = 2)
        subject.offer(RemoteInput.Key(RemoteKey.Escape, true))
        subject.offer(RemoteInput.Key(RemoteKey.Escape, false))

        assertFalse(subject.offer(RemoteInput.Key(RemoteKey.Tab, true)))

        assertEquals(2, subject.pendingCount)
    }

    @Test
    fun aMoveCanAlwaysBeAcceptedByMergingIntoThePendingOne() {
        // Documented guarantee: offer never returns false because of a move.
        val subject = RemoteInputQueue(capacity = 1)
        subject.offer(RemoteInput.PointerMove(1, 1, RemoteButton.NONE))

        assertTrue(subject.offer(RemoteInput.PointerMove(2, 2, RemoteButton.NONE)))

        assertEquals(1, subject.pendingCount)
    }

    // ---- draining --------------------------------------------------------------------------------

    @Test
    fun pollIsFirstInFirstOut() {
        val subject = RemoteInputQueue()
        subject.offer(RemoteInput.Key(RemoteKey.Escape, true))
        subject.offer(RemoteInput.Key(RemoteKey.Tab, true))

        assertEquals(RemoteInput.Key(RemoteKey.Escape, true), subject.poll())
        assertEquals(RemoteInput.Key(RemoteKey.Tab, true), subject.poll())
        assertNull(subject.poll())
    }

    @Test
    fun drainEmptiesTheQueueAndPreservesOrder() {
        val subject = RemoteInputQueue()
        subject.offer(RemoteInput.Key(RemoteKey.Tab, true))
        subject.offer(RemoteInput.Text("x"))

        val drained = subject.drain()

        assertEquals(2, drained.size)
        assertEquals(RemoteInput.Key(RemoteKey.Tab, true), drained[0])
        assertEquals(0, subject.pendingCount)
        assertEquals(0, subject.drain().size)
    }

    @Test
    fun clearDropsPendingInputButKeepsTheDiagnosticCounter() {
        // The counter is a session statistic for the panel in section 11, not queue state.
        val subject = RemoteInputQueue()
        subject.offer(RemoteInput.PointerMove(1, 1, RemoteButton.NONE))
        subject.offer(RemoteInput.PointerMove(2, 2, RemoteButton.NONE))

        subject.clear()

        assertEquals(0, subject.pendingCount)
        assertEquals(1, subject.coalescedMoves)
    }

    // ---- button masks ----------------------------------------------------------------------------

    @Test
    fun buttonMasksAreIndependentBits() {
        val chord = RemoteButton.PRIMARY or RemoteButton.SECONDARY
        assertTrue(RemoteButton.has(chord, RemoteButton.PRIMARY))
        assertTrue(RemoteButton.has(chord, RemoteButton.SECONDARY))
        assertFalse(RemoteButton.has(chord, RemoteButton.MIDDLE))
        assertFalse(RemoteButton.has(RemoteButton.NONE, RemoteButton.PRIMARY))
    }

    @Test
    fun buttonNamesAreStableForDiagnostics() {
        assertEquals("primary", RemoteButton.name(RemoteButton.PRIMARY))
        assertEquals("middle", RemoteButton.name(RemoteButton.MIDDLE))
        assertEquals("secondary", RemoteButton.name(RemoteButton.SECONDARY))
        assertEquals("button8", RemoteButton.name(8))
    }
}
