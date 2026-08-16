package one.zephyr.mobile.feature.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RemoteToolsOrbTest {

    @Test
    fun initialPositionIsCentredOnTheRightSafeEdge() {
        val bounds = RemoteToolsOrbGeometry.bounds(
            viewportWidthPx = 1080,
            viewportHeightPx = 2400,
            orbSizePx = 132f,
            marginPx = 30f,
            insetLeftPx = 0,
            insetTopPx = 90,
            insetRightPx = 0,
            insetBottomPx = 120,
        )
        val position = RemoteToolsOrbGeometry.initial(bounds)
        assertEquals(918f, position.x, 0f)
        assertEquals((120f + 2118f) / 2f, position.y, 0f)
    }

    @Test
    fun draggingClampsTheWholeOrbInsideSafeDrawingBounds() {
        val bounds = RemoteToolsOrbGeometry.bounds(500, 900, 44f, 10f, 7, 30, 11, 50)
        val initial = RemoteToolsOrbGeometry.initial(bounds)
        assertEquals(RemoteToolsOrbPosition(435f, 418f), initial)
        assertEquals(
            RemoteToolsOrbPosition(bounds.minX, bounds.maxY),
            RemoteToolsOrbGeometry.move(initial, -10_000f, 10_000f, bounds),
        )
    }

    @Test
    fun tinyViewportCollapsesBoundsWithoutThrowing() {
        val bounds = RemoteToolsOrbGeometry.bounds(20, 20, 44f, 10f, 9, 8, 9, 8)
        assertEquals(bounds.minX, bounds.maxX, 0f)
        assertEquals(bounds.minY, bounds.maxY, 0f)
    }

    @Test
    fun quickStationaryLiftIsClickButLongPressAndMovementAreNot() {
        assertTrue(RemoteToolsOrbGesture.isTap(120L, 2f))
        assertFalse(RemoteToolsOrbGesture.isTap(RemoteToolsOrbGesture.LONG_PRESS_MS, 0f))
        assertFalse(RemoteToolsOrbGesture.isTap(80L, RemoteToolsOrbGesture.TAP_SLOP_PX + 1f))
    }
}
