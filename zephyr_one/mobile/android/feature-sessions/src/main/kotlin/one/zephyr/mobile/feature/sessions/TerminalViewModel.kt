package one.zephyr.mobile.feature.sessions

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import one.zephyr.mobile.contracts.Capability
import one.zephyr.mobile.data.repository.ConnectionRepository
import one.zephyr.mobile.data.session.SessionExecution
import one.zephyr.mobile.data.session.SessionRegistry
import one.zephyr.mobile.data.session.SessionRow
import one.zephyr.mobile.data.session.SessionTransport
import one.zephyr.mobile.model.Connection
import one.zephyr.mobile.model.MobileError
import one.zephyr.mobile.model.PageState
import one.zephyr.mobile.model.Protocol
import one.zephyr.mobile.model.Residency
import one.zephyr.mobile.model.TerminalEncoding

/**
 * The context dock from SCREEN_CATALOG.md 8.
 *
 * [FILES] is absent for Telnet rather than disabled: the frozen rule is that Telnet has no SFTP and
 * the dock entry is hidden with an explanation, so modelling availability per protocol keeps the
 * screen from having to know the rule.
 */
enum class TerminalDockItem {
    KEYBOARD,
    COPY,
    PASTE,
    FILES,
    SNIPPETS,
    NOTES,
    STATS,
    THEME,
    DISCONNECT,
    ;

    companion object {
        /** Demo `.context-dock` order. Telnet hides 文件 rather than greying it out. */
        fun forProtocol(protocol: Protocol): List<TerminalDockItem> = listOf(
            KEYBOARD,
            COPY,
            PASTE,
            FILES,
            SNIPPETS,
            NOTES,
            STATS,
            THEME,
            DISCONNECT,
        ).filter { it != FILES || protocol.supportsFiles }
    }
}

/** A host-key decision the user must make before the session can continue (ADR-002 gate). */
data class HostKeyPrompt(val fingerprint: String, val changed: Boolean)

/** One visible terminal grid snapshot. Kept out of [TerminalContent] so page state stays lightweight. */
data class TerminalRenderFrame(
    val lines: List<TerminalLine>,
    val cursor: TerminalCursor?,
)

/** Everything S21 renders around the terminal surface. */
data class TerminalContent(
    val connection: Connection,
    val surface: TerminalSurfaceState,
    val transport: SessionTransport,
    val dock: List<TerminalDockItem>,
    /** Non-null for Telnet only: the frozen cleartext warning (TERMINAL_EXPERIENCE.md 10). */
    val cleartextWarning: String?,
    val encoding: TerminalEncoding,
    val encodingSelectable: Boolean,
    val autoLoginStatus: String?,
    val hostKeyPrompt: HostKeyPrompt?,
    val missedOutputRows: Int,
    /** Shared sessions must keep saying how they are executed (SCREEN_CATALOG.md 2.1). */
    val executionDisclosure: String?,
) {
    val followingBottom: Boolean get() = surface.followingBottom
}

/**
 * S21 SSH/Telnet 终端.
 *
 * Holds the one [TerminalSurfaceController] for this session and nothing else that can write bytes.
 * The emulator is fed here rather than in the controller because parsing is the engine's job and the
 * controller must stay pure enough to unit test; this class is the only place the two meet.
 */
class TerminalViewModel(
    private val sessionId: String,
    private val connectionId: String,
    private val registry: SessionRegistry,
    /** Narrowed to the one lookup this class performs, so S21 is unit testable without a database. */
    private val findConnection: suspend (String) -> Connection?,
    private val host: TerminalHost,
    private val emulator: TerminalEmulator,
    private val secretProvider: suspend (Connection) -> TerminalCredentials,
    private val clock: () -> Long = System::currentTimeMillis,
    private val emulatorDispatcher: CoroutineDispatcher = Dispatchers.Default,
    private val latencyRefreshMs: Long = LATENCY_REFRESH_MS,
) : ViewModel() {

    /**
     * The transport delegates per call rather than being captured once.
     *
     * The surface exists before the session is open so the user sees the chrome and the shortcut
     * matrix immediately; resolving the transport lazily means the same controller survives a
     * reconnect without being rebuilt, which is what keeps scrollback and composition alive
     * (TERMINAL_EXPERIENCE.md 9).
     */
    private val delegatingTransport = object : TerminalTransport {
        override suspend fun write(bytes: ByteArray) = host.transportFor(sessionId).write(bytes)
        override suspend fun resize(columns: Int, rows: Int, widthPx: Int, heightPx: Int) =
            host.transportFor(sessionId).resize(columns, rows, widthPx, heightPx)
        override fun onFailure(error: Throwable) = host.transportFor(sessionId).onFailure(error)
    }

    val controller = TerminalSurfaceController(
        transport = delegatingTransport,
        scope = viewModelScope,
    )

    /**
     * The live Termux session the view attaches to.
     *
     * Only a [TermuxSessionBridge] has a [com.termux.terminal.TerminalSession]. Wrapping the
     * parser as [SimpleVtEmulator] and casting that wrapper left the pane on an empty box
     * while SSH output kept arriving.
     */
    val termux: TermuxSessionBridge? = emulator as? TermuxSessionBridge

    init {
        termux?.bindWriteBytes { bytes ->
            controller.enqueueWrite(bytes)
            controller.consumeLatches()
        }
    }

    private val connectionState = MutableStateFlow<Connection?>(null)
    private val errorState = MutableStateFlow<MobileError?>(null)
    private val hostKeyState = MutableStateFlow<HostKeyPrompt?>(null)
    private val autoLoginState = MutableStateFlow<String?>(null)
    private val loadedState = MutableStateFlow(false)

    private val messages = MutableSharedFlow<String>(extraBufferCapacity = 4)
    val message: SharedFlow<String> = messages

    /** Dock taps the host must act on. The ViewModel owns no navigation. */
    private val dockEvents = MutableSharedFlow<TerminalDockItem>(extraBufferCapacity = 4)
    val dockEvent: SharedFlow<TerminalDockItem> = dockEvents

    private val titleState = MutableStateFlow<String?>(null)
    val title: StateFlow<String?> = titleState.asStateFlow()

    private var outputJob: Job? = null
    private var closureJob: Job? = null
    private var latencyJob: Job? = null
    private val emulatorLock = Any()
    private var connectRequested = false

    init {
        viewModelScope.launch {
            var lastSize: TerminalSize? = null
            controller.state.collect { surface ->
                val size = surface.size
                if (size != lastSize && size.columns > 0 && size.rows > 0) {
                    lastSize = size
                    synchronized(emulatorLock) { emulator.resize(size.columns, size.rows) }
                }
            }
        }
    }
    @Volatile private var opening = false

    private data class CachedTerminalFrame(
        val topRow: Int,
        val rows: Int,
        val frame: TerminalRenderFrame,
    )

    @Volatile
    private var cachedFrame: CachedTerminalFrame? = null

    /**
     * Bumped at most once per display frame while output is arriving.
     *
     * The cell grid is far too large to put in a state object and copy on every keystroke, so the
     * screen reads it through [visibleLines] and uses this counter as the recomposition trigger.
     * TERMINAL_EXPERIENCE.md 3 requires exactly this split: UI state may recompose freely while the
     * emulator and its scrollback are never rebuilt.
     */
    private val revisionState = MutableStateFlow(0)
    val surfaceRevision: StateFlow<Int> = revisionState.asStateFlow()
    private val redrawWake = Channel<Unit>(Channel.CONFLATED)

    val state: StateFlow<PageState<TerminalContent>> = combine(
        connectionState,
        controller.state,
        registry.observe(sessionId),
        combine(errorState, hostKeyState, autoLoginState, loadedState) { error, hostKey, autoLogin, loaded ->
            Aux(error, hostKey, autoLogin, loaded)
        },
        controller.missedOutputRows,
    ) { connection, surface, row, aux, missed ->
        derive(connection, surface, row, aux, missed)
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(STOP_TIMEOUT_MS), PageState.InitialLoading)

    private data class Aux(
        val error: MobileError?,
        val hostKey: HostKeyPrompt?,
        val autoLogin: String?,
        val loaded: Boolean,
    )

    private fun derive(
        connection: Connection?,
        surface: TerminalSurfaceState,
        row: SessionRow?,
        aux: Aux,
        missed: Int,
    ): PageState<TerminalContent> {
        if (!aux.loaded) return PageState.InitialLoading
        // A connection that vanished from the mirror, or a grant revoked while the tab was open,
        // is terminal: the tab keeps its explanation and offers no retry.
        if (connection == null) return PageState.NotFoundOrRevoked
        if (row?.revoked == true) return PageState.NotFoundOrRevoked
        if (!connection.capabilities.canUse) {
            return PageState.PermissionDenied(Capability.USE, "已失去该连接的使用权限")
        }
        aux.error?.let { error ->
            // engine_unavailable cannot be retried away, so it renders as fatal rather than
            // offering a retry button that would fail identically (ADR-002/ADR-003).
            return if (error.retryable) PageState.RetryableError(error) else PageState.FatalIncompatible(error)
        }
        return PageState.Content(
            TerminalContent(
                connection = connection,
                surface = surface,
                // DISCONNECTED rather than CONNECTING when there is no row yet: connect() registers
                // the row synchronously before it launches, so the only way to observe a missing row
                // is a tab that has never dialled - and telling that user 连接中 would hide the one
                // button that can help them.
                transport = row?.transport ?: SessionTransport.DISCONNECTED,
                dock = TerminalDockItem.forProtocol(connection.protocol),
                cleartextWarning = if (connection.protocol.isCleartext) CLEARTEXT_WARNING else null,
                encoding = connection.encoding,
                // Only Telnet negotiates a code page; SSH is UTF-8 and offering a picker would
                // suggest the user can change something that has no effect.
                encodingSelectable = connection.protocol == Protocol.TELNET,
                autoLoginStatus = aux.autoLogin,
                hostKeyPrompt = aux.hostKey,
                missedOutputRows = missed,
                executionDisclosure = disclosureFor(connection),
            ),
        )
    }

    private fun disclosureFor(connection: Connection): String? {
        if (connection.residency != Residency.SHARED_ONLINE_ONLY) return null
        return if (connection.sharedUsePolicy.materialTouchesDevice) DISCLOSURE_DIRECT else DISCLOSURE_RELAY
    }

    init {
        viewModelScope.launch {
            for (signal in redrawWake) {
                val surface = controller.state.value
                if (revisionState.subscriptionCount.value > 0) {
                    val frame = withContext(emulatorDispatcher) {
                        snapshotFrame(surface.topRow, surface.size.rows)
                    }
                    cachedFrame = CachedTerminalFrame(surface.topRow, surface.size.rows, frame)
                } else {
                    cachedFrame = null
                }
                revisionState.value = revisionState.value + 1
                registry.markOutput(sessionId, foreground = true)
                // Keep one trailing wake while a burst is arriving. The first update is immediate;
                // only subsequent network fragmentation inside the same display frame is merged.
                delay(RENDER_FRAME_INTERVAL_MS)
            }
        }
        viewModelScope.launch {
            val connection = findConnection(connectionId)
            connectionState.value = connection
            loadedState.value = true
            if (connection != null) controller.setCharset(TerminalCharset.of(connection.encoding))
            if (connectRequested) connect()
        }
    }

    // ---- lifecycle -------------------------------------------------------------------------------

    /**
     * Opens the transport.
     *
     * Explicit rather than automatic in [init]: a restored workspace tab must not dial, and the same
     * ViewModel serves both a fresh connect and a restored row. The caller decides.
     */
    fun connect() {
        connectRequested = true
        val connection = connectionState.value
        if (connection == null) return
        if (opening) return
        val existing = registry.find(sessionId)
        if (existing?.transport == SessionTransport.CONNECTED ||
            existing?.transport == SessionTransport.CONNECTING
        ) {
            return
        }
        if (!emulator.isAvailable) {
            errorState.value = UnavailableTerminalEmulator.BLOCKED
            return
        }
        if (!host.isAvailable) {
            errorState.value = if (connection.protocol == Protocol.TELNET) {
                UnavailableTerminalHost.TELNET_NO_SOCKET
            } else {
                UnavailableTerminalHost.SSH_BLOCKED
            }
            return
        }
        errorState.value = null
        opening = true
        registerRow(connection, SessionTransport.CONNECTING)

        viewModelScope.launch {
            val surface = controller.state.value
            val credentials = runCatching { secretProvider(connection) }.getOrDefault(TerminalCredentials())
            val request = TerminalOpenRequest(
                sessionId = sessionId,
                protocol = connection.protocol,
                host = connection.host,
                port = connection.port,
                username = connection.username,
                password = credentials.password,
                privateKey = credentials.privateKey,
                passphrase = credentials.passphrase,
                columns = surface.size.columns,
                rows = surface.size.rows,
                charset = TerminalCharset.of(connection.encoding),
                autoLogin = connection.protocol == Protocol.TELNET && connection.username.isNotEmpty(),
            )
            when (val outcome = host.open(request)) {
                is TerminalOpenOutcome.Opened -> {
                    registry.setTransport(sessionId, SessionTransport.CONNECTED, clock())
                    if (outcome.banner.isNotEmpty()) titleState.value = outcome.banner
                    startOutput()
                    startClosureWatch()
                    startLatencyProbe()
                }
                is TerminalOpenOutcome.HostKeyDecision -> {
                    // The session stays CONNECTING: nothing has been trusted, and a changed key
                    // blocks by default rather than prompting a yes/no on an equal footing.
                    hostKeyState.value = HostKeyPrompt(outcome.fingerprint, outcome.changed)
                }
                is TerminalOpenOutcome.Failed -> {
                    errorState.value = outcome.error
                    registry.setTransport(sessionId, SessionTransport.DISCONNECTED, clock())
                    registry.setDetail(sessionId, outcome.error.message)
                }
            }
            // The plaintext lives in this coroutine only. Wiping here rather than in a finally on the
            // host means a host implementation that keeps the array cannot extend its lifetime.
            request.wipe()
            credentials.wipe()
            opening = false
        }
    }

    private fun startClosureWatch() {
        closureJob?.cancel()
        closureJob = viewModelScope.launch {
            host.closure(sessionId).collect { error ->
                if (registry.find(sessionId)?.transport != SessionTransport.CONNECTED) return@collect
                outputJob?.cancel()
                latencyJob?.cancel()
                registry.close(sessionId, clock(), error.message ?: REMOTE_CLOSED)
                messages.tryEmit(REMOTE_CLOSED)
            }
        }
    }

    private fun startLatencyProbe() {
        latencyJob?.cancel()
        latencyJob = viewModelScope.launch {
            do {
                registry.setLatency(sessionId, runCatching { host.measureLatency(sessionId) }.getOrNull())
                if (latencyRefreshMs <= 0L) break
                delay(latencyRefreshMs)
            } while (isActive)
        }
    }

    /**
     * Streams emulator output into the surface.
     *
     * The emulator owns parsing and reports how many rows it appended; the controller decides whether
     * the viewport follows. Splitting it this way is what makes "output must not steal the viewport"
     * a property of the controller rather than of the parser.
     */
    private fun startOutput() {
        outputJob?.cancel()
        outputJob = viewModelScope.launch {
            host.output(sessionId).collect { bytes ->
                // Termux's emulator and TerminalView share one buffer. Feeding it off the main
                // thread races onDraw and paints a blank grid. Snapshot-only emulators stay on
                // the background dispatcher so unit tests do not need a Looper.
                val update = if (termux != null) {
                    withContext(Dispatchers.Main.immediate) {
                        synchronized(emulatorLock) { emulator.feed(bytes) }
                    }
                } else {
                    withContext(emulatorDispatcher) {
                        synchronized(emulatorLock) { emulator.feed(bytes) }
                    }
                }
                controller.onModes(update.modes)
                controller.onOutput(update.newRows, update.transcriptRows)
                update.title?.let { titleState.value = it }
                redrawWake.trySend(Unit)
            }
        }
    }

    /**
     * The rows currently under the viewport.
     *
     * Read on demand rather than pushed, so a 100k-row scrollback costs one visible-screen copy per
     * frame instead of living in the state object.
     */
    fun visibleLines(): List<TerminalLine> {
        if (!emulator.isAvailable) return emptyList()
        val surface = controller.state.value
        return synchronized(emulatorLock) { emulator.snapshot(surface.topRow, surface.size.rows) }
    }

    fun cursor(): TerminalCursor = synchronized(emulatorLock) { emulator.cursor() }

    fun renderFrame(topRow: Int, rows: Int): TerminalRenderFrame {
        cachedFrame?.let { cached ->
            if (cached.topRow == topRow && cached.rows == rows) return cached.frame
        }
        return snapshotFrame(topRow, rows).also { frame ->
            cachedFrame = CachedTerminalFrame(topRow, rows, frame)
        }
    }

    private fun snapshotFrame(topRow: Int, rows: Int): TerminalRenderFrame {
        if (!emulator.isAvailable) return TerminalRenderFrame(emptyList(), null)
        return synchronized(emulatorLock) {
            TerminalRenderFrame(
                lines = emulator.snapshot(topRow, rows),
                cursor = emulator.cursor(),
            )
        }
    }

    /** Scrollback as text, for copy/share of a selected range. */
    fun readScrollback(fromRow: Int, toRow: Int): String =
        synchronized(emulatorLock) { emulator.readScrollback(fromRow, toRow) }

    fun onHostKeyAccepted() {
        val prompt = hostKeyState.value ?: return
        hostKeyState.value = null
        viewModelScope.launch {
            host.trustHostKey(sessionId)
            // The first socket was intentionally rejected by the verifier. Move out of CONNECTING
            // before re-opening; otherwise connect() sees CONNECTING and returns without dialing.
            registry.setTransport(sessionId, SessionTransport.DISCONNECTED, clock())
            connect()
        }
        if (prompt.changed) messages.tryEmit(HOST_KEY_CHANGED_ACCEPTED)
    }

    fun onHostKeyRejected() {
        hostKeyState.value = null
        errorState.value = MobileError.local(
            code = "host_key_rejected",
            message = "已拒绝该主机密钥，未建立连接",
            retryable = false,
        )
        registry.setTransport(sessionId, SessionTransport.DISCONNECTED, clock())
    }

    fun reconnect() {
        hostKeyState.value = null
        errorState.value = null
        connect()
    }

    fun disconnect() {
        outputJob?.cancel()
        closureJob?.cancel()
        latencyJob?.cancel()
        registry.close(sessionId, clock())
        viewModelScope.launch { runCatching { host.close(sessionId) } }
    }

    fun minimise() = registry.setMinimised(sessionId, true)

    fun selectedText(): String = termux?.selectedText().orEmpty()

    fun clearSelection() {
        termux?.clearSelection()
    }

    fun setEncoding(encoding: TerminalEncoding) {
        controller.setCharset(TerminalCharset.of(encoding))
        connectionState.value = connectionState.value?.copy(encoding = encoding)
    }

    suspend fun listRemoteDirectory(path: String) = host.listDirectory(sessionId, path)

    suspend fun executeRemote(command: String) = host.exec(sessionId, command)

    fun executeRemoteStream(command: String) = host.execStream(sessionId, command)

    suspend fun remoteMetrics(): Result<RemoteMetrics> = host.exec(
        sessionId,
        one.zephyr.mobile.protocol.ssh.SshRemoteOps.statsCommand,
    ).mapCatching { result ->
        if (result.exitCode != 0 && result.stdout.isEmpty()) {
            error(result.stderr.toString(Charsets.UTF_8).ifBlank { "读取远端指标失败" })
        }
        val snapshot = one.zephyr.mobile.protocol.ssh.SshRemoteOps.parseRemoteStats(
            result.stdout.toString(Charsets.UTF_8),
        )
        parseRemoteMetrics(snapshot)
    }

    fun onDock(item: TerminalDockItem) {
        if (item == TerminalDockItem.DISCONNECT) {
            disconnect()
            return
        }
        dockEvents.tryEmit(item)
    }

    private fun registerRow(connection: Connection, transport: SessionTransport) {
        val existing = registry.find(sessionId)
        if (existing != null) {
            registry.setTransport(sessionId, transport, clock())
            return
        }
        registry.register(
            SessionRow(
                sessionId = sessionId,
                connectionId = connection.id,
                protocol = connection.protocol,
                name = connection.name,
                host = connection.host,
                port = connection.port,
                transport = transport,
                execution = if (connection.sharedUsePolicy.materialTouchesDevice) {
                    SessionExecution.LOCAL
                } else if (connection.residency == Residency.SHARED_ONLINE_ONLY) {
                    SessionExecution.RELAY
                } else {
                    SessionExecution.LOCAL
                },
                capabilities = connection.capabilities,
                residency = connection.residency,
                startedAt = clock(),
            ),
        )
    }

    override fun onCleared() {
        outputJob?.cancel()
        closureJob?.cancel()
        latencyJob?.cancel()
        // The emulator holds a native handle; leaking it would leak the whole scrollback buffer.
        synchronized(emulatorLock) { emulator.close() }
        super.onCleared()
    }

    class Factory(
        private val sessionId: String,
        private val connectionId: String,
        private val registry: SessionRegistry,
        private val connections: ConnectionRepository,
        private val host: TerminalHost,
        private val emulator: TerminalEmulator,
        private val secretProvider: suspend (Connection) -> TerminalCredentials,
    ) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T = TerminalViewModel(
            sessionId = sessionId,
            connectionId = connectionId,
            registry = registry,
            findConnection = { id -> connections.find(id) },
            host = host,
            emulator = emulator,
            secretProvider = secretProvider,
        ) as T
    }

    companion object {
        /** Refresh the top-bar latency reading every 5s while the session is live. */
        private const val LATENCY_REFRESH_MS = 5_000L

        const val CLEARTEXT_WARNING = "Telnet 为明文协议，凭据与输出在网络中不加密"
        const val HOST_KEY_CHANGED_ACCEPTED = "已接受变更后的主机密钥"
        const val DISCLOSURE_RELAY = "主端 relay：凭据保留在主端"
        const val DISCLOSURE_DIRECT = "本次原生直连：加密连接材料仅驻留会话内存"
        const val REMOTE_CLOSED = "SSH 连接已断开"
        private const val STOP_TIMEOUT_MS = 5_000L
        private const val RENDER_FRAME_INTERVAL_MS = 16L
    }
}

data class RemoteMetrics(val cpuPercent: Int, val memoryPercent: Int, val diskPercent: Int)

internal fun parseRemoteMetrics(text: String): RemoteMetrics =
    parseRemoteMetrics(one.zephyr.mobile.protocol.ssh.SshRemoteOps.parseRemoteStats(text))

internal fun parseRemoteMetrics(snapshot: one.zephyr.mobile.protocol.ssh.HostStatsSnapshot): RemoteMetrics {
    val disk = snapshot.disks.maxByOrNull { it.percent }?.percent ?: 0
    return RemoteMetrics(
        cpuPercent = snapshot.cpu.usagePercent.toInt().coerceIn(0, 100),
        memoryPercent = snapshot.memory.memPercent.toInt().coerceIn(0, 100),
        diskPercent = disk.coerceIn(0, 100),
    )
}

/**
 * Decrypted connection material for one open attempt.
 *
 * A holder with an explicit [wipe] rather than Strings because a String cannot be zeroed: the
 * secret-handling rule in SHARED_RESOURCE_RESIDENCY.md is that connection material for a shared
 * resource lives in session memory only, and that is unenforceable if the plaintext is interned.
 */
class TerminalCredentials(
    val password: CharArray? = null,
    val privateKey: CharArray? = null,
    val passphrase: CharArray? = null,
) {
    fun wipe() {
        password?.fill('\u0000')
        privateKey?.fill('\u0000')
        passphrase?.fill('\u0000')
    }
}
