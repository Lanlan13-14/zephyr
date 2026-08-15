package one.zephyr.mobile.feature.sessions

/**
 * JVM-safe Termux parser wrapper.
 *
 * Production attaches a [TermuxSessionBridge] so [TerminalView] can paint. This class stays a
 * snapshot adapter for unit tests: constructing [TerminalSession] here would pull android.os.Handler
 * into every emulator test.
 */
class SimpleVtEmulator(
    maxScrollback: Int = 4_000,
    outputSink: ((ByteArray) -> Unit)? = null,
) : TerminalEmulator {

    private val delegate = TermuxTerminalEmulator(
        maxScrollback = maxScrollback,
        outputSink = outputSink,
    )

    override val isAvailable: Boolean get() = delegate.isAvailable

    override fun resize(columns: Int, rows: Int) = delegate.resize(columns, rows)

    override fun feed(bytes: ByteArray): EmulatorUpdate = delegate.feed(bytes)

    override fun snapshot(topRow: Int, rows: Int): List<TerminalLine> = delegate.snapshot(topRow, rows)

    override fun cursor(): TerminalCursor = delegate.cursor()

    override fun readScrollback(fromRow: Int, toRow: Int): String = delegate.readScrollback(fromRow, toRow)

    override fun close() = delegate.close()
}
