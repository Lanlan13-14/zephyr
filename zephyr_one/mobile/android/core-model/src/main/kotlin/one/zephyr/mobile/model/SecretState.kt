package one.zephyr.mobile.model

import java.nio.CharBuffer

/**
 * Secret editing is an explicit tri-state (ZEPHYR_PARITY.md 5.3). A masked placeholder is never
 * a new secret, so "unchanged" must be representable and must never reach a fieldMask.
 */
sealed interface SecretState {
    /** Keep whatever the server already holds. Produces no fieldMask entry. */
    data object Unchanged : SecretState

    /**
     * Replace with a new plaintext value, which is enveloped before it leaves the device.
     *
     * A mutable character buffer is intentional: editor success, cancel, lock and disposal can
     * overwrite it. The type is not a data class because generated toString would disclose it.
     */
    class Replace(plaintext: String) : SecretState {
        private val characters: CharArray = plaintext.toCharArray()

        val isBlank: Boolean get() = characters.all(Char::isWhitespace)

        /** Compose requires a String-backed text field; callers must not retain this copy. */
        fun editingText(): String = String(characters)

        /** Encodes without first constructing another immutable plaintext String. */
        fun <T> withUtf8Bytes(block: (ByteArray) -> T): T {
            val encoded = Charsets.UTF_8.newEncoder().encode(CharBuffer.wrap(characters))
            val bytes = ByteArray(encoded.remaining())
            encoded.get(bytes)
            return try {
                block(bytes)
            } finally {
                bytes.fill(0)
                if (encoded.hasArray()) encoded.array().fill(0)
            }
        }

        fun wipe() {
            characters.fill(NUL)
        }

        fun isWiped(): Boolean = characters.all { it == NUL }

        override fun equals(other: Any?): Boolean =
            other is Replace && characters.contentEquals(other.characters)

        override fun hashCode(): Int = characters.contentHashCode()

        override fun toString(): String = "Replace(plaintext=[redacted])"

        private companion object {
            const val NUL = '\u0000'
        }
    }

    /** Explicitly clear the stored secret. */
    data object Clear : SecretState

    val contributesToFieldMask: Boolean
        get() = this !is Unchanged
}

/** Best-effort overwrite for state leaving a form or being superseded by another edit. */
fun SecretState.wipePlaintext() {
    if (this is SecretState.Replace) wipe()
}

/**
 * List payloads only ever carry presence, never the secret. Mirrors Zephyr's hasX/masked contract.
 */
data class SecretPresence(
    val hasValue: Boolean,
    val secretRef: String? = null,
) {
    companion object {
        val absent = SecretPresence(hasValue = false)
        const val MASK = "******"
    }
}

/** The three logical coordinates of one local secret. */
data class SecretRefParts(
    val entityType: String,
    val entityId: String,
    val fieldName: String,
)

/**
 * A reference into the local SecretStore. Business rows never hold ciphertext directly.
 *
 * New refs use length-prefixed components. Entity ids are server-controlled and may contain `/`,
 * so delimiter-only refs cannot safely distinguish `abc` from `abc/child` during entity purges.
 * [partsOrNull] still understands the historical slash form so an installed app can migrate it.
 */
@JvmInline
value class SecretRef(val value: String) {

    fun partsOrNull(): SecretRefParts? =
        if (value.startsWith(V2_PREFIX)) parseV2(value) else parseLegacy(value)

    /** Converts a parseable legacy ref to the unambiguous current representation. */
    fun canonical(): SecretRef {
        if (value.startsWith(V2_PREFIX)) return this
        val parts = partsOrNull() ?: return this
        return of(parts.entityType, parts.entityId, parts.fieldName)
    }

    /** Historical representation, used only while locating an old encrypted blob for migration. */
    fun legacyValueOrNull(): String? {
        val parts = partsOrNull() ?: return null
        return parts.entityType + "/" + parts.entityId + "/" + parts.fieldName
    }

    fun belongsTo(entityType: String, entityId: String): Boolean =
        partsOrNull()?.let { it.entityType == entityType && it.entityId == entityId } == true

    companion object {
        fun of(entityType: String, entityId: String, fieldName: String): SecretRef =
            SecretRef(
                buildString {
                    append(V2_PREFIX)
                    appendComponent(entityType)
                    appendComponent(entityId)
                    appendComponent(fieldName)
                },
            )

        private const val V2_PREFIX = "v2:"

        private fun StringBuilder.appendComponent(component: String) {
            append(component.length)
            append(':')
            append(component)
        }

        private fun parseV2(value: String): SecretRefParts? {
            var cursor = V2_PREFIX.length
            fun component(): String? {
                val colon = value.indexOf(':', cursor)
                if (colon < cursor) return null
                val lengthText = value.substring(cursor, colon)
                if (lengthText.isEmpty() || lengthText.any { !it.isDigit() }) return null
                val length = lengthText.toIntOrNull() ?: return null
                val start = colon + 1
                val end = start.toLong() + length.toLong()
                if (end > value.length.toLong()) return null
                cursor = end.toInt()
                return value.substring(start, cursor)
            }

            val entityType = component() ?: return null
            val entityId = component() ?: return null
            val fieldName = component() ?: return null
            if (cursor != value.length) return null
            return SecretRefParts(entityType, entityId, fieldName)
        }

        private fun parseLegacy(value: String): SecretRefParts? {
            val first = value.indexOf('/')
            val last = value.lastIndexOf('/')
            if (first < 0 || last <= first) return null
            return SecretRefParts(
                entityType = value.substring(0, first),
                entityId = value.substring(first + 1, last),
                fieldName = value.substring(last + 1),
            )
        }
    }
}
