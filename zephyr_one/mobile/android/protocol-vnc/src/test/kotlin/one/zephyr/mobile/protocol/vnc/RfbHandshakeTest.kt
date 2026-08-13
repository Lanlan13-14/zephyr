package one.zephyr.mobile.protocol.vnc

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The RFB handshake across all three versions ADR-005 gates on.
 *
 * Every case asserts on both directions: what the client wrote, and how much of the script it left
 * unread. The unread count is the load-bearing assertion - the handshake bugs that matter are
 * off-by-one reads that leave the stream one field out of step, and those still return a plausible
 * session if only the result is checked.
 */
class RfbHandshakeTest {

    @Test
    fun `3 point 8 with None security completes without a challenge`() = runTest {
        val channel = FakeRfbChannel(
            ServerScript()
                .ascii("RFB 003.008\n")
                .u8(1)
                .u8(RfbSecurityType.NONE)
                .u32(0)
                .bytes(serverInit().build())
                .build(),
        )

        val outcome = RfbHandshake.perform(channel, password = null)

        val ready = outcome as RfbHandshakeOutcome.Ready
        assertEquals(RfbVersion.V3_8, ready.session.version)
        assertEquals(RfbSecurityType.NONE, ready.session.securityType)
        assertEquals(1024, ready.session.width)
        assertEquals(768, ready.session.height)
        assertEquals("zephyr-lab", ready.session.desktopName)
        assertEquals(RfbPixelFormat.RGB888, ready.session.pixelFormat)
        // Version, the echoed security type, then the ClientInit shared flag.
        assertEquals("524642203030332e3030380a" + "01" + "01", channel.written)
        assertEquals(0, channel.unreadBytes)
    }

    @Test
    fun `3 point 3 neither echoes the security type nor reads a SecurityResult for None`() = runTest {
        val channel = FakeRfbChannel(
            ServerScript()
                .ascii("RFB 003.003\n")
                .u32(RfbSecurityType.NONE)
                .bytes(serverInit().build())
                .build(),
        )

        val outcome = RfbHandshake.perform(channel, password = null)

        assertTrue(outcome is RfbHandshakeOutcome.Ready)
        // Version then the shared flag: no echo byte, because 3.3 lets the server dictate.
        assertEquals("524642203030332e3030330a" + "01", channel.written)
        // Zero unread bytes proves no phantom SecurityResult was consumed out of ServerInit.
        assertEquals(0, channel.unreadBytes)
    }

    @Test
    fun `3 point 3 with VncAuth answers the challenge and reads a reasonless SecurityResult`() = runTest {
        val channel = FakeRfbChannel(
            ServerScript()
                .ascii("RFB 003.003\n")
                .u32(RfbSecurityType.VNC_AUTH)
                .bytes(SEQUENTIAL_CHALLENGE)
                .u32(0)
                .bytes(serverInit().build())
                .build(),
        )

        val outcome = RfbHandshake.perform(channel, password = "zephyr".toCharArray())

        val ready = outcome as RfbHandshakeOutcome.Ready
        assertEquals(RfbSecurityType.VNC_AUTH, ready.session.securityType)
        assertEquals("524642203030332e3030330a" + "d553bf38c266cdab7287fd29a093b59e" + "01", channel.written)
        assertEquals(0, channel.unreadBytes)
    }

    @Test
    fun `3 point 8 prefers VncAuth over None when a password is configured`() = runTest {
        val channel = FakeRfbChannel(
            ServerScript()
                .ascii("RFB 003.008\n")
                .u8(2)
                .u8(RfbSecurityType.NONE)
                .u8(RfbSecurityType.VNC_AUTH)
                .bytes(SEQUENTIAL_CHALLENGE)
                .u32(0)
                .bytes(serverInit().build())
                .build(),
        )

        val outcome = RfbHandshake.perform(channel, password = "password".toCharArray())

        val ready = outcome as RfbHandshakeOutcome.Ready
        assertEquals(RfbSecurityType.VNC_AUTH, ready.session.securityType)
        assertEquals("524642203030332e3030380a" + "02" + "b866924125c8eebb9debc1db61c538e2" + "01", channel.written)
        assertEquals(0, channel.unreadBytes)
    }

    @Test
    fun `3 point 8 surfaces the server reason for a failed authentication`() = runTest {
        val channel = FakeRfbChannel(
            ServerScript()
                .ascii("RFB 003.008\n")
                .u8(1)
                .u8(RfbSecurityType.VNC_AUTH)
                .bytes(SEQUENTIAL_CHALLENGE)
                .u32(1)
                .string("Authentication failure")
                .build(),
        )

        val outcome = RfbHandshake.perform(channel, password = "zephyr".toCharArray())

        val rejected = outcome as RfbHandshakeOutcome.Rejected
        assertEquals(VncErrors.AUTH_FAILED, rejected.code)
        assertEquals("Authentication failure", rejected.detail)
        assertEquals(0, channel.unreadBytes)
    }

    @Test
    fun `3 point 7 failure has no reason string on the wire`() = runTest {
        val channel = FakeRfbChannel(
            ServerScript()
                .ascii("RFB 003.007\n")
                .u8(1)
                .u8(RfbSecurityType.VNC_AUTH)
                .bytes(SEQUENTIAL_CHALLENGE)
                .u32(1)
                .build(),
        )

        val outcome = RfbHandshake.perform(channel, password = "zephyr".toCharArray())

        val rejected = outcome as RfbHandshakeOutcome.Rejected
        assertEquals(VncErrors.AUTH_FAILED, rejected.code)
        assertTrue("falls back to local text", rejected.detail.isNotBlank())
        // Nothing left unread: reading a 3.8-style reason here would have thrown instead.
        assertEquals(0, channel.unreadBytes)
        assertEquals("524642203030332e3030370a" + "02" + "d553bf38c266cdab7287fd29a093b59e", channel.written)
    }

    @Test
    fun `too many attempts is reported apart from a wrong password`() = runTest {
        val channel = FakeRfbChannel(
            ServerScript()
                .ascii("RFB 003.008\n")
                .u8(1)
                .u8(RfbSecurityType.VNC_AUTH)
                .bytes(SEQUENTIAL_CHALLENGE)
                .u32(2)
                .string("Too many authentication failures")
                .build(),
        )

        val outcome = RfbHandshake.perform(channel, password = "zephyr".toCharArray())

        // A distinct code because retrying is pointless: the server is rate-limiting, and the UI
        // must say so rather than inviting another attempt.
        assertEquals(VncErrors.TOO_MANY_ATTEMPTS, (outcome as RfbHandshakeOutcome.Rejected).code)
    }

    @Test
    fun `an unsupported security type is refused before any credential leaves the device`() = runTest {
        val channel = FakeRfbChannel(
            ServerScript()
                .ascii("RFB 003.008\n")
                .u8(2)
                .u8(RfbSecurityType.TLS)
                .u8(RfbSecurityType.VENCRYPT)
                .build(),
        )

        val outcome = RfbHandshake.perform(channel, password = "zephyr".toCharArray())

        val rejected = outcome as RfbHandshakeOutcome.Rejected
        assertEquals(VncErrors.NO_SUPPORTED_SECURITY, rejected.code)
        // Only the version went out. No echo, no challenge response, no password-derived bytes.
        assertEquals("524642203030332e3030380a", channel.written)
    }

    @Test
    fun `a 3 point 8 server refusing the connection sends a zero count and a reason`() = runTest {
        val channel = FakeRfbChannel(
            ServerScript()
                .ascii("RFB 003.008\n")
                .u8(0)
                .string("Too many security failures")
                .build(),
        )

        val outcome = RfbHandshake.perform(channel, password = null)

        val rejected = outcome as RfbHandshakeOutcome.Rejected
        assertEquals(VncErrors.CONNECTION_REJECTED, rejected.code)
        assertEquals("Too many security failures", rejected.detail)
    }

    @Test
    fun `a 3 point 3 server refuses with a bare zero security type`() = runTest {
        val channel = FakeRfbChannel(
            ServerScript()
                .ascii("RFB 003.003\n")
                .u32(RfbSecurityType.INVALID)
                .string("Blocked by the host allow list")
                .build(),
        )

        val outcome = RfbHandshake.perform(channel, password = null)

        val rejected = outcome as RfbHandshakeOutcome.Rejected
        assertEquals(VncErrors.CONNECTION_REJECTED, rejected.code)
        assertEquals("Blocked by the host allow list", rejected.detail)
    }

    @Test
    fun `a non RFB greeting is refused without writing anything`() = runTest {
        val channel = FakeRfbChannel("HTTP/1.1 400".toByteArray(Charsets.US_ASCII))

        val outcome = RfbHandshake.perform(channel, password = null)

        assertEquals(VncErrors.BAD_VERSION, (outcome as RfbHandshakeOutcome.Rejected).code)
        // Nothing is sent to a server that has not identified itself as RFB.
        assertEquals("", channel.written)
    }

    @Test
    fun `a pre 3 point 3 server is unsupported and gets no version reply`() = runTest {
        val channel = FakeRfbChannel("RFB 003.002\n".toByteArray(Charsets.US_ASCII))

        val outcome = RfbHandshake.perform(channel, password = null)

        assertEquals(VncErrors.VERSION_UNSUPPORTED, (outcome as RfbHandshakeOutcome.Rejected).code)
        assertEquals("", channel.written)
    }

    @Test
    fun `a greeting cut short is reported as truncated`() = runTest {
        val channel = FakeRfbChannel("RFB 003.".toByteArray(Charsets.US_ASCII))

        val outcome = RfbHandshake.perform(channel, password = null)

        assertEquals(VncErrors.TRUNCATED, (outcome as RfbHandshakeOutcome.Rejected).code)
    }

    @Test
    fun `a ServerInit cut short is reported as truncated`() = runTest {
        val channel = FakeRfbChannel(
            ServerScript()
                .ascii("RFB 003.008\n")
                .u8(1)
                .u8(RfbSecurityType.NONE)
                .u32(0)
                .u16(1024)
                .u16(768)
                .build(),
        )

        val outcome = RfbHandshake.perform(channel, password = null)

        // A mid-handshake disconnect is a normal network event rather than a protocol violation, so
        // it gets its own code instead of being reported as a malformed server.
        assertEquals(VncErrors.TRUNCATED, (outcome as RfbHandshakeOutcome.Rejected).code)
    }

    @Test
    fun `a zero framebuffer dimension is refused`() = runTest {
        val channel = FakeRfbChannel(
            ServerScript()
                .ascii("RFB 003.008\n")
                .u8(1)
                .u8(RfbSecurityType.NONE)
                .u32(0)
                .bytes(serverInit(width = 0).build())
                .build(),
        )

        val outcome = RfbHandshake.perform(channel, password = null)

        assertEquals(VncErrors.BAD_FRAMEBUFFER_SIZE, (outcome as RfbHandshakeOutcome.Rejected).code)
    }

    @Test
    fun `a structurally impossible pixel format is refused`() = runTest {
        val channel = FakeRfbChannel(
            ServerScript()
                .ascii("RFB 003.008\n")
                .u8(1)
                .u8(RfbSecurityType.NONE)
                .u32(0)
                .u16(1024)
                .u16(768)
                // 24 bits per pixel: RFB permits only 8, 16 or 32, and a 3-byte stride would
                // silently misalign every row of the framebuffer.
                .bytes(hex("18 18 00 01 00ff 00ff 00ff 10 08 00 000000"))
                .string("bad-format")
                .build(),
        )

        val outcome = RfbHandshake.perform(channel, password = null)

        assertEquals(VncErrors.BAD_PIXEL_FORMAT, (outcome as RfbHandshakeOutcome.Rejected).code)
    }

    @Test
    fun `a newer server is answered with 3 point 8 rather than its own version`() = runTest {
        val channel = FakeRfbChannel(
            ServerScript()
                .ascii("RFB 003.889\n")
                .u8(1)
                .u8(RfbSecurityType.NONE)
                .u32(0)
                .bytes(serverInit().build())
                .build(),
        )

        val outcome = RfbHandshake.perform(channel, password = null)

        assertEquals(RfbVersion.V3_8, (outcome as RfbHandshakeOutcome.Ready).session.version)
        // Apple Remote Desktop announces 003.889; echoing it back would promise unimplemented
        // extensions and desynchronise the very next field.
        assertTrue(channel.written.startsWith("524642203030332e3030380a"))
    }

    @Test
    fun `the ClientInit shared flag follows the caller`() = runTest {
        val channel = FakeRfbChannel(
            ServerScript()
                .ascii("RFB 003.008\n")
                .u8(1)
                .u8(RfbSecurityType.NONE)
                .u32(0)
                .bytes(serverInit().build())
                .build(),
        )

        RfbHandshake.perform(channel, password = null, shareDesktop = false)

        // A zero shared flag asks the server to disconnect other viewers, so it must never be sent
        // by accident: it kicks whoever is on the console.
        assertEquals("524642203030332e3030380a" + "01" + "00", channel.written)
    }

    @Test
    fun `a server requiring a password without one stored is reported specifically`() = runTest {
        val channel = FakeRfbChannel(
            ServerScript()
                .ascii("RFB 003.008\n")
                .u8(1)
                .u8(RfbSecurityType.VNC_AUTH)
                .build(),
        )

        val outcome = RfbHandshake.perform(channel, password = null)

        // Distinct from AUTH_FAILED so the UI prompts for a password instead of claiming the stored
        // one was wrong.
        assertEquals(VncErrors.PASSWORD_REQUIRED, (outcome as RfbHandshakeOutcome.Rejected).code)
    }

    @Test
    fun `an empty password counts as no password`() = runTest {
        val channel = FakeRfbChannel(
            ServerScript()
                .ascii("RFB 003.008\n")
                .u8(1)
                .u8(RfbSecurityType.VNC_AUTH)
                .build(),
        )

        val outcome = RfbHandshake.perform(channel, password = CharArray(0))

        assertEquals(VncErrors.PASSWORD_REQUIRED, (outcome as RfbHandshakeOutcome.Rejected).code)
    }

    @Test
    fun `the desktop name is decoded as UTF-8`() = runTest {
        val channel = FakeRfbChannel(
            ServerScript()
                .ascii("RFB 003.008\n")
                .u8(1)
                .u8(RfbSecurityType.NONE)
                .u32(0)
                .bytes(serverInit(name = "研发机 01", width = 1920, height = 1080).build())
                .build(),
        )

        val outcome = RfbHandshake.perform(channel, password = null)

        val ready = outcome as RfbHandshakeOutcome.Ready
        assertEquals("研发机 01", ready.session.desktopName)
        assertEquals(1920, ready.session.width)
        assertEquals(1080, ready.session.height)
        assertEquals(0, channel.unreadBytes)
    }

    @Test
    fun `a nameless desktop is accepted`() = runTest {
        val channel = FakeRfbChannel(
            ServerScript()
                .ascii("RFB 003.008\n")
                .u8(1)
                .u8(RfbSecurityType.NONE)
                .u32(0)
                .bytes(serverInit(name = "").build())
                .build(),
        )

        val outcome = RfbHandshake.perform(channel, password = null)

        assertEquals("", (outcome as RfbHandshakeOutcome.Ready).session.desktopName)
        assertEquals(0, channel.unreadBytes)
    }

    @Test
    fun `an oversized name length is rejected rather than allocated or left in the frame stream`() = runTest {
        // A hostile server claiming a 4 GiB desktop name must not be able to make the client try to
        // allocate it, so the read is clamped to MAX_STRING_BYTES.
        val nameBytes = ByteArray(RfbHandshake.MAX_STRING_BYTES) { 'z'.code.toByte() }
        val channel = FakeRfbChannel(
            ServerScript()
                .ascii("RFB 003.008\n")
                .u8(1)
                .u8(RfbSecurityType.NONE)
                .u32(0)
                .u16(800)
                .u16(600)
                .bytes(RfbPixelFormat.RGB565.encode())
                .u32(0xFFFF_FFFFL)
                .bytes(nameBytes)
                .build(),
        )

        val outcome = RfbHandshake.perform(channel, password = null)

        val rejected = outcome as RfbHandshakeOutcome.Rejected
        assertEquals(VncErrors.PROTOCOL_ERROR, rejected.code)
        // The payload is intentionally not consumed: the connection is rejected immediately rather
        // than treating bytes beyond the cap as the first server message.
        assertEquals(RfbHandshake.MAX_STRING_BYTES, channel.unreadBytes)
    }
}
