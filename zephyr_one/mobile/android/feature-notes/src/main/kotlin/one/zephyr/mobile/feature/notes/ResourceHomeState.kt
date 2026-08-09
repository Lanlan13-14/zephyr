package one.zephyr.mobile.feature.notes

import one.zephyr.mobile.model.EmptyReason
import one.zephyr.mobile.model.PageState

/**
 * The four S30 entry cards, in the frozen order from SCREEN_CATALOG.md 11.
 *
 * An enum so the screen renders entries() and cannot silently drop or reorder one; the order is
 * part of the spec, not a layout choice.
 */
enum class ResourceEntry { FILES, NOTES, SNIPPETS, DOWNLOADS }

/**
 * Counts behind the entry cards plus the 最近文件 strip.
 *
 * Counts are entity counts rather than "has items" booleans because SCREEN_CATALOG.md 26 requires
 * progress and quantity to be readable numbers for a screen reader, not a coloured dot.
 */
data class ResourceHomeSummary(
    val noteCount: Int,
    val snippetCount: Int,
    val trashedNoteCount: Int,
    val activeDownloadCount: Int,
    val recentFiles: List<RecentFileRecord>,
    val pendingCount: Int = 0,
    val conflictCount: Int = 0,
) {
    fun countFor(entry: ResourceEntry): Int = when (entry) {
        // 文件 has no local count: a remote directory is only knowable while connected, and
        // claiming a number here would be inventing one.
        ResourceEntry.FILES -> recentFiles.size
        ResourceEntry.NOTES -> noteCount
        ResourceEntry.SNIPPETS -> snippetCount
        ResourceEntry.DOWNLOADS -> activeDownloadCount
    }
}

/**
 * S30 page state, as a pure function.
 *
 * The entry cards are navigation and always exist, so this never reports Empty while any of the
 * counted resources exist. The one honest empty case is a freshly bound device with nothing yet:
 * showing "没有数据" there would be wrong, because the data simply has not arrived.
 */
object ResourceHomeStates {

    fun derive(
        summary: ResourceHomeSummary,
        loaded: Boolean = true,
        online: Boolean = true,
        bound: Boolean = true,
        lastSyncedAt: Long? = null,
    ): PageState<ResourceHomeSummary> {
        if (!loaded) return PageState.InitialLoading

        val anything = summary.noteCount > 0 ||
            summary.snippetCount > 0 ||
            summary.trashedNoteCount > 0 ||
            summary.recentFiles.isNotEmpty() ||
            summary.activeDownloadCount > 0

        // Notes and snippets are owned data with a local mirror, so offline shows the cache with its
        // age rather than an error (SHARED_RESOURCE_RESIDENCY.md 3). The 文件 card still navigates;
        // S31 is where the lack of a connection becomes visible.
        if (!online) return PageState.OfflineWithCache(summary, lastSyncedAt)

        if (!anything) {
            return PageState.Empty(
                if (bound) EmptyReason.NO_DATA else EmptyReason.NOT_YET_SYNCED,
            )
        }

        return PageState.Content(
            value = summary,
            pendingSync = summary.pendingCount > 0,
            conflict = summary.conflictCount > 0,
        )
    }
}
