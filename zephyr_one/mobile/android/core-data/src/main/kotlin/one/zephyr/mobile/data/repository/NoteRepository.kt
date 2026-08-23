package one.zephyr.mobile.data.repository

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.serialization.json.JsonObject
import one.zephyr.mobile.contracts.SyncAction
import one.zephyr.mobile.data.LocalEdit
import one.zephyr.mobile.data.LocalEditResult
import one.zephyr.mobile.data.LocalWriteGateway
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
        db.mirrorDao().observeByType(Note.ENTITY_TYPE, ownerUserId).map { rows -> rows.map(ResourceMappers::note) }

    /**
     * 回收站. observeByType filters deletedAt, so the trash scope reads its own query instead of
     * an empty filter over the active list.
     */
    fun observeTrashedNotes(ownerUserId: String): Flow<List<Note>> =
        db.mirrorDao().observeTrashedByType(Note.ENTITY_TYPE, ownerUserId).map { rows -> rows.map(ResourceMappers::note) }

    fun observeSnippets(ownerUserId: String): Flow<List<Snippet>> =
        db.mirrorDao().observeByType(Snippet.ENTITY_TYPE, ownerUserId).map { rows -> rows.map(ResourceMappers::snippet) }

    fun observeNote(noteId: String): Flow<Note?> =
        db.mirrorDao().observe(Note.ENTITY_TYPE, noteId).map { row -> row?.let(ResourceMappers::note) }

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

    /*
     * No purgeNote on purpose. The gateway's DELETE path is soft-delete-then-tombstone for notes,
     * so a second DELETE would only re-mark the row; and the mobile v1 sync contract has no purge
     * action (UPSERT/DELETE/RESTORE only). Zephyr's permanent delete lives in notes-service.purge,
     * an HTTP API outside the sync channel, and the 30-day retention clears trashed rows
     * server-side. The trash view therefore offers restore, not a fake purge.
     */

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
