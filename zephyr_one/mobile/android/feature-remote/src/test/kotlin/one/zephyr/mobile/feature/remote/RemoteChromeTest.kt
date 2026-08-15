package one.zephyr.mobile.feature.remote

import one.zephyr.mobile.model.Protocol
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Chrome visibility from REMOTE_DESKTOP_EXPERIENCE.md 12, and the dock sets frozen by
 * SCREEN_CATALOG.md 9 and 10.
 *
 * The rule worth testing is the one a boolean cannot express: a gesture that drove the remote pointer
 * must not toggle chrome when it lifts, while a tap that landed on nothing must. Both end in the same
 * lift, so only the suppression flag tells them apart.
 */
class RemoteChromeTest {

    @Test
    fun chromeStartsVisibleWithTheToolsPanelHidden() {
        val state = RemoteChromeState()
        assertTrue(state.visible)
        assertFalse(state.dockVisible)
        assertFalse(state.toolsPanelVisible)
        assertTrue(state.statusPillVisible)
        assertFalse(state.suppressedByGesture)
        assertFalse(state.gestureActive)
        assertFalse(state.keyboardVisible)
        assertFalse(state.modifierBarVisible)
    }

    @Test
    fun theImeBringsTheModifierBarWithoutOpeningTheToolsPanel() {
        val open = RemoteChrome.setKeyboard(RemoteChromeState(), true)
        assertTrue(open.keyboardVisible)
        assertTrue(open.visible)
        assertFalse(open.dockVisible)
        assertTrue(open.statusPillVisible)
        assertTrue(open.modifierBarVisible)
    }

    @Test
    fun openingTheKeyboardWhileChromeIsHiddenBringsChromeBack() {
        /* Without this the user dismisses the IME and is left with no dock and no way to get it back
         * except a blind tap on a surface that might consume it. */
        val hidden = RemoteChromeState(visible = false)
        val open = RemoteChrome.setKeyboard(hidden, true)
        assertTrue(open.visible)
        assertTrue(open.modifierBarVisible)
    }

    @Test
    fun closingTheKeyboardTouchesOnlyTheKeyboardFlag() {
        val open = RemoteChrome.setKeyboard(RemoteChromeState(visible = false), true)
        val closed = RemoteChrome.setKeyboard(open, false)
        assertFalse(closed.keyboardVisible)
        // Still visible, because opening the IME made it visible and closing it is not a hide request.
        assertTrue(closed.visible)
        assertFalse(closed.dockVisible)
        // The modifier bar is left where it was rather than being force-closed.
        assertTrue(closed.modifierBarVisible)
    }

    @Test
    fun aTapThatDroveTheRemotePointerDoesNotToggleChrome() {
        val afterInput = RemoteChrome.onRemoteInput(RemoteChromeState())
        assertTrue(afterInput.suppressedByGesture)

        val afterTap = RemoteChrome.onSurfaceTap(afterInput)
        // Chrome unchanged, and the flag is consumed so the next bare tap works normally.
        assertTrue(afterTap.visible)
        assertFalse(afterTap.suppressedByGesture)
    }

    @Test
    fun aTapThatLandedOnNothingTogglesTheToolsPanel() {
        val shown = RemoteChrome.onSurfaceTap(RemoteChromeState())
        assertTrue(shown.toolsPanelVisible)
        assertTrue(shown.visible)
        val hidden = RemoteChrome.onSurfaceTap(shown)
        assertFalse(hidden.toolsPanelVisible)
        assertTrue(hidden.visible)
    }

    @Test
    fun consumingTheSuppressionTakesOneTapNotTwo() {
        /* The flag is cleared by the tap that it suppressed, so a drag followed by two taps ends with
         * chrome toggled once. If clearing needed its own event, the second tap would be eaten too. */
        var state = RemoteChrome.onRemoteInput(RemoteChromeState())
        state = RemoteChrome.onSurfaceTap(state)
        state = RemoteChrome.onSurfaceTap(state)
        assertTrue(state.toolsPanelVisible)
    }

    @Test
    fun remoteInputSuppressionIsIdempotent() {
        /* A drag delivers hundreds of move samples. Returning the same instance rather than a fresh
         * copy per sample is what keeps this off the recomposition path. */
        val first = RemoteChrome.onRemoteInput(RemoteChromeState())
        val second = RemoteChrome.onRemoteInput(first)
        assertSame(first, second)
    }

    @Test
    fun autoHideWaitsForTheFingerToLift() {
        val touching = RemoteChrome.onGestureStart(RemoteChromeState(toolsPanelVisible = true))
        assertTrue(touching.gestureActive)
        assertFalse(touching.mayAutoHide)

        val lifted = RemoteChrome.onGestureEnd(touching)
        assertFalse(lifted.gestureActive)
        assertTrue(lifted.mayAutoHide)
    }

    @Test
    fun autoHideIsBlockedWhileTheKeyboardIsOpen() {
        val open = RemoteChrome.setKeyboard(RemoteChromeState(toolsPanelVisible = true), true)
        assertFalse(open.mayAutoHide)
    }

    @Test
    fun autoHideDoesNothingWhenTheToolsPanelIsClosed() {
        assertFalse(RemoteChromeState().mayAutoHide)
        assertFalse(RemoteChromeState(visible = false).mayAutoHide)
    }

    @Test
    fun gestureTrackingDoesNotMoveChromeByItself() {
        /* Distinct from suppression on purpose: a gesture that never reaches the framebuffer, such as
         * a tap on the letterbox, must still be able to toggle chrome on lift. */
        val state = RemoteChrome.onGestureEnd(RemoteChrome.onGestureStart(RemoteChromeState()))
        assertTrue(state.visible)
        assertFalse(state.suppressedByGesture)
    }

    @Test
    fun theModifierBarIsIndependentOfTheDock() {
        val on = RemoteChrome.setModifierBar(RemoteChromeState(), true)
        assertTrue(on.modifierBarVisible)
        assertTrue(on.visible)
        assertFalse(on.keyboardVisible)

        val off = RemoteChrome.setModifierBar(on, false)
        assertFalse(off.modifierBarVisible)
        assertTrue(off.visible)
    }

    @Test
    fun theTransitionIsOpacityAndOffsetNeverAScale() {
        /* Section 12 asks for 120-180ms. A scale would resample the framebuffer mid-animation, which
         * is the one thing a remote surface must never do to its own pixels. */
        assertTrue(RemoteChrome.FADE_MS in 120..180)
        assertTrue(RemoteChrome.OFFSET_DP in 1..12)
        assertEquals(5_000L, RemoteChrome.AUTO_HIDE_MS)
    }

    @Test
    fun theRdpStripMatchesTheDemoOperationPage() {
        val items = RemoteDockItem.forProtocol(Protocol.RDP)
        assertEquals(
            listOf(
                RemoteDockItem.POINTER_MODE,
                RemoteDockItem.KEYBOARD,
                RemoteDockItem.QUALITY,
                RemoteDockItem.RESOLUTION,
                RemoteDockItem.FPS,
                RemoteDockItem.FIT,
                RemoteDockItem.ZOOM,
                RemoteDockItem.CLIPBOARD,
                RemoteDockItem.DRIVE,
                RemoteDockItem.SHORTCUTS,
                RemoteDockItem.JOYSTICK,
                RemoteDockItem.CAD,
                RemoteDockItem.RECONNECT,
                RemoteDockItem.DISCONNECT,
            ),
            items,
        )
        assertFalse(items.contains(RemoteDockItem.VNC_QUALITY))
    }

    @Test
    fun theVncStripHasNoDriveCadOrRdpDisplayCycle() {
        val items = RemoteDockItem.forProtocol(Protocol.VNC)
        assertEquals(
            listOf(
                RemoteDockItem.POINTER_MODE,
                RemoteDockItem.KEYBOARD,
                RemoteDockItem.VNC_QUALITY,
                RemoteDockItem.FIT,
                RemoteDockItem.ZOOM,
                RemoteDockItem.CLIPBOARD,
                RemoteDockItem.JOYSTICK,
                RemoteDockItem.RECONNECT,
                RemoteDockItem.DISCONNECT,
            ),
            items,
        )
        assertFalse(items.contains(RemoteDockItem.DRIVE))
        assertFalse(items.contains(RemoteDockItem.CAD))
        assertFalse(items.contains(RemoteDockItem.RESOLUTION))
        assertFalse(items.contains(RemoteDockItem.FPS))
    }

    @Test
    fun terminalProtocolsHaveNoRemoteDockAtAll() {
        assertTrue(RemoteDockItem.forProtocol(Protocol.SSH).isEmpty())
        assertTrue(RemoteDockItem.forProtocol(Protocol.TELNET).isEmpty())
    }
}
