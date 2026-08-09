package one.zephyr.mobile.model

/**
 * Connection protocols and their Zephyr default ports (ZEPHYR_PARITY.md 5.1).
 * Unknown wire values are preserved read-only instead of being coerced.
 */
enum class Protocol(val wireName: String, val defaultPort: Int) {
    SSH("SSH", 22),
    TELNET("TELNET", 23),
    RDP("RDP", 3389),
    VNC("VNC", 5900),
    ;

    val isTerminal: Boolean get() = this == SSH || this == TELNET
    val isRemoteDesktop: Boolean get() = this == RDP || this == VNC

    /** Only SSH carries SFTP, Docker, batch execution and snippet execution. */
    val supportsFiles: Boolean get() = this == SSH
    val supportsExec: Boolean get() = this == SSH

    /** Telnet is cleartext; the UI must keep saying so. */
    val isCleartext: Boolean get() = this == TELNET

    companion object {
        fun fromWire(value: String?): Protocol? =
            entries.firstOrNull { it.wireName.equals(value?.trim(), ignoreCase = true) }
    }
}

/** Terminal encodings Zephyr accepts. Telnet may use the legacy code pages. */
enum class TerminalEncoding(val wireName: String) {
    UTF8("UTF-8"),
    GBK("GBK"),
    BIG5("Big5"),
    LATIN1("Latin-1"),
    ;

    companion object {
        val default = UTF8
        fun fromWire(value: String?): TerminalEncoding =
            entries.firstOrNull { it.wireName.equals(value?.trim(), ignoreCase = true) } ?: default
    }
}

enum class ConnectionMode(val wireName: String) {
    DIRECT("direct"),
    PROXY("proxy"),
    JUMP("jump"),
    ;

    companion object {
        val default = DIRECT
        fun fromWire(value: String?): ConnectionMode =
            entries.firstOrNull { it.wireName == value } ?: default
    }
}
