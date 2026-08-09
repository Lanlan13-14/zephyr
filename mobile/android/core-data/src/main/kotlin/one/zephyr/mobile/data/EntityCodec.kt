package one.zephyr.mobile.data

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import one.zephyr.mobile.contracts.EntityRegistry
import one.zephyr.mobile.data.db.Converters
import one.zephyr.mobile.model.SecretPresence

/**
 * Payload access helpers.
 *
 * The mirror stores the full server payload as JSON so opaquePreserve fields survive a round trip
 * untouched (DATA_AND_MIGRATION.md 3.3). Typed models are projected out of that JSON here rather
 * than by deserialising into a data class, because deserialising would silently drop any field this
 * app version does not know about and the next push would erase it on the server.
 */
object EntityCodec {

    fun parse(payloadJson: String): JsonObject = Converters.textToJsonObject(payloadJson)

    fun encode(payload: JsonObject): String = Converters.jsonObjectToText(payload)

    fun string(payload: JsonObject, key: String): String? =
        (payload[key] as? JsonPrimitive)?.takeIf { it.isString || it.contentOrNull != null }?.contentOrNull

    fun text(payload: JsonObject, key: String, fallback: String = ""): String = string(payload, key) ?: fallback

    fun int(payload: JsonObject, key: String, fallback: Int): Int =
        (payload[key] as? JsonPrimitive)?.intOrNull ?: fallback

    fun intOrNull(payload: JsonObject, key: String): Int? = (payload[key] as? JsonPrimitive)?.intOrNull

    fun long(payload: JsonObject, key: String, fallback: Long): Long =
        (payload[key] as? JsonPrimitive)?.longOrNull ?: fallback

    fun longOrNull(payload: JsonObject, key: String): Long? = (payload[key] as? JsonPrimitive)?.longOrNull

    fun bool(payload: JsonObject, key: String, fallback: Boolean): Boolean =
        (payload[key] as? JsonPrimitive)?.booleanOrNull ?: fallback

    fun float(payload: JsonObject, key: String, fallback: Float): Float =
        (payload[key] as? JsonPrimitive)?.doubleOrNull?.toFloat() ?: fallback

    fun stringList(payload: JsonObject, key: String): List<String> =
        (payload[key] as? kotlinx.serialization.json.JsonArray)
            ?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
            ?: emptyList()

    /**
     * Presence flags for secret fields.
     *
     * The main end sends hasPassword/hasPrivateKey style booleans, never the value, so list and
     * editor screens can render "已设置" without a secret ever entering the payload.
     */
    fun secretPresence(entityType: String, payload: JsonObject): Map<String, SecretPresence> {
        val spec = EntityRegistry.byType[entityType] ?: return emptyMap()
        return spec.secretFields.associateWith { field ->
            val flag = "has" + field.replaceFirstChar { it.uppercaseChar() }
            SecretPresence(hasValue = bool(payload, flag, false))
        }
    }

    /**
     * Merge an edited subset into the stored payload.
     *
     * Only the keys named in [mask] are replaced; everything else, including fields this client
     * cannot interpret, is copied through unchanged.
     */
    fun merge(stored: JsonObject, edited: JsonObject, mask: List<String>): JsonObject {
        val roots = mask.map { one.zephyr.mobile.model.sync.FieldMask.rootOf(it) }.toSet()
        val merged = LinkedHashMap<String, JsonElement>(stored)
        for (root in roots) {
            val value = edited[root]
            if (value == null) merged.remove(root) else merged[root] = value
        }
        return JsonObject(merged)
    }

    /**
     * Sort key used by the mirror's list queries. Notes carry an explicit sortOrder; everything
     * else falls back to a case-insensitive name so list order is stable across devices.
     */
    fun sortKeyFor(entityType: String, payload: JsonObject): String = when (entityType) {
        "note" -> String.format("%012d", long(payload, "sortOrder", 0L)) + "|" + text(payload, "title").lowercase()
        "activityEvent" -> String.format("%013d", Long.MAX_VALUE - long(payload, "time", 0L))
        else -> (string(payload, "name") ?: string(payload, "title") ?: "").lowercase()
    }

    /** Title and body fed to FTS. Only owned rows reach this function. */
    fun searchText(entityType: String, payload: JsonObject): Pair<String, String>? = when (entityType) {
        "note" -> text(payload, "title") to text(payload, "content")
        "connection" -> text(payload, "name") to
            listOf(text(payload, "host"), text(payload, "username"), text(payload, "remark"))
                .filter { it.isNotEmpty() }
                .joinToString(" ")
        "snippet" -> text(payload, "name") to text(payload, "command")
        else -> null
    }
}
