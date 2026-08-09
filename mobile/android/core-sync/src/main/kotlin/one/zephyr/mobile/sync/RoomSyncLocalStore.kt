package one.zephyr.mobile.sync

import androidx.room.withTransaction
import one.zephyr.mobile.contracts.BindingState
import one.zephyr.mobile.data.ApplyPageResult
import one.zephyr.mobile.data.EnvelopeOpener
import one.zephyr.mobile.data.MirrorWriter
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

    override suspend fun saveAckedCursor(cursor: Long) {
        syncState.ensure(bindingKey)
        syncState.updateAckedCursor(bindingKey, cursor)
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
        db.withTransaction {
            // Order matters: deleting first would briefly leave the queue without the merged row,
            // and a crash in between would lose the edit entirely.
            db.pendingOperationDao().upsertAll(kept.map(PendingOperationMapper::toRow))
            if (removedOpIds.isNotEmpty()) db.pendingOperationDao().deleteByIds(removedOpIds)
        }
    }

    override suspend fun markDispatched(opIds: List<String>, at: Long, batchId: String) {
        if (opIds.isEmpty()) return
        db.pendingOperationDao().markDispatched(opIds, at, batchId)
    }

    override suspend fun markFailed(opId: String, error: String?) {
        db.pendingOperationDao().markFailed(opId, error)
    }

    /**
     * An accepted operation leaves the queue and joins the applied-id log in one transaction, so a
     * replay after a crash is recognised as a duplicate instead of being applied twice.
     */
    override suspend fun completeOperations(accepted: List<AcceptedOperation>) {
        if (accepted.isEmpty()) return
        db.withTransaction {
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
    }

    override suspend fun dropOperations(opIds: List<String>) {
        if (opIds.isEmpty()) return
        db.pendingOperationDao().deleteByIds(opIds)
    }

    override suspend fun recordConflict(conflict: DetectedConflict) {
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
        mirror.stageBootstrapPage(generation, entities, boundUserId)

    override suspend fun promoteBootstrap(generation: Long) = mirror.promoteBootstrap(generation)

    override suspend fun clearBootstrapStaging() {
        db.bootstrapDao().clearAll()
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

    override suspend fun clearBootstrapCheckpoint() {
        db.bootstrapDao().clearProgress(bindingKey)
    }

    override suspend fun pruneRetention(nowMs: Long) = mirror.pruneRetention(nowMs)
}
