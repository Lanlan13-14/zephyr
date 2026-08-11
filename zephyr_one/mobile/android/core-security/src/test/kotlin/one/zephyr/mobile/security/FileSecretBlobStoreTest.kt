package one.zephyr.mobile.security

import java.io.File
import java.io.IOException
import java.nio.file.Files
import one.zephyr.mobile.model.Base64Codec
import one.zephyr.mobile.model.SecretRef
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class FileSecretBlobStoreTest {

    @Test
    fun `delete false fails closed and the old blob stays unreadable after restart`() = withRoot { root ->
        val ref = SecretRef.of("clientToken", "old/token", "token")
        val blob = byteArrayOf(1, 2, 3)
        blobFile(root, ref).writeBytes(blob)
        val store = FileSecretBlobStore(root, deleteFile = { false })
        assertArrayEquals(blob, store.read(ref))

        assertThrows(IOException::class.java) { store.delete(ref) }

        assertNull(store.read(ref))
        assertFalse(store.listRefs().contains(ref))
        assertNull(FileSecretBlobStore(root).read(ref))
    }

    @Test
    fun `delete exception fails closed without hiding a different scoped ref`() = withRoot { root ->
        val oldGeneration = SecretRef("__secretScope/owner-generation-1/clientToken/old/token")
        val currentGeneration = SecretRef("__secretScope/owner-generation-2/clientToken/old/token")
        blobFile(root, oldGeneration).writeBytes(byteArrayOf(4))
        blobFile(root, currentGeneration).writeBytes(byteArrayOf(5))
        val store = FileSecretBlobStore(root, deleteFile = { throw IOException("disk failure") })

        assertThrows(IOException::class.java) { store.delete(oldGeneration) }

        assertNull(store.read(oldGeneration))
        assertArrayEquals(byteArrayOf(5), store.read(currentGeneration))
        assertNull(FileSecretBlobStore(root).read(oldGeneration))
    }

    private fun blobFile(root: File, ref: SecretRef): File =
        File(
            root,
            Base64Codec.encodeUrlNoPad(ref.value.toByteArray(Charsets.UTF_8)) + ".bin",
        )

    private fun withRoot(block: (File) -> Unit) {
        val root = Files.createTempDirectory("zephyr-secret-blob-test").toFile()
        try {
            block(root)
        } finally {
            root.deleteRecursively()
        }
    }
}
