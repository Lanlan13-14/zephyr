package one.zephyr.mobile.model.sync

import kotlinx.serialization.json.JsonObject
import one.zephyr.mobile.contracts.SyncAction
import one.zephyr.mobile.contracts.SyncContract
import one.zephyr.mobile.model.PendingOperation

/**
 * Push shaping: dependency ordering, batching and folding of unsent operations.
 *
 * Folding matters for correctness, not just efficiency: SYNC_STATE_MACHINE.md 6.2 requires a
 * locally created row that is deleted before its first push to disappear entirely, and requires a
 * merged update to keep the *oldest* baseRevision so the server can still detect a real conflict.
 */
object OperationFolding {

    fun dependencyOrder(entityType: String): Int = FieldMask.spec(entityType).dependencyOrder

    /**
     * Stable sort by dependency order. Ties keep insertion order so a create still precedes its
     * own later update inside the same entity type.
     */
    fun sortForPush(operations: List<PendingOperation>): List<PendingOperation> =
        operations.withIndex()
            .sortedWith(
                compareBy({ dependencyOrder(it.value.entityType) }, { it.index }),
            )
            .map { it.value }

    fun batch(
        operations: List<PendingOperation>,
        maxPerBatch: Int = SyncContract.MAX_OPS_PER_BATCH,
    ): List<List<PendingOperation>> {
        require(maxPerBatch > 0) { "batch size must be positive" }
        return sortForPush(operations).chunked(maxPerBatch)
    }

    /**
     * Collapse the queue for each entity.
     *
     * Retries reuse the folded operation's opId, which is why the merged upsert inherits the
     * *first* op's id: a sent-but-unacknowledged op must replay under its original id so the server
     * can deduplicate it.
     */
    fun fold(operations: List<PendingOperation>): List<PendingOperation> {
        val groups = LinkedHashMap<String, MutableList<PendingOperation>>()
        for (op in operations) {
            groups.getOrPut(op.entityType + "::" + op.entityId) { mutableListOf() }.add(op)
        }

        val folded = mutableListOf<PendingOperation>()
        for (group in groups.values) {
            val createdLocally = group.any { it.action == SyncAction.UPSERT && it.createdLocally }
            val lastDeleteIndex = group.indexOfLast { it.action == SyncAction.DELETE }
            val lastRestoreIndex = group.indexOfLast { it.action == SyncAction.RESTORE }

            // Never-synced row deleted before its first push: nothing for the server to hear about.
            if (lastDeleteIndex >= 0 && createdLocally && lastRestoreIndex < 0) continue

            if (lastDeleteIndex >= 0 && lastRestoreIndex < lastDeleteIndex) {
                val delete = group[lastDeleteIndex]
                folded.add(
                    delete.copy(
                        fieldMask = emptyList(),
                        payload = JsonObject(emptyMap()),
                        secretFields = emptyList(),
                        clearSecretFields = emptyList(),
                    ),
                )
                continue
            }

            val upserts = group.filter { it.action == SyncAction.UPSERT }
            if (upserts.isEmpty()) {
                folded.add(group.last())
                continue
            }

            // The wire deliberately makes replace envelopes and clears mutually exclusive. Keep
            // mixed secret operations in their original order instead of coalescing them into an
            // operation the server must reject. Their stable opIds retain retry idempotency.
            if (upserts.any { it.secretFields.isNotEmpty() } &&
                upserts.any { it.clearSecretFields.isNotEmpty() }
            ) {
                folded.addAll(upserts)
                continue
            }

            val mergedMask = mutableListOf<String>()
            val mergedPayload = mutableMapOf<String, kotlinx.serialization.json.JsonElement>()
            val mergedSecrets = mutableListOf<String>()
            val mergedClears = mutableListOf<String>()
            for (op in upserts) {
                for (field in op.fieldMask) if (!mergedMask.contains(field)) mergedMask.add(field)
                mergedPayload.putAll(op.payload)
                // Last write wins per secret field, and the SecretStore already holds that value, so
                // the union of names is enough to re-seal exactly once.
                for (field in op.secretFields) if (!mergedSecrets.contains(field)) mergedSecrets.add(field)
                for (field in op.clearSecretFields) if (!mergedClears.contains(field)) mergedClears.add(field)
            }
            folded.add(
                upserts.last().copy(
                    opId = upserts.first().opId,
                    action = SyncAction.UPSERT,
                    createdLocally = createdLocally,
                    baseRevision = upserts.minOf { it.baseRevision },
                    fieldMask = mergedMask.toList(),
                    payload = JsonObject(mergedPayload),
                    secretFields = mergedSecrets.toList(),
                    clearSecretFields = mergedClears.toList(),
                ),
            )
        }
        return folded
    }
}
