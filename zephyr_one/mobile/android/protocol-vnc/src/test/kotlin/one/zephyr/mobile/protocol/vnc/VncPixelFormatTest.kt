package one.zephyr.mobile.protocol.vnc

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The 16-byte PIXEL_FORMAT struct and the encoding advertisement rule.
 *
 * Byte-exact assertions rather than round-trip only: a shift/max pair that survives a round trip can
 * still be wrong on the wire, and the symptom is channel-swapped colour that no test would catch.
 */
class VncPixelFormatTest {

    @Test
    fun `RGB888 encodes to the documented sixteen bytes`() {
        assertEquals("2018000100ff00ff00ff100800000000", RfbPixelFormat.RGB888.encode().toHex())
        assertEquals(RfbPixelFormat.SIZE_BYTES, RfbPixelFormat.RGB888.encode().size)
    }

    @Test
    fun `RGB565 encodes to the documented sixteen bytes`() {
        assertEquals("10100001001f003f001f0b0500000000", RfbPixelFormat.RGB565.encode().toHex())
    }

    @Test
    fun `RGB555 encodes the performance quality rung`() {
        assertEquals("100f0001001f001f001f0a0500000000", RfbPixelFormat.RGB555.encode().toHex())
        assertEquals(2, RfbPixelFormat.RGB555.bytesPerPixel)
        assertEquals(5, RfbPixelFormat.RGB555.greenBits)
        assertEquals(15, RfbPixelFormat.RGB555.depth)
        assertTrue(RfbPixelFormat.RGB555.trueColour)
    }

    @Test
    fun `BGR888 differs from RGB888 only in the red and blue shifts`() {
        assertEquals("2018000100ff00ff00ff000810000000", RfbPixelFormat.BGR888.encode().toHex())
        assertEquals(0, RfbPixelFormat.BGR888.redShift)
        assertEquals(16, RfbPixelFormat.BGR888.blueShift)
        assertEquals(RfbPixelFormat.RGB888.greenShift, RfbPixelFormat.BGR888.greenShift)
    }

    @Test
    fun `encode and decode are exact inverses`() {
        for (format in listOf(RfbPixelFormat.RGB888, RfbPixelFormat.BGR888, RfbPixelFormat.RGB565, RfbPixelFormat.RGB555)) {
            assertEquals(format, RfbPixelFormat.decode(format.encode()))
        }
    }

    @Test
    fun `decode reads from an offset inside a larger buffer`() {
        // ServerInit puts the pixel format at offset 4, so this is the real call shape.
        val buffer = hex("0400 0300") + RfbPixelFormat.RGB565.encode()
        assertEquals(RfbPixelFormat.RGB565, RfbPixelFormat.decode(buffer, 4))
    }

    @Test
    fun `the last three bytes stay zero because some servers reject padding`() {
        val encoded = RfbPixelFormat.RGB888.encode()
        assertEquals(0, encoded[13].toInt())
        assertEquals(0, encoded[14].toInt())
        assertEquals(0, encoded[15].toInt())
    }

    @Test
    fun `derived widths come from the channel maxima`() {
        assertEquals(4, RfbPixelFormat.RGB888.bytesPerPixel)
        assertEquals(8, RfbPixelFormat.RGB888.redBits)
        assertEquals(8, RfbPixelFormat.RGB888.greenBits)
        assertEquals(8, RfbPixelFormat.RGB888.blueBits)

        assertEquals(2, RfbPixelFormat.RGB565.bytesPerPixel)
        assertEquals(5, RfbPixelFormat.RGB565.redBits)
        assertEquals(6, RfbPixelFormat.RGB565.greenBits)
        assertEquals(5, RfbPixelFormat.RGB565.blueBits)
    }

    @Test
    fun `a colour map format needs no channel maxima`() {
        // trueColour=false means the server sends indices, so zero maxima are correct rather than
        // missing and must not be rejected.
        val indexed = RfbPixelFormat(
            bitsPerPixel = 8,
            depth = 8,
            bigEndian = false,
            trueColour = false,
            redMax = 0,
            greenMax = 0,
            blueMax = 0,
            redShift = 0,
            greenShift = 0,
            blueShift = 0,
        )
        assertEquals("08080000000000000000000000000000", indexed.encode().toHex())
        assertEquals(indexed, RfbPixelFormat.decode(indexed.encode()))
        assertFalse(indexed.trueColour)
    }

    @Test
    fun `the big endian flag survives a round trip`() {
        val bigEndian = RfbPixelFormat.RGB888.copy(bigEndian = true)
        assertEquals(1, bigEndian.encode()[2].toInt())
        assertTrue(RfbPixelFormat.decode(bigEndian.encode()).bigEndian)
    }

    @Test(expected = IllegalArgumentException::class)
    fun `a 24 bit per pixel format is refused`() {
        // A 3-byte stride is not representable in RFB and would misalign every framebuffer row.
        RfbPixelFormat.RGB888.copy(bitsPerPixel = 24)
    }

    @Test(expected = IllegalArgumentException::class)
    fun `a depth beyond 32 is refused`() {
        RfbPixelFormat.RGB888.copy(depth = 40)
    }

    @Test(expected = IllegalArgumentException::class)
    fun `a depth wider than the pixel is refused`() {
        RfbPixelFormat.RGB565.copy(depth = 24)
    }

    @Test(expected = IllegalArgumentException::class)
    fun `a true colour format with a zero channel maximum is refused`() {
        RfbPixelFormat.RGB888.copy(redMax = 0)
    }

    @Test(expected = IllegalArgumentException::class)
    fun `decode refuses a buffer that is too short`() {
        RfbPixelFormat.decode(ByteArray(15))
    }

    @Test
    fun `encoding numbers match the RFB registry`() {
        assertEquals(0, RfbEncoding.RAW)
        assertEquals(1, RfbEncoding.COPY_RECT)
        assertEquals(2, RfbEncoding.RRE)
        assertEquals(5, RfbEncoding.HEXTILE)
        assertEquals(7, RfbEncoding.TIGHT)
        assertEquals(15, RfbEncoding.TRLE)
        assertEquals(16, RfbEncoding.ZRLE)
        // Pseudo-encodings are negative; reading them unsigned is how DesktopSize gets mistaken for
        // an unknown real encoding.
        assertEquals(-223, RfbEncoding.DESKTOP_SIZE)
        assertEquals(-224, RfbEncoding.LAST_RECT)
        assertEquals(-239, RfbEncoding.CURSOR)
        assertEquals(-308, RfbEncoding.EXTENDED_DESKTOP_SIZE)
    }

    @Test
    fun `unknown encodings keep their number in the label`() {
        assertEquals("Raw", RfbEncoding.name(RfbEncoding.RAW))
        assertEquals("ZRLE", RfbEncoding.name(RfbEncoding.ZRLE))
        assertEquals("LastRect", RfbEncoding.name(RfbEncoding.LAST_RECT))
        assertEquals("Unknown(999)", RfbEncoding.name(999))
    }

    @Test
    fun `Raw is advertised even when the core supports nothing else`() {
        // Every RFB server implements Raw, so it is the guarantee that the stream stays decodable.
        assertEquals(listOf(RfbEncoding.RAW), RfbEncodingPolicy.advertise(emptySet()))
    }

    @Test
    fun `Raw is advertised exactly once when the core also lists it`() {
        assertEquals(listOf(RfbEncoding.RAW), RfbEncodingPolicy.advertise(setOf(RfbEncoding.RAW)))
    }

    @Test
    fun `only encodings the core can decode are advertised`() {
        // The failure this prevents: announcing ZRLE for the bandwidth, then meeting a ZRLE
        // rectangle with no decoder, which corrupts the stream with no recoverable error.
        val advertised = RfbEncodingPolicy.advertise(
            setOf(RfbEncoding.ZRLE, RfbEncoding.COPY_RECT, RfbEncoding.LAST_RECT, RfbEncoding.CURSOR),
        )
        assertEquals(
            listOf(
                RfbEncoding.ZRLE,
                RfbEncoding.COPY_RECT,
                RfbEncoding.RAW,
                RfbEncoding.LAST_RECT,
                RfbEncoding.CURSOR,
            ),
            advertised,
        )
        assertFalse("TIGHT was never claimed by the core", advertised.contains(RfbEncoding.TIGHT))
    }

    @Test
    fun `real encodings are advertised in bandwidth order ahead of Raw`() {
        val advertised = RfbEncodingPolicy.advertise(setOf(RfbEncoding.HEXTILE, RfbEncoding.TIGHT))
        assertEquals(listOf(RfbEncoding.TIGHT, RfbEncoding.HEXTILE, RfbEncoding.RAW), advertised)
    }

    @Test
    fun `pseudo encodings follow every real encoding`() {
        val advertised = RfbEncodingPolicy.advertise(
            RfbEncodingPolicy.PREFERENCE_ORDER.toSet() + RfbEncodingPolicy.PSEUDO_ORDER.toSet(),
        )
        val firstPseudo = advertised.indexOfFirst { it < 0 }
        val lastReal = advertised.indexOfLast { it >= 0 }
        assertTrue("pseudo-encodings must not interleave with real ones", lastReal < firstPseudo)
        assertEquals(RfbEncoding.RAW, advertised[lastReal])
    }
}
