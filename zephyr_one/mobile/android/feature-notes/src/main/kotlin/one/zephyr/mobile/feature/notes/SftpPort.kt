package one.zephyr.mobile.feature.notes

import one.zephyr.mobile.model.MobileError
import one.zephyr.mobile.model.MobileApiException

/**
 * One entry in a remote directory.
 *
 * Carries only what the S31 list, breadcrumb and editor baseline actually need. A permission string
 * is kept verbatim rather than parsed into flags: SFTP servers disagree about the octal bits, and
 * One has no business guessing what a mode means on the far side.
 */
data class RemoteEntry(
    val name: String,
    val path: String,
    val isDirectory: Boolean,
    val sizeBytes: Long,
    val mtimeMs: Long,
    val permissions: String = "",
    val isSymlink: Boolean = false,
)

/** Result of a stat. Separated from [RemoteEntry] so a save-time check cannot be fed a list row. */
data class RemoteStat(
    val path: String,
    val isDirectory: Boolean,
    val sizeBytes: Long,
    val mtimeMs: Long,
    val sha256: String?,
)

/**
 * Bytes read from the remote file, with the two values the editor must remember.
 *
 * SCREEN_CATALOG.md 12 requires mtime and hash to be recorded at read time, so they are returned
 * together with the content rather than fetched again later: a second stat could already be a
 * different revision, which would make the baseline useless.
 *
 * Raw bytes rather than decoded text because encoding is a first-class S31 state: the user may
 * re-decode the same buffer as GBK or Big5 without another round trip.
 */
class RemoteFileRead(
    val path: String,
    val bytes: ByteArray,
    val mtimeMs: Long,
    val sha256: String,
    /** True when the file exceeded the editor ceiling and only a prefix was read. */
    val truncated: Boolean = false,
) {
    override fun equals(other: Any?): Boolean = other is RemoteFileRead &&
        path == other.path &&
        mtimeMs == other.mtimeMs &&
        sha256 == other.sha256 &&
        truncated == other.truncated &&
        bytes.contentEquals(other.bytes)

    override fun hashCode(): Int {
        var result = path.hashCode()
        result = 31 * result + mtimeMs.hashCode()
        result = 31 * result + sha256.hashCode()
        result = 31 * result + truncated.hashCode()
        result = 31 * result + bytes.contentHashCode()
        return result
    }
}

/** What the server reports after a successful write, so the editor can rebase without a re-read. */
data class RemoteWriteReceipt(val path: String, val mtimeMs: Long, val sha256: String)

/** Opaque session token. The engine owns its meaning; One only passes it back. */
@JvmInline
value class SftpSessionHandle(val token: String)

/**
 * A chunk of a download in flight, reported as entity counts rather than a ratio.
 *
 * SCREEN_CATALOG.md 26 requires progress to be a readable percentage or entity count, so bytes are
 * carried explicitly and the percentage is derived where it is rendered.
 */
data class DownloadProgress(val transferredBytes: Long, val totalBytes: Long?)

/** One remote shell command run on the same SSH session the SFTP handle owns. */
data class RemoteExecResult(val exitCode: Int, val stdout: String, val stderr: String) {
    fun requireOk(label: String = "远程命令"): String {
        if (exitCode != 0) {
            error(stderr.ifBlank { stdout }.ifBlank { "$label 失败（exit $exitCode）" })
        }
        return stdout
    }
}

/**
 * The narrow SFTP surface S31 is written against.
 *
 * There is deliberately no implementation of this interface in this module.
 * NATIVE_ENGINE_DECISIONS.md ADR-002 records libssh2 + a Zephyr adapter as a *decision*, and the
 * engine has not been built: no SSH transport, no SFTP subsystem, no host-key store. Shipping a
 * stub that pretended to connect would be worse than shipping nothing, because the user would
 * believe a directory listing or a save had actually reached the server. So the state machine,
 * capability gates, conflict rules and UI are complete and testable here, and the binding to the
 * real engine is the single seam the app module fills once ADR-002 lands.
 *
 * Every method suspends and signals failure by throwing [MobileApiException] with a structured
 * [MobileError], which is what lets the ViewModel map a failure onto the frozen page states instead
 * of inventing a toast.
 */
interface SftpPort {

    /** Opens a file channel over an existing connection definition. */
    suspend fun open(connectionId: String): SftpSessionHandle

    suspend fun close(handle: SftpSessionHandle)

    /** True while the underlying transport is usable; drives the disconnected state. */
    suspend fun isOpen(handle: SftpSessionHandle): Boolean

    /** Resolves `.`, `..`, and symlinks to a server canonical absolute path. */
    suspend fun canonicalPath(handle: SftpSessionHandle, path: String): String

    suspend fun list(handle: SftpSessionHandle, directory: String): List<RemoteEntry>

    suspend fun stat(handle: SftpSessionHandle, path: String): RemoteStat?

    suspend fun read(handle: SftpSessionHandle, path: String, maxBytes: Long): RemoteFileRead

    /**
     * @param expectedMtimeMs and [expectedSha256] are the editor baseline. An engine that can do a
     *   compare-and-set uses them; one that cannot must still be given them so the adapter can
     *   re-stat immediately before writing. [force] is only ever true after the user confirmed an
     *   overwrite in the UI.
     */
    suspend fun write(
        handle: SftpSessionHandle,
        path: String,
        bytes: ByteArray,
        expectedMtimeMs: Long?,
        expectedSha256: String?,
        force: Boolean,
    ): RemoteWriteReceipt

    suspend fun createDirectory(handle: SftpSessionHandle, path: String)

    suspend fun createFile(handle: SftpSessionHandle, path: String)

    suspend fun rename(handle: SftpSessionHandle, from: String, to: String)

    suspend fun delete(handle: SftpSessionHandle, path: String, recursive: Boolean)

    suspend fun chmod(handle: SftpSessionHandle, path: String, mode: Int)

    suspend fun readRange(
        handle: SftpSessionHandle,
        path: String,
        offset: Long,
        maxBytes: Int,
    ): RemoteFileRead

    suspend fun upload(handle: SftpSessionHandle, path: String, bytes: ByteArray): RemoteWriteReceipt

    /**
     * Resumable download.
     *
     * @param resumeFromBytes non-zero continues a paused transfer, which is the frozen
     *   pause/continue state from SCREEN_CATALOG.md 12.
     * @param onProgress called on the caller's coroutine; implementations must not assume a
     *   dispatcher.
     */
    suspend fun download(
        handle: SftpSessionHandle,
        path: String,
        destinationUri: String,
        resumeFromBytes: Long,
        onProgress: (DownloadProgress) -> Unit,
    ): Long

    /** Runs a shell command on the same SSH session. Used for compress / extract / copy / properties. */
    suspend fun exec(handle: SftpSessionHandle, command: String): RemoteExecResult
}

/**
 * The only [SftpPort] this module ships.
 *
 * Fails every call with a structured, non-retryable error. This is the honest representation of
 * ADR-002 being a decision rather than code: the screen renders its fatal-incompatible state and
 * says the file engine is absent from this build, instead of showing an empty directory that the
 * user would read as "the server has no files".
 */
object UnavailableSftpPort : SftpPort {

    const val ERROR_CODE = "sftp_engine_unavailable"
    const val ERROR_MESSAGE = "此版本尚未内置 SFTP 引擎，无法访问远程文件"

    private fun fail(): Nothing = throw MobileApiException(
        MobileError.local(code = ERROR_CODE, message = ERROR_MESSAGE, retryable = false),
    )

    override suspend fun open(connectionId: String): SftpSessionHandle = fail()

    override suspend fun close(handle: SftpSessionHandle) = fail()

    override suspend fun isOpen(handle: SftpSessionHandle): Boolean = false

    override suspend fun canonicalPath(handle: SftpSessionHandle, path: String): String = fail()

    override suspend fun list(handle: SftpSessionHandle, directory: String): List<RemoteEntry> = fail()

    override suspend fun stat(handle: SftpSessionHandle, path: String): RemoteStat? = fail()

    override suspend fun read(handle: SftpSessionHandle, path: String, maxBytes: Long): RemoteFileRead = fail()

    override suspend fun write(
        handle: SftpSessionHandle,
        path: String,
        bytes: ByteArray,
        expectedMtimeMs: Long?,
        expectedSha256: String?,
        force: Boolean,
    ): RemoteWriteReceipt = fail()

    override suspend fun createDirectory(handle: SftpSessionHandle, path: String) = fail()

    override suspend fun createFile(handle: SftpSessionHandle, path: String) = fail()

    override suspend fun rename(handle: SftpSessionHandle, from: String, to: String) = fail()

    override suspend fun delete(handle: SftpSessionHandle, path: String, recursive: Boolean) = fail()

    override suspend fun chmod(handle: SftpSessionHandle, path: String, mode: Int) = fail()

    override suspend fun readRange(
        handle: SftpSessionHandle,
        path: String,
        offset: Long,
        maxBytes: Int,
    ): RemoteFileRead = fail()

    override suspend fun upload(handle: SftpSessionHandle, path: String, bytes: ByteArray): RemoteWriteReceipt = fail()

    override suspend fun download(
        handle: SftpSessionHandle,
        path: String,
        destinationUri: String,
        resumeFromBytes: Long,
        onProgress: (DownloadProgress) -> Unit,
    ): Long = fail()

    override suspend fun exec(handle: SftpSessionHandle, command: String): RemoteExecResult = fail()
}
