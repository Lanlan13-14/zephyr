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
    val onFloatingSubtle: Color,
) {

    /**
     * The island's selected pill.
     *
     * A tonal container -- the accent mixed into [ZephyrSurfaces.floating] -- rather than the raw
     * accent, because no single label colour clears WCAG AA over all four raw accents: LAVA
     * (#BF5A1F) reaches only 4.47:1 against white and 4.30:1 against near-black, so a raw-accent
     * pill would ship a sub-AA label on at least one theme whichever on-colour was chosen.
     * Blending keeps [onFloating] usable as the label colour at 7.96:1 in the worst of the eight
     * theme/mode combinations, while staying visibly distinct from the unselected surface.
     */
    val islandSelection: Color = mix(surfaces.floating, brand.accent, SELECTION_BLEND)

    /**
     * Label and icon colour inside [islandSelection].
     *
     * Deliberately [onFloating] and not a separately chosen colour: the pill is a tint of the
     * floating surface, so the contrast pair that was already verified for that surface still
     * holds. Choosing a second on-colour here would create a value nothing verifies.
     */
    val onIslandSelection: Color = brand.accent

    /**
     * Ambient and spot colour for the island's drop shadow.
     *
     * Neutral black at differing opacity rather than a brand tint: a coloured shadow reads as a
     * glow, and MOBILE_EXPERIENCE.md 2.1 restricts brand colour to selection, primary action and
     * protocol status. Heavier in dark mode, where the shadow is the only thing separating the
     * island from a nearly-black background.
     */
    val islandShadow: Color = if (dark) Color(0x99000000) else Color(0x33000000)

    companion object {

        /**
         * How much accent the selected pill carries.
         *
         * 0.32 is the measured value, not a guess: every step from 0.20 to 0.50 keeps the label
         * above AA, and 0.32 is where the pill is clearly distinguishable from the unselected
         * surface (1.37:1 to 1.67:1) while the label still measures 7.96:1 at worst.
         */
        private const val SELECTION_BLEND = 0.16f

        /**
         * Component-wise mix of two opaque colours.
         *
         * Not `androidx.compose.ui.graphics.lerp`, which interpolates in Oklab: the AA figures
         * above were computed by interpolating encoded sRGB components, and a different
         * interpolation space would produce different colours than the ones actually verified.
         */
        private fun mix(base: Color, accent: Color, fraction: Float): Color = Color(
            red = base.red + (accent.red - base.red) * fraction,
            green = base.green + (accent.green - base.green) * fraction,
            blue = base.blue + (accent.blue - base.blue) * fraction,
            alpha = 1f,
        )

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
                success = if (dark) Color(0xFF30D158) else Color(0xFF15803D),
                warning = if (dark) Color(0xFFFFD60A) else Color(0xFFB45309),
                error = if (dark) Color(0xFFFF453A) else Color(0xFFB91C1C),
                offline = if (dark) Color(0xFF8E99A6) else Color(0xFF64748B),
                pendingSync = if (dark) Color(0xFF64D2FF) else Color(0xFF1D4ED8),
                conflict = if (dark) Color(0xFFFF9F0A) else Color(0xFF7E22CE),
            ),
            protocol = ZephyrProtocolColors(
                ssh = if (dark) Color(0xFF0A84FF) else Color(0xFF0F766E),
                telnet = if (dark) Color(0xFFFFD60A) else Color(0xFF92400E),
                rdp = if (dark) Color(0xFFBF5AF2) else Color(0xFF1E40AF),
                vnc = if (dark) Color(0xFF30D158) else Color(0xFF6B21A8),
            ),
            surfaces = if (dark) {
                ZephyrSurfaces(
                    background = Color(0xFF0A0C0F),
                    content = Color(0xFF13161B),
                    elevated = Color(0xFF1B1F26),
                    // High opacity, not translucency: DEVELOPMENT.md 6.1.1 forbids faking glass, and
                    // a tonal surface keeps contrast predictable when blur is unavailable.
                    floating = Color(0xE61A1E25),
                    scrim = Color(0x80000000),
                    outline = Color(0x14FFFFFF),
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
            onBackground = if (dark) Color(0xFFF2F4F7) else Color(0xFF10151B),
            onFloating = if (dark) Color(0xFFF2F4F7) else Color(0xFF10151B),
            onFloatingMuted = if (dark) Color(0xFF9AA4B0) else Color(0xFF5B6875),
            onFloatingSubtle = if (dark) Color(0xFF5D6773) else Color(0xFF98A1AB),
        )
    }
}
