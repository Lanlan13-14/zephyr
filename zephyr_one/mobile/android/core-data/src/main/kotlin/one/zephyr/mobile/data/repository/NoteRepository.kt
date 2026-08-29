package one.zephyr.mobile.data.repository

import androidx.room.withTransaction
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map
import kotlinx.serialization.json.JsonObject
import one.zephyr.mobile.contracts.SyncAction
import one.zephyr.mobile.data.LocalEdit
import one.zephyr.mobile.data.LocalEditResult
import one.zephyr.mobile.data.LocalWriteGateway
import one.zephyr.mobile.data.LocalWriteRejected
import one.zephyr.mobile.data.db.TombstoneRow
import one.zephyr.mobile.data.db.ZephyrDatabase
import one.zephyr.mobile.data.mapper.ResourceMappers
import one.zephyr.mobile.model.Note
import one.zephyr.mobile.model.Snippet

/** Notes and snippets. Notes are soft-deleted first, so the trash view reads deletedAt rows. */
class NoteRepository(
    private val db: ZephyrDatabase,
    private val gateway: LocalWriteGateway,
) {

    fun observeNotes(ownerUserId: String): Flow<List<Note>> =
        db.mirrorDao().observeByType(Note.ENTITY_TYPE, ownerUserId)
            .map { rows -> rows.map(ResourceMappers::note) }
            // JSON payload decoding runs per row on every DB emission; keep it off Main so
            // large libraries do not drop frames while the list is animating.
            .flowOn(Dispatchers.Default)

    /**
     * 回收站. observeByType filters deletedAt, so the trash scope reads its own query instead of
     * an empty filter over the active list.
     */
    fun observeTrashedNotes(ownerUserId: String): Flow<List<Note>> =
        db.mirrorDao().observeTrashedByType(Note.ENTITY_TYPE, ownerUserId)
            .map { rows -> rows.map(ResourceMappers::note) }
            .flowOn(Dispatchers.Default)

    fun observeSnippets(ownerUserId: String): Flow<List<Snippet>> =
        db.mirrorDao().observeByType(Snippet.ENTITY_TYPE, ownerUserId)
            .map { rows -> rows.map(ResourceMappers::snippet) }
            .flowOn(Dispatchers.Default)

    fun observeNote(noteId: String): Flow<Note?> =
        db.mirrorDao().observe(Note.ENTITY_TYPE, noteId)
            .map { row -> row?.let(ResourceMappers::note) }
            .flowOn(Dispatchers.Default)

    suspend fun searchNotes(query: String, ownerUserId: String): List<Note> =
        db.mirrorDao().search(query, ownerUserId)
            .filter { it.entityType == Note.ENTITY_TYPE }
            .map(ResourceMappers::note)

    /** Zephyr's own limits, checked before the write so the failure is a form error not a push error. */
    fun validate(note: Note): List<String> = buildList {
        if (note.title.length > Note.MAX_TITLE_CHARS) add("title")
        if (note.content.toByteArray(Charsets.UTF_8).size > Note.MAX_CONTENT_BYTES) add("content")
        if (note.tags.size > Note.MAX_TAGS) add("tags")
        if (note.linkedConnectionIds.size > Note.MAX_LINKS) add("linkedConnectionIds")
    }

    suspend fun saveNote(
        note: Note,
        mask: List<String>,
        ownerUserId: String,
        createdLocally: Boolean = false,
    ): LocalEditResult {
        val invalid = validate(note)
        require(invalid.isEmpty()) { "note exceeds Zephyr limits: " + invalid.joinToString(",") }
        return gateway.apply(
            LocalEdit(
                entityType = Note.ENTITY_TYPE,
                entityId = note.noteId,
                action = SyncAction.UPSERT,
                requestedMask = mask,
                values = ResourceMappers.noteValues(note),
                residency = note.residency,
                capabilities = note.capabilities,
                createdLocally = createdLocally,
            ),
            ownerUserId = ownerUserId,
        )
    }

    suspend fun saveSnippet(
        snippet: Snippet,
        mask: List<String>,
        ownerUserId: String,
        createdLocally: Boolean = false,
    ): LocalEditResult {
        require(snippet.name.length <= Snippet.MAX_NAME_CHARS) { "snippet name too long" }
        require(snippet.command.length <= Snippet.MAX_COMMAND_CHARS) { "snippet command too long" }
        return gateway.apply(
            LocalEdit(
                entityType = Snippet.ENTITY_TYPE,
                entityId = snippet.id,
                action = SyncAction.UPSERT,
                requestedMask = mask,
                values = ResourceMappers.snippetValues(snippet),
                residency = snippet.residency,
                capabilities = snippet.capabilities,
                createdLocally = createdLocally,
            ),
            ownerUserId = ownerUserId,
        )
    }

    suspend fun trashNote(note: Note, ownerUserId: String): LocalEditResult = gateway.apply(
        LocalEdit(
            entityType = Note.ENTITY_TYPE,
            entityId = note.noteId,
            action = SyncAction.DELETE,
            requestedMask = emptyList(),
            values = JsonObject(emptyMap()),
            capabilities = note.capabilities,
        ),
        ownerUserId = ownerUserId,
    )

    /**
     * Permanent local delete for a row already in the trash.
     *
     * The gateway DELETE path is soft-delete-then-tombstone, so a second DELETE would only re-mark
     * the row. A purge therefore goes around the gateway: hard-delete the mirror row, drop search
     * and overlay, and write a tombstone so a later inbound UPSERT of a lower or equal revision
     * cannot resurrect it. Local-only accounts have no server to talk to, so this is the complete
     * permanent delete. Bound accounts still lose the local copy immediately; the existing queued
     * DELETE from trashNote is left in pending_operations so the server still sees the delete.
     */
    suspend fun purgeNote(note: Note, ownerUserId: String): LocalEditResult {
        if (note.ownerUserId != ownerUserId) {
            throw LocalWriteRejected("owner_mismatch", "note/" + note.noteId + " is not owned by this account")
        }
        if (!note.isTrashed) {
            throw LocalWriteRejected("not_trashed", "only a trashed note can be purged")
        }
        if (!note.capabilities.canDelete) {
            throw LocalWriteRejected("capability_denied", "no delete capability for note/" + note.noteId)
        }
        val now = System.currentTimeMillis()
        val revision = note.revision
        db.withTransaction {
            db.mirrorDao().hardDelete(Note.ENTITY_TYPE, note.noteId)
            db.mirrorDao().deleteSearch(Note.ENTITY_TYPE, note.noteId)
            db.overlayDao().deleteForEntity(Note.ENTITY_TYPE, note.noteId)
            db.tombstoneDao().upsert(
                TombstoneRow(
                    entityType = Note.ENTITY_TYPE,
                    entityId = note.noteId,
                    revision = revision,
                    deletedAt = now,
                    authoritative = false,
                ),
            )
        }
        return LocalEditResult(
            opId = null,
            acceptedMask = emptyList(),
            rejectedMask = emptyList(),
            revision = revision,
        )
    }

    suspend fun restoreNote(note: Note, ownerUserId: String): LocalEditResult = gateway.apply(
        LocalEdit(
            entityType = Note.ENTITY_TYPE,
            entityId = note.noteId,
            action = SyncAction.RESTORE,
            requestedMask = emptyList(),
            values = JsonObject(emptyMap()),
            capabilities = note.capabilities,
        ),
        ownerUserId = ownerUserId,
    )

    suspend fun deleteSnippet(snippet: Snippet, ownerUserId: String): LocalEditResult = gateway.apply(
        LocalEdit(
            entityType = Snippet.ENTITY_TYPE,
            entityId = snippet.id,
            action = SyncAction.DELETE,
            requestedMask = emptyList(),
            values = JsonObject(emptyMap()),
            capabilities = snippet.capabilities,
        ),
        ownerUserId = ownerUserId,
    )
}
