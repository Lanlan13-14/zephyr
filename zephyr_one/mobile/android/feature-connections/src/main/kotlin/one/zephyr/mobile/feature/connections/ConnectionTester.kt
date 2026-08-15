package one.zephyr.mobile.feature.connections

import one.zephyr.mobile.model.Connection
import one.zephyr.mobile.model.MobileError

/**
 * Outcome of the S11 "测试" action.
 *
 * Reachability and authentication are separate outcomes because they need different remedies: a
 * refused TCP connect is a host/port/route problem, a rejected credential is an auth problem, and
 * telling the user "失败" for both is the anti-pattern MOBILE_EXPERIENCE.md 6 calls out.
 */
sealed interface ConnectionTestResult {
    data class Reachable(val roundTripMs: Long) : ConnectionTestResult

    data class Authenticated(val roundTripMs: Long) : ConnectionTestResult

    data class Failed(val error: MobileError) : ConnectionTestResult
}

/**
 * Port for the connection test.
 *
 * A port rather than a direct engine call because the editor lives above the protocol layer: SSH,
 * RDP and VNC engines are gated on the M0 spikes in NATIVE_ENGINE_DECISIONS.md (ADR-002/004/005),
 * while Telnet is implemented. Wiring the concrete testers in the app module keeps this feature
 * module free of protocol dependencies and lets each protocol arrive independently.
 */
interface ConnectionTester {
    suspend fun test(connection: Connection, credentials: ConnectionTestCredentials = ConnectionTestCredentials()): ConnectionTestResult
}

class ConnectionTestCredentials(
    val password: CharArray? = null,
    val privateKey: CharArray? = null,
    val passphrase: CharArray? = null,
) {
    fun wipe() {
        password?.fill('\u0000')
        privateKey?.fill('\u0000')
        passphrase?.fill('\u0000')
    }
}

/**
 * Fallback for protocols whose engine is not available in this build.
 *
 * Returns a structured error instead of pretending the test passed. A fake success here would be
 * worse than no button: the user would save a connection believing it was verified.
 */
object UnavailableConnectionTester : ConnectionTester {
    override suspend fun test(connection: Connection, credentials: ConnectionTestCredentials): ConnectionTestResult =
        ConnectionTestResult.Failed(
            MobileError.local(
                code = "engine_unavailable",
                message = connection.protocol.wireName + " 引擎在此版本中尚不可用，无法测试",
            ),
        )
}
