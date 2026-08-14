package one.zephyr.mobile.feature.notes

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NoteDraftSaveTest {

    @Test
    fun `create requires a title and names every field`() {
        val draft = NoteDraft.create("user", "n1")
        assertFalse(draft.canSave)
        assertEquals(NoteIssueCode.TITLE_REQUIRED, draft.validate().single().code)
        assertEquals(NoteDraft.FIELD_READERS.keys.toList(), draft.changedFields())
    }

    @Test
    fun `edit only masks the fields that moved`() {
        val original = NoteDraft.create("user", "n1").withTitle("Runbook").normalized()
        val draft = NoteDraft.edit(original).withContent("du -x")
        assertTrue(draft.canSave)
        assertEquals(listOf("content"), draft.changedFields())
    }
}
