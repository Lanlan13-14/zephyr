/**
 * TerminalSurfaceController — single control plane for mobile WTerm × Zephyr.
 *
 * Before: parallel keyboard modules, terminal-scroll-policy, terminal.js flags,
 * WTerm viewport, parent keyboard-metrics, and CSS chrome each fired on their
 * own. terminal.js sprinkled ~90 call sites to glue them.
 *
 * After: every mobile surface event enters HERE. This module is the only writer of:
 *   - scrollTop (via chrome-pin geometry)
 *   - --ime-chrome-bottom / keyboard-open class / ime-active class
 *   - soft-keyboard intent (delegates to ssh-keyboard facade)
 *
 * Other modules are read-only services:
 *   - scroll-policy: pure math
 *   - soft-keyboard: intent state machine
 *   - WTerm: buffer + render + public viewport API
 */

import {
    Intent as SoftKeyboardIntent,
    LiftMode as SoftKeyboardLiftMode,
} from './ssh-keyboard/index.js?v=20260722-kb-cjk-cand1';
import {
    computeCursorAboveChromeScrollTop,
    allowScrollDuringTyping,
    scrollSettlePhases,
    shouldScrollOnTerminalOutput,
    DEFAULT_TERMINAL_SCROLL_SETTINGS,
} from './terminal-scroll-policy.js?v=20260721-cursor-metrics1';

/**
 * @typedef {object} SurfaceHost
 * @property {() => boolean} isTouchDevice
 * @property {() => boolean} isMobileStable
 * @property {() => any} getTerm                 WTerm instance
 * @property {() => HTMLElement | null} getScrollElement
 * @property {() => HTMLElement | null} getWtermRoot  .wterm element
 * @property {() => HTMLTextAreaElement | null} ensureImeProxy
 * @property {() => { keyboardInset: number }} getViewportMetrics
 * @property {() => boolean} isSelectionMode
 * @property {() => boolean} isGestureSuppressed  pan/selection only
 * @property {() => number} getChromeHeight       fixed bars covering scrollport (0 if flow)
 * @property {() => { lineHeight: number, cursorTopInContent?: number, cursorBottomInContent?: number } | null} getCursorMetrics
 * @property {() => number} getMaxScroll
 * @property {(open: boolean, inset: number, meta?: object) => void} applyChromeLayout
 * @property {(reason: string, opts?: { force?: boolean, sameLineInput?: boolean, immediate?: boolean }) => boolean} [pinScroll]
 *        Single scrollTop writer owned by host (applyCursorAboveChromeScroll).
 * @property {(metrics: object) => void} [notifyParent]
 * @property {(label: string, details?: object) => void} [log]
 * @property {() => void} [onScrollbar]
 * @property {(state: object) => void} [onSoftKeyboardState]
 * @property {() => boolean} [hasLiveSelection]
 * @property {() => boolean} [isUserReadingHistory]
 */

/**
 * @param {SurfaceHost} host
 */
export function createTerminalSurfaceController(host) {
    /** @type {'idle'|'ime-open'|'user-reading'|'selection'|'composing'} */
    let mode = 'idle';
    let composing = false;
    let followEnabled = true;
    let lastScrollTop = 0;
    let lastScrollReason = 'init';
    let scrollApiCalls = 0;
    let typingUntil = 0;
    let suppressScrollUntil = 0;
    let keyboardOpen = false;
    let keyboardInset = 0;
    let imeActive = false;
    let softKeyboard = null;
    let unsubRender = null;
    let bound = false;

    const settings = { ...DEFAULT_TERMINAL_SCROLL_SETTINGS };

    function log(event, details = {}) {
        try {
            host.log?.(`surface:${event}`, {
                ...details,
                mode,
                keyboardOpen,
                followEnabled,
                composing,
                scrollApiCalls,
            });
        } catch (_) {}
    }

    function snapshot() {
        return {
            mode,
            composing,
            followEnabled,
            keyboardOpen,
            keyboardInset,
            imeActive,
            lastScrollTop,
            lastScrollReason,
            scrollApiCalls,
            liftMode: softKeyboard?.getLiftMode?.() || SoftKeyboardLiftMode.WORKSPACE,
            intent: softKeyboard?.getState?.()?.intent || SoftKeyboardIntent.CLOSED,
        };
    }

    // ─── mode ───────────────────────────────────────────────────────────

    function recomputeMode() {
        if (host.isSelectionMode?.() || host.hasLiveSelection?.()) {
            mode = 'selection';
        } else if (composing) {
            mode = 'composing';
        } else if (host.isUserReadingHistory?.() || !followEnabled) {
            mode = 'user-reading';
        } else if (keyboardOpen || softKeyboard?.desiredOpen?.()) {
            mode = 'ime-open';
        } else {
            mode = 'idle';
        }
        return mode;
    }

    function setFollowEnabled(enabled, reason = '') {
        followEnabled = !!enabled;
        recomputeMode();
        log('follow', { enabled: followEnabled, reason });
    }

    // ─── ime-active class (cursor visibility) ───────────────────────────

    function setImeActive(active, reason = '') {
        imeActive = !!active;
        const el = host.getWtermRoot?.();
        if (el?.classList) {
            el.classList.toggle('ime-active', imeActive);
            if (imeActive) el.classList.add('cursor-blink');
        }
        log('ime-active', { active: imeActive, reason });
    }

    // ─── single scroll writer ───────────────────────────────────────────

    /**
     * Route pin through host.pinScroll (single writer). Surface only decides WHEN.
     * @returns {boolean}
     */
    function pinCursorAboveChrome(reason = 'pin', { force = false, sameLineInput = false, immediate = false } = {}) {
        if (!host.isMobileStable?.()) return false;
        recomputeMode();

        if (mode === 'selection') {
            log('pin-blocked-selection', { reason });
            return false;
        }
        if (mode === 'user-reading' && !force && !sameLineInput) {
            log('pin-blocked-reading', { reason });
            return false;
        }
        if (composing && !force) {
            log('pin-blocked-composing', { reason });
            return false;
        }

        if (typeof host.pinScroll === 'function') {
            const did = !!host.pinScroll(reason, { force, sameLineInput, immediate });
            if (did) {
                scrollApiCalls += 1;
                lastScrollReason = reason;
                try {
                    lastScrollTop = host.getScrollElement?.()?.scrollTop || lastScrollTop;
                } catch (_) {}
                if (!sameLineInput || force) followEnabled = true;
                recomputeMode();
            }
            log('pin', { reason, did, force, sameLineInput });
            return did;
        }

        // Fallback pure path (tests / host without pinScroll)
        const el = host.getScrollElement?.();
        if (!el) return false;
        const cursor = host.getCursorMetrics?.();
        if (!cursor || !(Number.isFinite(cursor.cursorBottomInViewport) || Number.isFinite(cursor.cursorBottomInContent))) {
            host.onScrollbar?.();
            return false;
        }
        const decision = computeCursorAboveChromeScrollTop({
            scrollTop: el.scrollTop || 0,
            maxScroll: host.getMaxScroll?.() ?? Math.max(0, el.scrollHeight - el.clientHeight),
            scrollportHeight: el.clientHeight || 0,
            cursorBottomInViewport: cursor.cursorBottomInViewport,
            cursorTopInViewport: cursor.cursorTopInViewport,
            cursorBottomInContent: cursor.cursorBottomInContent,
            cursorTopInContent: cursor.cursorTopInContent,
            chromeHeight: host.getChromeHeight?.() || 0,
            lineHeight: cursor.lineHeight || 17,
            sameLineInput,
            force,
        });
        if (sameLineInput && !force && !allowScrollDuringTyping(decision)) {
            host.onScrollbar?.();
            return false;
        }
        if (!decision.changed) {
            host.onScrollbar?.();
            return false;
        }
        el.scrollTop = decision.scrollTop;
        lastScrollTop = decision.scrollTop;
        lastScrollReason = `${reason}:${decision.reason}`;
        scrollApiCalls += 1;
        if (decision.reason !== 'sparse-zero-max') followEnabled = true;
        recomputeMode();
        host.onScrollbar?.();
        log('pin', { reason: lastScrollReason, scrollTop: lastScrollTop });
        return true;
    }

    function schedulePin(reason, opts = {}, phases = [0]) {
        const list = Array.isArray(phases) ? phases : [0];
        list.forEach((delay) => {
            const run = () => pinCursorAboveChrome(reason, opts);
            if (delay <= 0) {
                if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
                else run();
            } else {
                setTimeout(() => {
                    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
                    else run();
                }, delay);
            }
        });
    }

    // ─── soft keyboard host bridge ──────────────────────────────────────

        function ensureSoftKeyboard() {
        if (softKeyboard) return softKeyboard;
        if (!host.isTouchDevice?.()) return null;
        // Sole authority: host must inject SshKeyboard.asSoftKeyboard().
        if (typeof host.getSoftKeyboard === 'function') {
            const external = host.getSoftKeyboard();
            if (external) {
                softKeyboard = external;
                return softKeyboard;
            }
        }
        host.log?.('soft-kb:missing-inject', {});
        return null;
    }

    // ─── public event API (only entries terminal.js should call) ────────

    /** Bind to a live WTerm instance (call once after term created). */
    function attachTerm(reason = 'attach') {
        detachTerm();
        const term = host.getTerm?.();
        if (!term) return false;
        bound = true;

        // Mobile: kill WTerm internal maxScroll stick — we own scroll.
        if (host.isMobileStable?.()) {
            try { term.lockBottom?.(); } catch (_) {}
            try { term._shouldScrollToBottom = false; } catch (_) {}
        }

        if (typeof term.onRenderComplete === 'function') {
            unsubRender = term.onRenderComplete(() => {
                onRenderComplete('wterm-render');
            });
        }
        log('attach', { reason });
        return true;
    }

    function detachTerm() {
        try { unsubRender?.(); } catch (_) {}
        unsubRender = null;
        bound = false;
    }

    function onRenderComplete(reason = 'render') {
        if (!host.isMobileStable?.()) return;
        recomputeMode();
        // Render is NOT a scroll writer. Input/output/enter/layout paths own
        // the single pin. Auto-pinning here raced compositionend + input and
        // made the cursor jump twice per keystroke.
        host.onScrollbar?.();
        host.onCursorGeometry?.(reason);
    }

    /** User tapped terminal body — open/retain IME only. */
    function onTerminalTap(reason = 'terminal-tap') {
        if (!host.isMobileStable?.()) return false;
        if (host.isSelectionMode?.() || host.hasLiveSelection?.()) return false;
        if (host.isGestureSuppressed?.()) return false;
        const kb = ensureSoftKeyboard();
        if (!kb) return false;
        kb.handleTerminalTap(reason);
        setImeActive(true, reason);
        recomputeMode();
        return kb.desiredOpen();
    }

    function onCmdFocus(reason = 'cmd-focus') {
        const kb = ensureSoftKeyboard();
        kb?.open?.(reason, { gesture: true, liftMode: SoftKeyboardLiftMode.NONE });
        setImeActive(false, reason); // cmd bar owns caret, not wterm cursor
        recomputeMode();
    }

    function onCmdBlur(reason = 'cmd-blur') {
        const kb = ensureSoftKeyboard();
        if (kb?.getLiftMode?.() === SoftKeyboardLiftMode.NONE || kb?.desiredOpen?.()) {
            kb?.close?.(reason, { force: false, blurCmd: false });
        }
        recomputeMode();
    }

    function onViewport(reason = 'viewport') {
        ensureSoftKeyboard()?.syncFromViewport?.(reason);
        recomputeMode();
    }

    function onCompositionStart() {
        composing = true;
        suppressScrollUntil = Date.now() + 4000;
        recomputeMode();
        log('composition-start', {});
    }

    function onCompositionEnd() {
        composing = false;
        suppressScrollUntil = Date.now() + 120;
        recomputeMode();
        log('composition-end', {});
    }

    /**
     * After printable IME text was sent to PTY.
     * Same-line: pin only if clipped. Never multi-phase.
     */
    function onUserInputCommitted(data, reason = 'input', { paste = false } = {}) {
        typingUntil = Date.now() + (paste ? 260 : 180);
        suppressScrollUntil = Math.max(suppressScrollUntil, Date.now() + (paste ? 260 : 180));
        followEnabled = true;
        recomputeMode();

        if (composing) return false;

        if (paste) {
            schedulePin(`${reason}:paste`, { force: true, sameLineInput: false }, scrollSettlePhases('paste'));
            return true;
        }
        // Wait one render so cursor metrics are fresh, then single pin.
        const term = host.getTerm?.();
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            pinCursorAboveChrome(`${reason}:input`, { force: false, sameLineInput: true });
        };
        if (term && typeof term.onRenderComplete === 'function') {
            const unsub = term.onRenderComplete(() => { unsub(); finish(); });
            setTimeout(finish, 100);
        } else if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(finish);
        } else {
            finish();
        }
        return true;
    }

    /** Enter / control that should reveal new line. */
    function onEnterCommitted(reason = 'enter') {
        typingUntil = Date.now() + 40;
        suppressScrollUntil = Math.max(suppressScrollUntil, Date.now() + 40);
        followEnabled = true;
        recomputeMode();
        schedulePin(`${reason}:enter`, { force: true, sameLineInput: false }, scrollSettlePhases('enter'));
        return true;
    }

    /**
     * Remote output arrived. Default: no app-layer scroll (Netcatty).
     * Stick only via chrome-pin when already following and not typing.
     */
    function onOutput(reason = 'output') {
        if (!host.isMobileStable?.()) return false;
        recomputeMode();
        if (mode === 'user-reading' || mode === 'selection' || composing) {
            host.onScrollbar?.();
            return false;
        }
        if (shouldScrollOnTerminalOutput(settings)) {
            return pinCursorAboveChrome(`${reason}:output-policy`, { force: true });
        }
        // Default off: if user was following, WTerm paint may shift content;
        // one chrome-pin keeps cursor above bars without chasing maxScroll.
        if (followEnabled && Date.now() >= typingUntil && Date.now() >= suppressScrollUntil) {
            return pinCursorAboveChrome(`${reason}:output-stick`, { force: true });
        }
        host.onScrollbar?.();
        return false;
    }

    function onUserScrollAway(reason = 'user-scroll') {
        followEnabled = false;
        recomputeMode();
        log('scroll-away', { reason });
    }

    function onUserScrollToBottom(reason = 'user-bottom') {
        followEnabled = true;
        recomputeMode();
        pinCursorAboveChrome(reason, { force: true });
    }

    function closeKeyboard(reason = 'close', opts = {}) {
        ensureSoftKeyboard()?.close?.(reason, opts);
        setImeActive(false, reason);
        recomputeMode();
    }

    function openKeyboard(reason = 'open', opts = {}) {
        ensureSoftKeyboard()?.open?.(reason, opts);
        setImeActive(true, reason);
        recomputeMode();
    }

    function getSoftKeyboard() {
        return ensureSoftKeyboard();
    }

    function getState() {
        return snapshot();
    }

    function dispose() {
        detachTerm();
        softKeyboard = null;
    }

    return {
        // lifecycle
        attachTerm,
        detachTerm,
        dispose,
        // events (terminal.js should ONLY use these for mobile surface)
        onTerminalTap,
        onCmdFocus,
        onCmdBlur,
        onViewport,
        onCompositionStart,
        onCompositionEnd,
        onUserInputCommitted,
        onEnterCommitted,
        onOutput,
        onRenderComplete,
        onUserScrollAway,
        onUserScrollToBottom,
        openKeyboard,
        closeKeyboard,
        // state
        getState,
        getSoftKeyboard,
        setFollowEnabled,
        setImeActive,
        pinCursorAboveChrome,
        // debug
        get scrollApiCalls() { return scrollApiCalls; },
    };
}

export default createTerminalSurfaceController;
