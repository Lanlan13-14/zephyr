package one.zephyr.mobile.model.sync

import kotlinx.serialization.json.JsonObject
import one.zephyr.mobile.contracts.ConflictResolution
import one.zephyr.mobile.contracts.SyncAction
import one.zephyr.mobile.model.PendingOperation

data class ConflictOutcome(
    /** Null for use_server: the local edit is abandoned, nothing new is queued. */
    val operation: PendingOperation?,
    val clearsConflict: Boolean,
)

/**
 * Conflict resolution.
 *
 * Every resolution mints a *fresh* opId at the newest baseRevision (SYNC_STATE_MACHINE.md 7.3).
 * Reusing the stale opId would let the server deduplicate the resolution against the operation that
 * caused the conflict, which is how "keep local" silently loses.
 */
object ConflictResolver {

    fun resolve(
        resolution: ConflictResolution,
        entityType: String,
        entityId: String,
        serverRevision: Long,
        newOpId: String,
        mask: List<String>,
        payload: JsonObject,
        createdAt: Long = 0L,
        secretFields: List<String> = emptyList(),
    ): ConflictOutcome {
        val accepted = FieldMask.sanitize(entityType, mask).accepted
        return when (resolution) {
            ConflictResolution.USE_SERVER -> ConflictOutcome(operation = null, clearsConflict = true)

            // A copy is a brand new row, so it starts at baseRevision 0 and is marked local-only.
            ConflictResolution.COPY_AS_NEW -> ConflictOutcome(
                operation = PendingOperation(
                    opId = newOpId,
                    entityType = entityType,
                    entityId = entityId + "-copy",
                    action = SyncAction.UPSERT,
                    baseRevision = 0L,
                    fieldMask = accepted,
                    payload = payload,
                    createdAt = createdAt,
                    createdLocally = true,
                    // A copy is a new row, so its secrets must be sealed again under the new id.
                    secretFields = secretFields,
                ),
                clearsConflict = true,
            )

            ConflictResolution.KEEP_LOCAL, ConflictResolution.MANUAL_MERGE -> ConflictOutcome(
                operation = PendingOperation(
                    opId = newOpId,
                    entityType = entityType,
                    entityId = entityId,
                    action = SyncAction.UPSERT,
                    baseRevision = serverRevision,
                    fieldMask = accepted,
                    payload = payload,
                    createdAt = createdAt,
                    secretFields = secretFields,
                ),
                clearsConflict = true,
            )
        }
    }
}
