package one.zephyr.mobile.feature.notes

import one.zephyr.mobile.protocol.ssh.SshFileKinds

/** What tapping a remote file should do. Mirrors `public/terminal.js` open / preview routing. */
enum class SftpOpenKind { DIRECTORY, IMAGE, MEDIA, TEXT, ARCHIVE, BINARY }

object SftpOpenPolicy {

    const val TEXT_EDIT_LIMIT = 2L * 1024 * 1024
    const val IMAGE_PREVIEW_LIMIT = 8L * 1024 * 1024
    const val MEDIA_PREVIEW_LIMIT = 32L * 1024 * 1024

    fun kindOf(entry: RemoteEntry): SftpOpenKind = when {
        entry.isDirectory -> SftpOpenKind.DIRECTORY
        SshFileKinds.isImage(entry.name) -> SftpOpenKind.IMAGE
        SshFileKinds.isMedia(entry.name) -> SftpOpenKind.MEDIA
        SshFileKinds.isArchive(entry.name) -> SftpOpenKind.ARCHIVE
        SshFileKinds.isText(entry.name) -> SftpOpenKind.TEXT
        else -> SftpOpenKind.BINARY
    }

    fun previewLimit(kind: SftpOpenKind): Long = when (kind) {
        SftpOpenKind.TEXT -> TEXT_EDIT_LIMIT
        SftpOpenKind.IMAGE -> IMAGE_PREVIEW_LIMIT
        SftpOpenKind.MEDIA -> MEDIA_PREVIEW_LIMIT
        else -> TEXT_EDIT_LIMIT
    }

    fun rejectReason(kind: SftpOpenKind, sizeBytes: Long): String? = when {
        kind == SftpOpenKind.TEXT && sizeBytes > TEXT_EDIT_LIMIT ->
            "文件超过 ${formatBytes(TEXT_EDIT_LIMIT)}，拒绝作为文本打开"
        kind == SftpOpenKind.IMAGE && sizeBytes > IMAGE_PREVIEW_LIMIT ->
            "图片超过 ${formatBytes(IMAGE_PREVIEW_LIMIT)}，请下载后查看"
        kind == SftpOpenKind.MEDIA && sizeBytes > MEDIA_PREVIEW_LIMIT ->
            "媒体超过 ${formatBytes(MEDIA_PREVIEW_LIMIT)}，请下载后播放"
        else -> null
    }

    fun formatBytes(bytes: Long): String {
        if (bytes < 1024L) return "$bytes B"
        val units = listOf("KiB", "MiB", "GiB", "TiB")
        var value = bytes.toDouble() / 1024.0
        var unit = 0
        while (value >= 1024.0 && unit < units.lastIndex) {
            value /= 1024.0
            unit++
        }
        val rounded = (value * 10.0).toLong()
        return "${rounded / 10L}.${rounded % 10L} ${units[unit]}"
    }

    fun formatTime(mtimeMs: Long): String {
        if (mtimeMs <= 0L) return "—"
        val seconds = mtimeMs / 1000L
        val date = java.time.Instant.ofEpochSecond(seconds).atZone(java.time.ZoneId.systemDefault())
        return "%04d-%02d-%02d %02d:%02d".format(
            date.year,
            date.monthValue,
            date.dayOfMonth,
            date.hour,
            date.minute,
        )
    }
}

enum class SftpClipboardMode { COPY, CUT }

data class SftpClipboard(
    val mode: SftpClipboardMode,
    val paths: List<String>,
    val sourceDirectory: String,
) {
    val isEmpty: Boolean get() = paths.isEmpty()
    val count: Int get() = paths.size
}

enum class SftpPasteConflictMode { OVERWRITE, SKIP, COMPATIBLE }

data class SftpPastePlan(
    val copies: List<Pair<String, String>>,
    val skipped: List<String>,
    val overwrites: List<String>,
)

object SftpClipboardOps {

    fun planPaste(
        clipboard: SftpClipboard,
        destination: String,
        existingNames: Set<String>,
        conflict: SftpPasteConflictMode,
    ): SftpPastePlan {
        val copies = ArrayList<Pair<String, String>>()
        val skipped = ArrayList<String>()
        val overwrites = ArrayList<String>()
        val reserved = existingNames.toMutableSet()
        for (source in clipboard.paths) {
            val name = RemotePath.nameOf(source)
            val clash = name in reserved
            when {
                !clash -> {
                    val target = RemotePath.join(destination, name)
                    copies += source to target
                    reserved += name
                }
                conflict == SftpPasteConflictMode.SKIP -> skipped += source
                conflict == SftpPasteConflictMode.OVERWRITE -> {
                    val target = RemotePath.join(destination, name)
                    copies += source to target
                    overwrites += target
                }
                else -> {
                    val renamed = SshFileKinds.uniqueCopyName(reserved, name)
                    copies += source to RemotePath.join(destination, renamed)
                    reserved += renamed
                }
            }
        }
        return SftpPastePlan(copies = copies, skipped = skipped, overwrites = overwrites)
    }

    fun commandFor(plan: SftpPastePlan, cut: Boolean): String? {
        if (plan.copies.isEmpty()) return null
        val quote = one.zephyr.mobile.protocol.ssh.SshRemoteOps::shellQuote
        val parts = ArrayList<String>()
        if (cut) {
            for (target in plan.overwrites) {
                parts += SshFileKinds.recursiveDeleteCommand(target)
            }
        }
        for ((from, to) in plan.copies) {
            val destDir = RemotePath.parentOf(to)
            val op = if (cut) "mv" else "cp -a"
            parts += "mkdir -p ${quote(destDir)} && $op -- ${quote(from)} ${quote(to)}"
        }
        return parts.joinToString(" && ")
    }
}
