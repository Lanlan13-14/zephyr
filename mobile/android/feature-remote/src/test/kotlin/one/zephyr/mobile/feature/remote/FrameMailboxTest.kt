package one.zephyr.mobile.feature.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The bounded video hand-off from REMOTE_DESKTOP_EXPERIENCE.md 2 and 11.
 *
 * The one class in the remote stack that is allowed to lose data, and these tests pin down exactly
 * how: it discards pixels and demands a repaint, which costs one frame. Dropping the *oldest* patch
 * instead would leave stale pixels on screen forever, because nothing ever redraws a region the
 * server has already sent - so "which end does it drop from" is a correctness question, not a
 * performance one.
 */
class FrameMailboxTest {

    // ---- merging ---------------------------------------------------------------------------------

    @Test
    fun patchesAccumulateAndTheirRegionsMerge() {
        val subject = FrameMailbox()
        subject.offer(RemoteFixtures.patch(0, 0, 10, 10))
        subject.offer(RemoteFixtures.patch(100, 100, 10, 10))
        assertEquals(2, subject.pendingCount)

        val drain = subject.drain()

        assertEquals(2, drain.patches.size)
        // The union rather than the two rectangles: the renderer uploads one bounding box.
        assertEquals(FrameRegion(0, 0, 110, 110), drain.region)
        assertFalse(drain.fullRepaint)
        assertEquals(0, drain.droppedPatches)
    }

    @Test
    fun anEmptyRegionIsIgnoredRatherThanMerged() {
        val subject = FrameMailbox()
        subject.offer(FramePatch(FrameRegion(0, 0, 0, 0), ByteArray(0)))

        assertEquals(0, subject.pendingCount)
        assertNull(subject.drain().region)
    }

    @Test
    fun drainClearsThePendingSetSoAFrameIsNeverUploadedTwice() {
        val subject = FrameMailbox()
        subject.offer(RemoteFixtures.patch(0, 0, 4, 4))
        subject.drain()

        val second = subject.drain()

        assertEquals(0, second.patches.size)
        assertNull(second.region)
        assertFalse(second.fullRepaint)
    }

    // ---- degradation -----------------------------------------------------------------------------

    @Test
    fun exceedingThePatchBoundDegradesToAFullRepaintForOneFrame() {
        val subject = FrameMailbox(maxPatches = 2)
        subject.offer(RemoteFixtures.patch(0, 0, 1, 1))
        subject.offer(RemoteFixtures.patch(1, 0, 1, 1))
        subject.offer(RemoteFixtures.patch(2, 0, 1, 1))

        val drain = subject.drain()

        // All three sets of pixels are gone, but the geometry survives so the renderer knows the
        // damaged area, and the next frame is whole rather than corrupt.
        assertTrue(drain.fullRepaint)
        assertEquals(0, drain.patches.size)
        assertEquals(3, drain.droppedPatches)
        assertEquals(FrameRegion(0, 0, 3, 1), drain.region)
    }

    @Test
    fun exceedingTheByteBoundDegradesEvenWithFewPatches() {
        // One 3x1 RGBA patch is 12 bytes. A single oversized patch has to be caught too: 64 tiny
        // patches and one full-screen patch are the same problem for the upload budget.
        val subject = FrameMailbox(maxBytes = 8)
        subject.offer(RemoteFixtures.patch(0, 0, 3, 1))

        val drain = subject.drain()

        assertTrue(drain.fullRepaint)
        assertEquals(1, drain.droppedPatches)
    }

    @Test
    fun aPatchExactlyAtTheByteBoundIsKept() {
        // The bound is a ceiling, not a fence: degrading at exactly the limit would throw away a frame
        // that fits.
        val subject = FrameMailbox(maxBytes = 8)
        subject.offer(RemoteFixtures.patch(0, 0, 2, 1))

        val drain = subject.drain()

        assertFalse(drain.fullRepaint)
        assertEquals(1, drain.patches.size)
    }

    @Test
    fun onceDegradedFurtherPatchesKeepMergingGeometryWithoutBufferingPixels() {
        val subject = FrameMailbox(maxPatches = 1)
        subject.offer(RemoteFixtures.patch(0, 0, 1, 1))
        subject.offer(RemoteFixtures.patch(1, 1, 1, 1))
        assertEquals(0, subject.pendingCount)

        subject.offer(RemoteFixtures.patch(50, 50, 10, 10))

        val drain = subject.drain()
        assertTrue(drain.fullRepaint)
        assertEquals(0, drain.patches.size)
        assertEquals(FrameRegion(0, 0, 60, 60), drain.region)
        assertEquals(3, drain.droppedPatches)
    }

    @Test
    fun theDroppedCounterIsCumulativeAcrossDrainsBecauseTheStatsLineIsCumulative() {
        val subject = FrameMailbox(maxPatches = 1)
        subject.offer(RemoteFixtures.patch(0, 0, 1, 1))
        subject.offer(RemoteFixtures.patch(1, 0, 1, 1))
        subject.drain()

        assertEquals(2, subject.droppedPatches)
        assertFalse(subject.drain().fullRepaint)
        assertEquals(2, subject.droppedPatches)
    }

    // ---- explicit repaint ------------------------------------------------------------------------

    @Test
    fun requestFullRepaintDiscardsPendingPixelsAndCountsThem() {
        val subject = FrameMailbox()
        subject.offer(RemoteFixtures.patch(0, 0, 4, 4))

        subject.requestFullRepaint(null)

        assertEquals(0, subject.pendingCount)
        val drain = subject.drain()
        assertTrue(drain.fullRepaint)
        assertEquals(1, drain.droppedPatches)
        // The region the pending patch covered is still reported: a resize must not lose the area.
        assertEquals(FrameRegion(0, 0, 4, 4), drain.region)
    }

    @Test
    fun requestFullRepaintWithARegionUsesItWhenNothingWasPending() {
        val subject = FrameMailbox()
        subject.requestFullRepaint(FrameRegion(0, 0, 800, 600))

        val drain = subject.drain()

        assertTrue(drain.fullRepaint)
        assertEquals(FrameRegion(0, 0, 800, 600), drain.region)
        assertEquals(0, drain.droppedPatches)
    }

    @Test
    fun resetClearsTheCounterAsWellAsTheBuffer() {
        // Reconnect: the previous session's drop count is not this session's diagnostics.
        val subject = FrameMailbox(maxPatches = 1)
        subject.offer(RemoteFixtures.patch(0, 0, 1, 1))
        subject.offer(RemoteFixtures.patch(1, 0, 1, 1))

        subject.reset()

        assertEquals(0, subject.droppedPatches)
        assertEquals(0, subject.pendingCount)
        assertFalse(subject.drain().fullRepaint)
    }

    // ---- region algebra --------------------------------------------------------------------------

    @Test
    fun regionEdgesAndAreaAreDerivedNotStored() {
        val region = FrameRegion(10, 20, 30, 40)
        assertEquals(40, region.right)
        assertEquals(60, region.bottom)
        assertEquals(1200, region.area)
        assertFalse(region.isEmpty)
    }

    @Test
    fun aNegativeDimensionIsEmptyAndHasNoArea() {
        val region = FrameRegion(0, 0, -5, 10)
        assertTrue(region.isEmpty)
        assertEquals(0, region.area)
    }

    @Test
    fun unionWithAnEmptyRegionIsIdentityInBothDirections() {
        val real = FrameRegion(5, 5, 10, 10)
        val empty = FrameRegion(0, 0, 0, 0)
        assertEquals(real, real.union(empty))
        assertEquals(real, empty.union(real))
    }

    @Test
    fun touchingRegionsDoNotIntersect() {
        // Half-open on purpose: a region ending at x=10 and one starting at x=10 share no pixel, and
        // treating them as overlapping would merge two independent damage rectangles every frame.
        val left = FrameRegion(0, 0, 10, 10)
        val right = FrameRegion(10, 0, 10, 10)
        assertFalse(left.intersects(right))
        assertTrue(left.intersects(FrameRegion(9, 0, 10, 10)))
    }

    @Test
    fun containmentIsInclusiveAtTheEdgesAndTrivialForEmpty() {
        val outer = FrameRegion(0, 0, 10, 10)
        assertTrue(outer.contains(FrameRegion(0, 0, 10, 10)))
        assertTrue(outer.contains(FrameRegion(2, 2, 3, 3)))
        assertFalse(outer.contains(FrameRegion(2, 2, 9, 9)))
        assertTrue(outer.contains(FrameRegion(0, 0, 0, 0)))
    }
}
