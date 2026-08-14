package one.zephyr.mobile.feature.notes

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SnippetDraftSaveTest {

    @Test
    fun `create requires name and command`() {
        val draft = SnippetDraft.create("user", "s1")
        assertFalse(draft.canSave)
        val codes = draft.validate().map { it.code }.toSet()
        assertTrue(SnippetIssueCode.NAME_REQUIRED in codes)
        assertTrue(SnippetIssueCode.COMMAND_REQUIRED in codes)
    }

    @Test
    fun `edit only masks the command when that is what moved`() {
        val original = SnippetDraft.create("user", "s1").withName("disk").withCommand("du -x").normalized()
        val draft = SnippetDraft.edit(original).withCommand("df -h")
        assertTrue(draft.canSave)
        assertEquals(listOf("command"), draft.changedFields())
    }
}
