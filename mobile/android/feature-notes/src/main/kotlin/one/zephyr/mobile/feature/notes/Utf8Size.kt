package one.zephyr.mobile.feature.notes

/**
 * UTF-8 byte length without allocating the encoded array.
 *
 * The 1 MiB body limit (SCREEN_CATALOG.md 13) has to be checked on every keystroke. Doing it with
 * String.toByteArray would allocate a fresh megabyte per character typed, which is exactly the kind
 * of editor stall a large note would hit. The surrogate handling mirrors what the JDK encoder
 * actually does, including replacing an unpaired surrogate with a single '?' byte, so this never
 * disagrees with NoteRepository.validate's authoritative check.
 */
object Utf8Size {

    fun of(text: String): Int {
        var bytes = 0
        var index = 0
        while (index < text.length) {
            val char = text[index]
            when {
                char.code < 0x80 -> bytes += 1
                char.code < 0x800 -> bytes += 2
                Character.isHighSurrogate(char) &&
                    index + 1 < text.length &&
                    Character.isLowSurrogate(text[index + 1]) -> {
                    bytes += 4
                    index += 1
                }
                // Unpaired surrogate: the encoder emits one replacement byte rather than three.
                Character.isSurrogate(char) -> bytes += 1
                else -> bytes += 3
            }
            index += 1
        }
        return bytes
    }
}
