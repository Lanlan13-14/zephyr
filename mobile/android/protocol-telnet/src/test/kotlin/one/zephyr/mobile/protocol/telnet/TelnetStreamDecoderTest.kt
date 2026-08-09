package one.zephyr.mobile.protocol.telnet

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Incremental decoding across TCP boundaries.
 *
 * A multi-byte character split across two reads is the normal case on a busy connection, not an edge
 * case: decoding each chunk independently produces a replacement character in the middle of ordinary
 * CJK output, which is the single most reported terminal-encoding bug.
 */
class TelnetStreamDecoderTest {

    private fun bytes(vararg values: Int): ByteArray = ByteArray(values.size) { values[it].toByte() }

    @Test
    fun decodesAsciiUnchanged() {
        assertEquals("hello", TelnetStreamDecoder().decode("hello".toByteArray(Charsets.UTF_8)))
    }

    @Test
    fun holdsAUtf8CharacterSplitAcrossChunks() {
        val decoder = TelnetStreamDecoder(TelnetEncoding.UTF_8)
        val encoded = "中".toByteArray(Charsets.UTF_8)
        assertEquals(3, encoded.size)

        assertEquals("", decoder.decode(encoded.copyOfRange(0, 2)))
        assertEquals("two of three bytes must be held, not replaced", 2, decoder.bufferedBytes)
        assertEquals("中", decoder.decode(encoded.copyOfRange(2, 3)))
        assertEquals(0, decoder.bufferedBytes)
    }

    @Test
    fun holdsAGbkCharacterSplitAcrossChunks() {
        val decoder = TelnetStreamDecoder(TelnetEncoding.GBK)
        // GBK 0xD6D0 is 中. Written as bytes rather than encoded here, so the test proves the decode
        // direction the wire actually uses instead of round-tripping through the encoder.
        assertEquals("", decoder.decode(bytes(0xD6)))
        assertEquals(1, decoder.bufferedBytes)
        assertEquals("中", decoder.decode(bytes(0xD0)))
        assertEquals(0, decoder.bufferedBytes)
    }

    @Test
    fun decodesBig5AndLatin1() {
        // Big5 0xA440 is 一, the first entry of the Big5 table.
        assertEquals("一", TelnetStreamDecoder(TelnetEncoding.BIG5).decode(bytes(0xA4, 0x40)))
        assertEquals("\u00ff", TelnetStreamDecoder(TelnetEncoding.LATIN_1).decode(bytes(0xFF)))
    }

    /** A malformed byte becomes U+FFFD rather than throwing: one bad byte must not end a session. */
    @Test
    fun replacesMalformedInputInsteadOfFailing() {
        val out = TelnetStreamDecoder(TelnetEncoding.UTF_8).decode(bytes(0x41, 0xC3, 0x28, 0x42))
        assertEquals("A\uFFFD(B", out)
    }

    /**
     * A stream of lead bytes must not grow the carry.
     *
     * Each 0xF0 followed by another 0xF0 is malformed and becomes a replacement character
     * immediately; only the final byte is genuinely incomplete. So 32 hostile bytes leave exactly
     * one byte held, not 32 - which is what stops a peer from growing this buffer at will.
     */
    @Test
    fun boundsTheCarryToOneIncompleteCharacter() {
        val decoder = TelnetStreamDecoder(TelnetEncoding.UTF_8)
        val out = decoder.decode(ByteArray(32) { 0xF0.toByte() })
        assertEquals(31, out.length)
        assertEquals(1, decoder.bufferedBytes)
    }

    /**
     * A partial character in the old charset is meaningless in the new one, so the carry is dropped
     * rather than reinterpreted.
     */
    @Test
    fun switchingEncodingDropsThePartialCharacter() {
        val decoder = TelnetStreamDecoder(TelnetEncoding.UTF_8)
        decoder.decode("中".toByteArray(Charsets.UTF_8).copyOfRange(0, 2))
        assertEquals(2, decoder.bufferedBytes)

        decoder.setEncoding(TelnetEncoding.GBK)
        assertEquals(0, decoder.bufferedBytes)
        assertEquals(TelnetEncoding.GBK, decoder.encoding)
    }

    @Test
    fun finishFlushesATruncatedTail() {
        val decoder = TelnetStreamDecoder(TelnetEncoding.UTF_8)
        decoder.decode("中".toByteArray(Charsets.UTF_8).copyOfRange(0, 2))
        // Not lost silently: the user sees a replacement character where bytes were cut off.
        assertEquals("\uFFFD", decoder.finish())
        assertEquals(0, decoder.bufferedBytes)
    }
}
