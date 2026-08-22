package one.zephyr.mobile.feature.sessions

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.runBlocking
import one.zephyr.mobile.model.Protocol
import one.zephyr.mobile.protocol.ssh.SshConnectOutcome
import one.zephyr.mobile.protocol.ssh.SshConnectRequest
import one.zephyr.mobile.protocol.ssh.SshEngine
import one.zephyr.mobile.protocol.ssh.SshExecResult
import one.zephyr.mobile.protocol.ssh.SshRemoteFile
import one.zephyr.mobile.protocol.ssh.SshRemoteFileVersion
import one.zephyr.mobile.protocol.ssh.SftpDirectory
import one.zephyr.mobile.protocol.ssh.SftpEntry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SshTerminalHostTest {

    @Test
    fun missingCredentialsNeverReachTheEngine() = runBlocking {
        val engine = RecordingEngine()
        val host = SshTerminalHost(engine, findConnection = { null })
        val outcome = host.open(
            TerminalOpenRequest(
                sessionId = "s1",
                protocol = Protocol.SSH,
                host = "10.0.0.1",
                port = 22,
                username = "deploy",
            ),
        )
        assertTrue(outcome is TerminalOpenOutcome.Failed)
        assertEquals("auth_missing", (outcome as TerminalOpenOutcome.Failed).error.code)
        assertEquals(0, engine.connects)
    }

    @Test
    fun trustHostKeyForwardsTheRememberedAddress() = runBlocking {
        val engine = RecordingEngine()
        val host = SshTerminalHost(engine, findConnection = { null })
        val outcome = host.open(
            TerminalOpenRequest(
                sessionId = "s1",
                protocol = Protocol.SSH,
                host = "103.240.198.233",
                port = 22,
                username = "root",
                password = "secret".toCharArray(),
            ),
        )
        assertTrue(outcome is TerminalOpenOutcome.Failed)
        host.trustHostKey("s1")
        assertEquals(1, engine.accepts)
        assertEquals("s1", engine.acceptedSession)
        assertEquals("103.240.198.233", engine.acceptedHost)
        assertEquals(22, engine.acceptedPort)
    }

    @Test
    fun trustHostKeyStillReachesTheEngineAfterTheRequestIsDropped() = runBlocking {
        val engine = RecordingEngine()
        val host = SshTerminalHost(engine, findConnection = { null })
        host.open(
            TerminalOpenRequest(
                sessionId = "s1",
                protocol = Protocol.SSH,
                host = "10.0.0.1",
                port = 22,
                username = "root",
                password = "secret".toCharArray(),
            ),
        )
        host.close("s1")
        host.trustHostKey("s1")
        assertEquals(1, engine.accepts)
        assertEquals("s1", engine.acceptedSession)
        assertEquals("", engine.acceptedHost)
        assertEquals(0, engine.acceptedPort)
    }

    @Test
    fun aJumpRouteIsPassedToTheEngineWithPerHopCredentials() = runBlocking {
        val engine = RecordingEngine()
        val jump = one.zephyr.mobile.model.Connection(
            id = "jump-1",
            ownerUserId = "u1",
            protocol = Protocol.SSH,
            name = "bastion",
            host = "bastion.internal",
            port = 22,
            username = "jump",
        )
        val target = jump.copy(id = "target-1", name = "prod", host = "10.0.0.5", username = "root")
        val route = one.zephyr.mobile.protocol.ssh.SshRoute(
            listOf(
                one.zephyr.mobile.protocol.ssh.RouteHop.SshJump(
                    host = jump.host,
                    port = jump.port,
                    username = jump.username,
                    connectionId = jump.id,
                ),
                one.zephyr.mobile.protocol.ssh.RouteHop.Target(target.host, target.port),
            ),
        )
        val hopAuth = one.zephyr.mobile.protocol.ssh.HopAuth(
            username = "jump",
            credential = one.zephyr.mobile.protocol.ssh.SshCredential.Password("hop-secret".toCharArray()),
        )
        val host = SshTerminalHost(
            engine = engine,
            findConnection = { id -> if (id == target.id) target else null },
            routePlanner = { route },
            hopAuthProvider = { mapOf(jump.id to hopAuth) },
        )
        host.open(
            TerminalOpenRequest(
                sessionId = "s1",
                protocol = Protocol.SSH,
                host = target.host,
                port = target.port,
                username = target.username,
                connectionId = target.id,
                password = "target-secret".toCharArray(),
            ),
        )
        val seen = engine.lastRequest
        requireNotNull(seen)
        assertEquals(route, seen.route)
        assertEquals(setOf(jump.id), seen.hopCredentials.keys)
        assertEquals("root", seen.username)
    }

    @Test
    fun telnetStaysOnTheUnavailablePath() = runBlocking {
        val engine = RecordingEngine()
        val host = SshTerminalHost(engine, findConnection = { null })
        val outcome = host.open(
            TerminalOpenRequest(
                sessionId = "s1",
                protocol = Protocol.TELNET,
                host = "10.0.0.1",
                port = 23,
                username = "root",
                password = "x".toCharArray(),
            ),
        )
        assertTrue(outcome is TerminalOpenOutcome.Failed)
        assertEquals(UnavailableTerminalHost.TELNET_NO_SOCKET.code, (outcome as TerminalOpenOutcome.Failed).error.code)
        assertEquals(0, engine.connects)
    }

    private class RecordingEngine : SshEngine {
        var connects = 0
        var accepts = 0
        var acceptedSession: String? = null
        var acceptedHost: String? = null
        var acceptedPort: Int? = null
        var lastRequest: SshConnectRequest? = null
        override val isAvailable: Boolean = true
        override suspend fun connect(request: SshConnectRequest): SshConnectOutcome {
            connects += 1
            lastRequest = request
            return SshConnectOutcome.Failed(one.zephyr.mobile.model.MobileError.local("unused", "unused"))
        }
        override fun output(sessionId: String): Flow<ByteArray> = emptyFlow()
        override fun closure(sessionId: String): Flow<Throwable> = emptyFlow()
        override fun reportFailure(sessionId: String, error: Throwable) = Unit
        override suspend fun send(sessionId: String, bytes: ByteArray) = Unit
        override suspend fun resize(sessionId: String, cols: Int, rows: Int, widthPx: Int, heightPx: Int) = Unit
        override suspend fun disconnect(sessionId: String) = Unit
        override fun acceptHostKey(sessionId: String, host: String, port: Int) {
            acceptHostKey(sessionId, host, port, null)
        }
        override fun acceptHostKey(
            sessionId: String,
            host: String,
            port: Int,
            key: one.zephyr.mobile.protocol.ssh.HostKey?,
        ) {
            accepts += 1
            acceptedSession = sessionId
            acceptedHost = host
            acceptedPort = port
        }
        override suspend fun measureLatency(sessionId: String): Long? = null
        override suspend fun listDirectory(sessionId: String, path: String): Result<SftpDirectory> =
            Result.failure(IllegalStateException("unused"))
        override suspend fun stat(sessionId: String, path: String) = Result.success<SftpEntry?>(null)
        override suspend fun createDirectory(sessionId: String, path: String) = Result.success(Unit)
        override suspend fun createFile(sessionId: String, path: String) = Result.success(Unit)
        override suspend fun rename(sessionId: String, from: String, to: String) = Result.success(Unit)
        override suspend fun delete(sessionId: String, path: String, recursive: Boolean) = Result.success(Unit)
        override suspend fun readFile(sessionId: String, path: String, maxBytes: Int) =
            Result.failure<SshRemoteFile>(IllegalStateException("unused"))
        override suspend fun writeFile(
            sessionId: String,
            path: String,
            bytes: ByteArray,
            expected: SshRemoteFileVersion?,
        ) = Result.failure<SshRemoteFileVersion>(IllegalStateException("unused"))
        override suspend fun readFileRange(
            sessionId: String,
            path: String,
            offset: Long,
            maxBytes: Int,
        ) = Result.failure<SshRemoteFile>(IllegalStateException("unused"))
        override suspend fun chmod(sessionId: String, path: String, mode: Int) = Result.success(Unit)
        override suspend fun exec(sessionId: String, command: String): Result<SshExecResult> =
            Result.failure(IllegalStateException("unused"))
    }
}
