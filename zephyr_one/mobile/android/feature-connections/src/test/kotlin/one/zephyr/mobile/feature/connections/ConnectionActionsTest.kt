package one.zephyr.mobile.feature.connections

import one.zephyr.mobile.contracts.Capability
import one.zephyr.mobile.model.ActionGate
import one.zephyr.mobile.model.CapabilitySet
import one.zephyr.mobile.model.SharedUsePolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ConnectionActionsTest {

    @Test
    fun `owner may do everything`() {
        val c = Fixtures.connection()
        for (action in ConnectionAction.entries) {
            assertTrue(action.name, ConnectionActions.gate(c, action).isAllowed)
        }
    }

    @Test
    fun `no capability hides use edit and delete`() {
        val c = Fixtures.connection(capabilities = CapabilitySet.none)
        assertEquals(ActionGate.Hidden(Capability.USE), ConnectionActions.gate(c, ConnectionAction.USE))
        assertEquals(ActionGate.Hidden(Capability.EDIT), ConnectionActions.gate(c, ConnectionAction.EDIT))
        assertEquals(ActionGate.Hidden(Capability.DELETE), ConnectionActions.gate(c, ConnectionAction.DELETE))
    }

    /** Test opens and closes a transport and never writes, so USE is the whole requirement. */
    @Test
    fun `test needs only use`() {
        val c = Fixtures.connection(capabilities = Fixtures.capabilities(Capability.USE))
        assertTrue(ConnectionActions.gate(c, ConnectionAction.TEST).isAllowed)
        assertEquals(ActionGate.Hidden(Capability.EDIT), ConnectionActions.gate(c, ConnectionAction.EDIT))
    }

    /**
     * Copying a shared row would create owned material from someone else's resource, which the
     * residency contract forbids. It stays visible with a reason so the absence is explained.
     */
    @Test
    fun `duplicate is disabled with a reason for shared rows`() {
        val gate = ConnectionActions.gate(Fixtures.shared(), ConnectionAction.DUPLICATE)
        assertEquals(
            ActionGate.Disabled(Capability.EDIT, ConnectionActions.REASON_SHARED_NO_COPY),
            gate,
        )
        assertTrue(gate.isVisible)
    }

    @Test
    fun `share is disabled with a reason for shared rows`() {
        assertEquals(
            ActionGate.Disabled(Capability.SHARE, ConnectionActions.REASON_SHARED_NO_RESHARE),
            ConnectionActions.gate(Fixtures.shared(), ConnectionAction.SHARE),
        )
    }

    @Test
    fun `share is hidden for an owned row without the capability`() {
        val c = Fixtures.connection(capabilities = Fixtures.capabilities(Capability.VIEW, Capability.EDIT))
        assertEquals(
            ActionGate.Hidden(Capability.SHARE),
            ConnectionActions.gate(c, ConnectionAction.SHARE),
        )
    }

    @Test
    fun `visible actions for a shared row keep use and the disabled explanations`() {
        val visible = ConnectionActions.visibleActions(Fixtures.shared())
        assertTrue(ConnectionAction.USE in visible)
        assertTrue(ConnectionAction.TEST in visible)
        assertTrue(ConnectionAction.DUPLICATE in visible)
        assertTrue(ConnectionAction.SHARE in visible)
        assertTrue(ConnectionAction.EDIT !in visible)
        assertTrue(ConnectionAction.DELETE !in visible)
    }

    @Test
    fun `owned rows get no shared use disclosure`() {
        assertNull(ConnectionActions.sharedUseDisclosure(Fixtures.connection()))
    }

    /** The catalog bans a vague "安全连接": relay and direct must read differently. */
    @Test
    fun `shared use disclosure distinguishes relay from direct`() {
        assertEquals(
            ConnectionActions.DISCLOSURE_RELAY,
            ConnectionActions.sharedUseDisclosure(Fixtures.shared(usePolicy = SharedUsePolicy.RELAY_ONLY)),
        )
        assertEquals(
            ConnectionActions.DISCLOSURE_DIRECT,
            ConnectionActions.sharedUseDisclosure(Fixtures.shared(usePolicy = SharedUsePolicy.DIRECT_ALLOWED)),
        )
    }
}
