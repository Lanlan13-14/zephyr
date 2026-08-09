package one.zephyr.mobile.data.db

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.Fts4
import androidx.room.Index
import androidx.room.PrimaryKey

/**
 * The local mirror of the bound account's own data.
 *
 * One row per (entityType, entityId). Only owned data is ever inserted here:
 * SHARED_RESOURCE_RESIDENCY.md 3 forbids shared-to-me resources from touching the database at all,
 * which is why [ownerUserId] is asserted on write rather than filtered on read.
 */
@Entity(
    tableName = "mirror_entities",
    primaryKeys = ["entityType", "entityId"],
    indices = [
        Index(value = ["entityType", "deletedAt"]),
        Index(value = ["entityType", "sortKey"]),
        Index(value = ["revision"]),
    ],
)
data class MirrorEntityRow(
    val entityType: String,
    val entityId: String,
    val ownerUserId: String,
    /** Server revision. 0 means the row exists only locally and has never been acknowledged. */
    val revision: Long,
    /** Full server payload including opaquePreserve fields, which must survive untouched. */
    val payloadJson: String,
    /** hasX flags only; the values live in the SecretStore keyed by SecretRef. */
    val secretPresenceJson: String,
    /** Soft delete marker for entities whose deleteMode is soft-delete-then-tombstone. */
    val deletedAt: Long?,
    val serverUpdatedAt: Long?,
    val localUpdatedAt: Long,
    /** Set while a local edit has not been acknowledged, so the UI can show a pending badge. */
    val hasPendingWrite: Boolean = false,
    /**
     * Precomputed list ordering key, recomputed on every mirror write.
     *
     * Sorting cannot be done on the JSON payload in SQL, and the frozen list orders differ per
     * entity (notes honour sortOrder, connections sort by display name), so the repository decides
     * the key and the DAO just orders by it.
     */
    val sortKey: String = "",
)

/**
 * Device-local field overlay.
 *
 * deviceLocal fields (registry classification 3) belong to this device only and must never appear
 * in a fieldMask or a push payload. Keeping them out of [MirrorEntityRow.payloadJson] makes that
 * structural instead of a rule someone has to remember.
 */
@Entity(tableName = "device_local_overlay", primaryKeys = ["entityType", "entityId", "fieldName"])
data class DeviceLocalOverlayRow(
    val entityType: String,
    val entityId: String,
    val fieldName: String,
    val valueJson: String,
    val updatedAt: Long,
)

/**
 * Tombstones for deleted entities.
 *
 * Retained for the frozen 180 days so a device that syncs late still learns about the delete
 * instead of resurrecting the row from its own stale mirror.
 */
@Entity(tableName = "tombstones", primaryKeys = ["entityType", "entityId"])
data class TombstoneRow(
    val entityType: String,
    val entityId: String,
    val revision: Long,
    val deletedAt: Long,
    /** Revocation tombstones (resourceAcl) are authoritative and cannot be overridden locally. */
    val authoritative: Boolean = false,
)

/**
 * Full-text search over owned notes and connections.
 *
 * Maintained in the same transaction as the mirror write. Shared-to-me content is never indexed
 * (SHARED_RESOURCE_RESIDENCY.md 143 requires a canary grep of the FTS tables to come up empty).
 */
@Fts4
@Entity(tableName = "entity_search")
data class EntitySearchRow(
    @PrimaryKey(autoGenerate = true) @ColumnInfo(name = "rowid") val rowId: Long = 0,
    val entityType: String,
    val entityId: String,
    val title: String,
    val body: String,
)
