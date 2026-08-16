package one.zephyr.mobile.protocol.ssh

import kotlinx.coroutines.flow.Flow
import one.zephyr.mobile.model.MobileApiException
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

    /** Emits once when read/write detects a remote close or transport error. */
    fun closure(sessionId: String): Flow<Throwable>

    /** Reports a failed asynchronous terminal write without throwing on the UI scope. */
    fun reportFailure(sessionId: String, error: Throwable)

    suspend fun send(sessionId: String, bytes: ByteArray)

    /** Reports the visible terminal geometry. Both cells and pixels, per TERMINAL_EXPERIENCE.md 6. */
    suspend fun resize(sessionId: String, cols: Int, rows: Int, widthPx: Int, heightPx: Int)

    suspend fun disconnect(sessionId: String)

    fun acceptHostKey(sessionId: String, host: String, port: Int) = Unit

    /** Measures one SSH request/reply round trip on an authenticated transport. */
    suspend fun measureLatency(sessionId: String): Long?

    /** SFTP, Docker, batch execution and snippets are SSH-only (`Protocol.supportsFiles`). */
    suspend fun listDirectory(sessionId: String, path: String): Result<SftpDirectory>
    suspend fun stat(sessionId: String, path: String): Result<SftpEntry?>
    suspend fun createDirectory(sessionId: String, path: String): Result<Unit>
    suspend fun createFile(sessionId: String, path: String): Result<Unit>
    suspend fun rename(sessionId: String, from: String, to: String): Result<Unit>
    suspend fun delete(sessionId: String, path: String, recursive: Boolean): Result<Unit>
    suspend fun readFile(sessionId: String, path: String, maxBytes: Int): Result<SshRemoteFile>
    suspend fun readFileRange(
        sessionId: String,
        path: String,
        offset: Long,
        maxBytes: Int,
    ): Result<SshRemoteFile>
    suspend fun writeFile(
        sessionId: String,
        path: String,
        bytes: ByteArray,
        expected: SshRemoteFileVersion? = null,
    ): Result<SshRemoteFileVersion>
    suspend fun chmod(sessionId: String, path: String, mode: Int): Result<Unit>

    suspend fun exec(sessionId: String, command: String): Result<SshExecResult>

    /**
     * Streaming exec for `docker logs -f` / `docker pull`.
     * Completes after [SshExecEvent.Closed]. Cancel the collector to kill the remote process.
     */
    fun execStream(sessionId: String, command: String): Flow<SshExecEvent> =
        kotlinx.coroutines.flow.flow {
            val result = exec(sessionId, command).getOrElse { throw it }
            if (result.stdout.isNotEmpty()) emit(SshExecEvent.Stdout(result.stdout))
            if (result.stderr.isNotEmpty()) emit(SshExecEvent.Stderr(result.stderr))
            emit(SshExecEvent.Closed(result.exitCode))
        }

    /**
     * Stream a remote file in chunks so a 2 GiB download never sits in a ByteArray.
     * [onChunk] is invoked on the IO dispatcher.
     */
    suspend fun readFileStream(
        sessionId: String,
        path: String,
        offset: Long = 0L,
        onChunk: suspend (offset: Long, bytes: ByteArray, total: Long) -> Unit,
    ): Result<SshRemoteFileVersion> = readFileRange(sessionId, path, offset, Int.MAX_VALUE / 4).mapCatching { file ->
        if (file.bytes.isNotEmpty()) onChunk(offset, file.bytes, file.size)
        SshRemoteFileVersion(file.path, file.size, file.modifiedAt)
    }

    /**
     * Stream-write [next] chunks to [path]. [next] returns the next payload or null at EOF.
     */
    suspend fun writeFileStream(
        sessionId: String,
        path: String,
        expected: SshRemoteFileVersion? = null,
        next: suspend () -> ByteArray?,
    ): Result<SshRemoteFileVersion> {
        val chunks = ArrayList<ByteArray>()
        var total = 0
        while (true) {
            val chunk = next() ?: break
            chunks += chunk
            total += chunk.size
            if (total > 8 * 1024 * 1024) {
                return Result.failure(IllegalStateException("写入内容过大，当前引擎回退上限 8 MiB"))
            }
        }
        val bytes = ByteArray(total)
        var cursor = 0
        for (chunk in chunks) {
            System.arraycopy(chunk, 0, bytes, cursor, chunk.size)
            cursor += chunk.size
        }
        return writeFile(sessionId, path, bytes, expected)
    }
}

sealed interface SshExecEvent {
    data class Stdout(val bytes: ByteArray) : SshExecEvent
    data class Stderr(val bytes: ByteArray) : SshExecEvent
    data class Closed(val exitCode: Int) : SshExecEvent
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

data class SshRemoteFile(
    val path: String,
    val bytes: ByteArray,
    val size: Long,
    val modifiedAt: Long,
    val permissions: Int,
)

data class SshRemoteFileVersion(
    val path: String,
    val size: Long,
    val modifiedAt: Long,
)

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

    override fun closure(sessionId: String): Flow<Throwable> = kotlinx.coroutines.flow.emptyFlow()

    override fun reportFailure(sessionId: String, error: Throwable) = Unit

    override suspend fun send(sessionId: String, bytes: ByteArray) = Unit

    override suspend fun resize(sessionId: String, cols: Int, rows: Int, widthPx: Int, heightPx: Int) = Unit

    override suspend fun disconnect(sessionId: String) = Unit

    override suspend fun measureLatency(sessionId: String): Long? = null

    override suspend fun listDirectory(sessionId: String, path: String): Result<SftpDirectory> =
        Result.failure(one.zephyr.mobile.model.MobileApiException(BLOCKED))

    override suspend fun stat(sessionId: String, path: String): Result<SftpEntry?> =
        Result.failure(MobileApiException(BLOCKED))
    override suspend fun createDirectory(sessionId: String, path: String): Result<Unit> =
        Result.failure(MobileApiException(BLOCKED))
    override suspend fun createFile(sessionId: String, path: String): Result<Unit> =
        Result.failure(MobileApiException(BLOCKED))
    override suspend fun rename(sessionId: String, from: String, to: String): Result<Unit> =
        Result.failure(MobileApiException(BLOCKED))
    override suspend fun delete(sessionId: String, path: String, recursive: Boolean): Result<Unit> =
        Result.failure(MobileApiException(BLOCKED))

    override suspend fun readFile(sessionId: String, path: String, maxBytes: Int): Result<SshRemoteFile> =
        Result.failure(MobileApiException(BLOCKED))

    override suspend fun readFileRange(
        sessionId: String,
        path: String,
        offset: Long,
        maxBytes: Int,
    ): Result<SshRemoteFile> = Result.failure(MobileApiException(BLOCKED))

    override suspend fun writeFile(
        sessionId: String,
        path: String,
        bytes: ByteArray,
        expected: SshRemoteFileVersion?,
    ): Result<SshRemoteFileVersion> = Result.failure(MobileApiException(BLOCKED))

    override suspend fun chmod(sessionId: String, path: String, mode: Int): Result<Unit> =
        Result.failure(MobileApiException(BLOCKED))

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
