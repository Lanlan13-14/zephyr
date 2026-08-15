package one.zephyr.mobile.app.di

import android.content.Context
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import one.zephyr.mobile.BuildConfig
import one.zephyr.mobile.app.AboutActionLauncher
import one.zephyr.mobile.app.LauncherIconController
import one.zephyr.mobile.contracts.BindingState
import one.zephyr.mobile.model.AccountBinding
import one.zephyr.mobile.model.NetworkPolicy
import one.zephyr.mobile.model.TlsPolicy
import one.zephyr.mobile.app.binding.BindingCoordinator
import one.zephyr.mobile.app.binding.BindingGatewayFactory
import one.zephyr.mobile.app.binding.BindingGraphFactory
import one.zephyr.mobile.app.binding.BindingGraphHost
import one.zephyr.mobile.app.binding.ManagedBindingGraph
import one.zephyr.mobile.app.binding.MobileBindingGateway
import one.zephyr.mobile.app.binding.PendingDeviceIdentity
import one.zephyr.mobile.app.binding.PendingDeviceIdentityFactory
import one.zephyr.mobile.app.binding.RoomBindingStorage
import one.zephyr.mobile.app.binding.BindingScopeStateWiper
import one.zephyr.mobile.app.binding.BindingPreparedStateWiper
import one.zephyr.mobile.app.binding.BindingTeardownScope
import one.zephyr.mobile.app.binding.NoAccountStateWiper
import one.zephyr.mobile.app.binding.SharedPreferencesBindingTeardownJournal
import one.zephyr.mobile.app.binding.SharedPreferencesBindingReplacementJournal
import one.zephyr.mobile.app.binding.SharedPreferencesNoAccountCleanupJournal
import one.zephyr.mobile.protocol.rdp.AndroidRdpEngine
import one.zephyr.mobile.protocol.rdp.RdpEngine
import one.zephyr.mobile.protocol.vnc.SocketVncEngine
import one.zephyr.mobile.protocol.vnc.VncEngine
import one.zephyr.mobile.app.session.WorkspaceStatePersistence
import one.zephyr.mobile.app.security.BiometricDeviceAuthenticator
import one.zephyr.mobile.data.db.DatabaseFactory
import one.zephyr.mobile.data.db.AccountDatabaseManager
import one.zephyr.mobile.data.db.AccountDatabaseScope
import one.zephyr.mobile.data.db.ZephyrDatabase
import one.zephyr.mobile.data.repository.BindingRepository
import one.zephyr.mobile.feature.filesync.ConnectionSharePreferences
import one.zephyr.mobile.feature.filesync.ContentResolverUriPermissions
import one.zephyr.mobile.feature.filesync.PersistentShareStore
import one.zephyr.mobile.feature.filesync.SafShareGrants
import one.zephyr.mobile.feature.filesync.SharedPreferencesKeyValueStore
import one.zephyr.mobile.network.NetworkMonitor
import one.zephyr.mobile.network.ApiEndpoint
import one.zephyr.mobile.network.CredentialScope
import one.zephyr.mobile.network.CredentialStore
import one.zephyr.mobile.security.AppLock
import one.zephyr.mobile.security.DeviceIdentity
import one.zephyr.mobile.security.FileSecretBlobStore
import one.zephyr.mobile.security.SecretBlobStore
import one.zephyr.mobile.sync.WakeBindingIdentity
import one.zephyr.mobile.sync.SyncSettings

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

    val aboutActions: AboutActionLauncher by lazy { AboutActionLauncher(context) }

    /** Keeps the one enabled launcher alias aligned with the selected local colour theme. */
    internal val launcherIcons: LauncherIconController by lazy { LauncherIconController(context) }

    /** Process-scoped protocol engines survive Activity recreation without orphaning sessions. */
    val vncEngine: VncEngine by lazy { SocketVncEngine() }

    /** Reports unavailable until the packaged FreeRDP JNI library can be loaded. */
    val rdpEngine: RdpEngine by lazy { AndroidRdpEngine() }

    /** Process-scoped SSH client. Direct password / key auth only. */
    val sshEngine: one.zephyr.mobile.protocol.ssh.SshEngine by lazy {
        one.zephyr.mobile.protocol.ssh.SshjEngine()
    }

    /** Process lifetime scope used only to tear down a graph after that graph reports revocation. */
    private val teardownScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    private val processForeground = AtomicBoolean(false)

    val databaseDirectory: File by lazy { File(context.filesDir, "db").apply { mkdirs() } }

    val secretsDirectory: File by lazy { File(context.filesDir, "secrets").apply { mkdirs() } }

    val database: ZephyrDatabase by lazy { DatabaseFactory.create(context, databaseDirectory) }

    /** Encrypted mirrors opened only after a server account binding has been verified. */
    internal val accountDatabases: AccountDatabaseManager by lazy { AccountDatabaseManager(context) }

    /** Completes any erase whose durable tombstone was written before the previous process died. */
    fun sweepErasedAccountDatabases() {
        accountDatabases.sweepErasedGenerations()
    }

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

    /** SID used only while turning a server login into a device binding. */
    private val pendingBindingCredentials: CredentialStore by lazy {
        CredentialStore(
            secretStore = accountFreeSecretStore(),
            scope = CredentialScope(
                bindingKey = SCOPE_PREBIND,
                generation = deviceInstallId,
            ),
        )
    }

    private val bindingTeardownJournal by lazy {
        SharedPreferencesBindingTeardownJournal(context)
    }

    private val bindingReplacementJournal by lazy {
        SharedPreferencesBindingReplacementJournal(context)
    }

    private val noAccountCleanupJournal by lazy {
        SharedPreferencesNoAccountCleanupJournal(context)
    }

    /**
     * Binding rows carry a stored credential, so [BindingRepository] needs a secret store before an
     * account scope exists. This one is scoped to the device alone: it can hold the binding secret
     * and nothing account-shaped, which is exactly the material S02 needs before it knows the user.
     */
    private fun accountFreeSecretStore(): one.zephyr.mobile.security.SecretStore =
        one.zephyr.mobile.security.SecretStore(
            blobs = secretBlobs,
            scope = one.zephyr.mobile.security.SecretStore.SecretScope(
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

    /** Set once S02 binding completes or startup recovery validates the persisted binding. */
    @Volatile
    private var accountGraph: ManagedBindingGraph? = null

    private val accountState = MutableStateFlow<AccountContainer?>(null)

    val accounts: StateFlow<AccountContainer?> = accountState.asStateFlow()

    val account: AccountContainer?
        get() = accountGraph as? AccountContainer

    val bindingCoordinator: BindingCoordinator by lazy {
        BindingCoordinator(
            storage = RoomBindingStorage(bindings, database),
            host = object : BindingGraphHost {
                override fun currentGraph(): ManagedBindingGraph? = accountGraph

                override fun attachGraph(graph: ManagedBindingGraph) {
                    check(accountGraph == null) { "old account graph must be stopped before replacement" }
                    accountGraph = graph
                    (graph as? AccountContainer)?.let { account ->
                        accountState.value = account
                        account.onProcessForegroundChanged(processForeground.get())
                    }
                }

                override fun clearGraph(expected: ManagedBindingGraph) {
                    if (accountGraph === expected) {
                        accountGraph = null
                        accountState.value = null
                    }
                }
            },
            graphFactory = BindingGraphFactory { stored ->
                val databaseScope = AccountContainer.databaseScopeOf(stored.binding)
                val databaseHandle = accountDatabases.open(databaseScope)
                try {
                    AccountContainer(
                        context = context,
                        binding = stored.binding,
                        endpoint = ApiEndpoint(stored.profile.baseUrl, stored.profile.tlsPolicy),
                        appContainer = this,
                        databaseScope = databaseScope,
                        database = databaseHandle.database,
                        appVersion = BuildConfig.VERSION_NAME,
                        initialSyncSettings = stored.settings,
                    )
                } catch (failure: Throwable) {
                    accountDatabases.close(databaseScope)
                    throw failure
                }
            },
            identityFactory = PendingDeviceIdentityFactory { serverId, userId, deviceId ->
                val identity = DeviceIdentity(
                    blobs = secretBlobs,
                    scope = DeviceIdentity.Scope(serverId = serverId, userId = userId, deviceId = deviceId),
                )
                object : PendingDeviceIdentity {
                    override fun ensureKeys(): DeviceIdentity.PublicKeys = identity.ensureKeys()
                    override fun wipe() = identity.wipe()
                }
            },
            gatewayFactory = BindingGatewayFactory { profile ->
                MobileBindingGateway.create(
                    profile = profile,
                    credentials = pendingBindingCredentials,
                    appVersion = BuildConfig.VERSION_NAME,
                )
            },
            teardownJournal = bindingTeardownJournal,
            replacementJournal = bindingReplacementJournal,
            scopeStateWiper = BindingScopeStateWiper(::wipeBindingScope),
            preparedStateWiper = BindingPreparedStateWiper(::discardPreparedBindingScope),
            noAccountCleanupJournal = noAccountCleanupJournal,
            noAccountStateWiper = NoAccountStateWiper(::wipeNoAccountState),
        ).also(appLock::register)
    }

    /**
     * Builds the device-local workspace that keeps the app fully usable without a server binding.
     *
     * Sync is optional on mobile (PRODUCT_REQUIREMENTS.md): an unbound install must still open the
     * dashboard and edit connections/notes/settings locally instead of showing a dead notice. The
     * workspace is scoped to reserved LOCAL_* ids that no server ever issues, so its keystore and
     * database scope can never collide with a real account's, and it is replaced when a real binding
     * is attached (the coordinator's attachGraph requires accountGraph == null, which the caller
     * ensures before starting a bind).
     *
     * @return the active graph when one already exists (server or local), otherwise a fresh local
     *   workspace that becomes the active graph.
     */
    @Synchronized
    fun ensureLocalWorkspace(): AccountContainer {
        (accountGraph as? AccountContainer)?.let { return it }

        val binding = localBinding()
        val databaseScope = AccountContainer.databaseScopeOf(binding)
        val databaseHandle = accountDatabases.open(databaseScope)
        val container = try {
            AccountContainer(
                context = context,
                binding = binding,
                endpoint = LOCAL_ENDPOINT,
                appContainer = this,
                databaseScope = databaseScope,
                database = databaseHandle.database,
                appVersion = BuildConfig.VERSION_NAME,
                initialSyncSettings = LOCAL_SYNC_SETTINGS,
                localMode = true,
            )
        } catch (failure: Throwable) {
            accountDatabases.close(databaseScope)
            throw failure
        }
        accountGraph = container
        accountState.value = container
        container.onProcessForegroundChanged(processForeground.get())
        return container
    }

    /** True when the active graph is the device-reserved local workspace. */
    val isLocalMode: Boolean
        get() = (accountGraph as? AccountContainer)?.isLocalMode == true

    private fun localBinding(): AccountBinding = AccountBinding(
        serverProfileId = LOCAL_SERVER_ID,
        userId = LOCAL_USER_ID,
        username = "local",
        deviceId = deviceInstallId,
        deviceName = "This device",
        tokenId = LOCAL_TOKEN_ID,
        tokenName = "local",
        state = BindingState.IDLE,
        registryHash = "",
        boundAt = 0L,
        lastSyncAt = null,
        instanceEpoch = 0L,
    )

    /**
     * Idempotently erases a persisted account scope without opening its SQLCipher database.
     *
     * This is shared by the live graph and startup journal replay so the two paths cannot drift.
     * The generation-specific database and credential scope are selected from the journal rather
     * than reconstructed from the binding row, which may already have been deleted by a prior run.
     */
    internal fun wipeBindingScope(scope: BindingTeardownScope) {
        var failure: Throwable? = null
        fun attempt(block: () -> Unit) {
            runCatching(block).onFailure { if (failure == null) failure = it }
        }

        val secretStore = one.zephyr.mobile.security.SecretStore(
            blobs = secretBlobs,
            scope = one.zephyr.mobile.security.SecretStore.SecretScope(
                serverId = scope.serverProfileId,
                userId = scope.userId,
                deviceId = scope.deviceId,
                generation = scope.generation,
            ),
        )
        val credentials = CredentialStore(
            secretStore = secretStore,
            scope = CredentialScope(bindingKey = scope.bindingKey, generation = scope.generation),
        )
        val identity = DeviceIdentity(
            blobs = secretBlobs,
            scope = DeviceIdentity.Scope(scope.serverProfileId, scope.userId, scope.deviceId),
        )

        attempt(pendingBindingCredentials::clearAll)
        attempt(credentials::clearAll)
        attempt(identity::wipe)
        attempt(secretStore::wipe)
        attempt { WorkspaceStatePersistence(context).clear() }

        val sharePreferences = context.getSharedPreferences(
            PersistentShareStore.PREFERENCES,
            Context.MODE_PRIVATE,
        )
        val permissionStore = ContentResolverUriPermissions(context.contentResolver)
        val fileSyncStore = SharedPreferencesKeyValueStore(sharePreferences)
        val fileSyncOwnerId = PersistentShareStore.ownerId(
            scope.serverProfileId,
            scope.userId,
            scope.deviceId,
            scope.generation,
        )
        val grants = SafShareGrants(
            permissions = permissionStore,
            store = PersistentShareStore(fileSyncStore, ownerId = fileSyncOwnerId),
            reconcileOnInit = false,
        )
        attempt {
            check(grants.revokeAllOwned()) { "persisted file sync permissions could not be revoked" }
            check(
                ConnectionSharePreferences(fileSyncStore, ownerId = fileSyncOwnerId).clearAll(),
            ) { "file sync connection choices could not be erased" }
        }
        attempt {
            accountDatabases.erase(
                AccountDatabaseScope(
                    serverId = scope.serverProfileId,
                    userId = scope.userId,
                    generation = scope.generation,
                ),
            )
        }
        failure?.let { throw it }
    }

    /** Prepared generations own only generation-local files and secrets, never platform grants. */
    internal fun discardPreparedBindingScope(scope: BindingTeardownScope) {
        var failure: Throwable? = null
        fun attempt(block: () -> Unit) {
            runCatching(block).onFailure { if (failure == null) failure = it }
        }

        val secretStore = one.zephyr.mobile.security.SecretStore(
            blobs = secretBlobs,
            scope = one.zephyr.mobile.security.SecretStore.SecretScope(
                serverId = scope.serverProfileId,
                userId = scope.userId,
                deviceId = scope.deviceId,
                generation = scope.generation,
            ),
        )
        val credentials = CredentialStore(
            secretStore = secretStore,
            scope = CredentialScope(bindingKey = scope.bindingKey, generation = scope.generation),
        )
        val identity = DeviceIdentity(
            blobs = secretBlobs,
            scope = DeviceIdentity.Scope(scope.serverProfileId, scope.userId, scope.deviceId),
        )

        attempt(credentials::clearAll)
        attempt(identity::wipe)
        attempt(secretStore::wipe)
        attempt {
            accountDatabases.erase(
                AccountDatabaseScope(
                    serverId = scope.serverProfileId,
                    userId = scope.userId,
                    generation = scope.generation,
                ),
            )
        }
        failure?.let { throw it }
    }

    /** Called only while the coordinator holds its no-binding/no-graph startup fence. */
    internal fun wipeNoAccountState(): Boolean {
        val fileSyncStore = SharedPreferencesKeyValueStore(
            context.getSharedPreferences(PersistentShareStore.PREFERENCES, Context.MODE_PRIVATE),
        )
        val grants = SafShareGrants(
            permissions = ContentResolverUriPermissions(context.contentResolver),
            store = PersistentShareStore(fileSyncStore, ownerId = NO_ACCOUNT_TEARDOWN_OWNER),
            reconcileOnInit = false,
        )
        return grants.revokeAllPersistedForGlobalTeardown()
    }

    /** Process death never resumes a password/TOTP-authenticated binding attempt. */
    fun clearPendingBindingAuthentication() {
        pendingBindingCredentials.clearAll()
    }

    /**
     * Drops the account graph.
     *
     * Registered lock sinks are cleared first: an unbind has to leave no decrypted material behind,
     * and clearing after dropping the reference would leave the arena unreachable but still warm.
     */
    suspend fun unbindAccount() {
        bindingCoordinator.unbind()
        appLock.clearSensitiveMaterial()
    }

    internal fun onDeviceRevoked(bindingKey: String, generation: String) {
        teardownScope.launch {
            bindingCoordinator.onDeviceRevoked(bindingKey, generation)
            appLock.clearSensitiveMaterial()
        }
    }

    /** Wake terminal path: persist the exact generation fence before joining the live stream. */
    internal suspend fun persistWakeDeviceRevocationFence(bindingKey: String, generation: String): Boolean =
        bindingCoordinator.persistDeviceRevocationFence(bindingKey, generation)

    internal fun completeWakeDeviceRevocation() {
        teardownScope.launch {
            bindingCoordinator.completePendingTeardown()
            appLock.clearSensitiveMaterial()
        }
    }

    internal fun currentWakeIdentity(): WakeBindingIdentity? = account?.wakeIdentity

    internal fun isProcessForeground(): Boolean = processForeground.get()

    fun onProcessForeground() {
        processForeground.set(true)
        account?.onProcessForegroundChanged(true)
    }

    fun onProcessBackground() {
        processForeground.set(false)
        account?.onProcessForegroundChanged(false)
    }

    /** Entry point for an optional payload-free push receiver. Cursor values are never trusted. */
    fun onPushWake(bindingKey: String, generation: String) {
        account?.onPushWake(bindingKey, generation)
    }

    private companion object {
        const val PREFS = "zephyr-one-device"
        const val KEY_INSTALL_ID = "install-id"
        const val NO_ACCOUNT_TEARDOWN_OWNER = "no-account-teardown"

        /** Reserved scope segment: never a real server or user id, which are opaque server strings. */
        const val SCOPE_PREBIND = "_prebind"

        /** Local-workspace scope ids. Reserved on purpose: a real server never issues them, so the
         *  local keystore/database scope can never collide with a bound account's. */
        const val LOCAL_SERVER_ID = "_local"
        const val LOCAL_USER_ID = "local"
        const val LOCAL_TOKEN_ID = "local-token"

        /** Dummy endpoint for the local workspace; nothing network-backed is ever started there. */
        val LOCAL_ENDPOINT: ApiEndpoint by lazy {
            ApiEndpoint(baseUrl = "https://local.invalid", tlsPolicy = TlsPolicy.SystemTrust)
        }

        /** Local workspace never syncs, so automatic sync is off by default. */
        val LOCAL_SYNC_SETTINGS: SyncSettings by lazy {
            SyncSettings(
                automaticEnabled = false,
                intervalSec = 300,
                networkPolicy = NetworkPolicy.ANY,
            )
        }
    }
}
