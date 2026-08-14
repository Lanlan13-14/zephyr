package one.zephyr.mobile.ui.theme

import org.junit.Assert.assertEquals
import org.junit.Test

class MotionTokensTest {

    @Test
    fun `durations match demo root variables`() {
        assertEquals(120, ZephyrMotionTokens.PRESS_MS)
        assertEquals(160, ZephyrMotionTokens.FAST_MS)
        assertEquals(240, ZephyrMotionTokens.MED_MS)
        assertEquals(420, ZephyrMotionTokens.SHEET_MS)
        assertEquals(340, IslandSpec.SELECTION_MS)
        assertEquals(180, IslandSpec.LABEL_CROSSFADE_MS)
    }

    @Test
    fun `press scales match demo active states`() {
        assertEquals(0.98f, ZephyrMotionTokens.PRESS_SCALE)
        assertEquals(0.94f, ZephyrMotionTokens.ISLAND_PRESS_SCALE)
        assertEquals(0.92f, ZephyrMotionTokens.BACK_PRESS_SCALE)
        assertEquals(0.90f, ZephyrMotionTokens.HEAD_PRESS_SCALE)
    }

    @Test
    fun `radius ladder matches demo r-sm md lg xl`() {
        assertEquals(10f, ZephyrRadius.sm.value)
        assertEquals(14f, ZephyrRadius.md.value)
        assertEquals(20f, ZephyrRadius.lg.value)
        assertEquals(28f, ZephyrRadius.xl.value)
    }
}
