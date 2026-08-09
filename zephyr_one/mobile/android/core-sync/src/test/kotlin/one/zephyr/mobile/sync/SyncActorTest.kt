package one.zephyr.mobile.sync

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import one.zephyr.mobile.contracts.BindingState
import one.zephyr.mobile.contracts.PushStatus
import one.zephyr.mobile.contracts.SyncAction
import one.zephyr.mobile.contracts.SyncPhase
import one.zephyr.mobile.model.BootstrapPage
import one.zephyr.mobile.model.ChangePage
import one.zephyr.mobile.model.MobileError
import one.zephyr.mobile.model.PushResponse
import one.zephyr.mobile.model.PushResult
import one.zephyr.mobile.model.SyncChange
import one.zephyr.mobile.model.SyncTrigger
import one.zephyr.mobile.network.ApiResult
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
    ) = SyncActor(
        transport = transport,
        store = store,
        sealer = sealer,
        blobs = blobs,
        clock = { now },
        batchIdFactory = { "batch-fixed" },
        jitter = { 1.0 },
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
                    results = listOf(PushResult(opId = "op-1", status = PushStatus.ACCEPTED, revision = 2)),
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
                        PushResult(opId = "op-1", status = PushStatus.ACCEPTED, entityId = "c-1", revision = 7),
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
                    results = listOf(PushResult(opId = "op-1", status = PushStatus.DUPLICATE, revision = 4)),
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
                            revision = 9,
                            serverPayload = payload("name" to "server wins"),
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
                            revision = 9,
                            error = MobileError.local("forbidden_resource_edit", "no edit capability"),
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
                ChangePage(fromCursor = 0, nextCursor = 30, hasMore = false, changes = listOf(change(30, revision = 2))),
                null,
            ),
        )
        transport.ackResult = ApiResult.Failure(MobileError.local("server_unavailable", "down", retryable = true))
        val store = FakeSyncLocalStore(BindingState.IDLE)

        val result = actor(transport, store).request(SyncTrigger.INTERVAL).single()

        // Applied locally, but the server was not told, so the change will be re-sent next round.
        assertEquals(30L, store.appliedCursor)
        assertEquals(0L, store.ackedCursor)
        assertEquals(SyncPhase.ACK_CURSOR, result.stoppedAt)
        assertNotNull(result.error)
    }

    @Test
    fun `an empty change page still honours the server cursor`() = runTest {
        val transport = FakeSyncTransport()
        transport.changePages.add(
            ApiResult.Success(ChangePage(fromCursor = 5, nextCursor = 11, hasMore = false, changes = emptyList()), null),
        )
        val store = FakeSyncLocalStore(BindingState.IDLE)
        store.appliedCursor = 5

        actor(transport, store).request(SyncTrigger.INTERVAL)

        // Letting the cursor advance is what allows the server to prune its change log.
        assertEquals(11L, store.appliedCursor)
        assertEquals(11L, store.ackedCursor)
    }

    @Test
    fun `multiple change pages are drained in one round`() = runTest {
        val transport = FakeSyncTransport()
        transport.changePages.add(
            ApiResult.Success(
                ChangePage(fromCursor = 0, nextCursor = 10, hasMore = true, changes = listOf(change(10))),
                null,
            ),
        )
        transport.changePages.add(
            ApiResult.Success(
                ChangePage(fromCursor = 10, nextCursor = 20, hasMore = false, changes = listOf(change(20, entityId = "c-2"))),
                null,
            ),
        )
        val store = FakeSyncLocalStore(BindingState.IDLE)

        val result = actor(transport, store).request(SyncTrigger.INTERVAL).single()

        assertEquals(listOf(0L, 10L), transport.changeCursors)
        assertEquals(2, result.applied)
        assertEquals(20L, store.appliedCursor)
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
    fun `a sealable secret travels as an envelope keyed by opId`() = runTest {
        val transport = FakeSyncTransport()
        val store = FakeSyncLocalStore(BindingState.IDLE)
        store.queue.add(pendingOp("op-1", fieldMask = listOf("name"), secretFields = listOf("password")))
        transport.pushResponses.add(
            ApiResult.Success(
                PushResponse(
                    batchId = "batch-fixed",
                    serverCursor = 1,
                    results = listOf(PushResult(opId = "op-1", status = PushStatus.ACCEPTED, revision = 2)),
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

    private fun payload(vararg pairs: Pair<String, String>): JsonObject =
        JsonObject(pairs.associate { (key, value) -> key to JsonPrimitive(value) })
}
