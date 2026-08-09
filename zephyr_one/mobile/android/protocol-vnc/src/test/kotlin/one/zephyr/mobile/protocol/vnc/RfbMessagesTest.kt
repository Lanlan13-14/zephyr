package one.zephyr.mobile.protocol.vnc

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Client-to-server message layout.
 *
 * Asserted byte for byte because the padding bytes are part of the wire format: a message that is
 * one byte short does not fail, it shifts every following message and the session dies several
 * exchanges later somewhere unrelated.
 */
class RfbMessagesTest {

    @Test
    fun `message type numbers match the RFB registry`() {
        assertEquals(0, RfbClientMessage.SET_PIXEL_FORMAT)
        assertEquals(2, RfbClientMessage.SET_ENCODINGS)
        assertEquals(3, RfbClientMessage.FRAMEBUFFER_UPDATE_REQUEST)
        assertEquals(4, RfbClientMessage.KEY_EVENT)
        assertEquals(5, RfbClientMessage.POINTER_EVENT)
        assertEquals(6, RfbClientMessage.CLIENT_CUT_TEXT)

        assertEquals(0, RfbServerMessage.FRAMEBUFFER_UPDATE)
        assertEquals(1, RfbServerMessage.SET_COLOUR_MAP_ENTRIES)
        assertEquals(2, RfbServerMessage.BELL)
        assertEquals(3, RfbServerMessage.SERVER_CUT_TEXT)
    }

    @Test
    fun `SetPixelFormat is a type byte three padding bytes and the format`() {
        assertEquals(
            "000000002018000100ff00ff00ff100800000000",
            RfbEncoder.setPixelFormat(RfbPixelFormat.RGB888).toHex(),
        )
        assertEquals(20, RfbEncoder.setPixelFormat(RfbPixelFormat.RGB565).size)
    }

    @Test
    fun `SetEncodings writes a count then one signed int per encoding`() {
        val message = RfbEncoder.setEncodings(
            listOf(RfbEncoding.ZRLE, RfbEncoding.RAW, RfbEncoding.LAST_RECT),
        )
        // Type 02, one padding byte, count 0003, then 16, 0 and -224 as big-endian s32.
        assertEquals("020000030000001000000000ffffff20", message.toHex())
    }

    @Test
    fun `SetEncodings with no encodings is still well formed`() {
        assertEquals("02000000", RfbEncoder.setEncodings(emptyList()).toHex())
    }

    @Test
    fun `an incremental FramebufferUpdateRequest asks for the whole viewport`() {
        assertEquals(
            "03010000000004000300",
            RfbEncoder.framebufferUpdateRequest(true, 0, 0, 1024, 768).toHex(),
        )
    }

    @Test
    fun `a full FramebufferUpdateRequest clears the incremental flag`() {
        // Only correct after a resize or a decode failure; per frame it turns the session into a
        // bandwidth hog.
        assertEquals(
            "0300000a001400640032",
            RfbEncoder.framebufferUpdateRequest(false, 10, 20, 100, 50).toHex(),
        )
    }

    @Test
    fun `KeyEvent carries a keysym and a down flag`() {
        assertEquals("040100000000ff0d", RfbEncoder.keyEvent(X11Keysym.RETURN, down = true).toHex())
        assertEquals("0400000000000061", RfbEncoder.keyEvent(0x61, down = false).toHex())
    }

    @Test
    fun `PointerEvent carries the button mask and position`() {
        assertEquals("0501006400c8", RfbEncoder.pointerEvent(RfbButton.LEFT, 100, 200).toHex())
        assertEquals("050000000000", RfbEncoder.pointerEvent(0, 0, 0).toHex())
    }

    @Test
    fun `button mask bits are single bits so they can be combined`() {
        assertEquals(1, RfbButton.LEFT)
        assertEquals(2, RfbButton.MIDDLE)
        assertEquals(4, RfbButton.RIGHT)
        assertEquals(8, RfbButton.WHEEL_UP)
        assertEquals(16, RfbButton.WHEEL_DOWN)
        val leftAndRight = RfbButton.LEFT or RfbButton.RIGHT
        assertEquals("0505006400c8", RfbEncoder.pointerEvent(leftAndRight, 100, 200).toHex())
    }

    @Test
    fun `ClientCutText writes a length prefixed Latin-1 body`() {
        assertEquals("06000000000000026869", RfbEncoder.clientCutText("hi").toHex())
    }

    @Test
    fun `ClientCutText replaces characters outside Latin-1`() {
        // A real interoperability limit of the base protocol, not a shortcut: CJK clipboard needs
        // the extended clipboard pseudo-encoding, which depends on the core ADR-005 has not chosen.
        val encoded = RfbEncoder.clientCutText("研")
        assertEquals("06000000000000013f", encoded.toHex())
    }

    @Test
    fun `ClientCutText truncates an oversized paste instead of sending it`() {
        val huge = "z".repeat(RfbEncoder.MAX_CUT_TEXT_CHARS + 5000)
        val encoded = RfbEncoder.clientCutText(huge)
        assertEquals(8 + RfbEncoder.MAX_CUT_TEXT_CHARS, encoded.size)
    }

    @Test
    fun `printable Latin-1 maps straight to its code point`() {
        assertEquals(0x41, X11Keysym.unicode(0x41))
        assertEquals(0x20, X11Keysym.unicode(0x20))
        assertEquals(0xFF, X11Keysym.unicode(0xFF))
    }

    @Test
    fun `anything outside Latin-1 uses the Unicode keysym range`() {
        // What makes CJK IME composition work over VNC.
        assertEquals(0x0100_7814, X11Keysym.unicode(0x7814))
        assertEquals(0x0100_0100, X11Keysym.unicode(0x100))
        // Control characters are below the printable range and take the same form; a terminal wants
        // the dedicated keysym instead, which is why RETURN exists as a constant.
        assertEquals(0x0100_001F, X11Keysym.unicode(0x1F))
    }

    @Test
    fun `function keys are contiguous from F1`() {
        assertEquals(0xFFBE, X11Keysym.function(1))
        assertEquals(0xFFBF, X11Keysym.function(2))
        assertEquals(0xFFC9, X11Keysym.function(12))
    }

    @Test(expected = IllegalArgumentException::class)
    fun `a function key beyond F12 is refused`() {
        X11Keysym.function(13)
    }

    @Test
    fun `navigation keysyms match the X11 numbers`() {
        assertEquals(0xFF08, X11Keysym.BACK_SPACE)
        assertEquals(0xFF09, X11Keysym.TAB)
        assertEquals(0xFF0D, X11Keysym.RETURN)
        assertEquals(0xFF1B, X11Keysym.ESCAPE)
        assertEquals(0xFFFF, X11Keysym.DELETE)
        assertEquals(0xFF51, X11Keysym.LEFT)
        assertEquals(0xFF52, X11Keysym.UP)
        assertEquals(0xFF53, X11Keysym.RIGHT)
        assertEquals(0xFF54, X11Keysym.DOWN)
        assertEquals(0xFFE3, X11Keysym.CONTROL_LEFT)
    }

    @Test
    fun `a rectangle header decodes its geometry and encoding`() {
        val header = RfbRectangleHeader.decode(hex("000a 0014 0064 0032 00000000"))
        assertEquals(10, header.x)
        assertEquals(20, header.y)
        assertEquals(100, header.width)
        assertEquals(50, header.height)
        assertEquals(RfbEncoding.RAW, header.encoding)
        assertFalse(header.isPseudoEncoding)
        assertFalse(header.isLastRect)
    }

    @Test
    fun `a negative encoding is read as a pseudo encoding`() {
        val lastRect = RfbRectangleHeader.decode(hex("0000 0000 0000 0000 ffffff20"))
        assertEquals(RfbEncoding.LAST_RECT, lastRect.encoding)
        assertTrue(lastRect.isPseudoEncoding)
        assertTrue(lastRect.isLastRect)

        val cursor = RfbRectangleHeader.decode(hex("0000 0000 0010 0010 ffffff11"))
        assertEquals(RfbEncoding.CURSOR, cursor.encoding)
        assertTrue(cursor.isPseudoEncoding)
        assertFalse("only LastRect ends the update", cursor.isLastRect)
    }

    @Test
    fun `a rectangle header decodes from an offset`() {
        val buffer = hex("00 0001") + hex("0005 0006 0007 0008 00000001")
        val header = RfbRectangleHeader.decode(buffer, 3)
        assertEquals(5, header.x)
        assertEquals(RfbEncoding.COPY_RECT, header.encoding)
    }

    @Test(expected = IllegalArgumentException::class)
    fun `a short rectangle header is refused`() {
        RfbRectangleHeader.decode(ByteArray(RfbRectangleHeader.BYTES - 1))
    }
}
