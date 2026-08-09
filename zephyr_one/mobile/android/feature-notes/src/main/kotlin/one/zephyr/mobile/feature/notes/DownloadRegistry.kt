package one.zephyr.mobile.feature.notes

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import one.zephyr.mobile.model.MobileError

/** Lifecycle of one download. Pause and resume are frozen states in SCREEN_CATALOG.md 12. */
enum class DownloadState {
    QUEUED,
    RUNNING,
    PAUSED,
    COMPLETED,
    FAILED,

    /** Bytes arrived but the hash did not match: the frozen hash-mismatch state. */
    INTEGRITY_FAILED,
    ;

    val isFinished: Boolean get() = this == COMPLETED || this == FAILED || this == INTEGRITY_FAILED
    val isActive: Boolean get() = this == QUEUED || this == RUNNING
    val canPause: Boolean get() = this == RUNNING || this == QUEUED
    val canResume: Boolean get() = this == PAUSED || this == FAILED
}

/**
 * One download, as the user sees it.
 *
 * [remotePath] is held because the row has to be resumable and re-openable, but it is display and
 * request data only: SCREEN_CATALOG.md 11 says paths do not go into telemetry, so nothing here is
 * ever handed to an analytics or logging sink.
 */
data class FileDownload(
    val id: String,
    val connectionId: String,
    val connectionName: String,
    val remotePath: String,
    val destinationUri: String,
    val transferredBytes: Long = 0,
    val totalBytes: Long? = null,
    val state: DownloadState = DownloadState.QUEUED,
    val expectedSha256: String? = null,
    val actualSha256: String? = null,
    val error: MobileError? = null,
    val startedAt: Long = 0,
    val updatedAt: Long = 0,
) {
    val fileName: String get() = RemotePath.nameOf(remotePath)

    /**
     * Readable percentage, or null when the server did not report a size.
     *
     * SCREEN_CATALOG.md 26 requires progress as a readable percentage or entity count, so a null
     * here means the UI must show transferred bytes instead of a meaningless bar.
     */
    val percentComplete: Int?
        get() {
            val total = totalBytes ?: return null
            if (total <= 0L) return null
            return ((transferredBytes.coerceAtMost(total) * 100L) / total).toInt()
        }

    val remainingBytes: Long? get() = totalBytes?.let { (it - transferredBytes).coerceAtLeast(0L) }
}

/**
 * In-memory download book-keeping for the file screens.
 *
 * This is state, not transport: it records what the user asked for and how far each transfer got,
 * and it is the single source both S30's 下载 card and S31's transfer list read. The bytes
 * themselves are moved by [SftpPort], which is unimplemented in this build (ADR-002), so this class
 * deliberately performs no I/O at all and survives no process death.
 */
class DownloadRegistry(private val clock: () -> Long = System::currentTimeMillis) {

    private val items = MutableStateFlow<List<FileDownload>>(emptyList())
    val downloads: StateFlow<List<FileDownload>> = items.asStateFlow()

    fun enqueue(
        id: String,
        connectionId: String,
        connectionName: String,
        remotePath: String,
        destinationUri: String,
        totalBytes: Long?,
        expectedSha256: String? = null,
    ): FileDownload {
        val now = clock()
        val row = FileDownload(
            id = id,
            connectionId = connectionId,
            connectionName = connectionName,
            remotePath = remotePath,
            destinationUri = destinationUri,
            totalBytes = totalBytes,
            expectedSha256 = expectedSha256,
            state = DownloadState.QUEUED,
            startedAt = now,
            updatedAt = now,
        )
        items.value = items.value.filterNot { it.id == id } + row
        return row
    }

    fun markRunning(id: String) = mutate(id) { it.copy(state = DownloadState.RUNNING) }

    /**
     * Progress never moves backwards and never exceeds the total.
     *
     * A resumed transfer re-reports its offset, and an adapter that double-counted a retried chunk
     * would otherwise drive the percentage above 100 and make the readout untrustworthy.
     */
    fun onProgress(id: String, transferredBytes: Long, totalBytes: Long?) = mutate(id) { current ->
        val total = totalBytes ?: current.totalBytes
        val bounded = maxOf(current.transferredBytes, transferredBytes).let { value ->
            if (total != null && total > 0L) value.coerceAtMost(total) else value
        }
        current.copy(
            transferredBytes = bounded,
            totalBytes = total,
            state = if (current.state == DownloadState.QUEUED) DownloadState.RUNNING else current.state,
        )
    }

    /** Pausing keeps [FileDownload.transferredBytes] so the resume can pass it as the read offset. */
    fun pause(id: String) = mutate(id) { current ->
        if (current.state.canPause) current.copy(state = DownloadState.PAUSED) else current
    }

    fun resume(id: String) = mutate(id) { current ->
        if (current.state.canResume) current.copy(state = DownloadState.RUNNING, error = null) else current
    }

    /**
     * Completion also decides integrity.
     *
     * A finished transfer whose hash disagrees with the server's is reported as
     * [DownloadState.INTEGRITY_FAILED] rather than success: the file on disk is wrong, and calling
     * that "已完成" would be the silent-corruption case SCREEN_CATALOG.md 12 lists as a state.
     */
    fun complete(id: String, transferredBytes: Long, actualSha256: String?) = mutate(id) { current ->
        val mismatch = current.expectedSha256 != null &&
            actualSha256 != null &&
            !ContentHash.matches(current.expectedSha256, actualSha256)
        current.copy(
            transferredBytes = transferredBytes,
            totalBytes = current.totalBytes ?: transferredBytes,
            actualSha256 = actualSha256,
            state = if (mismatch) DownloadState.INTEGRITY_FAILED else DownloadState.COMPLETED,
            error = if (mismatch) {
                MobileError.local(code = ERROR_HASH_MISMATCH, message = MSG_HASH_MISMATCH)
            } else {
                null
            },
        )
    }

    fun fail(id: String, error: MobileError) = mutate(id) {
        it.copy(state = DownloadState.FAILED, error = error)
    }

    fun remove(id: String) {
        items.value = items.value.filterNot { it.id == id }
    }

    fun clearFinished() {
        items.value = items.value.filterNot { it.state.isFinished }
    }

    /** Cleared on unbind, account switch and app lock, like every other in-memory holder. */
    fun clear() {
        items.value = emptyList()
    }

    fun find(id: String): FileDownload? = items.value.firstOrNull { it.id == id }

    fun activeCount(): Int = items.value.count { it.state.isActive }

    private fun mutate(id: String, transform: (FileDownload) -> FileDownload) {
        val now = clock()
        items.value = items.value.map { row ->
            if (row.id == id) transform(row).copy(updatedAt = now) else row
        }
    }

    companion object {
        const val ERROR_HASH_MISMATCH = "download_hash_mismatch"
        const val MSG_HASH_MISMATCH = "下载完成但校验不一致，文件可能已损坏"
    }
}
