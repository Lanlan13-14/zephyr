package one.zephyr.mobile.data.session

import one.zephyr.mobile.contracts.Capability
import one.zephyr.mobile.model.CapabilitySet
import one.zephyr.mobile.model.Protocol
import one.zephyr.mobile.model.Residency

/**
 * Fixtures for the session list.
 *
 * A builder with defaults rather than literal rows in every test: the interesting tests each vary
 * exactly one field, and spelling out nineteen constructor arguments each time would hide which one
 * is under test.
 */
internal object SessionFixtures {

    val useOnly = CapabilitySet(setOf(Capability.VIEW, Capability.USE))
    val viewOnly = CapabilitySet(setOf(Capability.VIEW))

    fun row(
        sessionId: String = "s-1",
        connectionId: String = "c-1",
        protocol: Protocol = Protocol.SSH,
        transport: SessionTransport = SessionTransport.CONNECTED,
        execution: SessionExecution = SessionExecution.LOCAL,
        capabilities: CapabilitySet = useOnly,
        residency: Residency = Residency.OWNED,
        minimised: Boolean = false,
        revoked: Boolean = false,
        revokedReason: String? = null,
        startedAt: Long = 1_000L,
        endedAt: Long? = null,
        latencyMs: Long? = 24L,
        unreadOutput: Boolean = false,
    ): SessionRow = SessionRow(
        sessionId = sessionId,
        connectionId = connectionId,
        protocol = protocol,
        name = "prod-web",
        host = "10.0.0.5",
        port = protocol.defaultPort,
        transport = transport,
        execution = execution,
        capabilities = capabilities,
        residency = residency,
        minimised = minimised,
        revoked = revoked,
        revokedReason = revokedReason,
        startedAt = startedAt,
        endedAt = endedAt,
        latencyMs = latencyMs,
        unreadOutput = unreadOutput,
    )
}
