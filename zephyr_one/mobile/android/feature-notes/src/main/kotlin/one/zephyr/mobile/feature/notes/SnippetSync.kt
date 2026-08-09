package one.zephyr.mobile.feature.notes

import one.zephyr.mobile.contracts.SyncAction
import one.zephyr.mobile.model.Snippet
import one.zephyr.mobile.model.SyncState

/**
 * One queued snippet delete.
 *
 * A delete is a per-id tombstone and carries no payload. SCREEN_CATALOG.md 14 requires that
 * deleting a snippet must not clobber snippets another device added, and the obvious wrong
 * implementation is right there in the entity source: Zephyr stores snippets inside
 * user_settings.snippets, so a "save the settings bag" push would make the last writer's list
 * authoritative and silently delete every snippet the other device had created in the meantime.
 */
data class SnippetTombstone(val snippetId: String, val deletedAt: Long) {
    val entityType: String get() = Snippet.ENTITY_TYPE
    val action: SyncAction get() = SyncAction.DELETE

    /** A delete names no fields, which is what stops it carrying a stale whole-list payload. */
    val fieldMask: List<String> get() = emptyList()
}

/**
 * Local/remote reconciliation for snippets.
 *
 * Pure, so the frozen tombstone rule is testable without a database: the assertions that matter are
 * that a delete removes exactly one id, that a stale server copy of a deleted row does not
 * resurrect it, and that a row this device has never seen survives the merge.
 */
object SnippetSync {

    fun tombstoneIds(tombstones: Collection<SnippetTombstone>): Set<String> =
        tombstones.mapTo(LinkedHashSet()) { it.snippetId }

    /**
     * Merges a pulled list into the local one.
     *
     * Four rules, in order:
     *  1. a tombstoned id stays gone even when the server still lists it, because the delete has
     *     not been pushed yet and resurrecting it would undo what the user just did;
     *  2. an incoming row this device has never seen is added, which is precisely the snippet a
     *     whole-bag push would have destroyed;
     *  3. a row with an unpushed local edit is left alone, because overwriting it here would
     *     discard the edit before the server ever saw it;
     *  4. a local row absent from the incoming list survives, because absence from a partial pull
     *     is not evidence of deletion.
     */
    fun merge(
        local: List<Snippet>,
        incoming: List<Snippet>,
        tombstones: Set<String> = emptySet(),
    ): List<Snippet> {
        val result = LinkedHashMap<String, Snippet>()
        for (row in local) {
            if (row.id in tombstones) continue
            if (row.deletedAt != null) continue
            result[row.id] = row
        }
        for (row in incoming) {
            if (row.id in tombstones) continue
            if (row.deletedAt != null) {
                result.remove(row.id)
                continue
            }
            val existing = result[row.id]
            when {
                existing == null -> result[row.id] = row
                existing.syncState == SyncState.PENDING_LOCAL -> Unit
                row.revision >= existing.revision -> result[row.id] = row
                else -> Unit
            }
        }
        return result.values.toList()
    }

    /**
     * Applies one delete.
     *
     * Separate from [merge] so the "one id only" property is stated directly: the returned list
     * differs from the input by exactly the deleted row.
     */
    fun applyDelete(local: List<Snippet>, snippetId: String): List<Snippet> =
        local.filterNot { it.id == snippetId }

    /** The frozen 500-per-account ceiling. */
    fun canCreate(currentCount: Int): Boolean = currentCount < Snippet.MAX_PER_ACCOUNT

    fun remainingCapacity(currentCount: Int): Int =
        (Snippet.MAX_PER_ACCOUNT - currentCount).coerceAtLeast(0)
}
