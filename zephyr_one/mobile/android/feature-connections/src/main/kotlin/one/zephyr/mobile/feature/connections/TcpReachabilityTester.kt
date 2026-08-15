package one.zephyr.mobile.feature.connections

import java.net.InetSocketAddress
import java.net.Socket
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import one.zephyr.mobile.model.Connection
import one.zephyr.mobile.model.MobileError

/**
 * Local TCP reachability. Independent of any protocol engine and of the main end.
 *
 * Measures the time to complete a TCP handshake to [Connection.host]:[Connection.port]. That is
 * the "测试连接延迟" the editor already knows how to render as [ConnectionTestResult.Reachable].
 * Authentication is a different question and stays with the protocol engines.
 */
class TcpReachabilityTester(
    private val timeoutMs: Int = DEFAULT_TIMEOUT_MS,
    private val nowMs: () -> Long = System::currentTimeMillis,
    private val connect: (String, Int, Int) -> Unit = { host, port, timeout ->
        Socket().use { socket ->
            socket.connect(InetSocketAddress(host, port), timeout)
        }
    },
) : ConnectionTester {

    override suspend fun test(
        connection: Connection,
        credentials: ConnectionTestCredentials,
    ): ConnectionTestResult = withContext(Dispatchers.IO) {
        val host = connection.host.trim()
        if (host.isEmpty()) {
            return@withContext ConnectionTestResult.Failed(
                MobileError.local("test_no_host", "没有填写主机", retryable = false),
            )
        }
        if (connection.port !in 1..65_535) {
            return@withContext ConnectionTestResult.Failed(
                MobileError.local("test_bad_port", "端口无效", retryable = false),
            )
        }
        val started = nowMs()
        try {
            connect(host, connection.port, timeoutMs)
            ConnectionTestResult.Reachable((nowMs() - started).coerceAtLeast(0L))
        } catch (error: Throwable) {
            ConnectionTestResult.Failed(
                MobileError.local(
                    code = "test_unreachable",
                    message = error.message?.takeIf { it.isNotBlank() } ?: "无法连接到 ${host}:${connection.port}",
                    retryable = true,
                ),
            )
        }
    }

    companion object {
        const val DEFAULT_TIMEOUT_MS = 5_000
    }
}
