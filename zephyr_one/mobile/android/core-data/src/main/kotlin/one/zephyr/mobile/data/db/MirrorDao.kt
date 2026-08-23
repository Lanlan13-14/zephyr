package one.zephyr.mobile.data.db

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

/**
 * The local mirror.
 *
 * Every read is scoped by ownerUserId at the call site because SHARED_RESOURCE_RESIDENCY.md 3
 * forbids another user's rows from ever appearing here; a query that forgets the owner would be a
 * residency bug, so the parameter is mandatory rather than defaulted.
 */
@Dao
interface MirrorDao {

    @Query(
        "SELECT * FROM mirror_entities WHERE entityType = :entityType AND ownerUserId = :ownerUserId " +
            "AND deletedAt IS NULL ORDER BY sortKey, entityId",
    )
    fun observeByType(entityType: String, ownerUserId: String): Flow<List<MirrorEntityRow>>

    /** 回收站. Soft-deleted rows, newest first: restore is the primary action. */
    @Query(
        "SELECT * FROM mirror_entities WHERE entityType = :entityType AND ownerUserId = :ownerUserId " +
            "AND deletedAt IS NOT NULL ORDER BY deletedAt DESC, entityId",
    )
    fun observeTrashedByType(entityType: String, ownerUserId: String): Flow<List<MirrorEntityRow>>

    @Query(
        "SELECT * FROM mirror_entities WHERE entityType = :entityType AND ownerUserId = :ownerUserId " +
            "AND deletedAt IS NULL ORDER BY sortKey, entityId",
    )
    suspend fun listByType(entityType: String, ownerUserId: String): List<MirrorEntityRow>

    @Query("SELECT * FROM mirror_entities WHERE entityType = :entityType AND entityId = :entityId")
    suspend fun find(entityType: String, entityId: String): MirrorEntityRow?

    @Query("SELECT * FROM mirror_entities WHERE entityType = :entityType AND entityId = :entityId")
    fun observe(entityType: String, entityId: String): Flow<MirrorEntityRow?>

    @Query("SELECT revision FROM mirror_entities WHERE entityType = :entityType AND entityId = :entityId")
    suspend fun revisionOf(entityType: String, entityId: String): Long?

    @Upsert
    suspend fun upsert(row: MirrorEntityRow)

    @Upsert
    suspend fun upsertAll(rows: List<MirrorEntityRow>)

    /** Soft delete first: notes have a recoverable state before the tombstone arrives. */
    @Query("UPDATE mirror_entities SET deletedAt = :deletedAt WHERE entityType = :entityType AND entityId = :entityId")
    suspend fun markDeleted(entityType: String, entityId: String, deletedAt: Long)

    @Query("DELETE FROM mirror_entities WHERE entityType = :entityType AND entityId = :entityId")
    suspend fun hardDelete(entityType: String, entityId: String)

    /** Used when a binding is dropped or an account is switched: no cross-account residue. */
    @Query("DELETE FROM mirror_entities")
    suspend fun deleteAll()

    @Query("DELETE FROM mirror_entities WHERE ownerUserId <> :ownerUserId")
    suspend fun deleteForeignOwners(ownerUserId: String)

    @Query("SELECT COUNT(*) FROM mirror_entities WHERE entityType = :entityType AND ownerUserId = :ownerUserId AND deletedAt IS NULL")
    suspend fun countByType(entityType: String, ownerUserId: String): Int

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertSearch(row: EntitySearchRow)

    @Query("DELETE FROM entity_search WHERE entityType = :entityType AND entityId = :entityId")
    suspend fun deleteSearch(entityType: String, entityId: String)

    @Query("DELETE FROM entity_search")
    suspend fun deleteAllSearch()

    /**
     * Clear the pending badge for rows whose operations have all drained.
     *
     * Driven by the pending_operations table rather than a counter so a crash between the push ack
     * and the flag update cannot leave a row badged forever.
     */
    @Query(
        "UPDATE mirror_entities SET hasPendingWrite = 0 WHERE hasPendingWrite = 1 AND NOT EXISTS (" +
            "SELECT 1 FROM pending_operations p WHERE p.entityType = mirror_entities.entityType " +
            "AND p.entityId = mirror_entities.entityId)",
    )
    suspend fun clearPendingFlagForSyncedRows()

    @Query(
        "UPDATE mirror_entities SET hasPendingWrite = 1 WHERE entityType = :entityType AND entityId = :entityId",
    )
    suspend fun markPending(entityType: String, entityId: String)

    /**
     * FTS4 match. Only owned rows are indexed, so a shared note can never be found here.
     */
    @Query(
        "SELECT m.* FROM mirror_entities m JOIN entity_search s " +
            "ON m.entityType = s.entityType AND m.entityId = s.entityId " +
            "WHERE entity_search MATCH :query AND m.ownerUserId = :ownerUserId AND m.deletedAt IS NULL",
    )
    suspend fun search(query: String, ownerUserId: String): List<MirrorEntityRow>

    @Transaction
    suspend fun replaceWithSnapshot(rows: List<MirrorEntityRow>) {
        deleteAll()
        deleteAllSearch()
        upsertAll(rows)
    }
}

/** Device-local overlay: values that must survive a server change but never be pushed. */
@Dao
interface OverlayDao {

    @Query("SELECT * FROM device_local_overlay WHERE entityType = :entityType AND entityId = :entityId")
    suspend fun forEntity(entityType: String, entityId: String): List<DeviceLocalOverlayRow>

    @Upsert
    suspend fun upsert(row: DeviceLocalOverlayRow)

    @Query("DELETE FROM device_local_overlay WHERE entityType = :entityType AND entityId = :entityId")
    suspend fun deleteForEntity(entityType: String, entityId: String)

    @Query("DELETE FROM device_local_overlay")
    suspend fun deleteAll()
}

/** Tombstones, retained for the frozen window so a late push can be recognised as stale. */
@Dao
interface TombstoneDao {

    @Upsert
    suspend fun upsert(row: TombstoneRow)

    @Query("SELECT * FROM tombstones WHERE entityType = :entityType AND entityId = :entityId")
    suspend fun find(entityType: String, entityId: String): TombstoneRow?

    @Query("DELETE FROM tombstones WHERE deletedAt < :cutoff")
    suspend fun pruneOlderThan(cutoff: Long): Int

    @Query("DELETE FROM tombstones")
    suspend fun deleteAll()
}
