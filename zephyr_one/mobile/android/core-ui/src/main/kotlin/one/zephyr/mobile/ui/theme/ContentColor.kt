package one.zephyr.mobile.ui.theme

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

val LocalZephyrContentColor = staticCompositionLocalOf { Color.Unspecified }

@Composable
fun ProvideContentColor(color: Color, content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalZephyrContentColor provides color, content = content)
}

@Composable
fun resolvedContentColor(fallback: Color): Color {
    val local = LocalZephyrContentColor.current
    return if (local == Color.Unspecified) fallback else local
}
