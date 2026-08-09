package one.zephyr.mobile.feature.notes

import one.zephyr.mobile.model.Note
import one.zephyr.mobile.model.SyncState

/** Which slice of the library the list is showing. */
enum class NoteScope {
    ACTIVE,

    /** 回收站. Soft-deleted rows, which are still real notes until retention prunes them. */
    TRASH,
}

enum class NoteSort { UPDATED_DESC, TITLE_ASC, TITLE_DESC }

/**
 * The S32 filter set.
 *
 * A value type with no Android or coroutine dependency, so the whole search/group/tag matrix is
 * unit testable without an emulator: most of the list screen's correctness is this function.
 */
data class NoteFilter(
    val query: String = "",
    val groupPath: String = "",
    val tags: Set<String> = emptySet(),
    val scope: NoteScope = NoteScope.ACTIVE,
    val sort: NoteSort = NoteSort.UPDATED_DESC,
    val linkedConnectionId: String? = null,
    val conflictedOnly: Boolean = false,
) {
    /** Scope is not part of "active": switching to the trash is navigation, not filtering. */
    val isActive: Boolean
        get() = query.isNotBlank() ||
            groupPath.isNotEmpty() ||
            tags.isNotEmpty() ||
            linkedConnectionId != null ||
            conflictedOnly

    fun withTagToggled(tag: String): NoteFilter =
        copy(tags = if (tag in tags) tags - tag else tags + tag)

    /** Clearing keeps the query and the scope: the user is still where they navigated to. */
    fun cleared(): NoteFilter = NoteFilter(query = query, scope = scope, sort = sort)
}

/**
 * Pure filtering and ordering for the note library.
 *
 * Deliberately not a SQL query. The trash view, the group tree and the tag facets all read the same
 * in-memory rows, so one ordering rule serves every column of the tablet layout and the phone list.
 */
object NoteFilters {

    /**
     * Multi-field match.
     *
     * Body text is searched because a note is mostly body: a title-only search would miss the
     * command the user is actually looking for. Group path is included so typing a group name
     * behaves like the user expects.
     */
    fun matchesQuery(note: Note, rawQuery: String): Boolean {
        val query = rawQuery.trim()
        if (query.isEmpty()) return true
        val needle = query.lowercase()
        if (note.title.lowercase().contains(needle)) return true
        if (note.groupPath.lowercase().contains(needle)) return true
        if (note.tags.any { it.lowercase().contains(needle) }) return true
        return note.content.lowercase().contains(needle)
    }

    fun matches(note: Note, filter: NoteFilter): Boolean {
        val inScope = when (filter.scope) {
            NoteScope.ACTIVE -> !note.isTrashed
            NoteScope.TRASH -> note.isTrashed
        }
        if (!inScope) return false
        // A group selection includes its descendants: selecting "运维" and seeing nothing while
        // "运维/线上" has ten notes would read as a bug.
        if (filter.groupPath.isNotEmpty() && !NoteGroups.isDescendantOf(note.groupPath, filter.groupPath)) {
            return false
        }
        // Tags are OR within the facet, matching how the chips read.
        if (filter.tags.isNotEmpty() && filter.tags.none { tag -> note.tags.any { it.equals(tag, ignoreCase = true) } }) {
            return false
        }
        filter.linkedConnectionId?.let { id ->
            if (id !in note.linkedConnectionIds) return false
        }
        if (filter.conflictedOnly && note.syncState != SyncState.CONFLICTED) return false
        return matchesQuery(note, filter.query)
    }

    fun apply(notes: List<Note>, filter: NoteFilter): List<Note> = notes
        .asSequence()
        .filter { matches(it, filter) }
        .sortedWith(ordering(filter.sort))
        .toList()

    /**
     * Ordering.
     *
     * Conflicts float to the top of every ordering: SYNC_STATE_MACHINE.md 7.2 keeps a conflict open
     * until the user chooses, so burying it under an alphabetical sort would hide the one row that
     * needs an action. The id tiebreak keeps the order stable across recompositions.
     */
    fun ordering(sort: NoteSort): Comparator<Note> {
        val conflictsFirst = compareByDescending<Note> { it.syncState == SyncState.CONFLICTED }
        return when (sort) {
            NoteSort.UPDATED_DESC -> conflictsFirst
                .thenByDescending { it.updatedAt }
                .thenBy { it.noteId }
            NoteSort.TITLE_ASC -> conflictsFirst
                .thenBy(String.CASE_INSENSITIVE_ORDER) { it.title }
                .thenBy { it.noteId }
            NoteSort.TITLE_DESC -> conflictsFirst
                .thenByDescending(String.CASE_INSENSITIVE_ORDER) { it.title }
                .thenBy { it.noteId }
        }
    }

    /** Tag facet values actually present in the current scope, sorted. */
    fun availableTags(notes: List<Note>, scope: NoteScope = NoteScope.ACTIVE): List<String> = notes
        .asSequence()
        .filter { if (scope == NoteScope.TRASH) it.isTrashed else !it.isTrashed }
        .flatMap { it.tags.asSequence() }
        .distinctBy { it.lowercase() }
        .sortedWith(String.CASE_INSENSITIVE_ORDER)
        .toList()
}
