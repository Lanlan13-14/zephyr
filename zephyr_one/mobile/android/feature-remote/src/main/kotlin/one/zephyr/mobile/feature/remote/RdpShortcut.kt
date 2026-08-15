package one.zephyr.mobile.feature.remote

/**
 * The five chords the demo RDP shortcut sheet sends.
 *
 * Built as complete down/up sequences so a tool-strip tap is one [RemoteSessionController] submit
 * rather than a half-held modifier left on the wire. CAD uses the right-Alt scan that Windows
 * treats as the secure-attention sequence together with Ctrl and Delete.
 */
enum class RdpShortcut(val label: String) {
    WIN("Win"),
    CAD("Ctrl+Alt+Del"),
    ALT_TAB("Alt+Tab"),
    WIN_R("Win+R"),
    ALT_F4("Alt+F4"),
    ;

    fun inputs(): List<RemoteInput> = when (this) {
        WIN -> tap(RemoteKey.Modifier(RemoteModifier.META))
        CAD -> chord(
            RemoteKey.Modifier(RemoteModifier.CTRL),
            RemoteKey.Modifier(RemoteModifier.ALT, right = true),
            RemoteKey.Delete,
        )
        ALT_TAB -> chord(RemoteKey.Modifier(RemoteModifier.ALT), RemoteKey.Tab)
        WIN_R -> chord(RemoteKey.Modifier(RemoteModifier.META), RemoteKey.Character('r'.code))
        ALT_F4 -> chord(RemoteKey.Modifier(RemoteModifier.ALT), RemoteKey.Function(4))
    }

    companion object {
        val sheetItems: List<RdpShortcut> = entries.toList()

        private fun tap(key: RemoteKey): List<RemoteInput> = listOf(
            RemoteInput.Key(key, down = true),
            RemoteInput.Key(key, down = false),
        )

        private fun chord(vararg keys: RemoteKey): List<RemoteInput> {
            val events = ArrayList<RemoteInput>(keys.size * 2)
            for (key in keys) events += RemoteInput.Key(key, down = true)
            for (index in keys.lastIndex downTo 0) events += RemoteInput.Key(keys[index], down = false)
            return events
        }
    }
}
