package one.zephyr.mobile.feature.sessions

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The frozen shortcut matrix and the latch cycle (TERMINAL_EXPERIENCE.md 8.1). */
class ExtraKeysTest {

    @Test
    fun theDefaultLayoutIsTheFrozenTwoRows() {
        assertEquals(8, ExtraKeysLayout.row1.size)
        assertEquals(8, ExtraKeysLayout.row2.size)
        assertEquals(
            listOf("esc", "ctrl", "alt", "tab", "left", "down", "up", "right"),
            ExtraKeysLayout.row1.map { it.id },
        )
        assertEquals(
            listOf("slash", "dash", "pipe", "home", "end", "pgup", "pgdn", "keyboard"),
            ExtraKeysLayout.row2.map { it.id },
        )
    }

    /** Actions must be actions: TERMINAL_EXPERIENCE.md 8.1 forbids disguising them as PTY strings. */
    @Test
    fun keyboardIsAnActionNotAKey() {
        val keyboard = ExtraKeysLayout.byId("keyboard")
        assertTrue(keyboard is ExtraKey.Action)
        assertEquals(TerminalAction.TOGGLE_KEYBOARD, (keyboard as ExtraKey.Action).action)
    }

    @Test
    fun modifiersCarryNoStroke() {
        val ctrl = ExtraKeysLayout.byId("ctrl")
        assertTrue(ctrl is ExtraKey.Modifier)
        assertEquals(KeyModifier.CTRL, (ctrl as ExtraKey.Modifier).modifier)
    }

    @Test
    fun savedOrderIsAppliedAndUnknownIdsAreDropped() {
        val ordered = ExtraKeysLayout.ordered(listOf("tab", "esc", "not-a-key"))
        assertEquals("tab", ordered[0].id)
        assertEquals("esc", ordered[1].id)
        assertEquals(ExtraKeysLayout.all.size, ordered.size)
    }

    @Test
    fun aLayoutSavedByANewerBuildStillProducesAUsableMatrix() {
        val ordered = ExtraKeysLayout.ordered(emptyList())
        assertEquals(ExtraKeysLayout.all.size, ordered.size)
    }

    @Test
    fun latchCyclesOneShotThenLockThenRelease() {
        assertEquals(LatchState.ONE_SHOT, LatchState.OFF.tapped())
        assertEquals(LatchState.LOCKED, LatchState.ONE_SHOT.tapped())
        assertEquals(LatchState.OFF, LatchState.LOCKED.tapped())
    }

    @Test
    fun tappingAModifierOnlyMovesThatModifier() {
        val latches = ModifierLatches().tap(KeyModifier.CTRL)
        assertEquals(LatchState.ONE_SHOT, latches.ctrl)
        assertEquals(LatchState.OFF, latches.alt)
        assertTrue(latches.anyActive)
    }

    @Test
    fun activeLatchesApplyToTheNextStroke() {
        val latches = ModifierLatches().tap(KeyModifier.CTRL).tap(KeyModifier.ALT)
        val stroke = latches.applyTo(TerminalKeyStroke(TerminalKey.Character('f'.code)))
        assertTrue(stroke.ctrl)
        assertTrue(stroke.alt)
        assertFalse(stroke.shift)
    }

    /** Both one-shots must clear together, or the second would leak into the following key. */
    @Test
    fun consumeClearsEveryOneShotAtOnceAndKeepsLocks() {
        val latches = ModifierLatches()
            .tap(KeyModifier.CTRL)
            .tap(KeyModifier.ALT)
            .tap(KeyModifier.SHIFT).tap(KeyModifier.SHIFT)
        assertEquals(LatchState.LOCKED, latches.shift)

        val consumed = latches.consume()
        assertEquals(LatchState.OFF, consumed.ctrl)
        assertEquals(LatchState.OFF, consumed.alt)
        assertEquals(LatchState.LOCKED, consumed.shift)
    }

    @Test
    fun stateOfReadsBackTheTappedModifier() {
        val latches = ModifierLatches().tap(KeyModifier.FN)
        assertEquals(LatchState.ONE_SHOT, latches.stateOf(KeyModifier.FN))
        assertEquals(LatchState.OFF, latches.stateOf(KeyModifier.CTRL))
    }
}
