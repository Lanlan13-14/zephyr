package one.zephyr.mobile.feature.remote

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import one.zephyr.mobile.contracts.Capability
import one.zephyr.mobile.data.repository.ConnectionRepository
import one.zephyr.mobile.data.session.SessionExecution
import one.zephyr.mobile.data.session.SessionRegistry
import one.zephyr.mobile.data.session.SessionRow
import one.zephyr.mobile.data.session.SessionTransport
import one.zephyr.mobile.model.Connection
import one.zephyr.mobile.model.MobileError
import one.zephyr.mobile.model.PageState
import one.zephyr.mobile.model.Residency
import one.zephyr.mobile.protocol.vnc.RfbPixelFormat
import one.zephyr.mobile.protocol.vnc.RfbSecurityType
import one.zephyr.mobile.protocol.vnc.VncConnectOutcome
import one.zephyr.mobile.protocol.vnc.VncConnectRequest
import one.zephyr.mobile.protocol.vnc.VncEngine

/**
 * Colour depth, as S23's 画质/颜色 tool presents it.
 *
 * Two entries rather than a free-form pixel format editor: RFB lets a client ask for almost anything,
 * but the only choice a user can act on is "fewer bytes per pixel on a slow link" versus "accurate
 * colour", and offering shift/max fields would expose a protocol detail with no product meaning.
 */
enum class VncColourDepth(val label: String, val format: RfbPixelFormat) {
    HIGH_COLOUR("16 位色 · 省流量", RfbPixelFormat.RGB565),
    TRUE_COLOUR("24 位真彩", RfbPixelFormat.RGB888),
    ;

    companion object {
        fun of(format: RfbPixelFormat): VncColourDepth =
            entries.firstOrNull { it.format == format } ?: HIGH_COLOUR
    }
}

/**
 * S23 VNC.
 *
 * Shares [RemoteSessionController], the viewport, both touch modes and the whole chrome with S22; the
 * differences are the four things RFB does differently - a security type instead of a certificate, a
 * password prompt instead of NLA, a pixel format instead of a codec, and no drive at all. Section 9 of
 * REMOTE_DESKTOP_EXPERIENCE.md is explicit that a VNC page must not invent a remote disk, so there is
 * no drive state here to invent one with.
 */
class VncViewModel(
    private val sessionId: String,
    private val connectionId: String,
    private val registry: SessionRegistry,
    private val findConnection: suspend (String) -> Connection?,
    private val engine: VncEngine,
    private val secretProvider: suspend (Connection) -> RemoteCredentials,
    private val clock: () -> Long = System::currentTimeMillis,
) : ViewModel() {

    private val adapter = VncProtocolAdapter(engine)

    val controller = RemoteSessionController(
        sessionId = sessionId,
        adapter = adapter,
        scope = viewModelScope,
    )

    private val connectionState = MutableStateFlow<Connection?>(null)
    private val errorState = MutableStateFlow<MobileError?>(null)
    private val authState = MutableStateFlow<RemoteAuthPrompt?>(null)
    private val loadedState = MutableStateFlow(false)
    private val statusState = MutableStateFlow(RemoteSessionStatus())
    private val depthState = MutableStateFlow(VncColourDepth.HIGH_COLOUR)

    private val messages = MutableSharedFlow<String>(extraBufferCapacity = 4)
    val message: SharedFlow<String> = messages

    /** Remote clipboard text waiting for a decision. See the RDP note: the offer carries a preview. */
    private var pendingRemoteClipboard: String? = null

    private val clipboardToLocal = MutableSharedFlow<String>(extraBufferCapacity = 1)

    val localClipboardWrites: SharedFlow<String> = clipboardToLocal

    private val titleState = MutableStateFlow<String?>(null)

    /** The remote desktop name from the handshake. Shown in the status pill once it is known. */
    val title: StateFlow<String?> = titleState.asStateFlow()

    val frameRevision: StateFlow<Int> get() = controller.frameRevision

    private var frameJob: Job? = null
    private var clipboardJob: Job? = null
    private var watchdogJob: Job? = null
    private var reconnectJob: Job? = null

    /**
     * A password the user typed after the stored one was refused.
     *
     * Held here rather than written back to the mirror: the stored secret is the owner's, an
     * interactive retry is this session's, and persisting it would silently rewrite a shared
     * resource's credential from a failed login.
     */
    private var interactivePassword: CharArray? = null

    private var securityLabel: String? = null

    val state: StateFlow<PageState<RemoteContent>> = combine(
        connectionState,
        controller.state,
        registry.observe(sessionId),
        combine(errorState, authState, loadedState, statusState) { error, auth, loaded, status ->
            Aux(error, auth, loaded, status)
        },
        depthState,
    ) { connection, surface, row, aux, depth ->
        derive(connection, surface, row, aux, depth)
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(STOP_TIMEOUT_MS), PageState.InitialLoading)

    private data class Aux(
        val error: MobileError?,
        val auth: RemoteAuthPrompt?,
        val loaded: Boolean,
        val status: RemoteSessionStatus,
    )

    private fun derive(
        connection: Connection?,
        surface: RemoteSurfaceState,
        row: SessionRow?,
        aux: Aux,
        depth: VncColourDepth,
    ): PageState<RemoteContent> {
        if (!aux.loaded) return PageState.InitialLoading
        if (connection == null) return PageState.NotFoundOrRevoked
        if (row?.revoked == true) return PageState.NotFoundOrRevoked
        if (!connection.capabilities.canUse) {
            return PageState.PermissionDenied(Capability.USE, "已失去该连接的使用权限")
        }
        // An auth prompt is not an error: it is a question. Returning RetryableError here would show
        // a retry button where the user needs a password field (ADR-005).
        if (aux.auth == null) {
            aux.error?.let { error ->
                return if (error.retryable) PageState.RetryableError(error) else PageState.FatalIncompatible(error)
            }
        }
        val viewOnly = !connection.capabilities.canControl
        return PageState.Content(
            RemoteContent(
                connection = connection,
                surface = surface,
                status = aux.status,
                transport = row?.transport ?: SessionTransport.DISCONNECTED,
                dock = RemoteDockItem.forProtocol(connection.protocol),
                engineAvailable = engine.isAvailable,
                viewOnly = viewOnly,
                executionDisclosure = disclosureFor(connection, viewOnly),
                securityWarning = securityWarning(),
                certificatePrompt = null,
                authPrompt = aux.auth,
                clipboardPrompt = surface.pendingClipboard,
                securityLabel = securityLabel,
                pixelFormatLabel = depth.label,
            ),
        )
    }

    /**
     * The weak-transport warning.
     *
     * Only shown once the security type is actually known, because section 10 forbids describing a
     * plain VNC password as strong encryption *and* forbids guessing: before the handshake there is
     * nothing truthful to say about the transport.
     */
    private fun securityWarning(): String? =
        if (securityLabel != null && securityLabel!!.contains(WEAK_SECURITY_MARKER)) {
            RemoteDisclosure.VNC_PASSWORD
        } else {
            null
        }

    private fun disclosureFor(connection: Connection, viewOnly: Boolean): String? {
        if (viewOnly) return RemoteDisclosure.VIEW_ONLY
        if (connection.residency != Residency.SHARED_ONLINE_ONLY) return null
        return if (connection.sharedUsePolicy.materialTouchesDevice) {
            RemoteDisclosure.DIRECT
        } else {
            RemoteDisclosure.RELAY
        }
    }

    init {
        viewModelScope.launch {
            val connection = findConnection(connectionId)
            connectionState.value = connection
            loadedState.value = true
            if (connection != null) {
                controller.viewOnly = !connection.capabilities.canControl
                // Sensitivity and touch mode live in RdpSettings, but the gesture layer is shared and
                // the user set them once: honouring them for VNC too is what makes the two screens feel
                // like one product rather than two ports.
                controller.setPointerMode(RemotePointerMode.of(connection.rdp.touchMode))
                controller.setSensitivity(connection.rdp.touchSensitivity)
            }
        }
    }

    // ---- lifecycle -------------------------------------------------------------------------------

    /** Opens the session. Explicit, so a restored workspace tab shows a framebuffer only on request. */
    fun connect() {
        val connection = connectionState.value ?: return
        reconnectJob?.cancel()
        errorState.value = null
        authState.value = null
        registerRow(connection, SessionTransport.CONNECTING)
        advance(RemotePhase.CONNECTING)

        viewModelScope.launch {
            val stored = runCatching { secretProvider(connection) }.getOrDefault(RemoteCredentials())
            val password = (interactivePassword ?: stored.password)?.copyOf()
            val request = VncConnectRequest(
                sessionId = sessionId,
                host = connection.host,
                port = connection.port,
                password = password,
                shared = true,
                // Sent to the server as well as enforced locally: a view-only grant should not rely on
                // the client choosing not to send input.
                viewOnly = !connection.capabilities.canControl,
                preferredPixelFormat = depthState.value.format,
            )
            when (val outcome = engine.connect(request)) {
                is VncConnectOutcome.Connected -> {
                    securityLabel = RfbSecurityType.name(outcome.securityType) + " · " + outcome.version.wire.trim()
                    depthState.value = VncColourDepth.of(outcome.pixelFormat)
                    if (outcome.desktopName.isNotEmpty()) titleState.value = outcome.desktopName
                    controller.onRemoteSize(outcome.widthPx, outcome.heightPx)
                    statusState.value = statusState.value.copy(
                        remoteWidthPx = outcome.widthPx,
                        remoteHeightPx = outcome.heightPx,
                        negotiatedLabel = outcome.widthPx.toString() + "x" + outcome.heightPx +
                            " · " + VncColourDepth.of(outcome.pixelFormat).label,
                    )
                    authState.value = null
                    // FIRST_FRAME rather than CONNECTED: the handshake succeeded, but section 13
                    // separates "server accepted" from "pixels arrived" precisely because a server
                    // that never sends an update is a different problem with a different fix.
                    advance(RemotePhase.FIRST_FRAME)
                    startStreams()
                    startWatchdog()
                }

                is VncConnectOutcome.AuthenticationRequired -> {
                    authState.value = RemoteAuthPrompt(outcome.reason, outcome.attemptsExhausted)
                    advance(RemotePhase.AUTHENTICATING)
                    registry.setTransport(sessionId, SessionTransport.CONNECTING, clock())
                }

                is VncConnectOutcome.Failed -> fail(outcome.error)
            }
            password?.fill('\u0000')
            stored.wipe()
        }
    }

    /**
     * Retries with a password the user typed.
     *
     * The array is taken over, not copied: the caller's copy is the one the IME produced, and having
     * two live copies of a password would defeat wiping either.
     */
    fun submitPassword(password: CharArray) {
        interactivePassword?.fill('\u0000')
        interactivePassword = password
        authState.value = null
        connect()
    }

    fun cancelAuth() {
        authState.value = null
        errorState.value = MobileError.local(
            code = "rfb_password_required",
            message = "未提供密码，连接已取消",
            retryable = true,
        )
        registry.setTransport(sessionId, SessionTransport.DISCONNECTED, clock())
        advance(RemotePhase.DISCONNECTED)
    }

    fun reconnect() {
        errorState.value = null
        authState.value = null
        statusState.value = statusState.value.copy(attempt = 0)
        connect()
    }

    fun disconnect() {
        stopStreams()
        reconnectJob?.cancel()
        registry.close(sessionId, clock())
        advance(RemotePhase.DISCONNECTED)
        viewModelScope.launch { runCatching { controller.disconnect() } }
    }

    fun minimise() = registry.setMinimised(sessionId, true)

    // ---- tools -----------------------------------------------------------------------------------

    /**
     * Changes colour depth without dropping the session.
     *
     * SetPixelFormat is a mid-session RFB client message, so this is a real change rather than a
     * reconnect in disguise; the engine reports what actually took effect and the label follows that
     * rather than the request.
     */
    fun setColourDepth(depth: VncColourDepth) {
        if (depth == depthState.value) return
        viewModelScope.launch {
            val applied = runCatching { engine.setPixelFormat(sessionId, depth.format) }
                .getOrDefault(depthState.value.format)
            depthState.value = VncColourDepth.of(applied)
            // A full repaint is required: every cached pixel is in the old format.
            controller.requestFullRepaint()
            if (VncColourDepth.of(applied) != depth) messages.tryEmit(DEPTH_UNCHANGED)
        }
    }

    fun acceptRemoteClipboard() {
        val text = pendingRemoteClipboard
        pendingRemoteClipboard = null
        controller.acceptRemoteClipboard()
        if (text != null) clipboardToLocal.tryEmit(text)
    }

    fun cancelClipboard() {
        pendingRemoteClipboard = null
        controller.cancelClipboard()
    }

    fun sendClipboardToRemote(text: String) {
        val connection = connectionState.value ?: return
        if (!connection.rdp.clipboard || !connection.capabilities.canControl) {
            messages.tryEmit(CLIPBOARD_BLOCKED)
            return
        }
        controller.sendClipboard(text)
    }

    // ---- streams ---------------------------------------------------------------------------------

    private fun startStreams() {
        frameJob?.cancel()
        frameJob = viewModelScope.launch {
            adapter.frames(sessionId).collect { patch ->
                controller.onFrame(patch)
                if (statusState.value.phase == RemotePhase.FIRST_FRAME) advance(RemotePhase.CONNECTED)
                registry.markOutput(sessionId, foreground = true)
            }
        }
        clipboardJob?.cancel()
        clipboardJob = viewModelScope.launch {
            adapter.clipboard(sessionId).collect { text ->
                val connection = connectionState.value ?: return@collect
                pendingRemoteClipboard = text
                val decision = controller.offerClipboard(
                    offer = RemoteClipboard.textOffer(text, fromRemote = true),
                    channelEnabled = connection.rdp.clipboard,
                    hasCapability = connection.capabilities.canUse,
                    policy = RemoteClipboardPolicy.ASK,
                )
                if (decision is RemoteClipboardDecision.Blocked) pendingRemoteClipboard = null
            }
        }
    }

    private fun stopStreams() {
        frameJob?.cancel()
        clipboardJob?.cancel()
        watchdogJob?.cancel()
        frameJob = null
        clipboardJob = null
        watchdogJob = null
    }

    /** Fails the session when a phase overruns, so a silent server is reported rather than spun on. */
    private fun startWatchdog() {
        watchdogJob?.cancel()
        watchdogJob = viewModelScope.launch {
            while (true) {
                delay(WATCHDOG_TICK_MS)
                val status = statusState.value
                if (!status.phase.isProgressing) continue
                if (RemotePhasePolicy.hasTimedOut(status, clock())) {
                    fail(RemotePhasePolicy.timeoutError(status.phase))
                    return@launch
                }
            }
        }
    }

    // ---- failure ---------------------------------------------------------------------------------

    private fun fail(error: MobileError) {
        stopStreams()
        errorState.value = error
        registry.setTransport(sessionId, SessionTransport.DISCONNECTED, clock())
        registry.setDetail(sessionId, error.message)
        advance(RemotePhase.DISCONNECTED)
        scheduleReconnect(error)
    }

    /**
     * Automatic reconnect after a recoverable drop.
     *
     * Gated on the error code rather than on a retry counter alone: section 13 requires a revoked
     * credential or ACL to stop and be handled, and a loop that retried those would lock the user out
     * of the one screen that could explain why.
     */
    private fun scheduleReconnect(error: MobileError) {
        if (!RemotePhasePolicy.canAutoReconnect(error)) return
        val attempt = statusState.value.attempt + 1
        if (attempt > RemotePhasePolicy.MAX_AUTO_ATTEMPTS) return
        statusState.value = statusState.value.copy(attempt = attempt)
        reconnectJob?.cancel()
        reconnectJob = viewModelScope.launch {
            advance(RemotePhase.RECONNECTING)
            delay(RemotePhasePolicy.reconnectDelayMs(attempt))
            connect()
        }
    }

    private fun advance(phase: RemotePhase) {
        statusState.value = statusState.value.advance(phase, clock())
    }

    private fun registerRow(connection: Connection, transport: SessionTransport) {
        if (registry.find(sessionId) != null) {
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
                execution = if (connection.residency == Residency.SHARED_ONLINE_ONLY &&
                    !connection.sharedUsePolicy.materialTouchesDevice
                ) {
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
        stopStreams()
        reconnectJob?.cancel()
        interactivePassword?.fill('\u0000')
        interactivePassword = null
        super.onCleared()
    }

    class Factory(
        private val sessionId: String,
        private val connectionId: String,
        private val registry: SessionRegistry,
        private val connections: ConnectionRepository,
        private val engine: VncEngine,
        private val secretProvider: suspend (Connection) -> RemoteCredentials,
    ) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T = VncViewModel(
            sessionId = sessionId,
            connectionId = connectionId,
            registry = registry,
            findConnection = { id -> connections.find(id) },
            engine = engine,
            secretProvider = secretProvider,
        ) as T
    }

    companion object {
        const val DEPTH_UNCHANGED = "服务器未接受该颜色深度，已保留当前格式"
        const val CLIPBOARD_BLOCKED = "该连接未开启剪贴板通道，或授权不包含控制权限"

        /** Present in the security label of the two types that are not transport-encrypted. */
        private const val WEAK_SECURITY_MARKER = "VNC"

        private const val WATCHDOG_TICK_MS = 1_000L
        private const val STOP_TIMEOUT_MS = 5_000L
    }
}
