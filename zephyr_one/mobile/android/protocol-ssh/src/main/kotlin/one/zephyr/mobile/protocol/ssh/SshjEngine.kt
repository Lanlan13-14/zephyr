package one.zephyr.mobile.protocol.ssh

import java.io.File
import java.io.InputStream
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
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import net.schmizz.sshj.SSHClient
import net.schmizz.sshj.common.Buffer
import net.schmizz.sshj.common.KeyType
import net.schmizz.sshj.connection.channel.direct.PTYMode
import net.schmizz.sshj.connection.channel.direct.Session
import net.schmizz.sshj.sftp.FileMode
import net.schmizz.sshj.sftp.OpenMode
import net.schmizz.sshj.sftp.RenameFlags
import net.schmizz.sshj.sftp.SFTPClient
import net.schmizz.sshj.transport.verification.HostKeyVerifier
import net.schmizz.sshj.userauth.UserAuthException
import one.zephyr.mobile.model.MobileError

class SshRemoteFileConflict(
    val path: String,
    val remoteSize: Long,
    val remoteModifiedAt: Long,
) : IllegalStateException("远端文件已变化：$path")

private const val MAX_FILE_WRITE_BYTES = 8 * 1024 * 1024
private const val MAX_FILE_RANGE_BYTES = 32 * 1024 * 1024
private const val STREAM_CHUNK_BYTES = 256 * 1024
private const val DEFAULT_NEW_FILE_MODE = 0x1A4 // 0644




/** Live direct SSH transport: shell, SFTP, exec and request/reply latency probes. */
class SshjEngine internal constructor(
    private val io: kotlinx.coroutines.CoroutineDispatcher = Dispatchers.IO,
    private val knownHosts: SshKnownHostsBook = MemorySshKnownHostsBook(),
) : SshEngine {

    constructor() : this(Dispatchers.IO, MemorySshKnownHostsBook())

    constructor(filesDir: File) : this(
        io = Dispatchers.IO,
        knownHosts = FileSshKnownHostsBook(File(filesDir, TRUST_FILE_NAME)),
    )

    init {
        AndroidSshSecurity.configure()
    }

    private val sessions = ConcurrentHashMap<String, LiveSession>()
    private val closeEvents = ConcurrentHashMap<String, MutableSharedFlow<Throwable>>()
    private val pending = ConcurrentHashMap<String, PendingHostKey>()
    private val scope = CoroutineScope(SupervisorJob() + io)

    override val isAvailable: Boolean = true

    override suspend fun connect(request: SshConnectRequest): SshConnectOutcome = withContext(io) {
        sessions.remove(request.sessionId)?.close()
        val jumps = request.route.hops.filterIsInstance<RouteHop.SshJump>()
        if (request.route.hops.any { it !is RouteHop.Target && it !is RouteHop.SshJump }) {
            return@withContext SshConnectOutcome.Failed(
                MobileError.local("route_unsupported", "当前 SSHJ 引擎尚未接入代理链", false),
            )
        }
        val target = request.route.target
        val chain = mutableListOf<SSHClient>()
        var stage = ConnectStage.TRANSPORT
        /* Set by whichever hop presented an untrusted key before connect threw;
         * keyed by hop so a jump fingerprint is never shown as the target's. */
        var firstUntrusted: Pair<PendingHostKey, HostKey?>? = null
        /* Declared here, not inside try, so the failure path can close the
         * half-open target client after a jump error: the loop's chain holds
         * only the hops, and a leaked target transport would sit on the last
         * jump's direct-tcpip channel. */
        val client = SSHClient()
        try {
            /* Jump chain, main-end createRoutedSSHConnection semantics: hop 1 is
             * dialed directly; each next hop is reached through a direct-tcpip
             * channel on the previous client. Every hop authenticates with the
             * connection's own credential and presents its own host key, keyed by
             * the hop's host:port — approving one hop must never trust another. */
            var upstream: SSHClient? = null
            for (jump in jumps) {
                val hopClient = SSHClient()
                chain += hopClient
                val hopVerifier = RecordingVerifier(jump.host, jump.port)
                hopClient.addHostKeyVerifier(hopVerifier)
                val from = upstream
                try {
                    if (from == null) {
                        hopClient.connect(jump.host, jump.port)
                    } else {
                        /* SSHJ's jump-host transport: the direct-tcpip channel on the
                         * previous client carries this hop's handshake. connectVia is
                         * the SocketClient entry point that accepts a DirectConnection. */
                        hopClient.connectVia(from.newDirectConnection(jump.host, jump.port))
                    }
                } catch (error: Exception) {
                    val key = hopVerifier.presented
                    if (key != null && !hopVerifier.accepted && firstUntrusted == null) {
                        firstUntrusted = PendingHostKey(jump.host, jump.port, key) to hopVerifier.storedKey
                    }
                    throw error
                }
                stage = ConnectStage.AUTHENTICATION
                authenticateHop(hopClient, jump, request)
                stage = ConnectStage.TRANSPORT
                upstream = hopClient
            }
            val verifier = RecordingVerifier(target.host, target.port)
            client.addHostKeyVerifier(verifier)
            val from = upstream
            try {
                if (from == null) {
                    client.connect(target.host, target.port)
                } else {
                    client.connectVia(from.newDirectConnection(target.host, target.port))
                }
            } catch (error: Exception) {
                val key = verifier.presented
                if (key != null && !verifier.accepted && firstUntrusted == null) {
                    firstUntrusted = PendingHostKey(target.host, target.port, key) to verifier.storedKey
                }
                throw error
            }
            stage = ConnectStage.AUTHENTICATION
            authenticate(client, request)
            stage = ConnectStage.PTY
            val terminalSession = client.startSession()
            terminalSession.allocatePTY("xterm-256color", request.cols, request.rows, 0, 0, emptyMap<PTYMode, Int>())
            stage = ConnectStage.SHELL
            val shell = terminalSession.startShell()
            sessions[request.sessionId] = LiveSession(client, terminalSession, shell, chain.toList())
            closeEvents[request.sessionId] = MutableSharedFlow(replay = 1, extraBufferCapacity = 1)
            pending.remove(request.sessionId)
            SshConnectOutcome.Connected(request.sessionId, "")
        } catch (error: Exception) {
            chain.forEach(::closeQuietly)
            /* `client` is still a local here: sessions[...] is only set after a
             * fully successful open, so a failed attempt must close it directly. */
            runCatching { client.disconnect() }
            val untrusted = firstUntrusted
            if (untrusted != null) {
                pending[request.sessionId] = untrusted.first
                return@withContext SshConnectOutcome.HostKeyDecisionRequired(
                    untrusted.first.key,
                    known = untrusted.second,
                )
            }
            SshConnectOutcome.Failed(mapError(error, stage))
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

    override suspend fun send(sessionId: String, bytes: ByteArray) {
        val live = sessions[sessionId] ?: throw IllegalStateException("SSH 会话已断开")
        live.withShellWrite {
            try {
                live.shell.outputStream.write(bytes)
                live.shell.outputStream.flush()
            } catch (error: Exception) {
                sessions.remove(sessionId, live)
                live.close()
                throw error
            }
        }
    }

    override suspend fun resize(sessionId: String, cols: Int, rows: Int, widthPx: Int, heightPx: Int) = withContext(io) {
        val live = sessions[sessionId] ?: return@withContext
        live.shell.changeWindowDimensions(cols, rows, widthPx, heightPx)
    }

    override suspend fun disconnect(sessionId: String): Unit = withContext(io) {
        sessions.remove(sessionId)?.close()
        closeEvents.remove(sessionId)
        // Pending trust is a user decision, not a live socket. Clearing it here is
        // why "信任并继续" after a reconnect / host recreation wrote nothing.
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
            withSftp(sessionId) { sftp ->
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
            withSftp(sessionId) { sftp ->
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
            withSftp(sessionId) { sftp ->
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
            withSftp(sessionId) { sftp ->
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
                            val count = minOf(STREAM_CHUNK_BYTES, bytes.size - written)
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
        block: suspend SFTPClient.() -> Unit,
    ): Result<Unit> = withContext(io) {
        runCatching { withSftp(sessionId) { it.block() } }
    }

    private suspend fun <T> withSftp(sessionId: String, block: suspend (SFTPClient) -> T): T {
        val live = sessions[sessionId] ?: error("SSH 会话已断开")
        return live.withSftp(block)
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

    override fun execStream(sessionId: String, command: String): Flow<SshExecEvent> = callbackFlow {
        require(command.isNotBlank()) { "远程命令不能为空" }
        val live = sessions[sessionId] ?: error("SSH 会话已断开")
        val commandSession = live.client.startSession()
        val remote = commandSession.exec(command)
        val stdoutJob = scope.launch {
            val buffer = ByteArray(16 * 1024)
            val input = remote.inputStream
            while (true) {
                val read = runCatching { input.read(buffer) }.getOrDefault(-1)
                if (read < 0) break
                if (read > 0) trySend(SshExecEvent.Stdout(buffer.copyOf(read)))
            }
        }
        val stderrJob = scope.launch {
            val buffer = ByteArray(8 * 1024)
            val input = remote.errorStream
            while (true) {
                val read = runCatching { input.read(buffer) }.getOrDefault(-1)
                if (read < 0) break
                if (read > 0) trySend(SshExecEvent.Stderr(buffer.copyOf(read)))
            }
        }
        val joinJob = scope.launch {
            runCatching { remote.join() }
            stdoutJob.join()
            stderrJob.join()
            trySend(SshExecEvent.Closed(remote.exitStatus ?: -1))
            close()
        }
        awaitClose {
            joinJob.cancel()
            stdoutJob.cancel()
            stderrJob.cancel()
            runCatching { remote.close() }
            runCatching { commandSession.close() }
        }
    }

    override suspend fun readFileStream(
        sessionId: String,
        path: String,
        offset: Long,
        onChunk: suspend (offset: Long, bytes: ByteArray, total: Long) -> Unit,
    ): Result<SshRemoteFileVersion> = withContext(io) {
        runCatching {
            require(offset >= 0L) { "读取偏移无效" }
            withSftp(sessionId) { sftp ->
                val canonicalPath = sftp.canonicalize(path)
                val attrs = sftp.stat(canonicalPath)
                require(attrs.type == FileMode.Type.REGULAR) { "只能读取普通文件" }
                sftp.open(canonicalPath, EnumSet.of(OpenMode.READ)).use { remote ->
                    var cursor = offset
                    val buffer = ByteArray(STREAM_CHUNK_BYTES)
                    while (cursor < attrs.size) {
                        val want = minOf(buffer.size.toLong(), attrs.size - cursor).toInt()
                        val read = remote.read(cursor, buffer, 0, want)
                        if (read <= 0) break
                        onChunk(cursor, buffer.copyOf(read), attrs.size)
                        cursor += read
                    }
                }
                SshRemoteFileVersion(canonicalPath, attrs.size, attrs.mtime * 1_000L)
            }
        }
    }

    override suspend fun writeFileStream(
        sessionId: String,
        path: String,
        expected: SshRemoteFileVersion?,
        next: suspend () -> ByteArray?,
    ): Result<SshRemoteFileVersion> = withContext(io) {
        runCatching {
            withSftp(sessionId) { sftp ->
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
                    if (before == null) throw SshRemoteFileConflict(canonicalPath, 0L, 0L)
                    if (before.size != expected.size || before.mtime * 1_000L != expected.modifiedAt) {
                        throw SshRemoteFileConflict(canonicalPath, before.size, before.mtime * 1_000L)
                    }
                }
                val mode = before?.mode?.mask?.and(0xFFF) ?: DEFAULT_NEW_FILE_MODE
                val temporary = "$canonicalPath.zephyr-${java.util.UUID.randomUUID()}.tmp"
                try {
                    sftp.open(temporary, EnumSet.of(OpenMode.WRITE, OpenMode.CREAT, OpenMode.TRUNC)).use { remote ->
                        var written = 0L
                        while (true) {
                            val chunk = next() ?: break
                            if (chunk.isEmpty()) continue
                            remote.write(written, chunk, 0, chunk.size)
                            written += chunk.size
                        }
                    }
                    sftp.chmod(temporary, mode)
                    if (before == null) sftp.rename(temporary, canonicalPath)
                    else sftp.rename(temporary, canonicalPath, EnumSet.of(RenameFlags.OVERWRITE))
                } catch (failure: Throwable) {
                    runCatching { sftp.rm(temporary) }
                    throw failure
                }
                val after = sftp.stat(canonicalPath)
                SshRemoteFileVersion(canonicalPath, after.size, after.mtime * 1_000L)
            }
        }
    }

    override fun acceptHostKey(sessionId: String, host: String, port: Int) {
        acceptPresented(sessionId, host, port, key = null)
    }

    override fun acceptHostKey(sessionId: String, host: String, port: Int, key: HostKey?) {
        acceptPresented(sessionId, host, port, key)
    }

    private fun acceptPresented(sessionId: String, host: String, port: Int, key: HostKey?) {
        val pendingKey = pending.remove(sessionId)
        val presented = key ?: pendingKey?.key ?: return
        val storedHost = host.ifBlank { pendingKey?.host.orEmpty() }
        val storedPort = if (port > 0) port else pendingKey?.port ?: 0
        if (storedHost.isBlank() || storedPort <= 0) return
        knownHosts.put(storedHost, storedPort, presented)
    }

    /** Test seam: the first handshake stores the presented key before the user accepts it. */
    internal fun rememberPendingForTest(sessionId: String, host: String, port: Int, key: HostKey) {
        pending[sessionId] = PendingHostKey(host, port, key)
    }

    private fun authenticate(client: SSHClient, request: SshConnectRequest) {
        applyAuth(client, request.username, request.credential)
    }

    /**
     * Main-end `connectSSHClient(hop)`: the hop authenticates as itself. Falling
     * back to the target's username/password is the failure that made a jump
     * that works on the server fail on the phone.
     */
    private fun authenticateHop(client: SSHClient, jump: RouteHop.SshJump, request: SshConnectRequest) {
        val hop = request.hopCredentials[jump.connectionId]
            ?: error("jump_auth_missing: 跳板 ${jump.host}:${jump.port} 没有可用的 SSH 凭据")
        applyAuth(client, hop.username, hop.credential)
    }

    private fun applyAuth(client: SSHClient, username: String, credential: SshCredential) {
        when (credential) {
            is SshCredential.Password -> client.authPassword(username, String(credential.value))
            is SshCredential.PrivateKey -> {
                val provider = SshPrivateKeyLoader.load(String(credential.pem), credential.passphrase)
                client.authPublickey(username, provider)
            }
            SshCredential.Interactive -> error("keyboard-interactive 尚未接入")
        }
    }

    private inner class RecordingVerifier(private val host: String, private val port: Int) : HostKeyVerifier {
        @Volatile var presented: HostKey? = null
        @Volatile var accepted: Boolean = false
        @Volatile var storedKey: HostKey? = null

        override fun verify(hostname: String, port: Int, key: PublicKey): Boolean {
            val seen = hostKeyOf(key) ?: return false
            presented = seen
            val known = knownHosts.find(this.host, this.port) ?: knownHosts.find(hostname, port)
            storedKey = known
            return (known != null && known.blob.contentEquals(seen.blob)).also { accepted = it }
        }
        override fun findExistingAlgorithms(hostname: String, port: Int): List<String> {
            val known = knownHosts.find(this.host, this.port) ?: knownHosts.find(hostname, port)
            val algorithm = known?.algorithm?.takeIf { it.isNotBlank() } ?: return emptyList()
            return listOf(algorithm)
        }
    }

    private data class LiveSession(
        val client: SSHClient,
        val session: Session,
        val shell: Session.Shell,
        /* Every hop above the target's own client. Closing the target alone
         * would leave the jump transports (and their direct-tcpip channels)
         * open on the network. */
        val chain: List<SSHClient> = emptyList(),
        @Volatile var closed: Boolean = false,
    ) {
        @Volatile private var sftpClient: SFTPClient? = null
        private val sftpMutex = Mutex()
        private val writeMutex = Mutex()

        suspend fun withShellWrite(block: suspend () -> Unit) {
            writeMutex.withLock {
                withContext(Dispatchers.IO) { block() }
            }
        }

        suspend fun <T> withSftp(block: suspend (SFTPClient) -> T): T {
            if (closed) error("SSH 会话已断开")
            return sftpMutex.withLock {
                if (closed) error("SSH 会话已断开")
                val existing = sftpClient
                val usable = existing?.takeIf { it.getSFTPEngine().getSubsystem().isOpen }
                val active = usable ?: this.client.newSFTPClient().also { sftpClient = it }
                block(active)
            }
        }

        fun close() {
            closed = true
            runCatching { sftpClient?.close() }
            sftpClient = null
            runCatching { shell.close() }
            runCatching { session.close() }
            closeQuietly(client)
            /* The jumps' transports live on their own sockets; the target's
             * direct-tcpip channel dies with them, not before. */
            chain.forEach(::closeQuietly)
        }
    }

    private enum class ConnectStage(
        val code: String,
        val label: String,
        val retryable: Boolean,
    ) {
        TRANSPORT("ssh_transport_failed", "SSH 传输握手失败", true),
        AUTHENTICATION("ssh_auth_failed", "SSH 认证失败", false),
        PTY("ssh_pty_failed", "SSH PTY 创建失败", true),
        SHELL("ssh_shell_failed", "SSH Shell 启动失败", true),
    }

    private data class PendingHostKey(
        val host: String,
        val port: Int,
        val key: HostKey,
    )

    companion object {
        const val TRUST_FILE_NAME = "ssh_known_hosts"
        private const val LATENCY_PROBE_TIMEOUT_MS = 4_000

        private fun hostPort(host: String, port: Int): String = SshKnownHostsBook.key(host, port)
        private fun closeQuietly(client: SSHClient) { runCatching { client.disconnect() } }

        fun hostKeyOf(key: PublicKey): HostKey? {
            val wire = runCatching {
                val type = KeyType.fromKey(key)
                val buffer = Buffer.PlainBuffer()
                type.putPubKeyIntoBuffer(key, buffer)
                HostKey(type.toString(), buffer.compactData)
            }.getOrNull()
            if (wire != null && wire.blob.isNotEmpty()) return wire
            val encoded = key.encoded ?: return null
            if (encoded.isEmpty()) return null
            return HostKey(key.algorithm, encoded)
        }
        private fun mapError(error: Exception, stage: ConnectStage): MobileError {
            val root = generateSequence(error as Throwable?) { it.cause }.lastOrNull() ?: error
            val cause = root.message?.takeIf(String::isNotBlank) ?: root.javaClass.simpleName
            if (error is IllegalArgumentException && cause.contains("私钥")) {
                return MobileError.local("ssh_key_invalid", cause, retryable = false)
            }
            if (error is UserAuthException) {
                return MobileError.local("ssh_auth_failed", "SSH 认证失败：$cause", retryable = false)
            }
            return MobileError.local(stage.code, "${stage.label}：$cause", retryable = stage.retryable)
        }
    }
}
