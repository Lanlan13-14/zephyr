package one.zephyr.mobile.feature.sessions

import java.nio.charset.Charset
import one.zephyr.mobile.model.TerminalEncoding

/**
 * A key the terminal can receive.
 *
 * A sealed hierarchy rather than an enum because a printable character and a named key are encoded
 * by completely different rules: one goes through the session charset, the other through a fixed
 * xterm escape table. Modelling both as one enum would force every call site to carry a separate
 * code point field that is meaningless for most entries.
 */
sealed interface TerminalKey {

    /** One printable Unicode code point. Encoded with the session charset, not always UTF-8. */
    data class Character(val codePoint: Int) : TerminalKey

    /** F1..F12. Bounded here so an out-of-range key cannot reach the escape table. */
    data class Function(val index: Int) : TerminalKey {
        init {
            require(index in MIN_INDEX..MAX_INDEX) { "function key index must be " + MIN_INDEX + ".." + MAX_INDEX }
        }

        companion object {
            const val MIN_INDEX = 1
            const val MAX_INDEX = 12
        }
    }

    data object Enter : TerminalKey
    data object Backspace : TerminalKey
    data object Delete : TerminalKey
    data object Insert : TerminalKey
    data object Tab : TerminalKey
    data object Escape : TerminalKey

    data object ArrowUp : TerminalKey
    data object ArrowDown : TerminalKey
    data object ArrowLeft : TerminalKey
    data object ArrowRight : TerminalKey

    data object Home : TerminalKey
    data object End : TerminalKey
    data object PageUp : TerminalKey
    data object PageDown : TerminalKey
}

/**
 * One key press with its modifiers.
 *
 * The modifiers travel with the key rather than being read from controller state at encode time,
 * because the latch in [ModifierLatches] is consumed *after* the stroke is encoded: an encoder that
 * read live state could see a latch that the same event already cleared.
 */
data class TerminalKeyStroke(
    val key: TerminalKey,
    val ctrl: Boolean = false,
    val alt: Boolean = false,
    val shift: Boolean = false,
) {
    val hasModifier: Boolean get() = ctrl || alt || shift
}

/**
 * Byte encoding for the session.
 *
 * Telnet may negotiate a legacy code page (ZEPHYR_PARITY.md 6.2), so keyboard input cannot be
 * hard-coded to UTF-8: typing a Chinese character into a GBK session must produce GBK bytes. Escape
 * sequences are always ASCII and therefore identical in every charset here.
 */
enum class TerminalCharset(val charsetName: String) {
    UTF8("UTF-8"),
    GBK("GBK"),
    BIG5("Big5"),
    LATIN1("ISO-8859-1"),
    ;

    /**
     * Resolved lazily and cached: Charset.forName is a lookup, and the encoder runs on every
     * keystroke on the input path.
     */
    val charset: Charset by lazy {
        // A device without the legacy code page must not crash the session; falling back to UTF-8
        // is wrong for the remote host but recoverable, and the session banner already states the
        // negotiated encoding.
        runCatching { Charset.forName(charsetName) }.getOrDefault(Charsets.UTF_8)
    }

    fun encode(text: String): ByteArray = text.toByteArray(charset)

    fun decode(bytes: ByteArray): String = String(bytes, charset)

    companion object {
        /** Maps the stored connection field onto the transport charset. */
        fun of(encoding: TerminalEncoding): TerminalCharset = when (encoding) {
            TerminalEncoding.UTF8 -> UTF8
            TerminalEncoding.GBK -> GBK
            TerminalEncoding.BIG5 -> BIG5
            TerminalEncoding.LATIN1 -> LATIN1
        }
    }
}

/**
 * The canonical key encoder.
 *
 * TERMINAL_EXPERIENCE.md 3 requires exactly one owner for a key event, and 4.3 requires the software
 * shortcut matrix, the IME and a hardware keyboard to share it. Anything that produced bytes on its
 * own would be a second owner, which is precisely the failure the reverse test in section 12 injects
 * on purpose. Every function here is pure, so the whole table is checkable without a PTY.
 */
object TerminalKeyEncoder {

    const val ESC: Byte = 0x1B
    private const val ESC_CHAR = '\u001b'

    /**
     * The single entry point.
     *
     * @param modes what the emulator actually negotiated (DECCKM/DECKPAM), not a guess. vim and
     *   readline both change behaviour on these, so passing a default here would break arrows in
     *   the two programs users test first.
     */
    fun encode(
        stroke: TerminalKeyStroke,
        modes: TerminalModes = TerminalModes(),
        encoding: TerminalCharset = TerminalCharset.UTF8,
    ): ByteArray {
        val body = when (val key = stroke.key) {
            is TerminalKey.Character -> character(key.codePoint, stroke, encoding)
            is TerminalKey.Function -> functionKey(key.index, csiModifier(stroke))
            TerminalKey.Enter -> byteArrayOf(0x0D)
            // DEL rather than BS, matching xterm's default and what bash/readline expect.
            TerminalKey.Backspace -> byteArrayOf(0x7F)
            TerminalKey.Delete -> csi("3~", csiModifier(stroke))
            TerminalKey.Insert -> csi("2~", csiModifier(stroke))
            // Shift+Tab is back-tab: a distinct sequence, not a modified Tab.
            TerminalKey.Tab -> if (stroke.shift) csiRaw("Z") else byteArrayOf(0x09)
            TerminalKey.Escape -> byteArrayOf(ESC)
            TerminalKey.ArrowUp -> cursor('A', stroke, modes)
            TerminalKey.ArrowDown -> cursor('B', stroke, modes)
            TerminalKey.ArrowRight -> cursor('C', stroke, modes)
            TerminalKey.ArrowLeft -> cursor('D', stroke, modes)
            TerminalKey.Home -> edge('H', stroke, modes)
            TerminalKey.End -> edge('F', stroke, modes)
            TerminalKey.PageUp -> csi("5~", csiModifier(stroke))
            TerminalKey.PageDown -> csi("6~", csiModifier(stroke))
        }
        // Alt is an ESC prefix, never the eighth bit: setting the high bit would corrupt UTF-8 and
        // break readline's Alt+B / Alt+F (TERMINAL_EXPERIENCE.md 2.11). Named keys already carry
        // their modifiers in the CSI parameter, so only the character path needs the prefix.
        return body
    }

    /**
     * A printable code point.
     *
     * Ctrl consumes the character into a control byte where one exists; where none exists the
     * literal character is sent rather than a wrong byte, so Ctrl+1 types "1" instead of NUL.
     */
    private fun character(codePoint: Int, stroke: TerminalKeyStroke, encoding: TerminalCharset): ByteArray {
        val base = if (stroke.ctrl) {
            controlByte(codePoint)?.let { byteArrayOf(it) } ?: encoding.encode(codePointString(codePoint))
        } else {
            encoding.encode(codePointString(codePoint))
        }
        return if (stroke.alt) byteArrayOf(ESC) + base else base
    }

    /**
     * Control characters.
     *
     * The full Termux-verified set (TERMINAL_EXPERIENCE.md 2.10): Ctrl+A..Z, Ctrl+Space and Ctrl+@
     * as NUL, and the punctuation controls. Null means the combination has no control meaning.
     */
    fun controlByte(codePoint: Int): Byte? = when {
        codePoint == ' '.code || codePoint == '@'.code -> 0x00
        codePoint in 'a'.code..'z'.code -> (codePoint - 'a'.code + 1).toByte()
        codePoint in 'A'.code..'Z'.code -> (codePoint - 'A'.code + 1).toByte()
        codePoint == '['.code -> 0x1B
        codePoint == '\\'.code -> 0x1C
        codePoint == ']'.code -> 0x1D
        codePoint == '^'.code -> 0x1E
        codePoint == '_'.code -> 0x1F
        // Ctrl+/ and Ctrl+? both produce DEL, which is readline's backward-kill-word.
        codePoint == '/'.code || codePoint == '?'.code -> 0x7F
        else -> null
    }

    /**
     * xterm modifier parameter: 1 + bitmask(shift=1, alt=2, ctrl=4).
     *
     * Null when unmodified, so the caller emits the short form every terminal understands.
     */
    fun csiModifier(stroke: TerminalKeyStroke): Int? {
        if (!stroke.hasModifier) return null
        var mask = 0
        if (stroke.shift) mask = mask or 1
        if (stroke.alt) mask = mask or 2
        if (stroke.ctrl) mask = mask or 4
        return mask + 1
    }

    /**
     * Arrow keys.
     *
     * The SS3 form applies only when unmodified: xterm reverts to CSI as soon as a modifier is
     * present, and vim's Ctrl+Arrow handling depends on that.
     */
    private fun cursor(final: Char, stroke: TerminalKeyStroke, modes: TerminalModes): ByteArray {
        val modifier = csiModifier(stroke)
        return when {
            modifier != null -> ascii(ESC_CHAR + "[1;" + modifier + final)
            modes.applicationCursor -> ss3(final)
            else -> csiRaw(final.toString())
        }
    }

    /** Home/End follow the keypad mode rather than the cursor mode on most hosts. */
    private fun edge(final: Char, stroke: TerminalKeyStroke, modes: TerminalModes): ByteArray {
        val modifier = csiModifier(stroke)
        return when {
            modifier != null -> ascii(ESC_CHAR + "[1;" + modifier + final)
            modes.applicationKeypad || modes.applicationCursor -> ss3(final)
            else -> csiRaw(final.toString())
        }
    }

    /** F1..F4 are SS3 in xterm; F5..F12 are CSI with a numeric parameter. */
    private fun functionKey(index: Int, modifier: Int?): ByteArray {
        val ss3Final = SS3_FUNCTION_FINALS[index]
        return when {
            ss3Final != null && modifier == null -> ss3(ss3Final)
            ss3Final != null -> ascii(ESC_CHAR + "[1;" + modifier + ss3Final)
            else -> csi(CSI_FUNCTION_NUMBERS.getValue(index).toString() + "~", modifier)
        }
    }

    /** CSI with a trailing form like "3~". The modifier is spliced in before the final character. */
    private fun csi(suffix: String, modifier: Int?): ByteArray {
        if (modifier == null) return csiRaw(suffix)
        return ascii(ESC_CHAR + "[" + suffix.dropLast(1) + ";" + modifier + suffix.last())
    }

    private fun csiRaw(body: String): ByteArray = ascii(ESC_CHAR + "[" + body)

    private fun ss3(final: Char): ByteArray = ascii(ESC_CHAR + "O" + final)

    /** Escape sequences are ASCII in every supported charset, so they bypass the session encoder. */
    private fun ascii(value: String): ByteArray = ByteArray(value.length) { value[it].code.toByte() }

    private fun codePointString(codePoint: Int): String = String(Character.toChars(codePoint))

    /**
     * Scrollback keys the client consumes rather than forwarding.
     *
     * Shift+PageUp/PageDown scroll the local transcript (TERMINAL_EXPERIENCE.md 2.12), so they must
     * never reach the PTY: forwarding them would make the remote program see a page key the user
     * meant for the scrollback.
     */
    fun isLocalScrollKey(stroke: TerminalKeyStroke): Boolean =
        stroke.shift && !stroke.ctrl && !stroke.alt &&
            (stroke.key == TerminalKey.PageUp || stroke.key == TerminalKey.PageDown)

    private val SS3_FUNCTION_FINALS: Map<Int, Char> = mapOf(1 to 'P', 2 to 'Q', 3 to 'R', 4 to 'S')

    private val CSI_FUNCTION_NUMBERS: Map<Int, Int> = mapOf(
        5 to 15, 6 to 17, 7 to 18, 8 to 19, 9 to 20, 10 to 21, 11 to 23, 12 to 24,
    )
}
