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
    val Eye: ImageVector by lazy { fill("i-eye", "M12 4C6.5 4 2.2 8.1 1 12c1.2 3.9 5.5 8 11 8s9.8-4.1 11-8c-1.2-3.9-5.5-8-11-8zm0 2c3.9 0 7.4 2.7 8.7 6-1.3 3.3-4.8 6-8.7 6s-7.4-2.7-8.7-6C4.6 8.7 8.1 6 12 6zm0 2.5A3.5 3.5 0 1 0 12 15.5 3.5 3.5 0 0 0 12 8.5z", evenOdd = true) }
    val EyeOff: ImageVector by lazy { fill("i-eye-off", "M3.3 2 22 20.7 20.7 22l-3-3A11 11 0 0 1 12 20C6.5 20 2.2 15.9 1 12a13 13 0 0 1 3.2-5.1L2 4.7 3.3 2zm2.3 6.3A10 10 0 0 0 3.3 12c1.3 3.3 4.8 6 8.7 6 1.5 0 2.9-.4 4.1-1L14.5 15.4A3.5 3.5 0 0 1 8.6 9.5L5.6 8.3zM12 4c5.5 0 9.8 4.1 11 8a12.7 12.7 0 0 1-2.7 4.6l-1.4-1.4a10.5 10.5 0 0 0 1.8-3.2c-1.3-3.3-4.8-6-8.7-6-.9 0-1.8.1-2.6.4L7.8 4.8C9.1 4.3 10.5 4 12 4zm0 4.5a3.5 3.5 0 0 1 3.5 3.5c0 .4-.1.8-.2 1.2L10.8 8.7c.4-.1.8-.2 1.2-.2z") }
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

    /* ── 远端系统图标（与 Zephyr 网页端 CONNECTION_OS_ICONS 同一套 path）──────
       品牌色不进 path：Compose 的 fill 固定 Color.Black，由调用方 tint 上色，
       这样浅色/深色主题下 currentColor 类图标（macos/linux/unknown）能跟随主题。 */
    val OsWindows: ImageVector by lazy { fill("os-windows", "M0 0h11v11H0zM13 0h11v11H13zM0 13h11v11H0zM13 13h11v11H13z") }
    val OsMacos: ImageVector by lazy { fill("os-macos", "M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701") }
    val OsUbuntu: ImageVector by lazy { fill("os-ubuntu", "M17.61.455a3.41 3.41 0 0 0-3.41 3.41 3.41 3.41 0 0 0 3.41 3.41 3.41 3.41 0 0 0 3.41-3.41 3.41 3.41 0 0 0-3.41-3.41zM12.92.8C8.923.777 5.137 2.941 3.148 6.451a4.5 4.5 0 0 1 .26-.007 4.92 4.92 0 0 1 2.585.737A8.316 8.316 0 0 1 12.688 3.6 4.944 4.944 0 0 1 13.723.834 11.008 11.008 0 0 0 12.92.8zm9.226 4.994a4.915 4.915 0 0 1-1.918 2.246 8.36 8.36 0 0 1-.273 8.303 4.89 4.89 0 0 1 1.632 2.54 11.156 11.156 0 0 0 .559-13.089zM3.41 7.932A3.41 3.41 0 0 0 0 11.342a3.41 3.41 0 0 0 3.41 3.409 3.41 3.41 0 0 0 3.41-3.41 3.41 3.41 0 0 0-3.41-3.41zm2.027 7.866a4.908 4.908 0 0 1-2.915.358 11.1 11.1 0 0 0 7.991 6.698 11.234 11.234 0 0 0 2.422.249 4.879 4.879 0 0 1-.999-2.85 8.484 8.484 0 0 1-.836-.136 8.304 8.304 0 0 1-5.663-4.32zm11.405.928a3.41 3.41 0 0 0-3.41 3.41 3.41 3.41 0 0 0 3.41 3.41 3.41 3.41 0 0 0 3.41-3.41 3.41 3.41 0 0 0-3.41-3.41z") }
    val OsDebian: ImageVector by lazy { fill("os-debian", "M13.88 12.685c-.4 0 .08.2.601.28.14-.1.27-.22.39-.33a3.001 3.001 0 01-.99.05m2.14-.53c.23-.33.4-.69.47-1.06-.06.27-.2.5-.33.73-.75.47-.07-.27 0-.56-.8 1.01-.11.6-.14.89m.781-2.05c.05-.721-.14-.501-.2-.221.07.04.13.5.2.22M12.38.31c.2.04.45.07.42.12.23-.05.28-.1-.43-.12m.43.12l-.15.03.14-.01V.43m6.633 9.944c.02.64-.2.95-.38 1.5l-.35.181c-.28.54.03.35-.17.78-.44.39-1.34 1.22-1.62 1.301-.201 0 .14-.25.19-.34-.591.4-.481.6-1.371.85l-.03-.06c-2.221 1.04-5.303-1.02-5.253-3.842-.03.17-.07.13-.12.2a3.551 3.552 0 012.001-3.501 3.361 3.362 0 013.732.48 3.341 3.342 0 00-2.721-1.3c-1.18.01-2.281.76-2.651 1.57-.6.38-.67 1.47-.93 1.661-.361 2.601.66 3.722 2.38 5.042.27.19.08.21.12.35a4.702 4.702 0 01-1.53-1.16c.23.33.47.66.8.91-.55-.18-1.27-1.3-1.48-1.35.93 1.66 3.78 2.921 5.261 2.3a6.203 6.203 0 01-2.33-.28c-.33-.16-.77-.51-.7-.57a5.802 5.803 0 005.902-.84c.44-.35.93-.94 1.07-.95-.2.32.04.16-.12.44.44-.72-.2-.3.46-1.24l.24.33c-.09-.6.74-1.321.66-2.262.19-.3.2.3 0 .97.29-.74.08-.85.15-1.46.08.2.18.42.23.63-.18-.7.2-1.2.28-1.6-.09-.05-.28.3-.32-.53 0-.37.1-.2.14-.28-.08-.05-.26-.32-.38-.861.08-.13.22.33.34.34-.08-.42-.2-.75-.2-1.08-.34-.68-.12.1-.4-.3-.34-1.091.3-.25.34-.74.54.77.84 1.96.981 2.46-.1-.6-.28-1.2-.49-1.76.16.07-.26-1.241.21-.37A7.823 7.824 0 0017.702 1.6c.18.17.42.39.33.42-.75-.45-.62-.48-.73-.67-.61-.25-.65.02-1.06 0C15.082.73 14.862.8 13.8.4l.05.23c-.77-.25-.9.1-1.73 0-.05-.04.27-.14.53-.18-.741.1-.701-.14-1.431.03.17-.13.36-.21.55-.32-.6.04-1.44.35-1.18.07C9.6.68 7.847 1.3 6.867 2.22L6.838 2c-.45.54-1.96 1.611-2.08 2.311l-.131.03c-.23.4-.38.85-.57 1.261-.3.52-.45.2-.4.28-.6 1.22-.9 2.251-1.16 3.102.18.27 0 1.65.07 2.76-.3 5.463 3.84 10.776 8.363 12.006.67.23 1.65.23 2.49.25-.99-.28-1.12-.15-2.08-.49-.7-.32-.85-.7-1.34-1.13l.2.35c-.971-.34-.57-.42-1.361-.67l.21-.27c-.31-.03-.83-.53-.97-.81l-.34.01c-.41-.501-.63-.871-.61-1.161l-.111.2c-.13-.21-1.52-1.901-.8-1.511-.13-.12-.31-.2-.5-.55l.14-.17c-.35-.44-.64-1.02-.62-1.2.2.24.32.3.45.33-.88-2.172-.93-.12-1.601-2.202l.15-.02c-.1-.16-.18-.34-.26-.51l.06-.6c-.63-.74-.18-3.102-.09-4.402.07-.54.53-1.1.88-1.981l-.21-.04c.4-.71 2.341-2.872 3.241-2.761.43-.55-.09 0-.18-.14.96-.991 1.26-.7 1.901-.88.7-.401-.6.16-.27-.151 1.2-.3.85-.7 2.421-.85.16.1-.39.14-.52.26 1-.49 3.151-.37 4.562.27 1.63.77 3.461 3.011 3.531 5.132l.08.02c-.04.85.13 1.821-.17 2.711l.2-.42M9.54 13.236l-.05.28c.26.35.47.73.8 1.01-.24-.47-.42-.66-.75-1.3m.62-.02c-.14-.15-.22-.34-.31-.52.08.32.26.6.43.88l-.12-.36m10.945-2.382l-.07.15c-.1.76-.34 1.511-.69 2.212.4-.73.65-1.541.75-2.362M12.45.12c.27-.1.66-.05.95-.12-.37.03-.74.05-1.1.1l.15.02M3.006 5.142c.07.57-.43.8.11.42.3-.66-.11-.18-.1-.42m-.64 2.661c.12-.39.15-.62.2-.84-.35.44-.17.53-.2.83") }
    val OsArch: ImageVector by lazy { fill("os-arch", "M11.39.605C10.376 3.092 9.764 4.72 8.635 7.132c.693.734 1.543 1.589 2.923 2.554-1.484-.61-2.496-1.224-3.252-1.86C6.86 10.842 4.596 15.138 0 23.395c3.612-2.085 6.412-3.37 9.021-3.862a6.61 6.61 0 01-.171-1.547l.003-.115c.058-2.315 1.261-4.095 2.687-3.973 1.426.12 2.534 2.096 2.478 4.409a6.52 6.52 0 01-.146 1.243c2.58.505 5.352 1.787 8.914 3.844-.702-1.293-1.33-2.459-1.929-3.57-.943-.73-1.926-1.682-3.933-2.713 1.38.359 2.367.772 3.137 1.234-6.09-11.334-6.582-12.84-8.67-17.74zM22.898 21.36v-.623h-.234v-.084h.562v.084h-.234v.623h.331v-.707h.142l.167.5.034.107a2.26 2.26 0 01.038-.114l.17-.493H24v.707h-.091v-.593l-.206.593h-.084l-.205-.602v.602h-.091") }
    val OsAlpine: ImageVector by lazy { fill("os-alpine", "M5.998 1.607L0 12l5.998 10.393h12.004L24 12 18.002 1.607H5.998zM9.965 7.12L12.66 9.9l1.598 1.595.002-.002 2.41 2.363c-.2.14-.386.252-.563.344a3.756 3.756 0 01-.496.217 2.702 2.702 0 01-.425.111c-.131.023-.25.034-.358.034-.13 0-.242-.014-.338-.034a1.317 1.317 0 01-.24-.072.95.95 0 01-.2-.113l-1.062-1.092-3.039-3.041-1.1 1.053-3.07 3.072a.974.974 0 01-.2.111 1.274 1.274 0 01-.237.073c-.096.02-.209.033-.338.033-.108 0-.227-.009-.358-.031a2.7 2.7 0 01-.425-.114 3.748 3.748 0 01-.496-.217 5.228 5.228 0 01-.563-.343l6.803-6.727zm4.72.785l4.579 4.598 1.382 1.353a5.24 5.24 0 01-.564.344 3.73 3.73 0 01-.494.217 2.697 2.697 0 01-.426.111c-.13.023-.251.034-.36.034-.129 0-.241-.014-.337-.034a1.285 1.285 0 01-.385-.146c-.033-.02-.05-.036-.053-.04l-1.232-1.218-2.111-2.111-.334.334L12.79 9.8l1.896-1.897zm-5.966 4.12v2.529a2.128 2.128 0 01-.356-.035 2.765 2.765 0 01-.422-.116 3.708 3.708 0 01-.488-.214 5.217 5.217 0 01-.555-.34l1.82-1.825Z") }
    val OsRaspberry: ImageVector by lazy { fill("os-raspberry", "m19.8955 10.8961-.1726-.3028c.0068-2.1746-1.0022-3.061-2.1788-3.7348.356-.0938.7237-.1711.8245-.6182.6118-.1566.7397-.4398.8011-.7398.16-.1066.6955-.4061.6394-.9211.2998-.2069.4669-.4725.3819-.8487.3222-.3515.407-.6419.2702-.9096.3868-.4805.2152-.7295.05-.9817.2897-.5254.0341-1.0887-.7758-.9944-.3221-.4733-1.0244-.3659-1.133-.3637-.1215-.1519-.2819-.2821-.7755-.219-.3197-.2851-.6771-.2364-1.0458-.0964-.4378-.3403-.7275-.0675-1.0584.0356-.53-.1706-.6513.0631-.9117.1583-.5781-.1203-.7538.1416-1.0309.4182l-.3224-.0063c-.8719.5061-1.305 1.5366-1.4585 2.0664-.1536-.5299-.5858-1.5604-1.4575-2.0664l-.3223.0063C9.942.5014 9.7663.2394 9.1883.3597 8.9279.2646 8.807.0309 8.2766.2015c-.2172-.0677-.417-.2084-.6522-.2012l.0004.0002C7.5017.0041 7.369.049 7.2185.166c-.3688-.1401-.7262-.1887-1.0459.0964-.4936-.0631-.654.0671-.7756.219C5.2887.4791 4.5862.3717 4.264.845c-.8096-.0943-1.0655.4691-.7756.9944-.1653.2521-.3366.5013.05.9819-.1367.2677-.0519.5581.2703.9096-.085.3763.0822.6418.3819.8487-.0561.515.4795.8144.6394.9211.0614.3001.1894.5832.8011.7398.1008.4472.4685.5244.8245.6183-1.1766.6737-2.1856 1.56-2.1788 3.7348l-.1724.3028c-1.3491.8082-2.5629 3.4056-.6648 5.5167.124.6609.3319 1.1355.5171 1.6609.2769 2.117 2.0841 3.1082 2.5608 3.2255.6984.524 1.4423 1.0212 2.449 1.3696.949.964 1.977 1.3314 3.0107 1.3308.0152 0 .0306.0002.0457 0 1.0337.0006 2.0618-.3668 3.0107-1.3308 1.0067-.3483 1.7506-.8456 2.4491-1.3696.4766-.1173 2.2838-1.1085 2.5607-3.2255.1851-.5253.3931-1 .517-1.6609 1.8981-2.1113.6843-4.7089-.6649-5.517zm-1.0386-.3715c-.0704.8759-4.6354-3.0504-3.8472-3.1808 2.1391-.3558 3.9191.896 3.8472 3.1808zm-2.0155 4.3649c-1.1481.7409-2.8025.2626-3.6953-1.0681-.8928-1.3306-.6858-3.0101.4623-3.7509 1.1481-.7409 2.8025-.2627 3.6953 1.068.8927 1.3307.6858 3.0101-.4623 3.751z") }
    val OsRedhat: ImageVector by lazy { fill("os-redhat", "M16.009 13.386c1.577 0 3.86-.326 3.86-2.202a1.765 1.765 0 0 0-.04-.431l-.94-4.08c-.216-.898-.406-1.305-1.982-2.093-1.223-.625-3.888-1.658-4.676-1.658-.733 0-.947.946-1.822.946-.842 0-1.467-.706-2.255-.706-.757 0-1.25.515-1.63 1.576 0 0-1.06 2.99-1.197 3.424a.81.81 0 0 0-.028.245c0 1.162 4.577 4.974 10.71 4.974m4.101-1.435c.218 1.032.218 1.14.218 1.277 0 1.765-1.984 2.745-4.593 2.745-5.895.004-11.06-3.451-11.06-5.734a2.326 2.326 0 0 1 .19-.925C2.746 9.415 0 9.794 0 12.217c0 3.969 9.405 8.861 16.851 8.861 5.71 0 7.149-2.582 7.149-4.62 0-1.605-1.387-3.425-3.887-4.512") }
    val OsLinux: ImageVector by lazy { fill("os-linux", "M12.003 0c-2.42 0-4.385 1.96-4.385 4.38 0 .42.06.83.17 1.22C6.388 6.46 5.158 8.04 5.158 9.94c0 .48.08.94.23 1.37-.99.78-1.62 1.97-1.62 3.32 0 1.92 1.28 3.54 3.05 4.09.43 2.99 2.99 5.28 6.185 5.28 3.2 0 5.75-2.29 6.19-5.28 1.77-.55 3.05-2.17 3.05-4.09 0-1.35-.63-2.54-1.62-3.32.15-.43.23-.89.23-1.37 0-1.9-1.23-3.48-2.63-4.34.11-.39.17-.8.17-1.22C16.388 1.96 14.423 0 12.003 0z") }

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
        strokes("back", listOf("M15 5l-7 7 7 7"), width = 2.6f, cap = StrokeCap.Round)
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

    /* Every system glyph is authored in the same 0..24 box the web app declares
     * as its viewBox. The artwork inside that box is not itself square — Debian's
     * swirl is taller than it is wide — and that is how the web app draws it too.
     * Shrinking the viewport to the artwork's extent crops the negative space and
     * stretches the glyph, so the viewport stays 24 for all of them. */
    private fun fill(name: String, d: String, evenOdd: Boolean = false, viewport: Float = 24f): ImageVector =
        ImageVector.Builder(
            name = name,
            defaultWidth = 24.dp,
            defaultHeight = 24.dp,
            viewportWidth = viewport,
            viewportHeight = viewport,
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
