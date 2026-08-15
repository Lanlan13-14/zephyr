package one.zephyr.mobile.feature.sessions

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import one.zephyr.mobile.model.MobileError
import one.zephyr.mobile.model.Protocol

/**
 * What the emulator changed after being fed bytes.
 *
 * @param newRows rows appended to the transcript, which is what decides whether a viewport pinned to
 *   the bottom must follow. Returned rather than inferred from the cell snapshot because the
 *   difference between "10 rows scrolled past" and "the same 10 rows were redrawn" is invisible in a
 *   snapshot and decides whether the user's scroll position is stolen.
 * @param modes DEC private modes after the feed. The mouse/cursor/keypad modes change what the next
 *   keystroke and the next gesture must encode, so they travel with every update.
 */
data class EmulatorUpdate(
    val newRows: Int = 0,
    val transcriptRows: Int = 0,
    val modes: TerminalModes = TerminalModes(),
    /** Rows the renderer must repaint, relative to the visible viewport. */
    val dirtyRows: IntRange? = null,
    /** OSC 0/2 window title, when the program set one. */
    val title: String? = null,
    /** BEL. The host decides whether to make a sound; the emulator only reports it. */
    val bell: Boolean = false,
)

/** One rendered cell. */
data class TerminalCell(
    val text: String,
    val foreground: Int,
    val background: Int,
    val bold: Boolean = false,
    val italic: Boolean = false,
    val underline: Boolean = false,
    val inverse: Boolean = false,
    /** OSC 8 hyperlink target, for the link-open action in the selection menu. */
    val hyperlink: String? = null,
    /** Wide glyphs occupy two cells; the second carries an empty text and this flag. */
    val wideContinuation: Boolean = false,
)

data class TerminalLine(val cells: List<TerminalCell>)

data class TerminalCursor(val column: Int, val row: Int, val visible: Boolean)

/**
 * The VT parser and cell grid.
 *
 * A port rather than a class because ADR-003 leaves the implementation open: the Android candidate is
 * Termux's Apache-2.0 terminal-emulator module, which cannot be linked before a file-level licence
 * audit, and the iOS candidate is SwiftTerm. The C ABI listed in ADR-003 maps onto these methods one
 * for one (terminal_feed_utf8, terminal_resize, terminal_snapshot_cells, terminal_cursor,
 * terminal_dirty_regions, terminal_scrollback_read), so the adapter is a thin translation rather than
 * a redesign.
 *
 * Everything above this port - the surface controller, the key and mouse encoders, the gesture
 * arbiter, the viewport - is fully implemented and tested, because none of it needs a parser.
 */
interface TerminalEmulator {

    /** False until an audited engine is linked. The UI must show a blocked state, never a fake grid. */
    val isAvailable: Boolean

    fun resize(columns: Int, rows: Int)

    /** Feeds output from the transport. */
    fun feed(bytes: ByteArray): EmulatorUpdate

    /**
     * @param topRow rows above the bottom, matching [ScrollbackViewport.topRow], so the renderer and
     *   the scroll state cannot disagree about which slice is on screen.
     */
    fun snapshot(topRow: Int, rows: Int): List<TerminalLine>

    fun cursor(): TerminalCursor

    /** Plain text for selection, copy and the accessibility snapshot. */
    fun readScrollback(fromRow: Int, toRow: Int): String

    fun close()
}

/**
 * The M0 stand-in.
 *
 * Returns empty state and reports unavailable rather than echoing bytes back as plain text. An
 * echoing fake would look like a working terminal in a screenshot while silently dropping every
 * escape sequence, which is exactly the "connect succeeded but nothing works" outcome the ADR-003
 * exit gate exists to prevent.
 */
class UnavailableTerminalEmulator : TerminalEmulator {

    override val isAvailable: Boolean = false

    override fun resize(columns: Int, rows: Int) = Unit

    override fun feed(bytes: ByteArray): EmulatorUpdate = EmulatorUpdate()

    override fun snapshot(topRow: Int, rows: Int): List<TerminalLine> = emptyList()

    override fun cursor(): TerminalCursor = TerminalCursor(column = 0, row = 0, visible = false)

    override fun readScrollback(fromRow: Int, toRow: Int): String = ""

    override fun close() = Unit

    companion object {
        val BLOCKED: MobileError = MobileError.local(
            code = "engine_unavailable",
            message = "终端解析引擎尚未链接（ADR-003 许可证审计未完成）",
            retryable = false,
        )
    }
}

/**
 * What a session needs in order to be opened.
 *
 * Secrets are passed as CharArray so the caller can wipe them: a String would stay in the heap until
 * the next GC, and SHARED_RESOURCE_RESIDENCY.md requires shared connection material to leave memory
 * as soon as the session ends.
 */
data class TerminalOpenRequest(
    val sessionId: String,
    val protocol: Protocol,
    val host: String,
    val port: Int,
    val username: String,
    val password: CharArray? = null,
    val privateKey: CharArray? = null,
    val passphrase: CharArray? = null,
    val columns: Int = 80,
    val rows: Int = 24,
    val charset: TerminalCharset = TerminalCharset.UTF8,
    /** Telnet only: in-band auto-login is the only authentication the protocol has (ADR-006). */
    val autoLogin: Boolean = false,
) {
    /** Clears the credential arrays. Called by the host once the transport has consumed them. */
    fun wipe() {
        password?.fill('\u0000')
        privateKey?.fill('\u0000')
        passphrase?.fill('\u0000')
    }
}

sealed interface TerminalOpenOutcome {
    data class Opened(val sessionId: String, val banner: String = "") : TerminalOpenOutcome

    /**
     * SSH host key needs a decision.
     *
     * A distinct outcome rather than a failure because the user can resolve it, and a distinct
     * outcome rather than a silent accept because ADR-002's gate requires unknown and changed keys to
     * be surfaced.
     */
    data class HostKeyDecision(val fingerprint: String, val changed: Boolean) : TerminalOpenOutcome

    data class Failed(val error: MobileError) : TerminalOpenOutcome
}

/**
 * The transport half of a terminal session.
 *
 * SSH and Telnet share this interface because TERMINAL_EXPERIENCE.md 1 freezes that they share the
 * whole surface and differ only in transport and negotiation. Keeping the difference behind one
 * interface is what stops the difference from leaking into the controller, the encoders or the UI.
 */
interface TerminalHost {

    val isAvailable: Boolean

    suspend fun open(request: TerminalOpenRequest): TerminalOpenOutcome

    /** Raw bytes from the peer, still to be fed to a [TerminalEmulator]. */
    fun output(sessionId: String): Flow<ByteArray>

    fun transportFor(sessionId: String): TerminalTransport

    suspend fun close(sessionId: String)

    /** Completes when the remote stream ends, carrying an error for failed writes/reads. */
    fun closure(sessionId: String): Flow<Throwable> = emptyFlow()

    /** Real round-trip probe on the established transport. */
    suspend fun measureLatency(sessionId: String): Long? = null

    suspend fun listDirectory(sessionId: String, path: String): Result<one.zephyr.mobile.protocol.ssh.SftpDirectory> =
        Result.failure(IllegalStateException("SFTP unavailable"))

    suspend fun exec(sessionId: String, command: String): Result<one.zephyr.mobile.protocol.ssh.SshExecResult> =
        Result.failure(IllegalStateException("SSH exec unavailable"))

    /** Accepts and remembers a presented host key after the user confirmed it. */
    suspend fun trustHostKey(sessionId: String) = Unit
}

/** Discards writes and reports no output. Paired with an unavailable host. */
private object NoopTransport : TerminalTransport {
    override suspend fun write(bytes: ByteArray) = Unit
    override suspend fun resize(columns: Int, rows: Int, widthPx: Int, heightPx: Int) = Unit
}

/**
 * A host for a protocol whose engine is not linked.
 *
 * Fails the open with a structured error rather than throwing, so the screen renders the blocked
 * state through the normal [one.zephyr.mobile.model.PageState] path with a copyable diagnostic.
 */
class UnavailableTerminalHost(private val error: MobileError) : TerminalHost {

    override val isAvailable: Boolean = false

    override suspend fun open(request: TerminalOpenRequest): TerminalOpenOutcome {
        // Wiped even on the failure path: the credential was materialised for an attempt that will
        // not happen, and leaving it in the heap would be worse than not trying at all.
        request.wipe()
        return TerminalOpenOutcome.Failed(error)
    }

    override fun output(sessionId: String): Flow<ByteArray> = emptyFlow()

    override fun transportFor(sessionId: String): TerminalTransport = NoopTransport

    override suspend fun close(sessionId: String) = Unit

    companion object {
        val SSH_BLOCKED: MobileError = MobileError.local(
            code = "engine_unavailable",
            message = "SSH 引擎尚未链接（ADR-002 M0 spike 未完成）",
            retryable = false,
        )

        /**
         * Telnet's state machine is complete in protocol-telnet; only the socket is missing, and the
         * socket is the app module's job. This error is therefore about wiring, not about the
         * protocol, and says so.
         */
        val TELNET_NO_SOCKET: MobileError = MobileError.local(
            code = "engine_unavailable",
            message = "Telnet socket 未注入（IAC 状态机已实现，需宿主提供 socket）",
            retryable = false,
        )
    }
}
