package one.zephyr.mobile.protocol.telnet

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** The byte sink a session writes to. A port, so the state machine stays pure JVM and testable. */
interface TelnetSocket {
    suspend fun write(bytes: ByteArray)
    fun close()
}

/**
 * One Telnet session's settings.
 *
 * @param autoLoginUsername optional; auto-login is off unless a username is present.
 * @param keepaliveMs `IAC NOP` period. Telnet sessions sit behind NAT and idle-timeout aggressively;
 *   60 s matches the main end.
 */
data class TelnetConfig(
    val cols: Int = 80,
    val rows: Int = 24,
    val termType: String = Telnet.DEFAULT_TERM,
    val encoding: TelnetEncoding = TelnetEncoding.UTF_8,
    val autoLoginUsername: String? = null,
    val autoLoginPassword: String? = null,
    val keepaliveMs: Long = 60_000L,
)

/**
 * Drives one Telnet connection: negotiation, IAC processing, decoding, resize and auto-login.
 *
 * The session owns no socket of its own and does no I/O beyond [TelnetSocket], so the whole
 * protocol path is unit-testable. Cleartext is not hidden: [isCleartext] is always true and the UI
 * is required to say so (DEVELOPMENT.md 14.2 - the warning may add a confirmation but must never
 * imply the session is encrypted).
 */
class TelnetSession(
    private val socket: TelnetSocket,
    private val config: TelnetConfig,
    private val scope: CoroutineScope,
) {

    private val engine = TelnetIacEngine(
        writer = { bytes -> pendingWrites.add(bytes) },
        termType = config.termType,
        respond = true,
    )

    /**
     * Replies the engine produced during [onBytes].
     *
     * The engine is synchronous while socket writes are suspending, so replies are queued here and
     * flushed by the caller's coroutine. Draining them in arrival order matters: a Telnet server may
     * base its next request on the previous answer.
     */
    private val pendingWrites = ArrayDeque<ByteArray>()

    private val decoder = TelnetStreamDecoder(config.encoding)

    private val autoLogin = TelnetAutoLogin(
        username = config.autoLoginUsername,
        password = config.autoLoginPassword,
        send = { line -> pendingWrites.add(encodeOutbound(line)) },
    )

    private var keepaliveJob: Job? = null

    private var cols = config.cols
    private var rows = config.rows

    private val _autoLoginState = MutableStateFlow(autoLogin.state)
    val autoLoginState: StateFlow<TelnetAutoLogin.State> = _autoLoginState.asStateFlow()

    /** Telnet is plaintext by definition. Never hidden, never softened. */
    val isCleartext: Boolean get() = true

    /** True once the server took over echoing; the UI uses it to decide on local echo. */
    val serverEchoes: Boolean get() = engine.peerEnabled(Telnet.OPT_ECHO)

    val binaryMode: Boolean get() = engine.peerEnabled(Telnet.OPT_BINARY)

    /** Sends the opening option negotiation and starts the keepalive. */
    suspend fun start() {
        socket.write(Telnet.negotiationSequence(cols, rows))
        if (config.keepaliveMs > 0) startKeepalive(config.keepaliveMs)
    }

    /**
     * Processes one inbound chunk and returns the text for the emulator.
     *
     * Order is deliberate: strip IAC first, then decode. Decoding first would let an option byte
     * be interpreted as part of a multi-byte character and corrupt both.
     */
    suspend fun onBytes(chunk: ByteArray): String {
        val payload = engine.feed(chunk)
        flushPendingWrites()
        if (payload.isEmpty()) return ""
        val text = decoder.decode(payload)
        if (text.isNotEmpty()) {
            autoLogin.observe(text)
            _autoLoginState.value = autoLogin.state
            flushPendingWrites()
        }
        return text
    }

    /** Sends user input. */
    suspend fun sendText(text: String) {
        if (text.isEmpty()) return
        socket.write(encodeOutbound(text))
    }

    /**
     * Reports a new terminal size.
     *
     * Sent unconditionally rather than only when NAWS was confirmed: the dialer announced
     * `WILL NAWS` up front, and a server that did not enable it ignores the subnegotiation
     * harmlessly. Skipping it would leave a resized terminal misreported for the whole session.
     */
    suspend fun resize(nextCols: Int, nextRows: Int) {
        if (nextCols == cols && nextRows == rows) return
        cols = nextCols
        rows = nextRows
        socket.write(Telnet.encodeNaws(nextCols, nextRows))
    }

    fun setEncoding(encoding: TelnetEncoding) = decoder.setEncoding(encoding)

    fun startKeepalive(intervalMs: Long) {
        keepaliveJob?.cancel()
        keepaliveJob = scope.launch {
            val period = intervalMs.coerceAtLeast(MIN_KEEPALIVE_MS)
            while (true) {
                delay(period)
                socket.write(Telnet.KEEPALIVE)
            }
        }
    }

    /** Flushes the decoder's tail so a truncated character is not lost, then closes. */
    suspend fun stop() {
        keepaliveJob?.cancel()
        keepaliveJob = null
        engine.destroy()
        decoder.finish()
        socket.close()
    }

    private suspend fun flushPendingWrites() {
        while (pendingWrites.isNotEmpty()) {
            socket.write(pendingWrites.removeFirst())
        }
    }

    /**
     * Encodes outbound text and escapes `0xFF` as `IAC IAC`.
     *
     * Without the escape, a single byte the user typed - reachable in Latin-1 and as a GBK trail
     * byte - would be read by the server as the start of an option command and desynchronise the
     * session. This is the one transformation that must not be skipped on the write path.
     */
    internal fun encodeOutbound(text: String): ByteArray {
        val raw = text.toByteArray(charset(decoder.encoding.charsetName))
        var escapes = 0
        for (byte in raw) if ((byte.toInt() and 0xFF) == Telnet.IAC) escapes++
        if (escapes == 0) return raw
        val out = ByteArray(raw.size + escapes)
        var target = 0
        for (byte in raw) {
            out[target++] = byte
            if ((byte.toInt() and 0xFF) == Telnet.IAC) out[target++] = Telnet.IAC.toByte()
        }
        return out
    }

    private companion object {
        /** Floored so a misconfigured interval cannot turn the keepalive into a busy loop. */
        const val MIN_KEEPALIVE_MS = 1_000L
    }
}
