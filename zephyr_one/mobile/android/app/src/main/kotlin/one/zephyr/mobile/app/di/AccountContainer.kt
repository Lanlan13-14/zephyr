package one.zephyr.mobile.app.di

import android.content.Context
import android.net.Uri
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import one.zephyr.mobile.app.binding.AccountDatabaseReadiness
import one.zephyr.mobile.app.LocalAiWorkspace
import one.zephyr.mobile.app.binding.BindingGeneration
import one.zephyr.mobile.app.binding.BindingTeardownScope
import one.zephyr.mobile.app.binding.ManagedBindingGraph
import one.zephyr.mobile.app.binding.isDeviceRevocationError
import one.zephyr.mobile.app.session.WorkspaceStatePersistence
import one.zephyr.mobile.app.sync.SyncWorker
import one.zephyr.mobile.data.LocalWriteGateway
import one.zephyr.mobile.data.MirrorWriter
import one.zephyr.mobile.data.SecretMutationJournal
import one.zephyr.mobile.data.db.AccountDatabaseScope
import one.zephyr.mobile.data.db.DevicePreferenceRow
import one.zephyr.mobile.data.db.ZephyrDatabase
import one.zephyr.mobile.data.repository.ConflictRepository
import one.zephyr.mobile.data.repository.ConnectionRepository
import one.zephyr.mobile.data.repository.LocalAiRepository
import one.zephyr.mobile.data.repository.NoteRepository
import one.zephyr.mobile.data.repository.OwnedAiRepository
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
import one.zephyr.mobile.feature.tools.ClientTokenActions
import one.zephyr.mobile.feature.tools.RepositoryClientTokenSecretCache
import one.zephyr.mobile.model.AccountBinding
import one.zephyr.mobile.model.TlsPolicy
import one.zephyr.mobile.network.ApiEndpoint
import one.zephyr.mobile.network.ApiResult
import one.zephyr.mobile.network.ClientTokenManagementApi
import one.zephyr.mobile.network.CredentialStore
import one.zephyr.mobile.network.CredentialScope
import one.zephyr.mobile.network.DeviceProofSigner
import one.zephyr.mobile.network.MobileApi
import one.zephyr.mobile.network.MobileApiClient
import one.zephyr.mobile.network.MobileWakeStreamTransport
import one.zephyr.mobile.network.NetworkMonitor
import one.zephyr.mobile.network.NetworkState
import one.zephyr.mobile.network.SharedResourceClient
import one.zephyr.mobile.network.WakeProofSigner
import one.zephyr.mobile.security.DeviceIdentity
import one.zephyr.mobile.security.SecretStore
import one.zephyr.mobile.security.SessionSecretArena
import one.zephyr.mobile.security.LockSensitiveSink
import one.zephyr.mobile.sync.ApiSharedResourceFetcher
import one.zephyr.mobile.sync.BlobTransferPort
import one.zephyr.mobile.sync.BootstrapOutcome
import one.zephyr.mobile.sync.DeviceEnvelopeOpener
import one.zephyr.mobile.sync.DeviceSecretSealer
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import one.zephyr.mobile.sync.LinkChannel
import one.zephyr.mobile.sync.LinkKinds
import one.zephyr.mobile.sync.LinkChannelException
import one.zephyr.mobile.sync.LinkSyncTransport
import one.zephyr.mobile.sync.MobileApiTransport
import one.zephyr.mobile.sync.RoomSyncLocalStore
import one.zephyr.mobile.sync.ServerEncryptionKey
import one.zephyr.mobile.sync.SharedResourceCoordinator
import one.zephyr.mobile.sync.SyncActor
import one.zephyr.mobile.sync.SyncEngine
import one.zephyr.mobile.sync.SyncRoundResult
import one.zephyr.mobile.sync.SyncScheduler
import one.zephyr.mobile.sync.SyncSettings
import one.zephyr.mobile.sync.WakeBindingIdentity
import one.zephyr.mobile.sync.WakeCoordinator

/** The only application-wide side effect allowed when an account graph becomes durable. */
internal class AccountContainerShareActivation(
    private val grants: SafShareGrants,
) {
    private var activated = false

    @Synchronized
    fun activate() {
        if (activated) return
        grants.reconcilePersistedPermissions()
        activated = true
    }
}

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
    override val binding: AccountBinding,
    val endpoint: ApiEndpoint,
    private val appContainer: AppContainer,
    private val databaseScope: AccountDatabaseScope,
    val database: ZephyrDatabase,
    appVersion: String,
    /**
     * Sync preferences as persisted for this binding.
     *
     * Passed in rather than defaulted here: they live on the binding row, and defaulting them would
     * silently re-enable automatic sync for a user who turned it off.
     */
    initialSyncSettings: SyncSettings,
    /**
     * Local-first mode: no server binding is involved, so network/sync/wake producers are never
     * started and every scope is reserved to this device (see [AppContainer]'s LOCAL_ ids). All
     * local data -- connections, notes, settings, sessions -- works exactly as in a bound account,
     * so sync being optional never makes the app unusable.
     */
    val localMode: Boolean = false,
) : ManagedBindingGraph {

    /** Identifies this binding's rows in `sync_state` / `bootstrap_progress`. */
    override val bindingKey: String = bindingKeyOf(binding)

    /**
     * Stable across process recreation, but different after a fresh bind of the same account.
     * WorkManager persists it with each request so work left by an older graph fails closed.
     */
    override val generation: String = generationOf(binding)

    init {
        require(databaseScope.serverId == binding.serverProfileId) { "database server scope mismatch" }
        require(databaseScope.userId == binding.userId) { "database user scope mismatch" }
        require(databaseScope.generation == generation) { "database generation scope mismatch" }
    }
    /** True for the device-reserved local workspace ([AppContainer].ensureLocalWorkspace). */
    val isLocalMode: Boolean get() = localMode
    override val isDeviceLocal: Boolean get() = localMode

    private val accountJob = SupervisorJob()
    private val accountScope = CoroutineScope(accountJob + Dispatchers.Default)
    private val syncJob = SupervisorJob(accountJob)
    private val syncExceptionHandler = CoroutineExceptionHandler { _, failure ->
        android.util.Log.e("ZephyrSync", "uncaught sync failure", failure)
    }
    private val syncScope = CoroutineScope(syncJob + Dispatchers.Default + syncExceptionHandler)
    private val wakeJob = SupervisorJob(accountJob)
    private val wakeScope = CoroutineScope(wakeJob + Dispatchers.Default)
    private val started = AtomicBoolean(false)
    private val producersStarted = AtomicBoolean(false)
    private val preparedDiscarded = AtomicBoolean(false)
    private val networkEnabled = AtomicBoolean(false)
    private val holdAlive = AtomicBoolean(false)

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
            generation = generation,
        ),
    )

    val journal: SecretMutationJournal = SecretMutationJournal(
        db = database,
        secretStore = secretStore,
        serverId = binding.serverProfileId,
        ownerUserId = binding.userId,
        deviceId = binding.deviceId,
        bindingGeneration = generation,
    )

    val credentials: CredentialStore = CredentialStore(
        secretStore = secretStore,
        scope = CredentialScope(bindingKey = bindingKey, generation = generation),
    )

    val deviceIdentity: DeviceIdentity = DeviceIdentity(
        blobs = appContainer.secretBlobs,
        scope = DeviceIdentity.Scope(
            serverId = binding.serverProfileId,
            userId = binding.userId,
            deviceId = binding.deviceId,
        ),
    )

    /**
     * Session-scoped plaintext for shared resources.
     *
     * Shared material must not reach the mirror at all (SHARED_RESOURCE_RESIDENCY.md), so it lives
     * here and dies with the session. Registered as a lock sink in [activate] so a device lock wipes it
     * without waiting for the session to end.
     */
    val sessionSecrets: SessionSecretArena = SessionSecretArena()

    internal fun registerSensitiveSink(sink: LockSensitiveSink) = appContainer.appLock.register(sink)

    internal fun unregisterSensitiveSink(sink: LockSensitiveSink) = appContainer.appLock.unregister(sink)

    // -- network --

    private val deviceProofSigner = DeviceProofSigner { challenge ->
        deviceIdentity.signChallengeProof(
            method = challenge.method,
            canonicalPath = challenge.canonicalPath,
            bodySha256 = challenge.bodySha256,
            usage = challenge.usage,
            timestampSeconds = challenge.timestamp,
            serverNonce = challenge.nonce,
        )
    }

    val apiClient: MobileApiClient = MobileApiClient(
        endpoint = endpoint,
        credentials = credentials,
        refresher = { refreshAccess() },
        appVersion = appVersion,
        proofSigner = deviceProofSigner,
    )

    val api: MobileApi = MobileApi(apiClient)

    /** Server-owned AI runtime. Uses SID when present, then the bound device access credential. */
    val aiRuntime: one.zephyr.mobile.network.AiRuntimeApi = one.zephyr.mobile.network.AiRuntimeApi(
        endpoint = endpoint,
        credentials = credentials,
        appVersion = appVersion,
    )

    val clientTokenManagement: ClientTokenManagementApi = ClientTokenManagementApi(apiClient)

    /** Shared-to-me reads go through their own client so no shared payload can reach the mirror. */
    val sharedResourceClient: SharedResourceClient = SharedResourceClient(apiClient)

    val networkMonitor: NetworkMonitor = appContainer.networkMonitor

    val network: Flow<NetworkState> = networkMonitor.states()

    // -- local data --

    val writeGateway: LocalWriteGateway = LocalWriteGateway(database, secretStore, journal)

    val connections: ConnectionRepository = ConnectionRepository(database, writeGateway)

    val resources: ResourceRepository = ResourceRepository(database, writeGateway)

    val notes: NoteRepository = NoteRepository(database, writeGateway)

    val settings: SettingsRepository = SettingsRepository(database, writeGateway)

    /** Full local AI authority. Server binding is never required to edit or run it. */
    val localAi: LocalAiRepository = LocalAiRepository(database, secretStore)

    /** Bound-account AI entities that ride the owned-sync change feed. */
    val ownedAi: OwnedAiRepository = OwnedAiRepository(database, writeGateway)

    internal val localAiWorkspace: LocalAiWorkspace = LocalAiWorkspace(
        File(context.noBackupFilesDir, "ai-workspaces/$generation"),
        localAi,
    )

    internal fun appContainer(): AppContainer = appContainer

    val tokens: one.zephyr.mobile.data.repository.ClientTokenRepository =
        one.zephyr.mobile.data.repository.ClientTokenRepository(
            db = database,
            gateway = writeGateway,
            secretStore = secretStore,
            boundOwnerUserId = binding.userId,
        )

    val syncState: SyncStateRepository = SyncStateRepository(database)

    val conflicts: ConflictRepository = ConflictRepository(database)

    val mirror: MirrorWriter = MirrorWriter(database, secretStore, secretJournal = journal)

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

    private val fileSyncOwnerId = PersistentShareStore.ownerId(
        binding.serverProfileId,
        binding.userId,
        binding.deviceId,
        generation,
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
        store = PersistentShareStore(fileSyncStore, ownerId = fileSyncOwnerId),
        reconcileOnInit = false,
    )

    private val shareActivation = AccountContainerShareActivation(shareGrants)

    /** Which authorised directory each connection uses. Device-local, per DEVELOPMENT.md 13.2. */
    val connectionShares: ConnectionSharePreferences = ConnectionSharePreferences(
        store = fileSyncStore,
        ownerId = fileSyncOwnerId,
    )

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
    /**
     * Envelope AAD serverId from /capabilities. Empty until the first validated
     * capabilities payload; opening a secret before that fails closed rather
     * than silently using the local ServerProfile row id.
     *
     * Persisted in device_preferences so a process restart can open already-
     * staged envelopes before the next capabilities round. The local
     * ServerProfile UUID is never written here.
     */
    private val envelopeServerId = MutableStateFlow("")

    fun onServerEncryptionKey(key: ServerEncryptionKey) {
        serverKeyState.value = key
    }

    val sealer: DeviceSecretSealer = DeviceSecretSealer(
        secretStore = secretStore,
        serverKey = { serverKeyState.value },
        serverId = { envelopeServerId.value },
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
        serverId = { envelopeServerId.value },
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
        secretJournal = journal,
    )

    private val httpTransport: MobileApiTransport = MobileApiTransport(api, binding.deviceId)

    /**
     * The owned-sync channel over Zephyr Link (ZSL/2). Data sync rides the encrypted channel end to
     * end instead of plaintext HTTPS: a verb is sealed by the embedded Go core and answered by the
     * server's single sync core, so mobile, desktop and browser all share one implementation. The
     * session dials lazily on first use and redials if the channel dropped.
     */
    private val linkSpkiPins: List<String> =
        (endpoint.tlsPolicy as? TlsPolicy.PinnedSpki)?.sha256Pins ?: emptyList()
    private val linkInsecure: Boolean = endpoint.tlsPolicy is TlsPolicy.InsecureTrust

    private val linkChannel = object : LinkChannel {
        private val sessionMutex = Mutex()
        private var session: one.zephyr.mobile.app.EmbeddedLinkApi.LinkSession? = null

        override val isEstablished: Boolean get() = session != null

        override suspend fun syncOp(op: String, body: kotlinx.serialization.json.JsonObject): kotlinx.serialization.json.JsonObject {
            var attemptedRedial = false
            while (true) {
                val sess = sessionMutex.withLock {
                    session ?: appContainer.embeddedLink.dial(
                        endpoint.baseUrl, binding.deviceId, linkSpkiPins, linkInsecure,
                    ).also { session = it }
                }
                try {
                    return appContainer.embeddedLink.push(
                        endpoint.baseUrl, sess, kind = LinkKinds.SYNC_OP,
                        body = body, spkiPins = linkSpkiPins, insecure = linkInsecure,
                    ).ack
                } catch (e: one.zephyr.mobile.app.EmbeddedLinkApi.LinkRequestException) {
                    /* A server restart forgets only the ephemeral session. The operation is safe to
                     * resend once: opId makes push idempotent; bootstrap/changes/ack are reads or
                     * monotonic receipts. Business failures keep their exact state-machine code. */
                    if (e.sessionInvalid && !attemptedRedial) {
                        sessionMutex.withLock { if (session == sess) session = null }
                        attemptedRedial = true
                        continue
                    }
                    if (e.sessionInvalid) sessionMutex.withLock { if (session == sess) session = null }
                    throw LinkChannelException(e.message, e.code, e.retryable, e.details)
                } catch (e: Exception) {
                    sessionMutex.withLock { if (session == sess) session = null }
                    throw LinkChannelException(e.message ?: "Link 推送失败")
                }
            }
        }
    }

    /**
     * Data sync transport. Local-only accounts have no server. Bound accounts use HTTPS only for
     * pre-session capability discovery; bootstrap, changes, push and ack all run inside Link.
     */
    val transport: one.zephyr.mobile.sync.SyncTransport =
        if (localMode) httpTransport else LinkSyncTransport(linkChannel, binding.deviceId, httpTransport)

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
        onCapabilities = { caps ->
            /* Feed the server's published ML-KEM key into the live key state so the sealer can
             * seal and the opener recognises the key version. A null/absent key means "defer
             * secrets", which the sealer already honours, so only an Available key updates state. */
            rememberPublishedEnvelopeIdentity(caps.serverId, caps.serverEncryption)
        },
    )

    val scheduler: SyncScheduler = SyncScheduler(
        context = context,
        workerClass = SyncWorker::class.java,
        bindingKey = bindingKey,
        generation = generation,
    )

    private val syncSettings = MutableStateFlow(initialSyncSettings)

    val syncSettingsState: StateFlow<SyncSettings> = syncSettings.asStateFlow()

    /** Callers persist through [one.zephyr.mobile.data.repository.BindingRepository] as well. */
    fun updateSyncSettings(transform: (SyncSettings) -> SyncSettings) {
        val next = transform(syncSettings.value)
        syncSettings.value = next
        if (!localMode) {
            accountScope.launch {
                runCatching {
                    appContainer.bindings.saveBinding(
                        binding = binding,
                        automaticEnabled = next.automaticEnabled,
                        intervalSec = next.intervalSec,
                        policy = next.networkPolicy,
                    )
                }
            }
        }
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

    val clientTokenActions: ClientTokenActions = ClientTokenActions(
        management = clientTokenManagement,
        secretCache = RepositoryClientTokenSecretCache(tokens, binding.userId),
        localMode = localMode,
        onServerMutation = { syncEngine.syncNow() },
    )

    internal val wakeIdentity = WakeBindingIdentity(
        serverId = binding.serverProfileId,
        userId = binding.userId,
        deviceId = binding.deviceId,
        generation = generation,
    )

    private val wakeCoordinator = WakeCoordinator(
        identity = wakeIdentity,
        transport = MobileWakeStreamTransport(
            client = apiClient,
            proofSigner = WakeProofSigner(deviceProofSigner::sign),
        ),
        currentIdentity = appContainer::currentWakeIdentity,
        appliedCursor = { syncState.state(bindingKey)?.appliedCursor ?: 0L },
        requestSync = {
            val results = syncEngine.onServerWake()
            results.isNotEmpty() && results.all { it.complete }
        },
        onTerminal = { code ->
            if (isDeviceRevocationError(code)) {
                // No new producer may start once the server has made a terminal decision. Persist
                // the fence before waiting on cleanup so process death can only resume teardown.
                networkEnabled.set(false)
                if (appContainer.persistWakeDeviceRevocationFence(bindingKey, generation)) {
                    syncJob.cancelAndJoin()
                    scheduler.cancelAllAndAwait()
                    appContainer.completeWakeDeviceRevocation()
                }
            }
        },
    )

    /**
     * Starts the long-lived collectors and arms the lock sink.
     *
     * Separate from construction so a test can build the graph without spawning coroutines, and so
     * the scope is the application's rather than one screen's.
     */
    override suspend fun activate() {
        check(!preparedDiscarded.get()) { "discarded account graph cannot be activated" }
        shareActivation.activate()
        if (!started.compareAndSet(false, true)) return
        restorePublishedEnvelopeIdentity()
        journal.recover()
        appContainer.appLock.register(secretStore)
        appContainer.appLock.register(sessionSecrets)
        // A local workspace has no server to sync or wake from. The lock sinks above still arm,
        // which is what wipes device-local secrets when the device locks.
        if (localMode) return
        syncState.ensure(bindingKey)
        networkEnabled.set(true)
    }

    /**
     * Opens the sync collectors and the wake stream.
     *
     * Kept off the restore critical path so the first frame can paint before sockets and the
     * embedded Link process come up. Bind completion still calls this before bootstrap so the
     * first owned-sync round has producers.
     */
    override fun startNetworkProducers() {
        if (localMode || !started.get() || !networkEnabled.get()) return
        if (!producersStarted.compareAndSet(false, true)) {
            wakeCoordinator.onHoldAliveChanged(holdAlive.get())
            wakeCoordinator.onForegroundChanged(appContainer.isProcessForeground())
            return
        }
        syncEngine.start(syncScope)
        syncScope.launch {
            syncEngine.lastRoundResult.collect { round ->
                if (isDeviceRevocationError(round?.error?.code)) {
                    appContainer.onDeviceRevoked(bindingKey, generation)
                }
            }
        }
        wakeCoordinator.start(wakeScope)
        wakeCoordinator.onHoldAliveChanged(holdAlive.get())
        wakeCoordinator.onForegroundChanged(appContainer.isProcessForeground())
        wakeScope.launch {
            network.collect { state ->
                wakeCoordinator.onNetworkChanged(state.connected)
                if (state.connected) runCatching { sharedResourceCoordinator.refresh() }
            }
        }
    }

    internal fun setHoldAlive(hold: Boolean) {
        holdAlive.set(hold)
        if (producersStarted.get()) wakeCoordinator.onHoldAliveChanged(hold)
    }

    /** Runs the first bootstrap inside this account's cancellable lifetime. */
    override suspend fun bootstrapAfterBind(): List<SyncRoundResult> =
        if (!localMode && networkEnabled.get()) syncScope.async {
            // A failed pre-fix first round may have persisted REAUTH_REQUIRED even though no snapshot
            // was ever committed. The encrypted readiness marker is the authority for whether this
            // generation has usable data; missing marker forces a fresh bootstrap after credentials
            // become valid again. Invalid credentials still fail validation and restore reauth.
            if (accountDatabaseRequiresBootstrap()) {
                syncState.ensure(bindingKey)
                syncState.updateState(bindingKey, one.zephyr.mobile.contracts.BindingState.BOUND_NEEDS_BOOTSTRAP)
            }
            val rounds = syncEngine.onBindComplete()
            /* The readiness marker must track the committed snapshot, not the whole round. A
             * first round whose bootstrap promoted the mirror but then failed a later phase
             * (push/pull/ack) used to leave the marker unset, so the next launch reset the
             * binding to BOUND_NEEDS_BOOTSTRAP and re-downloaded the entire account — and a
             * re-staged snapshot whose envelopes could not be opened then froze staging with
             * a misleading missing_envelope. Once any round promoted the snapshot, the mirror
             * is complete and later phases are retried as an ordinary normal round. */
            if (rounds.any { it.bootstrapOutcome is BootstrapOutcome.Complete }) {
                markAccountDatabaseReady()
            }
            rounds
        }.await() else emptyList()

    /** Runs once after a restored, already-bootstrapped graph is published. */
    override suspend fun runForegroundRound(): List<SyncRoundResult> =
        if (!localMode && networkEnabled.get()) syncScope.async { syncEngine.onForegroundStart() }.await() else emptyList()

    /** Runs only when the worker's persisted identity has already matched this graph. */
    override suspend fun runScheduledRound(): List<SyncRoundResult> =
        if (!localMode && networkEnabled.get()) syncScope.async { syncEngine.runScheduledRound() }.await() else emptyList()

    override suspend fun accountDatabaseRequiresBootstrap(): Boolean =
        if (localMode) false else AccountDatabaseReadiness.requiresBootstrap(
            database.devicePreferenceDao().find(AccountDatabaseReadiness.MARKER_KEY)?.valueJson,
            binding,
        )

    override suspend fun markAccountDatabaseReady() {
        database.devicePreferenceDao().upsert(
            DevicePreferenceRow(
                key = AccountDatabaseReadiness.MARKER_KEY,
                valueJson = AccountDatabaseReadiness.marker(binding),
                updatedAt = System.currentTimeMillis(),
            ),
        )
    }

    /**
     * Quiesces the graph before its reference or secrets are cleared.
     *
     * Cancelling this job waits for actor rounds and collectors started by this account. WorkManager
     * cancellation follows, so no queued worker can reacquire the graph during teardown.
     */
    override suspend fun stopAndJoin() {
        networkEnabled.set(false)
        holdAlive.set(false)
        wakeCoordinator.stopAndJoin()
        wakeJob.cancelAndJoin()
        syncJob.cancelAndJoin()
        accountJob.cancelAndJoin()
        scheduler.cancelAllAndAwait()
        dispose()
    }

    internal fun onProcessForegroundChanged(foreground: Boolean) {
        wakeCoordinator.onForegroundChanged(foreground)
    }

    /** Silent-push fallback: identity is checked again by the persisted worker after process death. */
    internal fun onPushWake(expectedBindingKey: String, expectedGeneration: String) {
        if (!networkEnabled.get() || bindingKey != expectedBindingKey || generation != expectedGeneration) return
        scheduler.requestBackgroundRound(syncSettings.value.networkPolicy, expedited = true)
    }

    /** Erases every credential, key and device-local handle owned by this binding. */
    override fun wipeBindingState() {
        appContainer.wipeBindingScope(BindingTeardownScope.of(binding))
    }

    override fun isRecoverable(): Boolean =
        if (localMode) true else credentials.refreshCredential() != null && deviceIdentity.hasKeys()

    override fun storeCredentials(access: String, accessExpiresAt: Long?, refresh: String) {
        credentials.replaceBindingCredentials(access, accessExpiresAt, refresh)
    }

    override fun discardPreparedState() {
        check(!started.get()) { "active account graph requires full binding teardown" }
        if (!preparedDiscarded.compareAndSet(false, true)) return
        networkEnabled.set(false)
        accountJob.cancel()
        secretStore.evictPlaintextCache()
        sessionSecrets.purgeAll()
        sharedResourceCoordinator.clear()
        sessions.clear()
        appContainer.discardPreparedBindingScope(BindingTeardownScope.of(binding))
    }

    /**
     * Releases what outlives a plain garbage collection.
     *
     * The lock registration is a strong reference from the process-scoped [AppLock] into this graph,
     * so failing to unregister would keep an unbound account's arena reachable - exactly what an
     * unbind is supposed to prevent.
     */
    private fun dispose() {
        appContainer.appLock.unregister(secretStore)
        appContainer.appLock.unregister(sessionSecrets)
        secretStore.evictPlaintextCache()
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
                credentials.replaceBindingCredentials(
                    access = body.accessCredential,
                    expiresAt = body.accessExpiresAt,
                    refresh = body.refreshCredential,
                )
                true
            }
            is ApiResult.Failure -> false
        }
    }

    private suspend fun restorePublishedEnvelopeIdentity() {
        if (localMode) return
        val storedId = PublishedEnvelopePrefs.decodeServerId(
            runCatching {
                database.devicePreferenceDao().find(ENVELOPE_SERVER_ID_PREF)?.valueJson
            }.getOrNull(),
        )
        if (storedId.isNotEmpty()) {
            envelopeServerId.value = storedId
        }
        val storedKey = PublishedEnvelopePrefs.decodeServerKey(
            runCatching {
                database.devicePreferenceDao().find(ENVELOPE_SERVER_KEY_PREF)?.valueJson
            }.getOrNull(),
        ) ?: return
        serverKeyState.value = ServerEncryptionKey(
            publicKey = storedKey.second,
            keyVersion = storedKey.first,
        )
    }

    private fun rememberPublishedEnvelopeIdentity(
        publishedServerId: String,
        encryption: one.zephyr.mobile.model.ServerEncryptionCapabilities?,
    ) {
        if (publishedServerId.isNotEmpty()) {
            envelopeServerId.value = publishedServerId
            persistPreference(ENVELOPE_SERVER_ID_PREF, PublishedEnvelopePrefs.encodeServerId(publishedServerId))
        }
        if (encryption == null) return
        val decoded = runCatching {
            one.zephyr.mobile.model.Base64Codec.decode(encryption.publicKey)
        }.getOrNull()
        if (decoded == null || decoded.isEmpty()) return
        serverKeyState.value = ServerEncryptionKey(publicKey = decoded, keyVersion = encryption.keyVersion)
        persistPreference(
            ENVELOPE_SERVER_KEY_PREF,
            PublishedEnvelopePrefs.encodeServerKey(encryption.keyVersion, decoded),
        )
    }

    private fun persistPreference(key: String, value: String) {
        accountScope.launch {
            database.devicePreferenceDao().upsert(
                DevicePreferenceRow(
                    key = key,
                    valueJson = value,
                    updatedAt = System.currentTimeMillis(),
                ),
            )
        }
    }

    companion object {
        internal const val ENVELOPE_SERVER_ID_PREF = "published-envelope-server-id"
        internal const val ENVELOPE_SERVER_KEY_PREF = "published-envelope-server-key"
        /**
         * One row per (server, user, device).
         *
         * The device id is part of the key on purpose: the same account on two devices keeps
         * independent cursors, so one device catching up cannot advance the other's applied cursor.
         */
        fun bindingKeyOf(binding: AccountBinding): String =
            binding.serverProfileId + "/" + binding.userId + "/" + binding.deviceId

        fun generationOf(binding: AccountBinding): String =
            BindingGeneration.of(binding)

        fun databaseScopeOf(binding: AccountBinding): AccountDatabaseScope = AccountDatabaseScope(
            serverId = binding.serverProfileId,
            userId = binding.userId,
            generation = generationOf(binding),
        )
    }
}
