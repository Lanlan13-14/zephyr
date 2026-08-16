package one.zephyr.mobile.protocol.ssh

import java.io.InputStream
import java.io.StringReader
import java.net.InetSocketAddress
import java.net.Socket
import java.security.PublicKey
import java.util.EnumSet
import java.util.concurrent.ConcurrentHashMap
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
import net.schmizz.sshj.sftp.OpenMode
import net.schmizz.sshj.sftp.RenameFlags
import net.schmizz.sshj.transport.verification.HostKeyVerifier
import net.schmizz.sshj.userauth.keyprovider.KeyProvider
import net.schmizz.sshj.userauth.keyprovider.OpenSSHKeyFile
import net.schmizz.sshj.userauth.keyprovider.PKCS8KeyFile
import net.schmizz.sshj.userauth.password.PasswordFinder
import net.schmizz.sshj.userauth.password.PasswordUtils
import one.zephyr.mobile.model.MobileError

class SshRemoteFileConflict(
    val path: String,
    val remoteSize: Long,
    val remoteModifiedAt: Long,
) : IllegalStateException("远端文件已变化：$path")

private const val MAX_FILE_WRITE_BYTES = 8 * 1024 * 1024
private const val MAX_FILE_RANGE_BYTES = 32 * 1024 * 1024
private const val DEFAULT_NEW_FILE_MODE = 0x1A4 // 0644



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

    override suspend fun disconnect(sessionId: String): Unit = withContext(io) {
        sessions.remove(sessionId)?.close()
        closeEvents.remove(sessionId)
        pending.remove(sessionId)
        Unit
    }

    override suspend fun measureLatency(sessionId: String): Long? = withContext(io) {
        val live = sessions[sessionId] ?: return@withContext null
        runCatching {
            val host = live.client.remoteHostname
            val port = live.client.remotePort
            val started = System.nanoTime()
            Socket().use { socket ->
                socket.connect(InetSocketAddress(host, port), LATENCY_PROBE_TIMEOUT_MS)
            }
            ((System.nanoTime() - started) / 1_000_000L).coerceAtLeast(1L)
        }.getOrNull()
    }

    override suspend fun listDirectory(sessionId: String, path: String): Result<SftpDirectory> = withContext(io) {
        runCatching {
            val live = sessions[sessionId] ?: error("SSH 会话已断开")
            live.client.newSFTPClient().use { sftp ->
                val canonicalPath = sftp.canonicalize(path)
                val entries = sftp.ls(canonicalPath)
                    .asSequence()
                    .filterNot { it.name == "." || it.name == ".." }
                    .map { entry ->
                        val attrs = entry.attributes
                        attrs.toEntry(entry.name, entry.path)
                    }
                    .sortedWith(compareByDescending<SftpEntry> { it.isDirectory }.thenBy(String.CASE_INSENSITIVE_ORDER) { it.name })
                    .toList()
                SftpDirectory(path = canonicalPath, entries = entries)
            }
        }
    }

    override suspend fun stat(sessionId: String, path: String): Result<SftpEntry?> = withContext(io) {
        runCatching {
            val live = sessions[sessionId] ?: error("SSH 会话已断开")
            live.client.newSFTPClient().use { sftp ->
                val canonical = sftp.canonicalize(path)
                val attrs = sftp.stat(canonical)
                attrs.toEntry(canonical.substringAfterLast('/').ifBlank { "/" }, canonical)
            }
        }
    }

    override suspend fun createDirectory(sessionId: String, path: String): Result<Unit> = sftpUnit(sessionId) { mkdir(path) }

    override suspend fun createFile(sessionId: String, path: String): Result<Unit> = sftpUnit(sessionId) {
        open(path, EnumSet.of(OpenMode.WRITE, OpenMode.CREAT, OpenMode.EXCL)).use { }
    }

    override suspend fun rename(sessionId: String, from: String, to: String): Result<Unit> = sftpUnit(sessionId) {
        rename(from, to)
    }

    override suspend fun delete(sessionId: String, path: String, recursive: Boolean): Result<Unit> = sftpUnit(sessionId) {
        val attrs = stat(path)
        if (attrs.type == FileMode.Type.DIRECTORY) {
            if (recursive) removeTree(this, path) else rmdir(path)
        } else {
            rm(path)
        }
    }

    override suspend fun readFile(sessionId: String, path: String, maxBytes: Int): Result<SshRemoteFile> =
        readFileRange(sessionId, path, offset = 0L, maxBytes = maxBytes)

    override suspend fun readFileRange(
        sessionId: String,
        path: String,
        offset: Long,
        maxBytes: Int,
    ): Result<SshRemoteFile> = withContext(io) {
        runCatching {
            require(offset >= 0L) { "读取偏移无效" }
            require(maxBytes in 1..MAX_FILE_RANGE_BYTES) { "读取上限无效" }
            val live = sessions[sessionId] ?: error("SSH 会话已断开")
            live.client.newSFTPClient().use { sftp ->
                val canonicalPath = sftp.canonicalize(path)
                val attrs = sftp.stat(canonicalPath)
                require(attrs.type == FileMode.Type.REGULAR) { "只能读取普通文件" }
                val remaining = (attrs.size - offset).coerceAtLeast(0L)
                val count = minOf(remaining, maxBytes.toLong()).toInt()
                val bytes = ByteArray(count)
                if (count > 0) {
                    sftp.open(canonicalPath, EnumSet.of(OpenMode.READ)).use { remote ->
                        var done = 0
                        while (done < bytes.size) {
                            val read = remote.read(offset + done, bytes, done, bytes.size - done)
                            if (read <= 0) break
                            done += read
                        }
                        require(done == bytes.size) { "远端文件读取不完整" }
                    }
                }
                SshRemoteFile(
                    path = canonicalPath,
                    bytes = bytes,
                    size = attrs.size,
                    modifiedAt = attrs.mtime * 1_000L,
                    permissions = attrs.mode.mask and 0xFFF,
                )
            }
        }
    }

    override suspend fun writeFile(
        sessionId: String,
        path: String,
        bytes: ByteArray,
        expected: SshRemoteFileVersion?,
    ): Result<SshRemoteFileVersion> = withContext(io) {
        runCatching {
            require(bytes.size <= MAX_FILE_WRITE_BYTES) { "写入内容过大，当前上限 $MAX_FILE_WRITE_BYTES bytes" }
            val live = sessions[sessionId] ?: error("SSH 会话已断开")
            live.client.newSFTPClient().use { sftp ->
                val leaf = path.substringAfterLast('/').ifBlank { path }
                val parent = when {
                    path == leaf -> ""
                    path.lastIndexOf('/') <= 0 -> "/"
                    else -> path.substringBeforeLast('/')
                }
                val canonicalParent = when {
                    parent.isEmpty() -> sftp.canonicalize(".")
                    parent == "/" -> "/"
                    else -> sftp.canonicalize(parent)
                }
                val canonicalPath = if (leaf.isEmpty() || leaf == "/") {
                    canonicalParent
                } else if (canonicalParent == "/") {
                    "/$leaf"
                } else {
                    "$canonicalParent/$leaf"
                }
                val before = runCatching { sftp.stat(canonicalPath) }.getOrNull()
                if (expected != null) {
                    if (before == null) {
                        throw SshRemoteFileConflict(canonicalPath, 0L, 0L)
                    }
                    if (before.size != expected.size || before.mtime * 1_000L != expected.modifiedAt) {
                        throw SshRemoteFileConflict(canonicalPath, before.size, before.mtime * 1_000L)
                    }
                }
                val mode = before?.mode?.mask?.and(0xFFF) ?: DEFAULT_NEW_FILE_MODE
                val temporary = "$canonicalPath.zephyr-${java.util.UUID.randomUUID()}.tmp"
                try {
                    sftp.open(temporary, EnumSet.of(OpenMode.WRITE, OpenMode.CREAT, OpenMode.TRUNC)).use { remote ->
                        var written = 0
                        while (written < bytes.size) {
                            val count = minOf(32 * 1024, bytes.size - written)
                            remote.write(written.toLong(), bytes, written, count)
                            written += count
                        }
                    }
                    sftp.chmod(temporary, mode)
                    if (before == null) {
                        sftp.rename(temporary, canonicalPath)
                    } else {
                        sftp.rename(temporary, canonicalPath, EnumSet.of(RenameFlags.OVERWRITE))
                    }
                } catch (failure: Throwable) {
                    runCatching { sftp.rm(temporary) }
                    throw failure
                }
                val after = sftp.stat(canonicalPath)
                SshRemoteFileVersion(canonicalPath, after.size, after.mtime * 1_000L)
            }
        }
    }

    override suspend fun chmod(sessionId: String, path: String, mode: Int): Result<Unit> =
        sftpUnit(sessionId) { chmod(path, mode and 0xFFF) }

    private suspend fun sftpUnit(
        sessionId: String,
        block: net.schmizz.sshj.sftp.SFTPClient.() -> Unit,
    ): Result<Unit> = withContext(io) {
        runCatching {
            val live = sessions[sessionId] ?: error("SSH 会话已断开")
            live.client.newSFTPClient().use { it.block() }
        }
    }

    private fun net.schmizz.sshj.sftp.FileAttributes.toEntry(name: String, path: String) = SftpEntry(
        name = name,
        path = path,
        isDirectory = type == FileMode.Type.DIRECTORY,
        isSymlink = type == FileMode.Type.SYMLINK,
        size = size,
        modifiedAt = mtime * 1_000L,
        permissions = mode.mask and 0xFFF,
        owner = uid.toString(),
        group = gid.toString(),
    )

    private fun removeTree(sftp: net.schmizz.sshj.sftp.SFTPClient, path: String) {
        sftp.ls(path).filterNot { it.name == "." || it.name == ".." }.forEach { entry ->
            if (entry.isDirectory) removeTree(sftp, entry.path) else sftp.rm(entry.path)
        }
        sftp.rmdir(path)
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

    override fun acceptHostKey(sessionId: String, host: String, port: Int) {
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
        private const val LATENCY_PROBE_TIMEOUT_MS = 4_000

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
