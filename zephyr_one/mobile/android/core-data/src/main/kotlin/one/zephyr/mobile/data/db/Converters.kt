package one.zephyr.mobile.data.db

import androidx.room.TypeConverter
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

/**
 * Room converters.
 *
 * Lists and payloads are stored as JSON text rather than in child tables because the entity
 * registry is data-driven: DATA_AND_MIGRATION.md 4 defines twenty entity types that share one
 * lifecycle, so one mirror table with a JSON payload stays in step with the registry instead of
 * needing a schema migration whenever the main end adds a field.
 */
object Converters {

    /**
     * ignoreUnknownKeys is required, not convenience: opaquePreserve fields must survive a round
     * trip even when this client version has never heard of them.
     */
    val json: Json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    private val stringListSerializer = ListSerializer(String.serializer())

    @TypeConverter
    fun stringListToText(value: List<String>?): String =
        json.encodeToString(stringListSerializer, value ?: emptyList())

    @TypeConverter
    fun textToStringList(value: String?): List<String> =
        if (value.isNullOrEmpty()) emptyList() else json.decodeFromString(stringListSerializer, value)

    @TypeConverter
    fun jsonObjectToText(value: JsonObject?): String =
        json.encodeToString(JsonObject.serializer(), value ?: JsonObject(emptyMap()))

    @TypeConverter
    fun textToJsonObject(value: String?): JsonObject =
        if (value.isNullOrEmpty()) JsonObject(emptyMap()) else json.decodeFromString(JsonObject.serializer(), value)
}
