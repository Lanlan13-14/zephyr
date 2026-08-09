package one.zephyr.mobile.data

import androidx.room.withTransaction
import java.util.UUID
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.serialization.json.JsonObject
import one.zephyr.mobile.contracts.Capability
import one.zephyr.mobile.contracts.EntityRegistry
import one.zephyr.mobile.contracts.SyncAction
import one.zephyr.mobile.data.db.Converters
import one.zephyr.mobile.data.db.EntitySearchRow
import one.zephyr.mobile.data.db.MirrorEntityRow
import one.zephyr.mobile.data.db.PendingOperationRow
import one.zephyr.mobile.data.db.TombstoneRow
import one.zephyr.mobile.data.db.ZephyrDatabase
import one.zephyr.mobile.model.CapabilitySet
import one.zephyr.mobile.model.Residency
import one.zephyr.mobile.model.SecretRef
import one.zephyr.mobile.model.SecretState
import one.zephyr.mobile.model.sync.FieldMask
import one.zephyr.mobile.model.sync.MaskRejection
import one.zephyr.mobile.security.ResidencyViolationException
import one.zephyr.mobile.security.SecretStore

/** A single user edit, before sanitation. */
data class LocalEdit(
    val entityType: String,
    val entityId: String,
    val action: SyncAction,
    /** Fields the user actually touched. Sanitised against the registry before anything is stored. */
    val requestedMask: List<String>,
    /** New values for the masked fields only. */
    val values: JsonObject = JsonObject(emptyMap()),
    /** Secret fields keyed by registry field name. Unchanged entries never reach the mask. */
    val secrets: Map<String, SecretState> = emptyMap(),
    /** Device-local fields, stored in the overlay and never pushed. */
    val deviceLocal: Map<String, JsonObject> = emptyMap(),
    val residency: Residency = Residency.OWNED,
    val capabilities: CapabilitySet = CapabilitySet.owner,
    /** True for a row the user just created that the server has never seen. */
    val createdLocally: Boolean = false,
)

data class LocalEditResult(
    val opId: String?,
    val acceptedMask: List<String>,
    val rejectedMask: List<MaskRejection>,
    val revision: Long,
)

class LocalWriteRejected(val reason: String, message: String) : IllegalArgumentException(message)

/**
 * The only path a local edit may take into the database.
 *
 * SYNC_STATE_MACHINE.md 5.2 requires the optimistic mirror write and its pending operation to be
 * committed atomically, so every mutation runs inside one Room transaction. Room's own
 * withTransaction uses SQLite's deferred transaction; that is sufficient here because a single
 * writer connection is enforced by Room and the actor in core-sync is the only other writer.
 *
 * The gateway also owns the four invariants that would otherwise be scattered across UI code:
 *  1. only owned data may be persisted at all;
 *  2. a mask may only ever name editable fields, so a masked placeholder cannot be pushed;
 *  3. secrets go to the SecretStore, never into the mirror payload;
 *  4. a row the user has no EDIT capability for cannot queue an operation.
 */
class LocalWriteGateway(
    private val db: ZephyrDatabase,
    private val secretStore: SecretStore,
    private val clock: () -> Long = System::currentTimeMillis,
    private val opIdFactory: () -> String = { "op-" + UUID.randomUUID() },
) {

    private val signals = MutableSharedFlow<Unit>(replay = 1, extraBufferCapacity = 1)

    /** Emitted after a successful commit so the sync actor can debounce a push round. */
    val writeSignals: SharedFlow<Unit> = signals

    suspend fun apply(edit: LocalEdit, ownerUserId: String): LocalEditResult {
        val spec = EntityRegistry.byType[edit.entityType]
            ?: throw LocalWriteRejected("unknown_entity_type", "unknown entity type " + edit.entityType)

        if (!edit.residency.allowsLocalPersistence) {
            throw ResidencyViolationException(
                "shared-to-me " + edit.entityType + " must not be written to the local mirror",
            )
        }
        if (!edit.capabilities.allowsLocalWriteQueue) {
            throw LocalWriteRejected(
                "capability_denied",
                "no edit capability for " + edit.entityType + "/" + edit.entityId,
            )
        }
        if (edit.action == SyncAction.DELETE && !edit.capabilities.contains(Capability.DELETE)) {
            throw LocalWriteRejected("capability_denied", "no delete capability for " + edit.entityType)
        }

        // activityEvent has no editable fields at all: it is append-only server-side, so it can
        // never produce an operation and must be rejected before anything is written.
        if (spec.editableFields.isEmpty()) {
            throw LocalWriteRejected("not_editable", edit.entityType + " is not user-editable")
        }

        val now = clock()
        val sanitized = FieldMask.sanitize(edit.entityType, edit.requestedMask)

        // A secret change is never named in the mask, but it still has to make the operation
        // non-empty so the push carries the envelope.
        val changedSecrets = edit.secrets.filterValues { it.contributesToFieldMask }

        if (edit.action == SyncAction.UPSERT && sanitized.accepted.isEmpty() && changedSecrets.isEmpty()) {
            throw LocalWriteRejected("empty_field_mask", "nothing editable changed for " + edit.entityType)
        }

        var opId: String? = null
        var revision = 0L

        db.withTransaction {
            val existing = db.mirrorDao().find(edit.entityType, edit.entityId)
            if (existing != null && existing.ownerUserId != ownerUserId) {
                // Defence in depth: a row owned by someone else cannot be edited through One even
                // if a caller somehow reached this point with the wrong binding.
                throw ResidencyViolationException("refusing to edit foreign-owned " + edit.entityType)
            }
            revision = existing?.revision ?: 0L
            val storedPayload = existing?.let { EntityCodec.parse(it.payloadJson) } ?: JsonObject(emptyMap())

            when (edit.action) {
                SyncAction.UPSERT -> {
                    val mergedPayload = EntityCodec.merge(storedPayload, edit.values, sanitized.accepted)
                    val presence = presenceAfter(existing, edit)
                    db.mirrorDao().upsert(
                        MirrorEntityRow(
                            entityType = edit.entityType,
                            entityId = edit.entityId,
                            ownerUserId = ownerUserId,
                            revision = revision,
                            payloadJson = EntityCodec.encode(mergedPayload),
                            secretPresenceJson = Converters.jsonObjectToText(presence),
                            deletedAt = null,
                            serverUpdatedAt = existing?.serverUpdatedAt,
                            localUpdatedAt = now,
                            sortKey = EntityCodec.sortKeyFor(edit.entityType, mergedPayload),
                            hasPendingWrite = true,
                        ),
                    )
                    reindex(edit.entityType, edit.entityId, mergedPayload)
                    writeSecrets(edit, ownerUserId)
                    writeOverlay(edit, now)
                }

                SyncAction.DELETE -> {
                    val softDelete = spec.deleteMode == "soft-delete-then-tombstone"
                    if (softDelete) {
                        db.mirrorDao().markDeleted(edit.entityType, edit.entityId, now)
                    } else {
                        db.mirrorDao().hardDelete(edit.entityType, edit.entityId)
                    }
                    db.mirrorDao().deleteSearch(edit.entityType, edit.entityId)
                    db.tombstoneDao().upsert(
                        TombstoneRow(
                            entityType = edit.entityType,
                            entityId = edit.entityId,
                            revision = revision,
                            deletedAt = now,
                            authoritative = false,
                        ),
                    )
                    // The local secret goes immediately: a deleted row must not leave key material
                    // behind while the delete is still queued.
                    secretStore.removeEntity(edit.entityType, edit.entityId)
                }

                SyncAction.RESTORE -> {
                    // Only a soft-deleted row can be restored; a hard-deleted one is gone locally
                    // and has to come back from the server instead.
                    val row = existing
                        ?: throw LocalWriteRejected("not_restorable", "no local row to restore for " + edit.entityType)
                    db.mirrorDao().upsert(row.copy(deletedAt = null, localUpdatedAt = now, hasPendingWrite = true))
                    reindex(edit.entityType, edit.entityId, EntityCodec.parse(row.payloadJson))
                }
            }


            val newOpId = opIdFactory()
            opId = newOpId
            db.pendingOperationDao().upsert(
                PendingOperationRow(
                    opId = newOpId,
                    batchId = null,
                    entityType = edit.entityType,
                    entityId = edit.entityId,
                    action = edit.action.name.lowercase(),
                    baseRevision = revision,
                    fieldMaskJson = Converters.stringListToText(
                        if (edit.action == SyncAction.UPSERT) sanitized.accepted else emptyList(),
                    ),
                    payloadJson = EntityCodec.encode(
                        if (edit.action == SyncAction.UPSERT) pushPayload(edit, sanitized.accepted) else JsonObject(emptyMap()),
                    ),
                    createdAt = now,
                    attemptCount = 0,
                    lastError = null,
                    createdLocally = edit.createdLocally,
                    // Only genuinely changed secrets: an Unchanged state must not cause a re-seal,
                    // which is what keeps a masked placeholder from becoming a new secret.
                    secretFieldsJson = Converters.stringListToText(
                        if (edit.action == SyncAction.UPSERT) changedSecrets.keys.toList() else emptyList(),
                    ),
                    dispatchedAt = null,
                ),
            )
        }

        signals.tryEmit(Unit)
        return LocalEditResult(
            opId = opId,
            acceptedMask = sanitized.accepted,
            rejectedMask = sanitized.rejected,
            revision = revision,
        )
    }

    /**
     * Only masked fields travel. Secret values are excluded on purpose: the sync actor attaches
     * envelopes separately, so plaintext never sits in the pending_operations table.
     */
    private fun pushPayload(edit: LocalEdit, mask: List<String>): JsonObject {
        val roots = mask.map(FieldMask::rootOf).toSet()
        return JsonObject(edit.values.filterKeys { roots.contains(it) })
    }

    private fun presenceAfter(
        existing: MirrorEntityRow?,
        edit: LocalEdit,
    ): JsonObject {
        val current = existing?.let { Converters.textToJsonObject(it.secretPresenceJson) } ?: JsonObject(emptyMap())
        val next = LinkedHashMap<String, kotlinx.serialization.json.JsonElement>(current)
        for ((field, state) in edit.secrets) {
            val flag = "has" + field.replaceFirstChar { it.uppercaseChar() }
            when (state) {
                is SecretState.Replace -> next[flag] = kotlinx.serialization.json.JsonPrimitive(true)
                SecretState.Clear -> next[flag] = kotlinx.serialization.json.JsonPrimitive(false)
                SecretState.Unchanged -> Unit
            }
        }
        return JsonObject(next)
    }

    private fun writeSecrets(edit: LocalEdit, ownerUserId: String) {
        for ((field, state) in edit.secrets) {
            val ref = SecretRef.of(edit.entityType, edit.entityId, field)
            when (state) {
                is SecretState.Replace -> secretStore.putText(ref, state.plaintext, edit.residency)
                SecretState.Clear -> secretStore.remove(ref)
                SecretState.Unchanged -> Unit
            }
        }
    }

    private suspend fun writeOverlay(edit: LocalEdit, now: Long) {
        for ((field, value) in edit.deviceLocal) {
            db.overlayDao().upsert(
                one.zephyr.mobile.data.db.DeviceLocalOverlayRow(
                    entityType = edit.entityType,
                    entityId = edit.entityId,
                    fieldName = field,
                    valueJson = Converters.jsonObjectToText(value),
                    updatedAt = now,
                ),
            )
        }
    }

    private suspend fun reindex(entityType: String, entityId: String, payload: JsonObject) {
        val text = EntityCodec.searchText(entityType, payload) ?: return
        db.mirrorDao().deleteSearch(entityType, entityId)
        db.mirrorDao().upsertSearch(
            EntitySearchRow(entityType = entityType, entityId = entityId, title = text.first, body = text.second),
        )
    }
}
