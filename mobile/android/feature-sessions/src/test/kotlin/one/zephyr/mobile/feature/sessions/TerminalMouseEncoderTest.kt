package one.zephyr.mobile.feature.sessions

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * DEC mouse reporting (TERMINAL_EXPERIENCE.md 2.6).
 *
 * The interesting cases are the ones where the encoder must *refuse* to report: reporting when the
 * program never asked, synthesising a wheel release, or reporting motion without a motion mode.
 * Each of those would put stray bytes into a program that cannot parse them.
 */
class TerminalMouseEncoderTest {

    private fun encode(
        button: MouseButton,
        type: MouseEventType,
        column: Int,
        row: Int,
        modes: TerminalModes,
        ctrl: Boolean = false,
        alt: Boolean = false,
        shift: Boolean = false,
    ): String = hex(TerminalMouseEncoder.encode(button, type, column, row, modes, ctrl, alt, shift))

    @Test
    fun sgrReportsDecimalCoordinates() {
        assertEquals("1b 5b 3c 30 3b 31 3b 31 4d", encode(MouseButton.LEFT, MouseEventType.PRESS, 1, 1, sgrModes))
        assertEquals(
            "1b 5b 3c 32 3b 38 30 3b 32 34 4d",
            encode(MouseButton.RIGHT, MouseEventType.PRESS, 80, 24, sgrModes),
        )
    }

    /** SGR distinguishes a release with a lowercase final, which X10 cannot express. */
    @Test
    fun sgrReleaseUsesLowercaseFinal() {
        assertEquals(
            "1b 5b 3c 30 3b 31 32 3b 33 34 6d",
            encode(MouseButton.LEFT, MouseEventType.RELEASE, 12, 34, sgrModes),
        )
    }

    @Test
    fun motionSetsBitFive() {
        assertEquals("1b 5b 3c 33 32 3b 35 3b 36 4d", encode(MouseButton.LEFT, MouseEventType.MOVE, 5, 6, sgrModes))
    }

    @Test
    fun modifiersAreOredIntoTheButtonCode() {
        assertEquals(
            "1b 5b 3c 31 36 3b 33 3b 34 4d",
            encode(MouseButton.LEFT, MouseEventType.PRESS, 3, 4, sgrModes, ctrl = true),
        )
        assertEquals(
            "1b 5b 3c 34 3b 33 3b 34 4d",
            encode(MouseButton.LEFT, MouseEventType.PRESS, 3, 4, sgrModes, shift = true),
        )
        assertEquals(
            "1b 5b 3c 38 3b 33 3b 34 4d",
            encode(MouseButton.LEFT, MouseEventType.PRESS, 3, 4, sgrModes, alt = true),
        )
    }

    @Test
    fun wheelUsesTheHighButtonCodes() {
        assertEquals(
            "1b 5b 3c 36 34 3b 31 30 3b 31 30 4d",
            encode(MouseButton.WHEEL_UP, MouseEventType.PRESS, 10, 10, sgrModes),
        )
        assertEquals(
            "1b 5b 3c 36 35 3b 31 30 3b 31 30 4d",
            encode(MouseButton.WHEEL_DOWN, MouseEventType.PRESS, 10, 10, sgrModes),
        )
    }

    /** A wheel has no release; synthesising one would make less scroll twice per notch. */
    @Test
    fun wheelHasNoReleaseOrMotion() {
        assertEquals(0, TerminalMouseEncoder.encode(MouseButton.WHEEL_UP, MouseEventType.RELEASE, 1, 1, sgrModes).size)
        assertEquals(0, TerminalMouseEncoder.encode(MouseButton.WHEEL_DOWN, MouseEventType.MOVE, 1, 1, sgrModes).size)
    }

    @Test
    fun x10OffsetsEveryByteBy32() {
        assertEquals("1b 5b 4d 20 21 21", encode(MouseButton.LEFT, MouseEventType.PRESS, 1, 1, x10Modes))
        assertEquals("1b 5b 4d 22 70 38", encode(MouseButton.RIGHT, MouseEventType.PRESS, 80, 24, x10Modes))
    }

    /** X10 cannot name the released button, so every release reports 3. */
    @Test
    fun x10ReleaseReportsButtonThree() {
        assertEquals("1b 5b 4d 23 21 21", encode(MouseButton.LEFT, MouseEventType.RELEASE, 1, 1, x10Modes))
        assertEquals("1b 5b 4d 23 21 21", encode(MouseButton.RIGHT, MouseEventType.RELEASE, 1, 1, x10Modes))
    }

    /**
     * X10 clamps rather than wraps.
     *
     * A wrapped coordinate is indistinguishable from a real click elsewhere, which is worse than
     * reporting the edge of the addressable area.
     */
    @Test
    fun x10ClampsBeyondItsAddressableArea() {
        assertEquals("1b 5b 4d 20 ff ff", encode(MouseButton.LEFT, MouseEventType.PRESS, 300, 400, x10Modes))
        assertEquals(223, TerminalMouseEncoder.X10_MAX_COORDINATE)
    }

    /** SGR has no coordinate ceiling, which is why a large tablet viewport must negotiate 1006. */
    @Test
    fun sgrDoesNotClamp() {
        assertEquals(
            "1b 5b 3c 30 3b 33 30 30 3b 34 30 30 4d",
            encode(MouseButton.LEFT, MouseEventType.PRESS, 300, 400, sgrModes),
        )
    }

    /** Nothing is reported when the program never enabled reporting. */
    @Test
    fun reportingOffProducesNoBytes() {
        assertEquals(
            0,
            TerminalMouseEncoder.encode(MouseButton.LEFT, MouseEventType.PRESS, 1, 1, TerminalModes()).size,
        )
    }

    @Test
    fun motionNeedsAMotionMode() {
        val pressOnly = TerminalModes(mouseReporting = true, mouseProtocol = MouseProtocol.SGR)
        assertEquals(0, TerminalMouseEncoder.encode(MouseButton.LEFT, MouseEventType.MOVE, 1, 1, pressOnly).size)
        val anyMotion = pressOnly.copy(mouseAnyMotion = true)
        assertEquals(
            "1b 5b 3c 33 32 3b 31 3b 31 4d",
            hex(TerminalMouseEncoder.encode(MouseButton.LEFT, MouseEventType.MOVE, 1, 1, anyMotion)),
        )
    }

    @Test
    fun wheelHelperEmitsOneReportPerNotch() {
        val up = TerminalMouseEncoder.wheel(-3, 5, 5, sgrModes)
        assertEquals(3, up.size / 9)
        assertEquals(0, TerminalMouseEncoder.wheel(0, 5, 5, sgrModes).size)
        val down = TerminalMouseEncoder.wheel(1, 5, 5, sgrModes)
        assertEquals("1b 5b 3c 36 35 3b 35 3b 35 4d", hex(down))
    }

    @Test
    fun coordinatesHaveAFloorOfOne() {
        assertEquals("1b 5b 3c 30 3b 31 3b 31 4d", encode(MouseButton.LEFT, MouseEventType.PRESS, 0, -4, sgrModes))
    }
}
