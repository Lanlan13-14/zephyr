package one.zephyr.mobile.feature.sessions

import android.view.KeyEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The IME mapping table.
 *
 * Runs under plain JUnit with no Robolectric because [TerminalKeyMapper.map] takes the resolved
 * unicode character as a parameter instead of calling KeyEvent.getUnicodeChar: the platform method
 * returns 0 outside a device, which would make every printable key untestable. The KeyEvent.KEYCODE_*
 * and META_* values referenced here are compile-time constants and are inlined by the compiler, so
 * nothing in this file touches the Android runtime.
 */
class TerminalKeyMapperTest {

    // ---- named keys ------------------------------------------------------------------------------

    @Test
    fun namedKeysMapToTheirTerminalKey() {
        assertEquals(TerminalKey.Enter, TerminalKeyMapper.named(KeyEvent.KEYCODE_ENTER))
        assertEquals(TerminalKey.Enter, TerminalKeyMapper.named(KeyEvent.KEYCODE_NUMPAD_ENTER))
        // KEYCODE_DEL is the backspace key; forward delete is a different keycode. Swapping these two
        // is the classic Android terminal bug: backspace would delete forwards.
        assertEquals(TerminalKey.Backspace, TerminalKeyMapper.named(KeyEvent.KEYCODE_DEL))
        assertEquals(TerminalKey.Delete, TerminalKeyMapper.named(KeyEvent.KEYCODE_FORWARD_DEL))
        assertEquals(TerminalKey.Insert, TerminalKeyMapper.named(KeyEvent.KEYCODE_INSERT))
        assertEquals(TerminalKey.Tab, TerminalKeyMapper.named(KeyEvent.KEYCODE_TAB))
        assertEquals(TerminalKey.Escape, TerminalKeyMapper.named(KeyEvent.KEYCODE_ESCAPE))
        assertEquals(TerminalKey.ArrowUp, TerminalKeyMapper.named(KeyEvent.KEYCODE_DPAD_UP))
        assertEquals(TerminalKey.ArrowDown, TerminalKeyMapper.named(KeyEvent.KEYCODE_DPAD_DOWN))
        assertEquals(TerminalKey.ArrowLeft, TerminalKeyMapper.named(KeyEvent.KEYCODE_DPAD_LEFT))
        assertEquals(TerminalKey.ArrowRight, TerminalKeyMapper.named(KeyEvent.KEYCODE_DPAD_RIGHT))
        assertEquals(TerminalKey.Home, TerminalKeyMapper.named(KeyEvent.KEYCODE_MOVE_HOME))
        assertEquals(TerminalKey.End, TerminalKeyMapper.named(KeyEvent.KEYCODE_MOVE_END))
        assertEquals(TerminalKey.PageUp, TerminalKeyMapper.named(KeyEvent.KEYCODE_PAGE_UP))
        assertEquals(TerminalKey.PageDown, TerminalKeyMapper.named(KeyEvent.KEYCODE_PAGE_DOWN))
    }

    @Test
    fun theWholeFunctionKeyRangeIsOneBased() {
        for (index in 1..12) {
            val keyCode = KeyEvent.KEYCODE_F1 + index - 1
            assertEquals(
                "F" + index,
                TerminalKey.Function(index),
                TerminalKeyMapper.named(keyCode),
            )
        }
        // Off-by-one guard: the encoder table is indexed 1..12, so an F1 that mapped to Function(0)
        // would throw rather than send SS3 P.
        assertEquals(TerminalKey.Function(1), TerminalKeyMapper.named(KeyEvent.KEYCODE_F1))
        assertEquals(TerminalKey.Function(12), TerminalKeyMapper.named(KeyEvent.KEYCODE_F12))
    }

    @Test
    fun keysThatAreNotTerminalInputAreLeftToTheSystem() {
        // Back must stay with the system: swallowing it would break the predictive-back gesture that
        // ANDROID_PREDICTIVE_BACK.md requires on every screen.
        assertNull(TerminalKeyMapper.named(KeyEvent.KEYCODE_BACK))
        assertNull(TerminalKeyMapper.named(KeyEvent.KEYCODE_VOLUME_UP))
        assertNull(TerminalKeyMapper.named(KeyEvent.KEYCODE_A))
        assertNull(TerminalKeyMapper.map(KeyEvent.KEYCODE_BACK, metaState = 0, unicodeChar = 0))
    }

    // ---- modifiers on named keys -----------------------------------------------------------------

    @Test
    fun namedKeysCarryTheirModifiers() {
        val stroke = TerminalKeyMapper.map(
            keyCode = KeyEvent.KEYCODE_DPAD_UP,
            metaState = KeyEvent.META_CTRL_ON or KeyEvent.META_CTRL_LEFT_ON,
            unicodeChar = 0,
        )

        // A named key encodes its modifiers as an xterm parameter, so they must survive the mapping.
        assertEquals(TerminalKeyStroke(TerminalKey.ArrowUp, ctrl = true), stroke)
    }

    @Test
    fun shiftIsKeptOnANamedKey() {
        val stroke = TerminalKeyMapper.map(
            keyCode = KeyEvent.KEYCODE_TAB,
            metaState = KeyEvent.META_SHIFT_ON,
            unicodeChar = 0,
        )

        // Shift+Tab is CSI Z, a different sequence from Tab. Dropping shift here would send a plain
        // tab and break reverse field navigation.
        assertEquals(TerminalKeyStroke(TerminalKey.Tab, shift = true), stroke)
    }

    @Test
    fun allThreeModifiersPropagateTogether() {
        val stroke = TerminalKeyMapper.map(
            keyCode = KeyEvent.KEYCODE_DPAD_DOWN,
            metaState = KeyEvent.META_CTRL_ON or KeyEvent.META_ALT_ON or KeyEvent.META_SHIFT_ON,
            unicodeChar = 0,
        )

        assertEquals(
            TerminalKeyStroke(TerminalKey.ArrowDown, ctrl = true, alt = true, shift = true),
            stroke,
        )
    }

    @Test
    fun aNamedKeyWinsOverAResolvedCharacter() {
        // The platform resolves Enter to a newline character. Taking the character path would send
        // 0x0a where the terminal expects 0x0d, which breaks line-based shells.
        val stroke = TerminalKeyMapper.map(
            keyCode = KeyEvent.KEYCODE_ENTER,
            metaState = 0,
            unicodeChar = '\n'.code,
        )

        assertEquals(TerminalKeyStroke(TerminalKey.Enter), stroke)
    }

    // ---- printable characters --------------------------------------------------------------------

    @Test
    fun aResolvedCharacterBecomesACharacterStroke() {
        val stroke = TerminalKeyMapper.map(
            keyCode = KeyEvent.KEYCODE_A,
            metaState = 0,
            unicodeChar = 'a'.code,
        )

        assertEquals(TerminalKeyStroke(TerminalKey.Character('a'.code)), stroke)
    }

    @Test
    fun shiftIsDroppedOnACharacterBecauseItIsAlreadyResolved() {
        val stroke = TerminalKeyMapper.map(
            keyCode = KeyEvent.KEYCODE_A,
            metaState = KeyEvent.META_SHIFT_ON or KeyEvent.META_SHIFT_LEFT_ON,
            unicodeChar = 'A'.code,
        )

        // The caller already asked the platform for the shifted character. Passing shift on as well
        // would make the encoder add an xterm modifier parameter to a printable byte.
        assertEquals(TerminalKeyStroke(TerminalKey.Character('A'.code), shift = false), stroke)
    }

    @Test
    fun ctrlAndAltSurviveOnACharacter() {
        val stroke = TerminalKeyMapper.map(
            keyCode = KeyEvent.KEYCODE_C,
            metaState = KeyEvent.META_CTRL_ON,
            unicodeChar = 'c'.code,
        )

        // Ctrl+c is 0x03. This is the single most important stroke in a terminal, and it only works
        // because the caller stripped ctrl before asking for the unicode value.
        assertEquals(TerminalKeyStroke(TerminalKey.Character('c'.code), ctrl = true), stroke)

        val meta = TerminalKeyMapper.map(
            keyCode = KeyEvent.KEYCODE_B,
            metaState = KeyEvent.META_ALT_ON,
            unicodeChar = 'b'.code,
        )
        assertEquals(TerminalKeyStroke(TerminalKey.Character('b'.code), alt = true), meta)
    }

    @Test
    fun aNonAsciiCharacterIsCarriedAsACodePoint() {
        val stroke = TerminalKeyMapper.map(
            keyCode = KeyEvent.KEYCODE_UNKNOWN,
            metaState = 0,
            unicodeChar = 0x4e2d,
        )

        // The charset conversion happens in the encoder, so the mapper must not truncate to a byte.
        assertEquals(TerminalKeyStroke(TerminalKey.Character(0x4e2d)), stroke)
    }

    // ---- the two null paths ----------------------------------------------------------------------

    @Test
    fun aDeadKeyInProgressProducesNothing() {
        val stroke = TerminalKeyMapper.map(
            keyCode = KeyEvent.KEYCODE_UNKNOWN,
            metaState = 0,
            unicodeChar = TerminalKeyMapper.COMBINING_ACCENT or 0x0301,
        )

        // Sending it now would type the accent as a standalone character; the IME must resolve the
        // combination first.
        assertNull(stroke)
    }

    @Test
    fun anUnresolvableKeyProducesNothing() {
        // getUnicodeChar returns 0 for a key with no printable form. Mapping it to Character(0) would
        // send a NUL byte on every modifier press.
        assertNull(TerminalKeyMapper.map(KeyEvent.KEYCODE_SHIFT_LEFT, metaState = 0, unicodeChar = 0))
        assertNull(TerminalKeyMapper.map(KeyEvent.KEYCODE_UNKNOWN, metaState = 0, unicodeChar = 0))
    }

    // ---- printableMeta ---------------------------------------------------------------------------

    @Test
    fun printableMetaStripsCtrlAndAltAndKeepsShift() {
        val metaState = KeyEvent.META_CTRL_ON or
            KeyEvent.META_CTRL_LEFT_ON or
            KeyEvent.META_ALT_ON or
            KeyEvent.META_ALT_LEFT_ON or
            KeyEvent.META_SHIFT_ON

        val printable = TerminalKeyMapper.printableMeta(metaState)

        // Shift stays because it changes the character; ctrl and alt go because the platform returns
        // 0 for the unicode value while they are set, which would lose the keystroke entirely.
        assertEquals(KeyEvent.META_SHIFT_ON, printable)
    }

    @Test
    fun printableMetaLeavesUnrelatedBitsAlone() {
        val metaState = KeyEvent.META_SHIFT_ON or KeyEvent.META_CAPS_LOCK_ON or KeyEvent.META_NUM_LOCK_ON

        // Caps lock and num lock take part in resolving the character, so stripping them would give
        // the wrong glyph on a physical keyboard.
        assertEquals(metaState, TerminalKeyMapper.printableMeta(metaState))
    }
}
