package one.zephyr.mobile.feature.sessions

import android.graphics.Typeface
import android.view.inputmethod.InputMethodManager
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.termux.view.TerminalView
import java.util.Properties
import kotlin.math.roundToInt

/**
 * One Termux [TerminalView] for a live SSH/Telnet session.
 *
 * Keyboard is the system IME. Extra-key latches are read by [ZephyrTerminalViewClient] so the demo
 * Ctrl/Alt row actually modifies the next keystroke Termux sends.
 */
@Composable
fun TermuxTerminalPane(
    viewModel: TerminalViewModel,
    keyboardVisible: Boolean,
    colors: TerminalChromeColors,
    focused: Boolean,
    onTap: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val latches by viewModel.controller.state.collectAsStateWithLifecycle()
    val bridge = viewModel.termux
    val client = remember(viewModel) {
        ZephyrTerminalViewClient(
            latches = { viewModel.controller.state.value.latches },
            onTap = onTap,
            onScale = { scale ->
                val current = viewModel.controller.state.value.fontSp
                val next = TerminalGeometry.commitFontSp(current * scale)
                viewModel.controller.setFontSp(next)
                1f
            },
            onCopyMode = { active -> viewModel.controller.setSelectionActive(active) },
        )
    }

    LaunchedEffect(colors.termBg, colors.text) {
        bridge?.applyScheme(
            TermuxColorScheme(
                foregroundArgb = colors.text.toArgb(),
                backgroundArgb = colors.termBg.toArgb(),
                cursorArgb = colors.text.toArgb(),
            ),
        )
    }

    Box(modifier.background(colors.termBg)) {
        if (bridge == null) {
            FallbackComposeViewport(viewModel, colors)
            return@Box
        }
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { context ->
                TerminalView(context).also { view ->
                    view.setBackgroundColor(colors.termBg.toArgb())
                    view.setTextSize(spToPx(view, latches.fontSp))
                    view.setTypeface(Typeface.MONOSPACE)
                    view.setTerminalViewClient(client)
                    view.isFocusable = true
                    view.isFocusableInTouchMode = true
                    bridge.attach(view)
                }
            },
            update = { view ->
                view.setBackgroundColor(colors.termBg.toArgb())
                view.setTextSize(spToPx(view, latches.fontSp))
                view.setTerminalViewClient(client)
                if (view.currentSession !== bridge.session) bridge.attach(view)
                if (focused && keyboardVisible) {
                    view.requestFocus()
                    val imm = view.context.getSystemService(android.content.Context.INPUT_METHOD_SERVICE) as? InputMethodManager
                    imm?.showSoftInput(view, InputMethodManager.SHOW_IMPLICIT)
                } else if (focused && !keyboardVisible) {
                    val imm = view.context.getSystemService(android.content.Context.INPUT_METHOD_SERVICE) as? InputMethodManager
                    imm?.hideSoftInputFromWindow(view.windowToken, 0)
                }
            },
        )
    }

    DisposableEffect(viewModel) {
        onDispose { }
    }
}

private fun spToPx(view: android.view.View, sp: Float): Int =
    (sp * view.resources.displayMetrics.scaledDensity).roundToInt().coerceAtLeast(8)

@Composable
private fun FallbackComposeViewport(viewModel: TerminalViewModel, colors: TerminalChromeColors) {
    val revision by viewModel.surfaceRevision.collectAsStateWithLifecycle()
    val surface by viewModel.controller.state.collectAsStateWithLifecycle()
    val frame = remember(revision, surface.topRow, surface.size.rows) {
        viewModel.renderFrame(surface.topRow, surface.size.rows)
    }
    Box(Modifier.fillMaxSize().background(colors.termBg))
    /* Keep a live revision read so output still advances the fallback path. */
    @Suppress("UNUSED_VARIABLE")
    val unused = frame.lines.size
}

internal fun termuxDefaultProperties(colors: TerminalChromeColors): Properties = Properties().apply {
    setProperty("foreground", String.format("#%06X", colors.text.toArgb() and 0xFFFFFF))
    setProperty("background", String.format("#%06X", colors.termBg.toArgb() and 0xFFFFFF))
    setProperty("cursor", String.format("#%06X", colors.text.toArgb() and 0xFFFFFF))
}
