package one.zephyr.mobile.ui.theme

import android.provider.Settings
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ProvidableCompositionLocal
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalInspectionMode

/**
 * Motion capability for the current device state.
 *
 * Animator duration scale is read from the system, not an app preference.
 * [reduceMotion] removes positional springs; gesture tracking stays 1:1.
 */
data class ZephyrMotion(
    val reduceMotion: Boolean,
    val durationScale: Float,
) {
    fun scale(durationMs: Int): Int =
        if (reduceMotion) 0 else (durationMs * durationScale).toInt().coerceAtLeast(0)

    companion object {
        val full = ZephyrMotion(reduceMotion = false, durationScale = 1f)
        val reduced = ZephyrMotion(reduceMotion = true, durationScale = 0f)
    }
}

val LocalZephyrPalette: ProvidableCompositionLocal<ZephyrPalette> =
    staticCompositionLocalOf { ZephyrPalette.of(ZephyrThemeId.default, dark = false) }

val LocalZephyrMotion: ProvidableCompositionLocal<ZephyrMotion> =
    staticCompositionLocalOf { ZephyrMotion.full }

/**
 * Root theme. Palette + motion only. There is no Material ColorScheme and no
 * MaterialTheme wrapper: screens must read [ZephyrTheme.palette] / typography.
 */
@Composable
fun ZephyrTheme(
    themeId: ZephyrThemeId = ZephyrThemeId.default,
    dark: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    val palette = remember(themeId, dark) { ZephyrPalette.of(themeId, dark) }
    val motion = rememberZephyrMotion()
    CompositionLocalProvider(
        LocalZephyrPalette provides palette,
        LocalZephyrMotion provides motion,
        content = content,
    )
}

object ZephyrTheme {

    val palette: ZephyrPalette
        @Composable get() = LocalZephyrPalette.current

    val motion: ZephyrMotion
        @Composable get() = LocalZephyrMotion.current

    val typography: ZephyrTextStyles
        @Composable get() = ZephyrTextStyles
}

@Composable
fun rememberZephyrMotion(): ZephyrMotion {
    if (LocalInspectionMode.current) return ZephyrMotion.full
    val context = LocalContext.current
    return remember(context) {
        val scale = runCatching {
            Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
        }.getOrDefault(1f)
        ZephyrMotion(reduceMotion = scale == 0f, durationScale = scale)
    }
}
