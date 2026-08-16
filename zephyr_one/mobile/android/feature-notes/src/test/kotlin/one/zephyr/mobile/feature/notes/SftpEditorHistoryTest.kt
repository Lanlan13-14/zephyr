package one.zephyr.mobile.feature.notes

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SftpEditorHistoryTest {

    @Test
    fun successiveKeystrokesShareOneUndoEntry() {
        val history = SftpEditorHistory(coalesceMs = 400L)
        var text = "hello"
        text = type(history, text, "hello ", 1_000L)
        text = type(history, text, "hello w", 1_050L)
        text = type(history, text, "hello wo", 1_100L)
        text = type(history, text, "hello wor", 1_150L)
        assertEquals(1, history.undoSize)
        assertEquals("hello", history.undo(text))
    }

    @Test
    fun aPauseStartsANewUndoEntry() {
        val history = SftpEditorHistory(coalesceMs = 400L)
        var text = "a"
        text = type(history, text, "ab", 1_000L)
        text = type(history, text, "abc", 1_600L)
        assertEquals(2, history.undoSize)
        assertEquals("ab", history.undo(text))
        assertEquals("a", history.undo("ab"))
    }

    @Test
    fun identicalTextDoesNotGrowHistory() {
        val history = SftpEditorHistory()
        assertFalse(history.record("same", "same", 1L))
        assertEquals(0, history.undoSize)
    }

    @Test
    fun redoIsClearedByANewEdit() {
        val history = SftpEditorHistory(coalesceMs = 0L)
        history.record("a", "ab", 1L)
        val undone = history.undo("ab")
        assertEquals("a", undone)
        assertTrue(history.canRedo())
        history.record("a", "az", 2L)
        assertFalse(history.canRedo())
        assertNull(history.redo("az"))
    }

    @Test
    fun aLargePasteDoesNotCoalesceWithThePreviousKeystroke() {
        val history = SftpEditorHistory(coalesceMs = 400L, coalesceChars = 24)
        var text = "head"
        text = type(history, text, "headx", 1_000L)
        val pasted = "headx" + "y".repeat(200)
        history.record(text, pasted, 1_050L)
        assertEquals(2, history.undoSize)
        assertEquals("headx", history.undo(pasted))
    }

    @Test
    fun deletingTheCoalesceWindowWouldSnapshotEveryCharacter() {
        val coalesced = SftpEditorHistory(coalesceMs = 400L)
        var text = ""
        var now = 1_000L
        for (ch in "typing-feels-fine") {
            val next = text + ch
            coalesced.record(text, next, now)
            text = next
            now += 20L
        }
        assertEquals(1, coalesced.undoSize)

        val naive = SftpEditorHistory(coalesceMs = 0L)
        text = ""
        now = 1_000L
        for (ch in "typing-feels-fine") {
            val next = text + ch
            naive.record(text, next, now)
            text = next
            now += 20L
        }
        assertEquals("typing-feels-fine".length, naive.undoSize)
    }

    private fun type(history: SftpEditorHistory, previous: String, next: String, nowMs: Long): String {
        history.record(previous, next, nowMs)
        return next
    }
}
