package one.zephyr.mobile.feature.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The viewport arithmetic from REMOTE_DESKTOP_EXPERIENCE.md 4.
 *
 * Pure, and tested exhaustively because this is where an off-by-one becomes a click that lands on the
 * wrong pixel: every gesture, every pointer event and the cursor layer all read the same transform,
 * so a sign error here is invisible in review and obvious only on a real desktop.
 */
class RemoteViewportTest {

    private val geometry = RemoteFixtures.geometry

    // ---- scales ----------------------------------------------------------------------------------

    @Test
    fun fitAndFillWidthDifferOnANonSquareViewport() {
        assertEquals(0.25f, geometry.fitScale, EPSILON)
        assertEquals(0.5f, geometry.fillWidthScale, EPSILON)
        assertTrue(geometry.isMeasured)
    }

    @Test
    fun anUnmeasuredGeometryReportsUnitScaleRatherThanZero() {
        // A zero scale would divide by zero in every mapping below; 1 is the only safe placeholder.
        assertEquals(1f, RemoteFixtures.unmeasured.fitScale, EPSILON)
        assertEquals(1f, RemoteFixtures.unmeasured.fillWidthScale, EPSILON)
    }

    @Test
    fun theScaleRangeAlwaysContainsFitEvenWhenFitExceedsTheNominalCeiling() {
        // A 10x10 desktop in a 500x500 viewport fits at 50x, well past MAX_SCALE. Clamping fit out of
        // the range would make 适应窗口 unreachable on a tiny remote desktop.
        val tiny = RemoteGeometry(10, 10, 500f, 500f)
        val range = RemoteViewport.scaleRange(tiny)
        assertEquals(RemoteViewport.MIN_SCALE, range.start, EPSILON)
        assertEquals(50f, range.endInclusive, EPSILON)
        assertEquals(50f, RemoteViewport.scaleFor(RemoteViewportMode.FIT, tiny), EPSILON)
    }

    // ---- transforms ------------------------------------------------------------------------------

    @Test
    fun fitCentresTheDesktopInBothAxes() {
        val transform = RemoteViewport.transformFor(RemoteViewportMode.FIT, geometry)
        assertEquals(0.25f, transform.scale, EPSILON)
        assertEquals(125f, transform.offsetXPx, EPSILON)
        assertEquals(0f, transform.offsetYPx, EPSILON)
    }

    @Test
    fun fillWidthLeavesNoHorizontalGapAndPinsTheTop() {
        val transform = RemoteViewport.transformFor(RemoteViewportMode.FILL_WIDTH, geometry)
        assertEquals(0.5f, transform.scale, EPSILON)
        assertEquals(0f, transform.offsetXPx, EPSILON)
        // Taller than the viewport, so the top edge is flush rather than centred: a gap at the top
        // with content cropped at the bottom would be the worst of both.
        assertEquals(0f, transform.offsetYPx, EPSILON)
    }

    @Test
    fun oneToOneIsUnscaledAndFlushToTheOrigin() {
        val transform = RemoteViewport.transformFor(RemoteViewportMode.ONE_TO_ONE, geometry)
        assertEquals(1f, transform.scale, EPSILON)
        assertEquals(0f, transform.offsetXPx, EPSILON)
        assertEquals(0f, transform.offsetYPx, EPSILON)
    }

    @Test
    fun dynamicShowsTheWholeDesktopUntilTheServerHasActuallyResized() {
        // DYNAMIC asks the server to match the viewport. Until it does, cropping would hide the part
        // of the desktop the user is waiting to see.
        assertEquals(
            RemoteViewport.transformFor(RemoteViewportMode.FIT, geometry),
            RemoteViewport.transformFor(RemoteViewportMode.DYNAMIC, geometry),
        )
        assertTrue(RemoteViewportMode.DYNAMIC.isServerNegotiated)
        assertTrue(!RemoteViewportMode.FIT.isServerNegotiated)
    }

    @Test
    fun customKeepsTheUsersPanWhenAnAnchorIsSupplied() {
        // Section 4: switching modes and back must not throw the pan away.
        val anchor = RemoteTransform(2f, -300f, -400f)
        val transform = RemoteViewport.transformFor(
            mode = RemoteViewportMode.CUSTOM,
            geometry = geometry,
            customScale = 2f,
            anchor = anchor,
        )
        assertEquals(2f, transform.scale, EPSILON)
        assertEquals(-300f, transform.offsetXPx, EPSILON)
        assertEquals(-400f, transform.offsetYPx, EPSILON)
    }

    @Test
    fun customWithoutAnAnchorCentresInsteadOfInventingAnOffset() {
        val transform = RemoteViewport.transformFor(
            mode = RemoteViewportMode.CUSTOM,
            geometry = geometry,
            customScale = 2f,
        )
        assertEquals(2f, transform.scale, EPSILON)
        assertEquals(0f, transform.offsetXPx, EPSILON)
        assertEquals(0f, transform.offsetYPx, EPSILON)
    }

    // ---- clamping and panning --------------------------------------------------------------------

    @Test
    fun panWithinBoundsIsApplied() {
        val panned = RemoteViewport.pan(RemoteTransform(1f, 0f, 0f), geometry, -100f, -50f)
        assertEquals(-100f, panned.offsetXPx, EPSILON)
        assertEquals(-50f, panned.offsetYPx, EPSILON)
    }

    @Test
    fun panStopsAtTheEdgeRatherThanOpeningAGap() {
        val panned = RemoteViewport.pan(RemoteTransform(1f, 0f, 0f), geometry, -1000f, 0f)
        // 1000px of desktop in a 500px viewport can travel exactly 500px.
        assertEquals(-500f, panned.offsetXPx, EPSILON)
    }

    @Test
    fun aDimensionSmallerThanTheViewportIsCentredNotPinned() {
        val clamped = RemoteViewport.clamp(RemoteTransform(0.25f, -999f, -999f), geometry)
        assertEquals(125f, clamped.offsetXPx, EPSILON)
        assertEquals(0f, clamped.offsetYPx, EPSILON)
    }

    // ---- zoom ------------------------------------------------------------------------------------

    @Test
    fun pinchKeepsTheRemotePixelUnderTheFingersUnderTheFingers() {
        // The frozen 1:1 tracking requirement from section 4, expressed as an invariant rather than as
        // an offset: whatever the arithmetic, the pixel at the focus must not move.
        val before = RemoteViewport.transformFor(RemoteViewportMode.FIT, geometry)
        val focusX = 250f
        val focusY = 125f
        val under = RemoteViewport.toRemote(focusX, focusY, before, geometry)

        val after = RemoteViewport.zoom(before, geometry, 2f, focusX, focusY)

        assertEquals(0.5f, after.scale, EPSILON)
        assertEquals(RemotePoint(500, 500), under)
        assertEquals(under, RemoteViewport.toRemote(focusX, focusY, after, geometry))
    }

    @Test
    fun zoomIsClampedToTheScaleCeiling() {
        val zoomed = RemoteViewport.zoom(RemoteTransform(1f, 0f, 0f), geometry, 100f, 0f, 0f)
        assertEquals(RemoteViewport.MAX_SCALE, zoomed.scale, EPSILON)
    }

    @Test
    fun aZoomThatWouldNotChangeTheScaleReturnsTheSameTransform() {
        // Identity rather than a recomputed copy: a pinch held at the ceiling must not drift the pan.
        val atCeiling = RemoteTransform(RemoteViewport.MAX_SCALE, -100f, -100f)
        assertSame(atCeiling, RemoteViewport.zoom(atCeiling, geometry, 2f, 10f, 10f))
    }

    @Test
    fun aNonPositiveZoomFactorIsRefused() {
        val transform = RemoteTransform(1f, 0f, 0f)
        assertSame(transform, RemoteViewport.zoom(transform, geometry, 0f, 0f, 0f))
        assertSame(transform, RemoteViewport.zoom(transform, geometry, -2f, 0f, 0f))
    }

    @Test
    fun zoomOnAnUnmeasuredGeometryIsRefused() {
        val transform = RemoteTransform(1f, 0f, 0f)
        assertSame(transform, RemoteViewport.zoom(transform, RemoteFixtures.unmeasured, 2f, 0f, 0f))
    }

    // ---- pointer mapping -------------------------------------------------------------------------

    @Test
    fun aTapInsideThePictureMapsToARemotePixel() {
        val transform = RemoteViewport.transformFor(RemoteViewportMode.FIT, geometry)
        assertEquals(RemotePoint(0, 0), RemoteViewport.toRemote(125f, 0f, transform, geometry))
        assertEquals(RemotePoint(996, 0), RemoteViewport.toRemote(374f, 0f, transform, geometry))
    }

    @Test
    fun aTapOnTheLetterboxIsNotAClickAtTheNearestEdge() {
        // The letterbox is inert. Snapping it to the edge would send an unintended click to the
        // remote desktop; overlay tools are opened only from the floating orb.
        val transform = RemoteViewport.transformFor(RemoteViewportMode.FIT, geometry)
        assertNull(RemoteViewport.toRemote(124f, 0f, transform, geometry))
        assertNull(RemoteViewport.toRemote(376f, 0f, transform, geometry))
        assertNull(RemoteViewport.toRemote(200f, -1f, transform, geometry))
    }

    @Test
    fun aHeldButtonKeepsDeliveringEdgeCoordinatesOutsideThePicture() {
        // Dragging a remote window against the edge of the desktop must not stop the drag the moment
        // the finger leaves the framebuffer.
        val transform = RemoteViewport.transformFor(RemoteViewportMode.FIT, geometry)
        assertEquals(RemotePoint(999, 999), RemoteViewport.toRemoteClamped(500f, 500f, transform, geometry))
        assertEquals(RemotePoint(0, 0), RemoteViewport.toRemoteClamped(-50f, -50f, transform, geometry))
    }

    @Test
    fun theRemoteCursorMapsBackToTheViewport() {
        val transform = RemoteViewport.transformFor(RemoteViewportMode.FIT, geometry)
        val local = RemoteViewport.toLocal(RemotePoint(500, 500), transform)
        assertEquals(250f, local.first, EPSILON)
        assertEquals(125f, local.second, EPSILON)
    }

    @Test
    fun mappingIsRefusedBeforeTheSurfaceHasBeenMeasured() {
        val transform = RemoteTransform(1f, 0f, 0f)
        assertNull(RemoteViewport.toRemote(10f, 10f, transform, RemoteFixtures.unmeasured))
        assertEquals(
            RemotePoint(0, 0),
            RemoteViewport.toRemoteClamped(10f, 10f, transform, RemoteFixtures.unmeasured),
        )
    }

    @Test
    fun aZeroScaleTransformCannotProduceACoordinate() {
        assertNull(RemoteViewport.toRemote(10f, 10f, RemoteTransform(0f, 0f, 0f), geometry))
    }

    // ---- double tap ------------------------------------------------------------------------------

    @Test
    fun doubleTapAwayFromFitReturnsToFit() {
        val target = RemoteViewport.doubleTapTarget(RemoteTransform(1f, 0f, 0f), geometry, null)
        assertEquals(RemoteViewportMode.FIT, target)
    }

    @Test
    fun doubleTapAtFitWithNothingRememberedGoesToOneToOne() {
        val atFit = RemoteViewport.transformFor(RemoteViewportMode.FIT, geometry)
        assertEquals(
            RemoteViewportMode.ONE_TO_ONE,
            RemoteViewport.doubleTapTarget(atFit, geometry, null),
        )
    }

    @Test
    fun doubleTapAtFitReturnsToTheRememberedZoom() {
        val atFit = RemoteViewport.transformFor(RemoteViewportMode.FIT, geometry)
        assertEquals(
            RemoteViewportMode.CUSTOM,
            RemoteViewport.doubleTapTarget(atFit, geometry, 3f),
        )
    }

    @Test
    fun aRememberedZoomEqualToFitIsNotAZoomAtAll() {
        // Otherwise the gesture would appear to do nothing: fit to fit is not a toggle.
        val atFit = RemoteViewport.transformFor(RemoteViewportMode.FIT, geometry)
        assertEquals(
            RemoteViewportMode.ONE_TO_ONE,
            RemoteViewport.doubleTapTarget(atFit, geometry, geometry.fitScale),
        )
    }

    // ---- rubber band -----------------------------------------------------------------------------

    @Test
    fun rubberBandIsSignPreservingAndDamped() {
        assertEquals(-49.5495f, RemoteViewport.rubberBand(-100f, 500f), 0.01f)
        assertEquals(49.5495f, RemoteViewport.rubberBand(100f, 500f), 0.01f)
    }

    @Test
    fun rubberBandCannotDragTheContentArbitrarilyFarOffScreen() {
        assertTrue(RemoteViewport.rubberBand(1_000_000f, 500f) < 500f)
    }

    @Test
    fun rubberBandOnAZeroDimensionIsZeroRatherThanInfinite() {
        assertEquals(0f, RemoteViewport.rubberBand(50f, 0f), EPSILON)
    }

    private companion object {
        const val EPSILON = 0.0001f
    }
}
