package one.zephyr.mobile.protocol.telnet

import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The session pump: negotiation on connect, replies flushed in order, and the write-path escape. */
class TelnetSessionTest {

    private class FakeSocket : TelnetSocket {
        val writes = mutableListOf<ByteArray>()
        var closed = false
        override suspend fun write(bytes: ByteArray) {
            writes.add(bytes)
        }
        override fun close() {
            closed = true
        }
        fun flat(): List<Int> = writes.flatMap { bytes -> bytes.map { it.toInt() and 0xFF } }
    }

    private fun bytes(vararg values: Int): ByteArray = ByteArray(values.size) { values[it].toByte() }

    @Test
    fun startSendsTheOpeningNegotiation() = runTest {
        val socket = FakeSocket()
        val session = TelnetSession(socket, TelnetConfig(cols = 100, rows = 30), backgroundScope)
        session.start()
        assertEquals(Telnet.negotiationSequence(100, 30).toList(), socket.writes.first().toList())
    }

    @Test
    fun inboundOptionBytesAreStrippedAndTheRestDecoded() = runTest {
        val socket = FakeSocket()
        val session = TelnetSession(socket, TelnetConfig(), backgroundScope)
        val text = session.onBytes(bytes(0x68, 0x69, Telnet.IAC, Telnet.WILL, Telnet.OPT_ECHO))
        assertEquals("hi", text)
        // The engine's DO ECHO reply reached the socket, in order.
        assertEquals(listOf(Telnet.IAC, Telnet.DO, Telnet.OPT_ECHO), socket.flat())
        assertTrue(session.serverEchoes)
    }

    /** Strip first, then decode: an option byte read as part of a character corrupts both. */
    @Test
    fun optionBytesInsideMultibyteOutputDoNotCorruptTheText() = runTest {
        val socket = FakeSocket()
        val session = TelnetSession(socket, TelnetConfig(), backgroundScope)
        val encoded = "中文".toByteArray(Charsets.UTF_8)
        val first = session.onBytes(encoded.copyOfRange(0, 4) + bytes(Telnet.IAC, Telnet.NOP))
        val second = session.onBytes(encoded.copyOfRange(4, encoded.size))
        assertEquals("中文", first + second)
    }

    /**
     * A 0xFF byte the user typed must be escaped, or the server reads it as the start of an option
     * command and the session desynchronises.
     */
    @Test
    fun outboundFfIsEscapedAsIacIac() = runTest {
        val socket = FakeSocket()
        val session = TelnetSession(socket, TelnetConfig(encoding = TelnetEncoding.LATIN_1), backgroundScope)
        assertArrayEquals(bytes(0x41, Telnet.IAC, Telnet.IAC, 0x42), session.encodeOutbound("A\u00ffB"))
    }

    @Test
    fun outboundTextUsesTheSessionEncoding() = runTest {
        val socket = FakeSocket()
        val session = TelnetSession(socket, TelnetConfig(encoding = TelnetEncoding.GBK), backgroundScope)
        session.sendText("中")
        assertArrayEquals("中".toByteArray(charset("GBK")), socket.writes.last())
    }

    @Test
    fun resizeSendsNawsOnlyWhenTheSizeChanged() = runTest {
        val socket = FakeSocket()
        val session = TelnetSession(socket, TelnetConfig(cols = 80, rows = 24), backgroundScope)
        session.resize(80, 24)
        assertTrue("an unchanged size must not produce traffic", socket.writes.isEmpty())
        session.resize(120, 40)
        assertArrayEquals(Telnet.encodeNaws(120, 40), socket.writes.last())
    }

    @Test
    fun keepaliveSendsIacNopOnItsInterval() = runTest {
        val socket = FakeSocket()
        val session = TelnetSession(socket, TelnetConfig(keepaliveMs = 0L), backgroundScope)
        session.startKeepalive(60_000L)
        advanceTimeBy(60_001)
        runCurrent()
        assertArrayEquals(Telnet.KEEPALIVE, socket.writes.last())
    }

    /** A misconfigured interval must not turn the keepalive into a busy loop. */
    @Test
    fun keepaliveIntervalIsFloored() = runTest {
        val socket = FakeSocket()
        val session = TelnetSession(socket, TelnetConfig(keepaliveMs = 0L), backgroundScope)
        session.startKeepalive(1L)
        advanceTimeBy(500)
        runCurrent()
        assertTrue(socket.writes.isEmpty())
        advanceTimeBy(600)
        runCurrent()
        assertEquals(1, socket.writes.size)
    }

    @Test
    fun autoLoginAnswersPromptsThroughTheSocket() = runTest {
        val socket = FakeSocket()
        val session = TelnetSession(
            socket,
            TelnetConfig(autoLoginUsername = "alice", autoLoginPassword = "s3cret", keepaliveMs = 0L),
            backgroundScope,
        )
        session.onBytes("login: ".toByteArray(Charsets.UTF_8))
        assertEquals("alice\r\n", String(socket.writes.last(), Charsets.UTF_8))
        assertEquals(TelnetAutoLogin.State.AWAITING_PASSWORD, session.autoLoginState.value)

        session.onBytes("Password: ".toByteArray(Charsets.UTF_8))
        assertEquals("s3cret\r\n", String(socket.writes.last(), Charsets.UTF_8))
        assertEquals(TelnetAutoLogin.State.COMPLETE, session.autoLoginState.value)
    }

    @Test
    fun autoLoginMatchesAFullWidthColonSplitInsideItsUtf8Sequence() = runTest {
        val socket = FakeSocket()
        val session = TelnetSession(
            socket,
            TelnetConfig(autoLoginUsername = "alice", keepaliveMs = 0L),
            backgroundScope,
        )
        val prompt = "\u7528\u6237\u540D\uFF1A".toByteArray(Charsets.UTF_8)
        val split = prompt.size - 2

        session.onBytes(prompt.copyOfRange(0, split))
        assertTrue(socket.writes.isEmpty())
        session.onBytes(prompt.copyOfRange(split, prompt.size))

        assertEquals("alice\r\n", String(socket.writes.single(), Charsets.UTF_8))
        assertEquals(TelnetAutoLogin.State.COMPLETE, session.autoLoginState.value)
    }

    /** Telnet is plaintext by definition; the flag is never softened. */
    @Test
    fun theSessionAlwaysReportsCleartext() = runTest {
        val socket = FakeSocket()
        val session = TelnetSession(socket, TelnetConfig(), backgroundScope)
        assertTrue(session.isCleartext)
        assertFalse(session.binaryMode)
    }

    @Test
    fun stopClosesTheSocketAndTheEngine() = runTest {
        val socket = FakeSocket()
        val session = TelnetSession(socket, TelnetConfig(keepaliveMs = 0L), backgroundScope)
        session.start()
        session.stop()
        assertTrue(socket.closed)
        assertEquals("", session.onBytes(bytes(0x41)))
    }
}
