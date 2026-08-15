package one.zephyr.mobile.feature.connections

import kotlinx.coroutines.test.runTest
import one.zephyr.mobile.model.Protocol
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TcpReachabilityTesterTest {

    @Test
    fun reachableReportsTheHandshakeDuration() = runTest {
        var now = 1_000L
        val tester = TcpReachabilityTester(
            nowMs = { now },
            connect = { host, port, timeout ->
                assertEquals("10.0.8.30", host)
                assertEquals(3389, port)
                assertEquals(5_000, timeout)
                now = 1_041L
            },
        )

        val result = tester.test(rdpHost()) as ConnectionTestResult.Reachable
        assertEquals(41L, result.roundTripMs)
    }

    @Test
    fun refusedConnectIsAReachabilityFailureNotAnEngineAbsence() = runTest {
        val tester = TcpReachabilityTester(
            connect = { _, _, _ -> throw java.net.ConnectException("Connection refused") },
        )

        val result = tester.test(rdpHost()) as ConnectionTestResult.Failed
        assertEquals("test_unreachable", result.error.code)
        assertTrue(result.error.retryable)
        assertTrue(result.error.message.contains("Connection refused"))
    }

    @Test
    fun emptyHostDoesNotOpenASocket() = runTest {
        var opened = false
        val tester = TcpReachabilityTester(connect = { _, _, _ -> opened = true })

        val result = tester.test(rdpHost(host = "  ")) as ConnectionTestResult.Failed
        assertEquals("test_no_host", result.error.code)
        assertEquals(false, opened)
    }
}

private fun rdpHost(host: String = "10.0.8.30") = Fixtures.connection(
    protocol = Protocol.RDP,
    host = host,
    port = 3389,
)
