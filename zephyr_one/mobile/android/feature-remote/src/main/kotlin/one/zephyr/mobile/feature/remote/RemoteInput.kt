package one.zephyr.mobile.feature.remote

/**
 * Neutral pointer button mask.
 *
 * The bit order is RFB's on purpose: RFB has no separate press/release event, the mask *is* the
 * event, so matching it means the VNC adapter passes the mask straight through and cannot reorder
 * buttons. RDP names its own flags per button and its adapter maps each one explicitly, so nothing
 * is lost by favouring the more constrained protocol here.
 */
object RemoteButton {
    const val NONE = 0
    const val PRIMARY = 1
    const val MIDDLE = 2
    const val SECONDARY = 4

    fun has(mask: Int, button: Int): Boolean = mask and button != 0

    fun name(button: Int): String = when (button) {
        PRIMARY -> "primary"
        MIDDLE -> "middle"
        SECONDARY -> "secondary"
        else -> "button" + button
    }
}

/**
 * One input event in remote coordinates, before it becomes an RDP or VNC event.
 *
 * Protocol-neutral because REMOTE_DESKTOP_EXPERIENCE.md 2 puts PointerController and
 * KeyboardController above the protocol adapter: the gesture and IME layers must not have to know
 * whether they are driving scan codes or keysyms.
 */
sealed interface RemoteInput {

    /** Pointer position, with whatever buttons are currently held. Coalescible. */
    data class PointerMove(val x: Int, val y: Int, val buttons: Int) : RemoteInput

    /**
     * A button transition.
     *
     * Carries the resulting [buttons] mask as well as which [button] changed, because RFB needs the
     * mask and RDP needs the individual flag, and deriving one from the other at the adapter is how
     * a chord ends up sending the wrong button.
     */
    data class PointerButton(
        val x: Int,
        val y: Int,
        val buttons: Int,
        val button: Int,
        val down: Boolean,
    ) : RemoteInput

    /** @param notches positive scrolls the content down, matching the platform wheel convention. */
    data class Wheel(val x: Int, val y: Int, val notches: Int, val horizontal: Boolean = false) : RemoteInput

    /** A key transition. Modifiers travel as their own strokes so a chord is explicit. */
    data class Key(val key: RemoteKey, val down: Boolean) : RemoteInput

    /**
     * Committed IME text.
     *
     * Separate from [Key] because REMOTE_DESKTOP_EXPERIENCE.md 6 requires system IME text to go over
     * the unicode/text path while program shortcuts go as scan codes: sending Ctrl+C as text would
     * type the letter c into the remote application.
     */
    data class Text(val text: String) : RemoteInput
}

/**
 * The input side of the protocol hand-off.
 *
 * Bounded, and lossless for everything that changes state. REMOTE_DESKTOP_EXPERIENCE.md 2 allows
 * stale video frames to be dropped but not input, so the bound is achieved by coalescing superseded
 * pointer positions rather than by discarding events: a burst of a hundred move samples occupies one
 * slot, and a press, release or key never merges with anything.
 *
 * The only event this will ever discard is a [RemoteInput.PointerMove] that a newer move already
 * supersedes, and [offer] reports false rather than dropping anything else, so a caller that somehow
 * fills the queue with transitions is told to back off instead of silently losing a key-up.
 */
class RemoteInputQueue(private val capacity: Int = CAPACITY) {

    private val queue = ArrayDeque<RemoteInput>()
    private var coalesced = 0

    val pendingCount: Int get() = queue.size

    /** Move samples merged into a later move. Reported in the diagnostics panel, never as an error. */
    val coalescedMoves: Int get() = coalesced

    /**
     * @return false when the queue is full of state transitions and the caller must retry. Never
     *   false because of moves: a move can always be merged into the pending one.
     */
    fun offer(input: RemoteInput): Boolean {
        if (input is RemoteInput.PointerMove) {
            val last = queue.lastOrNull()
            if (last is RemoteInput.PointerMove && last.buttons == input.buttons) {
                queue.removeLast()
                queue.addLast(input)
                coalesced++
                return true
            }
        }
        if (queue.size >= capacity) {
            // Sacrifice the oldest superseded position rather than a transition: a later move already
            // carries the truthful pointer location, but a dropped key-up leaves a stuck modifier.
            val staleMove = queue.indexOfFirst { it is RemoteInput.PointerMove }
            if (staleMove < 0) return false
            queue.removeAt(staleMove)
            coalesced++
        }
        queue.addLast(input)
        return true
    }

    fun poll(): RemoteInput? = queue.removeFirstOrNull()

    fun drain(): List<RemoteInput> {
        if (queue.isEmpty()) return emptyList()
        val result = ArrayList<RemoteInput>(queue)
        queue.clear()
        return result
    }

    fun clear() {
        queue.clear()
    }

    companion object {
        const val CAPACITY = 256
    }
}
