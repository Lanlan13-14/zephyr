package one.zephyr.mobile.sync

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import one.zephyr.mobile.contracts.BindingState
import one.zephyr.mobile.contracts.PushStatus
import one.zephyr.mobile.contracts.SyncAction
import one.zephyr.mobile.contracts.SyncPhase
import one.zephyr.mobile.data.SecretPayloadFailure
import one.zephyr.mobile.data.SecretPayloadViolationException
import one.zephyr.mobile.data.SecretReconciliationException
import one.zephyr.mobile.data.SecretReconciliationFailure
import one.zephyr.mobile.model.BootstrapPage
import one.zephyr.mobile.model.ChangePage
import one.zephyr.mobile.model.MobileError
import one.zephyr.mobile.model.PushResponse
import one.zephyr.mobile.model.PushResult
import one.zephyr.mobile.model.SyncChange
import one.zephyr.mobile.model.SyncTrigger
import one.zephyr.mobile.network.ApiResult
import one.zephyr.mobile.security.ResidencyViolationException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Round-level behaviour of the sync actor.
 *
 * These assert the rules that a compile cannot catch and an emulator test would catch too late:
 * phase order, when a cursor may be acknowledged, and what happens to a queued operation when the
 * server disagrees with it.
 */
class SyncActorTest {

    private var now = 1_000L

    private fun actor(
        transport: FakeSyncTransport,
        store: FakeSyncLocalStore,
        sealer: SecretSealer = NoSealer,
        blobs: BlobTransferPort = NoBlobs,
        onCapabilities: (one.zephyr.mobile.model.ServerCapabilities) -> Unit = {},
    ) = SyncActor(
        transport = transport,
        store = store,
        sealer = sealer,
        blobs = blobs,
        clock = { now },
        batchIdFactory = { "batch-fixed" },
        jitter = { 1.0 },
        onCapabilities = onCapabilities,
    )

    @Test
    fun `first bind runs the snapshot phases in the frozen order`() = runTest {
        val transport = FakeSyncTransport()
        transport.bootstrapPages.add(
            ApiResult.Success(
                BootstrapPage(
                    bootstrapId = "boot-1",
                    snapshotCursor = 120,
                    nextPageToken = "page-2",
                    complete = false,
                    entities = listOf(change(1, revision = 3)),
                ),
                null,
            ),
        )
        transport.bootstrapPages.add(
            ApiResult.Success(
                BootstrapPage(
                    bootstrapId = "boot-1",
                    snapshotCursor = 120,
                    nextPageToken = null,
                    complete = true,
                    entities = listOf(change(2, entityId = "c-2", revision = 4)),
                ),
                null,
            ),
        )
        val store = FakeSyncLocalStore(BindingState.BOUND_NEEDS_BOOTSTRAP)

        val result = actor(transport, store).request(SyncTrigger.BIND_COMPLETE).single()

        assertEquals(
            listOf(
                SyncPhase.VALIDATE_BINDING,
                SyncPhase.BOOTSTRAP_PAGE,
                SyncPhase.CATCH_UP_PULL,
                SyncPhase.PUSH_PENDING,
                SyncPhase.PULL_CHANGES,
                SyncPhase.APPLY_BLOBS,
                SyncPhase.ACK_CURSOR,
                SyncPhase.COMMIT_SUCCESS,
            ),
            result.phasesRun,
        )
        assertEquals(BindingState.IDLE, result.endState)
        // The snapshot cursor is persisted from the first page: it is the join to the change feed.
        assertEquals(listOf(120L), store.snapshotCursorWrites)
        assertEquals(1, store.promotedGenerations.size)
        assertEquals(120L, store.appliedCursor)
        // A fresh bootstrap clears any abandoned generation first.
        assertEquals(1, store.stagingCleared)
        assertEquals(listOf(null, "page-2"), transport.bootstrapTokens)
    }

    @Test
    fun `a normal round skips the snapshot phases`() = runTest {
        val transport = FakeSyncTransport()
        val store = FakeSyncLocalStore(BindingState.IDLE)

        val result = actor(transport, store).request(SyncTrigger.INTERVAL).single()

        assertEquals(
            listOf(
                SyncPhase.VALIDATE_BINDING,
                SyncPhase.PUSH_PENDING,
                SyncPhase.PULL_CHANGES,
                SyncPhase.APPLY_BLOBS,
                SyncPhase.ACK_CURSOR,
                SyncPhase.COMMIT_SUCCESS,
            ),
            result.phasesRun,
        )
        assertEquals(BindingState.IDLE, result.endState)
        assertEquals(1, store.successes)
    }

    @Test
    fun `an interrupted bootstrap resumes from its page token`() = runTest {
        val transport = FakeSyncTransport()
        transport.bootstrapPages.add(
            ApiResult.Success(
                BootstrapPage("boot-1", snapshotCursor = 500, nextPageToken = null, complete = true, entities = emptyList()),
                null,
            ),
        )
        val store = FakeSyncLocalStore(BindingState.BOUND_NEEDS_BOOTSTRAP)
        store.checkpoint = BootstrapCheckpoint(
            generation = 77,
            bootstrapId = "boot-1",
            snapshotCursor = 500,
            nextPageToken = "page-9",
            pagesFetched = 4,
            entitiesStaged = 900,
            expiresAt = now + 60_000,
        )

        val result = actor(transport, store).request(SyncTrigger.FOREGROUND_START).single()

        assertTrue(result.phasesRun.contains(SyncPhase.RECOVER_BOOTSTRAP))
        assertFalse(result.phasesRun.contains(SyncPhase.BOOTSTRAP_PAGE))
        assertEquals(listOf("page-9"), transport.bootstrapTokens)
        // Resuming must reuse the generation, or two snapshots would be mixed.
        assertEquals(listOf(77L), store.promotedGenerations)
        // The staged rows from the earlier attempt are kept.
        assertEquals(0, store.stagingCleared)
    }

    @Test
    fun `an expired checkpoint restarts the bootstrap instead of resuming`() = runTest {
        val transport = FakeSyncTransport()
        transport.bootstrapPages.add(
            ApiResult.Success(
                BootstrapPage("boot-2", snapshotCursor = 10, nextPageToken = null, complete = true, entities = emptyList()),
                null,
            ),
        )
        val store = FakeSyncLocalStore(BindingState.BOUND_NEEDS_BOOTSTRAP)
        store.checkpoint = BootstrapCheckpoint(
            generation = 5,
            bootstrapId = "old",
            snapshotCursor = 10,
            nextPageToken = "stale",
            pagesFetched = 2,
            entitiesStaged = 3,
            expiresAt = now - 1,
        )

        val result = actor(transport, store).request(SyncTrigger.MANUAL).single()

        assertTrue(result.phasesRun.contains(SyncPhase.BOOTSTRAP_PAGE))
        assertEquals(listOf<String?>(null), transport.bootstrapTokens)
        assertEquals(1, store.stagingCleared)
    }

    @Test
    fun `a 513 page snapshot returns a continuation before promotion and resumes after restart`() = runTest {
        val transport = FakeSyncTransport()
        repeat(512) { index ->
            transport.bootstrapPages.add(
                ApiResult.Success(
                    BootstrapPage(
                        bootstrapId = "boot-large",
                        snapshotCursor = 900,
                        nextPageToken = "page-${index + 1}",
                        complete = false,
                        entities = emptyList(),
                    ),
                    null,
                ),
            )
        }
        val store = FakeSyncLocalStore(BindingState.BOUND_NEEDS_BOOTSTRAP)
        store.queue.add(pendingOp("must-wait"))
        val firstActor = actor(transport, store)

        val first = firstActor.request(SyncTrigger.BIND_COMPLETE).single()

        val incomplete = first.bootstrapOutcome as BootstrapOutcome.Incomplete
        assertFalse(first.complete)
        assertTrue(first.succeeded)
        assertEquals("page-512", incomplete.continuation.nextPageToken)
        assertEquals(512, incomplete.continuation.pagesFetched)
        assertEquals(BindingState.BOOTSTRAPPING, first.endState)
        assertEquals(SyncPhase.BOOTSTRAP_PAGE, first.stoppedAt)
        assertEquals(
            listOf(SyncPhase.VALIDATE_BINDING, SyncPhase.BOOTSTRAP_PAGE),
            first.phasesRun,
        )
        assertTrue(store.promotedGenerations.isEmpty())
        assertEquals(incomplete.continuation, store.checkpoint)
        assertEquals(512, store.stagedGenerations.size)
        assertEquals(0L, store.appliedCursor)
        assertTrue(transport.changeCursors.isEmpty())
        assertTrue(transport.pushedBatches.isEmpty())
        assertTrue(transport.ackedCursors.isEmpty())
        assertEquals(0, store.successes)
        assertTrue(firstActor.rerunPending())

        transport.bootstrapPages.add(
            ApiResult.Success(
                BootstrapPage(
                    bootstrapId = "boot-large",
                    snapshotCursor = 900,
                    nextPageToken = null,
                    complete = true,
                    entities = emptyList(),
                ),
                null,
            ),
        )
        transport.pushResponses.add(
            ApiResult.Success(
                PushResponse(
                    batchId = "batch-fixed",
                    serverCursor = 900,
                    results = listOf(
                        PushResult(
                            opId = "must-wait",
                            status = PushStatus.ACCEPTED,
                            entityId = "c-1",
                            revision = 2,
                            changeSeq = 901,
                        ),
                    ),
                    changesAvailable = false,
                ),
                null,
            ),
        )

        // A new actor has no in-memory continuation flag; the persisted state/checkpoint are enough.
        val resumed = actor(transport, store).request(SyncTrigger.FOREGROUND_START).single()

        assertEquals(BootstrapOutcome.Complete, resumed.bootstrapOutcome)
        assertTrue(resumed.complete)
        assertEquals(BindingState.IDLE, resumed.endState)
        assertEquals("page-512", transport.bootstrapTokens.last())
        assertEquals(listOf(1_000L), store.promotedGenerations)
        assertEquals(900L, store.appliedCursor)
        assertEquals(null, store.checkpoint)
    }

    @Test
    fun `a looping page token aborts without promoting its partial generation`() = runTest {
        val transport = FakeSyncTransport()
        transport.bootstrapPages.add(
            ApiResult.Success(
                BootstrapPage("boot-loop", 40, "loop", complete = false, entities = emptyList()),
                null,
            ),
        )
        transport.bootstrapPages.add(
            ApiResult.Success(
                BootstrapPage("boot-loop", 40, "loop", complete = false, entities = emptyList()),
                null,
            ),
        )
        val store = FakeSyncLocalStore(BindingState.BOUND_NEEDS_BOOTSTRAP)

        val result = actor(transport, store).request(SyncTrigger.BIND_COMPLETE).single()

        assertEquals("bootstrap_expired", result.error?.code)
        assertEquals(BindingState.BOUND_NEEDS_BOOTSTRAP, result.endState)
        assertEquals(SyncPhase.BOOTSTRAP_PAGE, result.stoppedAt)
        assertEquals(listOf<String?>(null, "loop"), transport.bootstrapTokens)
        assertTrue(store.promotedGenerations.isEmpty())
        assertEquals(null, store.checkpoint)
        assertFalse(result.phasesRun.contains(SyncPhase.CATCH_UP_PULL))
        assertTrue(transport.pushedBatches.isEmpty())
        assertTrue(transport.ackedCursors.isEmpty())
    }

    @Test
    fun `a server-expired continuation is discarded and restarted safely in the same round`() = runTest {
        val transport = FakeSyncTransport()
        transport.bootstrapPages.add(
            ApiResult.Failure(MobileError.local("bootstrap_expired", "expired")),
        )
        transport.bootstrapPages.add(
            ApiResult.Success(
                BootstrapPage("boot-new", 88, null, complete = true, entities = emptyList()),
                null,
            ),
        )
        val store = FakeSyncLocalStore(BindingState.BOOTSTRAPPING)
        store.checkpoint = BootstrapCheckpoint(
            generation = 7,
            bootstrapId = "boot-old",
            snapshotCursor = 70,
            nextPageToken = "old-token",
            pagesFetched = 3,
            entitiesStaged = 30,
            expiresAt = now + 60_000,
        )

        val result = actor(transport, store).request(SyncTrigger.FOREGROUND_START).single()

        assertEquals(listOf<String?>("old-token", null), transport.bootstrapTokens)
        assertEquals(BootstrapOutcome.Complete, result.bootstrapOutcome)
        assertEquals(BindingState.IDLE, result.endState)
        assertEquals(listOf(1_000L), store.promotedGenerations)
        assertEquals(1, store.stagingCleared)
        assertEquals(null, store.checkpoint)
    }

    @Test
    fun `final promotion uses one atomic commit and preserves the local overlay`() = runTest {
        val transport = FakeSyncTransport()
        transport.bootstrapPages.add(
            ApiResult.Success(
                BootstrapPage("boot-atomic", 123, null, complete = true, entities = emptyList()),
                null,
            ),
        )
        val store = FakeSyncLocalStore(BindingState.BOUND_NEEDS_BOOTSTRAP)
        store.localOverlay["connection/c-1/color"] = "green"

        val result = actor(transport, store).request(SyncTrigger.BIND_COMPLETE).single()

        assertTrue(result.complete)
        assertEquals(listOf(1_000L to 123L), store.bootstrapCommits)
        assertEquals(123L, store.appliedCursor)
        assertEquals(null, store.checkpoint)
        assertEquals("green", store.localOverlay["connection/c-1/color"])
    }

    @Test
    fun `cursor expiry stops pushing and parks the binding on bootstrap`() = runTest {
        val transport = FakeSyncTransport()
        transport.changePages.add(ApiResult.Failure(MobileError.local("cursor_expired", "gone")))
        val store = FakeSyncLocalStore(BindingState.IDLE)
        store.appliedCursor = 40
        store.queue.add(pendingOp("op-1"))
        transport.pushResponses.add(
            ApiResult.Success(
                PushResponse(
                    batchId = "batch-fixed",
                    serverCursor = 41,
                    results = listOf(
                        PushResult(opId = "op-1", status = PushStatus.ACCEPTED, entityId = "c-1", revision = 2, changeSeq = 41),
                    ),
                    changesAvailable = true,
                ),
                null,
            ),
        )

        val result = actor(transport, store).request(SyncTrigger.INTERVAL).single()

        assertEquals(BindingState.BOUND_NEEDS_BOOTSTRAP, result.endState)
        assertEquals(SyncPhase.PULL_CHANGES, result.stoppedAt)
        // Acking a cursor the server has forgotten would be meaningless, so the phase never runs.
        assertFalse(result.phasesRun.contains(SyncPhase.ACK_CURSOR))
        assertEquals("cursor_expired", result.error?.code)
    }

    @Test
    fun `secret reconciliation failure does not advance or acknowledge the page cursor`() = runTest {
        val transport = FakeSyncTransport()
        transport.changePages.add(
            ApiResult.Success(
                ChangePage(
                    fromCursor = 40,
                    nextCursor = 41,
                    hasMore = false,
                    changes = listOf(change(41, revision = 8)),
                ),
                null,
            ),
        )
        val store = FakeSyncLocalStore(BindingState.IDLE)
        store.appliedCursor = 40
        store.ackedCursor = 40
        store.applyChangesFailure = SecretReconciliationException(
            SecretReconciliationFailure.ENVELOPE_REJECTED,
        )

        val result = actor(transport, store).request(SyncTrigger.INTERVAL).single()

        assertEquals("internal_error", result.error?.code)
        assertEquals(40L, store.appliedCursor)
        assertEquals(40L, store.ackedCursor)
        assertTrue(transport.ackedCursors.isEmpty())
        assertEquals(SyncPhase.PULL_CHANGES, result.stoppedAt)
    }

    @Test
    fun `an unsafe inbound payload does not crash the round or advance the cursor`() = runTest {
        val transport = FakeSyncTransport()
        transport.changePages.add(
            ApiResult.Success(
                ChangePage(
                    fromCursor = 40,
                    nextCursor = 41,
                    hasMore = false,
                    changes = listOf(change(41, revision = 8)),
                ),
                null,
            ),
        )
        val store = FakeSyncLocalStore(BindingState.IDLE)
        store.appliedCursor = 40
        store.ackedCursor = 40
        store.applyChangesFailure = SecretPayloadViolationException(SecretPayloadFailure.RAW_SECRET_FIELD)

        val result = actor(transport, store).request(SyncTrigger.INTERVAL).single()

        assertEquals("malformed_response", result.error?.code)
        assertEquals(40L, store.appliedCursor)
        assertEquals(40L, store.ackedCursor)
        assertTrue(transport.ackedCursors.isEmpty())
        assertEquals(SyncPhase.PULL_CHANGES, result.stoppedAt)
    }

    @Test
    fun `an accepted push clears the queue and acknowledges its opIds`() = runTest {
        val transport = FakeSyncTransport()
        val store = FakeSyncLocalStore(BindingState.IDLE)
        store.queue.add(pendingOp("op-1", payload = payload("name" to "renamed")))
        transport.pushResponses.add(
            ApiResult.Success(
                PushResponse(
                    batchId = "batch-fixed",
                    serverCursor = 9,
                    results = listOf(
                        PushResult(
                            opId = "op-1", status = PushStatus.ACCEPTED, entityId = "c-1", revision = 7, changeSeq = 9,
                        ),
                    ),
                    changesAvailable = false,
                ),
                null,
            ),
        )

        val result = actor(transport, store).request(SyncTrigger.MANUAL).single()

        assertEquals(1, result.pushed)
        assertTrue(store.queue.isEmpty())
        assertEquals(7L, store.completed.single().revision)
        // Dispatched before the call so a retry replays the same opId.
        assertEquals(listOf(listOf("op-1")), store.dispatched)
        assertEquals(listOf(listOf("op-1")), transport.ackedOpIds)
    }

    @Test
    fun `a duplicate result is treated as success`() = runTest {
        val transport = FakeSyncTransport()
        val store = FakeSyncLocalStore(BindingState.IDLE)
        store.queue.add(pendingOp("op-1", dispatchedAt = 500))
        transport.pushResponses.add(
            ApiResult.Success(
                PushResponse(
                    batchId = "batch-fixed",
                    serverCursor = 3,
                    results = listOf(
                        PushResult(opId = "op-1", status = PushStatus.DUPLICATE, entityId = "c-1", revision = 4),
                    ),
                    changesAvailable = false,
                ),
                null,
            ),
        )

        val result = actor(transport, store).request(SyncTrigger.MANUAL).single()

        // Deduplication is the whole point of reusing the opId, so this is not an error.
        assertEquals(1, result.pushed)
        assertTrue(store.queue.isEmpty())
        assertTrue(result.succeeded)
    }

    @Test
    fun `malformed push result sets never finalize drop or acknowledge operations`() = runTest {
        val valid = listOf(acceptedReceipt("op-1", "c-1"), acceptedReceipt("op-2", "c-2"))
        val responses = listOf(
            PushResponse("another-batch", 2, valid, changesAvailable = false),
            PushResponse("batch-fixed", 2, listOf(valid[0], valid[0]), changesAvailable = false),
            PushResponse("batch-fixed", 2, listOf(valid[0]), changesAvailable = false),
            PushResponse(
                "batch-fixed",
                2,
                listOf(valid[0], acceptedReceipt("unknown", "c-9")),
                changesAvailable = false,
            ),
        )

        for (response in responses) assertMalformedPush(response)
    }

    @Test
    fun `a conflict is recorded once and the losing operation stops being pushed`() = runTest {
        val transport = FakeSyncTransport()
        val store = FakeSyncLocalStore(BindingState.IDLE)
        store.queue.add(pendingOp("op-1", fieldMask = listOf("name"), secretFields = emptyList()))
        transport.pushResponses.add(
            ApiResult.Success(
                PushResponse(
                    batchId = "batch-fixed",
                    serverCursor = 12,
                    results = listOf(
                        PushResult(
                            opId = "op-1",
                            status = PushStatus.CONFLICT,
                            entityId = "c-1",
                            revision = 9,
                            serverPayload = payload(
                                "ownerUserId" to "user-1",
                                "name" to "server wins",
                            ),
                            serverChangedFields = listOf("name"),
                        ),
                    ),
                    changesAvailable = false,
                ),
                null,
            ),
        )

        val result = actor(transport, store).request(SyncTrigger.MANUAL).single()

        assertEquals(1, result.conflicts)
        assertEquals(BindingState.CONFLICTED, result.endState)
        val conflict = store.conflicts.single()
        assertEquals(listOf("name"), conflict.overlapFields)
        assertEquals(9L, conflict.serverRevision)
        // The conflict row owns the edit now; leaving it queued would push the losing side again.
        assertTrue(store.queue.isEmpty())
        assertEquals(listOf("op-1"), store.droppedOpIds)
    }

    @Test
    fun `an ACL rejection marks the conflict authoritative`() = runTest {
        val transport = FakeSyncTransport()
        val store = FakeSyncLocalStore(BindingState.IDLE)
        store.queue.add(pendingOp("op-1"))
        transport.pushResponses.add(
            ApiResult.Success(
                PushResponse(
                    batchId = "batch-fixed",
                    serverCursor = 12,
                    results = listOf(
                        PushResult(
                            opId = "op-1",
                            status = PushStatus.CONFLICT,
                            entityId = "c-1",
                            revision = 9,
                            error = MobileError.local("forbidden_resource_edit", "no edit capability"),
                            serverPayload = payload(
                                "ownerUserId" to "user-1",
                                "name" to "server wins",
                            ),
                            serverChangedFields = listOf("name"),
                        ),
                    ),
                    changesAvailable = false,
                ),
                null,
            ),
        )

        actor(transport, store).request(SyncTrigger.MANUAL)

        // ConflictRepository refuses keep_local on this flag, which is what makes revocation win.
        assertTrue(store.conflicts.single().aclRevoked)
    }

    @Test
    fun `a foreign conflict aborts without persisting or dropping the pending edit`() = runTest {
        val transport = FakeSyncTransport()
        val store = FakeSyncLocalStore(BindingState.IDLE)
        store.queue.add(pendingOp("op-1"))
        transport.pushResponses.add(
            ApiResult.Success(
                PushResponse(
                    batchId = "batch-fixed",
                    serverCursor = 12,
                    results = listOf(
                        PushResult(
                            opId = "op-1",
                            status = PushStatus.CONFLICT,
                            entityId = "c-1",
                            revision = 9,
                            serverPayload = payload(
                                "ownerUserId" to "user-2",
                                "name" to "foreign row",
                            ),
                            serverChangedFields = listOf("name"),
                        ),
                    ),
                    changesAvailable = false,
                ),
                null,
            ),
        )
        var purged = 0
        val subject = SyncActor(
            transport = transport,
            store = store,
            sealer = NoSealer,
            blobs = NoBlobs,
            clock = { now },
            batchIdFactory = { "batch-fixed" },
            onSharedPurge = { purged += 1 },
        )

        val result = subject.request(SyncTrigger.MANUAL).single()

        assertEquals("shared_residency_violation", result.error?.code)
        assertEquals(SyncPhase.PUSH_PENDING, result.stoppedAt)
        assertEquals(BindingState.IDLE, result.endState)
        assertEquals(1, purged)
        assertTrue(store.conflicts.isEmpty())
        assertTrue(store.droppedOpIds.isEmpty())
        assertTrue(store.completed.isEmpty())
        assertEquals("op-1", store.queue.single().opId)
        assertNotNull(store.queue.single().dispatchedAt)
        assertEquals(0L, store.appliedCursor)
        assertEquals(0L, store.ackedCursor)
        assertTrue(transport.ackedCursors.isEmpty())
    }

    @Test
    fun `a conflict without a server payload fails closed and remains pending`() = runTest {
        val transport = FakeSyncTransport()
        val store = FakeSyncLocalStore(BindingState.IDLE)
        store.queue.add(pendingOp("op-1"))
        transport.pushResponses.add(
            ApiResult.Success(
                PushResponse(
                    batchId = "batch-fixed",
                    serverCursor = 12,
                    results = listOf(
                        PushResult(
                            opId = "op-1",
                            status = PushStatus.CONFLICT,
                            entityId = "c-1",
                            revision = 9,
                            serverPayload = null,
                            serverChangedFields = listOf("name"),
                        ),
                    ),
                    changesAvailable = false,
                ),
                null,
            ),
        )

        val result = actor(transport, store).request(SyncTrigger.MANUAL).single()

        assertEquals("shared_residency_violation", result.error?.code)
        assertEquals(BindingState.IDLE, result.endState)
        assertEquals("op-1", store.queue.single().opId)
        assertTrue(store.conflicts.isEmpty())
        assertTrue(store.droppedOpIds.isEmpty())
    }

    @Test
    fun `conflict preflight leaves earlier accepted result in the same batch pending`() = runTest {
        val transport = FakeSyncTransport()
        val store = FakeSyncLocalStore(BindingState.IDLE)
        store.queue.add(pendingOp("op-1", entityId = "c-1"))
        store.queue.add(pendingOp("op-2", entityId = "c-2"))
        transport.pushResponses.add(
            ApiResult.Success(
                PushResponse(
                    batchId = "batch-fixed",
                    serverCursor = 12,
                    results = listOf(
                        PushResult(
                            opId = "op-1",
                            status = PushStatus.ACCEPTED,
                            entityId = "c-1",
                            revision = 2,
                            changeSeq = 13,
                        ),
                        PushResult(
                            opId = "op-2",
                            status = PushStatus.CONFLICT,
                            entityId = "c-2",
                            revision = 3,
                            serverPayload = payload(
                                "ownerUserId" to "foreign-user",
                                "name" to "foreign row",
                            ),
                            serverChangedFields = listOf("name"),
                        ),
                    ),
                    changesAvailable = false,
                ),
                null,
            ),
        )

        val result = actor(transport, store).request(SyncTrigger.MANUAL).single()

        assertEquals("shared_residency_violation", result.error?.code)
        assertEquals(listOf("op-1", "op-2"), store.queue.map { it.opId })
        assertTrue(store.completed.isEmpty())
        assertTrue(store.conflicts.isEmpty())
        assertTrue(store.droppedOpIds.isEmpty())
        assertEquals(0, result.pushed)
        assertEquals(0, result.conflicts)
    }

    @Test
    fun `an oversized conflict payload remains pending and never reaches the conflict store`() = runTest {
        val transport = FakeSyncTransport()
        val store = FakeSyncLocalStore(BindingState.IDLE)
        store.queue.add(pendingOp("op-1"))
        val oversized = JsonObject(
            mapOf(
                "ownerUserId" to JsonPrimitive("user-1"),
                "name" to JsonPrimitive("x".repeat(ConflictPayloadValidator.MAX_BYTES)),
            ),
        )
        transport.pushResponses.add(
            ApiResult.Success(
                PushResponse(
                    batchId = "batch-fixed",
                    serverCursor = 12,
                    results = listOf(
                        PushResult(
                            opId = "op-1",
                            status = PushStatus.CONFLICT,
                            entityId = "c-1",
                            revision = 9,
                            serverPayload = oversized,
                            serverChangedFields = listOf("name"),
                        ),
                    ),
                    changesAvailable = false,
                ),
                null,
            ),
        )

        val result = actor(transport, store).request(SyncTrigger.MANUAL).single()

        assertEquals("shared_residency_violation", result.error?.code)
        assertEquals(BindingState.IDLE, result.endState)
        assertEquals("op-1", store.queue.single().opId)
        assertTrue(store.conflicts.isEmpty())
        assertTrue(store.droppedOpIds.isEmpty())
    }

    @Test
    fun `cursor invalid rejection retains accepted siblings and journal until post-bootstrap ACK`() = runTest {
        val transport = FakeSyncTransport()
        val store = FakeSyncLocalStore(BindingState.IDLE)
        store.queue.add(pendingOp("op-accepted", entityId = "c-1"))
        store.queue.add(pendingOp("op-bootstrap", entityId = "c-2"))
        store.retainedJournalOpIds.add("op-accepted")
        store.checkpoint = BootstrapCheckpoint(
            generation = 7,
            bootstrapId = "stale-bootstrap",
            snapshotCursor = 10,
            nextPageToken = "stale-token",
            pagesFetched = 1,
            entitiesStaged = 2,
            expiresAt = now + 60_000,
        )
        transport.pushResponses.add(
            ApiResult.Success(
                PushResponse(
                    batchId = "batch-fixed",
                    serverCursor = 12,
                    results = listOf(
                        PushResult(
                            opId = "op-accepted",
                            status = PushStatus.ACCEPTED,
                            entityId = "c-1",
                            revision = 4,
                            changeSeq = 13,
                        ),
                        PushResult(
                            opId = "op-bootstrap",
                            status = PushStatus.REJECTED,
                            entityId = "c-2",
                            error = MobileError(
                                code = "cursor_invalid",
                                message = "refresh the account snapshot",
                                retryable = false,
                                requestId = "request-1",
                                details = mapOf("bootstrapRequired" to "true"),
                            ),
                        ),
                    ),
                    changesAvailable = false,
                ),
                null,
            ),
        )
        val subject = actor(transport, store)

        val result = subject.request(SyncTrigger.MANUAL).single()

        assertEquals("cursor_invalid", result.error?.code)
        assertEquals(SyncPhase.PUSH_PENDING, result.stoppedAt)
        assertEquals(BindingState.BOUND_NEEDS_BOOTSTRAP, result.endState)
        assertTrue(store.completed.isEmpty())
        assertEquals(listOf("op-accepted", "op-bootstrap"), store.queue.map { it.opId })
        assertEquals("cursor_invalid", store.queue.single { it.opId == "op-bootstrap" }.lastError)
        assertEquals(setOf("op-accepted"), store.retainedJournalOpIds)
        assertTrue(transport.ackedCursors.isEmpty())
        assertTrue(store.droppedOpIds.isEmpty())
        assertEquals(null, store.checkpoint)
        assertEquals(1, store.stagingCleared)
        assertTrue(subject.rerunPending())
        assertEquals(1, transport.pushedBatches.size)
    }

    @Test
    fun `explicit bootstrapRequired detail is typed even before a dedicated error code`() = runTest {
        val transport = FakeSyncTransport()
        val store = FakeSyncLocalStore(BindingState.IDLE)
        store.queue.add(pendingOp("op-1"))
        transport.pushResponses.add(
            ApiResult.Success(
                PushResponse(
                    batchId = "batch-fixed",
                    serverCursor = 1,
                    results = listOf(
                        PushResult(
                            opId = "op-1",
                            status = PushStatus.REJECTED,
                            error = MobileError(
                                code = "conflict_projection_unavailable",
                                message = "refresh required",
                                retryable = false,
                                requestId = null,
                                details = mapOf("bootstrapRequired" to "TRUE"),
                            ),
                        ),
                    ),
                    changesAvailable = false,
                ),
                null,
            ),
        )

        val result = actor(transport, store).request(SyncTrigger.MANUAL).single()

        assertEquals("conflict_projection_unavailable", result.error?.code)
        assertEquals(BindingState.BOUND_NEEDS_BOOTSTRAP, result.endState)
        assertEquals("op-1", store.queue.single().opId)
        assertEquals("conflict_projection_unavailable", store.queue.single().lastError)
        assertTrue(store.completed.isEmpty())
        assertTrue(store.droppedOpIds.isEmpty())
    }

    @Test
    fun `a new actor recovers bootstrap before retrying the retained operation`() = runTest {
        val transport = FakeSyncTransport()
        val store = FakeSyncLocalStore(BindingState.IDLE)
        store.queue.add(pendingOp("op-1"))
        transport.pushResponses.add(
            ApiResult.Success(
                PushResponse(
                    batchId = "batch-fixed",
                    serverCursor = 1,
                    results = listOf(
                        PushResult(
                            opId = "op-1",
                            status = PushStatus.REJECTED,
                            error = MobileError.local("cursor_invalid", "bootstrap required"),
                        ),
                    ),
                    changesAvailable = false,
                ),
                null,
            ),
        )

        val failed = actor(transport, store).request(SyncTrigger.INTERVAL).single()
        assertEquals(BindingState.BOUND_NEEDS_BOOTSTRAP, failed.endState)
        assertEquals(1, transport.pushedBatches.size)

        transport.bootstrapPages.add(
            ApiResult.Success(
                BootstrapPage(
                    bootstrapId = "fresh-bootstrap",
                    snapshotCursor = 20,
                    nextPageToken = null,
                    complete = true,
                    entities = emptyList(),
                ),
                null,
            ),
        )
        transport.pushResponses.add(
            ApiResult.Success(
                PushResponse(
                    batchId = "batch-fixed",
                    serverCursor = 21,
                    results = listOf(
                        PushResult(
                            opId = "op-1", status = PushStatus.ACCEPTED, entityId = "c-1", revision = 3, changeSeq = 21,
                        ),
                    ),
                    changesAvailable = false,
                ),
                null,
            ),
        )

        val recovered = actor(transport, store).request(SyncTrigger.FOREGROUND_START).single()

        assertEquals(SyncPhase.BOOTSTRAP_PAGE, recovered.phasesRun[1])
        assertEquals(listOf<String?>(null), transport.bootstrapTokens)
        assertEquals(2, transport.pushedBatches.size)
        assertEquals(listOf("op-1"), store.completed.map { it.opId })
        assertTrue(store.queue.isEmpty())
        assertEquals(BindingState.IDLE, recovered.endState)
    }

    @Test
    fun `a rejected operation stays queued with its error rather than vanishing`() = runTest {
        val transport = FakeSyncTransport()
        val store = FakeSyncLocalStore(BindingState.IDLE)
        store.queue.add(pendingOp("op-1"))
        transport.pushResponses.add(
            ApiResult.Success(
                PushResponse(
                    batchId = "batch-fixed",
                    serverCursor = 1,
                    results = listOf(
                        PushResult(
                            opId = "op-1",
                            status = PushStatus.REJECTED,
                            error = MobileError.local("payload_too_large", "split it"),
                        ),
                    ),
                    changesAvailable = false,
                ),
                null,
            ),
        )

        actor(transport, store).request(SyncTrigger.MANUAL)

        // Visible on the 文件同步 card instead of a silently lost edit.
        assertEquals(1, store.queue.size)
        assertEquals("payload_too_large", store.queue.single().lastError)
        assertTrue(store.droppedOpIds.isEmpty())
    }

    @Test
    fun `an operation the registry says to drop is dropped`() = runTest {
        val transport = FakeSyncTransport()
        val store = FakeSyncLocalStore(BindingState.IDLE)
        store.queue.add(pendingOp("op-1"))
        transport.pushResponses.add(
            ApiResult.Success(
                PushResponse(
                    batchId = "batch-fixed",
                    serverCursor = 1,
                    results = listOf(
                        PushResult(
                            opId = "op-1",
                            status = PushStatus.REJECTED,
                            error = MobileError.local("unsupported_scope", "not syncable"),
                        ),
                    ),
                    changesAvailable = false,
                ),
                null,
            ),
        )

        actor(transport, store).request(SyncTrigger.MANUAL)

        assertEquals(listOf("op-1"), store.droppedOpIds)
    }

    @Test
    fun `the cursor is only acknowledged after the page is committed locally`() = runTest {
        val transport = FakeSyncTransport()
        transport.changePages.add(
            ApiResult.Success(
                ChangePage(fromCursor = 0, nextCursor = 1, hasMore = false, changes = listOf(change(1, revision = 2))),
                null,
            ),
        )
        transport.ackResult = ApiResult.Failure(MobileError.local("server_unavailable", "down", retryable = true))
        val store = FakeSyncLocalStore(BindingState.IDLE)

        val result = actor(transport, store).request(SyncTrigger.INTERVAL).single()

        // Applied locally, but the server was not told, so the change will be re-sent next round.
        assertEquals(1L, store.appliedCursor)
        assertEquals(0L, store.ackedCursor)
        assertEquals(SyncPhase.ACK_CURSOR, result.stoppedAt)
        assertNotNull(result.error)
    }

    @Test
    fun `a retryable ACK protocol failure retains pending operation journal and cursor`() = runTest {
        val transport = FakeSyncTransport()
        val store = FakeSyncLocalStore(BindingState.IDLE)
        store.queue.add(pendingOp("op-1"))
        store.retainedJournalOpIds.add("op-1")
        transport.pushResponses.add(
            ApiResult.Success(
                PushResponse(
                    batchId = "batch-fixed",
                    serverCursor = 1,
                    results = listOf(acceptedReceipt("op-1", "c-1")),
                    changesAvailable = false,
                ),
                null,
            ),
        )
        transport.ackResult = ApiResult.Failure(
            MobileError.local("malformed_response", "ACK response omitted ok", retryable = true),
        )

        val result = actor(transport, store).request(SyncTrigger.INTERVAL).single()

        assertEquals("malformed_response", result.error?.code)
        assertEquals(SyncPhase.ACK_CURSOR, result.stoppedAt)
        assertEquals(listOf("op-1"), store.queue.map { it.opId })
        assertEquals(setOf("op-1"), store.retainedJournalOpIds)
        assertTrue(store.completed.isEmpty())
        assertEquals(0L, store.ackedCursor)
        assertTrue(store.acknowledgementCommits.isEmpty())
    }

    @Test
    fun `a new actor replays duplicate after ACK commit fault and clears journal only on retry`() = runTest {
        val transport = FakeSyncTransport()
        val store = FakeSyncLocalStore(BindingState.IDLE)
        store.queue.add(pendingOp("op-1"))
        store.retainedJournalOpIds.add("op-1")
        transport.pushResponses.add(
            ApiResult.Success(
                PushResponse(
                    batchId = "batch-fixed",
                    serverCursor = 1,
                    results = listOf(acceptedReceipt("op-1", "c-1")),
                    changesAvailable = false,
                ),
                null,
            ),
        )
        store.acknowledgementCommitFault = IllegalStateException("simulated transaction rollback")

        val interrupted = actor(transport, store).request(SyncTrigger.INTERVAL).single()

        assertEquals("internal_error", interrupted.error?.code)
        assertEquals(listOf("op-1"), store.queue.map { it.opId })
        assertEquals(setOf("op-1"), store.retainedJournalOpIds)
        assertTrue(store.completed.isEmpty())
        assertEquals(0L, store.ackedCursor)

        store.acknowledgementCommitFault = null
        transport.pushResponses.add(
            ApiResult.Success(
                PushResponse(
                    batchId = "batch-fixed",
                    serverCursor = 1,
                    results = listOf(
                        PushResult(
                            opId = "op-1",
                            status = PushStatus.DUPLICATE,
                            entityId = "c-1",
                            revision = 2,
                        ),
                    ),
                    changesAvailable = false,
                ),
                null,
            ),
        )

        val recovered = actor(transport, store).request(SyncTrigger.FOREGROUND_START).single()

        assertTrue(recovered.succeeded)
        assertEquals(2, transport.pushedBatches.size)
        assertEquals(listOf(listOf("op-1"), listOf("op-1")), transport.ackedOpIds)
        assertTrue(store.queue.isEmpty())
        assertTrue(store.retainedJournalOpIds.isEmpty())
        assertEquals(listOf("op-1"), store.completed.map { it.opId })
        assertEquals(listOf(0L to listOf("op-1")), store.acknowledgementCommits)
    }

    @Test
    fun `an empty change page cannot advance the server cursor`() = runTest {
        val transport = FakeSyncTransport()
        transport.changePages.add(
            ApiResult.Success(ChangePage(fromCursor = 5, nextCursor = 11, hasMore = false, changes = emptyList()), null),
        )
        val store = FakeSyncLocalStore(BindingState.IDLE)
        store.appliedCursor = 5

        val result = actor(transport, store).request(SyncTrigger.INTERVAL).single()

        // Letting the cursor advance is what allows the server to prune its change log.
        assertEquals("malformed_response", result.error?.code)
        assertEquals(5L, store.appliedCursor)
        assertEquals(0L, store.ackedCursor)
        assertTrue(transport.ackedCursors.isEmpty())
    }

    @Test
    fun `malformed change page metadata never applies advances or acknowledges`() = runTest {
        val pages = listOf(
            ChangePage(fromCursor = 0, nextCursor = 1, hasMore = false, changes = emptyList()),
            ChangePage(fromCursor = 0, nextCursor = 2, hasMore = false, changes = listOf(change(2), change(1))),
            ChangePage(fromCursor = 0, nextCursor = 1, hasMore = false, changes = listOf(change(1), change(1))),
            ChangePage(fromCursor = 0, nextCursor = 2, hasMore = false, changes = listOf(change(2))),
            ChangePage(fromCursor = 0, nextCursor = 2, hasMore = false, changes = listOf(change(1))),
            ChangePage(fromCursor = 1, nextCursor = 1, hasMore = false, changes = emptyList()),
        )

        for (page in pages) {
            val transport = FakeSyncTransport()
            transport.changePages.add(ApiResult.Success(page, null))
            val store = FakeSyncLocalStore(BindingState.IDLE)

            val result = actor(transport, store).request(SyncTrigger.INTERVAL).single()

            assertEquals("malformed_response", result.error?.code)
            assertTrue(store.appliedPages.isEmpty())
            assertEquals(0L, store.appliedCursor)
            assertEquals(0L, store.ackedCursor)
            assertTrue(transport.ackedCursors.isEmpty())
        }
    }

    @Test
    fun `multiple change pages are drained in one round`() = runTest {
        val transport = FakeSyncTransport()
        transport.changePages.add(
            ApiResult.Success(
                ChangePage(fromCursor = 0, nextCursor = 1, hasMore = true, changes = listOf(change(1))),
                null,
            ),
        )
        transport.changePages.add(
            ApiResult.Success(
                ChangePage(fromCursor = 1, nextCursor = 2, hasMore = false, changes = listOf(change(2, entityId = "c-2"))),
                null,
            ),
        )
        val store = FakeSyncLocalStore(BindingState.IDLE)

        val result = actor(transport, store).request(SyncTrigger.INTERVAL).single()

        assertEquals(listOf(0L, 1L), transport.changeCursors)
        assertEquals(2, result.applied)
        assertEquals(2L, store.appliedCursor)
    }

    @Test
    fun `a secret change is deferred and surfaced rather than sent in the clear`() = runTest {
        val transport = FakeSyncTransport()
        val store = FakeSyncLocalStore(BindingState.IDLE)
        store.queue.add(pendingOp("op-1", fieldMask = emptyList(), secretFields = listOf("password")))

        val result = actor(transport, store, sealer = NoSealer).request(SyncTrigger.MANUAL).single()

        assertEquals(DeferralReason.SECRET_UNSEALABLE, result.deferred.single().reason)
        assertEquals("op-1" to "secret_upstream_unavailable", store.failures.single())
        // Nothing was transmitted for this operation.
        assertTrue(transport.pushedBatches.isEmpty())
        assertEquals(1, store.queue.size)
    }

    @Test
    fun `a pure secret clear sends without a sealer and keeps an explicit clear intent`() = runTest {
        val transport = FakeSyncTransport()
        val store = FakeSyncLocalStore(BindingState.IDLE)
        store.queue.add(
            pendingOp(
                "op-clear",
                fieldMask = emptyList(),
                clearSecretFields = listOf("password"),
            ),
        )
        transport.pushResponses.add(
            ApiResult.Success(
                PushResponse(
                    batchId = "batch-fixed",
                    serverCursor = 1,
                    results = listOf(
                        PushResult(
                            opId = "op-clear", status = PushStatus.ACCEPTED, entityId = "c-1", revision = 2, changeSeq = 2,
                        ),
                    ),
                    changesAvailable = false,
                ),
                null,
            ),
        )

        val result = actor(transport, store, sealer = NoSealer).request(SyncTrigger.MANUAL).single()

        assertEquals(1, result.pushed)
        assertEquals(listOf("op-clear"), transport.pushedBatches.single().map { it.opId })
        assertTrue(transport.pushedEnvelopes.single().isEmpty())
        assertTrue(store.queue.isEmpty())
    }

    @Test
    fun `a sealable secret travels as an envelope keyed by opId`() = runTest {
        val transport = FakeSyncTransport()
        val store = FakeSyncLocalStore(BindingState.IDLE)
        store.queue.add(pendingOp("op-1", fieldMask = listOf("name"), secretFields = listOf("password")))
        transport.pushResponses.add(
            ApiResult.Success(
                PushResponse(
                    batchId = "batch-fixed",
                    serverCursor = 1,
                    results = listOf(
                        PushResult(
                            opId = "op-1", status = PushStatus.ACCEPTED, entityId = "c-1", revision = 2, changeSeq = 2,
                        ),
                    ),
                    changesAvailable = false,
                ),
                null,
            ),
        )
        val sealer = StubSealer()

        actor(transport, store, sealer = sealer).request(SyncTrigger.MANUAL)

        assertEquals(listOf("connection/c-1/password"), sealer.sealedFields)
        assertEquals(setOf("password"), transport.pushedEnvelopes.single().getValue("op-1").keys)
    }

    @Test
    fun `overlapping triggers collapse to the round in flight plus one trailing round`() = runTest {
        val transport = FakeSyncTransport()
        val store = FakeSyncLocalStore(BindingState.IDLE)
        val subject = actor(transport, store)
        var reentries = 0
        store.beforePending = {
            reentries += 1
            // A write landing mid-round: absorbed, never a third round inside this invocation.
            subject.request(SyncTrigger.LOCAL_WRITE_DEBOUNCE)
        }

        val results = subject.request(SyncTrigger.MANUAL)

        assertEquals(2, results.size)
        assertEquals(SyncTrigger.MANUAL, results[0].trigger)
        assertEquals(SyncTrigger.LOCAL_WRITE_DEBOUNCE, results[1].trigger)
        assertEquals(2, reentries)
        // The trigger from the trailing round is not lost; the scheduler picks it up.
        assertTrue(subject.rerunPending())
    }

    @Test
    fun `an incompatible protocol version is fatal and stops the round immediately`() = runTest {
        val transport = FakeSyncTransport()
        transport.capabilitiesResult = ApiResult.Success(
            one.zephyr.mobile.model.ServerCapabilities(protocolVersions = listOf(2, 3), registryHash = "h"),
            null,
        )
        val store = FakeSyncLocalStore(BindingState.IDLE)

        val result = actor(transport, store).request(SyncTrigger.INTERVAL).single()

        assertEquals(BindingState.FATAL_INCOMPATIBLE, result.endState)
        assertEquals(SyncPhase.VALIDATE_BINDING, result.stoppedAt)
        assertEquals(listOf(SyncPhase.VALIDATE_BINDING), result.phasesRun)
    }

    @Test
    fun `a residency violation aborts the round and purges shared state`() = runTest {
        val transport = FakeSyncTransport()
        transport.changePages.add(
            ApiResult.Failure(MobileError.local("shared_residency_violation", "shared row offered")),
        )
        val store = FakeSyncLocalStore(BindingState.IDLE)
        var purged = 0

        val subject = SyncActor(
            transport = transport,
            store = store,
            sealer = NoSealer,
            blobs = NoBlobs,
            clock = { now },
            onSharedPurge = { purged += 1 },
        )
        val result = subject.request(SyncTrigger.INTERVAL).single()

        assertEquals(1, purged)
        assertEquals(SyncPhase.PULL_CHANGES, result.stoppedAt)
    }

    @Test
    fun `local owner rejection rolls back page cursor and acknowledgement`() = runTest {
        val transport = FakeSyncTransport()
        transport.changePages.add(
            ApiResult.Success(
                ChangePage(fromCursor = 0, nextCursor = 1, hasMore = false, changes = listOf(change(1))),
                null,
            ),
        )
        val store = FakeSyncLocalStore(BindingState.IDLE)
        store.applyChangesFailure = ResidencyViolationException("missing ownerUserId")
        var purged = 0
        val subject = SyncActor(
            transport = transport,
            store = store,
            sealer = NoSealer,
            blobs = NoBlobs,
            clock = { now },
            onSharedPurge = { purged += 1 },
        )

        val result = subject.request(SyncTrigger.INTERVAL).single()

        assertEquals("shared_residency_violation", result.error?.code)
        assertEquals(SyncPhase.PULL_CHANGES, result.stoppedAt)
        assertEquals(0L, store.appliedCursor)
        assertEquals(0L, store.ackedCursor)
        assertTrue(transport.ackedCursors.isEmpty())
        assertTrue(store.appliedPages.isEmpty())
        assertEquals(1, purged)
    }

    @Test
    fun `bootstrap owner rejection does not persist snapshot cursor or staged rows`() = runTest {
        val transport = FakeSyncTransport()
        transport.bootstrapPages.add(
            ApiResult.Success(
                BootstrapPage(
                    bootstrapId = "boot-owner-invalid",
                    snapshotCursor = 90,
                    nextPageToken = null,
                    complete = true,
                    entities = listOf(change(1)),
                ),
                null,
            ),
        )
        val store = FakeSyncLocalStore(BindingState.BOUND_NEEDS_BOOTSTRAP)
        store.stageBootstrapFailure = ResidencyViolationException("owner has wrong type")
        var purged = 0
        val subject = SyncActor(
            transport = transport,
            store = store,
            sealer = NoSealer,
            blobs = NoBlobs,
            clock = { now },
            onSharedPurge = { purged += 1 },
        )

        val result = subject.request(SyncTrigger.BIND_COMPLETE).single()

        assertEquals("shared_residency_violation", result.error?.code)
        assertEquals(SyncPhase.BOOTSTRAP_PAGE, result.stoppedAt)
        assertTrue(store.snapshotCursorWrites.isEmpty())
        assertTrue(store.stagedGenerations.isEmpty())
        assertTrue(store.promotedGenerations.isEmpty())
        assertEquals(0L, store.appliedCursor)
        assertEquals(1, purged)
    }

    @Test
    fun `blocked blob transport is reported rather than silently skipped`() = runTest {
        val transport = FakeSyncTransport()
        val store = FakeSyncLocalStore(BindingState.IDLE)
        val blocked = object : BlobTransferPort {
            override suspend fun drain(): BlobDrainResult =
                BlobDrainResult(completed = 0, pending = 3, blocked = true)
        }

        val result = actor(transport, store, blobs = blocked).request(SyncTrigger.INTERVAL).single()

        assertTrue(result.blobsBlocked)
        // A blocked blob queue must not fail the round: the metadata still syncs.
        assertTrue(result.succeeded)
    }

    @Test
    fun `a retryable failure records the next eligible time`() = runTest {
        val transport = FakeSyncTransport()
        transport.capabilitiesResult = ApiResult.Failure(
            MobileError.local("server_unavailable", "maintenance", retryable = true),
        )
        val store = FakeSyncLocalStore(BindingState.IDLE)

        actor(transport, store).request(SyncTrigger.INTERVAL)

        assertEquals("server_unavailable", store.recordedFailures.single().code)
        assertEquals(now + 1_000L, store.nextEligibleAt)
    }

    @Test
    fun `a non-retryable failure schedules no automatic retry`() = runTest {
        val transport = FakeSyncTransport()
        transport.capabilitiesResult = ApiResult.Failure(MobileError.local("client_revoked", "device gone"))
        val store = FakeSyncLocalStore(BindingState.IDLE)

        val result = actor(transport, store).request(SyncTrigger.INTERVAL).single()

        assertEquals(BindingState.REVOKED, result.endState)
        assertEquals(null, store.nextEligibleAt)
    }

    private fun change(
        seq: Long,
        entityType: String = "connection",
        entityId: String = "c-1",
        action: SyncAction = SyncAction.UPSERT,
        revision: Long = 1,
    ): SyncChange = SyncChange(
        changeSeq = seq,
        entityType = entityType,
        entityId = entityId,
        action = action,
        revision = revision,
        changedAt = 0,
    )

    private suspend fun assertMalformedPush(response: PushResponse) {
        val transport = FakeSyncTransport()
        transport.pushResponses.add(ApiResult.Success(response, null))
        val store = FakeSyncLocalStore(BindingState.IDLE)
        store.queue.add(pendingOp("op-1", entityId = "c-1"))
        store.queue.add(pendingOp("op-2", entityId = "c-2"))

        val result = actor(transport, store).request(SyncTrigger.MANUAL).single()

        assertEquals("malformed_response", result.error?.code)
        assertEquals(listOf("op-1", "op-2"), store.queue.map { it.opId })
        assertTrue(store.completed.isEmpty())
        assertTrue(store.droppedOpIds.isEmpty())
        assertTrue(store.conflicts.isEmpty())
        assertTrue(transport.ackedCursors.isEmpty())
    }

    private fun acceptedReceipt(opId: String, entityId: String): PushResult = PushResult(
        opId = opId,
        status = PushStatus.ACCEPTED,
        entityId = entityId,
        revision = 2,
        changeSeq = 2,
    )

    private fun payload(vararg pairs: Pair<String, String>): JsonObject =
        JsonObject(pairs.associate { (key, value) -> key to JsonPrimitive(value) })
}
