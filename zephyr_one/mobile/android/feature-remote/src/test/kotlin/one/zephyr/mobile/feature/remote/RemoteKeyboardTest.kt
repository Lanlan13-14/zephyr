package one.zephyr.mobile.feature.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * S22/S23 keyboard mapping.
 *
 * The scan codes and keysyms here are transcribed from the protocol specifications, not from the
 * implementation, so a table edited by hand fails rather than agreeing with itself.
 */
class RemoteKeyboardTest {

    // ---- neutral key model -----------------------------------------------------------------------

    @Test
    fun aFunctionKeyOutsideF1ToF12IsRefusedAtConstruction() {
        /* Rejected in the constructor rather than at the mapping call, because a bad index would
         * otherwise compute a plausible-looking scan code: 0x3A + 13 is a real key, just the wrong
         * one. */
        for (index in intArrayOf(0, -1, 13, 25)) {
            var threw = false
            try {
                RemoteKey.Function(index)
            } catch (expected: IllegalArgumentException) {
                threw = true
            }
            assertTrue("index " + index + " must be refused", threw)
        }
        assertEquals(1, RemoteKey.Function(1).index)
        assertEquals(12, RemoteKey.Function(RemoteKey.Function.MAX_INDEX).index)
    }

    @Test
    fun shiftIsNotAShortcutModifierButTheOtherThreeAre() {
        /* The whole Ctrl+C rule rests on this: a shifted character arrives already shifted from the
         * IME, while Ctrl, Alt and Win turn a character into a program-level shortcut. */
        assertFalse(RemoteModifier.SHIFT.isShortcutModifier)
        assertTrue(RemoteModifier.CTRL.isShortcutModifier)
        assertTrue(RemoteModifier.ALT.isShortcutModifier)
        assertTrue(RemoteModifier.META.isShortcutModifier)
    }

    @Test
    fun theMetaModifierIsLabelledWinRatherThanMeta() {
        // Section 6 freezes the user-visible name; "Meta" would not be recognised on the dock.
        assertEquals("Win", RemoteModifier.META.label)
        assertEquals("Ctrl", RemoteModifier.CTRL.label)
        assertEquals("Alt", RemoteModifier.ALT.label)
        assertEquals("Shift", RemoteModifier.SHIFT.label)
    }

    @Test
    fun aLatchTogglesOnAndOffAndReportsShortcutModifiersOnly() {
        val empty = RemoteModifierLatches()
        assertFalse(empty.hasShortcutModifier)

        val shifted = empty.toggle(RemoteModifier.SHIFT)
        assertEquals(setOf(RemoteModifier.SHIFT), shifted.active)
        // Shift alone must not route text through the key path, or every capital letter would be
        // decomposed into keystrokes and an IME commit would break.
        assertFalse(shifted.hasShortcutModifier)

        val withCtrl = shifted.toggle(RemoteModifier.CTRL)
        assertTrue(withCtrl.hasShortcutModifier)

        val ctrlOff = withCtrl.toggle(RemoteModifier.CTRL)
        assertEquals(setOf(RemoteModifier.SHIFT), ctrlOff.active)
        assertFalse(ctrlOff.hasShortcutModifier)

        assertEquals(emptySet<RemoteModifier>(), withCtrl.cleared().active)
    }

    // ---- RDP scan codes --------------------------------------------------------------------------

    @Test
    fun theNavigationBlockIsExtendedAndTheTypewriterBlockIsNot() {
        /* The 0xE0 prefix is what distinguishes the grey navigation keys from the numeric keypad on a
         * PC/XT keyboard. Dropping it makes Delete arrive as keypad "." in the remote session. */
        for (key in listOf<RemoteKey>(
            RemoteKey.Insert, RemoteKey.Delete, RemoteKey.Home, RemoteKey.End,
            RemoteKey.PageUp, RemoteKey.PageDown, RemoteKey.ArrowUp, RemoteKey.ArrowDown,
            RemoteKey.ArrowLeft, RemoteKey.ArrowRight, RemoteKey.Menu, RemoteKey.PrintScreen,
        )) {
            val scan = RdpKeyMap.scanCode(key)
            assertTrue(labelOf(key) + " must map", scan != null)
            assertTrue(labelOf(key) + " must be extended", scan!!.extended)
        }
        for (key in listOf<RemoteKey>(
            RemoteKey.Escape, RemoteKey.Backspace, RemoteKey.Tab, RemoteKey.Enter,
            RemoteKey.Space, RemoteKey.CapsLock,
        )) {
            assertFalse(labelOf(key) + " must not be extended", RdpKeyMap.scanCode(key)!!.extended)
        }
    }

    @Test
    fun theNamedScanCodesAreTheSetOneMakeCodes() {
        assertEquals(RdpScanCode(0x01), RdpKeyMap.scanCode(RemoteKey.Escape))
        assertEquals(RdpScanCode(0x0E), RdpKeyMap.scanCode(RemoteKey.Backspace))
        assertEquals(RdpScanCode(0x0F), RdpKeyMap.scanCode(RemoteKey.Tab))
        assertEquals(RdpScanCode(0x1C), RdpKeyMap.scanCode(RemoteKey.Enter))
        assertEquals(RdpScanCode(0x39), RdpKeyMap.scanCode(RemoteKey.Space))
        assertEquals(RdpScanCode(0x3A), RdpKeyMap.scanCode(RemoteKey.CapsLock))
        assertEquals(RdpScanCode(0x53, extended = true), RdpKeyMap.scanCode(RemoteKey.Delete))
        assertEquals(RdpScanCode(0x48, extended = true), RdpKeyMap.scanCode(RemoteKey.ArrowUp))
    }

    @Test
    fun functionKeysAreContiguousExceptF11AndF12() {
        /* F1..F10 run from 0x3B, then the two keys added later sit at 0x57/0x58 rather than continuing
         * the run. A loop that assumed contiguity would send F11 as the keypad. */
        for (index in 1..10) {
            assertEquals(
                "F" + index,
                RdpScanCode(0x3A + index),
                RdpKeyMap.scanCode(RemoteKey.Function(index)),
            )
        }
        assertEquals(RdpScanCode(0x57), RdpKeyMap.scanCode(RemoteKey.Function(11)))
        assertEquals(RdpScanCode(0x58), RdpKeyMap.scanCode(RemoteKey.Function(12)))
        // Function keys are base codes, never extended.
        assertFalse(RdpKeyMap.scanCode(RemoteKey.Function(12))!!.extended)
    }

    @Test
    fun rightShiftIsItsOwnCodeWhileRightCtrlAndAltAreExtended() {
        /* Three different encodings for "the right-hand one", which is why this is a table rather than
         * a rule: right Shift is a distinct base code, right Ctrl/Alt reuse the left code with the
         * 0xE0 prefix, and the two Win keys are separate extended codes. */
        assertEquals(RdpScanCode(0x2A), RdpKeyMap.scanCode(RemoteKey.Modifier(RemoteModifier.SHIFT)))
        assertEquals(
            RdpScanCode(0x36),
            RdpKeyMap.scanCode(RemoteKey.Modifier(RemoteModifier.SHIFT, right = true)),
        )
        assertEquals(RdpScanCode(0x1D), RdpKeyMap.scanCode(RemoteKey.Modifier(RemoteModifier.CTRL)))
        assertEquals(
            RdpScanCode(0x1D, extended = true),
            RdpKeyMap.scanCode(RemoteKey.Modifier(RemoteModifier.CTRL, right = true)),
        )
        assertEquals(RdpScanCode(0x38), RdpKeyMap.scanCode(RemoteKey.Modifier(RemoteModifier.ALT)))
        assertEquals(
            RdpScanCode(0x38, extended = true),
            RdpKeyMap.scanCode(RemoteKey.Modifier(RemoteModifier.ALT, right = true)),
        )
        assertEquals(
            RdpScanCode(0x5B, extended = true),
            RdpKeyMap.scanCode(RemoteKey.Modifier(RemoteModifier.META)),
        )
        assertEquals(
            RdpScanCode(0x5C, extended = true),
            RdpKeyMap.scanCode(RemoteKey.Modifier(RemoteModifier.META, right = true)),
        )
    }

    @Test
    fun aPrintableCharacterHasNoScanCodeSoItTakesTheUnicodePath() {
        /* Returning null rather than guessing is the layout-independence rule: a scan code names a
         * physical key and the *remote* layout decides what it produces, so guessing 0x1E for "a"
         * types "q" on an AZERTY host. */
        assertNull(RdpKeyMap.scanCode(RemoteKey.Character('a'.code)))
        assertNull(RdpKeyMap.scanCode(RemoteKey.Character(0x4F60)))
        assertNull(RdpKeyMap.scanCode(RemoteKey.Character(0x1F600)))
    }

    @Test
    fun theRdpTableIsCompleteEnoughToDisplay() {
        // Section 6 requires the mapping to be viewable; 18 named + 8 modifiers + 12 function keys.
        val table = RdpKeyMap.table()
        assertEquals(38, table.size)
        val labels = table.map { it.first }
        assertTrue(labels.contains("Esc"))
        assertTrue(labels.contains("F11"))
        assertTrue(labels.contains("Ctrl (right)"))
        assertTrue(labels.contains("Win"))
    }

    // ---- VNC keysyms -----------------------------------------------------------------------------

    @Test
    fun latin1CodePointsAreTheirOwnKeysym() {
        /* The property that makes a printable character need no table at all: X11 chose Latin-1 as the
         * low keysym range, so the code point and the keysym are the same number. */
        assertEquals(0x61, VncKeyMap.characterKeysym('a'.code))
        assertEquals(0x20, VncKeyMap.characterKeysym(0x20))
        assertEquals(0xFF, VncKeyMap.characterKeysym(VncKeyMap.LATIN1_MAX))
    }

    @Test
    fun anythingAboveLatin1UsesTheUnicodeOffset() {
        assertEquals(0x0100_0100, VncKeyMap.characterKeysym(0x100))
        assertEquals(0x0100_4F60, VncKeyMap.characterKeysym(0x4F60))
        assertEquals(0x0101_F600, VncKeyMap.characterKeysym(0x1F600))
    }

    @Test
    fun aControlCodePointTakesTheUnicodeOffsetRatherThanPassingThrough() {
        /* Below 0x20 the Latin-1 identity does not hold: keysyms 0x00-0x1F are unassigned, so a raw
         * control character has to go through the Unicode plane or it would name no key at all. */
        assertEquals(VncKeyMap.UNICODE_OFFSET + 0x09, VncKeyMap.characterKeysym(0x09))
        assertEquals(VncKeyMap.UNICODE_OFFSET + 0x00, VncKeyMap.characterKeysym(0x00))
        // The boundary itself is inside the identity range.
        assertNotEquals(VncKeyMap.UNICODE_OFFSET + 0x20, VncKeyMap.characterKeysym(0x20))
    }

    @Test
    fun theNamedKeysymsAreTheX11Values() {
        assertEquals(0xFF1B, VncKeyMap.keysym(RemoteKey.Escape))
        assertEquals(0xFF08, VncKeyMap.keysym(RemoteKey.Backspace))
        assertEquals(0xFF09, VncKeyMap.keysym(RemoteKey.Tab))
        assertEquals(0xFF0D, VncKeyMap.keysym(RemoteKey.Enter))
        // Space is a printable character, so its keysym is its code point, not an 0xFFxx value.
        assertEquals(0x0020, VncKeyMap.keysym(RemoteKey.Space))
        assertEquals(0xFFFF, VncKeyMap.keysym(RemoteKey.Delete))
        assertEquals(0xFF50, VncKeyMap.keysym(RemoteKey.Home))
        assertEquals(0xFF57, VncKeyMap.keysym(RemoteKey.End))
    }

    @Test
    fun theArrowKeysymsAreInTheX11OrderNotTheUiOrder() {
        /* X11 orders them Left, Up, Right, Down. Assuming the visual Up/Down/Left/Right order of the
         * modifier bar would swap two of the four arrows in every remote application. */
        assertEquals(0xFF51, VncKeyMap.keysym(RemoteKey.ArrowLeft))
        assertEquals(0xFF52, VncKeyMap.keysym(RemoteKey.ArrowUp))
        assertEquals(0xFF53, VncKeyMap.keysym(RemoteKey.ArrowRight))
        assertEquals(0xFF54, VncKeyMap.keysym(RemoteKey.ArrowDown))
    }

    @Test
    fun functionKeysymsAreContiguousFromF1() {
        for (index in 1..RemoteKey.Function.MAX_INDEX) {
            assertEquals(
                "F" + index,
                0xFFBE + (index - 1),
                VncKeyMap.keysym(RemoteKey.Function(index)),
            )
        }
        assertEquals(0xFFC9, VncKeyMap.keysym(RemoteKey.Function(12)))
    }

    @Test
    fun metaMapsToSuperRatherThanToX11Meta() {
        /* X11 Meta_L (0xFFE7) is a different key from Super_L (0xFFEB), and every mainstream desktop
         * binds its window-manager shortcuts to Super. Mapping Win to Meta_L would make the Win key
         * do nothing on the far side. */
        assertEquals(0xFFEB, VncKeyMap.keysym(RemoteKey.Modifier(RemoteModifier.META)))
        assertEquals(0xFFEC, VncKeyMap.keysym(RemoteKey.Modifier(RemoteModifier.META, right = true)))
        assertNotEquals(0xFFE7, VncKeyMap.keysym(RemoteKey.Modifier(RemoteModifier.META)))
    }

    @Test
    fun everyModifierHasBothALeftAndARightKeysym() {
        for (modifier in RemoteModifier.entries) {
            val left = VncKeyMap.keysym(RemoteKey.Modifier(modifier))
            val right = VncKeyMap.keysym(RemoteKey.Modifier(modifier, right = true))
            assertTrue(modifier.name + " left", left != null)
            assertTrue(modifier.name + " right", right != null)
            // Distinct, or a right-modifier release would clear the left one on the far side.
            assertNotEquals(modifier.name, left, right)
        }
    }

    @Test
    fun everyNeutralKeyIsTypableOnAtLeastOneProtocol() {
        /* The two maps have complementary gaps by design: RDP returns null for a character and VNC
         * covers it arithmetically. This asserts the union is total, which is the property that makes
         * "no mapping" a bug rather than an expected outcome. */
        val keys = listOf<RemoteKey>(
            RemoteKey.Escape, RemoteKey.Enter, RemoteKey.Backspace, RemoteKey.Tab, RemoteKey.Space,
            RemoteKey.Delete, RemoteKey.Insert, RemoteKey.Home, RemoteKey.End, RemoteKey.PageUp,
            RemoteKey.PageDown, RemoteKey.ArrowUp, RemoteKey.ArrowDown, RemoteKey.ArrowLeft,
            RemoteKey.ArrowRight, RemoteKey.CapsLock, RemoteKey.Menu, RemoteKey.PrintScreen,
            RemoteKey.Function(1), RemoteKey.Function(12),
            RemoteKey.Modifier(RemoteModifier.CTRL), RemoteKey.Modifier(RemoteModifier.META, right = true),
            RemoteKey.Character('a'.code), RemoteKey.Character(0x4F60),
        )
        for (key in keys) {
            val rdp = RdpKeyMap.scanCode(key)
            val vnc = VncKeyMap.keysym(key)
            assertTrue(labelOf(key) + " is typable on neither protocol", rdp != null || vnc != null)
        }
    }

    // ---- labels and the modifier bar -------------------------------------------------------------

    @Test
    fun aCharacterKeyLabelsAsItselfIncludingOutsideTheBmp() {
        assertEquals("a", labelOf(RemoteKey.Character('a'.code)))
        assertEquals("\u4F60", labelOf(RemoteKey.Character(0x4F60)))
        // toChars, not toChar: an astral code point is a surrogate pair and would otherwise truncate.
        assertEquals(2, labelOf(RemoteKey.Character(0x1F600)).length)
    }

    @Test
    fun everyLabelIsShortEnoughForAModifierBarKey() {
        /* The bar is one row of 48dp targets, so a label is at most five characters. This is the
         * cheapest guard against a future key being labelled "PrintScreen" and reflowing the row. */
        for (key in RemoteModifierBar.keys) {
            assertTrue(labelOf(key) + " is too long for the bar", labelOf(key).length <= 5)
        }
        assertEquals("PrtSc", labelOf(RemoteKey.PrintScreen))
        assertEquals("PgUp", labelOf(RemoteKey.PageUp))
    }

    @Test
    fun theModifierBarCarriesTheFourLatchesAndTheSixKeysAnImeCannotProduce() {
        assertEquals(
            listOf(RemoteModifier.CTRL, RemoteModifier.ALT, RemoteModifier.SHIFT, RemoteModifier.META),
            RemoteModifierBar.modifiers,
        )
        assertEquals(
            listOf<RemoteKey>(
                RemoteKey.Escape, RemoteKey.Tab,
                RemoteKey.ArrowLeft, RemoteKey.ArrowDown, RemoteKey.ArrowUp, RemoteKey.ArrowRight,
            ),
            RemoteModifierBar.keys,
        )
        // Every bar entry must be sendable on both protocols, or a visible key would do nothing.
        for (key in RemoteModifierBar.keys) {
            assertTrue(labelOf(key), RdpKeyMap.scanCode(key) != null)
            assertTrue(labelOf(key), VncKeyMap.keysym(key) != null)
        }
    }

    // ---- text routing ----------------------------------------------------------------------------

    @Test
    fun plainTextTravelsAsTextSoAnImeCommitSurvives() {
        /* The text channel is the only one that can carry a CJK commit: decomposing it into key events
         * would require a scan code per ideograph, which no keyboard layout has. */
        val events = RemoteTextPolicy.route("\u4F60\u597D", RemoteModifierLatches())
        assertEquals(listOf<RemoteInput>(RemoteInput.Text("\u4F60\u597D")), events)
    }

    @Test
    fun shiftAloneStillCountsAsPlainText() {
        // A capital letter arrives already capitalised; decomposing it would send Shift twice.
        val latches = RemoteModifierLatches(setOf(RemoteModifier.SHIFT))
        assertEquals(listOf<RemoteInput>(RemoteInput.Text("A")), RemoteTextPolicy.route("A", latches))
    }

    @Test
    fun emptyTextProducesNothingRatherThanAnEmptyTextEvent() {
        assertEquals(emptyList<RemoteInput>(), RemoteTextPolicy.route("", RemoteModifierLatches()))
        assertEquals(
            emptyList<RemoteInput>(),
            RemoteTextPolicy.route("", RemoteModifierLatches(setOf(RemoteModifier.CTRL))),
        )
    }

    @Test
    fun ctrlPlusCIsDeliveredAsKeystrokesNotAsTheStringC() {
        /* The frozen rule in section 6. Sending "c" as text with Ctrl held would type the letter into
         * the remote application instead of copying. */
        val latches = RemoteModifierLatches(setOf(RemoteModifier.CTRL))
        val events = RemoteTextPolicy.route("c", latches)
        assertEquals(
            listOf<RemoteInput>(
                RemoteInput.Key(RemoteKey.Modifier(RemoteModifier.CTRL), down = true),
                RemoteInput.Key(RemoteKey.Character('c'.code), down = true),
                RemoteInput.Key(RemoteKey.Character('c'.code), down = false),
                RemoteInput.Key(RemoteKey.Modifier(RemoteModifier.CTRL), down = false),
            ),
            events,
        )
    }

    @Test
    fun shiftIsNotSentAsPartOfAShortcutChordFromText() {
        /* route() decomposes with the *shortcut* modifiers only. Ctrl+Shift+letter arrives from the
         * IME already uppercased, so re-sending Shift would produce Ctrl+Shift+Shift+C. */
        val latches = RemoteModifierLatches(setOf(RemoteModifier.CTRL, RemoteModifier.SHIFT))
        val events = RemoteTextPolicy.route("C", latches)
        assertEquals(4, events.size)
        val modifiersSent = events.filterIsInstance<RemoteInput.Key>()
            .mapNotNull { (it.key as? RemoteKey.Modifier)?.modifier }
            .toSet()
        assertEquals(setOf(RemoteModifier.CTRL), modifiersSent)
    }

    @Test
    fun anAstralCharacterIsOneKeystrokeNotTwoSurrogates() {
        /* codePointAt plus charCount rather than an index walk: iterating chars would send each half of
         * a surrogate pair as its own keysym, which names no character at all. */
        val latches = RemoteModifierLatches(setOf(RemoteModifier.ALT))
        val events = RemoteTextPolicy.route("\uD83D\uDE00", latches)
        assertEquals(4, events.size)
        val characters = events.filterIsInstance<RemoteInput.Key>()
            .mapNotNull { it.key as? RemoteKey.Character }
        assertEquals(2, characters.size)
        assertEquals(0x1F600, characters[0].codePoint)
        assertEquals(0x1F600, characters[1].codePoint)
    }

    @Test
    fun aChordUnwindsInReverseLikeAPhysicalKeyboard() {
        val latches = RemoteModifierLatches(setOf(RemoteModifier.CTRL, RemoteModifier.ALT))
        val events = RemoteTextPolicy.chord(RemoteKey.Delete, latches)
        assertEquals(6, events.size)

        val downModifiers = events.take(2).map { (it as RemoteInput.Key).key }
        val upModifiers = events.takeLast(2).map { (it as RemoteInput.Key).key }
        assertEquals(downModifiers.reversed(), upModifiers)
        assertTrue(events.take(2).all { (it as RemoteInput.Key).down })
        assertTrue(events.takeLast(2).none { (it as RemoteInput.Key).down })

        assertEquals(RemoteInput.Key(RemoteKey.Delete, down = true), events[2])
        assertEquals(RemoteInput.Key(RemoteKey.Delete, down = false), events[3])
    }

    @Test
    fun aChordSendsShiftWhereRoutedTextWouldNot() {
        /* The one deliberate asymmetry between the two entry points: a chord comes from the modifier
         * bar, where the user pressed Shift explicitly, so Shift+F10 has to include it. Routed text
         * comes from the IME, which already applied Shift to the character. */
        val latches = RemoteModifierLatches(setOf(RemoteModifier.SHIFT))
        val chord = RemoteTextPolicy.chord(RemoteKey.Function(10), latches)
        assertEquals(4, chord.size)
        assertEquals(RemoteInput.Key(RemoteKey.Modifier(RemoteModifier.SHIFT), down = true), chord[0])
        assertEquals(RemoteInput.Key(RemoteKey.Modifier(RemoteModifier.SHIFT), down = false), chord[3])

        assertEquals(listOf<RemoteInput>(RemoteInput.Text("x")), RemoteTextPolicy.route("x", latches))
    }

    @Test
    fun anUnlatchedChordIsJustTheKeyDownAndUp() {
        val events = RemoteTextPolicy.chord(RemoteKey.Escape, RemoteModifierLatches())
        assertEquals(
            listOf<RemoteInput>(
                RemoteInput.Key(RemoteKey.Escape, down = true),
                RemoteInput.Key(RemoteKey.Escape, down = false),
            ),
            events,
        )
    }
}
