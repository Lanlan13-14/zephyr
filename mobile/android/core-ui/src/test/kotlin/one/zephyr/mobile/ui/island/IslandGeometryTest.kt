package one.zephyr.mobile.ui.island

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Island arithmetic against the frozen numbers in DEVELOPMENT.md 6.1.1.
 *
 * These are the values a screenshot cannot prove: that a 320dp phone still clears the 48dp touch
 * floor, that a tablet stops at 520dp, and that a pill never grows past its own slot.
 */
class IslandGeometryTest {

    private val icon = 24f
    private val gap = 10f
    private val pad = 20f

    @Test
    fun outerWidthSubtractsBothInsetsAndCapsAtMaxWidth() {
        assertEquals(360f - 32f, IslandGeometry.outerWidth(360f, 16f, 520f), 0.001f)
        // Tablet: capped, not stretched into a full-width bar.
        assertEquals(520f, IslandGeometry.outerWidth(1024f, 16f, 520f), 0.001f)
    }

    @Test
    fun slotsSplitTheInnerWidthEvenly() {
        val outer = IslandGeometry.outerWidth(360f, 16f, 520f)
        val inner = IslandGeometry.innerWidth(outer, 6f)
        assertEquals(328f - 12f, inner, 0.001f)
        assertEquals(inner / 4f, IslandGeometry.slotWidth(inner), 0.001f)
    }

    @Test
    fun everySupportedWidthClearsTheAndroidTouchFloor() {
        // 320dp is the narrowest width the app supports; below the floor the layout would be illegal.
        for (screen in listOf(320f, 360f, 393f, 411f, 480f, 600f, 800f, 1024f)) {
            val outer = IslandGeometry.outerWidth(screen, 16f, 520f)
            val slot = IslandGeometry.slotWidth(IslandGeometry.innerWidth(outer, 6f))
            assertTrue(
                "slot " + slot + "dp at screen " + screen + "dp is below the 48dp floor",
                IslandGeometry.meetsTouchTargetFloor(slot, 48f),
            )
        }
    }

    @Test
    fun desiredPillWidthIsIconPlusLabelPlusPadding() {
        assertEquals(2 * pad + icon, IslandGeometry.desiredPillWidth(0f, icon, gap, pad), 0.001f)
        assertEquals(2 * pad + icon + gap + 30f, IslandGeometry.desiredPillWidth(30f, icon, gap, pad), 0.001f)
    }

    @Test
    fun labelIsDroppedRatherThanOverflowingItsSlot() {
        val slot = 79f
        assertFalse(IslandGeometry.labelFits(slot, 40f, icon, gap, pad))
        // Degraded to icon-only, and still clamped inside the slot.
        assertEquals(2 * pad + icon, IslandGeometry.pillWidth(slot, 40f, icon, gap, pad), 0.001f)
        assertTrue(IslandGeometry.pillWidth(slot, 40f, icon, gap, pad) <= slot)
    }

    @Test
    fun labelIsShownWhenItFits() {
        val slot = 120f
        assertTrue(IslandGeometry.labelFits(slot, 30f, icon, gap, pad))
        assertEquals(2 * pad + icon + gap + 30f, IslandGeometry.pillWidth(slot, 30f, icon, gap, pad), 0.001f)
    }

    @Test
    fun pillIsCentredInsideItsSlot() {
        val slot = 100f
        val pill = 80f
        assertEquals(10f, IslandGeometry.pillLeft(0, slot, pill), 0.001f)
        assertEquals(110f, IslandGeometry.pillLeft(1, slot, pill), 0.001f)
        assertEquals(310f, IslandGeometry.pillLeft(3, slot, pill), 0.001f)
    }

    @Test
    fun cornerRadiusIsExactlyHalfTheHeight() {
        assertEquals(36f, IslandGeometry.outerCornerRadius(72f), 0.001f)
    }

    @Test
    fun bottomGapTakesTheLargerOfSafeAreaAndFrozenMinimum() {
        assertEquals(10f, IslandGeometry.bottomGap(0f, 10f), 0.001f)
        assertEquals(10f, IslandGeometry.bottomGap(8f, 10f), 0.001f)
        assertEquals(34f, IslandGeometry.bottomGap(34f, 10f), 0.001f)
    }

    @Test
    fun contentInsetLetsTheLastRowClearTheIsland() {
        // 72 island + 12 gap + max(24, 10) safe area
        assertEquals(108f, IslandGeometry.contentBottomInset(72f, 12f, 24f, 10f), 0.001f)
        assertEquals(94f, IslandGeometry.contentBottomInset(72f, 12f, 0f, 10f), 0.001f)
    }

    @Test
    fun zeroCountCannotDivideByZero() {
        assertEquals(0f, IslandGeometry.slotWidth(320f, 0), 0.001f)
    }
}
