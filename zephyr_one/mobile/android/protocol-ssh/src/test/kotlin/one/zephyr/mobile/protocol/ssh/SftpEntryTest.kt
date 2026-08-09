package one.zephyr.mobile.protocol.ssh

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SftpEntryTest {

    private fun entry(
        name: String = "notes.txt",
        isDirectory: Boolean = false,
        isSymlink: Boolean = false,
        permissions: Int = 420,
    ) = SftpEntry(
        name = name,
        path = "/home/ops/" + name,
        isDirectory = isDirectory,
        isSymlink = isSymlink,
        size = 1024,
        modifiedAt = 1_700_000_000_000,
        permissions = permissions,
    )

    @Test
    fun `a directory renders like ls -l`() {
        // 0o755
        assertEquals("drwxr-xr-x", entry(isDirectory = true, permissions = 493).modeString())
    }

    @Test
    fun `a regular file renders with a leading dash`() {
        // 0o644
        assertEquals("-rw-r--r--", entry(permissions = 420).modeString())
    }

    @Test
    fun `a symlink wins over the directory flag`() {
        // A symlink to a directory has both flags set, and ls shows the link.
        assertEquals(
            "lrwxrwxrwx",
            entry(isDirectory = true, isSymlink = true, permissions = 511).modeString(),
        )
    }

    @Test
    fun `no permissions renders as all dashes`() {
        assertEquals("----------", entry(permissions = 0).modeString())
    }

    @Test
    fun `owner only permissions render in the first triple`() {
        // 0o600
        assertEquals("-rw-------", entry(permissions = 384).modeString())
    }

    @Test
    fun `execute only renders in the third column of a triple`() {
        // 0o111
        assertEquals("---x--x--x", entry(permissions = 73).modeString())
    }

    @Test
    fun `setuid and sticky bits are preserved in the raw mode even though the string omits them`() {
        // 0o4755. The rendered string matches ls's nine-column form; the extra bits stay in
        // permissions so a user diagnosing a permission problem has not lost them.
        val setuid = entry(isDirectory = true, permissions = 2541)
        assertEquals("drwxr-xr-x", setuid.modeString())
        assertEquals(2541, setuid.permissions)
    }

    @Test
    fun `a dot prefix marks an entry hidden`() {
        assertTrue(entry(name = ".bashrc").isHidden)
        assertTrue(entry(name = ".ssh", isDirectory = true).isHidden)
        assertFalse(entry(name = "bashrc").isHidden)
        assertFalse(entry(name = "").isHidden)
    }

    @Test
    fun `every conflict policy stays an explicit choice`() {
        // Overwrite is not a default: silently replacing a newer remote file cannot be undone from
        // a phone, which is why the policy is enumerated rather than assumed.
        assertEquals(4, SftpConflictPolicy.entries.size)
        assertTrue(SftpConflictPolicy.FAIL in SftpConflictPolicy.entries)
        assertTrue(SftpConflictPolicy.RESUME in SftpConflictPolicy.entries)
    }

    @Test
    fun `progress fraction is clamped and safe on an unknown total`() {
        assertEquals(0f, SftpTransferProgress("/a", 0, 0).fraction, 0f)
        assertEquals(0.5f, SftpTransferProgress("/a", 50, 100).fraction, 0.0001f)
        assertEquals(1f, SftpTransferProgress("/a", 100, 100).fraction, 0f)
        // A server that under-reports the size must not produce a progress bar past the end.
        assertEquals(1f, SftpTransferProgress("/a", 150, 100).fraction, 0f)
        assertEquals(0f, SftpTransferProgress("/a", 0, -1).fraction, 0f)
    }

    @Test
    fun `a resumed transfer remembers where it restarted`() {
        val progress = SftpTransferProgress("/a", bytesDone = 600, bytesTotal = 1000, resumedFrom = 500)

        assertEquals(500, progress.resumedFrom)
        assertEquals(0.6f, progress.fraction, 0.0001f)
    }
}
