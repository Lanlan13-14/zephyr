package one.zephyr.mobile.feature.sessions

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The single-owner contract from TERMINAL_EXPERIENCE.md 3, including the four reverse tests in 12.
 *
 * Every assertion here is about *routing*: which subsystem consumed an event and whether it reached
 * the transport. The byte-level tables live in the encoder tests.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class TerminalSurfaceControllerTest {

    private class RecordingTransport : TerminalTransport {
        val writes = mutableListOf<ByteArray>()
        val resizes = mutableListOf<ResizeCall>()

        override suspend fun write(bytes: ByteArray) {
            writes += bytes
        }

        override suspend fun resize(columns: Int, rows: Int, widthPx: Int, heightPx: Int) {
            resizes += ResizeCall(columns, rows, widthPx, heightPx)
        }

        fun hexAt(index: Int): String = hex(writes[index])
    }

    private data class ResizeCall(val columns: Int, val rows: Int, val widthPx: Int, val heightPx: Int)

    private fun controller(scope: CoroutineScope, transport: RecordingTransport) =
        TerminalSurfaceController(transport = transport, scope = scope)

    /** 800x1000 with a 100px matrix and an 80px dock: 80 columns by 41 rows. */
    private fun TerminalSurfaceController.measure(imeHeightPx: Float = 0f, totalWidthPx: Float = 800f) {
        onGeometry(
            totalWidthPx = totalWidthPx,
            totalHeightPx = 1000f,
            imeHeightPx = imeHeightPx,
            shortcutMatrixHeightPx = 100f,
            dockHeightPx = 80f,
            cellWidthPx = 10f,
            lineHeightPx = 20f,
        )
    }

    // ---- reverse test 1: exactly one owner sends Enter -----------------------------------------

    @Test
    fun enterProducesExactlyOneWriteOfOneByte() = runTest {
        val transport = RecordingTransport()
        val subject = controller(backgroundScope, transport)

        subject.onKey(TerminalKey.Enter)
        runCurrent()

        assertEquals(1, transport.writes.size)
        assertEquals("0d", transport.hexAt(0))
    }

    @Test
    fun aKeyDuringCompositionSendsTheTextAndTheKeyInOneWrite() = runTest {
        val transport = RecordingTransport()
        val subject = controller(backgroundScope, transport)

        subject.onComposing("\u4e2d")
        runCurrent()
        assertEquals(0, transport.writes.size)

        subject.onKey(TerminalKey.Enter)
        runCurrent()

        assertEquals(1, transport.writes.size)
        assertEquals("e4 b8 ad 0d", transport.hexAt(0))
        assertFalse(subject.state.value.composition.isActive)
    }

    @Test
    fun compositionUpdatesNeverReachTheTransport() = runTest {
        val transport = RecordingTransport()
        val subject = controller(backgroundScope, transport)

        subject.onComposing("zh")
        subject.onComposing("zho")
        subject.onComposing("zhong")
        runCurrent()

        assertEquals(0, transport.writes.size)
        assertEquals("zhong", subject.state.value.composition.composing)
    }

    @Test
    fun commitWritesOnceThenClearsTheOverlay() = runTest {
        val transport = RecordingTransport()
        val subject = controller(backgroundScope, transport)

        subject.onComposing("zhong")
        subject.onCommit("\u4e2d")
        runCurrent()

        assertEquals(1, transport.writes.size)
        assertEquals("e4 b8 ad", transport.hexAt(0))
        assertEquals(TerminalComposition.idle, subject.state.value.composition)
    }

    @Test
    fun cancelledCompositionWritesNothing() = runTest {
        val transport = RecordingTransport()
        val subject = controller(backgroundScope, transport)

        subject.onComposing("zhong")
        subject.onCancelComposing()
        runCurrent()

        assertEquals(0, transport.writes.size)
        assertFalse(subject.state.value.composition.isActive)
    }

    @Test
    fun charsetAppliesToCommittedText() = runTest {
        val transport = RecordingTransport()
        val subject = controller(backgroundScope, transport)

        subject.setCharset(TerminalCharset.GBK)
        subject.onCommit("\u4e2d")
        runCurrent()

        assertEquals("d6 d0", transport.hexAt(0))
    }

    // ---- reverse test 2: output must not steal the viewport -------------------------------------

    @Test
    fun outputFollowsTheBottomWhenTheUserIsAlreadyThere() = runTest {
        val transport = RecordingTransport()
        val subject = controller(backgroundScope, transport)
        subject.measure()

        subject.onOutput(newRows = 5, transcriptRows = 1000)

        assertEquals(0, subject.state.value.topRow)
        assertEquals(0, subject.missedOutputRows.value)
        assertTrue(subject.state.value.followingBottom)
    }

    @Test
    fun outputDoesNotPullAReadingUserBackToTheBottom() = runTest {
        val transport = RecordingTransport()
        val subject = controller(backgroundScope, transport)
        subject.measure()

        // Establish scrollback so scrollPages has a transcript to move through.
        subject.onOutput(newRows = 1000, transcriptRows = 1000)

        subject.scrollPages(1)
        assertEquals(41, subject.state.value.topRow)

        subject.onOutput(newRows = 5, transcriptRows = 1005)

        assertEquals(46, subject.state.value.topRow)
        assertEquals(5, subject.missedOutputRows.value)
        assertFalse(subject.state.value.followingBottom)
    }

    @Test
    fun jumpToBottomClearsTheMissedCounter() = runTest {
        val transport = RecordingTransport()
        val subject = controller(backgroundScope, transport)
        subject.measure()

        subject.scrollPages(1)
        subject.onOutput(5, 1005)
        subject.jumpToBottom()

        assertEquals(0, subject.state.value.topRow)
        assertEquals(0, subject.missedOutputRows.value)
    }

    @Test
    fun typingReturnsToTheLiveOutput() = runTest {
        val transport = RecordingTransport()
        val subject = controller(backgroundScope, transport)
        subject.measure()

        subject.scrollPages(1)
        subject.onKey(TerminalKey.Character('a'.code))
        runCurrent()

        assertEquals(0, subject.state.value.topRow)
    }

    // ---- CJK composition: no scroll, then at most one correction --------------------------------

    @Test
    fun theViewportDoesNotMoveWhileACompositionIsOpen() = runTest {
        val transport = RecordingTransport()
        val subject = controller(backgroundScope, transport)
        subject.measure()

        // Establish scrollback so scrollPages has a transcript to move through.
        subject.onOutput(newRows = 1000, transcriptRows = 1000)
        subject.scrollPages(1)

        subject.onComposing("zh")
        subject.onOutput(newRows = 3, transcriptRows = 1003)

        assertEquals(41, subject.state.value.topRow)
    }

    @Test
    fun exactlyOneCorrectionIsAppliedAfterTheComposition() = runTest {
        val transport = RecordingTransport()
        val subject = controller(backgroundScope, transport)
        subject.measure()

        // Establish scrollback so scrollPages has a transcript to move through.
        subject.onOutput(newRows = 1000, transcriptRows = 1000)
        subject.scrollPages(1)

        subject.onComposing("zh")
        subject.onOutput(3, 1003)
        subject.onOutput(4, 1007)
        subject.onCancelComposing()

        // One correction covering the whole burst, not one per output.
        assertEquals(48, subject.state.value.topRow)
        assertEquals(7, subject.missedOutputRows.value)

        // The budget is spent; a second cancel changes nothing.
        subject.onCancelComposing()
        assertEquals(48, subject.state.value.topRow)
    }

    // ---- reverse test 3: mouse mode must route correctly ---------------------------------------

    @Test
    fun wheelBecomesAMouseReportWhenTrackingIsActive() = runTest {
        val transport = RecordingTransport()
        val subject = controller(backgroundScope, transport)
        subject.measure()
        subject.onModes(TerminalModes(mouseReporting = true, mouseProtocol = MouseProtocol.SGR))

        subject.onWheel(notches = 1, column = 10, row = 20)
        runCurrent()

        assertEquals(1, transport.writes.size)
        assertEquals("1b 5b 3c 36 35 3b 31 30 3b 32 30 4d", transport.hexAt(0))
        assertEquals(0, subject.state.value.topRow)
    }

    @Test
    fun wheelScrollsLocallyWhenTrackingIsOff() = runTest {
        val transport = RecordingTransport()
        val subject = controller(backgroundScope, transport)
        subject.measure()
        subject.onOutput(0, 1000)

        subject.onWheel(notches = -3)
        runCurrent()

        assertEquals(0, transport.writes.size)
        assertEquals(3, subject.state.value.topRow)
    }

    @Test
    fun wheelOnTheAlternateBufferBecomesArrowKeys() = runTest {
        val transport = RecordingTransport()
        val subject = controller(backgroundScope, transport)
        subject.measure()
        subject.onModes(TerminalModes(alternateBuffer = true))

        subject.onWheel(notches = 2)
        runCurrent()

        assertEquals(1, transport.writes.size)
        assertEquals("1b 5b 42 1b 5b 42", transport.hexAt(0))
    }

    /**
     * A drag on the alternate buffer must agree with the wheel.
     *
     * Both paths mean the same thing by "toward the live bottom", so a finger moving up (positive
     * dyPx in the platform convention ScrollbackViewport.drag documents) has to produce the same
     * ArrowDown that a positive wheel notch produces. The two disagreed until the sign in rowsFor
     * was corrected, which would have scrolled less and man backwards.
     */
    @Test
    fun alternateScrollDragAgreesWithTheWheelDirection() = runTest {
        val transport = RecordingTransport()
        val subject = controller(backgroundScope, transport)
        subject.measure()
        subject.onModes(TerminalModes(alternateBuffer = true))

        subject.onPointerDown(1)
        subject.onPointerMove(1, dxPx = 0f, dyPx = 40f, spanDeltaPx = 0f)
        runCurrent()

        assertEquals(GestureOwner.ALTERNATE_SCROLL, subject.state.value.gestureOwner)
        assertEquals("1b 5b 42 1b 5b 42", transport.hexAt(0))
    }

    @Test
    fun alternateScrollDragUpwardSendsArrowUp() = runTest {
        val transport = RecordingTransport()
        val subject = controller(backgroundScope, transport)
        subject.measure()
        subject.onModes(TerminalModes(alternateBuffer = true))

        subject.onPointerDown(1)
        subject.onPointerMove(1, dxPx = 0f, dyPx = -40f, spanDeltaPx = 0f)
        runCurrent()

        assertEquals("1b 5b 41 1b 5b 41", transport.hexAt(0))
    }
    @Test
    fun dragWithTrackingActiveReportsMotionRatherThanScrolling() = runTest {
        val transport = RecordingTransport()
        val subject = controller(backgroundScope, transport)
        subject.measure()
        subject.onModes(
            TerminalModes(mouseReporting = true, mouseButtonMotion = true, mouseProtocol = MouseProtocol.SGR),
        )

        subject.onPointerDown(1)
        subject.onPointerMove(pointerCount = 1, dxPx = 0f, dyPx = 40f, spanDeltaPx = 0f, column = 5, row = 6)
        runCurrent()

        assertEquals(GestureOwner.REMOTE_MOUSE, subject.state.value.gestureOwner)
        assertEquals("1b 5b 3c 33 32 3b 35 3b 36 4d", transport.hexAt(0))
        assertEquals(0, subject.state.value.topRow)
    }

    @Test
    fun dragWithoutTrackingScrollsTheTranscriptAndSendsNothing() = runTest {
        val transport = RecordingTransport()
        val subject = controller(backgroundScope, transport)
        subject.measure()
        subject.onOutput(0, 1000)

        subject.onPointerDown(1)
        subject.onPointerMove(1, dxPx = 0f, dyPx = -40f, spanDeltaPx = 0f)
        runCurrent()

        assertEquals(GestureOwner.SCROLLBACK, subject.state.value.gestureOwner)
        assertEquals(0, transport.writes.size)
        assertEquals(2, subject.state.value.topRow)
    }

    @Test
    fun tapDuringSelectionExitsSelectionInsteadOfReachingTheProgram() = runTest {
        val transport = RecordingTransport()
        val subject = controller(backgroundScope, transport)
        subject.onModes(TerminalModes(mouseReporting = true, mouseProtocol = MouseProtocol.SGR))
        subject.setSelectionActive(true)

        assertTrue(subject.onTap(column = 5, row = 6))
        runCurrent()

        assertEquals(0, transport.writes.size)
        assertFalse(subject.state.value.selectionActive)
    }

    @Test
    fun tapWithTrackingActiveSendsPressAndRelease() = runTest {
        val transport = RecordingTransport()
        val subject = controller(backgroundScope, transport)
        subject.onModes(TerminalModes(mouseReporting = true, mouseProtocol = MouseProtocol.SGR))

        assertFalse(subject.onTap(column = 5, row = 6))
        runCurrent()

        assertEquals("1b 5b 3c 30 3b 35 3b 36 4d 1b 5b 3c 30 3b 35 3b 36 6d", transport.hexAt(0))
    }

    @Test
    fun tapWithoutTrackingIsAFocusRequestAndSendsNothing() = runTest {
        val transport = RecordingTransport()
        val subject = controller(backgroundScope, transport)

        assertTrue(subject.onTap(column = 5, row = 6))
        runCurrent()

        assertEquals(0, transport.writes.size)
    }

    // ---- reverse test 4: chrome and geometry must agree ----------------------------------------

    @Test
    fun geometryProducesTheSizeAndTheChromeFromTheSameNumbers() = runTest {
        val transport = RecordingTransport()
        val subject = controller(backgroundScope, transport)

        subject.measure()

        val state = subject.state.value
        assertEquals(80, state.size.columns)
        assertEquals(41, state.size.rows)
        assertTrue(state.chrome.shortcutMatrix)
        assertTrue(state.chrome.dock)
        assertTrue(state.chrome.island)
        assertFalse(state.keyboardVisible)
    }

    @Test
    fun openImeHidesTheIslandAndDockAndResizesTheViewport() = runTest {
        val transport = RecordingTransport()
        val subject = controller(backgroundScope, transport)

        subject.measure(imeHeightPx = 400f)

        val state = subject.state.value
        assertTrue(state.keyboardVisible)
        assertTrue(state.chrome.shortcutMatrix)
        assertFalse(state.chrome.dock)
        assertFalse(state.chrome.island)
        assertEquals(25, state.size.rows)
    }

    @Test
    fun resizeIsDebouncedAndTheLastValueStillArrives() = runTest {
        val transport = RecordingTransport()
        val subject = controller(backgroundScope, transport)

        subject.measure(totalWidthPx = 800f)
        subject.measure(totalWidthPx = 600f)
        subject.measure(totalWidthPx = 400f)
        advanceTimeBy(TerminalGeometry.RESIZE_DEBOUNCE_MAX_MS + 1)
        runCurrent()

        assertEquals(1, transport.resizes.size)
        assertEquals(ResizeCall(columns = 40, rows = 41, widthPx = 400, heightPx = 820), transport.resizes[0])
    }

    @Test
    fun anUnchangedSizeDoesNotResizeAgain() = runTest {
        val transport = RecordingTransport()
        val subject = controller(backgroundScope, transport)

        subject.measure()
        advanceTimeBy(TerminalGeometry.RESIZE_DEBOUNCE_MAX_MS + 1)
        runCurrent()
        subject.measure()
        advanceTimeBy(TerminalGeometry.RESIZE_DEBOUNCE_MAX_MS + 1)
        runCurrent()

        assertEquals(1, transport.resizes.size)
    }

    // ---- shortcut matrix -----------------------------------------------------------------------

    @Test
    fun aLatchedModifierAppliesToTheNextKeyThenClears() = runTest {
        val transport = RecordingTransport()
        val subject = controller(backgroundScope, transport)

        subject.onExtraKey(ExtraKeysLayout.byId("ctrl")!!)
        runCurrent()
        assertEquals(0, transport.writes.size)
        assertEquals(LatchState.ONE_SHOT, subject.state.value.latches.ctrl)

        subject.onKey(TerminalKey.Character('c'.code))
        runCurrent()

        assertEquals("03", transport.hexAt(0))
        assertEquals(LatchState.OFF, subject.state.value.latches.ctrl)

        subject.onKey(TerminalKey.Character('c'.code))
        runCurrent()
        assertEquals("63", transport.hexAt(1))
    }

    @Test
    fun anExtraKeyActionNeverBecomesBytes() = runTest {
        val transport = RecordingTransport()
        val subject = controller(backgroundScope, transport)

        subject.onExtraKey(ExtraKeysLayout.byId("keyboard")!!)
        runCurrent()

        assertEquals(0, transport.writes.size)
    }

    @Test
    fun anExtraKeyThatIsAKeyDoesBecomeBytes() = runTest {
        val transport = RecordingTransport()
        val subject = controller(backgroundScope, transport)

        subject.onExtraKey(ExtraKeysLayout.byId("esc")!!)
        runCurrent()

        assertEquals("1b", transport.hexAt(0))
    }

    @Test
    fun shiftPageUpScrollsLocallyAndIsNotForwarded() = runTest {
        val transport = RecordingTransport()
        val subject = controller(backgroundScope, transport)
        subject.measure()
        subject.onOutput(0, 1000)

        assertFalse(subject.onKey(TerminalKeyStroke(TerminalKey.PageUp, shift = true)))
        runCurrent()

        assertEquals(0, transport.writes.size)
        assertEquals(41, subject.state.value.topRow)
    }

    @Test
    fun anUnmodifiedPageUpIsForwardedToTheProgram() = runTest {
        val transport = RecordingTransport()
        val subject = controller(backgroundScope, transport)
        subject.measure()

        assertTrue(subject.onKey(TerminalKey.PageUp))
        runCurrent()

        assertEquals("1b 5b 35 7e", transport.hexAt(0))
    }

    // ---- paste ---------------------------------------------------------------------------------

    @Test
    fun aSmallPasteGoesStraightThrough() = runTest {
        val transport = RecordingTransport()
        val subject = controller(backgroundScope, transport)

        subject.onPaste("ls")
        runCurrent()

        assertEquals("6c 73", transport.hexAt(0))
        assertEquals(null, subject.state.value.pendingPaste)
    }

    @Test
    fun aMultiLinePasteWaitsForConfirmationInsteadOfExecuting() = runTest {
        val transport = RecordingTransport()
        val subject = controller(backgroundScope, transport)

        subject.onPaste("ls\n")
        runCurrent()

        assertEquals(0, transport.writes.size)
        assertEquals(2, subject.state.value.pendingPaste?.lineCount)
    }

    @Test
    fun confirmingWithoutTheTrailingNewlineLeavesTheCommandOnThePrompt() = runTest {
        val transport = RecordingTransport()
        val subject = controller(backgroundScope, transport)

        subject.onPaste("ls\n")
        subject.onPasteConfirmed(keepTrailingNewline = false)
        runCurrent()

        assertEquals("6c 73", transport.hexAt(0))
        assertEquals(null, subject.state.value.pendingPaste)
    }

    @Test
    fun cancellingAPasteSendsNothing() = runTest {
        val transport = RecordingTransport()
        val subject = controller(backgroundScope, transport)

        subject.onPaste("ls\n")
        subject.onPasteCancelled()
        runCurrent()

        assertEquals(0, transport.writes.size)
        assertEquals(null, subject.state.value.pendingPaste)
    }

    @Test
    fun bracketedPasteIsWrappedWhenTheProgramEnabledIt() = runTest {
        val transport = RecordingTransport()
        val subject = controller(backgroundScope, transport)
        subject.onModes(TerminalModes(bracketedPaste = true))

        subject.onPaste("ls")
        runCurrent()

        assertEquals("1b 5b 32 30 30 7e 6c 73 1b 5b 32 30 31 7e", transport.hexAt(0))
    }

    // ---- pinch ---------------------------------------------------------------------------------

    @Test
    fun pinchChangesTheFontInSteps() = runTest {
        val transport = RecordingTransport()
        val subject = controller(backgroundScope, transport)
        subject.measure()

        subject.onPointerDown(2)
        subject.onPointerMove(pointerCount = 2, dxPx = 0f, dyPx = 0f, spanDeltaPx = 200f)

        assertEquals(GestureOwner.PINCH, subject.state.value.gestureOwner)
        assertTrue(subject.state.value.fontSp > 14f)
    }

    @Test
    fun longPressTakesSelectionAndBlocksRemoteMouse() = runTest {
        val transport = RecordingTransport()
        val subject = controller(backgroundScope, transport)
        subject.onModes(TerminalModes(mouseReporting = true, mouseProtocol = MouseProtocol.SGR))

        subject.onPointerDown(1)
        subject.onLongPress()
        subject.onPointerMove(1, 0f, 40f, 0f, column = 5, row = 6)
        runCurrent()

        assertEquals(GestureOwner.SELECTION, subject.state.value.gestureOwner)
        assertEquals(0, transport.writes.size)
    }

    @Test
    fun imeClipboardAndCandidateCommitsKeepCharacterOrder() = runTest {
        val transport = RecordingTransport()
        val subject = controller(backgroundScope, transport)

        // Gboard / Samsung IME clipboard and candidate strip fire one commit per code point.
        "netlab".forEach { ch -> subject.enqueueWrite(byteArrayOf(ch.code.toByte())) }
        runCurrent()

        assertEquals("netlab", transport.writes.joinToString("") { String(it) })
    }
}
