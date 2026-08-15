package one.zephyr.mobile.ui.icon

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.unit.dp

/**
 * Demo.html icon sprite, 24×24, currentColor.
 *
 * Filled glyphs (`#i-*` symbols) come from the Zephyr desktop style.css data-uri set.
 * Stroked glyphs (island, back, search, check) are the inline SVGs on those controls.
 * Material Icons are not used anywhere in chrome.
 */
object ZephyrIcons {

    val File: ImageVector by lazy { fill("i-file", "M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v1H3V6zm0 4h18l-2 9H5l-2-9z") }
    val Stats: ImageVector by lazy { fill("i-stats", "M4 20V4h16v2H6v12h14v2H4zm3-3V9h3v8H7zm5 0V6h3v11h-3zm5 0v-5h3v5h-3z") }
    val Docker: ImageVector by lazy { fill("i-docker", "M3 13h18c-.6 4-3.8 7-8.8 7C7.5 20 4 17.8 3 13zm2-5h3v3H5V8zm4 0h3v3H9V8zm4 0h3v3h-3V8zM9 4h3v3H9V4zm4 0h3v3h-3V4zm4 4h3v3h-3V8z") }
    val Bolt: ImageVector by lazy { fill("i-bolt", "M13 2 4 14h7l-1 8 10-13h-7l0-7z") }
    val Notes: ImageVector by lazy { fill("i-notes", "M5 3h10l4 4v14H5V3zm9 1.5V8h3.5L14 4.5zM7 6h5v2H7V6zm0 4h10v2H7v-2zm0 4h10v2H7v-2zm0 4h7v2H7v-2z") }
    val Keyboard: ImageVector by lazy { fill("i-keyboard", "M3 6h18v12H3V6zm2 2v8h14V8H5zm1 1h2v2H6V9zm3 0h2v2H9V9zm3 0h2v2h-2V9zm3 0h2v2h-2V9zM6 12h2v2H6v-2zm3 0h6v2H9v-2zm7 0h2v2h-2v-2z") }
    val Copy: ImageVector by lazy { fill("i-copy", "M7 7V3h14v14h-4v4H3V7h4zm2 0h8v8h2V5H9v2zm-4 2v10h10V9H5z") }
    val Clipboard: ImageVector by lazy { fill("i-clipboard", "M9 3h6l1 2h3v16H5V5h3l1-2zm1 4h4l1-2h-6l1 2zm-3 1v11h10V8h-2v2H9V8H7z") }
    val Paste: ImageVector by lazy { Clipboard }
    val Theme: ImageVector by lazy { fill("i-theme", "M12 2a9 9 0 1 0 9 9c-1 4-5 7-9 7V2z") }
    val Reconnect: ImageVector by lazy { fill("i-reconnect", "M17.7 6.3A8 8 0 1 0 20 12h-2a6 6 0 1 1-1.76-4.24L13 11h8V3l-3.3 3.3z") }
    val Disconnect: ImageVector by lazy { fill("i-disconnect", "M7 3h10v2H7V3zm4 4h2v7h-2V7zm-5.6 3.2 1.5 1.3A6 6 0 1 0 17.1 11.5l1.5-1.3a8 8 0 1 1-13.2 0z") }
    val Fit: ImageVector by lazy { fill("i-fit", "M4 4h7v2H7.4l4.1 4.1-1.4 1.4L6 7.4V11H4V4zm9 0h7v7h-2V7.4l-4.1 4.1-1.4-1.4L16.6 6H13V4zM4 13h2v3.6l4.1-4.1 1.4 1.4L7.4 18H11v2H4v-7zm14 0h2v7h-7v-2h3.6l-4.1-4.1 1.4 1.4 4.1 4.1V13z") }
    val Zoom: ImageVector by lazy { fill("i-zoom", "M10 4a6 6 0 1 0 0 12 6 6 0 0 0 0-12zm0 2a4 4 0 1 1 0 8 4 4 0 0 1 0-8zm1 2H9v2H7v2h2v2h2v-2h2v-2h-2V8zm4.7 7.3 4.5 4.5-1.4 1.4-4.5-4.5 1.4-1.4z", evenOdd = true) }
    val Joystick: ImageVector by lazy { fill("i-joystick", "M7 9h10a5 5 0 0 1 4.8 3.6l.8 3A3.5 3.5 0 0 1 19.2 20c-1 0-1.9-.4-2.6-1.1L14.7 17H9.3l-1.9 1.9A3.7 3.7 0 0 1 4.8 20a3.5 3.5 0 0 1-3.4-4.4l.8-3A5 5 0 0 1 7 9zm1 3H6v2H4v2h2v2h2v-2h2v-2H8v-2zm8.5 1a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM18 10a1 1 0 1 0 0 2 1 1 0 0 0 0-2zM11 4h2v5h-2V4z") }
    val Security: ImageVector by lazy { fill("i-security", "M12 2 5 5v6c0 4.6 2.9 8.8 7 10 4.1-1.2 7-5.4 7-10V5l-7-3zm0 3.2 5 2.1V11c0 3.3-2 6.4-5 7.6-3-1.2-5-4.3-5-7.6V7.3l5-2.1zM11 8h2v5h-2V8zm0 7h2v2h-2v-2z") }
    val Download: ImageVector by lazy { fill("i-download", "M11 3h2v9.2l3.1-3.1 1.4 1.4L12 16l-5.5-5.5 1.4-1.4 3.1 3.1V3zM4 18h16v3H4v-3z") }
    val Globe: ImageVector by lazy { fill("i-globe", "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm7.9 9h-3a15.6 15.6 0 0 0-1.2-5.3A8 8 0 0 1 19.9 11zM12 4.1c.9 1.2 1.8 3.2 2.1 6.9H9.9c.3-3.7 1.2-5.7 2.1-6.9zM8.3 5.7A15.6 15.6 0 0 0 7.1 11h-3a8 8 0 0 1 4.2-5.3zM4.1 13h3c.2 2.3.6 4 1.2 5.3A8 8 0 0 1 4.1 13zM12 19.9c-.9-1.2-1.8-3.2-2.1-6.9h4.2c-.3 3.7-1.2 5.7-2.1 6.9zm3.7-1.6c.6-1.3 1-3 1.2-5.3h3a8 8 0 0 1-4.2 5.3z") }
    val Key: ImageVector by lazy { fill("i-key", "M14.5 3a6.5 6.5 0 0 0-6.3 8.1L3 16.3V21h4.7v-2.5h2.5v-2.5h2.3l1.2-1.2A6.5 6.5 0 1 0 14.5 3zm1 4a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z") }
    val JumpHost: ImageVector by lazy { fill("i-jumphost", "M4 17a3 3 0 1 1 2.8-4h3.9a3 3 0 1 1 2.6-4.5l3.4-2A3 3 0 1 1 18 4a3 3 0 0 1-.2 6 3 3 0 0 1-2.6-1.5l-3.4 2c.1.3.2.7.2 1a3 3 0 0 1-4.8 2.5H6.8A3 3 0 0 1 4 17z") }
    val Server: ImageVector by lazy { fill("i-server", "M4 3h16a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm2 2.5v2h2v-2H6zM4 11h16a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1zm2 2.5v2h2v-2H6zm-1 6.5h14v2H5v-2z") }
    val Lock: ImageVector by lazy { fill("i-lock", "M12 2a5 5 0 0 1 5 5v3h1a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h1V7a5 5 0 0 1 5-5zm0 2a3 3 0 0 0-3 3v3h6V7a3 3 0 0 0-3-3zm0 8.5a2 2 0 0 0-1 3.7V19h2v-2.8a2 2 0 0 0-1-3.7z") }
    val Activity: ImageVector by lazy { fill("i-activity", "M3 11h4l2.5-6 4 14L16 11h5v2h-3.9l-3.4 8.9-4.2-14.7L8.1 13H3v-2z") }
    val Gear: ImageVector by lazy { fill("i-gear", "M12 8.5A3.5 3.5 0 1 1 12 15.5 3.5 3.5 0 0 1 12 8.5zM10.9 2h2.2l.5 2.6c.7.2 1.3.5 1.9.9l2.5-1 1.1 1.9-1.7 2.1c.2.6.4 1.2.4 1.9s-.1 1.3-.4 1.9l1.7 2.1-1.1 1.9-2.5-1a8 8 0 0 1-1.9.9l-.5 2.6h-2.2l-.5-2.6a8 8 0 0 1-1.9-.9l-2.5 1-1.1-1.9 1.7-2.1a7.6 7.6 0 0 1 0-3.8L4.9 6.4 6 4.5l2.5 1c.6-.4 1.2-.7 1.9-.9l.5-2.6z") }
    val Save: ImageVector by lazy { fill("i-save", "M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm2 2v5h8V5H7zm5 6.5A3.5 3.5 0 1 0 12 18.5 3.5 3.5 0 0 0 12 11.5z") }
    val Plus: ImageVector by lazy { fill("i-plus", "M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5z") }
    val Ticket: ImageVector by lazy { fill("i-ticket", "M4 6a2 2 0 0 0-2 2v2a2 2 0 1 1 0 4v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a2 2 0 1 1 0-4V8a2 2 0 0 0-2-2H4zm9 2h2v2.5h-2V8zm0 4.5h2V15h-2v-2.5z") }
    val Warn: ImageVector by lazy { fill("i-warn", "M12 2 1.5 20.5h21L12 2zm-1 7h2v6h-2V9zm0 7.5h2v2h-2v-2z") }
    val Devices: ImageVector by lazy { fill("i-devices", "M3 5h14a1 1 0 0 1 1 1v3h-2V7H4v9h7v2H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm11 6h7a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1zm1.5 6.5h3v1h-3v-1z") }
    val Pointer: ImageVector by lazy { fill("i-pointer", "M6 3l13 9.5-7.2 1L9 20.5 6 3z") }
    val GridTools: ImageVector by lazy { fill("i-grid-tools", "M4 4h7v7H4V4zm9 0h7v7h-7V4zM4 13h7v7H4v-7zm9 3h2v-3h2v3h3v2h-3v3h-2v-3h-2v-2z") }
    val Monitor: ImageVector by lazy { fill("i-monitor", "M3 4h18a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-7v2h3v2H7v-2h3v-2H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm1 2v9h16V6H4z") }

    val Home: ImageVector by lazy {
        strokes(
            name = "island-home",
            paths = listOf("M3 10.5 12 3l9 7.5", "M5 9.5V21h14V9.5", "M9.5 21v-6h5v6"),
            width = 2f,
            cap = StrokeCap.Round,
            join = StrokeJoin.Round,
        )
    }
    val Sessions: ImageVector by lazy {
        ImageVector.Builder(
            name = "island-sessions",
            defaultWidth = 24.dp,
            defaultHeight = 24.dp,
            viewportWidth = 24f,
            viewportHeight = 24f,
        ).apply {
            path(
                fill = null,
                stroke = SolidColor(Color.Black),
                strokeLineWidth = 2f,
                strokeLineCap = StrokeCap.Round,
            ) {
                moveTo(6f, 4f)
                horizontalLineToRelative(12f)
                curveToRelative(1.657f, 0f, 3f, 1.343f, 3f, 3f)
                verticalLineToRelative(10f)
                curveToRelative(0f, 1.657f, -1.343f, 3f, -3f, 3f)
                horizontalLineTo(6f)
                curveToRelative(-1.657f, 0f, -3f, -1.343f, -3f, -3f)
                verticalLineTo(7f)
                curveToRelative(0f, -1.657f, 1.343f, -3f, 3f, -3f)
                close()
            }
            path(
                fill = null,
                stroke = SolidColor(Color.Black),
                strokeLineWidth = 2f,
                strokeLineCap = StrokeCap.Round,
            ) {
                moveTo(7f, 9f)
                lineToRelative(3f, 3f)
                lineToRelative(-3f, 3f)
                moveTo(12f, 15f)
                horizontalLineToRelative(5f)
            }
        }.build()
    }
    val Library: ImageVector by lazy {
        strokes(
            name = "island-library",
            paths = listOf("M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"),
            width = 2f,
            cap = StrokeCap.Round,
            join = StrokeJoin.Round,
        )
    }
    val Tools: ImageVector by lazy {
        ImageVector.Builder(
            name = "island-tools",
            defaultWidth = 24.dp,
            defaultHeight = 24.dp,
            viewportWidth = 24f,
            viewportHeight = 24f,
        ).apply {
            fun roundedRect(x: Float, y: Float, w: Float, h: Float, r: Float) {
                path(
                    fill = null,
                    stroke = SolidColor(Color.Black),
                    strokeLineWidth = 2f,
                    strokeLineCap = StrokeCap.Round,
                ) {
                    moveTo(x + r, y)
                    lineTo(x + w - r, y)
                    quadTo(x + w, y, x + w, y + r)
                    lineTo(x + w, y + h - r)
                    quadTo(x + w, y + h, x + w - r, y + h)
                    lineTo(x + r, y + h)
                    quadTo(x, y + h, x, y + h - r)
                    lineTo(x, y + r)
                    quadTo(x, y, x + r, y)
                    close()
                }
            }
            roundedRect(3.5f, 3.5f, 7f, 7f, 2f)
            roundedRect(13.5f, 3.5f, 7f, 7f, 2f)
            roundedRect(3.5f, 13.5f, 7f, 7f, 2f)
            path(
                fill = null,
                stroke = SolidColor(Color.Black),
                strokeLineWidth = 2f,
                strokeLineCap = StrokeCap.Round,
            ) {
                moveTo(17f, 13.5f)
                verticalLineToRelative(7f)
                moveTo(13.5f, 17f)
                horizontalLineToRelative(7f)
            }
        }.build()
    }

    val Back: ImageVector by lazy {
        strokes("back", listOf("M15 6l-6 6 6 6"), width = 2.4f, cap = StrokeCap.Round)
    }
    val Search: ImageVector by lazy {
        strokes("search", listOf("M18 11a7 7 0 1 1-14 0 7 7 0 0 1 14 0z", "M20 20l-3.5-3.5"), width = 2.2f, cap = StrokeCap.Round)
    }
    val Check: ImageVector by lazy {
        strokes("check", listOf("m5 13 4 4L19 7"), width = 2.6f, cap = StrokeCap.Round)
    }
    val Chevron: ImageVector by lazy {
        strokes("chevron", listOf("M9 6l6 6-6 6"), width = 2.2f, cap = StrokeCap.Round)
    }
    val Close: ImageVector by lazy {
        strokes("close", listOf("M6 6l12 12M18 6 6 18"), width = 2.2f, cap = StrokeCap.Round)
    }
    val More: ImageVector by lazy {
        fill("more", "M6 10.5A1.5 1.5 0 1 1 6 13.5 1.5 1.5 0 0 1 6 10.5zm6 0A1.5 1.5 0 1 1 12 13.5 1.5 1.5 0 0 1 12 10.5zm6 0A1.5 1.5 0 1 1 18 13.5 1.5 1.5 0 0 1 18 10.5z")
    }
    val Refresh: ImageVector by lazy {
        strokes("refresh", listOf("M21 12a9 9 0 1 1-2.6-6.3", "M21 3v6h-6"), width = 2.4f, cap = StrokeCap.Round)
    }
    val Star: ImageVector by lazy {
        fill("star", "M12 3.2 14.4 8l5.4.8-3.9 3.8.9 5.4L12 15.5 7.2 18l.9-5.4L4.2 8.8 9.6 8z")
    }
    val Account: ImageVector by lazy {
        fill("account", "M12 3a5 5 0 1 1 0 10 5 5 0 0 1 0-10zm0 12c4.4 0 8 2.2 8 5v1H4v-1c0-2.8 3.6-5 8-5z")
    }
    val AiSpark: ImageVector by lazy {
        ImageVector.Builder(
            name = "ai-spark",
            defaultWidth = 24.dp,
            defaultHeight = 24.dp,
            viewportWidth = 24f,
            viewportHeight = 24f,
        ).apply {
            addFilled("M12 2.5 13.8 8l5.7 1.8a.8.8 0 0 1 0 1.55L13.8 13.2 12 18.7a.8.8 0 0 1-1.55 0L8.7 13.2 3 11.35a.8.8 0 0 1 0-1.55L8.7 8 10.45 2.5a.8.8 0 0 1 1.55 0z")
            addFilled("M18.5 14.5l.9 2.6 2.6.9a.6.6 0 0 1 0 1.15l-2.6.9-.9 2.6a.6.6 0 0 1-1.15 0l-.9-2.6-2.6-.9a.6.6 0 0 1 0-1.15l2.6-.9.9-2.6a.6.6 0 0 1 1.15 0z")
        }.build()
    }
    val ArrowUp: ImageVector by lazy { strokes("up", listOf("M12 19V5M6 11l6-6 6 6"), width = 2.2f, cap = StrokeCap.Round) }
    val ArrowDown: ImageVector by lazy { strokes("down", listOf("M12 5v14M6 13l6 6 6-6"), width = 2.2f, cap = StrokeCap.Round) }
    val Delete: ImageVector by lazy { fill("delete", "M9 3h6l1 2h4v2H4V5h4l1-2zm1 6h2v9h-2V9zm4 0h2v9h-2V9zM6 7h12l-1 14H7L6 7z") }
    val Mic: ImageVector by lazy { fill("mic", "M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zm-7 9a7 7 0 0 0 6 6.9V21h2v-2.1A7 7 0 0 0 19 12h-2a5 5 0 0 1-10 0H5z") }
    val Volume: ImageVector by lazy { fill("volume", "M4 9h4l5-4v14l-5-4H4V9zm12.5 3a3.5 3.5 0 0 0-1.8-3.1l1.1-1.7A5.5 5.5 0 0 1 18.5 12a5.5 5.5 0 0 1-2.7 4.8l-1.1-1.7A3.5 3.5 0 0 0 16.5 12z") }
    val Tune: ImageVector by lazy { fill("tune", "M4 6h10v2H4V6zm12 0h4v2h-4V6zM4 11h4v2H4v-2zm6 0h10v2H10v-2zM4 16h8v2H4v-2zm10 0h6v2h-6v-2z") }
    val Translate: ImageVector by lazy { fill("translate", "M4 4h9v2H8.6A12 12 0 0 0 12 12.2 10 10 0 0 0 14.4 8H16a12 12 0 0 1-3.3 6.2A13 13 0 0 0 16 18h-2.1A11 11 0 0 1 12 14.7 11 11 0 0 1 9.9 18H8a13 13 0 0 0 3.2-4.2A14 14 0 0 1 7 6H4V4zm11 12h5v2h-5v-2z") }
    val Minus: ImageVector by lazy { fill("minus", "M5 11h14v2H5v-2z") }
    val Cancel: ImageVector by lazy { fill("cancel", "M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm3.7 6.3-3.7 3.7-3.7-3.7-1.4 1.4 3.7 3.7-3.7 3.7 1.4 1.4 3.7-3.7 3.7 3.7 1.4-1.4-3.7-3.7 3.7-3.7-1.4-1.4z") }
    val Camera: ImageVector by lazy { fill("camera", "M9 5h6l1.5 2H20a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h4.5L9 5zm3 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8z") }
    val Mouse: ImageVector by lazy { fill("mouse", "M11 2h2a5 5 0 0 1 5 5v5a6 6 0 0 1-12 0V7a5 5 0 0 1 5-5zm1 2h-1a3 3 0 0 0-3 3v2h4V4z") }
    val Inbox: ImageVector by lazy { fill("inbox", "M3 6h18v12H3V6zm2 2v5h4l1.2 2h3.6L15 13h4V8H5z") }
    val CloudOff: ImageVector by lazy { fill("cloud-off", "M4.2 5.6 5.6 4.2 19.8 18.4 18.4 19.8 16 17.4A6 6 0 0 1 6.2 13H6a4 4 0 0 1-.4-8h.2L4.2 5.6zM20 12.2A5 5 0 0 0 12.4 7l6.3 6.3c.8-.3 1.3-.7 1.3-1.1z") }
    val Error: ImageVector by lazy { Warn }
    val SystemUpdate: ImageVector by lazy { Download }

    private fun fill(name: String, d: String, evenOdd: Boolean = false): ImageVector =
        ImageVector.Builder(
            name = name,
            defaultWidth = 24.dp,
            defaultHeight = 24.dp,
            viewportWidth = 24f,
            viewportHeight = 24f,
        ).apply { addFilled(d, evenOdd) }.build()

    private fun ImageVector.Builder.addFilled(d: String, evenOdd: Boolean = false) {
        addPath(
            pathData = PathParser().parsePathString(d).toNodes(),
            fill = SolidColor(Color.Black),
            pathFillType = if (evenOdd) PathFillType.EvenOdd else PathFillType.NonZero,
        )
    }

    private fun strokes(
        name: String,
        paths: List<String>,
        width: Float,
        cap: StrokeCap = StrokeCap.Round,
        join: StrokeJoin = StrokeJoin.Miter,
    ): ImageVector = ImageVector.Builder(
        name = name,
        defaultWidth = 24.dp,
        defaultHeight = 24.dp,
        viewportWidth = 24f,
        viewportHeight = 24f,
    ).apply {
        for (d in paths) {
            addPath(
                pathData = PathParser().parsePathString(d).toNodes(),
                fill = null,
                stroke = SolidColor(Color.Black),
                strokeLineWidth = width,
                strokeLineCap = cap,
                strokeLineJoin = join,
            )
        }
    }.build()
}
