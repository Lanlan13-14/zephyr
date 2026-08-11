package one.zephyr.mobile.data.db

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import java.util.UUID
import java.io.File
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class AccountDatabaseManagerTest {

    private val context: Context = ApplicationProvider.getApplicationContext()

    @Test
    fun encryptedDatabaseRecoversWalAndKeepsAccountsAndGenerationsIsolated() = runBlocking {
        val run = UUID.randomUUID().toString()
        val alice = AccountDatabaseScope("server-$run", "alice", "1:100")
        val bob = AccountDatabaseScope("server-$run", "bob", "1:100")
        val reboundAlice = AccountDatabaseScope("server-$run", "alice", "1:101")
        val firstManager = AccountDatabaseManager(context)
        val aliceHandle = firstManager.open(alice)
        aliceHandle.database.devicePreferenceDao().upsert(
            DevicePreferenceRow("marker", "alice", 1L),
        )
        val journalMode = aliceHandle.database.openHelper.writableDatabase
            .query("PRAGMA journal_mode")
            .use { cursor ->
                check(cursor.moveToFirst())
                cursor.getString(0)
            }
        assertEquals("wal", journalMode.lowercase())
        assertFalse(
            aliceHandle.databaseFile.readBytes().copyOfRange(0, 16)
                .contentEquals("SQLite format 3\u0000".toByteArray(Charsets.US_ASCII)),
        )
        val aliceNamespace = aliceHandle.namespace
        firstManager.close()

        // A new manager models process recovery while a WAL may be present. The sealed key is
        // reopened through Keystore rather than reconstructed from preferences.
        val recoveredManager = AccountDatabaseManager(context)
        val recoveredAlice = recoveredManager.open(alice)
        assertEquals("alice", recoveredAlice.database.devicePreferenceDao().find("marker")?.valueJson)
        assertEquals(aliceNamespace, recoveredAlice.namespace)
        recoveredManager.close(alice)

        val bobHandle = recoveredManager.open(bob)
        assertNull(bobHandle.database.devicePreferenceDao().find("marker"))
        recoveredManager.close(bob)
        val reboundHandle = recoveredManager.open(reboundAlice)
        assertNull(reboundHandle.database.devicePreferenceDao().find("marker"))
        assertTrue(reboundHandle.namespace != aliceNamespace)
        recoveredManager.close(reboundAlice)

        recoveredManager.erase(alice)
        recoveredManager.erase(bob)
        recoveredManager.erase(reboundAlice)
        assertThrows(IllegalStateException::class.java) { recoveredManager.open(alice) }
        recoveredManager.close()
    }

    @Test
    fun databaseCopiedAcrossAccountsCannotBeOpenedWithTheOtherWrappedKey() {
        val run = UUID.randomUUID().toString()
        val first = AccountDatabaseScope("server-$run", "first", "2:200")
        val second = AccountDatabaseScope("server-$run", "second", "2:200")
        val manager = AccountDatabaseManager(context)
        val firstFile = manager.open(first).databaseFile
        manager.close(first)
        val secondFile = manager.open(second).databaseFile
        manager.close(second)
        val firstBytes = firstFile.readBytes()
        firstFile.copyTo(secondFile, overwrite = true)

        assertThrows(Exception::class.java) { manager.open(second) }
        assertArrayEquals(firstBytes, secondFile.readBytes())

        manager.erase(first)
        manager.erase(second)
        manager.close()
    }

    @Test
    fun startupSweepCompletesCrashInterruptedErasureWithoutBindingIdentity() = runBlocking {
        val scope = AccountDatabaseScope(
            "server-${UUID.randomUUID()}",
            "removed-user",
            "removed-generation",
        )
        val firstManager = AccountDatabaseManager(context)
        val handle = firstManager.open(scope)
        handle.database.devicePreferenceDao().upsert(DevicePreferenceRow("pending", "value", 1L))
        val namespace = AccountDatabaseNamespace(handle.namespace)
        val root = File(context.noBackupFilesDir, AccountDatabaseManager.ROOT_DIRECTORY)
        val files = AccountDatabaseFiles(root, namespace, AndroidFileModeApplier)
        files.markErased()
        firstManager.close()
        File(root, files.database.name + "-wal").writeBytes(byteArrayOf(1, 2, 3))
        File(root, files.database.name + "-shm").writeBytes(byteArrayOf(4, 5, 6))
        val envelope = File(
            File(root, AccountDatabaseManager.KEY_DIRECTORY),
            "account-${namespace.value}.key",
        )
        assertTrue(envelope.exists())

        // A new manager models app startup after the binding row and raw identity are gone.
        val restarted = AccountDatabaseManager(context)

        assertTrue(files.isErased())
        assertTrue(files.databaseArtifacts().isEmpty())
        assertFalse(envelope.exists())
        assertThrows(IllegalStateException::class.java) { restarted.open(scope) }
        restarted.close()
    }
}
