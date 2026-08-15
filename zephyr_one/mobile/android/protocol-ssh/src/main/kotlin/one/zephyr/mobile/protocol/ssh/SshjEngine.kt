package one.zephyr.mobile.protocol.ssh

import java.io.InputStream
import java.io.StringReader
import java.security.PublicKey
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import net.schmizz.sshj.SSHClient
import net.schmizz.sshj.connection.channel.direct.PTYMode
import net.schmizz.sshj.connection.channel.direct.Session
import net.schmizz.sshj.transport.verification.HostKeyVerifier
import net.schmizz.sshj.userauth.keyprovider.KeyProvider
import net.schmizz.sshj.userauth.keyprovider.OpenSSHKeyFile
import net.schmizz.sshj.userauth.keyprovider.PKCS8KeyFile
import net.schmizz.sshj.userauth.password.PasswordFinder
import net.schmizz.sshj.userauth.password.PasswordUtils
import one.zephyr.mobile.model.MobileError

/**
 * Direct SSH via SSHJ.
 *
 * Password and private-key auth, first-seen host-key prompt, PTY + shell. Proxy / jump hops are
 * rejected until the route planner is wired through SSHJ transports.
 */
class SshjEngine(
    private val io: kotlinx.coroutines.CoroutineDispatcher = Dispatchers.IO,
) : SshEngine {

    private val sessions = ConcurrentHashMap<String, LiveSession>()
    private val pending = ConcurrentHashMap<String, HostKey>()
    private val trusted = ConcurrentHashMap<String, HostKey>()
    private val scope = CoroutineScope(SupervisorJob() + io)

    override val isAvailable: Boolean = true

    override suspend fun connect(request: SshConnectRequest): SshConnectOutcome = withContext(io) {
        if (request.route.hops.any { it !is RouteHop.Target }) {
            return@withContext SshConnectOutcome.Failed(
                MobileError.local(
                    code = "route_unsupported",
                    message = "此版本先支持直连 SSH，代理和跳板稍后接入",
                    retryable = false,
                ),
            )
        }
        val target = request.route.target
        val client = SSHClient()
        val verifier = RecordingVerifier(hostPort(target.host, target.port))
        client.addHostKeyVerifier(verifier)
        try {
            client.connect(target.host, target.port)
            authenticate(client, request)
            val session = client.startSession()
            session.allocatePTY("xterm-256color", request.cols, request.rows, 0, 0, emptyMap<PTYMode, Int>())
            val shell = session.startShell()
            sessions[request.sessionId] = LiveSession(client, session, shell)
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
                if (read == 0) continue
                trySend(buffer.copyOf(read))
            }
            close()
        }
        awaitClose { job.cancel() }
    }

    override suspend fun send(sessionId: String, bytes: ByteArray) = withContext(io) {
        val live = sessions[sessionId] ?: return@withContext
        live.shell.outputStream.write(bytes)
        live.shell.outputStream.flush()
    }

    override suspend fun resize(
        sessionId: String,
        cols: Int,
        rows: Int,
        widthPx: Int,
        heightPx: Int,
    ) = withContext(io) {
        val live = sessions[sessionId] ?: return@withContext
        runCatching {
            live.shell.javaClass.methods
                .firstOrNull { it.name == "changeWindowDimensions" && it.parameterTypes.size == 4 }
                ?.invoke(live.shell, cols, rows, widthPx, heightPx)
        }
        Unit
    }

    override suspend fun disconnect(sessionId: String) = withContext(io) {
        sessions.remove(sessionId)?.close()
        pending.remove(sessionId)
        Unit
    }

    override suspend fun listDirectory(sessionId: String, path: String): Result<List<SftpEntry>> =
        Result.failure(one.zephyr.mobile.model.MobileApiException(SFTP_BLOCKED))

    override suspend fun exec(sessionId: String, command: String): Result<SshExecResult> =
        Result.failure(one.zephyr.mobile.model.MobileApiException(SFTP_BLOCKED))

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
            SshCredential.Interactive -> error("keyboard-interactive is not wired")
        }
    }

    private inner class RecordingVerifier(private val scope: String) : HostKeyVerifier {
        @Volatile var presented: HostKey? = null
        @Volatile var accepted: Boolean = false

        override fun verify(hostname: String, port: Int, key: PublicKey): Boolean {
            val seen = HostKey(algorithm = key.algorithm, blob = key.encoded)
            presented = seen
            val known = trusted[hostPort(hostname, port)] ?: trusted[scope]
            if (known != null && known == seen) {
                accepted = true
                return true
            }
            return false
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
            closed = true
            runCatching { shell.close() }
            runCatching { session.close() }
            closeQuietly(client)
        }
    }

    companion object {
        private val SFTP_BLOCKED = MobileError.local(
            code = "engine_unavailable",
            message = "此版本尚未接入 SFTP / 远程执行",
            retryable = false,
        )

        private fun hostPort(host: String, port: Int): String = host.lowercase() + ":" + port

        private fun loadKey(pem: String, finder: PasswordFinder?): KeyProvider {
            val trimmed = pem.trim()
            return if (trimmed.contains("BEGIN OPENSSH PRIVATE KEY")) {
                OpenSSHKeyFile().also { it.init(StringReader(trimmed), finder) }
            } else {
                PKCS8KeyFile().also { it.init(StringReader(trimmed), finder) }
            }
        }

        private fun closeQuietly(client: SSHClient) {
            runCatching { client.disconnect() }
        }

        private fun mapError(error: Exception): MobileError = MobileError.local(
            code = "ssh_connect_failed",
            message = error.message?.takeIf { it.isNotBlank() } ?: error.javaClass.simpleName,
            retryable = true,
        )
    }
}
