package one.zephyr.mobile.feature.remote

/**
 * A key as the UI knows it, before either protocol has seen it.
 *
 * Deliberately not a scan code and not a keysym: RDP wants PC/XT set-1 make codes and VNC wants X11
 * keysyms, and REMOTE_DESKTOP_EXPERIENCE.md 6 requires the mapping to be viewable and modifiable.
 * Keeping the neutral name as the type means one modifier bar, one shortcut table and one override
 * map serve both protocols, and a missing mapping is a null from one lookup rather than a wrong byte
 * on the wire.
 */
sealed interface RemoteKey {

    data object Escape : RemoteKey
    data object Enter : RemoteKey
    data object Backspace : RemoteKey
    data object Tab : RemoteKey
    data object Space : RemoteKey
    data object Delete : RemoteKey
    data object Insert : RemoteKey
    data object Home : RemoteKey
    data object End : RemoteKey
    data object PageUp : RemoteKey
    data object PageDown : RemoteKey
    data object ArrowUp : RemoteKey
    data object ArrowDown : RemoteKey
    data object ArrowLeft : RemoteKey
    data object ArrowRight : RemoteKey
    data object CapsLock : RemoteKey
    data object Menu : RemoteKey
    data object PrintScreen : RemoteKey

    /** A modifier pressed on its own, which is how a latching modifier bar sends Ctrl or Win. */
    data class Modifier(val modifier: RemoteModifier, val right: Boolean = false) : RemoteKey

    /** F1..F12. */
    data class Function(val index: Int) : RemoteKey {
        init {
            require(index in 1..MAX_INDEX) { "function key index must be within 1.." + MAX_INDEX }
        }

        companion object {
            const val MAX_INDEX = 12
        }
    }

    /** One Unicode code point. Latin-1 maps straight onto an X11 keysym; RDP needs a Unicode event. */
    data class Character(val codePoint: Int) : RemoteKey
}

/**
 * The four modifiers both protocols carry.
 *
 * META is the platform key: REMOTE_DESKTOP_EXPERIENCE.md 6 freezes that RDP maps it to Win and VNC
 * maps it through X key mapping, so the neutral name is what the UI shows and the per-protocol table
 * decides what goes on the wire.
 */
enum class RemoteModifier(val label: String) {
    CTRL("Ctrl"),
    ALT("Alt"),
    SHIFT("Shift"),
    META("Win"),
    ;

    /**
     * Whether this modifier changes the *meaning* of a keystroke rather than the character it
     * produces.
     *
     * Shift is excluded because a shifted character already arrives shifted from the IME; the other
     * three turn a character into a program-level shortcut, which is the distinction section 6
     * depends on when it forbids sending Ctrl+C as ordinary text.
     */
    val isShortcutModifier: Boolean get() = this != SHIFT
}

/** A latched modifier state, so the bar can hold Ctrl down across the next keystroke. */
data class RemoteModifierLatches(val active: Set<RemoteModifier> = emptySet()) {

    fun toggle(modifier: RemoteModifier): RemoteModifierLatches =
        if (modifier in active) RemoteModifierLatches(active - modifier) else RemoteModifierLatches(active + modifier)

    val hasShortcutModifier: Boolean get() = active.any { it.isShortcutModifier }

    fun cleared(): RemoteModifierLatches = RemoteModifierLatches()
}

/** One RDP scan code. [extended] is the 0xE0 prefix, not a value that can be folded into the code. */
data class RdpScanCode(val code: Int, val extended: Boolean = false)

/**
 * RDP keyboard mapping.
 *
 * PC/XT set-1 make codes, which is what the RDP fastpath input PDU carries. The extended flag is a
 * separate field rather than an 0xE0-prefixed integer because that is how the protocol encodes it,
 * and folding the prefix into the number would make right-Ctrl indistinguishable from left-Ctrl at
 * the call site.
 */
object RdpKeyMap {

    private val named: Map<RemoteKey, RdpScanCode> = mapOf(
        RemoteKey.Escape to RdpScanCode(0x01),
        RemoteKey.Backspace to RdpScanCode(0x0E),
        RemoteKey.Tab to RdpScanCode(0x0F),
        RemoteKey.Enter to RdpScanCode(0x1C),
        RemoteKey.Space to RdpScanCode(0x39),
        RemoteKey.CapsLock to RdpScanCode(0x3A),
        // The navigation block is the grey-key set, so every entry below is extended.
        RemoteKey.Insert to RdpScanCode(0x52, extended = true),
        RemoteKey.Delete to RdpScanCode(0x53, extended = true),
        RemoteKey.Home to RdpScanCode(0x47, extended = true),
        RemoteKey.End to RdpScanCode(0x4F, extended = true),
        RemoteKey.PageUp to RdpScanCode(0x49, extended = true),
        RemoteKey.PageDown to RdpScanCode(0x51, extended = true),
        RemoteKey.ArrowUp to RdpScanCode(0x48, extended = true),
        RemoteKey.ArrowDown to RdpScanCode(0x50, extended = true),
        RemoteKey.ArrowLeft to RdpScanCode(0x4B, extended = true),
        RemoteKey.ArrowRight to RdpScanCode(0x4D, extended = true),
        RemoteKey.Menu to RdpScanCode(0x5D, extended = true),
        RemoteKey.PrintScreen to RdpScanCode(0x37, extended = true),
    )

    private val modifiers: Map<Pair<RemoteModifier, Boolean>, RdpScanCode> = mapOf(
        (RemoteModifier.CTRL to false) to RdpScanCode(0x1D),
        (RemoteModifier.CTRL to true) to RdpScanCode(0x1D, extended = true),
        (RemoteModifier.SHIFT to false) to RdpScanCode(0x2A),
        // Right shift is a distinct base code rather than an extended left shift.
        (RemoteModifier.SHIFT to true) to RdpScanCode(0x36),
        (RemoteModifier.ALT to false) to RdpScanCode(0x38),
        (RemoteModifier.ALT to true) to RdpScanCode(0x38, extended = true),
        // Meta becomes Win, which section 6 freezes as the RDP default.
        (RemoteModifier.META to false) to RdpScanCode(0x5B, extended = true),
        (RemoteModifier.META to true) to RdpScanCode(0x5C, extended = true),
    )

    /**
     * @return null for a printable character, which RDP sends as a Unicode event instead. Returning
     *   null rather than guessing a scan code is what keeps a non-US layout from typing the wrong
     *   glyph: the scan code names a physical key, and the remote layout decides what it produces.
     */
    fun scanCode(key: RemoteKey): RdpScanCode? = when (key) {
        is RemoteKey.Function -> RdpScanCode(functionCode(key.index))
        is RemoteKey.Modifier -> modifiers[key.modifier to key.right]
        is RemoteKey.Character -> null
        else -> named[key]
    }

    /** F1..F10 are contiguous from 0x3B; F11 and F12 sit apart at 0x57/0x58. */
    private fun functionCode(index: Int): Int = when (index) {
        11 -> 0x57
        12 -> 0x58
        else -> 0x3A + index
    }

    /** The table as rows, so the settings page can show the mapping section 6 requires. */
    fun table(): List<Pair<String, RdpScanCode>> = buildList {
        for ((key, code) in named) add(labelOf(key) to code)
        for ((pair, code) in modifiers) {
            val suffix = if (pair.second) " (right)" else ""
            add(pair.first.label + suffix to code)
        }
        for (index in 1..RemoteKey.Function.MAX_INDEX) {
            add("F" + index to RdpScanCode(functionCode(index)))
        }
    }
}

/**
 * VNC keyboard mapping.
 *
 * X11 keysyms, which RFB KeyEvent carries directly. Latin-1 code points *are* their own keysyms and
 * anything above that uses the 0x01000000 Unicode offset, so a printable character needs no table at
 * all - which is why this returns a value where [RdpKeyMap.scanCode] returns null.
 */
object VncKeyMap {

    const val UNICODE_OFFSET = 0x0100_0000
    const val LATIN1_MAX = 0xFF

    private val named: Map<RemoteKey, Int> = mapOf(
        RemoteKey.Escape to 0xFF1B,
        RemoteKey.Backspace to 0xFF08,
        RemoteKey.Tab to 0xFF09,
        RemoteKey.Enter to 0xFF0D,
        RemoteKey.Space to 0x0020,
        RemoteKey.CapsLock to 0xFFE5,
        RemoteKey.Insert to 0xFF63,
        RemoteKey.Delete to 0xFFFF,
        RemoteKey.Home to 0xFF50,
        RemoteKey.End to 0xFF57,
        RemoteKey.PageUp to 0xFF55,
        RemoteKey.PageDown to 0xFF56,
        RemoteKey.ArrowLeft to 0xFF51,
        RemoteKey.ArrowUp to 0xFF52,
        RemoteKey.ArrowRight to 0xFF53,
        RemoteKey.ArrowDown to 0xFF54,
        RemoteKey.Menu to 0xFF67,
        RemoteKey.PrintScreen to 0xFF61,
    )

    private val modifiers: Map<Pair<RemoteModifier, Boolean>, Int> = mapOf(
        (RemoteModifier.CTRL to false) to 0xFFE3,
        (RemoteModifier.CTRL to true) to 0xFFE4,
        (RemoteModifier.SHIFT to false) to 0xFFE1,
        (RemoteModifier.SHIFT to true) to 0xFFE2,
        (RemoteModifier.ALT to false) to 0xFFE9,
        (RemoteModifier.ALT to true) to 0xFFEA,
        // Super, not Meta: X11 Meta_L is a different key, and every mainstream desktop binds its
        // window-manager shortcuts to Super.
        (RemoteModifier.META to false) to 0xFFEB,
        (RemoteModifier.META to true) to 0xFFEC,
    )

    fun keysym(key: RemoteKey): Int? = when (key) {
        is RemoteKey.Function -> 0xFFBE + (key.index - 1)
        is RemoteKey.Modifier -> modifiers[key.modifier to key.right]
        is RemoteKey.Character -> characterKeysym(key.codePoint)
        else -> named[key]
    }

    fun characterKeysym(codePoint: Int): Int =
        if (codePoint in 0x20..LATIN1_MAX) codePoint else codePoint + UNICODE_OFFSET

    fun table(): List<Pair<String, Int>> = buildList {
        for ((key, sym) in named) add(labelOf(key) to sym)
        for ((pair, sym) in modifiers) {
            val suffix = if (pair.second) " (right)" else ""
            add(pair.first.label + suffix to sym)
        }
        for (index in 1..RemoteKey.Function.MAX_INDEX) {
            add("F" + index to 0xFFBE + (index - 1))
        }
    }
}

/** A display name for the mapping table and for the accessibility label on a modifier-bar key. */
fun labelOf(key: RemoteKey): String = when (key) {
    RemoteKey.Escape -> "Esc"
    RemoteKey.Enter -> "Enter"
    RemoteKey.Backspace -> "Backspace"
    RemoteKey.Tab -> "Tab"
    RemoteKey.Space -> "Space"
    RemoteKey.Delete -> "Delete"
    RemoteKey.Insert -> "Insert"
    RemoteKey.Home -> "Home"
    RemoteKey.End -> "End"
    RemoteKey.PageUp -> "PgUp"
    RemoteKey.PageDown -> "PgDn"
    RemoteKey.ArrowUp -> "Up"
    RemoteKey.ArrowDown -> "Down"
    RemoteKey.ArrowLeft -> "Left"
    RemoteKey.ArrowRight -> "Right"
    RemoteKey.CapsLock -> "Caps"
    RemoteKey.Menu -> "Menu"
    RemoteKey.PrintScreen -> "PrtSc"
    is RemoteKey.Modifier -> key.modifier.label
    is RemoteKey.Function -> "F" + key.index
    is RemoteKey.Character -> String(Character.toChars(key.codePoint))
}

/**
 * The one-row modifier bar section 6 requires above the system IME.
 *
 * Fixed content rather than user-configurable order, because the row has to stay reachable with one
 * thumb: Ctrl/Alt/Shift/Win are the latching modifiers, Esc/Tab are the two keys an IME cannot
 * produce, and the arrows are what a remote text field needs when the IME owns the return key.
 */
object RemoteModifierBar {

    val modifiers: List<RemoteModifier> = listOf(
        RemoteModifier.CTRL,
        RemoteModifier.ALT,
        RemoteModifier.SHIFT,
        RemoteModifier.META,
    )

    val keys: List<RemoteKey> = listOf(
        RemoteKey.Escape,
        RemoteKey.Tab,
        RemoteKey.ArrowLeft,
        RemoteKey.ArrowDown,
        RemoteKey.ArrowUp,
        RemoteKey.ArrowRight,
    )
}

/**
 * Whether text from the IME travels as text or as key events.
 *
 * This is the section 6 rule that Ctrl+C must not be delivered as the string "c". A shortcut
 * modifier means the remote program is listening for a key code, so the whole string is decomposed
 * into keystrokes; without one, the text channel is correct and is also the only thing that can
 * carry a CJK commit.
 */
object RemoteTextPolicy {

    fun route(text: String, latches: RemoteModifierLatches): List<RemoteInput> {
        if (text.isEmpty()) return emptyList()
        if (!latches.hasShortcutModifier) return listOf(RemoteInput.Text(text))

        val held = latches.active.filter { it.isShortcutModifier }
        val events = ArrayList<RemoteInput>(held.size * 2 + text.length * 2)
        for (modifier in held) events += RemoteInput.Key(RemoteKey.Modifier(modifier), down = true)
        var index = 0
        while (index < text.length) {
            val codePoint = text.codePointAt(index)
            events += RemoteInput.Key(RemoteKey.Character(codePoint), down = true)
            events += RemoteInput.Key(RemoteKey.Character(codePoint), down = false)
            index += Character.charCount(codePoint)
        }
        // Released in reverse so a chord unwinds the way a physical keyboard would.
        for (modifier in held.reversed()) events += RemoteInput.Key(RemoteKey.Modifier(modifier), down = false)
        return events
    }

    /** A single key press with the latched modifiers wrapped around it. */
    fun chord(key: RemoteKey, latches: RemoteModifierLatches): List<RemoteInput> {
        val held = latches.active.toList()
        val events = ArrayList<RemoteInput>(held.size * 2 + 2)
        for (modifier in held) events += RemoteInput.Key(RemoteKey.Modifier(modifier), down = true)
        events += RemoteInput.Key(key, down = true)
        events += RemoteInput.Key(key, down = false)
        for (modifier in held.reversed()) events += RemoteInput.Key(RemoteKey.Modifier(modifier), down = false)
        return events
    }
}
