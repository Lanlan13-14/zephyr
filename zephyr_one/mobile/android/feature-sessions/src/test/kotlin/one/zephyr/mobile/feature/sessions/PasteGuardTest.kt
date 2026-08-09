package one.zephyr.mobile.feature.sessions

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Paste policy from TERMINAL_EXPERIENCE.md 4.3. */
class PasteGuardTest {

    @Test
    fun shortSingleLineTextGoesStraightThrough() {
        val decision = PasteGuard.decide("ls -la", bracketed = false)
        assertTrue(decision is PasteDecision.Immediate)
        assertEquals(hex(ascii("ls -la")), hex((decision as PasteDecision.Immediate).bytes))
    }

    @Test
    fun anyNewlineRequiresConfirmationBecauseItWouldExecute() {
        val decision = PasteGuard.decide("rm -rf /\n", bracketed = false)
        assertTrue(decision is PasteDecision.NeedsConfirmation)
        val confirmation = decision as PasteDecision.NeedsConfirmation
        assertEquals(2, confirmation.lineCount)
        assertTrue(confirmation.endsWithNewline)
    }

    @Test
    fun carriageReturnCountsAsANewline() {
        assertTrue(PasteGuard.needsConfirmation("a\rb"))
    }

    @Test
    fun theSizeThresholdIsExclusive() {
        assertFalse(PasteGuard.needsConfirmation("a".repeat(PasteGuard.CONFIRM_BYTES)))
        assertTrue(PasteGuard.needsConfirmation("a".repeat(PasteGuard.CONFIRM_BYTES + 1)))
    }

    @Test
    fun bracketedPasteWrapsTheBodyWithTheFrozenMarkers() {
        val decision = PasteGuard.decide("ls", bracketed = true) as PasteDecision.Immediate
        assertEquals(
            hex(ascii(PasteGuard.BRACKET_START + "ls" + PasteGuard.BRACKET_END)),
            hex(decision.bytes),
        )
    }

    /** The frozen option: paste the command onto the prompt without running it. */
    @Test
    fun droppingTheTrailingNewlineLeavesTheCommandUnexecuted() {
        assertEquals(
            hex(ascii("rm -rf /")),
            hex(PasteGuard.confirmed("rm -rf /\n", bracketed = false, keepTrailingNewline = false)),
        )
    }

    @Test
    fun keepingTheTrailingNewlineSendsItVerbatim() {
        assertEquals(
            hex(ascii("ls\n")),
            hex(PasteGuard.confirmed("ls\n", bracketed = false, keepTrailingNewline = true)),
        )
    }

    /**
     * Under a multi-byte code page the markers must stay ASCII, otherwise the terminal sees a
     * mangled sequence instead of a bracketed paste.
     */
    @Test
    fun bracketMarkersStayAsciiUnderALegacyCodePage() {
        val bytes = PasteGuard.confirmed(
            text = "\u4e2d",
            bracketed = true,
            keepTrailingNewline = true,
            encoding = TerminalCharset.GBK,
        )
        assertEquals("1b 5b 32 30 30 7e d6 d0 1b 5b 32 30 31 7e", hex(bytes))
    }

    @Test
    fun emptyTextHasNoLines() {
        val decision = PasteGuard.decide("", bracketed = false)
        assertTrue(decision is PasteDecision.Immediate)
    }

    @Test
    fun immediateDecisionComparesBytesByValue() {
        assertEquals(
            PasteDecision.Immediate(byteArrayOf(1, 2)),
            PasteDecision.Immediate(byteArrayOf(1, 2)),
        )
    }
}
