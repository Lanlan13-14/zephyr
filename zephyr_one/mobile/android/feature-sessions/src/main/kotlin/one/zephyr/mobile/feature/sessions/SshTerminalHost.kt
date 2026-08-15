package one.zephyr.mobile.feature.sessions

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import one.zephyr.mobile.model.Connection
import one.zephyr.mobile.model.MobileError
import one.zephyr.mobile.model.Protocol
import one.zephyr.mobile.protocol.ssh.HostKeyPolicy
import one.zephyr.mobile.protocol.ssh.RouteHop
import one.zephyr.mobile.protocol.ssh.SshConnectOutcome
import one.zephyr.mobile.protocol.ssh.SshConnectRequest
import one.zephyr.mobile.protocol.ssh.SshCredential
import one.zephyr.mobile.protocol.ssh.SshEngine
import one.zephyr.mobile.protocol.ssh.SshRoute
import one.zephyr.mobile.protocol.ssh.SshjEngine

/**
 * SSH [TerminalHost] over [SshEngine].
 *
 * Telnet stays on the unavailable host until its socket is injected. Direct SSH is the only live
 * path here; proxy / jump are rejected by the engine with a structured error.
 */
class SshTerminalHost(
    private val engine: SshEngine,
    private val findConnection: suspend (String) -> Connection?,
) : TerminalHost {

    private val lastRequest = LinkedHashMap<String, TerminalOpenRequest>()
    @Suppress("unused")
    private val connectionLookup = findConnection

    override val isAvailable: Boolean = engine.isAvailable

    override suspend fun open(request: TerminalOpenRequest): TerminalOpenOutcome {
        if (request.protocol != Protocol.SSH) {
            request.wipe()
            return TerminalOpenOutcome.Failed(UnavailableTerminalHost.TELNET_NO_SOCKET)
        }
        lastRequest[request.sessionId] = copyRequest(request)
        val route = SshRoute(listOf(RouteHop.Target(request.host, request.port)))
        if (request.password == null && request.privateKey == null) {
            request.wipe()
            return TerminalOpenOutcome.Failed(
                MobileError.local(code = "auth_missing", message = "请先填写密码或选择 SSH Key", retryable = false),
            )
        }
        val outcome = engine.connect(
            SshConnectRequest(
                sessionId = request.sessionId,
                route = route,
                username = request.username,
                credential = credentialOf(request),
                hostKeyPolicy = HostKeyPolicy.PROMPT_UNKNOWN_BLOCK_CHANGED,
                cols = request.columns,
                rows = request.rows,
            ),
        )
        request.wipe()
        return when (outcome) {
            is SshConnectOutcome.Connected -> TerminalOpenOutcome.Opened(outcome.sessionId, outcome.serverBanner)
            is SshConnectOutcome.HostKeyDecisionRequired -> TerminalOpenOutcome.HostKeyDecision(
                fingerprint = outcome.presented.sha256Fingerprint,
                changed = outcome.known != null,
            )
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
        lastRequest.remove(sessionId)
        engine.disconnect(sessionId)
    }

    override suspend fun measureLatency(sessionId: String): Long? = engine.measureLatency(sessionId)

    override suspend fun listDirectory(sessionId: String, path: String) = engine.listDirectory(sessionId, path)

    override suspend fun exec(sessionId: String, command: String) = engine.exec(sessionId, command)

    override suspend fun trustHostKey(sessionId: String) {
        val remembered = lastRequest[sessionId] ?: return
        (engine as? SshjEngine)?.acceptHostKey(sessionId, remembered.host, remembered.port)
    }

    private fun credentialOf(request: TerminalOpenRequest): SshCredential = when {
        request.privateKey != null -> SshCredential.PrivateKey(
            pem = request.privateKey.copyOf(),
            passphrase = request.passphrase?.copyOf(),
        )
        request.password != null -> SshCredential.Password(request.password.copyOf())
        else -> SshCredential.Interactive
    }

    private fun copyRequest(request: TerminalOpenRequest): TerminalOpenRequest = request.copy(
        password = request.password?.copyOf(),
        privateKey = request.privateKey?.copyOf(),
        passphrase = request.passphrase?.copyOf(),
    )
}
