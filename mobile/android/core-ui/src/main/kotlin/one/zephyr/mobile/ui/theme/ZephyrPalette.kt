package one.zephyr.mobile.ui.theme

import androidx.compose.ui.graphics.Color

/**
 * The four brand palettes, keyed exactly as in branding/manifest.json.
 *
 * The manifest is the single source of truth for the icon *and* the app chrome, so the hex values
 * are transcribed rather than re-picked: a divergence would give a device an icon and a UI that do
 * not match. MOBILE_EXPERIENCE.md 2.1 also restricts brand colour to selection, primary action and
 * protocol status, which is why each palette exposes only an accent set, not a full tonal ramp.
 */
enum class ZephyrThemeId(val wireName: String) {
    FROST("frost"),
    LAVA("lava"),
    ASAGI("asagi"),
    CYBER("cyber"),
    ;

    companion object {
        val default = FROST

        /** Unknown values fall back rather than throwing: a newer server may name a fifth theme. */
        fun fromWire(value: String?): ZephyrThemeId =
            entries.firstOrNull { it.wireName == value } ?: default
    }
}

/**
 * Brand colours for one theme.
 *
 * @property main the lightest brand tone, used for the icon body.
 * @property mid mid tone, used for the unselected island icon tint.
 * @property dark darkest brand tone.
 * @property accent the "dotA" colour: the only colour allowed to mark selection and primary action.
 * @property muted the "dotB" colour, for de-emphasised brand marks.
 */
data class ZephyrBrandColors(
    val main: Color,
    val mid: Color,
    val dark: Color,
    val accent: Color,
    val muted: Color,
)

/** Semantic status colours. Never the only signal: every use is paired with text or an icon. */
data class ZephyrStatusColors(
    val success: Color,
    val warning: Color,
    val error: Color,
    val offline: Color,
    val pendingSync: Color,
    val conflict: Color,
)

/** Per-protocol accent. Auxiliary only; the protocol name is always shown too. */
data class ZephyrProtocolColors(
    val ssh: Color,
    val telnet: Color,
    val rdp: Color,
    val vnc: Color,
)

/**
 * Five surface levels from MOBILE_EXPERIENCE.md 4.1.
 *
 * Named by role rather than elevation number so a screen cannot invent a sixth level: the rule is
 * that only the island, the session dock and the selection toolbar use [floating].
 */
data class ZephyrSurfaces(
    val background: Color,
    val content: Color,
    val elevated: Color,
    val floating: Color,
    val scrim: Color,
    val outline: Color,
)

data class ZephyrPalette(
    val id: ZephyrThemeId,
    val dark: Boolean,
    val brand: ZephyrBrandColors,
    val status: ZephyrStatusColors,
    val protocol: ZephyrProtocolColors,
    val surfaces: ZephyrSurfaces,
    val onBackground: Color,
    val onFloating: Color,
    val onFloatingMuted: Color,
) {
    companion object {
        fun of(id: ZephyrThemeId, dark: Boolean): ZephyrPalette = when (id) {
            ZephyrThemeId.FROST -> build(id, dark, Color(0xFFEEF2F7), Color(0xFFA8B5C3), Color(0xFF6E7B88), Color(0xFF0A84FF), Color(0xFF8E99A6))
            ZephyrThemeId.LAVA -> build(id, dark, Color(0xFFF1E8DF), Color(0xFFC79672), Color(0xFF8D5A3A), Color(0xFFBF5A1F), Color(0xFFA58A78))
            ZephyrThemeId.ASAGI -> build(id, dark, Color(0xFFEDF4F2), Color(0xFF9BBDB5), Color(0xFF5E8F83), Color(0xFF4D9C8A), Color(0xFF829B96))
            ZephyrThemeId.CYBER -> build(id, dark, Color(0xFFEEF3F5), Color(0xFF9EB7BD), Color(0xFF5D858D), Color(0xFF4F9DA6), Color(0xFF7F9298))
        }

        private fun build(
            id: ZephyrThemeId,
            dark: Boolean,
            main: Color,
            mid: Color,
            darkTone: Color,
            accent: Color,
            muted: Color,
        ): ZephyrPalette = ZephyrPalette(
            id = id,
            dark = dark,
            brand = ZephyrBrandColors(main = main, mid = mid, dark = darkTone, accent = accent, muted = muted),
            // Status hues are shared across themes on purpose: an error must look like an error
            // regardless of the brand palette the user picked.
            status = ZephyrStatusColors(
                success = if (dark) Color(0xFF4ADE80) else Color(0xFF15803D),
                warning = if (dark) Color(0xFFFBBF24) else Color(0xFFB45309),
                error = if (dark) Color(0xFFF87171) else Color(0xFFB91C1C),
                offline = if (dark) Color(0xFF94A3B8) else Color(0xFF64748B),
                pendingSync = if (dark) Color(0xFF60A5FA) else Color(0xFF1D4ED8),
                conflict = if (dark) Color(0xFFC084FC) else Color(0xFF7E22CE),
            ),
            protocol = ZephyrProtocolColors(
                ssh = if (dark) Color(0xFF5EEAD4) else Color(0xFF0F766E),
                telnet = if (dark) Color(0xFFFCD34D) else Color(0xFF92400E),
                rdp = if (dark) Color(0xFF93C5FD) else Color(0xFF1E40AF),
                vnc = if (dark) Color(0xFFD8B4FE) else Color(0xFF6B21A8),
            ),
            surfaces = if (dark) {
                ZephyrSurfaces(
                    background = Color(0xFF0B0F14),
                    content = Color(0xFF121820),
                    elevated = Color(0xFF1A222C),
                    // High opacity, not translucency: DEVELOPMENT.md 6.1.1 forbids faking glass, and
                    // a tonal surface keeps contrast predictable when blur is unavailable.
                    floating = Color(0xFF1C242E),
                    scrim = Color(0x99000000),
                    outline = Color(0x33FFFFFF),
                )
            } else {
                ZephyrSurfaces(
                    background = Color(0xFFF2F4F7),
                    content = Color(0xFFFFFFFF),
                    elevated = Color(0xFFFFFFFF),
                    floating = Color(0xFFFBFCFD),
                    scrim = Color(0x66000000),
                    outline = Color(0x1F0B0F14),
                )
            },
            onBackground = if (dark) Color(0xFFE8EDF3) else Color(0xFF10151B),
            onFloating = if (dark) Color(0xFFE8EDF3) else Color(0xFF10151B),
            onFloatingMuted = if (dark) Color(0xFF93A1B0) else Color(0xFF5B6875),
        )
    }
}
