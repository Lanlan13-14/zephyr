package one.zephyr.mobile.sync

import kotlinx.serialization.json.JsonObject
import one.zephyr.mobile.contracts.BindingState
import one.zephyr.mobile.data.ApplyPageResult
import one.zephyr.mobile.model.BootstrapPage
import one.zephyr.mobile.model.ChangePage
import one.zephyr.mobile.model.MobileError
import one.zephyr.mobile.model.PendingOperation
import one.zephyr.mobile.model.PushResponse
import one.zephyr.mobile.model.SecretEnvelope
import one.zephyr.mobile.model.ServerCapabilities
import one.zephyr.mobile.model.SyncChange
import one.zephyr.mobile.network.ApiResult

/**
 * Scriptable transport.
 *
 * Queued per endpoint rather than returning one canned value, because the interesting cases are
 * multi-page: a bootstrap that pages twice, or a pull whose second page fails.
 */
class FakeSyncTransport : SyncTransport {

    var capabilitiesResult: ApiResult<ServerCapabilities> = ApiResult.Success(
        ServerCapabilities(protocolVersions = listOf(1), registryHash = "hash-1"),
        requestId = null,
    )

    val bootstrapPages = ArrayDeque<ApiResult<BootstrapPage>>()
    val changePages = ArrayDeque<ApiResult<ChangePage>>()
    val pushResponses = ArrayDeque<ApiResult<PushResponse>>()
    var ackResult: ApiResult<Boolean> = ApiResult.Success(true, requestId = null)

    val bootstrapTokens = mutableListOf<String?>()
    val changeCursors = mutableListOf<Long>()
    val pushedBatches = mutableListOf<List<PendingOperation>>()
    val pushedEnvelopes = mutableListOf<Map<String, Map<String, SecretEnvelope>>>()
    val ackedCursors = mutableListOf<Long>()
    val ackedOpIds = mutableListOf<List<String>>()

    override suspend fun capabilities(): ApiResult<ServerCapabilities> = capabilitiesResult

    override suspend fun bootstrap(pageToken: String?, pageSize: Int?): ApiResult<BootstrapPage> {
        bootstrapTokens.add(pageToken)
        return bootstrapPages.removeFirstOrNull()
            ?: ApiResult.Failure(MobileError.local("internal_error", "no bootstrap page scripted"))
    }

    override suspend fun changes(sinceCursor: Long, limit: Int?): ApiResult<ChangePage> {
        changeCursors.add(sinceCursor)
        return changePages.removeFirstOrNull()
            ?: ApiResult.Success(
                ChangePage(fromCursor = sinceCursor, nextCursor = sinceCursor, hasMore = false, changes = emptyList()),
                requestId = null,
            )
    }

    override suspend fun push(
        batchId: String,
        baseCursor: Long,
        registryHash: String,
        operations: List<PendingOperation>,
        envelopes: Map<String, Map<String, SecretEnvelope>>,
    ): ApiResult<PushResponse> {
        pushedBatches.add(operations)
        pushedEnvelopes.add(envelopes)
        return pushResponses.removeFirstOrNull()
            ?: ApiResult.Success(
                PushResponse(batchId = batchId, serverCursor = baseCursor, results = emptyList(), changesAvailable = false),
                requestId = null,
            )
    }

    override suspend fun ack(cursor: Long, appliedOpIds: List<String>): ApiResult<Boolean> {
        ackedCursors.add(cursor)
        ackedOpIds.add(appliedOpIds)
        return ackResult
    }
}

/**
 * In-memory store.
 *
 * Mirrors the ordering guarantees the Room implementation gives the actor - cursors move
 * monotonically, the queue is a list in insertion order - without needing an emulator, so the phase
 * order and cursor arithmetic can be asserted directly.
 */
class FakeSyncLocalStore(
    initialState: BindingState = BindingState.IDLE,
) : SyncLocalStore {

    var state: BindingState = initialState
    var appliedCursor: Long = 0
    var ackedCursor: Long = 0
    var snapshotCursor: Long = 0
    var registryHash: String? = "hash-1"
    var consecutiveFailures: Int = 0
    var nextEligibleAt: Long? = null

    val queue = mutableListOf<PendingOperation>()
    val conflicts = mutableListOf<DetectedConflict>()
    val completed = mutableListOf<AcceptedOperation>()
    val droppedOpIds = mutableListOf<String>()
    val failures = mutableListOf<Pair<String, String?>>()
    val dispatched = mutableListOf<List<String>>()
    val stagedGenerations = mutableListOf<Long>()
    val promotedGenerations = mutableListOf<Long>()
    val bindingStates = mutableListOf<BindingState>()
    val snapshotCursorWrites = mutableListOf<Long>()
    var checkpoint: BootstrapCheckpoint? = null
    var stagingCleared = 0
    var successes = 0
    var recordedFailures = mutableListOf<MobileError>()
    var pruned = 0
    var appliedPages = mutableListOf<List<SyncChange>>()
    /** Set to make applyChanges report envelope rejections. */
    var envelopeFailuresPerPage: List<String> = emptyList()

    override suspend fun cursors(): SyncCursors = SyncCursors(
        bindingState = state,
        appliedCursor = appliedCursor,
        ackedCursor = ackedCursor,
        snapshotCursor = snapshotCursor,
        registryHash = registryHash,
        consecutiveFailures = consecutiveFailures,
        nextEligibleAt = nextEligibleAt,
    )

    override suspend fun saveBindingState(state: BindingState) {
        this.state = state
        bindingStates.add(state)
    }

    override suspend fun saveRegistryHash(hash: String) { registryHash = hash }

    override suspend fun saveAppliedCursor(cursor: Long) { appliedCursor = cursor }

    override suspend fun saveAckedCursor(cursor: Long) { ackedCursor = cursor }

    override suspend fun saveSnapshotCursor(cursor: Long) {
        snapshotCursor = cursor
        snapshotCursorWrites.add(cursor)
    }

    override suspend fun recordAttempt(startedAt: Long) = Unit

    override suspend fun recordSuccess(finishedAt: Long) {
        successes += 1
        consecutiveFailures = 0
    }

    override suspend fun recordFailure(finishedAt: Long, error: MobileError, nextEligibleAt: Long?) {
        recordedFailures.add(error)
        consecutiveFailures += 1
        this.nextEligibleAt = nextEligibleAt
    }

    /** Invoked at the start of PUSH_PENDING so a test can re-enter the actor mid-round. */
    var beforePending: suspend () -> Unit = {}

    override suspend fun pendingOperations(): List<PendingOperation> {
        beforePending()
        return queue.toList()
    }

    override suspend fun persistFold(kept: List<PendingOperation>, removedOpIds: List<String>) {
        queue.removeAll { op -> removedOpIds.contains(op.opId) }
        for (op in kept) {
            val index = queue.indexOfFirst { it.opId == op.opId }
            if (index >= 0) queue[index] = op else queue.add(op)
        }
    }

    override suspend fun markDispatched(opIds: List<String>, at: Long, batchId: String) {
        dispatched.add(opIds)
        for (index in queue.indices) {
            if (opIds.contains(queue[index].opId)) {
                queue[index] = queue[index].copy(dispatchedAt = at, batchId = batchId)
            }
        }
    }

    override suspend fun markFailed(opId: String, error: String?) {
        failures.add(opId to error)
        val index = queue.indexOfFirst { it.opId == opId }
        if (index >= 0) {
            queue[index] = queue[index].copy(
                attemptCount = queue[index].attemptCount + 1,
                lastError = error,
                dispatchedAt = null,
            )
        }
    }

    override suspend fun completeOperations(accepted: List<AcceptedOperation>) {
        completed.addAll(accepted)
        queue.removeAll { op -> accepted.any { it.opId == op.opId } }
    }

    override suspend fun dropOperations(opIds: List<String>) {
        droppedOpIds.addAll(opIds)
        queue.removeAll { opIds.contains(it.opId) }
    }

    override suspend fun recordConflict(conflict: DetectedConflict) { conflicts.add(conflict) }

    override suspend fun applyChanges(changes: List<SyncChange>, startCursor: Long): ApplyPageResult {
        appliedPages.add(changes)
        val cursor = changes.maxOfOrNull { it.changeSeq } ?: startCursor
        return ApplyPageResult(
            applied = changes.count { !it.isDelete },
            skipped = 0,
            deleted = changes.count { it.isDelete },
            appliedCursor = maxOf(startCursor, cursor),
            envelopeFailures = envelopeFailuresPerPage,
        )
    }

    override suspend fun stageBootstrap(generation: Long, entities: List<SyncChange>): Int {
        stagedGenerations.add(generation)
        return entities.size
    }

    override suspend fun promoteBootstrap(generation: Long) { promotedGenerations.add(generation) }

    override suspend fun clearBootstrapStaging() { stagingCleared += 1 }

    override suspend fun bootstrapCheckpoint(): BootstrapCheckpoint? = checkpoint

    override suspend fun saveBootstrapCheckpoint(checkpoint: BootstrapCheckpoint) { this.checkpoint = checkpoint }

    override suspend fun clearBootstrapCheckpoint() { checkpoint = null }

    override suspend fun pruneRetention(nowMs: Long) { pruned += 1 }
}

/** Seals nothing, like a device whose server has published no encryption key. */
object NoSealer : SecretSealer {
    override fun canSeal(): Boolean = false
    override suspend fun seal(
        entityType: String,
        entityId: String,
        fieldName: String,
        entityRevision: Long,
    ): SecretEnvelope? = null
}

/** Always seals, so the envelope plumbing can be asserted without real crypto. */
class StubSealer : SecretSealer {
    val sealedFields = mutableListOf<String>()
    override fun canSeal(): Boolean = true
    override suspend fun seal(
        entityType: String,
        entityId: String,
        fieldName: String,
        entityRevision: Long,
    ): SecretEnvelope {
        sealedFields.add(entityType + "/" + entityId + "/" + fieldName)
        return SecretEnvelope(
            v = 1,
            alg = "ML-KEM-768+HKDF-SHA256+AES-256-GCM",
            kem = "ML-KEM-768",
            aead = "AES-256-GCM",
            ct = "Y3Q=",
            iv = "aXY=",
            tag = "dGFn",
            data = "ZGF0YQ==",
            aad = "YWFk",
            keyVersion = 1,
            entityRevision = entityRevision,
        )
    }
}

object NoBlobs : BlobTransferPort {
    override suspend fun drain(): BlobDrainResult = BlobDrainResult(completed = 0, pending = 0)
}

/** Convenience builder so tests read as intent rather than constructor noise. */
fun pendingOp(
    opId: String,
    entityType: String = "connection",
    entityId: String = "c-1",
    action: one.zephyr.mobile.contracts.SyncAction = one.zephyr.mobile.contracts.SyncAction.UPSERT,
    baseRevision: Long = 1,
    fieldMask: List<String> = listOf("name"),
    payload: JsonObject = JsonObject(emptyMap()),
    createdAt: Long = 1,
    createdLocally: Boolean = false,
    secretFields: List<String> = emptyList(),
    dispatchedAt: Long? = null,
): PendingOperation = PendingOperation(
    opId = opId,
    entityType = entityType,
    entityId = entityId,
    action = action,
    baseRevision = baseRevision,
    fieldMask = fieldMask,
    payload = payload,
    createdAt = createdAt,
    createdLocally = createdLocally,
    secretFields = secretFields,
    dispatchedAt = dispatchedAt,
)
