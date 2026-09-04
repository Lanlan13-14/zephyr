package one.zephyr.mobile.data

import java.text.Normalizer
import java.util.Locale
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import one.zephyr.mobile.contracts.EntityRegistry

enum class SecretPayloadFailure {
    RAW_SECRET_FIELD,
    INVALID_PRESENCE,
    INVALID_EDITABLE_PATH,
    PAYLOAD_TOO_LARGE,
    PAYLOAD_TOO_DEEP,
}

/** The message is deliberately constant so hostile payload keys and values never reach a log. */
class SecretPayloadViolationException(
    val failure: SecretPayloadFailure,
) : IllegalArgumentException("unsafe inbound secret payload")

/**
 * Fail-closed residency validation for untrusted server JSON.
 *
 * Secret plaintext has exactly one wire representation: a device envelope outside the payload.
 * Payloads may contain only the registry-derived, root-level boolean presence flags. This boundary
 * is shared by change pages, bootstrap staging and conflict persistence so no alternate inbound
 * path can place a raw credential in Room, FTS, a diagnostic string or a later backup.
 */
object SecretPayloadSanitizer {

    const val MAX_BYTES: Int = 2 * 1024 * 1024
    const val MAX_DEPTH: Int = 16

    /** Returns [payload] after validation so callers cannot accidentally persist an unchecked copy. */
    fun requireSafe(entityType: String, payload: JsonObject): JsonObject {
        val spec = EntityRegistry.require(entityType)
        val secretNames = spec.secretFields.mapTo(hashSetOf(), ::normalizeKey)
        val presenceNames = spec.secretFields.associate { field ->
            normalizeKey(presenceFlag(field)) to presenceFlag(field)
        }
        var bytes = 0L

        fun addBytes(amount: Int) {
            bytes += amount
            if (bytes > MAX_BYTES) fail(SecretPayloadFailure.PAYLOAD_TOO_LARGE)
        }

        fun visit(value: JsonElement, depth: Int, root: Boolean = false) {
            if (depth > MAX_DEPTH) fail(SecretPayloadFailure.PAYLOAD_TOO_DEEP)
            when (value) {
                is JsonObject -> {
                    addBytes(2)
                    value.entries.forEachIndexed { index, (key, child) ->
                        if (index != 0) addBytes(1)
                        addBytes(jsonStringBytes(key))
                        addBytes(1)

                        val normalized = normalizeKey(key)
                        val canonicalPresence = presenceNames[normalized]
                        if (canonicalPresence != null) {
                            if (!root || key != canonicalPresence || EntityCodec.booleanOrNull(child) == null) {
                                fail(SecretPayloadFailure.INVALID_PRESENCE)
                            }
                        } else if (normalized in secretNames || isSecretAlias(normalized)) {
                            fail(SecretPayloadFailure.RAW_SECRET_FIELD)
                        }
                        visit(child, depth + 1)
                    }
                }

                is JsonArray -> {
                    addBytes(2)
                    value.forEachIndexed { index, child ->
                        if (index != 0) addBytes(1)
                        visit(child, depth + 1)
                    }
                }

                JsonNull -> addBytes(4)

                is JsonPrimitive -> addBytes(
                    if (value.isString) jsonStringBytes(value.content) else utf8Bytes(value.content),
                )
            }
        }

        visit(payload, depth = 0, root = true)
        return payload
    }

    /**
     * Removes credentials left by an older client before a pre-existing row is merged or promoted.
     * Untrusted inbound payloads still use [requireSafe] and are rejected rather than repaired.
     */
    fun sanitizeForStorage(entityType: String, payload: JsonObject): JsonObject {
        val spec = EntityRegistry.require(entityType)
        val secretNames = spec.secretFields.mapTo(hashSetOf(), ::normalizeKey)
        val presenceNames = spec.secretFields.associate { field ->
            normalizeKey(presenceFlag(field)) to presenceFlag(field)
        }

        fun scrub(value: JsonElement, root: Boolean = false): JsonElement = when (value) {
            is JsonObject -> JsonObject(
                buildMap {
                    for ((key, child) in value) {
                        val normalized = normalizeKey(key)
                        val canonicalPresence = presenceNames[normalized]
                        when {
                            canonicalPresence != null && root && key == canonicalPresence -> {
                                val flag = EntityCodec.booleanOrNull(child)
                                if (flag != null) put(key, JsonPrimitive(flag))
                            }
                            canonicalPresence != null -> Unit
                            normalized in secretNames || isSecretAlias(normalized) -> Unit
                            else -> put(key, scrub(child))
                        }
                    }
                },
            )

            is JsonArray -> JsonArray(value.map { child -> scrub(child) })
            else -> value
        }

        val sanitized = scrub(payload, root = true) as JsonObject
        return requireSafe(entityType, sanitized)
    }

    /**
     * Copies a local edit through the registry's exact editable paths.
     *
     * A JsonObject is immutable at the API level but can wrap a caller-owned Map. Rebuilding every
     * container here is Kotlin's equivalent of copying into a null-prototype object: no hidden
     * input entries or mutable backing maps survive into a Room payload.
     */
    fun sanitizeLocalEditableValues(
        entityType: String,
        values: JsonObject,
        acceptedMask: List<String>,
    ): JsonObject {
        requireSafe(entityType, values)
        val spec = EntityRegistry.require(entityType)
        val editable = spec.editableFields.toSet()
        val copied = copyLocalValue(values) as JsonObject
        val projected = LinkedHashMap<String, JsonElement>()
        for (field in acceptedMask) {
            val path = editablePath(field, editable)
            valueAtPath(copied, path)?.let { putAtPath(projected, path, it) }
        }
        return JsonObject(projected)
    }

    /** Applies exact local edit paths without replacing unmasked siblings in a nested settings object. */
    fun mergeLocalEditableValues(
        entityType: String,
        stored: JsonObject,
        editableValues: JsonObject,
        acceptedMask: List<String>,
    ): JsonObject {
        val editable = EntityRegistry.require(entityType).editableFields.toSet()
        val merged = LinkedHashMap<String, JsonElement>(stored)
        for (field in acceptedMask) {
            val path = editablePath(field, editable)
            replaceAtPath(merged, path, valueAtPath(editableValues, path))
        }
        return JsonObject(merged)
    }

    private fun copyLocalValue(value: JsonElement): JsonElement = when (value) {
        is JsonObject -> JsonObject(
            LinkedHashMap<String, JsonElement>(value.size).also { copy ->
                for ((key, child) in value) {
                    if (isLocalSecretKey(normalizeKey(key))) {
                        fail(SecretPayloadFailure.RAW_SECRET_FIELD)
                    }
                    copy[key] = copyLocalValue(child)
                }
            },
        )

        is JsonArray -> JsonArray(value.map(::copyLocalValue))
        else -> value
    }

    private fun editablePath(field: String, editable: Set<String>): List<String> = when {
        field in editable -> field.split('.')
        else -> fail(SecretPayloadFailure.INVALID_EDITABLE_PATH)
    }

    private fun valueAtPath(value: JsonObject, path: List<String>): JsonElement? {
        var current: JsonElement = value
        for (segment in path) {
            current = (current as? JsonObject)?.get(segment) ?: return null
        }
        return current
    }

    private fun putAtPath(
        destination: MutableMap<String, JsonElement>,
        path: List<String>,
        value: JsonElement,
    ) {
        val segment = path.first()
        if (path.size == 1) {
            destination[segment] = value
            return
        }
        val nested = (destination[segment] as? JsonObject)?.let { LinkedHashMap(it) } ?: LinkedHashMap()
        putAtPath(nested, path.drop(1), value)
        destination[segment] = JsonObject(nested)
    }

    private fun replaceAtPath(
        destination: MutableMap<String, JsonElement>,
        path: List<String>,
        replacement: JsonElement?,
    ) {
        val segment = path.first()
        if (path.size == 1) {
            if (replacement == null) destination.remove(segment) else destination[segment] = replacement
            return
        }
        val nested = (destination[segment] as? JsonObject)?.let { LinkedHashMap(it) } ?: LinkedHashMap()
        replaceAtPath(nested, path.drop(1), replacement)
        if (nested.isEmpty()) destination.remove(segment) else destination[segment] = JsonObject(nested)
    }

    private fun isSecretAlias(normalized: String): Boolean =
        normalized in EXACT_SECRET_ALIASES || SECRET_MARKERS.any(normalized::contains)

    /** Local writes may not forge server presence metadata; SecretState is its only source. */
    private fun isLocalSecretKey(normalized: String): Boolean =
        isSecretAlias(normalized) || normalized in PRESENCE_ALIASES

    private fun normalizeKey(value: String): String = buildString(value.length) {
        for (character in Normalizer.normalize(value, Normalizer.Form.NFKC).lowercase(Locale.ROOT)) {
            if (character.isLetterOrDigit()) append(character)
        }
    }

    private fun jsonStringBytes(value: String): Int {
        var bytes = 2
        var index = 0
        while (index < value.length) {
            val character = value[index]
            bytes += when {
                character == '"' || character == '\\' || character == '\b' ||
                    character == '\u000C' || character == '\n' || character == '\r' ||
                    character == '\t' -> 2
                character.code <= 0x1f -> 6
                character.code <= 0x7f -> 1
                character.code <= 0x7ff -> 2
                character.isHighSurrogate() && index + 1 < value.length &&
                    value[index + 1].isLowSurrogate() -> {
                    index += 1
                    4
                }
                else -> 3
            }
            index += 1
        }
        return bytes
    }

    private fun utf8Bytes(value: String): Int = value.toByteArray(Charsets.UTF_8).size

    private fun fail(failure: SecretPayloadFailure): Nothing =
        throw SecretPayloadViolationException(failure)

    private val EXACT_SECRET_ALIASES = setOf(
        "authorization",
        "bearer",
        "clientcredential",
        "clientcredentials",
        "clientsecret",
        "credential",
        "credentials",
        "password",
        "passwd",
        "privatekey",
        "pwd",
        "secret",
        "secretkey",
        "secretenvelope",
        "secretenvelopes",
    )

    private val SECRET_MARKERS = listOf(
        "password",
        "passwd",
        "privatekey",
        "apikey",
        "accesstoken",
        "refreshtoken",
        "authtoken",
        "bearertoken",
        "clientsecret",
        "secret",
        "token",
        "secretkey",
        "envelope",
        "presence",
        "authorization",
        "bearer",
    )

    private val PRESENCE_ALIASES = setOf("presence", "haspresence")
}
