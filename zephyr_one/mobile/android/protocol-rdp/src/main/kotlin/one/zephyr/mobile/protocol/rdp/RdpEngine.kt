package one.zephyr.mobile.protocol.rdp

import kotlinx.coroutines.flow.Flow
import one.zephyr.mobile.model.MobileError
import one.zephyr.mobile.model.RdpChannel
import one.zephyr.mobile.model.RdpFps
import one.zephyr.mobile.model.RdpQuality

/**
 * The RDP engine boundary.
 *
 * The Android implementation is [AndroidRdpEngine]. It is available only in builds that package the
 * pinned Android FreeRDP archives and JNI library; [UnavailableRdpEngine] remains the explicit
 * fallback for builds without that native payload.
 *
 * What exists here is the seam: the port every caller codes against, plus the pure decisions that do
 * not need an engine - certificate trust, channel gating and the drive read-only rule. When the
 * engine lands it implements [RdpEngine] and nothing above this line changes.
 *
 * Two upstream behaviours the desktop shim proved false must be carried into the mobile adapter
 * rather than rediscovered (ADR-004):
 *
 * 1. FreeRDP's WLog writes to stdout by default and floods any binary protocol sharing fd 1, so the
 *    adapter must isolate fd 1 at startup.
 * 2. `freerdp_client_add_device_channel` stats the mapped path, so a missing directory fails the
 *    whole settings assembly. The path must be validated first and reported as a specific code -
 *    which is what [RdpDrivePolicy] does.
 */
interface RdpEngine {

    /** Callers must branch on this because the native payload is optional per build. */
    val isAvailable: Boolean

    suspend fun connect(request: RdpConnectRequest): RdpConnectOutcome

    /**
     * Damage rectangles, never whole frames.
     *
     * ADR-004 requires incremental upload: copying a 1080p surface per frame is ~8 MB of traffic per
     * frame on the JNI boundary and will not hold 30 fps on a phone.
     */
    fun frames(sessionId: String): Flow<RdpFrame>

    suspend fun send(sessionId: String, event: RdpInputEvent)

    /** Dynamic resolution change, e.g. rotation or a foldable unfolding. */
    suspend fun resize(sessionId: String, widthPx: Int, heightPx: Int)

    suspend fun sendClipboard(sessionId: String, text: String)

    fun clipboard(sessionId: String): Flow<String>

    suspend fun disconnect(sessionId: String)

    /**
     * Commits the certificate the user just approved and lets the attempt continue.
     *
     * Takes a session id rather than a certificate because the engine already parsed and still holds
     * the presented chain: handing DER bytes up to a ViewModel so it can hand them straight back
     * would widen the blast radius of a certificate bug from one adapter to the whole UI layer, and
     * the same argument already shaped TerminalHost.trustHostKey.
     *
     * @param replaceExisting true for a *changed* certificate, which DEVELOPMENT.md 14.3 blocks by
     *   default. Separate from a first-contact accept so an implementation cannot conflate "no
     *   certificate was stored" with "a different certificate was stored", which is the one
     *   distinction that matters here.
     */
    suspend fun trustCertificate(sessionId: String, replaceExisting: Boolean = false) = Unit
}

data class RdpConnectRequest(
    val sessionId: String,
    val host: String,
    val port: Int,
    val username: String,
    val domain: String,
    val password: CharArray?,
    val widthPx: Int,
    val heightPx: Int,
    /** Already filtered by [RdpChannelPolicy]; the engine does not re-decide permissions. */
    val channels: Set<RdpChannel>,
    val drive: RdpDriveMapping?,
    val quality: RdpQuality = RdpQuality.default,
    val fps: RdpFps = RdpFps.default,
) {
    /**
     * Excluded from equals/hashCode/toString by hand-writing them: a data class would put the
     * password into any log line that prints the request.
     */
    override fun equals(other: Any?): Boolean = this === other

    override fun hashCode(): Int = System.identityHashCode(this)

    override fun toString(): String = "RdpConnectRequest(session=" + sessionId + ", host=" + host + ")"
}

/**
 * One damage rectangle.
 *
 * [pixels] is RGBA8888. FreeRDP's GDI surface is BGRA32, and ADR-004 records that the conversion
 * belongs in the pack step inside the adapter, so no caller above this port ever handles the
 * platform's byte order.
 */
data class RdpFrame(
    val x: Int,
    val y: Int,
    val width: Int,
    val height: Int,
    val pixels: ByteArray,
) {
    override fun equals(other: Any?): Boolean =
        other is RdpFrame && x == other.x && y == other.y && width == other.width &&
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

sealed interface RdpInputEvent {
    data class Pointer(val x: Int, val y: Int, val buttons: Int, val wheelDelta: Int = 0) : RdpInputEvent
    data class Key(val scanCode: Int, val down: Boolean, val extended: Boolean = false) : RdpInputEvent
    data class Unicode(val codePoint: Int, val down: Boolean) : RdpInputEvent
}

sealed interface RdpConnectOutcome {
    data class Connected(val widthPx: Int, val heightPx: Int, val grantedChannels: Set<RdpChannel>) : RdpConnectOutcome

    /**
     * The certificate needs a user decision; the session is held, not failed.
     *
     * [changed] and [previousFingerprint] are carried here rather than left for the caller to look up
     * because REMOTE_DESKTOP_EXPERIENCE.md 10 gives the two cases different default answers: an
     * unknown certificate may be accepted, a changed one blocks by default and the user must be shown
     * what it changed from. A UI that cannot tell them apart cannot implement that rule.
     */
    data class CertificateReview(
        val request: RdpCertificateReview,
        val changed: Boolean = false,
        val previousFingerprint: String? = null,
    ) : RdpConnectOutcome

    data class Failed(val error: MobileError) : RdpConnectOutcome
}

/** Explicit fallback for a build that does not package the JNI engine. */
class UnavailableRdpEngine : RdpEngine {

    override val isAvailable: Boolean = false

    override suspend fun connect(request: RdpConnectRequest): RdpConnectOutcome =
        RdpConnectOutcome.Failed(
            MobileError.local(
                code = ENGINE_UNAVAILABLE,
                message = "The native RDP engine is not built into this release",
            ),
        )

    override fun frames(sessionId: String): Flow<RdpFrame> = kotlinx.coroutines.flow.emptyFlow()

    override suspend fun send(sessionId: String, event: RdpInputEvent) = Unit

    override suspend fun resize(sessionId: String, widthPx: Int, heightPx: Int) = Unit

    override suspend fun sendClipboard(sessionId: String, text: String) = Unit

    override fun clipboard(sessionId: String): Flow<String> = kotlinx.coroutines.flow.emptyFlow()

    override suspend fun disconnect(sessionId: String) = Unit

    companion object {
        const val ENGINE_UNAVAILABLE = "rdp_engine_unavailable"
    }
}

/** Chooses the surface size the engine should request. */
object RdpGeometry {

    /**
     * RDP requires even dimensions for several codecs, and a surface smaller than this is not worth
     * connecting: the remote desktop would be unusable and some servers refuse outright.
     */
    const val MIN_DIMENSION = 200

    fun normalize(widthPx: Int, heightPx: Int): Pair<Int, Int> {
        val width = (widthPx.coerceAtLeast(MIN_DIMENSION)) and 0x7FFF_FFFE
        val height = (heightPx.coerceAtLeast(MIN_DIMENSION)) and 0x7FFF_FFFE
        return width to height
    }

    /**
     * Whether a resize is worth sending.
     *
     * A dynamic-resolution change costs a full surface reallocation on the server, so a one-pixel
     * jitter from a system bar animation must not trigger one.
     */
    fun shouldResize(currentWidth: Int, currentHeight: Int, nextWidth: Int, nextHeight: Int): Boolean {
        val (width, height) = normalize(nextWidth, nextHeight)
        return width != currentWidth || height != currentHeight
    }
}
