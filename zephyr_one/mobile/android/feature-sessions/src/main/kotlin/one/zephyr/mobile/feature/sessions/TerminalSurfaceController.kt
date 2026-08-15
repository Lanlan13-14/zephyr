package one.zephyr.mobile.feature.sessions

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * The byte sink for one session.
 *
 * An interface rather than a direct engine reference because SSH and Telnet reach the wire by
 * completely different routes (an SSH channel versus an IAC-escaped socket), yet the surface above
 * them is identical per TERMINAL_EXPERIENCE.md 1. It also means the whole controller is testable
 * with a recording fake.
 */
interface TerminalTransport {
    suspend fun write(bytes: ByteArray)

    /** Called when an asynchronous wire write/resize fails; never throw onto the UI dispatcher. */
    fun onFailure(error: Throwable) = Unit

    /**
     * @param widthPx pixel dimensions travel with the resize because SSH window-change carries them
     *   and some full-screen programs use them for sixel/image sizing. Telnet NAWS ignores them.
     */
    suspend fun resize(columns: Int, rows: Int, widthPx: Int, heightPx: Int)
}

/**
 * Everything the terminal UI renders, as one immutable value.
 *
 * One state object rather than a dozen observable fields is what keeps the frozen rule in
 * TERMINAL_EXPERIENCE.md 3 enforceable: UI state and engine state are separate, so the toolbar and
 * the session list may recompose freely while the emulator and its scrollback are never rebuilt.
 */
data class TerminalSurfaceState(
    val composition: TerminalComposition = TerminalComposition.idle,
    val latches: ModifierLatches = ModifierLatches(),
    val size: TerminalSize = TerminalSize(80, 24),
    val fontSp: Float = 14f,
    val chrome: TerminalChrome = TerminalChrome(shortcutMatrix = true, dock = true, island = true),
    val modes: TerminalModes = TerminalModes(),
    val charset: TerminalCharset = TerminalCharset.UTF8,
    val gestureOwner: GestureOwner = GestureOwner.UNDECIDED,
    val topRow: Int = 0,
    val selectionActive: Boolean = false,
    val keyboardVisible: Boolean = false,
    /** Pending paste awaiting confirmation. Held here so a recomposition cannot lose the dialog. */
    val pendingPaste: PasteDecision.NeedsConfirmation? = null,
) {
    /** True while the viewport follows live output; drives the jump-to-bottom affordance. */
    val followingBottom: Boolean get() = topRow == 0
}

/**
 * The single owner of a terminal surface.
 *
 * TERMINAL_EXPERIENCE.md 3 forbids more than one component sending an event: a Compose text field,
 * the terminal view and the extra-key row must not each be able to deliver Enter. This class is that
 * one owner. Every byte that reaches [transport] passes through exactly one method here, which is
 * what makes the reverse test in section 12 - "injecting a second owner that sends Enter must fail" -
 * a structural property rather than a convention.
 *
 * Pure decisions live in [TerminalKeyEncoder], [TerminalInput], [GestureArbiter],
 * [ScrollbackViewport], [TerminalGeometry], [PasteGuard] and [TerminalMouseEncoder]; this class only
 * sequences them and owns the mutable state. That split is deliberate: the whole decision table is
 * unit testable without a PTY, and this class is testable with a recording transport.
 */
class TerminalSurfaceController(
    private val transport: TerminalTransport,
    private val scope: CoroutineScope,
    charset: TerminalCharset = TerminalCharset.UTF8,
    fontSp: Float = 14f,
    private val arbiter: GestureArbiter = GestureArbiter(),
) {

    private val viewport = ScrollbackViewport(lineHeightPx = 1f)

    private val stateFlow = MutableStateFlow(TerminalSurfaceState(charset = charset, fontSp = fontSp))
    val state: StateFlow<TerminalSurfaceState> = stateFlow.asStateFlow()

    /**
     * Dock/matrix actions the host must perform.
     *
     * Emitted rather than executed because opening the snippet sheet or toggling the keyboard is the
     * host's job; TERMINAL_EXPERIENCE.md 8.1 is explicit that these are actions and must never be
     * disguised as bytes for the PTY.
     */
    private val actionFlow = MutableSharedFlow<TerminalAction>(extraBufferCapacity = 8)
    val actions: SharedFlow<TerminalAction> = actionFlow

    /** Rows of live output the user has not seen, for the scroll-to-bottom badge. */
    private val missedOutputFlow = MutableStateFlow(0)
    val missedOutputRows: StateFlow<Int> = missedOutputFlow.asStateFlow()

    private var transcriptRows: Int = 0
    private var lineHeightPx: Float = 1f
    private var cellWidthPx: Float = 1f
    private var viewportWidthPx: Float = 0f
    private var viewportHeightPx: Float = 0f

    private var resizeJob: Job? = null
    private var pendingSize: TerminalSize? = null
    private var lastSentSize: TerminalSize? = null

    /**
     * Output arrived while an IME composition was open.
     *
     * TERMINAL_EXPERIENCE.md 8.2 and 3: the viewport must not move during composition, because the
     * candidate window is anchored to the cursor and moving the text under it makes selection
     * impossible. Exactly one correction is allowed after the commit, which is what this flag
     * budgets - it is cleared as soon as it is spent, so a burst of output cannot produce a burst of
     * corrections.
     */
    private var compositionCorrectionPending = false

    /**
     * Rows the emulator appended while a composition was open.
     *
     * Accumulated rather than dropped so the one permitted correction can apply the whole burst at
     * once: dropping them would leave the viewport a screen behind after a long pinyin word, and
     * applying them immediately is exactly the scroll the spec forbids.
     */
    private var deferredOutputRows = 0

    private var pinchBaseFontSp: Float = fontSp

    // ---- geometry ------------------------------------------------------------------------------

    /**
     * Viewport measurement.
     *
     * The chrome decision and the terminal size are computed from the same numbers in the same call,
     * so the host cannot render a dock that the size calculation assumed was hidden - the fourth
     * reverse test in section 12.
     */
    fun onGeometry(
        totalWidthPx: Float,
        totalHeightPx: Float,
        imeHeightPx: Float,
        shortcutMatrixHeightPx: Float,
        dockHeightPx: Float,
        cellWidthPx: Float,
        lineHeightPx: Float,
    ) {
        this.cellWidthPx = cellWidthPx
        this.lineHeightPx = lineHeightPx

        val chrome = TerminalGeometry.chromeFor(
            totalHeightPx = totalHeightPx,
            imeHeightPx = imeHeightPx,
            shortcutMatrixHeightPx = shortcutMatrixHeightPx,
            dockHeightPx = dockHeightPx,
            lineHeightPx = lineHeightPx,
        )
        // Height is asked for with the chrome that actually survived, otherwise a dropped matrix
        // would leave a band of unused pixels below the terminal.
        val heightPx = TerminalGeometry.terminalHeightPx(
            totalHeightPx = totalHeightPx,
            imeHeightPx = imeHeightPx,
            shortcutMatrixHeightPx = if (chrome.shortcutMatrix) shortcutMatrixHeightPx else 0f,
            dockHeightPx = if (chrome.dock) dockHeightPx else 0f,
            lineHeightPx = lineHeightPx,
        )
        viewportWidthPx = totalWidthPx
        viewportHeightPx = heightPx

        val size = TerminalGeometry.sizeFor(totalWidthPx, heightPx, cellWidthPx, lineHeightPx)
        viewport.onGeometryChanged(lineHeightPx, size.rows)

        stateFlow.value = stateFlow.value.copy(
            size = size,
            chrome = chrome,
            keyboardVisible = imeHeightPx > 0f,
            topRow = viewport.topRow,
        )
        scheduleResize(size)
    }

    /**
     * Debounced PTY resize.
     *
     * TERMINAL_EXPERIENCE.md 6 requires the debounce *and* requires the last value to arrive: a drag
     * of the split-screen divider produces dozens of sizes and the final one is the only correct one.
     * The job reads [pendingSize] after the delay rather than capturing it, so the newest value wins
     * however many times this is called.
     */
    private fun scheduleResize(size: TerminalSize) {
        pendingSize = size
        if (size == lastSentSize) return
        resizeJob?.cancel()
        resizeJob = scope.launch {
            delay(TerminalGeometry.RESIZE_DEBOUNCE_MAX_MS)
            val target = pendingSize ?: return@launch
            if (target == lastSentSize) return@launch
            lastSentSize = target
            transport.resize(
                columns = target.columns,
                rows = target.rows,
                widthPx = viewportWidthPx.toInt(),
                heightPx = viewportHeightPx.toInt(),
            )
        }
    }

    // ---- IME -----------------------------------------------------------------------------------

    /** setComposingText. Updates the marked-text overlay only; nothing reaches the transport. */
    fun onComposing(text: String, cursor: Int = text.length) {
        val outcome = TerminalInput.composing(text, cursor)
        stateFlow.value = stateFlow.value.copy(composition = outcome.composition)
    }

    /** commitText. The one place composed text becomes bytes. */
    fun onCommit(text: String) {
        emit(TerminalInput.commit(text, stateFlow.value.charset))
    }

    /** finishComposingText: the platform contract is to commit whatever is pending. */
    fun onFinishComposing() {
        emit(TerminalInput.finish(stateFlow.value.composition, stateFlow.value.charset))
    }

    /** Cancelled composition. Nothing was sent, so nothing needs undoing. */
    fun onCancelComposing() {
        stateFlow.value = stateFlow.value.copy(composition = TerminalComposition.idle)
        spendCompositionCorrection()
    }

    // ---- keys ----------------------------------------------------------------------------------

    /**
     * A key from the software matrix, the IME or a hardware keyboard.
     *
     * All three share this method, which is the whole point of the single-owner rule: there is no
     * second path that could double-send Enter.
     *
     * @return true when the key produced bytes; false when it was consumed locally.
     */
    fun onKey(stroke: TerminalKeyStroke): Boolean {
        val current = stateFlow.value
        val effective = current.latches.applyTo(stroke)

        // Shift+PageUp/PageDown belong to the local transcript. Forwarding them would make the
        // remote program see a page key the user aimed at the scrollback.
        if (TerminalKeyEncoder.isLocalScrollKey(effective)) {
            val pages = if (effective.key == TerminalKey.PageUp) 1 else -1
            scrollPages(pages)
            stateFlow.value = stateFlow.value.copy(latches = current.latches.consume())
            return false
        }

        val outcome = TerminalInput.key(current.composition, effective, current.modes, current.charset)
        // Latches are consumed after the stroke is encoded, never before: Ctrl+Alt+F with both
        // one-shot must send one keystroke carrying both, then clear both.
        stateFlow.value = stateFlow.value.copy(latches = current.latches.consume())
        emit(outcome)
        return outcome.writesToPty
    }

    /** Convenience for a bare key with no modifiers beyond the current latches. */
    fun onKey(key: TerminalKey): Boolean = onKey(TerminalKeyStroke(key))

    /**
     * A tap on the shortcut matrix.
     *
     * The three [ExtraKey] subtypes are handled in three different ways, which is why they are
     * separate types: a modifier must not send bytes, and an action must not be encoded at all.
     */
    fun onExtraKey(key: ExtraKey) {
        when (key) {
            is ExtraKey.Key -> onKey(key.stroke)
            is ExtraKey.Modifier -> stateFlow.value =
                stateFlow.value.copy(latches = stateFlow.value.latches.tap(key.modifier))
            is ExtraKey.Action -> {
                if (key.action == TerminalAction.SCROLL_MODE) jumpToBottom()
                actionFlow.tryEmit(key.action)
            }
        }
    }

    // ---- paste ---------------------------------------------------------------------------------

    /**
     * Clipboard text the user asked to paste.
     *
     * The read itself stays in the host because the frozen rule is that the clipboard is only touched
     * in response to a user action; this method decides what happens to the text afterwards.
     */
    fun onPaste(text: String) {
        val current = stateFlow.value
        when (val decision = PasteGuard.decide(text, current.modes.bracketedPaste, current.charset)) {
            is PasteDecision.Immediate -> write(decision.bytes)
            is PasteDecision.NeedsConfirmation -> stateFlow.value = current.copy(pendingPaste = decision)
        }
    }

    /**
     * The user confirmed a large or multi-line paste.
     *
     * @param keepTrailingNewline false is the frozen option to paste without running the last line:
     *   the command lands on the prompt without executing, which is the entire reason it exists.
     */
    fun onPasteConfirmed(keepTrailingNewline: Boolean) {
        val pending = stateFlow.value.pendingPaste ?: return
        val bytes = PasteGuard.confirmed(
            text = pending.text,
            bracketed = stateFlow.value.modes.bracketedPaste,
            keepTrailingNewline = keepTrailingNewline,
            encoding = stateFlow.value.charset,
        )
        stateFlow.value = stateFlow.value.copy(pendingPaste = null)
        write(bytes)
    }

    fun onPasteCancelled() {
        stateFlow.value = stateFlow.value.copy(pendingPaste = null)
    }

    // ---- gestures ------------------------------------------------------------------------------

    fun onPointerDown(pointerCount: Int) {
        val owner = arbiter.onPointerDown(pointerCount, stateFlow.value.selectionActive)
        pinchBaseFontSp = stateFlow.value.fontSp
        stateFlow.value = stateFlow.value.copy(gestureOwner = owner)
    }

    /**
     * Pointer movement.
     *
     * The arbiter decides the owner once per gesture and this method obeys it. Routing a scroll to
     * the wrong side is the third reverse test in section 12, so the branch below is deliberately one
     * exhaustive decision with no fallback.
     *
     * @param twoFingerScrollGoesRemote the user setting from TERMINAL_EXPERIENCE.md 5.1.
     */
    fun onPointerMove(
        pointerCount: Int,
        dxPx: Float,
        dyPx: Float,
        spanDeltaPx: Float,
        column: Int = 1,
        row: Int = 1,
        twoFingerScrollGoesRemote: Boolean = false,
    ) {
        val current = stateFlow.value
        val owner = arbiter.onMove(
            pointerCount = pointerCount,
            dx = dxPx,
            dy = dyPx,
            spanDelta = spanDeltaPx,
            modes = current.modes,
            twoFingerScrollGoesRemote = twoFingerScrollGoesRemote,
        )
        if (owner != current.gestureOwner) stateFlow.value = current.copy(gestureOwner = owner)

        when (owner) {
            GestureOwner.SCROLLBACK -> {
                viewport.drag(dyPx, transcriptRows)
                publishViewport()
            }
            GestureOwner.REMOTE_MOUSE -> {
                // A drag with mouse reporting on is motion, not a wheel: reporting notches here
                // would make a curses app see scroll events during a selection drag.
                val bytes = TerminalMouseEncoder.encode(
                    button = MouseButton.LEFT,
                    type = MouseEventType.MOVE,
                    column = column,
                    row = row,
                    modes = current.modes,
                )
                if (bytes.isNotEmpty()) write(bytes)
            }
            GestureOwner.ALTERNATE_SCROLL -> {
                val rows = rowsFor(dyPx)
                if (rows != 0) write(AlternateScrollTranslator.encode(rows, current.modes))
            }
            GestureOwner.PINCH -> {
                // Font scale is previewed live but only committed in half-point steps, so a pinch
                // cannot produce a resize storm.
                val preview = pinchBaseFontSp * pinchScale(spanDeltaPx)
                if (TerminalGeometry.fontChanged(current.fontSp, preview)) {
                    stateFlow.value = stateFlow.value.copy(fontSp = TerminalGeometry.commitFontSp(preview))
                }
            }
            GestureOwner.SELECTION, GestureOwner.UNDECIDED -> Unit
        }
    }

    fun onGestureEnd() {
        arbiter.onGestureEnd()
        stateFlow.value = stateFlow.value.copy(gestureOwner = GestureOwner.UNDECIDED)
    }

    /** Long press always wins for selection: the user's intent is explicit. */
    fun onLongPress() {
        val owner = arbiter.onLongPress()
        stateFlow.value = stateFlow.value.copy(gestureOwner = owner, selectionActive = true)
    }

    /**
     * A tap.
     *
     * Ordered exactly as Termux does it (TERMINAL_EXPERIENCE.md 2.2): a tap during selection exits
     * selection instead of moving the cursor, so the first tap after a selection never reaches the
     * remote program.
     *
     * @return true when the tap was consumed locally.
     */
    fun onTap(column: Int, row: Int): Boolean {
        val current = stateFlow.value
        if (current.selectionActive) {
            stateFlow.value = current.copy(selectionActive = false)
            return true
        }
        if (current.modes.mouseReporting) {
            write(
                TerminalMouseEncoder.encode(MouseButton.LEFT, MouseEventType.PRESS, column, row, current.modes) +
                    TerminalMouseEncoder.encode(MouseButton.LEFT, MouseEventType.RELEASE, column, row, current.modes),
            )
            return false
        }
        // No mouse mode: a tap is a focus request, which is the host's job.
        actionFlow.tryEmit(TerminalAction.TOGGLE_KEYBOARD)
        return true
    }

    /** A physical mouse wheel. */
    fun onWheel(notches: Int, column: Int = 1, row: Int = 1) {
        val current = stateFlow.value
        when {
            current.modes.mouseReporting ->
                write(TerminalMouseEncoder.wheel(notches, column, row, current.modes))
            current.modes.alternateBuffer ->
                write(AlternateScrollTranslator.encode(notches, current.modes))
            else -> {
                viewport.scrollBy(-notches, transcriptRows)
                publishViewport()
            }
        }
    }

    fun onFling(velocityPxPerSecond: Float) {
        if (stateFlow.value.modes.mouseReporting || stateFlow.value.modes.alternateBuffer) return
        val rows = viewport.flingRows(velocityPxPerSecond)
        if (rows != 0) {
            viewport.scrollBy(rows, transcriptRows)
            publishViewport()
        }
    }

    fun setSelectionActive(active: Boolean) {
        stateFlow.value = stateFlow.value.copy(selectionActive = active)
    }

    // ---- scrollback ----------------------------------------------------------------------------

    fun scrollPages(pages: Int) {
        viewport.scrollPages(pages, transcriptRows)
        publishViewport()
    }

    fun jumpToBottom() {
        viewport.jumpToBottom()
        missedOutputFlow.value = 0
        publishViewport()
    }

    /**
     * Remote output arrived.
     *
     * Two frozen rules meet here. First, output must never steal the viewport from a user who has
     * scrolled up - the second reverse test in section 12. Second, the viewport must not move at all
     * while an IME composition is open, with one correction permitted after the commit.
     *
     * @param newRows rows the emulator appended.
     * @param transcriptRows total scrollback depth after the append.
     */
    fun onOutput(newRows: Int, transcriptRows: Int) {
        this.transcriptRows = transcriptRows

        if (stateFlow.value.composition.isActive) {
            // Budget a single correction rather than scrolling now.
            compositionCorrectionPending = true
            deferredOutputRows += newRows
            return
        }

        val following = viewport.onOutput(newRows, transcriptRows)
        if (!following) {
            missedOutputFlow.value = missedOutputFlow.value + newRows
        }
        publishViewport()
    }

    // ---- modes and charset ---------------------------------------------------------------------

    /**
     * The emulator negotiated new modes.
     *
     * Leaving a stale mode in place would send SGR reports to a program that only asked for 1000,
     * which draws escape text on the user's screen, so this is a plain replace rather than a merge.
     */
    fun onModes(modes: TerminalModes) {
        val current = stateFlow.value
        if (modes != current.modes) stateFlow.value = current.copy(modes = modes)
    }

    /** Telnet may renegotiate the code page mid-session (ZEPHYR_PARITY.md 6.2). */
    fun setCharset(charset: TerminalCharset) {
        stateFlow.value = stateFlow.value.copy(charset = charset)
    }

    fun setFontSp(fontSp: Float) {
        stateFlow.value = stateFlow.value.copy(fontSp = TerminalGeometry.commitFontSp(fontSp))
    }

    /** Clears one-shot modifier latches after Termux itself consumed a keystroke. */
    fun consumeLatches() {
        val current = stateFlow.value
        if (!current.latches.anyActive) return
        stateFlow.value = current.copy(latches = current.latches.consume())
    }

    // ---- internals -----------------------------------------------------------------------------

    /**
     * The only path from an [InputOutcome] to the wire.
     *
     * Applying the composition and writing the bytes in one place is what makes it impossible for the
     * overlay and the PTY to both hold the same characters.
     */
    private fun emit(outcome: InputOutcome) {
        stateFlow.value = stateFlow.value.copy(composition = outcome.composition)
        if (!outcome.composition.isActive) spendCompositionCorrection()
        if (outcome.writesToPty) {
            // Typing is an explicit request to see the result, so it returns to the live output.
            viewport.jumpToBottom()
            missedOutputFlow.value = 0
            publishViewport()
            write(outcome.bytes)
        }
    }

    /**
     * Spends the single post-commit correction, if one was budgeted.
     *
     * "At most one" is enforced by clearing the flag before doing the work, so a burst of output
     * during a long composition still produces exactly one viewport move.
     */
    private fun spendCompositionCorrection() {
        if (!compositionCorrectionPending) return
        compositionCorrectionPending = false
        val rows = deferredOutputRows
        deferredOutputRows = 0
        if (rows <= 0) return
        if (viewport.followingBottom) {
            // Already pinned to the live output: the appended rows are on screen by definition.
            publishViewport()
        } else {
            // Scrolled up: shift by the deferred rows so the text the user was reading stays put,
            // which is the same guarantee onOutput gives outside a composition.
            viewport.scrollBy(rows, transcriptRows)
            missedOutputFlow.value = missedOutputFlow.value + rows
            publishViewport()
        }
    }

    private fun write(bytes: ByteArray) {
        if (bytes.isEmpty()) return
        scope.launch {
            runCatching { transport.write(bytes) }
                .onFailure(transport::onFailure)
        }
    }

    private fun publishViewport() {
        if (stateFlow.value.topRow != viewport.topRow) {
            stateFlow.value = stateFlow.value.copy(topRow = viewport.topRow)
        }
    }

    /**
     * Drag distance to alternate-scroll rows.
     *
     * Positive [dyPx] is the platform "finger moved up" convention that [ScrollbackViewport.drag]
     * documents, which means "toward the live bottom" and therefore Down keys - the same direction a
     * positive notch count means in [onWheel]. Termux derives it identically
     * (distanceY / fontLineSpacing, then Down when the result is positive), so a full-screen pager
     * scrolls the same way under a finger as under a wheel.
     */
    private fun rowsFor(dyPx: Float): Int {
        if (lineHeightPx <= 0f) return 0
        return (dyPx / lineHeightPx).toInt()
    }

    /**
     * Pinch span to a scale factor.
     *
     * Relative to the viewport height so the same finger movement produces the same zoom on a phone
     * and on a tablet, instead of a pixel delta that means different things on different screens.
     */
    private fun pinchScale(spanDeltaPx: Float): Float {
        if (viewportHeightPx <= 0f) return 1f
        return (1f + spanDeltaPx / viewportHeightPx).coerceIn(MIN_PINCH_SCALE, MAX_PINCH_SCALE)
    }

    companion object {
        private const val MIN_PINCH_SCALE = 0.5f
        private const val MAX_PINCH_SCALE = 2f
    }
}
