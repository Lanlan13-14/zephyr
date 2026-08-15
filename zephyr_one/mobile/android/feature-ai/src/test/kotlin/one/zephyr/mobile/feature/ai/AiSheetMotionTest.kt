package one.zephyr.mobile.feature.ai

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AiSheetMotionTest {

    private val phone = 800f

    @Test
    fun `detents match demo fractions`() {
        assertEquals(0.30f, AiDetent.PEEK.fraction)
        assertEquals(0.55f, AiDetent.HALF.fraction)
        assertEquals(0.92f, AiDetent.EXPANDED.fraction)
        assertEquals(240f, AiSheetGeometry.heightPx(AiDetent.PEEK, phone))
        assertEquals(440f, AiSheetGeometry.heightPx(AiDetent.HALF, phone))
        assertEquals(736f, AiSheetGeometry.heightPx(AiDetent.EXPANDED, phone))
    }

    @Test
    fun `fab opens to half not peek or expanded`() {
        assertEquals(AiDetent.HALF, AiSheetMotion.open())
    }

    @Test
    fun `phone expanded is the only scrim state`() {
        assertTrue(AiSheetMotion.showScrim(AiDetent.EXPANDED, AiLayout.PHONE))
        assertFalse(AiSheetMotion.showScrim(AiDetent.HALF, AiLayout.PHONE))
        assertFalse(AiSheetMotion.showScrim(AiDetent.PEEK, AiLayout.PHONE))
        assertFalse(AiSheetMotion.showScrim(AiDetent.EXPANDED, AiLayout.PAD))
        assertFalse(AiSheetMotion.showScrim(null, AiLayout.PHONE))
    }

    @Test
    fun `fab hides while the sheet is open and when AI is off`() {
        assertTrue(AiSheetMotion.fabVisible(enabled = true, detent = null))
        assertFalse(AiSheetMotion.fabVisible(enabled = true, detent = AiDetent.HALF))
        assertFalse(AiSheetMotion.fabVisible(enabled = false, detent = null))
    }

    @Test
    fun `back walks expanded half peek closed and picker first`() {
        val expanded = AiSheetState(detent = AiDetent.EXPANDED)
        val half = AiSheetMotion.back(expanded)
        val peek = AiSheetMotion.back(half)
        val closed = AiSheetMotion.back(peek)
        assertEquals(AiDetent.HALF, half.detent)
        assertEquals(AiDetent.PEEK, peek.detent)
        assertNull(closed.detent)
        assertNull(AiSheetMotion.back(AiSheetState()).detent)

        val picker = AiSheetState(detent = AiDetent.HALF, pickerOpen = true)
        val afterPicker = AiSheetMotion.back(picker)
        assertEquals(AiDetent.HALF, afterPicker.detent)
        assertFalse(afterPicker.pickerOpen)
    }

    @Test
    fun `disabling AI closes the sheet without cancelling a run`() {
        val running = AiSheetState(detent = AiDetent.HALF, runActive = true)
        val hidden = AiSheetMotion.hidePanel(running)
        assertNull(hidden.detent)
        assertTrue(hidden.runActive)
        assertFalse(AiSheetMotion.disable(enabled = false, state = running).isOpen)
        assertTrue(AiSheetMotion.disable(enabled = true, state = running).isOpen)
    }

    @Test
    fun `flick down past 40px closes even when height is still nearer half`() {
        val half = AiSheetGeometry.heightPx(AiDetent.HALF, phone)
        val current = half - 50f
        assertTrue(current > AiSheetGeometry.heightPx(AiDetent.PEEK, phone))
        assertEquals(AiDetent.HALF, AiSheetMotion.nearestWithoutVelocity(current, phone))
        assertNull(
            AiSheetMotion.settle(
                currentHeightPx = current,
                containerHeightPx = phone,
                velocityPxPerMs = 1.2f,
                dragDeltaYPx = 50f,
                layout = AiLayout.PHONE,
            ),
        )
    }

    @Test
    fun `slow drag does not close just because the finger moved 40px`() {
        val half = AiSheetGeometry.heightPx(AiDetent.HALF, phone)
        val current = half - 50f
        assertEquals(
            AiDetent.HALF,
            AiSheetMotion.settle(
                currentHeightPx = current,
                containerHeightPx = phone,
                velocityPxPerMs = 0.2f,
                dragDeltaYPx = 50f,
                layout = AiLayout.PHONE,
            ),
        )
    }

    @Test
    fun `fast flick without 40px travel does not close it only projects`() {
        val half = AiSheetGeometry.heightPx(AiDetent.HALF, phone)
        assertEquals(
            AiDetent.PEEK,
            AiSheetMotion.settle(
                currentHeightPx = half,
                containerHeightPx = phone,
                velocityPxPerMs = 1.4f,
                dragDeltaYPx = 10f,
                layout = AiLayout.PHONE,
            ),
        )
    }

    @Test
    fun `upward velocity projects to expanded instead of the nearest detent`() {
        val current = 500f
        assertEquals(AiDetent.HALF, AiSheetMotion.nearestWithoutVelocity(current, phone))
        assertEquals(
            AiDetent.EXPANDED,
            AiSheetMotion.settle(
                currentHeightPx = current,
                containerHeightPx = phone,
                velocityPxPerMs = -2f,
                dragDeltaYPx = -80f,
                layout = AiLayout.PHONE,
            ),
        )
    }

    @Test
    fun `downward projection without a flick lands on peek`() {
        val current = 360f
        assertEquals(
            AiDetent.PEEK,
            AiSheetMotion.settle(
                currentHeightPx = current,
                containerHeightPx = phone,
                velocityPxPerMs = 0.6f,
                dragDeltaYPx = 30f,
                layout = AiLayout.PHONE,
            ),
        )
    }

    @Test
    fun `pad ignores phone flick close and stays a full-height rail`() {
        assertEquals(
            AiDetent.HALF,
            AiSheetMotion.settle(
                currentHeightPx = 200f,
                containerHeightPx = phone,
                velocityPxPerMs = 2f,
                dragDeltaYPx = 80f,
                layout = AiLayout.PAD,
            ),
        )
        assertEquals(AiLayout.PAD, AiSheetGeometry.layout(768f))
        assertEquals(AiLayout.PHONE, AiSheetGeometry.layout(767f))
        assertEquals(420f, AiSheetGeometry.padWidthDp(2000f))
        assertEquals(322.56f, AiSheetGeometry.padWidthDp(768f), 0.01f)
    }

    @Test
    fun `drag height never goes below 70 percent of peek or above expanded`() {
        assertEquals(168f, AiSheetGeometry.minDragHeightPx(phone))
        assertEquals(736f, AiSheetGeometry.maxDragHeightPx(phone))
        assertEquals(168f, AiSheetGeometry.clampHeightPx(10f, phone))
        assertEquals(736f, AiSheetGeometry.clampHeightPx(900f, phone))
    }

    @Test
    fun `durations match demo sheet and fab tokens`() {
        assertEquals(420, AiSheetGeometry.SHEET_MS)
        assertEquals(240, AiSheetGeometry.FAB_OPACITY_MS)
        assertEquals(120, AiSheetGeometry.FAB_SCALE_MS)
        assertEquals(0.92f, AiSheetGeometry.FAB_PRESS_SCALE)
        assertEquals(0.9f, AiSheetGeometry.FAB_GONE_SCALE)
        assertEquals(50f, AiSheetGeometry.FAB_SIZE_DP)
        assertEquals(16f, AiSheetGeometry.fabEndDp(AiLayout.PHONE))
        assertEquals(22f, AiSheetGeometry.fabEndDp(AiLayout.PAD))
        assertEquals(96f, AiSheetGeometry.FAB_BOTTOM_DP)
        assertEquals(28f, AiSheetGeometry.CORNER_DP)
        assertEquals(1.05f, AiSheetGeometry.CLOSED_TRANSLATE)
    }
}
