package one.zephyr.mobile.ui.component

/**
 * Window-independent numbers for the confirmation sheet.
 *
 * Compose [androidx.compose.ui.window.Dialog] sizes itself WRAP_CONTENT. Measuring the sheet
 * against that wrap height and then subtracting a gutter clips the cancel group (the screenshot
 * of the SSH/RDP host-key prompt). These helpers take the *screen* height, not the dialog's
 * wrap height, so the same sheet stays fully on screen for every protocol.
 */
object AlertDialogLayout {
    const val MAX_SHEET_DP = 640f
    const val EDGE_GUTTER_DP = 10f
    const val GROUP_GAP_DP = 8f
    const val ACTION_MIN_DP = 50f
    const val TITLE_TOP_PAD_DP = 16f
    const val BODY_VERTICAL_PAD_DP = 8f
    const val FINGERPRINT_GROUP = 4
    const val FINGERPRINT_GROUPS_PER_LINE = 6

    /** Dark-scheme floating sheet, forced opaque so Extra Keys cannot bleed through. */
    val DARK_SHEET_ARGB: Int = 0xFF1A1E25.toInt()

    /** Light-scheme floating sheet, forced opaque. */
    val LIGHT_SHEET_ARGB: Int = 0xFFFFFFFF.toInt()

    fun sheetArgb(dark: Boolean): Int = if (dark) DARK_SHEET_ARGB else LIGHT_SHEET_ARGB

    /**
     * Tallest the stacked groups may be.
     *
     * [windowHeightDp] is the physical window, not Dialog wrap-content. Subtracting the wrap
     * height would reproduce the cropped cancel button.
     */
    fun availableHeightDp(windowHeightDp: Float): Float =
        minOf(windowHeightDp - EDGE_GUTTER_DP * 2f, MAX_SHEET_DP).coerceAtLeast(120f)

    /**
     * The sheet is fully visible only when it is shorter than the window and still has room
     * for the cancel group after the body has taken its share.
     */
    fun sheetFits(
        windowHeightDp: Float,
        bodyHeightDp: Float,
        hasDismiss: Boolean,
    ): Boolean {
        val available = availableHeightDp(windowHeightDp)
        val stacked = stackedHeightDp(bodyHeightDp, hasDismiss)
        return stacked <= available + 0.01f && stacked <= windowHeightDp - EDGE_GUTTER_DP
    }

    fun stackedHeightDp(bodyHeightDp: Float, hasDismiss: Boolean): Float {
        val groups = if (hasDismiss) bodyHeightDp + GROUP_GAP_DP + ACTION_MIN_DP else bodyHeightDp
        return groups + EDGE_GUTTER_DP
    }

    /**
     * Break a SHA-256 fingerprint so a 360dp phone never has to clip or overflow it.
     *
     * OpenSSH (`SHA256:` + unpadded base64) and colon-hex TLS both become 4-character groups.
     * Six groups per line (~36 glyphs with the SHA256: prefix) is the widest line that still
     * fits the 20dp padded sheet on a 360dp device at the 13.5sp mono size. The screenshot
     * fingerprint is 11 groups, so it must break onto a second line.
     */
    fun wrapFingerprint(raw: String): String {
        val compact = raw.replace("\\s+".toRegex(), "")
        if (compact.isEmpty()) return raw
        val colon = compact.indexOf(':')
        val head = if (colon in 1..8) compact.substring(0, colon) else ""
        // SHA256 / MD5 carry a non-hex letter. A leading TLS pair such as "A1:" is hex-only
        // and must stay in the payload, or the wrap would drop the first byte.
        val prefixEnd = if (head.isNotEmpty() && head.any { !it.isHexDigit() }) colon + 1 else 0
        val prefix = compact.substring(0, prefixEnd)
        val payload = compact.substring(prefixEnd).replace(":", "")
        if (payload.isEmpty()) return compact
        val groups = payload.chunked(FINGERPRINT_GROUP)
        val lines = groups.chunked(FINGERPRINT_GROUPS_PER_LINE).map { it.joinToString(" ") }
        return if (prefix.isEmpty()) {
            lines.joinToString("\n")
        } else {
            prefix + lines.first() + lines.drop(1).joinToString("") { "\n" + it }
        }
    }

    private fun Char.isHexDigit(): Boolean =
        this in '0'..'9' || this in 'A'..'F' || this in 'a'..'f'
}
