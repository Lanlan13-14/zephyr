package one.zephyr.mobile.feature.remote

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import one.zephyr.mobile.protocol.rdp.RdpEngine
import one.zephyr.mobile.protocol.rdp.RdpGeometry
import one.zephyr.mobile.protocol.rdp.RdpInputEvent
import one.zephyr.mobile.protocol.vnc.VncEngine
import one.zephyr.mobile.protocol.vnc.VncInputEvent

/**
 * The framebuffer size actually in effect.
 *
 * @param serverResized false when the remote desktop kept its own size and the viewer must scale.
 *   REMOTE_DESKTOP_EXPERIENCE.md 4 lists dynamic resolution as "RDP 支持时首选", which means the
 *   opposite case is normal rather than exceptional and the UI has to be able to say so.
 */
data class RemoteSurfaceSize(val widthPx: Int, val heightPx: Int, val serverResized: Boolean)

/**
 * One protocol behind one interface.
 *
 * REMOTE_DESKTOP_EXPERIENCE.md 2 freezes that the protocol core knows nothing about the island,
 * sheets, themes or navigation, and that callbacks never touch Compose state directly. This port is
 * where that boundary is drawn: everything above it speaks [RemoteInput] and [FramePatch], so the
 * viewport, gesture and chrome code is written once rather than twice.
 */
interface RemoteProtocolAdapter {

    /** False while the engine is blocked by ADR-004 (RDP) or ADR-005 (VNC). */
    val isAvailable: Boolean

    suspend fun send(sessionId: String, input: RemoteInput)

    suspend fun sendAll(sessionId: String, inputs: List<RemoteInput>) {
        for (input in inputs) send(sessionId, input)
    }

    fun frames(sessionId: String): Flow<FramePatch>

    suspend fun resize(sessionId: String, widthPx: Int, heightPx: Int): RemoteSurfaceSize

    suspend fun sendClipboard(sessionId: String, text: String)

    fun clipboard(sessionId: String): Flow<String>

    suspend fun disconnect(sessionId: String)
}

/**
 * RDP.
 *
 * Pointer state is passed straight through because [RdpEngine] already takes the neutral button mask
 * this module defines; the wheel is the only place the two disagree, and it disagrees in units rather
 * than in meaning.
 */
class RdpProtocolAdapter(private val engine: RdpEngine) : RemoteProtocolAdapter {

    override val isAvailable: Boolean get() = engine.isAvailable

    override suspend fun send(sessionId: String, input: RemoteInput) {
        when (input) {
            is RemoteInput.PointerMove ->
                engine.send(sessionId, RdpInputEvent.Pointer(input.x, input.y, input.buttons))

            is RemoteInput.PointerButton ->
                engine.send(sessionId, RdpInputEvent.Pointer(input.x, input.y, input.buttons))

            is RemoteInput.Wheel -> engine.send(
                sessionId,
                // Negated: RDP rotation is positive when the wheel turns away from the user, which
                // scrolls the content up, while a positive notch here means "toward the bottom".
                RdpInputEvent.Pointer(
                    x = input.x,
                    y = input.y,
                    buttons = RemoteButton.NONE,
                    wheelDelta = -input.notches * WHEEL_UNIT,
                ),
            )

            is RemoteInput.Key -> {
                val scan = RdpKeyMap.scanCode(input.key)
                if (scan != null) {
                    engine.send(sessionId, RdpInputEvent.Key(scan.code, input.down, scan.extended))
                } else {
                    // No scan code for this key: fall back to the Unicode channel rather than
                    // dropping it, which is what keeps a CJK or emoji character typable.
                    val character = input.key as? RemoteKey.Character ?: return
                    engine.send(sessionId, RdpInputEvent.Unicode(character.codePoint, input.down))
                }
            }

            is RemoteInput.Text -> {
                var index = 0
                while (index < input.text.length) {
                    val codePoint = input.text.codePointAt(index)
                    engine.send(sessionId, RdpInputEvent.Unicode(codePoint, true))
                    engine.send(sessionId, RdpInputEvent.Unicode(codePoint, false))
                    index += Character.charCount(codePoint)
                }
            }
        }
    }

    override fun frames(sessionId: String): Flow<FramePatch> = engine.frames(sessionId).map { frame ->
        FramePatch(FrameRegion(frame.x, frame.y, frame.width, frame.height), frame.pixels)
    }

    /**
     * Requests a surface size.
     *
     * [RdpEngine.resize] returns nothing, so this reports the size it asked for and never claims the
     * server agreed. The authoritative size is observed instead: [RemoteSessionController] grows the
     * geometry when a damage rectangle lands outside the assumed bounds, so a server that refuses
     * dynamic resolution corrects the viewport on the next frame rather than clipping forever.
     */
    override suspend fun resize(sessionId: String, widthPx: Int, heightPx: Int): RemoteSurfaceSize {
        val (width, height) = RdpGeometry.normalize(widthPx, heightPx)
        engine.resize(sessionId, width, height)
        return RemoteSurfaceSize(widthPx = width, heightPx = height, serverResized = false)
    }

    override suspend fun sendClipboard(sessionId: String, text: String) =
        engine.sendClipboard(sessionId, text)

    override fun clipboard(sessionId: String): Flow<String> = engine.clipboard(sessionId)

    override suspend fun disconnect(sessionId: String) = engine.disconnect(sessionId)

    private companion object {
        /** One notch of a standard wheel, as RDP counts rotation. */
        const val WHEEL_UNIT = 120
    }
}

/**
 * VNC.
 *
 * RFB has no wheel field: buttons 4..7 are the wheel, and one notch is a press immediately followed
 * by a release. Expanding it here rather than in the engine keeps the engine a transport.
 */
class VncProtocolAdapter(private val engine: VncEngine) : RemoteProtocolAdapter {

    override val isAvailable: Boolean get() = engine.isAvailable

    override suspend fun send(sessionId: String, input: RemoteInput) {
        when (input) {
            is RemoteInput.PointerMove ->
                engine.send(sessionId, VncInputEvent.Pointer(input.x, input.y, input.buttons))

            is RemoteInput.PointerButton ->
                engine.send(sessionId, VncInputEvent.Pointer(input.x, input.y, input.buttons))

            is RemoteInput.Wheel -> {
                val button = wheelButton(input)
                repeat(kotlin.math.abs(input.notches)) {
                    engine.send(sessionId, VncInputEvent.Pointer(input.x, input.y, button))
                    engine.send(sessionId, VncInputEvent.Pointer(input.x, input.y, RemoteButton.NONE))
                }
            }

            is RemoteInput.Key -> {
                val keysym = VncKeyMap.keysym(input.key) ?: return
                engine.send(sessionId, VncInputEvent.Key(keysym, input.down))
            }

            // Handed over whole: the engine expands it to per-code-point key events, and splitting it
            // here would send a surrogate pair as two broken keysyms.
            is RemoteInput.Text -> engine.send(sessionId, VncInputEvent.Text(input.text))
        }
    }

    private fun wheelButton(input: RemoteInput.Wheel): Int = when {
        input.horizontal && input.notches > 0 -> WHEEL_RIGHT
        input.horizontal -> WHEEL_LEFT
        input.notches > 0 -> WHEEL_DOWN
        else -> WHEEL_UP
    }

    override fun frames(sessionId: String): Flow<FramePatch> = engine.frames(sessionId).map { frame ->
        FramePatch(FrameRegion(frame.x, frame.y, frame.width, frame.height), frame.pixels)
    }

    override suspend fun resize(sessionId: String, widthPx: Int, heightPx: Int): RemoteSurfaceSize {
        val size = engine.resize(sessionId, widthPx, heightPx)
        return RemoteSurfaceSize(size.widthPx, size.heightPx, size.serverResized)
    }

    override suspend fun sendClipboard(sessionId: String, text: String) =
        engine.sendClipboard(sessionId, text)

    override fun clipboard(sessionId: String): Flow<String> = engine.clipboard(sessionId)

    override suspend fun disconnect(sessionId: String) = engine.disconnect(sessionId)

    private companion object {
        /** RFB button 4..7, as bits of the pointer mask. */
        const val WHEEL_UP = 8
        const val WHEEL_DOWN = 16
        const val WHEEL_LEFT = 32
        const val WHEEL_RIGHT = 64
    }
}
