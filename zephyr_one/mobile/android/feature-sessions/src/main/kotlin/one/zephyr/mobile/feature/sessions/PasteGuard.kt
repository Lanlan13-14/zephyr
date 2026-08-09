package one.zephyr.mobile.feature.sessions

/**
 * What a paste should do.
 *
 * TERMINAL_EXPERIENCE.md 4.3 requires a preview for multi-line or large pastes, and an option to
 * paste without the trailing newline. Both exist because a blind paste into a shell executes
 * whatever the clipboard happened to hold.
 */
sealed interface PasteDecision {
    /** Small single-line text: send immediately. */
    data class Immediate(val bytes: ByteArray) : PasteDecision {
        override fun equals(other: Any?): Boolean =
            other is Immediate && bytes.contentEquals(other.bytes)

        override fun hashCode(): Int = bytes.contentHashCode()
    }

    /**
     * Needs confirmation first.
     *
     * @param lineCount shown to the user, because "3 行" is the information that makes the risk
     *   obvious in a way a character count does not.
     */
    data class NeedsConfirmation(
        val text: String,
        val lineCount: Int,
        val byteCount: Int,
        val endsWithNewline: Boolean,
    ) : PasteDecision
}

/**
 * Clipboard-to-PTY policy.
 *
 * Pure so the whole matrix (bracketed/not, multiline/not, over/under the threshold, trailing
 * newline kept or dropped) is unit testable. The clipboard read itself stays in the UI layer
 * because the spec allows it only in response to a user action.
 */
object PasteGuard {

    /** Frozen threshold from TERMINAL_EXPERIENCE.md 4.3. */
    const val CONFIRM_BYTES = 4 * 1024

    const val BRACKET_START = "\u001b[200~"
    const val BRACKET_END = "\u001b[201~"

    fun needsConfirmation(text: String): Boolean =
        text.contains('\n') || text.contains('\r') || text.toByteArray(Charsets.UTF_8).size > CONFIRM_BYTES

    fun decide(text: String, bracketed: Boolean, encoding: TerminalCharset = TerminalCharset.UTF8): PasteDecision =
        if (needsConfirmation(text)) {
            PasteDecision.NeedsConfirmation(
                text = text,
                lineCount = lineCount(text),
                byteCount = text.toByteArray(Charsets.UTF_8).size,
                endsWithNewline = text.endsWith("\n") || text.endsWith("\r"),
            )
        } else {
            PasteDecision.Immediate(encode(text, bracketed, encoding))
        }

    /**
     * The bytes for a confirmed paste.
     *
     * @param keepTrailingNewline false implements "粘贴但不执行最后换行": the text lands on the prompt
     *   without running, which is the whole point of the option.
     */
    fun confirmed(
        text: String,
        bracketed: Boolean,
        keepTrailingNewline: Boolean,
        encoding: TerminalCharset = TerminalCharset.UTF8,
    ): ByteArray {
        val body = if (keepTrailingNewline) text else text.trimEnd('\n', '\r')
        return encode(body, bracketed, encoding)
    }

    /**
     * Bracketed paste wrapping.
     *
     * The markers are ASCII control sequences and are deliberately encoded as Latin-1 rather than
     * through [encoding]: under GBK or Big5 a multi-byte encoder could otherwise mangle them.
     */
    private fun encode(text: String, bracketed: Boolean, encoding: TerminalCharset): ByteArray {
        val body = encoding.encode(text)
        if (!bracketed) return body
        return BRACKET_START.toByteArray(Charsets.ISO_8859_1) + body + BRACKET_END.toByteArray(Charsets.ISO_8859_1)
    }

    private fun lineCount(text: String): Int {
        if (text.isEmpty()) return 0
        return text.split('\n').size
    }
}
