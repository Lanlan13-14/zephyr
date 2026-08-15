package one.zephyr.mobile.feature.sessions

/**
 * Demo `#page-terminal` split / dock / floating-panel state.
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
    THEME,
    ;

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

enum class TermPanelLayout { FREE, LEFT_HALF, RIGHT_HALF, BOTTOM }

data class TerminalFloatingPanel(
    val kind: TerminalToolKind,
    val z: Int,
    val layout: TermPanelLayout = TermPanelLayout.FREE,
    val offsetXPx: Float = Float.NaN,
    val offsetYPx: Float = Float.NaN,
    val widthPx: Float = Float.NaN,
    val heightPx: Float = Float.NaN,
)

const val DEFAULT_TERMINAL_DOCK_FRACTION = 0.38f

data class TerminalWorkspaceState(
    val split: TerminalSplitMode = TerminalSplitMode.OFF,
    val dockWidthFraction: Float = DEFAULT_TERMINAL_DOCK_FRACTION,
    val focusPane: Char = 'a',
    val paneA: String,
    val paneB: String? = null,
    val docked: List<TerminalToolKind> = emptyList(),
    val dockCurrent: TerminalToolKind? = null,
    val floating: List<TerminalFloatingPanel> = emptyList(),
    val background: TermBackgroundKind = TermBackgroundKind.NONE,
    val backgroundBlurPx: Float = 0f,
    val backgroundOpacity: Float = 0.55f,
    val addSheetOpen: Boolean = false,
    val disconnectSheetOpen: Boolean = false,
    val nextZ: Int = 20,
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
    const val FLOAT_MIN_WIDTH_DP = 200
    const val FLOAT_MIN_HEIGHT_DP = 160
    const val FLOAT_DEFAULT_WIDTH_FRACTION = 0.78f
    const val FLOAT_DEFAULT_MAX_WIDTH_DP = 330
    const val FLOAT_DEFAULT_HEIGHT_FRACTION = 0.44f

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

    fun openTool(state: TerminalWorkspaceState, kind: TerminalToolKind): TerminalWorkspaceState {
        if (state.split.docksTools) {
            val docked = if (kind in state.docked) state.docked else state.docked + kind
            return state.copy(docked = docked, dockCurrent = kind)
        }
        val existing = state.floating.firstOrNull { it.kind == kind }
        val z = state.nextZ + 1
        return if (existing != null) {
            state.copy(
                floating = state.floating.map { if (it.kind == kind) it.copy(z = z) else it },
                nextZ = z,
            )
        } else {
            val index = state.floating.size
            state.copy(
                floating = state.floating + TerminalFloatingPanel(
                    kind = kind,
                    z = z,
                    offsetXPx = Float.NaN,
                    offsetYPx = Float.NaN,
                ).also { it },
                nextZ = z,
                /* index is used by the renderer to stagger the first paint */
            ).let { next ->
                if (index == 0) next else next
            }
        }
    }

    fun closeFloating(state: TerminalWorkspaceState, kind: TerminalToolKind): TerminalWorkspaceState =
        state.copy(floating = state.floating.filterNot { it.kind == kind })

    fun raiseFloating(state: TerminalWorkspaceState, kind: TerminalToolKind): TerminalWorkspaceState {
        val z = state.nextZ + 1
        return state.copy(
            floating = state.floating.map { if (it.kind == kind) it.copy(z = z) else it },
            nextZ = z,
        )
    }

    fun cycleLayout(state: TerminalWorkspaceState, kind: TerminalToolKind): TerminalWorkspaceState {
        val order = TermPanelLayout.entries
        return state.copy(
            floating = state.floating.map { panel ->
                if (panel.kind != kind) panel
                else {
                    val next = order[(order.indexOf(panel.layout) + 1) % order.size]
                    panel.copy(layout = next)
                }
            },
        )
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

    fun floatingOffset(index: Int): Pair<Float, Float> {
        val off = (index % 3) * 16f
        return (6f + off / 3f) to (8f + off)
    }
}
