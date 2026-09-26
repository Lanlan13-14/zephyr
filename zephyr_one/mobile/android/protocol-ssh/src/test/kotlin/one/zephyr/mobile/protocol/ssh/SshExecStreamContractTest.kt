package one.zephyr.mobile.protocol.ssh

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * execStream contract: the command reaches the engine verbatim and
 * isSessionLive reflects engine membership so the managed pool can drop stale
 * cached leases instead of handing a dead sessionId to `docker logs`.
 */
class SshExecStreamContractTest {

    private class RecordingEngine(private val liveIds: Set<String>) : SshEngine {
        override val isAvailable: Boolean = true

        val streamedCommands = mutableListOf<String>()

        override suspend fun connect(request: SshConnectRequest): SshConnectOutcome =
            SshConnectOutcome.Connected(request.sessionId, "")

        override fun output(sessionId: String): Flow<ByteArray> = flow { }
        override fun closure(sessionId: String): Flow<Throwable> = flow { }
        override fun reportFailure(sessionId: String, error: Throwable) = Unit
        override suspend fun send(sessionId: String, bytes: ByteArray) = Unit
        override suspend fun resize(sessionId: String, cols: Int, rows: Int, widthPx: Int, heightPx: Int) = Unit
        override suspend fun disconnect(sessionId: String) = Unit
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

        override fun isSessionLive(sessionId: String): Boolean = sessionId in liveIds

        override fun execStream(sessionId: String, command: String): Flow<SshExecEvent> = flow {
            streamedCommands += command
            emit(SshExecEvent.Stdout("ok".toByteArray()))
            emit(SshExecEvent.Closed(0))
        }
    }

    @Test
    fun `recording engine reports membership`() {
        val engine = RecordingEngine(setOf("managed-1"))
        assertTrue(engine.isSessionLive("managed-1"))
        assertFalse(engine.isSessionLive("managed-2"))
    }

    @Test
    fun `execStream command reaches the engine verbatim`() = runTest {
        val engine = RecordingEngine(setOf("s1"))
        val events = engine.execStream("s1", "docker logs --tail 200 --timestamps -f 'web'").toList()
        assertEquals(2, events.size)
        assertEquals(0, (events.last() as SshExecEvent.Closed).exitCode)
        assertEquals("docker logs --tail 200 --timestamps -f 'web'", engine.streamedCommands.single())
    }
}
