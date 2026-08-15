package one.zephyr.mobile.feature.sessions

import android.graphics.Paint
import android.graphics.Typeface
import android.view.inputmethod.InputMethodManager
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalDensity
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
 *
 * If the ViewModel was given a snapshot-only emulator (tests, or a host that still constructs
 * [SimpleVtEmulator]), the pane draws the cell grid itself instead of an empty Frost box.
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
                    bridge.applyScheme(
                        TermuxColorScheme(
                            foregroundArgb = colors.text.toArgb(),
                            backgroundArgb = colors.termBg.toArgb(),
                            cursorArgb = colors.text.toArgb(),
                        ),
                    )
                    bridge.attach(view)
                    view.post { view.onScreenUpdated() }
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
}

private fun spToPx(view: android.view.View, sp: Float): Int =
    (sp * view.resources.displayMetrics.scaledDensity).roundToInt().coerceAtLeast(8)

@Composable
internal fun FallbackComposeViewport(viewModel: TerminalViewModel, colors: TerminalChromeColors) {
    val revision by viewModel.surfaceRevision.collectAsStateWithLifecycle()
    val surface by viewModel.controller.state.collectAsStateWithLifecycle()
    val frame = remember(revision, surface.topRow, surface.size.rows) {
        viewModel.renderFrame(surface.topRow, surface.size.rows)
    }
    val density = LocalDensity.current
    val textPaint = remember {
        Paint(Paint.ANTI_ALIAS_FLAG).apply {
            typeface = Typeface.MONOSPACE
        }
    }
    val bgPaint = remember { Paint() }
    val fallbackFg = colors.text.toArgb()
    val fallbackBg = colors.termBg.toArgb()
    val cellW = surface.fontSp * 0.6f * density.density
    val lineH = surface.fontSp * 1.55f * density.density
    textPaint.textSize = surface.fontSp * density.fontScale * density.density

    Canvas(Modifier.fillMaxSize().background(colors.termBg)) {
        val native = drawContext.canvas.nativeCanvas
        val cursor = frame.cursor
        frame.lines.forEachIndexed { row, line ->
            var x = 0f
            val top = row * lineH
            val baseline = top + lineH - textPaint.fontMetrics.descent
            for (cell in line.cells) {
                if (cell.wideContinuation) {
                    x += cellW
                    continue
                }
                val bg = TerminalCellPaint.background(cell.background, fallbackBg)
                if (bg != fallbackBg) {
                    bgPaint.color = bg
                    native.drawRect(x, top, x + cellW, top + lineH, bgPaint)
                }
                val glyph = cell.text
                if (glyph.isNotEmpty() && glyph != " ") {
                    textPaint.color = TerminalCellPaint.foreground(cell.foreground, fallbackFg, fallbackBg)
                    textPaint.isFakeBoldText = cell.bold
                    textPaint.textSkewX = if (cell.italic) -0.2f else 0f
                    textPaint.isUnderlineText = cell.underline
                    native.drawText(glyph, x, baseline, textPaint)
                }
                x += cellW
            }
        }
        if (cursor != null && cursor.visible && cursor.row in frame.lines.indices) {
            val cx = cursor.column * cellW
            val cy = cursor.row * lineH
            bgPaint.color = fallbackFg
            native.drawRect(cx, cy, cx + 2f * density.density, cy + lineH, bgPaint)
        }
    }
}

internal fun termuxDefaultProperties(colors: TerminalChromeColors): Properties = Properties().apply {
    setProperty("foreground", String.format("#%06X", colors.text.toArgb() and 0xFFFFFF))
    setProperty("background", String.format("#%06X", colors.termBg.toArgb() and 0xFFFFFF))
    setProperty("cursor", String.format("#%06X", colors.text.toArgb() and 0xFFFFFF))
}
