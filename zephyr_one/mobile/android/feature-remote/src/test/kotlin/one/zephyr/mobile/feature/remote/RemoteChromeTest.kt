package one.zephyr.mobile.feature.remote

import one.zephyr.mobile.model.Protocol
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Chrome visibility from REMOTE_DESKTOP_EXPERIENCE.md 12, and the dock sets frozen by
 * SCREEN_CATALOG.md 9 and 10.
 *
 * The tools panel has exactly one user entry point: [RemoteChrome.toggleToolsPanel], dispatched by
 * the floating orb. Surface gestures only update remote input, zoom, and pan.
 */
class RemoteChromeTest {

    @Test
    fun chromeStartsVisibleWithTheToolsPanelHidden() {
        val state = RemoteChromeState()
        assertTrue(state.visible)
        assertFalse(state.dockVisible)
        assertFalse(state.toolsPanelVisible)
        assertTrue(state.statusPillVisible)
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
        /* The explicit tools orb is always reachable, so restoring chrome here is only about keeping
         * the keyboard's modifier controls visible. */
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
    fun onlyTheToolsOrbTransitionCanToggleTheToolsPanel() {
        val shown = RemoteChrome.toggleToolsPanel(RemoteChromeState())
        assertTrue(shown.toolsPanelVisible)
        assertTrue(shown.visible)
        val hidden = RemoteChrome.toggleToolsPanel(shown)
        assertFalse(hidden.toolsPanelVisible)
        assertTrue(hidden.visible)
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
        /* Distinct from panel visibility on purpose: framebuffer gestures may block auto-hide while
         * active, but can never open the tools panel when they end. */
        val state = RemoteChrome.onGestureEnd(RemoteChrome.onGestureStart(RemoteChromeState()))
        assertTrue(state.visible)
        assertFalse(state.toolsPanelVisible)
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
