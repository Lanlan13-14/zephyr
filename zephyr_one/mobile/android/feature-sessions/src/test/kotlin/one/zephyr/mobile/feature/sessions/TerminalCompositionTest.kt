package one.zephyr.mobile.feature.sessions

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The IME contract from TERMINAL_EXPERIENCE.md 3: an update writes nothing, a commit writes exactly
 * once, and a cancel writes nothing at all.
 */
class TerminalCompositionTest {

    @Test
    fun compositionUpdateNeverReachesThePty() {
        val outcome = TerminalInput.composing("zhong")
        assertFalse(outcome.writesToPty)
        assertEquals("zhong", outcome.composition.composing)
        assertTrue(outcome.composition.isActive)
    }

    @Test
    fun compositionCursorIsClampedToTheText() {
        assertEquals(2, TerminalInput.composing("ab", cursor = 99).composition.cursor)
        assertEquals(0, TerminalInput.composing("ab", cursor = -5).composition.cursor)
    }

    @Test
    fun commitWritesOnceAndClearsTheOverlay() {
        val outcome = TerminalInput.commit("\u4e2d")
        assertEquals("e4 b8 ad", hex(outcome.bytes))
        assertEquals(TerminalComposition.idle, outcome.composition)
    }

    @Test
    fun commitHonoursTheSessionCharset() {
        assertEquals("d6 d0", hex(TerminalInput.commit("\u4e2d", TerminalCharset.GBK).bytes))
    }

    @Test
    fun finishCommitsPendingTextBecauseThatIsThePlatformContract() {
        val pending = TerminalComposition("\u4e2d", 1)
        assertEquals("e4 b8 ad", hex(TerminalInput.finish(pending).bytes))
    }

    @Test
    fun finishWithNothingPendingWritesNothing() {
        assertFalse(TerminalInput.finish(TerminalComposition.idle).writesToPty)
    }

    @Test
    fun cancelWritesNothing() {
        val outcome = TerminalInput.cancel()
        assertFalse(outcome.writesToPty)
        assertEquals(TerminalComposition.idle, outcome.composition)
    }

    /** Ordering matters: the composed text must precede the newline, never follow it. */
    @Test
    fun aKeyDuringCompositionCommitsTheTextFirst() {
        val outcome = TerminalInput.key(
            current = TerminalComposition("\u4e2d", 1),
            stroke = TerminalKeyStroke(TerminalKey.Enter),
        )
        assertEquals("e4 b8 ad 0d", hex(outcome.bytes))
        assertEquals(TerminalComposition.idle, outcome.composition)
    }

    @Test
    fun aKeyWithNoCompositionIsJustTheKey() {
        val outcome = TerminalInput.key(TerminalComposition.idle, TerminalKeyStroke(TerminalKey.Enter))
        assertEquals("0d", hex(outcome.bytes))
    }

    @Test
    fun outcomeEqualityComparesBytesByValueSoAssertionsAreUsable() {
        assertEquals(
            InputOutcome(TerminalComposition.idle, byteArrayOf(1, 2)),
            InputOutcome(TerminalComposition.idle, byteArrayOf(1, 2)),
        )
    }
}
