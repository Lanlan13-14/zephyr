package one.zephyr.mobile.app.binding

import java.util.UUID
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import androidx.room.withTransaction
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import one.zephyr.mobile.contracts.BindingState
import one.zephyr.mobile.contracts.MobileApiPaths
import one.zephyr.mobile.data.db.ZephyrDatabase
import one.zephyr.mobile.data.db.DevicePreferenceRow
import one.zephyr.mobile.data.repository.BindingRepository
import one.zephyr.mobile.model.AccountBinding
import one.zephyr.mobile.model.MobileError
import one.zephyr.mobile.model.NetworkPolicy
import one.zephyr.mobile.model.ServerCapabilities
import one.zephyr.mobile.model.ServerProfile
import one.zephyr.mobile.network.ApiResult
import one.zephyr.mobile.security.DeviceIdentity
import one.zephyr.mobile.security.LockSensitiveSink
import one.zephyr.mobile.sync.SyncRoundResult
import one.zephyr.mobile.sync.SyncSettings

internal fun isDeviceRevocationError(code: String?): Boolean =
    code == "client_revoked" || code == "device_revoked" || code == "account_unavailable"

/** Authentication result consumed by the future S02 UI. Passwords never enter this model. */
sealed interface BindingAuthenticationResult {
    data class Authenticated(val userId: String, val username: String) : BindingAuthenticationResult
    data object TotpRequired : BindingAuthenticationResult
    data object PasswordChangeRequired : BindingAuthenticationResult
    data class Failed(val error: MobileError) : BindingAuthenticationResult
}

/** Result of persisting a device binding and starting its mandatory first bootstrap. */
sealed interface BindingCompletionResult {
    data class Completed(
        val binding: AccountBinding,
        val bootstrapSucceeded: Boolean,
    ) : BindingCompletionResult

    data class Failed(val error: MobileError) : BindingCompletionResult
    data object AuthenticationRequired : BindingCompletionResult
}

sealed interface BindingRestoreResult {
    data object Unbound : BindingRestoreResult
    data class Restored(val binding: AccountBinding) : BindingRestoreResult
    data class Invalidated(val reason: String) : BindingRestoreResult
    data class LocalCleanupRequired(val error: MobileError) : BindingRestoreResult
}

data class AuthenticatedBindingAccount(
    val userId: String,
    val username: String,
    val mustChangePassword: Boolean = false,
)

sealed interface BindingLoginReply {
    data class Authenticated(val account: AuthenticatedBindingAccount) : BindingLoginReply

    class TotpRequired(val tempToken: CharArray) : BindingLoginReply {
        constructor(tempToken: String) : this(tempToken.toCharArray())

        override fun toString(): String = "TotpRequired(tempToken=[redacted])"
    }
}

data class DeviceBindingCommand(
    val deviceId: String,
    val deviceName: String,
    val tokenId: String,
    val publicKeys: DeviceIdentity.PublicKeys,
    val syncIntervalSec: Int,
)

class SensitiveBindingGrant(val value: CharArray) {
    constructor(value: String) : this(value.toCharArray())

    fun clear() = value.fill('\u0000')

    override fun toString(): String = "SensitiveBindingGrant(value=[redacted])"
}

data class DeviceBindingReply(
    val deviceId: String,
    val deviceName: String,
    val tokenId: String,
    val accessCredential: String,
    val accessExpiresAt: Long?,
    val refreshCredential: String,
    val registryHash: String,
    val boundAt: Long,
    val instanceEpoch: Long,
    val userId: String? = null,
    val username: String? = null,
) {
    override fun toString(): String =
        "DeviceBindingReply(deviceId=$deviceId, deviceName=$deviceName, tokenId=$tokenId, " +
            "accessCredential=[redacted], accessExpiresAt=$accessExpiresAt, " +
            "refreshCredential=[redacted], registryHash=$registryHash, boundAt=$boundAt, " +
            "instanceEpoch=$instanceEpoch)"
}

data class CompleteBindingRequest(
    val deviceName: String,
    val tokenId: String = LINK_ENROLLMENT_TOKEN_ID,
    val tokenName: String = LINK_ENROLLMENT_TOKEN_NAME,
    val automaticEnabled: Boolean,
    val intervalSec: Int,
    val networkPolicy: NetworkPolicy,
)

const val LINK_ENROLLMENT_TOKEN_ID = "link-v2-enrollment"
const val LINK_ENROLLMENT_TOKEN_NAME = "Zephyr Link"

/** Correct S02 seam. TOTP carries the login challenge's temp token and bind carries a header grant. */
interface BindingGateway {
    suspend fun capabilities(): ApiResult<ServerCapabilities>
    suspend fun login(username: String, password: CharArray): ApiResult<BindingLoginReply>
    suspend fun verifyTotp(tempToken: CharArray, code: CharArray): ApiResult<AuthenticatedBindingAccount>
    suspend fun verifySensitive(
        action: String,
        secret: CharArray,
        targetIds: List<String>,
    ): ApiResult<SensitiveBindingGrant>
    suspend fun bind(command: DeviceBindingCommand, sensitiveGrant: CharArray): ApiResult<DeviceBindingReply>

    suspend fun createEnrollment(
        command: DeviceBindingCommand,
    ): ApiResult<one.zephyr.mobile.network.dto.LinkEnrollmentCreateResponseDto> =
        ApiResult.Failure(MobileError.local("unsupported_protocol_version", "this server does not advertise Link enrollment"))

    suspend fun enrollmentStatus(
        bindId: String,
        userCode: String,
    ): ApiResult<one.zephyr.mobile.network.dto.LinkEnrollmentStatusDto> =
        ApiResult.Failure(MobileError.local("unsupported_protocol_version", "this server does not advertise Link enrollment"))

    suspend fun consumeEnrollment(
        bindId: String,
        userCode: String,
        enrollmentSecret: CharArray,
        proof: String,
        command: DeviceBindingCommand,
    ): ApiResult<DeviceBindingReply> =
        ApiResult.Failure(MobileError.local("unsupported_protocol_version", "this server does not advertise Link enrollment"))

    /** Clears the memory/SecretStore SID and any outstanding TOTP challenge. */
    fun clearAuthentication()
}

internal fun interface BindingGatewayFactory {
    fun create(profile: ServerProfile): BindingGateway
}

internal data class StoredBinding(
    val binding: AccountBinding,
    val profile: ServerProfile,
    val settings: SyncSettings,
    val requiresBootstrap: Boolean = false,
)

internal interface BindingStorage {
    suspend fun saveProfile(profile: ServerProfile)
    suspend fun restore(): StoredBinding?
    suspend fun bindingForTeardown(): AccountBinding?
    suspend fun save(binding: AccountBinding, settings: SyncSettings)
    /** Atomically replaces exactly [expected] with a new generation. */
    suspend fun saveReplacing(
        expected: BindingTeardownScope,
        binding: AccountBinding,
        settings: SyncSettings,
    ): Boolean
    suspend fun markAccountDatabaseReady(binding: AccountBinding, state: BindingState)
    /** Deletes the binding row only when it still names this exact generation. */
    suspend fun erase(scope: BindingTeardownScope)
}

interface ManagedBindingGraph {
    val binding: AccountBinding
    val bindingKey: String
    val generation: String
    val isDeviceLocal: Boolean get() = false

    fun isRecoverable(): Boolean
    fun storeCredentials(access: String, accessExpiresAt: Long?, refresh: String)
    /** Performs platform reconciliation and starts producers after durable ownership is committed. */
    suspend fun activate()
    /**
     * Starts sync/wake collectors. Separate from [activate] so process restore can paint the first
     * frame before opening sockets. Bind completion still calls this before bootstrap.
     */
    fun startNetworkProducers() {}
    /** Discards an unpublished generation without touching application-wide platform grants. */
    fun discardPreparedState()
    suspend fun bootstrapAfterBind(): List<SyncRoundResult>
    suspend fun runForegroundRound(): List<SyncRoundResult> = emptyList()
    suspend fun runScheduledRound(): List<SyncRoundResult>
    suspend fun accountDatabaseRequiresBootstrap(): Boolean = false
    suspend fun markAccountDatabaseReady() = Unit
    suspend fun stopAndJoin()
    fun wipeBindingState()
}

internal interface BindingGraphHost {
    fun currentGraph(): ManagedBindingGraph?
    fun attachGraph(graph: ManagedBindingGraph)
    fun clearGraph(expected: ManagedBindingGraph)

    /**
     * Publishes a prepared replacement in one observable state transition.
     *
     * Emitting `null` between the old and new graphs tears down the Compose tree that owns the bind
     * coroutine. The coroutine is then cancelled after the server has consumed the enrollment but
     * before the UI receives completion. A host must therefore replace the graph atomically.
     */
    fun replaceGraph(expected: ManagedBindingGraph, next: ManagedBindingGraph) {
        clearGraph(expected)
        attachGraph(next)
    }
}

internal fun interface BindingGraphFactory {
    fun create(stored: StoredBinding): ManagedBindingGraph
}

internal interface PendingDeviceIdentity {
    fun ensureKeys(): DeviceIdentity.PublicKeys
    fun signPayload(payload: ByteArray): String = error("device signing is unavailable")
    /** Transfers cleanup ownership from the binding screen to the durable account graph. */
    fun commit() = Unit
    fun wipe()
}

internal fun interface PendingDeviceIdentityFactory {
    fun create(serverId: String, userId: String, deviceId: String): PendingDeviceIdentity
}

/**
 * Owns the one-account graph and the transient S02 authentication state.
 *
 * Every mutating path is serialized by [mutex]. A -> B replacement therefore cannot expose B until
 * A's collectors/rounds have joined and A's binding-scoped WorkManager requests are cancelled.
 */
class BindingCoordinator internal constructor(
    private val storage: BindingStorage,
    private val host: BindingGraphHost,
    private val graphFactory: BindingGraphFactory,
    private val identityFactory: PendingDeviceIdentityFactory,
    private val gatewayFactory: BindingGatewayFactory,
    private val teardownJournal: BindingTeardownJournal,
    private val replacementJournal: BindingReplacementJournal,
    private val scopeStateWiper: BindingScopeStateWiper,
    private val preparedStateWiper: BindingPreparedStateWiper,
    private val noAccountCleanupJournal: NoAccountCleanupJournal,
    private val noAccountStateWiper: NoAccountStateWiper,
    private val deviceIdFactory: () -> String = { UUID.randomUUID().toString() },
    private val now: () -> Long = System::currentTimeMillis,
) : LockSensitiveSink {
    private val mutex = Mutex()
    private val authenticationEpoch = AtomicLong(0)
    private val activeInputBuffers = mutableListOf<CharArray>()

    /** False from process creation until journal replay and binding recovery have completed. */
    @Volatile
    private var workersMayRun = false

    @Volatile
    private var localCleanupBlocked = false

    private var noAccountCleanupVerified = false

    private sealed interface PendingAuthentication {
        val profile: ServerProfile
        val gateway: BindingGateway

        data class Totp(
            override val profile: ServerProfile,
            override val gateway: BindingGateway,
            val tempToken: CharArray,
        ) : PendingAuthentication

        data class Ready(
            override val profile: ServerProfile,
            override val gateway: BindingGateway,
            val account: AuthenticatedBindingAccount,
        ) : PendingAuthentication
    }

    private val pendingAuthentication = AtomicReference<PendingAuthentication?>(null)

    private sealed interface CompletionPreparation {
        data class Ready(val binding: AccountBinding, val graph: ManagedBindingGraph) : CompletionPreparation
        data class Finished(val result: BindingCompletionResult) : CompletionPreparation
    }

    private data class RestorePreparation(
        val result: BindingRestoreResult,
        val restoredGraph: ManagedBindingGraph? = null,
        val requiresBootstrap: Boolean = false,
        val binding: AccountBinding? = null,
    )

    /** Restores the graph before WorkManager can resolve a persisted sync request. */
    suspend fun restoreActiveBinding(bootstrap: Boolean = true): BindingRestoreResult {
        val preparation = mutex.withLock {
            workersMayRun = false
            if (noAccountCleanupMarkerConflictsLocked()) {
                return@withLock localCleanupRequiredPreparation()
            }
            completePendingTeardownLocked()
            completePendingReplacementLocked()
            val stored = try {
                storage.restore()
            } catch (blocked: LegacyPendingWritesException) {
                return@withLock RestorePreparation(
                    BindingRestoreResult.Invalidated(LegacyAccountDatabaseMigration.BLOCKED_ERROR_CODE),
                )
            } ?: return@withLock if (completeNoAccountCleanupLocked()) {
                RestorePreparation(BindingRestoreResult.Unbound)
            } else {
                localCleanupRequiredPreparation()
            }
            if (!stored.binding.isLive) {
                eraseLocked(host.currentGraph(), stored.binding)
                noAccountCleanupVerified = false
                return@withLock if (completeNoAccountCleanupLocked()) {
                    RestorePreparation(BindingRestoreResult.Invalidated("binding_not_live"))
                } else {
                    localCleanupRequiredPreparation()
                }
            }

            val graph = host.currentGraph()?.takeIf {
                it.bindingKey == BindingTeardownScope.of(stored.binding).bindingKey &&
                    it.generation == BindingGeneration.of(stored.binding)
            } ?: graphFactory.create(stored)
            if (!graph.isRecoverable()) {
                eraseLocked(graph, stored.binding)
                noAccountCleanupVerified = false
                return@withLock if (completeNoAccountCleanupLocked()) {
                    RestorePreparation(BindingRestoreResult.Invalidated("binding_material_missing"))
                } else {
                    localCleanupRequiredPreparation()
                }
            }

            noAccountCleanupVerified = true
            localCleanupBlocked = false
            val requiresBootstrap = stored.requiresBootstrap || graph.accountDatabaseRequiresBootstrap()
            if (host.currentGraph() !== graph) replaceGraphLocked(graph)
            RestorePreparation(
                result = BindingRestoreResult.Restored(stored.binding),
                restoredGraph = graph,
                requiresBootstrap = requiresBootstrap,
                binding = stored.binding,
            )
        }
        // Bootstrap can perform network I/O. Keep it outside the coordinator mutex so unbind or a
        // revoke can cancel the graph, join the round, and erase the database immediately.
        preparation.restoredGraph?.takeIf { bootstrap }?.let { graph ->
            graph.startNetworkProducers()
            if (preparation.requiresBootstrap) {
                graph.bootstrapAfterBind().lastOrNull()?.takeIf { it.complete }?.let { round ->
                    markBootstrapReadyIfCurrent(graph, checkNotNull(preparation.binding), round.endState)
                }
            } else {
                graph.runForegroundRound()
            }
        }
        workersMayRun = preparation.result !is BindingRestoreResult.LocalCleanupRequired
        return preparation.result
    }

    /** Retries a restored account's initial sync without blocking process startup. */
    suspend fun bootstrapRestoredBinding() {
        val graph = mutex.withLock { host.currentGraph() ?: return }
        graph.startNetworkProducers()
        if (graph.accountDatabaseRequiresBootstrap()) {
            graph.bootstrapAfterBind().lastOrNull()?.takeIf { it.complete }?.let { round ->
                markBootstrapReadyIfCurrent(graph, graph.binding, round.endState)
            }
        } else {
            graph.runForegroundRound()
        }
    }

    /** Production entry point. The gateway is scoped to this server profile and authentication. */
    suspend fun login(
        profile: ServerProfile,
        username: String,
        password: CharArray,
    ): BindingAuthenticationResult {
        val gateway = try {
            gatewayFactory.create(profile)
        } catch (_: Exception) {
            password.fill(NUL)
            return BindingAuthenticationResult.Failed(
                MobileError.local("server_unavailable", "binding client could not be created", retryable = true),
            )
        }
        return login(profile, username, password, gateway)
    }

    /** Test seam for deterministic authentication and cancellation behavior. */
    internal suspend fun login(
        profile: ServerProfile,
        username: String,
        password: CharArray,
        gateway: BindingGateway,
    ): BindingAuthenticationResult = authenticate(profile, username, password, gateway)

    private suspend fun authenticate(
        profile: ServerProfile,
        username: String,
        password: CharArray,
        gateway: BindingGateway,
    ): BindingAuthenticationResult = try {
        mutex.withLock {
            clearPendingAuthenticationLocked()
            if (bindingIsBlockedByLocalCleanupLocked()) return@withLock localCleanupAuthenticationFailure()
            val attempt = authenticationEpoch.get()
            trackInput(password)
            storage.saveProfile(profile)

            when (val capabilities = gateway.capabilities()) {
                is ApiResult.Failure -> return@withLock BindingAuthenticationResult.Failed(capabilities.error)
                is ApiResult.Success -> {
                    if (authenticationWasCancelled(attempt, gateway)) {
                        return@withLock interruptedAuthentication()
                    }
                    if (MobileApiPaths.PROTOCOL_VERSION !in capabilities.value.protocolVersions) {
                        gateway.clearAuthentication()
                        return@withLock BindingAuthenticationResult.Failed(
                            MobileError.local("protocol_incompatible", "server does not support this mobile protocol"),
                        )
                    }
                }
            }

            when (val login = gateway.login(username, password)) {
                is ApiResult.Failure -> {
                    gateway.clearAuthentication()
                    BindingAuthenticationResult.Failed(login.error)
                }
                is ApiResult.Success -> when (val reply = login.value) {
                    is BindingLoginReply.Authenticated -> {
                        if (authenticationWasCancelled(attempt, gateway)) {
                            interruptedAuthentication()
                        } else if (reply.account.mustChangePassword) {
                            gateway.clearAuthentication()
                            BindingAuthenticationResult.PasswordChangeRequired
                        } else {
                            pendingAuthentication.set(PendingAuthentication.Ready(profile, gateway, reply.account))
                            BindingAuthenticationResult.Authenticated(reply.account.userId, reply.account.username)
                        }
                    }
                    is BindingLoginReply.TotpRequired -> {
                        if (authenticationWasCancelled(attempt, gateway)) {
                            reply.tempToken.fill(NUL)
                            interruptedAuthentication()
                        } else {
                            pendingAuthentication.set(
                                PendingAuthentication.Totp(profile, gateway, reply.tempToken),
                            )
                            BindingAuthenticationResult.TotpRequired
                        }
                    }
                }
            }
        }
    } finally {
        releaseInput(password)
    }

    suspend fun verifyTotp(code: CharArray): BindingAuthenticationResult = try {
        mutex.withLock {
            val pending = pendingAuthentication.get() as? PendingAuthentication.Totp
                ?: return@withLock BindingAuthenticationResult.Failed(
                    MobileError.local("authentication_required", "start login before TOTP verification"),
                )
            trackInput(code)
            val attempt = authenticationEpoch.get()
            when (val verified = pending.gateway.verifyTotp(pending.tempToken, code)) {
                is ApiResult.Failure -> BindingAuthenticationResult.Failed(verified.error)
                is ApiResult.Success -> {
                    if (authenticationWasCancelled(attempt, pending.gateway)) {
                        interruptedAuthentication()
                    } else if (verified.value.mustChangePassword) {
                        pending.tempToken.fill(NUL)
                        pendingAuthentication.set(null)
                        pending.gateway.clearAuthentication()
                        BindingAuthenticationResult.PasswordChangeRequired
                    } else {
                        pending.tempToken.fill(NUL)
                        pendingAuthentication.set(
                            PendingAuthentication.Ready(
                                profile = pending.profile,
                                gateway = pending.gateway,
                                account = verified.value,
                            ),
                        )
                        BindingAuthenticationResult.Authenticated(verified.value.userId, verified.value.username)
                    }
                }
            }
        }
    } finally {
        releaseInput(code)
    }

    suspend fun completeBinding(
        request: CompleteBindingRequest,
        verificationSecret: CharArray,
    ): BindingCompletionResult {
        trackInput(verificationSecret)
        return try {
            val prepared = mutex.withLock { prepareBindingLocked(request, verificationSecret) }
            if (prepared is CompletionPreparation.Finished) {
                prepared.result
            } else {
                prepared as CompletionPreparation.Ready

                // Do not hold the coordinator mutex across network bootstrap. Unbind/revoke must be able to
                // acquire it, cancel this graph's SupervisorJob and join the round immediately. Publication
                // is already durable, so a cancelled UI caller must not strand persisted background work.
                if (host.currentGraph() === prepared.graph) workersMayRun = true
                prepared.graph.startNetworkProducers()
                val bootstrap = prepared.graph.bootstrapAfterBind()
                val bootstrapSucceeded = bootstrap.lastOrNull()?.takeIf { it.complete }?.let { round ->
                    markBootstrapReadyIfCurrent(prepared.graph, prepared.binding, round.endState)
                } ?: false
                BindingCompletionResult.Completed(
                    binding = prepared.binding,
                    bootstrapSucceeded = bootstrapSucceeded,
                )
            }
        } finally {
            releaseInput(verificationSecret)
        }
    }

    internal data class PreparedEnrollment(
        val profile: ServerProfile,
        val gateway: BindingGateway,
        val identity: PendingDeviceIdentity,
        val command: DeviceBindingCommand,
        val created: one.zephyr.mobile.network.dto.LinkEnrollmentCreateResponseDto,
    )

    internal suspend fun startEnrollment(
        profile: ServerProfile,
        deviceName: String,
        intervalSec: Int,
        networkPolicy: NetworkPolicy,
    ): ApiResult<PreparedEnrollment> {
        val gateway = try {
            gatewayFactory.create(profile)
        } catch (_: Exception) {
            return ApiResult.Failure(
                MobileError.local("server_unavailable", "binding client could not be created", retryable = true),
            )
        }
        return mutex.withLock {
            if (bindingIsBlockedByLocalCleanupLocked()) {
                return@withLock ApiResult.Failure(localCleanupError())
            }
            storage.saveProfile(profile)
            when (val capabilities = gateway.capabilities()) {
                is ApiResult.Failure -> capabilities
                is ApiResult.Success -> {
                    if (!capabilities.value.feature("linkEnrollment")
                        && !capabilities.value.features.containsKey("linkEnrollment")
                    ) {
                        // Older servers omit the flag; still try the endpoint and let 404 surface.
                    }
                    val deviceId = deviceIdFactory()
                    val identity = identityFactory.create(profile.id, "pending", deviceId)
                    val publicKeys = try {
                        identity.ensureKeys()
                    } catch (failure: Exception) {
                        identity.wipe()
                        return@withLock ApiResult.Failure(
                            MobileError.local(
                                "device_key_unavailable",
                                failure.message ?: "device key generation failed",
                            ),
                        )
                    }
                    val command = DeviceBindingCommand(
                        deviceId = deviceId,
                        deviceName = deviceName,
                        tokenId = LINK_ENROLLMENT_TOKEN_ID,
                        publicKeys = publicKeys,
                        syncIntervalSec = intervalSec,
                    )
                    when (val created = gateway.createEnrollment(command)) {
                        is ApiResult.Failure -> {
                            identity.wipe()
                            created
                        }
                        is ApiResult.Success -> ApiResult.Success(
                            PreparedEnrollment(profile, gateway, identity, command, created.value),
                            created.requestId,
                        )
                    }
                }
            }
        }
    }

    internal suspend fun pollEnrollment(
        prepared: PreparedEnrollment,
    ): ApiResult<one.zephyr.mobile.network.dto.LinkEnrollmentStatusDto> =
        prepared.gateway.enrollmentStatus(prepared.created.bindId, prepared.created.userCode)

    internal suspend fun consumePreparedEnrollment(
        prepared: PreparedEnrollment,
        intervalSec: Int,
        automaticEnabled: Boolean,
        networkPolicy: NetworkPolicy,
    ): BindingCompletionResult {
        val secret = prepared.created.enrollmentSecret.toCharArray()
        return try {
            val payload = linkEnrollmentProofPayload(prepared)
            val proof = try {
                prepared.identity.signPayload(payload)
            } catch (failure: Exception) {
                prepared.identity.wipe()
                return BindingCompletionResult.Failed(
                    MobileError.local("device_key_unavailable", failure.message ?: "device proof failed"),
                )
            }
            val reply = when (
                val result = prepared.gateway.consumeEnrollment(
                    bindId = prepared.created.bindId,
                    userCode = prepared.created.userCode,
                    enrollmentSecret = secret,
                    proof = proof,
                    command = prepared.command.copy(syncIntervalSec = intervalSec),
                )
            ) {
                is ApiResult.Failure -> {
                    if (result.error.code == "enrollment_not_approved") {
                        return BindingCompletionResult.Failed(result.error)
                    }
                    prepared.identity.wipe()
                    return BindingCompletionResult.Failed(result.error)
                }
                is ApiResult.Success -> result.value
            }
            if (reply.username.isNullOrBlank() || reply.userId.isNullOrBlank()) {
                prepared.identity.wipe()
                return BindingCompletionResult.Failed(
                    MobileError.local("binding_identity_mismatch", "enrollment consume did not return the account"),
                )
            }
            completeConsumedBinding(
                profile = prepared.profile,
                account = AuthenticatedBindingAccount(reply.userId!!, reply.username!!),
                request = CompleteBindingRequest(
                    deviceName = prepared.command.deviceName,
                    automaticEnabled = automaticEnabled,
                    intervalSec = intervalSec,
                    networkPolicy = networkPolicy,
                ),
                identity = prepared.identity,
                reply = reply,
            )
        } finally {
            secret.fill('\u0000')
        }
    }

    private fun linkEnrollmentProofPayload(prepared: PreparedEnrollment): ByteArray {
        val created = prepared.created
        val secretHash = java.security.MessageDigest.getInstance("SHA-256")
            .digest(created.enrollmentSecret.toByteArray(Charsets.UTF_8))
            .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
        val userCode = created.userCode.uppercase().replace(Regex("[^A-Z0-9]"), "")
        return listOf(
            "zephyr-link-enrollment-v2",
            created.bindId,
            prepared.command.deviceId,
            userCode,
            created.sas,
            secretHash,
            created.serverId,
        ).joinToString("\u0000").toByteArray(Charsets.UTF_8)
    }

    /**
     * Persists a Link v2 enrollment that the device already consumed.
     * No SID, password or Client Token is required on this path.
     */
    internal suspend fun completeConsumedBinding(
        profile: ServerProfile,
        account: AuthenticatedBindingAccount,
        request: CompleteBindingRequest,
        identity: PendingDeviceIdentity,
        reply: DeviceBindingReply,
    ): BindingCompletionResult {
        val prepared = mutex.withLock {
            persistConsumedBindingLocked(profile, account, request, identity, reply)
        }
        return if (prepared is CompletionPreparation.Finished) {
            prepared.result
        } else {
            prepared as CompletionPreparation.Ready
            // Publication is the durable hand-off. The UI tree that called us may be replaced at
            // this exact point, so make workers eligible before awaiting network bootstrap.
            if (host.currentGraph() === prepared.graph) workersMayRun = true
            val bootstrap = prepared.graph.bootstrapAfterBind()
            val bootstrapSucceeded = bootstrap.lastOrNull()?.takeIf { it.complete }?.let { round ->
                markBootstrapReadyIfCurrent(prepared.graph, prepared.binding, round.endState)
            } ?: false
            BindingCompletionResult.Completed(
                binding = prepared.binding,
                bootstrapSucceeded = bootstrapSucceeded,
            )
        }
    }

    private suspend fun prepareBindingLocked(
        request: CompleteBindingRequest,
        verificationSecret: CharArray,
    ): CompletionPreparation {
        if (bindingIsBlockedByLocalCleanupLocked()) {
            clearPendingAuthenticationLocked()
            return CompletionPreparation.Finished(
                BindingCompletionResult.Failed(localCleanupError()),
            )
        }
        val pending = pendingAuthentication.get() as? PendingAuthentication.Ready
            ?: return CompletionPreparation.Finished(BindingCompletionResult.AuthenticationRequired)
        val authenticationAttempt = authenticationEpoch.get()
        val deviceId = deviceIdFactory()
        val identity = identityFactory.create(pending.profile.id, pending.account.userId, deviceId)
        val publicKeys = try {
            identity.ensureKeys()
        } catch (failure: Exception) {
            identity.wipe()
            return CompletionPreparation.Finished(
                BindingCompletionResult.Failed(
                    MobileError.local("device_key_unavailable", failure.message ?: "device key generation failed"),
                ),
            )
        }

        val sensitiveGrant = when (
            val result = pending.gateway.verifySensitive(
                action = DEVICE_BIND_ACTION,
                secret = verificationSecret,
                targetIds = listOf(request.tokenId, deviceId),
            )
        ) {
            is ApiResult.Failure -> {
                identity.wipe()
                return CompletionPreparation.Finished(BindingCompletionResult.Failed(result.error))
            }
            is ApiResult.Success -> result.value
        }

        if (authenticationWasCancelled(authenticationAttempt, pending.gateway)) {
            sensitiveGrant.clear()
            identity.wipe()
            return CompletionPreparation.Finished(BindingCompletionResult.AuthenticationRequired)
        }

        val reply = try {
            trackInput(sensitiveGrant.value)
            when (
                val result = pending.gateway.bind(
                    DeviceBindingCommand(
                        deviceId = deviceId,
                        deviceName = request.deviceName,
                        tokenId = request.tokenId,
                        publicKeys = publicKeys,
                        syncIntervalSec = request.intervalSec,
                    ),
                    sensitiveGrant = sensitiveGrant.value,
                )
            ) {
                is ApiResult.Failure -> {
                    identity.wipe()
                    return CompletionPreparation.Finished(BindingCompletionResult.Failed(result.error))
                }
                is ApiResult.Success -> result.value
            }
        } finally {
            releaseInput(sensitiveGrant.value)
        }

        if (authenticationWasCancelled(authenticationAttempt, pending.gateway)) {
            identity.wipe()
            return CompletionPreparation.Finished(BindingCompletionResult.AuthenticationRequired)
        }

        if (reply.deviceId != deviceId || reply.tokenId != request.tokenId) {
            identity.wipe()
            return CompletionPreparation.Finished(
                BindingCompletionResult.Failed(
                    MobileError.local("binding_identity_mismatch", "server returned a different device binding"),
                ),
            )
        }

        return persistReplyLocked(pending.profile, pending.account, request, identity, reply)
    }

    private suspend fun persistConsumedBindingLocked(
        profile: ServerProfile,
        account: AuthenticatedBindingAccount,
        request: CompleteBindingRequest,
        identity: PendingDeviceIdentity,
        reply: DeviceBindingReply,
    ): CompletionPreparation {
        if (bindingIsBlockedByLocalCleanupLocked()) {
            identity.wipe()
            return CompletionPreparation.Finished(BindingCompletionResult.Failed(localCleanupError()))
        }
        if (reply.deviceId.isBlank() || account.userId.isBlank() || account.username.isBlank()) {
            identity.wipe()
            return CompletionPreparation.Finished(
                BindingCompletionResult.Failed(
                    MobileError.local("binding_identity_mismatch", "enrollment consume returned an incomplete account"),
                ),
            )
        }
        return persistReplyLocked(profile, account, request, identity, reply)
    }

    private suspend fun persistReplyLocked(
        profile: ServerProfile,
        account: AuthenticatedBindingAccount,
        request: CompleteBindingRequest,
        identity: PendingDeviceIdentity,
        reply: DeviceBindingReply,
    ): CompletionPreparation {
        val binding = AccountBinding(
            serverProfileId = profile.id,
            userId = account.userId,
            username = account.username,
            deviceId = reply.deviceId,
            deviceName = reply.deviceName,
            tokenId = reply.tokenId,
            tokenName = request.tokenName,
            state = BindingState.BOUND_NEEDS_BOOTSTRAP,
            registryHash = reply.registryHash,
            boundAt = reply.boundAt.takeIf { it > 0L } ?: now(),
            lastSyncAt = null,
            instanceEpoch = reply.instanceEpoch,
        )
        val settings = SyncSettings(
            automaticEnabled = request.automaticEnabled,
            intervalSec = request.intervalSec,
            networkPolicy = request.networkPolicy,
        )

        val next = StoredBinding(binding, profile, settings)
        storage.saveProfile(profile)
        val previousBinding = host.currentGraph()
            ?.takeUnless { it.isDeviceLocal }
            ?.binding
            ?: storage.bindingForTeardown()
        val previousScope = previousBinding?.let(BindingTeardownScope::of)
        val workersWereAllowed = workersMayRun
        if (previousScope != null) workersMayRun = false
        val replacement = previousScope?.let {
            BindingReplacementRecord(previous = it, next = next, stage = BindingReplacementStage.PREPARED)
        }
        if (replacement == null) {
            try {
                // Preserve the legacy migration fence: no account database may be opened while
                // the old plaintext store still has ambiguous pending writes.
                storage.save(binding, settings)
            } catch (blocked: LegacyPendingWritesException) {
                identity.wipe()
                clearPendingAuthenticationLocked()
                return CompletionPreparation.Finished(
                    BindingCompletionResult.Failed(
                        MobileError.local(
                            LegacyAccountDatabaseMigration.BLOCKED_ERROR_CODE,
                            "Pending writes in the legacy local database require recovery before rebinding",
                        ),
                    ),
                )
            }
            val graph = try {
                graphFactory.create(next)
            } catch (failure: Throwable) {
                eraseLocked(null, binding)
                throw failure
            }
            try {
                graph.storeCredentials(reply.accessCredential, reply.accessExpiresAt, reply.refreshCredential)
            } catch (failure: Throwable) {
                eraseLocked(graph, binding)
                throw failure
            }
            if (!graph.isRecoverable()) {
                eraseLocked(graph, binding)
                clearPendingAuthenticationLocked()
                return CompletionPreparation.Finished(
                    BindingCompletionResult.Failed(
                        MobileError.local("binding_material_missing", "binding credentials could not be retained"),
                    ),
                )
            }
            replaceGraphLocked(graph, identity::commit)
            noAccountCleanupVerified = true
            clearPendingAuthenticationLocked()
            return CompletionPreparation.Ready(binding, graph)
        }

        try {
            replacementJournal.persist(replacement)
        } catch (failure: Throwable) {
            workersMayRun = workersWereAllowed
            if (replacement.nextScope != replacement.previous) identity.wipe()
            clearPendingAuthenticationLocked()
            throw failure
        }
        val graph = try {
            graphFactory.create(next)
        } catch (failure: Throwable) {
            if (discardPreparedReplacementLocked(replacement, null, failure)) {
                workersMayRun = workersWereAllowed
            }
            throw failure
        }
        try {
            graph.storeCredentials(reply.accessCredential, reply.accessExpiresAt, reply.refreshCredential)
        } catch (failure: Throwable) {
            if (discardPreparedReplacementLocked(replacement, graph, failure)) {
                workersMayRun = workersWereAllowed
            }
            throw failure
        }
        if (!graph.isRecoverable()) {
            discardPreparedReplacementLocked(replacement, graph)
            workersMayRun = workersWereAllowed
            clearPendingAuthenticationLocked()
            return CompletionPreparation.Finished(
                BindingCompletionResult.Failed(
                    MobileError.local("binding_material_missing", "binding credentials could not be retained"),
                ),
            )
        }

        try {
            check(storage.saveReplacing(replacement.previous!!, binding, settings)) {
                "active binding changed while replacement was being prepared"
            }
        } catch (blocked: LegacyPendingWritesException) {
            try {
                discardPreparedReplacementLocked(replacement, graph)
                workersMayRun = workersWereAllowed
            } finally {
                clearPendingAuthenticationLocked()
            }
            return CompletionPreparation.Finished(
                BindingCompletionResult.Failed(
                    MobileError.local(
                        LegacyAccountDatabaseMigration.BLOCKED_ERROR_CODE,
                        "Pending writes in the legacy local database require recovery before rebinding",
                    ),
                ),
            )
        } catch (failure: Throwable) {
            val currentResult = runCatching { storage.bindingForTeardown() }
            val current = currentResult.getOrNull()
            if (currentResult.isSuccess && current?.let(replacement.nextScope::matches) != true) {
                val discarded = discardPreparedReplacementLocked(replacement, graph, failure)
                if (discarded && current?.let { replacement.previous!!.matches(it) } == true) {
                    workersMayRun = workersWereAllowed
                }
            }
            clearPendingAuthenticationLocked()
            throw failure
        }
        try {
            replacementJournal.advance(replacement, BindingReplacementStage.COMMITTED)
            replaceGraphWithDurableReplacementLocked(graph, replacement, identity::commit)
            noAccountCleanupVerified = true
        } finally {
            clearPendingAuthenticationLocked()
        }
        return CompletionPreparation.Ready(binding, graph)
    }

    /** Returns null for missing, stale or replacement-generation work. */
    internal fun graphForWorker(bindingKey: String?, generation: String?): ManagedBindingGraph? {
        if (!workersMayRun) return null
        if (bindingKey.isNullOrBlank() || generation.isNullOrBlank()) return null
        val graph = host.currentGraph() ?: return null
        return graph.takeIf { it.bindingKey == bindingKey && it.generation == generation }
    }

    suspend fun unbind() = mutex.withLock {
        workersMayRun = false
        clearPendingAuthenticationLocked()
        val graph = host.currentGraph()
        val binding = graph?.binding ?: storage.bindingForTeardown()
        if (binding != null) eraseLocked(graph, binding)
        noAccountCleanupVerified = false
        completeNoAccountCleanupLocked()
    }

    suspend fun onDeviceRevoked(bindingKey: String, generation: String) = mutex.withLock {
        val graph = host.currentGraph() ?: return@withLock
        if (graph.bindingKey != bindingKey || graph.generation != generation) return@withLock
        workersMayRun = false
        clearPendingAuthenticationLocked()
        eraseLocked(graph, graph.binding)
        noAccountCleanupVerified = false
        completeNoAccountCleanupLocked()
    }

    /**
     * Durable terminal fence used by a live wake task before that task can safely be joined.
     * Completion runs from the process teardown scope, avoiding a stream waiting for itself.
     */
    internal suspend fun persistDeviceRevocationFence(bindingKey: String, generation: String): Boolean =
        mutex.withLock {
            val graph = host.currentGraph() ?: return@withLock false
            if (graph.bindingKey != bindingKey || graph.generation != generation) return@withLock false
            val scope = BindingTeardownScope.of(graph.binding)
            val activeBinding = storage.bindingForTeardown()
            check(activeBinding == null || scope.matches(activeBinding)) {
                "revocation fence does not match the active binding generation"
            }
            clearPendingAuthenticationLocked()
            workersMayRun = false
            teardownJournal.persist(scope)
            true
        }

    /** Startup gate: no account graph or persisted worker may run while this returns unsuccessfully. */
    suspend fun completePendingTeardown() = mutex.withLock {
        workersMayRun = false
        clearPendingAuthenticationLocked()
        if (noAccountCleanupMarkerConflictsLocked()) return@withLock
        completePendingTeardownLocked()
        if (host.currentGraph() == null && storage.bindingForTeardown() == null) {
            completeNoAccountCleanupLocked()
        }
    }

    /** Lets a worker distinguish startup/recovery fencing from an intentionally unbound account. */
    internal fun workersAreReady(): Boolean = workersMayRun

    /** User cancellation, lock, background and revoke all drop the same transient auth state. */
    fun cancelAuthentication() {
        clearPendingAuthenticationLocked()
    }

    override fun onLocked() {
        cancelAuthentication()
    }

    private suspend fun replaceGraphLocked(
        next: ManagedBindingGraph,
        onOwnershipCommitted: () -> Unit = {},
    ) {
        val previous = host.currentGraph()
        if (previous === next) return
        if (previous != null) {
            previous.stopAndJoin()
        }
        next.activate()
        // The binding row and credentials are already durable. Transfer identity ownership before
        // publishing the StateFlow update that can dispose the binding screen on another thread.
        onOwnershipCommitted()
        if (previous == null) {
            host.attachGraph(next)
        } else {
            // Publish old -> next atomically. A transient null account disposes BindingScreen and
            // cancels the very coroutine that is committing this replacement.
            host.replaceGraph(previous, next)
        }
        if (previous != null && !previous.isDeviceLocal) previous.wipeBindingState()
    }

    private suspend fun replaceGraphWithDurableReplacementLocked(
        next: ManagedBindingGraph,
        record: BindingReplacementRecord,
        onOwnershipCommitted: () -> Unit = {},
    ) {
        workersMayRun = false
        replacementJournal.advance(record, BindingReplacementStage.OLD_FENCED)
        val previous = host.currentGraph()
        if (previous != null) {
            check(record.previous?.matches(previous.binding) == true) {
                "replacement previous graph does not match the durable scope"
            }
            previous.stopAndJoin()
        }
        next.activate()
        replacementJournal.advance(record, BindingReplacementStage.NEXT_STARTED)
        // Storage already points at the replacement. Commit identity ownership before publication
        // can dispose the screen that still holds the pending wrapper.
        onOwnershipCommitted()
        if (previous == null) {
            host.attachGraph(next)
        } else {
            host.replaceGraph(previous, next)
        }
        replacementJournal.advance(record, BindingReplacementStage.PUBLISHED)
        // A server should issue a fresh generation for a rebind.  If it did not, the identity is
        // physically shared and treating it as retired would erase the just-published graph.
        record.previous?.takeIf { it != record.nextScope }?.let(scopeStateWiper::wipe)
        replacementJournal.advance(record, BindingReplacementStage.OLD_TORN_DOWN)
        replacementJournal.clear(record)
    }

    /** Replays an A -> B replacement before a normal restore can expose either generation. */
    private suspend fun completePendingReplacementLocked() {
        val record = replacementJournal.pending() ?: return
        workersMayRun = false
        val current = storage.bindingForTeardown()
        val previousStillOwnsBinding = current?.let { record.previous?.matches(it) == true } == true
        if (previousStillOwnsBinding || current == null && record.stage == BindingReplacementStage.PREPARED) {
            discardPreparedReplacementLocked(record)
            return
        }
        check(current?.let(record.nextScope::matches) == true) {
            "replacement record does not match the active binding generation"
        }

        // The binding row is the durable evidence for the narrow crash window between its CAS and
        // the journal commit. A PREPARED record can never promote while the previous row still wins.
        if (record.stage == BindingReplacementStage.PREPARED) {
            replacementJournal.advance(record, BindingReplacementStage.COMMITTED)
        }
        if (record.stage == BindingReplacementStage.OLD_TORN_DOWN) {
            replacementJournal.clear(record)
            return
        }

        replacementJournal.advance(record, BindingReplacementStage.OLD_FENCED)
        val existing = host.currentGraph()
        if (existing != null && record.previous?.matches(existing.binding) == true) {
            existing.stopAndJoin()
            host.clearGraph(existing)
        }
        val next = try {
            graphFactory.create(record.next)
        } catch (_: Exception) {
            abandonUnrecoverableReplacementLocked(record)
            return
        }
        if (!next.isRecoverable()) {
            abandonUnrecoverableReplacementLocked(record)
            return
        }
        next.activate()
        replacementJournal.advance(record, BindingReplacementStage.NEXT_STARTED)
        if (host.currentGraph() == null) host.attachGraph(next)
        replacementJournal.advance(record, BindingReplacementStage.PUBLISHED)
        record.previous?.takeIf { it != record.nextScope }?.let(scopeStateWiper::wipe)
        replacementJournal.advance(record, BindingReplacementStage.OLD_TORN_DOWN)
        replacementJournal.clear(record)
    }

    /** A committed replacement with missing credentials cannot be exposed as a live binding. */
    private suspend fun abandonUnrecoverableReplacementLocked(record: BindingReplacementRecord) {
        scopeStateWiper.wipe(record.nextScope)
        record.previous?.takeIf { it != record.nextScope }?.let(scopeStateWiper::wipe)
        storage.erase(record.nextScope)
        replacementJournal.advance(record, BindingReplacementStage.OLD_TORN_DOWN)
        replacementJournal.clear(record)
    }

    /** PREPARED still belongs to the previous binding, so cleanup is strictly limited to next. */
    private fun discardPreparedReplacementLocked(
        record: BindingReplacementRecord,
        graph: ManagedBindingGraph? = null,
        originalFailure: Throwable? = null,
    ): Boolean {
        try {
            if (record.nextScope != record.previous) {
                if (graph != null) {
                    graph.discardPreparedState()
                } else {
                    preparedStateWiper.discard(record.nextScope)
                }
            }
            replacementJournal.clear(record)
            return true
        } catch (cleanupFailure: Throwable) {
            if (originalFailure != null) {
                originalFailure.addSuppressed(cleanupFailure)
                return false
            } else {
                throw cleanupFailure
            }
        }
    }

    private suspend fun markBootstrapReadyIfCurrent(
        graph: ManagedBindingGraph,
        binding: AccountBinding,
        state: BindingState,
    ): Boolean = mutex.withLock {
        if (host.currentGraph() !== graph || graph.generation != BindingGeneration.of(binding)) {
            return@withLock false
        }
        graph.markAccountDatabaseReady()
        storage.markAccountDatabaseReady(binding, state)
        true
    }

    private suspend fun eraseLocked(graph: ManagedBindingGraph?, binding: AccountBinding) {
        val scope = BindingTeardownScope.of(binding)
        if (graph != null) {
            check(graph.bindingKey == scope.bindingKey && graph.generation == scope.generation) {
                "binding graph does not match teardown scope"
            }
        }
        val activeBinding = storage.bindingForTeardown()
        check(activeBinding == null || scope.matches(activeBinding)) {
            "teardown scope does not match the active binding generation"
        }
        // This is the commit point. From here onward a restart may only finish this teardown.
        teardownJournal.persist(scope)
        completeTeardownLocked(scope, graph)
    }

    private suspend fun completePendingTeardownLocked() {
        val scope = teardownJournal.pending() ?: return
        val graph = host.currentGraph()
        check(graph == null || (graph.bindingKey == scope.bindingKey && graph.generation == scope.generation)) {
            "cannot replay teardown while another binding generation is active"
        }
        val activeBinding = storage.bindingForTeardown()
        check(activeBinding == null || scope.matches(activeBinding)) {
            "pending teardown does not match the active binding generation"
        }
        completeTeardownLocked(scope, graph)
    }

    private suspend fun completeTeardownLocked(
        scope: BindingTeardownScope,
        graph: ManagedBindingGraph?,
    ) {
        if (graph != null) {
            graph.stopAndJoin()
            host.clearGraph(graph)
            graph.wipeBindingState()
        } else {
            scopeStateWiper.wipe(scope)
        }
        // Scope state is already non-recoverable. Delete the matching row, then the recovery proof.
        storage.erase(scope)
        teardownJournal.clear(scope)
    }

    /**
     * Performs the only package-global cleanup path. The marker is durable before the capability
     * sweep, and is cleared only after a second binding check under the coordinator mutex.
     */
    private suspend fun completeNoAccountCleanupLocked(): Boolean {
        if (noAccountCleanupVerified) return true
        if (host.currentGraph() != null) {
            markLocalCleanupBlocked()
            return false
        }
        val activeBefore = runCatching { storage.bindingForTeardown() }.getOrElse {
            markLocalCleanupBlocked()
            return false
        }
        if (activeBefore != null) {
            markLocalCleanupBlocked()
            return false
        }

        try {
            noAccountCleanupJournal.persist()
        } catch (_: Throwable) {
            markLocalCleanupBlocked()
            return false
        }
        val wiped = try {
            noAccountStateWiper.wipe()
        } catch (_: Throwable) {
            false
        }
        if (!wiped) {
            markLocalCleanupBlocked()
            return false
        }

        val activeAfter = runCatching { storage.bindingForTeardown() }.getOrElse {
            markLocalCleanupBlocked()
            return false
        }
        if (host.currentGraph() != null || activeAfter != null) {
            markLocalCleanupBlocked()
            return false
        }
        try {
            noAccountCleanupJournal.clear()
        } catch (_: Throwable) {
            markLocalCleanupBlocked()
            return false
        }
        noAccountCleanupVerified = true
        localCleanupBlocked = false
        return true
    }

    private suspend fun noAccountCleanupMarkerConflictsLocked(): Boolean {
        val pending = try {
            noAccountCleanupJournal.pending()
        } catch (_: Throwable) {
            markLocalCleanupBlocked()
            return true
        }
        if (!pending) return false
        val active = runCatching { storage.bindingForTeardown() }.getOrElse {
            markLocalCleanupBlocked()
            return true
        }
        if (host.currentGraph() == null && active == null) return false
        markLocalCleanupBlocked()
        return true
    }

    private fun bindingIsBlockedByLocalCleanupLocked(): Boolean {
        if (localCleanupBlocked) return true
        return try {
            noAccountCleanupJournal.pending().also { pending ->
                if (pending) markLocalCleanupBlocked()
            }
        } catch (_: Throwable) {
            markLocalCleanupBlocked()
            true
        }
    }

    private fun markLocalCleanupBlocked() {
        localCleanupBlocked = true
        noAccountCleanupVerified = false
        workersMayRun = false
    }

    private fun localCleanupRequiredPreparation(): RestorePreparation =
        RestorePreparation(BindingRestoreResult.LocalCleanupRequired(localCleanupError()))

    private fun localCleanupAuthenticationFailure(): BindingAuthenticationResult.Failed =
        BindingAuthenticationResult.Failed(localCleanupError())

    private fun localCleanupError(): MobileError = MobileError.local(
        code = LOCAL_CLEANUP_PENDING_ERROR_CODE,
        message = "Local cleanup is incomplete; retry recovery before binding",
        retryable = true,
    )

    private fun clearPendingAuthenticationLocked() {
        authenticationEpoch.incrementAndGet()
        synchronized(activeInputBuffers) {
            for (buffer in activeInputBuffers) buffer.fill(NUL)
        }
        val pending = pendingAuthentication.getAndSet(null)
        if (pending is PendingAuthentication.Totp) pending.tempToken.fill(NUL)
        pending?.gateway?.clearAuthentication()
    }

    private fun authenticationWasCancelled(attempt: Long, gateway: BindingGateway): Boolean {
        if (authenticationEpoch.get() == attempt) return false
        gateway.clearAuthentication()
        return true
    }

    private fun interruptedAuthentication(): BindingAuthenticationResult.Failed =
        BindingAuthenticationResult.Failed(
            MobileError.local("authentication_cancelled", "authentication was cancelled"),
        )

    private fun trackInput(buffer: CharArray) {
        synchronized(activeInputBuffers) { activeInputBuffers.add(buffer) }
    }

    private fun releaseInput(buffer: CharArray) {
        synchronized(activeInputBuffers) { activeInputBuffers.removeAll { it === buffer } }
        buffer.fill(NUL)
    }

    private companion object {
        const val LOCAL_CLEANUP_PENDING_ERROR_CODE = "local_cleanup_pending"
        const val NUL = '\u0000'
        const val DEVICE_BIND_ACTION = "device.bind"
        const val LINK_ENROLLMENT_TOKEN_ID = "link-v2-enrollment"
        const val LINK_ENROLLMENT_TOKEN_NAME = "Zephyr Link"
    }
}

internal class RoomBindingStorage(
    private val bindings: BindingRepository,
    private val database: ZephyrDatabase,
) : BindingStorage {
    override suspend fun saveProfile(profile: ServerProfile) = bindings.saveProfile(profile)

    override suspend fun bindingForTeardown(): AccountBinding? = bindings.activeBinding()

    override suspend fun restore(): StoredBinding? {
        val binding = bindings.activeBinding() ?: return null
        val expectedMarker = LegacyAccountDatabaseMigration.marker(binding)
        val profile = bindings.profile(binding.serverProfileId)
        val row = database.accountBindingDao().find(binding.serverProfileId)
        if (profile == null || row == null) {
            bindings.unbind()
            return null
        }
        val migration = database.withTransaction {
            val marker = database.devicePreferenceDao()
                .find(LegacyAccountDatabaseMigration.MARKER_KEY)
                ?.valueJson
            val pendingWriteCount = database.pendingOperationDao().observeCount().first()
            val decision = LegacyAccountDatabaseMigration.decide(marker, expectedMarker, pendingWriteCount)
            if (decision is LegacyAccountMigrationDecision.BlockedByPendingWrites) {
                throw LegacyPendingWritesException(decision.count)
            }
            purgeLegacyAccountRows()
            if (decision == LegacyAccountMigrationDecision.RequiresBootstrap) {
                database.accountBindingDao().updateState(
                    binding.serverProfileId,
                    BindingState.BOUND_NEEDS_BOOTSTRAP.name,
                )
            }
            decision
        }
        val restoredBinding = if (migration == LegacyAccountMigrationDecision.RequiresBootstrap) {
            binding.copy(state = BindingState.BOUND_NEEDS_BOOTSTRAP)
        } else {
            binding
        }
        return StoredBinding(
            binding = restoredBinding,
            profile = profile,
            settings = SyncSettings(
                automaticEnabled = row.automaticEnabled,
                intervalSec = row.syncIntervalSec,
                networkPolicy = NetworkPolicy.fromWire(row.networkPolicy),
            ),
            requiresBootstrap = migration == LegacyAccountMigrationDecision.RequiresBootstrap,
        )
    }

    override suspend fun save(binding: AccountBinding, settings: SyncSettings) {
        database.withTransaction {
            val pendingWriteCount = database.pendingOperationDao().observeCount().first()
            if (pendingWriteCount > 0) throw LegacyPendingWritesException(pendingWriteCount)
            purgeLegacyAccountRows()
            database.accountBindingDao().deleteAll()
            bindings.saveBinding(
                binding = binding,
                automaticEnabled = settings.automaticEnabled,
                intervalSec = settings.intervalSec,
                policy = settings.networkPolicy,
            )
        }
    }

    override suspend fun saveReplacing(
        expected: BindingTeardownScope,
        binding: AccountBinding,
        settings: SyncSettings,
    ): Boolean = database.withTransaction {
        val active = bindings.activeBinding()
        if (active == null || !expected.matches(active)) return@withTransaction false
        val pendingWriteCount = database.pendingOperationDao().observeCount().first()
        if (pendingWriteCount > 0) throw LegacyPendingWritesException(pendingWriteCount)
        purgeLegacyAccountRows()
        database.accountBindingDao().deleteAll()
        bindings.saveBinding(
            binding = binding,
            automaticEnabled = settings.automaticEnabled,
            intervalSec = settings.intervalSec,
            policy = settings.networkPolicy,
        )
        true
    }

    override suspend fun markAccountDatabaseReady(binding: AccountBinding, state: BindingState) {
        database.withTransaction {
            database.accountBindingDao().updateState(binding.serverProfileId, state.name)
            database.devicePreferenceDao().upsert(
                DevicePreferenceRow(
                    key = LegacyAccountDatabaseMigration.MARKER_KEY,
                    valueJson = LegacyAccountDatabaseMigration.marker(binding),
                    updatedAt = System.currentTimeMillis(),
                ),
            )
        }
    }

    override suspend fun erase(scope: BindingTeardownScope) {
        val active = bindings.activeBinding()
        if (active != null && scope.matches(active)) bindings.unbind()
    }

    /** Account-shaped rows are never retained in the plaintext pre-binding database. */
    private suspend fun purgeLegacyAccountRows() {
        database.pendingOperationDao().deleteAll()
        database.conflictDao().deleteAll()
        database.appliedOperationDao().deleteAll()
        database.blobTransferDao().deleteAll()
        database.bootstrapDao().clearAll()
        database.syncStateDao().deleteAll()
        database.overlayDao().deleteAll()
        database.tombstoneDao().deleteAll()
        database.mirrorDao().deleteAll()
        database.mirrorDao().deleteAllSearch()
        database.trustedCertificateDao().deleteAll()
    }
}
