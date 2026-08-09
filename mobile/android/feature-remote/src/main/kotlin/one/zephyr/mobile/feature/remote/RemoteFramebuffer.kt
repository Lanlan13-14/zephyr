package one.zephyr.mobile.feature.remote

/**
 * The assembled remote picture, as ARGB_8888 integers.
 *
 * Kept as a plain IntArray rather than an android.graphics.Bitmap so the patch arithmetic - which is
 * where an off-by-one silently corrupts the screen - is unit-testable on the JVM. The Android layer
 * owns the Bitmap and copies from here; see [RemoteSurface].
 *
 * Both engines deliver RGBA8888 (RdpFrame and VncFrame both document it), so the conversion is a
 * byte shuffle into 0xAARRGGBB rather than a per-pixel rescale.
 */
class RemoteFramebuffer {

    var widthPx: Int = 0
        private set

    var heightPx: Int = 0
        private set

    private var argb = IntArray(0)

    /** Patches that could not be applied because their pixel array was short. Surfaced for tests. */
    var malformedPatches: Int = 0
        private set

    val isEmpty: Boolean get() = widthPx <= 0 || heightPx <= 0

    /** The backing array. Only [RemoteSurface] should read it, and only to copy into a Bitmap. */
    fun pixels(): IntArray = argb

    /**
     * Grows or shrinks the framebuffer.
     *
     * Existing pixels are copied row by row so a dynamic-resolution change does not blank the screen
     * for a frame. The uncovered area stays at 0 (transparent black), which is what the letterbox
     * already draws, so a server that grew the desktop shows the new strip only once it paints it.
     */
    fun resize(nextWidthPx: Int, nextHeightPx: Int) {
        if (nextWidthPx <= 0 || nextHeightPx <= 0) return
        if (nextWidthPx == widthPx && nextHeightPx == heightPx) return
        val next = IntArray(nextWidthPx * nextHeightPx)
        val copyWidth = minOf(widthPx, nextWidthPx)
        val copyHeight = minOf(heightPx, nextHeightPx)
        for (row in 0 until copyHeight) {
            System.arraycopy(argb, row * widthPx, next, row * nextWidthPx, copyWidth)
        }
        argb = next
        widthPx = nextWidthPx
        heightPx = nextHeightPx
    }

    /**
     * Applies one damage rectangle.
     *
     * Clipped rather than trusted: a patch that claims to extend past the framebuffer is a protocol
     * bug on the far side, and writing it unclipped would be an out-of-bounds write in the renderer.
     * The caller has already grown the geometry through [RemoteSessionController.onFrame], so a
     * legitimately larger patch arrives after a resize rather than being clipped away.
     *
     * @return true when at least one pixel was written.
     */
    fun apply(patch: FramePatch): Boolean {
        if (isEmpty || patch.region.isEmpty) return false
        val region = patch.region
        val needed = region.width.toLong() * region.height.toLong() * BYTES_PER_PIXEL
        if (patch.pixels.size < needed) {
            malformedPatches += 1
            return false
        }
        val startX = maxOf(0, region.x)
        val startY = maxOf(0, region.y)
        val endX = minOf(widthPx, region.right)
        val endY = minOf(heightPx, region.bottom)
        if (startX >= endX || startY >= endY) return false

        for (y in startY until endY) {
            val sourceRow = (y - region.y) * region.width
            var destination = y * widthPx + startX
            var source = (sourceRow + (startX - region.x)) * BYTES_PER_PIXEL
            for (x in startX until endX) {
                val red = patch.pixels[source].toInt() and 0xFF
                val green = patch.pixels[source + 1].toInt() and 0xFF
                val blue = patch.pixels[source + 2].toInt() and 0xFF
                val alpha = patch.pixels[source + 3].toInt() and 0xFF
                // Alpha forced opaque: a desktop has no transparency, and a server that sends 0 in
                // the unused byte would otherwise paint an invisible frame.
                val opaque = if (alpha == 0) 0xFF else alpha
                argb[destination] = (opaque shl 24) or (red shl 16) or (green shl 8) or blue
                destination += 1
                source += BYTES_PER_PIXEL
            }
        }
        return true
    }

    /** ARGB at one remote pixel, or 0 when outside. For tests and for the cursor layer. */
    fun pixelAt(x: Int, y: Int): Int {
        if (x < 0 || y < 0 || x >= widthPx || y >= heightPx) return 0
        return argb[y * widthPx + x]
    }

    fun clear() {
        argb.fill(0)
    }

    companion object {
        const val BYTES_PER_PIXEL = 4
    }
}
