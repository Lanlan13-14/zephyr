package one.zephyr.mobile.feature.notes

import one.zephyr.mobile.contracts.Capability
import one.zephyr.mobile.model.CapabilitySet
import one.zephyr.mobile.model.Connection
import one.zephyr.mobile.model.EmptyReason
import one.zephyr.mobile.model.MobileError
import one.zephyr.mobile.model.PageState

/** List or grid, per SCREEN_CATALOG.md 12. A device-local view choice, never synced. */
enum class FileViewMode { LIST, GRID }

enum class FileSortKey { NAME, SIZE, MTIME }

/**
 * Why the browser cannot show a listing.
 *
 * Each case maps to exactly one frozen page state. Modelling them as a type instead of passing a
 * MobileError around is what stops "权限撤销" and "目录不存在" from both degrading into a generic
 * retryable error, which MOBILE_EXPERIENCE.md 6 calls out as the anti-pattern.
 */
sealed interface SftpFailure {

    /** Transport dropped. Reconnecting is a real remedy, so this stays retryable. */
    data object Disconnected : SftpFailure

    /** The grant lost fileRead/fileWrite while the screen was open. */
    data class CapabilityRevoked(val missing: Capability, val reason: String) : SftpFailure

    /** The directory was removed or renamed underneath the breadcrumb. */
    data class DirectoryMissing(val path: String) : SftpFailure

    /** Anything the engine reported with a structured code. */
    data class Transport(val error: MobileError) : SftpFailure

    /**
     * No SFTP engine in this build.
     *
     * NATIVE_ENGINE_DECISIONS.md ADR-002 is a decision, not an implementation, so this is the state
     * the screen actually reaches today. It maps to fatal-incompatible rather than to a retryable
     * error because no amount of retrying adds an engine to an installed APK.
     */
    data object EngineUnavailable : SftpFailure
}

/** One selectable connection in the S31 picker. */
data class SftpConnectionOption(
    val connectionId: String,
    val name: String,
    val host: String,
    val port: Int,
    val capabilities: CapabilitySet,
) {
    val canBrowse: Boolean get() = capabilities.canReadFiles
    val canWrite: Boolean get() = capabilities.canWriteFiles

    companion object {
        fun of(connection: Connection): SftpConnectionOption = SftpConnectionOption(
            connectionId = connection.id,
            name = connection.name,
            host = connection.host,
            port = connection.port,
            capabilities = connection.capabilities,
        )
    }
}

/** Everything the S31 list renders once a directory has been read. */
data class SftpBrowserContent(
    val connectionId: String,
    val connectionName: String,
    val directory: String,
    val crumbs: List<RemotePath.Crumb>,
    val entries: List<RemoteEntry>,
    val viewMode: FileViewMode,
    val sortKey: FileSortKey,
    val ascending: Boolean,
    val query: String,
    val capabilities: CapabilitySet,
    val totalCount: Int,
) {
    val isAtRoot: Boolean get() = RemotePath.isAtRoot(directory)
    val canWrite: Boolean get() = capabilities.canWriteFiles

    /** Hidden entries are filtered out of [entries]; the count keeps the toggle honest. */
    val hiddenCount: Int get() = (totalCount - entries.size).coerceAtLeast(0)
}

/** Inputs for one derivation. A parameter object because eleven positional arguments invite mistakes. */
data class SftpBrowserInput(
    val connectionId: String?,
    val connectionName: String = "",
    val directory: String = RemotePath.ROOT,
    /** null until the first listing arrives; an empty list is a genuinely empty directory. */
    val entries: List<RemoteEntry>? = null,
    val capabilities: CapabilitySet = CapabilitySet.none,
    val query: String = "",
    val showHidden: Boolean = false,
    val sortKey: FileSortKey = FileSortKey.NAME,
    val ascending: Boolean = true,
    val viewMode: FileViewMode = FileViewMode.LIST,
    val online: Boolean = true,
    val connected: Boolean = false,
    val failure: SftpFailure? = null,
)

/**
 * S31 SFTP 文件管理, as a pure function.
 *
 * Every frozen state in SCREEN_CATALOG.md 12 is reachable from here, and the branch order *is* the
 * specification: failures outrank connectivity, connectivity outranks emptiness, and a filtered
 * empty result is never reported as an empty directory.
 */
object SftpBrowserStates {

    fun derive(input: SftpBrowserInput): PageState<SftpBrowserContent> {
        input.failure?.let { return toPageState(it) }

        // No connection chosen yet. The picker is rendered above the scaffold and is itself the
        // action out of this state, so there is nothing to retry and nothing to report.
        val connectionId = input.connectionId ?: return PageState.Empty(EmptyReason.NO_DATA)

        // Read capability gates the whole browser, not individual rows: without it there is no
        // listing to show, so this is a page-level permission state.
        if (!SftpCapabilities.canBrowse(input.capabilities)) {
            return PageState.PermissionDenied(Capability.FILE_READ, SftpCapabilities.REASON_NO_READ)
        }

        // A remote filesystem has no mirror. SHARED_RESOURCE_RESIDENCY.md's offline-with-cache does
        // not apply: there is no cached directory, so offline is terminal here.
        if (!input.online) return PageState.OfflineNoCache

        if (!input.connected) return toPageState(SftpFailure.Disconnected)

        val all = input.entries ?: return PageState.InitialLoading
        val visible = filterAndSort(all, input)

        if (visible.isEmpty()) {
            val reason = if (input.query.isNotBlank() || (!input.showHidden && all.isNotEmpty())) {
                EmptyReason.NO_MATCHING_FILTER
            } else {
                EmptyReason.NO_DATA
            }
            return PageState.Empty(reason)
        }

        return PageState.Content(
            SftpBrowserContent(
                connectionId = connectionId,
                connectionName = input.connectionName,
                directory = RemotePath.normalize(input.directory),
                crumbs = RemotePath.crumbs(input.directory),
                entries = visible,
                viewMode = input.viewMode,
                sortKey = input.sortKey,
                ascending = input.ascending,
                query = input.query,
                capabilities = input.capabilities,
                totalCount = all.size,
            ),
        )
    }

    /**
     * Failure to page state.
     *
     * Exposed separately so a test can assert the mapping without building a whole input, and so the
     * editor can reuse the same table: a revoked grant must read identically on both screens.
     */
    fun toPageState(failure: SftpFailure): PageState<Nothing> = when (failure) {
        SftpFailure.Disconnected -> PageState.RetryableError(
            MobileError.local(code = ERROR_DISCONNECTED, message = MSG_DISCONNECTED, retryable = true),
        )

        is SftpFailure.CapabilityRevoked -> PageState.PermissionDenied(failure.missing, failure.reason)

        // Not-found and revoked share a state by design: telling the user which of the two it was
        // would leak whether a path they can no longer see still exists.
        is SftpFailure.DirectoryMissing -> PageState.NotFoundOrRevoked

        is SftpFailure.Transport -> PageState.RetryableError(failure.error)

        SftpFailure.EngineUnavailable -> PageState.FatalIncompatible(
            MobileError.local(
                code = UnavailableSftpPort.ERROR_CODE,
                message = UnavailableSftpPort.ERROR_MESSAGE,
                retryable = false,
            ),
        )
    }

    /**
     * Filter, then sort.
     *
     * Directories always sort before files regardless of the key, which is the behaviour every file
     * manager has and the reason "sort by size" does not scatter folders through the list. Dotfiles
     * are hidden unless asked for, and the count of what was hidden survives into the content so the
     * toggle can say how many rows it would add.
     */
    fun filterAndSort(entries: List<RemoteEntry>, input: SftpBrowserInput): List<RemoteEntry> {
        val needle = input.query.trim().lowercase()
        val filtered = entries.filter { entry ->
            if (!input.showHidden && entry.name.startsWith(".")) return@filter false
            needle.isEmpty() || entry.name.lowercase().contains(needle)
        }
        val comparator = when (input.sortKey) {
            FileSortKey.NAME -> compareBy(String.CASE_INSENSITIVE_ORDER) { it: RemoteEntry -> it.name }
            FileSortKey.SIZE -> compareBy { it: RemoteEntry -> it.sizeBytes }
            FileSortKey.MTIME -> compareBy { it: RemoteEntry -> it.mtimeMs }
        }
        val directed = if (input.ascending) comparator else comparator.reversed()
        return filtered.sortedWith(
            compareByDescending<RemoteEntry> { it.isDirectory }
                .then(directed)
                .thenBy { it.name },
        )
    }

    /** Human-readable size. Entity counts and percentages only, per SCREEN_CATALOG.md 26. */
    fun formatSize(bytes: Long): String {
        if (bytes < 1024L) return bytes.toString() + " B"
        val units = listOf("KiB", "MiB", "GiB", "TiB")
        var value = bytes.toDouble() / 1024.0
        var unit = 0
        while (value >= 1024.0 && unit < units.size - 1) {
            value /= 1024.0
            unit++
        }
        // One decimal place: enough to distinguish 1.2 MiB from 1.9 MiB without implying precision
        // the filesystem never reported.
        val rounded = (value * 10.0).toLong()
        return (rounded / 10L).toString() + "." + (rounded % 10L).toString() + " " + units[unit]
    }

    const val ERROR_DISCONNECTED = "sftp_disconnected"
    const val MSG_DISCONNECTED = "文件通道已断开，请重新连接"

    /** Editor ceiling. Above this the file opens read-only truncated rather than eating memory. */
    const val MAX_EDITABLE_BYTES = 2L * 1024 * 1024
}
