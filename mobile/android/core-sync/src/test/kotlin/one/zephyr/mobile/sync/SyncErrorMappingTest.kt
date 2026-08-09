package one.zephyr.mobile.sync

import one.zephyr.mobile.contracts.BindingState
import one.zephyr.mobile.contracts.SyncContract
import one.zephyr.mobile.model.MobileError
import one.zephyr.mobile.model.sync.BindingStateMachine
import one.zephyr.mobile.model.sync.SyncEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SyncErrorMappingTest {

    @Test
    fun `cursor expiry keeps the mirror but forces a fresh snapshot`() {
        assertEquals(SyncEvent.CURSOR_EXPIRED, SyncErrorMapping.eventFor("cursor_expired"))
        assertEquals(
            BindingState.BOUND_NEEDS_BOOTSTRAP,
            BindingStateMachine.next(BindingState.RUNNING, SyncEvent.CURSOR_EXPIRED),
        )
    }

    @Test
    fun `sid expiry leaves the data plane untouched`() {
        assertEquals(SyncEvent.SID_EXPIRED, SyncErrorMapping.eventFor("app_session_expired"))
        assertEquals(
            BindingState.RUNNING,
            BindingStateMachine.next(BindingState.RUNNING, SyncEvent.SID_EXPIRED),
        )
        // A management-plane expiry must not abort a data-plane round.
        assertFalse(SyncErrorMapping.abortsRound(MobileError.local("app_session_expired", "sid gone")))
    }

    @Test
    fun `a missing device row asks for re-auth rather than discarding the mirror`() {
        assertEquals(SyncEvent.TOKEN_MISSING, SyncErrorMapping.eventFor("client_not_found"))
        assertEquals(
            BindingState.REAUTH_REQUIRED,
            BindingStateMachine.next(BindingState.IDLE, SyncEvent.TOKEN_MISSING),
        )
        // Only an explicit revocation reaches REVOKED.
        assertEquals(
            BindingState.REVOKED,
            BindingStateMachine.next(BindingState.IDLE, SyncErrorMapping.eventFor("client_revoked")!!),
        )
    }

    @Test
    fun `reauth required still allows a manual round but no automatic one`() {
        assertTrue(BindingStateMachine.canRunManualSync(BindingState.REAUTH_REQUIRED))
        assertFalse(BindingStateMachine.canRunAutomaticSync(BindingState.REAUTH_REQUIRED, automaticEnabled = true))
    }

    @Test
    fun `unknown codes map to no transition`() {
        assertNull(SyncErrorMapping.eventFor("something_new_from_a_future_server"))
    }

    @Test
    fun `residency violation always aborts the round`() {
        val error = MobileError.local("shared_residency_violation", "shared row offered for the mirror")
        assertTrue(SyncErrorMapping.requiresSharedPurge(error.code))
        assertTrue(SyncErrorMapping.abortsRound(error))
    }

    @Test
    fun `retry after wins over the local backoff ladder`() {
        val rateLimited = MobileError(
            code = "rate_limited",
            message = "slow down",
            retryable = true,
            requestId = null,
            retryAfterSeconds = 42,
        )
        assertEquals(42_000L, SyncErrorMapping.retryDelayMs(rateLimited, attempt = 0))
    }

    @Test
    fun `backoff follows the frozen ladder and clamps jitter`() {
        assertEquals(SyncContract.retryBackoffMs[0], SyncErrorMapping.retryDelayMs(null, attempt = 0))
        assertEquals(SyncContract.retryBackoffMs[3], SyncErrorMapping.retryDelayMs(null, attempt = 3))
        // Beyond the ladder the cap holds.
        assertEquals(SyncContract.retryBackoffMs.last(), SyncErrorMapping.retryDelayMs(null, attempt = 99))
        // Jitter outside 0.5..1.5 is clamped rather than honoured.
        assertEquals(500L, BindingStateMachine.backoffMs(0, jitter = 0.01))
        assertEquals(1_500L, BindingStateMachine.backoffMs(0, jitter = 9.0))
    }

    @Test
    fun `registry and protocol mismatches are fatal`() {
        for (code in listOf("registry_mismatch", "unsupported_protocol_version")) {
            val event = SyncErrorMapping.eventFor(code)!!
            assertEquals(
                BindingState.FATAL_INCOMPATIBLE,
                BindingStateMachine.next(BindingState.IDLE, event),
            )
        }
    }
}
