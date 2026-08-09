package one.zephyr.mobile.protocol.zft2

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import one.zephyr.mobile.contracts.Zft2Contract

/**
 * Byte-exact ZFT2 codec.
 *
 * Ported from `file-transfer-protocol.js` and cross-checked against the Dart agent
 * implementation. "Byte-exact" is a hard requirement rather than an aspiration: the same frame is
 * produced by three languages and consumed by all three, so `contracts/generated/zft2-frames.json`
 * pins the exact hex of five representative frames plus five rejection cases.
 *
 * Header layout (all multi-byte fields big-endian), ZEPHYR_PARITY.md 10.2:
 *
 * ```text
 * [0..3]  magic "ZFT2"
 * [4]     version (2)
 * [5]     op
 * [6..7]  u16 flags
 * [8..11] u32 requestId
 * [12..15] u32 metaLen
 * [16..19] u32 payloadLen
 * ```
 */
object Zft2Codec {

    /**
     * Metadata JSON must serialise compactly with keys in insertion order and non-ASCII written as
     * raw UTF-8, because the byte length lands in the header. Pretty-printing or \\uXXXX escaping
     * would change metaLen and desynchronise the peer.
     */
    private val json = Json {
        prettyPrint = false
        encodeDefaults = true
        explicitNulls = false
    }

    private const val EMPTY_META = "{}"

    fun encode(
        op: Int,
        requestId: Long,
        flags: Int = 0,
        meta: JsonObject? = null,
        payload: ByteArray? = null,
        maxMetaBytes: Int = Zft2Contract.MAX_META_BYTES,
        maxPayloadBytes: Int = Zft2Contract.MAX_PAYLOAD_BYTES,
    ): ByteArray {
        if (op < 0 || op > 0xFF) throw Zft2Exception("invalid_type", "Invalid ZFT2 frame type")
        if (requestId < 0L || requestId > 0xFFFFFFFFL) {
            throw Zft2Exception("invalid_request_id", "Invalid ZFT2 request id")
        }

        val metaText = if (meta == null || meta.isEmpty()) EMPTY_META else json.encodeToString(JsonObject.serializer(), meta)
        val metaBytes = metaText.toByteArray(Charsets.UTF_8)
        val payloadBytes = payload ?: ByteArray(0)

        if (metaBytes.size > maxMetaBytes) throw Zft2Exception("metadata_too_large", "ZFT2 metadata exceeds limit")
        if (payloadBytes.size > maxPayloadBytes) throw Zft2Exception("payload_too_large", "ZFT2 payload exceeds limit")

        val out = ByteArray(Zft2Contract.HEADER_BYTES + metaBytes.size + payloadBytes.size)
        Zft2Contract.MAGIC.copyInto(out, 0)
        out[4] = Zft2Contract.VERSION.toByte()
        out[5] = (op and 0xFF).toByte()
        writeU16(out, 6, flags and 0xFFFF)
        writeU32(out, 8, requestId)
        writeU32(out, 12, metaBytes.size.toLong())
        writeU32(out, 16, payloadBytes.size.toLong())
        metaBytes.copyInto(out, Zft2Contract.HEADER_BYTES)
        payloadBytes.copyInto(out, Zft2Contract.HEADER_BYTES + metaBytes.size)
        return out
    }

    /**
     * Decode exactly one frame.
     *
     * Check order is part of the contract: a truncated header is reported before magic, and the
     * length limits before the total-length comparison. A reordered check would classify a hostile
     * length bomb as a mere length mismatch and lose the reason the frame was refused.
     */
    fun decode(
        raw: ByteArray,
        maxMetaBytes: Int = Zft2Contract.MAX_META_BYTES,
        maxPayloadBytes: Int = Zft2Contract.MAX_PAYLOAD_BYTES,
    ): Zft2Frame {
        if (raw.size < Zft2Contract.HEADER_BYTES) throw Zft2Exception("truncated_header", "Truncated ZFT2 header")
        for (index in 0 until 4) {
            if (raw[index] != Zft2Contract.MAGIC[index]) throw Zft2Exception("bad_magic", "Invalid ZFT2 magic")
        }
        val version = raw[4].toInt() and 0xFF
        if (version != Zft2Contract.VERSION) {
            throw Zft2Exception("unsupported_version", "Unsupported ZFT2 version " + version)
        }

        val metaLength = readU32(raw, 12)
        val payloadLength = readU32(raw, 16)
        if (metaLength > maxMetaBytes) throw Zft2Exception("metadata_too_large", "ZFT2 metadata exceeds limit")
        if (payloadLength > maxPayloadBytes) throw Zft2Exception("payload_too_large", "ZFT2 payload exceeds limit")

        val expected = Zft2Contract.HEADER_BYTES + metaLength + payloadLength
        if (raw.size.toLong() != expected) throw Zft2Exception("length_mismatch", "ZFT2 frame length mismatch")

        val metaStart = Zft2Contract.HEADER_BYTES
        val metaEnd = metaStart + metaLength.toInt()
        val meta = if (metaLength == 0L) {
            JsonObject(emptyMap())
        } else {
            val text = String(raw, metaStart, metaLength.toInt(), Charsets.UTF_8)
            try {
                json.decodeFromString(JsonObject.serializer(), text)
            } catch (failure: Exception) {
                throw Zft2Exception("bad_metadata", "ZFT2 metadata is not valid JSON")
            }
        }

        return Zft2Frame(
            op = raw[5].toInt() and 0xFF,
            requestId = readU32(raw, 8),
            flags = readU16(raw, 6),
            meta = meta,
            payload = raw.copyOfRange(metaEnd, raw.size),
        )
    }

    /** Response to a request, reusing its op and id so the peer can correlate. */
    fun encodeResponse(request: Zft2Frame, meta: JsonObject? = null, payload: ByteArray? = null): ByteArray =
        encode(
            op = request.op,
            requestId = request.requestId,
            flags = Zft2Contract.FLAG_RESPONSE,
            meta = meta,
            payload = payload,
        )

    /** Error response. Carries only a code and message: never a path or a secret. */
    fun encodeError(request: Zft2Frame, code: String, message: String): ByteArray =
        encode(
            op = request.op,
            requestId = request.requestId,
            flags = Zft2Contract.FLAG_RESPONSE or Zft2Contract.FLAG_ERROR,
            meta = JsonObject(
                mapOf(
                    "code" to kotlinx.serialization.json.JsonPrimitive(code),
                    "message" to kotlinx.serialization.json.JsonPrimitive(message),
                ),
            ),
        )

    /** Clamp to the frozen 1..16 window; a non-numeric value falls back to the default of 8. */
    fun clampInflight(value: Int?): Int {
        if (value == null) return Zft2Contract.MAX_INFLIGHT_DEFAULT
        return value.coerceIn(Zft2Contract.MAX_INFLIGHT_MIN, Zft2Contract.MAX_INFLIGHT_MAX)
    }

    /** Negotiated chunk size is the smaller capability, never above the protocol ceiling. */
    fun negotiateChunk(localMax: Int?, remoteMax: Int?): Int {
        val local = localMax ?: Zft2Contract.MAX_PAYLOAD_BYTES
        val remote = remoteMax ?: Zft2Contract.MAX_PAYLOAD_BYTES
        return maxOf(1, minOf(Zft2Contract.MAX_PAYLOAD_BYTES, local, remote))
    }

    // ---- unsigned big-endian helpers ------------------------------------------------------------

    private fun writeU16(out: ByteArray, offset: Int, value: Int) {
        out[offset] = ((value shr 8) and 0xFF).toByte()
        out[offset + 1] = (value and 0xFF).toByte()
    }

    private fun writeU32(out: ByteArray, offset: Int, value: Long) {
        out[offset] = ((value shr 24) and 0xFF).toByte()
        out[offset + 1] = ((value shr 16) and 0xFF).toByte()
        out[offset + 2] = ((value shr 8) and 0xFF).toByte()
        out[offset + 3] = (value and 0xFF).toByte()
    }

    fun readU16(raw: ByteArray, offset: Int): Int =
        ((raw[offset].toInt() and 0xFF) shl 8) or (raw[offset + 1].toInt() and 0xFF)

    /** Returns Long so 0xFFFFFFFF stays positive. */
    fun readU32(raw: ByteArray, offset: Int): Long =
        ((raw[offset].toLong() and 0xFF) shl 24) or
            ((raw[offset + 1].toLong() and 0xFF) shl 16) or
            ((raw[offset + 2].toLong() and 0xFF) shl 8) or
            (raw[offset + 3].toLong() and 0xFF)
}
