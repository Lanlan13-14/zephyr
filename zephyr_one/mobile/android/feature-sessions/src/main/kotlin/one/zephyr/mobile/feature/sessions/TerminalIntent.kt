package one.zephyr.mobile.feature.sessions

/**
 * Everything S21 can ask for.
 *
 * One sealed interface instead of thirty lambdas, for the same reason the connection editor uses
 * EditorIntent: adding a capability to the surface then fails to compile in [SessionRoutes] until it
 * is wired, and a Compose test can drive the whole screen by recording intents instead of
 * constructing a controller, an emulator and a transport.
 */
sealed interface TerminalIntent {

    /**
     * The measured layout.
     *
     * Reported as pixels rather than dp because the controller derives columns and rows from cell
     * metrics, and a dp round trip would drop the sub-pixel advance width that makes the last column
     * fit or not.
     */
    data class Geometry(
        val totalWidthPx: Float,
        val totalHeightPx: Float,
        val imeHeightPx: Float,
        val shortcutMatrixHeightPx: Float,
        val dockHeightPx: Float,
        val cellWidthPx: Float,
        val lineHeightPx: Float,
    ) : TerminalIntent

    // ---- keyboard and IME ------------------------------------------------------------------------

    data class KeyStroke(val stroke: TerminalKeyStroke) : TerminalIntent

    /** A tap on the shortcut matrix. Modifiers latch, actions never become bytes. */
    data class Shortcut(val key: ExtraKey) : TerminalIntent

    /** setComposingText: moves the overlay only. */
    data class Composing(val text: String, val cursor: Int) : TerminalIntent

    /** commitText: the one place composed text becomes bytes. */
    data class Commit(val text: String) : TerminalIntent

    data object FinishComposing : TerminalIntent

    data object CancelComposing : TerminalIntent

    // ---- clipboard -------------------------------------------------------------------------------

    /** Clipboard text the user asked for. The read happens in the screen, on a user action only. */
    data class Paste(val text: String) : TerminalIntent

    data class ConfirmPaste(val keepTrailingNewline: Boolean) : TerminalIntent

    data object CancelPaste : TerminalIntent

    // ---- pointer ---------------------------------------------------------------------------------

    data class PointerDown(val pointerCount: Int) : TerminalIntent

    /**
     * @param dyPx positive means the finger moved up, which is the convention
     *   ScrollbackViewport.drag documents and Android's onScroll distanceY uses.
     * @param column 1-based cell under the centroid, for mouse reporting.
     */
    data class PointerMove(
        val pointerCount: Int,
        val dxPx: Float,
        val dyPx: Float,
        val spanDeltaPx: Float,
        val column: Int,
        val row: Int,
    ) : TerminalIntent

    data object GestureEnd : TerminalIntent

    data object LongPress : TerminalIntent

    data class Tap(val column: Int, val row: Int) : TerminalIntent

    /** A physical wheel or trackpad. Positive scrolls toward the live bottom. */
    data class Wheel(val notches: Int, val column: Int, val row: Int) : TerminalIntent

    data class Fling(val velocityPxPerSecond: Float) : TerminalIntent

    data class SelectionActive(val active: Boolean) : TerminalIntent

    // ---- scrollback ------------------------------------------------------------------------------

    data class ScrollPages(val pages: Int) : TerminalIntent

    data object JumpToBottom : TerminalIntent

    // ---- session ---------------------------------------------------------------------------------

    data object Connect : TerminalIntent

    data object Reconnect : TerminalIntent

    data object Disconnect : TerminalIntent

    data object Minimise : TerminalIntent

    data object TrustHostKey : TerminalIntent

    data object RejectHostKey : TerminalIntent

    data class SetEncoding(val encoding: one.zephyr.mobile.model.TerminalEncoding) : TerminalIntent

    data class Dock(val item: TerminalDockItem) : TerminalIntent
}

/**
 * Chrome heights the screen renders and the controller measures.
 *
 * Declared once so the two cannot disagree: TerminalGeometry decides whether the matrix survives at
 * the current height, and it can only decide correctly if it is handed the height the screen will
 * actually draw.
 */
object TerminalChromeSpec {

    /** One shortcut key. 48dp is the Android touch-target floor from SCREEN_CATALOG.md 26. */
    val keyHeight = androidx.compose.ui.unit.Dp(48f)

    val keySpacing = androidx.compose.ui.unit.Dp(4f)

    val matrixPadding = androidx.compose.ui.unit.Dp(4f)

    val dockHeight = androidx.compose.ui.unit.Dp(56f)

    /** @param rows how many matrix rows will be drawn, normally 2 from ExtraKeysLayout.default. */
    fun matrixHeight(rows: Int): androidx.compose.ui.unit.Dp =
        androidx.compose.ui.unit.Dp(
            keyHeight.value * rows + keySpacing.value * (rows - 1).coerceAtLeast(0) + matrixPadding.value * 2f,
        )
}
