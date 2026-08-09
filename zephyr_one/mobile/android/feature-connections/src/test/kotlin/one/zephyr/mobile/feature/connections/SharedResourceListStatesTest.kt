package one.zephyr.mobile.feature.connections

import one.zephyr.mobile.contracts.Capability
import one.zephyr.mobile.data.repository.SharedResourceSummary
import one.zephyr.mobile.model.CapabilitySet
import one.zephyr.mobile.model.EmptyReason
import one.zephyr.mobile.model.MobileError
import one.zephyr.mobile.model.PageState
import one.zephyr.mobile.model.Residency
import one.zephyr.mobile.model.SharedUsePolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The shared-to-me list contract.
 *
 * Every case here is a way the screen could silently show something it must not: a remembered list
 * while offline, a retry button on a revoked grant, an action the grant never carried. None of them
 * fail loudly at runtime, which is why they are pinned here.
 */
class SharedResourceListStatesTest {

    private fun summary(
        id: String = "n-1",
        type: String = "note",
        name: String = "runbook",
        owner: String = "ops@example",
        capabilities: CapabilitySet = CapabilitySet.implicitShare,
        usePolicy: SharedUsePolicy = SharedUsePolicy.RELAY_ONLY,
        expiresAt: Long? = null,
    ): SharedResourceSummary = SharedResourceSummary(
        resourceType = type,
        resourceId = id,
        displayName = name,
        ownerLabel = owner,
        capabilities = capabilities,
        usePolicy = usePolicy,
        grantExpiresAt = expiresAt,
        protocol = null,
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

    /**
     * The rule that separates this list from the owned one.
     *
     * Owned rows have a Room mirror, so offline shows the cache. Shared rows have none, so a list
     * rendered offline would be data this device is not allowed to keep.
     */
    @Test
    fun `offline is terminal and never shows a cached list`() {
        val state = SharedResourceListStates.derive(listOf(summary()), online = false)
        assertEquals(PageState.OfflineNoCache, state)
    }

    /** Offline outranks a fetch error: the cause is known, so a request id is not the useful answer. */
    @Test
    fun `offline outranks a transport error`() {
        val state = SharedResourceListStates.derive(
            resources = emptyList(),
            online = false,
            error = error("http_500", retryable = true, status = 500),
        )
        assertEquals(PageState.OfflineNoCache, state)
    }

    @Test
    fun `a revoked grant is terminal rather than retryable`() {
        for (code in listOf("shared_grant_revoked", "shared_grant_expired")) {
            val state = SharedResourceListStates.derive(
                resources = emptyList(),
                error = error(code),
            )
            assertEquals("$code must be terminal", PageState.NotFoundOrRevoked, state)
        }
    }

    @Test
    fun `a retryable error offers retry`() {
        val state = SharedResourceListStates.derive(
            resources = emptyList(),
            error = error("http_503", retryable = true, status = 503),
        )
        assertTrue(state is PageState.RetryableError)
    }

    @Test
    fun `an unloaded list is loading, not empty`() {
        val state = SharedResourceListStates.derive(emptyList(), loaded = false)
        assertEquals(PageState.InitialLoading, state)
    }

    /**
     * The distinction decides which offer the screen makes: clear the search, or explain that
     * nobody has shared anything.
     */
    @Test
    fun `an empty search result is a filter outcome not an empty share set`() {
        val filtered = SharedResourceListStates.derive(listOf(summary(name = "runbook")), query = "zzz")
        assertEquals(PageState.Empty(EmptyReason.NO_MATCHING_FILTER), filtered)

        val nothingShared = SharedResourceListStates.derive(emptyList(), query = "zzz")
        assertEquals(PageState.Empty(EmptyReason.NO_DATA), nothingShared)
    }

    @Test
    fun `search matches the name and the owner label`() {
        val rows = listOf(
            summary(id = "a", name = "runbook", owner = "ops@example"),
            summary(id = "b", name = "budget", owner = "finance@example"),
        )
        assertEquals(listOf("a"), SharedResourceListStates.filter(rows, "RUN").map { it.resourceId })
        assertEquals(listOf("b"), SharedResourceListStates.filter(rows, "finance").map { it.resourceId })
        assertEquals(2, SharedResourceListStates.filter(rows, "   ").size)
    }

    /**
     * A shared resource has no local write queue at all: writes go straight to the owner's main end
     * through invoke. A pending or conflict banner here would be describing state that cannot exist.
     */
    @Test
    fun `content never claims a pending write or a conflict`() {
        val state = SharedResourceListStates.derive(listOf(summary()))
        val content = state as PageState.Content
        assertFalse(content.pendingSync)
        assertFalse(content.conflict)
        assertFalse(content.savingLocal)
    }

    @Test
    fun `every row reports shared-online-only residency`() {
        assertEquals(Residency.SHARED_ONLINE_ONLY, summary().residency)
    }
}

/** Capability gating for shared rows. Presentation only, but presenting a refused action is a bug. */
class SharedResourceActionsTest {

    private fun summary(
        capabilities: CapabilitySet,
        usePolicy: SharedUsePolicy = SharedUsePolicy.RELAY_ONLY,
        expiresAt: Long? = null,
    ): SharedResourceSummary = SharedResourceSummary(
        resourceType = "connection",
        resourceId = "c-1",
        displayName = "db",
        ownerLabel = "ops",
        capabilities = capabilities,
        usePolicy = usePolicy,
        grantExpiresAt = expiresAt,
        protocol = "ssh",
    )

    /** VIEW means "you may see this exists", not "you may open it". */
    @Test
    fun `view alone does not permit opening a session`() {
        val viewOnly = summary(CapabilitySet(setOf(Capability.DISCOVER, Capability.VIEW)))
        assertFalse(SharedResourceActions.canOpenSession(viewOnly))
        assertTrue(SharedResourceActions.canReadContent(viewOnly))
    }

    @Test
    fun `use or observe permits opening a session`() {
        assertTrue(SharedResourceActions.canOpenSession(summary(CapabilitySet(setOf(Capability.USE)))))
        assertTrue(SharedResourceActions.canOpenSession(summary(CapabilitySet(setOf(Capability.OBSERVE)))))
    }

    /**
     * The implicit share set is discover/view/use/observe. If editing were ever implied by it, every
     * shared note would be writable by everyone it was shared with.
     */
    @Test
    fun `edit is never implied by sharing`() {
        assertFalse(SharedResourceActions.canEditContent(summary(CapabilitySet.implicitShare)))
        assertTrue(SharedResourceActions.canEditContent(summary(CapabilitySet(setOf(Capability.EDIT)))))
    }

    @Test
    fun `direct use is the only policy that puts material on the device`() {
        val relay = summary(CapabilitySet.implicitShare, SharedUsePolicy.RELAY_ONLY)
        val direct = summary(CapabilitySet.implicitShare, SharedUsePolicy.DIRECT_ALLOWED)
        assertFalse(SharedResourceActions.materialTouchesDevice(relay))
        assertTrue(SharedResourceActions.materialTouchesDevice(direct))
    }

    /** A null expiry means the owner set no deadline, not that the grant is dead. */
    @Test
    fun `an open-ended grant is inside its window`() {
        assertTrue(SharedResourceActions.isWithinGrantWindow(summary(CapabilitySet.implicitShare), 1_000L))
    }

    @Test
    fun `an elapsed grant is outside its window`() {
        val expiring = summary(CapabilitySet.implicitShare, expiresAt = 500L)
        assertTrue(SharedResourceActions.isWithinGrantWindow(expiring, 400L))
        assertFalse(SharedResourceActions.isWithinGrantWindow(expiring, 600L))
    }
}
