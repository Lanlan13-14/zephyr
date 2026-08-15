package one.zephyr.mobile.app

import one.zephyr.mobile.feature.connections.ConnectionTestCredentials
import one.zephyr.mobile.feature.connections.ConnectionTestResult
import one.zephyr.mobile.feature.connections.ConnectionTester
import one.zephyr.mobile.model.Connection
import one.zephyr.mobile.model.Protocol

/** SSH authenticates through SSHJ; other protocols retain the main branch TCP latency probe. */
internal class ProtocolConnectionTester(
    private val ssh: ConnectionTester,
    private val fallback: ConnectionTester,
) : ConnectionTester {
    override suspend fun test(
        connection: Connection,
        credentials: ConnectionTestCredentials,
    ): ConnectionTestResult = if (connection.protocol == Protocol.SSH) {
        ssh.test(connection, credentials)
    } else {
        fallback.test(connection, credentials)
    }
}
