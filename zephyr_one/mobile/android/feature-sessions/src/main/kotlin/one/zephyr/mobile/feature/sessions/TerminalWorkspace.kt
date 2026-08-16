package one.zephyr.mobile.feature.sessions

/**
 * Demo `#page-terminal` split / dock / in-flow tool-sheet state.
 *
 * `toggleSplit` walks off → term → right → left → off, matching
 * `index__2_.html` `toggleSplit()` / `setDockSide()`.
 */
enum class TerminalSplitMode {
    OFF,
    TERM,
    RIGHT,
    LEFT,
    ;

    val docksTools: Boolean get() = this == LEFT || this == RIGHT
    val splitsTerms: Boolean get() = this == TERM
}

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

enum class TermBackgroundKind { NONE, IMAGE, BIG }

const val DEFAULT_TERMINAL_DOCK_FRACTION = 0.38f
const val DEFAULT_TERMINAL_SHEET_FRACTION = 0.44f

data class TerminalWorkspaceState(
    val split: TerminalSplitMode = TerminalSplitMode.OFF,
    val dockWidthFraction: Float = DEFAULT_TERMINAL_DOCK_FRACTION,
    val focusPane: Char = 'a',
    val paneA: String,
    val paneB: String? = null,
    val docked: List<TerminalToolKind> = emptyList(),
    val dockCurrent: TerminalToolKind? = null,
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
    val focusedSessionId: String
        get() = if (split == TerminalSplitMode.TERM && focusPane == 'b') {
            paneB ?: paneA
        } else {
            paneA
        }

    fun withFocus(pane: Char): TerminalWorkspaceState = copy(focusPane = pane)

    fun assignToFocused(sessionId: String): TerminalWorkspaceState {
        if (split != TerminalSplitMode.TERM) return copy(paneA = sessionId, focusPane = 'a')
        return if (focusPane == 'b') {
            if (sessionId == paneA) copy(paneA = paneB ?: sessionId, paneB = sessionId)
            else copy(paneB = sessionId)
        } else {
            if (sessionId == paneB) copy(paneB = paneA, paneA = sessionId)
            else copy(paneA = sessionId)
        }
    }

    fun closeSession(sessionId: String, remaining: List<String>): TerminalWorkspaceState? {
        val next = remaining.filterNot { it == sessionId }
        if (next.isEmpty()) return null
        val clamp = { id: String? ->
            when {
                id == null || id == sessionId || id !in next -> next.first()
                else -> id
            }
        }
        var a = clamp(paneA)
        var b = paneB?.let(clamp)
        if (split == TerminalSplitMode.TERM && a == b && next.size > 1) {
            b = next.first { it != a }
        }
        return copy(paneA = a, paneB = b)
    }
}

object TerminalWorkspace {

    const val DEFAULT_DOCK_FRACTION = 0.38f
    const val TERM_SPLIT_FRACTION = 0.50f
    const val MIN_DOCK_FRACTION = 0.20f
    const val MAX_DOCK_FRACTION = 0.70f
    const val PAD_RAIL_MIN_DP = 768
    const val PAD_RAIL_WIDTH_DP = 216
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

    val splitCycle: List<TerminalSplitMode> = listOf(
        TerminalSplitMode.OFF,
        TerminalSplitMode.TERM,
        TerminalSplitMode.RIGHT,
        TerminalSplitMode.LEFT,
    )

    fun nextSplit(current: TerminalSplitMode): TerminalSplitMode {
        val i = splitCycle.indexOf(current)
        return splitCycle[(i + 1).coerceAtLeast(0) % splitCycle.size]
    }

    fun clampDockWidth(fraction: Float): Float =
        fraction.coerceIn(MIN_DOCK_FRACTION, MAX_DOCK_FRACTION)

    fun applySplit(
        state: TerminalWorkspaceState,
        side: TerminalSplitMode,
        sessionIds: List<String>,
    ): TerminalWorkspaceState {
        val fraction = when (side) {
            TerminalSplitMode.TERM ->
                if (state.split == TerminalSplitMode.TERM) state.dockWidthFraction else TERM_SPLIT_FRACTION
            TerminalSplitMode.LEFT, TerminalSplitMode.RIGHT ->
                if (state.split.docksTools) state.dockWidthFraction else DEFAULT_DOCK_FRACTION
            TerminalSplitMode.OFF -> state.dockWidthFraction
        }
        var paneB = state.paneB
        if (side == TerminalSplitMode.TERM) {
            paneB = when {
                sessionIds.size < 2 -> state.paneA
                paneB == null || paneB == state.paneA || paneB !in sessionIds ->
                    sessionIds.firstOrNull { it != state.paneA } ?: state.paneA
                else -> paneB
            }
        }
        var docked = state.docked
        var dockCurrent = state.dockCurrent
        if (side.docksTools && dockCurrent == null) {
            docked = listOf(TerminalToolKind.STATS)
            dockCurrent = TerminalToolKind.STATS
        }
        return state.copy(
            split = side,
            dockWidthFraction = clampDockWidth(fraction),
            paneB = paneB,
            focusPane = 'a',
            docked = docked,
            dockCurrent = dockCurrent,
        )
    }

    fun openTool(
        state: TerminalWorkspaceState,
        kind: TerminalToolKind,
        phone: Boolean = true,
    ): TerminalWorkspaceState {
        if (!phone) {
            val base = if (state.split.docksTools) state else applySplit(
                state = state,
                side = TerminalSplitMode.RIGHT,
                sessionIds = listOfNotNull(state.paneA, state.paneB),
            )
            val docked = if (kind in base.docked) base.docked else base.docked + kind
            return base.copy(docked = docked, dockCurrent = kind)
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
        state.copy(sheetFraction = 0f)

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

    fun undock(state: TerminalWorkspaceState, kind: TerminalToolKind): TerminalWorkspaceState {
        val docked = state.docked.filterNot { it == kind }
        val current = when {
            state.dockCurrent != kind -> state.dockCurrent
            docked.isEmpty() -> null
            else -> docked.last()
        }
        return state.copy(docked = docked, dockCurrent = current)
    }

    fun dragWidth(
        startFraction: Float,
        dxPx: Float,
        splitWidthPx: Float,
        split: TerminalSplitMode,
    ): Float {
        if (splitWidthPx <= 0f) return startFraction
        val signed = if (split == TerminalSplitMode.LEFT) dxPx else -dxPx
        return clampDockWidth(startFraction + signed / splitWidthPx)
    }
}
