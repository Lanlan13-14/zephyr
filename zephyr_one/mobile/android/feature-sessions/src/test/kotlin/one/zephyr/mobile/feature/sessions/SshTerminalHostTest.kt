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
        val host = SshTerminalHost(engine) { null }
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
    fun telnetStaysOnTheUnavailablePath() = runBlocking {
        val engine = RecordingEngine()
        val host = SshTerminalHost(engine) { null }
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
        override val isAvailable: Boolean = true
        override suspend fun connect(request: SshConnectRequest): SshConnectOutcome {
            connects += 1
            return SshConnectOutcome.Failed(one.zephyr.mobile.model.MobileError.local("unused", "unused"))
        }
        override fun output(sessionId: String): Flow<ByteArray> = emptyFlow()
        override fun closure(sessionId: String): Flow<Throwable> = emptyFlow()
        override fun reportFailure(sessionId: String, error: Throwable) = Unit
        override suspend fun send(sessionId: String, bytes: ByteArray) = Unit
        override suspend fun resize(sessionId: String, cols: Int, rows: Int, widthPx: Int, heightPx: Int) = Unit
        override suspend fun disconnect(sessionId: String) = Unit
        override fun acceptHostKey(sessionId: String, host: String, port: Int) = Unit
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
        override suspend fun exec(sessionId: String, command: String): Result<SshExecResult> =
            Result.failure(IllegalStateException("unused"))
    }
}
