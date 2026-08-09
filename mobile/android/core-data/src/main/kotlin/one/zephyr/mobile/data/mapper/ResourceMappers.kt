package one.zephyr.mobile.data.mapper

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import one.zephyr.mobile.data.EntityCodec
import one.zephyr.mobile.data.db.MirrorEntityRow
import one.zephyr.mobile.model.ActivityEvent
import one.zephyr.mobile.model.CapabilitySet
import one.zephyr.mobile.model.ClientToken
import one.zephyr.mobile.model.JumpHost
import one.zephyr.mobile.model.Note
import one.zephyr.mobile.model.Proxy
import one.zephyr.mobile.model.ProxyType
import one.zephyr.mobile.model.Residency
import one.zephyr.mobile.model.SecretPresence
import one.zephyr.mobile.model.Snippet
import one.zephyr.mobile.model.SshKey
import one.zephyr.mobile.model.SyncState

/** Projections for the remaining mirrored entities. Same opaque-preserving rules as connections. */
object ResourceMappers {

    private fun syncStateOf(row: MirrorEntityRow, conflicted: Boolean): SyncState = when {
        conflicted -> SyncState.CONFLICTED
        row.hasPendingWrite -> SyncState.PENDING_LOCAL
        else -> SyncState.SYNCED
    }

    fun proxy(row: MirrorEntityRow, conflicted: Boolean = false): Proxy {
        val payload = EntityCodec.parse(row.payloadJson)
        val presence = EntityCodec.parse(row.secretPresenceJson)
        val type = ProxyType.fromWire(EntityCodec.string(payload, "type"))
        return Proxy(
            id = row.entityId,
            ownerUserId = row.ownerUserId,
            name = EntityCodec.text(payload, "name"),
            type = type,
            host = EntityCodec.text(payload, "host"),
            port = EntityCodec.int(payload, "port", type.defaultPort),
            username = EntityCodec.text(payload, "username"),
            password = SecretPresence(EntityCodec.bool(presence, "hasPassword", false)),
            visibility = EntityCodec.text(payload, "visibility", "private"),
            revision = row.revision,
            updatedAt = row.serverUpdatedAt ?: row.localUpdatedAt,
            deletedAt = row.deletedAt,
            residency = Residency.OWNED,
            capabilities = CapabilitySet.owner,
            syncState = syncStateOf(row, conflicted),
        )
    }

    fun sshKey(row: MirrorEntityRow, conflicted: Boolean = false): SshKey {
        val payload = EntityCodec.parse(row.payloadJson)
        val presence = EntityCodec.parse(row.secretPresenceJson)
        return SshKey(
            id = row.entityId,
            ownerUserId = row.ownerUserId,
            name = EntityCodec.text(payload, "name"),
            remark = EntityCodec.text(payload, "remark"),
            privateKey = SecretPresence(EntityCodec.bool(presence, "hasPrivateKey", false)),
            passphrase = SecretPresence(EntityCodec.bool(presence, "hasPassphrase", false)),
            visibility = EntityCodec.text(payload, "visibility", "private"),
            revision = row.revision,
            updatedAt = row.serverUpdatedAt ?: row.localUpdatedAt,
            deletedAt = row.deletedAt,
            syncState = syncStateOf(row, conflicted),
        )
    }

    fun jumpHost(row: MirrorEntityRow, conflicted: Boolean = false): JumpHost {
        val payload = EntityCodec.parse(row.payloadJson)
        return JumpHost(
            id = row.entityId,
            ownerUserId = row.ownerUserId,
            name = EntityCodec.text(payload, "name"),
            connectionId = EntityCodec.text(payload, "connectionId"),
            visibility = EntityCodec.text(payload, "visibility", "private"),
            revision = row.revision,
            updatedAt = row.serverUpdatedAt ?: row.localUpdatedAt,
            deletedAt = row.deletedAt,
            syncState = syncStateOf(row, conflicted),
        )
    }

    fun note(row: MirrorEntityRow, conflicted: Boolean = false): Note {
        val payload = EntityCodec.parse(row.payloadJson)
        return Note(
            noteId = row.entityId,
            ownerUserId = row.ownerUserId,
            title = EntityCodec.text(payload, "title"),
            content = EntityCodec.text(payload, "content"),
            groupPath = EntityCodec.text(payload, "groupPath"),
            tags = EntityCodec.stringList(payload, "tags"),
            linkedConnectionIds = EntityCodec.stringList(payload, "linkedConnectionIds"),
            aiReadEnabled = EntityCodec.bool(payload, "allowAiRead", false),
            aiWriteEnabled = EntityCodec.bool(payload, "allowAiWrite", false),
            revision = row.revision,
            updatedAt = row.serverUpdatedAt ?: row.localUpdatedAt,
            deletedAt = row.deletedAt,
            syncState = syncStateOf(row, conflicted),
        )
    }

    fun snippet(row: MirrorEntityRow, conflicted: Boolean = false): Snippet {
        val payload = EntityCodec.parse(row.payloadJson)
        return Snippet(
            id = row.entityId,
            ownerUserId = row.ownerUserId,
            name = EntityCodec.text(payload, "name"),
            command = EntityCodec.text(payload, "command"),
            group = EntityCodec.text(payload, "group"),
            autoRun = EntityCodec.bool(payload, "autoRun", false),
            revision = row.revision,
            updatedAt = row.serverUpdatedAt ?: row.localUpdatedAt,
            deletedAt = row.deletedAt,
            syncState = syncStateOf(row, conflicted),
        )
    }

    /**
     * Client Token is a full entity, not metadata: the secret rides the device envelope into the
     * SecretStore, and only its presence appears here. PRODUCT_REQUIREMENTS.md 12 lists
     * "token metadata only" as a release blocker, so [ClientToken.token] must reflect a real value.
     */
    fun clientToken(row: MirrorEntityRow, conflicted: Boolean = false): ClientToken {
        val payload = EntityCodec.parse(row.payloadJson)
        val presence = EntityCodec.parse(row.secretPresenceJson)
        return ClientToken(
            id = row.entityId,
            ownerUserId = row.ownerUserId,
            name = EntityCodec.text(payload, "name"),
            token = SecretPresence(EntityCodec.bool(presence, "hasToken", false)),
            createdAt = EntityCodec.long(payload, "createdAt", 0L),
            updatedAt = row.serverUpdatedAt ?: row.localUpdatedAt,
            lastUsedAt = EntityCodec.longOrNull(payload, "lastUsedAt"),
            linkedOneDeviceCount = EntityCodec.int(payload, "linkedOneDeviceCount", 0),
            linkedLegacyAgentCount = EntityCodec.int(payload, "linkedLegacyAgentCount", 0),
            revision = row.revision,
            deletedAt = row.deletedAt,
            syncState = syncStateOf(row, conflicted),
        )
    }

    fun activityEvent(row: MirrorEntityRow): ActivityEvent {
        val payload = EntityCodec.parse(row.payloadJson)
        return ActivityEvent(
            id = row.entityId,
            userId = row.ownerUserId,
            message = EntityCodec.text(payload, "message"),
            type = EntityCodec.text(payload, "type"),
            category = EntityCodec.text(payload, "category"),
            outcome = EntityCodec.text(payload, "outcome"),
            protocol = EntityCodec.string(payload, "protocol"),
            target = EntityCodec.string(payload, "target"),
            connectionId = EntityCodec.string(payload, "connectionId"),
            durationMs = EntityCodec.longOrNull(payload, "durationMs"),
            occurredAt = EntityCodec.long(payload, "time", 0L),
        )
    }

    fun proxyValues(proxy: Proxy): JsonObject = JsonObject(
        mapOf(
            "name" to JsonPrimitive(proxy.name),
            "host" to JsonPrimitive(proxy.host),
            "port" to JsonPrimitive(proxy.port),
            "type" to JsonPrimitive(proxy.type.wireName),
            "username" to JsonPrimitive(proxy.username),
            "visibility" to JsonPrimitive(proxy.visibility),
        ),
    )

    fun sshKeyValues(key: SshKey): JsonObject = JsonObject(
        mapOf(
            "name" to JsonPrimitive(key.name),
            "remark" to JsonPrimitive(key.remark),
            "visibility" to JsonPrimitive(key.visibility),
        ),
    )

    fun jumpHostValues(host: JumpHost): JsonObject = JsonObject(
        mapOf(
            "name" to JsonPrimitive(host.name),
            "connectionId" to JsonPrimitive(host.connectionId),
            "visibility" to JsonPrimitive(host.visibility),
        ),
    )

    fun noteValues(note: Note): JsonObject = JsonObject(
        mapOf(
            "title" to JsonPrimitive(note.title),
            "content" to JsonPrimitive(note.content),
            "groupPath" to JsonPrimitive(note.groupPath),
            "tags" to JsonArrays.of(note.tags),
            "linkedConnectionIds" to JsonArrays.of(note.linkedConnectionIds),
            "allowAiRead" to JsonPrimitive(note.aiReadEnabled),
            "allowAiWrite" to JsonPrimitive(note.aiWriteEnabled),
        ),
    )

    fun snippetValues(snippet: Snippet): JsonObject = JsonObject(
        mapOf(
            "name" to JsonPrimitive(snippet.name),
            "command" to JsonPrimitive(snippet.command),
            "group" to JsonPrimitive(snippet.group),
            "autoRun" to JsonPrimitive(snippet.autoRun),
        ),
    )
}
