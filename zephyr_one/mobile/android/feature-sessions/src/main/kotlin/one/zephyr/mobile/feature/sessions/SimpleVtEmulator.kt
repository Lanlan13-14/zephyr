package one.zephyr.mobile.feature.sessions

/**
 * Terminal VT emulator powered by Termux engine.
 *
 * Full ANSI/VT100/VT220/xterm/truecolor/256-color support with scrollback reflow,
 * wide CJK glyphs, cursor tracking, and DEC private modes.
 */
class SimpleVtEmulator(
    maxScrollback: Int = 4_000,
) : TerminalEmulator {

    private val delegate = TermuxTerminalEmulator(maxScrollback = maxScrollback)

    override val isAvailable: Boolean get() = delegate.isAvailable

    override fun resize(columns: Int, rows: Int) = delegate.resize(columns, rows)

    override fun feed(bytes: ByteArray): EmulatorUpdate = delegate.feed(bytes)

    override fun snapshot(topRow: Int, rows: Int): List<TerminalLine> = delegate.snapshot(topRow, rows)

    override fun cursor(): TerminalCursor = delegate.cursor()

    override fun readScrollback(fromRow: Int, toRow: Int): String = delegate.readScrollback(fromRow, toRow)

    override fun close() = delegate.close()
}
