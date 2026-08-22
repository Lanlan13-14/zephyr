package one.zephyr.mobile.feature.sessions

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import one.zephyr.mobile.model.Connection
import one.zephyr.mobile.model.MobileError
import one.zephyr.mobile.model.Protocol
import one.zephyr.mobile.protocol.ssh.HopAuth
import one.zephyr.mobile.protocol.ssh.HostKeyPolicy
import one.zephyr.mobile.protocol.ssh.RouteHop
import one.zephyr.mobile.protocol.ssh.SshConnectOutcome
import one.zephyr.mobile.protocol.ssh.SshConnectRequest
import one.zephyr.mobile.protocol.ssh.SshCredential
import one.zephyr.mobile.protocol.ssh.SshEngine
import one.zephyr.mobile.protocol.ssh.SshRoute

/**
 * SSH [TerminalHost] over [SshEngine].
 *
 * The stored route is dialled, not just the target's TCP port: a jump or proxy
 * chain is part of the connection. Hard-coding a direct Target here is what
 * made a working jump on the server fail on the phone after PR #45 wired the
 * engine and the planner but never this host.
 */
class SshTerminalHost(
    private val engine: SshEngine,
    private val findConnection: suspend (String) -> Connection?,
    private val routePlanner: suspend (Connection) -> SshRoute = { connection ->
        SshRoute(listOf(RouteHop.Target(connection.host, connection.port)))
    },
    private val hopAuthProvider: suspend (SshRoute) -> Map<String, HopAuth> = { emptyMap() },
) : TerminalHost {

    private val lastTarget = LinkedHashMap<String, RememberedTarget>()
    @Suppress("unused")
    private val connectionLookup = findConnection

    override val isAvailable: Boolean = engine.isAvailable

    override suspend fun open(request: TerminalOpenRequest): TerminalOpenOutcome {
        if (request.protocol != Protocol.SSH) {
            request.wipe()
            return TerminalOpenOutcome.Failed(UnavailableTerminalHost.TELNET_NO_SOCKET)
        }
        lastTarget[request.sessionId] = RememberedTarget(request.host, request.port, presented = null)
        val credential = credentialOf(request) ?: run {
            request.wipe()
            return TerminalOpenOutcome.Failed(
                MobileError.local(code = "auth_missing", message = "请先填写密码或选择 SSH Key", retryable = false),
            )
        }
        val connection = findConnection(request.connectionId)
        val route = try {
            if (connection != null) routePlanner(connection)
            else SshRoute(listOf(RouteHop.Target(request.host, request.port)))
        } catch (error: Exception) {
            request.wipe()
            return TerminalOpenOutcome.Failed(
                MobileError.local(
                    code = "route_invalid",
                    message = error.message ?: "路由配置无效",
                    retryable = false,
                ),
            )
        }
        val hopCredentials = try {
            hopAuthProvider(route)
        } catch (error: Exception) {
            request.wipe()
            return TerminalOpenOutcome.Failed(
                MobileError.local(
                    code = "jump_auth_missing",
                    message = error.message ?: "跳板机没有可用的 SSH 凭据",
                    retryable = false,
                ),
            )
        }
        val outcome = engine.connect(
            SshConnectRequest(
                sessionId = request.sessionId,
                route = route,
                username = request.username,
                credential = credential,
                hopCredentials = hopCredentials,
                hostKeyPolicy = HostKeyPolicy.PROMPT_UNKNOWN_BLOCK_CHANGED,
                cols = request.columns,
                rows = request.rows,
            ),
        )
        request.wipe()
        return when (outcome) {
            is SshConnectOutcome.Connected -> TerminalOpenOutcome.Opened(outcome.sessionId, outcome.serverBanner)
            is SshConnectOutcome.HostKeyDecisionRequired -> {
                lastTarget[request.sessionId] = RememberedTarget(
                    host = request.host,
                    port = request.port,
                    presented = outcome.presented,
                )
                TerminalOpenOutcome.HostKeyDecision(
                    fingerprint = outcome.presented.sha256Fingerprint,
                    changed = outcome.known != null,
                )
            }
            is SshConnectOutcome.Failed -> TerminalOpenOutcome.Failed(outcome.error)
        }
    }

    override fun output(sessionId: String): Flow<ByteArray> =
        if (engine.isAvailable) engine.output(sessionId) else emptyFlow()

    override fun closure(sessionId: String): Flow<Throwable> =
        if (engine.isAvailable) engine.closure(sessionId) else emptyFlow()

    override fun transportFor(sessionId: String): TerminalTransport = object : TerminalTransport {
        override suspend fun write(bytes: ByteArray) = engine.send(sessionId, bytes)
        override suspend fun resize(columns: Int, rows: Int, widthPx: Int, heightPx: Int) =
            engine.resize(sessionId, columns, rows, widthPx, heightPx)
        override fun onFailure(error: Throwable) = engine.reportFailure(sessionId, error)
    }

    override suspend fun close(sessionId: String) {
        lastTarget.remove(sessionId)
        engine.disconnect(sessionId)
    }

    override suspend fun measureLatency(sessionId: String): Long? = engine.measureLatency(sessionId)

    override suspend fun listDirectory(sessionId: String, path: String) = engine.listDirectory(sessionId, path)

    override suspend fun exec(sessionId: String, command: String) = engine.exec(sessionId, command)

    override fun execStream(sessionId: String, command: String) = engine.execStream(sessionId, command)

    override suspend fun trustHostKey(sessionId: String) {
        val remembered = lastTarget[sessionId]
        engine.acceptHostKey(
            sessionId,
            remembered?.host.orEmpty(),
            remembered?.port ?: 0,
            remembered?.presented,
        )
    }

    private fun credentialOf(request: TerminalOpenRequest): SshCredential? {
        val privateKey = request.privateKey.usableSecret()
        val password = request.password.usableSecret()
        return when {
            privateKey != null -> SshCredential.PrivateKey(
                pem = privateKey,
                passphrase = request.passphrase.usableSecret(),
            )
            password != null -> SshCredential.Password(password)
            else -> null
        }
    }

    private fun CharArray?.usableSecret(): CharArray? {
        if (this == null || isEmpty() || all { it.isWhitespace() }) return null
        return copyOf()
    }

    private data class RememberedTarget(
        val host: String,
        val port: Int,
        val presented: one.zephyr.mobile.protocol.ssh.HostKey?,
    )
}
