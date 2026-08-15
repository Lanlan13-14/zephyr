package one.zephyr.mobile.feature.remote

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import one.zephyr.mobile.data.session.SessionRegistry
import one.zephyr.mobile.model.PageState
import one.zephyr.mobile.model.RdpChannel
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
    fun cycleQualityWalksDemoOrderAndStaysOnThePage() = runTest {
        val vm = viewModel()
        runCurrent()

        vm.cycleQuality()
        assertEquals(RdpQuality.PERFORMANCE, content(vm).quality)
        vm.cycleQuality()
        assertEquals(RdpQuality.QUALITY, content(vm).quality)
        vm.cycleQuality()
        assertEquals(RdpQuality.BALANCED, content(vm).quality)
    }

    @Test
    fun connectSendsTheCycledQualityAndFpsToTheEngine() = runTest {
        val engine = RecordingEngine()
        val vm = viewModel(engine = engine)
        runCurrent()
        vm.cycleQuality()
        vm.cycleFps()
        runCurrent()
        vm.connect()
        runCurrent()

        val request = requireNotNull(engine.lastRequest)
        assertEquals(RdpQuality.PERFORMANCE, request.quality)
        assertEquals(RdpFps.F45, request.fps)
        assertEquals(RdpConnectOutcome.Connected::class, engine.lastOutcome!!::class)
    }

    @Test
    fun connectBeforeTheConnectionLoadsIsFlushedAfterInit() = runTest {
        val engine = RecordingEngine()
        val vm = viewModel(engine = engine)
        vm.connect()
        assertEquals(null, engine.lastRequest)
        runCurrent()
        assertEquals(RemoteFixtures.connection().host, engine.lastRequest?.host)
        assertEquals(RdpConnectOutcome.Connected::class, engine.lastOutcome!!::class)
    }

    @Test
    fun disconnectClosesTheRegistryRowSoTheHostCanPopTheWindow() = runTest {
        val registry = SessionRegistry()
        val engine = RecordingEngine()
        val vm = viewModel(engine = engine, registry = registry)
        runCurrent()
        vm.connect()
        runCurrent()
        val closed = async { vm.message.first() }
        vm.disconnect()
        runCurrent()
        assertEquals(one.zephyr.mobile.data.session.SessionTransport.CLOSED, registry.find("s1")?.transport)
        assertEquals(1, engine.disconnects)
        assertEquals(RdpViewModel.SESSION_CLOSED, closed.await())
    }

    @Test
    fun sendShortcutAndCadDoNotDisconnect() = runTest {
        val engine = RecordingEngine()
        val vm = viewModel(engine = engine)
        runCurrent()
        vm.connect()
        runCurrent()
        vm.sendShortcut(RdpShortcut.WIN)
        vm.sendCad()
        runCurrent()
        assertTrue(engine.sent.isNotEmpty())
        assertEquals(0, engine.disconnects)
        assertTrue(content(vm).status.hasSurface || content(vm).status.phase.isProgressing)
    }

    private fun viewModel(
        engine: RecordingEngine = RecordingEngine(),
        registry: SessionRegistry = SessionRegistry(),
    ): RdpViewModel {
        val connection = RemoteFixtures.connection(
            rdp = RdpSettings(quality = RdpQuality.BALANCED, fps = RdpFps.F30, resolution = RdpResolution.AUTO),
        )
        return RdpViewModel(
            sessionId = "s1",
            connectionId = connection.id,
            registry = registry,
            findConnection = { connection },
            engine = engine,
            secretProvider = { "secret".toCharArray() },
            driveProfileProvider = { null },
        )
    }

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
