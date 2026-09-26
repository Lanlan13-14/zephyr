package one.zephyr.mobile.app

import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import one.zephyr.mobile.feature.sessions.TerminalCredentials
import one.zephyr.mobile.model.Connection
import one.zephyr.mobile.protocol.ssh.HostKey
import one.zephyr.mobile.protocol.ssh.HostKeyPolicy
import one.zephyr.mobile.protocol.ssh.RouteHop
import one.zephyr.mobile.protocol.ssh.SshConnectOutcome
import one.zephyr.mobile.protocol.ssh.SshConnectRequest
import one.zephyr.mobile.protocol.ssh.SshCredential
import one.zephyr.mobile.protocol.ssh.SshEngine
import one.zephyr.mobile.protocol.ssh.SshRoute

data class ManagedHostKeyPrompt(
    val connectionName: String,
    val connectionId: String,
    val host: String,
    val port: Int,
    val hostKey: HostKey,
    val changed: Boolean,
    internal val decision: CompletableDeferred<Boolean>,
) {
    val algorithm: String get() = hostKey.algorithm
    val fingerprint: String get() = hostKey.sha256Fingerprint
}

class ManagedSshSessionPool(
    private val engine: SshEngine,
    private val connectionProvider: suspend (String) -> Connection?,
    private val credentialsProvider: suspend (Connection) -> TerminalCredentials,
    private val routePlanner: RoutePlanner = RoutePlanner { null },
    private val hopAuthProvider: suspend (SshRoute) -> Map<String, one.zephyr.mobile.protocol.ssh.HopAuth> = { emptyMap() },
) {
    fun interface RoutePlanner {
        suspend fun plan(connection: Connection): SshRoute?
    }

    private data class Live(val sessionId: String, var references: Int)

    private val locks = ConcurrentHashMap<String, Mutex>()
    private val live = ConcurrentHashMap<String, Live>()
    private val promptState = MutableStateFlow<ManagedHostKeyPrompt?>(null)
    val prompt: StateFlow<ManagedHostKeyPrompt?> = promptState.asStateFlow()

    suspend fun acquire(connectionId: String): ManagedSshLease {
        val lock = locks.getOrPut(connectionId) { Mutex() }
        return lock.withLock {
            /* A cached Live can point at a session the engine already dropped
             * (remote close, failed write). Handing that sessionId to exec or
             * execStream fails instantly with "SSH 会话已断开" - the "日志流已
             * 结束" with no output. Drop the stale row and redial. */
            live[connectionId]?.let { cached ->
                if (engine.isSessionLive(cached.sessionId)) {
                    cached.references += 1
                    return@withLock ManagedSshLease(connectionId, cached.sessionId, this)
                }
                live.remove(connectionId, cached)
            }
            val connection = connectionProvider(connectionId) ?: error("连接不存在")
            /* wireName is "SSH" (uppercase). A literal "ssh" comparison is
             * case-sensitive and failed for every connection, including SSH
             * itself, which made SFTP and batch exec demand a manual home-
             * screen connection before they could work at all. */
            require(connection.protocol == one.zephyr.mobile.model.Protocol.SSH) { "仅 SSH 连接支持此操作" }
            require(connection.capabilities.canUse) { "没有使用此连接的权限" }
            val sessionId = "managed-${connection.id}-${UUID.randomUUID()}"
            open(sessionId, connection)
            live[connectionId] = Live(sessionId, 1)
            ManagedSshLease(connectionId, sessionId, this)
        }
    }

    private suspend fun open(sessionId: String, connection: Connection) {
        val credentials = credentialsProvider(connection)
        try {
            val privateKey = credentials.privateKey
            val password = credentials.password
            val credential = when {
                privateKey != null && privateKey.isNotEmpty() ->
                    SshCredential.PrivateKey(privateKey.copyOf(), credentials.passphrase?.copyOf())
                password != null && password.isNotEmpty() ->
                    SshCredential.Password(password.copyOf())
                else -> error("连接没有可用的 SSH 凭据")
            }
            /* Route resolution is a configuration check, not a dial: a proxy or
             * jump chain that does not resolve is a fixable setup error, and the
             * planner names which field to fix. Only after it succeeds does a
             * socket open. */
            val route = routePlanner.plan(connection)
                ?: SshRoute(listOf(RouteHop.Target(connection.host, connection.port)))
            val request = SshConnectRequest(
                sessionId = sessionId,
                route = route,
                username = connection.username,
                credential = credential,
                hopCredentials = hopAuthProvider(route),
                hostKeyPolicy = HostKeyPolicy.PROMPT_UNKNOWN_BLOCK_CHANGED,
                cols = 80,
                rows = 24,
            )
            var outcome = engine.connect(request)
            if (outcome is SshConnectOutcome.HostKeyDecisionRequired && outcome.known == null) {
                // First sight of this host: the same trust-on-first-use the main
                // end applies, so SFTP and batch can open a session without the
                // user having connected from the home screen first. A key that
                // changed still falls through to the prompt below.
                engine.acceptHostKey(sessionId, connection.host, connection.port, outcome.presented)
                outcome = engine.connect(request)
            }
            if (outcome is SshConnectOutcome.HostKeyDecisionRequired) {
                val decision = CompletableDeferred<Boolean>()
                val prompt = ManagedHostKeyPrompt(
                    connectionName = connection.name,
                    connectionId = connection.id,
                    host = connection.host,
                    port = connection.port,
                    hostKey = outcome.presented,
                    changed = outcome.known != null,
                    decision = decision,
                )
                promptState.value = prompt
                val accepted = try { decision.await() } finally {
                    if (promptState.value === prompt) promptState.value = null
                }
                if (!accepted) error("已取消主机指纹确认")
                engine.acceptHostKey(sessionId, connection.host, connection.port, outcome.presented)
                outcome = engine.connect(request)
            }
            require(outcome is SshConnectOutcome.Connected) {
                (outcome as? SshConnectOutcome.Failed)?.error?.message ?: "SSH 自动连接失败"
            }
        } finally {
            credentials.wipe()
        }
    }

    fun acceptHostKey() = decideHostKey(true)
    fun rejectHostKey() = decideHostKey(false)

    suspend fun <T> withSession(connectionId: String, block: suspend (String) -> T): Result<T> = runCatching {
        val lease = acquire(connectionId)
        try {
            block(lease.sessionId)
        } finally {
            lease.close()
        }
    }

    fun decideHostKey(accept: Boolean) {
        promptState.value?.decision?.complete(accept)
    }

    internal suspend fun release(connectionId: String, sessionId: String) {
        val lock = locks.getOrPut(connectionId) { Mutex() }
        lock.withLock {
            val current = live[connectionId] ?: return@withLock
            if (current.sessionId != sessionId) return@withLock
            current.references -= 1
            if (current.references <= 0) {
                live.remove(connectionId)
                engine.disconnect(sessionId)
            }
        }
    }

    suspend fun closeAll() {
        val sessions = live.values.map { it.sessionId }
        live.clear()
        sessions.forEach { engine.disconnect(it) }
        promptState.value?.decision?.complete(false)
        promptState.value = null
    }
}

class ManagedSshLease internal constructor(
    val connectionId: String,
    val sessionId: String,
    private val pool: ManagedSshSessionPool,
) {
    private var closed = false
    suspend fun close() {
        if (closed) return
        closed = true
        pool.release(connectionId, sessionId)
    }
}
