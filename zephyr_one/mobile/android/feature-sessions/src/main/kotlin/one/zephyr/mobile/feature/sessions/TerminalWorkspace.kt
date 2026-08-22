package one.zephyr.mobile.feature.sessions

/**
 * Demo `#page-terminal` tool-sheet state.
 *
 * The old split mode (term↔term, tool dock left/right) is gone. A phone shows
 * tools in a bottom sheet; a pad in landscape keeps the terminal on one side
 * and the tool panel (or the home surface) on the other, with a draggable
 * gutter between them.
 */
enum class TerminalToolKind {
    FILES,
    SNIPPET,
    NOTES,
    STATS,
    DOCKER,
    THEME,
    ;

    /** Drawers that embed a text field must stay composed while the system IME is open. */
    val keepsIme: Boolean
        get() = this == FILES || this == STATS || this == DOCKER

    companion object {
        fun fromDock(item: TerminalDockItem): TerminalToolKind? = when (item) {
            TerminalDockItem.FILES -> FILES
            TerminalDockItem.SNIPPETS -> SNIPPET
            TerminalDockItem.NOTES -> NOTES
            TerminalDockItem.STATS -> STATS
            TerminalDockItem.THEME -> THEME
            else -> null
        }
    }
}

/** Which side of a landscape pad the terminal pane sits on. */
enum class PadTermSide { LEFT, RIGHT }

enum class TermBackgroundKind { NONE, IMAGE, BIG }

const val DEFAULT_TERMINAL_SHEET_FRACTION = 0.44f

data class TerminalWorkspaceState(
    /* One terminal at a time: the split panes were removed because the second
     * pane never had a real ViewModel wired and the mode confused more
     * sessions than it helped. */
    val activeSessionId: String,
    /* Pad layout. padTermFraction is the terminal's share of the width;
     * 1f means the terminal covers the whole row (the panel is hidden). */
    val padTermSide: PadTermSide = PadTermSide.RIGHT,
    val padTermFraction: Float = TerminalWorkspace.PAD_DEFAULT_TERM_FRACTION,
    val padPanelTool: TerminalToolKind? = null,
    val sheetTools: List<TerminalToolKind> = emptyList(),
    val sheetCurrent: TerminalToolKind? = null,
    val sheetFraction: Float = 0f,
    val background: TermBackgroundKind = TermBackgroundKind.NONE,
    val backgroundBlurPx: Float = 0f,
    val backgroundOpacity: Float = 0.55f,
    val customBackgroundColor: Boolean = false,
    val customSelectionColor: Boolean = false,
    val addSheetOpen: Boolean = false,
    val disconnectSheetOpen: Boolean = false,
) {
    val focusedSessionId: String get() = activeSessionId

    fun withFocus(pane: Char): TerminalWorkspaceState = this

    fun assignToFocused(sessionId: String): TerminalWorkspaceState =
        copy(activeSessionId = sessionId)

    fun closeSession(sessionId: String, remaining: List<String>): TerminalWorkspaceState? {
        val next = remaining.filterNot { it == sessionId }
        if (next.isEmpty()) return null
        return copy(activeSessionId = if (activeSessionId == sessionId) next.first() else activeSessionId)
    }
}

object TerminalWorkspace {

    const val KEY_HEIGHT_DP = 36
    const val KEY_PADDING_V_DP = 7
    const val KEY_GAP_DP = 6
    const val DOCK_PAD_TOP_DP = 8
    const val DOCK_PAD_BOTTOM_DP = 10
    const val HEAD_PAD_TOP_EXTRA_DP = 12
    const val HEAD_PAD_H_DP = 14
    const val HEAD_PAD_BOTTOM_DP = 12
    const val BACK_SIZE_DP = 30
    const val SPLIT_BTN_SIZE_DP = 30
    const val RAIL_CHIP_HEIGHT_DP = 34
    const val GUTTER_WIDTH_DP = 12
    const val SHEET_MID_FRACTION = 0.44f
    const val SHEET_MAX_FRACTION = 1.00f
    const val SHEET_DISMISS_FRACTION = 0.20f
    const val SHEET_DISMISS_VELOCITY_PX_PER_MS = 0.70f
    const val SHEET_PROJECTION_SECONDS = 0.12f

    /* Pad two-pane layout: the terminal starts at half the row and can be
     * dragged between a readable minimum and full width. */
    const val PAD_RAIL_MIN_DP = 768
    const val PAD_RAIL_WIDTH_DP = 216
    const val PAD_DEFAULT_TERM_FRACTION = 0.50f
    const val PAD_MIN_TERM_FRACTION = 0.30f
    const val PAD_MAX_TERM_FRACTION = 1.00f

    fun clampPadTermFraction(fraction: Float): Float =
        fraction.coerceIn(PAD_MIN_TERM_FRACTION, PAD_MAX_TERM_FRACTION)

    /**
     * Horizontal drag on the gutter. Dragging towards the panel grows the
     * terminal; at [PAD_MAX_TERM_FRACTION] the terminal is full-width and the
     * panel is gone, which is the pad equivalent of closing the sheet.
     */
    fun dragPadTermFraction(startFraction: Float, dxPx: Float, rowWidthPx: Float, side: PadTermSide): Float {
        if (rowWidthPx <= 0f) return startFraction
        /* The gutter sits on the panel side of the terminal. When the terminal
         * is on the right, dragging left (negative dx) widens it; when it is on
         * the left, dragging right does. */
        val signed = if (side == PadTermSide.RIGHT) -dxPx else dxPx
        return clampPadTermFraction(startFraction + signed / rowWidthPx)
    }

    fun openTool(
        state: TerminalWorkspaceState,
        kind: TerminalToolKind,
        phone: Boolean = true,
    ): TerminalWorkspaceState {
        if (!phone) {
            /* Pad: the tool takes the panel side. Tapping the open tool again
             * closes the panel back to the home surface, mirroring the phone
             * sheet toggle. */
            if (state.padPanelTool == kind) return state.copy(padPanelTool = null)
            return state.copy(
                padPanelTool = kind,
                padTermFraction = clampPadTermFraction(
                    if (state.padTermFraction >= PAD_MAX_TERM_FRACTION) PAD_DEFAULT_TERM_FRACTION
                    else state.padTermFraction,
                ),
            )
        }
        if (state.sheetCurrent == kind && state.sheetFraction > 0f) return closeSheet(state)
        val tools = if (kind in state.sheetTools) state.sheetTools else state.sheetTools + kind
        return state.copy(
            sheetTools = tools,
            sheetCurrent = kind,
            sheetFraction = if (state.sheetFraction > 0f) state.sheetFraction else SHEET_MID_FRACTION,
        )
    }

    fun selectSheetTool(state: TerminalWorkspaceState, kind: TerminalToolKind): TerminalWorkspaceState =
        if (kind in state.sheetTools) state.copy(sheetCurrent = kind) else state

    fun closeSheetTool(state: TerminalWorkspaceState, kind: TerminalToolKind): TerminalWorkspaceState {
        val tools = state.sheetTools.filterNot { it == kind }
        if (tools.isEmpty()) return closeSheet(state)
        return state.copy(
            sheetTools = tools,
            sheetCurrent = if (state.sheetCurrent == kind) tools.last() else state.sheetCurrent,
        )
    }

    fun closeSheet(state: TerminalWorkspaceState): TerminalWorkspaceState =
        state.copy(sheetFraction = 0f, padPanelTool = null)

    /**
     * Drops the last tab after the close height animation has reached 0.
     * Called only from the sheet, never from a dock tap — otherwise the node
     * disappears before [animateFloatAsState] can run.
     */
    fun finishClose(state: TerminalWorkspaceState): TerminalWorkspaceState =
        if (state.sheetFraction > 0f) state
        else state.copy(sheetTools = emptyList(), sheetCurrent = null, sheetFraction = 0f)

    fun setSheetFraction(state: TerminalWorkspaceState, fraction: Float): TerminalWorkspaceState =
        state.copy(sheetFraction = fraction.coerceIn(0f, SHEET_MAX_FRACTION))

    fun settleSheet(current: Float, velocityPxPerMs: Float): Float {
        if (velocityPxPerMs > SHEET_DISMISS_VELOCITY_PX_PER_MS || current < SHEET_DISMISS_FRACTION) return 0f
        val projected = current - velocityPxPerMs * SHEET_PROJECTION_SECONDS
        return if (kotlin.math.abs(projected - SHEET_MAX_FRACTION) < kotlin.math.abs(projected - SHEET_MID_FRACTION)) {
            SHEET_MAX_FRACTION
        } else {
            SHEET_MID_FRACTION
        }
    }
}
