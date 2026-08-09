package one.zephyr.mobile.feature.sessions

import kotlin.math.abs

/**
 * Which subsystem owns the current pointer stream.
 *
 * TERMINAL_EXPERIENCE.md 5.1 freezes the arbitration table, and 12 injects a reverse test where a
 * scroll turns into a selection mid-gesture. Making the winner an explicit state that only changes
 * at defined moments is what makes that test fail as required.
 */
enum class GestureOwner {
    /** Nothing has won yet; the pointers are still within the slop radius. */
    UNDECIDED,

    /** Active text selection owns the drag, including its handles. */
    SELECTION,

    /** Two-finger pinch owns both pointers and drives font scale. */
    PINCH,

    /** Local transcript scroll. */
    SCROLLBACK,

    /** Bytes go to the remote program as terminal mouse events. */
    REMOTE_MOUSE,

    /** Alternate buffer with no mouse reporting: scroll becomes Up/Down keys. */
    ALTERNATE_SCROLL,
}

/**
 * The emulator state the arbiter and the encoders need.
 *
 * Passed in as a value rather than read from an engine so every decision in this module stays pure.
 * The defaults are the modes a terminal starts in, so a caller that has not negotiated anything yet
 * gets the conservative behaviour: local scroll, no reporting, ESC-prefixed Alt.
 */
data class TerminalModes(
    /** DECSET 1000: any mouse reporting at all. The other mouse flags are meaningless without it. */
    val mouseReporting: Boolean = false,
    /** DECSET 1002: report motion while a button is held. */
    val mouseButtonMotion: Boolean = false,
    /** DECSET 1003: report motion with no button held. */
    val mouseAnyMotion: Boolean = false,
    /** DECSET 1006 selects SGR; without it the legacy X10 encoding applies. */
    val mouseProtocol: MouseProtocol = MouseProtocol.X10,
    val alternateBuffer: Boolean = false,
    val applicationCursor: Boolean = false,
    val applicationKeypad: Boolean = false,
    val bracketedPaste: Boolean = false,
)

/**
 * Gesture arbitration.
 *
 * The rules are ordered, not scored: selection beats everything, then pinch, then the mouse-mode
 * question, and only then the buffer-dependent scroll behaviour. An ordered table is the only form
 * that can be read against the frozen spec line by line.
 */
class GestureArbiter(
    private val touchSlopPx: Float = DEFAULT_TOUCH_SLOP_PX,
    private val pinchSlopPx: Float = DEFAULT_PINCH_SLOP_PX,
) {

    private var owner: GestureOwner = GestureOwner.UNDECIDED

    val current: GestureOwner get() = owner

    /**
     * Called once per pointer-down.
     *
     * Selection is decided immediately because a drag that starts on a selection handle must not
     * spend the slop distance undecided: the handle would visibly lag.
     */
    fun onPointerDown(pointerCount: Int, selectionActive: Boolean): GestureOwner {
        owner = if (selectionActive) GestureOwner.SELECTION else GestureOwner.UNDECIDED
        return owner
    }

    /**
     * Called on every move until a winner is locked.
     *
     * @param twoFingerScrollGoesRemote user setting from TERMINAL_EXPERIENCE.md 5.1: with mouse
     *   reporting on, a two-finger scroll is either wheel events for the remote program or a local
     *   transcript scroll, and the user decides which.
     * @return the owner after this move. Once it is not [GestureOwner.UNDECIDED] it never changes
     *   for the rest of the gesture.
     */
    fun onMove(
        pointerCount: Int,
        dx: Float,
        dy: Float,
        spanDelta: Float,
        modes: TerminalModes,
        twoFingerScrollGoesRemote: Boolean = false,
    ): GestureOwner {
        if (owner != GestureOwner.UNDECIDED) return owner

        if (pointerCount >= 2 && abs(spanDelta) >= pinchSlopPx) {
            owner = GestureOwner.PINCH
            return owner
        }

        val movedEnough = abs(dx) >= touchSlopPx || abs(dy) >= touchSlopPx
        if (!movedEnough) return owner

        // Horizontal drags are not a terminal gesture: they belong to the session switcher, so the
        // arbiter refuses them rather than scrolling sideways through a grid that does not exist.
        if (abs(dx) > abs(dy)) {
            owner = GestureOwner.UNDECIDED
            return owner
        }

        owner = when {
            modes.mouseReporting && pointerCount == 1 -> GestureOwner.REMOTE_MOUSE
            modes.mouseReporting && twoFingerScrollGoesRemote -> GestureOwner.REMOTE_MOUSE
            modes.mouseReporting -> GestureOwner.SCROLLBACK
            // A full-screen program on the alternate buffer has no transcript to scroll, so the
            // scroll is translated to the keys it actually understands (TERMINAL_EXPERIENCE.md 2.5).
            modes.alternateBuffer -> GestureOwner.ALTERNATE_SCROLL
            else -> GestureOwner.SCROLLBACK
        }
        return owner
    }

    fun onGestureEnd() {
        owner = GestureOwner.UNDECIDED
    }

    /**
     * Long press.
     *
     * Selection takes over regardless of what was winning, because the user's intent is explicit.
     * The caller fires the system haptic; the arbiter only owns the state so that the two cannot
     * disagree.
     */
    fun onLongPress(): GestureOwner {
        owner = GestureOwner.SELECTION
        return owner
    }

    companion object {
        const val DEFAULT_TOUCH_SLOP_PX = 8f
        const val DEFAULT_PINCH_SLOP_PX = 24f
    }
}

/**
 * Alternate-buffer scroll translation.
 *
 * TERMINAL_EXPERIENCE.md 2.5: with no mouse tracking, a scroll on the alternate buffer becomes
 * Up/Down so that less and man behave. Kept separate from the arbiter so the key bytes come from
 * [TerminalKeyEncoder] and not from a second encoder.
 */
object AlternateScrollTranslator {

    /** @return one repeat of the key per scrolled row, in order. */
    fun keysFor(rows: Int): List<TerminalKey> {
        if (rows == 0) return emptyList()
        val key = if (rows < 0) TerminalKey.ArrowUp else TerminalKey.ArrowDown
        return List(abs(rows)) { key }
    }

    /**
     * @param modes passed through whole rather than just the cursor flag, so the translated key goes
     *   through exactly the same encoder path as a real arrow press.
     */
    fun encode(rows: Int, modes: TerminalModes): ByteArray {
        var out = ByteArray(0)
        for (key in keysFor(rows)) {
            out += TerminalKeyEncoder.encode(TerminalKeyStroke(key), modes)
        }
        return out
    }
}
