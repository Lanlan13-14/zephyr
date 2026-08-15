package one.zephyr.mobile.protocol.ssh

import java.io.InputStream
import java.io.StringReader
import java.security.PublicKey
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import kotlin.system.measureNanoTime
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withContext
import net.schmizz.sshj.SSHClient
import net.schmizz.sshj.common.SSHPacket
import net.schmizz.sshj.connection.channel.direct.PTYMode
import net.schmizz.sshj.connection.channel.direct.Session
import net.schmizz.sshj.sftp.FileMode
import net.schmizz.sshj.transport.verification.HostKeyVerifier
import net.schmizz.sshj.userauth.keyprovider.KeyProvider
import net.schmizz.sshj.userauth.keyprovider.OpenSSHKeyFile
import net.schmizz.sshj.userauth.keyprovider.PKCS8KeyFile
import net.schmizz.sshj.userauth.password.PasswordFinder
import net.schmizz.sshj.userauth.password.PasswordUtils
import one.zephyr.mobile.model.MobileError

/** Live direct SSH transport: shell, SFTP, exec and request/reply latency probes. */
class SshjEngine(
    private val io: kotlinx.coroutines.CoroutineDispatcher = Dispatchers.IO,
) : SshEngine {

    private val sessions = ConcurrentHashMap<String, LiveSession>()
    private val closeEvents = ConcurrentHashMap<String, MutableSharedFlow<Throwable>>()
    private val pending = ConcurrentHashMap<String, HostKey>()
    private val trusted = ConcurrentHashMap<String, HostKey>()
    private val scope = CoroutineScope(SupervisorJob() + io)

    override val isAvailable: Boolean = true

    override suspend fun connect(request: SshConnectRequest): SshConnectOutcome = withContext(io) {
        if (request.route.hops.any { it !is RouteHop.Target }) {
            return@withContext SshConnectOutcome.Failed(
                MobileError.local("route_unsupported", "当前 SSHJ 引擎尚未接入代理或跳板链", false),
            )
        }
        sessions.remove(request.sessionId)?.close()
        val target = request.route.target
        val client = SSHClient()
        val verifier = RecordingVerifier(hostPort(target.host, target.port))
        client.addHostKeyVerifier(verifier)
        try {
            client.connect(target.host, target.port)
            authenticate(client, request)
            val terminalSession = client.startSession()
            terminalSession.allocatePTY("xterm-256color", request.cols, request.rows, 0, 0, emptyMap<PTYMode, Int>())
            val shell = terminalSession.startShell()
            sessions[request.sessionId] = LiveSession(client, terminalSession, shell)
            closeEvents[request.sessionId] = MutableSharedFlow(replay = 1, extraBufferCapacity = 1)
            pending.remove(request.sessionId)
            SshConnectOutcome.Connected(request.sessionId, "")
        } catch (error: Exception) {
            closeQuietly(client)
            val presented = verifier.presented ?: pending[request.sessionId]
            if (presented != null && !verifier.accepted) {
                pending[request.sessionId] = presented
                return@withContext SshConnectOutcome.HostKeyDecisionRequired(presented, known = null)
            }
            SshConnectOutcome.Failed(mapError(error))
        }
    }

    override fun output(sessionId: String): Flow<ByteArray> = callbackFlow {
        val live = sessions[sessionId]
        if (live == null) {
            close()
            return@callbackFlow
        }
        val job = scope.launch {
            val buffer = ByteArray(16 * 1024)
            val input: InputStream = live.shell.inputStream
            while (!live.closed) {
                val read = runCatching { input.read(buffer) }.getOrDefault(-1)
                if (read < 0) break
                if (read > 0) trySend(buffer.copyOf(read))
            }
            sessions.remove(sessionId, live)
            live.close()
            closeEvents[sessionId]?.tryEmit(IllegalStateException("SSH 远端已断开"))
            close()
        }
        awaitClose { job.cancel() }
    }

    override fun closure(sessionId: String): Flow<Throwable> =
        closeEvents.getOrPut(sessionId) { MutableSharedFlow(replay = 1, extraBufferCapacity = 1) }.asSharedFlow()

    override fun reportFailure(sessionId: String, error: Throwable) {
        closeEvents[sessionId]?.tryEmit(error)
    }

    override suspend fun send(sessionId: String, bytes: ByteArray) = withContext(io) {
        val live = sessions[sessionId] ?: throw IllegalStateException("SSH 会话已断开")
        try {
            live.shell.outputStream.write(bytes)
            live.shell.outputStream.flush()
        } catch (error: Exception) {
            sessions.remove(sessionId, live)
            live.close()
            throw error
        }
    }

    override suspend fun resize(sessionId: String, cols: Int, rows: Int, widthPx: Int, heightPx: Int) = withContext(io) {
        val live = sessions[sessionId] ?: return@withContext
        live.shell.changeWindowDimensions(cols, rows, widthPx, heightPx)
    }

    override suspend fun disconnect(sessionId: String) = withContext(io) {
        sessions.remove(sessionId)?.close()
        closeEvents.remove(sessionId)
        pending.remove(sessionId)
    }

    override suspend fun measureLatency(sessionId: String): Long? = withContext(io) {
        val live = sessions[sessionId] ?: return@withContext null
        runCatching {
            var nanos = 0L
            nanos = measureNanoTime {
                live.client.connection
                    .sendGlobalRequest("keepalive@openssh.com", true, ByteArray(0))
                    .retrieve(5, TimeUnit.SECONDS)
            }
            (nanos / 1_000_000L).coerceAtLeast(1L)
        }.getOrNull()
    }

    override suspend fun listDirectory(sessionId: String, path: String): Result<List<SftpEntry>> = withContext(io) {
        runCatching {
            val live = sessions[sessionId] ?: error("SSH 会话已断开")
            live.client.newSFTPClient().use { sftp ->
                sftp.ls(path).filterNot { it.name == "." || it.name == ".." }.map { entry ->
                    val attrs = entry.attributes
                    SftpEntry(
                        name = entry.name,
                        path = entry.path,
                        isDirectory = entry.isDirectory,
                        isSymlink = attrs.type == FileMode.Type.SYMLINK,
                        size = attrs.size,
                        modifiedAt = attrs.mtime * 1_000L,
                        permissions = attrs.mode.mask and 0xFFF,
                        owner = attrs.uid.toString(),
                        group = attrs.gid.toString(),
                    )
                }
            }
        }
    }

    override suspend fun exec(sessionId: String, command: String): Result<SshExecResult> = withContext(io) {
        runCatching {
            require(command.isNotBlank()) { "远程命令不能为空" }
            val live = sessions[sessionId] ?: error("SSH 会话已断开")
            live.client.startSession().use { commandSession ->
                val remote = commandSession.exec(command)
                coroutineScope {
                    val stdout = async(io) { remote.inputStream.readBytes() }
                    val stderr = async(io) { remote.errorStream.readBytes() }
                    remote.join()
                    SshExecResult(remote.exitStatus ?: -1, stdout.await(), stderr.await())
                }
            }
        }
    }

    fun acceptHostKey(sessionId: String, host: String, port: Int) {
        val key = pending.remove(sessionId) ?: return
        trusted[hostPort(host, port)] = key
    }

    private fun authenticate(client: SSHClient, request: SshConnectRequest) {
        when (val credential = request.credential) {
            is SshCredential.Password -> client.authPassword(request.username, String(credential.value))
            is SshCredential.PrivateKey -> {
                val finder = credential.passphrase?.let { PasswordUtils.createOneOff(it) }
                client.authPublickey(request.username, loadKey(String(credential.pem), finder))
            }
            SshCredential.Interactive -> error("keyboard-interactive 尚未接入")
        }
    }

    private inner class RecordingVerifier(private val scope: String) : HostKeyVerifier {
        @Volatile var presented: HostKey? = null
        @Volatile var accepted: Boolean = false
        override fun verify(hostname: String, port: Int, key: PublicKey): Boolean {
            val seen = HostKey(key.algorithm, key.encoded)
            presented = seen
            val known = trusted[hostPort(hostname, port)] ?: trusted[scope]
            return (known != null && known == seen).also { accepted = it }
        }
        override fun findExistingAlgorithms(hostname: String, port: Int): List<String> = emptyList()
    }

    private data class LiveSession(
        val client: SSHClient,
        val session: Session,
        val shell: Session.Shell,
        @Volatile var closed: Boolean = false,
    ) {
        fun close() {
            if (closed) return
            closed = true
            runCatching { shell.close() }
            runCatching { session.close() }
            closeQuietly(client)
        }
    }

    companion object {
        private fun hostPort(host: String, port: Int): String = host.lowercase() + ":" + port
        private fun loadKey(pem: String, finder: PasswordFinder?): KeyProvider =
            if (pem.trim().contains("BEGIN OPENSSH PRIVATE KEY")) {
                OpenSSHKeyFile().also { it.init(StringReader(pem.trim()), finder) }
            } else {
                PKCS8KeyFile().also { it.init(StringReader(pem.trim()), finder) }
            }
        private fun closeQuietly(client: SSHClient) { runCatching { client.disconnect() } }
        private fun mapError(error: Exception): MobileError = MobileError.local(
            "ssh_connect_failed",
            error.message?.takeIf(String::isNotBlank) ?: error.javaClass.simpleName,
            true,
        )
    }
}
