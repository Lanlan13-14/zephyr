package one.zephyr.mobile.model.sync

import one.zephyr.mobile.contracts.SyncAction

enum class PushClassificationStatus { ACCEPTED, CONFLICT;
    val wireName: String get() = name.lowercase()
}

enum class PushClassificationReason {
    BASE_MATCHES,
    NON_OVERLAPPING_MERGE,
    FIELD_OVERLAP,
    ;
    val wireName: String get() = name.lowercase()
}

data class PushClassification(
    val status: PushClassificationStatus,
    val reason: PushClassificationReason,
    val fields: List<String> = emptyList(),
)

/**
 * Local prediction of what the server will do with an operation.
 *
 * Used to decide whether an edit can be optimistically kept or must open a conflict card before
 * the round trip. SYNC_STATE_MACHINE.md 7: disjoint field sets merge automatically, an overlapping
 * field set is a stable conflict that must not silently resolve itself on retry.
 */
object PushPrediction {

    fun classify(
        localMask: List<String>,
        serverChangedFields: List<String>,
        baseRevision: Long,
        currentRevision: Long,
    ): PushClassification {
        if (baseRevision == currentRevision) {
            return PushClassification(PushClassificationStatus.ACCEPTED, PushClassificationReason.BASE_MATCHES)
        }
        val overlap = localMask.filter { serverChangedFields.contains(it) }
        if (overlap.isEmpty()) {
            return PushClassification(
                PushClassificationStatus.ACCEPTED,
                PushClassificationReason.NON_OVERLAPPING_MERGE,
            )
        }
        return PushClassification(
            PushClassificationStatus.CONFLICT,
            PushClassificationReason.FIELD_OVERLAP,
            overlap,
        )
    }

    /**
     * A tombstone always applies, even with a lower revision than the local row: delete beats a
     * concurrent edit (SYNC_STATE_MACHINE.md 7.4). Otherwise the server revision must be strictly
     * newer, which is what makes the echo of our own push a no-op.
     *
     * `localRevision` is the revision of the live mirror row, OR — when the row was already
     * hard-deleted — the revision of its tombstone. Passing the tombstone revision keeps the
     * delete durable: an inbound UPSERT must be strictly newer than the tombstone to recreate
     * the row, so a stale replayed UPSERT (out-of-order page, bootstrap backfill) cannot
     * resurrect something the user deleted.
     */
    fun shouldApplyChange(localRevision: Long?, action: SyncAction, changeRevision: Long): Boolean {
        if (action == SyncAction.DELETE) return true
        return changeRevision > (localRevision ?: 0L)
    }

    /**
     * Advance the applied cursor across a page. Entries at or below the cursor are echoes that the
     * revision check already handles, so they move the cursor no further backwards.
     */
    fun advanceCursor(appliedCursor: Long, changeSeqs: List<Long>): Long {
        var cursor = appliedCursor
        for (seq in changeSeqs) {
            if (seq <= cursor) continue
            cursor = seq
        }
        return cursor
    }
}
