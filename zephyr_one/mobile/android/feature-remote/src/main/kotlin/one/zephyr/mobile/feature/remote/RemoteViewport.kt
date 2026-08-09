package one.zephyr.mobile.feature.remote

import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * How the remote framebuffer is fitted into the local viewport.
 *
 * REMOTE_DESKTOP_EXPERIENCE.md 4 freezes five modes. [DYNAMIC] is the only one that changes anything
 * on the far side: the other four are purely local transforms, which is what lets an orientation
 * change re-fit the picture without renegotiating a session.
 */
enum class RemoteViewportMode {
    /** The whole desktop is visible, letterboxed if the aspect ratios differ. */
    FIT,

    /** Width fills the viewport; the user pans vertically. */
    FILL_WIDTH,

    /** One remote pixel per device pixel, for fine inspection. */
    ONE_TO_ONE,

    /** Whatever scale and anchor the user pinched to. */
    CUSTOM,

    /** Ask the server to match the available viewport. RDP only. */
    DYNAMIC,
    ;

    val isServerNegotiated: Boolean get() = this == DYNAMIC
}

/**
 * The two rectangles that decide every transform.
 *
 * Remote size is in remote pixels and viewport size in device pixels, kept as Int and Float
 * respectively because the framebuffer is a discrete grid while the viewport is a measured layout.
 */
data class RemoteGeometry(
    val remoteWidthPx: Int,
    val remoteHeightPx: Int,
    val viewportWidthPx: Float,
    val viewportHeightPx: Float,
) {
    val isMeasured: Boolean
        get() = remoteWidthPx > 0 && remoteHeightPx > 0 && viewportWidthPx > 0f && viewportHeightPx > 0f

    /** Largest scale at which the whole desktop still fits. */
    val fitScale: Float
        get() = if (!isMeasured) 1f else min(
            viewportWidthPx / remoteWidthPx,
            viewportHeightPx / remoteHeightPx,
        )

    val fillWidthScale: Float
        get() = if (!isMeasured) 1f else viewportWidthPx / remoteWidthPx
}

/**
 * A local view transform.
 *
 * @param offsetXPx position of the remote image top-left corner in viewport coordinates. Stored as
 *   the corner rather than as a centre point because clamping, rubber banding and pointer mapping
 *   all read the corner, and deriving it from a centre on every frame is where sign errors live.
 */
data class RemoteTransform(
    val scale: Float,
    val offsetXPx: Float,
    val offsetYPx: Float,
) {
    fun scaledWidthPx(geometry: RemoteGeometry): Float = geometry.remoteWidthPx * scale

    fun scaledHeightPx(geometry: RemoteGeometry): Float = geometry.remoteHeightPx * scale
}

/** A point on the remote framebuffer grid. */
data class RemotePoint(val x: Int, val y: Int)

/**
 * Viewport arithmetic for both protocols.
 *
 * Pure and shared: REMOTE_DESKTOP_EXPERIENCE.md 2 puts ViewportTransform above the protocol adapter,
 * so RDP and VNC cannot drift into two different ideas of where the user just tapped. The one rule
 * every function here preserves is that [RemoteGeometry.fitScale] is always reachable - a viewport
 * the user cannot get back to fit is a viewport they cannot recover from.
 */
object RemoteViewport {

    /** Absolute floor, widened when the desktop is so large that even fit is smaller. */
    const val MIN_SCALE = 0.25f

    /** Absolute ceiling, widened when the desktop is so small that fit is larger. */
    const val MAX_SCALE = 8f

    /** UIScrollView-style resistance constant. */
    const val RUBBER_BAND_FACTOR = 0.55f

    /**
     * Legal scale range for this geometry.
     *
     * Both ends are widened to admit [RemoteGeometry.fitScale] so a 4K desktop on a phone can still
     * reach fit, and an 800x600 desktop on a tablet can still be scaled up to fill the screen.
     */
    fun scaleRange(geometry: RemoteGeometry): ClosedFloatingPointRange<Float> {
        val fit = geometry.fitScale
        return min(MIN_SCALE, fit)..max(MAX_SCALE, fit)
    }

    fun scaleFor(mode: RemoteViewportMode, geometry: RemoteGeometry, customScale: Float = 1f): Float {
        val raw = when (mode) {
            RemoteViewportMode.FIT -> geometry.fitScale
            RemoteViewportMode.FILL_WIDTH -> geometry.fillWidthScale
            RemoteViewportMode.ONE_TO_ONE -> 1f
            RemoteViewportMode.CUSTOM -> customScale
            // The server is asked to match the viewport, so once it has, the picture is 1:1. Until
            // then fit keeps the whole desktop visible rather than cropping it.
            RemoteViewportMode.DYNAMIC -> geometry.fitScale
        }
        return raw.coerceIn(scaleRange(geometry))
    }

    /**
     * The transform for a mode, centred and clamped.
     *
     * @param anchor kept for [RemoteViewportMode.CUSTOM]: switching away and back must not throw the
     *   user's pan away. Null centres the content.
     */
    fun transformFor(
        mode: RemoteViewportMode,
        geometry: RemoteGeometry,
        customScale: Float = 1f,
        anchor: RemoteTransform? = null,
    ): RemoteTransform {
        val scale = scaleFor(mode, geometry, customScale)
        val base = if (mode == RemoteViewportMode.CUSTOM && anchor != null) {
            RemoteTransform(scale, anchor.offsetXPx, anchor.offsetYPx)
        } else {
            RemoteTransform(scale, 0f, 0f)
        }
        return clamp(base, geometry)
    }

    /**
     * Pulls a transform back into legal bounds.
     *
     * A dimension smaller than the viewport is centred; a larger one is clamped so no gap can appear
     * at an edge. This is the only place either decision is made, so a pan, a pinch and a rotation
     * cannot disagree about where the edges are.
     */
    fun clamp(transform: RemoteTransform, geometry: RemoteGeometry): RemoteTransform {
        if (!geometry.isMeasured) return transform
        val scaledWidth = transform.scaledWidthPx(geometry)
        val scaledHeight = transform.scaledHeightPx(geometry)
        val x = if (scaledWidth <= geometry.viewportWidthPx) {
            (geometry.viewportWidthPx - scaledWidth) / 2f
        } else {
            transform.offsetXPx.coerceIn(geometry.viewportWidthPx - scaledWidth, 0f)
        }
        val y = if (scaledHeight <= geometry.viewportHeightPx) {
            (geometry.viewportHeightPx - scaledHeight) / 2f
        } else {
            transform.offsetYPx.coerceIn(geometry.viewportHeightPx - scaledHeight, 0f)
        }
        return transform.copy(offsetXPx = x, offsetYPx = y)
    }

    fun pan(
        transform: RemoteTransform,
        geometry: RemoteGeometry,
        dxPx: Float,
        dyPx: Float,
    ): RemoteTransform = clamp(
        transform.copy(offsetXPx = transform.offsetXPx + dxPx, offsetYPx = transform.offsetYPx + dyPx),
        geometry,
    )

    /**
     * Pinch zoom about a focal point.
     *
     * The remote pixel under the two fingers stays under the two fingers, which is what makes the
     * gesture track 1:1 as REMOTE_DESKTOP_EXPERIENCE.md 4 requires. Solving for the offset rather
     * than scaling the offset is the difference between the picture following the fingers and the
     * picture sliding out from under them.
     */
    fun zoom(
        transform: RemoteTransform,
        geometry: RemoteGeometry,
        factor: Float,
        focalXPx: Float,
        focalYPx: Float,
    ): RemoteTransform {
        if (!geometry.isMeasured || factor <= 0f) return transform
        val next = (transform.scale * factor).coerceIn(scaleRange(geometry))
        if (next == transform.scale) return transform
        val ratio = next / transform.scale
        return clamp(
            RemoteTransform(
                scale = next,
                offsetXPx = focalXPx - (focalXPx - transform.offsetXPx) * ratio,
                offsetYPx = focalYPx - (focalYPx - transform.offsetYPx) * ratio,
            ),
            geometry,
        )
    }

    /**
     * Where a double tap goes.
     *
     * Toggles between fit and the most recent user zoom, per REMOTE_DESKTOP_EXPERIENCE.md 4. With no
     * remembered zoom it goes to 1:1, which is the useful second state on a desktop that already
     * fits.
     */
    fun doubleTapTarget(
        current: RemoteTransform,
        geometry: RemoteGeometry,
        rememberedScale: Float?,
    ): RemoteViewportMode {
        val fit = scaleFor(RemoteViewportMode.FIT, geometry)
        val atFit = kotlin.math.abs(current.scale - fit) < SCALE_EPSILON
        if (!atFit) return RemoteViewportMode.FIT
        val remembered = rememberedScale ?: return RemoteViewportMode.ONE_TO_ONE
        return if (kotlin.math.abs(remembered - fit) < SCALE_EPSILON) {
            RemoteViewportMode.ONE_TO_ONE
        } else {
            RemoteViewportMode.CUSTOM
        }
    }

    /**
     * Visual resistance past an edge.
     *
     * Asymptotic rather than linear so the content can never be dragged arbitrarily far off screen,
     * and monotonic so the finger and the picture never move in opposite directions.
     */
    fun rubberBand(overshootPx: Float, dimensionPx: Float): Float {
        if (dimensionPx <= 0f) return 0f
        val magnitude = kotlin.math.abs(overshootPx)
        val damped = (1f - 1f / (magnitude * RUBBER_BAND_FACTOR / dimensionPx + 1f)) * dimensionPx
        return if (overshootPx < 0f) -damped else damped
    }

    /**
     * Maps a viewport point to a remote pixel, or null when it is outside the picture.
     *
     * Strict on purpose: a tap on the letterbox is not a click at the nearest edge, and turning one
     * into the other would make the desktop border unusable as a place to dismiss chrome.
     */
    fun toRemote(
        localXPx: Float,
        localYPx: Float,
        transform: RemoteTransform,
        geometry: RemoteGeometry,
    ): RemotePoint? {
        if (!geometry.isMeasured || transform.scale <= 0f) return null
        val x = (localXPx - transform.offsetXPx) / transform.scale
        val y = (localYPx - transform.offsetYPx) / transform.scale
        if (x < 0f || y < 0f) return null
        if (x > geometry.remoteWidthPx - 1 || y > geometry.remoteHeightPx - 1) return null
        return RemotePoint(x.roundToInt(), y.roundToInt())
    }

    /**
     * Maps a viewport point to the nearest remote pixel.
     *
     * Used while a button is held: dragging a window against the edge of the desktop must keep
     * delivering edge coordinates rather than stopping the drag the moment the finger leaves the
     * picture.
     */
    fun toRemoteClamped(
        localXPx: Float,
        localYPx: Float,
        transform: RemoteTransform,
        geometry: RemoteGeometry,
    ): RemotePoint {
        if (!geometry.isMeasured || transform.scale <= 0f) return RemotePoint(0, 0)
        val x = (localXPx - transform.offsetXPx) / transform.scale
        val y = (localYPx - transform.offsetYPx) / transform.scale
        return RemotePoint(
            x.roundToInt().coerceIn(0, geometry.remoteWidthPx - 1),
            y.roundToInt().coerceIn(0, geometry.remoteHeightPx - 1),
        )
    }

    /** Maps a remote pixel back to the viewport, for drawing the remote cursor. */
    fun toLocal(point: RemotePoint, transform: RemoteTransform): Pair<Float, Float> = Pair(
        transform.offsetXPx + point.x * transform.scale,
        transform.offsetYPx + point.y * transform.scale,
    )

    private const val SCALE_EPSILON = 0.001f
}
