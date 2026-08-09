package one.zephyr.mobile.feature.remote

import one.zephyr.mobile.model.MobileError
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The connect pipeline from REMOTE_DESKTOP_EXPERIENCE.md 13.
 *
 * These are the phase-level guarantees the screen depends on: a per-phase timeout so a 20-second wait
 * names which step is stuck, an error that clears when the pipeline moves on, and a stop list so a
 * revoked credential cannot drive a reconnect loop.
 */
class RemoteSessionPhaseTest {

    @Test
    fun everyPhaseHasItsOwnLabel() {
        // A shared label would defeat the whole point of splitting the pipeline into phases.
        val labels = RemotePhase.entries.map { it.label }
        assertEquals(labels.size, labels.toSet().size)
        assertEquals("解析主机", RemotePhase.RESOLVING.label)
        assertEquals("等待首帧", RemotePhase.FIRST_FRAME.label)
        assertEquals("已连接", RemotePhase.CONNECTED.label)
        assertEquals("质量降级", RemotePhase.DEGRADED.label)
    }

    @Test
    fun onlyConnectedAndDegradedCanShowPixels() {
        /* DEGRADED counts: it is a live session below its quality target, so hiding the surface would
         * blank a desktop the user is still working in. */
        val withSurface = RemotePhase.entries.filter { it.hasSurface }
        assertEquals(listOf(RemotePhase.CONNECTED, RemotePhase.DEGRADED), withSurface)
    }

    @Test
    fun progressingIsEveryPhaseWithSomethingStillPending() {
        val progressing = RemotePhase.entries.filter { it.isProgressing }
        assertEquals(
            listOf(
                RemotePhase.RESOLVING,
                RemotePhase.CONNECTING,
                RemotePhase.SECURING,
                RemotePhase.AUTHENTICATING,
                RemotePhase.NEGOTIATING,
                RemotePhase.FIRST_FRAME,
                RemotePhase.RECONNECTING,
            ),
            progressing,
        )
        // A live session is not "progressing": a spinner over a working desktop reads as a hang.
        assertFalse(RemotePhase.CONNECTED.isProgressing)
        assertFalse(RemotePhase.DEGRADED.isProgressing)
    }

    @Test
    fun onlyDisconnectedIsTerminal() {
        assertEquals(listOf(RemotePhase.DISCONNECTED), RemotePhase.entries.filter { it.isTerminal })
    }

    @Test
    fun elapsedTimeIsZeroUntilThePhaseIsStamped() {
        // Not nowMs - 0, which would render as 57 years of "解析主机".
        assertEquals(0L, RemoteSessionStatus().elapsedMs(1_700_000_000_000L))
        assertEquals(0L, RemoteSessionStatus(phaseSince = 0L).elapsedMs(5_000L))
    }

    @Test
    fun elapsedTimeNeverRunsBackwards() {
        /* System.currentTimeMillis can step backwards on an NTP correction. A negative elapsed time
         * would render as a countdown and could underflow a progress calculation. */
        val status = RemoteSessionStatus(phase = RemotePhase.CONNECTING, phaseSince = 10_000L)
        assertEquals(0L, status.elapsedMs(9_000L))
        assertEquals(2_500L, status.elapsedMs(12_500L))
    }

    @Test
    fun advancingToTheSamePhaseKeepsTheSameInstance() {
        /* The watchdog ticks once a second and re-asserts the phase. Returning a copy would restamp
         * phaseSince, so the elapsed timer would sit at zero forever and never trip the timeout. */
        val status = RemoteSessionStatus(phase = RemotePhase.FIRST_FRAME, phaseSince = 1_000L)
        assertSame(status, status.advance(RemotePhase.FIRST_FRAME, 9_999L))
    }

    @Test
    fun advancingClearsTheErrorTheLastPhaseLeftBehind() {
        val failed = RemoteSessionStatus(
            phase = RemotePhase.RECONNECTING,
            phaseSince = 1_000L,
            error = MobileError.local("network_offline", "掉线", retryable = true),
        )
        val next = failed.advance(RemotePhase.CONNECTING, 2_000L)
        assertEquals(RemotePhase.CONNECTING, next.phase)
        assertEquals(2_000L, next.phaseSince)
        // Stale errors are the reason a retry appears to have failed before it has run.
        assertNull(next.error)
    }

    @Test
    fun everyConnectPhaseIsBoundedAndEveryLivePhaseIsNot() {
        assertEquals(10_000L, RemotePhasePolicy.timeoutMs(RemotePhase.RESOLVING))
        assertEquals(20_000L, RemotePhasePolicy.timeoutMs(RemotePhase.CONNECTING))
        assertEquals(15_000L, RemotePhasePolicy.timeoutMs(RemotePhase.SECURING))
        assertEquals(30_000L, RemotePhasePolicy.timeoutMs(RemotePhase.AUTHENTICATING))
        assertEquals(20_000L, RemotePhasePolicy.timeoutMs(RemotePhase.NEGOTIATING))
        assertEquals(30_000L, RemotePhasePolicy.timeoutMs(RemotePhase.FIRST_FRAME))

        // A live or finished session has nothing left to time out.
        assertNull(RemotePhasePolicy.timeoutMs(RemotePhase.CONNECTED))
        assertNull(RemotePhasePolicy.timeoutMs(RemotePhase.DEGRADED))
        assertNull(RemotePhasePolicy.timeoutMs(RemotePhase.DISCONNECTED))
        // RECONNECTING is bounded by the attempt cap and the backoff, not by a phase timeout.
        assertNull(RemotePhasePolicy.timeoutMs(RemotePhase.RECONNECTING))
    }

    @Test
    fun theTimeoutFiresOnTheBoundaryNotAfterIt() {
        val status = RemoteSessionStatus(phase = RemotePhase.RESOLVING, phaseSince = 1_000L)
        assertFalse(RemotePhasePolicy.hasTimedOut(status, 10_999L))
        assertTrue(RemotePhasePolicy.hasTimedOut(status, 11_000L))
        assertTrue(RemotePhasePolicy.hasTimedOut(status, 20_000L))
    }

    @Test
    fun anUnboundedPhaseNeverTimesOut() {
        val connected = RemoteSessionStatus(phase = RemotePhase.CONNECTED, phaseSince = 1L)
        assertFalse(RemotePhasePolicy.hasTimedOut(connected, Long.MAX_VALUE))
    }

    @Test
    fun aFirstFrameTimeoutIsReportedAsItsOwnFailure() {
        /* Distinct because the fix is different: a server that finished the handshake and sent no
         * frame is usually a display or session problem, not a routing one. */
        val firstFrame = RemotePhasePolicy.timeoutError(RemotePhase.FIRST_FRAME)
        assertEquals("remote_first_frame_timeout", firstFrame.code)
        assertEquals("等待首帧超时", firstFrame.message)
        assertTrue(firstFrame.retryable)

        val connecting = RemotePhasePolicy.timeoutError(RemotePhase.CONNECTING)
        assertEquals("remote_phase_timeout", connecting.code)
        assertEquals("建立连接超时", connecting.message)
        assertTrue(connecting.retryable)
    }

    @Test
    fun aTimeoutWithNoErrorYetStillAllowsAReconnect() {
        // A dropped link reports no code at all; defaulting to "give up" would strand the session.
        assertTrue(RemotePhasePolicy.canAutoReconnect(null))
    }

    @Test
    fun aRevokedGrantStopsTheLoopEvenWhenItClaimsToBeRetryable() {
        /* The stop list wins over the retryable flag on purpose: retrying a revoked grant loops
         * against a decision only the user or the server can change. */
        for (code in RemotePhasePolicy.STOP_CODES) {
            val error = MobileError.local(code, "停止", retryable = true)
            assertFalse("expected " + code + " to stop the reconnect loop", RemotePhasePolicy.canAutoReconnect(error))
        }
    }

    @Test
    fun theStopListCoversRevocationAuthAndMissingEngines() {
        val codes = RemotePhasePolicy.STOP_CODES
        assertTrue(codes.contains("resource_revoked"))
        assertTrue(codes.contains("capability_denied"))
        assertTrue(codes.contains("grant_expired"))
        assertTrue(codes.contains("auth_failed"))
        assertTrue(codes.contains("rfb_auth_failed"))
        assertTrue(codes.contains("certificate_changed"))
        // An unimplemented engine will not become implemented by dialling again.
        assertTrue(codes.contains("rdp_engine_unavailable"))
        assertTrue(codes.contains("vnc_engine_unavailable"))
        assertTrue(codes.contains("engine_unavailable"))
    }

    @Test
    fun aTransportErrorFollowsItsOwnRetryableFlag() {
        val retryable = MobileError.local("network_offline", "掉线", retryable = true)
        assertTrue(RemotePhasePolicy.canAutoReconnect(retryable))

        val fatal = MobileError.local("protocol_incompatible", "不兼容", retryable = false)
        assertFalse(RemotePhasePolicy.canAutoReconnect(fatal))
    }

    @Test
    fun theBackoffIsCappedBecauseSomeoneIsWatchingTheScreen() {
        assertEquals(1_000L, RemotePhasePolicy.reconnectDelayMs(1))
        assertEquals(2_000L, RemotePhasePolicy.reconnectDelayMs(2))
        assertEquals(5_000L, RemotePhasePolicy.reconnectDelayMs(3))
        assertEquals(10_000L, RemotePhasePolicy.reconnectDelayMs(4))
        assertEquals(15_000L, RemotePhasePolicy.reconnectDelayMs(5))
        // Capped rather than doubling: a remote desktop is an interactive session, not a background job.
        assertEquals(15_000L, RemotePhasePolicy.reconnectDelayMs(99))
        assertEquals(5, RemotePhasePolicy.MAX_AUTO_ATTEMPTS)
    }

    @Test
    fun aZeroOrNegativeAttemptStillGetsARealDelay() {
        // Guards an off-by-one at the call site turning into a tight reconnect loop.
        assertEquals(1_000L, RemotePhasePolicy.reconnectDelayMs(0))
        assertEquals(1_000L, RemotePhasePolicy.reconnectDelayMs(-1))
    }

    @Test
    fun theBackoffIsMonotonic() {
        var previous = 0L
        for (attempt in 1..RemotePhasePolicy.MAX_AUTO_ATTEMPTS) {
            val delay = RemotePhasePolicy.reconnectDelayMs(attempt)
            assertTrue(delay >= previous)
            previous = delay
        }
        assertNotNull(previous)
    }
}
