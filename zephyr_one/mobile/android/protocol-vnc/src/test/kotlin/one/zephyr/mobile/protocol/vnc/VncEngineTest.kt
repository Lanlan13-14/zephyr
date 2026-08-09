package one.zephyr.mobile.protocol.vnc

import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The engine seam while ADR-005 is open.
 *
 * The point of these assertions is that the absent engine reports itself as absent with a specific
 * code. A seam that returned a generic timeout instead would look like a network problem, and the
 * user would spend the evening checking firewall rules for a feature that is not in the build.
 */
class VncEngineTest {

    private val engine = UnavailableVncEngine()

    private fun request() = VncConnectRequest(
        sessionId = "s-1",
        host = "10.0.0.9",
        port = 5900,
        password = "secret".toCharArray(),
    )

    @Test
    fun `the engine reports itself unavailable`() {
        assertFalse(engine.isAvailable)
    }

    @Test
    fun `connect fails with the engine code rather than a timeout`() = runTest {
        val outcome = engine.connect(request())
        val failed = outcome as VncConnectOutcome.Failed
        assertEquals(UnavailableVncEngine.ENGINE_UNAVAILABLE, failed.error.code)
        assertEquals(VncErrors.ENGINE_UNAVAILABLE, failed.error.code)
        assertFalse("a missing engine will not appear by retrying", failed.error.retryable)
    }

    @Test
    fun `the frame and clipboard flows complete empty instead of hanging`() = runTest {
        assertTrue(engine.frames("s-1").toList().isEmpty())
        assertTrue(engine.clipboard("s-1").toList().isEmpty())
    }

    @Test
    fun `resize reports the size the caller asked for and no server resize`() = runTest {
        val size = engine.resize("s-1", 1080, 2400)
        assertEquals(1080, size.widthPx)
        assertEquals(2400, size.heightPx)
        // Only a server supporting ExtendedDesktopSize can actually resize the desktop.
        assertFalse(size.serverResized)
    }

    @Test
    fun `the remaining operations are inert`() = runTest {
        engine.send("s-1", VncInputEvent.Key(X11Keysym.RETURN, down = true))
        engine.send("s-1", VncInputEvent.Pointer(10, 20, RfbButton.LEFT))
        engine.send("s-1", VncInputEvent.Text("研发"))
        engine.sendClipboard("s-1", "text")
        engine.disconnect("s-1")
    }

    @Test
    fun `a connect request never prints its password`() {
        val text = request().toString()
        assertFalse("the password must not reach a log line", text.contains("secret"))
        assertTrue(text.contains("s-1"))
        assertTrue(text.contains("10.0.0.9"))
    }

    @Test
    fun `connect requests compare by identity so a CharArray cannot leak through equals`() {
        val first = request()
        val second = request()
        assertNotEquals(first, second)
        assertEquals(first, first)
    }

    @Test
    fun `the default pixel format is the bandwidth saving one`() {
        // A phone on mobile data is the target, and RGB565 halves framebuffer traffic.
        assertEquals(RfbPixelFormat.RGB565, request().preferredPixelFormat)
    }

    @Test
    fun `the shared flag defaults to leaving other viewers connected`() {
        // Defaulting to false would silently disconnect whoever is already on the console.
        assertTrue(request().shared)
        assertFalse(request().viewOnly)
    }

    @Test
    fun `frames compare by pixel content`() {
        val first = VncFrame(0, 0, 2, 1, byteArrayOf(1, 2, 3, 4))
        val same = VncFrame(0, 0, 2, 1, byteArrayOf(1, 2, 3, 4))
        val different = VncFrame(0, 0, 2, 1, byteArrayOf(1, 2, 3, 5))
        assertEquals(first, same)
        assertEquals(first.hashCode(), same.hashCode())
        assertNotEquals(first, different)
    }
}
