package one.zephyr.mobile.protocol.telnet

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

/** The exact opening bytes and the NAWS encoding, which the main end and the Go worker also send. */
class TelnetWireTest {

    private fun ints(bytes: ByteArray): List<Int> = bytes.map { it.toInt() and 0xFF }

    @Test
    fun negotiationSequenceMatchesTheMainEndOrder() {
        val expected = listOf(
            Telnet.IAC, Telnet.WILL, Telnet.OPT_NAWS,
            Telnet.IAC, Telnet.WILL, Telnet.OPT_TTYPE,
            Telnet.IAC, Telnet.DO, Telnet.OPT_SGA,
            Telnet.IAC, Telnet.DO, Telnet.OPT_ECHO,
            Telnet.IAC, Telnet.SB, Telnet.OPT_NAWS, 0, 80, 0, 24, Telnet.IAC, Telnet.SE,
        )
        assertEquals(expected, ints(Telnet.negotiationSequence(80, 24)))
    }

    @Test
    fun nawsIsTwoBigEndianShorts() {
        assertEquals(
            listOf(Telnet.IAC, Telnet.SB, Telnet.OPT_NAWS, 1, 44, 0, 50, Telnet.IAC, Telnet.SE),
            ints(Telnet.encodeNaws(300, 50)),
        )
    }

    /** A resize is a hint: clamped to the protocol range rather than refused. */
    @Test
    fun nawsClampsOutOfRangeSizes() {
        assertEquals(listOf(0, Telnet.MIN_COLS, 0, Telnet.MIN_ROWS), ints(Telnet.encodeNaws(0, 0)).subList(3, 7))
        assertEquals(
            listOf((Telnet.MAX_COLS shr 8), Telnet.MAX_COLS and 0xFF, 0, Telnet.MAX_ROWS),
            ints(Telnet.encodeNaws(9999, 9999)).subList(3, 7),
        )
    }

    @Test
    fun defaultPortsMatchTheProtocols() {
        assertEquals(22, Telnet.defaultPort("SSH"))
        assertEquals(23, Telnet.defaultPort("telnet"))
        assertEquals(3389, Telnet.defaultPort("RDP"))
        assertEquals(5900, Telnet.defaultPort("VNC"))
        assertEquals("an unknown protocol falls back to SSH", 22, Telnet.defaultPort(null))
    }

    @Test
    fun keepaliveIsIacNop() {
        assertArrayEquals(byteArrayOf(Telnet.IAC.toByte(), Telnet.NOP.toByte()), Telnet.KEEPALIVE)
    }

    @Test
    fun encodingLookupFallsBackToUtf8() {
        assertEquals(TelnetEncoding.GBK, TelnetEncoding.fromName("gbk"))
        assertEquals(TelnetEncoding.BIG5, TelnetEncoding.fromName("Big5"))
        assertEquals(TelnetEncoding.LATIN_1, TelnetEncoding.fromName("ISO-8859-1"))
        assertEquals(TelnetEncoding.UTF_8, TelnetEncoding.fromName("nonsense"))
    }
}
