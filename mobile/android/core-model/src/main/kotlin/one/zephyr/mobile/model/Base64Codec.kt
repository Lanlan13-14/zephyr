package one.zephyr.mobile.model

/**
 * Base64 for wire payloads.
 *
 * DATA_AND_MIGRATION.md 5.2 freezes envelope fields as padded standard Base64, so this wraps
 * java.util.Base64 (available since API 26, our minSdk) rather than android.util.Base64. The JVM
 * codec keeps the crypto layer testable in plain unit tests, where android.util.Base64 is an
 * unimplemented stub.
 */
object Base64Codec {

    /** Padded, single-line standard alphabet. This is the frozen wire form. */
    fun encode(bytes: ByteArray): String = java.util.Base64.getEncoder().encodeToString(bytes)

    /**
     * Accepts the standard alphabet and tolerates URL-safe characters and missing padding, because
     * rejecting a structurally fine envelope on an alphabet detail would look like tampering.
     */
    fun decode(value: String): ByteArray {
        val normalized = value.trim().replace('-', '+').replace('_', '/')
        val padded = when (normalized.length % 4) {
            0 -> normalized
            2 -> normalized + "=="
            3 -> normalized + "="
            else -> throw IllegalArgumentException("invalid base64 length")
        }
        return java.util.Base64.getDecoder().decode(padded)
    }

    /** Used for filesystem-safe names, never for wire payloads. */
    fun encodeUrlNoPad(bytes: ByteArray): String =
        java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

    fun decodeUrlNoPad(value: String): ByteArray =
        java.util.Base64.getUrlDecoder().decode(value)
}
