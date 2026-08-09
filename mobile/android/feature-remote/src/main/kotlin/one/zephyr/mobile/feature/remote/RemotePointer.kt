package one.zephyr.mobile.feature.remote

import kotlin.math.min

/** Direct maps a finger to the remote pointer; trackpad drives it relatively. */
enum class RemotePointerMode {
    DIRECT,
    TRACKPAD,
    ;

    companion object {
        fun of(mode: one.zephyr.mobile.model.RdpTouchMode): RemotePointerMode =
            when (mode) {
                one.zephyr.mobile.model.RdpTouchMode.DIRECT -> DIRECT
                one.zephyr.mobile.model.RdpTouchMode.RELATIVE -> TRACKPAD
            }
    }
}

/**
 * Pointer acceleration for trackpad mode.
 *
 * A two-segment curve rather than a polynomial: it is continuous at the threshold, monotonic
 * everywhere and bounded above, so a fast flick cannot teleport the remote cursor across the desktop
 * and a slow drag stays pixel-accurate. REMOTE_DESKTOP_EXPERIENCE.md 5.2 asks for a "稳定曲线" with a
 * 0.5-2.5 sensitivity range, which is exactly those three properties plus the range.
 */
object RemotePointerAcceleration {

    const val MIN_SENSITIVITY = 0.5f
    const val MAX_SENSITIVITY = 2.5f

    /** Below this per-sample distance the gain is the raw sensitivity, so slow drags are precise. */
    const val THRESHOLD_PX = 8f

    /** Ceiling on the acceleration multiplier, independent of sensitivity. */
    const val MAX_ACCELERATION = 2f

    fun clampSensitivity(value: Float): Float = value.coerceIn(MIN_SENSITIVITY, MAX_SENSITIVITY)

    fun gain(distancePx: Float, sensitivity: Float): Float {
        val base = clampSensitivity(sensitivity)
        if (distancePx <= THRESHOLD_PX) return base
        val excess = (distancePx - THRESHOLD_PX) / THRESHOLD_PX
        return base * (1f + min(excess, MAX_ACCELERATION - 1f))
    }
}

/**
 * Where the remote pointer is and what is held down.
 *
 * @param dragLock a trackpad double-tap-and-drag left the primary button down deliberately. Tracked
 *   separately from [buttons] because releasing it is a distinct user action, and a mode switch must
 *   not silently strand it.
 */
data class RemotePointerState(
    val mode: RemotePointerMode = RemotePointerMode.DIRECT,
    val cursor: RemotePoint = RemotePoint(0, 0),
    val buttons: Int = RemoteButton.NONE,
    val dragLock: Boolean = false,
) {
    val hasButtonDown: Boolean get() = buttons != RemoteButton.NONE
}

/**
 * Turns gestures into remote pointer events.
 *
 * Stateful for one reason: trackpad mode is relative, so the remote cursor position lives here rather
 * than being recomputed from the finger. That is also what satisfies "切模式保留 remote cursor，不跳到
 * 手指位置" - the cursor survives a mode switch because the switch only changes how deltas are
 * interpreted, never where the pointer is.
 *
 * @param swapLongPress swaps primary and secondary for direct-mode tap and long press, which
 *   REMOTE_DESKTOP_EXPERIENCE.md 5.1 allows as a setting.
 */
class RemotePointerController(
    initialMode: RemotePointerMode = RemotePointerMode.DIRECT,
    sensitivity: Float = 1.5f,
    private val swapLongPress: Boolean = false,
) {

    var state: RemotePointerState = RemotePointerState(mode = initialMode)
        private set

    private var sensitivityValue = RemotePointerAcceleration.clampSensitivity(sensitivity)

    /** Sub-pixel remainder, so a slow trackpad drag is not rounded away one sample at a time. */
    private var residualX = 0f
    private var residualY = 0f

    val sensitivity: Float get() = sensitivityValue

    fun setSensitivity(value: Float) {
        sensitivityValue = RemotePointerAcceleration.clampSensitivity(value)
    }

    /** Switches mode. The remote cursor stays where it is; only interpretation changes. */
    fun setMode(mode: RemotePointerMode): List<RemoteInput> {
        if (mode == state.mode) return emptyList()
        // A held button would otherwise stay down across a mode change, which reads to the remote
        // application as a drag that never ends.
        val released = releaseAll()
        state = state.copy(mode = mode)
        residualX = 0f
        residualY = 0f
        return released
    }

    private val primary: Int get() = if (swapLongPress) RemoteButton.SECONDARY else RemoteButton.PRIMARY
    private val secondary: Int get() = if (swapLongPress) RemoteButton.PRIMARY else RemoteButton.SECONDARY

    // ---- direct mode -----------------------------------------------------------------------------

    /**
     * A tap at a remote point: move, press, release.
     *
     * The move is sent first because a remote application decides what was clicked from the pointer
     * position it last saw, and some Windows controls read the position on the button-down message
     * rather than from the message itself.
     */
    fun tap(point: RemotePoint, button: Int = primary): List<RemoteInput> {
        val moved = moveTo(point)
        return moved + press(button) + release(button)
    }

    /** Long press: a secondary click at the touched point. The haptic is the caller's job. */
    fun longPress(point: RemotePoint): List<RemoteInput> = tap(point, secondary)

    fun dragStart(point: RemotePoint, button: Int = primary): List<RemoteInput> =
        moveTo(point) + press(button)

    fun dragTo(point: RemotePoint): List<RemoteInput> = moveTo(point)

    fun dragEnd(): List<RemoteInput> = releaseAll()

    // ---- trackpad mode ---------------------------------------------------------------------------

    /**
     * Relative movement in viewport pixels.
     *
     * @param scale the current viewport scale, so one device pixel of finger travel moves one remote
     *   pixel when zoomed in. Without this a trackpad drag would feel proportionally faster the more
     *   the user zoomed in.
     */
    fun moveBy(dxPx: Float, dyPx: Float, geometry: RemoteGeometry, scale: Float): List<RemoteInput> {
        if (!geometry.isMeasured) return emptyList()
        val distance = kotlin.math.hypot(dxPx.toDouble(), dyPx.toDouble()).toFloat()
        val gain = RemotePointerAcceleration.gain(distance, sensitivityValue)
        val divisor = if (scale > 0f) scale else 1f
        val totalX = residualX + dxPx * gain / divisor
        val totalY = residualY + dyPx * gain / divisor
        val stepX = totalX.toInt()
        val stepY = totalY.toInt()
        residualX = totalX - stepX
        residualY = totalY - stepY
        if (stepX == 0 && stepY == 0) return emptyList()
        val next = RemotePoint(
            (state.cursor.x + stepX).coerceIn(0, geometry.remoteWidthPx - 1),
            (state.cursor.y + stepY).coerceIn(0, geometry.remoteHeightPx - 1),
        )
        return moveTo(next)
    }

    /** Trackpad tap: a click wherever the remote cursor already is. */
    fun clickAtCursor(button: Int = RemoteButton.PRIMARY): List<RemoteInput> =
        press(button) + release(button)

    /**
     * Double-tap-and-drag: holds primary down until [releaseDragLock].
     *
     * Modelled as an explicit latch rather than as a long press so the UI can show that the button is
     * held; an invisible held button is indistinguishable from a stuck one.
     */
    fun engageDragLock(): List<RemoteInput> {
        if (state.dragLock) return emptyList()
        val events = press(RemoteButton.PRIMARY)
        state = state.copy(dragLock = true)
        return events
    }

    fun releaseDragLock(): List<RemoteInput> {
        if (!state.dragLock) return emptyList()
        state = state.copy(dragLock = false)
        return release(RemoteButton.PRIMARY)
    }

    // ---- shared ----------------------------------------------------------------------------------

    /** Two-finger scroll, in wheel notches at the current cursor. */
    fun wheel(notches: Int, horizontal: Boolean = false): List<RemoteInput> {
        if (notches == 0) return emptyList()
        return listOf(RemoteInput.Wheel(state.cursor.x, state.cursor.y, notches, horizontal))
    }

    /** Hardware mouse and hover: absolute position with an explicit mask, passed straight through. */
    fun hardware(point: RemotePoint, buttons: Int): List<RemoteInput> {
        val events = ArrayList<RemoteInput>(4)
        if (point != state.cursor) {
            state = state.copy(cursor = point)
            events += RemoteInput.PointerMove(point.x, point.y, state.buttons)
        }
        // Diffed rather than replaced so a chord produces one transition per button, which is what
        // both protocols expect and what makes a middle-drag work.
        for (button in BUTTONS) {
            val was = RemoteButton.has(state.buttons, button)
            val now = RemoteButton.has(buttons, button)
            if (was == now) continue
            events += if (now) press(button) else release(button)
        }
        return events
    }

    fun releaseAll(): List<RemoteInput> {
        if (!state.hasButtonDown) {
            state = state.copy(dragLock = false)
            return emptyList()
        }
        val events = ArrayList<RemoteInput>(3)
        for (button in BUTTONS) {
            if (RemoteButton.has(state.buttons, button)) events += release(button)
        }
        state = state.copy(dragLock = false)
        return events
    }

    private fun moveTo(point: RemotePoint): List<RemoteInput> {
        if (point == state.cursor) return emptyList()
        state = state.copy(cursor = point)
        return listOf(RemoteInput.PointerMove(point.x, point.y, state.buttons))
    }

    private fun press(button: Int): List<RemoteInput> {
        if (RemoteButton.has(state.buttons, button)) return emptyList()
        val mask = state.buttons or button
        state = state.copy(buttons = mask)
        return listOf(
            RemoteInput.PointerButton(
                x = state.cursor.x,
                y = state.cursor.y,
                buttons = mask,
                button = button,
                down = true,
            ),
        )
    }

    private fun release(button: Int): List<RemoteInput> {
        if (!RemoteButton.has(state.buttons, button)) return emptyList()
        val mask = state.buttons and button.inv()
        state = state.copy(buttons = mask)
        return listOf(
            RemoteInput.PointerButton(
                x = state.cursor.x,
                y = state.cursor.y,
                buttons = mask,
                button = button,
                down = false,
            ),
        )
    }

    private companion object {
        val BUTTONS = intArrayOf(RemoteButton.PRIMARY, RemoteButton.MIDDLE, RemoteButton.SECONDARY)
    }
}
