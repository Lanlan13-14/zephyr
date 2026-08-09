package one.zephyr.mobile.ui.theme

import android.provider.Settings
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
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
 * MOBILE_EXPERIENCE.md 5.4 requires the Android animator duration scale to be honoured, so this is
 * read from system settings rather than exposed as an app preference. [reduceMotion] removes
 * positional springs and parallax; it never disables gesture tracking, which stays 1:1 either way.
 */
data class ZephyrMotion(
    val reduceMotion: Boolean,
    /** Raw animator duration scale; 0 means the user disabled animations entirely. */
    val durationScale: Float,
) {
    /** Scales a duration, with a floor of one frame so a "0ms" animation still commits state. */
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
 * Root theme.
 *
 * Material3 still supplies component defaults, but the Zephyr palette is provided alongside it
 * rather than folded into a ColorScheme: MOBILE_EXPERIENCE.md 4.1 defines five *named* surface roles
 * whose meaning would be lost if they were flattened onto Material's elevation-derived surfaces.
 *
 * Dynamic colour is deliberately not used. The brand palette is a product decision the user makes
 * explicitly, and wallpaper-derived colour would silently override it.
 */
@Composable
fun ZephyrTheme(
    themeId: ZephyrThemeId = ZephyrThemeId.default,
    dark: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    val palette = remember(themeId, dark) { ZephyrPalette.of(themeId, dark) }
    val motion = rememberZephyrMotion()

    val scheme = remember(palette) {
        if (palette.dark) {
            darkColorScheme(
                primary = palette.brand.accent,
                onPrimary = palette.surfaces.background,
                background = palette.surfaces.background,
                onBackground = palette.onBackground,
                surface = palette.surfaces.content,
                onSurface = palette.onBackground,
                surfaceVariant = palette.surfaces.elevated,
                error = palette.status.error,
                outline = palette.surfaces.outline,
            )
        } else {
            lightColorScheme(
                primary = palette.brand.accent,
                onPrimary = palette.surfaces.content,
                background = palette.surfaces.background,
                onBackground = palette.onBackground,
                surface = palette.surfaces.content,
                onSurface = palette.onBackground,
                surfaceVariant = palette.surfaces.elevated,
                error = palette.status.error,
                outline = palette.surfaces.outline,
            )
        }
    }

    CompositionLocalProvider(
        LocalZephyrPalette provides palette,
        LocalZephyrMotion provides motion,
    ) {
        MaterialTheme(
            colorScheme = scheme,
            typography = zephyrTypography(),
            content = content,
        )
    }
}

/**
 * Ambient accessors.
 *
 * Declared as an object beside the composable of the same name, mirroring how Material3 exposes
 * MaterialTheme.colorScheme: call sites read `ZephyrTheme.palette` without importing the
 * CompositionLocal, and the locals stay available for the rare case that needs to provide them.
 */
object ZephyrTheme {

    val palette: ZephyrPalette
        @Composable get() = LocalZephyrPalette.current

    val motion: ZephyrMotion
        @Composable get() = LocalZephyrMotion.current

    val typography: ZephyrTextStyles
        @Composable get() = ZephyrTextStyles
}

/**
 * Reads the system animator duration scale.
 *
 * A scale of 0 is the accessibility "remove animations" setting, so it is treated as reduce-motion
 * rather than as "animate instantly", which would still schedule interpolators.
 */
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
