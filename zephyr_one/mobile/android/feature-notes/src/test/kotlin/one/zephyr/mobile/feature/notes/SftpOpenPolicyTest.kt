package one.zephyr.mobile.feature.notes

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SftpOpenPolicyTest {

    private fun entry(name: String, directory: Boolean = false, size: Long = 10L) = RemoteEntry(
        name = name,
        path = "/var/$name",
        isDirectory = directory,
        sizeBytes = size,
        mtimeMs = 1_700_000_000_000,
    )

    @Test
    fun tapRoutesMatchDesktopPreviewTables() {
        assertEquals(SftpOpenKind.DIRECTORY, SftpOpenPolicy.kindOf(entry("etc", directory = true)))
        assertEquals(SftpOpenKind.IMAGE, SftpOpenPolicy.kindOf(entry("logo.PNG")))
        assertEquals(SftpOpenKind.MEDIA, SftpOpenPolicy.kindOf(entry("clip.mkv")))
        assertEquals(SftpOpenKind.MEDIA, SftpOpenPolicy.kindOf(entry("song.flac")))
        assertEquals(SftpOpenKind.ARCHIVE, SftpOpenPolicy.kindOf(entry("backup.tar.gz")))
        assertEquals(SftpOpenKind.TEXT, SftpOpenPolicy.kindOf(entry("nginx.conf")))
        assertEquals(SftpOpenKind.BINARY, SftpOpenPolicy.kindOf(entry("payload.bin")))
    }

    @Test
    fun oversizedPreviewIsRejectedWithAReadableLimit() {
        assertNull(SftpOpenPolicy.rejectReason(SftpOpenKind.TEXT, 1024))
        val text = SftpOpenPolicy.rejectReason(SftpOpenKind.TEXT, SftpOpenPolicy.TEXT_EDIT_LIMIT + 1)
        assertTrue(text!!.contains("拒绝作为文本打开"))
        val image = SftpOpenPolicy.rejectReason(SftpOpenKind.IMAGE, SftpOpenPolicy.IMAGE_PREVIEW_LIMIT + 1)
        assertTrue(image!!.contains("请下载后查看"))
        assertEquals(null, SftpOpenPolicy.rejectReason(SftpOpenKind.MEDIA, SftpOpenPolicy.MEDIA_PREVIEW_LIMIT))
        assertTrue(SftpOpenPolicy.rejectReason(SftpOpenKind.MEDIA, SftpOpenPolicy.MEDIA_CACHE_LIMIT + 1)!!.contains("请下载后播放"))
    }

    @Test
    fun pastePlansCoverOverwriteSkipAndCompatible() {
        val clip = SftpClipboard(
            mode = SftpClipboardMode.COPY,
            paths = listOf("/src/notes.txt", "/src/only.txt"),
            sourceDirectory = "/src",
            sourceConnectionId = "host-a",
        )
        val existing = setOf("notes.txt")
        val overwrite = SftpClipboardOps.planPaste(clip, "/dst", existing, SftpPasteConflictMode.OVERWRITE)
        assertEquals(listOf("/dst/notes.txt"), overwrite.overwrites)
        assertEquals(2, overwrite.copies.size)
        val skip = SftpClipboardOps.planPaste(clip, "/dst", existing, SftpPasteConflictMode.SKIP)
        assertEquals(listOf("/src/notes.txt"), skip.skipped)
        assertEquals(listOf("/src/only.txt" to "/dst/only.txt"), skip.copies)
        val compatible = SftpClipboardOps.planPaste(clip, "/dst", existing, SftpPasteConflictMode.COMPATIBLE)
        assertTrue(compatible.copies.any { it.second.endsWith("notes-复制.txt") })
        val command = SftpClipboardOps.commandFor(compatible, cut = false)!!
        assertTrue(command.contains("cp -a -- '/src/notes.txt' '/dst/notes-复制.txt'"))
        assertTrue(command.startsWith("mkdir -p '/dst'"))
    }

    @Test
    fun clipboardKnowsWhetherPasteIsSameHost() {
        val clip = SftpClipboard(SftpClipboardMode.COPY, listOf("/a"), "/src", sourceConnectionId = "alpha")
        assertTrue(clip.sameHostAs("alpha"))
        assertTrue(!clip.sameHostAs("beta"))
        assertTrue(SftpClipboard(SftpClipboardMode.COPY, listOf("/a"), "/src").sameHostAs("beta"))
    }

    @Test
    fun cutOverwriteDeletesTheTargetFirst() {
        val clip = SftpClipboard(SftpClipboardMode.CUT, listOf("/src/a"), "/src")
        val plan = SftpClipboardOps.planPaste(clip, "/dst", setOf("a"), SftpPasteConflictMode.OVERWRITE)
        val command = SftpClipboardOps.commandFor(plan, cut = true)!!
        assertTrue(command.contains("rm -rf -- '/dst/a'"))
        assertTrue(command.contains("mv -- '/src/a' '/dst/a'"))
    }
}
