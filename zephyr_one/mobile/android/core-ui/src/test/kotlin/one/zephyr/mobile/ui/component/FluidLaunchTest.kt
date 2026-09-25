package one.zephyr.mobile.ui.component

import androidx.compose.ui.graphics.Color
import one.zephyr.mobile.ui.theme.ZephyrThemeId
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class FluidLaunchTest {

    @Test
    fun `ease endpoints stay pinned`() {
        assertEquals(0f, appleEase(0f), 0f)
        assertEquals(1f, appleEase(1f), 0f)
    }

    @Test
    fun `apple ease overshoots linear early and settles`() {
        assertTrue(appleEase(0.35f) > 0.7f)
        assertTrue(appleEase(0.7f) > 0.95f)
        assertTrue(appleEase(0.5f) in 0f..1f)
    }

    @Test
    fun `phone width uses the compact launch plate`() {
        val metrics = fluidLaunchMetrics(shortestDp = 390)
        assertEquals(128, metrics.card.value.toInt())
        assertEquals(102, metrics.mark.value.toInt())
        assertEquals(30, metrics.radius.value.toInt())
        assertEquals(200, metrics.track.value.toInt())
    }

    @Test
    fun `nothing is drawn before the first beat`() {
        val frame = fluidLaunchFrame(elapsedMs = 0L, reducedMotion = false, ready = false)
        assertEquals(0f, frame.cardAlpha, 0f)
        assertEquals(0f, frame.seedAlpha, 0f)
        assertEquals(0f, frame.ribbon1, 0f)
        assertEquals(0f, frame.wordAlpha, 0f)
        assertEquals(0f, frame.progressAlpha, 0f)
        assertEquals(0f, frame.progressFraction, 0f)
        assertEquals(FluidLaunchTiming.CAPTION_WAKE, frame.caption)
    }

    @Test
    fun `seed ignites before the ribbons leave the point`() {
        val atIgnite = fluidLaunchFrame(elapsedMs = 240L, reducedMotion = false, ready = false)
        assertTrue(atIgnite.seedAlpha > 0.9f)
        assertEquals(0f, atIgnite.ribbon1, 0f)
        assertEquals(FluidLaunchTiming.CAPTION_WAKE, atIgnite.caption)
    }

    @Test
    fun `ribbons cascade and the wordmark replaces the seed`() {
        val drawing = fluidLaunchFrame(elapsedMs = 520L, reducedMotion = false, ready = false)
        assertTrue(drawing.ribbon1 > drawing.ribbon2 && drawing.ribbon2 > drawing.ribbon3)
        assertEquals(FluidLaunchTiming.CAPTION_CREDENTIALS, drawing.caption)
        assertEquals(0.624f, drawing.progressFraction, 0.02f)

        val settled = fluidLaunchFrame(elapsedMs = 2_000L, reducedMotion = false, ready = false)
        assertEquals(1f, settled.ribbon1, 0.001f)
        assertEquals(1f, settled.ribbon2, 0.001f)
        assertEquals(1f, settled.ribbon3, 0.001f)
        assertEquals(0f, settled.seedAlpha, 0.001f)
        assertEquals(0.96f, settled.wordAlpha, 0.001f)
        assertEquals(FluidLaunchTiming.CAPTION_ALMOST, settled.caption)
        assertEquals(0.92f, settled.progressFraction, 0.001f)
    }

    @Test
    fun `scripted progress never claims ready before the gate opens`() {
        val waiting = fluidLaunchFrame(elapsedMs = 20_000L, reducedMotion = false, ready = false)
        assertTrue(waiting.progressFraction <= 0.92f)
        assertEquals(FluidLaunchTiming.CAPTION_ALMOST, waiting.caption)

        val ready = fluidLaunchFrame(elapsedMs = 20_000L, reducedMotion = false, ready = true)
        assertEquals(1f, ready.progressFraction, 0f)
        assertEquals(FluidLaunchTiming.CAPTION_READY, ready.caption)
    }

    @Test
    fun `reduced motion shows the finished mark without a fake completion`() {
        val waiting = fluidLaunchFrame(elapsedMs = 0L, reducedMotion = true, ready = false)
        assertEquals(1f, waiting.cardAlpha, 0f)
        assertEquals(1f, waiting.ribbon1, 0f)
        assertEquals(0f, waiting.seedAlpha, 0f)
        assertEquals(0.35f, waiting.progressFraction, 0f)
        assertEquals(FluidLaunchTiming.CAPTION_WAKE, waiting.caption)

        val ready = fluidLaunchFrame(elapsedMs = 0L, reducedMotion = true, ready = true)
        assertEquals(1f, ready.progressFraction, 0f)
        assertEquals(FluidLaunchTiming.CAPTION_READY, ready.caption)
    }

    @Test
    fun `launch plates follow the four official palettes`() {
        assertEquals(Color(0xFF1E242C), launchPlate(ZephyrThemeId.FROST, dark = true).top)
        assertEquals(Color(0xFF101419), launchPlate(ZephyrThemeId.FROST, dark = true).bottom)
        assertEquals(Color.White, launchPlate(ZephyrThemeId.FROST, dark = false).top)
        assertTrue(launchPlate(ZephyrThemeId.FROST, dark = false).flat)
        assertEquals(Color(0xFF241C17), launchPlate(ZephyrThemeId.LAVA, dark = true).top)
        assertEquals(Color(0xFF17221F), launchPlate(ZephyrThemeId.ASAGI, dark = true).top)
        assertEquals(Color(0xFF152024), launchPlate(ZephyrThemeId.CYBER, dark = true).top)
        assertEquals(Color(0xFF090B0E), launchCanvas(ZephyrThemeId.FROST, dark = true))
        assertEquals(Color(0xFFF5F5F7), launchCanvas(ZephyrThemeId.FROST, dark = false))
        assertEquals(Color(0xFF100E0C), launchCanvas(ZephyrThemeId.LAVA, dark = true))
        assertEquals(Color(0xFF86868B), launchCaptionColor(ZephyrThemeId.FROST, dark = true))
        assertEquals(Color(0xFFA39D95), launchCaptionColor(ZephyrThemeId.LAVA, dark = true))
        assertEquals(Color(0xFF746860), launchCaptionColor(ZephyrThemeId.LAVA, dark = false))
        assertEquals(Color(0xFF93A09E), launchCaptionColor(ZephyrThemeId.ASAGI, dark = true))
        assertEquals(Color(0xFF657270), launchCaptionColor(ZephyrThemeId.ASAGI, dark = false))
        assertEquals(Color(0xFF909AA3), launchCaptionColor(ZephyrThemeId.CYBER, dark = true))
        assertEquals(Color(0xFF667078), launchCaptionColor(ZephyrThemeId.CYBER, dark = false))
    }
}
