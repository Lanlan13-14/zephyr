package one.zephyr.mobile.feature.remote

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import one.zephyr.mobile.data.session.SessionRegistry
import one.zephyr.mobile.data.session.SessionTransport
import one.zephyr.mobile.model.PageState
import one.zephyr.mobile.model.RdpFps
import one.zephyr.mobile.model.RdpQuality
import one.zephyr.mobile.model.RdpResolution
import one.zephyr.mobile.model.RdpSettings
import one.zephyr.mobile.protocol.rdp.RdpConnectOutcome
import one.zephyr.mobile.protocol.rdp.RdpConnectRequest
import one.zephyr.mobile.protocol.rdp.RdpEngine
import one.zephyr.mobile.protocol.rdp.RdpFrame
import one.zephyr.mobile.protocol.rdp.RdpInputEvent
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class RdpViewModelOperationTest {

    private val mainDispatcher = UnconfinedTestDispatcher()

    @Before
    fun setUp() {
        Dispatchers.setMain(mainDispatcher)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun cycleQualityWalksDemoOrderAndStaysOnThePage() = runTest(mainDispatcher) {
        val vm = viewModel()
        backgroundScope.launch { vm.state.collect { } }
        runCurrent()

        vm.cycleQuality()
        assertEquals(RdpQuality.PERFORMANCE, content(vm).quality)
        vm.cycleQuality()
        assertEquals(RdpQuality.QUALITY, content(vm).quality)
        vm.cycleQuality()
        assertEquals(RdpQuality.BALANCED, content(vm).quality)
    }

    @Test
    fun connectSendsTheCycledQualityAndFpsToTheEngine() = runTest(mainDispatcher) {
        val engine = RecordingEngine()
        val vm = viewModel(engine = engine)
        backgroundScope.launch { vm.state.collect { } }
        runCurrent()
        vm.cycleQuality()
        vm.cycleFps()
        vm.connect()
        runCurrent()

        val request = requireNotNull(engine.lastRequest)
        assertEquals(RdpQuality.PERFORMANCE, request.quality)
        assertEquals(RdpFps.F45, request.fps)
        assertEquals(RdpConnectOutcome.Connected::class, engine.lastOutcome!!::class)
        vm.disconnect()
        runCurrent()
    }

    @Test
    fun connectBeforeTheConnectionLoadsIsFlushedAfterInit() = runTest(mainDispatcher) {
        val engine = RecordingEngine()
        val loaded = CompletableDeferred<one.zephyr.mobile.model.Connection>()
        val vm = viewModel(engine = engine, findConnection = { loaded.await() })
        backgroundScope.launch { vm.state.collect { } }
        vm.connect()
        runCurrent()
        assertNull(engine.lastRequest)
        loaded.complete(RemoteFixtures.connection())
        runCurrent()
        assertEquals(RemoteFixtures.connection().host, engine.lastRequest?.host)
        assertEquals(RdpConnectOutcome.Connected::class, engine.lastOutcome!!::class)
        vm.disconnect()
        runCurrent()
    }

    @Test
    fun disconnectClosesTheRegistryRowSoTheHostCanPopTheWindow() = runTest(mainDispatcher) {
        val registry = SessionRegistry()
        val engine = RecordingEngine()
        val vm = viewModel(engine = engine, registry = registry)
        backgroundScope.launch { vm.state.collect { } }
        runCurrent()
        vm.connect()
        runCurrent()
        val closed = async { vm.message.first() }
        vm.disconnect()
        runCurrent()
        assertEquals(SessionTransport.CLOSED, registry.find("s1")?.transport)
        assertEquals(1, engine.disconnects)
        assertEquals(RdpViewModel.SESSION_CLOSED, closed.await())
    }

    @Test
    fun sendShortcutAndCadDoNotDisconnect() = runTest(mainDispatcher) {
        val engine = RecordingEngine()
        val vm = viewModel(engine = engine)
        backgroundScope.launch { vm.state.collect { } }
        runCurrent()
        vm.connect()
        runCurrent()
        vm.sendShortcut(RdpShortcut.WIN)
        vm.sendCad()
        runCurrent()
        assertTrue(engine.sent.isNotEmpty())
        assertEquals(0, engine.disconnects)
        assertTrue(content(vm).status.hasSurface || content(vm).status.phase.isProgressing)
        vm.disconnect()
        runCurrent()
    }

    private fun viewModel(
        engine: RecordingEngine = RecordingEngine(),
        registry: SessionRegistry = SessionRegistry(),
        findConnection: suspend (String) -> one.zephyr.mobile.model.Connection? = {
            RemoteFixtures.connection(
                rdp = RdpSettings(quality = RdpQuality.BALANCED, fps = RdpFps.F30, resolution = RdpResolution.AUTO),
            )
        },
    ): RdpViewModel = RdpViewModel(
        sessionId = "s1",
        connectionId = "c1",
        registry = registry,
        findConnection = findConnection,
        engine = engine,
        secretProvider = { "secret".toCharArray() },
        driveProfileProvider = { null },
    )

    private fun content(vm: RdpViewModel): RemoteContent {
        val state = vm.state.value
        assertTrue("expected Content, got $state", state is PageState.Content<*>)
        @Suppress("UNCHECKED_CAST")
        return (state as PageState.Content<RemoteContent>).value
    }

    private class RecordingEngine : RdpEngine {
        override val isAvailable: Boolean = true
        var lastRequest: RdpConnectRequest? = null
        var lastOutcome: RdpConnectOutcome? = null
        var disconnects = 0
        val sent = mutableListOf<RdpInputEvent>()

        override suspend fun connect(request: RdpConnectRequest): RdpConnectOutcome {
            lastRequest = request
            val outcome = RdpConnectOutcome.Connected(800, 600, request.channels)
            lastOutcome = outcome
            return outcome
        }

        override fun frames(sessionId: String): Flow<RdpFrame> = emptyFlow()
        override suspend fun send(sessionId: String, event: RdpInputEvent) {
            sent += event
        }
        override suspend fun resize(sessionId: String, widthPx: Int, heightPx: Int) = Unit
        override suspend fun sendClipboard(sessionId: String, text: String) = Unit
        override fun clipboard(sessionId: String): Flow<String> = emptyFlow()
        override suspend fun disconnect(sessionId: String) {
            disconnects += 1
        }
    }
}
