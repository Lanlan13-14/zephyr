package one.zephyr.mobile.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import one.zephyr.mobile.feature.sessions.TerminalCredentials
import one.zephyr.mobile.model.CapabilitySet
import one.zephyr.mobile.model.Connection
import one.zephyr.mobile.model.Protocol
import one.zephyr.mobile.model.Residency
import one.zephyr.mobile.protocol.ssh.SshConnectOutcome
import one.zephyr.mobile.protocol.ssh.SshConnectRequest
import one.zephyr.mobile.protocol.ssh.SshEngine

/**
 * The pool's protocol gate used the case-sensitive literal "ssh" against the
 * uppercase wireName "SSH", so acquire() rejected every connection — SSH
 * included — and SFTP / batch exec only worked after a manual home-screen
 * connection had left a live session to reuse.
 */
class ManagedSshSessionPoolGateTest {

    @Test
    fun acquireAcceptsAnSshConnectionWithoutAPriorSession() {
        val connection = sshConnection()
        var connected = false
        val pool = pool(connection) { _, _ ->
            connected = true
            SshConnectOutcome.Connected(sessionId = "s", serverBanner = "")
        }
        val lease = pool.acquire("c1")
        assertTrue(connected)
        lease.close()
    }

    @Test
    fun acquireRejectsNonSshWithTheProtocolMessage() {
        val connection = sshConnection(protocol = Protocol.TELNET)
        val pool = pool(connection) { _, _ -> SshConnectOutcome.Connected(sessionId = "s", serverBanner = "") }
        val error = runCatching { pool.acquire("c1") }.exceptionOrNull()
        assertTrue(error is IllegalArgumentException)
        assertEquals("仅 SSH 连接支持此操作", error?.message)
    }

    private fun sshConnection(protocol: Protocol = Protocol.SSH) = Connection(
        id = "c1",
        ownerUserId = "u1",
        protocol = protocol,
        name = "home",
        host = "192.0.2.10",
        port = 22,
        username = "root",
        capabilities = CapabilitySet.owner,
        residency = Residency.OWNED,
    )

    private fun pool(
        connection: Connection,
        onConnect: suspend (String, SshConnectRequest) -> SshConnectOutcome,
    ): ManagedSshSessionPool {
        val engine = object : SshEngine {
            override val isAvailable: Boolean get() = true
            override suspend fun connect(request: SshConnectRequest): SshConnectOutcome = onConnect(request.sessionId, request)
            override suspend fun disconnect(sessionId: String) {}
        }
        return ManagedSshSessionPool(
            engine = engine,
            connectionProvider = { id -> if (id == connection.id) connection else null },
            credentialsProvider = { _ -> TerminalCredentials(password = "pw".toCharArray()) },
            routePlanner = { null },
        )
    }
}
