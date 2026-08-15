package one.zephyr.mobile.protocol.rdp

import one.zephyr.mobile.model.RdpFps
import one.zephyr.mobile.model.RdpQuality
import one.zephyr.mobile.model.RdpResolution
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RdpDisplayPolicyTest {

    @Test
    fun qualityCyclesInDemoOrder() {
        assertEquals(RdpQuality.PERFORMANCE, RdpDisplayPolicy.nextQuality(RdpQuality.BALANCED))
        assertEquals(RdpQuality.QUALITY, RdpDisplayPolicy.nextQuality(RdpQuality.PERFORMANCE))
        assertEquals(RdpQuality.BALANCED, RdpDisplayPolicy.nextQuality(RdpQuality.QUALITY))
    }

    @Test
    fun resolutionCycleStopsAt4K() {
        assertEquals(RdpResolution.P1080, RdpDisplayPolicy.nextResolution(RdpResolution.AUTO))
        assertEquals(RdpResolution.K2, RdpDisplayPolicy.nextResolution(RdpResolution.P1080))
        assertEquals(RdpResolution.K4, RdpDisplayPolicy.nextResolution(RdpResolution.K2))
        assertEquals(RdpResolution.AUTO, RdpDisplayPolicy.nextResolution(RdpResolution.K4))
        assertFalse(RdpDisplayPolicy.RESOLUTION_CYCLE.contains(RdpResolution.K8))
    }

    @Test
    fun fpsCycleMatchesDemo() {
        assertEquals(RdpFps.F45, RdpDisplayPolicy.nextFps(RdpFps.F30))
        assertEquals(RdpFps.F60, RdpDisplayPolicy.nextFps(RdpFps.F45))
        assertEquals(RdpFps.F120, RdpDisplayPolicy.nextFps(RdpFps.F60))
        assertEquals(RdpFps.F30, RdpDisplayPolicy.nextFps(RdpFps.F120))
        assertFalse(RdpDisplayPolicy.FPS_CYCLE.contains(RdpFps.F144))
    }

    @Test
    fun zoomFactorsMatchDemo() {
        assertEquals(4, RdpDisplayPolicy.ZOOM_FACTORS.size)
        assertEquals(1f, RdpDisplayPolicy.ZOOM_FACTORS[0])
        assertEquals(1.25f, RdpDisplayPolicy.ZOOM_FACTORS[1])
        assertEquals(1.5f, RdpDisplayPolicy.ZOOM_FACTORS[2])
        assertEquals(0.75f, RdpDisplayPolicy.ZOOM_FACTORS[3])
        assertEquals(1, RdpDisplayPolicy.nextZoomIndex(0))
        assertEquals(0, RdpDisplayPolicy.nextZoomIndex(3))
        assertEquals("100%", RdpDisplayPolicy.zoomLabel(1f))
        assertEquals("75%", RdpDisplayPolicy.zoomLabel(0.75f))
    }

    @Test
    fun performanceDropsGfxAndWallpaper() {
        val flags = RdpDisplayPolicy.nativeFlags(RdpQuality.PERFORMANCE)
        assertFalse(flags.gfx)
        assertTrue(flags.disableWallpaper)
        assertTrue(flags.disableThemes)
        assertFalse(flags.allowFontSmoothing)
    }

    @Test
    fun qualityKeepsDesktopChrome() {
        val flags = RdpDisplayPolicy.nativeFlags(RdpQuality.QUALITY)
        assertTrue(flags.gfx)
        assertFalse(flags.disableWallpaper)
        assertFalse(flags.disableThemes)
        assertTrue(flags.allowFontSmoothing)
    }

    @Test
    fun labelsMatchDemoCopy() {
        assertEquals("平衡", RdpDisplayPolicy.qualityLabel(RdpQuality.BALANCED))
        assertEquals("自动", RdpDisplayPolicy.resolutionLabel(RdpResolution.AUTO))
        assertEquals("30FPS", RdpDisplayPolicy.fpsLabel(RdpFps.F30))
    }
}
