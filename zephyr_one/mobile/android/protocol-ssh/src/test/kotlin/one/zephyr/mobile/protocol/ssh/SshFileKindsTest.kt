package one.zephyr.mobile.protocol.ssh

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SshFileKindsTest {

    @Test
    fun desktopExtensionTablesClassifyPreviewTargets() {
        assertTrue(SshFileKinds.isImage("/var/www/logo.PNG"))
        assertTrue(SshFileKinds.isImage("photo.heic"))
        assertTrue(SshFileKinds.isVideo("clip.mkv"))
        assertTrue(SshFileKinds.isAudio("track.flac"))
        assertTrue(SshFileKinds.isMedia("movie.mp4"))
        assertTrue(SshFileKinds.isArchive("backup.tar.gz"))
        assertTrue(SshFileKinds.isArchive("app.apk"))
        assertTrue(SshFileKinds.isText("nginx.conf"))
        assertTrue(SshFileKinds.isText("README"))
        assertFalse(SshFileKinds.isText("payload.bin"))
        assertEquals(".tar.gz", SshFileKinds.archiveExtensionOf("db.dump.tar.gz"))
    }

    @Test
    fun octalModeRoundTripsAndRejectsGarbage() {
        assertEquals(0b110_100_100, SshFileKinds.decodeOctalMode("644"))
        assertEquals(0b111_101_101, SshFileKinds.decodeOctalMode("0755"))
        assertEquals("644", SshFileKinds.formatOctalMode(420))
        try {
            SshFileKinds.decodeOctalMode("999")
            throw AssertionError("invalid mode accepted")
        } catch (_: IllegalArgumentException) {
        }
    }

    @Test
    fun copyNamesAppendChineseCopySuffixWithoutClobberingArchives() {
        val existing = setOf("notes.txt", "notes-复制.txt")
        assertEquals("notes-复制2.txt", SshFileKinds.uniqueCopyName(existing, "notes.txt"))
        assertEquals(
            "backup-复制.tar.gz",
            SshFileKinds.uniqueCopyName(setOf("backup.tar.gz"), "backup.tar.gz"),
        )
    }

    @Test
    fun compressExtractCopyAndDeleteCommandsMatchDesktopShell() {
        assertEquals(
            "tar -czf '/tmp/a.tar.gz' '/var/log' '/etc/nginx'",
            SshFileKinds.compressCommand(listOf("/var/log", "/etc/nginx"), "/tmp/a.tar.gz"),
        )
        assertEquals(
            "zip -r -- '/tmp/a.zip' '/var/log'",
            SshFileKinds.compressCommand(listOf("/var/log"), "/tmp/a.zip"),
        )
        assertTrue(SshFileKinds.extractCommand("/tmp/a.zip", "/tmp/out").contains("unzip -o"))
        assertTrue(SshFileKinds.extractCommand("/tmp/a.tar.gz", "/tmp/out").contains("tar -xzf"))
        assertEquals(
            "mkdir -p '/home/me' && cp -a -- '/src/a' '/home/me'",
            SshFileKinds.copyCommand(listOf("/src/a"), "/home/me", cut = false),
        )
        assertEquals(
            "mkdir -p '/home/me' && mv -- '/src/a' '/home/me'",
            SshFileKinds.copyCommand(listOf("/src/a"), "/home/me", cut = true),
        )
        assertEquals("rm -rf -- '/tmp/old'", SshFileKinds.recursiveDeleteCommand("/tmp/old"))
        try {
            SshFileKinds.recursiveDeleteCommand("/")
            throw AssertionError("root delete accepted")
        } catch (_: IllegalArgumentException) {
        }
    }

    @Test
    fun treePropertiesParseJsonAndSurfaceRemoteErrors() {
        val parsed = SshFileKinds.parseTreeProperties(
            """{"path":"/var/log","size":4096,"fileCount":12,"dirCount":3,"mtime":1700000000}""",
        )
        assertEquals("/var/log", parsed.path)
        assertEquals(4096L, parsed.sizeBytes)
        assertEquals(12, parsed.fileCount)
        try {
            SshFileKinds.parseTreeProperties("""{"error":"Permission denied"}""")
            throw AssertionError("error object accepted")
        } catch (error: IllegalStateException) {
            assertEquals("Permission denied", error.message)
        }
    }
}
