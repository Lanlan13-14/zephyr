package one.zephyr.mobile.app.di

import android.content.Context
import android.net.Uri
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import one.zephyr.mobile.app.session.WorkspaceStatePersistence
import one.zephyr.mobile.app.sync.SyncWorker
import one.zephyr.mobile.data.LocalWriteGateway
import one.zephyr.mobile.data.MirrorWriter
import one.zephyr.mobile.data.db.ZephyrDatabase
import one.zephyr.mobile.data.repository.ConflictRepository
import one.zephyr.mobile.data.repository.ConnectionRepository
import one.zephyr.mobile.data.repository.NoteRepository
import one.zephyr.mobile.data.repository.ResourceRepository
import one.zephyr.mobile.data.repository.SettingsRepository
import one.zephyr.mobile.data.repository.SharedResourceStore
import one.zephyr.mobile.data.repository.SyncStateRepository
import one.zephyr.mobile.data.session.SessionRegistry
import one.zephyr.mobile.feature.filesync.ConnectionSharePreferences
import one.zephyr.mobile.feature.filesync.ContentResolverDocumentTree
import one.zephyr.mobile.feature.filesync.ContentResolverUriPermissions
import one.zephyr.mobile.feature.filesync.FileSyncShareCoordinator
import one.zephyr.mobile.feature.filesync.SafShareGrants
import one.zephyr.mobile.feature.filesync.PersistentShareStore
import one.zephyr.mobile.feature.filesync.SharedPreferencesKeyValueStore
import one.zephyr.mobile.model.AccountBinding
import one.zephyr.mobile.network.ApiEndpoint
import one.zephyr.mobile.network.ApiResult
import one.zephyr.mobile.network.CredentialStore
import one.zephyr.mobile.network.MobileApi
import one.zephyr.mobile.network.MobileApiClient
import one.zephyr.mobile.network.NetworkMonitor
import one.zephyr.mobile.network.NetworkState
import one.zephyr.mobile.network.SharedResourceClient
import one.zephyr.mobile.security.DeviceIdentity
import one.zephyr.mobile.security.SecretStore
import one.zephyr.mobile.security.SessionSecretArena
import one.zephyr.mobile.sync.ApiSharedResourceFetcher
import one.zephyr.mobile.sync.BlobTransferPort
import one.zephyr.mobile.sync.DeviceEnvelopeOpener
import one.zephyr.mobile.sync.DeviceSecretSealer
import one.zephyr.mobile.sync.MobileApiTransport
import one.zephyr.mobile.sync.RoomSyncLocalStore
import one.zephyr.mobile.sync.ServerEncryptionKey
import one.zephyr.mobile.sync.SharedResourceCoordinator
import one.zephyr.mobile.sync.SyncActor
import one.zephyr.mobile.sync.SyncEngine
import one.zephyr.mobile.sync.SyncScheduler
import one.zephyr.mobile.sync.SyncSettings

/**
 * Everything that only exists once an account is bound.
 *
 * Split from [AppContainer] because none of it can be built at startup. The secret store, the sync
 * store and the sealer are all scoped to a (serverId, userId, deviceId) triple that only exists
 * after S02 binding completes, and inventing placeholder ids would let one account's keystore
 * aliases collide with another's - which is how one account ends up reading another's blobs.
 *
 * Built eagerly rather than behind `by lazy`. The scope is fixed for the lifetime of the binding, so
 * there is no ordering hazard left to defer, and a half-built graph would surface a missing
 * dependency at first use in some screen instead of at bind time where it can be reported.
 *
 * Dropped wholesale by [AppContainer.unbindAccount] via [dispose]: an unbind must leave no decrypted
 * material reachable, and clearing individual caches would leave the session arena warm.
 */
class AccountContainer(
    private val context: Context,
    /** The account this graph belongs to. Every scope below is derived from it, never invented. */
    val binding: AccountBinding,
    endpoint: ApiEndpoint,
    private val appContainer: AppContainer,
    appVersion: String,
    /**
     * Sync preferences as persisted for this binding.
     *
     * Passed in rather than defaulted here: they live on the binding row, and defaulting them would
     * silently re-enable automatic sync for a user who turned it off.
     */
    initialSyncSettings: SyncSettings,
) {

    /** Identifies this binding's rows in `sync_state` / `bootstrap_progress`. */
    val bindingKey: String = bindingKeyOf(binding)

    /**
     * Scoped to the bound triple, not to the install.
     *
     * [AppContainer] keeps a `_prebind` store for the binding row itself; every account secret goes
     * here instead, so unbinding and then binding a different account cannot read the old blobs.
     */
    val secretStore: SecretStore = SecretStore(
        blobs = appContainer.secretBlobs,
        scope = SecretStore.SecretScope(
            serverId = binding.serverProfileId,
            userId = binding.userId,
            deviceId = binding.deviceId,
        ),
    )

    val database: ZephyrDatabase = appContainer.database

    val credentials: CredentialStore = CredentialStore(secretStore)

    val deviceIdentity: DeviceIdentity = DeviceIdentity(
        blobs = appContainer.secretBlobs,
        scope = DeviceIdentity.Scope(
            serverId = binding.serverProfileId,
            deviceId = binding.deviceId,
        ),
    )

    /**
     * Session-scoped plaintext for shared resources.
     *
     * Shared material must not reach the mirror at all (SHARED_RESOURCE_RESIDENCY.md), so it lives
     * here and dies with the session. Registered as a lock sink in [start] so a device lock wipes it
     * without waiting for the session to end.
     */
    val sessionSecrets: SessionSecretArena = SessionSecretArena()

    // -- network --

    val apiClient: MobileApiClient = MobileApiClient(
        endpoint = endpoint,
        credentials = credentials,
        refresher = { refreshAccess() },
        appVersion = appVersion,
        proofSigner = { method, path, body, nonce ->
            /* Unsigned rather than a fabricated signature when the server sent no nonce: the proof
             * binds one request to this device's signing key, and a proof computed over an invented
             * nonce would be replayable. Returning null makes the interceptor omit the header, which
             * the server can reject explicitly. */
            nonce?.let { serverNonce ->
                deviceIdentity.signRequestProof(
                    method = method,
                    path = path,
                    body = body,
                    timestampSeconds = System.currentTimeMillis() / 1000L,
                    serverNonce = serverNonce,
                )
            }
        },
    )

    val api: MobileApi = MobileApi(apiClient)

    /** Shared-to-me reads go through their own client so no shared payload can reach the mirror. */
    val sharedResourceClient: SharedResourceClient = SharedResourceClient(apiClient)

    val networkMonitor: NetworkMonitor = appContainer.networkMonitor

    val network: Flow<NetworkState> = networkMonitor.states()

    // -- local data --

    val writeGateway: LocalWriteGateway = LocalWriteGateway(database, secretStore)

    val connections: ConnectionRepository = ConnectionRepository(database, writeGateway)

    val resources: ResourceRepository = ResourceRepository(database, writeGateway)

    val notes: NoteRepository = NoteRepository(database, writeGateway)

    val settings: SettingsRepository = SettingsRepository(database, writeGateway)

    val syncState: SyncStateRepository = SyncStateRepository(database)

    val conflicts: ConflictRepository = ConflictRepository(database)

    val mirror: MirrorWriter = MirrorWriter(database, secretStore)

    /** Online-only and memory resident: shared-to-me resources have no mirror by contract. */
    val sharedResources: SharedResourceStore = SharedResourceStore()

    /**
     * The only thing that fills [sharedResources].
     *
     * Without it the store was permanently empty: nothing in the tree called
     * SharedResourceStore.replace(), and sharedResourceClient was constructed and never used. So
     * ConnectionListViewModel merged an empty shared list into every render and the three
     * implemented /shared endpoints were unreachable from the device -- present, tested, and dead,
     * the same shape as driveProfileProvider = { null } before the SAF picker was wired.
     */
    val sharedResourceCoordinator: SharedResourceCoordinator = SharedResourceCoordinator(
        client = ApiSharedResourceFetcher(sharedResourceClient),
        store = sharedResources,
    )

    /** In-memory: a session is a live transport, and a transport does not survive process death. */
    val sessions: SessionRegistry = SessionRegistry()

    val workspaceState: WorkspaceStatePersistence = WorkspaceStatePersistence(context)

    // -- file sync --

    /**
     * Preferences behind the authorised-directory rows and the per-connection choice.
     *
     * One file for both, because they are read together on every drive resolution and neither is a
     * secret: a SAF tree URI is an opaque handle that grants nothing without the permission the
     * system holds separately, and the profile id is a local label. Nothing here is synced
     * (DEVELOPMENT.md 3), and allowBackup=false in the manifest keeps it off a device transfer,
     * where a tree URI would name a directory that does not exist.
     */
    private val fileSyncStore = SharedPreferencesKeyValueStore(
        context.getSharedPreferences(PersistentShareStore.PREFERENCES, Context.MODE_PRIVATE),
    )

    /**
     * The directories the user has authorised for file sync.
     *
     * Backed by a write-through store so a picked directory survives a relaunch. Without it the app
     * would hold a SAF permission with no row describing it: access the user granted, that the UI
     * could no longer show or revoke.
     */
    val shareGrants: SafShareGrants = SafShareGrants(
        permissions = ContentResolverUriPermissions(context.contentResolver),
        store = PersistentShareStore(fileSyncStore),
    )

    /** Which authorised directory each connection uses. Device-local, per DEVELOPMENT.md 13.2. */
    val connectionShares: ConnectionSharePreferences = ConnectionSharePreferences(fileSyncStore)

    /**
     * Resolves a connection to the drive profile an RDP session can map.
     *
     * This is what stopped driveProfileProvider from being a hardcoded null. The document tree is
     * built per grant rather than once, because a tree URI is the identity of the grant: caching one
     * across grants would serve the previous directory after the user picked a new one.
     */
    val fileSyncShares: FileSyncShareCoordinator = FileSyncShareCoordinator(
        grants = shareGrants,
        profileForConnection = { connectionId -> connectionShares.profileFor(connectionId) },
        treeFactory = { treeUri ->
            ContentResolverDocumentTree(
                resolver = context.contentResolver,
                treeUri = Uri.parse(treeUri),
            )
        },
    )

    /**
     * Drops grants the system no longer reports, and any connection choice left pointing at one.
     *
     * DEVELOPMENT.md 13.5 requires the binding and the file-bridge lease to be re-verified before
     * reconnecting, and a SAF grant can be revoked in system settings while the app is not running.
     * Pruning the choices as well as the grants matters: a choice naming a dead profile resolves to
     * null, which the session reports as no-directory-authorised while the editor still shows a
     * directory as selected.
     *
     * @return the connection ids whose directory choice was dropped.
     */
    fun pruneRevokedShares(): List<String> {
        shareGrants.pruneRevoked()
        return connectionShares.pruneMissing(shareGrants.all().map { it.profileId }.toSet())
    }

    // -- sync --

    /**
     * The server's current encryption key, as last reported by capabilities or a bootstrap page.
     *
     * Held in a [MutableStateFlow] and read on every call rather than captured at construction, so a
     * key rotation is visible to the sealer and the opener without rebuilding the whole graph.
     */
    private val serverKeyState = MutableStateFlow<ServerEncryptionKey?>(null)

    fun onServerEncryptionKey(key: ServerEncryptionKey) {
        serverKeyState.value = key
    }

    val sealer: DeviceSecretSealer = DeviceSecretSealer(
        secretStore = secretStore,
        serverKey = { serverKeyState.value },
        serverId = binding.serverProfileId,
        userId = binding.userId,
        deviceId = binding.deviceId,
    )

    /**
     * Opens envelopes the server minted for this device.
     *
     * `knownKeyVersions` is a lambda over the live state for the same rotation reason as above: a
     * captured set would reject a freshly rotated key as unknown.
     */
    val envelopeOpener: DeviceEnvelopeOpener = DeviceEnvelopeOpener(
        identity = deviceIdentity,
        serverId = binding.serverProfileId,
        userId = binding.userId,
        deviceId = binding.deviceId,
        knownKeyVersions = { serverKeyState.value?.let { setOf(it.keyVersion) } ?: emptySet() },
    )

    val syncStore: RoomSyncLocalStore = RoomSyncLocalStore(
        db = database,
        syncState = syncState,
        conflicts = conflicts,
        mirror = mirror,
        bindingKey = bindingKey,
        boundUserId = binding.userId,
        envelopeOpener = envelopeOpener,
    )

    val transport: MobileApiTransport = MobileApiTransport(api, binding.deviceId)

    /**
     * Blob transfer has no implementation yet, and this reports that honestly.
     *
     * `pendingCount` is 0 because nothing in the tree enqueues a blob operation: there is no blob
     * queue to drain, so a round must not be marked blocked. The moment a real blob queue exists
     * this becomes its pending count and [BlobTransferPort.unavailable] starts reporting blocked,
     * which is the behaviour the contract asks for. Returning a non-zero constant here instead would
     * put every device into a permanent "blocked" state for work that cannot exist.
     */
    val blobs: BlobTransferPort = BlobTransferPort.unavailable { 0 }

    val actor: SyncActor = SyncActor(
        transport = transport,
        store = syncStore,
        sealer = sealer,
        blobs = blobs,
        /* A residency violation must drop shared state from memory, not just stop the round: the
         * server is telling us we hold something we are not allowed to keep. */
        onSharedPurge = {
            /* Through the coordinator so `hasLoaded` resets too. Clearing the store alone leaves
             * it true, and the next render would say "nobody has shared anything with you"
             * rather than showing a spinner -- a false claim rather than a stale one. */
            sharedResourceCoordinator.clear()
            sessionSecrets.purgeAll()
        },
    )

    val scheduler: SyncScheduler = SyncScheduler(context, SyncWorker::class.java)

    private val syncSettings = MutableStateFlow(initialSyncSettings)

    val syncSettingsState: StateFlow<SyncSettings> = syncSettings.asStateFlow()

    /** Callers persist through [one.zephyr.mobile.data.repository.BindingRepository] as well. */
    fun updateSyncSettings(transform: (SyncSettings) -> SyncSettings) {
        syncSettings.value = transform(syncSettings.value)
    }

    val syncEngine: SyncEngine = SyncEngine(
        actor = actor,
        syncState = syncState,
        conflicts = conflicts,
        scheduler = scheduler,
        networkMonitor = networkMonitor,
        bindingKey = bindingKey,
        settings = syncSettingsState,
        localWriteSignals = writeGateway.writeSignals,
    )

    /**
     * Starts the long-lived collectors and arms the lock sink.
     *
     * Separate from construction so a test can build the graph without spawning coroutines, and so
     * the scope is the application's rather than one screen's.
     */
    fun start(scope: CoroutineScope) {
        appContainer.appLock.register(sessionSecrets)
        syncEngine.start(scope)
    }

    /**
     * Releases what outlives a plain garbage collection.
     *
     * The lock registration is a strong reference from the process-scoped [AppLock] into this graph,
     * so failing to unregister would keep an unbound account's arena reachable - exactly what an
     * unbind is supposed to prevent.
     */
    fun dispose() {
        appContainer.appLock.unregister(sessionSecrets)
        sessionSecrets.purgeAll()
        sharedResourceCoordinator.clear()
        sessions.clear()
    }

    /**
     * Stops serving the local file share for this account.
     *
     * The ZFT2 transport is not wired to a live socket yet, so this drops the session material the
     * bridge would have used. It is deliberately not a no-op: the foreground service calls it on its
     * stop action, and leaving decrypted share material behind after the user pressed 停止 would be
     * the wrong failure.
     */
    suspend fun stopFileBridge() {
        sessionSecrets.purgeAll()
    }

    /**
     * Exchanges the rotating refresh credential for a fresh access credential.
     *
     * The refresh credential rotates on every use, so the new one is stored before reporting
     * success; dropping it would leave the device unable to refresh again and force a rebind.
     */
    private suspend fun refreshAccess(): Boolean {
        val refresh = credentials.refreshCredential() ?: return false
        return when (val result = api.refresh(binding.deviceId, refresh)) {
            is ApiResult.Success -> {
                val body = result.value
                credentials.storeAccess(body.accessCredential, body.accessExpiresAt)
                credentials.storeRefresh(body.refreshCredential)
                true
            }
            is ApiResult.Failure -> false
        }
    }

    companion object {
        /**
         * One row per (server, user, device).
         *
         * The device id is part of the key on purpose: the same account on two devices keeps
         * independent cursors, so one device catching up cannot advance the other's applied cursor.
         */
        fun bindingKeyOf(binding: AccountBinding): String =
            binding.serverProfileId + "/" + binding.userId + "/" + binding.deviceId
    }
}
