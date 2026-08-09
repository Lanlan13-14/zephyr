package one.zephyr.mobile.feature.sessions

/**
 * Wire format for mouse reports.
 *
 * X10 is the legacy encoding every terminal understands but it cannot express a coordinate above
 * 223, so a large tablet viewport silently wraps. SGR has no such limit. Both exist here because the
 * remote program chooses, not the client: reporting SGR to a program that only enabled 1000 would
 * put literal escape text on the screen.
 */
enum class MouseProtocol {
    /** `ESC [ M Cb Cx Cy`, each value offset by 32. */
    X10,

    /** `ESC [ < b ; col ; row M|m`, decimal and unbounded (DECSET 1006). */
    SGR,
}

enum class MouseButton(val code: Int) {
    LEFT(0),
    MIDDLE(1),
    RIGHT(2),
    WHEEL_UP(64),
    WHEEL_DOWN(65),
    ;

    val isWheel: Boolean get() = this == WHEEL_UP || this == WHEEL_DOWN
}

enum class MouseEventType { PRESS, RELEASE, MOVE }

/**
 * Terminal mouse protocol encoder.
 *
 * TERMINAL_EXPERIENCE.md 2.6 requires that with mouse tracking active a tap/drag/wheel becomes a
 * terminal mouse event rather than a local scroll, and the reverse test in 12 requires the wrong
 * choice to fail. Keeping the encoding pure means that decision is testable without a PTY, and
 * keeping it out of [TerminalKeyEncoder] keeps each encoder answering one question.
 */
object TerminalMouseEncoder {

    private const val ESC_CHAR = '\u001b'

    /** X10 offsets every byte by 32, so the highest representable coordinate is 255-32-1. */
    const val X10_OFFSET = 32
    const val X10_MAX_COORDINATE = 223

    const val MODIFIER_SHIFT = 4
    const val MODIFIER_ALT = 8
    const val MODIFIER_CTRL = 16

    /** Motion reports set bit 5 on top of the held button. */
    const val MOTION_FLAG = 32

    /** X10 cannot name the released button, so it reports 3 for every release. */
    const val X10_RELEASE_BUTTON = 3

    /**
     * @param column 1-based terminal column.
     * @param row 1-based terminal row.
     * @return the report bytes, or an empty array when the event must not be reported at all.
     */
    fun encode(
        button: MouseButton,
        type: MouseEventType,
        column: Int,
        row: Int,
        modes: TerminalModes,
        ctrl: Boolean = false,
        alt: Boolean = false,
        shift: Boolean = false,
    ): ByteArray {
        if (!modes.mouseReporting) return ByteArray(0)
        // A wheel has no release: the program expects one report per notch, and synthesising a
        // release would make less scroll twice per notch.
        if (button.isWheel && type != MouseEventType.PRESS) return ByteArray(0)
        if (type == MouseEventType.MOVE && !modes.mouseButtonMotion && !modes.mouseAnyMotion) return ByteArray(0)

        var code = button.code
        if (type == MouseEventType.MOVE) code = code or MOTION_FLAG
        if (shift) code = code or MODIFIER_SHIFT
        if (alt) code = code or MODIFIER_ALT
        if (ctrl) code = code or MODIFIER_CTRL

        return when (modes.mouseProtocol) {
            MouseProtocol.SGR -> sgr(code, type, column, row)
            MouseProtocol.X10 -> x10(code, type, column, row)
        }
    }

    /**
     * Wheel notches as reports.
     *
     * @param notches negative scrolls back through the transcript, matching the sign convention the
     *   gesture layer already uses for rows.
     */
    fun wheel(notches: Int, column: Int, row: Int, modes: TerminalModes): ByteArray {
        if (notches == 0) return ByteArray(0)
        val button = if (notches < 0) MouseButton.WHEEL_UP else MouseButton.WHEEL_DOWN
        var out = ByteArray(0)
        repeat(kotlin.math.abs(notches)) {
            out += encode(button, MouseEventType.PRESS, column, row, modes)
        }
        return out
    }

    private fun sgr(code: Int, type: MouseEventType, column: Int, row: Int): ByteArray {
        val final = if (type == MouseEventType.RELEASE) 'm' else 'M'
        return ascii(ESC_CHAR + "[<" + code + ";" + maxOf(1, column) + ";" + maxOf(1, row) + final)
    }

    /**
     * X10.
     *
     * Coordinates are clamped rather than wrapped: a wrapped coordinate is indistinguishable from a
     * real click somewhere else, which is worse than reporting the edge of the addressable area.
     */
    private fun x10(code: Int, type: MouseEventType, column: Int, row: Int): ByteArray {
        val reported = if (type == MouseEventType.RELEASE) {
            (code and MOTION_FLAG.inv() and 0x03.inv()) or X10_RELEASE_BUTTON
        } else {
            code
        }
        val cx = maxOf(1, column).coerceAtMost(X10_MAX_COORDINATE) + X10_OFFSET
        val cy = maxOf(1, row).coerceAtMost(X10_MAX_COORDINATE) + X10_OFFSET
        return byteArrayOf(
            TerminalKeyEncoder.ESC,
            '['.code.toByte(),
            'M'.code.toByte(),
            (reported + X10_OFFSET).toByte(),
            cx.toByte(),
            cy.toByte(),
        )
    }

    private fun ascii(value: String): ByteArray = ByteArray(value.length) { value[it].code.toByte() }
}
