package one.zephyr.mobile.data.db

import java.io.File
import java.nio.ByteBuffer
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class AccountDatabaseSecurityTest {

    @get:Rule
    val temporaryFolder = TemporaryFolder()

    private val modeApplier = FileModeApplier { _, _ -> }
    private val namespaceDeriver = HmacAccountNamespaceDeriver {
        SecretKeySpec(ByteArray(32) { 0x2a }, "HmacSHA256")
    }

    @Test
    fun `multi account and rebind generations have opaque isolated namespaces`() {
        val first = AccountDatabaseScope("https://main.example", "alice", "4:100")
        val otherUser = AccountDatabaseScope("https://main.example", "bob", "4:100")
        val otherServer = AccountDatabaseScope("https://other.example", "alice", "4:100")
        val rebound = AccountDatabaseScope("https://main.example", "alice", "4:101")

        val namespaces = listOf(first, otherUser, otherServer, rebound).map(namespaceDeriver::derive)

        assertEquals(4, namespaces.map { it.value }.toSet().size)
        namespaces.forEach { namespace ->
            assertTrue(namespace.value.matches(Regex("[0-9a-f]{64}")))
            assertFalse(namespace.value.contains("alice"))
            assertFalse(namespace.value.contains("example"))
        }
        assertEquals("AccountDatabaseScope(<redacted>)", first.toString())
    }

    @Test
    fun `length framing prevents ambiguous scope identities`() {
        val left = AccountDatabaseScope("ab", "c", "generation")
        val right = AccountDatabaseScope("a", "bc", "generation")

        assertFalse(left.authenticatedBytes().contentEquals(right.authenticatedBytes()))
        assertNotEquals(namespaceDeriver.derive(left), namespaceDeriver.derive(right))
    }

    @Test
    fun `sealed key survives restart and stale crash temporary is removed`() {
        val root = temporaryFolder.newFolder("keys")
        val store = keyStore(root)
        val scope = AccountDatabaseScope("server", "user", "generation")
        val namespace = namespaceDeriver.derive(scope)
        val first = store.loadOrCreate(scope)
        val envelope = store.envelopeFile(namespace)
        val stale = File(root, envelope.name + ".tmp-crash")
        stale.writeBytes(byteArrayOf(1, 2, 3))

        val afterRestart = keyStore(root).loadOrCreate(scope)

        assertArrayEquals(first, afterRestart)
        assertFalse(stale.exists())
        assertEquals(32, afterRestart.size)
    }

    @Test
    fun `copying a key envelope to another account fails authenticated open`() {
        val root = temporaryFolder.newFolder("keys")
        val store = keyStore(root)
        val first = AccountDatabaseScope("server", "alice", "generation")
        val second = AccountDatabaseScope("server", "bob", "generation")
        store.loadOrCreate(first).fill(0)
        store.envelopeFile(namespaceDeriver.derive(first)).copyTo(
            store.envelopeFile(namespaceDeriver.derive(second)),
        )

        assertThrows(Exception::class.java) { store.loadOrCreate(second) }
    }

    @Test
    fun `corrupt crash envelope fails closed instead of rotating the database key`() {
        val root = temporaryFolder.newFolder("keys")
        val store = keyStore(root)
        val scope = AccountDatabaseScope("server", "user", "generation")
        val envelope = store.envelopeFile(namespaceDeriver.derive(scope))
        envelope.writeBytes(byteArrayOf(1, 2, 3))

        assertThrows(Exception::class.java) { store.loadOrCreate(scope) }
        assertArrayEquals(byteArrayOf(1, 2, 3), envelope.readBytes())
    }

    @Test
    fun `erasure removes database WAL SHM journal and temporary artifacts only for its account`() {
        val root = temporaryFolder.newFolder("databases")
        val firstNamespace = namespaceDeriver.derive(AccountDatabaseScope("server", "alice", "g1"))
        val secondNamespace = namespaceDeriver.derive(AccountDatabaseScope("server", "bob", "g1"))
        val first = AccountDatabaseFiles(root, firstNamespace, modeApplier)
        val second = AccountDatabaseFiles(root, secondNamespace, modeApplier)
        listOf(
            first.database,
            File(root, first.database.name + "-wal"),
            File(root, first.database.name + "-shm"),
            File(root, first.database.name + "-journal"),
            File(root, first.database.name + "-mj crash"),
            File(root, first.database.name + ".tmp-crash"),
            File(root, first.database.name + "-unrelated"),
            second.database,
            File(root, second.database.name + "-wal"),
        ).forEach { it.writeBytes(byteArrayOf(7)) }

        first.markErased()
        first.eraseDatabaseFiles()

        assertTrue(first.isErased())
        assertEquals(
            listOf(first.database.name + "-unrelated"),
            root.listFiles().orEmpty().filter { it.name.startsWith(first.database.name) }.map(File::getName),
        )
        assertTrue(second.database.exists())
        assertTrue(File(root, second.database.name + "-wal").exists())
    }

    @Test
    fun `startup sweep completes tombstoned generations without raw account identity`() {
        val root = temporaryFolder.newFolder("restart-sweep")
        val keyStore = keyStore(File(root, "keys"))
        val erasedScope = AccountDatabaseScope("server-secret", "alice-secret", "generation-secret")
        val liveScope = AccountDatabaseScope("server-secret", "bob-secret", "generation-secret")
        val erasedNamespace = namespaceDeriver.derive(erasedScope)
        val liveNamespace = namespaceDeriver.derive(liveScope)
        keyStore.loadOrCreate(erasedScope).fill(0)
        keyStore.loadOrCreate(liveScope).fill(0)
        val erasedFiles = AccountDatabaseFiles(root, erasedNamespace, modeApplier)
        val liveFiles = AccountDatabaseFiles(root, liveNamespace, modeApplier)
        erasedFiles.database.writeBytes(byteArrayOf(1))
        File(root, erasedFiles.database.name + "-wal").writeBytes(byteArrayOf(2))
        File(root, erasedFiles.database.name + "-shm").writeBytes(byteArrayOf(3))
        liveFiles.database.writeBytes(byteArrayOf(4))
        erasedFiles.markErased()

        AccountDatabaseErasureSweeper(root, keyStore, modeApplier).sweep()

        assertTrue(erasedFiles.isErased())
        assertTrue(erasedFiles.databaseArtifacts().isEmpty())
        assertFalse(keyStore.envelopeFile(erasedNamespace).exists())
        assertTrue(liveFiles.database.exists())
        assertTrue(keyStore.envelopeFile(liveNamespace).exists())
        assertFalse(root.walkTopDown().any { it.name.contains("server-secret") || it.name.contains("alice-secret") })
    }

    @Test
    fun `failed startup sweep retains tombstone and retries remaining key erasure`() {
        val root = temporaryFolder.newFolder("retry-sweep")
        val keyStore = keyStore(File(root, "keys"))
        val namespace = namespaceDeriver.derive(AccountDatabaseScope("server", "user", "generation"))
        val files = AccountDatabaseFiles(root, namespace, modeApplier)
        files.database.writeBytes(byteArrayOf(1))
        files.markErased()
        val envelope = keyStore.envelopeFile(namespace)
        envelope.mkdirs()
        File(envelope, "blocks-delete").writeBytes(byteArrayOf(2))
        val sweeper = AccountDatabaseErasureSweeper(root, keyStore, modeApplier)

        assertThrows(IllegalStateException::class.java) { sweeper.sweep() }
        assertTrue(files.isErased())
        assertFalse(files.database.exists())

        File(envelope, "blocks-delete").delete()
        envelope.delete()
        sweeper.sweep()

        assertTrue(files.isErased())
        assertFalse(envelope.exists())
    }

    @Test
    fun `malformed tombstones cannot select deletion targets`() {
        val root = temporaryFolder.newFolder("invalid-tombstones")
        val erased = File(root, "erased").apply { mkdirs() }
        File(erased, "account-alice.erased").writeText("erased-v1\n")
        File(erased, "account-${"a".repeat(63)}.erased").writeText("erased-v1\n")
        File(root, "account-alice.db").writeBytes(byteArrayOf(1))
        val keyStore = keyStore(File(root, "keys"))

        AccountDatabaseErasureSweeper(root, keyStore, modeApplier).sweep()

        assertTrue(File(root, "account-alice.db").exists())
        assertTrue(AccountDatabaseFiles.erasedNamespaces(root).isEmpty())
    }

    @Test
    fun `database and envelope modes are requested as owner only`() {
        val modes = mutableListOf<Pair<String, Int>>()
        val recorder = FileModeApplier { file, mode -> modes += file.name to mode }
        val root = temporaryFolder.newFolder("private")
        val keyStore = AccountDatabaseKeyStore(
            directory = File(root, "keys"),
            namespaceDeriver = namespaceDeriver,
            cipher = TestKeyCipher,
            modeApplier = recorder,
            random = SecureRandom(byteArrayOf(9)),
        )
        val scope = AccountDatabaseScope("server", "user", "generation")
        keyStore.loadOrCreate(scope).fill(0)
        val files = AccountDatabaseFiles(root, namespaceDeriver.derive(scope), recorder)
        files.database.writeBytes(byteArrayOf(1))
        files.hardenDatabaseFiles()

        assertTrue(modes.any { (name, mode) -> name == "keys" && mode == MODE_DIRECTORY })
        assertTrue(modes.any { (name, mode) -> name.endsWith(".key") && mode == MODE_FILE })
        assertTrue(modes.any { (name, mode) -> name.endsWith(".db") && mode == MODE_FILE })
    }

    private fun keyStore(root: File): AccountDatabaseKeyStore = AccountDatabaseKeyStore(
        directory = root,
        namespaceDeriver = namespaceDeriver,
        cipher = TestKeyCipher,
        modeApplier = modeApplier,
        random = SecureRandom(byteArrayOf(1, 2, 3, 4)),
    )

    private object TestKeyCipher : AccountDatabaseKeyCipher {
        private val key: SecretKey = SecretKeySpec(ByteArray(32) { 0x5c }, "AES")

        override fun seal(plaintext: ByteArray, aad: ByteArray): ByteArray {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key)
            cipher.updateAAD(aad)
            val encrypted = cipher.doFinal(plaintext)
            return ByteBuffer.allocate(4 + cipher.iv.size + encrypted.size)
                .putInt(cipher.iv.size)
                .put(cipher.iv)
                .put(encrypted)
                .array()
        }

        override fun open(ciphertext: ByteArray, aad: ByteArray): ByteArray {
            val buffer = ByteBuffer.wrap(ciphertext)
            val iv = ByteArray(buffer.int).also(buffer::get)
            val encrypted = ByteArray(buffer.remaining()).also(buffer::get)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, iv))
            cipher.updateAAD(aad)
            return cipher.doFinal(encrypted)
        }
    }
}
