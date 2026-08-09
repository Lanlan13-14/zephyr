package one.zephyr.mobile.feature.connections

import one.zephyr.mobile.contracts.Capability
import one.zephyr.mobile.model.CapabilitySet
import one.zephyr.mobile.model.Connection
import one.zephyr.mobile.model.Protocol
import one.zephyr.mobile.model.Residency
import one.zephyr.mobile.model.SecretPresence
import one.zephyr.mobile.model.SharedUsePolicy

/**
 * Builders for the connection tests.
 *
 * Defaults are an owned SSH row with full capabilities, so each test states only the field it is
 * actually about. That keeps a test's intent readable and stops an unrelated default from being
 * the thing that makes an assertion pass.
 */
internal object Fixtures {

    const val OWNER = "user-1"

    fun connection(
        id: String = "c-1",
        name: String = "prod-web",
        host: String = "10.0.0.1",
        protocol: Protocol = Protocol.SSH,
        port: Int = protocol.defaultPort,
        username: String = "root",
        remark: String = "",
        tags: List<String> = emptyList(),
        lastConnectedAt: Long? = null,
        deletedAt: Long? = null,
        residency: Residency = Residency.OWNED,
        capabilities: CapabilitySet = CapabilitySet.owner,
        sharedUsePolicy: SharedUsePolicy = SharedUsePolicy.RELAY_ONLY,
        password: SecretPresence = SecretPresence.absent,
        privateKey: SecretPresence = SecretPresence.absent,
        revision: Long = 3,
    ): Connection = Connection(
        id = id,
        ownerUserId = OWNER,
        protocol = protocol,
        name = name,
        host = host,
        port = port,
        username = username,
        remark = remark,
        tags = tags,
        lastConnectedAt = lastConnectedAt,
        deletedAt = deletedAt,
        residency = residency,
        capabilities = capabilities,
        sharedUsePolicy = sharedUsePolicy,
        password = password,
        privateKey = privateKey,
        revision = revision,
    )

    /** Shared-to-me row: implicit grants only, so no EDIT/DELETE/SHARE. */
    fun shared(
        id: String = "s-1",
        name: String = "shared-db",
        usePolicy: SharedUsePolicy = SharedUsePolicy.RELAY_ONLY,
    ): Connection = connection(
        id = id,
        name = name,
        residency = Residency.SHARED_ONLINE_ONLY,
        capabilities = CapabilitySet.implicitShare,
        sharedUsePolicy = usePolicy,
    )

    fun capabilities(vararg values: Capability): CapabilitySet = CapabilitySet(values.toSet())

    /** Everything the route validator will accept, for tests that are not about route repair. */
    fun inventory(
        proxies: Set<String> = setOf("p-1", "p-2"),
        keys: Set<String> = setOf("k-1", "k-2"),
        jumps: Set<String> = setOf("j-1", "j-2", "j-3", "j-4", "j-5", "j-6", "j-7", "j-8", "j-9"),
    ): RouteInventory = RouteInventory(proxies, keys, jumps)
}
