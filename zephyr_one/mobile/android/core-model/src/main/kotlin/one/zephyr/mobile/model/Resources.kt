package one.zephyr.mobile.model

/** SOCKS5/HTTP CONNECT proxy. Zephyr default is SOCKS5 on 1080. */
data class Proxy(
    val id: String,
    val ownerUserId: String,
    val name: String,
    val type: ProxyType = ProxyType.default,
    val host: String,
    val port: Int = ProxyType.default.defaultPort,
    val username: String = "",
    val password: SecretPresence = SecretPresence.absent,
    val visibility: String = "private",
    val revision: Long = 0,
    val updatedAt: Long = 0,
    val deletedAt: Long? = null,
    val residency: Residency = Residency.OWNED,
    val capabilities: CapabilitySet = CapabilitySet.owner,
    val syncState: SyncState = SyncState.SYNCED,
    val opaque: Map<String, String> = emptyMap(),
) {
    companion object { const val ENTITY_TYPE = "proxy" }
}

enum class ProxyType(val wireName: String, val defaultPort: Int) {
    SOCKS5("socks5", 1080),
    HTTP_CONNECT("http", 8080),
    ;
    companion object {
        val default = SOCKS5
        fun fromWire(value: String?) = entries.firstOrNull { it.wireName == value } ?: default
    }
}

data class SshKey(
    val id: String,
    val ownerUserId: String,
    val name: String,
    val remark: String = "",
    val privateKey: SecretPresence = SecretPresence.absent,
    val passphrase: SecretPresence = SecretPresence.absent,
    val visibility: String = "private",
    val revision: Long = 0,
    val updatedAt: Long = 0,
    val deletedAt: Long? = null,
    val residency: Residency = Residency.OWNED,
    val capabilities: CapabilitySet = CapabilitySet.owner,
    val syncState: SyncState = SyncState.SYNCED,
    val opaque: Map<String, String> = emptyMap(),
) {
    companion object { const val ENTITY_TYPE = "sshKey" }
}

/** A jump host is a named pointer at an SSH connection, so deleting it is reference-checked. */
data class JumpHost(
    val id: String,
    val ownerUserId: String,
    val name: String,
    val connectionId: String,
    val visibility: String = "private",
    val revision: Long = 0,
    val updatedAt: Long = 0,
    val deletedAt: Long? = null,
    val residency: Residency = Residency.OWNED,
    val capabilities: CapabilitySet = CapabilitySet.owner,
    val syncState: SyncState = SyncState.SYNCED,
    val opaque: Map<String, String> = emptyMap(),
) {
    companion object { const val ENTITY_TYPE = "jumpHost" }
}

/** Markdown note. Limits are the Zephyr limits, enforced before a local write is accepted. */
data class Note(
    val noteId: String,
    val ownerUserId: String,
    val title: String,
    val content: String = "",
    val groupPath: String = "",
    val tags: List<String> = emptyList(),
    val linkedConnectionIds: List<String> = emptyList(),
    val aiReadEnabled: Boolean = false,
    val aiWriteEnabled: Boolean = false,
    val revision: Long = 0,
    val updatedAt: Long = 0,
    val deletedAt: Long? = null,
    val residency: Residency = Residency.OWNED,
    val capabilities: CapabilitySet = CapabilitySet.owner,
    val syncState: SyncState = SyncState.SYNCED,
    val opaque: Map<String, String> = emptyMap(),
) {
    val isTrashed: Boolean get() = deletedAt != null

    companion object {
        const val ENTITY_TYPE = "note"
        const val MAX_TITLE_CHARS = 200
        const val MAX_CONTENT_BYTES = 1024 * 1024
        const val MAX_TAGS = 100
        const val MAX_LINKS = 100
        const val MAX_BULK = 200
    }
}

data class Snippet(
    val id: String,
    val ownerUserId: String,
    val name: String,
    val command: String,
    val group: String = "",
    val autoRun: Boolean = false,
    val revision: Long = 0,
    val updatedAt: Long = 0,
    val deletedAt: Long? = null,
    val residency: Residency = Residency.OWNED,
    val capabilities: CapabilitySet = CapabilitySet.owner,
    val syncState: SyncState = SyncState.SYNCED,
    val opaque: Map<String, String> = emptyMap(),
) {
    companion object {
        const val ENTITY_TYPE = "snippet"
        const val MAX_NAME_CHARS = 60
        const val MAX_COMMAND_CHARS = 20_000
        const val MAX_GROUP_CHARS = 40
        const val MAX_PER_ACCOUNT = 500
    }
}

/**
 * A Zephyr Client Token. This is a full mutual-backup entity, not transitional metadata, so the
 * secret is mirrored through the device envelope into the SecretStore and never into a plain row.
 */
data class ClientToken(
    val id: String,
    val ownerUserId: String,
    val name: String,
    val token: SecretPresence = SecretPresence.absent,
    val createdAt: Long = 0,
    val updatedAt: Long = 0,
    val lastUsedAt: Long? = null,
    val linkedOneDeviceCount: Int = 0,
    val linkedLegacyAgentCount: Int = 0,
    val revision: Long = 0,
    val deletedAt: Long? = null,
    val syncState: SyncState = SyncState.SYNCED,
) {
    companion object {
        const val ENTITY_TYPE = "clientToken"
        const val MAX_NAME_CHARS = 80
        const val MIN_SECRET_CHARS = 16
        const val MAX_SECRET_CHARS = 256
    }
}

/** Append-only activity row, deduplicated by stable event id. */
data class ActivityEvent(
    val id: String,
    val userId: String,
    val message: String,
    val type: String = "",
    val category: String = "",
    val outcome: String = "",
    val protocol: String? = null,
    val target: String? = null,
    val connectionId: String? = null,
    val durationMs: Long? = null,
    val occurredAt: Long,
) {
    companion object { const val ENTITY_TYPE = "activityEvent" }
}
