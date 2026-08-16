package one.zephyr.mobile.ui.component

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The host-key / certificate sheet is shared by SSH, RDP and VNC. These numbers
 * are what the screenshot failed: a WRAP_CONTENT Dialog measured against itself
 * cropped the cancel group, and a single-line SHA-256 overflowed the card.
 */
class AlertDialogLayoutTest {

    @Test
    fun availableHeightUsesTheWindowNotTheWrapContentDialog() {
        // A 780dp phone. The old formula used Dialog wrap-content (~220dp) and
        // then subtracted 20dp, which is exactly how the cancel group vanished.
        assertEquals(640f, AlertDialogLayout.availableHeightDp(780f), 0.001f)
        assertEquals(340f, AlertDialogLayout.availableHeightDp(360f), 0.001f)
        assertEquals(120f, AlertDialogLayout.availableHeightDp(80f), 0.001f)
    }

    @Test
    fun firstContactSheetFitsAPhoneAndKeepsTheCancelGroup() {
        val body = 180f
        assertTrue(AlertDialogLayout.sheetFits(780f, body, hasDismiss = true))
        val stacked = AlertDialogLayout.stackedHeightDp(body, hasDismiss = true)
        assertEquals(body + 8f + 50f + 10f, stacked, 0.001f)
        assertTrue(stacked < 780f)
    }

    @Test
    fun measuringAgainstWrapContentWouldClipTheCancelGroup() {
        // Reproduce the screenshot: Dialog wrap height ≈ card + gutter, no room
        // left for the separate cancel group.
        val wrapHeight = 220f
        val body = 180f
        assertFalse(AlertDialogLayout.sheetFits(wrapHeight, body, hasDismiss = true))
        assertTrue(AlertDialogLayout.sheetFits(780f, body, hasDismiss = true))
    }

    @Test
    fun opensshFingerprintWrapsIntoFourCharacterGroups() {
        val raw = "SHA256:QytVAAei+gY5ISAlZF3D6WfcZGOaTGY+ygTPRiDSbl0"
        val wrapped = AlertDialogLayout.wrapFingerprint(raw)
        assertEquals(
            "SHA256:QytV AAei +gY5 ISAl ZF3D 6Wfc\nZGOa TGY+ ygTP RiDS bl0",
            wrapped,
        )
        val longest = wrapped.lineSequence().maxOf { it.length }
        assertTrue("longest line $longest glyphs overflows a 360dp sheet", longest <= 48)
        assertFalse(wrapped.contains("SHA256:QytVAAei+gY5ISAlZF3D6WfcZGOaTGY+ygTPRiDSbl0"))
    }

    @Test
    fun colonHexTlsFingerprintWrapsWithoutLosingBytes() {
        val raw = (0..31).joinToString(":") { byte -> "%02X".format(byte) }
        val wrapped = AlertDialogLayout.wrapFingerprint(raw)
        assertEquals(raw.replace(":", ""), wrapped.replace(Regex("[\\s:]"), ""))
        assertTrue(wrapped.startsWith("0001 0203"))
        assertFalse(wrapped.startsWith("00:"))
        assertTrue(wrapped.contains("\n"))
        val longest = wrapped.lineSequence().maxOf { it.length }
        assertTrue("longest TLS line $longest glyphs overflows", longest <= 48)
    }

    @Test
    fun hexOnlyHeadIsNotTreatedAsAnAlgorithmPrefix() {
        val raw = "A1:B2:C3:D4:E5:F6:01:23:45:67:89:AB:CD:EF:00:11"
        val wrapped = AlertDialogLayout.wrapFingerprint(raw)
        assertTrue(wrapped.startsWith("A1B2"))
        assertEquals(raw.replace(":", ""), wrapped.replace(Regex("[\\s:]"), ""))
    }

    @Test
    fun wrappingIsIdempotentAndDoesNotInventGlyphs() {
        val raw = "SHA256:QytVAAei+gY5ISAlZF3D6WfcZGOaTGY+ygTPRiDSbl0"
        val once = AlertDialogLayout.wrapFingerprint(raw)
        assertEquals(once, AlertDialogLayout.wrapFingerprint(once))
        val restored = once.replace("\n", "").replace(" ", "")
        assertEquals(raw.replace(":", ""), restored)
        assertEquals(raw.replace(":", "").length, restored.length)
    }

    @Test
    fun sheetColorIsForcedOpaqueInBothSchemes() {
        assertEquals(0xFF1A1E25.toInt(), AlertDialogLayout.sheetArgb(dark = true))
        assertEquals(0xFFFFFFFF.toInt(), AlertDialogLayout.sheetArgb(dark = false))
        assertEquals(0xFF, (AlertDialogLayout.DARK_SHEET_ARGB ushr 24) and 0xFF)
        assertEquals(0xFF, (AlertDialogLayout.LIGHT_SHEET_ARGB ushr 24) and 0xFF)
    }
}
