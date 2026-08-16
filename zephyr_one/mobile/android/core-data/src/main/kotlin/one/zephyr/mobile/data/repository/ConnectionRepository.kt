package one.zephyr.mobile.data.repository

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.map
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import one.zephyr.mobile.contracts.SyncAction
import one.zephyr.mobile.data.LocalEdit
import one.zephyr.mobile.data.LocalEditResult
import one.zephyr.mobile.data.LocalWriteGateway
import one.zephyr.mobile.data.db.DeviceLocalOverlayRow
import one.zephyr.mobile.data.db.ZephyrDatabase
import one.zephyr.mobile.data.mapper.ConnectionMapper
import one.zephyr.mobile.model.Connection
import one.zephyr.mobile.model.FileSyncDirectoryIntent
import one.zephyr.mobile.model.SecretState

/**
 * Owned connections.
 *
 * Reads come from the mirror, so the list works offline (PageState.OfflineWithCache). Shared-to-me
 * connections are deliberately absent: they have no mirror row and are served online-only by
 * [SharedResourceCache].
 */
class ConnectionRepository(
    private val db: ZephyrDatabase,
    private val gateway: LocalWriteGateway,
) {

    fun observeAll(ownerUserId: String): Flow<List<Connection>> =
        combine(
            db.mirrorDao().observeByType(Connection.ENTITY_TYPE, ownerUserId),
            db.pendingOperationDao().observeAll(),
            db.conflictDao().observeAll(),
        ) { rows, pending, conflicts ->
            val pendingIds = pending.filter { it.entityType == Connection.ENTITY_TYPE }.map { it.entityId }.toSet()
            val conflictIds = conflicts.filter { it.entityType == Connection.ENTITY_TYPE }.map { it.entityId }.toSet()
            rows.map { row ->
                ConnectionMapper.fromRow(
                    row = row,
                    pending = pendingIds.contains(row.entityId),
                    conflicted = conflictIds.contains(row.entityId),
                )
            }
        }

    fun observe(connectionId: String): Flow<Connection?> =
        db.mirrorDao().observe(Connection.ENTITY_TYPE, connectionId).map { row ->
            row?.let {
                ConnectionMapper.fromRow(
                    row = it,
                    pending = it.hasPendingWrite,
                    conflicted = false,
                    deviceLocal = overlayOf(connectionId),
                )
            }
        }

    suspend fun find(connectionId: String): Connection? =
        db.mirrorDao().find(Connection.ENTITY_TYPE, connectionId)?.let {
            ConnectionMapper.fromRow(
                row = it,
                pending = it.hasPendingWrite,
                conflicted = false,
                deviceLocal = overlayOf(connectionId),
            )
        }

    /**
     * Device-local field values for one connection.
     *
     * Stored as a JSON scalar per row, so the quotes a JsonPrimitive adds are stripped here rather
     * than leaving every consumer to remember to do it.
     */
    private suspend fun overlayOf(connectionId: String): Map<String, String> =
        db.overlayDao().forEntity(Connection.ENTITY_TYPE, connectionId)
            .associate { row -> row.fieldName to row.valueJson.trim().removeSurrounding("\"") }

    suspend fun all(ownerUserId: String): List<Connection> =
        db.mirrorDao().listByType(Connection.ENTITY_TYPE, ownerUserId)
            .map { ConnectionMapper.fromRow(it, pending = it.hasPendingWrite, conflicted = false) }

    suspend fun search(query: String, ownerUserId: String): List<Connection> =
        db.mirrorDao().search(query, ownerUserId)
            .filter { it.entityType == Connection.ENTITY_TYPE }
            .map { ConnectionMapper.fromRow(it, pending = it.hasPendingWrite, conflicted = false) }

    suspend fun count(ownerUserId: String): Int = db.mirrorDao().countByType(Connection.ENTITY_TYPE, ownerUserId)

    /**
     * @param mask fields the user actually edited. Sanitised again by the gateway, so passing a
     *   secret or authority field here is rejected rather than silently pushed.
     */
    suspend fun save(
        connection: Connection,
        mask: List<String>,
        secrets: Map<String, SecretState> = emptyMap(),
        ownerUserId: String,
        createdLocally: Boolean = false,
    ): LocalEditResult = gateway.apply(
        LocalEdit(
            entityType = Connection.ENTITY_TYPE,
            entityId = connection.id,
            action = SyncAction.UPSERT,
            requestedMask = mask,
            values = ConnectionMapper.editValues(connection, mask),
            secrets = secrets,
            residency = connection.residency,
            capabilities = connection.capabilities,
            createdLocally = createdLocally,
        ),
        ownerUserId = ownerUserId,
    )

    /**
     * Records the file-sync directory intent for one connection.
     *
     * Deliberately not routed through [LocalWriteGateway]: the frozen entity registry lists
     * storageIntent in neither editableFields nor deviceLocalFields, so the gateway would sanitise
     * it out of the mask and then reject the edit as empty_field_mask. Writing the overlay directly
     * keeps the user's choice on this device, which is where DEVELOPMENT.md 878 wants the directory
     * authorisation to live anyway, and queues nothing for push.
     *
     * The limitation is real and belongs in the status report: until the registry publishes the
     * field, this intent does not travel to other devices.
     */
    suspend fun setFileSyncIntent(connectionId: String, intent: FileSyncDirectoryIntent, nowMs: Long) {
        db.overlayDao().upsert(
            DeviceLocalOverlayRow(
                entityType = Connection.ENTITY_TYPE,
                entityId = connectionId,
                fieldName = ConnectionMapper.STORAGE_INTENT_FIELD,
                valueJson = JsonPrimitive(intent.wireName).toString(),
                updatedAt = nowMs,
            ),
        )
    }

    suspend fun delete(connection: Connection, ownerUserId: String): LocalEditResult = gateway.apply(
        LocalEdit(
            entityType = Connection.ENTITY_TYPE,
            entityId = connection.id,
            action = SyncAction.DELETE,
            requestedMask = emptyList(),
            values = JsonObject(emptyMap()),
            residency = connection.residency,
            capabilities = connection.capabilities,
        ),
        ownerUserId = ownerUserId,
    )

    /**
     * Reference check before a dependency is deleted.
     *
     * The server enforces this too, but doing it locally means the user is told which connections
     * would break instead of watching the push fail with dependency_missing.
     */
    suspend fun dependentsOf(resourceId: String, ownerUserId: String): List<Connection> =
        db.mirrorDao().listByType(Connection.ENTITY_TYPE, ownerUserId)
            .map { ConnectionMapper.fromRow(it, pending = false, conflicted = false) }
            .filter { it.dependencyIds.contains(resourceId) }
}
