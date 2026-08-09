package one.zephyr.mobile.feature.notes

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flowOf
import one.zephyr.mobile.model.Note

/**
 * Reads soft-deleted notes for 回收站 (SCREEN_CATALOG.md 13).
 *
 * This is a seam, not a preference. NoteRepository.observeNotes goes through
 * MirrorDao.observeByType, whose query ends in "AND deletedAt IS NULL", so a trashed note is
 * invisible to every list query core-data currently exposes. The trash view therefore needs one
 * additional query that belongs in core-data and is outside this module's write scope.
 *
 * The rest of the trash feature is real: [NoteRepository.trashNote] and
 * [NoteRepository.restoreNote] both exist and both queue the correct sync action, and the screen,
 * gating and messages here are complete. Only the *listing* of trashed rows is deferred, so this
 * interface exists to make that gap explicit and typed rather than leaving a screen that silently
 * shows nothing.
 */
fun interface TrashedNotesPort {
    fun observeTrashed(ownerUserId: String): Flow<List<Note>>
}

/**
 * Default binding until core-data exposes a deleted-rows query.
 *
 * Emits an empty list *once* rather than never: an empty emission renders the honest
 * "回收站是空的" state, whereas an empty flow would leave the screen on initial-loading forever,
 * which reads as a hang.
 */
object EmptyTrashedNotesPort : TrashedNotesPort {
    override fun observeTrashed(ownerUserId: String): Flow<List<Note>> = flowOf(emptyList())
}
