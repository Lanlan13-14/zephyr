package one.zephyr.mobile.feature.sessions

/**
 * One key on the shortcut matrix.
 *
 * TERMINAL_EXPERIENCE.md 8.1 draws a hard line between keys and actions: `keyboard`, `paste`,
 * `scroll`, `snippets` and `sessions` are actions and must not be disguised as a string sent to the
 * PTY. Modelling that as two subtypes makes the mistake unrepresentable.
 */
sealed interface ExtraKey {
    /** Stable id. Synced as a semantic name, never as a pixel position (spec 8.1). */
    val id: String

    /**
     * What the key shows.
     *
     * On the interface rather than on each subtype so a renderer can label any key without an
     * exhaustive when: a new ExtraKey variant then cannot ship with no visible caption.
     */
    val label: String

    /** A key that produces bytes. */
    data class Key(override val id: String, override val label: String, val stroke: TerminalKeyStroke) : ExtraKey

    /** A latching modifier. Produces no bytes on its own. */
    data class Modifier(override val id: String, override val label: String, val modifier: KeyModifier) : ExtraKey

    /** A UI action. Never reaches the transport. */
    data class Action(override val id: String, override val label: String, val action: TerminalAction) : ExtraKey
}

enum class KeyModifier { CTRL, ALT, SHIFT, FN }

enum class TerminalAction {
    TOGGLE_KEYBOARD,
    PASTE,
    COPY,
    SCROLL_MODE,
    SNIPPETS,
    SESSIONS,
    FILES,
    NOTES,
    STATS,
    THEME,
    DISCONNECT,
}

/**
 * Latch state for one modifier.
 *
 * Three states rather than a boolean because the spec requires single-tap one-shot, double-tap lock
 * and a third tap to release. A boolean could not express "consumed after the next key".
 */
enum class LatchState {
    OFF,

    /** Applies to exactly one following key, then clears. */
    ONE_SHOT,

    /** Applies until explicitly released. */
    LOCKED,
    ;

    val isActive: Boolean get() = this != OFF

    /** Tap cycle: off -> one-shot -> locked -> off. */
    fun tapped(): LatchState = when (this) {
        OFF -> ONE_SHOT
        ONE_SHOT -> LOCKED
        LOCKED -> OFF
    }
}

/**
 * The modifier latches as a unit.
 *
 * Held together rather than as four fields on the controller so [consume] can clear every one-shot
 * atomically: Ctrl+Alt+F with both one-shot must send one keystroke with both modifiers and then
 * clear both, not clear one and leak the other into the next key.
 */
data class ModifierLatches(
    val ctrl: LatchState = LatchState.OFF,
    val alt: LatchState = LatchState.OFF,
    val shift: LatchState = LatchState.OFF,
    val fn: LatchState = LatchState.OFF,
) {
    fun tap(modifier: KeyModifier): ModifierLatches = when (modifier) {
        KeyModifier.CTRL -> copy(ctrl = ctrl.tapped())
        KeyModifier.ALT -> copy(alt = alt.tapped())
        KeyModifier.SHIFT -> copy(shift = shift.tapped())
        KeyModifier.FN -> copy(fn = fn.tapped())
    }

    fun stateOf(modifier: KeyModifier): LatchState = when (modifier) {
        KeyModifier.CTRL -> ctrl
        KeyModifier.ALT -> alt
        KeyModifier.SHIFT -> shift
        KeyModifier.FN -> fn
    }

    /** Modifiers to apply to the next keystroke. */
    fun applyTo(stroke: TerminalKeyStroke): TerminalKeyStroke = stroke.copy(
        ctrl = stroke.ctrl || ctrl.isActive,
        alt = stroke.alt || alt.isActive,
        shift = stroke.shift || shift.isActive,
    )

    /** Clears one-shots, keeps locks. Called after a key is encoded, never before. */
    fun consume(): ModifierLatches = ModifierLatches(
        ctrl = if (ctrl == LatchState.ONE_SHOT) LatchState.OFF else ctrl,
        alt = if (alt == LatchState.ONE_SHOT) LatchState.OFF else alt,
        shift = if (shift == LatchState.ONE_SHOT) LatchState.OFF else shift,
        fn = if (fn == LatchState.ONE_SHOT) LatchState.OFF else fn,
    )

    val anyActive: Boolean get() = ctrl.isActive || alt.isActive || shift.isActive || fn.isActive
}

/**
 * The frozen default layout.
 *
 * TERMINAL_EXPERIENCE.md 8.1 fixes both rows. Reordering is a user preference stored by key id, so
 * the default lives here and a saved order is applied on top by [ordered].
 */
object ExtraKeysLayout {

    val row1: List<ExtraKey> = listOf(
        ExtraKey.Key("esc", "Esc", TerminalKeyStroke(TerminalKey.Escape)),
        ExtraKey.Modifier("ctrl", "Ctrl", KeyModifier.CTRL),
        ExtraKey.Modifier("alt", "Alt", KeyModifier.ALT),
        ExtraKey.Key("tab", "Tab", TerminalKeyStroke(TerminalKey.Tab)),
        ExtraKey.Key("left", "←", TerminalKeyStroke(TerminalKey.ArrowLeft)),
        ExtraKey.Key("down", "↓", TerminalKeyStroke(TerminalKey.ArrowDown)),
        ExtraKey.Key("up", "↑", TerminalKeyStroke(TerminalKey.ArrowUp)),
        ExtraKey.Key("right", "→", TerminalKeyStroke(TerminalKey.ArrowRight)),
    )

    val row2: List<ExtraKey> = listOf(
        ExtraKey.Key("slash", "/", TerminalKeyStroke(TerminalKey.Character('/'.code))),
        ExtraKey.Key("dash", "-", TerminalKeyStroke(TerminalKey.Character('-'.code))),
        ExtraKey.Key("pipe", "|", TerminalKeyStroke(TerminalKey.Character('|'.code))),
        ExtraKey.Key("home", "Home", TerminalKeyStroke(TerminalKey.Home)),
        ExtraKey.Key("end", "End", TerminalKeyStroke(TerminalKey.End)),
        ExtraKey.Key("pgup", "PgUp", TerminalKeyStroke(TerminalKey.PageUp)),
        ExtraKey.Key("pgdn", "PgDn", TerminalKeyStroke(TerminalKey.PageDown)),
        ExtraKey.Action("keyboard", "键盘", TerminalAction.TOGGLE_KEYBOARD),
    )

    val default: List<List<ExtraKey>> = listOf(row1, row2)

    /**
     * Demo `#page-terminal .keyrow` — one horizontal row, system IME instead of a 键盘 key.
     *
     * Esc Tab Ctrl Alt ← ↓ ↑ → | ~ / -
     */
    val demoRow: List<ExtraKey> = listOf(
        ExtraKey.Key("esc", "Esc", TerminalKeyStroke(TerminalKey.Escape)),
        ExtraKey.Key("tab", "Tab", TerminalKeyStroke(TerminalKey.Tab)),
        ExtraKey.Modifier("ctrl", "Ctrl", KeyModifier.CTRL),
        ExtraKey.Modifier("alt", "Alt", KeyModifier.ALT),
        ExtraKey.Key("left", "←", TerminalKeyStroke(TerminalKey.ArrowLeft)),
        ExtraKey.Key("down", "↓", TerminalKeyStroke(TerminalKey.ArrowDown)),
        ExtraKey.Key("up", "↑", TerminalKeyStroke(TerminalKey.ArrowUp)),
        ExtraKey.Key("right", "→", TerminalKeyStroke(TerminalKey.ArrowRight)),
        ExtraKey.Key("pipe", "|", TerminalKeyStroke(TerminalKey.Character('|'.code))),
        ExtraKey.Key("tilde", "~", TerminalKeyStroke(TerminalKey.Character('~'.code))),
        ExtraKey.Key("slash", "/", TerminalKeyStroke(TerminalKey.Character('/'.code))),
        ExtraKey.Key("dash", "-", TerminalKeyStroke(TerminalKey.Character('-'.code))),
    )

    val all: List<ExtraKey> = row1 + row2 + demoRow.filterNot { key ->
        row1.any { it.id == key.id } || row2.any { it.id == key.id }
    }

    fun byId(id: String): ExtraKey? = all.firstOrNull { it.id == id }

    /**
     * Applies a saved order.
     *
     * Unknown ids are dropped and missing ones appended, so a layout saved by a newer build that
     * knows an extra key still produces a usable matrix instead of an empty row.
     */
    fun ordered(savedIds: List<String>): List<ExtraKey> {
        val resolved = savedIds.mapNotNull(::byId)
        val missing = all.filterNot { key -> resolved.any { it.id == key.id } }
        return resolved + missing
    }
}
