package one.zephyr.mobile.feature.sessions

import one.zephyr.mobile.contracts.Capability
import one.zephyr.mobile.data.session.SessionExecution
import one.zephyr.mobile.data.session.SessionRow
import one.zephyr.mobile.data.session.SessionTransport
import one.zephyr.mobile.model.CapabilitySet
import one.zephyr.mobile.model.Connection
import one.zephyr.mobile.model.Protocol
import one.zephyr.mobile.model.Residency
import one.zephyr.mobile.model.SharedUsePolicy
import one.zephyr.mobile.model.TerminalEncoding

/**
 * Row and connection builders.
 *
 * core-data has its own copy because a test source set is not visible across modules. Duplicating a
 * builder is cheaper than adding a testFixtures variant to core-data, and the two are independent by
 * design: if the SessionRow shape changes, both fail rather than one silently compiling.
 */
internal object SessionFixtures {

    fun row(
        sessionId: String = "s1",
        connectionId: String = "c1",
        protocol: Protocol = Protocol.SSH,
        name: String = "prod-web",
        host: String = "10.0.0.1",
        port: Int = 22,
        transport: SessionTransport = SessionTransport.CONNECTED,
        execution: SessionExecution = SessionExecution.LOCAL,
        capabilities: CapabilitySet = CapabilitySet.owner,
        residency: Residency = Residency.OWNED,
        minimised: Boolean = false,
        revoked: Boolean = false,
        revokedReason: String? = null,
        startedAt: Long = 1_000L,
        endedAt: Long? = null,
        latencyMs: Long? = null,
        unreadOutput: Boolean = false,
        restoredFromWorkspace: Boolean = false,
        detail: String? = null,
    ): SessionRow = SessionRow(
        sessionId = sessionId,
        connectionId = connectionId,
        protocol = protocol,
        name = name,
        host = host,
        port = port,
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
        restoredFromWorkspace = restoredFromWorkspace,
        detail = detail,
    )

    fun connection(
        id: String = "c1",
        protocol: Protocol = Protocol.SSH,
        name: String = "prod-web",
        host: String = "10.0.0.1",
        port: Int = 22,
        username: String = "root",
        encoding: TerminalEncoding = TerminalEncoding.UTF8,
        residency: Residency = Residency.OWNED,
        capabilities: CapabilitySet = CapabilitySet.owner,
        sharedUsePolicy: SharedUsePolicy = SharedUsePolicy.RELAY_ONLY,
        sharedOwnerLabel: String? = null,
    ): Connection = Connection(
        id = id,
        ownerUserId = "u1",
        protocol = protocol,
        name = name,
        host = host,
        port = port,
        username = username,
        encoding = encoding,
        residency = residency,
        capabilities = capabilities,
        sharedUsePolicy = sharedUsePolicy,
        sharedOwnerLabel = sharedOwnerLabel,
    )

    /** view + use only: enough to open a session, not enough to edit or share it. */
    val useOnly = CapabilitySet(setOf(Capability.VIEW, Capability.USE))

    /** view only: the gate that must disable 重连 with a reason rather than hide it. */
    val viewOnly = CapabilitySet(setOf(Capability.VIEW))
}
