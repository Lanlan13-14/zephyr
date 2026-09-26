package one.zephyr.mobile.app

import java.lang.reflect.InvocationHandler
import java.lang.reflect.Method
import java.lang.reflect.Proxy
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import one.zephyr.mobile.feature.sessions.TerminalCredentials
import one.zephyr.mobile.model.CapabilitySet
import one.zephyr.mobile.model.Connection
import one.zephyr.mobile.model.Protocol
import one.zephyr.mobile.model.Residency
import one.zephyr.mobile.protocol.ssh.SshConnectOutcome
import one.zephyr.mobile.protocol.ssh.SshEngine

/**
 * The pool's protocol gate compared the case-sensitive literal "ssh" against
 * the enum wireName "SSH", so acquire() rejected every connection — SSH
 * included — and SFTP / batch exec only worked after a manual home-screen
 * connection had left a live session to reuse.
 *
 * The engine is proxied: the interface has dozens of members and the pool
 * only calls connect/disconnect on this path.
 */
class ManagedSshSessionPoolGateTest {

    @Test
    fun acquireAcceptsAnSshConnectionWithoutAPriorSession() = runBlocking {
        val connection = sshConnection()
        var connected = false
        val pool = pool(connection) { connected = true }
        val lease = pool.acquire("c1")
        assertTrue(connected)
        lease.close()
    }

    @Test
    fun acquireRejectsNonSshWithTheProtocolMessage() = runBlocking {
        val connection = sshConnection(protocol = Protocol.TELNET)
        val pool = pool(connection) {}
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

    private fun pool(connection: Connection, onConnect: () -> Unit): ManagedSshSessionPool {
        val loader = SshEngine::class.java.classLoader
        val types = arrayOf<Class<*>>(SshEngine::class.java)
        val engine = Proxy.newProxyInstance(loader, types, InvocationHandler { _: Any?, method: Method, args: Array<Any?>? ->
            when (method.name) {
                "isAvailable" -> true
                "connect" -> {
                    onConnect()
                    SshConnectOutcome.Connected(sessionId = "s", serverBanner = "")
                }
                "disconnect" -> null
                else -> throw UnsupportedOperationException(method.name)
            }
        }) as SshEngine
        return ManagedSshSessionPool(
            engine = engine,
            connectionProvider = { id -> if (id == connection.id) connection else null },
            credentialsProvider = { _ -> TerminalCredentials(password = "pw".toCharArray()) },
            routePlanner = { null },
        )
    }
}
