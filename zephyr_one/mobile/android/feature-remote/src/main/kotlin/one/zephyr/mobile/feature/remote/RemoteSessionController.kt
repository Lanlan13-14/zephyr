package one.zephyr.mobile.feature.remote

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Everything the remote surface renders, as one value.
 *
 * Frames are deliberately absent: they are drained from [RemoteSessionController.drainFrames] rather
 * than carried here, because a state object copied on every pointer move must not contain a
 * framebuffer. REMOTE_DESKTOP_EXPERIENCE.md 11 puts the pixel path outside the UI state for exactly
 * this reason.
 */
data class RemoteSurfaceState(
    val geometry: RemoteGeometry = RemoteGeometry(0, 0, 0f, 0f),
    val transform: RemoteTransform = RemoteTransform(1f, 0f, 0f),
    val mode: RemoteViewportMode = RemoteViewportMode.FIT,
    val pointer: RemotePointerState = RemotePointerState(),
    val latches: RemoteModifierLatches = RemoteModifierLatches(),
    val chrome: RemoteChromeState = RemoteChromeState(),
    /** Patches thrown away because the mailbox filled. Surfaced so the UI can show a real number. */
    val droppedPatches: Int = 0,
    val coalescedMoves: Int = 0,
    val pendingClipboard: RemoteClipboardOffer? = null,
    /** Published so the pointer panel's slider shows the value in force, not the stored default. */
    val sensitivity: Float = 1.5f,
) {
    val canInteract: Boolean get() = geometry.isMeasured
}

/**
 * The single owner of one remote session's surface.
 *
 * Gestures, keys and clipboard all arrive here and leave as [RemoteInput] through one bounded queue,
 * so the ordering rule in REMOTE_DESKTOP_EXPERIENCE.md 11 - coalesce moves, never coalesce down/up or
 * keys - is a property of this class rather than of each call site. The protocol adapter is the only
 * thing it talks to, which is what keeps the same code driving RDP and VNC.
 */
class RemoteSessionController(
    private val sessionId: String,
    private val adapter: RemoteProtocolAdapter,
    private val scope: CoroutineScope,
    initialPointerMode: RemotePointerMode = RemotePointerMode.DIRECT,
    sensitivity: Float = 1.5f,
    swapLongPress: Boolean = false,
    private val mailbox: FrameMailbox = FrameMailbox(),
    private val queue: RemoteInputQueue = RemoteInputQueue(),
) {

    private val pointer = RemotePointerController(
        initialMode = initialPointerMode,
        sensitivity = sensitivity,
        swapLongPress = swapLongPress,
    )

    private val stateFlow = MutableStateFlow(
        RemoteSurfaceState(pointer = RemotePointerState(mode = initialPointerMode)),
    )
    val state: StateFlow<RemoteSurfaceState> = stateFlow.asStateFlow()

    /** Bumped once per drained frame batch, so the renderer recomposes without the pixels in state. */
    private val revisionFlow = MutableStateFlow(0)
    val frameRevision: StateFlow<Int> = revisionFlow.asStateFlow()

    private val gestureFlow = MutableSharedFlow<RemoteGestureSignal>(extraBufferCapacity = 8)
    val gestureSignals: SharedFlow<RemoteGestureSignal> = gestureFlow

    /** Zoom the user reached by pinching, so a double tap can return to it (section 4). */
    private var rememberedScale: Float? = null

    private var geometry = RemoteGeometry(0, 0, 0f, 0f)
    private var transform = RemoteTransform(1f, 0f, 0f)
    private var mode = RemoteViewportMode.FIT
    private var chrome = RemoteChromeState()
    private var latches = RemoteModifierLatches()
    private var pendingClipboard: RemoteClipboardOffer? = null

    /**
     * Wakes the pump.
     *
     * CONFLATED because the signal carries no information: one wake after a burst is enough, and the
     * pump drains whatever accumulated. This is what lets the queue coalesce moves while a slow
     * adapter call is in flight instead of building an unbounded backlog.
     */
    private val wake = Channel<Unit>(Channel.CONFLATED)

    init {
        scope.launch {
            for (signal in wake) {
                while (true) {
                    val next = queue.poll() ?: break
                    // A failed send must not kill the pump: the session may be reconnecting, and the
                    // next input still has to reach the wire once it is back.
                    runCatching { adapter.send(sessionId, next) }
                }
                publish()
            }
        }
    }

    // ---- geometry --------------------------------------------------------------------------------

    /**
     * The viewport changed size.
     *
     * @param requestResize true asks the server to match, which only RDP dynamic resolution and the
     *   VNC ExtendedDesktopSize pseudo-encoding can honour. The reply is applied to [geometry] so a
     *   server that refused is not mistaken for one that agreed.
     */
    fun onViewportMeasured(widthPx: Float, heightPx: Float, requestResize: Boolean = false) {
        if (widthPx <= 0f || heightPx <= 0f) return
        val next = geometry.copy(viewportWidthPx = widthPx, viewportHeightPx = heightPx)
        if (next == geometry) return
        geometry = next
        // Re-derived rather than carried over: an orientation change must not leave a pointer mapping
        // computed against the old matrix (section 4).
        retransform()
        if (requestResize && geometry.remoteWidthPx > 0) {
            scope.launch {
                val size = runCatching { adapter.resize(sessionId, widthPx.toInt(), heightPx.toInt()) }
                    .getOrNull() ?: return@launch
                onRemoteSize(size.widthPx, size.heightPx)
            }
        }
    }

    /** The remote framebuffer size as the engine reports it. */
    fun onRemoteSize(widthPx: Int, heightPx: Int) {
        if (widthPx <= 0 || heightPx <= 0) return
        if (widthPx == geometry.remoteWidthPx && heightPx == geometry.remoteHeightPx) return
        geometry = geometry.copy(remoteWidthPx = widthPx, remoteHeightPx = heightPx)
        mailbox.requestFullRepaint(FrameRegion(0, 0, widthPx, heightPx))
        retransform()
    }

    // ---- frames ----------------------------------------------------------------------------------

    /**
     * A damage rectangle from the engine.
     *
     * A patch outside the known framebuffer grows it rather than being clipped away: this is the only
     * signal available when a server silently keeps its own size after a resize request, and dropping
     * the patch would leave a permanently blank strip on screen.
     */
    fun onFrame(patch: FramePatch) {
        if (patch.region.right > geometry.remoteWidthPx || patch.region.bottom > geometry.remoteHeightPx) {
            onRemoteSize(
                maxOf(patch.region.right, geometry.remoteWidthPx),
                maxOf(patch.region.bottom, geometry.remoteHeightPx),
            )
        }
        mailbox.offer(patch)
    }

    /** Called by the renderer once per frame. Empties the mailbox and bumps [frameRevision]. */
    fun drainFrames(): FrameDrain {
        val drain = mailbox.drain()
        if (drain.patches.isNotEmpty() || drain.fullRepaint) {
            revisionFlow.value = revisionFlow.value + 1
            publish()
        }
        return drain
    }

    fun requestFullRepaint() {
        mailbox.requestFullRepaint(
            if (geometry.remoteWidthPx > 0) {
                FrameRegion(0, 0, geometry.remoteWidthPx, geometry.remoteHeightPx)
            } else {
                null
            },
        )
    }

    // ---- viewport --------------------------------------------------------------------------------

    fun setViewportMode(next: RemoteViewportMode) {
        mode = next
        if (next != RemoteViewportMode.CUSTOM) rememberedScale = null
        retransform()
    }

    /** Pinch. Anchored on the focus so the pixel under the fingers stays under the fingers. */
    fun onPinch(factor: Float, focusXPx: Float, focusYPx: Float) {
        if (!geometry.isMeasured || factor <= 0f) return
        transform = RemoteViewport.zoom(transform, geometry, factor, focusXPx, focusYPx)
        mode = RemoteViewportMode.CUSTOM
        rememberedScale = transform.scale
        publish()
    }

    fun onPan(dxPx: Float, dyPx: Float) {
        if (!geometry.isMeasured) return
        transform = RemoteViewport.pan(transform, geometry, dxPx, dyPx)
        publish()
    }

    /** Double tap toggles fit and the remembered zoom (or 1:1 the first time). */
    fun onDoubleTap(focusXPx: Float, focusYPx: Float) {
        if (!geometry.isMeasured) return
        val target = RemoteViewport.doubleTapTarget(transform, geometry, rememberedScale)
        mode = target
        transform = if (target == RemoteViewportMode.FIT) {
            // Fit has one answer, and it is centred: there is nothing for a focal point to preserve.
            RemoteViewport.transformFor(target, geometry)
        } else {
            // Zoomed about the tap rather than centred, so the pixel the user aimed at stays under
            // the finger (section 4). Expressed as a zoom because that is the one function that
            // already solves for the offset which keeps a focal point fixed.
            val targetScale = RemoteViewport.scaleFor(target, geometry, rememberedScale ?: 1f)
            RemoteViewport.zoom(
                transform = transform,
                geometry = geometry,
                factor = targetScale / transform.scale,
                focalXPx = focusXPx,
                focalYPx = focusYPx,
            )
        }
        publish()
    }

    private fun retransform() {
        if (!geometry.isMeasured) {
            publish()
            return
        }
        transform = if (mode == RemoteViewportMode.CUSTOM) {
            RemoteViewport.clamp(transform, geometry)
        } else {
            RemoteViewport.transformFor(mode, geometry, rememberedScale ?: 1f)
        }
        publish()
    }

    // ---- pointer ---------------------------------------------------------------------------------

    fun setPointerMode(next: RemotePointerMode) {
        submit(pointer.setMode(next))
    }

    fun setSensitivity(value: Float) {
        pointer.setSensitivity(value)
        publish()
    }

    /**
     * A tap on the surface.
     *
     * @return true when the tap was consumed as remote input. False means it fell on the letterbox,
     *   and the caller treats it as a chrome toggle instead - which is why this returns a value
     *   rather than swallowing it.
     */
    fun onTap(localXPx: Float, localYPx: Float): Boolean {
        if (!geometry.isMeasured) return false
        return when (pointer.state.mode) {
            RemotePointerMode.DIRECT -> {
                val point = RemoteViewport.toRemote(localXPx, localYPx, transform, geometry) ?: return false
                submit(pointer.tap(point))
                true
            }
            // Trackpad taps click wherever the remote cursor already is, so the finger position is
            // irrelevant and a tap on the letterbox is still a click (section 5.2).
            RemotePointerMode.TRACKPAD -> {
                // A tap while the drag lock is held releases it instead of clicking. The lock is a
                // button that is genuinely down, so the gesture that ends it has to be the obvious
                // one - otherwise the only way out is a mode switch.
                if (pointer.state.dragLock) {
                    submit(pointer.releaseDragLock())
                } else {
                    submit(pointer.clickAtCursor())
                }
                true
            }
        }
    }

    fun onLongPress(localXPx: Float, localYPx: Float): Boolean {
        if (!geometry.isMeasured) return false
        return when (pointer.state.mode) {
            RemotePointerMode.DIRECT -> {
                val point = RemoteViewport.toRemote(localXPx, localYPx, transform, geometry) ?: return false
                // Emitted before submit, not after: section 5.1 requires the haptic to precede the
                // secondary click, and submit() only enqueues - the pump could send it first.
                gestureFlow.tryEmit(RemoteGestureSignal.SecondaryClickHaptic)
                submit(pointer.longPress(point))
                true
            }
            RemotePointerMode.TRACKPAD -> {
                gestureFlow.tryEmit(RemoteGestureSignal.DragLockHaptic)
                submit(pointer.engageDragLock())
                true
            }
        }
    }

    /**
     * Trackpad two-finger tap: a secondary click where the remote cursor already is.
     *
     * Separate from [onLongPress] because in trackpad mode a long press means drag lock, so the
     * secondary click needs its own gesture (section 5.2) and therefore its own entry point.
     */
    fun onSecondaryClickAtCursor() {
        gestureFlow.tryEmit(RemoteGestureSignal.SecondaryClickHaptic)
        submit(pointer.clickAtCursor(RemoteButton.SECONDARY))
    }

    fun onDragStart(localXPx: Float, localYPx: Float) {
        if (pointer.state.mode != RemotePointerMode.DIRECT) return
        // Clamped rather than rejected: a drag that starts inside and leaves the image must keep
        // driving the remote pointer along the edge instead of stopping mid-selection.
        val point = RemoteViewport.toRemoteClamped(localXPx, localYPx, transform, geometry)
        submit(pointer.dragStart(point))
    }

    fun onDragTo(localXPx: Float, localYPx: Float) {
        if (pointer.state.mode != RemotePointerMode.DIRECT) return
        val point = RemoteViewport.toRemoteClamped(localXPx, localYPx, transform, geometry)
        submit(pointer.dragTo(point))
    }

    fun onDragEnd() {
        submit(pointer.dragEnd())
    }

    /** Trackpad-mode finger movement: relative, scaled by the current zoom so it feels 1:1. */
    fun onRelativeMove(dxPx: Float, dyPx: Float) {
        if (pointer.state.mode != RemotePointerMode.TRACKPAD) return
        if (!geometry.isMeasured) return
        submit(pointer.moveBy(dxPx, dyPx, geometry, transform.scale))
    }

    fun onHover(localXPx: Float, localYPx: Float, buttons: Int) {
        if (!geometry.isMeasured) return
        val point = RemoteViewport.toRemote(localXPx, localYPx, transform, geometry) ?: return
        submit(pointer.hardware(point, buttons))
    }

    fun onWheel(notches: Int, localXPx: Float, localYPx: Float, horizontal: Boolean = false) {
        if (notches == 0) return
        if (geometry.isMeasured && pointer.state.mode == RemotePointerMode.DIRECT) {
            RemoteViewport.toRemote(localXPx, localYPx, transform, geometry)?.let { point ->
                submit(pointer.dragTo(point))
            }
        }
        submit(pointer.wheel(notches, horizontal))
    }

    fun releasePointer() {
        submit(pointer.releaseAll())
    }

    // ---- keyboard --------------------------------------------------------------------------------

    fun onModifierTap(modifier: RemoteModifier) {
        latches = latches.toggle(modifier)
        publish()
    }

    /**
     * A named key or shortcut.
     *
     * The latched modifiers are wrapped around it and then cleared, so Ctrl behaves as a one-shot the
     * way a touch keyboard needs: holding a physical key is not possible, and leaving Ctrl latched
     * after Ctrl+C would break every following keystroke.
     */
    fun onKey(key: RemoteKey) {
        submit(RemoteTextPolicy.chord(key, latches))
        latches = latches.cleared()
        publish()
    }

    /**
     * A physical keyboard key.
     *
     * Passed through with its real down/up transition and *without* the soft latches, because a
     * hardware Ctrl is already held: wrapping it in the latched modifiers would press Ctrl twice and
     * release it once. Section 5.3 requires button chords and section 6 requires shortcuts to travel
     * as key codes, and both need the transitions to survive intact.
     */
    fun onHardwareKey(key: RemoteKey, down: Boolean) {
        submit(listOf(RemoteInput.Key(key, down)))
    }

    /** IME-committed text. Routed as text unless a shortcut modifier is latched (section 6). */
    fun onText(text: String) {
        if (text.isEmpty()) return
        submit(RemoteTextPolicy.route(text, latches))
        latches = latches.cleared()
        publish()
    }

    fun setKeyboardVisible(visible: Boolean) {
        chrome = RemoteChrome.setKeyboard(chrome, visible)
        publish()
    }

    fun setModifierBarVisible(visible: Boolean) {
        chrome = RemoteChrome.setModifierBar(chrome, visible)
        publish()
    }

    // ---- chrome ----------------------------------------------------------------------------------

    fun onSurfaceTapForChrome() {
        chrome = RemoteChrome.onSurfaceTap(chrome)
        publish()
    }

    /** The idle timer expired. Only ever hides, so it cannot fight the user's own tap. */
    fun hideChrome() {
        if (!chrome.mayAutoHide) return
        chrome = chrome.copy(visible = false)
        publish()
    }

    fun onGestureStart() {
        chrome = RemoteChrome.onGestureStart(chrome)
        publish()
    }

    fun onGestureEnd() {
        chrome = RemoteChrome.onGestureEnd(chrome)
        publish()
    }

    // ---- clipboard -------------------------------------------------------------------------------

    /** Offers clipboard text in either direction. Returns what the UI must do about it. */
    fun offerClipboard(
        offer: RemoteClipboardOffer,
        policy: RemoteClipboardPolicy,
        channelEnabled: Boolean,
        hasCapability: Boolean,
    ): RemoteClipboardDecision {
        // Named: the policy enum sits between two Booleans in this call, so a positional slip here
        // would silently swap "channel is on" with "the ACL allows it".
        val decision = RemoteClipboard.decide(
            offer = offer,
            channelEnabled = channelEnabled,
            allowedByAcl = hasCapability,
            policy = policy,
        )
        pendingClipboard = (decision as? RemoteClipboardDecision.Confirm)?.offer
        publish()
        return decision
    }

    /**
     * Sends the device clipboard to the remote session.
     *
     * The only direction that reaches the wire. A remote-to-local acceptance is [acceptRemoteClipboard]
     * instead: echoing the far side's own text back to it would be a loop rather than a paste, and the
     * device clipboard is written by the UI layer that owns the platform API.
     */
    fun sendClipboard(text: String) {
        pendingClipboard = null
        scope.launch { runCatching { adapter.sendClipboard(sessionId, text) } }
        publish()
    }

    /** Clears the prompt for an accepted remote-to-local transfer. Touches no clipboard itself. */
    fun acceptRemoteClipboard() {
        pendingClipboard = null
        publish()
    }

    fun cancelClipboard() {
        pendingClipboard = null
        publish()
    }

    // ---- teardown --------------------------------------------------------------------------------

    suspend fun disconnect() {
        queue.clear()
        mailbox.reset()
        runCatching { adapter.disconnect(sessionId) }
    }

    /**
     * True when the session may look but not touch.
     *
     * Enforced in the one place every input passes through rather than at each gesture handler: an
     * observe-only grant that is checked in twenty call sites is a grant that will eventually be
     * missed in one of them. The local pointer state still moves so the chrome stays responsive; only
     * the wire is silent.
     */
    var viewOnly: Boolean = false

    private fun submit(inputs: List<RemoteInput>) {
        if (inputs.isEmpty() || viewOnly) return
        for (input in inputs) queue.offer(input)
        wake.trySend(Unit)
        // The one place every input passes through, which is why the chrome rule is applied here: a
        // gesture that reached the wire must not also toggle chrome when the finger lifts.
        chrome = RemoteChrome.onRemoteInput(chrome)
        publish()
    }

    private fun publish() {
        stateFlow.value = RemoteSurfaceState(
            geometry = geometry,
            transform = transform,
            mode = mode,
            pointer = pointer.state,
            latches = latches,
            chrome = chrome,
            droppedPatches = mailbox.droppedPatches,
            coalescedMoves = queue.coalescedMoves,
            pendingClipboard = pendingClipboard,
            sensitivity = pointer.sensitivity,
        )
    }
}

/**
 * Something the host must do that is not state.
 *
 * Haptics are events rather than flags because "vibrate once" cannot be expressed as a state value
 * without the UI having to diff it, and section 5.1 requires the haptic to fire *before* the
 * secondary click is delivered.
 */
sealed interface RemoteGestureSignal {
    data object SecondaryClickHaptic : RemoteGestureSignal
    data object DragLockHaptic : RemoteGestureSignal
}
