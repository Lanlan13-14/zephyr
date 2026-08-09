package one.zephyr.mobile.feature.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Patch arithmetic, on the JVM.
 *
 * This is the class REMOTE_DESKTOP_EXPERIENCE.md 11 is really about: an off-by-one in the row stride
 * or a swapped byte silently corrupts the picture, and neither shows up in a screenshot review. Kept
 * free of android.graphics precisely so these cases can be asserted pixel by pixel.
 */
class RemoteFramebufferTest {

    @Test
    fun aFreshFramebufferHasNoPixelsAndAcceptsNothing() {
        val subject = RemoteFramebuffer()

        assertTrue(subject.isEmpty)
        assertEquals(0, subject.widthPx)
        assertEquals(0, subject.heightPx)
        // Refused rather than counted as malformed: the patch is fine, there is nowhere to put it.
        assertFalse(subject.apply(RemoteFixtures.patch(0, 0, 1, 1)))
        assertEquals(0, subject.malformedPatches)
    }

    @Test
    fun resizeAllocatesExactlyWidthTimesHeight() {
        val subject = RemoteFramebuffer()
        subject.resize(4, 4)

        assertFalse(subject.isEmpty)
        assertEquals(4, subject.widthPx)
        assertEquals(4, subject.heightPx)
        assertEquals(16, subject.pixels().size)
    }

    @Test
    fun aNonPositiveResizeIsIgnoredRatherThanEmptyingTheScreen() {
        val subject = RemoteFramebuffer()
        subject.resize(4, 4)

        subject.resize(0, 10)
        subject.resize(10, -1)

        assertEquals(4, subject.widthPx)
        assertEquals(4, subject.heightPx)
    }

    // ---- pixel format ----------------------------------------------------------------------------

    @Test
    fun rgba8888BecomesArgbInTheRightOrder() {
        // Both engines document RGBA8888. A red/green swap here is the single most likely rendering
        // bug and the hardest to spot on a desktop wallpaper.
        val subject = RemoteFramebuffer()
        subject.resize(2, 2)
        val patch = FramePatch(
            region = FrameRegion(0, 0, 1, 1),
            pixels = byteArrayOf(0x12, 0x34, 0x56, 0xFF.toByte()),
        )

        assertTrue(subject.apply(patch))

        assertEquals(0xFF123456.toInt(), subject.pixelAt(0, 0))
    }

    @Test
    fun aFullyTransparentPixelIsForcedOpaque() {
        // The remote desktop is opaque by definition; an alpha of 0 from an engine that does not fill
        // the channel would otherwise render the whole screen invisible.
        val subject = RemoteFramebuffer()
        subject.resize(1, 1)
        val patch = FramePatch(
            region = FrameRegion(0, 0, 1, 1),
            pixels = byteArrayOf(0x10, 0x20, 0x30, 0x00),
        )

        subject.apply(patch)

        assertEquals(0xFF102030.toInt(), subject.pixelAt(0, 0))
    }

    @Test
    fun aPartiallyTransparentPixelKeepsItsAlpha() {
        val subject = RemoteFramebuffer()
        subject.resize(1, 1)
        val patch = FramePatch(
            region = FrameRegion(0, 0, 1, 1),
            pixels = byteArrayOf(0x10, 0x20, 0x30, 0x80.toByte()),
        )

        subject.apply(patch)

        assertEquals(0x80102030.toInt(), subject.pixelAt(0, 0))
    }

    @Test
    fun rowStrideFollowsThePatchWidthNotTheFramebufferWidth() {
        // The patch is 2 wide inside a 4-wide framebuffer, so source row 1 starts at byte 8 while
        // destination row 1 starts at index 4. Reusing one stride for both is the classic corruption.
        val subject = RemoteFramebuffer()
        subject.resize(4, 4)
        val patch = FramePatch(
            region = FrameRegion(0, 0, 2, 2),
            pixels = byteArrayOf(
                0x01, 0x01, 0x01, 0xFF.toByte(),
                0x02, 0x02, 0x02, 0xFF.toByte(),
                0x03, 0x03, 0x03, 0xFF.toByte(),
                0x04, 0x04, 0x04, 0xFF.toByte(),
            ),
        )

        assertTrue(subject.apply(patch))

        assertEquals(0xFF010101.toInt(), subject.pixelAt(0, 0))
        assertEquals(0xFF020202.toInt(), subject.pixelAt(1, 0))
        assertEquals(0xFF030303.toInt(), subject.pixelAt(0, 1))
        assertEquals(0xFF040404.toInt(), subject.pixelAt(1, 1))
        // Everything outside the patch is untouched.
        assertEquals(0, subject.pixelAt(2, 0))
    }

    // ---- hostile input ---------------------------------------------------------------------------

    @Test
    fun aShortPixelArrayIsCountedRatherThanReadPastTheEnd() {
        val subject = RemoteFramebuffer()
        subject.resize(4, 4)
        val patch = FramePatch(FrameRegion(0, 0, 2, 2), ByteArray(8))

        assertFalse(subject.apply(patch))

        assertEquals(1, subject.malformedPatches)
        assertEquals(0, subject.pixelAt(0, 0))
    }

    @Test
    fun aPatchThatOverhangsTheEdgeIsClippedNotRefused() {
        // A server that reports a stale desktop size sends these. Writing it unclipped would be an
        // out-of-bounds write in the renderer; refusing it outright would leave a dead strip.
        val subject = RemoteFramebuffer()
        subject.resize(4, 4)
        val patch = FramePatch(
            region = FrameRegion(3, 3, 2, 2),
            pixels = byteArrayOf(
                0x11, 0x11, 0x11, 0xFF.toByte(),
                0x22, 0x22, 0x22, 0xFF.toByte(),
                0x33, 0x33, 0x33, 0xFF.toByte(),
                0x44, 0x44, 0x44, 0xFF.toByte(),
            ),
        )

        assertTrue(subject.apply(patch))

        assertEquals(0xFF111111.toInt(), subject.pixelAt(3, 3))
        assertEquals(0, subject.malformedPatches)
    }

    @Test
    fun aPatchEntirelyOutsideTheFramebufferIsNotMalformed() {
        val subject = RemoteFramebuffer()
        subject.resize(4, 4)

        assertFalse(subject.apply(RemoteFixtures.patch(10, 10, 2, 2)))

        assertEquals(0, subject.malformedPatches)
    }

    @Test
    fun anEmptyRegionIsRefusedWithoutCounting() {
        val subject = RemoteFramebuffer()
        subject.resize(4, 4)

        assertFalse(subject.apply(FramePatch(FrameRegion(0, 0, 0, 5), ByteArray(0))))

        assertEquals(0, subject.malformedPatches)
    }

    // ---- dynamic resolution ----------------------------------------------------------------------

    @Test
    fun growingKeepsTheExistingPictureAtTheSameCoordinates() {
        // Section 4: a dynamic-resolution change must not blank the screen for a frame.
        val subject = RemoteFramebuffer()
        subject.resize(2, 2)
        subject.apply(
            FramePatch(
                region = FrameRegion(0, 0, 2, 2),
                pixels = byteArrayOf(
                    0x01, 0x01, 0x01, 0xFF.toByte(),
                    0x02, 0x02, 0x02, 0xFF.toByte(),
                    0x03, 0x03, 0x03, 0xFF.toByte(),
                    0x04, 0x04, 0x04, 0xFF.toByte(),
                ),
            ),
        )

        subject.resize(4, 4)

        assertEquals(0xFF010101.toInt(), subject.pixelAt(0, 0))
        assertEquals(0xFF020202.toInt(), subject.pixelAt(1, 0))
        assertEquals(0xFF030303.toInt(), subject.pixelAt(0, 1))
        assertEquals(0xFF040404.toInt(), subject.pixelAt(1, 1))
        // The new strip is transparent black, which is what the letterbox already draws.
        assertEquals(0, subject.pixelAt(3, 3))
    }

    @Test
    fun shrinkingKeepsTheTopLeftAndDropsTheRest() {
        val subject = RemoteFramebuffer()
        subject.resize(4, 4)
        subject.apply(
            FramePatch(FrameRegion(0, 0, 1, 1), byteArrayOf(0x09, 0x09, 0x09, 0xFF.toByte())),
        )

        subject.resize(2, 2)

        assertEquals(2, subject.widthPx)
        assertEquals(4, subject.pixels().size)
        assertEquals(0xFF090909.toInt(), subject.pixelAt(0, 0))
    }

    @Test
    fun resizingToTheSameSizeKeepsTheSameBuffer() {
        val subject = RemoteFramebuffer()
        subject.resize(4, 4)
        subject.apply(
            FramePatch(FrameRegion(0, 0, 1, 1), byteArrayOf(0x09, 0x09, 0x09, 0xFF.toByte())),
        )

        subject.resize(4, 4)

        assertEquals(0xFF090909.toInt(), subject.pixelAt(0, 0))
    }

    @Test
    fun pixelAtOutsideTheBufferIsZeroRatherThanAnException() {
        val subject = RemoteFramebuffer()
        subject.resize(2, 2)

        assertEquals(0, subject.pixelAt(-1, 0))
        assertEquals(0, subject.pixelAt(0, -1))
        assertEquals(0, subject.pixelAt(2, 0))
        assertEquals(0, subject.pixelAt(0, 2))
    }

    @Test
    fun clearZeroesEveryPixelWithoutResizing() {
        val subject = RemoteFramebuffer()
        subject.resize(2, 2)
        subject.apply(
            FramePatch(FrameRegion(0, 0, 1, 1), byteArrayOf(0x09, 0x09, 0x09, 0xFF.toByte())),
        )

        subject.clear()

        assertEquals(0, subject.pixelAt(0, 0))
        assertEquals(2, subject.widthPx)
        assertEquals(4, subject.pixels().size)
    }
}
