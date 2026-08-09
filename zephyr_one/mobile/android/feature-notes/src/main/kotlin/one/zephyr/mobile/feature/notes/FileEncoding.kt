package one.zephyr.mobile.feature.notes

import java.nio.charset.Charset

/**
 * Text encoding for the S31 preview and editor.
 *
 * Encoding is one of the frozen S31 states (SCREEN_CATALOG.md 12), so it is a first-class choice
 * rather than an assumption: a GBK log opened as UTF-8 is unreadable, and silently substituting
 * replacement characters and then saving would corrupt the file on the server.
 *
 * This is separate from core-model's TerminalEncoding on purpose. That enum is a *connection* field
 * with a wire name the server understands; this one is a per-file view choice that never leaves the
 * device, and its constant names are JVM charset names rather than Zephyr wire names.
 */
enum class FileEncoding(val charsetName: String, val label: String) {
    UTF8("UTF-8", "UTF-8"),
    GBK("GBK", "GBK"),
    BIG5("Big5", "Big5"),
    SHIFT_JIS("Shift_JIS", "Shift_JIS"),
    LATIN1("ISO-8859-1", "Latin-1"),
    ;

    /**
     * Resolved once and cached. A device without a legacy code page must not crash the editor, so an
     * unavailable charset falls back to UTF-8; [isAvailable] lets the UI say so instead of silently
     * showing mojibake the user cannot explain.
     */
    val charset: Charset by lazy { runCatching { Charset.forName(charsetName) }.getOrDefault(Charsets.UTF_8) }

    val isAvailable: Boolean get() = charset.name().equals(charsetName, ignoreCase = true) || this == UTF8

    fun decode(bytes: ByteArray): String = String(bytes, charset)

    fun encode(text: String): ByteArray = text.toByteArray(charset)

    companion object {
        val default = UTF8

        /**
         * Heuristic first guess, used only to pick the initial selection.
         *
         * Strictly UTF-8-or-not: a valid UTF-8 decode is overwhelmingly likely to be UTF-8, while
         * guessing *which* legacy code page a byte stream is would be a coin flip that silently
         * mangles text. Anything that is not valid UTF-8 is left for the user to choose, which is
         * why the editor always shows the encoding control.
         */
        fun guess(bytes: ByteArray): FileEncoding = if (isValidUtf8(bytes)) UTF8 else GBK

        /** Full UTF-8 well-formedness check, including surrogate and overlong rejection. */
        fun isValidUtf8(bytes: ByteArray): Boolean {
            var index = 0
            while (index < bytes.size) {
                val first = bytes[index].toInt() and 0xff
                val extra = when {
                    first <= 0x7f -> 0
                    first in 0xc2..0xdf -> 1
                    first in 0xe0..0xef -> 2
                    first in 0xf0..0xf4 -> 3
                    else -> return false
                }
                if (index + extra >= bytes.size) return false
                for (offset in 1..extra) {
                    val continuation = bytes[index + offset].toInt() and 0xff
                    if (continuation < 0x80 || continuation > 0xbf) return false
                }
                // Surrogates and out-of-range planes are structurally valid but not legal UTF-8.
                if (extra == 2) {
                    val second = bytes[index + 1].toInt() and 0xff
                    if (first == 0xe0 && second < 0xa0) return false
                    if (first == 0xed && second > 0x9f) return false
                }
                if (extra == 3) {
                    val second = bytes[index + 1].toInt() and 0xff
                    if (first == 0xf0 && second < 0x90) return false
                    if (first == 0xf4 && second > 0x8f) return false
                }
                index += extra + 1
            }
            return true
        }

        /** True when the buffer holds a NUL, which means it is not text and must not be edited. */
        fun looksBinary(bytes: ByteArray): Boolean = bytes.any { it.toInt() == 0 }
    }
}
