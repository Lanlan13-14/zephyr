package one.zephyr.mobile.protocol.vnc

import java.io.EOFException

/**
 * A scripted [RfbByteChannel].
 *
 * The handshake is a strict request/response sequence, so a recorded script plus a recording of what
 * the client wrote is enough to pin every branch - including the ones that are only wrong by an
 * offset, such as reading a SecurityResult that RFB 3.3 never sends.
 */
class FakeRfbChannel(script: ByteArray) : RfbByteChannel {

    private val inbound = script
    private var readOffset = 0
    private val outbound = StringBuilder()

    /** Everything the client sent, in order, as lowercase hex. */
    val written: String get() = outbound.toString()

    val unreadBytes: Int get() = inbound.size - readOffset

    override suspend fun readFully(count: Int): ByteArray {
        if (readOffset + count > inbound.size) {
            // Exactly what a real socket does when the peer hangs up mid-handshake.
            throw EOFException("script exhausted: wanted " + count + ", had " + unreadBytes)
        }
        val slice = inbound.copyOfRange(readOffset, readOffset + count)
        readOffset += count
        return slice
    }

    override suspend fun write(bytes: ByteArray) {
        outbound.append(bytes.toHex())
    }
}

/** Assembles the server side of a handshake. Big-endian throughout, like RFB. */
class ServerScript {

    private val buffer = ArrayList<Byte>()

    fun ascii(text: String): ServerScript = bytes(text.toByteArray(Charsets.US_ASCII))

    fun u8(value: Int): ServerScript {
        buffer.add((value and 0xFF).toByte())
        return this
    }

    fun u16(value: Int): ServerScript {
        u8(value shr 8)
        u8(value)
        return this
    }

    fun u32(value: Long): ServerScript {
        u8((value shr 24).toInt())
        u8((value shr 16).toInt())
        u8((value shr 8).toInt())
        u8(value.toInt())
        return this
    }

    fun u32(value: Int): ServerScript = u32(value.toLong())

    fun bytes(source: ByteArray): ServerScript {
        for (byte in source) buffer.add(byte)
        return this
    }

    /** A u32 length followed by UTF-8 bytes, the shape RFB uses for every server-supplied string. */
    fun string(text: String): ServerScript {
        val encoded = text.toByteArray(Charsets.UTF_8)
        u32(encoded.size)
        return bytes(encoded)
    }

    fun build(): ByteArray = ByteArray(buffer.size) { index -> buffer[index] }
}

fun hex(text: String): ByteArray {
    val compact = text.replace(" ", "").replace("\n", "")
    require(compact.length % 2 == 0) { "hex must have an even length" }
    return ByteArray(compact.length / 2) { index ->
        compact.substring(index * 2, index * 2 + 2).toInt(16).toByte()
    }
}

fun ByteArray.toHex(): String = joinToString("") { byte ->
    val value = byte.toInt() and 0xFF
    val digits = "0123456789abcdef"
    "" + digits[value shr 4] + digits[value and 0xF]
}

/** The 16-byte challenge used by every VNC Auth vector here: 00 01 02 .. 0f. */
val SEQUENTIAL_CHALLENGE: ByteArray = ByteArray(16) { index -> index.toByte() }

/** A ServerInit body for a 1024x768 RGB888 desktop named "zephyr-lab". */
fun serverInit(
    width: Int = 1024,
    height: Int = 768,
    format: RfbPixelFormat = RfbPixelFormat.RGB888,
    name: String = "zephyr-lab",
): ServerScript = ServerScript()
    .u16(width)
    .u16(height)
    .bytes(format.encode())
    .string(name)
