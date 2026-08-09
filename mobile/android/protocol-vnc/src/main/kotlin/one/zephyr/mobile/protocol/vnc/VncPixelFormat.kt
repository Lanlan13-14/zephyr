package one.zephyr.mobile.protocol.vnc

/**
 * The 16-byte RFB PIXEL_FORMAT structure.
 *
 * Modelled explicitly rather than passed through as opaque bytes because ADR-005 gates on "常见
 * pixel format/encoding": the shift/max quadruple is what decides whether a decoded framebuffer
 * looks correct or channel-swapped, and a mismatch here is invisible until a user reports wrong
 * colours. Encoding and decoding are exact inverses so a fixture can round-trip.
 */
data class RfbPixelFormat(
    val bitsPerPixel: Int,
    val depth: Int,
    /** True when multi-byte pixel values arrive most-significant byte first. */
    val bigEndian: Boolean,
    /** False means the server sends colour-map indices and all max/shift fields are zero. */
    val trueColour: Boolean,
    val redMax: Int,
    val greenMax: Int,
    val blueMax: Int,
    val redShift: Int,
    val greenShift: Int,
    val blueShift: Int,
) {
    init {
        // RFB permits only these three widths. A server announcing anything else is unusable, and
        // failing here is better than allocating a framebuffer with a fractional stride.
        require(bitsPerPixel == 8 || bitsPerPixel == 16 || bitsPerPixel == 32) {
            "bitsPerPixel must be 8, 16 or 32 but was " + bitsPerPixel
        }
        require(depth in 1..32) { "depth out of range: " + depth }
        require(depth <= bitsPerPixel) { "depth " + depth + " exceeds bitsPerPixel " + bitsPerPixel }
        if (trueColour) {
            require(redMax in 1..65535) { "redMax out of range: " + redMax }
            require(greenMax in 1..65535) { "greenMax out of range: " + greenMax }
            require(blueMax in 1..65535) { "blueMax out of range: " + blueMax }
            require(redShift in 0..31) { "redShift out of range: " + redShift }
            require(greenShift in 0..31) { "greenShift out of range: " + greenShift }
            require(blueShift in 0..31) { "blueShift out of range: " + blueShift }
        }
    }

    val bytesPerPixel: Int get() = bitsPerPixel / 8

    /** Bits actually used per channel, derived from the max. Useful when picking a local surface. */
    val redBits: Int get() = Integer.bitCount(redMax)
    val greenBits: Int get() = Integer.bitCount(greenMax)
    val blueBits: Int get() = Integer.bitCount(blueMax)

    fun encode(): ByteArray {
        val out = ByteArray(SIZE_BYTES)
        out[0] = bitsPerPixel.toByte()
        out[1] = depth.toByte()
        out[2] = if (bigEndian) 1 else 0
        out[3] = if (trueColour) 1 else 0
        writeU16(out, 4, redMax)
        writeU16(out, 6, greenMax)
        writeU16(out, 8, blueMax)
        out[10] = redShift.toByte()
        out[11] = greenShift.toByte()
        out[12] = blueShift.toByte()
        // Bytes 13..15 stay zero: the spec calls them padding and some servers reject non-zero.
        return out
    }

    companion object {
        const val SIZE_BYTES = 16

        /**
         * Reads a pixel format out of a larger buffer.
         *
         * Throws [IllegalArgumentException] on a structurally impossible format so the handshake can
         * map it to a single stable error code instead of carrying a half-valid struct forward.
         */
        fun decode(bytes: ByteArray, offset: Int = 0): RfbPixelFormat {
            require(offset >= 0 && bytes.size - offset >= SIZE_BYTES) {
                "pixel format needs " + SIZE_BYTES + " bytes at offset " + offset
            }
            return RfbPixelFormat(
                bitsPerPixel = bytes[offset].toInt() and 0xFF,
                depth = bytes[offset + 1].toInt() and 0xFF,
                bigEndian = bytes[offset + 2].toInt() != 0,
                trueColour = bytes[offset + 3].toInt() != 0,
                redMax = readU16(bytes, offset + 4),
                greenMax = readU16(bytes, offset + 6),
                blueMax = readU16(bytes, offset + 8),
                redShift = bytes[offset + 10].toInt() and 0xFF,
                greenShift = bytes[offset + 11].toInt() and 0xFF,
                blueShift = bytes[offset + 12].toInt() and 0xFF,
            )
        }

        internal fun readU16(bytes: ByteArray, offset: Int): Int =
            ((bytes[offset].toInt() and 0xFF) shl 8) or (bytes[offset + 1].toInt() and 0xFF)

        internal fun writeU16(out: ByteArray, offset: Int, value: Int) {
            out[offset] = ((value shr 8) and 0xFF).toByte()
            out[offset + 1] = (value and 0xFF).toByte()
        }

        /**
         * 32bpp little-endian RGB.
         *
         * The preferred request on both platforms: it matches Android ARGB_8888 and iOS
         * BGRA8888 surfaces closely enough that the adapter converts with a byte shuffle rather
         * than a per-pixel rescale.
         */
        val RGB888 = RfbPixelFormat(
            bitsPerPixel = 32,
            depth = 24,
            bigEndian = false,
            trueColour = true,
            redMax = 255,
            greenMax = 255,
            blueMax = 255,
            redShift = 16,
            greenShift = 8,
            blueShift = 0,
        )

        /** Same widths with the channels swapped, which is what several servers offer natively. */
        val BGR888 = RGB888.copy(redShift = 0, blueShift = 16)

        /**
         * 16bpp 5-6-5.
         *
         * Halves framebuffer traffic, which matters on the weak-network path in
         * REMOTE_DESKTOP_EXPERIENCE.md. Requested only when the user picks a bandwidth-saving
         * quality, never silently: the banding is visible.
         */
        val RGB565 = RfbPixelFormat(
            bitsPerPixel = 16,
            depth = 16,
            bigEndian = false,
            trueColour = true,
            redMax = 31,
            greenMax = 63,
            blueMax = 31,
            redShift = 11,
            greenShift = 5,
            blueShift = 0,
        )
    }
}

/**
 * RFB encoding numbers.
 *
 * Kept as constants rather than an enum because the wire field is a signed 32-bit integer whose
 * negative half is an open-ended pseudo-encoding space; an enum would have to be edited every time
 * a server offers something new, and unknown values must survive being read.
 */
object RfbEncoding {
    const val RAW = 0
    const val COPY_RECT = 1
    const val RRE = 2
    const val CO_RRE = 4
    const val HEXTILE = 5
    const val ZLIB = 6
    const val TIGHT = 7
    const val ZLIBHEX = 8
    const val TRLE = 15
    const val ZRLE = 16

    /** Pseudo-encodings: capability announcements, not pixel data. */
    const val CURSOR = -239
    const val DESKTOP_SIZE = -223
    const val LAST_RECT = -224
    const val QEMU_EXTENDED_KEY_EVENT = -258
    const val FENCE = -312
    const val CONTINUOUS_UPDATES = -313
    const val EXTENDED_DESKTOP_SIZE = -308

    fun name(value: Int): String = when (value) {
        RAW -> "Raw"
        COPY_RECT -> "CopyRect"
        RRE -> "RRE"
        CO_RRE -> "CoRRE"
        HEXTILE -> "Hextile"
        ZLIB -> "Zlib"
        TIGHT -> "Tight"
        ZLIBHEX -> "ZlibHex"
        TRLE -> "TRLE"
        ZRLE -> "ZRLE"
        CURSOR -> "Cursor"
        DESKTOP_SIZE -> "DesktopSize"
        LAST_RECT -> "LastRect"
        QEMU_EXTENDED_KEY_EVENT -> "QemuExtendedKeyEvent"
        FENCE -> "Fence"
        CONTINUOUS_UPDATES -> "ContinuousUpdates"
        EXTENDED_DESKTOP_SIZE -> "ExtendedDesktopSize"
        else -> "Unknown(" + value + ")"
    }
}

/**
 * Decides what to advertise in SetEncodings.
 *
 * The rule that makes this worth a separate object: an encoding may only be advertised if the linked
 * RFB core can decode it. Announcing ZRLE to save bandwidth and then meeting a ZRLE rectangle with
 * no decoder corrupts the stream with no recoverable error, and since ADR-005 leaves the core choice
 * open on a licence audit, the supported set is a runtime input rather than a compile-time list.
 */
object RfbEncodingPolicy {

    /** Most to least preferred. Bandwidth first: the target is a phone on mobile data. */
    val PREFERENCE_ORDER = listOf(
        RfbEncoding.ZRLE,
        RfbEncoding.TIGHT,
        RfbEncoding.TRLE,
        RfbEncoding.HEXTILE,
        RfbEncoding.ZLIBHEX,
        RfbEncoding.ZLIB,
        RfbEncoding.RRE,
        RfbEncoding.CO_RRE,
        RfbEncoding.COPY_RECT,
    )

    /** Requested when supported; each one removes a round trip or a full-screen redraw. */
    val PSEUDO_ORDER = listOf(
        RfbEncoding.LAST_RECT,
        RfbEncoding.CURSOR,
        RfbEncoding.EXTENDED_DESKTOP_SIZE,
        RfbEncoding.DESKTOP_SIZE,
        RfbEncoding.CONTINUOUS_UPDATES,
        RfbEncoding.FENCE,
        RfbEncoding.QEMU_EXTENDED_KEY_EVENT,
    )

    /**
     * Every RFB server must implement Raw, so it is always advertised and always last: it is the
     * fallback that guarantees the stream stays decodable.
     */
    fun advertise(coreSupports: Set<Int>): List<Int> {
        val real = PREFERENCE_ORDER.filter { it != RfbEncoding.RAW && it in coreSupports }
        val pseudo = PSEUDO_ORDER.filter { it in coreSupports }
        return real + RfbEncoding.RAW + pseudo
    }
}
