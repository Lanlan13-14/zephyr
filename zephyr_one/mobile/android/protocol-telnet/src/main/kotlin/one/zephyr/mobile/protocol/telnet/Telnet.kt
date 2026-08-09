package one.zephyr.mobile.protocol.telnet

/**
 * Telnet wire constants and the stateless helpers around them.
 *
 * Ported from the main end's `telnet-transport.js` so a mobile session negotiates exactly what the
 * web client negotiates. The byte sequences are asserted in tests rather than eyeballed, because an
 * option reply that differs by one byte produces a session that looks connected and then silently
 * misbehaves - no echo, no resize, or a prompt that never arrives.
 */
object Telnet {

    // RFC 854 commands.
    const val IAC = 255
    const val DONT = 254
    const val DO = 253
    const val WONT = 252
    const val WILL = 251
    const val SB = 250
    const val SE = 240
    const val NOP = 241
    const val GA = 249

    // Options this client cares about.
    const val OPT_BINARY = 0
    const val OPT_ECHO = 1
    const val OPT_SGA = 3
    const val OPT_STATUS = 5
    const val OPT_TTYPE = 24
    const val OPT_NAWS = 31

    const val TTYPE_IS = 0
    const val TTYPE_SEND = 1

    const val CR = 0x0D
    const val NUL = 0x00

    /** Matches the main end. A server that does not know it falls back to its own default. */
    const val DEFAULT_TERM = "xterm-256color"

    /** Long enough for every real terminfo name; bounds what a config can push onto the wire. */
    const val MAX_TERM_LENGTH = 40

    // NAWS is two big-endian u16s, so these are protocol maxima as well as sanity limits.
    const val MIN_COLS = 1
    const val MAX_COLS = 500
    const val MIN_ROWS = 1
    const val MAX_ROWS = 200

    /**
     * Default port per protocol.
     *
     * Kept here rather than in the UI so the connection editor and the dialer cannot disagree.
     */
    fun defaultPort(protocol: String?): Int = when (protocol?.uppercase()) {
        "RDP" -> 3389
        "VNC" -> 5900
        "TELNET" -> 23
        else -> 22
    }

    /**
     * `IAC SB NAWS <cols:u16> <rows:u16> IAC SE`.
     *
     * Clamped rather than rejected: a resize is a best-effort hint, and refusing to report a size
     * because the terminal reported something odd would leave the remote side stuck at 80x24.
     */
    fun encodeNaws(cols: Int, rows: Int): ByteArray {
        val clampedCols = cols.coerceIn(MIN_COLS, MAX_COLS)
        val clampedRows = rows.coerceIn(MIN_ROWS, MAX_ROWS)
        return byteArrayOf(
            IAC.toByte(), SB.toByte(), OPT_NAWS.toByte(),
            ((clampedCols shr 8) and 0xFF).toByte(), (clampedCols and 0xFF).toByte(),
            ((clampedRows shr 8) and 0xFF).toByte(), (clampedRows and 0xFF).toByte(),
            IAC.toByte(), SE.toByte(),
        )
    }

    /**
     * The opening negotiation, in the main end's exact order: WILL NAWS, WILL TTYPE, DO SGA, DO ECHO,
     * then the initial NAWS.
     *
     * DO ECHO asks the server to do the echoing. Without it a Telnet server that expects a
     * line-mode client leaves the terminal with no visible typing at all.
     */
    fun negotiationSequence(cols: Int = 80, rows: Int = 24): ByteArray =
        byteArrayOf(IAC.toByte(), WILL.toByte(), OPT_NAWS.toByte()) +
            byteArrayOf(IAC.toByte(), WILL.toByte(), OPT_TTYPE.toByte()) +
            byteArrayOf(IAC.toByte(), DO.toByte(), OPT_SGA.toByte()) +
            byteArrayOf(IAC.toByte(), DO.toByte(), OPT_ECHO.toByte()) +
            encodeNaws(cols, rows)

    /** `IAC NOP`: a keepalive that costs two bytes and is legal to send at any time. */
    val KEEPALIVE: ByteArray = byteArrayOf(IAC.toByte(), NOP.toByte())
}

/**
 * Character encodings offered for Telnet (DEVELOPMENT.md 14.2).
 *
 * Telnet carries bytes with no encoding declaration, so this is a user choice rather than something
 * that can be negotiated. Legacy network gear is the reason GBK and Big5 are on the list at all.
 */
enum class TelnetEncoding(val charsetName: String, val label: String) {
    UTF_8("UTF-8", "UTF-8"),
    GBK("GBK", "GBK"),
    BIG5("Big5", "Big5"),
    LATIN_1("ISO-8859-1", "Latin-1"),
    ;

    companion object {
        fun fromName(name: String?): TelnetEncoding =
            entries.firstOrNull { it.charsetName.equals(name, ignoreCase = true) || it.name.equals(name, ignoreCase = true) }
                ?: UTF_8
    }
}

/** One-shot IAC stripper. Incomplete trailing sequences are dropped, as on the main end. */
fun filterIac(data: ByteArray): ByteArray = TelnetIacEngine(respond = false).feed(data)
