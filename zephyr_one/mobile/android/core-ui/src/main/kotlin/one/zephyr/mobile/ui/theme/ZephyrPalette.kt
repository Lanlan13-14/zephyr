package one.zephyr.mobile.ui.theme

import androidx.compose.ui.graphics.Color

/**
 * Brand + surface tokens transcribed from demo.html.
 *
 * `[data-theme]` only changes `--accent` / `--accent-2`. Surfaces, text and
 * status hues come from `[data-scheme]`. Protocol colours are scheme-independent
 * (`--p-ssh` etc.). Light-mode status hues stay the same as dark: the demo does
 * not recast `--ok/--warn/--err` when the scheme flips.
 */
enum class ZephyrThemeId(val wireName: String) {
    FROST("frost"),
    LAVA("lava"),
    ASAGI("asagi"),
    CYBER("cyber"),
    ;

    companion object {
        val default = FROST

        fun fromWire(value: String?): ZephyrThemeId =
            entries.firstOrNull { it.wireName.equals(value, ignoreCase = true) } ?: default
    }
}

data class ZephyrBrandColors(
    val main: Color,
    val mid: Color,
    val dark: Color,
    val accent: Color,
    val muted: Color,
)

data class ZephyrStatusColors(
    val success: Color,
    val warning: Color,
    val error: Color,
    val offline: Color,
    val pendingSync: Color,
    val conflict: Color,
)

data class ZephyrProtocolColors(
    val ssh: Color,
    val telnet: Color,
    val rdp: Color,
    val vnc: Color,
    val sftp: Color,
)

data class ZephyrSurfaces(
    val background: Color,
    val content: Color,
    val elevated: Color,
    val floating: Color,
    val scrim: Color,
    val outline: Color,
    val outlineSoft: Color,
    val termBackground: Color,
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

    val islandSelection: Color = mix(surfaces.floating, brand.accent, SELECTION_BLEND)
    val onIslandSelection: Color = brand.accent
    val islandShadow: Color = if (dark) Color(0x73000000) else Color(0x29000000)

    fun protocolOf(name: String): Color = when (name.lowercase()) {
        "ssh" -> protocol.ssh
        "telnet" -> protocol.telnet
        "rdp" -> protocol.rdp
        "vnc" -> protocol.vnc
        "sftp" -> protocol.sftp
        else -> brand.accent
    }

    companion object {

        private const val SELECTION_BLEND = 0.16f

        fun mix(base: Color, accent: Color, fraction: Float): Color = Color(
            red = base.red + (accent.red - base.red) * fraction,
            green = base.green + (accent.green - base.green) * fraction,
            blue = base.blue + (accent.blue - base.blue) * fraction,
            alpha = 1f,
        )

        fun of(id: ZephyrThemeId, dark: Boolean): ZephyrPalette {
            val (accent, muted) = when (id) {
                ZephyrThemeId.FROST -> Color(0xFF0A84FF) to Color(0xFF8E99A6)
                ZephyrThemeId.LAVA -> Color(0xFFBF5A1F) to Color(0xFFA58A78)
                ZephyrThemeId.ASAGI -> Color(0xFF4D9C8A) to Color(0xFF829B96)
                ZephyrThemeId.CYBER -> Color(0xFF4F9DA6) to Color(0xFF7F9298)
            }
            val (main, mid, darkTone) = when (id) {
                ZephyrThemeId.FROST -> Triple(Color(0xFFEEF2F7), Color(0xFFA8B5C3), Color(0xFF6E7B88))
                ZephyrThemeId.LAVA -> Triple(Color(0xFFF1E8DF), Color(0xFFC79672), Color(0xFF8D5A3A))
                ZephyrThemeId.ASAGI -> Triple(Color(0xFFEDF4F2), Color(0xFF9BBDB5), Color(0xFF5E8F83))
                ZephyrThemeId.CYBER -> Triple(Color(0xFFEEF3F5), Color(0xFF9EB7BD), Color(0xFF5D858D))
            }
            return ZephyrPalette(
                id = id,
                dark = dark,
                brand = ZephyrBrandColors(main, mid, darkTone, accent, muted),
                status = ZephyrStatusColors(
                    success = Color(0xFF30D158),
                    warning = Color(0xFFFFD60A),
                    error = Color(0xFFFF453A),
                    offline = Color(0xFF8E99A6),
                    pendingSync = Color(0xFF64D2FF),
                    conflict = Color(0xFFFF9F0A),
                ),
                protocol = ZephyrProtocolColors(
                    ssh = Color(0xFF0A84FF),
                    telnet = Color(0xFFFFD60A),
                    rdp = Color(0xFFBF5AF2),
                    vnc = Color(0xFF30D158),
                    sftp = Color(0xFF64D2FF),
                ),
                surfaces = if (dark) {
                    ZephyrSurfaces(
                        background = Color(0xFF0A0C0F),
                        content = Color(0xFF13161B),
                        elevated = Color(0xFF1B1F26),
                        floating = Color(0xC71A1E25),
                        scrim = Color(0x80000000),
                        outline = Color(0x14FFFFFF),
                        outlineSoft = Color(0x0DFFFFFF),
                        termBackground = Color(0xFF07090C),
                    )
                } else {
                    ZephyrSurfaces(
                        background = Color(0xFFEEF0F4),
                        content = Color(0xFFF7F8FA),
                        elevated = Color(0xFFFFFFFF),
                        floating = Color(0xD1FFFFFF),
                        scrim = Color(0x5914181E),
                        outline = Color(0x1A0F141C),
                        outlineSoft = Color(0x0D0F141C),
                        termBackground = Color(0xFFF3F5F7),
                    )
                },
                onBackground = if (dark) Color(0xFFF2F4F7) else Color(0xFF14181D),
                onFloating = if (dark) Color(0xFFF2F4F7) else Color(0xFF14181D),
                onFloatingMuted = if (dark) Color(0xFF9AA4B0) else Color(0xFF5B6570),
                onFloatingSubtle = if (dark) Color(0xFF5D6773) else Color(0xFF98A1AB),
            )
        }
    }
}
