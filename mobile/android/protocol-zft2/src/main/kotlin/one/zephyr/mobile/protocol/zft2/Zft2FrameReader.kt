package one.zephyr.mobile.protocol.zft2

import one.zephyr.mobile.contracts.Zft2Contract

/**
 * Reassembles frames from a byte stream.
 *
 * A TCP read boundary has nothing to do with a frame boundary, so the header may arrive split across
 * two reads and several frames may arrive in one. The reader therefore buffers until a whole frame is
 * present rather than assuming one read equals one frame - the single most common way a hand-rolled
 * binary client corrupts a session.
 *
 * Not thread-safe by design: one reader belongs to one connection, and the session owns the
 * coroutine that feeds it.
 */
class Zft2FrameReader(
    private val maxMetaBytes: Int = Zft2Contract.MAX_META_BYTES,
    private val maxPayloadBytes: Int = Zft2Contract.MAX_PAYLOAD_BYTES,
) {

    private var buffer = ByteArray(0)

    val bufferedBytes: Int get() = buffer.size

    /**
     * Append bytes and return every complete frame now available.
     *
     * @throws Zft2Exception on a structurally invalid frame. The caller must drop the connection: a
     *   stream that has lost frame alignment cannot be resynchronised, and scanning forward for the
     *   next magic would let an attacker choose the next frame boundary.
     */
    fun feed(chunk: ByteArray): List<Zft2Frame> {
        if (chunk.isEmpty()) return emptyList()
        buffer = if (buffer.isEmpty()) chunk.copyOf() else buffer + chunk

        val frames = mutableListOf<Zft2Frame>()
        while (true) {
            if (buffer.size < Zft2Contract.HEADER_BYTES) break

            // Validate the header before trusting its lengths, so a bad-magic stream fails now
            // rather than after buffering a bogus multi-megabyte length.
            for (index in 0 until 4) {
                if (buffer[index] != Zft2Contract.MAGIC[index]) {
                    throw Zft2Exception("bad_magic", "Invalid ZFT2 magic")
                }
            }
            val version = buffer[4].toInt() and 0xFF
            if (version != Zft2Contract.VERSION) {
                throw Zft2Exception("unsupported_version", "Unsupported ZFT2 version " + version)
            }

            val metaLength = Zft2Codec.readU32(buffer, 12)
            val payloadLength = Zft2Codec.readU32(buffer, 16)
            if (metaLength > maxMetaBytes) throw Zft2Exception("metadata_too_large", "ZFT2 metadata exceeds limit")
            if (payloadLength > maxPayloadBytes) throw Zft2Exception("payload_too_large", "ZFT2 payload exceeds limit")

            val total = Zft2Contract.HEADER_BYTES + metaLength + payloadLength
            if (buffer.size < total) break

            val frameBytes = buffer.copyOfRange(0, total.toInt())
            frames.add(Zft2Codec.decode(frameBytes, maxMetaBytes, maxPayloadBytes))
            buffer = buffer.copyOfRange(total.toInt(), buffer.size)
        }
        return frames
    }

    fun reset() {
        buffer = ByteArray(0)
    }
}
