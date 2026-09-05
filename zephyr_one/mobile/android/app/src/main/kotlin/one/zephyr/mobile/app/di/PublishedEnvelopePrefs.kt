package one.zephyr.mobile.app.di

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import one.zephyr.mobile.data.EntityCodec
import one.zephyr.mobile.model.Base64Codec

/**
 * Wire form for the published envelope identity rows in `device_preferences`.
 *
 * That table is observed as a map of JSON objects (language, theme, app lock).
 * A bare `srv-...` string is not an object: kotlinx.serialization throws, Compose
 * collection of [one.zephyr.mobile.data.repository.SettingsRepository.observePreferences]
 * crashes the process the moment capabilities persist. Store `{"value":...}` and
 * still read the pre56 crash-write so a device that already died on first sync
 * can open envelopes after the upgrade.
 */
internal object PublishedEnvelopePrefs {

    fun encodeServerId(id: String): String =
        EntityCodec.encode(JsonObject(mapOf("value" to JsonPrimitive(id))))

    fun decodeServerId(raw: String?): String {
        val text = raw?.trim().orEmpty()
        if (text.isEmpty()) return ""
        runCatching { EntityCodec.parse(text) }.getOrNull()?.let { obj ->
            return EntityCodec.string(obj, "value").orEmpty()
        }
        if (text.startsWith("{") || text.startsWith("[")) return ""
        return text
    }

    fun encodeServerKey(keyVersion: Int, publicKey: ByteArray): String =
        EntityCodec.encode(
            JsonObject(
                mapOf(
                    "keyVersion" to JsonPrimitive(keyVersion),
                    "publicKey" to JsonPrimitive(Base64Codec.encode(publicKey)),
                ),
            ),
        )

    fun decodeServerKey(raw: String?): Pair<Int, ByteArray>? {
        val text = raw?.trim().orEmpty()
        if (text.isEmpty()) return null
        runCatching { EntityCodec.parse(text) }.getOrNull()?.let { obj ->
            val version = EntityCodec.intOrNull(obj, "keyVersion") ?: return null
            val encoded = EntityCodec.string(obj, "publicKey") ?: return null
            val publicKey = runCatching { Base64Codec.decode(encoded) }.getOrNull() ?: return null
            return if (version > 0 && publicKey.isNotEmpty()) version to publicKey else null
        }
        val parts = text.split(':', limit = 2)
        val version = parts.getOrNull(0)?.toIntOrNull() ?: return null
        val publicKey = parts.getOrNull(1)?.let { encoded ->
            runCatching { Base64Codec.decode(encoded) }.getOrNull()
        } ?: return null
        return if (version > 0 && publicKey.isNotEmpty()) version to publicKey else null
    }
}
