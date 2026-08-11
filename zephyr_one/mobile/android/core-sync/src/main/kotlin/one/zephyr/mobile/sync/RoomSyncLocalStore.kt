package one.zephyr.mobile.sync

import androidx.room.withTransaction
import one.zephyr.mobile.contracts.BindingState
import one.zephyr.mobile.data.ApplyPageResult
import one.zephyr.mobile.data.EnvelopeOpener
import one.zephyr.mobile.data.MirrorWriter
import one.zephyr.mobile.data.SecretMutationJournal
import one.zephyr.mobile.data.SecretMutationOperationRebinding
import one.zephyr.mobile.data.db.AppliedOperationRow
import one.zephyr.mobile.data.db.BootstrapProgressRow
import one.zephyr.mobile.data.db.ZephyrDatabase
import one.zephyr.mobile.data.mapper.PendingOperationMapper
import one.zephyr.mobile.data.repository.ConflictRepository
import one.zephyr.mobile.data.repository.SyncStateRepository
import one.zephyr.mobile.model.MobileError
import one.zephyr.mobile.model.PendingOperation
import one.zephyr.mobile.model.SyncChange

/**
 * Room-backed [SyncLocalStore].
 *
 * Every method that changes more than one table runs inside a Room transaction, because the actor
 * treats each of them as a single durable step: SYNC_STATE_MACHINE.md 6.4 allows a round to die at
 * any point, and the recovery rule is that a half-applied step must never be observable.
 */
class RoomSyncLocalStore(
    private val db: ZephyrDatabase,
    private val syncState: SyncStateRepository,
    private val conflicts: ConflictRepository,
    private val mirror: MirrorWriter,
    private val bindingKey: String,
    private val boundUserId: String,
    private val envelopeOpener: EnvelopeOpener? = null,
    private val clock: () -> Long = System::currentTimeMillis,
    private val secretJournal: SecretMutationJournal? = null,
) : SyncLocalStore {

    override suspend fun cursors(): SyncCursors {
        val row = syncState.ensure(bindingKey)
        return SyncCursors(
            bindingState = runCatching { BindingState.valueOf(row.bindingState) }
                .getOrDefault(BindingState.UNBOUND),
            appliedCursor = row.appliedCursor,
            ackedCursor = row.ackedCursor,
            snapshotCursor = row.snapshotCursor,
            registryHash = row.registryHash,
            consecutiveFailures = row.consecutiveFailures,
            nextEligibleAt = row.nextEligibleAt,
        )
    }

    override suspend fun saveBindingState(state: BindingState) {
        syncState.ensure(bindingKey)
        syncState.updateState(bindingKey, state)
    }

    override suspend fun saveRegistryHash(hash: String) {
        val row = syncState.ensure(bindingKey)
        if (row.registryHash != hash) syncState.save(row.copy(registryHash = hash))
    }

    override suspend fun saveAppliedCursor(cursor: Long) {
        syncState.ensure(bindingKey)
        syncState.updateAppliedCursor(bindingKey, cursor)
    }

    override suspend fun saveSnapshotCursor(cursor: Long) {
        val row = syncState.ensure(bindingKey)
        syncState.save(row.copy(snapshotCursor = cursor))
    }

    override suspend fun recordAttempt(startedAt: Long) {
        val row = syncState.ensure(bindingKey)
        syncState.save(row.copy(lastAttemptAt = startedAt))
    }

    /** Success clears the failure counter and the backoff gate, not just the error text. */
    override suspend fun recordSuccess(finishedAt: Long) {
        val row = syncState.ensure(bindingKey)
        syncState.save(
            row.copy(
                lastSuccessAt = finishedAt,
                lastErrorCode = null,
                lastErrorMessage = null,
                consecutiveFailures = 0,
                nextEligibleAt = null,
            ),
        )
    }

    override suspend fun recordFailure(finishedAt: Long, error: MobileError, nextEligibleAt: Long?) {
        val row = syncState.ensure(bindingKey)
        syncState.save(
            row.copy(
                lastAttemptAt = finishedAt,
                lastErrorCode = error.code,
                // The registry message is display text; the requestId is what makes a report useful,
                // and MobileError.diagnosticText() is already redacted.
                lastErrorMessage = error.diagnosticText(),
                consecutiveFailures = row.consecutiveFailures + 1,
                nextEligibleAt = nextEligibleAt,
            ),
        )
    }

    // ---- operation queue --------------------------------------------------------------------

    override suspend fun pendingOperations(): List<PendingOperation> =
        db.pendingOperationDao().all().map(PendingOperationMapper::toModel)

    override suspend fun persistFold(kept: List<PendingOperation>, removedOpIds: List<String>) {
        if (kept.isEmpty() && removedOpIds.isEmpty()) return
        val removed = removedOpIds.distinct()
        val keptByEntity = kept.associateBy { it.entityType + "\\u0000" + it.entityId }
        val removedRows = db.pendingOperationDao().all().filter { it.opId in removed }.map(PendingOperationMapper::toModel)
        val rebindingByTarget = linkedMapOf<String, MutableList<String>>()
        val finalized = linkedSetOf<String>()
        for (source in removedRows) {
            val target = keptByEntity[source.entityType + "\\u0000" + source.entityId]?.opId
            if (target != null && target != source.opId) {
                rebindingByTarget.getOrPut(target) { mutableListOf() }.add(source.opId)
            } else {
                // A local create followed by a local delete has no wire operation left. Its secret
                // rows are now final and must leave with the pending row, never be rebound.
                finalized += source.opId
            }
        }
        // If a stale caller names an already absent row, it cannot carry a retained journal entry:
        // finalizing it remains harmless and makes the cleanup idempotent after a restart.
        finalized += removed.filterNot { source -> rebindingByTarget.values.any { source in it } }
        val rebindings = rebindingByTarget.map { (target, sources) ->
            SecretMutationOperationRebinding(sources, target)
        }
        rebindOrFinalize(rebindings, finalized.toList()) {
            // Order matters: deleting first would briefly leave the queue without the merged row,
            // and a crash in between would lose the edit entirely.
            db.pendingOperationDao().upsertAll(kept.map(PendingOperationMapper::toRow))
            if (removed.isNotEmpty()) db.pendingOperationDao().deleteByIds(removed)
        }
    }

    override suspend fun markDispatched(opIds: List<String>, at: Long, batchId: String) {
        if (opIds.isEmpty()) return
        db.pendingOperationDao().markDispatched(opIds, at, batchId)
    }

    override suspend fun markFailed(opId: String, error: String?) {
        db.pendingOperationDao().markFailed(opId, error)
    }

    override suspend fun commitAcknowledgement(cursor: Long, accepted: List<AcceptedOperation>) {
        require(accepted.map { it.opId }.distinct().size == accepted.size) {
            "an ACK commit cannot contain duplicate operation ids"
        }
        finalizeRemote(accepted.map { it.opId }) {
            val current = syncState.state(bindingKey)
                ?: throw IllegalStateException("ACK commit lost its binding state")
            require(cursor >= current.ackedCursor && cursor <= current.appliedCursor) {
                "ACK cursor is outside the current binding cursor range"
            }
            val pendingIds = db.pendingOperationDao().all().mapTo(hashSetOf()) { it.opId }
            require(accepted.all { it.opId in pendingIds }) {
                "ACK commit contains an operation from another binding generation"
            }
            completeOperationsInTransaction(accepted)
            syncState.updateAckedCursor(bindingKey, cursor)
        }
    }

    override suspend fun enterBootstrapRequiredAfterPush(
        accepted: List<AcceptedOperation>,
        retainedErrors: Map<String, String>,
    ) {
        require(retainedErrors.keys.intersect(accepted.mapTo(hashSetOf()) { it.opId }).isEmpty()) {
            "a bootstrap-signalling operation cannot also be accepted"
        }
        db.withTransaction {
            for ((opId, error) in retainedErrors) {
                db.pendingOperationDao().markFailed(opId, error)
            }
            mirror.resetBootstrap()
            db.bootstrapDao().clearProgress(bindingKey)
            syncState.ensure(bindingKey)
            syncState.updateState(bindingKey, BindingState.BOUND_NEEDS_BOOTSTRAP)
        }
    }

    private suspend fun completeOperationsInTransaction(accepted: List<AcceptedOperation>) {
        if (accepted.isEmpty()) return
        db.appliedOperationDao().upsertAll(
            accepted.map { op ->
                AppliedOperationRow(
                    opId = op.opId,
                    entityType = op.entityType,
                    entityId = op.entityId,
                    revision = op.revision,
                    appliedAt = op.appliedAt,
                )
            },
        )
        db.pendingOperationDao().deleteByIds(accepted.map { it.opId })
    }

    override suspend fun dropOperations(opIds: List<String>) {
        if (opIds.isEmpty()) return
        finalizeRemote(opIds) { db.pendingOperationDao().deleteByIds(opIds) }
    }

    override fun validateConflictPayload(entityType: String, payload: kotlinx.serialization.json.JsonObject) {
        ConflictPayloadValidator.requireSafe(entityType, payload, boundUserId)
    }

    override suspend fun recordConflictAndDrop(conflict: DetectedConflict, opId: String) {
        // Keep the durable boundary self-defending even if a future caller bypasses SyncActor's
        // batch preflight.
        validateConflictPayload(conflict.entityType, conflict.serverPayload)
        finalizeRemote(listOf(opId)) {
            conflicts.record(
                entityType = conflict.entityType,
                entityId = conflict.entityId,
                localMask = conflict.localMask,
                localPayload = conflict.localPayload,
                serverRevision = conflict.serverRevision,
                serverPayload = conflict.serverPayload,
                overlapFields = conflict.overlapFields,
                serverDeleted = conflict.serverDeleted,
                aclRevoked = conflict.aclRevoked,
                secretFields = conflict.secretFields,
            )
            db.pendingOperationDao().deleteByIds(listOf(opId))
        }
    }

    private suspend fun <T> finalizeRemote(operationIds: List<String>, block: suspend () -> T): T {
        val journal = secretJournal
        return if (journal == null) db.withTransaction { block() } else journal.finalizeRemote(operationIds, block)
    }

    private suspend fun <T> rebindOrFinalize(
        rebindings: List<SecretMutationOperationRebinding>,
        finalizedOperationIds: List<String>,
        block: suspend () -> T,
    ): T {
        val journal = secretJournal
        return if (journal == null) {
            db.withTransaction { block() }
        } else {
            journal.rebindOperations(rebindings, finalizedOperationIds, block)
        }
    }

    // ---- mirror -----------------------------------------------------------------------------

    override suspend fun applyChanges(changes: List<SyncChange>, startCursor: Long): ApplyPageResult =
        mirror.applyPage(
            changes = changes,
            boundUserId = boundUserId,
            startCursor = startCursor,
            opener = envelopeOpener,
        )

    override suspend fun stageBootstrap(generation: Long, entities: List<SyncChange>): Int =
        mirror.stageBootstrapPage(generation, entities, boundUserId, envelopeOpener)

    override suspend fun resetBootstrap() {
        db.withTransaction {
            mirror.resetBootstrap()
            db.bootstrapDao().clearProgress(bindingKey)
        }
    }

    override suspend fun bootstrapCheckpoint(): BootstrapCheckpoint? =
        db.bootstrapDao().progress(bindingKey)?.let { row ->
            BootstrapCheckpoint(
                generation = row.generation,
                bootstrapId = row.bootstrapId,
                snapshotCursor = row.snapshotCursor,
                nextPageToken = row.nextPageToken,
                pagesFetched = row.pagesFetched,
                entitiesStaged = row.entitiesStaged,
                expiresAt = row.expiresAt,
            )
        }

    override suspend fun saveBootstrapCheckpoint(checkpoint: BootstrapCheckpoint) {
        db.bootstrapDao().saveProgress(
            BootstrapProgressRow(
                bindingKey = bindingKey,
                generation = checkpoint.generation,
                bootstrapId = checkpoint.bootstrapId,
                snapshotCursor = checkpoint.snapshotCursor,
                nextPageToken = checkpoint.nextPageToken,
                pagesFetched = checkpoint.pagesFetched,
                entitiesStaged = checkpoint.entitiesStaged,
                startedAt = clock(),
                expiresAt = checkpoint.expiresAt,
            ),
        )
    }

    override suspend fun commitBootstrap(generation: Long, snapshotCursor: Long) {
        db.withTransaction {
            // MirrorWriter replaces only the server mirror/search tables. The device-local overlay
            // and pending operation queue deliberately remain outside this promotion transaction.
            mirror.promoteBootstrap(generation, boundUserId)
            syncState.ensure(bindingKey)
            syncState.updateAppliedCursor(bindingKey, snapshotCursor)
            db.bootstrapDao().clearProgress(bindingKey)
        }
    }

    override suspend fun pruneRetention(nowMs: Long) = mirror.pruneRetention(nowMs)
}
