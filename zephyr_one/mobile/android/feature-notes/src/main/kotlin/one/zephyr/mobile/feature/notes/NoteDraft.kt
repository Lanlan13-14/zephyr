package one.zephyr.mobile.feature.notes

import one.zephyr.mobile.model.Note

/**
 * Why a note cannot be saved.
 *
 * A code rather than a sentence: house convention keeps every user-visible string in
 * strings.xml, and a code is also what makes the limit tests readable.
 */
enum class NoteIssueCode {
    TITLE_REQUIRED,
    TITLE_TOO_LONG,
    CONTENT_TOO_LARGE,
    TOO_MANY_TAGS,
    TOO_MANY_LINKS,
}

/** One validation failure, tied to the field so the editor can point at it. */
data class NoteIssue(val field: String, val code: NoteIssueCode)

/**
 * The S32 editor state.
 *
 * Holds [original] beside [current] for the same reason the connection editor does: the fieldMask is
 * a diff, and "unsaved changes" is a diff. A draft carrying only edited values could not tell a
 * cleared tag list from an untouched one.
 *
 * @param original null when creating, which makes the save name every editable field because the
 *   server has no row to merge against.
 */
data class NoteDraft(
    val original: Note?,
    val current: Note,
) {

    val isCreate: Boolean get() = original == null

    val isDirty: Boolean get() = isCreate || current != original

    /** Live counters for the editor footer, so the user sees the ceiling before they hit it. */
    val titleLength: Int get() = current.title.length
    val contentBytes: Int get() = Utf8Size.of(current.content)
    val tagCount: Int get() = current.tags.size
    val linkCount: Int get() = current.linkedConnectionIds.size

    // ---- editing -------------------------------------------------------------------------------

    fun withTitle(title: String): NoteDraft = copy(current = current.copy(title = title))

    fun withContent(content: String): NoteDraft = copy(current = current.copy(content = content))

    fun withGroupPath(groupPath: String): NoteDraft = copy(current = current.copy(groupPath = groupPath))

    fun withAiRead(enabled: Boolean): NoteDraft = copy(current = current.copy(aiReadEnabled = enabled))

    /**
     * AI write implies AI read.
     *
     * A note the assistant may rewrite but not read is not a meaningful grant, and leaving the two
     * independent would let the UI present a permission combination the server cannot honour.
     */
    fun withAiWrite(enabled: Boolean): NoteDraft = copy(
        current = current.copy(
            aiWriteEnabled = enabled,
            aiReadEnabled = if (enabled) true else current.aiReadEnabled,
        ),
    )

    /**
     * Adds one tag.
     *
     * Refuses past the frozen ceiling rather than silently dropping, so the editor can explain why
     * the chip did not appear. Case-insensitive duplicates collapse because the server stores tags
     * set-like and two chips differing only in case would round-trip as one.
     */
    fun withTagAdded(tag: String): NoteDraft {
        val trimmed = tag.trim()
        if (trimmed.isEmpty()) return this
        if (current.tags.any { it.equals(trimmed, ignoreCase = true) }) return this
        if (current.tags.size >= Note.MAX_TAGS) return this
        return copy(current = current.copy(tags = current.tags + trimmed))
    }

    fun withTagRemoved(tag: String): NoteDraft =
        copy(current = current.copy(tags = current.tags.filterNot { it.equals(tag, ignoreCase = true) }))

    fun withLinkAdded(connectionId: String): NoteDraft {
        if (connectionId.isBlank()) return this
        if (connectionId in current.linkedConnectionIds) return this
        if (current.linkedConnectionIds.size >= Note.MAX_LINKS) return this
        return copy(current = current.copy(linkedConnectionIds = current.linkedConnectionIds + connectionId))
    }

    fun withLinkRemoved(connectionId: String): NoteDraft = copy(
        current = current.copy(linkedConnectionIds = current.linkedConnectionIds.filterNot { it == connectionId }),
    )

    // ---- normalisation and mask ----------------------------------------------------------------

    /**
     * The row to persist.
     *
     * Trailing whitespace in a title is invisible in a list and would make two notes look identical,
     * so it goes. The body is left byte-for-byte alone: trimming a Markdown document would change a
     * fenced code block's content.
     */
    fun normalized(): Note = current.copy(
        title = current.title.trim(),
        groupPath = NoteGroups.normalize(current.groupPath),
        tags = current.tags.map { it.trim() }.filter { it.isNotEmpty() }.distinct(),
        linkedConnectionIds = current.linkedConnectionIds.filter { it.isNotBlank() }.distinct(),
    )

    /**
     * The fieldMask for this save.
     *
     * A create names everything; an edit names only what moved, so a concurrent edit of a different
     * field does not become a conflict (SYNC_STATE_MACHINE.md 4.3).
     */
    fun changedFields(): List<String> {
        val base = original ?: return FIELD_READERS.keys.toList()
        val candidate = normalized()
        return FIELD_READERS.keys.filter { field ->
            val read = FIELD_READERS.getValue(field)
            read(candidate) != read(base)
        }
    }

    // ---- validation ----------------------------------------------------------------------------

    /**
     * The frozen S32 limits, checked before the write.
     *
     * NoteRepository.saveNote throws when its own validate finds a violation, so an editor that did
     * not check first would turn a form error into a crash.
     */
    fun validate(): List<NoteIssue> = buildList {
        val candidate = normalized()
        if (candidate.title.isEmpty()) add(NoteIssue("title", NoteIssueCode.TITLE_REQUIRED))
        if (candidate.title.length > Note.MAX_TITLE_CHARS) {
            add(NoteIssue("title", NoteIssueCode.TITLE_TOO_LONG))
        }
        if (Utf8Size.of(candidate.content) > Note.MAX_CONTENT_BYTES) {
            add(NoteIssue("content", NoteIssueCode.CONTENT_TOO_LARGE))
        }
        if (candidate.tags.size > Note.MAX_TAGS) add(NoteIssue("tags", NoteIssueCode.TOO_MANY_TAGS))
        if (candidate.linkedConnectionIds.size > Note.MAX_LINKS) {
            add(NoteIssue("linkedConnectionIds", NoteIssueCode.TOO_MANY_LINKS))
        }
    }

    val canSave: Boolean get() = validate().isEmpty() && isDirty

    fun issueFor(field: String): NoteIssue? = validate().firstOrNull { it.field == field }

    companion object {

        fun create(ownerUserId: String, noteId: String, groupPath: String = ""): NoteDraft = NoteDraft(
            original = null,
            current = Note(
                noteId = noteId,
                ownerUserId = ownerUserId,
                title = "",
                groupPath = NoteGroups.normalize(groupPath),
            ),
        )

        fun edit(note: Note): NoteDraft = NoteDraft(original = note, current = note)

        /**
         * Field readers keyed by the frozen registry field names.
         *
         * A table rather than a when-chain so the mask and the mapper cannot drift: a field with no
         * reader is simply never masked, which fails closed. The names match
         * EntityRegistry's note editableFields and ResourceMappers.noteValues exactly, because a
         * mask entry the server does not publish would be rejected as unknown.
         */
        val FIELD_READERS: Map<String, (Note) -> Any?> = linkedMapOf(
            "title" to { note: Note -> note.title },
            "content" to { note: Note -> note.content },
            "groupPath" to { note: Note -> note.groupPath },
            "tags" to { note: Note -> note.tags },
            "linkedConnectionIds" to { note: Note -> note.linkedConnectionIds },
            "allowAiRead" to { note: Note -> note.aiReadEnabled },
            "allowAiWrite" to { note: Note -> note.aiWriteEnabled },
        )
    }
}
