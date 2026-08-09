package one.zephyr.mobile.feature.sessions

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
import one.zephyr.mobile.data.session.SessionAction
import one.zephyr.mobile.data.session.SessionActions
import one.zephyr.mobile.data.session.SessionGroup
import one.zephyr.mobile.data.session.SessionRegistry
import one.zephyr.mobile.data.session.SessionRow
import one.zephyr.mobile.data.session.SessionSnapshot
import one.zephyr.mobile.data.session.SessionTransport
import one.zephyr.mobile.model.Connection
import one.zephyr.mobile.model.PageState
import one.zephyr.mobile.model.Protocol
import one.zephyr.mobile.network.NetworkState
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * S20's ViewModel.
 *
 * The assertions worth having here are the ones about what this class refuses to do: restoring a
 * workspace must not dial, a row action must be re-gated rather than trusted from the screen, and a
 * close must land in 历史任务 even when the socket teardown throws. Everything else is the registry's
 * behaviour and is tested there.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class SessionListViewModelTest {

    private val mainDispatcher = UnconfinedTestDispatcher()

    @Before
    fun setUp() {
        // viewModelScope is hard-wired to Dispatchers.Main.immediate, so the restore in init cannot
        // run at all without this. Unconfined rather than Standard because init must have finished
        // by the time the test body reads the registry.
        Dispatchers.setMain(mainDispatcher)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    // ---- helpers ---------------------------------------------------------------------------------

    private fun snapshot(
        sessionId: String = "s1",
        connectionId: String = "c1",
        protocol: Protocol = Protocol.SSH,
        name: String = "prod-web",
        host: String = "10.0.0.1",
        port: Int = 22,
        startedAt: Long = 1_000L,
        endedAt: Long? = null,
    ) = SessionSnapshot(
        sessionId = sessionId,
        connectionId = connectionId,
        protocol = protocol,
        name = name,
        host = host,
        port = port,
        startedAt = startedAt,
        endedAt = endedAt,
    )

    private fun viewModel(
        registry: SessionRegistry,
        connections: Map<String, Connection> = emptyMap(),
        online: Boolean = true,
        closeTransport: suspend (SessionRow) -> Unit = {},
        loadWorkspace: suspend () -> List<SessionSnapshot> = { emptyList() },
    ) = SessionListViewModel(
        registry = registry,
        findConnection = { id -> connections[id] },
        ownerUserId = "u1",
        network = MutableStateFlow(NetworkState(connected = online, unmetered = true)),
        closeTransport = closeTransport,
        loadWorkspace = loadWorkspace,
        clock = { NOW },
    )

    /**
     * state is a WhileSubscribed StateFlow, so it computes nothing until something collects it.
     * Reading state.value without this would assert against the InitialLoading seed forever.
     */
    private fun TestScope.subscribe(subject: SessionListViewModel) {
        backgroundScope.launch { subject.state.collect {} }
        runCurrent()
    }

    /** Events replay nothing, so the collector has to exist before the action that emits. */
    private fun TestScope.collectEvents(subject: SessionListViewModel): List<SessionListEvent> {
        val seen = mutableListOf<SessionListEvent>()
        backgroundScope.launch { subject.event.collect { seen += it } }
        runCurrent()
        return seen
    }

    private fun TestScope.collectMessages(subject: SessionListViewModel): List<String> {
        val seen = mutableListOf<String>()
        backgroundScope.launch { subject.message.collect { seen += it } }
        runCurrent()
        return seen
    }

    private fun contentOf(state: PageState<SessionListContent>): SessionListContent {
        assertTrue("expected Content but was " + state, state is PageState.Content)
        return (state as PageState.Content).value
    }

    // ---- restore ---------------------------------------------------------------------------------

    @Test
    fun restoringAWorkspaceProducesDisconnectedTabsThatNeverDial() = runTest(mainDispatcher) {
        val registry = SessionRegistry()
        val subject = viewModel(
            registry = registry,
            connections = mapOf("c1" to SessionFixtures.connection()),
            loadWorkspace = { listOf(snapshot()) },
        )
        subscribe(subject)

        val row = registry.find("s1")!!
        // The frozen 不自动连接 rule expressed as an assertion: a restored tab is disconnected and
        // says where it came from, so the UI has to offer 重连 as a user action.
        assertEquals(SessionTransport.DISCONNECTED, row.transport)
        assertTrue(row.restoredFromWorkspace)
        assertEquals(SessionGroup.RESUMABLE, row.group)
        assertFalse(row.revoked)
        assertEquals(1, contentOf(subject.state.value).total)
    }

    @Test
    fun aSnapshotWhoseConnectionIsGoneComesBackRevoked() = runTest(mainDispatcher) {
        val registry = SessionRegistry()
        // No entry for c1: the grant was revoked, or the connection deleted, while the app was dead.
        val subject = viewModel(registry = registry, loadWorkspace = { listOf(snapshot()) })
        subscribe(subject)

        val row = registry.find("s1")!!
        assertTrue(row.revoked)
        assertEquals(SessionActions.REASON_REVOKED, row.revokedReason)
        // A reconnect button resolved from a stale persisted capability set would fail at the server.
        assertFalse(row.capabilities.canUse)
    }

    @Test
    fun theListStaysLoadingUntilThePersistedWorkspaceHasBeenRead() = runTest(mainDispatcher) {
        val gate = CompletableDeferred<List<SessionSnapshot>>()
        val subject = viewModel(registry = SessionRegistry(), loadWorkspace = { gate.await() })
        subscribe(subject)

        // Empty here would render 无会话 for a frame and then flash the restored tabs in.
        assertEquals(PageState.InitialLoading, subject.state.value)

        gate.complete(emptyList())
        runCurrent()

        assertTrue(subject.state.value is PageState.Empty)
    }

    @Test
    fun aFailingWorkspaceLoadStillFinishesTheRestore() = runTest(mainDispatcher) {
        val subject = viewModel(
            registry = SessionRegistry(),
            loadWorkspace = { throw IllegalStateException("corrupt workspace blob") },
        )
        subscribe(subject)

        // A workspace file that cannot be read must not leave the list spinning forever.
        assertTrue(subject.state.value is PageState.Empty)
    }

    // ---- row actions -----------------------------------------------------------------------------

    @Test
    fun restoreOnATerminalRowOpensTheTerminal() = runTest(mainDispatcher) {
        val registry = SessionRegistry()
        registry.register(SessionFixtures.row(sessionId = "s1", connectionId = "c1"))
        val subject = viewModel(registry = registry)
        val events = collectEvents(subject)

        subject.onAction(registry.find("s1")!!, SessionAction.RESTORE)
        runCurrent()

        assertEquals(listOf(SessionListEvent.OpenTerminal("s1", "c1")), events)
    }

    @Test
    fun restoreOnARemoteDesktopRowOpensTheRemoteScreen() = runTest(mainDispatcher) {
        val registry = SessionRegistry()
        registry.register(
            SessionFixtures.row(sessionId = "s2", connectionId = "c2", protocol = Protocol.RDP, port = 3389),
        )
        val subject = viewModel(registry = registry)
        val events = collectEvents(subject)

        subject.onAction(registry.find("s2")!!, SessionAction.RESTORE)
        runCurrent()

        // One list, two destinations. Routing on the protocol here is what keeps the row from having
        // to know which screen exists.
        assertEquals(listOf(SessionListEvent.OpenRemote("s2", "c2")), events)
    }

    @Test
    fun restoreMarksTheRowReadSoTheBadgeClears() = runTest(mainDispatcher) {
        val registry = SessionRegistry()
        registry.register(
            SessionFixtures.row(sessionId = "s1", unreadOutput = true, minimised = true),
        )
        val subject = viewModel(registry = registry)
        collectEvents(subject)

        subject.onAction(registry.find("s1")!!, SessionAction.RESTORE)
        runCurrent()

        val row = registry.find("s1")!!
        assertFalse(row.unreadOutput)
        assertFalse(row.minimised)
        // Reading a tab is not connecting to it.
        assertEquals(SessionTransport.CONNECTED, row.transport)
    }

    @Test
    fun reconnectEmitsAnIntentAndOpensNoTransport() = runTest(mainDispatcher) {
        val registry = SessionRegistry()
        registry.register(
            SessionFixtures.row(sessionId = "s1", transport = SessionTransport.DISCONNECTED),
        )
        val subject = viewModel(registry = registry)
        val events = collectEvents(subject)

        subject.onAction(registry.find("s1")!!, SessionAction.RECONNECT)
        runCurrent()

        assertEquals(listOf(SessionListEvent.Reconnect("s1", "c1")), events)
        // Still disconnected: the terminal screen dials after the user is looking at it, so a list
        // that could open a socket would break the frozen restore rule one refactor later.
        assertEquals(SessionTransport.DISCONNECTED, registry.find("s1")!!.transport)
    }

    @Test
    fun aRevokedRowReportsTheReasonInsteadOfActing() = runTest(mainDispatcher) {
        val registry = SessionRegistry()
        registry.register(
            SessionFixtures.row(sessionId = "s1", transport = SessionTransport.DISCONNECTED),
        )
        registry.markRevoked("s1")
        val subject = viewModel(registry = registry)
        val events = collectEvents(subject)
        val messages = collectMessages(subject)

        subject.onAction(registry.find("s1")!!, SessionAction.RECONNECT)
        runCurrent()

        assertEquals(0, events.size)
        assertEquals(listOf(SessionActions.REASON_REVOKED), messages)
    }

    // ---- close -----------------------------------------------------------------------------------

    @Test
    fun closingMovesTheRowToHistoryEvenWhenTheTeardownFails() = runTest(mainDispatcher) {
        val registry = SessionRegistry()
        registry.register(SessionFixtures.row(sessionId = "s1"))
        var attempted = 0
        val subject = viewModel(
            registry = registry,
            closeTransport = {
                attempted++
                throw IllegalStateException("socket hung on close")
            },
        )
        subscribe(subject)

        subject.close(registry.find("s1")!!)
        runCurrent()

        val row = registry.find("s1")!!
        // A socket that cannot be torn down must not leave a session sitting in 已连接 that the user
        // has no way to get rid of.
        assertEquals(SessionTransport.CLOSED, row.transport)
        assertEquals(SessionGroup.HISTORY, row.group)
        assertEquals(NOW, row.endedAt ?: 0L)
        assertEquals(1, attempted)
    }

    @Test
    fun closingARowDropsItFromTheSelection() = runTest(mainDispatcher) {
        val registry = SessionRegistry()
        registry.register(SessionFixtures.row(sessionId = "s1"))
        registry.register(SessionFixtures.row(sessionId = "s2"))
        val subject = viewModel(registry = registry)
        subject.toggleSelection("s1")
        subject.toggleSelection("s2")

        subject.close(registry.find("s1")!!)
        runCurrent()

        // A stale id in the selection would make the bulk-close confirmation overstate its count.
        assertEquals(setOf("s2"), subject.selection.value)
    }

    @Test
    fun closeAllSkipsRowsThatAreAlreadyHistory() = runTest(mainDispatcher) {
        val registry = SessionRegistry()
        registry.register(SessionFixtures.row(sessionId = "s1"))
        registry.register(SessionFixtures.row(sessionId = "s2", transport = SessionTransport.DISCONNECTED))
        registry.register(SessionFixtures.row(sessionId = "s3", transport = SessionTransport.CLOSED, endedAt = 5L))
        val torn = mutableListOf<String>()
        val subject = viewModel(registry = registry, closeTransport = { torn += it.sessionId })
        subscribe(subject)

        subject.closeAll(null)
        runCurrent()

        // s3 was already closed: closing it again would rewrite endedAt and reorder history.
        assertEquals(listOf("s1", "s2"), torn)
        assertEquals(5L, registry.find("s3")!!.endedAt ?: 0L)
        assertEquals(emptySet<String>(), subject.selection.value)
    }

    @Test
    fun closeAllWithAnExplicitSelectionClosesOnlyThatSelection() = runTest(mainDispatcher) {
        val registry = SessionRegistry()
        registry.register(SessionFixtures.row(sessionId = "s1"))
        registry.register(SessionFixtures.row(sessionId = "s2"))
        val torn = mutableListOf<String>()
        val subject = viewModel(registry = registry, closeTransport = { torn += it.sessionId })
        subscribe(subject)

        subject.closeAll(setOf("s2"))
        runCurrent()

        assertEquals(listOf("s2"), torn)
        assertEquals(SessionTransport.CONNECTED, registry.find("s1")!!.transport)
        assertEquals(SessionTransport.CLOSED, registry.find("s2")!!.transport)
    }

    // ---- persistence -----------------------------------------------------------------------------

    @Test
    fun snapshotExcludesClosedAndRevokedRows() = runTest(mainDispatcher) {
        val registry = SessionRegistry()
        registry.register(SessionFixtures.row(sessionId = "live"))
        registry.register(SessionFixtures.row(sessionId = "gone", transport = SessionTransport.CLOSED))
        registry.register(SessionFixtures.row(sessionId = "revoked"))
        registry.markRevoked("revoked")
        val subject = viewModel(registry = registry)

        val persisted = subject.snapshot()

        // History would come back as fake tabs; a revoked row would come back as a tab that cannot
        // be used and has already been explained once.
        assertEquals(listOf("live"), persisted.map { it.sessionId })
        assertNull(persisted.single().endedAt)
    }

    private companion object {
        const val NOW = 9_000L
    }
}
