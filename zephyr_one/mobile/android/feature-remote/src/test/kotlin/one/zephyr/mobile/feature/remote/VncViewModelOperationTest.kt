package one.zephyr.mobile.feature.remote

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
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
import one.zephyr.mobile.model.Protocol
import one.zephyr.mobile.protocol.vnc.RfbPixelFormat
import one.zephyr.mobile.protocol.vnc.RfbVersion
import one.zephyr.mobile.protocol.vnc.VncConnectOutcome
import one.zephyr.mobile.protocol.vnc.VncConnectRequest
import one.zephyr.mobile.protocol.vnc.VncEngine
import one.zephyr.mobile.protocol.vnc.VncFrame
import one.zephyr.mobile.protocol.vnc.VncInputEvent
import one.zephyr.mobile.protocol.vnc.VncSurfaceSize
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class VncViewModelOperationTest {

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
    fun qualityCyclesHighBalancedPerformanceAndAsksTheEngine() = runTest(mainDispatcher) {
        val engine = RecordingEngine()
        val vm = viewModel(engine)
        backgroundScope.launch { vm.state.collect { } }
        runCurrent()
        vm.connect()
        runCurrent()

        assertEquals(RfbPixelFormat.RGB888, engine.lastRequest?.preferredPixelFormat)
        assertEquals("高质量", content(vm).pixelFormatLabel)

        vm.cycleQuality()
        runCurrent()
        assertEquals(RfbPixelFormat.RGB565, engine.lastFormat)
        assertEquals("平衡", content(vm).pixelFormatLabel)

        vm.cycleQuality()
        runCurrent()
        assertEquals(RfbPixelFormat.RGB555, engine.lastFormat)
        assertEquals("性能", content(vm).pixelFormatLabel)

        vm.cycleQuality()
        runCurrent()
        assertEquals(RfbPixelFormat.RGB888, engine.lastFormat)
        assertEquals("高质量", content(vm).pixelFormatLabel)
        vm.disconnect()
        runCurrent()
    }

    @Test
    fun engineLatencySamplesReachTheStatusPillAndTheRegistry() = runTest(mainDispatcher) {
        val engine = RecordingEngine()
        val registry = SessionRegistry()
        val vm = viewModel(engine, registry)
        backgroundScope.launch { vm.state.collect { } }
        runCurrent()
        vm.connect()
        runCurrent()
        assertNull(content(vm).status.latencyMs)

        engine.latency.tryEmit(18L)
        runCurrent()
        assertEquals(18L, content(vm).status.latencyMs)
        assertEquals(18L, registry.find("s1")?.latencyMs)

        engine.latency.tryEmit(41L)
        runCurrent()
        assertEquals(41L, content(vm).status.latencyMs)
        vm.disconnect()
        runCurrent()
    }

    @Test
    fun disconnectClosesTheRegistryRowSoTheHostCanPopTheWindow() = runTest(mainDispatcher) {
        val registry = SessionRegistry()
        val engine = RecordingEngine()
        val vm = viewModel(engine, registry)
        backgroundScope.launch { vm.state.collect { } }
        runCurrent()
        vm.connect()
        runCurrent()
        val closed = async { vm.message.first() }
        vm.disconnect()
        runCurrent()
        assertEquals(SessionTransport.CLOSED, registry.find("s1")?.transport)
        assertEquals(1, engine.disconnects)
        assertEquals(VncViewModel.SESSION_CLOSED, closed.await())
    }

    @Test
    fun compactStatusUsesDashUntilASampleArrives() {
        assertEquals("— · — · —", VncDemoStatus.statusText(null, 0, 0, null))
        assertEquals("18 ms · 1440×900 · 高质量", VncDemoStatus.statusText(18, 1440, 900, "高质量"))
        assertFalse(VncDemoStatus.statusText(null, 0, 0, null).contains("0 ms"))
    }

    private fun viewModel(
        engine: RecordingEngine,
        registry: SessionRegistry = SessionRegistry(),
    ): VncViewModel = VncViewModel(
        sessionId = "s1",
        connectionId = "c1",
        registry = registry,
        findConnection = { RemoteFixtures.connection(protocol = Protocol.VNC, port = 5900) },
        engine = engine,
        secretProvider = { RemoteCredentials() },
    )

    private fun content(vm: VncViewModel): RemoteContent {
        val state = vm.state.value
        assertTrue("expected Content, got $state", state is PageState.Content<*>)
        @Suppress("UNCHECKED_CAST")
        return (state as PageState.Content<RemoteContent>).value
    }

    private class RecordingEngine : VncEngine {
        override val isAvailable: Boolean = true
        var lastRequest: VncConnectRequest? = null
        var lastFormat: RfbPixelFormat? = null
        var disconnects = 0
        val latency = MutableSharedFlow<Long>(extraBufferCapacity = 4)

        override suspend fun connect(request: VncConnectRequest): VncConnectOutcome {
            lastRequest = request
            return VncConnectOutcome.Connected(
                version = RfbVersion.V3_8,
                securityType = 1,
                widthPx = 1440,
                heightPx = 900,
                desktopName = "vnc-lab",
                pixelFormat = request.preferredPixelFormat,
            )
        }

        override fun frames(sessionId: String): Flow<VncFrame> = emptyFlow()
        override suspend fun send(sessionId: String, event: VncInputEvent) = Unit
        override suspend fun resize(sessionId: String, widthPx: Int, heightPx: Int) =
            VncSurfaceSize(widthPx, heightPx, serverResized = false)
        override suspend fun sendClipboard(sessionId: String, text: String) = Unit
        override fun clipboard(sessionId: String): Flow<String> = emptyFlow()
        override fun latency(sessionId: String): Flow<Long> = latency
        override suspend fun setPixelFormat(sessionId: String, format: RfbPixelFormat): RfbPixelFormat {
            lastFormat = format
            return format
        }
        override suspend fun disconnect(sessionId: String) {
            disconnects += 1
        }
    }
}
