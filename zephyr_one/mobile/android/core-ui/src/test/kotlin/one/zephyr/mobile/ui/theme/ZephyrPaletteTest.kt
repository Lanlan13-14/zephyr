package one.zephyr.mobile.ui.theme

import androidx.compose.ui.graphics.Color
import org.junit.Assert.assertEquals
import org.junit.Test

class ZephyrPaletteTest {

    @Test
    fun `frost accents match demo data-theme`() {
        val dark = ZephyrPalette.of(ZephyrThemeId.FROST, dark = true)
        assertEquals(Color(0xFF0A84FF), dark.brand.accent)
        assertEquals(Color(0xFF8E99A6), dark.brand.muted)
        assertEquals(Color(0xFF0A0C0F), dark.surfaces.background)
        assertEquals(Color(0xFF13161B), dark.surfaces.content)
        assertEquals(Color(0xFF1B1F26), dark.surfaces.elevated)
        assertEquals(Color(0xFFF2F4F7), dark.onBackground)
        assertEquals(Color(0xFF9AA4B0), dark.onFloatingMuted)
        assertEquals(Color(0xFF5D6773), dark.onFloatingSubtle)
        assertEquals(Color(0xFF30D158), dark.status.success)
        assertEquals(Color(0xFFFF453A), dark.status.error)
        assertEquals(Color(0xFF0A84FF), dark.protocol.ssh)
        assertEquals(Color(0xFFBF5AF2), dark.protocol.rdp)
    }

    @Test
    fun `light scheme matches demo data-scheme light`() {
        val light = ZephyrPalette.of(ZephyrThemeId.FROST, dark = false)
        assertEquals(Color(0xFFEEF0F4), light.surfaces.background)
        assertEquals(Color(0xFFF7F8FA), light.surfaces.content)
        assertEquals(Color(0xFFFFFFFF), light.surfaces.elevated)
        assertEquals(Color(0xFF14181D), light.onBackground)
        assertEquals(Color(0xFF5B6570), light.onFloatingMuted)
        assertEquals(Color(0xFFF3F5F7), light.surfaces.termBackground)
    }

    @Test
    fun `theme ids only change the accent`() {
        val frost = ZephyrPalette.of(ZephyrThemeId.FROST, dark = true)
        val lava = ZephyrPalette.of(ZephyrThemeId.LAVA, dark = true)
        assertEquals(Color(0xFFBF5A1F), lava.brand.accent)
        assertEquals(frost.surfaces.background, lava.surfaces.background)
        assertEquals(frost.status.error, lava.status.error)
    }

    @Test
    fun `unknown wire name falls back to frost`() {
        assertEquals(ZephyrThemeId.FROST, ZephyrThemeId.fromWire("nope"))
        assertEquals(ZephyrThemeId.ASAGI, ZephyrThemeId.fromWire("asagi"))
    }
}
