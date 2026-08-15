package one.zephyr.mobile.feature.ai

import kotlin.math.abs

/**
 * Stable one-axis release velocity for the AI sheet handle.
 *
 * Compose's VelocityTracker lives in UI code; this pure replica keeps the policy testable on the
 * JVM and guards the exact failure mode that made the old two-sample derivative feel jittery.
 */
internal class AiHandleVelocityEstimator(
    private val horizonMs: Long = 100L,
    private val maxSamples: Int = 8,
) {
    private data class Sample(val timeMs: Long, val yPx: Float)
    private val samples = ArrayDeque<Sample>()

    fun reset(timeMs: Long, yPx: Float) {
        samples.clear()
        add(timeMs, yPx)
    }

    fun add(timeMs: Long, yPx: Float) {
        if (samples.isNotEmpty() && timeMs <= samples.last().timeMs) return
        samples.addLast(Sample(timeMs, yPx))
        while (samples.size > maxSamples) samples.removeFirst()
        while (samples.size > 2 && timeMs - samples.first().timeMs > horizonMs) samples.removeFirst()
    }

    fun velocityPxPerSecond(): Float {
        if (samples.size < 2) return 0f
        val first = samples.first()
        val xMean = samples.map { (it.timeMs - first.timeMs).toFloat() }.average().toFloat()
        val yMean = samples.map { it.yPx }.average().toFloat()
        var numerator = 0f
        var denominator = 0f
        for (sample in samples) {
            val x = (sample.timeMs - first.timeMs).toFloat() - xMean
            numerator += x * (sample.yPx - yMean)
            denominator += x * x
        }
        if (abs(denominator) < 0.001f) return 0f
        return numerator / denominator * 1_000f
    }
}
