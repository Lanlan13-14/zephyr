package one.zephyr.mobile.protocol.vnc

/**
 * One outstanding FramebufferUpdateRequest → first FramebufferUpdate sample.
 *
 * RFB has no ping message. The honest number the status pill can show is how long
 * the server took to answer the last update request. A second request before the
 * first sample is ignored so a burst of incremental requests cannot invent a
 * 0 ms reading. Samples without a matching request are dropped: those are
 * unsolicited server pushes, not a round trip.
 *
 * Bounds are 1..60_000 ms. Zero would be a claim the wire never made; a minute
 * is already a dead session and belongs to the phase watchdog, not the pill.
 */
class RfbUpdateLatency(
    private val nowNs: () -> Long = System::nanoTime,
) {

    @Volatile
    private var outstandingNs: Long = NONE

    fun markRequested(atNs: Long = nowNs()) {
        if (outstandingNs != NONE) return
        outstandingNs = atNs
    }

    /**
     * @return the elapsed milliseconds, or null when there is no matching request
     *   or the sample is out of range.
     */
    fun sample(atNs: Long = nowNs()): Long? {
        val started = outstandingNs
        outstandingNs = NONE
        if (started == NONE || atNs < started) return null
        val ms = (atNs - started) / NANOS_PER_MS
        if (ms < MIN_MS || ms > MAX_MS) return null
        return ms
    }

    fun clear() {
        outstandingNs = NONE
    }

    val hasOutstanding: Boolean get() = outstandingNs != NONE

    companion object {
        const val MIN_MS = 1L
        const val MAX_MS = 60_000L
        private const val NONE = -1L
        private const val NANOS_PER_MS = 1_000_000L
    }
}
