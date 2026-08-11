package one.zephyr.mobile.data.db

import android.content.Context
import java.io.Closeable
import java.io.File

/** Open account database whose ownership is represented only by an opaque namespace. */
class AccountDatabaseHandle internal constructor(
    val namespace: String,
    val database: ZephyrDatabase,
    internal val databaseFile: File,
)

/**
 * Owns encrypted Room handles and their cryptographic erasure lifecycle.
 *
 * A scope which has been erased is permanently tombstoned. Rebinding the same account must use a
 * new generation, which creates both a new opaque namespace and a new SQLCipher key.
 */
class AccountDatabaseManager internal constructor(
    private val context: Context,
    candidateRoot: File,
    private val namespaceDeriver: AccountNamespaceDeriver,
    keyCipher: AccountDatabaseKeyCipher,
    private val modeApplier: FileModeApplier,
) : Closeable {

    constructor(context: Context) : this(
        context = context.applicationContext,
        candidateRoot = File(context.noBackupFilesDir, ROOT_DIRECTORY),
        namespaceDeriver = HmacAccountNamespaceDeriver(AndroidKeystoreAccountNamespaceKey::getOrCreate),
        keyCipher = KeystoreAccountDatabaseKeyCipher,
        modeApplier = AndroidFileModeApplier,
    )

    private val root = verifiedNoBackupRoot(context, candidateRoot).also {
        ensurePrivateDirectory(it, modeApplier)
    }
    private val keyStore = AccountDatabaseKeyStore(
        directory = File(root, KEY_DIRECTORY),
        namespaceDeriver = namespaceDeriver,
        cipher = keyCipher,
        modeApplier = modeApplier,
    )
    private val erasureSweeper = AccountDatabaseErasureSweeper(root, keyStore, modeApplier)
    private val openHandles = mutableMapOf<String, AccountDatabaseHandle>()

    init {
        erasureSweeper.sweep()
    }

    @Synchronized
    fun open(scope: AccountDatabaseScope): AccountDatabaseHandle {
        val namespace = namespaceDeriver.derive(scope)
        openHandles[namespace.value]?.let { return it }
        val files = AccountDatabaseFiles(root, namespace, modeApplier)
        if (files.isErased()) {
            completeErasure(namespace, files)
            error("account database generation has been erased")
        }

        val passphrase = keyStore.loadOrCreate(scope)
        try {
            files.hardenDatabaseFiles()
            val database = DatabaseFactory.createEncrypted(context, files.database, passphrase)
            try {
                // Room opens lazily. Eager validation makes a wrong account key fail at the scope
                // boundary instead of during an unrelated repository operation.
                database.openHelper.writableDatabase
                files.hardenDatabaseFiles()
            } catch (failure: Throwable) {
                database.close()
                throw failure
            }
            return AccountDatabaseHandle(namespace.value, database, files.database).also {
                openHandles[namespace.value] = it
            }
        } finally {
            passphrase.fill(0)
        }
    }

    @Synchronized
    fun close(scope: AccountDatabaseScope) {
        val namespace = namespaceDeriver.derive(scope)
        openHandles.remove(namespace.value)?.database?.close()
    }

    /** Used by logout, account switch and device revoke after account jobs have stopped. */
    @Synchronized
    fun erase(scope: AccountDatabaseScope) {
        val namespace = namespaceDeriver.derive(scope)
        val files = AccountDatabaseFiles(root, namespace, modeApplier)
        // The durable marker comes first. A process death from this point onward can only resume
        // erasure; it can never reopen the old generation.
        files.markErased()
        var failure: Throwable? = null
        runCatching { openHandles.remove(namespace.value)?.database?.close() }
            .onFailure { failure = it }
        runCatching { completeErasure(namespace, files) }
            .onFailure { if (failure == null) failure = it }
        failure?.let { throw it }
    }

    /** App startup calls this before binding recovery; tombstones make repeated sweeps idempotent. */
    @Synchronized
    fun sweepErasedGenerations() {
        erasureSweeper.sweep()
    }

    @Synchronized
    override fun close() {
        openHandles.values.forEach { it.database.close() }
        openHandles.clear()
    }

    private fun completeErasure(namespace: AccountDatabaseNamespace, files: AccountDatabaseFiles) {
        var failure: Throwable? = null
        runCatching { keyStore.delete(namespace) }.onFailure { failure = it }
        runCatching { files.eraseDatabaseFiles() }.onFailure { if (failure == null) failure = it }
        failure?.let { throw it }
    }

    internal companion object {
        const val ROOT_DIRECTORY = "account-databases"
        const val KEY_DIRECTORY = "keys"

        private fun verifiedNoBackupRoot(context: Context, root: File): File {
            val noBackup = context.noBackupFilesDir.canonicalFile
            val candidate = root.canonicalFile
            val prefix = noBackup.path + File.separator
            require(candidate == noBackup || candidate.path.startsWith(prefix)) {
                "account databases must live under noBackupFilesDir"
            }
            return candidate
        }
    }
}
