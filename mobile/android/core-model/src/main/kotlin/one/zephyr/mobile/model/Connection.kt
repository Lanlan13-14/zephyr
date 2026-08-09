package one.zephyr.mobile.model

/**
 * A Zephyr connection as mirrored on the device. Field names track the entity registry so a
 * fieldMask can be produced without a translation table.
 */
data class Connection(
    val id: String,
    val ownerUserId: String,
    val protocol: Protocol,
    val name: String,
    val host: String,
    val port: Int,
    val username: String = "",
    val remark: String = "",
    val tags: List<String> = emptyList(),
    val encoding: TerminalEncoding = TerminalEncoding.default,
    val connectionMode: ConnectionMode = ConnectionMode.default,
    val proxyId: String? = null,
    val sshKeyId: String? = null,
    val jumpHostIds: List<String> = emptyList(),
    val rdp: RdpSettings = RdpSettings(),
    val fileSyncIntent: FileSyncDirectoryIntent = FileSyncDirectoryIntent.default,
    val visibility: String = "private",
    val password: SecretPresence = SecretPresence.absent,
    val privateKey: SecretPresence = SecretPresence.absent,
    val revision: Long = 0,
    val updatedAt: Long = 0,
    val lastConnectedAt: Long? = null,
    val deletedAt: Long? = null,
    val residency: Residency = Residency.OWNED,
    val capabilities: CapabilitySet = CapabilitySet.owner,
    val sharedOwnerLabel: String? = null,
    val sharedUsePolicy: SharedUsePolicy = SharedUsePolicy.RELAY_ONLY,
    val grantExpiresAt: Long? = null,
    val syncState: SyncState = SyncState.SYNCED,
    /** Fields One does not understand. Preserved verbatim, never named in a fieldMask. */
    val opaque: Map<String, String> = emptyMap(),
    /** One-shot deep link connection: never listed, never mirrored, cleaned up after TTL. */
    val ephemeral: Boolean = false,
) {
    val displayAddress: String get() = host + ":" + port
    val isDeleted: Boolean get() = deletedAt != null

    /** Jump chain depth is capped at 8 levels by Zephyr's route planner. */
    val jumpDepth: Int get() = jumpHostIds.size

    val dependencyIds: List<String>
        get() = buildList {
            proxyId?.let(::add)
            sshKeyId?.let(::add)
            addAll(jumpHostIds)
        }

    /** Switching protocol clears incompatible fields but keeps the rest of the draft. */
    fun withProtocol(next: Protocol, portWasEdited: Boolean): Connection {
        if (next == protocol) return this
        val nextPort = if (portWasEdited) port else next.defaultPort
        return when (next) {
            Protocol.TELNET -> copy(
                protocol = next,
                port = nextPort,
                sshKeyId = null,
                privateKey = SecretPresence.absent,
            )
            else -> copy(protocol = next, port = nextPort)
        }
    }

    fun withConnectionMode(next: ConnectionMode): Connection = when (next) {
        ConnectionMode.DIRECT -> copy(connectionMode = next, proxyId = null, jumpHostIds = emptyList())
        ConnectionMode.PROXY -> copy(connectionMode = next, jumpHostIds = emptyList())
        ConnectionMode.JUMP -> copy(connectionMode = next, proxyId = null)
    }

    companion object {
        const val MAX_JUMP_DEPTH = 8
        const val ENTITY_TYPE = "connection"
        const val EPHEMERAL_TTL_MS = 6L * 60 * 60 * 1000
    }
}

/** Local mirror state for any entity row. */
enum class SyncState {
    SYNCED,
    PENDING_LOCAL,
    CONFLICTED,
    /** Present on the server but not authorized for this device to edit. */
    READ_ONLY_REMOTE,
}
