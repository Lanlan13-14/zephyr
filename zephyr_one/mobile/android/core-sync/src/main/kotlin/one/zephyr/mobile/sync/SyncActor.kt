package one.zephyr.mobile.sync

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import one.zephyr.mobile.contracts.BindingState
import one.zephyr.mobile.contracts.ErrorRegistry
import one.zephyr.mobile.contracts.PushStatus
import one.zephyr.mobile.contracts.SyncContract
import one.zephyr.mobile.contracts.SyncPhase
import one.zephyr.mobile.model.MobileError
import one.zephyr.mobile.model.PendingOperation
import one.zephyr.mobile.model.PushResponse
import one.zephyr.mobile.model.SecretEnvelope
import one.zephyr.mobile.model.SyncProgress
import one.zephyr.mobile.model.SyncTrigger
import one.zephyr.mobile.model.sync.BindingStateMachine
import one.zephyr.mobile.model.sync.PushPrediction
import one.zephyr.mobile.model.sync.SyncEvent
import one.zephyr.mobile.network.ApiResult

/**
 * Runs sync rounds for exactly one binding.
 *
 * One actor per binding is what makes the phase order in SYNC_STATE_MACHINE.md 2 meaningful: the
 * phases mutate shared cursors, so two concurrent rounds could ack a cursor whose page the other
 * round has not committed. Concurrency is therefore collapsed rather than parallelised, and
 * [request] coalesces overlapping triggers into "the round in flight plus at most one trailing
 * round" (SYNC_STATE_MACHINE.md 9.2). The trailing round exists so a write that lands while a round
 * is already past PUSH_PENDING is not stranded until the next interval.
 */
class SyncActor(
    private val transport: SyncTransport,
    private val store: SyncLocalStore,
    private val sealer: SecretSealer,
    private val blobs: BlobTransferPort,
    private val clock: () -> Long = System::currentTimeMillis,
    private val batchIdFactory: () -> String = { "batch-" + java.util.UUID.randomUUID() },
    private val jitter: () -> Double = { 0.5 + Math.random() },
    private val bootstrapPageSize: Int? = null,
    private val changeLimit: Int? = null,
    /** Invoked when the server reports a residency violation; must drop shared state from memory. */
    private val onSharedPurge: suspend () -> Unit = {},
) {

    private val progressState = MutableStateFlow(SyncProgress.idle)

    /** Live phase progress for the 文件同步 card. */
    val progress: StateFlow<SyncProgress> = progressState.asStateFlow()

    private val flagLock = Mutex()
    private var running = false
    private var rerunRequested = false
    private var rerunTrigger: SyncTrigger? = null

    /**
     * True when a trigger arrived that this invocation could not absorb.
     *
     * The scheduler reads it to enqueue one more run, which is how the two-round cap stays a cap
     * rather than a dropped write.
     */
    suspend fun rerunPending(): Boolean = flagLock.withLock { rerunRequested }

    /**
     * Run sync, coalescing with any round already in flight.
     *
     * @return the rounds this call actually executed; empty when the trigger was absorbed by a
     *   round that was already running.
     */
    suspend fun request(trigger: SyncTrigger): List<SyncRoundResult> {
        val claimed = flagLock.withLock {
            if (running) {
                rerunRequested = true
                // Keep the earliest waiting trigger: it is the one the user is waiting on, and a
                // later interval tick must not relabel a manual 立即同步.
                if (rerunTrigger == null) rerunTrigger = trigger
                false
            } else {
                running = true
                // The round about to start subsumes anything queued before it.
                rerunRequested = false
                rerunTrigger = null
                true
            }
        }
        if (!claimed) return emptyList()

        val results = mutableListOf<SyncRoundResult>()
        try {
            var next: SyncTrigger? = trigger
            while (next != null) {
                results.add(runRound(next))
                next = flagLock.withLock {
                    when {
                        !rerunRequested -> null
                        // Second round already run: leave the flag set so the scheduler picks it up
                        // instead of letting one invocation spin indefinitely.
                        results.size >= MAX_ROUNDS_PER_INVOCATION -> null
                        else -> {
                            rerunRequested = false
                            val queued = rerunTrigger ?: SyncTrigger.LOCAL_WRITE_DEBOUNCE
                            rerunTrigger = null
                            queued
                        }
                    }
                }
            }
        } finally {
            flagLock.withLock { running = false }
            progressState.value = SyncProgress.idle
        }
        return results
    }

    // ---- one round -------------------------------------------------------------------------------

    private suspend fun runRound(trigger: SyncTrigger): SyncRoundResult {
        val startedAt = clock()
        store.recordAttempt(startedAt)

        val opening = store.cursors()
        var state = opening.bindingState
        val acc = RoundAccumulator()

        val checkpoint = store.bootstrapCheckpoint()
        val phases = planPhases(state, checkpoint, startedAt)

        var failure: MobileError? = null
        var stoppedAt: SyncPhase? = null

        for (phase in phases) {
            if (!shouldRun(phase, state)) continue
            acc.phasesRun.add(phase)
            publish(phase, acc)

            val error: MobileError? = when (phase) {
                SyncPhase.VALIDATE_BINDING -> validateBinding()

                SyncPhase.RECOVER_BOOTSTRAP -> {
                    state = BindingStateMachine.next(state, SyncEvent.RUN)
                    runBootstrap(acc, checkpoint)
                }

                SyncPhase.BOOTSTRAP_PAGE -> {
                    state = BindingStateMachine.next(state, SyncEvent.RUN)
                    runBootstrap(acc, resume = null)
                }

                SyncPhase.CATCH_UP_PULL -> pullLoop(acc)

                SyncPhase.PUSH_PENDING -> {
                    // A round is only RUNNING once it can actually write: entering RUNNING before
                    // the snapshot exists would let the status card claim progress it cannot make.
                    if (state == BindingState.IDLE || state == BindingState.CONFLICTED) {
                        state = BindingStateMachine.next(state, SyncEvent.TRIGGER)
                    }
                    pushPending(acc)
                }

                SyncPhase.PULL_CHANGES -> pullLoop(acc)
                SyncPhase.APPLY_BLOBS -> applyBlobs(acc)
                SyncPhase.ACK_CURSOR -> ackCursor(acc)
                SyncPhase.COMMIT_SUCCESS -> null
            }

            if (error != null) {
                SyncErrorMapping.eventFor(error.code)?.let { event ->
                    state = BindingStateMachine.next(state, event)
                }
                if (SyncErrorMapping.requiresSharedPurge(error.code)) onSharedPurge()
                if (SyncErrorMapping.abortsRound(error)) {
                    failure = error
                    stoppedAt = phase
                    break
                }
                continue
            }

            state = when (phase) {
                SyncPhase.RECOVER_BOOTSTRAP, SyncPhase.BOOTSTRAP_PAGE ->
                    BindingStateMachine.next(state, SyncEvent.SNAPSHOT_COMPLETE)

                SyncPhase.CATCH_UP_PULL -> BindingStateMachine.next(state, SyncEvent.SUCCESS)

                // A round that produced a stable conflict has still succeeded mechanically; the
                // binding parks in CONFLICTED so the user is asked instead of the edit being retried.
                SyncPhase.COMMIT_SUCCESS -> BindingStateMachine.next(
                    state,
                    if (acc.conflicts > 0) SyncEvent.CONFLICT_ONLY else SyncEvent.SUCCESS,
                )

                else -> state
            }
        }

        val finishedAt = clock()
        if (failure == null) {
            store.recordSuccess(finishedAt)
            store.pruneRetention(finishedAt)
        } else {
            val retryable = SyncErrorMapping.isRetryable(failure)
            val delay = SyncErrorMapping.retryDelayMs(failure, opening.consecutiveFailures, jitter())
            store.recordFailure(finishedAt, failure, if (retryable) finishedAt + delay else null)
        }
        store.saveBindingState(state)

        val closing = store.cursors()
        return SyncRoundResult(
            trigger = trigger,
            startedAt = startedAt,
            finishedAt = finishedAt,
            phasesRun = acc.phasesRun.toList(),
            endState = state,
            pushed = acc.pushed,
            conflicts = acc.conflicts,
            deferred = acc.deferred.toList(),
            applied = acc.applied,
            skipped = acc.skipped,
            appliedCursor = closing.appliedCursor,
            ackedCursor = closing.ackedCursor,
            error = failure,
            stoppedAt = stoppedAt,
            blobsBlocked = acc.blobsBlocked,
        )
    }

    /**
     * A never-bootstrapped binding runs the snapshot phases; everything else runs the short round.
     * RECOVER_BOOTSTRAP replaces BOOTSTRAP_PAGE only when a live checkpoint exists, so an
     * interrupted snapshot resumes from its page token instead of re-downloading the account.
     */
    private fun planPhases(
        state: BindingState,
        checkpoint: BootstrapCheckpoint?,
        nowMs: Long,
    ): List<SyncPhase> {
        val base = BindingStateMachine.phasesFor(state)
        if (!base.contains(SyncPhase.BOOTSTRAP_PAGE)) return base
        if (checkpoint == null || checkpoint.isExpired(nowMs)) return base
        return base.map { phase ->
            if (phase == SyncPhase.BOOTSTRAP_PAGE) SyncPhase.RECOVER_BOOTSTRAP else phase
        }
    }

    /**
     * cursor_expired can land the binding back on BOUND_NEEDS_BOOTSTRAP in the middle of a round.
     * SYNC_STATE_MACHINE.md 3 requires pushing to stop until a fresh snapshot exists, so the
     * write-side phases are dropped rather than run against a cursor the server has forgotten.
     */
    private fun shouldRun(phase: SyncPhase, state: BindingState): Boolean = when (phase) {
        SyncPhase.PUSH_PENDING, SyncPhase.PULL_CHANGES, SyncPhase.ACK_CURSOR ->
            state != BindingState.BOUND_NEEDS_BOOTSTRAP
        else -> true
    }

    // ---- phases ----------------------------------------------------------------------------------

    private suspend fun validateBinding(): MobileError? {
        val caps = when (val result = transport.capabilities()) {
            is ApiResult.Failure -> return result.error
            is ApiResult.Success -> result.value
        }
        if (!caps.supports(SyncContract.PROTOCOL_VERSION)) {
            return MobileError.local(
                "unsupported_protocol_version",
                "server does not speak mobile protocol v" + SyncContract.PROTOCOL_VERSION,
            )
        }
        // Recorded, not compared. The client cannot tell an additive registry change from a breaking
        // one, and the server rejects a stale hash on push with registry_mismatch; failing here on
        // any difference would strand One on a harmless server-side addition.
        store.saveRegistryHash(caps.registryHash)
        return null
    }

    /**
     * Snapshot download.
     *
     * The snapshot cursor is persisted before the first page is staged: it is the join between the
     * snapshot and the change feed, and a crash that loses it makes every staged row unusable
     * (DATA_AND_MIGRATION.md 7.2). Pages stage into a generation and only become visible at
     * [SyncLocalStore.promoteBootstrap], so an interrupted bootstrap leaves the old mirror intact.
     */
    private suspend fun runBootstrap(acc: RoundAccumulator, resume: BootstrapCheckpoint?): MobileError? {
        val generation = resume?.generation ?: clock()
        var pageToken = resume?.nextPageToken
        var pages = resume?.pagesFetched ?: 0
        var staged = resume?.entitiesStaged ?: 0
        var snapshotCursor = resume?.snapshotCursor ?: 0L
        var bootstrapId = resume?.bootstrapId ?: ""

        if (resume == null) store.clearBootstrapStaging()

        while (true) {
            val page = when (val result = transport.bootstrap(pageToken, bootstrapPageSize)) {
                is ApiResult.Failure -> return result.error
                is ApiResult.Success -> result.value
            }

            if (pages == 0) {
                snapshotCursor = page.snapshotCursor
                bootstrapId = page.bootstrapId
                store.saveSnapshotCursor(snapshotCursor)
            }

            staged += store.stageBootstrap(generation, page.entities)
            pages += 1
            pageToken = page.nextPageToken

            store.saveBootstrapCheckpoint(
                BootstrapCheckpoint(
                    generation = generation,
                    bootstrapId = bootstrapId,
                    snapshotCursor = snapshotCursor,
                    nextPageToken = pageToken,
                    pagesFetched = pages,
                    entitiesStaged = staged,
                    expiresAt = clock() + PAGE_TOKEN_TTL_MS,
                ),
            )
            acc.entitiesStaged = staged
            publish(SyncPhase.BOOTSTRAP_PAGE, acc)

            if (page.complete || pageToken == null) break
            if (pages >= MAX_PAGES_PER_ROUND) break
        }

        store.promoteBootstrap(generation)
        // The mirror now matches the snapshot, so the change feed resumes from its cursor. ackedCursor
        // stays behind until ACK_CURSOR succeeds.
        store.saveAppliedCursor(snapshotCursor)
        store.clearBootstrapCheckpoint()
        acc.applied += staged
        return null
    }

    /**
     * Change-feed drain, shared by CATCH_UP_PULL and PULL_CHANGES.
     *
     * The two phases differ only in when they run: catch-up closes the gap a snapshot opened, and
     * the normal pull picks up everything since the last round. The page arithmetic is identical, so
     * duplicating it would just create two places for an off-by-one cursor bug to live.
     */
    private suspend fun pullLoop(acc: RoundAccumulator): MobileError? {
        var pages = 0
        while (pages < MAX_PAGES_PER_ROUND) {
            pages += 1
            val cursors = store.cursors()
            val page = when (val result = transport.changes(cursors.appliedCursor, changeLimit)) {
                is ApiResult.Failure -> return result.error
                is ApiResult.Success -> result.value
            }

            if (page.changes.isEmpty()) {
                // An empty page still carries a cursor; honouring it lets the server prune its
                // change log even when nothing changed for this device.
                if (page.nextCursor > cursors.appliedCursor) store.saveAppliedCursor(page.nextCursor)
                return null
            }

            val applied = store.applyChanges(page.changes, cursors.appliedCursor)
            acc.applied += applied.applied
            acc.skipped += applied.skipped
            acc.envelopeFailures += applied.envelopeFailures.size
            store.saveAppliedCursor(maxOf(applied.appliedCursor, page.nextCursor))
            publish(SyncPhase.PULL_CHANGES, acc)

            if (!page.hasMore) return null
        }
        return null
    }

    private suspend fun pushPending(acc: RoundAccumulator): MobileError? {
        val queued = store.pendingOperations()
        if (queued.isEmpty()) return null

        val plan = PushPlanner.plan(queued, sealer.canSeal())
        // The fold is persisted before dispatch: an in-memory-only fold interrupted after the network
        // call would leave the superseded rows queued and push the same edit a second time.
        store.persistFold(plan.foldedKept, plan.foldedRemoved)
        acc.deferred.addAll(plan.deferred)
        for (deferral in plan.deferred) {
            if (deferral.reason == DeferralReason.SECRET_UNSEALABLE) {
                // Surfaced as a queued operation with an error rather than dropped, so the user can
                // see that the secret has not reached the server.
                store.markFailed(deferral.opId, "secret_upstream_unavailable")
            }
        }
        if (plan.isEmpty) return null

        val cursors = store.cursors()
        val registryHash = cursors.registryHash ?: ""

        for (batch in plan.batches) {
            val batchId = batchIdFactory()
            val envelopes = sealEnvelopes(batch)

            // Marked before the call, never after: an operation whose outcome is unknown must replay
            // under the same opId so the server deduplicates instead of applying it twice.
            store.markDispatched(batch.map { it.opId }, clock(), batchId)

            val response = when (
                val result = transport.push(
                    batchId = batchId,
                    baseCursor = cursors.appliedCursor,
                    registryHash = registryHash,
                    operations = batch,
                    envelopes = envelopes,
                )
            ) {
                is ApiResult.Failure -> {
                    for (op in batch) store.markFailed(op.opId, result.error.code)
                    return result.error
                }
                is ApiResult.Success -> result.value
            }

            applyPushResults(batch, response, acc)
            publish(SyncPhase.PUSH_PENDING, acc)
        }
        return null
    }

    private suspend fun applyPushResults(
        batch: List<PendingOperation>,
        response: PushResponse,
        acc: RoundAccumulator,
    ) {
        val byId = batch.associateBy { it.opId }
        val accepted = mutableListOf<AcceptedOperation>()
        val dropped = mutableListOf<String>()
        val now = clock()

        for (result in response.results) {
            val op = byId[result.opId] ?: continue
            when (result.status) {
                // DUPLICATE is a success: it means a replay found the original already applied,
                // which is exactly what reusing the opId is for.
                PushStatus.ACCEPTED, PushStatus.DUPLICATE -> {
                    accepted.add(
                        AcceptedOperation(
                            opId = op.opId,
                            entityType = op.entityType,
                            entityId = result.entityId ?: op.entityId,
                            revision = result.revision ?: op.baseRevision,
                            appliedAt = now,
                        ),
                    )
                    acc.pushed += 1
                    acc.appliedOpIds.add(op.opId)
                }

                PushStatus.CONFLICT -> {
                    val serverRevision = result.revision ?: op.baseRevision
                    val classification = PushPrediction.classify(
                        localMask = op.fieldMask,
                        serverChangedFields = result.serverChangedFields,
                        baseRevision = op.baseRevision,
                        currentRevision = serverRevision,
                    )
                    val overlap = classification.fields.ifEmpty {
                        op.fieldMask.filter { result.serverChangedFields.contains(it) }
                    }
                    val code = result.error?.code
                    store.recordConflict(
                        DetectedConflict(
                            entityType = op.entityType,
                            entityId = op.entityId,
                            localMask = op.fieldMask,
                            localPayload = op.payload,
                            serverRevision = serverRevision,
                            serverPayload = result.serverPayload ?: kotlinx.serialization.json.JsonObject(emptyMap()),
                            overlapFields = overlap,
                            serverDeleted = code == "resource_not_found_or_inaccessible",
                            // An ACL revocation is authoritative, so the conflict row records it and
                            // ConflictRepository then refuses keep_local.
                            aclRevoked = code != null && code.startsWith("forbidden_"),
                            secretFields = op.secretFields,
                        ),
                    )
                    // The conflict row owns the local payload and mask from here, so leaving the
                    // operation queued would push the losing edit again on the next round.
                    dropped.add(op.opId)
                    acc.conflicts += 1
                }

                PushStatus.REJECTED -> {
                    val code = result.error?.code ?: "invalid_request"
                    val action = ErrorRegistry.clientAction(code)
                    if (action == "drop_operation_and_report" || action == "upgrade_or_drop_operation") {
                        dropped.add(op.opId)
                    } else {
                        // Kept deliberately: a dropped row is a silently lost user edit, whereas a
                        // queued row with lastError is visible on the 文件同步 card.
                        store.markFailed(op.opId, code)
                    }
                    acc.rejected += 1
                }

                // The dependency is expected to arrive in an earlier batch of a later round, since
                // push order is dependency-sorted; retrying the same opId is safe.
                PushStatus.DEPENDENCY_MISSING -> {
                    store.markFailed(op.opId, result.error?.code ?: "dependency_missing")
                    acc.rejected += 1
                }
            }
        }

        if (accepted.isNotEmpty()) store.completeOperations(accepted)
        if (dropped.isNotEmpty()) store.dropOperations(dropped)
    }

    private suspend fun sealEnvelopes(
        batch: List<PendingOperation>,
    ): Map<String, Map<String, SecretEnvelope>> {
        if (!sealer.canSeal()) return emptyMap()
        val sealed = LinkedHashMap<String, Map<String, SecretEnvelope>>()
        for (op in batch) {
            if (op.secretFields.isEmpty()) continue
            val fields = LinkedHashMap<String, SecretEnvelope>()
            for (field in op.secretFields) {
                val envelope = sealer.seal(op.entityType, op.entityId, field, op.baseRevision)
                if (envelope != null) fields[field] = envelope
            }
            if (fields.isNotEmpty()) sealed[op.opId] = fields
        }
        return sealed
    }

    private suspend fun applyBlobs(acc: RoundAccumulator): MobileError? {
        val result = blobs.drain()
        acc.blobsBlocked = result.blocked
        acc.blobsCompleted = result.completed
        return null
    }

    /**
     * Acknowledge only what is already committed locally.
     *
     * SYNC_STATE_MACHINE.md 6.4: acking before the commit would let a crash skip changes for good,
     * because the server is then free to prune them.
     */
    private suspend fun ackCursor(acc: RoundAccumulator): MobileError? {
        val cursors = store.cursors()
        val nothingNew = cursors.appliedCursor <= cursors.ackedCursor && acc.appliedOpIds.isEmpty()
        if (nothingNew) return null
        return when (val result = transport.ack(cursors.appliedCursor, acc.appliedOpIds.toList())) {
            is ApiResult.Failure -> result.error
            is ApiResult.Success -> {
                store.saveAckedCursor(cursors.appliedCursor)
                null
            }
        }
    }

    private fun publish(phase: SyncPhase, acc: RoundAccumulator) {
        progressState.value = SyncProgress(
            phase = phase,
            entitiesProcessed = acc.applied + acc.pushed,
            entitiesTotal = acc.entitiesStaged.takeIf { it > 0 },
        )
    }

    private class RoundAccumulator {
        val phasesRun = mutableListOf<SyncPhase>()
        val deferred = mutableListOf<DeferredOperation>()
        val appliedOpIds = mutableListOf<String>()
        var pushed = 0
        var rejected = 0
        var conflicts = 0
        var applied = 0
        var skipped = 0
        var entitiesStaged = 0
        var envelopeFailures = 0
        var blobsBlocked = false
        var blobsCompleted = 0
    }

    private companion object {
        /** The frozen coalescing rule: the round in flight plus at most one trailing round. */
        const val MAX_ROUNDS_PER_INVOCATION = 2

        /**
         * Page guard. A server that never clears hasMore would otherwise hold the actor forever and
         * starve the trailing round; the next round simply resumes from the persisted cursor.
         */
        const val MAX_PAGES_PER_ROUND = 512

        val PAGE_TOKEN_TTL_MS: Long =
            SyncContract.BOOTSTRAP_PAGE_TOKEN_TTL_MINUTES * 60L * 1000L
    }
}
