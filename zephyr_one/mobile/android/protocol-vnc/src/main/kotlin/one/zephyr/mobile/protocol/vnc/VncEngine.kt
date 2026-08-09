package one.zephyr.mobile.protocol.vnc

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import one.zephyr.mobile.model.MobileError

/**
 * The RFB engine boundary.
 *
 * ADR-005 in NATIVE_ENGINE_DECISIONS.md prefers a shared LibVNCClient-class core behind a small C
 * adapter, but it is blocked on a licence audit: LibVNCClient and TigerVNC ship under GPL-2.0-family
 * terms and MultiVNC under GPL-3.0, and the ADR is explicit that Zephyr being GPL-3.0-only does not
 * make the combination automatically compatible - linking form, transitive dependencies and App
 * Store distribution obligations all have to be audited per version. Until that closes, no core is
 * linked and [isAvailable] is false.
 *
 * The handshake is implemented for real anyway ([RfbHandshake]), because it is pure byte logic, it
 * carries the ADR-005 gate that unknown security types must be refused, and it is identical whichever
 * core wins. The framebuffer decoders are what the licence question actually covers.
 *
 * ADR-005 also rules out two shortcuts: no embedded noVNC page inside the native app, and no copying
 * a third-party viewer's UI. So this port speaks in damage rectangles and input events, and the
 * gesture and viewport work lives in feature-remote where REMOTE_DESKTOP_EXPERIENCE.md puts it.
 */
interface VncEngine {

    /** False until the ADR-005 licence gate closes and a core is linked. Callers must branch on it. */
    val isAvailable: Boolean

    suspend fun connect(request: VncConnectRequest): VncConnectOutcome

    /** Incremental damage rectangles. A whole-framebuffer push per frame will not hold up on a phone. */
    fun frames(sessionId: String): Flow<VncFrame>

    suspend fun send(sessionId: String, event: VncInputEvent)

    /**
     * Reports the viewport the client can display.
     *
     * Whether this changes the remote desktop depends on the server: only a server that supports the
     * ExtendedDesktopSize pseudo-encoding can resize. Otherwise the framebuffer keeps its size and
     * the viewer scales, which is why this returns the size actually in effect.
     */
    suspend fun resize(sessionId: String, widthPx: Int, heightPx: Int): VncSurfaceSize

    suspend fun sendClipboard(sessionId: String, text: String)

    fun clipboard(sessionId: String): Flow<String>

    suspend fun disconnect(sessionId: String)

    /**
     * Changes the pixel format mid-session.
     *
     * SCREEN_CATALOG.md 10 lists 画质/颜色 as an S23 tool, and RFB supports it without reconnecting:
     * SetPixelFormat is a client-to-server message valid at any time, and [RfbEncoder.setPixelFormat]
     * already encodes it. Defaulted to a no-op so an engine that has not wired it yet reports the
     * unchanged format rather than claiming a change it did not make.
     *
     * @return the format actually in effect afterwards.
     */
    suspend fun setPixelFormat(sessionId: String, format: RfbPixelFormat): RfbPixelFormat = format
}

data class VncConnectRequest(
    val sessionId: String,
    val host: String,
    val port: Int,
    /** VNC Auth has no username. A blank password means "expect security type None". */
    val password: CharArray?,
    /**
     * RFB shared flag. True lets other viewers stay connected.
     *
     * Defaulted to true because the alternative silently disconnects whoever is already on the
     * console, which on a server someone is actively using is destructive.
     */
    val shared: Boolean = true,
    val viewOnly: Boolean = false,
    val preferredPixelFormat: RfbPixelFormat = RfbPixelFormat.RGB565,
) {
    /** Hand-written so the password never reaches a log line through toString(). */
    override fun equals(other: Any?): Boolean = this === other

    override fun hashCode(): Int = System.identityHashCode(this)

    override fun toString(): String = "VncConnectRequest(session=" + sessionId + ", host=" + host + ")"
}

/** The framebuffer size in effect, which is not always what the client asked for. */
data class VncSurfaceSize(val widthPx: Int, val heightPx: Int, val serverResized: Boolean)

/**
 * One damage rectangle, already decoded to RGBA8888.
 *
 * The engine converts from the negotiated pixel format so no caller above this port has to know
 * whether the session negotiated RGB565 or RGB888.
 */
data class VncFrame(
    val x: Int,
    val y: Int,
    val width: Int,
    val height: Int,
    val pixels: ByteArray,
) {
    override fun equals(other: Any?): Boolean =
        other is VncFrame && x == other.x && y == other.y && width == other.width &&
            height == other.height && pixels.contentEquals(other.pixels)

    override fun hashCode(): Int {
        var result = x
        result = 31 * result + y
        result = 31 * result + width
        result = 31 * result + height
        result = 31 * result + pixels.contentHashCode()
        return result
    }
}

/**
 * Input as RFB carries it.
 *
 * [Key] takes an X11 keysym rather than a platform key code, matching the wire format: translating
 * in the engine would put the same lookup table behind two platform layers.
 */
sealed interface VncInputEvent {
    data class Key(val keysym: Int, val down: Boolean) : VncInputEvent
    data class Pointer(val x: Int, val y: Int, val buttonMask: Int) : VncInputEvent

    /** Text committed by an IME, expanded to per-code-point key events by the engine. */
    data class Text(val text: String) : VncInputEvent
}

sealed interface VncConnectOutcome {
    data class Connected(
        val version: RfbVersion,
        val securityType: Int,
        val widthPx: Int,
        val heightPx: Int,
        val desktopName: String,
        val pixelFormat: RfbPixelFormat,
    ) : VncConnectOutcome

    /**
     * The password was wrong, or none was supplied for a server that requires one.
     *
     * Kept separate from [Failed] so the UI can re-prompt instead of showing a generic error, which
     * ADR-005 lists as a required behaviour ("认证失败").
     */
    data class AuthenticationRequired(val reason: String, val attemptsExhausted: Boolean) : VncConnectOutcome

    data class Failed(val error: MobileError) : VncConnectOutcome
}

/** Reports the ADR-005 block instead of pretending to connect. */
class UnavailableVncEngine : VncEngine {

    override val isAvailable: Boolean = false

    override suspend fun connect(request: VncConnectRequest): VncConnectOutcome =
        VncConnectOutcome.Failed(
            MobileError.local(
                code = ENGINE_UNAVAILABLE,
                message = "The native VNC engine is not built into this release",
            ),
        )

    override fun frames(sessionId: String): Flow<VncFrame> = emptyFlow()

    override suspend fun send(sessionId: String, event: VncInputEvent) = Unit

    override suspend fun resize(sessionId: String, widthPx: Int, heightPx: Int): VncSurfaceSize =
        VncSurfaceSize(widthPx = widthPx, heightPx = heightPx, serverResized = false)

    override suspend fun sendClipboard(sessionId: String, text: String) = Unit

    override fun clipboard(sessionId: String): Flow<String> = emptyFlow()

    override suspend fun disconnect(sessionId: String) = Unit

    companion object {
        const val ENGINE_UNAVAILABLE = "vnc_engine_unavailable"
    }
}
