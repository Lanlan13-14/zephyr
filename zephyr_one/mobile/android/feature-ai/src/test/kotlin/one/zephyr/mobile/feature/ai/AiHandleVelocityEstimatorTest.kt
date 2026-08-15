package one.zephyr.mobile.feature.ai

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AiHandleVelocityEstimatorTest {

    @Test
    fun `linear samples return stable release velocity`() {
        val tracker = AiHandleVelocityEstimator()
        tracker.reset(0, 10f)
        tracker.add(16, 26f)
        tracker.add(32, 42f)
        tracker.add(48, 58f)
        assertEquals(1_000f, tracker.velocityPxPerSecond(), 0.01f)
    }

    @Test
    fun `an old outlier falls outside the release horizon`() {
        val tracker = AiHandleVelocityEstimator(horizonMs = 70)
        tracker.reset(0, 400f)
        tracker.add(100, 10f)
        tracker.add(116, 26f)
        tracker.add(132, 42f)
        tracker.add(148, 58f)
        assertEquals(1_000f, tracker.velocityPxPerSecond(), 0.01f)
    }

    @Test
    fun `stationary tail damps a stale fast move`() {
        val tracker = AiHandleVelocityEstimator()
        tracker.reset(0, 0f)
        tracker.add(16, 40f)
        tracker.add(50, 44f)
        tracker.add(80, 44f)
        tracker.add(100, 44f)
        assertTrue(tracker.velocityPxPerSecond() < 400f)
    }

    @Test
    fun `duplicate timestamps and one sample never produce a spike`() {
        val tracker = AiHandleVelocityEstimator()
        tracker.reset(10, 20f)
        tracker.add(10, 1000f)
        assertEquals(0f, tracker.velocityPxPerSecond())
    }
}
