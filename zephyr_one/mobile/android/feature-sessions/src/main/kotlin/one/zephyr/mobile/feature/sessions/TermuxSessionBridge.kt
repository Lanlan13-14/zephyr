package one.zephyr.mobile.feature.sessions

import android.view.KeyEvent
import android.view.MotionEvent
import android.view.inputmethod.InputMethodManager
import com.termux.terminal.TerminalBuffer
import com.termux.terminal.TerminalColors
import com.termux.terminal.TerminalEmulator as TermuxCoreEmulator
import com.termux.terminal.TerminalOutput
import com.termux.terminal.TerminalRow
import com.termux.terminal.TerminalSession
import com.termux.terminal.TerminalSessionClient
import com.termux.terminal.TextStyle
import com.termux.terminal.WcWidth
import android.os.Looper
import com.termux.view.TerminalView
import com.termux.view.TerminalViewClient
import java.lang.ref.WeakReference
import java.util.Properties
import java.util.concurrent.atomic.AtomicInteger

/**
 * One Termux [TerminalSession] bound to a remote SSH/Telnet byte pipe.
 *
 * Termux's view talks to a session, not to our snapshot adapter. The session is created empty and
 * fed remote bytes; keystrokes leave through [TerminalSession.OutputListener] so they never try to
 * open a local PTY.
 */
class TermuxSessionBridge(
    private val maxScrollback: Int = 4_000,
    initialWriteBytes: (ByteArray) -> Unit = {},
    private val onTitle: (String?) -> Unit = {},
    private val onCopy: (String) -> Unit = {},
    private val onPasteRequested: () -> Unit = {},
    private val onBell: () -> Unit = {},
    private val onScreenChanged: () -> Unit = {},
    private val onFinished: () -> Unit = {},
) : TerminalEmulator {

    override val isAvailable: Boolean = true

    @Volatile
    private var writeBytes: (ByteArray) -> Unit = initialWriteBytes

    fun bindWriteBytes(writer: (ByteArray) -> Unit) {
        writeBytes = writer
    }

    private val client = BridgeSessionClient()

    @Volatile
    private var lastColumns: Int = 80

    @Volatile
    private var lastRows: Int = 24

    val session: TerminalSession = TerminalSession(
        /* in = */ null,
        /* out = */ null,
        Integer.valueOf(maxScrollback),
        client,
    ).also { created ->
        created.setOutputListener { data, offset, count ->
            writeBytes(data.copyOfRange(offset, offset + count))
        }
        created.setOnResizeCallback {
            val emulator = created.emulator ?: return@setOnResizeCallback
            lastColumns = emulator.mColumns
            lastRows = emulator.mRows
        }
        // SSH banners arrive before the first layout. Without an emulator they are dropped and
        // the first paint is an empty grid on Frost's term background.
        created.updateSize(lastColumns, lastRows, 8, 16)
    }

    private val snapshotColors = TerminalColors()

    @Volatile
    private var attachedView: WeakReference<TerminalView>? = null

    val columns: Int get() = session.emulator?.mColumns ?: lastColumns
    val rows: Int get() = session.emulator?.mRows ?: lastRows

    fun applyScheme(scheme: TermuxColorScheme) {
        val props = Properties()
        props.setProperty("foreground", scheme.foregroundHex)
        props.setProperty("background", scheme.backgroundHex)
        props.setProperty("cursor", scheme.cursorHex)
        scheme.ansiArgb.forEachIndexed { index, argb ->
            props.setProperty("color$index", String.format("#%06X", argb and 0xFFFFFF))
        }
        TerminalColors.COLOR_SCHEME.updateWith(props)
        session.emulator?.mColors?.reset()
        snapshotColors.reset()
        attachedView?.get()?.onScreenUpdated()
        onScreenChanged()
    }

    fun setSelectionColors(backgroundArgb: Int?, foregroundArgb: Int?) {
        attachedView?.get()?.setSelectionColors(backgroundArgb, foregroundArgb)
    }

    fun attach(view: TerminalView) {
        attachedView = WeakReference(view)
        view.attachSession(session)
        view.onScreenUpdated()
    }

    fun feedRemote(bytes: ByteArray) {
        if (bytes.isEmpty()) return
        session.appendFromRemote(bytes, 0, bytes.size)
    }

    fun sendBytes(bytes: ByteArray) {
        if (bytes.isEmpty()) return
        session.write(bytes, 0, bytes.size)
    }

    fun updateSize(columns: Int, rows: Int, cellWidthPx: Int, cellHeightPx: Int) {
        val nextCols = columns.coerceAtLeast(4)
        val nextRows = rows.coerceAtLeast(4)
        lastColumns = nextCols
        lastRows = nextRows
        session.updateSize(nextCols, nextRows, cellWidthPx.coerceAtLeast(1), cellHeightPx.coerceAtLeast(1))
    }

    override fun resize(columns: Int, rows: Int) {
        updateSize(columns, rows, cellWidthPx = 8, cellHeightPx = 16)
    }

    override fun feed(bytes: ByteArray): EmulatorUpdate {
        feedRemote(bytes)
        val emulator = session.emulator
        val screen = emulator?.screen
        val transcriptRows = (screen?.activeTranscriptRows ?: 0) + (emulator?.mRows ?: lastRows)
        return EmulatorUpdate(
            newRows = 0,
            transcriptRows = transcriptRows,
            dirtyRows = 0 until (emulator?.mRows ?: lastRows),
            title = emulator?.title,
            modes = currentModes(),
        )
    }

    override fun snapshot(topRow: Int, rows: Int): List<TerminalLine> {
        val emulator = session.emulator ?: return emptyList()
        val screen: TerminalBuffer = emulator.screen ?: return emptyList()
        val totalTranscript = screen.activeTranscriptRows
        val screenRows = screen.activeRows
        val columns = emulator.mColumns
        val result = ArrayList<TerminalLine>(rows)
        val baseRow = -topRow
        for (r in 0 until rows) {
            val targetRow = baseRow + r
            val termRow: TerminalRow? = if (targetRow in -totalTranscript until screenRows) {
                runCatching { screen.allocateFullLineIfNecessary(targetRow) }.getOrNull()
            } else {
                null
            }
            val cells = ArrayList<TerminalCell>(columns)
            if (termRow == null) {
                repeat(columns) { cells.add(TerminalCell(text = " ", foreground = 0, background = 0)) }
            } else {
                var c = 0
                val spaceUsed = termRow.spaceUsed
                while (c < columns) {
                    if (c < spaceUsed) {
                        val codePoint = termRow.getCodePoint(c)
                        val width = WcWidth.width(codePoint).coerceAtLeast(1)
                        val style = termRow.getStyle(c)
                        val fg = resolveColor(TextStyle.decodeForeColor(style), style, true)
                        val bg = resolveColor(TextStyle.decodeBackColor(style), style, false)
                        val bold = (style and TextStyle.CHARACTER_ATTRIBUTE_BOLD.toLong()) != 0L
                        val italic = (style and TextStyle.CHARACTER_ATTRIBUTE_ITALIC.toLong()) != 0L
                        val underline = (style and TextStyle.CHARACTER_ATTRIBUTE_UNDERLINE.toLong()) != 0L
                        val inverse = (style and TextStyle.CHARACTER_ATTRIBUTE_INVERSE.toLong()) != 0L
                        cells.add(
                            TerminalCell(
                                text = String(Character.toChars(codePoint)),
                                foreground = fg,
                                background = bg,
                                bold = bold,
                                italic = italic,
                                underline = underline,
                                inverse = inverse,
                            ),
                        )
                        c++
                        if (width == 2 && c < columns) {
                            cells.add(
                                TerminalCell(
                                    text = "",
                                    foreground = fg,
                                    background = bg,
                                    bold = bold,
                                    italic = italic,
                                    underline = underline,
                                    inverse = inverse,
                                    wideContinuation = true,
                                ),
                            )
                            c++
                        }
                    } else {
                        cells.add(TerminalCell(text = " ", foreground = 0, background = 0))
                        c++
                    }
                }
            }
            result.add(TerminalLine(cells))
        }
        return result
    }

    override fun cursor(): TerminalCursor {
        val emulator = session.emulator
        return TerminalCursor(
            column = (emulator?.cursorCol ?: 0).coerceAtLeast(0),
            row = (emulator?.cursorRow ?: 0).coerceAtLeast(0),
            visible = emulator?.isCursorVisible ?: false,
        )
    }

    override fun readScrollback(fromRow: Int, toRow: Int): String {
        val screen = session.emulator?.screen ?: return ""
        return runCatching { screen.getSelectedText(0, fromRow, columns, toRow).orEmpty() }.getOrDefault("")
    }

    override fun close() {
        session.finishRemote()
    }

    fun currentModes(): TerminalModes {
        val emulator = session.emulator ?: return TerminalModes()
        return TerminalModes(
            mouseReporting = emulator.isMouseTrackingActive,
            alternateBuffer = emulator.isShowingAltBuffer,
            bracketedPaste = emulator.isBracketedPasteEnabled,
            mouseProtocol = MouseProtocol.SGR,
        )
    }

    private fun resolveColor(color: Int, style: Long, isForeground: Boolean): Int {
        if (isForeground && (style and TextStyle.CHARACTER_ATTRIBUTE_TRUECOLOR_FOREGROUND.toLong()) != 0L) {
            return (0xFF shl 24) or (color and 0xFFFFFF)
        }
        if (!isForeground && (style and TextStyle.CHARACTER_ATTRIBUTE_TRUECOLOR_BACKGROUND.toLong()) != 0L) {
            return (0xFF shl 24) or (color and 0xFFFFFF)
        }
        if (color in 0 until TextStyle.NUM_INDEXED_COLORS) {
            return snapshotColors.mCurrentColors[color]
        }
        return 0
    }

    private inner class BridgeSessionClient : TerminalSessionClient {
        override fun onTextChanged(changedSession: TerminalSession) {
            val view = attachedView?.get()
            if (view != null) {
                if (Looper.myLooper() == Looper.getMainLooper()) {
                    view.onScreenUpdated()
                } else {
                    view.post { view.onScreenUpdated() }
                }
            }
            onScreenChanged()
        }
        override fun onTitleChanged(changedSession: TerminalSession) = onTitle(changedSession.title)
        override fun onSessionFinished(finishedSession: TerminalSession) = onFinished()
        override fun onCopyTextToClipboard(session: TerminalSession, text: String) = onCopy(text)
        override fun onPasteTextFromClipboard(session: TerminalSession?) = onPasteRequested()
        override fun onBell(session: TerminalSession) = onBell()
        override fun onColorsChanged(session: TerminalSession) = onScreenChanged()
        override fun onTerminalCursorStateChange(state: Boolean) = Unit
        override fun setTerminalShellPid(session: TerminalSession, pid: Int) = Unit
        override fun getTerminalCursorStyle(): Int? = null
        override fun logError(tag: String, message: String) = Unit
        override fun logWarn(tag: String, message: String) = Unit
        override fun logInfo(tag: String, message: String) = Unit
        override fun logDebug(tag: String, message: String) = Unit
        override fun logVerbose(tag: String, message: String) = Unit
        override fun logStackTraceWithMessage(tag: String, message: String, e: Exception) = Unit
        override fun logStackTrace(tag: String, e: Exception) = Unit
    }
}

data class TermuxColorScheme(
    val foregroundArgb: Int,
    val backgroundArgb: Int,
    val cursorArgb: Int,
    val ansiArgb: IntArray = readableAnsiPalette(backgroundArgb),
) {
    val foregroundHex: String get() = hex(foregroundArgb)
    val backgroundHex: String get() = hex(backgroundArgb)
    val cursorHex: String get() = hex(cursorArgb)

    private fun hex(argb: Int): String = String.format("#%06X", argb and 0xFFFFFF)
}

internal fun readableAnsiPalette(backgroundArgb: Int): IntArray {
    val light = TerminalCellPaint.contrast(0xFF14181D.toInt(), backgroundArgb) >
        TerminalCellPaint.contrast(0xFFF2F4F7.toInt(), backgroundArgb)
    return if (light) intArrayOf(
        0xFF1C232B.toInt(), 0xFFB3261E.toInt(), 0xFF087F23.toInt(), 0xFF7A6200.toInt(),
        0xFF1565C0.toInt(), 0xFF8E24AA.toInt(), 0xFF007C91.toInt(), 0xFF4A525B.toInt(),
        0xFF5B6570.toInt(), 0xFFD32F2F.toInt(), 0xFF0B7A2C.toInt(), 0xFF8A6500.toInt(),
        0xFF0D5BB5.toInt(), 0xFF7B1FA2.toInt(), 0xFF006B75.toInt(), 0xFF14181D.toInt(),
    ) else intArrayOf(
        0xFF000000.toInt(), 0xFFCD0000.toInt(), 0xFF00CD00.toInt(), 0xFFCDCD00.toInt(),
        0xFF6495ED.toInt(), 0xFFCD00CD.toInt(), 0xFF00CDCD.toInt(), 0xFFE5E5E5.toInt(),
        0xFF7F7F7F.toInt(), 0xFFFF0000.toInt(), 0xFF00FF00.toInt(), 0xFFFFFF00.toInt(),
        0xFF5C5CFF.toInt(), 0xFFFF00FF.toInt(), 0xFF00FFFF.toInt(), 0xFFFFFFFF.toInt(),
    )
}

/**
 * Termux view callbacks that stay inside the view. Modifier latches come from the shortcut row so
 * Ctrl/Alt/Shift tap on the demo keyrow actually reach the PTY.
 */
class ZephyrTerminalViewClient(
    private val latches: () -> ModifierLatches,
    private val onTap: () -> Unit,
    private val onScale: (Float) -> Float,
    private val onCopyMode: (Boolean) -> Unit = {},
) : TerminalViewClient {

    override fun onScale(scale: Float): Float = onScale.invoke(scale)

    override fun onSingleTapUp(e: MotionEvent) = onTap()

    override fun shouldBackButtonBeMappedToEscape(): Boolean = false

    override fun shouldEnforceCharBasedInput(): Boolean = true

    override fun shouldUseCtrlSpaceWorkaround(): Boolean = false

    override fun isTerminalViewSelected(): Boolean = true

    override fun copyModeChanged(copyMode: Boolean) = onCopyMode(copyMode)

    override fun onKeyDown(keyCode: Int, e: KeyEvent, session: TerminalSession): Boolean = false

    override fun onKeyUp(keyCode: Int, e: KeyEvent): Boolean = false

    override fun onLongPress(event: MotionEvent): Boolean = false

    override fun readControlKey(): Boolean = latches().ctrl.isActive

    override fun readAltKey(): Boolean = latches().alt.isActive

    override fun readShiftKey(): Boolean = latches().shift.isActive

    override fun readFnKey(): Boolean = latches().fn.isActive

    override fun onCodePoint(codePoint: Int, ctrlDown: Boolean, session: TerminalSession): Boolean = false

    override fun onEmulatorSet() = Unit

    override fun logError(tag: String, message: String) = Unit
    override fun logWarn(tag: String, message: String) = Unit
    override fun logInfo(tag: String, message: String) = Unit
    override fun logDebug(tag: String, message: String) = Unit
    override fun logVerbose(tag: String, message: String) = Unit
    override fun logStackTraceWithMessage(tag: String, message: String, e: Exception) = Unit
    override fun logStackTrace(tag: String, e: Exception) = Unit
}

fun showSystemIme(view: android.view.View, show: Boolean) {
    val imm = view.context.getSystemService(android.content.Context.INPUT_METHOD_SERVICE) as? InputMethodManager
        ?: return
    if (show) {
        view.requestFocus()
        imm.showSoftInput(view, InputMethodManager.SHOW_IMPLICIT)
    } else {
        imm.hideSoftInputFromWindow(view.windowToken, 0)
    }
}

/** Serial so two panes never share a Termux handle name. */
internal object TermuxHandleSeq {
    private val next = AtomicInteger(1)
    fun next(): Int = next.getAndIncrement()
}

/**
 * Production emulator: a live Termux session the view can attach to.
 *
 * [SimpleVtEmulator] is the JVM snapshot wrapper. The app used to construct that wrapper and then
 * `as? TermuxSessionBridge`, which is always null, so the pane painted an empty Frost box over a
 * live SSH stream.
 */
fun productionTerminalEmulator(maxScrollback: Int = 4_000): TerminalEmulator =
    TermuxSessionBridge(maxScrollback = maxScrollback)
