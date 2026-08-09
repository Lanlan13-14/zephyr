package one.zephyr.mobile.data.db

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

/**
 * A local write waiting to be pushed.
 *
 * Written in the same transaction as the optimistic mirror update (SYNC_STATE_MACHINE.md 5.2): a
 * crash must never leave a visible local edit with no queued operation, or an operation with no
 * visible edit.
 */
@Entity(
    tableName = "pending_operations",
    indices = [Index(value = ["entityType", "entityId"]), Index(value = ["dispatchedAt"])],
)
data class PendingOperationRow(
    @PrimaryKey val opId: String,
    val batchId: String?,
    val entityType: String,
    val entityId: String,
    /** upsert / delete / restore, stored as the wire name. */
    val action: String,
    val baseRevision: Long,
    val fieldMaskJson: String,
    val payloadJson: String,
    val createdAt: Long,
    val attemptCount: Int,
    val lastError: String?,
    val createdLocally: Boolean,
    /**
     * Registry field names whose secret changed, as JSON text.
     *
     * A secret never appears in fieldMaskJson or payloadJson (SYNC_STATE_MACHINE.md 4.3). The push
     * layer needs the names anyway so it can mint one envelope per changed secret, and keeping them
     * on the operation is what makes that survive a process death.
     */
    val secretFieldsJson: String = "[]",
    /**
     * Set when the op is handed to the network. A retry after an unknown outcome must replay the
     * same opId so the server can deduplicate rather than apply the edit twice.
     */
    val dispatchedAt: Long?,
)

/**
 * Bootstrap staging.
 *
 * Snapshot pages land here under a generation id and are promoted to the mirror in one transaction
 * only when the snapshot is complete (DATA_AND_MIGRATION.md 7.2). An interrupted bootstrap
 * therefore leaves the previous mirror intact instead of a half-populated one.
 */
@Entity(
    tableName = "bootstrap_staging",
    primaryKeys = ["generation", "entityType", "entityId"],
    indices = [Index(value = ["generation"])],
)
data class BootstrapStagingRow(
    val generation: Long,
    val entityType: String,
    val entityId: String,
    val ownerUserId: String,
    val revision: Long,
    val payloadJson: String,
    val secretPresenceJson: String,
    val deletedAt: Long?,
    val serverUpdatedAt: Long?,
)

/** Progress of an in-flight bootstrap, so a resumed run continues instead of restarting. */
@Entity(tableName = "bootstrap_progress")
data class BootstrapProgressRow(
    @PrimaryKey val bindingKey: String,
    val generation: Long,
    val bootstrapId: String,
    val snapshotCursor: Long,
    val nextPageToken: String?,
    val pagesFetched: Int,
    val entitiesStaged: Int,
    val startedAt: Long,
    val expiresAt: Long,
)

/**
 * One row per binding. [appliedCursor] is only advanced after the page has been committed and
 * acknowledged, so a crash re-fetches rather than skips.
 */
@Entity(tableName = "sync_state")
data class SyncStateRow(
    @PrimaryKey val bindingKey: String,
    val bindingState: String,
    val appliedCursor: Long,
    val ackedCursor: Long,
    val snapshotCursor: Long,
    val lastAttemptAt: Long?,
    val lastSuccessAt: Long?,
    val lastErrorCode: String?,
    val lastErrorMessage: String?,
    val consecutiveFailures: Int,
    val nextEligibleAt: Long?,
    /** Server registry hash seen at the last successful round; a change forces re-validation. */
    val registryHash: String?,
)

/**
 * A stable conflict awaiting a user decision.
 *
 * Conflicts do not resolve themselves on retry (SYNC_STATE_MACHINE.md 7.2), so this row survives
 * until the user picks a resolution.
 */
@Entity(tableName = "conflicts", indices = [Index(value = ["entityType", "entityId"], unique = true)])
data class ConflictRow(
    @PrimaryKey val conflictId: String,
    val entityType: String,
    val entityId: String,
    val localMaskJson: String,
    val localPayloadJson: String,
    val serverRevision: Long,
    val serverPayloadJson: String,
    val overlapFieldsJson: String,
    /** Secret fields the local side changed, so keep_local can re-seal them after resolution. */
    val secretFieldsJson: String = "[]",
    val detectedAt: Long,
    /** True when the server side is a tombstone: delete beats edit, so "keep local" must copy. */
    val serverDeleted: Boolean = false,
    /** True when an ACL revocation caused it; the local edit can never win. */
    val aclRevoked: Boolean = false,
)

/**
 * Applied operation ids, retained for the frozen 180 days.
 *
 * Lets a replayed op be recognised as already applied instead of being re-executed after an
 * unknown network outcome.
 */
@Entity(tableName = "applied_operations")
data class AppliedOperationRow(
    @PrimaryKey val opId: String,
    val entityType: String,
    val entityId: String,
    val revision: Long,
    val appliedAt: Long,
)

/** Blob transfers for the 4 MiB chunked APPLY_BLOBS phase. */
@Entity(tableName = "blob_transfers", indices = [Index(value = ["entityType", "entityId"])])
data class BlobTransferRow(
    @PrimaryKey val blobId: String,
    val entityType: String,
    val entityId: String,
    val fieldName: String,
    val totalBytes: Long,
    val receivedBytes: Long,
    val chunkBytes: Int,
    val sha256: String?,
    val localUri: String?,
    val completedAt: Long?,
)
