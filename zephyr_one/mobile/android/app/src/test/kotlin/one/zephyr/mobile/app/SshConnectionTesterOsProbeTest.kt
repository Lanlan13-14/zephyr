package one.zephyr.mobile.app

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.runBlocking
import one.zephyr.mobile.feature.connections.ConnectionTestCredentials
import one.zephyr.mobile.feature.connections.ConnectionTestResult
import one.zephyr.mobile.feature.connections.RemoteOsIcon
import one.zephyr.mobile.model.Connection
import one.zephyr.mobile.model.MobileError
import one.zephyr.mobile.model.Protocol
import one.zephyr.mobile.protocol.ssh.HostKey
import one.zephyr.mobile.protocol.ssh.SshConnectOutcome
import one.zephyr.mobile.protocol.ssh.SshConnectRequest
import one.zephyr.mobile.protocol.ssh.SshEngine
import one.zephyr.mobile.protocol.ssh.SshExecResult
import one.zephyr.mobile.protocol.ssh.SshRemoteFile
import one.zephyr.mobile.protocol.ssh.SshRemoteFileVersion
import one.zephyr.mobile.protocol.ssh.SftpDirectory
import one.zephyr.mobile.protocol.ssh.SftpEntry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A successful SSH test has to come back with the system it found, because that is what the editor
 * writes onto the connection. A failed test must not probe at all.
 */
class SshConnectionTesterOsProbeTest {

    @Test
    fun anAuthenticatedTestReportsTheDetectedSystem() = runBlocking {
        val engine = ProbeEngine(
            outcome = SshConnectOutcome.Connected("s", ""),
            probeOutput = "ID=debian\nPRETTY_NAME=\"Debian GNU/Linux 12\"\n\nLinux\n",
        )
        val tester = DirectSshConnectionTester(engine)

        val result = tester.test(sshConnection(), password())

        val authenticated = result as ConnectionTestResult.Authenticated
        assertEquals("debian", authenticated.detectedIcon)
        assertEquals(1, engine.execs)
        assertEquals(RemoteOsIcon.PROBE_COMMAND, engine.lastCommand)
        assertEquals(1, engine.disconnects)
    }

    @Test
    fun aFailedTestDoesNotProbe() = runBlocking {
        val engine = ProbeEngine(
            outcome = SshConnectOutcome.Failed(MobileError.local("auth_failed", "认证失败")),
        )
        val tester = DirectSshConnectionTester(engine)

        val result = tester.test(sshConnection(), password())

        assertTrue(result is ConnectionTestResult.Failed)
        assertNull(result.detectedIcon)
        assertEquals(0, engine.execs)
    }

    @Test
    fun anUnrecognisedBannerLeavesTheIconUnset() = runBlocking {
        val engine = ProbeEngine(
            outcome = SshConnectOutcome.Connected("s", ""),
            probeOutput = "no release file here",
        )
        val tester = DirectSshConnectionTester(engine)

        val result = tester.test(sshConnection(), password()) as ConnectionTestResult.Authenticated

        assertNull(result.detectedIcon)
    }

    @Test
    fun aProbeThatThrowsDoesNotFailTheTest() = runBlocking {
        val engine = ProbeEngine(
            outcome = SshConnectOutcome.Connected("s", ""),
            execFailure = IllegalStateException("channel closed"),
        )
        val tester = DirectSshConnectionTester(engine)

        val result = tester.test(sshConnection(), password())

        assertTrue(result is ConnectionTestResult.Authenticated)
        assertNull(result.detectedIcon)
    }

    private fun sshConnection(): Connection = Connection(
        id = "c-1",
        ownerUserId = "user-1",
        protocol = Protocol.SSH,
        name = "home",
        host = "10.0.0.1",
        port = 22,
        username = "root",
    )

    private fun password(): ConnectionTestCredentials = ConnectionTestCredentials(password = "secret".toCharArray())

    private class ProbeEngine(
        private val outcome: SshConnectOutcome,
        private val probeOutput: String = "",
        private val execFailure: Throwable? = null,
    ) : SshEngine {
        var execs = 0
        var disconnects = 0
        var lastCommand: String? = null
        override val isAvailable: Boolean = true

        override suspend fun connect(request: SshConnectRequest): SshConnectOutcome = outcome
        override fun output(sessionId: String): Flow<ByteArray> = emptyFlow()
        override fun closure(sessionId: String): Flow<Throwable> = emptyFlow()
        override fun reportFailure(sessionId: String, error: Throwable) = Unit
        override suspend fun send(sessionId: String, bytes: ByteArray) = Unit
        override suspend fun resize(sessionId: String, cols: Int, rows: Int, widthPx: Int, heightPx: Int) = Unit
        override suspend fun disconnect(sessionId: String) { disconnects += 1 }
        override fun acceptHostKey(sessionId: String, host: String, port: Int) = Unit
        override fun acceptHostKey(sessionId: String, host: String, port: Int, key: HostKey?) = Unit
        override suspend fun measureLatency(sessionId: String): Long? = null
        override suspend fun listDirectory(sessionId: String, path: String): Result<SftpDirectory> =
            Result.failure(IllegalStateException("unused"))
        override suspend fun stat(sessionId: String, path: String): Result<SftpEntry?> = Result.success(null)
        override suspend fun createDirectory(sessionId: String, path: String) = Result.success(Unit)
        override suspend fun createFile(sessionId: String, path: String) = Result.success(Unit)
        override suspend fun rename(sessionId: String, from: String, to: String) = Result.success(Unit)
        override suspend fun delete(sessionId: String, path: String, recursive: Boolean) = Result.success(Unit)
        override suspend fun readFile(sessionId: String, path: String, maxBytes: Int): Result<SshRemoteFile> =
            Result.failure(IllegalStateException("unused"))
        override suspend fun readFileRange(sessionId: String, path: String, offset: Long, maxBytes: Int): Result<SshRemoteFile> =
            Result.failure(IllegalStateException("unused"))
        override suspend fun writeFile(
            sessionId: String,
            path: String,
            bytes: ByteArray,
            expected: SshRemoteFileVersion?,
        ): Result<SshRemoteFileVersion> = Result.failure(IllegalStateException("unused"))
        override suspend fun chmod(sessionId: String, path: String, mode: Int) = Result.success(Unit)
        override suspend fun exec(sessionId: String, command: String): Result<SshExecResult> {
            execs += 1
            lastCommand = command
            execFailure?.let { return Result.failure(it) }
            return Result.success(SshExecResult(0, probeOutput.toByteArray(), ByteArray(0)))
        }
    }
}
