package one.zephyr.mobile.sync

import one.zephyr.mobile.contracts.BindingState
import one.zephyr.mobile.contracts.SyncPhase
import one.zephyr.mobile.data.ApplyPageResult
import one.zephyr.mobile.model.BootstrapPage
import one.zephyr.mobile.model.ChangePage
import one.zephyr.mobile.model.MobileError
import one.zephyr.mobile.model.PendingOperation
import one.zephyr.mobile.model.PushResponse
import one.zephyr.mobile.model.SecretEnvelope
import one.zephyr.mobile.model.ServerCapabilities
import one.zephyr.mobile.model.SyncTrigger
import one.zephyr.mobile.network.ApiResult

/**
 * Everything the sync round needs from the network.
 *
 * The actor talks to this port rather than to MobileApi directly for one reason that matters more
 * than testability: the round is the only place in One where an error code decides a *persisted*
 * state transition, so it has to be exercised against every branch of the error registry. A port
 * makes that possible in a plain JVM test, with no emulator and no HTTP.
 */
interface SyncTransport {

    suspend fun capabilities(): ApiResult<ServerCapabilities>

    suspend fun bootstrap(pageToken: String?, pageSize: Int?): ApiResult<BootstrapPage>

    suspend fun changes(sinceCursor: Long, limit: Int?): ApiResult<ChangePage>

    suspend fun push(
        batchId: String,
        baseCursor: Long,
        registryHash: String,
        operations: List<PendingOperation>,
        envelopes: Map<String, Map<String, SecretEnvelope>>,
    ): ApiResult<PushResponse>

    suspend fun ack(cursor: Long, appliedOpIds: List<String>): ApiResult<Boolean>
}

/**
 * Cursor and failure bookkeeping for one binding.
 *
 * appliedCursor and ackedCursor are separate because they fail independently: a page may be
 * committed locally and the ack round trip may then fail, and SYNC_STATE_MACHINE.md 6.4 requires the
 * local commit to win in that race rather than the change being skipped.
 */
data class SyncCursors(
    val bindingState: BindingState,
    val appliedCursor: Long,
    val ackedCursor: Long,
    val snapshotCursor: Long,
    val registryHash: String?,
    val consecutiveFailures: Int,
    val nextEligibleAt: Long?,
)

/** A bootstrap that was interrupted and can be resumed instead of restarted. */
data class BootstrapCheckpoint(
    val generation: Long,
    val bootstrapId: String,
    val snapshotCursor: Long,
    val nextPageToken: String?,
    val pagesFetched: Int,
    val entitiesStaged: Int,
    val expiresAt: Long,
) {
    fun isExpired(nowMs: Long): Boolean = nowMs >= expiresAt
}

/**
 * Everything the sync round needs from local storage.
 *
 * Deliberately narrow: the actor may move cursors, drain the operation queue and hand pages to the
 * mirror, but it has no way to reach the SecretStore or write an entity field directly. That keeps
 * the residency rule in MirrorWriter as the single enforcement point.
 */
interface SyncLocalStore {

    suspend fun cursors(): SyncCursors

    suspend fun saveBindingState(state: BindingState)

    suspend fun saveRegistryHash(hash: String)

    suspend fun saveAppliedCursor(cursor: Long)

    suspend fun saveAckedCursor(cursor: Long)

    suspend fun saveSnapshotCursor(cursor: Long)

    suspend fun recordAttempt(startedAt: Long)

    suspend fun recordSuccess(finishedAt: Long)

    suspend fun recordFailure(finishedAt: Long, error: MobileError, nextEligibleAt: Long?)

    // ---- operation queue ----------------------------------------------------------------------

    suspend fun pendingOperations(): List<PendingOperation>

    /**
     * Persist the result of folding in one transaction.
     *
     * Folding has to be durable before dispatch: an in-memory-only fold that is interrupted after
     * the network call would leave the superseded rows queued and push the same edit twice.
     */
    suspend fun persistFold(kept: List<PendingOperation>, removedOpIds: List<String>)

    suspend fun markDispatched(opIds: List<String>, at: Long, batchId: String)

    suspend fun markFailed(opId: String, error: String?)

    suspend fun completeOperations(accepted: List<AcceptedOperation>)

    suspend fun dropOperations(opIds: List<String>)

    suspend fun recordConflict(conflict: DetectedConflict)

    // ---- mirror -------------------------------------------------------------------------------

    suspend fun applyChanges(changes: List<one.zephyr.mobile.model.SyncChange>, startCursor: Long): ApplyPageResult

    suspend fun stageBootstrap(generation: Long, entities: List<one.zephyr.mobile.model.SyncChange>): Int

    suspend fun promoteBootstrap(generation: Long)

    suspend fun clearBootstrapStaging()

    suspend fun bootstrapCheckpoint(): BootstrapCheckpoint?

    suspend fun saveBootstrapCheckpoint(checkpoint: BootstrapCheckpoint)

    suspend fun clearBootstrapCheckpoint()

    suspend fun pruneRetention(nowMs: Long)
}

/** An operation the server accepted, so the local queue entry can go. */
data class AcceptedOperation(
    val opId: String,
    val entityType: String,
    val entityId: String,
    val revision: Long,
    val appliedAt: Long,
)

/** A stable conflict the push surfaced. */
data class DetectedConflict(
    val entityType: String,
    val entityId: String,
    val localMask: List<String>,
    val localPayload: kotlinx.serialization.json.JsonObject,
    val serverRevision: Long,
    val serverPayload: kotlinx.serialization.json.JsonObject,
    val overlapFields: List<String>,
    val serverDeleted: Boolean,
    val aclRevoked: Boolean,
    val secretFields: List<String>,
)

/**
 * Seals a locally changed secret for the server.
 *
 * Split out as a port because the frozen mobile v1 contract does not currently publish a server
 * encryption public key: /capabilities and BindResponse carry only the *device* key. Until the main
 * end exposes one, [DeviceSecretSealer] reports the field as unsealable and the round defers the
 * operation instead of downgrading it to plaintext. See the class comment there.
 */
interface SecretSealer {

    /** False when no server key is available, so the round can defer instead of failing hard. */
    fun canSeal(): Boolean

    /**
     * @return the envelope, or null when this field cannot be sealed right now.
     */
    suspend fun seal(
        entityType: String,
        entityId: String,
        fieldName: String,
        entityRevision: Long,
    ): SecretEnvelope?
}

/** Result of draining the blob transfer queue. */
data class BlobDrainResult(
    val completed: Int,
    val pending: Int,
    /** True when transfers exist but no transport is wired, so the phase reports rather than lies. */
    val blocked: Boolean = false,
)

/**
 * Moves chunked blob bodies.
 *
 * Kept as a port because the frozen OpenAPI has no blob endpoint: DEVELOPMENT.md 673 specifies a
 * content-addressed manifest with chunked upload/download, but the route set is not frozen yet, so
 * One ships the queue, the resume arithmetic ([BlobChunker]) and this seam without inventing a wire
 * format.
 */
interface BlobTransferPort {
    suspend fun drain(): BlobDrainResult

    companion object {
        /** Reports blocked only when work actually exists, so a clean device stays quiet. */
        fun unavailable(pendingCount: suspend () -> Int): BlobTransferPort = object : BlobTransferPort {
            override suspend fun drain(): BlobDrainResult {
                val pending = pendingCount()
                return BlobDrainResult(completed = 0, pending = pending, blocked = pending > 0)
            }
        }
    }
}

/** Outcome of one sync round. */
data class SyncRoundResult(
    val trigger: SyncTrigger,
    val startedAt: Long,
    val finishedAt: Long,
    val phasesRun: List<SyncPhase>,
    val endState: BindingState,
    val pushed: Int,
    val conflicts: Int,
    val deferred: List<DeferredOperation>,
    val applied: Int,
    val skipped: Int,
    val appliedCursor: Long,
    val ackedCursor: Long,
    val error: MobileError? = null,
    /** Set when the round stopped early; the phase it stopped in. */
    val stoppedAt: SyncPhase? = null,
    val blobsBlocked: Boolean = false,
) {
    val succeeded: Boolean get() = error == null
}
