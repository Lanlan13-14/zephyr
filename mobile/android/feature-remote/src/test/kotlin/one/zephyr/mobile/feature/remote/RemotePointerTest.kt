package one.zephyr.mobile.feature.remote

import one.zephyr.mobile.model.RdpTouchMode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Gesture to remote pointer translation (REMOTE_DESKTOP_EXPERIENCE.md 5).
 *
 * Two properties carry most of these tests. First, the move always precedes the button: some Windows
 * controls read the pointer position from the button-down message rather than from the event, so a
 * press that arrives before the move clicks whatever was under the *old* cursor. Second, nothing is
 * emitted for a no-op - a repeated tap on the same pixel, a mode switch to the current mode, a zero
 * wheel - because a redundant event still costs a round trip on a weak link.
 */
class RemotePointerTest {

    private val geometry = RemoteFixtures.geometry

    private fun controller(
        mode: RemotePointerMode = RemotePointerMode.DIRECT,
        sensitivity: Float = 1.5f,
        swapLongPress: Boolean = false,
    ) = RemotePointerController(mode, sensitivity, swapLongPress)

    /** Puts the cursor somewhere without going through a gesture, so a test can start mid-desktop. */
    private fun RemotePointerController.placeAt(x: Int, y: Int) {
        hardware(RemotePoint(x, y), RemoteButton.NONE)
    }

    // ---- button mask -----------------------------------------------------------------------------

    @Test
    fun theButtonMaskIsRfbBitOrder() {
        /* Frozen to RFB's order because RFB has no separate press/release event - the mask *is* the
         * event - so matching it means the VNC adapter passes it straight through. RDP names its own
         * per-button flags and maps each one explicitly, so nothing is lost. */
        assertEquals(0, RemoteButton.NONE)
        assertEquals(1, RemoteButton.PRIMARY)
        assertEquals(2, RemoteButton.MIDDLE)
        assertEquals(4, RemoteButton.SECONDARY)
    }

    @Test
    fun maskMembershipIsBitwiseNotEquality() {
        val chord = RemoteButton.PRIMARY or RemoteButton.SECONDARY
        assertTrue(RemoteButton.has(chord, RemoteButton.PRIMARY))
        assertTrue(RemoteButton.has(chord, RemoteButton.SECONDARY))
        // The middle button is not in the chord, and an equality test would have said it was not in
        // any chord at all.
        assertFalse(RemoteButton.has(chord, RemoteButton.MIDDLE))
        assertFalse(RemoteButton.has(RemoteButton.NONE, RemoteButton.PRIMARY))
    }

    @Test
    fun everyButtonHasADiagnosticName() {
        assertEquals("primary", RemoteButton.name(RemoteButton.PRIMARY))
        assertEquals("middle", RemoteButton.name(RemoteButton.MIDDLE))
        assertEquals("secondary", RemoteButton.name(RemoteButton.SECONDARY))
        // An unknown button is named rather than dropped, so a diagnostics log stays readable.
        assertEquals("button8", RemoteButton.name(8))
    }

    // ---- acceleration ----------------------------------------------------------------------------

    @Test
    fun sensitivityIsClampedToTheFrozenRange() {
        assertEquals(0.5f, RemotePointerAcceleration.clampSensitivity(0.1f), 0.0001f)
        assertEquals(2.5f, RemotePointerAcceleration.clampSensitivity(9f), 0.0001f)
        assertEquals(1.5f, RemotePointerAcceleration.clampSensitivity(1.5f), 0.0001f)
    }

    @Test
    fun slowMovementIsPixelAccurate() {
        // At or below the threshold the gain is the raw sensitivity, so a slow drag can still land on
        // a single-pixel target.
        assertEquals(1.5f, RemotePointerAcceleration.gain(0f, 1.5f), 0.0001f)
        assertEquals(1.5f, RemotePointerAcceleration.gain(RemotePointerAcceleration.THRESHOLD_PX, 1.5f), 0.0001f)
    }

    @Test
    fun theCurveIsContinuousAtTheThreshold() {
        /* A discontinuity here would feel like the pointer snapping mid-drag. Just past the threshold
         * the gain must still be essentially the base value. */
        val atThreshold = RemotePointerAcceleration.gain(8f, 1.5f)
        val justPast = RemotePointerAcceleration.gain(8.001f, 1.5f)
        assertEquals(atThreshold, justPast, 0.001f)
    }

    @Test
    fun accelerationIsBoundedSoAFlickCannotTeleportTheCursor() {
        // MAX_ACCELERATION caps the multiplier at 2x the base, independent of how fast the flick was.
        val fast = RemotePointerAcceleration.gain(10_000f, 1.5f)
        assertEquals(3.0f, fast, 0.0001f)
        assertEquals(3.0f, RemotePointerAcceleration.gain(16f, 1.5f), 0.0001f)
        assertEquals(5.0f, RemotePointerAcceleration.gain(10_000f, 2.5f), 0.0001f)
    }

    @Test
    fun theCurveIsMonotonic() {
        var previous = 0f
        var distance = 0f
        while (distance <= 64f) {
            val gain = RemotePointerAcceleration.gain(distance, 1.5f)
            assertTrue("gain must not decrease at " + distance, gain >= previous)
            previous = gain
            distance += 0.5f
        }
    }

    @Test
    fun gainClampsItsSensitivityArgument() {
        // The controller clamps on the way in, but the function is public and must not trust callers.
        assertEquals(0.5f, RemotePointerAcceleration.gain(1f, -3f), 0.0001f)
        assertEquals(2.5f, RemotePointerAcceleration.gain(1f, 99f), 0.0001f)
    }

    // ---- direct mode -----------------------------------------------------------------------------

    @Test
    fun aTapMovesBeforeItPresses() {
        val subject = controller()
        val events = subject.tap(RemotePoint(10, 20))

        assertEquals(
            listOf(
                RemoteInput.PointerMove(10, 20, RemoteButton.NONE),
                RemoteInput.PointerButton(10, 20, RemoteButton.PRIMARY, RemoteButton.PRIMARY, true),
                RemoteInput.PointerButton(10, 20, RemoteButton.NONE, RemoteButton.PRIMARY, false),
            ),
            events,
        )
        assertEquals(RemotePoint(10, 20), subject.state.cursor)
        assertFalse(subject.state.hasButtonDown)
    }

    @Test
    fun aSecondTapOnTheSamePixelSkipsTheRedundantMove() {
        // The cursor is already there; re-sending the position costs a round trip and changes nothing.
        val subject = controller()
        subject.tap(RemotePoint(10, 20))
        val events = subject.tap(RemotePoint(10, 20))

        assertEquals(2, events.size)
        assertTrue(events.none { it is RemoteInput.PointerMove })
    }

    @Test
    fun aLongPressIsASecondaryClick() {
        val subject = controller()
        val events = subject.longPress(RemotePoint(3, 4))
        val press = events.filterIsInstance<RemoteInput.PointerButton>().first()
        assertEquals(RemoteButton.SECONDARY, press.button)
        assertTrue(press.down)
    }

    @Test
    fun swapLongPressExchangesTheTwoButtons() {
        /* Offered as a setting in section 5.1. Both directions must swap: a left-handed user who gets
         * a swapped tap but an unswapped long press has two buttons that both do the same thing. */
        val subject = controller(swapLongPress = true)
        val tap = subject.tap(RemotePoint(1, 1)).filterIsInstance<RemoteInput.PointerButton>().first()
        assertEquals(RemoteButton.SECONDARY, tap.button)

        val long = subject.longPress(RemotePoint(2, 2)).filterIsInstance<RemoteInput.PointerButton>().first()
        assertEquals(RemoteButton.PRIMARY, long.button)
    }

    @Test
    fun aDragHoldsTheButtonAcrossEveryMove() {
        val subject = controller()
        val start = subject.dragStart(RemotePoint(5, 5))
        assertEquals(2, start.size)
        assertTrue(subject.state.hasButtonDown)

        val moved = subject.dragTo(RemotePoint(9, 9))
        // The held mask travels with the move, or the remote application sees a hover instead of a drag.
        assertEquals(listOf(RemoteInput.PointerMove(9, 9, RemoteButton.PRIMARY)), moved)

        val end = subject.dragEnd()
        assertEquals(
            listOf(RemoteInput.PointerButton(9, 9, RemoteButton.NONE, RemoteButton.PRIMARY, false)),
            end,
        )
        assertFalse(subject.state.hasButtonDown)
    }

    @Test
    fun pressingAnAlreadyHeldButtonEmitsNothing() {
        // Duplicate transitions are what leave a remote application with a stuck button.
        val subject = controller()
        subject.dragStart(RemotePoint(1, 1))
        assertTrue(subject.dragStart(RemotePoint(1, 1)).isEmpty())
    }

    @Test
    fun releasingWithNothingHeldEmitsNothing() {
        val subject = controller()
        assertTrue(subject.dragEnd().isEmpty())
        assertTrue(subject.releaseAll().isEmpty())
    }

    // ---- trackpad mode ---------------------------------------------------------------------------

    @Test
    fun relativeMovementIsRefusedBeforeTheViewportIsMeasured()  {
        /* Nothing is known about the desktop size yet, so there is no way to clamp. Emitting anyway
         * would send a coordinate the server has to reject. */
        val subject = controller(RemotePointerMode.TRACKPAD)
        assertTrue(subject.moveBy(10f, 10f, RemoteFixtures.unmeasured, 1f).isEmpty())
    }

    @Test
    fun slowMovementAppliesTheSensitivityDirectly() {
        val subject = controller(RemotePointerMode.TRACKPAD)
        val events = subject.moveBy(4f, 0f, geometry, 1f)
        // 4px under the threshold at 1.5 sensitivity is 6 remote pixels.
        assertEquals(listOf(RemoteInput.PointerMove(6, 0, RemoteButton.NONE)), events)
    }

    @Test
    fun subPixelMovementAccumulatesRatherThanBeingRoundedAway() {
        /* Without the residual, a slow drag of half-pixel samples would round to zero on every sample
         * and the pointer would never move at all. */
        val subject = controller(RemotePointerMode.TRACKPAD)
        assertTrue(subject.moveBy(0.5f, 0f, geometry, 1f).isEmpty())
        assertEquals(RemotePoint(0, 0), subject.state.cursor)

        val events = subject.moveBy(0.5f, 0f, geometry, 1f)
        assertEquals(listOf(RemoteInput.PointerMove(1, 0, RemoteButton.NONE)), events)
    }

    @Test
    fun fastMovementIsAccelerated() {
        val subject = controller(RemotePointerMode.TRACKPAD)
        // 16px is twice the threshold, so the gain saturates at 3.0 and 16 becomes 48.
        assertEquals(
            listOf(RemoteInput.PointerMove(48, 0, RemoteButton.NONE)),
            subject.moveBy(16f, 0f, geometry, 1f),
        )
    }

    @Test
    fun zoomingInDoesNotMakeTheTrackpadFaster() {
        /* Divided by the viewport scale so one device pixel of finger travel stays one remote pixel.
         * Without this, the pointer would feel proportionally faster the further the user zoomed in. */
        val subject = controller(RemotePointerMode.TRACKPAD)
        assertEquals(
            listOf(RemoteInput.PointerMove(24, 0, RemoteButton.NONE)),
            subject.moveBy(16f, 0f, geometry, 2f),
        )
    }

    @Test
    fun anUnsetScaleIsTreatedAsOneRatherThanDividingByZero() {
        val subject = controller(RemotePointerMode.TRACKPAD)
        assertEquals(
            listOf(RemoteInput.PointerMove(48, 0, RemoteButton.NONE)),
            subject.moveBy(16f, 0f, geometry, 0f),
        )
    }

    @Test
    fun theCursorStopsAtTheLeftEdgeInsteadOfGoingNegative() {
        val subject = controller(RemotePointerMode.TRACKPAD)
        subject.placeAt(5, 5)
        // A 300px step from x=5 would land at -295, which no server would accept.
        assertEquals(
            listOf(RemoteInput.PointerMove(0, 5, RemoteButton.NONE)),
            subject.moveBy(-100f, 0f, geometry, 1f),
        )
    }

    @Test
    fun theCursorStopsAtTheLastPixelNotAtTheWidth() {
        /* Off by one matters: a 1000px desktop has no column 1000, and sending one is a protocol error
         * rather than a clamp the server will forgive. */
        val subject = controller(RemotePointerMode.TRACKPAD)
        subject.placeAt(990, 990)
        assertEquals(
            listOf(RemoteInput.PointerMove(999, 990, RemoteButton.NONE)),
            subject.moveBy(100f, 0f, geometry, 1f),
        )
    }

    @Test
    fun aTrackpadTapClicksWhereTheCursorIsNotWhereTheFingerIs() {
        val subject = controller(RemotePointerMode.TRACKPAD)
        subject.placeAt(40, 50)
        val events = subject.clickAtCursor()
        assertEquals(
            listOf(
                RemoteInput.PointerButton(40, 50, RemoteButton.PRIMARY, RemoteButton.PRIMARY, true),
                RemoteInput.PointerButton(40, 50, RemoteButton.NONE, RemoteButton.PRIMARY, false),
            ),
            events,
        )
    }

    @Test
    fun theDragLockIsAnExplicitLatch() {
        /* Modelled as a latch rather than as a long press so the UI can show that the button is held;
         * an invisible held button is indistinguishable from a stuck one. */
        val subject = controller(RemotePointerMode.TRACKPAD)
        val engaged = subject.engageDragLock()
        assertEquals(1, engaged.size)
        assertTrue(subject.state.dragLock)
        assertTrue(subject.state.hasButtonDown)

        // Idempotent: a second double-tap must not send a duplicate press.
        assertTrue(subject.engageDragLock().isEmpty())

        val released = subject.releaseDragLock()
        assertEquals(1, released.size)
        assertFalse(subject.state.dragLock)
        assertFalse(subject.state.hasButtonDown)

        assertTrue(subject.releaseDragLock().isEmpty())
    }

    @Test
    fun aLatchedButtonStillTravelsWithTheMove() {
        val subject = controller(RemotePointerMode.TRACKPAD)
        subject.engageDragLock()
        val moved = subject.moveBy(4f, 0f, geometry, 1f)
        assertEquals(listOf(RemoteInput.PointerMove(6, 0, RemoteButton.PRIMARY)), moved)
    }

    // ---- shared ----------------------------------------------------------------------------------

    @Test
    fun aZeroWheelIsNotAnEvent() {
        assertTrue(controller().wheel(0).isEmpty())
    }

    @Test
    fun theWheelScrollsAtTheCursor() {
        val subject = controller()
        subject.placeAt(7, 8)
        assertEquals(listOf(RemoteInput.Wheel(7, 8, 3, false)), subject.wheel(3))
        assertEquals(listOf(RemoteInput.Wheel(7, 8, -2, true)), subject.wheel(-2, horizontal = true))
    }

    @Test
    fun aHardwareMouseMovesBeforeItsButtonsChange() {
        val subject = controller()
        val chord = RemoteButton.PRIMARY or RemoteButton.MIDDLE or RemoteButton.SECONDARY
        val events = subject.hardware(RemotePoint(1, 1), chord)

        assertEquals(
            listOf(
                RemoteInput.PointerMove(1, 1, RemoteButton.NONE),
                RemoteInput.PointerButton(1, 1, 1, RemoteButton.PRIMARY, true),
                RemoteInput.PointerButton(1, 1, 3, RemoteButton.MIDDLE, true),
                RemoteInput.PointerButton(1, 1, 7, RemoteButton.SECONDARY, true),
            ),
            events,
        )
    }

    @Test
    fun aHardwareChordIsDiffedNotReplaced() {
        /* One transition per button, which is what both protocols expect and what makes a middle-drag
         * work. Replacing the mask wholesale would send a single ambiguous event. */
        val subject = controller()
        subject.hardware(RemotePoint(1, 1), RemoteButton.PRIMARY or RemoteButton.MIDDLE)
        val events = subject.hardware(RemotePoint(1, 1), RemoteButton.MIDDLE)

        assertEquals(
            listOf(RemoteInput.PointerButton(1, 1, RemoteButton.MIDDLE, RemoteButton.PRIMARY, false)),
            events,
        )
    }

    @Test
    fun anUnchangedHardwareStateEmitsNothing() {
        // Hover samples arrive continuously; each identical one must be free.
        val subject = controller()
        subject.hardware(RemotePoint(1, 1), RemoteButton.PRIMARY)
        assertTrue(subject.hardware(RemotePoint(1, 1), RemoteButton.PRIMARY).isEmpty())
    }

    @Test
    fun releaseAllReleasesEveryHeldButtonInOrder() {
        val subject = controller()
        val chord = RemoteButton.PRIMARY or RemoteButton.MIDDLE or RemoteButton.SECONDARY
        subject.hardware(RemotePoint(1, 1), chord)

        val events = subject.releaseAll()
        assertEquals(
            listOf(RemoteButton.PRIMARY, RemoteButton.MIDDLE, RemoteButton.SECONDARY),
            events.filterIsInstance<RemoteInput.PointerButton>().map { it.button },
        )
        assertEquals(RemoteButton.NONE, subject.state.buttons)
    }

    @Test
    fun releaseAllClearsTheLatchEvenWithNothingHeld() {
        /* Defensive: the latch and the mask are separate fields, and a latch left set with no button
         * down would make the UI show a held button forever. */
        val subject = controller(RemotePointerMode.TRACKPAD)
        subject.engageDragLock()
        subject.releaseAll()
        assertFalse(subject.state.dragLock)
    }

    // ---- mode ------------------------------------------------------------------------------------

    @Test
    fun switchingToTheCurrentModeIsANoOp() {
        val subject = controller()
        assertTrue(subject.setMode(RemotePointerMode.DIRECT).isEmpty())
    }

    @Test
    fun aModeSwitchKeepsTheRemoteCursorWhereItIs() {
        /* The frozen rule: 切模式保留 remote cursor，不跳到手指位置. The switch only changes how deltas
         * are interpreted, never where the pointer is. */
        val subject = controller()
        subject.tap(RemotePoint(123, 45))
        subject.setMode(RemotePointerMode.TRACKPAD)

        assertEquals(RemotePointerMode.TRACKPAD, subject.state.mode)
        assertEquals(RemotePoint(123, 45), subject.state.cursor)
    }

    @Test
    fun aModeSwitchReleasesAHeldButton() {
        // A button left down across a mode change reads to the remote application as a drag that
        // never ends.
        val subject = controller()
        subject.dragStart(RemotePoint(5, 5))
        val events = subject.setMode(RemotePointerMode.TRACKPAD)

        assertEquals(
            listOf(RemoteInput.PointerButton(5, 5, RemoteButton.NONE, RemoteButton.PRIMARY, false)),
            events,
        )
        assertFalse(subject.state.hasButtonDown)
    }

    @Test
    fun aModeSwitchDiscardsTheSubPixelRemainder() {
        /* Residual from the old mode would otherwise leak into the first sample of the new one, making
         * the pointer jump by up to a pixel for no reason the user can see. */
        val subject = controller(RemotePointerMode.TRACKPAD)
        subject.moveBy(0.5f, 0f, geometry, 1f)
        subject.setMode(RemotePointerMode.DIRECT)
        subject.setMode(RemotePointerMode.TRACKPAD)

        // Without the reset this half-pixel would complete the earlier one and emit a move.
        assertTrue(subject.moveBy(0.5f, 0f, geometry, 1f).isEmpty())
    }

    @Test
    fun theStoredTouchModeMapsOntoThePointerMode() {
        assertEquals(RemotePointerMode.DIRECT, RemotePointerMode.of(RdpTouchMode.DIRECT))
        assertEquals(RemotePointerMode.TRACKPAD, RemotePointerMode.of(RdpTouchMode.RELATIVE))
        // The two enums are deliberately separate: RELATIVE is the persisted wire name, TRACKPAD is
        // what the UI calls it, and renaming either must not silently change the other.
        assertNotEquals(RdpTouchMode.RELATIVE.name, RemotePointerMode.TRACKPAD.name)
    }

    @Test
    fun sensitivityCanBeChangedMidSessionAndIsClamped() {
        val subject = controller()
        assertEquals(1.5f, subject.sensitivity, 0.0001f)
        subject.setSensitivity(99f)
        assertEquals(RemotePointerAcceleration.MAX_SENSITIVITY, subject.sensitivity, 0.0001f)
    }

    @Test
    fun theConstructorClampsAnOutOfRangeSensitivity() {
        // The stored RdpSettings range is 0.5..3.0 but the curve is only defined to 2.5, so a saved
        // 3.0 must be narrowed here rather than trusted.
        assertEquals(RemotePointerAcceleration.MAX_SENSITIVITY, controller(sensitivity = 3f).sensitivity, 0.0001f)
    }
}
