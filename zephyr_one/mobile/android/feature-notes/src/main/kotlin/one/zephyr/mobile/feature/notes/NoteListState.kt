package one.zephyr.mobile.feature.notes

import one.zephyr.mobile.model.EmptyReason
import one.zephyr.mobile.model.Note
import one.zephyr.mobile.model.PageState
import one.zephyr.mobile.model.SyncState

/** Everything the S32 list column renders, including the facets the filter row needs. */
data class NoteListContent(
    val notes: List<Note>,
    val groups: List<NoteGroupNode>,
    val availableTags: List<String>,
    val totalCount: Int,
    val trashedCount: Int,
)

/**
 * The S32 list page state, as a pure function.
 *
 * The branch order is the specification (SCREEN_CATALOG.md 2), so it lives here rather than inside a
 * composable and can be asserted without an emulator. Deriving the facets in the same place as the
 * visible rows is what stops the group tree from disagreeing with the list it filters.
 */
object NoteListStates {

    /**
     * @param loaded false only before the first mirror emission; an unemitted flow is genuinely
     *   unknown, which is not the same as an empty account.
     * @param online drives the offline branch. Owned notes have a local mirror, so offline shows the
     *   cache with its age rather than an error (SHARED_RESOURCE_RESIDENCY.md 3).
     * @param trashed passed separately because the mirror query filters soft-deleted rows out; see
     *   [TrashedNotesPort] for why that is a seam rather than a repository call.
     */
    fun derive(
        notes: List<Note>,
        trashed: List<Note> = emptyList(),
        filter: NoteFilter = NoteFilter(),
        loaded: Boolean = true,
        online: Boolean = true,
        bound: Boolean = true,
        lastSyncedAt: Long? = null,
    ): PageState<NoteListContent> {
        if (!loaded) return PageState.InitialLoading

        val pool = if (filter.scope == NoteScope.TRASH) trashed else notes
        val visible = NoteFilters.apply(pool, filter)
        val content = NoteListContent(
            notes = visible,
            groups = NoteGroups.tree(notes),
            availableTags = NoteFilters.availableTags(notes),
            totalCount = notes.count { !it.isTrashed },
            trashedCount = trashed.size,
        )

        if (visible.isNotEmpty()) {
            // Offline is reported before the pending/conflict banners because it is the stronger
            // statement about what the user is looking at: a mirror, not the live account.
            if (!online) return PageState.OfflineWithCache(content, lastSyncedAt)
            return PageState.Content(
                value = content,
                pendingSync = visible.any { it.syncState == SyncState.PENDING_LOCAL },
                conflict = visible.any { it.syncState == SyncState.CONFLICTED },
            )
        }

        // An empty result over a non-empty pool is a filter outcome, not an empty account: it
        // decides whether the screen offers 清除筛选 or 新建笔记.
        val anyRow = pool.isNotEmpty()
        return when {
            filter.isActive && anyRow -> PageState.Empty(EmptyReason.NO_MATCHING_FILTER)
            !bound -> PageState.Empty(EmptyReason.NOT_YET_SYNCED)
            else -> PageState.Empty(EmptyReason.NO_DATA)
        }
    }
}

/** Phone is a single column with a full-screen editor; tablet shows group/list/editor (13). */
enum class NotesLayout { PHONE_SINGLE_PANE, TABLET_THREE_PANE }

object NotesLayouts {

    /**
     * The frozen breakpoint.
     *
     * 840dp is the Material expanded-width boundary and the point at which three columns each keep a
     * usable measure; below it the editor would be too narrow to edit Markdown in. Taking the width
     * as a value keeps the decision unit testable rather than hidden behind a WindowSizeClass call.
     */
    const val THREE_PANE_MIN_WIDTH_DP = 840

    fun forWidth(widthDp: Int): NotesLayout =
        if (widthDp >= THREE_PANE_MIN_WIDTH_DP) NotesLayout.TABLET_THREE_PANE else NotesLayout.PHONE_SINGLE_PANE
}
