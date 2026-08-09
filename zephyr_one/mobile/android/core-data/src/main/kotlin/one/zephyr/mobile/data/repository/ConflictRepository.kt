package one.zephyr.mobile.data.repository

import androidx.room.withTransaction
import java.util.UUID
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.serialization.json.JsonObject
import one.zephyr.mobile.contracts.ConflictResolution
import one.zephyr.mobile.data.EntityCodec
import one.zephyr.mobile.data.db.Converters
import one.zephyr.mobile.data.db.PendingOperationRow
import one.zephyr.mobile.data.db.ZephyrDatabase
import one.zephyr.mobile.model.ConflictRecord
import one.zephyr.mobile.model.sync.ConflictResolver

/**
 * The conflict centre.
 *
 * A conflict is stable: it survives retries and app restarts until the user chooses, because
 * SYNC_STATE_MACHINE.md 7.2 forbids silent re-resolution. Each resolution mints a fresh opId at the
 * newest server revision, which is what stops the server deduplicating the fix against the
 * operation that caused the conflict.
 */
class ConflictRepository(
    private val db: ZephyrDatabase,
    private val clock: () -> Long = System::currentTimeMillis,
    private val opIdFactory: () -> String = { "op-" + UUID.randomUUID() },
) {

    fun observeAll(): Flow<List<ConflictRecord>> =
        db.conflictDao().observeAll().map { rows ->
            rows.map { row ->
                ConflictRecord(
                    conflictId = row.conflictId,
                    entityType = row.entityType,
                    entityId = row.entityId,
                    displayName = displayNameOf(row.serverPayloadJson, row.localPayloadJson),
                    overlappingFields = Converters.textToStringList(row.overlapFieldsJson),
                    baseRevision = 0,
                    serverRevision = row.serverRevision,
                    localPayloadJson = row.localPayloadJson,
                    serverPayloadJson = row.serverPayloadJson,
                    basePayloadJson = null,
                    detectedAt = row.detectedAt,
                )
            }
        }

    suspend fun record(
        entityType: String,
        entityId: String,
        localMask: List<String>,
        localPayload: JsonObject,
        serverRevision: Long,
        serverPayload: JsonObject,
        overlapFields: List<String>,
        serverDeleted: Boolean = false,
        aclRevoked: Boolean = false,
        secretFields: List<String> = emptyList(),
    ) {
        val existing = db.conflictDao().forEntity(entityType, entityId)
        db.conflictDao().upsert(
            one.zephyr.mobile.data.db.ConflictRow(
                conflictId = existing?.conflictId ?: ("conflict-" + UUID.randomUUID()),
                entityType = entityType,
                entityId = entityId,
                localMaskJson = Converters.stringListToText(localMask),
                localPayloadJson = EntityCodec.encode(localPayload),
                serverRevision = serverRevision,
                serverPayloadJson = EntityCodec.encode(serverPayload),
                overlapFieldsJson = Converters.stringListToText(overlapFields),
                secretFieldsJson = Converters.stringListToText(secretFields),
                detectedAt = existing?.detectedAt ?: clock(),
                serverDeleted = serverDeleted,
                aclRevoked = aclRevoked,
            ),
        )
    }

    /**
     * @return the new opId, or null when the resolution needs no operation (use_server).
     * @throws IllegalStateException when the caller tries to keep a local edit over an
     *   authoritative revocation tombstone, which ACL policy never permits.
     */
    suspend fun resolve(conflictId: String, resolution: ConflictResolution): String? {
        val row = db.conflictDao().find(conflictId) ?: return null

        if (row.aclRevoked && resolution == ConflictResolution.KEEP_LOCAL) {
            throw IllegalStateException(
                "keep_local cannot override an ACL revocation; copy_as_new or use_server only",
            )
        }
        if (row.serverDeleted && resolution == ConflictResolution.KEEP_LOCAL) {
            throw IllegalStateException("the server deleted this row; use copy_as_new to keep the edit")
        }

        val outcome = ConflictResolver.resolve(
            resolution = resolution,
            entityType = row.entityType,
            entityId = row.entityId,
            serverRevision = row.serverRevision,
            newOpId = opIdFactory(),
            mask = Converters.textToStringList(row.localMaskJson),
            payload = EntityCodec.parse(row.localPayloadJson),
            createdAt = clock(),
            secretFields = Converters.textToStringList(row.secretFieldsJson),
        )

        db.withTransaction {
            // The stale operation goes first: leaving it queued would push the losing edit again.
            db.pendingOperationDao().deleteForEntity(row.entityType, row.entityId)
            outcome.operation?.let { op ->
                db.pendingOperationDao().upsert(
                    PendingOperationRow(
                        opId = op.opId,
                        batchId = null,
                        entityType = op.entityType,
                        entityId = op.entityId,
                        action = op.action.name.lowercase(),
                        baseRevision = op.baseRevision,
                        fieldMaskJson = Converters.stringListToText(op.fieldMask),
                        payloadJson = EntityCodec.encode(op.payload),
                        createdAt = op.createdAt,
                        attemptCount = 0,
                        lastError = null,
                        createdLocally = op.createdLocally,
                        secretFieldsJson = Converters.stringListToText(op.secretFields),
                        dispatchedAt = null,
                    ),
                )
            }
            if (outcome.clearsConflict) db.conflictDao().delete(conflictId)
        }
        return outcome.operation?.opId
    }

    suspend fun count(): Int = db.conflictDao().count()

    private fun displayNameOf(serverPayloadJson: String, localPayloadJson: String): String {
        val server = EntityCodec.parse(serverPayloadJson)
        val local = EntityCodec.parse(localPayloadJson)
        return EntityCodec.string(local, "name")
            ?: EntityCodec.string(local, "title")
            ?: EntityCodec.string(server, "name")
            ?: EntityCodec.string(server, "title")
            ?: ""
    }
}
