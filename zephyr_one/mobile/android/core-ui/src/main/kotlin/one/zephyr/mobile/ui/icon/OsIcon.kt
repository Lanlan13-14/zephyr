package one.zephyr.mobile.ui.icon

import androidx.compose.foundation.Image
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import one.zephyr.mobile.model.Connection
import one.zephyr.mobile.model.Protocol

/**
 * Remote-system icon for a connection, matching the Zephyr web app's
 * CONNECTION_OS_ICONS set (probe-backed `icon` field).
 *
 * Brand-tinted glyphs (Windows blue, Ubuntu orange, …) carry their own colour;
 * currentColor glyphs (macOS, generic Linux) follow the ambient theme, and
 * `auto`/unknown falls back to the caller-supplied protocol colour so the
 * card keeps its per-protocol identity until the main end probes the system.
 */
object OsIcons {

    data class Glyph(val vector: ImageVector, val brandColor: Color?, val isCurrentColor: Boolean = false)

    fun glyphFor(iconKey: String?): Glyph? = when (iconKey?.lowercase()?.trim()) {
        "windows" -> Glyph(ZephyrIcons.OsWindows, Color(0xFF0078D4))
        "macos" -> Glyph(ZephyrIcons.OsMacos, null, isCurrentColor = true)
        "ubuntu" -> Glyph(ZephyrIcons.OsUbuntu, Color(0xFFE95420))
        "debian" -> Glyph(ZephyrIcons.OsDebian, Color(0xFFD70A53))
        "arch" -> Glyph(ZephyrIcons.OsArch, Color(0xFF1793D1))
        "alpine" -> Glyph(ZephyrIcons.OsAlpine, Color(0xFF0D597F))
        "raspberry" -> Glyph(ZephyrIcons.OsRaspberry, Color(0xFFC51A4A))
        "redhat" -> Glyph(ZephyrIcons.OsRedhat, Color(0xFFEE0000))
        "linux" -> Glyph(ZephyrIcons.OsLinux, null, isCurrentColor = true)
        else -> null
    }

    fun isResolved(iconKey: String?): Boolean = glyphFor(iconKey) != null

        /**
         * Which glyph a connection card draws.
         *
         * Same rule as the web app's `detectConnectionIconKey`: a stored key is
         * trusted as-is, because the main end writes `icon` only when the user
         * picked it or a probe confirmed it. `auto` falls back to the same text
         * guess the web app uses, and RDP with nothing else to go on is Windows.
         * A key no glyph exists for stays unresolved so the card keeps its
         * protocol monogram instead of inventing one.
         */
        fun cardIconKey(connection: Connection): String? {
            val explicit = connection.icon.lowercase().trim()
            if (explicit.isNotEmpty() && explicit != "auto" && glyphFor(explicit) != null) return explicit
            val text = listOf(
                connection.name,
                connection.remark,
                connection.tags.joinToString(" "),
                connection.host,
            ).joinToString(" ").lowercase()
            val guessed = when {
                text.contains(Regex("""windows|win11|win10|winserver|\bwin\b""")) -> "windows"
                text.contains(Regex("""macos|osx|darwin|apple|macbook|macmini|imac|macstudio|\bmac\b""")) -> "macos"
                text.contains("ubuntu") -> "ubuntu"
                text.contains("debian") -> "debian"
                text.contains(Regex("""arch|archlinux|manjaro""")) -> "arch"
                text.contains(Regex("""alpine|alpinelinux""")) -> "alpine"
                text.contains(Regex("""raspberry|rpi|raspbian|\bpi\s?[2-5]\w*\b""")) -> "raspberry"
                text.contains(Regex("""redhat|rhel|centos|fedora|rocky|alma""")) -> "redhat"
                text.contains(Regex("""linux|kali|gentoo|suse|opensuse""")) -> "linux"
                connection.protocol == Protocol.RDP -> "windows"
                else -> null
            }
            return guessed?.takeIf { glyphFor(it) != null }
    }
}

/**
 * Renders the resolved system glyph when `iconKey` names one; otherwise invokes
 * [fallback] so the caller keeps its protocol-coloured placeholder.
 */
@Composable
fun OsIcon(
    iconKey: String?,
    modifier: Modifier = Modifier,
    themeContentColor: Color = Color.Unspecified,
    fallback: @Composable () -> Unit,
) {
    val glyph = OsIcons.glyphFor(iconKey)
    if (glyph == null) {
        fallback()
        return
    }
    val tint = glyph.brandColor ?: themeContentColor.takeIf { it != Color.Unspecified } ?: Color(0xFF1D1D1F)
    androidx.compose.foundation.Image(
        imageVector = glyph.vector,
        contentDescription = null,
        modifier = modifier,
        colorFilter = androidx.compose.ui.graphics.ColorFilter.tint(tint),
    )
}