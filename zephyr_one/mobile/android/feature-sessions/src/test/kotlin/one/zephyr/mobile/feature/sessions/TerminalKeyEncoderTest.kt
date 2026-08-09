package one.zephyr.mobile.feature.sessions

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The frozen key table from TERMINAL_EXPERIENCE.md 2.10-2.12 and 4.
 *
 * Every expected value here was produced by replaying the xterm rules independently, so a
 * regression in the Kotlin encoder cannot quietly redefine what "correct" means.
 */
class TerminalKeyEncoderTest {

    private fun encode(
        key: TerminalKey,
        ctrl: Boolean = false,
        alt: Boolean = false,
        shift: Boolean = false,
        modes: TerminalModes = TerminalModes(),
        charset: TerminalCharset = TerminalCharset.UTF8,
    ): String = hex(TerminalKeyEncoder.encode(TerminalKeyStroke(key, ctrl, alt, shift), modes, charset))

    @Test
    fun namedKeysMatchXterm() {
        assertEquals("0d", encode(TerminalKey.Enter))
        // DEL rather than BS: this is what bash/readline expect from a mobile backspace.
        assertEquals("7f", encode(TerminalKey.Backspace))
        assertEquals("09", encode(TerminalKey.Tab))
        assertEquals("1b", encode(TerminalKey.Escape))
        assertEquals("1b 5b 33 7e", encode(TerminalKey.Delete))
        assertEquals("1b 5b 32 7e", encode(TerminalKey.Insert))
        assertEquals("1b 5b 35 7e", encode(TerminalKey.PageUp))
        assertEquals("1b 5b 36 7e", encode(TerminalKey.PageDown))
    }

    /** Shift+Tab is back-tab, a distinct sequence rather than a modified Tab. */
    @Test
    fun shiftTabIsBackTab() {
        assertEquals("1b 5b 5a", encode(TerminalKey.Tab, shift = true))
    }

    @Test
    fun arrowsUseSs3OnlyWhenUnmodified() {
        assertEquals("1b 5b 41", encode(TerminalKey.ArrowUp))
        assertEquals("1b 4f 41", encode(TerminalKey.ArrowUp, modes = TerminalModes(applicationCursor = true)))
        // A modifier reverts to CSI even in application-cursor mode; vim's Ctrl+Arrow depends on it.
        assertEquals(
            "1b 5b 31 3b 35 41",
            encode(TerminalKey.ArrowUp, ctrl = true, modes = TerminalModes(applicationCursor = true)),
        )
        assertEquals("1b 5b 31 3b 35 41", encode(TerminalKey.ArrowUp, ctrl = true))
    }

    @Test
    fun arrowFinalsAreDistinct() {
        assertEquals("1b 5b 41", encode(TerminalKey.ArrowUp))
        assertEquals("1b 5b 42", encode(TerminalKey.ArrowDown))
        assertEquals("1b 5b 43", encode(TerminalKey.ArrowRight))
        assertEquals("1b 5b 44", encode(TerminalKey.ArrowLeft))
    }

    /** xterm modifier parameter is 1 + bitmask(shift=1, alt=2, ctrl=4). */
    @Test
    fun modifierParameterFollowsXtermBitmask() {
        assertEquals("1b 5b 31 3b 32 44", encode(TerminalKey.ArrowLeft, shift = true))
        assertEquals("1b 5b 31 3b 33 43", encode(TerminalKey.ArrowRight, alt = true))
        assertEquals("1b 5b 31 3b 35 41", encode(TerminalKey.ArrowUp, ctrl = true))
        assertEquals(
            "1b 5b 31 3b 38 42",
            encode(TerminalKey.ArrowDown, ctrl = true, alt = true, shift = true),
        )
        assertEquals("1b 5b 35 3b 32 7e", encode(TerminalKey.PageUp, shift = true))
    }

    @Test
    fun csiModifierIsNullWhenUnmodified() {
        assertNull(TerminalKeyEncoder.csiModifier(TerminalKeyStroke(TerminalKey.ArrowUp)))
        assertEquals(
            5,
            TerminalKeyEncoder.csiModifier(TerminalKeyStroke(TerminalKey.ArrowUp, ctrl = true)),
        )
    }

    /** Home/End follow the keypad mode as well as the cursor mode, as most hosts do. */
    @Test
    fun homeAndEndFollowKeypadMode() {
        assertEquals("1b 5b 48", encode(TerminalKey.Home))
        assertEquals("1b 5b 46", encode(TerminalKey.End))
        assertEquals("1b 4f 48", encode(TerminalKey.Home, modes = TerminalModes(applicationKeypad = true)))
        assertEquals("1b 5b 31 3b 35 46", encode(TerminalKey.End, ctrl = true))
    }

    @Test
    fun functionKeysSplitBetweenSs3AndCsi() {
        assertEquals("1b 4f 50", encode(TerminalKey.Function(1)))
        assertEquals("1b 4f 53", encode(TerminalKey.Function(4)))
        assertEquals("1b 5b 31 35 7e", encode(TerminalKey.Function(5)))
        assertEquals("1b 5b 32 34 7e", encode(TerminalKey.Function(12)))
        assertEquals("1b 5b 31 3b 35 50", encode(TerminalKey.Function(1), ctrl = true))
        assertEquals("1b 5b 31 35 3b 32 7e", encode(TerminalKey.Function(5), shift = true))
    }

    @Test(expected = IllegalArgumentException::class)
    fun functionKeyIndexIsBounded() {
        TerminalKey.Function(13)
    }

    @Test(expected = IllegalArgumentException::class)
    fun functionKeyIndexHasAFloor() {
        TerminalKey.Function(0)
    }

    /** The full Termux-verified control set (TERMINAL_EXPERIENCE.md 2.10). */
    @Test
    fun controlCharactersCoverTheFullSet() {
        assertEquals("01", encode(TerminalKey.Character('a'.code), ctrl = true))
        assertEquals("03", encode(TerminalKey.Character('c'.code), ctrl = true))
        assertEquals("04", encode(TerminalKey.Character('d'.code), ctrl = true))
        assertEquals("1a", encode(TerminalKey.Character('z'.code), ctrl = true))
        // Upper case maps to the same control byte: Ctrl+Shift+A is still SOH.
        assertEquals("01", encode(TerminalKey.Character('A'.code), ctrl = true))
        assertEquals("00", encode(TerminalKey.Character(' '.code), ctrl = true))
        assertEquals("00", encode(TerminalKey.Character('@'.code), ctrl = true))
        assertEquals("1b", encode(TerminalKey.Character('['.code), ctrl = true))
        assertEquals("1c", encode(TerminalKey.Character('\\'.code), ctrl = true))
        assertEquals("1d", encode(TerminalKey.Character(']'.code), ctrl = true))
        assertEquals("1e", encode(TerminalKey.Character('^'.code), ctrl = true))
        assertEquals("1f", encode(TerminalKey.Character('_'.code), ctrl = true))
        // Both produce DEL, which is readline's backward-kill-word.
        assertEquals("7f", encode(TerminalKey.Character('/'.code), ctrl = true))
        assertEquals("7f", encode(TerminalKey.Character('?'.code), ctrl = true))
    }

    /** A Ctrl combination with no control meaning sends the literal character, not a wrong byte. */
    @Test
    fun ctrlWithoutMeaningSendsTheLiteralCharacter() {
        assertEquals("31", encode(TerminalKey.Character('1'.code), ctrl = true))
        assertNull(TerminalKeyEncoder.controlByte('1'.code))
    }

    /** Alt is an ESC prefix, never the eighth bit: readline Alt+B/Alt+F depend on it. */
    @Test
    fun altPrefixesEscapeRatherThanSettingTheHighBit() {
        assertEquals("1b 62", encode(TerminalKey.Character('b'.code), alt = true))
        assertEquals("1b 66", encode(TerminalKey.Character('f'.code), alt = true))
        assertEquals("1b 03", encode(TerminalKey.Character('c'.code), ctrl = true, alt = true))
    }

    @Test
    fun charactersUseTheSessionCharset() {
        assertEquals("e4 b8 ad", encode(TerminalKey.Character(0x4E2D)))
        // Astral plane: the encoder must build a surrogate pair before encoding.
        assertEquals("f0 9f 98 80", encode(TerminalKey.Character(0x1F600)))
        assertEquals("d6 d0", encode(TerminalKey.Character(0x4E2D), charset = TerminalCharset.GBK))
    }

    /** Escape sequences are ASCII in every charset, so a GBK session must not mangle them. */
    @Test
    fun escapeSequencesBypassTheSessionCharset() {
        assertEquals(
            encode(TerminalKey.ArrowUp),
            encode(TerminalKey.ArrowUp, charset = TerminalCharset.GBK),
        )
        assertEquals(
            encode(TerminalKey.Function(5)),
            encode(TerminalKey.Function(5), charset = TerminalCharset.BIG5),
        )
    }

    @Test
    fun charsetRoundTripsText() {
        for (charset in TerminalCharset.entries) {
            assertEquals("ascii", charset.decode(charset.encode("ascii")))
        }
        assertEquals("\u4e2d\u6587", TerminalCharset.GBK.decode(TerminalCharset.GBK.encode("\u4e2d\u6587")))
    }

    @Test
    fun charsetMapsFromTheStoredEncoding() {
        assertEquals(TerminalCharset.UTF8, TerminalCharset.of(one.zephyr.mobile.model.TerminalEncoding.UTF8))
        assertEquals(TerminalCharset.GBK, TerminalCharset.of(one.zephyr.mobile.model.TerminalEncoding.GBK))
        assertEquals(TerminalCharset.BIG5, TerminalCharset.of(one.zephyr.mobile.model.TerminalEncoding.BIG5))
        assertEquals(TerminalCharset.LATIN1, TerminalCharset.of(one.zephyr.mobile.model.TerminalEncoding.LATIN1))
    }

    /**
     * Shift+PageUp/PageDown scroll the local transcript and must never reach the PTY
     * (TERMINAL_EXPERIENCE.md 2.12).
     */
    @Test
    fun shiftPageKeysAreLocalScroll() {
        assertTrue(TerminalKeyEncoder.isLocalScrollKey(TerminalKeyStroke(TerminalKey.PageUp, shift = true)))
        assertTrue(TerminalKeyEncoder.isLocalScrollKey(TerminalKeyStroke(TerminalKey.PageDown, shift = true)))
        assertFalse(TerminalKeyEncoder.isLocalScrollKey(TerminalKeyStroke(TerminalKey.PageUp)))
        // Ctrl+Shift+PageUp is a different binding and belongs to the remote program.
        assertFalse(
            TerminalKeyEncoder.isLocalScrollKey(
                TerminalKeyStroke(TerminalKey.PageUp, ctrl = true, shift = true),
            ),
        )
        assertFalse(TerminalKeyEncoder.isLocalScrollKey(TerminalKeyStroke(TerminalKey.ArrowUp, shift = true)))
    }

    @Test
    fun strokeReportsWhetherItHasAModifier() {
        assertFalse(TerminalKeyStroke(TerminalKey.Enter).hasModifier)
        assertTrue(TerminalKeyStroke(TerminalKey.Enter, ctrl = true).hasModifier)
        assertTrue(TerminalKeyStroke(TerminalKey.Enter, alt = true).hasModifier)
        assertTrue(TerminalKeyStroke(TerminalKey.Enter, shift = true).hasModifier)
    }
}
