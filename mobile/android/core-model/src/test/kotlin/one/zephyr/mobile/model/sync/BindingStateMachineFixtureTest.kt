package one.zephyr.mobile.model.sync

import kotlinx.serialization.json.jsonPrimitive
import one.zephyr.mobile.contracts.BindingState
import one.zephyr.mobile.contracts.SyncContract
import one.zephyr.mobile.contracts.SyncPhase
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BindingStateMachineFixtureTest {

    @Test
    fun matchesGeneratedTransitions() {
        val cases = Fixtures.array(Fixtures.syncCases, "transitions")
        assertEquals(true, cases.isNotEmpty())
        for (case in cases) {
            val from = BindingState.valueOf(case["from"]!!.jsonPrimitive.content)
            val eventName = case["event"]!!.jsonPrimitive.content
            val event = SyncEvent.fromWire(eventName)
                ?: throw AssertionError("fixture uses unknown event " + eventName)
            val expected = BindingState.valueOf(case["expected"]!!.jsonPrimitive.content)
            assertEquals(from.name + " + " + eventName, expected, BindingStateMachine.next(from, event))
        }
    }

    @Test
    fun sidExpiryLeavesTheDataPlaneAlone() {
        for (state in BindingState.entries) {
            assertEquals(state, BindingStateMachine.next(state, SyncEvent.SID_EXPIRED))
        }
    }

    @Test
    fun cursorExpiryForcesBootstrapAndBlocksPush() {
        val next = BindingStateMachine.next(BindingState.IDLE, SyncEvent.CURSOR_EXPIRED)
        assertEquals(BindingState.BOUND_NEEDS_BOOTSTRAP, next)
        // Push may only run after the snapshot, so the phase list must start with bootstrap.
        assertEquals(SyncPhase.BOOTSTRAP_PAGE, BindingStateMachine.phasesFor(next)[1])
        assertTrue(
            BindingStateMachine.phasesFor(next).indexOf(SyncPhase.BOOTSTRAP_PAGE) <
                BindingStateMachine.phasesFor(next).indexOf(SyncPhase.PUSH_PENDING),
        )
    }

    @Test
    fun manualSyncStaysAvailableWhileBound() {
        // Removing 立即同步 is a release blocker, so it must survive conflict and re-auth states.
        assertTrue(BindingStateMachine.canRunManualSync(BindingState.CONFLICTED))
        assertTrue(BindingStateMachine.canRunManualSync(BindingState.REAUTH_REQUIRED))
        assertFalse(BindingStateMachine.canRunManualSync(BindingState.UNBOUND))
        assertFalse(BindingStateMachine.canRunManualSync(BindingState.REVOKED))
        assertFalse(BindingStateMachine.canRunManualSync(BindingState.FATAL_INCOMPATIBLE))
    }

    @Test
    fun automaticSyncStopsWhenReauthIsNeeded() {
        assertFalse(BindingStateMachine.canRunAutomaticSync(BindingState.REAUTH_REQUIRED, true))
        assertFalse(BindingStateMachine.canRunAutomaticSync(BindingState.IDLE, false))
        assertTrue(BindingStateMachine.canRunAutomaticSync(BindingState.IDLE, true))
    }

    @Test
    fun firstBindRunsBootstrapBeforeNormalRounds() {
        assertEquals(SyncContract.firstBindPhases, BindingStateMachine.phasesFor(BindingState.BOUND_NEEDS_BOOTSTRAP))
        assertEquals(SyncContract.normalPhases, BindingStateMachine.phasesFor(BindingState.IDLE))
    }

    @Test
    fun backoffIsClampedAndJittered() {
        assertEquals(1_000L, BindingStateMachine.backoffMs(0))
        assertEquals(900_000L, BindingStateMachine.backoffMs(99))
        assertEquals(500L, BindingStateMachine.backoffMs(0, 0.1))
        assertEquals(1_500L, BindingStateMachine.backoffMs(0, 9.0))
    }
}
