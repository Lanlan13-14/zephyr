package one.zephyr.mobile.feature.remote

import kotlin.math.max
import kotlin.math.min

/**
 * One damage rectangle.
 *
 * Deliberately not the protocol frame type: RDP and VNC both deliver rectangles with pixels, and the
 * renderer only needs the geometry to decide what to invalidate.
 */
data class FrameRegion(val x: Int, val y: Int, val width: Int, val height: Int) {

    val right: Int get() = x + width
    val bottom: Int get() = y + height
    val area: Int get() = max(0, width) * max(0, height)
    val isEmpty: Boolean get() = width <= 0 || height <= 0

    fun union(other: FrameRegion): FrameRegion {
        if (isEmpty) return other
        if (other.isEmpty) return this
        val left = min(x, other.x)
        val top = min(y, other.y)
        return FrameRegion(
            x = left,
            y = top,
            width = max(right, other.right) - left,
            height = max(bottom, other.bottom) - top,
        )
    }

    fun intersects(other: FrameRegion): Boolean =
        !isEmpty && !other.isEmpty && x < other.right && other.x < right && y < other.bottom && other.y < bottom

    fun contains(other: FrameRegion): Boolean =
        other.isEmpty || (!isEmpty && x <= other.x && y <= other.y && right >= other.right && bottom >= other.bottom)
}

/** A damage rectangle together with its pixels, as the engine delivered them. */
class FramePatch(val region: FrameRegion, val pixels: ByteArray)

/**
 * What one drain produced.
 *
 * @param fullRepaint true when the mailbox gave up on incremental patches. The renderer must ask the
 *   engine for the whole framebuffer for this frame and then resume incremental updates, which is
 *   the "退化为 bounding/full frame，下一帧恢复" rule from REMOTE_DESKTOP_EXPERIENCE.md 11.
 * @param region union of everything pending, so a renderer that cannot use individual patches still
 *   knows the minimum area to invalidate.
 */
data class FrameDrain(
    val patches: List<FramePatch>,
    val region: FrameRegion?,
    val fullRepaint: Boolean,
    val droppedPatches: Int,
)

/**
 * The bounded hand-off between the protocol thread and the renderer.
 *
 * REMOTE_DESKTOP_EXPERIENCE.md 2 requires that a backlog drops stale *video* and never drops input,
 * clipboard, resize or channel control - so those travel through [RemoteInputQueue] and the channel
 * flows instead, and this class is allowed to be lossy. It is lossy in exactly one way: when the
 * backlog exceeds a bound it discards the pixels it is holding and demands a full repaint, which
 * costs one frame and cannot corrupt the picture. Dropping the *oldest* patch instead would leave
 * stale pixels on screen forever, because nothing will redraw a region the server already sent.
 *
 * @param maxBytes default is roughly two 1080p RGBA frames, which is where the 2-3 frame bound in
 *   the spec lands for a full-screen update.
 */
class FrameMailbox(
    private val maxPatches: Int = MAX_PATCHES,
    private val maxBytes: Int = MAX_BYTES,
) {

    private val pending = ArrayList<FramePatch>()
    private var pendingBytes = 0
    private var merged: FrameRegion? = null
    private var fullRepaint = false
    private var dropped = 0

    /** Total patches discarded since construction, for the stats line the spec requires. */
    val droppedPatches: Int get() = dropped

    val pendingCount: Int get() = pending.size

    @Synchronized
    fun offer(patch: FramePatch): Boolean {
        if (patch.region.isEmpty) return false
        merged = merged?.union(patch.region) ?: patch.region
        if (fullRepaint) {
            // Already degraded for this frame: keep merging geometry so the renderer knows the area,
            // but do not accumulate pixels that a full repaint will supersede anyway.
            dropped++
            return true
        }
        pending.add(patch)
        pendingBytes += patch.pixels.size
        if (pending.size > maxPatches || pendingBytes > maxBytes) {
            degrade()
        }
        return true
    }

    /** Marks the next drain as a full repaint. Called on resize, reconnect and surface recreation. */
    @Synchronized
    fun requestFullRepaint(region: FrameRegion?) {
        fullRepaint = true
        dropped += pending.size
        pending.clear()
        pendingBytes = 0
        if (region != null) merged = merged?.union(region) ?: region
    }

    @Synchronized
    fun drain(): FrameDrain {
        val result = FrameDrain(
            patches = if (fullRepaint) emptyList() else ArrayList(pending),
            region = merged,
            fullRepaint = fullRepaint,
            droppedPatches = dropped,
        )
        pending.clear()
        pendingBytes = 0
        merged = null
        fullRepaint = false
        return result
    }

    @Synchronized
    fun reset() {
        pending.clear()
        pendingBytes = 0
        merged = null
        fullRepaint = false
        dropped = 0
    }

    private fun degrade() {
        dropped += pending.size
        pending.clear()
        pendingBytes = 0
        fullRepaint = true
    }

    companion object {
        const val MAX_PATCHES = 64

        /** 1920 * 1080 * 4 * 2, i.e. two full 1080p RGBA frames. */
        const val MAX_BYTES = 16_588_800
    }
}
