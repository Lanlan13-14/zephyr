package one.zephyr.mobile.data.db

import androidx.room.Dao
import androidx.room.Query
import androidx.room.Transaction
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

@Dao
interface PendingOperationDao {

    /**
     * Ordered by creation so folding sees the user's real edit sequence; dependency ordering is
     * applied later by OperationFolding.sortForPush.
     */
    @Query("SELECT * FROM pending_operations ORDER BY createdAt, opId")
    suspend fun all(): List<PendingOperationRow>

    @Query("SELECT * FROM pending_operations ORDER BY createdAt, opId")
    fun observeAll(): Flow<List<PendingOperationRow>>

    @Query("SELECT COUNT(*) FROM pending_operations")
    fun observeCount(): Flow<Int>

    @Query("SELECT * FROM pending_operations WHERE entityType = :entityType AND entityId = :entityId ORDER BY createdAt")
    suspend fun forEntity(entityType: String, entityId: String): List<PendingOperationRow>

    /** Sent but unacknowledged: these must replay under their original opId. */
    @Query("SELECT * FROM pending_operations WHERE dispatchedAt IS NOT NULL ORDER BY createdAt")
    suspend fun dispatched(): List<PendingOperationRow>

    @Upsert
    suspend fun upsert(row: PendingOperationRow)

    @Upsert
    suspend fun upsertAll(rows: List<PendingOperationRow>)

    @Query("UPDATE pending_operations SET dispatchedAt = :at, batchId = :batchId WHERE opId IN (:opIds)")
    suspend fun markDispatched(opIds: List<String>, at: Long, batchId: String)

    @Query("UPDATE pending_operations SET attemptCount = attemptCount + 1, lastError = :error, dispatchedAt = NULL WHERE opId = :opId")
    suspend fun markFailed(opId: String, error: String?)

    @Query("DELETE FROM pending_operations WHERE opId IN (:opIds)")
    suspend fun deleteByIds(opIds: List<String>)

    @Query("DELETE FROM pending_operations WHERE entityType = :entityType AND entityId = :entityId")
    suspend fun deleteForEntity(entityType: String, entityId: String)

    @Query("DELETE FROM pending_operations")
    suspend fun deleteAll()
}

@Dao
interface BootstrapDao {

    @Upsert
    suspend fun stage(rows: List<BootstrapStagingRow>)

    @Query("SELECT * FROM bootstrap_staging WHERE generation = :generation ORDER BY entityType, entityId")
    suspend fun staged(generation: Long): List<BootstrapStagingRow>

    /** Every staged row, used to remove generation-scoped temporary secret refs on restart. */
    @Query("SELECT * FROM bootstrap_staging ORDER BY generation, entityType, entityId")
    suspend fun allStaged(): List<BootstrapStagingRow>

    @Query("SELECT COUNT(*) FROM bootstrap_staging WHERE generation = :generation")
    suspend fun stagedCount(generation: Long): Int

    @Query("DELETE FROM bootstrap_staging WHERE generation = :generation")
    suspend fun clearGeneration(generation: Long)

    /** Abandoned generations are dropped so a retried bootstrap cannot mix two snapshots. */
    @Query("DELETE FROM bootstrap_staging WHERE generation <> :keepGeneration")
    suspend fun clearOtherGenerations(keepGeneration: Long)

    @Query("DELETE FROM bootstrap_staging")
    suspend fun clearAll()

    @Upsert
    suspend fun saveProgress(row: BootstrapProgressRow)

    @Query("SELECT * FROM bootstrap_progress WHERE bindingKey = :bindingKey")
    suspend fun progress(bindingKey: String): BootstrapProgressRow?

    @Query("DELETE FROM bootstrap_progress WHERE bindingKey = :bindingKey")
    suspend fun clearProgress(bindingKey: String)
}

@Dao
interface SyncStateDao {

    @Query("SELECT * FROM sync_state WHERE bindingKey = :bindingKey")
    suspend fun find(bindingKey: String): SyncStateRow?

    @Query("SELECT * FROM sync_state WHERE bindingKey = :bindingKey")
    fun observe(bindingKey: String): Flow<SyncStateRow?>

    @Upsert
    suspend fun upsert(row: SyncStateRow)

    @Query("UPDATE sync_state SET bindingState = :state WHERE bindingKey = :bindingKey")
    suspend fun updateState(bindingKey: String, state: String)

    /**
     * appliedCursor and ackedCursor move separately: a page may be applied locally before the ack
     * round trip succeeds, and only the ack lets the server prune its change log.
     */
    @Query("UPDATE sync_state SET appliedCursor = :cursor WHERE bindingKey = :bindingKey")
    suspend fun updateAppliedCursor(bindingKey: String, cursor: Long)

    @Query("UPDATE sync_state SET ackedCursor = :cursor WHERE bindingKey = :bindingKey")
    suspend fun updateAckedCursor(bindingKey: String, cursor: Long)

    @Query("DELETE FROM sync_state")
    suspend fun deleteAll()
}

@Dao
interface ConflictDao {

    @Query("SELECT * FROM conflicts ORDER BY detectedAt DESC")
    fun observeAll(): Flow<List<ConflictRow>>

    @Query("SELECT COUNT(*) FROM conflicts")
    fun observeCount(): Flow<Int>

    @Query("SELECT * FROM conflicts WHERE conflictId = :conflictId")
    suspend fun find(conflictId: String): ConflictRow?

    @Query("SELECT * FROM conflicts WHERE entityType = :entityType AND entityId = :entityId")
    suspend fun forEntity(entityType: String, entityId: String): ConflictRow?

    @Query("SELECT COUNT(*) FROM conflicts")
    suspend fun count(): Int

    @Upsert
    suspend fun upsert(row: ConflictRow)

    @Query("DELETE FROM conflicts WHERE conflictId = :conflictId")
    suspend fun delete(conflictId: String)

    @Query("DELETE FROM conflicts")
    suspend fun deleteAll()
}

@Dao
interface AppliedOperationDao {

    @Upsert
    suspend fun upsertAll(rows: List<AppliedOperationRow>)

    @Query("SELECT opId FROM applied_operations WHERE opId IN (:opIds)")
    suspend fun known(opIds: List<String>): List<String>

    @Query("DELETE FROM applied_operations WHERE appliedAt < :cutoff")
    suspend fun pruneOlderThan(cutoff: Long): Int

    @Query("DELETE FROM applied_operations")
    suspend fun deleteAll()
}

@Dao
interface BlobTransferDao {

    @Upsert
    suspend fun upsert(row: BlobTransferRow)

    @Query("SELECT * FROM blob_transfers WHERE completedAt IS NULL ORDER BY blobId")
    suspend fun pending(): List<BlobTransferRow>

    @Query("SELECT * FROM blob_transfers WHERE blobId = :blobId")
    suspend fun find(blobId: String): BlobTransferRow?

    @Query("UPDATE blob_transfers SET receivedBytes = :received WHERE blobId = :blobId")
    suspend fun updateProgress(blobId: String, received: Long)

    @Query("DELETE FROM blob_transfers WHERE blobId = :blobId")
    suspend fun delete(blobId: String)

    @Query("DELETE FROM blob_transfers")
    suspend fun deleteAll()

    @Transaction
    suspend fun complete(blobId: String, at: Long, localUri: String?) {
        find(blobId)?.let { upsert(it.copy(completedAt = at, localUri = localUri)) }
    }
}
