package one.zephyr.mobile.app.di

import android.content.Context
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.Dispatchers
import one.zephyr.mobile.app.security.BiometricDeviceAuthenticator
import one.zephyr.mobile.data.db.DatabaseFactory
import one.zephyr.mobile.data.db.ZephyrDatabase
import one.zephyr.mobile.data.repository.BindingRepository
import one.zephyr.mobile.network.NetworkMonitor
import one.zephyr.mobile.security.AppLock
import one.zephyr.mobile.security.FileSecretBlobStore
import one.zephyr.mobile.security.SecretBlobStore

/**
 * Objects that live as long as the process and do not depend on which account is bound.
 *
 * Split from [AccountContainer] because most of the graph cannot be built at startup: the secret
 * store, the sync store and the sealer all need a server id, a user id and a device id, and those
 * only exist after S02 binding completes. Constructing them eagerly would mean inventing
 * placeholders, and a placeholder scope in a keystore-backed secret store is how one account ends up
 * reading another's blobs.
 */
class AppContainer(private val context: Context) {

    /** Survives configuration changes; cancelled only with the process. */
    val applicationScope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    val databaseDirectory: File by lazy { File(context.filesDir, "db").apply { mkdirs() } }

    val secretsDirectory: File by lazy { File(context.filesDir, "secrets").apply { mkdirs() } }

    val database: ZephyrDatabase by lazy { DatabaseFactory.create(context, databaseDirectory) }

    val secretBlobs: SecretBlobStore by lazy { FileSecretBlobStore(secretsDirectory) }

    val networkMonitor: NetworkMonitor by lazy { NetworkMonitor(context) }

    /**
     * The authenticator is created without an Activity and resolves one per prompt.
     *
     * BiometricPrompt needs a FragmentActivity, but the lock is process-scoped: holding the Activity
     * here would leak it across a rotation. The activity is supplied at prompt time instead.
     */
    val deviceAuthenticator: BiometricDeviceAuthenticator by lazy {
        BiometricDeviceAuthenticator(context)
    }

    val appLock: AppLock by lazy { AppLock(deviceAuthenticator) }

    /** Server profiles and the active binding are readable before any account scope exists. */
    val bindings: BindingRepository by lazy { BindingRepository(database, accountFreeSecretStore()) }

    /**
     * Binding rows carry a stored credential, so [BindingRepository] needs a secret store before an
     * account scope exists. This one is scoped to the device alone: it can hold the binding secret
     * and nothing account-shaped, which is exactly the material S02 needs before it knows the user.
     */
    private fun accountFreeSecretStore(): one.zephyr.mobile.security.SecretStore =
        one.zephyr.mobile.security.SecretStore(
            blobs = secretBlobs,
            scope = one.zephyr.mobile.security.SecretScope(
                serverId = SCOPE_PREBIND,
                userId = SCOPE_PREBIND,
                deviceId = deviceInstallId,
            ),
        )

    /**
     * A random per-install id, persisted in plain preferences.
     *
     * Not the bound device id, which the server issues: this exists so the pre-binding secret scope
     * and the keystore aliases are stable across launches. It is not a secret and not an identifier
     * the server ever sees, so a plain file is the right home for it.
     */
    val deviceInstallId: String by lazy {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        prefs.getString(KEY_INSTALL_ID, null) ?: java.util.UUID.randomUUID().toString().also {
            prefs.edit().putString(KEY_INSTALL_ID, it).apply()
        }
    }

    /** Set once S02 binding completes. Null means no account is bound yet. */
    @Volatile
    var account: AccountContainer? = null
        private set

    fun bindAccount(container: AccountContainer) {
        account = container
    }

    /**
     * Drops the account graph.
     *
     * Registered lock sinks are cleared first: an unbind has to leave no decrypted material behind,
     * and clearing after dropping the reference would leave the arena unreachable but still warm.
     */
    fun unbindAccount() {
        appLock.clearSensitiveMaterial()
        account = null
    }

    private companion object {
        const val PREFS = "zephyr-one-device"
        const val KEY_INSTALL_ID = "install-id"

        /** Reserved scope segment: never a real server or user id, which are opaque server strings. */
        const val SCOPE_PREBIND = "_prebind"
    }
}
