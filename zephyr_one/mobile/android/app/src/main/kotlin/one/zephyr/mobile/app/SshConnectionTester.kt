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

/** One-shot SSH test used by the connection editor. Never creates a terminal tab.
 *
 * The stored route is dialled, not just the target's TCP port: a proxy or jump
 * chain is part of the connection's reachability, and testing past it would
 * report a working connection the real dialer cannot make. */
internal class DirectSshConnectionTester(
    private val engine: SshEngine,
    private val routePlanner: suspend (Connection) -> SshRoute = {
        SshRoute(listOf(RouteHop.Target(it.host, it.port)))
    },
) : ConnectionTester {
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
        val privateKey = credentials.privateKey
        val password = credentials.password
        val credential = when {
            privateKey != null && privateKey.isNotEmpty() -> SshCredential.PrivateKey(
                privateKey,
                credentials.passphrase,
            )
            password != null && password.isNotEmpty() ->
                SshCredential.Password(password)
            else -> return ConnectionTestResult.Failed(
                MobileError.local("auth_missing", "请填写密码或选择 SSH Key", false),
            )
        }
        val sessionId = "test-" + UUID.randomUUID()
        var outcome: SshConnectOutcome
        val route = try {
            routePlanner(connection)
        } catch (error: Exception) {
            /* A route that does not resolve is a configuration error, not a
             * network failure: say which field is wrong instead of timing out. */
            return ConnectionTestResult.Failed(
                MobileError.local("route_invalid", error.message ?: "路由配置无效", false),
            )
        }
        val elapsedNanos = measureNanoTime {
            outcome = engine.connect(
                SshConnectRequest(
                    sessionId = sessionId,
                    route = route,
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
