package one.zephyr.mobile.feature.connections

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import one.zephyr.mobile.data.repository.SharedResourceStore
import one.zephyr.mobile.model.CapabilitySet
import one.zephyr.mobile.model.EmptyReason
import one.zephyr.mobile.model.MobileError
import one.zephyr.mobile.model.PageState
import one.zephyr.mobile.model.SharedUsePolicy
import one.zephyr.mobile.network.ApiResult
import one.zephyr.mobile.network.NetworkState
import one.zephyr.mobile.network.SharedResource
import one.zephyr.mobile.sync.SharedResourceCoordinator
import one.zephyr.mobile.sync.SharedResourceFetcher
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * S11's ViewModel.
 *
 * This is the class that makes the /shared endpoints reachable: before it existed nothing called
 * SharedResourceCoordinator.refresh(), so the store stayed empty forever. The assertions worth
 * having are about what it refuses to do -- no local write of any kind, no overlapping refresh, no
 * duplicated error reporting -- plus the residency rules it inherits.
 *
 * Built on a real [SharedResourceCoordinator] over a fake fetcher rather than a fake coordinator:
 * the coordinator is a final class, and going through the real one also proves the two agree about
 * replace-vs-merge and expiry rather than only about the happy path.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class SharedResourceListViewModelTest {

    private val mainDispatcher = UnconfinedTestDispatcher()

    @Before
    fun setUp() {
        /* viewModelScope is hard-wired to Dispatchers.Main.immediate, so refresh() cannot run at all
         * without this. Unconfined rather than Standard so a launched fetch has completed by the time
         * the test body reads the state. */
        Dispatchers.setMain(mainDispatcher)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    // ---- helpers ---------------------------------------------------------------------------------

    private class FakeFetcher : SharedResourceFetcher {
        val listResults = ArrayDeque<ApiResult<List<SharedResource>>>()
        val detailResults = ArrayDeque<ApiResult<SharedResource>>()
        var listCalls = 0

        /** Set to block the next list() so an overlapping refresh is observable. */
        var gate: CompletableDeferred<Unit>? = null

        override suspend fun list(): ApiResult<List<SharedResource>> {
            listCalls += 1
            gate?.await()
            return listResults.removeFirstOrNull()
                ?: ApiResult.Success(emptyList(), requestId = null)
        }

        override suspend fun detail(resourceType: String, resourceId: String): ApiResult<SharedResource> =
            detailResults.removeFirstOrNull()
                ?: ApiResult.Failure(MobileError.local("internal_error", "no detail scripted"))
    }

    private fun resource(
        id: String = "n-1",
        type: String = "note",
        name: String = "runbook",
        owner: String = "ops@example",
        capabilities: CapabilitySet = CapabilitySet.implicitShare,
        expiresAt: Long? = null,
    ): SharedResource = SharedResource(
        resourceType = type,
        resourceId = id,
        displayName = name,
        ownerDisplayName = owner,
        capabilities = capabilities,
        expiresAt = expiresAt,
        usePolicy = SharedUsePolicy.RELAY_ONLY,
        revision = 3,
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

    private fun viewModel(
        fetcher: FakeFetcher,
        online: Boolean = true,
        now: Long = 1_000L,
    ): SharedResourceListViewModel = SharedResourceListViewModel(
        coordinator = SharedResourceCoordinator(fetcher, SharedResourceStore()) { now },
        network = MutableStateFlow(NetworkState(connected = online, unmetered = true)),
    )

    // ---- tests -----------------------------------------------------------------------------------

    /**
     * state is a WhileSubscribed StateFlow, so it computes nothing until something collects it.
     * Reading state.value without a collector would assert against the InitialLoading seed forever.
     */
    private fun TestScope.collecting(
        subject: SharedResourceListViewModel,
    ) {
        backgroundScope.launch { subject.state.collect { } }
        runCurrent()
    }

    @Test
    fun `refresh fetches the list and publishes content`() = runTest(mainDispatcher) {
        val fetcher = FakeFetcher()
        fetcher.listResults.add(ApiResult.Success(listOf(resource()), requestId = null))
        val subject = viewModel(fetcher)
        collecting(subject)

        subject.refresh()
        runCurrent()

        assertEquals(1, fetcher.listCalls)
        val content = subject.state.value as PageState.Content
        assertEquals(listOf("n-1"), content.value.map { it.resourceId })
    }

    /**
     * The state must be a spinner before the first fetch resolves, not "nobody shared anything".
     *
     * The two are different statements and the screen renders them differently, so collapsing them
     * would tell the user the list is empty while the request is still in flight.
     */
    @Test
    fun `the initial state is loading rather than empty`() = runTest(mainDispatcher) {
        val subject = viewModel(FakeFetcher())
        collecting(subject)

        assertEquals(PageState.InitialLoading, subject.state.value)
    }

    /** Owned rows have a mirror; shared rows do not, so offline is terminal for this screen. */
    @Test
    fun `offline is terminal`() = runTest(mainDispatcher) {
        val fetcher = FakeFetcher()
        fetcher.listResults.add(ApiResult.Success(listOf(resource()), requestId = null))
        val subject = viewModel(fetcher, online = false)
        collecting(subject)

        subject.refresh()
        runCurrent()

        assertEquals(PageState.OfflineNoCache, subject.state.value)
    }

    /**
     * Two concurrent full-replace refreshes would race on the store, and the loser would install a
     * list the server has already superseded. The second call is dropped, not queued.
     */
    @Test
    fun `an overlapping refresh is dropped rather than queued`() = runTest(mainDispatcher) {
        val fetcher = FakeFetcher()
        fetcher.gate = CompletableDeferred()
        fetcher.listResults.add(ApiResult.Success(listOf(resource()), requestId = null))
        val subject = viewModel(fetcher)
        collecting(subject)

        subject.refresh()
        runCurrent()
        assertTrue("the first fetch must be in flight", subject.isRefreshing.value)

        subject.refresh()
        runCurrent()
        assertEquals("the second call must not reach the API", 1, fetcher.listCalls)

        fetcher.gate?.complete(Unit)
        runCurrent()
        assertFalse(subject.isRefreshing.value)
    }

    /** The flag must clear even when the fetch fails, or the next pull-to-refresh is dead. */
    @Test
    fun `the refreshing flag clears after a failure`() = runTest(mainDispatcher) {
        val fetcher = FakeFetcher()
        fetcher.listResults.add(ApiResult.Failure(error("http_503", retryable = true, status = 503)))
        val subject = viewModel(fetcher)
        collecting(subject)

        subject.refresh()
        runCurrent()

        assertFalse(subject.isRefreshing.value)
        assertTrue(subject.state.value is PageState.RetryableError)
    }

    /**
     * A revoked grant is terminal and gets a message; a retryable error is not and does not.
     *
     * The retryable branch already renders its own banner with a request id, so emitting a snackbar
     * too would report one failure twice.
     */
    @Test
    fun `only a revocation emits a message`() = runTest(mainDispatcher) {
        val fetcher = FakeFetcher()
        fetcher.listResults.add(ApiResult.Failure(error("http_503", retryable = true, status = 503)))
        fetcher.listResults.add(ApiResult.Failure(error("shared_grant_revoked")))
        val subject = viewModel(fetcher)
        collecting(subject)

        val seen = mutableListOf<String>()
        backgroundScope.launch { subject.message.collect { seen.add(it) } }
        runCurrent()

        subject.refresh()
        runCurrent()
        assertEquals(emptyList<String>(), seen)

        subject.refresh()
        runCurrent()
        assertEquals(listOf(SharedResourceListViewModel.MSG_REVOKED), seen)
        assertEquals(PageState.NotFoundOrRevoked, subject.state.value)
    }

    @Test
    fun `the query filters the visible rows without refetching`() = runTest(mainDispatcher) {
        val fetcher = FakeFetcher()
        fetcher.listResults.add(
            ApiResult.Success(
                listOf(resource(id = "a", name = "runbook"), resource(id = "b", name = "budget")),
                requestId = null,
            ),
        )
        val subject = viewModel(fetcher)
        collecting(subject)

        subject.refresh()
        runCurrent()

        subject.setQuery("run")
        runCurrent()

        val content = subject.state.value as PageState.Content
        assertEquals(listOf("a"), content.value.map { it.resourceId })
        assertEquals("filtering must not hit the network", 1, fetcher.listCalls)
    }

    /** An empty search result is a filter outcome, not an empty share set. */
    @Test
    fun `a query matching nothing reports a filter miss`() = runTest(mainDispatcher) {
        val fetcher = FakeFetcher()
        fetcher.listResults.add(ApiResult.Success(listOf(resource(name = "runbook")), requestId = null))
        val subject = viewModel(fetcher)
        collecting(subject)

        subject.refresh()
        runCurrent()
        subject.setQuery("zzz")
        runCurrent()

        assertEquals(PageState.Empty(EmptyReason.NO_MATCHING_FILTER), subject.state.value)
    }

    @Test
    fun `an empty share set reports no data`() = runTest(mainDispatcher) {
        val fetcher = FakeFetcher()
        fetcher.listResults.add(ApiResult.Success(emptyList(), requestId = null))
        val subject = viewModel(fetcher)
        collecting(subject)

        subject.refresh()
        runCurrent()

        assertEquals(PageState.Empty(EmptyReason.NO_DATA), subject.state.value)
    }

    /**
     * A grant whose window closed must not be shown as live.
     *
     * Exercised through the real coordinator, so this also proves the ViewModel does not resurrect a
     * row the coordinator purged.
     */
    @Test
    fun `an expired grant never reaches the screen`() = runTest(mainDispatcher) {
        val fetcher = FakeFetcher()
        fetcher.listResults.add(
            ApiResult.Success(
                listOf(resource(id = "live", expiresAt = 5_000L), resource(id = "dead", expiresAt = 500L)),
                requestId = null,
            ),
        )
        val subject = viewModel(fetcher, now = 1_000L)
        collecting(subject)

        subject.refresh()
        runCurrent()

        val content = subject.state.value as PageState.Content
        assertEquals(listOf("live"), content.value.map { it.resourceId })
    }

    /**
     * Content must never claim a pending write or a conflict.
     *
     * Both describe a local write queue, and a shared resource has none: every write goes straight to
     * the owner's main end through invoke.
     */
    @Test
    fun `content never claims a pending write`() = runTest(mainDispatcher) {
        val fetcher = FakeFetcher()
        fetcher.listResults.add(ApiResult.Success(listOf(resource()), requestId = null))
        val subject = viewModel(fetcher)
        collecting(subject)

        subject.refresh()
        runCurrent()

        val content = subject.state.value as PageState.Content
        assertFalse(content.pendingSync)
        assertFalse(content.conflict)
        assertFalse(content.savingLocal)
    }

    /** A detail read that 404s drops the row, because a stale row offers an action that cannot work. */
    @Test
    fun `refreshing one revoked row removes it and reports it`() = runTest(mainDispatcher) {
        val fetcher = FakeFetcher()
        fetcher.listResults.add(
            ApiResult.Success(listOf(resource(id = "a"), resource(id = "b")), requestId = null),
        )
        fetcher.detailResults.add(ApiResult.Failure(error("shared_grant_revoked")))
        val subject = viewModel(fetcher)
        collecting(subject)

        val seen = mutableListOf<String>()
        backgroundScope.launch { subject.message.collect { seen.add(it) } }
        runCurrent()

        subject.refresh()
        runCurrent()
        val before = subject.state.value as PageState.Content
        val target = before.value.first { it.resourceId == "a" }

        subject.refreshOne(target)
        runCurrent()

        val after = subject.state.value as PageState.Content
        assertEquals(listOf("b"), after.value.map { it.resourceId })
        assertEquals(listOf(SharedResourceListViewModel.MSG_REVOKED), seen)
    }

    /**
     * The ViewModel exposes no local write intent at all.
     *
     * Asserted by reflection because the absence is the contract: a shared resource has no mirror row
     * to delete and no write queue to hold a favourite, so any such method would be a residency bug
     * rather than a missing feature. A compile-time check is not possible for a method that does not
     * exist, and a reviewer adding one would otherwise see nothing fail.
     */
    @Test
    fun `the view model exposes no local write intents`() {
        val forbidden = setOf("delete", "toggleFavourite", "save", "update", "create", "syncNow")
        val declared = SharedResourceListViewModel::class.java.declaredMethods.map { it.name }.toSet()
        for (name in forbidden) {
            assertFalse(
                "a shared resource has no local write queue; " + name + "() must not exist",
                declared.contains(name),
            )
        }
    }
}
