package one.zephyr.mobile.protocol.rdp

import java.io.File
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.withContext
import one.zephyr.mobile.model.MobileError
import one.zephyr.mobile.model.RdpChannel

/** Android JNI implementation backed by the repository's FreeRDP C shim. */
class AndroidRdpEngine internal constructor(
    private val native: RdpNativeBridge,
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
    private val fingerprints: RdpFingerprintBook = MemoryRdpFingerprintBook(),
    homeDir: File? = null,
    installHome: (File) -> Unit = { RdpAndroidRuntime.installHome(it) },
) : RdpEngine {

    constructor() : this(JniRdpNativeBridge)

    constructor(filesDir: File) : this(
        native = JniRdpNativeBridge,
        fingerprints = FileRdpFingerprintBook(File(filesDir, TRUST_FILE_NAME)),
        homeDir = filesDir,
    )

    private val sessions = ConcurrentHashMap<String, Session>()
    private val pendingReviews = ConcurrentHashMap<String, PendingReview>()

    init {
        if (homeDir != null) installHome(homeDir)
    }

    override val isAvailable: Boolean
        get() = native.isAvailable

    override suspend fun connect(request: RdpConnectRequest): RdpConnectOutcome {
        if (!native.isAvailable) return failure(ENGINE_UNAVAILABLE, native.unavailableReason, retryable = false)
        if (request.drive != null) {
            return failure(
                DRIVE_UNSUPPORTED,
                "Android document-tree drive redirection needs a FreeRDP filesystem provider",
                retryable = false,
            )
        }
        val unsupported = request.channels.intersect(UNSUPPORTED_CHANNELS)
        if (unsupported.isNotEmpty()) {
            return failure(
                CHANNEL_UNSUPPORTED,
                "The Android FreeRDP bridge does not implement: ${unsupported.joinToString()}",
                retryable = false,
            )
        }
        if (sessions.containsKey(request.sessionId)) {
            return failure(SESSION_EXISTS, "An RDP session with this id already exists", retryable = false)
        }

        return try {
            val stored = fingerprints.find(request.host, request.port)
            val first = openNative(request, ignoreCertificate = false)
            val presented = first.fingerprint?.let(RdpFingerprintBook::normalize)?.takeIf { it.isNotEmpty() }
            if (first.outcome is RdpConnectOutcome.Connected) return first.outcome
            if (presented != null) {
                if (stored != null && stored == presented) {
                    return openNative(request, ignoreCertificate = true).outcome
                }
                pendingReviews[request.sessionId] = PendingReview(request.host, request.port, presented)
                return RdpConnectOutcome.CertificateReview(
                    request = RdpCertificateReview(
                        host = request.host,
                        port = request.port,
                        subject = request.host,
                        issuer = "",
                        notBefore = 0L,
                        notAfter = 0L,
                        sha256Fingerprint = presented,
                    ),
                    changed = stored != null,
                    previousFingerprint = stored,
                )
            }
            first.outcome
        } finally {
            request.password?.fill('\u0000')
        }
    }

    override suspend fun trustCertificate(sessionId: String, replaceExisting: Boolean) {
        val pending = pendingReviews.remove(sessionId) ?: return
        if (replaceExisting) fingerprints.remove(pending.host, pending.port)
        fingerprints.put(pending.host, pending.port, pending.fingerprint)
    }

    override fun frames(sessionId: String): Flow<RdpFrame> =
        sessions[sessionId]?.frames ?: kotlinx.coroutines.flow.emptyFlow()

    override suspend fun send(sessionId: String, event: RdpInputEvent) {
        val session = sessions[sessionId] ?: return
        when (event) {
            is RdpInputEvent.Pointer -> session.sendPointer(native, event)
            is RdpInputEvent.Key -> session.sendScancode(native, event)
            is RdpInputEvent.Unicode -> session.sendUnicode(native, event)
        }
    }

    override suspend fun resize(sessionId: String, widthPx: Int, heightPx: Int) {
        val (width, height) = RdpGeometry.normalize(widthPx, heightPx)
        sessions[sessionId]?.resize(native, width, height)
    }

    override suspend fun sendClipboard(sessionId: String, text: String) {
        sessions[sessionId]?.sendClipboard(native, text)
    }

    override fun clipboard(sessionId: String): Flow<String> =
        sessions[sessionId]?.clipboard ?: kotlinx.coroutines.flow.emptyFlow()

    override suspend fun disconnect(sessionId: String) {
        pendingReviews.remove(sessionId)
        val session = sessions.remove(sessionId) ?: return
        session.stop(native)
        withContext(ioDispatcher) {
            val thread = session.runThread
            if (thread != null && thread !== Thread.currentThread()) thread.join()
        }
    }

    private suspend fun openNative(
        request: RdpConnectRequest,
        ignoreCertificate: Boolean,
    ): NativeAttempt {
        if (sessions.containsKey(request.sessionId)) {
            return NativeAttempt(failure(SESSION_EXISTS, "An RDP session with this id already exists", false))
        }

        val (width, height) = RdpGeometry.normalize(request.widthPx, request.heightPx)
        val session = Session()
        if (sessions.putIfAbsent(request.sessionId, session) != null) {
            return NativeAttempt(failure(SESSION_EXISTS, "An RDP session with this id already exists", false))
        }

        val display = RdpDisplayPolicy.nativeFlags(request.quality)
        // JNI copy_password historically wrote zeros back into the Java array.
        // The stored-fingerprint retry is a second create() in this same connect(),
        // so each attempt must own a fresh copy.
        val attemptPassword = request.password?.copyOf()
        val config = NativeRdpConfig(
            host = request.host,
            port = request.port,
            username = request.username,
            domain = request.domain,
            password = attemptPassword,
            widthPx = width,
            heightPx = height,
            audio = RdpChannel.AUDIO in request.channels,
            microphone = RdpChannel.MICROPHONE in request.channels,
            clipboard = RdpChannel.CLIPBOARD in request.channels,
            gfx = display.gfx,
            disableWallpaper = display.disableWallpaper,
            disableThemes = display.disableThemes,
            disableMenuAnims = display.disableMenuAnims,
            disableFullWindowDrag = display.disableFullWindowDrag,
            allowFontSmoothing = display.allowFontSmoothing,
            requestedFps = request.fps.value,
            ignoreCertificate = ignoreCertificate,
        )

        return try {
            val handle = native.create(config, session.sink)
            if (handle == 0L) {
                sessions.remove(request.sessionId, session)
                return NativeAttempt(
                    failure(SESSION_CREATE_FAILED, "FreeRDP rejected the session settings"),
                    session.fingerprint,
                )
            }
            session.handle = handle
            val thread = Thread({
                try {
                    val result = native.run(handle)
                    session.connectEvents.trySend(
                        ConnectEvent.Error(result, "FreeRDP exited before reporting a connection"),
                    )
                } catch (error: Throwable) {
                    session.connectEvents.trySend(ConnectEvent.Error(-1, error.message))
                } finally {
                    sessions.remove(request.sessionId, session)
                    session.free(native)
                    session.runThread = null
                }
            }, "zephyr-rdp-${request.sessionId}").apply { isDaemon = true }
            session.runThread = thread
            thread.start()
            session.runStarted = true

            when (val event = session.connectEvents.receive()) {
                is ConnectEvent.Connected -> NativeAttempt(
                    RdpConnectOutcome.Connected(event.width, event.height, request.channels),
                    session.fingerprint,
                )
                is ConnectEvent.Error -> {
                    stopAndJoin(request.sessionId, session)
                    NativeAttempt(
                        failure(NATIVE_CONNECT_FAILED, event.message ?: "FreeRDP connect failed", true),
                        session.fingerprint,
                    )
                }
            }
        } catch (error: CancellationException) {
            withContext(NonCancellable) { stopAndJoin(request.sessionId, session) }
            throw error
        } catch (error: Throwable) {
            stopAndJoin(request.sessionId, session)
            NativeAttempt(
                failure(NATIVE_CONNECT_FAILED, error.message ?: "FreeRDP connect failed", true),
                session.fingerprint,
            )
        } finally {
            attemptPassword?.fill('\u0000')
        }
    }

    private suspend fun stopAndJoin(sessionId: String, session: Session) {
        sessions.remove(sessionId, session)
        session.stop(native)
        withContext(ioDispatcher) {
            val thread = session.runThread
            if (session.runStarted && thread != null && thread !== Thread.currentThread()) thread.join()
        }
        if (!session.runStarted) session.free(native)
    }

    private fun failure(code: String, message: String?, retryable: Boolean = true) =
        RdpConnectOutcome.Failed(MobileError.local(code, message ?: code, retryable))

    private class Session {
        @Volatile var handle: Long = 0L
        @Volatile var runStarted: Boolean = false
        @Volatile var runThread: Thread? = null
        @Volatile var fingerprint: String? = null
        private var pointerButtons: Int = 0

        val connectEvents = Channel<ConnectEvent>(capacity = 1)
        val frames = MutableSharedFlow<RdpFrame>(
            extraBufferCapacity = FRAME_BUFFER_CAPACITY,
            onBufferOverflow = BufferOverflow.DROP_OLDEST,
        )
        val clipboard = MutableSharedFlow<String>(
            extraBufferCapacity = CLIPBOARD_BUFFER_CAPACITY,
            onBufferOverflow = BufferOverflow.DROP_OLDEST,
        )
        val sink = object : NativeRdpSink {
            override fun onConnected(width: Int, height: Int) {
                connectEvents.trySend(ConnectEvent.Connected(width, height))
            }

            override fun onError(code: Int, message: String?) {
                connectEvents.trySend(ConnectEvent.Error(code, message))
            }

            override fun onFrame(x: Int, y: Int, width: Int, height: Int, rgba: ByteArray) {
                frames.tryEmit(RdpFrame(x, y, width, height, rgba))
            }

            override fun onClipboard(text: String) {
                clipboard.tryEmit(text)
            }

            override fun onCertificateFingerprint(value: String) {
                fingerprint = value
            }
        }

        @Synchronized
        fun sendPointer(native: RdpNativeBridge, event: RdpInputEvent.Pointer) {
            val handle = handle
            if (handle == 0L) return
            val x = event.x.coerceIn(0, MAX_POINTER_COORDINATE)
            val y = event.y.coerceIn(0, MAX_POINTER_COORDINATE)
            val changed = pointerButtons xor event.buttons
            for (button in POINTER_BUTTONS) {
                if (changed and button != 0) {
                    native.sendPointerButton(handle, x, y, button, event.buttons and button != 0)
                }
            }
            pointerButtons = event.buttons
            if (changed == 0) native.sendPointerMove(handle, x, y)

            var remaining = event.wheelDelta.coerceIn(-MAX_WHEEL_DELTA, MAX_WHEEL_DELTA)
            while (remaining != 0) {
                val step = remaining.coerceIn(-MAX_WHEEL_STEP, MAX_WHEEL_STEP)
                native.sendWheel(handle, x, y, step)
                remaining -= step
            }
        }

        @Synchronized
        fun sendScancode(native: RdpNativeBridge, event: RdpInputEvent.Key) {
            if (handle != 0L) native.sendScancode(handle, event.scanCode, event.down, event.extended)
        }

        @Synchronized
        fun sendUnicode(native: RdpNativeBridge, event: RdpInputEvent.Unicode) {
            if (handle == 0L || !Character.isValidCodePoint(event.codePoint) ||
                event.codePoint in Char.MIN_HIGH_SURROGATE.code..Char.MAX_LOW_SURROGATE.code
            ) return
            for (unit in Character.toChars(event.codePoint)) native.sendUnicode(handle, unit.code, event.down)
        }

        @Synchronized
        fun resize(native: RdpNativeBridge, width: Int, height: Int) {
            if (handle != 0L) native.resize(handle, width, height)
        }

        @Synchronized
        fun sendClipboard(native: RdpNativeBridge, text: String) {
            if (handle != 0L) native.sendClipboard(handle, text)
        }

        @Synchronized
        fun stop(native: RdpNativeBridge) {
            if (handle != 0L) native.stop(handle)
        }

        @Synchronized
        fun free(native: RdpNativeBridge) {
            val value = handle
            handle = 0L
            if (value != 0L) native.free(value)
        }
    }

    private sealed interface ConnectEvent {
        data class Connected(val width: Int, val height: Int) : ConnectEvent
        data class Error(val code: Int, val message: String?) : ConnectEvent
    }

    private data class NativeAttempt(
        val outcome: RdpConnectOutcome,
        val fingerprint: String? = null,
    )

    private data class PendingReview(
        val host: String,
        val port: Int,
        val fingerprint: String,
    )

    companion object {
        const val ENGINE_UNAVAILABLE = "rdp_engine_unavailable"
        const val DRIVE_UNSUPPORTED = "rdp_drive_provider_unavailable"
        const val CHANNEL_UNSUPPORTED = "rdp_channel_unavailable"
        const val SESSION_EXISTS = "rdp_session_exists"
        const val SESSION_CREATE_FAILED = "rdp_session_create_failed"
        const val NATIVE_CONNECT_FAILED = "rdp_connect_failed"
        const val TRUST_FILE_NAME = "rdp-trust.properties"
        private const val FRAME_BUFFER_CAPACITY = 32
        private const val CLIPBOARD_BUFFER_CAPACITY = 4
        private const val MAX_WHEEL_STEP = 255
        private const val MAX_WHEEL_DELTA = 32_767
        private const val MAX_POINTER_COORDINATE = 65_535
        private val POINTER_BUTTONS = intArrayOf(1, 2, 4)
        private val UNSUPPORTED_CHANNELS = setOf(RdpChannel.CAMERA, RdpChannel.LOCATION)
    }
}

internal data class NativeRdpConfig(
    val host: String,
    val port: Int,
    val username: String,
    val domain: String,
    val password: CharArray?,
    val widthPx: Int,
    val heightPx: Int,
    val audio: Boolean,
    val microphone: Boolean,
    val clipboard: Boolean,
    val gfx: Boolean = true,
    val disableWallpaper: Boolean = true,
    val disableThemes: Boolean = true,
    val disableMenuAnims: Boolean = true,
    val disableFullWindowDrag: Boolean = true,
    val allowFontSmoothing: Boolean = true,
    val requestedFps: Int = 30,
    val ignoreCertificate: Boolean = false,
)

internal interface NativeRdpSink {
    fun onConnected(width: Int, height: Int)
    fun onError(code: Int, message: String?)
    fun onFrame(x: Int, y: Int, width: Int, height: Int, rgba: ByteArray)
    fun onClipboard(text: String)
    fun onCertificateFingerprint(fingerprint: String)
}

internal interface RdpNativeBridge {
    val isAvailable: Boolean
    val unavailableReason: String?
    fun create(config: NativeRdpConfig, sink: NativeRdpSink): Long
    fun run(handle: Long): Int
    fun stop(handle: Long)
    fun free(handle: Long)
    fun sendPointerMove(handle: Long, x: Int, y: Int)
    fun sendPointerButton(handle: Long, x: Int, y: Int, button: Int, down: Boolean)
    fun sendWheel(handle: Long, x: Int, y: Int, delta: Int)
    fun sendScancode(handle: Long, scanCode: Int, down: Boolean, extended: Boolean)
    fun sendUnicode(handle: Long, utf16Unit: Int, down: Boolean)
    fun resize(handle: Long, width: Int, height: Int)
    fun sendClipboard(handle: Long, text: String)
}

internal object JniRdpNativeBridge : RdpNativeBridge {
    private val loadFailure: Throwable? = runCatching { System.loadLibrary("zephyr_rdp_android") }.exceptionOrNull()

    override val isAvailable: Boolean get() = loadFailure == null
    override val unavailableReason: String? get() = loadFailure?.message

    override external fun create(config: NativeRdpConfig, sink: NativeRdpSink): Long
    override external fun run(handle: Long): Int
    override external fun stop(handle: Long)
    override external fun free(handle: Long)
    override external fun sendPointerMove(handle: Long, x: Int, y: Int)
    override external fun sendPointerButton(handle: Long, x: Int, y: Int, button: Int, down: Boolean)
    override external fun sendWheel(handle: Long, x: Int, y: Int, delta: Int)
    override external fun sendScancode(handle: Long, scanCode: Int, down: Boolean, extended: Boolean)
    override external fun sendUnicode(handle: Long, utf16Unit: Int, down: Boolean)
    override external fun resize(handle: Long, width: Int, height: Int)
    override external fun sendClipboard(handle: Long, text: String)
}
