package one.zephyr.mobile.feature.sessions

/**
 * A compact VT parser good enough for a live SSH shell.
 *
 * Handles UTF-8 text, CR/LF/BS/TAB, CUP/CUU/CUD/CUF/CUB, ED/EL, SGR colours and OSC titles.
 * Unknown CSI/ESC sequences are dropped so a real bash prompt still renders.
 */
class SimpleVtEmulator(
    private val maxScrollback: Int = 4_000,
) : TerminalEmulator {

    override val isAvailable: Boolean = true

    private var columns: Int = 80
    private var rows: Int = 24
    private val scrollback = ArrayDeque<TerminalLine>()
    private var screen: Array<Array<MutableCell>> = Array(24) { Array(80) { MutableCell() } }

    init {
        screen = Array(rows) { Array(columns) { MutableCell() } }
    }
    private var cursorCol: Int = 0
    private var cursorRow: Int = 0
    private var cursorVisible: Boolean = true
    private var current = CellStyle()
    private var title: String? = null
    private var bell: Boolean = false
    private var appended: Int = 0
    private val utf8 = Utf8Decoder()

    override fun resize(columns: Int, rows: Int) {
        val nextCols = columns.coerceAtLeast(1)
        val nextRows = rows.coerceAtLeast(1)
        val next = emptyGrid(nextCols, nextRows)
        val copyRows = minOf(this.rows, nextRows)
        val copyCols = minOf(this.columns, nextCols)
        for (row in 0 until copyRows) {
            for (col in 0 until copyCols) {
                next[row][col] = screen.getOrNull(row)?.getOrNull(col)?.duplicate() ?: MutableCell()
            }
        }
        this.columns = nextCols
        this.rows = nextRows
        screen = next
        cursorCol = cursorCol.coerceIn(0, nextCols - 1)
        cursorRow = cursorRow.coerceIn(0, nextRows - 1)
    }

    override fun feed(bytes: ByteArray): EmulatorUpdate {
        appended = 0
        bell = false
        title = null
        utf8.feed(bytes) { code -> consume(code) }
        return EmulatorUpdate(
            newRows = appended,
            transcriptRows = scrollback.size + rows,
            dirtyRows = 0 until rows,
            title = title,
            bell = bell,
        )
    }

    override fun snapshot(topRow: Int, rows: Int): List<TerminalLine> {
        val out = ArrayList<TerminalLine>(rows)
        val start = topRow.coerceAtLeast(0)
        for (index in 0 until rows) {
            val absolute = start + index
            out += if (absolute < scrollback.size) {
                scrollback.elementAt(absolute)
            } else {
                val screenRow = absolute - scrollback.size
                if (screenRow in screen.indices) snapshotRow(screen[screenRow]) else emptyLine()
            }
        }
        return out
    }

    override fun cursor(): TerminalCursor = TerminalCursor(cursorCol, cursorRow, cursorVisible)

    override fun readScrollback(fromRow: Int, toRow: Int): String {
        val start = fromRow.coerceAtLeast(0)
        val end = toRow.coerceAtLeast(start)
        val builder = StringBuilder()
        for (index in start until end) {
            val line = if (index < scrollback.size) {
                scrollback.elementAt(index)
            } else {
                val screenRow = index - scrollback.size
                if (screenRow in screen.indices) snapshotRow(screen[screenRow]) else continue
            }
            builder.append(line.cells.joinToString("") { it.text })
            builder.append('\n')
        }
        return builder.toString()
    }

    override fun close() {
        scrollback.clear()
        screen = emptyGrid(columns, rows)
    }

    private fun consume(code: Int) {
        when {
            code == 0x1B -> state = Parser.Escape
            state == Parser.Ground -> print(code)
            state == Parser.Escape -> escape(code)
            state == Parser.Csi -> csi(code)
            state == Parser.Osc -> osc(code)
            state == Parser.OscEsc -> {
                if (code == 0x5C) finishOsc() else {
                    oscBuffer.append(0x1B.toChar()).append(code.toChar())
                    state = Parser.Osc
                }
            }
        }
    }

    private var state: Parser = Parser.Ground
    private val csiBuffer = StringBuilder()
    private val oscBuffer = StringBuilder()

    private fun print(code: Int) {
        when (code) {
            0x07 -> bell = true
            0x08 -> cursorCol = (cursorCol - 1).coerceAtLeast(0)
            0x09 -> cursorCol = ((cursorCol / 8) + 1) * 8
            0x0A -> lineFeed()
            0x0D -> cursorCol = 0
            in 0x00..0x1F -> Unit
            else -> writeGlyph(String(intArrayOf(code), 0, 1))
        }
        if (cursorCol >= columns) {
            cursorCol = 0
            lineFeed()
        }
    }

    private fun escape(code: Int) {
        state = Parser.Ground
        when (code) {
            '['.code -> {
                csiBuffer.clear()
                state = Parser.Csi
            }
            ']'.code -> {
                oscBuffer.clear()
                state = Parser.Osc
            }
            '7'.code, '8'.code, 'M'.code, 'D'.code, 'E'.code, 'c'.code -> Unit
        }
    }

    private fun csi(code: Int) {
        if (code in 0x40..0x7E) {
            applyCsi(csiBuffer.toString(), code.toChar())
            csiBuffer.clear()
            state = Parser.Ground
        } else {
            csiBuffer.append(code.toChar())
        }
    }

    private fun osc(code: Int) {
        when (code) {
            0x07 -> finishOsc()
            0x1B -> state = Parser.OscEsc
            else -> oscBuffer.append(code.toChar())
        }
    }

    private fun finishOsc() {
        val body = oscBuffer.toString()
        val split = body.indexOf(';')
        if (split > 0) {
            val kind = body.substring(0, split)
            if (kind == "0" || kind == "2") title = body.substring(split + 1)
        }
        oscBuffer.clear()
        state = Parser.Ground
    }

    private fun applyCsi(params: String, command: Char) {
        val numbers = params.split(';').map { it.toIntOrNull() ?: 0 }
        val first = numbers.firstOrNull() ?: 0
        when (command) {
            'A' -> cursorRow = (cursorRow - first.coerceAtLeast(1)).coerceAtLeast(0)
            'B' -> cursorRow = (cursorRow + first.coerceAtLeast(1)).coerceAtMost(rows - 1)
            'C' -> cursorCol = (cursorCol + first.coerceAtLeast(1)).coerceAtMost(columns - 1)
            'D' -> cursorCol = (cursorCol - first.coerceAtLeast(1)).coerceAtLeast(0)
            'H', 'f' -> {
                val row = (numbers.getOrNull(0)?.takeIf { it > 0 } ?: 1) - 1
                val col = (numbers.getOrNull(1)?.takeIf { it > 0 } ?: 1) - 1
                cursorRow = row.coerceIn(0, rows - 1)
                cursorCol = col.coerceIn(0, columns - 1)
            }
            'J' -> eraseDisplay(first)
            'K' -> eraseLine(first)
            'm' -> applySgr(if (params.isEmpty()) listOf(0) else numbers)
            's', 'u', 'l', 'h', 'n', 'r' -> Unit
        }
    }

    private fun applySgr(params: List<Int>) {
        var index = 0
        while (index < params.size) {
            when (val code = params[index]) {
                0 -> current = CellStyle()
                1 -> current = current.copy(bold = true)
                3 -> current = current.copy(italic = true)
                4 -> current = current.copy(underline = true)
                7 -> current = current.copy(inverse = true)
                22 -> current = current.copy(bold = false)
                23 -> current = current.copy(italic = false)
                24 -> current = current.copy(underline = false)
                27 -> current = current.copy(inverse = false)
                39 -> current = current.copy(foreground = 0)
                49 -> current = current.copy(background = 0)
                in 30..37 -> current = current.copy(foreground = ansi(code - 30, bright = false))
                in 90..97 -> current = current.copy(foreground = ansi(code - 90, bright = true))
                in 40..47 -> current = current.copy(background = ansi(code - 40, bright = false))
                in 100..107 -> current = current.copy(background = ansi(code - 100, bright = true))
                38, 48 -> {
                    val isFg = code == 38
                    val mode = params.getOrNull(index + 1) ?: 0
                    if (mode == 5 && params.size > index + 2) {
                        val color = indexed(params[index + 2])
                        current = if (isFg) current.copy(foreground = color) else current.copy(background = color)
                        index += 2
                    } else if (mode == 2 && params.size > index + 4) {
                        val color = argb(params[index + 2], params[index + 3], params[index + 4])
                        current = if (isFg) current.copy(foreground = color) else current.copy(background = color)
                        index += 4
                    }
                }
            }
            index += 1
        }
    }

    private fun writeGlyph(text: String) {
        if (cursorCol >= columns) {
            cursorCol = 0
            lineFeed()
        }
        screen[cursorRow][cursorCol] = MutableCell(
            text = text,
            foreground = current.foreground,
            background = current.background,
            bold = current.bold,
            italic = current.italic,
            underline = current.underline,
            inverse = current.inverse,
        )
        cursorCol += 1
    }

    private fun lineFeed() {
        if (cursorRow < rows - 1) {
            cursorRow += 1
            return
        }
        scrollback.addLast(snapshotRow(screen[0]))
        while (scrollback.size > maxScrollback) scrollback.removeFirst()
        for (row in 0 until rows - 1) screen[row] = screen[row + 1]
        screen[rows - 1] = Array(columns) { MutableCell() }
        appended += 1
    }

    private fun eraseDisplay(mode: Int) {
        when (mode) {
            0 -> {
                eraseLine(0)
                for (row in (cursorRow + 1) until rows) clearRow(row)
            }
            1 -> {
                eraseLine(1)
                for (row in 0 until cursorRow) clearRow(row)
            }
            else -> {
                for (row in 0 until rows) clearRow(row)
                cursorCol = 0
                cursorRow = 0
            }
        }
    }

    private fun eraseLine(mode: Int) {
        val row = screen[cursorRow]
        val start = if (mode == 1) 0 else cursorCol
        val end = if (mode == 1) cursorCol + 1 else columns
        for (col in start until end) row[col] = MutableCell()
        if (mode == 2) for (col in 0 until columns) row[col] = MutableCell()
    }

    private fun clearRow(row: Int) {
        screen[row] = Array(columns) { MutableCell() }
    }

    private fun snapshotRow(row: Array<MutableCell>): TerminalLine =
        TerminalLine(row.map { it.toCell() })

    private fun emptyLine(): TerminalLine = TerminalLine(List(columns) { TerminalCell(" ", 0, 0) })

    private enum class Parser { Ground, Escape, Csi, Osc, OscEsc }

    private data class CellStyle(
        val foreground: Int = 0,
        val background: Int = 0,
        val bold: Boolean = false,
        val italic: Boolean = false,
        val underline: Boolean = false,
        val inverse: Boolean = false,
    )

    private data class MutableCell(
        var text: String = " ",
        var foreground: Int = 0,
        var background: Int = 0,
        var bold: Boolean = false,
        var italic: Boolean = false,
        var underline: Boolean = false,
        var inverse: Boolean = false,
    ) {
        fun toCell(): TerminalCell = TerminalCell(text, foreground, background, bold, italic, underline, inverse)
        fun duplicate(): MutableCell = MutableCell(text, foreground, background, bold, italic, underline, inverse)
    }

    private class Utf8Decoder {
        private var needed = 0
        private var acc = 0

        fun feed(bytes: ByteArray, emit: (Int) -> Unit) {
            for (raw in bytes) {
                val value = raw.toInt() and 0xFF
                if (needed == 0) {
                    when {
                        value < 0x80 -> emit(value)
                        value and 0xE0 == 0xC0 -> {
                            needed = 1
                            acc = value and 0x1F
                        }
                        value and 0xF0 == 0xE0 -> {
                            needed = 2
                            acc = value and 0x0F
                        }
                        value and 0xF8 == 0xF0 -> {
                            needed = 3
                            acc = value and 0x07
                        }
                    }
                } else if (value and 0xC0 == 0x80) {
                    acc = (acc shl 6) or (value and 0x3F)
                    needed -= 1
                    if (needed == 0) emit(acc)
                } else {
                    needed = 0
                }
            }
        }
    }

    companion object {
        private fun emptyGrid(columns: Int, rows: Int): Array<Array<MutableCell>> =
            Array(rows) { Array(columns) { MutableCell() } }

        private fun ansi(index: Int, bright: Boolean): Int {
            val colors = if (bright) BRIGHT else NORMAL
            return colors[index.coerceIn(0, 7)]
        }

        private fun indexed(index: Int): Int = when {
            index < 8 -> NORMAL[index]
            index < 16 -> BRIGHT[index - 8]
            else -> 0xFFCCCCCC.toInt()
        }

        private fun argb(r: Int, g: Int, b: Int): Int =
            (0xFF shl 24) or ((r and 0xFF) shl 16) or ((g and 0xFF) shl 8) or (b and 0xFF)

        private val NORMAL = intArrayOf(
            0xFF0A0C0F.toInt(), 0xFFFF453A.toInt(), 0xFF30D158.toInt(), 0xFFFFD60A.toInt(),
            0xFF0A84FF.toInt(), 0xFFBF5AF2.toInt(), 0xFF64D2FF.toInt(), 0xFFF2F4F7.toInt(),
        )
        private val BRIGHT = intArrayOf(
            0xFF5D6773.toInt(), 0xFFFF6961.toInt(), 0xFF30DB5B.toInt(), 0xFFFFD426.toInt(),
            0xFF409CFF.toInt(), 0xFFDA8FFF.toInt(), 0xFF70D7FF.toInt(), 0xFFFFFFFF.toInt(),
        )
    }
}
