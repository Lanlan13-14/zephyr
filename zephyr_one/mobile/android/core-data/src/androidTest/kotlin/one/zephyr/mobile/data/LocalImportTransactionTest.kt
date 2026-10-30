package one.zephyr.mobile.data

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import java.io.File
import java.util.UUID
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import one.zephyr.mobile.contracts.SyncAction
import one.zephyr.mobile.data.db.*
import one.zephyr.mobile.model.SecretRef
import one.zephyr.mobile.model.SecretState
import one.zephyr.mobile.security.FileSecretBlobStore
import one.zephyr.mobile.security.SecretStore
import org.junit.Assert.*
import org.junit.Test

/** Actual Room transactions and Android Keystore, executed on the CI emulator, not JVM fakes. */
class LocalImportTransactionTest {
    private val context: Context = ApplicationProvider.getApplicationContext()

    private suspend fun fixture(block: suspend (ZephyrDatabase, SecretStore, LocalWriteGateway) -> Unit) {
        val run = UUID.randomUUID().toString()
        val directory = File(context.noBackupFilesDir, "import-test-$run")
        val db = Room.inMemoryDatabaseBuilder(context, ZephyrDatabase::class.java).build()
        val store = SecretStore(FileSecretBlobStore(directory), SecretStore.SecretScope("s-$run", "alice", "device", "g"))
        val journal = SecretMutationJournal(db, store, "s-$run", "alice", "device", "g")
        try {
            journal.recover()
            block(db, store, LocalWriteGateway(db, store, journal))
        } finally {
            store.wipe()
            db.close()
            directory.deleteRecursively()
        }
    }

    private fun edit(id: String, secret: SecretState? = null) = LocalEdit(
        "connection", id, SyncAction.UPSERT, listOf("name", "host"),
        values = buildJsonObject { put("name", "Copy"); put("host", "example.invalid") },
        secrets = secret?.let { mapOf("password" to it) } ?: emptyMap(), createdLocally = true,
    )

    @Test fun receiptMirrorAndQueueCommitTogetherAndCollisionCannotOverwrite() = runBlocking {
        fixture { db, _, gateway ->
            val receipt = DevicePreferenceRow("copy-receipt", "copied", 1L)
            gateway.apply(edit("new-id"), "alice", receipt, requireAbsent = true)
            assertEquals("copied", db.devicePreferenceDao().find(receipt.key)?.valueJson)
            assertEquals("alice", db.mirrorDao().find("connection", "new-id")?.ownerUserId)
            assertEquals(1, db.pendingOperationDao().count())
            val existing = db.mirrorDao().find("connection", "new-id")
            try {
                gateway.apply(edit("new-id"), "alice", DevicePreferenceRow("second", "bad", 2L), requireAbsent = true)
                fail("collision must reject")
            } catch (_: LocalWriteRejected) { }
            assertEquals(existing, db.mirrorDao().find("connection", "new-id"))
            assertEquals(1, db.pendingOperationDao().count())
            assertNull(db.devicePreferenceDao().find("second"))
        }
    }

    @Test fun transactionFailureRollsBackMirrorQueueReceiptAndRewrappedSecret() = runBlocking {
        fixture { db, store, gateway ->
            // Fail at the final receipt write, after the business writes and secret stage occurred.
            db.openHelper.writableDatabase.execSQL("CREATE TRIGGER fail_import BEFORE INSERT ON device_preferences BEGIN SELECT RAISE(ABORT, 'injected'); END")
            val secret = SecretState.Replace("rollback-secret")
            try {
                gateway.apply(edit("fail-id", secret), "alice", DevicePreferenceRow("receipt", "copied", 1L), requireAbsent = true)
                fail("receipt failure must reject")
            } catch (_: Exception) { } finally { secret.wipe() }
            assertNull(db.mirrorDao().find("connection", "fail-id"))
            assertEquals(0, db.pendingOperationDao().count())
            assertNull(db.devicePreferenceDao().find("receipt"))
            assertFalse(store.has(SecretRef.of("connection", "fail-id", "password")))
        }
    }

    @Test fun commitGuardRejectsChangedBindingBeforeAnythingIsCommitted() = runBlocking {
        fixture { db, store, gateway ->
            val secret = SecretState.Replace("guard-secret")
            try {
                gateway.apply(edit("fenced", secret), "alice", DevicePreferenceRow("receipt", "copied", 1L),
                    requireAbsent = true, commitGuard = { error("binding stopped") })
                fail("stale binding must reject")
            } catch (_: IllegalStateException) { } finally { secret.wipe() }
            assertNull(db.mirrorDao().find("connection", "fenced"))
            assertEquals(0, db.pendingOperationDao().count())
            assertNull(db.devicePreferenceDao().find("receipt"))
            assertFalse(store.has(SecretRef.of("connection", "fenced", "password")))
        }
    }

    @Test fun sourceSecretIsReencryptedForNewAccountAndNewIdentityWithoutChangingSource() = runBlocking {
        fixture { db, targetStore, gateway ->
            val root = File(context.noBackupFilesDir, "import-source-${UUID.randomUUID()}")
            val source = SecretStore(FileSecretBlobStore(root), SecretStore.SecretScope("local", "local", "device", "old-g"))
            val old = SecretRef.of("connection", "local-id", "password")
            val new = SecretRef.of("connection", "target-id", "password")
            try {
                source.putText(old, "密码-42")
                val bytes = checkNotNull(source.get(old))
                val replacement = try { SecretState.Replace.fromUtf8(bytes) } finally { bytes.fill(0) }
                try { gateway.apply(edit("target-id", replacement), "alice", DevicePreferenceRow("receipt", "copied", 1L), requireAbsent = true) }
                finally { replacement.wipe() }
                targetStore.evictPlaintextCache()
                assertEquals("密码-42", targetStore.getText(new))
                assertEquals("密码-42", source.getText(old))
                assertNull(targetStore.get(old))
                assertFalse(db.mirrorDao().find("connection", "target-id")!!.payloadJson.contains("密码"))
                assertFalse(db.pendingOperationDao().all().single().payloadJson.contains("密码"))
            } finally { source.wipe(); root.deleteRecursively() }
        }
    }
}
