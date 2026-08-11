package one.zephyr.mobile.sync

import one.zephyr.mobile.contracts.SyncAction
import one.zephyr.mobile.contracts.SyncContract
import one.zephyr.mobile.model.PendingOperation
import one.zephyr.mobile.model.sync.OperationFolding

/** Why an operation is being held back rather than pushed this round. */
enum class DeferralReason {
    /** An earlier copy of the same entity is already in flight under its own opId. */
    IN_FLIGHT_PREDECESSOR,

    /** A changed secret cannot be sealed because no server encryption key is available. */
    SECRET_UNSEALABLE,
}

data class DeferredOperation(val opId: String, val reason: DeferralReason)

/**
 * What one PUSH_PENDING phase will send.
 *
 * @property batches dispatch order, already dependency-sorted and chunked to the frozen limit.
 * @property foldedKept operations to persist as the folded queue.
 * @property foldedRemoved opIds the fold superseded or dropped entirely.
 * @property deferred operations intentionally held back, with the reason.
 */
data class PushPlan(
    val batches: List<List<PendingOperation>>,
    val foldedKept: List<PendingOperation>,
    val foldedRemoved: List<String>,
    val deferred: List<DeferredOperation>,
) {
    val operationCount: Int get() = batches.sumOf { it.size }
    val isEmpty: Boolean get() = batches.isEmpty()
}

/**
 * Pure planning for the push phase.
 *
 * Separated from [SyncActor] so the two rules that are easy to get subtly wrong can be tested
 * directly:
 *
 *  1. An operation that has already been dispatched must replay under its original opId
 *     (SYNC_STATE_MACHINE.md 5.3). Folding rewrites content while keeping the *first* opId, so
 *     folding a group that contains an in-flight operation would change what that id means and the
 *     server would deduplicate the merged edit away. Such groups are therefore never folded, and the
 *     newer operations for that entity wait for the next round.
 *
 *  2. A changed secret is not named in the fieldMask, so an operation whose only change is a secret
 *     has an empty mask. The frozen SyncOperation schema requires a non-empty mask on upsert, so such
 *     an operation cannot be represented on the wire without an envelope and is deferred rather than
 *     sent as a no-op.
 */
object PushPlanner {

    fun plan(
        operations: List<PendingOperation>,
        canSealSecrets: Boolean,
        maxPerBatch: Int = SyncContract.MAX_OPS_PER_BATCH,
    ): PushPlan {
        if (operations.isEmpty()) {
            return PushPlan(emptyList(), emptyList(), emptyList(), emptyList())
        }

        val byEntity = LinkedHashMap<String, MutableList<PendingOperation>>()
        for (op in operations) {
            byEntity.getOrPut(op.entityType + "::" + op.entityId) { mutableListOf() }.add(op)
        }

        val sendable = mutableListOf<PendingOperation>()
        val keptFolds = mutableListOf<PendingOperation>()
        val removed = mutableListOf<String>()
        val deferred = mutableListOf<DeferredOperation>()

        for (group in byEntity.values) {
            val inFlight = group.filter { it.isDispatched }
            if (inFlight.isNotEmpty()) {
                // Replay the in-flight operations verbatim, and hold everything newer for this
                // entity until the server has ruled on them.
                sendable.addAll(inFlight)
                for (op in group) {
                    if (!op.isDispatched) {
                        deferred.add(DeferredOperation(op.opId, DeferralReason.IN_FLIGHT_PREDECESSOR))
                    }
                }
                continue
            }

            val folded = OperationFolding.fold(group)
            val keptIds = folded.map { it.opId }.toSet()
            for (op in group) if (!keptIds.contains(op.opId)) removed.add(op.opId)
            keptFolds.addAll(folded)

            for (op in folded) {
                if (op.secretFields.isNotEmpty() && !canSealSecrets) {
                    deferred.add(DeferredOperation(op.opId, DeferralReason.SECRET_UNSEALABLE))
                    continue
                }
                // An upsert with nothing to say cannot be encoded: the schema demands a non-empty
                // mask, and an empty payload would be a silent no-op on the server.
                if (
                    op.action == SyncAction.UPSERT && op.fieldMask.isEmpty() &&
                        op.secretFields.isEmpty() && op.clearSecretFields.isEmpty()
                ) {
                    removed.add(op.opId)
                    continue
                }
                sendable.add(op)
            }
        }

        val batches = if (sendable.isEmpty()) {
            emptyList()
        } else {
            OperationFolding.batch(sendable, maxPerBatch)
        }
        return PushPlan(
            batches = batches,
            foldedKept = keptFolds,
            foldedRemoved = removed.distinct(),
            deferred = deferred,
        )
    }
}
