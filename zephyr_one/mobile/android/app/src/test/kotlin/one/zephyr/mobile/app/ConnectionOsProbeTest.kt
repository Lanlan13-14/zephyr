package one.zephyr.mobile.app

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.runBlocking
import one.zephyr.mobile.feature.connections.RemoteOsIcon
import one.zephyr.mobile.feature.sessions.TerminalHost
import one.zephyr.mobile.feature.sessions.TerminalOpenOutcome
import one.zephyr.mobile.feature.sessions.TerminalOpenRequest
import one.zephyr.mobile.feature.sessions.TerminalTransport
import one.zephyr.mobile.model.Connection
import one.zephyr.mobile.model.Protocol
import one.zephyr.mobile.protocol.ssh.SshExecResult
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Opening a connection on One has to identify the remote system and store it, because the main end
 * only probes sessions it opens itself.
 */
class ConnectionOsProbeTest {

    @Test
    fun anAutoConnectionTakesTheDetectedSystem() = runBlocking {
        val store = MemoryConnections(connection(icon = "auto"))
        val probe = probe(store, ExecHost(output = "ID=ubuntu\n\nLinux\n"))

        probe.probe("s1", store.saved!!)

        assertEquals("ubuntu", store.saved?.icon)
        assertEquals(listOf("icon"), store.savedMask)
    }

    @Test
    fun aConnectionThatAlreadyHasAnIconIsLeftAlone() = runBlocking {
        val store = MemoryConnections(connection(icon = "debian"))
        val probe = probe(store, ExecHost(output = "ID=ubuntu\n\nLinux\n"))

        probe.probe("s1", store.saved!!)

        assertEquals("debian", store.saved?.icon)
        assertNull(store.savedMask)
    }

    @Test
    fun anUnrecognisedProbeWritesNothing() = runBlocking {
        val store = MemoryConnections(connection(icon = "auto"))
        val probe = probe(store, ExecHost(output = ""))

        probe.probe("s1", store.saved!!)

        assertEquals("auto", store.saved?.icon)
        assertNull(store.savedMask)
    }

    @Test
    fun aNonSshConnectionIsNotProbed() = runBlocking {
        val store = MemoryConnections(connection(icon = "auto", protocol = Protocol.RDP))
        val host = ExecHost(output = "ID=debian\n\nLinux\n")
        val probe = probe(store, host)

        probe.probe("s1", store.saved!!)

        assertEquals(0, host.execs)
        assertNull(store.savedMask)
    }

    @Test
    fun theProbeUsesTheSameCommandAsTheMainEnd() = runBlocking {
        val store = MemoryConnections(connection(icon = "auto"))
        val host = ExecHost(output = "ID=debian\n\nLinux\n")
        val probe = probe(store, host)

        probe.probe("s1", store.saved!!)

        assertEquals(RemoteOsIcon.PROBE_COMMAND, host.lastCommand)
        assertTrue(host.execs == 1)
    }

    @Test
    fun aProbeThatReadsADeletedConnectionWritesNothing() = runBlocking {
        val store = MemoryConnections(connection(icon = "auto"))
        val probe = probe(store, ExecHost(output = "ID=debian\n\nLinux\n"))
        store.saved = null

        probe.probe("s1", connection(icon = "auto"))

        assertNull(store.savedMask)
    }

    private fun probe(store: MemoryConnections, host: ExecHost): ConnectionOsProbe = ConnectionOsProbe(
        host = host,
        findConnection = { id -> store.saved?.takeIf { it.id == id } },
        saveIcon = { updated, mask ->
            store.saved = updated
            store.savedMask = mask
        },
    )

    private fun connection(icon: String, protocol: Protocol = Protocol.SSH): Connection = Connection(
        id = "c-1",
        ownerUserId = "user-1",
        protocol = protocol,
        name = "home",
        host = "10.0.0.1",
        port = protocol.defaultPort,
        username = "root",
        icon = icon,
    )

    private class MemoryConnections(initial: Connection?) {
        var saved: Connection? = initial
        var savedMask: List<String>? = null
    }

    private class ExecHost(private val output: String) : TerminalHost {
        var execs = 0
        var lastCommand: String? = null
        override val isAvailable: Boolean = true
        override suspend fun open(request: TerminalOpenRequest): TerminalOpenOutcome =
            TerminalOpenOutcome.Failed(one.zephyr.mobile.model.MobileError.local("unused", "unused"))
        override fun output(sessionId: String): Flow<ByteArray> = emptyFlow()
        override fun transportFor(sessionId: String): TerminalTransport = error("unused")
        override suspend fun close(sessionId: String) = Unit
        override suspend fun exec(sessionId: String, command: String): Result<SshExecResult> {
            execs += 1
            lastCommand = command
            return Result.success(SshExecResult(0, output.toByteArray(), ByteArray(0)))
        }
    }
}
