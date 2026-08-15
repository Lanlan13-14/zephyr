package one.zephyr.mobile.protocol.rdp

import java.util.concurrent.CountDownLatch
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import one.zephyr.mobile.model.RdpChannel
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidRdpEngineTest {

    @Test
    fun `missing JNI library reports unavailable without creating a session`() = runTest {
        val native = FakeNative(available = false)
        val engine = AndroidRdpEngine(native)

        val outcome = engine.connect(request()) as RdpConnectOutcome.Failed

        assertEquals(AndroidRdpEngine.ENGINE_UNAVAILABLE, outcome.error.code)
        assertEquals(0, native.createCalls)
        assertFalse(engine.isAvailable)
    }

    @Test
    fun `connect returns on connected event and disconnect joins and frees the native session`() = runTest {
        val native = FakeNative()
        val password = "secret".toCharArray()
        val engine = AndroidRdpEngine(native)

        val outcome = engine.connect(request(password = password))

        assertEquals(RdpConnectOutcome.Connected(1080, 2400, setOf(RdpChannel.CLIPBOARD)), outcome)
        assertArrayEquals(CharArray(password.size), password)
        assertEquals(1080, native.config?.widthPx)
        assertEquals(2400, native.config?.heightPx)
        assertEquals(true, native.config?.gfx)
        assertEquals(true, native.config?.disableWallpaper)
        assertEquals(30, native.config?.requestedFps)

        engine.disconnect("s1")
        assertEquals(1, native.stopCalls)
        assertEquals(1, native.freeCalls)
    }

    @Test
    fun `pointer masks become changed button events and large wheels are split`() = runTest {
        val native = FakeNative()
        val engine = AndroidRdpEngine(native)
        engine.connect(request())

        engine.send("s1", RdpInputEvent.Pointer(10, 20, buttons = 0))
        engine.send("s1", RdpInputEvent.Pointer(10, 20, buttons = 1))
        engine.send("s1", RdpInputEvent.Pointer(11, 21, buttons = 1, wheelDelta = -300))
        engine.send("s1", RdpInputEvent.Pointer(11, 21, buttons = 0))

        assertEquals(listOf("move:10:20", "button:1:true", "move:11:21", "wheel:-255", "wheel:-45", "button:1:false"), native.pointerEvents)
        engine.disconnect("s1")
    }

    @Test
    fun `supplementary Unicode is sent as an ordered UTF16 surrogate pair`() = runTest {
        val native = FakeNative()
        val engine = AndroidRdpEngine(native)
        engine.connect(request())

        engine.send("s1", RdpInputEvent.Unicode(0x1F600, down = true))

        assertEquals(listOf(0xD83D to true, 0xDE00 to true), native.unicodeEvents)
        engine.disconnect("s1")
    }

    @Test
    fun `native callbacks feed frame and clipboard flows`() = runTest {
        val native = FakeNative()
        val engine = AndroidRdpEngine(native)
        engine.connect(request())
        val frame = async { engine.frames("s1").first() }
        val clipboard = async { engine.clipboard("s1").first() }
        runCurrent()

        native.sink?.onFrame(1, 2, 1, 1, byteArrayOf(1, 2, 3, 4))
        native.sink?.onClipboard("text")

        assertEquals(RdpFrame(1, 2, 1, 1, byteArrayOf(1, 2, 3, 4)), frame.await())
        assertEquals("text", clipboard.await())
        engine.disconnect("s1")
    }

    @Test
    fun `drive and unimplemented channels fail before JNI`() = runTest {
        val native = FakeNative()
        val engine = AndroidRdpEngine(native)

        val drive = engine.connect(
            request().copyForTest(drive = RdpDriveMapping("PHONE", "tree", true)),
        ) as RdpConnectOutcome.Failed
        val camera = engine.connect(
            request().copyForTest(channels = setOf(RdpChannel.CAMERA)),
        ) as RdpConnectOutcome.Failed

        assertEquals(AndroidRdpEngine.DRIVE_UNSUPPORTED, drive.error.code)
        assertEquals(AndroidRdpEngine.CHANNEL_UNSUPPORTED, camera.error.code)
        assertEquals(0, native.createCalls)
    }

    @Test
    fun `performance quality disables gfx and font smoothing`() = runTest {
        val native = FakeNative()
        val engine = AndroidRdpEngine(native)

        engine.connect(request().copyForTest(quality = one.zephyr.mobile.model.RdpQuality.PERFORMANCE))

        assertEquals(false, native.config?.gfx)
        assertEquals(false, native.config?.allowFontSmoothing)
        assertEquals(true, native.config?.disableWallpaper)
        engine.disconnect("s1")
    }

    private fun request(password: CharArray? = null) = RdpConnectRequest(
        sessionId = "s1",
        host = "server",
        port = 3389,
        username = "user",
        domain = "",
        password = password,
        widthPx = 1081,
        heightPx = 2401,
        channels = setOf(RdpChannel.CLIPBOARD),
        drive = null,
    )

    private fun RdpConnectRequest.copyForTest(
        channels: Set<RdpChannel> = this.channels,
        drive: RdpDriveMapping? = this.drive,
        quality: one.zephyr.mobile.model.RdpQuality = this.quality,
    ) = RdpConnectRequest(
        sessionId, host, port, username, domain, password, widthPx, heightPx, channels, drive, quality, fps,
    )

    private class FakeNative(private val available: Boolean = true) : RdpNativeBridge {
        private val stopped = CountDownLatch(1)
        @Volatile var sink: NativeRdpSink? = null
        @Volatile var config: NativeRdpConfig? = null
        @Volatile var createCalls = 0
        @Volatile var stopCalls = 0
        @Volatile var freeCalls = 0
        val pointerEvents = mutableListOf<String>()
        val unicodeEvents = mutableListOf<Pair<Int, Boolean>>()

        override val isAvailable: Boolean get() = available
        override val unavailableReason: String? get() = if (available) null else "not packaged"

        override fun create(config: NativeRdpConfig, sink: NativeRdpSink): Long {
            createCalls++
            this.config = config
            this.sink = sink
            return 7L
        }

        override fun run(handle: Long): Int {
            sink?.onConnected(1080, 2400)
            stopped.await()
            return 0
        }

        override fun stop(handle: Long) { stopCalls++; stopped.countDown() }
        override fun free(handle: Long) { freeCalls++ }
        override fun sendPointerMove(handle: Long, x: Int, y: Int) { pointerEvents += "move:$x:$y" }
        override fun sendPointerButton(handle: Long, x: Int, y: Int, button: Int, down: Boolean) {
            pointerEvents += "button:$button:$down"
        }
        override fun sendWheel(handle: Long, x: Int, y: Int, delta: Int) { pointerEvents += "wheel:$delta" }
        override fun sendScancode(handle: Long, scanCode: Int, down: Boolean, extended: Boolean) = Unit
        override fun sendUnicode(handle: Long, utf16Unit: Int, down: Boolean) {
            unicodeEvents += utf16Unit to down
        }
        override fun resize(handle: Long, width: Int, height: Int) = Unit
        override fun sendClipboard(handle: Long, text: String) = Unit
    }
}
