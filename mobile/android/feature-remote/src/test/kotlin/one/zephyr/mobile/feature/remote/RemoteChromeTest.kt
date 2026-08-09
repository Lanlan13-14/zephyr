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
    fun chromeStartsVisibleWithTheDockShowing() {
        val state = RemoteChromeState()
        assertTrue(state.visible)
        assertTrue(state.dockVisible)
        assertTrue(state.statusPillVisible)
        assertFalse(state.suppressedByGesture)
        assertFalse(state.gestureActive)
        assertFalse(state.keyboardVisible)
        assertFalse(state.modifierBarVisible)
    }

    @Test
    fun theImeReplacesTheDockRatherThanStackingAboveIt() {
        val open = RemoteChrome.setKeyboard(RemoteChromeState(), true)
        assertTrue(open.keyboardVisible)
        assertTrue(open.visible)
        // The dock goes, the status pill stays: it is the only thing still reporting the phase.
        assertFalse(open.dockVisible)
        assertTrue(open.statusPillVisible)
        // The modifier bar is what the remaining height is worth with the IME open.
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
        assertTrue(closed.dockVisible)
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
    fun aTapThatLandedOnNothingTogglesChrome() {
        val hidden = RemoteChrome.onSurfaceTap(RemoteChromeState())
        assertFalse(hidden.visible)
        val shown = RemoteChrome.onSurfaceTap(hidden)
        assertTrue(shown.visible)
    }

    @Test
    fun consumingTheSuppressionTakesOneTapNotTwo() {
        /* The flag is cleared by the tap that it suppressed, so a drag followed by two taps ends with
         * chrome toggled once. If clearing needed its own event, the second tap would be eaten too. */
        var state = RemoteChrome.onRemoteInput(RemoteChromeState())
        state = RemoteChrome.onSurfaceTap(state)
        state = RemoteChrome.onSurfaceTap(state)
        assertFalse(state.visible)
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
        val touching = RemoteChrome.onGestureStart(RemoteChromeState())
        assertTrue(touching.gestureActive)
        assertFalse(touching.mayAutoHide)

        val lifted = RemoteChrome.onGestureEnd(touching)
        assertFalse(lifted.gestureActive)
        assertTrue(lifted.mayAutoHide)
    }

    @Test
    fun autoHideIsBlockedWhileTheKeyboardIsOpen() {
        // Hiding the modifier bar from under a typing user would be the worst possible moment.
        val open = RemoteChrome.setKeyboard(RemoteChromeState(), true)
        assertFalse(open.mayAutoHide)
    }

    @Test
    fun autoHideDoesNothingWhenChromeIsAlreadyHidden() {
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
        assertEquals(4_000L, RemoteChrome.AUTO_HIDE_MS)
    }

    @Test
    fun theRdpDockCarriesSoundDriveAndCertificate() {
        val items = RemoteDockItem.forProtocol(Protocol.RDP)
        assertEquals(
            listOf(
                RemoteDockItem.KEYBOARD,
                RemoteDockItem.POINTER_MODE,
                RemoteDockItem.MODIFIERS,
                RemoteDockItem.CLIPBOARD,
                RemoteDockItem.DISPLAY,
                RemoteDockItem.SOUND,
                RemoteDockItem.CHANNELS,
                RemoteDockItem.DRIVE,
                RemoteDockItem.CERTIFICATE,
                RemoteDockItem.RECONNECT,
                RemoteDockItem.DISCONNECT,
            ),
            items,
        )
        // Quality is a VNC-side encoding choice; RDP negotiates it from the connection settings.
        assertFalse(items.contains(RemoteDockItem.QUALITY))
    }

    @Test
    fun theVncDockOffersQualityAndNoRemoteDisk() {
        val items = RemoteDockItem.forProtocol(Protocol.VNC)
        assertEquals(
            listOf(
                RemoteDockItem.KEYBOARD,
                RemoteDockItem.POINTER_MODE,
                RemoteDockItem.MODIFIERS,
                RemoteDockItem.CLIPBOARD,
                RemoteDockItem.DISPLAY,
                RemoteDockItem.QUALITY,
                RemoteDockItem.RECONNECT,
                RemoteDockItem.DISCONNECT,
            ),
            items,
        )
        // Plain RFB has no file transfer and no certificate to review; offering either would be a lie.
        assertFalse(items.contains(RemoteDockItem.DRIVE))
        assertFalse(items.contains(RemoteDockItem.SOUND))
        assertFalse(items.contains(RemoteDockItem.CERTIFICATE))
    }

    @Test
    fun terminalProtocolsHaveNoRemoteDockAtAll() {
        assertTrue(RemoteDockItem.forProtocol(Protocol.SSH).isEmpty())
        assertTrue(RemoteDockItem.forProtocol(Protocol.TELNET).isEmpty())
    }
}
