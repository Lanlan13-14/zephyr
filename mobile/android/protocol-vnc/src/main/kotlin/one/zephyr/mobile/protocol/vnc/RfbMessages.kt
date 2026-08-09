package one.zephyr.mobile.protocol.vnc

/** Client-to-server message type numbers. */
object RfbClientMessage {
    const val SET_PIXEL_FORMAT = 0
    const val SET_ENCODINGS = 2
    const val FRAMEBUFFER_UPDATE_REQUEST = 3
    const val KEY_EVENT = 4
    const val POINTER_EVENT = 5
    const val CLIENT_CUT_TEXT = 6
}

/** Server-to-client message type numbers. */
object RfbServerMessage {
    const val FRAMEBUFFER_UPDATE = 0
    const val SET_COLOUR_MAP_ENTRIES = 1
    const val BELL = 2
    const val SERVER_CUT_TEXT = 3
}

/** Pointer button mask bits, as used by [RfbEncoder.pointerEvent]. */
object RfbButton {
    const val LEFT = 1
    const val MIDDLE = 2
    const val RIGHT = 4
    const val WHEEL_UP = 8
    const val WHEEL_DOWN = 16
    const val WHEEL_LEFT = 32
    const val WHEEL_RIGHT = 64
}

/**
 * X11 keysyms RFB carries on the wire.
 *
 * RFB does not use scan codes: KeyEvent carries an X11 keysym, so the mapping from a platform key
 * code lives above this module but the keysym numbers themselves are protocol constants. Only the
 * keys a terminal or desktop session cannot work without are listed; printable ASCII is its own
 * code point, and other characters follow the Unicode rule in [unicode].
 */
object X11Keysym {
    const val BACK_SPACE = 0xFF08
    const val TAB = 0xFF09
    const val RETURN = 0xFF0D
    const val ESCAPE = 0xFF1B
    const val INSERT = 0xFF63
    const val DELETE = 0xFFFF
    const val HOME = 0xFF50
    const val END = 0xFF57
    const val PAGE_UP = 0xFF55
    const val PAGE_DOWN = 0xFF56
    const val LEFT = 0xFF51
    const val UP = 0xFF52
    const val RIGHT = 0xFF53
    const val DOWN = 0xFF54
    const val F1 = 0xFFBE
    const val SHIFT_LEFT = 0xFFE1
    const val CONTROL_LEFT = 0xFFE3
    const val META_LEFT = 0xFFE7
    const val ALT_LEFT = 0xFFE9
    const val SUPER_LEFT = 0xFFEB

    /** F1..F12 are contiguous from [F1]. */
    fun function(index: Int): Int {
        require(index in 1..12) { "Function key index must be 1..12 but was " + index }
        return F1 + (index - 1)
    }

    /**
     * Keysym for a Unicode code point.
     *
     * Latin-1 maps directly; everything else uses the 0x01000000 + code point form. This is what
     * makes CJK IME composition work over VNC, which REMOTE_DESKTOP_EXPERIENCE.md requires.
     */
    fun unicode(codePoint: Int): Int = if (codePoint in 0x20..0xFF) codePoint else 0x0100_0000 + codePoint
}

/**
 * Builds client-to-server messages.
 *
 * Byte layout is the protocol, so it is encoded here once and pinned by tests rather than being
 * open-coded next to whichever engine ADR-005 ends up linking. Every message is fixed-layout
 * big-endian; the padding bytes are part of the wire format and must be present.
 */
object RfbEncoder {

    /** u8 type, 3 padding, 16-byte pixel format. */
    fun setPixelFormat(format: RfbPixelFormat): ByteArray {
        val out = ByteArray(4 + RfbPixelFormat.SIZE_BYTES)
        out[0] = RfbClientMessage.SET_PIXEL_FORMAT.toByte()
        format.encode().copyInto(out, 4)
        return out
    }

    /** u8 type, 1 padding, u16 count, then one s32 per encoding in preference order. */
    fun setEncodings(encodings: List<Int>): ByteArray {
        require(encodings.size <= 0xFFFF) { "Too many encodings: " + encodings.size }
        val out = ByteArray(4 + encodings.size * 4)
        out[0] = RfbClientMessage.SET_ENCODINGS.toByte()
        writeU16(out, 2, encodings.size)
        var offset = 4
        for (encoding in encodings) {
            writeS32(out, offset, encoding)
            offset += 4
        }
        return out
    }

    /**
     * u8 type, u8 incremental, u16 x, y, width, height.
     *
     * [incremental] false forces a full repaint and is only correct after a resize or a decode
     * failure: sending it per frame is the classic way to turn a VNC session into a bandwidth hog.
     */
    fun framebufferUpdateRequest(
        incremental: Boolean,
        x: Int,
        y: Int,
        width: Int,
        height: Int,
    ): ByteArray {
        val out = ByteArray(10)
        out[0] = RfbClientMessage.FRAMEBUFFER_UPDATE_REQUEST.toByte()
        out[1] = if (incremental) 1 else 0
        writeU16(out, 2, x)
        writeU16(out, 4, y)
        writeU16(out, 6, width)
        writeU16(out, 8, height)
        return out
    }

    /** u8 type, u8 down flag, 2 padding, u32 keysym. */
    fun keyEvent(keysym: Int, down: Boolean): ByteArray {
        val out = ByteArray(8)
        out[0] = RfbClientMessage.KEY_EVENT.toByte()
        out[1] = if (down) 1 else 0
        writeS32(out, 4, keysym)
        return out
    }

    /** u8 type, u8 button mask, u16 x, u16 y. */
    fun pointerEvent(buttonMask: Int, x: Int, y: Int): ByteArray {
        val out = ByteArray(6)
        out[0] = RfbClientMessage.POINTER_EVENT.toByte()
        out[1] = (buttonMask and 0xFF).toByte()
        writeU16(out, 2, x)
        writeU16(out, 4, y)
        return out
    }

    /**
     * u8 type, 3 padding, u32 length, then Latin-1 text.
     *
     * The base protocol clipboard is Latin-1 only, so characters outside it become '?'. That is a
     * real interoperability limit rather than a shortcut: carrying CJK text needs the extended
     * clipboard pseudo-encoding, which depends on the core ADR-005 has not chosen yet.
     */
    fun clientCutText(text: String): ByteArray {
        val body = text.take(MAX_CUT_TEXT_CHARS).toByteArray(Charsets.ISO_8859_1)
        val out = ByteArray(8 + body.size)
        out[0] = RfbClientMessage.CLIENT_CUT_TEXT.toByte()
        writeS32(out, 4, body.size)
        body.copyInto(out, 8)
        return out
    }

    /**
     * Cap on outgoing clipboard text.
     *
     * A clipboard paste is user-triggered and unbounded; some servers drop the connection on an
     * oversized cut text, so it is truncated here where the limit is visible.
     */
    const val MAX_CUT_TEXT_CHARS = 1 shl 20

    private fun writeU16(target: ByteArray, offset: Int, value: Int) {
        target[offset] = ((value shr 8) and 0xFF).toByte()
        target[offset + 1] = (value and 0xFF).toByte()
    }

    private fun writeS32(target: ByteArray, offset: Int, value: Int) {
        target[offset] = ((value shr 24) and 0xFF).toByte()
        target[offset + 1] = ((value shr 16) and 0xFF).toByte()
        target[offset + 2] = ((value shr 8) and 0xFF).toByte()
        target[offset + 3] = (value and 0xFF).toByte()
    }
}

/**
 * One rectangle header inside a FramebufferUpdate.
 *
 * [encoding] is signed because pseudo-encodings are negative, and treating it as unsigned is how a
 * DesktopSize or LastRect pseudo-rectangle gets mistaken for an unknown real encoding.
 */
data class RfbRectangleHeader(
    val x: Int,
    val y: Int,
    val width: Int,
    val height: Int,
    val encoding: Int,
) {
    val isPseudoEncoding: Boolean get() = encoding < 0

    /** LastRect reports "no more rectangles" instead of a count, so its geometry is meaningless. */
    val isLastRect: Boolean get() = encoding == RfbEncoding.LAST_RECT

    companion object {
        const val BYTES = 12

        fun decode(bytes: ByteArray, offset: Int = 0): RfbRectangleHeader {
            require(bytes.size - offset >= BYTES) { "Rectangle header needs " + BYTES + " bytes" }
            return RfbRectangleHeader(
                x = RfbPixelFormat.readU16(bytes, offset),
                y = RfbPixelFormat.readU16(bytes, offset + 2),
                width = RfbPixelFormat.readU16(bytes, offset + 4),
                height = RfbPixelFormat.readU16(bytes, offset + 6),
                encoding = (bytes[offset + 8].toInt() shl 24) or
                    ((bytes[offset + 9].toInt() and 0xFF) shl 16) or
                    ((bytes[offset + 10].toInt() and 0xFF) shl 8) or
                    (bytes[offset + 11].toInt() and 0xFF),
            )
        }
    }
}
