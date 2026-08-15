package one.zephyr.mobile.protocol.ssh

/**
 * One SFTP directory entry.
 *
 * [permissions] is the raw POSIX mode because the UI shows `rwxr-xr-x`, and recomputing it from
 * booleans loses setuid and sticky bits that matter when a user is diagnosing a permission problem.
 */
data class SftpEntry(
    val name: String,
    val path: String,
    val isDirectory: Boolean,
    val isSymlink: Boolean,
    val size: Long,
    val modifiedAt: Long,
    val permissions: Int,
    val owner: String = "",
    val group: String = "",
) {
    val isHidden: Boolean get() = name.startsWith(".")

    /** `drwxr-xr-x`, matching what the Zephyr web file manager shows. */
    fun modeString(): String {
        val builder = StringBuilder(10)
        builder.append(if (isSymlink) 'l' else if (isDirectory) 'd' else '-')
        val triples = intArrayOf(6, 3, 0)
        for (shift in triples) {
            val bits = (permissions shr shift) and 0x7
            builder.append(if (bits and 0x4 != 0) 'r' else '-')
            builder.append(if (bits and 0x2 != 0) 'w' else '-')
            builder.append(if (bits and 0x1 != 0) 'x' else '-')
        }
        return builder.toString()
    }
}

data class SftpDirectory(
    val path: String,
    val entries: List<SftpEntry>,
)

/**
 * How a transfer resolves a name that already exists at the destination.
 *
 * DEVELOPMENT.md 14.1 lists mtime conflict as an M0 gate, so the choice is explicit rather than an
 * overwrite default: silently overwriting a newer remote file is unrecoverable from a phone.
 */
enum class SftpConflictPolicy { FAIL, OVERWRITE, RESUME, RENAME }

/** Progress for one transfer. Resumable so a mobile network drop does not restart a 1 GiB copy. */
data class SftpTransferProgress(
    val path: String,
    val bytesDone: Long,
    val bytesTotal: Long,
    val resumedFrom: Long = 0L,
) {
    val fraction: Float get() = if (bytesTotal <= 0L) 0f else (bytesDone.toFloat() / bytesTotal.toFloat()).coerceIn(0f, 1f)
}
