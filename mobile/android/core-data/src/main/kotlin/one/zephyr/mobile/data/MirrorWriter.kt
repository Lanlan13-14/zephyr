package one.zephyr.mobile.data

import androidx.room.withTransaction
import kotlinx.serialization.json.JsonObject
import one.zephyr.mobile.contracts.EntityRegistry
import one.zephyr.mobile.contracts.SyncAction
import one.zephyr.mobile.data.db.BootstrapStagingRow
import one.zephyr.mobile.data.db.Converters
import one.zephyr.mobile.data.db.EntitySearchRow
import one.zephyr.mobile.data.db.MirrorEntityRow
import one.zephyr.mobile.data.db.TombstoneRow
import one.zephyr.mobile.data.db.ZephyrDatabase
import one.zephyr.mobile.model.SecretRef
import one.zephyr.mobile.model.SyncChange
import one.zephyr.mobile.model.sync.PushPrediction
import one.zephyr.mobile.security.SecretStore

/** Outcome of applying one page, used by the actor to decide the next phase. */
data class ApplyPageResult(
    val applied: Int,
    val skipped: Int,
    val deleted: Int,
    val appliedCursor: Long,
    /** Entities whose secret envelope could not be opened; they keep the previous local value. */
    val envelopeFailures: List<String> = emptyList(),
)

/** Decrypts one envelope. Implemented in core-sync, where the device private key is reachable. */
fun interface EnvelopeOpener {
    /**
     * @return plaintext, or null when the envelope must be rejected. Rejection is not fatal to the
     *   page: the field keeps its previous local value and the failure is reported so the next round
     *   can retry with a fresh revision.
     */
    fun open(change: SyncChange, fieldName: String): ByteArray?
}

/**
 * Applies server changes to the local mirror.
 *
 * Every rule here comes from SYNC_STATE_MACHINE.md 6:
 *  - a page is applied in one transaction so the cursor and the rows advance together;
 *  - a change is skipped when its revision is not newer, which makes the echo of our own push free;
 *  - a tombstone always wins, even against a higher local revision;
 *  - opaquePreserve fields are copied from the server payload verbatim;
 *  - deviceLocal fields live in the overlay and are never overwritten by a server payload.
 */
class MirrorWriter(
    private val db: ZephyrDatabase,
    private val secretStore: SecretStore,
    private val clock: () -> Long = System::currentTimeMillis,
) {

    suspend fun applyPage(
        changes: List<SyncChange>,
        boundUserId: String,
        startCursor: Long,
        opener: EnvelopeOpener? = null,
    ): ApplyPageResult {
        var applied = 0
        var skipped = 0
        var deleted = 0
        var cursor = startCursor
        val failures = mutableListOf<String>()

        db.withTransaction {
            for (change in changes) {
                if (EntityRegistry.byType[change.entityType] == null) {
                    // An unknown entity type from a newer server is skipped, not guessed at. The
                    // cursor still advances so the client is not wedged behind it.
                    skipped += 1
                    cursor = maxOf(cursor, change.changeSeq)
                    continue
                }

                val localRevision = db.mirrorDao().revisionOf(change.entityType, change.entityId)
                if (!PushPrediction.shouldApplyChange(localRevision, change.action, change.revision)) {
                    skipped += 1
                    cursor = maxOf(cursor, change.changeSeq)
                    continue
                }

                if (change.isDelete) {
                    applyDelete(change)
                    deleted += 1
                } else {
                    val failed = applyUpsert(change, boundUserId, opener)
                    if (failed.isNotEmpty()) failures.addAll(failed)
                    applied += 1
                }
                cursor = maxOf(cursor, change.changeSeq)
            }
            db.mirrorDao().clearPendingFlagForSyncedRows()
        }

        return ApplyPageResult(applied, skipped, deleted, cursor, failures)
    }

    private suspend fun applyUpsert(
        change: SyncChange,
        boundUserId: String,
        opener: EnvelopeOpener?,
    ): List<String> {
        val spec = EntityRegistry.require(change.entityType)
        val ownerUserId = EntityCodec.string(change.payload, spec.ownerField) ?: boundUserId

        // Residency is enforced at the door: a row the bound account does not own must never enter
        // the mirror, even if the server sent it (SHARED_RESOURCE_RESIDENCY.md 3).
        if (ownerUserId != boundUserId) return listOf(change.entityType + "/" + change.entityId)

        val existing = db.mirrorDao().find(change.entityType, change.entityId)
        val storedPayload = existing?.let { EntityCodec.parse(it.payloadJson) } ?: JsonObject(emptyMap())

        // A partial change page names the fields it carries; a full snapshot entry carries none and
        // replaces the payload outright.
        val nextPayload = if (change.fieldMask.isEmpty()) {
            change.payload
        } else {
            EntityCodec.merge(storedPayload, change.payload, change.fieldMask)
        }

        val failures = mutableListOf<String>()
        for ((fieldName, _) in change.secretEnvelopes) {
            if (!spec.secretFields.contains(fieldName)) {
                // The server is not allowed to invent a secret field: writing it would create a
                // SecretStore entry no screen can ever clear.
                failures.add(change.entityType + "/" + change.entityId + "/" + fieldName)
                continue
            }
            val plaintext = opener?.open(change, fieldName)
            if (plaintext == null) {
                failures.add(change.entityType + "/" + change.entityId + "/" + fieldName)
                continue
            }
            try {
                secretStore.put(SecretRef.of(change.entityType, change.entityId, fieldName), plaintext)
            } finally {
                plaintext.fill(0)
            }
        }

        db.mirrorDao().upsert(
            MirrorEntityRow(
                entityType = change.entityType,
                entityId = change.entityId,
                ownerUserId = ownerUserId,
                revision = change.revision,
                payloadJson = EntityCodec.encode(nextPayload),
                secretPresenceJson = Converters.jsonObjectToText(presenceFrom(change, nextPayload)),
                deletedAt = null,
                serverUpdatedAt = change.changedAt,
                localUpdatedAt = clock(),
                sortKey = EntityCodec.sortKeyFor(change.entityType, nextPayload),
                hasPendingWrite = false,
            ),
        )
        reindex(change.entityType, change.entityId, nextPayload)
        return failures
    }

    private suspend fun applyDelete(change: SyncChange) {
        val spec = EntityRegistry.require(change.entityType)
        if (spec.deleteMode == "soft-delete-then-tombstone") {
            db.mirrorDao().markDeleted(change.entityType, change.entityId, change.changedAt)
        } else {
            db.mirrorDao().hardDelete(change.entityType, change.entityId)
        }
        db.mirrorDao().deleteSearch(change.entityType, change.entityId)
        db.overlayDao().deleteForEntity(change.entityType, change.entityId)
        db.tombstoneDao().upsert(
            TombstoneRow(
                entityType = change.entityType,
                entityId = change.entityId,
                revision = change.revision,
                deletedAt = change.changedAt,
                // An ACL revocation tombstone is authoritative: "keep local" can never override it.
                authoritative = spec.deleteMode == "revocation-tombstone",
            ),
        )
        // A local edit to a row the server deleted is dead; keeping it queued would resurrect it.
        db.pendingOperationDao().deleteForEntity(change.entityType, change.entityId)
        secretStore.removeEntity(change.entityType, change.entityId)
    }

    /** Presence flags the UI shows. Derived from the payload plus whatever envelopes arrived. */
    private fun presenceFrom(change: SyncChange, payload: JsonObject): JsonObject {
        val spec = EntityRegistry.require(change.entityType)
        val map = LinkedHashMap<String, kotlinx.serialization.json.JsonElement>()
        for (field in spec.secretFields) {
            val flag = "has" + field.replaceFirstChar { it.uppercaseChar() }
            val fromPayload = EntityCodec.bool(payload, flag, false)
            val fromEnvelope = change.secretEnvelopes.containsKey(field)
            map[flag] = kotlinx.serialization.json.JsonPrimitive(fromPayload || fromEnvelope)
        }
        return JsonObject(map)
    }

    private suspend fun reindex(entityType: String, entityId: String, payload: JsonObject) {
        val text = EntityCodec.searchText(entityType, payload) ?: return
        db.mirrorDao().deleteSearch(entityType, entityId)
        db.mirrorDao().upsertSearch(
            EntitySearchRow(entityType = entityType, entityId = entityId, title = text.first, body = text.second),
        )
    }

    // ---- bootstrap staging -------------------------------------------------------------------

    /**
     * Stage a snapshot page.
     *
     * Staged rows are invisible to the UI until [promoteBootstrap] runs, so an interrupted or
     * expired bootstrap leaves the previous mirror intact (DATA_AND_MIGRATION.md 7.2).
     */
    suspend fun stageBootstrapPage(generation: Long, entities: List<SyncChange>, boundUserId: String): Int {
        val rows = entities.mapNotNull { change ->
            val spec = EntityRegistry.byType[change.entityType] ?: return@mapNotNull null
            val ownerUserId = EntityCodec.string(change.payload, spec.ownerField) ?: boundUserId
            if (ownerUserId != boundUserId) return@mapNotNull null
            BootstrapStagingRow(
                generation = generation,
                entityType = change.entityType,
                entityId = change.entityId,
                ownerUserId = ownerUserId,
                revision = change.revision,
                payloadJson = EntityCodec.encode(change.payload),
                secretPresenceJson = Converters.jsonObjectToText(presenceFrom(change, change.payload)),
                deletedAt = null,
                serverUpdatedAt = change.changedAt,
            )
        }
        db.bootstrapDao().stage(rows)
        return rows.size
    }

    /**
     * Swap the staged generation into the mirror.
     *
     * Pending local operations deliberately survive: a snapshot is a fresh view of the server, not
     * a reason to discard writes the user has not seen fail.
     */
    suspend fun promoteBootstrap(generation: Long) {
        db.withTransaction {
            val staged = db.bootstrapDao().staged(generation)
            val now = clock()
            val rows = staged.map { row ->
                val payload = EntityCodec.parse(row.payloadJson)
                MirrorEntityRow(
                    entityType = row.entityType,
                    entityId = row.entityId,
                    ownerUserId = row.ownerUserId,
                    revision = row.revision,
                    payloadJson = row.payloadJson,
                    secretPresenceJson = row.secretPresenceJson,
                    deletedAt = row.deletedAt,
                    serverUpdatedAt = row.serverUpdatedAt,
                    localUpdatedAt = now,
                    sortKey = EntityCodec.sortKeyFor(row.entityType, payload),
                    hasPendingWrite = false,
                )
            }
            db.mirrorDao().replaceWithSnapshot(rows)
            for (row in rows) {
                val payload = EntityCodec.parse(row.payloadJson)
                val text = EntityCodec.searchText(row.entityType, payload) ?: continue
                db.mirrorDao().upsertSearch(
                    EntitySearchRow(
                        entityType = row.entityType,
                        entityId = row.entityId,
                        title = text.first,
                        body = text.second,
                    ),
                )
            }
            db.bootstrapDao().clearGeneration(generation)
            db.bootstrapDao().clearOtherGenerations(generation)
        }
    }

    /** Retention pruning for the frozen 180-day windows. */
    suspend fun pruneRetention(nowMs: Long = clock()) {
        val tombstoneCutoff = nowMs - DAY_MS * one.zephyr.mobile.contracts.SyncContract.TOMBSTONE_RETENTION_DAYS
        val appliedCutoff = nowMs - DAY_MS * one.zephyr.mobile.contracts.SyncContract.APPLIED_OP_RETENTION_DAYS
        db.withTransaction {
            db.tombstoneDao().pruneOlderThan(tombstoneCutoff)
            db.appliedOperationDao().pruneOlderThan(appliedCutoff)
        }
    }

    private companion object {
        const val DAY_MS = 24L * 60 * 60 * 1000
    }
}
