package one.zephyr.mobile.feature.connections

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import one.zephyr.mobile.data.repository.SharedResourceSummary
import one.zephyr.mobile.model.Connection
import one.zephyr.mobile.model.Protocol
import one.zephyr.mobile.model.Residency

/**
 * Device-local favourites.
 *
 * A favourite is a per-device preference, not account data: the frozen entity registry has no
 * favourite field on connection, so pushing one would be inventing a contract. Stored through
 * SettingsRepository's preference table, which never enters a fieldMask.
 */
object FavouriteConnections {

    const val PREFERENCE_KEY = "one.connections.favourites"

    fun decode(value: JsonObject?): Set<String> {
        val ids = value?.get("ids") ?: return emptySet()
        return runCatching {
            ids.jsonArray.mapNotNull { it.jsonPrimitive.content.takeIf(String::isNotBlank) }.toSet()
        }.getOrDefault(emptySet())
    }

    fun encode(ids: Set<String>): JsonObject =
        JsonObject(mapOf("ids" to JsonArray(ids.sorted().map(::JsonPrimitive))))

    fun toggled(ids: Set<String>, connectionId: String): Set<String> =
        if (connectionId in ids) ids - connectionId else ids + connectionId
}

/**
 * Shared-to-me rows for the S10 list.
 *
 * Shared resources have no mirror row, so they arrive as an in-memory summary and are projected onto
 * [Connection] purely so one list can render both origins with one card. The projection deliberately
 * leaves [Connection.host] empty: SHARED_RESOURCE_RESIDENCY.md 2 forbids storing the endpoint of a
 * shared resource on this device, and the card shows the owner disclosure line instead of an
 * endpoint. A screen that rendered host:port for a shared row would be displaying data One is not
 * allowed to have.
 */
object SharedConnectionRows {

    fun isConnection(summary: SharedResourceSummary): Boolean =
        summary.resourceType == Connection.ENTITY_TYPE

    fun toDisplayRow(summary: SharedResourceSummary, ownerUserId: String): Connection? {
        val protocol = Protocol.fromWire(summary.protocol) ?: return null
        return Connection(
            id = summary.resourceId,
            // The bound account is not the owner; the owner label is carried separately because the
            // owner's user id is not something One is told.
            ownerUserId = ownerUserId,
            protocol = protocol,
            name = summary.displayName,
            host = "",
            port = protocol.defaultPort,
            residency = Residency.SHARED_ONLINE_ONLY,
            capabilities = summary.capabilities,
            sharedOwnerLabel = summary.ownerLabel,
            sharedUsePolicy = summary.usePolicy,
            grantExpiresAt = summary.grantExpiresAt,
        )
    }

    fun rowsFrom(summaries: List<SharedResourceSummary>, ownerUserId: String): List<Connection> =
        summaries.filter(::isConnection).mapNotNull { toDisplayRow(it, ownerUserId) }
}
