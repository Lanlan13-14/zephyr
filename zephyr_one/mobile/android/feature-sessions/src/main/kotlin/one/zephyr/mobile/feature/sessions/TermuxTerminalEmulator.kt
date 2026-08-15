package one.zephyr.mobile.feature.sessions

import com.termux.terminal.TerminalBuffer
import com.termux.terminal.TerminalColors
import com.termux.terminal.TerminalEmulator as TermuxCoreEmulator
import com.termux.terminal.TerminalOutput
import com.termux.terminal.TerminalRow
import com.termux.terminal.TextStyle
import com.termux.terminal.WcWidth

/**
 * TerminalEmulator backed by Termux terminal-emulator engine.
 *
 * Full xterm / ANSI VT100 / VT220 / truecolor / 256-color support with
 * scrollback reflow, wide characters, cursor tracking, and DEC private modes.
 */
class TermuxTerminalEmulator(
    private val maxScrollback: Int = 4_000,
    private val outputSink: ((ByteArray) -> Unit)? = null,
) : TerminalEmulator {

    override val isAvailable: Boolean = true

    private var columns: Int = 80
    private var rows: Int = 24
    private val colors = TerminalColors()

    private val sessionOutput = object : TerminalOutput() {
        override fun write(data: ByteArray, offset: Int, count: Int) {
            outputSink?.invoke(data.copyOfRange(offset, offset + count))
        }

        override fun titleChanged(oldTitle: String?, newTitle: String?) = Unit
        override fun onCopyTextToClipboard(text: String?) = Unit
        override fun onPasteTextFromClipboard() = Unit
        override fun onBell() = Unit
        override fun onColorsChanged() = Unit
    }

    private var emulator: TermuxCoreEmulator = TermuxCoreEmulator(
        sessionOutput,
        columns,
        rows,
        0,
        0,
        maxScrollback,
        null,
    )

    override fun resize(columns: Int, rows: Int) {
        val nextCols = columns.coerceAtLeast(1)
        val nextRows = rows.coerceAtLeast(1)
        this.columns = nextCols
        this.rows = nextRows
        emulator.resize(nextCols, nextRows, 0, 0)
    }

    override fun feed(bytes: ByteArray): EmulatorUpdate {
        emulator.append(bytes, bytes.size)
        val screen: TerminalBuffer? = emulator.screen
        val transcriptRows = screen?.activeTranscriptRows ?: 0
        return EmulatorUpdate(
            newRows = 0,
            transcriptRows = transcriptRows + rows,
            dirtyRows = 0 until rows,
            title = emulator.title,
            modes = TerminalModes(
                mouseReporting = emulator.isMouseTrackingActive,
                alternateBuffer = emulator.isShowingAltBuffer,
                bracketedPaste = emulator.isBracketedPasteEnabled,
                mouseProtocol = MouseProtocol.SGR,
            ),
        )
    }

    override fun snapshot(topRow: Int, rows: Int): List<TerminalLine> {
        val screen: TerminalBuffer = emulator.screen ?: return emptyList()
        val totalTranscript = screen.activeTranscriptRows
        val screenRows = screen.activeRows
        val result = ArrayList<TerminalLine>(rows)

        val baseRow = -topRow

        for (r in 0 until rows) {
            val targetRow = baseRow + r
            val termRow: TerminalRow? = if (targetRow in -totalTranscript until screenRows) {
                try {
                    screen.allocateFullLineIfNecessary(targetRow)
                } catch (t: Throwable) {
                    null
                }
            } else {
                null
            }

            val cells = ArrayList<TerminalCell>(columns)
            if (termRow == null) {
                for (c in 0 until columns) {
                    cells.add(TerminalCell(text = " ", foreground = 0, background = 0))
                }
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

                        if (width == 2) {
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
                            if (c < columns) {
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
                            }
                        } else {
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
                        }
                    } else {
                        cells.add(TerminalCell(text = " ", foreground = 0, background = 0))
                    }
                    c++
                }
            }
            result.add(TerminalLine(cells))
        }
        return result
    }

    private fun resolveColor(color: Int, style: Long, isForeground: Boolean): Int {
        if (isForeground && (style and TextStyle.CHARACTER_ATTRIBUTE_TRUECOLOR_FOREGROUND.toLong()) != 0L) {
            return (0xFF shl 24) or (color and 0xFFFFFF)
        }
        if (!isForeground && (style and TextStyle.CHARACTER_ATTRIBUTE_TRUECOLOR_BACKGROUND.toLong()) != 0L) {
            return (0xFF shl 24) or (color and 0xFFFFFF)
        }
        if (color in 0 until TextStyle.NUM_INDEXED_COLORS) {
            return colors.mCurrentColors[color]
        }
        return 0
    }

    override fun cursor(): TerminalCursor {
        return TerminalCursor(
            column = emulator.cursorCol.coerceIn(0, (columns - 1).coerceAtLeast(0)),
            row = emulator.cursorRow.coerceIn(0, (rows - 1).coerceAtLeast(0)),
            visible = emulator.isCursorVisible,
        )
    }

    override fun readScrollback(fromRow: Int, toRow: Int): String {
        val screen = emulator.screen ?: return ""
        return try {
            screen.getSelectedText(0, fromRow, columns, toRow) ?: ""
        } catch (t: Throwable) {
            ""
        }
    }

    override fun close() {
    }
}
