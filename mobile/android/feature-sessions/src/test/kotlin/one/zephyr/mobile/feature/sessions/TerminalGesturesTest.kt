package one.zephyr.mobile.feature.sessions

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The frozen arbitration table from TERMINAL_EXPERIENCE.md 5.1, plus the reverse test from 12.
 */
class TerminalGesturesTest {

    private fun arbiter() = GestureArbiter()

    @Test
    fun verticalDragWithNoMouseModeScrollsTheTranscript() {
        val subject = arbiter()
        subject.onPointerDown(pointerCount = 1, selectionActive = false)
        assertEquals(
            GestureOwner.SCROLLBACK,
            subject.onMove(1, dx = 0f, dy = 20f, spanDelta = 0f, modes = TerminalModes()),
        )
    }

    @Test
    fun movementInsideTheSlopRadiusDecidesNothing() {
        val subject = arbiter()
        subject.onPointerDown(1, false)
        assertEquals(
            GestureOwner.UNDECIDED,
            subject.onMove(1, dx = 2f, dy = 3f, spanDelta = 0f, modes = TerminalModes()),
        )
    }

    @Test
    fun horizontalDragIsNotATerminalGesture() {
        val subject = arbiter()
        subject.onPointerDown(1, false)
        assertEquals(
            GestureOwner.UNDECIDED,
            subject.onMove(1, dx = 40f, dy = 2f, spanDelta = 0f, modes = TerminalModes()),
        )
    }

    @Test
    fun twoFingerSpanBeyondThePinchSlopWinsPinch() {
        val subject = arbiter()
        subject.onPointerDown(2, false)
        assertEquals(
            GestureOwner.PINCH,
            subject.onMove(2, dx = 0f, dy = 0f, spanDelta = 30f, modes = TerminalModes()),
        )
    }

    @Test
    fun oneFingerDragWithMouseReportingGoesToTheRemoteProgram() {
        val subject = arbiter()
        subject.onPointerDown(1, false)
        assertEquals(
            GestureOwner.REMOTE_MOUSE,
            subject.onMove(1, 0f, 20f, 0f, TerminalModes(mouseReporting = true)),
        )
    }

    @Test
    fun twoFingerScrollWithMouseReportingIsLocalUnlessTheUserChoseOtherwise() {
        val local = arbiter()
        local.onPointerDown(2, false)
        assertEquals(
            GestureOwner.SCROLLBACK,
            local.onMove(2, 0f, 20f, 0f, TerminalModes(mouseReporting = true), twoFingerScrollGoesRemote = false),
        )

        val remote = arbiter()
        remote.onPointerDown(2, false)
        assertEquals(
            GestureOwner.REMOTE_MOUSE,
            remote.onMove(2, 0f, 20f, 0f, TerminalModes(mouseReporting = true), twoFingerScrollGoesRemote = true),
        )
    }

    @Test
    fun alternateBufferWithoutMouseReportingTranslatesToKeys() {
        val subject = arbiter()
        subject.onPointerDown(1, false)
        assertEquals(
            GestureOwner.ALTERNATE_SCROLL,
            subject.onMove(1, 0f, 20f, 0f, TerminalModes(alternateBuffer = true)),
        )
    }

    @Test
    fun activeSelectionOwnsThePointerImmediately() {
        val subject = arbiter()
        assertEquals(GestureOwner.SELECTION, subject.onPointerDown(1, selectionActive = true))
        assertEquals(
            GestureOwner.SELECTION,
            subject.onMove(1, 0f, 40f, 0f, TerminalModes()),
        )
    }

    /** The reverse test from TERMINAL_EXPERIENCE.md 12: a scroll must not become a pinch mid-gesture. */
    @Test
    fun ownerIsStickyForTheRestOfTheGesture() {
        val subject = arbiter()
        subject.onPointerDown(1, false)
        assertEquals(GestureOwner.SCROLLBACK, subject.onMove(1, 0f, 20f, 0f, TerminalModes()))
        assertEquals(GestureOwner.SCROLLBACK, subject.onMove(2, 0f, 0f, 400f, TerminalModes()))
        assertEquals(GestureOwner.SCROLLBACK, subject.current)
    }

    @Test
    fun longPressAlwaysTakesSelection() {
        val subject = arbiter()
        subject.onPointerDown(1, false)
        subject.onMove(1, 0f, 20f, 0f, TerminalModes())
        assertEquals(GestureOwner.SELECTION, subject.onLongPress())
    }

    @Test
    fun gestureEndResetsTheOwner() {
        val subject = arbiter()
        subject.onPointerDown(1, false)
        subject.onMove(1, 0f, 20f, 0f, TerminalModes())
        subject.onGestureEnd()
        assertEquals(GestureOwner.UNDECIDED, subject.current)
    }

    @Test
    fun alternateScrollProducesOneArrowPerRow() {
        assertEquals(0, AlternateScrollTranslator.keysFor(0).size)
        assertEquals(listOf(TerminalKey.ArrowUp, TerminalKey.ArrowUp), AlternateScrollTranslator.keysFor(-2))
        assertEquals(
            listOf(TerminalKey.ArrowDown, TerminalKey.ArrowDown, TerminalKey.ArrowDown),
            AlternateScrollTranslator.keysFor(3),
        )
    }

    @Test
    fun alternateScrollUsesTheSameEncoderAsARealArrowPress() {
        assertEquals("1b 5b 41", hex(AlternateScrollTranslator.encode(-1, TerminalModes())))
        assertEquals(
            "1b 4f 41",
            hex(AlternateScrollTranslator.encode(-1, TerminalModes(applicationCursor = true))),
        )
        assertEquals("1b 5b 42 1b 5b 42", hex(AlternateScrollTranslator.encode(2, TerminalModes())))
    }
}
