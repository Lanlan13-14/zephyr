package one.zephyr.mobile.protocol.rdp

import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import one.zephyr.mobile.model.RdpChannel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RdpEngineTest {

    private fun request() = RdpConnectRequest(
        sessionId = "s1",
        host = "win-lab",
        port = 3389,
        username = "administrator",
        domain = "CORP",
        password = "hunter2".toCharArray(),
        widthPx = 1080,
        heightPx = 2400,
        channels = setOf(RdpChannel.CLIPBOARD),
        drive = null,
    )

    @Test
    fun `the unavailable engine reports itself rather than pretending to connect`() = runTest {
        val engine = UnavailableRdpEngine()

        assertFalse(engine.isAvailable)
        val outcome = engine.connect(request())
        // A specific code so the UI can say "not in this build" instead of showing a timeout.
        assertEquals(
            UnavailableRdpEngine.ENGINE_UNAVAILABLE,
            (outcome as RdpConnectOutcome.Failed).error.code,
        )
        assertEquals("rdp_engine_unavailable", outcome.error.code)
        assertFalse(outcome.error.retryable)
    }

    @Test
    fun `the unavailable engine produces no frames or clipboard and swallows input`() = runTest {
        val engine = UnavailableRdpEngine()

        assertTrue(engine.frames("s1").toList().isEmpty())
        assertTrue(engine.clipboard("s1").toList().isEmpty())
        engine.send("s1", RdpInputEvent.Pointer(x = 1, y = 2, buttons = 1))
        engine.send("s1", RdpInputEvent.Key(scanCode = 28, down = true))
        engine.send("s1", RdpInputEvent.Unicode(codePoint = 0x7814, down = true))
        engine.resize("s1", 1080, 2400)
        engine.sendClipboard("s1", "text")
        engine.disconnect("s1")
    }

    @Test
    fun `a connect request never prints its password`() {
        val text = request().toString()

        assertFalse(text.contains("hunter2"))
        assertTrue(text.contains("win-lab"))
        assertTrue(text.contains("s1"))
    }

    @Test
    fun `connect requests compare by identity so credentials are never compared`() {
        val first = request()

        assertEquals(first, first)
        assertNotEquals(first, request())
    }

    @Test
    fun `normalize forces even dimensions`() {
        // Several RDP codecs require even width and height.
        assertEquals(1080 to 720, RdpGeometry.normalize(1081, 721))
        assertEquals(1080 to 720, RdpGeometry.normalize(1080, 720))
        assertEquals(1920 to 1080, RdpGeometry.normalize(1921, 1080))
    }

    @Test
    fun `normalize refuses a surface too small to be usable`() {
        assertEquals(
            RdpGeometry.MIN_DIMENSION to RdpGeometry.MIN_DIMENSION,
            RdpGeometry.normalize(10, 10),
        )
        // 201 is coerced up to 201 then rounded down to an even 200.
        assertEquals(200 to 200, RdpGeometry.normalize(201, 201))
    }

    @Test
    fun `a one pixel jitter does not trigger a resize`() {
        // A dynamic resolution change costs a full server-side surface reallocation, so a system bar
        // animation must not cause one.
        assertFalse(RdpGeometry.shouldResize(1080, 720, 1081, 721))
        assertFalse(RdpGeometry.shouldResize(1080, 720, 1080, 720))
    }

    @Test
    fun `a real geometry change triggers a resize`() {
        assertTrue(RdpGeometry.shouldResize(1080, 720, 1280, 800))
        // Rotation swaps the axes, which is a genuine change.
        assertTrue(RdpGeometry.shouldResize(1080, 2400, 2400, 1080))
    }

    @Test
    fun `frames compare by pixel content`() {
        val first = RdpFrame(0, 0, 2, 1, byteArrayOf(1, 2, 3, 4))
        val same = RdpFrame(0, 0, 2, 1, byteArrayOf(1, 2, 3, 4))
        val different = RdpFrame(0, 0, 2, 1, byteArrayOf(9, 9, 9, 9))

        assertEquals(first, same)
        assertEquals(first.hashCode(), same.hashCode())
        assertNotEquals(first, different)
        assertNotEquals(first, RdpFrame(1, 0, 2, 1, byteArrayOf(1, 2, 3, 4)))
    }
}
