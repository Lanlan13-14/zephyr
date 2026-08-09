package one.zephyr.mobile.protocol.zft2

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull

/**
 * Tolerant readers for frame metadata.
 *
 * The peer is JavaScript, where every number is a double and `3` may arrive as `3` or `3.0`, and
 * the Go WASM client has been observed sending numeric fields as strings. Reading through these
 * helpers rather than `jsonPrimitive.long` means a benign representation difference produces a
 * correct value instead of a `bad_metadata` rejection mid-transfer, while a genuinely absent
 * required field still fails loudly.
 */
internal fun JsonObject.stringOrNull(key: String): String? =
    (this[key] as? JsonPrimitive)?.contentOrNullIfJsonNull()

internal fun JsonObject.requireString(key: String): String =
    stringOrNull(key)?.takeIf { it.isNotEmpty() }
        ?: throw Zft2Exception("invalid_argument", "Missing required field " + key)

internal fun JsonObject.longOr(key: String, fallback: Long): Long {
    val primitive = this[key] as? JsonPrimitive ?: return fallback
    primitive.longOrNull?.let { return it }
    // A JS float that happens to hold an integral value, e.g. offset 4.0.
    primitive.doubleOrNull?.let { if (it >= Long.MIN_VALUE.toDouble() && it <= Long.MAX_VALUE.toDouble()) return it.toLong() }
    return primitive.content.toLongOrNull() ?: fallback
}

internal fun JsonObject.intOr(key: String, fallback: Int): Int {
    val value = longOr(key, fallback.toLong())
    return value.coerceIn(Int.MIN_VALUE.toLong(), Int.MAX_VALUE.toLong()).toInt()
}

internal fun JsonObject.booleanOr(key: String, fallback: Boolean): Boolean {
    val primitive = this[key] as? JsonPrimitive ?: return fallback
    primitive.booleanOrNull?.let { return it }
    return when (primitive.content) {
        "true", "1" -> true
        "false", "0" -> false
        else -> fallback
    }
}

private fun JsonPrimitive.contentOrNullIfJsonNull(): String? =
    if (this is JsonNull) null else content
