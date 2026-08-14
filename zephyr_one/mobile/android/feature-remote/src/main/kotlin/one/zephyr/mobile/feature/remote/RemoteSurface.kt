package one.zephyr.mobile.feature.remote

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color as AndroidColor
import android.graphics.Matrix
import android.graphics.Paint
import android.os.Handler
import android.os.HandlerThread
import android.view.SurfaceHolder
import android.view.SurfaceView
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.PointerEvent
import androidx.compose.ui.input.pointer.PointerEventType
import androidx.compose.ui.input.pointer.PointerInputChange
import androidx.compose.ui.input.pointer.isPrimaryPressed
import androidx.compose.ui.input.pointer.isSecondaryPressed
import androidx.compose.ui.input.pointer.isTertiaryPressed
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import one.zephyr.mobile.ui.theme.LocalZephyrPalette
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.math.abs
import kotlin.math.sqrt

/**
 * The framebuffer renderer.
 *
 * A SurfaceView rather than a Compose Canvas because REMOTE_DESKTOP_EXPERIENCE.md 11 requires one
 * spike-proven path with pixel conversion off the main thread, and Compose only hosting chrome. The
 * patch-to-ARGB conversion and the blit both run on this view's own render thread; the composable
 * above only hands over a drained batch, which is a list swap.
 *
 * Not a Compose-visible type on purpose: nothing here reads or writes snapshot state, so a frame
 * arriving at 60 Hz cannot invalidate a composition.
 */
internal class RemoteRenderView(context: Context) : SurfaceView(context) {

    private val framebuffer = RemoteFramebuffer()
    private var bitmap: Bitmap? = null

    private val paint = Paint()
    private val matrix = Matrix()

    private var thread: HandlerThread? = null
    private var handler: Handler? = null

    private val transformLock = Any()
    private var pendingTransform: RemoteTransform? = null
    private var transformScheduled = false
    private val transformRunnable = Runnable {
        val next = synchronized(transformLock) {
            transformScheduled = false
            pendingTransform.also { pendingTransform = null }
        }
        val source = bitmap
        if (next != null && source != null) blit(source, next)
    }

    @Volatile
    private var surfaceValid = false

    /** Set when the surface was recreated, so the next batch repaints everything it has. */
    @Volatile
    private var surfaceDirty = false

    /**
     * Full-frame repaints that could not be satisfied from the engine.
     *
     * The mailbox can demand a full repaint after it drops a backlog, and the correct recovery is a
     * non-incremental update request. Neither engine port exposes one yet (ADR-004 / ADR-005), so the
     * composite already held here is re-blitted and this counter records the gap rather than the code
     * pretending the picture is guaranteed current.
     */
    @Volatile
    var unservicedFullRepaints: Int = 0
        private set

    init {
        holder.addCallback(
            object : SurfaceHolder.Callback {
                override fun surfaceCreated(holder: SurfaceHolder) {
                    surfaceValid = true
                    surfaceDirty = true
                }

                override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
                    surfaceDirty = true
                }

                override fun surfaceDestroyed(holder: SurfaceHolder) {
                    surfaceValid = false
                }
            },
        )
    }

    fun start() {
        if (thread != null) return
        // Above default priority: section 11 puts the frame path ahead of background work, and a
        // render thread that loses to a sync round is a visible stutter.
        val created = HandlerThread("zephyr-remote-render", android.os.Process.THREAD_PRIORITY_DISPLAY)
        created.start()
        thread = created
        handler = Handler(created.looper)
    }

    fun stop() {
        handler?.removeCallbacksAndMessages(null)
        handler = null
        synchronized(transformLock) {
            pendingTransform = null
            transformScheduled = false
        }
        thread?.quitSafely()
        thread = null
        bitmap?.recycle()
        bitmap = null
    }

    /**
     * Drains and renders exactly one mailbox batch.
     *
     * The caller awaits completion, so its conflated frame channel cannot enqueue another render
     * task while this one is running. Pixels stay in the bounded mailbox until the render thread is
     * ready for them instead of moving into an unbounded Handler queue.
     */
    suspend fun renderNext(controller: RemoteSessionController) {
        val completion = CompletableDeferred<Unit>()
        val accepted = handler?.post {
            try {
                val surface = controller.state.value
                render(
                    drain = controller.drainFrames(),
                    remoteWidthPx = surface.geometry.remoteWidthPx,
                    remoteHeightPx = surface.geometry.remoteHeightPx,
                    transform = surface.transform,
                )
            } finally {
                completion.complete(Unit)
            }
        } == true
        if (!accepted) completion.complete(Unit)
        completion.await()
    }

    /** Coalesces gesture transforms and redraws the existing Bitmap without uploading its pixels. */
    fun updateTransform(transform: RemoteTransform) {
        val target = handler ?: return
        val shouldPost = synchronized(transformLock) {
            pendingTransform = transform
            if (transformScheduled) {
                false
            } else {
                transformScheduled = true
                true
            }
        }
        if (shouldPost && !target.post(transformRunnable)) {
            synchronized(transformLock) { transformScheduled = false }
        }
    }

    private fun render(
        drain: FrameDrain,
        remoteWidthPx: Int,
        remoteHeightPx: Int,
        transform: RemoteTransform,
    ) {
        if (remoteWidthPx <= 0 || remoteHeightPx <= 0) return
        framebuffer.resize(remoteWidthPx, remoteHeightPx)
        ensureBitmap(remoteWidthPx, remoteHeightPx)
        val target = bitmap ?: return

        var touched = FrameRegion(0, 0, 0, 0)
        for (patch in drain.patches) {
            if (framebuffer.apply(patch)) touched = touched.union(patch.region)
        }

        val everything = drain.fullRepaint || surfaceDirty
        if (drain.fullRepaint) unservicedFullRepaints += 1

        if (everything) {
            target.setPixels(framebuffer.pixels(), 0, remoteWidthPx, 0, 0, remoteWidthPx, remoteHeightPx)
        } else if (!touched.isEmpty) {
            val x = touched.x.coerceIn(0, remoteWidthPx)
            val y = touched.y.coerceIn(0, remoteHeightPx)
            val width = touched.width.coerceAtMost(remoteWidthPx - x)
            val height = touched.height.coerceAtMost(remoteHeightPx - y)
            if (width > 0 && height > 0) {
                target.setPixels(
                    framebuffer.pixels(),
                    y * remoteWidthPx + x,
                    remoteWidthPx,
                    x,
                    y,
                    width,
                    height,
                )
            }
        } else if (drain.patches.isNotEmpty()) {
            return
        }

        blit(target, transform)
        surfaceDirty = false
    }

    private fun ensureBitmap(widthPx: Int, heightPx: Int) {
        val current = bitmap
        if (current != null && current.width == widthPx && current.height == heightPx) return
        current?.recycle()
        bitmap = Bitmap.createBitmap(widthPx, heightPx, Bitmap.Config.ARGB_8888)
        surfaceDirty = true
    }

    private fun blit(source: Bitmap, transform: RemoteTransform) {
        if (!surfaceValid) return
        val canvas = runCatching { holder.lockCanvas() }.getOrNull() ?: return
        try {
            // Black rather than the theme background: the letterbox around a remote desktop is not a
            // themed surface, and tinting it would misreport the desktop's own edges.
            canvas.drawColor(AndroidColor.BLACK)
            matrix.reset()
            matrix.setScale(transform.scale, transform.scale)
            matrix.postTranslate(transform.offsetXPx, transform.offsetYPx)
            // Filtered only when minifying. At or above 1:1 the user asked to inspect pixels, and
            // smoothing them is the one thing 1:1 mode exists to avoid.
            paint.isFilterBitmap = transform.scale < 1f
            canvas.drawBitmap(source, matrix, paint)
        } finally {
            runCatching { holder.unlockCanvasAndPost(canvas) }
        }
    }
}

/**
 * The remote desktop surface and the whole touch story.
 *
 * Holds [RemoteSessionController] directly rather than going through [RemoteIntent]: a pointer move
 * arrives tens of times a second, and section 11 requires it on a separate high-priority path where
 * only moves coalesce. Chrome, sheets and prompts go through the intent surface instead - see
 * [RemoteIntent] for why the boundary is drawn here.
 *
 * @param onChromeTap called for a tap the remote did not consume, which is the section 12 rule that
 *   empty space toggles chrome while a pointer interaction never does.
 */
@Composable
fun RemoteSurface(
    controller: RemoteSessionController,
    onChromeTap: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val surface by controller.state.collectAsStateWithLifecycle()
    val haptics = LocalHapticFeedback.current
    val lifecycleOwner = LocalLifecycleOwner.current

    val view = remember { RemoteViewHolder() }

    // Haptics are events, not state: section 5.1 requires the secondary-click buzz to fire before the
    // click is delivered, and the controller emits the signal before it enqueues the button.
    LaunchedEffect(controller, lifecycleOwner) {
        lifecycleOwner.lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            controller.gestureSignals.collect { signal ->
                when (signal) {
                    RemoteGestureSignal.SecondaryClickHaptic ->
                        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                    RemoteGestureSignal.DragLockHaptic ->
                        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                }
            }
        }
    }

    Box(
        modifier = modifier
            .fillMaxSize()
            .onSizeChanged { size ->
                // requestResize only in DYNAMIC: the other four modes are local transforms, and
                // asking the server to resize on every rotation in FIT mode would renegotiate a
                // session the user only wanted re-fitted (section 4).
                controller.onViewportMeasured(
                    widthPx = size.width.toFloat(),
                    heightPx = size.height.toFloat(),
                    requestResize = controller.state.value.mode == RemoteViewportMode.DYNAMIC,
                )
            }
            .remoteGestures(controller, onChromeTap)
            .remoteHardwarePointer(controller),
    ) {
        AndroidView(
            factory = { context ->
                RemoteRenderView(context).also { created ->
                    created.start()
                    view.value = created
                }
            },
            modifier = Modifier.fillMaxSize(),
        )

        LaunchedEffect(controller, lifecycleOwner) {
            lifecycleOwner.lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
                controller.frameRequests.collect {
                    view.value?.renderNext(controller)
                }
            }
        }

        // A gesture only changes the matrix. The framebuffer Bitmap is already current and must not
        // be uploaded again on every pan/pinch event.
        LaunchedEffect(surface.transform) {
            view.value?.updateTransform(surface.transform)
        }

        DisposableEffect(Unit) {
            onDispose {
                view.value?.stop()
                view.value = null
            }
        }

        // The trackpad cursor, on its own layer as section 11 requires. Only in trackpad mode: in
        // direct mode the finger is the cursor, and a second marker would fight the remote's own.
        if (surface.pointer.mode == RemotePointerMode.TRACKPAD && surface.geometry.isMeasured) {
            RemoteCursorMarker(surface = surface, modifier = Modifier.fillMaxSize())
        }
    }
}

/**
 * A holder for the view handed back by [AndroidView]'s factory.
 *
 * Deliberately not snapshot state: writing the view into a MutableState from inside the factory would
 * schedule a recomposition during composition, and the render view is not something composition needs
 * to observe - only the drain effect touches it.
 */
internal class RemoteViewHolder {
    var value: RemoteRenderView? = null
}

/**
 * The trackpad cursor.
 *
 * Its own layer, as section 11 requires: the remote framebuffer already contains whatever cursor the
 * far side draws, and compositing this marker into the bitmap would make every cursor move a
 * framebuffer write. Drawn only in trackpad mode, where the finger is nowhere near the pointer.
 */
@Composable
private fun RemoteCursorMarker(surface: RemoteSurfaceState, modifier: Modifier = Modifier) {
    val palette = LocalZephyrPalette.current
    Canvas(modifier = modifier) {
        val local = RemoteViewport.toLocal(surface.pointer.cursor, surface.transform)
        val centre = Offset(local.first, local.second)
        // Two rings rather than one: a single colour disappears against a desktop of the same shade,
        // and a halo keeps it findable without hiding the pixel underneath.
        drawCircle(
            color = palette.surfaces.scrim,
            radius = CURSOR_HALO_PX,
            center = centre,
            style = Stroke(width = CURSOR_STROKE_PX * 2f),
        )
        drawCircle(
            color = if (surface.pointer.dragLock) palette.status.warning else palette.brand.accent,
            radius = CURSOR_RING_PX,
            center = centre,
            style = Stroke(width = CURSOR_STROKE_PX),
        )
    }
}

/**
 * The one gesture loop.
 *
 * Deliberately not detectTapGestures plus detectTransformGestures: two detectors race over the same
 * down event, and both touch modes in sections 5.1 and 5.2 are defined by an ordering - pinch beats
 * remote gestures, a long press beats a drag, a lift after remote input is not a chrome tap. Written
 * as one loop, that ordering is readable against the frozen table instead of being an emergent
 * property of two arbiters.
 */
private fun Modifier.remoteGestures(
    controller: RemoteSessionController,
    onChromeTap: () -> Unit,
): Modifier = pointerInput(controller) {
    var lastTapUptime = 0L

    awaitEachGesture {
        val down = awaitFirstDown(requireUnconsumed = false)
        val mode = controller.state.value.pointer.mode
        controller.onGestureStart()

        var centroid = down.position
        var span = 0f
        var pointerCount = 1
        var maxPointerCount = 1
        var travel = 0f
        var wheelResidual = 0f
        var horizontalResidual = 0f
        var released = false
        var dragging = false
        var pinched = false
        var longPressed = false
        var last = down.position

        // A double tap is decided by the gap between this down and the previous lift, which is the
        // only place both are known. In trackpad mode it also arms the drag lock (section 5.2).
        val doubleTap = down.uptimeMillis - lastTapUptime <= DOUBLE_TAP_MS

        fun consume(event: PointerEvent) {
            val pressed = event.changes.filter { it.pressed }
            if (pressed.isEmpty()) {
                released = true
                return
            }

            val nextCentroid = centroidOf(pressed)
            val nextSpan = spanOf(pressed, nextCentroid)
            val countChanged = pressed.size != pointerCount

            // Rebased on a pointer count change: a finger arriving or leaving moves the centroid and
            // the span discontinuously, and accumulating that would read a second finger as a
            // full-screen pinch.
            val dx = if (countChanged) 0f else nextCentroid.x - centroid.x
            val dy = if (countChanged) 0f else nextCentroid.y - centroid.y
            val spanDelta = if (countChanged) 0f else nextSpan - span

            centroid = nextCentroid
            span = nextSpan
            pointerCount = pressed.size
            maxPointerCount = maxOf(maxPointerCount, pressed.size)
            last = nextCentroid
            travel += abs(dx) + abs(dy)

            // Three or more fingers are left alone: section 5.2 forbids taking over the system
            // navigation gestures, and the safest way to honour that is to not claim them.
            if (pressed.size >= SYSTEM_GESTURE_POINTERS) return

            if (pressed.size >= 2) {
                // Pinch has priority over every remote gesture (sections 5.1 and 5.2), so it is
                // tested first and a pinching gesture never also scrolls.
                if (abs(spanDelta) > PINCH_SLOP_PX && span > 0f && span - spanDelta > 0f) {
                    pinched = true
                    controller.onPinch(
                        factor = span / (span - spanDelta),
                        focusXPx = nextCentroid.x,
                        focusYPx = nextCentroid.y,
                    )
                    event.changes.forEach { it.consume() }
                    return
                }
                if (pinched) {
                    // Two-finger movement after a pinch pans the local viewport rather than
                    // scrolling the remote: the user is still framing the picture.
                    controller.onPan(dx, dy)
                    event.changes.forEach { it.consume() }
                    return
                }
                wheelResidual += dy
                horizontalResidual += dx
                val vertical = (wheelResidual / WHEEL_STEP_PX).toInt()
                val horizontal = (horizontalResidual / WHEEL_STEP_PX).toInt()
                if (vertical != 0) {
                    wheelResidual -= vertical * WHEEL_STEP_PX
                    // Negated into the neutral convention: a positive notch means "toward the
                    // bottom of the document", and a finger moving up scrolls that way.
                    controller.onWheel(-vertical, nextCentroid.x, nextCentroid.y)
                }
                if (horizontal != 0) {
                    horizontalResidual -= horizontal * WHEEL_STEP_PX
                    controller.onWheel(-horizontal, nextCentroid.x, nextCentroid.y, horizontal = true)
                }
                event.changes.forEach { it.consume() }
                return
            }

            if (travel <= TAP_SLOP_PX) return

            when (mode) {
                RemotePointerMode.DIRECT -> {
                    if (!dragging) {
                        dragging = true
                        controller.onDragStart(nextCentroid.x, nextCentroid.y)
                    } else {
                        controller.onDragTo(nextCentroid.x, nextCentroid.y)
                    }
                }
                RemotePointerMode.TRACKPAD -> {
                    if (!dragging && (doubleTap || longPressed)) {
                        // Double-tap-and-drag, the frozen trackpad drag-lock gesture. The haptic and
                        // the button-down were already delivered by engageDragLock.
                        dragging = true
                        if (!longPressed) controller.onLongPress(nextCentroid.x, nextCentroid.y)
                    }
                    dragging = true
                    controller.onRelativeMove(dx, dy)
                }
            }
        }

        // A long press is a timeout with no qualifying movement, so it is detected by racing the
        // pointer stream against the platform threshold rather than by a second detector.
        val settled = withTimeoutOrNull(LONG_PRESS_MS) {
            var interrupted = false
            while (!interrupted) {
                consume(awaitPointerEvent())
                if (released || travel > TAP_SLOP_PX || pointerCount > 1) interrupted = true
            }
            true
        }
        if (settled == null) {
            longPressed = true
            controller.onLongPress(last.x, last.y)
        }

        while (!released) {
            consume(awaitPointerEvent())
        }

        val tapped = !longPressed && !pinched && travel <= TAP_SLOP_PX

        when {
            // Two-finger tap is the trackpad secondary click (section 5.2). Recognised from the
            // high-water pointer count, because by the lift both fingers are already gone.
            tapped && maxPointerCount == 2 && mode == RemotePointerMode.TRACKPAD -> {
                controller.onSecondaryClickAtCursor()
            }

            tapped && maxPointerCount == 1 -> {
                lastTapUptime = down.uptimeMillis
                if (doubleTap) {
                    controller.onDoubleTap(last.x, last.y)
                } else if (!controller.onTap(last.x, last.y)) {
                    // Fell on the letterbox, so it was never remote input. Section 12: empty space
                    // toggles chrome.
                    onChromeTap()
                }
            }

            dragging && mode == RemotePointerMode.DIRECT -> controller.onDragEnd()
        }

        controller.onGestureEnd()
    }
}

/**
 * A physical mouse or trackpad.
 *
 * Separate from the touch loop because hover and scroll have no down and no up: folding them into
 * awaitEachGesture would make them wait for a press that never arrives. Section 5.3 requires hover,
 * wheel, relative movement and button chords to pass through, and hover specifically must not open
 * all of the chrome.
 */
private fun Modifier.remoteHardwarePointer(controller: RemoteSessionController): Modifier =
    pointerInput(controller) {
        awaitPointerEventScope {
            while (true) {
                val event = awaitPointerEvent()
                val change = event.changes.firstOrNull() ?: continue
                when (event.type) {
                    PointerEventType.Scroll -> {
                        val vertical = change.scrollDelta.y.toInt()
                        val horizontal = change.scrollDelta.x.toInt()
                        if (vertical != 0) {
                            controller.onWheel(vertical, change.position.x, change.position.y)
                        }
                        if (horizontal != 0) {
                            controller.onWheel(
                                notches = horizontal,
                                localXPx = change.position.x,
                                localYPx = change.position.y,
                                horizontal = true,
                            )
                        }
                    }

                    PointerEventType.Move, PointerEventType.Enter -> {
                        if (change.pressed) continue
                        controller.onHover(
                            localXPx = change.position.x,
                            localYPx = change.position.y,
                            buttons = buttonMaskOf(event),
                        )
                    }

                    PointerEventType.Press, PointerEventType.Release -> {
                        // Only for a real mouse: a finger press is the touch loop's business, and
                        // handling it twice would double every tap.
                        if (change.type != androidx.compose.ui.input.pointer.PointerType.Mouse) continue
                        controller.onHover(
                            localXPx = change.position.x,
                            localYPx = change.position.y,
                            buttons = buttonMaskOf(event),
                        )
                    }

                    else -> Unit
                }
            }
        }
    }

/** Compose button state to the neutral mask, which matches RFB bit for bit by design. */
private fun buttonMaskOf(event: PointerEvent): Int {
    var mask = RemoteButton.NONE
    if (event.buttons.isPrimaryPressed) mask = mask or RemoteButton.PRIMARY
    if (event.buttons.isSecondaryPressed) mask = mask or RemoteButton.SECONDARY
    if (event.buttons.isTertiaryPressed) mask = mask or RemoteButton.MIDDLE
    return mask
}

private fun centroidOf(changes: List<PointerInputChange>): Offset {
    if (changes.isEmpty()) return Offset.Zero
    var x = 0f
    var y = 0f
    for (change in changes) {
        x += change.position.x
        y += change.position.y
    }
    return Offset(x / changes.size, y / changes.size)
}

/**
 * Pinch magnitude as the mean distance from the centroid.
 *
 * Monotone in the finger separation for any pointer count, so a third finger does not produce the
 * discontinuity a first-to-second-pointer distance would.
 */
private fun spanOf(changes: List<PointerInputChange>, centroid: Offset): Float {
    if (changes.size < 2) return 0f
    var total = 0f
    for (change in changes) {
        val dx = change.position.x - centroid.x
        val dy = change.position.y - centroid.y
        total += sqrt(dx * dx + dy * dy)
    }
    return total / changes.size
}

private const val LONG_PRESS_MS = 500L
private const val DOUBLE_TAP_MS = 300L
private const val TAP_SLOP_PX = 12f
private const val PINCH_SLOP_PX = 6f

/** Finger travel per wheel notch. Tuned so a comfortable two-finger swipe is three or four notches. */
private const val WHEEL_STEP_PX = 48f

/** At this many fingers the gesture belongs to the system, not to the session. */
private const val SYSTEM_GESTURE_POINTERS = 3

private const val CURSOR_RING_PX = 9f
private const val CURSOR_HALO_PX = 11f
private const val CURSOR_STROKE_PX = 2f
