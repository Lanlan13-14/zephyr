package one.zephyr.mobile.data.mapper

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import one.zephyr.mobile.data.EntityCodec
import one.zephyr.mobile.data.db.MirrorEntityRow
import one.zephyr.mobile.model.CapabilitySet
import one.zephyr.mobile.model.Connection
import one.zephyr.mobile.model.ConnectionMode
import one.zephyr.mobile.model.FileSyncDirectoryIntent
import one.zephyr.mobile.model.Protocol
import one.zephyr.mobile.model.RdpFps
import one.zephyr.mobile.model.RdpQuality
import one.zephyr.mobile.model.RdpResolution
import one.zephyr.mobile.model.RdpSettings
import one.zephyr.mobile.model.RdpSoundMode
import one.zephyr.mobile.model.RdpTouchMode
import one.zephyr.mobile.model.Residency
import one.zephyr.mobile.model.SecretPresence
import one.zephyr.mobile.model.SyncState
import one.zephyr.mobile.model.TerminalEncoding

/**
 * Projection between the stored payload and [Connection].
 *
 * Projection rather than deserialisation is deliberate: DATA_AND_MIGRATION.md 3.3 requires
 * opaquePreserve fields (rdpPipeline today, anything the main end adds tomorrow) to survive a round
 * trip untouched. A `@Serializable` data class would drop unknown keys and the next push would
 * erase them on the server.
 */
object ConnectionMapper {

    /**
     * @param deviceLocal overlay values for this row, from OverlayDao.
     *
     * Passed in rather than read here because the mapper is pure. The only key it consumes today is
     * storageIntent: DEVELOPMENT.md 878 keeps the directory *intent* on the synced connection and
     * the profileId device-local, but the frozen entity registry lists it in neither editableFields
     * nor deviceLocalFields, so One stores the user's choice on the device and never pushes it.
     */
    fun fromRow(
        row: MirrorEntityRow,
        pending: Boolean,
        conflicted: Boolean,
        deviceLocal: Map<String, String> = emptyMap(),
    ): Connection {
        val payload = EntityCodec.parse(row.payloadJson)
        val presence = EntityCodec.parse(row.secretPresenceJson)
        return Connection(
            id = row.entityId,
            ownerUserId = row.ownerUserId,
            // An unknown protocol stays read-only rather than being coerced to SSH, which would
            // silently rewrite the row on the next push.
            protocol = Protocol.fromWire(EntityCodec.string(payload, "protocol")) ?: Protocol.SSH,
            name = EntityCodec.text(payload, "name"),
            host = EntityCodec.text(payload, "host"),
            port = EntityCodec.int(payload, "port", 0),
            username = EntityCodec.text(payload, "username"),
            remark = EntityCodec.text(payload, "remark"),
            tags = EntityCodec.stringList(payload, "tags"),
            encoding = TerminalEncoding.fromWire(EntityCodec.string(payload, "encoding")),
            connectionMode = ConnectionMode.fromWire(EntityCodec.string(payload, "connectionMode")),
            proxyId = EntityCodec.string(payload, "proxyId"),
            sshKeyId = EntityCodec.string(payload, "sshKeyId"),
            jumpHostIds = jumpHostIds(payload),
            rdp = rdpFrom(payload),
            // The overlay wins over the payload: it is the only writable home this field has while
            // the registry gap stands. Falling back to the payload keeps a value the main end may
            // start sending later from being ignored.
            fileSyncIntent = FileSyncDirectoryIntent.fromWire(
                deviceLocal[STORAGE_INTENT_FIELD] ?: EntityCodec.string(payload, "storageIntent"),
            ),
            visibility = EntityCodec.text(payload, "visibility", "private"),
            password = SecretPresence(EntityCodec.bool(presence, "hasPassword", false)),
            privateKey = SecretPresence(EntityCodec.bool(presence, "hasPrivateKey", false)),
            revision = row.revision,
            updatedAt = row.serverUpdatedAt ?: row.localUpdatedAt,
            lastConnectedAt = EntityCodec.longOrNull(payload, "lastConnectedAt"),
            deletedAt = row.deletedAt,
            residency = Residency.OWNED,
            capabilities = CapabilitySet.owner,
            syncState = when {
                conflicted -> SyncState.CONFLICTED
                pending || row.hasPendingWrite -> SyncState.PENDING_LOCAL
                else -> SyncState.SYNCED
            },
            opaque = opaqueOf(payload),
            ephemeral = false,
        )
    }

    /**
     * Zephyr accepts both the single `jumpHostId` and the ordered `jumpHostIds` chain.
     * The list wins when present so an 8-level chain is not truncated to its first hop.
     */
    private fun jumpHostIds(payload: JsonObject): List<String> {
        val list = EntityCodec.stringList(payload, "jumpHostIds")
        if (list.isNotEmpty()) return list.take(Connection.MAX_JUMP_DEPTH)
        return EntityCodec.string(payload, "jumpHostId")?.let(::listOf) ?: emptyList()
    }

    private fun rdpFrom(payload: JsonObject): RdpSettings = RdpSettings(
        soundMode = RdpSoundMode.fromWire(EntityCodec.string(payload, "rdpSoundMode")),
        clipboard = EntityCodec.bool(payload, "rdpClipboard", true),
        microphone = EntityCodec.bool(payload, "rdpMicrophone", false),
        camera = EntityCodec.bool(payload, "rdpCamera", false),
        storage = EntityCodec.bool(payload, "rdpStorage", false),
        location = EntityCodec.bool(payload, "rdpLocation", false),
        resolution = RdpResolution.fromWire(EntityCodec.string(payload, "rdpResolution")),
        quality = RdpQuality.fromWire(EntityCodec.string(payload, "rdpQuality")),
        fps = RdpFps.fromValue(EntityCodec.intOrNull(payload, "rdpFps")),
        touchMode = RdpTouchMode.fromWire(EntityCodec.string(payload, "rdpTouchMode")),
        // Clamped rather than rejected: a server value outside the slider range must not make the
        // editor unopenable.
        touchSensitivity = RdpSettings.clampSensitivity(
            EntityCodec.float(payload, "rdpTouchSensitivity", RdpSettings.DEFAULT_SENSITIVITY),
        ),
        domain = EntityCodec.text(payload, "rdpDomain"),
    )

    private fun opaqueOf(payload: JsonObject): Map<String, String> =
        EntityRegistrySupport.opaqueFields(Connection.ENTITY_TYPE)
            .mapNotNull { field -> payload[field]?.let { field to it.toString() } }
            .toMap()

    /**
     * Overlay key for the directory intent.
     *
     * Named after the frozen wire name in DEVELOPMENT.md 878 rather than the Kotlin property, so if
     * the registry later adopts the field the overlay row and the pushed field agree.
     */
    const val STORAGE_INTENT_FIELD = "storageIntent"

    /** Editor output: the values for the fields the user actually touched. */
    fun editValues(connection: Connection, mask: List<String>): JsonObject {
        val values = LinkedHashMap<String, kotlinx.serialization.json.JsonElement>()
        for (field in mask.map { it.substringBefore('.').substringBefore('[') }.distinct()) {
            val element = when (field) {
                "name" -> JsonPrimitive(connection.name)
                "host" -> JsonPrimitive(connection.host)
                "port" -> JsonPrimitive(connection.port)
                "protocol" -> JsonPrimitive(connection.protocol.wireName)
                "username" -> JsonPrimitive(connection.username)
                "remark" -> JsonPrimitive(connection.remark)
                "tags" -> JsonArrays.of(connection.tags)
                "connectionMode" -> JsonPrimitive(connection.connectionMode.wireName)
                "proxyId" -> connection.proxyId?.let(::JsonPrimitive) ?: kotlinx.serialization.json.JsonNull
                "sshKeyId" -> connection.sshKeyId?.let(::JsonPrimitive) ?: kotlinx.serialization.json.JsonNull
                "jumpHostIds" -> JsonArrays.of(connection.jumpHostIds)
                "jumpHostId" -> connection.jumpHostIds.firstOrNull()?.let(::JsonPrimitive)
                    ?: kotlinx.serialization.json.JsonNull
                "rdpSoundMode" -> JsonPrimitive(connection.rdp.soundMode.wireName)
                "rdpClipboard" -> JsonPrimitive(connection.rdp.clipboard)
                "rdpMicrophone" -> JsonPrimitive(connection.rdp.microphone)
                "rdpCamera" -> JsonPrimitive(connection.rdp.camera)
                "rdpStorage" -> JsonPrimitive(connection.rdp.storage)
                "rdpLocation" -> JsonPrimitive(connection.rdp.location)
                "rdpResolution" -> JsonPrimitive(connection.rdp.resolution.wireName)
                "rdpQuality" -> JsonPrimitive(connection.rdp.quality.wireName)
                "rdpFps" -> JsonPrimitive(connection.rdp.fps.value)
                "rdpTouchMode" -> JsonPrimitive(connection.rdp.touchMode.wireName)
                "rdpTouchSensitivity" -> JsonPrimitive(connection.rdp.touchSensitivity)
                "rdpDomain" -> JsonPrimitive(connection.rdp.domain)
                "encoding" -> JsonPrimitive(connection.encoding.wireName)
                "visibility" -> JsonPrimitive(connection.visibility)
                else -> null
            }
            if (element != null) values[field] = element
        }
        return JsonObject(values)
    }
}

internal object JsonArrays {
    fun of(values: List<String>): kotlinx.serialization.json.JsonArray =
        kotlinx.serialization.json.JsonArray(values.map(::JsonPrimitive))
}

internal object EntityRegistrySupport {
    fun opaqueFields(entityType: String): List<String> =
        one.zephyr.mobile.contracts.EntityRegistry.byType[entityType]?.opaquePreserveFields ?: emptyList()
}
