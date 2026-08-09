package one.zephyr.mobile.feature.sessions

/**
 * Hex rendering for byte assertions.
 *
 * assertArrayEquals on a ByteArray reports "arrays first differed at element [3]", which says
 * nothing useful about an escape sequence. Comparing lowercase hex strings makes a wrong terminal
 * sequence readable in the failure message, which is the whole point of having frozen vectors.
 */
internal fun hex(bytes: ByteArray): String =
    bytes.joinToString(" ") { byte -> (byte.toInt() and 0xFF).toString(16).padStart(2, '0') }

internal fun ascii(value: String): ByteArray = ByteArray(value.length) { value[it].code.toByte() }

/** Modes with mouse reporting in the SGR encoding, which is what a modern curses app negotiates. */
internal val sgrModes = TerminalModes(
    mouseReporting = true,
    mouseProtocol = MouseProtocol.SGR,
    mouseButtonMotion = true,
)

internal val x10Modes = TerminalModes(
    mouseReporting = true,
    mouseProtocol = MouseProtocol.X10,
    mouseButtonMotion = true,
)
