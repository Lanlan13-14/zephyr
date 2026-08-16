package one.zephyr.mobile.feature.remote

import one.zephyr.mobile.model.Protocol

/**
 * One entry of the bottom session dock.
 *
 * SCREEN_CATALOG.md 9 and 10 freeze different tool sets for RDP and VNC: RDP has 声音, 文件 drive and
 * 证书, VNC has 画质/颜色 and no drive at all - REMOTE_DESKTOP_EXPERIENCE.md 9 says a VNC page must not
 * invent a remote disk. Availability is therefore a property of the protocol rather than a runtime
 * check the screen has to remember to make.
 */
enum class RemoteDockItem {
    POINTER_MODE,
    KEYBOARD,
    QUALITY,
    RESOLUTION,
    FPS,
    FIT,
    ZOOM,
    CLIPBOARD,
    DRIVE,
    SHORTCUTS,
    JOYSTICK,
    CAD,
    RECONNECT,
    DISCONNECT,
    VNC_QUALITY,
    ;

    companion object {
        fun forProtocol(protocol: Protocol): List<RemoteDockItem> = when (protocol) {
            Protocol.RDP -> listOf(
                POINTER_MODE, KEYBOARD, QUALITY, RESOLUTION, FPS, FIT, ZOOM,
                CLIPBOARD, DRIVE, SHORTCUTS, JOYSTICK, CAD, RECONNECT, DISCONNECT,
            )
            Protocol.VNC -> listOf(
                POINTER_MODE, KEYBOARD, VNC_QUALITY, FIT, ZOOM, CLIPBOARD,
                JOYSTICK, RECONNECT, DISCONNECT,
            )
            else -> emptyList()
        }
    }
}

/**
 * Whether the overlay chrome is showing.
 *
 * A value type rather than a boolean because keyboard and modifier-bar visibility are independent
 * from the tools strip. The tools strip itself has exactly one user entry point: the floating orb.
 */
data class RemoteChromeState(
    val visible: Boolean = true,
    /** Demo `#rdp-panel`. Independent of [visible] so the ball/status stay up after it auto-hides. */
    val toolsPanelVisible: Boolean = false,
    /** True between a first touch and the last lift. Blocks auto-hide, never the toggle. */
    val gestureActive: Boolean = false,
    val keyboardVisible: Boolean = false,
    val modifierBarVisible: Boolean = false,
) {
    /**
     * The frozen layout rule: the IME replaces the dock rather than stacking above it.
     *
     * Chrome overlays the surface and never resizes the remote desktop, so with the IME open the only
     * thing worth the remaining height is the modifier bar (§6).
     */
    val dockVisible: Boolean get() = toolsPanelVisible

    val statusPillVisible: Boolean get() = visible

    /** Auto-hide is only allowed while the tools panel is up and nothing is being touched. */
    val mayAutoHide: Boolean get() = toolsPanelVisible && !gestureActive && !keyboardVisible
}

/** Chrome transitions. Pure so orb-only tool-panel access stays testable. */
object RemoteChrome {

    /** §12: 120-180ms opacity plus a small offset. Never a scale, which would resample the frame. */
    const val FADE_MS = 150
    const val OFFSET_DP = 6

    /** Demo `resetHide`: the tools panel closes after five idle seconds. */
    const val AUTO_HIDE_MS = 5_000L

    fun toggleToolsPanel(state: RemoteChromeState): RemoteChromeState =
        state.copy(toolsPanelVisible = !state.toolsPanelVisible, visible = true)

    fun hideToolsPanel(state: RemoteChromeState): RemoteChromeState =
        if (!state.toolsPanelVisible) state else state.copy(toolsPanelVisible = false)

    fun onGestureStart(state: RemoteChromeState): RemoteChromeState =
        state.copy(gestureActive = true)

    fun onGestureEnd(state: RemoteChromeState): RemoteChromeState =
        state.copy(gestureActive = false)

    fun setKeyboard(state: RemoteChromeState, visible: Boolean): RemoteChromeState = state.copy(
        keyboardVisible = visible,
        // The tools orb is always reachable, so showing chrome here only keeps keyboard affordances
        // visible while the IME owns the bottom of the viewport.
        visible = if (visible) true else state.visible,
        modifierBarVisible = if (visible) true else state.modifierBarVisible,
    )

    fun setModifierBar(state: RemoteChromeState, visible: Boolean): RemoteChromeState =
        state.copy(modifierBarVisible = visible)
}
