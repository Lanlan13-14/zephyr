package one.zephyr.mobile.feature.sessions

/**
 * IME composition state.
 *
 * TERMINAL_EXPERIENCE.md 3 is explicit: a composition update only moves the marked-text overlay and
 * must not write to the PTY, a commit writes exactly once, and a cancel writes nothing. Modelling it
 * as a value type with an explicit outcome is what makes "Enter exactly once" testable - the
 * reverse test in section 12 requires a second owner sending Enter to *fail*, and it can only fail
 * if there is one place that decides.
 */
data class TerminalComposition(
    /** Text the IME is still composing. Rendered as an overlay, never sent. */
    val composing: String = "",
    /** Cursor inside [composing], for the overlay caret. */
    val cursor: Int = 0,
) {
    val isActive: Boolean get() = composing.isNotEmpty()

    companion object {
        val idle = TerminalComposition()
    }
}

/**
 * What the surface should do with an input event.
 *
 * [bytes] empty means nothing reaches the transport. A caller that ignores this and writes anyway is
 * the double-owner bug the spec's reverse test hunts for.
 */
data class InputOutcome(
    val composition: TerminalComposition,
    val bytes: ByteArray = ByteArray(0),
) {
    val writesToPty: Boolean get() = bytes.isNotEmpty()

    // ByteArray in a data class has identity equals, which would make every assertEquals fail.
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is InputOutcome) return false
        return composition == other.composition && bytes.contentEquals(other.bytes)
    }

    override fun hashCode(): Int = 31 * composition.hashCode() + bytes.contentHashCode()
}

/**
 * The IME half of the single surface owner.
 *
 * Separate from [TerminalKeyEncoder] because the two answer different questions: the encoder turns a
 * key into bytes, this decides *whether* an event produces bytes at all. Keeping them apart is what
 * lets the CJK path (many updates, one commit) share the encoder with the hardware-key path.
 */
object TerminalInput {

    /**
     * setComposingText.
     *
     * Never emits bytes. A terminal has no way to represent "provisional text", so sending a
     * composition would put half-typed pinyin into the remote shell and then be unable to erase it.
     */
    fun composing(text: String, cursor: Int = text.length): InputOutcome =
        InputOutcome(TerminalComposition(text, cursor.coerceIn(0, text.length)))

    /**
     * commitText.
     *
     * The committed text is encoded once and the composition is cleared in the same outcome, so
     * there is no window in which both the overlay and the PTY hold the same characters.
     */
    fun commit(text: String, encoding: TerminalCharset = TerminalCharset.UTF8): InputOutcome =
        InputOutcome(TerminalComposition.idle, encoding.encode(text))

    /** finishComposingText with pending text: the platform contract is to commit it. */
    fun finish(current: TerminalComposition, encoding: TerminalCharset = TerminalCharset.UTF8): InputOutcome =
        if (current.isActive) commit(current.composing, encoding) else InputOutcome(TerminalComposition.idle)

    /** Cancelled composition. Nothing was ever sent, so nothing needs undoing. */
    fun cancel(): InputOutcome = InputOutcome(TerminalComposition.idle)

    /**
     * A hardware or extra key while a composition is open.
     *
     * The composition is committed first so the ordering the user typed is preserved: pressing Enter
     * mid-composition must send the composed text *then* the newline, not the other way round.
     */
    fun key(
        current: TerminalComposition,
        stroke: TerminalKeyStroke,
        modes: TerminalModes = TerminalModes(),
        encoding: TerminalCharset = TerminalCharset.UTF8,
    ): InputOutcome {
        val keyBytes = TerminalKeyEncoder.encode(stroke, modes, encoding)
        if (!current.isActive) return InputOutcome(TerminalComposition.idle, keyBytes)
        val committed = encoding.encode(current.composing)
        return InputOutcome(TerminalComposition.idle, committed + keyBytes)
    }
}
