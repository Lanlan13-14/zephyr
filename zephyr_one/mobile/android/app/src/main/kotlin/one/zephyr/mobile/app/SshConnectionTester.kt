package one.zephyr.mobile.app

import java.util.UUID
import kotlin.system.measureNanoTime
import one.zephyr.mobile.feature.connections.ConnectionTestCredentials
import one.zephyr.mobile.feature.connections.ConnectionTestResult
import one.zephyr.mobile.feature.connections.ConnectionTester
import one.zephyr.mobile.model.Connection
import one.zephyr.mobile.model.MobileError
import one.zephyr.mobile.protocol.ssh.HostKeyPolicy
import one.zephyr.mobile.protocol.ssh.RouteHop
import one.zephyr.mobile.protocol.ssh.SshConnectOutcome
import one.zephyr.mobile.protocol.ssh.SshConnectRequest
import one.zephyr.mobile.protocol.ssh.SshCredential
import one.zephyr.mobile.protocol.ssh.SshEngine
import one.zephyr.mobile.protocol.ssh.SshRoute

/** One-shot direct SSH test used by the connection editor. Never creates a terminal tab. */
internal class DirectSshConnectionTester(private val engine: SshEngine) : ConnectionTester {
    override suspend fun test(
        connection: Connection,
        credentials: ConnectionTestCredentials,
    ): ConnectionTestResult {
        if (!engine.isAvailable) return ConnectionTestResult.Failed(
            MobileError.local("engine_unavailable", "SSH 引擎不可用", false),
        )
        if (!connection.protocol.isTerminal || connection.protocol != one.zephyr.mobile.model.Protocol.SSH) {
            return ConnectionTestResult.Failed(
                MobileError.local("protocol_unsupported", "此测试器仅支持 SSH", false),
            )
        }
        val credential = when {
            credentials.privateKey != null && credentials.privateKey.isNotEmpty() -> SshCredential.PrivateKey(
                credentials.privateKey,
                credentials.passphrase,
            )
            credentials.password != null && credentials.password.isNotEmpty() ->
                SshCredential.Password(credentials.password)
            else -> return ConnectionTestResult.Failed(
                MobileError.local("auth_missing", "请填写密码或选择 SSH Key", false),
            )
        }
        val sessionId = "test-" + UUID.randomUUID()
        var outcome: SshConnectOutcome
        val elapsedNanos = measureNanoTime {
            outcome = engine.connect(
                SshConnectRequest(
                    sessionId = sessionId,
                    route = SshRoute(listOf(RouteHop.Target(connection.host, connection.port))),
                    username = connection.username,
                    credential = credential,
                    hostKeyPolicy = HostKeyPolicy.PROMPT_UNKNOWN_BLOCK_CHANGED,
                    cols = 80,
                    rows = 24,
                    encoding = connection.encoding.wireName,
                ),
            )
        }
        val elapsedMs = (elapsedNanos / 1_000_000L).coerceAtLeast(1L)
        return try {
            when (val value = outcome) {
                is SshConnectOutcome.Connected -> ConnectionTestResult.Authenticated(elapsedMs)
                is SshConnectOutcome.HostKeyDecisionRequired -> ConnectionTestResult.Reachable(elapsedMs)
                is SshConnectOutcome.Failed -> ConnectionTestResult.Failed(value.error)
            }
        } finally {
            engine.disconnect(sessionId)
        }
    }
}
