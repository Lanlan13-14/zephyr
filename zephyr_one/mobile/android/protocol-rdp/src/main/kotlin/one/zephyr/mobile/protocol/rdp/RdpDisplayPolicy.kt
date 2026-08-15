package one.zephyr.mobile.protocol.rdp

import one.zephyr.mobile.model.RdpFps
import one.zephyr.mobile.model.RdpQuality
import one.zephyr.mobile.model.RdpResolution

/**
 * Session-time display choices from the demo RDP tool strip.
 *
 * Quality maps onto FreeRDP's existing wallpaper/theme/GFX knobs rather than a new C ABI field:
 * those flags are what `zephyr_rdp_config` already carries, and inventing a frame-rate field the
 * shim cannot honour would only decorate the HUD. FPS is recorded for the status pill and the next
 * connect; live GFX frame pacing is still whatever the server negotiated.
 */
object RdpDisplayPolicy {

    val QUALITY_CYCLE: List<RdpQuality> = listOf(
        RdpQuality.BALANCED,
        RdpQuality.PERFORMANCE,
        RdpQuality.QUALITY,
    )

    val RESOLUTION_CYCLE: List<RdpResolution> = listOf(
        RdpResolution.AUTO,
        RdpResolution.P1080,
        RdpResolution.K2,
        RdpResolution.K4,
    )

    val FPS_CYCLE: List<RdpFps> = listOf(
        RdpFps.F30,
        RdpFps.F45,
        RdpFps.F60,
        RdpFps.F120,
    )

    /** Multipliers of the fitted scale, matching the demo `ZOOMS` array. */
    val ZOOM_FACTORS: FloatArray = floatArrayOf(1f, 1.25f, 1.5f, 0.75f)

    fun nextQuality(current: RdpQuality): RdpQuality = nextIn(QUALITY_CYCLE, current)

    fun nextResolution(current: RdpResolution): RdpResolution = nextIn(RESOLUTION_CYCLE, current)

    fun nextFps(current: RdpFps): RdpFps = nextIn(FPS_CYCLE, current)

    fun nextZoomIndex(current: Int): Int {
        if (ZOOM_FACTORS.isEmpty()) return 0
        return (current + 1).mod(ZOOM_FACTORS.size)
    }

    fun qualityLabel(quality: RdpQuality): String = when (quality) {
        RdpQuality.BALANCED -> "平衡"
        RdpQuality.PERFORMANCE -> "性能"
        RdpQuality.QUALITY -> "画质"
    }

    fun resolutionLabel(resolution: RdpResolution): String = when (resolution) {
        RdpResolution.AUTO -> "自动"
        RdpResolution.P1080 -> "1080p"
        RdpResolution.K2 -> "2K"
        RdpResolution.K4 -> "4K"
        RdpResolution.K8 -> "8K"
    }

    fun fpsLabel(fps: RdpFps): String = fps.value.toString() + "FPS"

    fun zoomLabel(factor: Float): String = (factor * 100f).toInt().toString() + "%"

    fun nativeFlags(quality: RdpQuality): NativeFlags = when (quality) {
        RdpQuality.PERFORMANCE -> NativeFlags(
            gfx = false,
            disableWallpaper = true,
            disableThemes = true,
            disableMenuAnims = true,
            disableFullWindowDrag = true,
            allowFontSmoothing = false,
        )
        RdpQuality.BALANCED -> NativeFlags(
            gfx = true,
            disableWallpaper = true,
            disableThemes = true,
            disableMenuAnims = true,
            disableFullWindowDrag = true,
            allowFontSmoothing = true,
        )
        RdpQuality.QUALITY -> NativeFlags(
            gfx = true,
            disableWallpaper = false,
            disableThemes = false,
            disableMenuAnims = false,
            disableFullWindowDrag = false,
            allowFontSmoothing = true,
        )
    }

    data class NativeFlags(
        val gfx: Boolean,
        val disableWallpaper: Boolean,
        val disableThemes: Boolean,
        val disableMenuAnims: Boolean,
        val disableFullWindowDrag: Boolean,
        val allowFontSmoothing: Boolean,
    )

    private fun <T> nextIn(cycle: List<T>, current: T): T {
        val index = cycle.indexOf(current)
        if (index < 0) return cycle.first()
        return cycle[(index + 1) % cycle.size]
    }
}
