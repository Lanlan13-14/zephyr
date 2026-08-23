package one.zephyr.mobile.feature.notes

import one.zephyr.mobile.model.EmptyReason
import one.zephyr.mobile.model.Note
import one.zephyr.mobile.model.PageState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class NoteListStatesTest {

    private fun note(id: String, title: String, group: String = "", deletedAt: Long? = null): Note =
        Note(noteId = id, ownerUserId = "u", title = title, groupPath = group, deletedAt = deletedAt)

    @Test
    fun `local-only empty list is no data, not a sync prompt`() {
        val state = NoteListStates.derive(
            notes = emptyList(),
            bound = false,
            lastSyncedAt = null,
        )
        assertEquals(PageState.Empty(EmptyReason.NO_DATA), state)
    }

    @Test
    fun `bound account that has never synced is not-yet-synced`() {
        val state = NoteListStates.derive(
            notes = emptyList(),
            bound = true,
            lastSyncedAt = null,
        )
        assertEquals(PageState.Empty(EmptyReason.NOT_YET_SYNCED), state)
    }

    @Test
    fun `bound account that already synced and is empty is no data`() {
        val state = NoteListStates.derive(
            notes = emptyList(),
            bound = true,
            lastSyncedAt = 1L,
        )
        assertEquals(PageState.Empty(EmptyReason.NO_DATA), state)
    }

    @Test
    fun `empty trash is no data even for an unbound account`() {
        val state = NoteListStates.derive(
            notes = emptyList(),
            trashed = emptyList(),
            filter = NoteFilter(scope = NoteScope.TRASH),
            bound = false,
        )
        assertEquals(PageState.Empty(EmptyReason.NO_DATA), state)
    }

    @Test
    fun `trash with leftover group filter hides rows that are not in that group`() {
        val trashed = listOf(note("n1", "Runbook", group = "", deletedAt = 10))
        val leftover = NoteFilter(scope = NoteScope.TRASH, groupPath = "运维")
        val filtered = NoteListStates.derive(notes = emptyList(), trashed = trashed, filter = leftover)
        assertEquals(PageState.Empty(EmptyReason.NO_MATCHING_FILTER), filtered)
    }

    @Test
    fun `clearing group on trash transition shows every recoverable row`() {
        val trashed = listOf(note("n1", "Runbook", group = "", deletedAt = 10))
        val cleared = NoteFilter(scope = NoteScope.TRASH, groupPath = "")
        val state = NoteListStates.derive(notes = emptyList(), trashed = trashed, filter = cleared)
        assertTrue(state is PageState.Content)
        assertEquals(listOf("n1"), (state as PageState.Content).value.notes.map { it.noteId })
    }

    @Test
    fun `active notes still render in local-only mode`() {
        val state = NoteListStates.derive(
            notes = listOf(note("n1", "Runbook")),
            bound = false,
        )
        assertTrue(state is PageState.Content)
        assertEquals(1, (state as PageState.Content).value.notes.size)
    }
}
