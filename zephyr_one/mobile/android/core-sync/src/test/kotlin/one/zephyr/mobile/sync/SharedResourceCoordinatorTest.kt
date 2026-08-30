package one.zephyr.mobile.sync

import kotlinx.coroutines.test.runTest
import one.zephyr.mobile.data.repository.SharedResourceStore
import one.zephyr.mobile.model.CapabilitySet
import one.zephyr.mobile.model.MobileError
import one.zephyr.mobile.model.SharedUsePolicy
import one.zephyr.mobile.network.ApiResult
import one.zephyr.mobile.network.SharedResource
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Scriptable [SharedResourceFetcher]. Queued so a refresh-then-fail sequence is expressible. */
private class FakeSharedResourceFetcher : SharedResourceFetcher {

    val listResults = ArrayDeque<ApiResult<List<SharedResource>>>()
    val detailResults = ArrayDeque<ApiResult<SharedResource>>()
    var listCalls = 0
    val detailRequests = mutableListOf<Pair<String, String>>()

    override suspend fun list(): ApiResult<List<SharedResource>> {
        listCalls += 1
        return listResults.removeFirstOrNull()
            ?: ApiResult.Failure(MobileError.local("internal_error", "no list scripted"))
    }

    override suspend fun detail(resourceType: String, resourceId: String): ApiResult<SharedResource> {
        detailRequests.add(resourceType to resourceId)
        return detailResults.removeFirstOrNull()
            ?: ApiResult.Failure(MobileError.local("internal_error", "no detail scripted"))
    }
}

/**
 * The seam that was missing entirely.
 *
 * Nothing in the tree called SharedResourceStore.replace(), and SharedResourceClient was constructed
 * and never used, so the store was permanently empty and the /shared endpoints were unreachable.
 * These tests pin the behaviour that makes it correct as well as present -- each case below is a way
 * the coordinator could leave a resource visible after this device lost the right to see it.
 */
class SharedResourceCoordinatorTest {

    private fun resource(
        id: String = "n-1",
        type: String = "note",
        name: String = "runbook",
        owner: String = "ops@example",
        capabilities: CapabilitySet = CapabilitySet.implicitShare,
        policy: SharedUsePolicy = SharedUsePolicy.RELAY_ONLY,
        expiresAt: Long? = null,
        protocol: String? = null,
    ): SharedResource = SharedResource(
        resourceType = type,
        resourceId = id,
        displayName = name,
        ownerDisplayName = owner,
        capabilities = capabilities,
        expiresAt = expiresAt,
        usePolicy = policy,
        revision = 3,
        protocol = protocol,
    )

    private fun error(
        code: String,
        retryable: Boolean = false,
        status: Int? = null,
    ): MobileError = MobileError(
        code = code,
        message = "m",
        retryable = retryable,
        requestId = "req-1",
        httpStatus = status,
    )

    private fun coordinator(
        fetcher: SharedResourceFetcher,
        store: SharedResourceStore = SharedResourceStore(),
        now: Long = 1_000L,
    ): Pair<SharedResourceCoordinator, SharedResourceStore> =
        SharedResourceCoordinator(fetcher, store) { now } to store

    @Test
    fun `a successful refresh fills the store and marks it loaded`() = runTest {
        val fetcher = FakeSharedResourceFetcher()
        fetcher.listResults.add(ApiResult.Success(listOf(resource()), requestId = "r"))
        val (subject, store) = coordinator(fetcher)

        assertFalse("nothing is known before the first fetch", subject.hasLoaded.value)
        subject.refresh()

        assertEquals(1, store.resources.value.size)
        assertTrue(subject.hasLoaded.value)
        assertNull(subject.error.value)
    }

    /**
     * The wire property is `ownerDisplayName`; the store property is `ownerLabel`.
     *
     * Getting this wrong is silent: kotlinx defaults a missing string, so every row would render with
     * a blank owner and the disclosure line could not say whose resource it was.
     */
    @Test
    fun `connection list rows are hydrated through online detail before they become visible`() = runTest {
        val fetcher = FakeSharedResourceFetcher()
        fetcher.listResults.add(
            ApiResult.Success(listOf(resource(id = "c-1", type = "connection", protocol = null)), requestId = null),
        )
        fetcher.detailResults.add(
            ApiResult.Success(resource(id = "c-1", type = "connection", protocol = "ssh"), requestId = null),
        )
        val (subject, store) = coordinator(fetcher)

        subject.refresh()

        assertEquals("ssh", store.resources.value.single().protocol)
        assertEquals(listOf("connection" to "c-1"), fetcher.detailRequests)
    }

    @Test
    fun `connection with no protocol is never guessed as SSH`() = runTest {
        val fetcher = FakeSharedResourceFetcher()
        fetcher.listResults.add(
            ApiResult.Success(listOf(resource(id = "c-1", type = "connection", protocol = null)), requestId = null),
        )
        fetcher.detailResults.add(
            ApiResult.Success(resource(id = "c-1", type = "connection", protocol = null), requestId = null),
        )
        val (subject, store) = coordinator(fetcher)

        subject.refresh()

        assertTrue(store.resources.value.isEmpty())
    }

    @Test
    fun `the owner display name becomes the owner label`() = runTest {
        val fetcher = FakeSharedResourceFetcher()
        fetcher.listResults.add(ApiResult.Success(listOf(resource(owner = "alice@corp")), requestId = null))
        val (subject, store) = coordinator(fetcher)

        subject.refresh()

        assertEquals("alice@corp", store.resources.value.single().ownerLabel)
    }

    /**
     * A row the server stopped returning has had its grant withdrawn, so it must leave the device on
     * the same round. Merging would keep a revoked resource visible.
     */
    @Test
    fun `a refresh replaces rather than merges`() = runTest {
        val fetcher = FakeSharedResourceFetcher()
        fetcher.listResults.add(
            ApiResult.Success(listOf(resource(id = "a"), resource(id = "b")), requestId = null),
        )
        fetcher.listResults.add(ApiResult.Success(listOf(resource(id = "a")), requestId = null))
        val (subject, store) = coordinator(fetcher)

        subject.refresh()
        assertEquals(2, store.resources.value.size)

        subject.refresh()
        assertEquals(listOf("a"), store.resources.value.map { it.resourceId })
    }

    /**
     * expiresAt is a deadline, not a delete: the server is not obliged to have filtered a grant whose
     * window closed while the response was in flight.
     */
    @Test
    fun `an expired grant is dropped on the same pass`() = runTest {
        val fetcher = FakeSharedResourceFetcher()
        fetcher.listResults.add(
            ApiResult.Success(
                listOf(resource(id = "live", expiresAt = 5_000L), resource(id = "dead", expiresAt = 500L)),
                requestId = null,
            ),
        )
        val (subject, store) = coordinator(fetcher, now = 1_000L)

        subject.refresh()

        assertEquals(listOf("live"), store.resources.value.map { it.resourceId })
    }

    /** A null expiry means the owner set no deadline, not that the grant expired. */
    @Test
    fun `an open-ended grant survives the expiry pass`() = runTest {
        val fetcher = FakeSharedResourceFetcher()
        fetcher.listResults.add(ApiResult.Success(listOf(resource(expiresAt = null)), requestId = null))
        val (subject, store) = coordinator(fetcher, now = Long.MAX_VALUE / 2)

        subject.refresh()

        assertEquals(1, store.resources.value.size)
    }

    /**
     * The distinction that matters most on failure.
     *
     * A transient 503 is not evidence the user lost access, so the list stays. Wiping it would make a
     * flaky network look like a revocation.
     */
    @Test
    fun `a retryable failure keeps the rows already held`() = runTest {
        val fetcher = FakeSharedResourceFetcher()
        fetcher.listResults.add(ApiResult.Success(listOf(resource()), requestId = null))
        fetcher.listResults.add(ApiResult.Failure(error("http_503", retryable = true, status = 503)))
        val (subject, store) = coordinator(fetcher)

        subject.refresh()
        subject.refresh()

        assertEquals(1, store.resources.value.size)
        assertEquals("http_503", subject.error.value?.code)
    }

    @Test
    fun `a revocation clears the list`() = runTest {
        val fetcher = FakeSharedResourceFetcher()
        fetcher.listResults.add(ApiResult.Success(listOf(resource()), requestId = null))
        fetcher.listResults.add(ApiResult.Failure(error("shared_grant_revoked")))
        val (subject, store) = coordinator(fetcher)

        subject.refresh()
        subject.refresh()

        assertTrue("a revoked grant must not survive in memory", store.resources.value.isEmpty())
    }

    /** A successful refresh after a failure must clear the error, or the screen stays on the error state. */
    @Test
    fun `a later success clears the recorded error`() = runTest {
        val fetcher = FakeSharedResourceFetcher()
        fetcher.listResults.add(ApiResult.Failure(error("http_503", retryable = true, status = 503)))
        fetcher.listResults.add(ApiResult.Success(listOf(resource()), requestId = null))
        val (subject, _) = coordinator(fetcher)

        subject.refresh()
        assertEquals("http_503", subject.error.value?.code)

        subject.refresh()
        assertNull(subject.error.value)
    }

    @Test
    fun `refreshing one resource replaces only that row`() = runTest {
        val fetcher = FakeSharedResourceFetcher()
        fetcher.listResults.add(
            ApiResult.Success(listOf(resource(id = "a", name = "old"), resource(id = "b")), requestId = null),
        )
        fetcher.detailResults.add(ApiResult.Success(resource(id = "a", name = "new"), requestId = null))
        val (subject, store) = coordinator(fetcher)

        subject.refresh()
        subject.refreshOne("note", "a")

        val rows = store.resources.value.associateBy { it.resourceId }
        assertEquals(2, rows.size)
        assertEquals("new", rows.getValue("a").displayName)
        assertEquals(listOf("note" to "a"), fetcher.detailRequests)
    }

    /**
     * The detail response is the first place the client learns a grant is gone. Leaving the list row
     * behind would offer an action that cannot succeed.
     */
    @Test
    fun `a 404 on detail removes the row immediately`() = runTest {
        val fetcher = FakeSharedResourceFetcher()
        fetcher.listResults.add(ApiResult.Success(listOf(resource(id = "a"), resource(id = "b")), requestId = null))
        fetcher.detailResults.add(ApiResult.Failure(error("not_found", status = 404)))
        val (subject, store) = coordinator(fetcher)

        subject.refresh()
        subject.refreshOne("note", "a")

        assertEquals(listOf("b"), store.resources.value.map { it.resourceId })
    }

    @Test
    fun `a revoked detail removes the row`() = runTest {
        val fetcher = FakeSharedResourceFetcher()
        fetcher.listResults.add(ApiResult.Success(listOf(resource(id = "a")), requestId = null))
        fetcher.detailResults.add(ApiResult.Failure(error("shared_grant_revoked")))
        val (subject, store) = coordinator(fetcher)

        subject.refresh()
        subject.refreshOne("note", "a")

        assertTrue(store.resources.value.isEmpty())
    }

    /** A transient detail failure must not drop a row the user still has access to. */
    @Test
    fun `a retryable detail failure keeps the row`() = runTest {
        val fetcher = FakeSharedResourceFetcher()
        fetcher.listResults.add(ApiResult.Success(listOf(resource(id = "a")), requestId = null))
        fetcher.detailResults.add(ApiResult.Failure(error("http_503", retryable = true, status = 503)))
        val (subject, store) = coordinator(fetcher)

        subject.refresh()
        subject.refreshOne("note", "a")

        assertEquals(listOf("a"), store.resources.value.map { it.resourceId })
    }

    /**
     * clear() resets hasLoaded as well as the rows.
     *
     * Leaving it true would make the next screen say "nobody has shared anything with you" -- a false
     * statement about the new account rather than a stale one about the old.
     */
    @Test
    fun `clear resets the loaded flag so the next screen shows a spinner`() = runTest {
        val fetcher = FakeSharedResourceFetcher()
        fetcher.listResults.add(ApiResult.Success(listOf(resource()), requestId = null))
        val (subject, store) = coordinator(fetcher)

        subject.refresh()
        assertTrue(subject.hasLoaded.value)

        subject.clear()

        assertTrue(store.resources.value.isEmpty())
        assertFalse(subject.hasLoaded.value)
        assertNull(subject.error.value)
    }

    /** The coordinator exposes the store's own flow, so the two can never disagree. */
    @Test
    fun `the exposed flow is the store flow`() = runTest {
        val fetcher = FakeSharedResourceFetcher()
        val store = SharedResourceStore()
        val (subject, _) = coordinator(fetcher, store)

        assertTrue(subject.resources === store.resources)
    }
}
