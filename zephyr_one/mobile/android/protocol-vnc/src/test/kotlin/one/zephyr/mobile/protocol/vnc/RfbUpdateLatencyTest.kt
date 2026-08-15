package one.zephyr.mobile.protocol.vnc

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * FramebufferUpdateRequest → first FramebufferUpdate is the only RTT RFB can measure.
 *
 * Mutation: treating a second request as a new clock, or reporting 0 ms when
 * nothing was requested, would put a lie on the status pill.
 */
class RfbUpdateLatencyTest {

    @Test
    fun aMatchedRequestReportsElapsedMilliseconds() {
        val clock = mutableListOf(1_000_000_000L)
        val sampler = RfbUpdateLatency { clock.first() }
        sampler.markRequested()
        clock[0] = 1_018_000_000L
        assertEquals(18L, sampler.sample())
        assertFalse(sampler.hasOutstanding)
    }

    @Test
    fun aSecondRequestDoesNotRestartTheClock() {
        val clock = mutableListOf(0L)
        val sampler = RfbUpdateLatency { clock.first() }
        sampler.markRequested()
        clock[0] = 5_000_000L
        sampler.markRequested()
        clock[0] = 20_000_000L
        assertEquals(20L, sampler.sample())
    }

    @Test
    fun aSampleWithoutARequestIsDropped() {
        val sampler = RfbUpdateLatency { 10_000_000L }
        assertNull(sampler.sample())
    }

    @Test
    fun zeroAndSubMillisecondReadingsAreNotReported() {
        val clock = mutableListOf(0L)
        val sampler = RfbUpdateLatency { clock.first() }
        sampler.markRequested()
        clock[0] = 500_000L
        assertNull("sub-millisecond is not a measurement we can show", sampler.sample())
    }

    @Test
    fun aMinutePlusSampleBelongsToTheWatchdogNotThePill() {
        val clock = mutableListOf(0L)
        val sampler = RfbUpdateLatency { clock.first() }
        sampler.markRequested()
        clock[0] = 61_000L * 1_000_000L
        assertNull(sampler.sample())
    }

    @Test
    fun clearDropsAnOutstandingRequest() {
        val sampler = RfbUpdateLatency { 0L }
        sampler.markRequested()
        assertTrue(sampler.hasOutstanding)
        sampler.clear()
        assertFalse(sampler.hasOutstanding)
        assertNull(sampler.sample())
    }
}
