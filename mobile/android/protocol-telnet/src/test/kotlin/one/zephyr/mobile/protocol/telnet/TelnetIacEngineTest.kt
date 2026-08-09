package one.zephyr.mobile.protocol.telnet

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The IAC state machine, asserted at byte level against the main end's implementation.
 *
 * Every case here is a real Telnet failure mode rather than a coverage exercise: a sequence split
 * across TCP reads, a negotiation loop, a literal 0xFF in the payload. All of them produce a session
 * that looks connected and then misbehaves, which is exactly the class of bug that is expensive to
 * diagnose from a phone.
 */
class TelnetIacEngineTest {

    private class Recorder {
        val writes = mutableListOf<ByteArray>()
        fun sink(): (ByteArray) -> Unit = { writes.add(it) }
        fun flat(): List<Int> = writes.flatMap { bytes -> bytes.map { it.toInt() and 0xFF } }
    }

    private fun bytes(vararg values: Int): ByteArray = ByteArray(values.size) { values[it].toByte() }

    @Test
    fun stripsPlainNegotiationAndKeepsPayload() {
        val recorder = Recorder()
        val engine = TelnetIacEngine(recorder.sink())
        val out = engine.feed(bytes(0x68, Telnet.IAC, Telnet.WILL, Telnet.OPT_SGA, 0x69))
        assertArrayEquals(bytes(0x68, 0x69), out)
    }

    /** A DO split across two reads must not be half-executed and half-printed. */
    @Test
    fun buffersAnOptionSequenceSplitAcrossChunks() {
        val recorder = Recorder()
        val engine = TelnetIacEngine(recorder.sink())

        val first = engine.feed(bytes(0x41, Telnet.IAC, Telnet.DO))
        assertArrayEquals(bytes(0x41), first)
        assertEquals("the incomplete DO must be held, not emitted", 2, engine.bufferedBytes)
        assertTrue(recorder.writes.isEmpty())

        val second = engine.feed(bytes(Telnet.OPT_TTYPE, 0x42))
        assertArrayEquals(bytes(0x42), second)
        assertEquals(0, engine.bufferedBytes)
        // Seeded as already-announced, so the confirmation is silent.
        assertTrue(recorder.writes.isEmpty())
    }

    @Test
    fun buffersASubnegotiationSplitAcrossChunks() {
        val recorder = Recorder()
        val engine = TelnetIacEngine(recorder.sink())

        val first = engine.feed(bytes(Telnet.IAC, Telnet.SB, Telnet.OPT_TTYPE, Telnet.TTYPE_SEND))
        assertEquals(0, first.size)
        assertEquals(4, engine.bufferedBytes)
        assertTrue("no reply until IAC SE arrives", recorder.writes.isEmpty())

        val second = engine.feed(bytes(Telnet.IAC, Telnet.SE, 0x5A))
        assertArrayEquals(bytes(0x5A), second)
        val expected = mutableListOf(Telnet.IAC, Telnet.SB, Telnet.OPT_TTYPE, Telnet.TTYPE_IS)
        expected += Telnet.DEFAULT_TERM.map { it.code }
        expected += listOf(Telnet.IAC, Telnet.SE)
        assertEquals(expected, recorder.flat())
    }

    /** A 0xFF byte inside a subnegotiation body must not be read as the terminator. */
    @Test
    fun skipsEscapedIacInsideASubnegotiationBody() {
        val recorder = Recorder()
        val engine = TelnetIacEngine(recorder.sink())
        val out = engine.feed(
            bytes(
                Telnet.IAC, Telnet.SB, Telnet.OPT_STATUS, 0x01, Telnet.IAC, Telnet.IAC, 0x02,
                Telnet.IAC, Telnet.SE, 0x7A,
            ),
        )
        assertArrayEquals(bytes(0x7A), out)
        // STATUS is not TTYPE, so it is parsed and ignored rather than answered.
        assertTrue(recorder.writes.isEmpty())
    }

    @Test
    fun unescapesIacIacToALiteralByte() {
        val engine = TelnetIacEngine(respond = false)
        assertArrayEquals(bytes(0x41, 0xFF, 0x42), engine.feed(bytes(0x41, Telnet.IAC, Telnet.IAC, 0x42)))
    }

    @Test
    fun stripsNopAndGoAhead() {
        val engine = TelnetIacEngine(respond = false)
        val out = engine.feed(bytes(0x41, Telnet.IAC, Telnet.NOP, 0x42, Telnet.IAC, Telnet.GA, 0x43))
        assertArrayEquals(bytes(0x41, 0x42, 0x43), out)
    }

    /** IP/AO/AYT/EC/EL/BRK are the server's business; forwarding them corrupts the emulator. */
    @Test
    fun stripsUnknownTwoByteCommands()  {
        val engine = TelnetIacEngine(respond = false)
        assertArrayEquals(bytes(0x41, 0x42), engine.feed(bytes(0x41, Telnet.IAC, 244, 0x42)))
    }

    // ---- RFC 854 CR NUL --------------------------------------------------------------------------

    @Test
    fun collapsesCrNulToCr() {
        val engine = TelnetIacEngine(respond = false)
        assertArrayEquals(bytes(0x41, Telnet.CR, 0x42), engine.feed(bytes(0x41, Telnet.CR, Telnet.NUL, 0x42)))
    }

    @Test
    fun holdsALoneTrailingCarriageReturn() {
        val engine = TelnetIacEngine(respond = false)
        val first = engine.feed(bytes(0x41, Telnet.CR))
        assertArrayEquals(bytes(0x41), first)
        assertEquals(1, engine.bufferedBytes)
        // The NUL arrives next, completing the sequence exactly once.
        assertArrayEquals(bytes(Telnet.CR, 0x42), engine.feed(bytes(Telnet.NUL, 0x42)))
    }

    @Test
    fun keepsCrLfIntact() {
        val engine = TelnetIacEngine(respond = false)
        assertArrayEquals(bytes(Telnet.CR, 0x0A, 0x41), engine.feed(bytes(Telnet.CR, 0x0A, 0x41)))
    }

    /** In BINARY mode those bytes are data, so collapsing them would corrupt the stream. */
    @Test
    fun doesNotCollapseCrNulOnceThePeerEnabledBinary() {
        val recorder = Recorder()
        val engine = TelnetIacEngine(recorder.sink())
        engine.feed(bytes(Telnet.IAC, Telnet.WILL, Telnet.OPT_BINARY))
        assertTrue(engine.peerEnabled(Telnet.OPT_BINARY))
        assertArrayEquals(bytes(Telnet.CR, Telnet.NUL), engine.feed(bytes(Telnet.CR, Telnet.NUL)))
    }

    // ---- option replies --------------------------------------------------------------------------

    /**
     * The loop guard. NAWS is seeded enabled because the dialer already sent WILL NAWS, so a DO is a
     * confirmation. Answering every confirmation is how two RFC 855 implementations ping-pong.
     */
    @Test
    fun doForAnAlreadyEnabledOptionIsNotAnswered() {
        val recorder = Recorder()
        val engine = TelnetIacEngine(recorder.sink())
        engine.feed(bytes(Telnet.IAC, Telnet.DO, Telnet.OPT_NAWS))
        engine.feed(bytes(Telnet.IAC, Telnet.DO, Telnet.OPT_NAWS))
        assertTrue("a confirmed option must not be re-announced", recorder.writes.isEmpty())
        assertTrue(engine.localEnabled(Telnet.OPT_NAWS))
    }

    @Test
    fun doForAnOptionWeDoNotWantIsRefused() {
        val recorder = Recorder()
        val engine = TelnetIacEngine(recorder.sink())
        engine.feed(bytes(Telnet.IAC, Telnet.DO, Telnet.OPT_STATUS))
        assertEquals(listOf(Telnet.IAC, Telnet.WONT, Telnet.OPT_STATUS), recorder.flat())
        assertFalse(engine.localEnabled(Telnet.OPT_STATUS))
    }

    @Test
    fun dontIsAnsweredOnlyWhenTheOptionWasEnabled() {
        val recorder = Recorder()
        val engine = TelnetIacEngine(recorder.sink())
        engine.feed(bytes(Telnet.IAC, Telnet.DONT, Telnet.OPT_NAWS))
        assertEquals(listOf(Telnet.IAC, Telnet.WONT, Telnet.OPT_NAWS), recorder.flat())
        recorder.writes.clear()
        // Now off: a repeat is silent.
        engine.feed(bytes(Telnet.IAC, Telnet.DONT, Telnet.OPT_NAWS))
        assertTrue(recorder.writes.isEmpty())
    }

    @Test
    fun willForAWantedOptionIsAcceptedOnce() {
        val recorder = Recorder()
        val engine = TelnetIacEngine(recorder.sink())
        engine.feed(bytes(Telnet.IAC, Telnet.WILL, Telnet.OPT_ECHO))
        assertEquals(listOf(Telnet.IAC, Telnet.DO, Telnet.OPT_ECHO), recorder.flat())
        assertTrue(engine.peerEnabled(Telnet.OPT_ECHO))
        recorder.writes.clear()
        engine.feed(bytes(Telnet.IAC, Telnet.WILL, Telnet.OPT_ECHO))
        assertTrue("re-offering an enabled option must be silent", recorder.writes.isEmpty())
    }

    @Test
    fun willForAnUnwantedOptionIsRefused() {
        val recorder = Recorder()
        val engine = TelnetIacEngine(recorder.sink())
        engine.feed(bytes(Telnet.IAC, Telnet.WILL, Telnet.OPT_STATUS))
        assertEquals(listOf(Telnet.IAC, Telnet.DONT, Telnet.OPT_STATUS), recorder.flat())
    }

    @Test
    fun wontIsAnsweredOnlyWhenThePeerHadItEnabled() {
        val recorder = Recorder()
        val engine = TelnetIacEngine(recorder.sink())
        engine.feed(bytes(Telnet.IAC, Telnet.WONT, Telnet.OPT_SGA))
        assertTrue("SGA was never confirmed, so there is nothing to withdraw", recorder.writes.isEmpty())

        engine.feed(bytes(Telnet.IAC, Telnet.WILL, Telnet.OPT_SGA))
        recorder.writes.clear()
        engine.feed(bytes(Telnet.IAC, Telnet.WONT, Telnet.OPT_SGA))
        assertEquals(listOf(Telnet.IAC, Telnet.DONT, Telnet.OPT_SGA), recorder.flat())
        assertFalse(engine.peerEnabled(Telnet.OPT_SGA))
    }

    @Test
    fun ttypeReplyIsTruncatedToTheProtocolLimit() {
        val recorder = Recorder()
        val engine = TelnetIacEngine(recorder.sink(), termType = "x".repeat(80))
        assertEquals(Telnet.MAX_TERM_LENGTH, engine.termType.length)
        engine.feed(bytes(Telnet.IAC, Telnet.SB, Telnet.OPT_TTYPE, Telnet.TTYPE_SEND, Telnet.IAC, Telnet.SE))
        assertEquals(6 + Telnet.MAX_TERM_LENGTH, recorder.flat().size)
    }

    /** NAWS is client-to-server only, so an inbound one is parsed and dropped. */
    @Test
    fun inboundNawsSubnegotiationIsIgnored() {
        val recorder = Recorder()
        val engine = TelnetIacEngine(recorder.sink())
        val out = engine.feed(
            bytes(Telnet.IAC, Telnet.SB, Telnet.OPT_NAWS, 0, 80, 0, 24, Telnet.IAC, Telnet.SE, 0x41),
        )
        assertArrayEquals(bytes(0x41), out)
        assertTrue(recorder.writes.isEmpty())
    }

    @Test
    fun aTtypeSubnegotiationThatIsNotSendIsIgnored() {
        val recorder = Recorder()
        val engine = TelnetIacEngine(recorder.sink())
        engine.feed(bytes(Telnet.IAC, Telnet.SB, Telnet.OPT_TTYPE, Telnet.TTYPE_IS, 0x41, Telnet.IAC, Telnet.SE))
        assertTrue(recorder.writes.isEmpty())
    }

    // ---- pure stripper ---------------------------------------------------------------------------

    @Test
    fun filterIacStripsWithoutReplying() {
        val out = filterIac(bytes(0x41, Telnet.IAC, Telnet.DO, Telnet.OPT_TTYPE, 0x42))
        assertArrayEquals(bytes(0x41, 0x42), out)
    }

    @Test
    fun aDestroyedEngineEmitsNothing() {
        val engine = TelnetIacEngine(respond = false)
        engine.feed(bytes(0x41, Telnet.CR))
        engine.destroy()
        assertEquals(0, engine.bufferedBytes)
        assertEquals(0, engine.feed(bytes(0x42)).size)
    }
}
