package one.zephyr.mobile.protocol.ssh

import one.zephyr.mobile.model.Connection
import one.zephyr.mobile.model.ConnectionMode
import one.zephyr.mobile.model.JumpHost
import one.zephyr.mobile.model.Protocol
import one.zephyr.mobile.model.Proxy
import one.zephyr.mobile.model.ProxyType

/**
 * An in-memory [HostKeyStore] that records what was asked of it.
 *
 * The recording is the point: the security property under test is not only which verdict comes back
 * but that verifying never writes trust as a side effect, and that can only be asserted by watching
 * the store.
 */
class RecordingHostKeyStore : HostKeyStore {

    private val keys = mutableMapOf<String, HostKey>()
    val calls = mutableListOf<String>()

    override suspend fun find(scope: HostKeyScope): HostKey? {
        calls += "find:" + scope.storageKey
        return keys[scope.storageKey]
    }

    override suspend fun trust(scope: HostKeyScope, key: HostKey) {
        calls += "trust:" + scope.storageKey
        keys[scope.storageKey] = key
    }

    override suspend fun forget(scope: HostKeyScope) {
        calls += "forget:" + scope.storageKey
        keys.remove(scope.storageKey)
    }

    fun seed(scope: HostKeyScope, key: HostKey) {
        keys[scope.storageKey] = key
    }

    val storedCount: Int get() = keys.size
}

/** An ssh-rsa public key blob. Fingerprints are pinned in [HostKeyVerifierTest]. */
val KEY_A = HostKey("ssh-rsa", byteArrayOf(0, 0, 0, 7, 115, 115, 104, 45, 114, 115, 97, 1, 2, 3))

/** A different key for the same algorithm, i.e. the man-in-the-middle case. */
val KEY_B = HostKey("ssh-rsa", byteArrayOf(0, 0, 0, 7, 115, 115, 104, 45, 114, 115, 97, 9, 9, 9))

val KEY_ED25519 = HostKey(
    "ssh-ed25519",
    byteArrayOf(0, 0, 0, 11, 115, 115, 104, 45, 101, 100, 50, 53, 53, 49, 57, 7, 7),
)

fun connection(
    id: String = "conn-1",
    host: String = "10.0.0.5",
    port: Int = 22,
    username: String = "root",
    mode: ConnectionMode = ConnectionMode.DIRECT,
    proxyId: String? = null,
    jumpHostIds: List<String> = emptyList(),
): Connection = Connection(
    id = id,
    ownerUserId = "user-1",
    protocol = Protocol.SSH,
    name = "lab-" + id,
    host = host,
    port = port,
    username = username,
    connectionMode = mode,
    proxyId = proxyId,
    jumpHostIds = jumpHostIds,
)

fun proxy(
    id: String = "proxy-1",
    type: ProxyType = ProxyType.SOCKS5,
    host: String = "proxy.internal",
    port: Int = 1080,
    username: String = "agent",
): Proxy = Proxy(
    id = id,
    ownerUserId = "user-1",
    name = "office",
    type = type,
    host = host,
    port = port,
    username = username,
)

fun jumpHost(id: String, connectionId: String): JumpHost =
    JumpHost(id = id, ownerUserId = "user-1", name = "jump-" + id, connectionId = connectionId)

/** Builds a chain of [count] jump hosts, each pointing at its own distinct SSH connection. */
fun jumpChain(count: Int): Triple<List<String>, Map<String, JumpHost>, Map<String, Connection>> {
    val ids = (1..count).map { index -> "jump-" + index }
    val hosts = ids.associateWith { id -> jumpHost(id, "via-" + id) }
    val vias = ids.associate { id ->
        val viaId = "via-" + id
        viaId to connection(id = viaId, host = viaId + ".internal", port = 2200, username = "hop")
    }
    return Triple(ids, hosts, vias)
}
