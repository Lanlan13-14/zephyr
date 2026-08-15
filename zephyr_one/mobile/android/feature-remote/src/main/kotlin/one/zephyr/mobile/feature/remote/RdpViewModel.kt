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
import one.zephyr.mobile.model.RdpChannel
import one.zephyr.mobile.model.RdpFps
import one.zephyr.mobile.model.RdpQuality
import one.zephyr.mobile.model.RdpResolution
import one.zephyr.mobile.model.Residency
import one.zephyr.mobile.protocol.rdp.FileSyncShareProfile
import one.zephyr.mobile.protocol.rdp.PermissionState
import one.zephyr.mobile.protocol.rdp.RdpChannelPolicy
import one.zephyr.mobile.protocol.rdp.RdpConnectOutcome
import one.zephyr.mobile.protocol.rdp.RdpConnectRequest
import one.zephyr.mobile.protocol.rdp.RdpDisplayPolicy
import one.zephyr.mobile.protocol.rdp.RdpDrivePolicy
import one.zephyr.mobile.protocol.rdp.RdpDriveResolution
import one.zephyr.mobile.protocol.rdp.AndroidRdpEngine
import one.zephyr.mobile.protocol.rdp.RdpEngine
import one.zephyr.mobile.protocol.rdp.RdpGeometry
import one.zephyr.mobile.protocol.rdp.UnavailableRdpEngine

/**
 * The surface size to ask the server for.
 *
 * Separate from the viewport because they are different questions: the viewport is how much screen
 * the user has, while this is what the remote desktop should be. RDP dynamic resolution can honour a
 * device-shaped request, and REMOTE_DESKTOP_EXPERIENCE.md 4 makes that the preferred mode when it is
 * available - but a user who picked 1080p wants 1080p letterboxed, not a phone-shaped desktop.
 */
object RemoteSurfaceSizePolicy {

    fun sizeFor(
        resolution: RdpResolution,
        viewportWidthPx: Int,
        viewportHeightPx: Int,
    ): Pair<Int, Int> = when (resolution) {
        // The only mode that follows the device, so it is also the only one that can end up portrait.
        RdpResolution.AUTO -> RdpGeometry.normalize(viewportWidthPx, viewportHeightPx)
        RdpResolution.P1080 -> RdpGeometry.normalize(1920, 1080)
        RdpResolution.K2 -> RdpGeometry.normalize(2560, 1440)
        RdpResolution.K4 -> RdpGeometry.normalize(3840, 2160)
        RdpResolution.K8 -> RdpGeometry.normalize(7680, 4320)
    }

    fun labelOf(resolution: RdpResolution, widthPx: Int, heightPx: Int): String =
        resolution.wireName + " (" + widthPx + "x" + heightPx + ")"
}

/**
 * S22 RDP.
 *
 * Owns the phase machine and the channel/drive decisions; the pixels, gestures and viewport belong to
 * [RemoteSessionController], which is shared with VNC. Nothing here starts a connection on its own:
 * a restored workspace tab must not dial, exactly as on S21.
 */
class RdpViewModel(
    private val sessionId: String,
    private val connectionId: String,
    private val registry: SessionRegistry,
    private val findConnection: suspend (String) -> Connection?,
    private val engine: RdpEngine,
    /** Returns the decrypted password for one attempt. The array is wiped after the open. */
    private val secretProvider: suspend (Connection) -> CharArray?,
    /** The authorised directory as the platform reports it now, not as the config hopes. */
    private val driveProfileProvider: suspend (Connection) -> FileSyncShareProfile?,
    private val clock: () -> Long = System::currentTimeMillis,
) : ViewModel() {

    private val adapter = RdpProtocolAdapter(engine)

    /**
     * Created with defaults and reconfigured once the connection loads.
     *
     * The surface has to exist before the connection is read so the chrome and the blocked state can
     * render immediately; touch mode and sensitivity are then applied through the setters, which is
     * also the path a user taking the pointer-mode action uses.
     */
    val controller = RemoteSessionController(
        sessionId = sessionId,
        adapter = adapter,
        scope = viewModelScope,
    )

    private val connectionState = MutableStateFlow<Connection?>(null)
    private val loadedState = MutableStateFlow(false)
    private val errorState = MutableStateFlow<MobileError?>(null)
    private val certificateState = MutableStateFlow<RemoteCertificatePrompt?>(null)
    private val statusState = MutableStateFlow(RemoteSessionStatus())

    private val permissionsState = MutableStateFlow<Map<RdpChannel, PermissionState>>(emptyMap())
    private val permanentlyDeniedState = MutableStateFlow<Set<RdpChannel>>(emptySet())

    /**
     * Channels the far side actually opened.
     *
     * Section 8 freezes that a permission is requested when the session really asks, so an empty set
     * means no prompt: connecting must not ask for the microphone on the chance that the remote may
     * one day want it.
     */
    private val remoteRequestedState = MutableStateFlow<Set<RdpChannel>>(emptySet())
    private val driveState = MutableStateFlow<RdpDriveResolution?>(null)
    private val qualityState = MutableStateFlow(RdpQuality.default)
    private val resolutionState = MutableStateFlow(RdpResolution.default)
    private val fpsState = MutableStateFlow(RdpFps.default)
    @Volatile private var pendingConnect = false

    private val messages = MutableSharedFlow<String>(extraBufferCapacity = 4)
    val message: SharedFlow<String> = messages

    /**
     * Remote clipboard text waiting for the user's decision.
     *
     * Held here rather than inside the offer because [RemoteClipboardOffer] carries only a preview:
     * section 7 wants the user to recognise what is waiting, not to read it out of a state object
     * that the surface, the logs and the sync feed can all see.
     */
    private var pendingRemoteClipboard: String? = null

    private val clipboardToLocal = MutableSharedFlow<String>(extraBufferCapacity = 1)

    /** Emitted only after an explicit acceptance. The host writes the device clipboard. */
    val localClipboardWrites: SharedFlow<String> = clipboardToLocal

    val gestureSignals: SharedFlow<RemoteGestureSignal> get() = controller.gestureSignals

    private var frameJob: Job? = null
    private var clipboardJob: Job? = null
    private var watchdogJob: Job? = null

    private data class Aux(
        val error: MobileError?,
        val certificate: RemoteCertificatePrompt?,
        val loaded: Boolean,
        val status: RemoteSessionStatus,
    )

    private data class ChannelAux(
        val permissions: Map<RdpChannel, PermissionState>,
        val permanentlyDenied: Set<RdpChannel>,
        val remoteRequested: Set<RdpChannel>,
        val drive: RdpDriveResolution?,
        val quality: RdpQuality,
        val resolution: RdpResolution,
        val fps: RdpFps,
    )

    val state: StateFlow<PageState<RemoteContent>> = combine(
        connectionState,
        controller.contentState,
        registry.observe(sessionId),
        combine(errorState, certificateState, loadedState, statusState) { error, certificate, loaded, status ->
            Aux(error, certificate, loaded, status)
        },
        combine(
            permissionsState,
            permanentlyDeniedState,
            remoteRequestedState,
            driveState,
            combine(qualityState, resolutionState, fpsState) { quality, resolution, fps ->
                Triple(quality, resolution, fps)
            },
        ) { permissions, denied, requested, drive, display ->
            ChannelAux(
                permissions = permissions,
                permanentlyDenied = denied,
                remoteRequested = requested,
                drive = drive,
                quality = display.first,
                resolution = display.second,
                fps = display.third,
            )
        },
    ) { connection, surface, row, aux, channels ->
        derive(connection, surface, row, aux, channels)
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(STOP_TIMEOUT_MS), PageState.InitialLoading)

    private fun derive(
        connection: Connection?,
        surface: RemoteSurfaceState,
        row: SessionRow?,
        aux: Aux,
        channels: ChannelAux,
    ): PageState<RemoteContent> {
        if (!aux.loaded) return PageState.InitialLoading
        if (connection == null) return PageState.NotFoundOrRevoked
        if (row?.revoked == true) return PageState.NotFoundOrRevoked
        if (!connection.capabilities.canUse) {
            return PageState.PermissionDenied(Capability.USE, "已失去该连接的使用权限")
        }
        aux.error?.let { error ->
            // A missing JNI library is a local packaging fact, not a server-version clash.
            // The screen already has EngineBlockedOverlay for engineAvailable=false.
            if (error.code != AndroidRdpEngine.ENGINE_UNAVAILABLE &&
                error.code != UnavailableRdpEngine.ENGINE_UNAVAILABLE
            ) {
                return if (error.retryable) PageState.RetryableError(error) else PageState.FatalIncompatible(error)
            }
        }

        val driveAvailable = channels.drive is RdpDriveResolution.Mapped
        val decisions = RdpChannelPolicy.decide(
            settings = connection.rdp,
            permissions = channels.permissions,
            driveAvailable = driveAvailable,
        )
        val rows = RemoteChannels.rows(
            decisions = decisions,
            permissions = channels.permissions,
            permanentlyDenied = channels.permanentlyDenied,
        )
        return PageState.Content(
            RemoteContent(
                connection = connection,
                surface = surface,
                status = aux.status,
                dock = RemoteDockItem.forProtocol(connection.protocol),
                transport = row?.transport ?: SessionTransport.DISCONNECTED,
                channels = rows,
                drive = channels.drive,
                certificatePrompt = aux.certificate,
                pendingPermissions = RemoteChannels.toRequest(rows, channels.remoteRequested),
                captureLabels = RemoteChannels.activeCaptureLabels(rows),
                quality = channels.quality,
                resolution = channels.resolution,
                fpsChoice = channels.fps,
                // RDP presents a certificate rather than a bare password, so this screen has no
                // weak-transport warning to raise; section 10 puts that burden on the VNC screen.
                securityWarning = null,
                // RdpConnectOutcome has no AuthenticationRequired branch - NLA/CredSSP failures arrive
                // as Failed with a specific code, so there is nothing to re-prompt with here.
                authPrompt = null,
                clipboardPrompt = surface.pendingClipboard,
                // View-only rather than an error: OBSERVE without CONTROL is a legitimate grant, and
                // the surface stays live while every input is dropped at the controller.
                viewOnly = !connection.capabilities.canControl,
                executionDisclosure = disclosureFor(connection),
                engineAvailable = engine.isAvailable,
            ),
        )
    }

    private fun disclosureFor(connection: Connection): String? {
        if (connection.residency != Residency.SHARED_ONLINE_ONLY) return null
        return if (connection.sharedUsePolicy.materialTouchesDevice) DISCLOSURE_DIRECT else DISCLOSURE_RELAY
    }

    init {
        viewModelScope.launch {
            val connection = findConnection(connectionId)
            connectionState.value = connection
            loadedState.value = true
            if (connection != null) {
                controller.setPointerMode(RemotePointerMode.of(connection.rdp.touchMode))
                controller.setSensitivity(connection.rdp.touchSensitivity)
                controller.viewOnly = !connection.capabilities.canControl
                qualityState.value = connection.rdp.quality
                resolutionState.value = connection.rdp.resolution
                fpsState.value = connection.rdp.fps
                driveState.value = resolveDrive(connection)
                if (pendingConnect) {
                    pendingConnect = false
                    connect()
                }
            }
        }
    }

    // ---- lifecycle -------------------------------------------------------------------------------

    /**
     * Opens the session.
     *
     * The phase machine only enters phases the port can actually observe. [RdpEngine.connect] is one
     * suspending call, so RESOLVING/SECURING/AUTHENTICATING/NEGOTIATING are not knowable from here -
     * inventing them with timers would put four labels on one wait and lie about which one failed.
     * SECURING is the exception: a certificate review proves the handshake reached TLS.
     */
    fun connect() {
        val connection = connectionState.value
        if (connection == null) {
            pendingConnect = true
            return
        }
        errorState.value = null
        certificateState.value = null
        registerRow(connection, SessionTransport.CONNECTING)
        advance(RemotePhase.CONNECTING)

        viewModelScope.launch {
            val surface = controller.state.value
            val (width, height) = RemoteSurfaceSizePolicy.sizeFor(
                resolution = resolutionState.value,
                viewportWidthPx = surface.geometry.viewportWidthPx.toInt(),
                viewportHeightPx = surface.geometry.viewportHeightPx.toInt(),
            )
            val drive = driveState.value ?: resolveDrive(connection).also { driveState.value = it }
            val mapping = (drive as? RdpDriveResolution.Mapped)?.mapping
            val password = runCatching { secretProvider(connection) }.getOrNull()
            val request = RdpConnectRequest(
                sessionId = sessionId,
                host = connection.host,
                port = connection.port,
                username = connection.username,
                domain = connection.rdp.domain,
                password = password,
                widthPx = width,
                heightPx = height,
                channels = RdpChannelPolicy.granted(
                    settings = connection.rdp,
                    permissions = permissionsState.value,
                    driveAvailable = mapping != null,
                ),
                drive = mapping,
                quality = qualityState.value,
                fps = fpsState.value,
            )
            when (val outcome = engine.connect(request)) {
                is RdpConnectOutcome.Connected -> onConnected(connection, outcome, width, height)
                is RdpConnectOutcome.CertificateReview -> {
                    // Held, not failed: the handshake got far enough to present a certificate, and the
                    // session is waiting on the user rather than on the network.
                    advance(RemotePhase.SECURING)
                    certificateState.value = RemoteCertificatePrompt(
                        review = outcome.request,
                        changed = outcome.changed,
                        previousFingerprint = outcome.previousFingerprint,
                    )
                }
                is RdpConnectOutcome.Failed -> onFailed(outcome.error)
            }
            // Wiped here rather than inside the engine: an engine that keeps the array cannot extend
            // the plaintext lifetime beyond this coroutine.
            password?.fill('\u0000')
        }
    }

    private fun onConnected(
        connection: Connection,
        outcome: RdpConnectOutcome.Connected,
        requestedWidth: Int,
        requestedHeight: Int,
    ) {
        controller.onRemoteSize(outcome.widthPx, outcome.heightPx)
        registry.setTransport(sessionId, SessionTransport.CONNECTED, clock())
        statusState.value = statusState.value.copy(
            remoteWidthPx = outcome.widthPx,
            remoteHeightPx = outcome.heightPx,
            negotiatedLabel = RemoteSurfaceSizePolicy.labelOf(
                resolutionState.value,
                outcome.widthPx,
                outcome.heightPx,
            ),
            fps = fpsState.value.value,
        )
        if (outcome.widthPx != requestedWidth || outcome.heightPx != requestedHeight) {
            // Reported rather than hidden: a server that refused dynamic resolution is why the desktop
            // is letterboxed, and section 11 requires the actual negotiated size to be visible.
            messages.tryEmit(SERVER_KEPT_ITS_SIZE)
        }
        val denied = connection.rdp.requestedChannels - outcome.grantedChannels
        if (denied.isNotEmpty()) {
            messages.tryEmit(
                CHANNELS_UNAVAILABLE + denied.joinToString("、") { RemoteChannels.labelOf(it) },
            )
        }
        // FIRST_FRAME rather than CONNECTED: the transport is up but there are no pixels yet, and
        // section 13 keeps those two apart so a server that never paints is diagnosable.
        advance(RemotePhase.FIRST_FRAME)
        startFrames()
        startClipboard()
        startWatchdog()
    }

    private fun onFailed(error: MobileError) {
        errorState.value = error
        statusState.value = statusState.value.advance(RemotePhase.DISCONNECTED, clock()).copy(error = error)
        registry.setTransport(sessionId, SessionTransport.DISCONNECTED, clock())
        registry.setDetail(sessionId, error.message)
    }

    private suspend fun resolveDrive(connection: Connection): RdpDriveResolution {
        val profile = runCatching { driveProfileProvider(connection) }.getOrNull()
        return RdpDrivePolicy.resolve(
            intent = connection.rdp.storage.let { if (it) connection.fileSyncIntent else OFF_INTENT },
            profile = profile,
            // FILE_WRITE on the connection, so a read-only grant on a shared connection cannot be
            // widened by a locally chosen directory.
            connectionAllowsWrite = connection.capabilities.canWriteFiles,
            serverAllowsWrite = true,
        )
    }

    private fun startFrames() {
        frameJob?.cancel()
        frameJob = viewModelScope.launch {
            adapter.frames(sessionId).collect { patch ->
                val first = statusState.value.phase == RemotePhase.FIRST_FRAME
                controller.onFrame(patch)
                if (first) {
                    advance(RemotePhase.CONNECTED)
                    registry.markOutput(sessionId, foreground = true)
                }
            }
        }
    }

    private fun startClipboard() {
        clipboardJob?.cancel()
        clipboardJob = viewModelScope.launch {
            adapter.clipboard(sessionId).collect { text ->
                val connection = connectionState.value ?: return@collect
                pendingRemoteClipboard = text
                val decision = controller.offerClipboard(
                    offer = RemoteClipboard.textOffer(text, fromRemote = true),
                    policy = RemoteClipboardPolicy.ASK,
                    channelEnabled = connection.rdp.clipboard,
                    hasCapability = connection.capabilities.canUse,
                )
                // A blocked offer must not leave the text sitting in the ViewModel: the user will
                // never be asked about it, so holding it would be retention with no purpose.
                if (decision is RemoteClipboardDecision.Blocked) pendingRemoteClipboard = null
            }
        }
    }

    /**
     * Fails a phase that stopped making progress.
     *
     * A watchdog rather than withTimeout around the connect call, because the phase that has to time
     * out is FIRST_FRAME - the one that starts *after* connect returns.
     */
    private fun startWatchdog() {
        watchdogJob?.cancel()
        watchdogJob = viewModelScope.launch {
            while (true) {
                delay(WATCHDOG_TICK_MS)
                val status = statusState.value
                if (!status.phase.isProgressing) continue
                if (RemotePhasePolicy.hasTimedOut(status, clock())) {
                    onFailed(RemotePhasePolicy.timeoutError(status.phase))
                    return@launch
                }
            }
        }
    }

    private fun advance(phase: RemotePhase) {
        statusState.value = statusState.value.advance(phase, clock())
    }

    // ---- user actions ----------------------------------------------------------------------------

    fun acceptCertificate() {
        val prompt = certificateState.value ?: return
        certificateState.value = null
        viewModelScope.launch {
            engine.trustCertificate(sessionId, replaceExisting = prompt.changed)
            connect()
        }
        if (prompt.changed) messages.tryEmit(CERTIFICATE_CHANGED_ACCEPTED)
    }

    fun rejectCertificate() {
        certificateState.value = null
        onFailed(
            MobileError.local(
                code = "certificate_rejected",
                message = "已拒绝该服务器证书，未建立连接",
                retryable = false,
            ),
        )
    }

    fun reconnect() {
        certificateState.value = null
        errorState.value = null
        statusState.value = statusState.value.copy(attempt = statusState.value.attempt + 1)
        connect()
    }

    fun disconnect() {
        frameJob?.cancel()
        clipboardJob?.cancel()
        watchdogJob?.cancel()
        pendingConnect = false
        advance(RemotePhase.DISCONNECTED)
        registry.close(sessionId, clock())
        messages.tryEmit(SESSION_CLOSED)
        viewModelScope.launch { runCatching { controller.disconnect() } }
    }

    fun minimise() = registry.setMinimised(sessionId, true)

    /**
     * Synchronises an already-existing OS grant without presenting it as a new user action.
     *
     * The host calls this when the route appears so a permission granted in an earlier session is
     * reflected before connect. It deliberately emits no message: merely opening a screen must not
     * claim the user just changed a channel.
     */
    fun onPermissionStateObserved(
        channel: RdpChannel,
        state: PermissionState,
        permanentlyDenied: Boolean,
    ) {
        updatePermission(channel, state, permanentlyDenied)
    }

    /** The host reports one user-initiated system permission result. */
    fun onPermissionResult(channel: RdpChannel, state: PermissionState, permanentlyDenied: Boolean) {
        updatePermission(channel, state, permanentlyDenied)
        messages.tryEmit(
            if (state == PermissionState.GRANTED) {
                CHANNEL_ENABLED + RemoteChannels.labelOf(channel)
            } else {
                // One channel closes; the session continues. Section 8 makes this explicit.
                CHANNEL_CLOSED + RemoteChannels.labelOf(channel)
            },
        )
    }

    private fun updatePermission(
        channel: RdpChannel,
        state: PermissionState,
        permanentlyDenied: Boolean,
    ) {
        permissionsState.value = permissionsState.value + (channel to state)
        permanentlyDeniedState.value = if (permanentlyDenied) {
            permanentlyDeniedState.value + channel
        } else {
            permanentlyDeniedState.value - channel
        }
    }

    /** The remote opened a channel that needs a grant, which is the only time One asks. */
    fun onRemoteRequestedChannel(channel: RdpChannel) {
        remoteRequestedState.value = remoteRequestedState.value + channel
    }

    /** A newly picked directory, or a grant that went stale. */
    fun onDriveProfileChanged() {
        val connection = connectionState.value ?: return
        viewModelScope.launch { driveState.value = resolveDrive(connection) }
    }

    /** The user accepted the far side's clipboard. Only now does the text leave this ViewModel. */
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

    /**
     * Pushes the device clipboard to the session.
     *
     * Gated here as well as in the controller because the connection switch and the ACL are both
     * connection state, and section 7 requires both before anything is bridged.
     */
    fun sendClipboardToRemote(text: String) {
        val connection = connectionState.value ?: return
        if (!connection.rdp.clipboard || !connection.capabilities.canControl) {
            messages.tryEmit(CLIPBOARD_BLOCKED)
            return
        }
        controller.sendClipboard(text)
    }

    fun cycleQuality() {
        val next = RdpDisplayPolicy.nextQuality(qualityState.value)
        qualityState.value = next
        messages.tryEmit("画质模式 · " + RdpDisplayPolicy.qualityLabel(next) + " · 下次连接生效")
    }

    fun cycleResolution() {
        val next = RdpDisplayPolicy.nextResolution(resolutionState.value)
        resolutionState.value = next
        val surface = controller.state.value
        val (width, height) = RemoteSurfaceSizePolicy.sizeFor(
            resolution = next,
            viewportWidthPx = surface.geometry.viewportWidthPx.toInt(),
            viewportHeightPx = surface.geometry.viewportHeightPx.toInt(),
        )
        if (statusState.value.hasSurface && next == RdpResolution.AUTO) {
            controller.setViewportMode(RemoteViewportMode.DYNAMIC)
            viewModelScope.launch {
                runCatching { adapter.resize(sessionId, width, height) }
            }
        }
        messages.tryEmit("分辨率 · " + RdpDisplayPolicy.resolutionLabel(next))
    }

    fun cycleFps() {
        val next = RdpDisplayPolicy.nextFps(fpsState.value)
        fpsState.value = next
        statusState.value = statusState.value.copy(fps = next.value)
        messages.tryEmit("目标帧率 · " + RdpDisplayPolicy.fpsLabel(next))
    }

    fun fitViewport() {
        controller.fitToWindow()
        messages.tryEmit("已适应窗口")
    }

    fun cycleZoom() {
        val factor = controller.cycleZoom(RdpDisplayPolicy.ZOOM_FACTORS)
        messages.tryEmit("缩放 · " + RdpDisplayPolicy.zoomLabel(factor))
    }

    fun toggleJoystick() {
        val next = controller.toggleDragMode()
        messages.tryEmit(
            if (next == RemoteDragMode.VIEWPORT) "视区模式 · 拖动平移远程画面" else "指针模式 · 拖动驱动远程指针",
        )
    }

    fun sendShortcut(shortcut: RdpShortcut) {
        controller.sendInputs(shortcut.inputs())
        messages.tryEmit("已发送 " + shortcut.label)
    }

    fun clickTrackpadButton(button: Int) {
        controller.clickMouseButton(button)
    }

    fun sendCad() = sendShortcut(RdpShortcut.CAD)

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
        frameJob?.cancel()
        clipboardJob?.cancel()
        watchdogJob?.cancel()
        super.onCleared()
    }

    class Factory(
        private val sessionId: String,
        private val connectionId: String,
        private val registry: SessionRegistry,
        private val connections: ConnectionRepository,
        private val engine: RdpEngine,
        private val secretProvider: suspend (Connection) -> CharArray?,
        private val driveProfileProvider: suspend (Connection) -> FileSyncShareProfile?,
    ) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T = RdpViewModel(
            sessionId = sessionId,
            connectionId = connectionId,
            registry = registry,
            findConnection = { id -> connections.find(id) },
            engine = engine,
            secretProvider = secretProvider,
            driveProfileProvider = driveProfileProvider,
        ) as T
    }

    companion object {
        const val CERTIFICATE_CHANGED_ACCEPTED = "已接受变更后的服务器证书"
        const val SERVER_KEPT_ITS_SIZE = "服务器未接受动态分辨率，画面按远端尺寸缩放显示"
        const val CHANNELS_UNAVAILABLE = "以下通道未启用："
        const val CHANNEL_ENABLED = "已启用该通道："
        const val CHANNEL_CLOSED = "已关闭该通道，会话继续："
        const val CLIPBOARD_BLOCKED = "该连接未开启剪贴板通道，或授权不包含控制权限"
        const val SESSION_CLOSED = "会话已关闭"
        const val DISCLOSURE_RELAY = "主端 relay：凭据保留在主端"
        const val DISCLOSURE_DIRECT = "本次原生直连：加密连接材料仅驻留会话内存"
        private const val STOP_TIMEOUT_MS = 5_000L
        private const val WATCHDOG_TICK_MS = 1_000L
        private val OFF_INTENT = one.zephyr.mobile.model.FileSyncDirectoryIntent.OFF
    }
}
