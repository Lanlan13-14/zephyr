package one.zephyr.mobile.protocol.telnet

import java.nio.ByteBuffer
import java.nio.CharBuffer
import java.nio.charset.CharsetDecoder
import java.nio.charset.CodingErrorAction

/**
 * Incremental byte-to-text decoding for a Telnet stream.
 *
 * Telnet has no encoding negotiation, so the charset is a user setting (DEVELOPMENT.md 14.2). The
 * reason this is a stateful object rather than a `String(bytes, charset)` call is that a multi-byte
 * character routinely straddles a TCP read boundary: a GBK ideograph split across two packets
 * decodes to two replacement characters if each chunk is converted independently. The undecoded tail
 * is carried to the next chunk instead.
 *
 * Malformed input is replaced rather than thrown, because a terminal that dies on one bad byte from
 * a mislabelled legacy device is worse than one that shows a replacement character.
 */
class TelnetStreamDecoder(encoding: TelnetEncoding = TelnetEncoding.UTF_8) {

    var encoding: TelnetEncoding = encoding
        private set

    private var decoder: CharsetDecoder = newDecoder(encoding)
    private var carry: ByteArray = ByteArray(0)

    val bufferedBytes: Int get() = carry.size

    /**
     * Switches charset mid-session.
     *
     * The carry is dropped because a partial character in the old encoding is meaningless in the
     * new one. At most a few bytes of already-arrived output are lost, which is the correct trade
     * against emitting a garbage character on every switch.
     */
    fun setEncoding(next: TelnetEncoding) {
        if (next == encoding) return
        encoding = next
        decoder = newDecoder(next)
        carry = ByteArray(0)
    }

    fun decode(chunk: ByteArray): String {
        if (chunk.isEmpty() && carry.isEmpty()) return ""
        val input = if (carry.isEmpty()) chunk else carry + chunk
        carry = ByteArray(0)

        val source = ByteBuffer.wrap(input)
        // Worst case one char per byte for every charset in TelnetEncoding.
        val target = CharBuffer.allocate(input.size + 1)
        decoder.decode(source, target, false)
        if (source.hasRemaining()) {
            // An incomplete trailing character: hold it for the next chunk. Bounded by the longest
            // sequence any supported charset uses, so a stream of malformed lead bytes cannot grow
            // this without limit.
            carry = ByteArray(source.remaining())
            source.get(carry)
            if (carry.size > MAX_CARRY_BYTES) carry = ByteArray(0)
        }
        target.flip()
        return target.toString()
    }

    /** Flushes any held bytes at end of stream, so a truncated character is not silently dropped. */
    fun finish(): String {
        if (carry.isEmpty()) return ""
        val source = ByteBuffer.wrap(carry)
        val target = CharBuffer.allocate(carry.size + 1)
        carry = ByteArray(0)
        decoder.decode(source, target, true)
        decoder.flush(target)
        target.flip()
        return target.toString()
    }

    fun reset() {
        carry = ByteArray(0)
        decoder.reset()
    }

    private companion object {
        const val MAX_CARRY_BYTES = 8

        fun newDecoder(encoding: TelnetEncoding): CharsetDecoder =
            charset(encoding.charsetName).newDecoder()
                .onMalformedInput(CodingErrorAction.REPLACE)
                .onUnmappableCharacter(CodingErrorAction.REPLACE)
    }
}
