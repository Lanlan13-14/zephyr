package one.zephyr.mobile.protocol.ssh

import kotlinx.coroutines.flow.Flow
import one.zephyr.mobile.model.MobileError

/**
 * The native SSH engine boundary.
 *
 * This is a seam, not an implementation. ADR-002 in NATIVE_ENGINE_DECISIONS.md has not exited its M0
 * spike: the choice between a shared `libssh2` C core and per-platform SSHJ/SwiftNIO SSH depends on
 * measured host-key, agent, algorithm and eight-level-jump behaviour on real hardware. Pinning an
 * engine here before that gate would be the "quietly forked" outcome the ADR forbids.
 *
 * What is implemented in this module is everything that does *not* depend on that choice and is
 * wrong to write twice: host-key trust decisions, route planning across proxies and jump hosts, and
 * the SFTP model. Those are the parts a wrong engine choice would not invalidate.
 */
interface SshEngine {

    /** True once a concrete engine is linked. Every call site must branch on it. */
    val isAvailable: Boolean

    suspend fun connect(request: SshConnectRequest): SshConnectOutcome

    /** Terminal bytes from the remote PTY. */
    fun output(sessionId: String): Flow<ByteArray>

    suspend fun send(sessionId: String, bytes: ByteArray)

    /** Reports the visible terminal geometry. Both cells and pixels, per TERMINAL_EXPERIENCE.md 6. */
    suspend fun resize(sessionId: String, cols: Int, rows: Int, widthPx: Int, heightPx: Int)

    suspend fun disconnect(sessionId: String)

    /** SFTP, Docker, batch execution and snippets are SSH-only (`Protocol.supportsFiles`). */
    suspend fun listDirectory(sessionId: String, path: String): Result<List<SftpEntry>>

    suspend fun exec(sessionId: String, command: String): Result<SshExecResult>
}

data class SshConnectRequest(
    val sessionId: String,
    val route: SshRoute,
    val username: String,
    /**
     * Resolved credential material.
     *
     * Held as a value only for the duration of the call. DEVELOPMENT.md 12 keeps connection secrets
     * in the native SessionSecretArena, never in a Kotlin field that outlives the dial.
     */
    val credential: SshCredential,
    val hostKeyPolicy: HostKeyPolicy,
    val cols: Int = 80,
    val rows: Int = 24,
    val encoding: String = "UTF-8",
)

sealed interface SshCredential {
    data class Password(val value: CharArray) : SshCredential
    data class PrivateKey(val pem: CharArray, val passphrase: CharArray?) : SshCredential

    /** Interactive keyboard-interactive without stored material. */
    data object Interactive : SshCredential
}

data class SshExecResult(val exitCode: Int, val stdout: ByteArray, val stderr: ByteArray)

sealed interface SshConnectOutcome {
    data class Connected(val sessionId: String, val serverBanner: String) : SshConnectOutcome

    /**
     * The engine stopped to ask about a host key.
     *
     * A blocking outcome rather than a callback: DEVELOPMENT.md 14.1 requires an explicit user
     * decision, and a callback that defaults to "continue" is how host-key checks get bypassed.
     */
    data class HostKeyDecisionRequired(val presented: HostKey, val known: HostKey?) : SshConnectOutcome

    data class Failed(val error: MobileError) : SshConnectOutcome
}

/**
 * Stands in until ADR-002 exits M0.
 *
 * It fails loudly with a specific code rather than pretending to connect, so a UI wired against this
 * seam shows an honest "engine not available in this build" state instead of a generic timeout.
 */
class UnavailableSshEngine : SshEngine {

    override val isAvailable: Boolean = false

    override suspend fun connect(request: SshConnectRequest): SshConnectOutcome =
        SshConnectOutcome.Failed(BLOCKED)

    override fun output(sessionId: String): Flow<ByteArray> = kotlinx.coroutines.flow.emptyFlow()

    override suspend fun send(sessionId: String, bytes: ByteArray) = Unit

    override suspend fun resize(sessionId: String, cols: Int, rows: Int, widthPx: Int, heightPx: Int) = Unit

    override suspend fun disconnect(sessionId: String) = Unit

    override suspend fun listDirectory(sessionId: String, path: String): Result<List<SftpEntry>> =
        Result.failure(one.zephyr.mobile.model.MobileApiException(BLOCKED))

    override suspend fun exec(sessionId: String, command: String): Result<SshExecResult> =
        Result.failure(one.zephyr.mobile.model.MobileApiException(BLOCKED))

    private companion object {
        val BLOCKED = MobileError.local(
            code = "engine_unavailable",
            message = "SSH engine is not linked in this build (ADR-002 M0 spike open)",
            retryable = false,
        )
    }
}
