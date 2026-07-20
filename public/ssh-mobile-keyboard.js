/**
 * SSH mobile soft-keyboard controller (intent-driven).
 *
 * Design goals (Termius / Blink / iOS Terminal class):
 * 1. User intent is explicit: open | closed. Viewport only reports physical state.
 * 2. Open only from a real user gesture (focus proxy in the same event turn).
 * 3. Terminal body: single clean tap opens; never toggle-dismisses.
 *    Dismiss via keyboard button, system back/gesture, or parent reset.
 * 4. Scroll / long-press / double-tap selection never open the keyboard.
 * 5. Aux keys keep focus on the IME proxy without stealing it.
 * 6. Physical open is measured from visualViewport / virtualKeyboard with hysteresis.
 * 7. liftMode:
 *    - workspace: whole terminal surface lifts above the keyboard (scheme A)
 *    - none:      top command bar input — do not lift the page
 */

export const SoftKeyboardIntent = Object.freeze({
    OPEN: 'open',
    CLOSED: 'closed',
});

export const SoftKeyboardLiftMode = Object.freeze({
    WORKSPACE: 'workspace',
    NONE: 'none',
});

/**
 * @typedef {object} SoftKeyboardHost
 * @property {() => boolean} isTouchDevice
 * @property {() => boolean} isStableMode
 * @property {() => HTMLTextAreaElement | null} ensureProxy
 * @property {(proxy: HTMLTextAreaElement) => void} [onProxyAttached]
 * @property {() => { keyboardInset: number, keyboardOpenHint?: boolean }} getViewportMetrics
 * @property {() => boolean} isSelectionMode
 * @property {() => boolean} isGestureSuppressed
 * @property {(state: SoftKeyboardState) => void} onStateChange
 * @property {(metrics: object) => void} [notifyParent]
 * @property {(inset: number, open: boolean, reason: string, meta?: object) => void} [applyInset]
 * @property {(reason: string) => void} [onOpenCommitted]
 * @property {(reason: string) => void} [onCloseCommitted]
 * @property {(label: string, details?: object) => void} [log]
 */

/**
 * @typedef {object} SoftKeyboardState
 * @property {'open'|'closed'} intent
 * @property {boolean} physicalOpen
 * @property {number} inset
 * @property {'workspace'|'none'} liftMode
 * @property {string} lastReason
 * @property {number} lastGestureAt
 * @property {boolean} focusLikely
 */

const OPEN_INSET_THRESHOLD = 80;
const CLOSE_INSET_THRESHOLD = 12;
const GESTURE_FOCUS_MS = 2400;
const REFOCUS_GUARD_MS = 600;
const OPEN_HOLD_MS = 3200;
const PHYSICAL_DEBOUNCE_MS = 48;

function isEditableElement(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'TEXTAREA' || tag === 'INPUT' || !!el.isContentEditable
        || !!el.classList?.contains?.('mobile-terminal-ime-proxy');
}

/**
 * @param {SoftKeyboardHost} host
 */
export function createSshMobileSoftKeyboard(host) {
    /** @type {SoftKeyboardState} */
    let state = {
        intent: SoftKeyboardIntent.CLOSED,
        physicalOpen: false,
        inset: 0,
        liftMode: SoftKeyboardLiftMode.WORKSPACE,
        lastReason: 'init',
        lastGestureAt: 0,
        focusLikely: false,
    };

    let settleTimer = 0;
    let refocusTimer = 0;
    let signature = '';
    let suppressRefocusUntil = 0;
    let lastOpenGestureAt = 0;
    let openHoldUntil = 0;
    let lastPhysicalAboveCloseAt = 0;

    function log(event, details = {}) {
        try { host.log?.(event, { ...details, state: snapshot() }); } catch (_) {}
    }

    function snapshot() {
        return { ...state };
    }

    function emit() {
        try { host.onStateChange?.(snapshot()); } catch (_) {}
    }

    function getActiveElement() {
        try { return globalThis.document?.activeElement || null; } catch (_) { return null; }
    }

    function focusProxy(reason = 'focus') {
        const proxy = host.ensureProxy?.();
        if (!proxy) return false;
        try {
            if (getActiveElement() !== proxy) {
                proxy.focus({ preventScroll: true });
            }
        } catch (_) {
            try { proxy.focus(); } catch (__) { return false; }
        }
        state.focusLikely = true;
        lastOpenGestureAt = Date.now();
        log('focus-proxy', { reason });
        return getActiveElement() === proxy || state.intent === SoftKeyboardIntent.OPEN;
    }

    function blurProxy(reason = 'blur') {
        const proxy = host.ensureProxy?.();
        state.focusLikely = false;
        try { proxy?.blur?.(); } catch (_) {}
        try {
            const active = getActiveElement();
            if (active && (active === proxy || active?.classList?.contains?.('mobile-terminal-ime-proxy'))) {
                active.blur?.();
            }
        } catch (_) {}
        log('blur-proxy', { reason });
    }

    function setIntent(intent, reason) {
        if (state.intent === intent && state.lastReason === reason) return false;
        state.intent = intent;
        state.lastReason = reason;
        emit();
        return true;
    }

    function parentPayload(open, inset, reason) {
        let viewportHeight = 0;
        let layoutHeight = 0;
        let offsetTop = 0;
        try {
            viewportHeight = Math.round(globalThis.window?.visualViewport?.height || globalThis.window?.innerHeight || 0);
            layoutHeight = Math.round(
                globalThis.window?.innerHeight
                || globalThis.document?.documentElement?.clientHeight
                || 0,
            );
            offsetTop = Math.round(globalThis.window?.visualViewport?.offsetTop || 0);
        } catch (_) {}
        return {
            keyboardOpen: open,
            keyboardInset: open ? inset : 0,
            viewportHeight,
            layoutHeight,
            offsetTop,
            stableInput: !!host.isStableMode?.(),
            liftMode: state.liftMode,
            source: state.liftMode === SoftKeyboardLiftMode.NONE ? 'cmd' : 'terminal-ime',
            reason: reason || state.lastReason,
        };
    }

    function commitPhysical(open, inset, reason) {
        const nextInset = Math.max(0, Math.round(inset || 0));
        const layoutFrozen = state.liftMode === SoftKeyboardLiftMode.NONE;
        // liftMode=none (top command bar): track physical open for diagnostics only.
        // Never apply non-zero inset / never ask parent to change layout.
        const appliedOpen = layoutFrozen ? false : open;
        const appliedInset = layoutFrozen ? 0 : (open ? nextInset : 0);
        const changed = state.physicalOpen !== open
            || Math.abs(state.inset - (open ? nextInset : 0)) >= 4
            || signature !== `${open}:${open ? nextInset : 0}:${state.liftMode}`;
        state.physicalOpen = open;
        state.inset = open ? nextInset : 0;
        if (!changed && signature === `${open}:${state.inset}:${state.liftMode}`) return false;
        signature = `${open}:${state.inset}:${state.liftMode}`;
        try {
            host.applyInset?.(appliedInset, appliedOpen, reason, {
                liftMode: state.liftMode,
                source: layoutFrozen ? 'cmd' : 'terminal-ime',
                layoutFrozen,
            });
        } catch (_) {}
        try {
            host.notifyParent?.(parentPayload(
                // Parent must treat cmd bar as layout-closed even if IME is up.
                layoutFrozen ? false : open,
                layoutFrozen ? 0 : state.inset,
                reason,
            ));
        } catch (_) {}
        emit();
        if (open && !layoutFrozen) host.onOpenCommitted?.(reason);
        else if (!open) host.onCloseCommitted?.(reason);
        log('physical', { reason, open, inset: state.inset, liftMode: state.liftMode, layoutFrozen });
        return true;
    }

    function measurePhysical() {
        const metrics = host.getViewportMetrics?.() || { keyboardInset: 0 };
        const inset = Math.max(0, Math.round(Number(metrics.keyboardInset) || 0));
        // Hysteresis: easier to stay open than to flip-flop during IME animation.
        if (state.physicalOpen) {
            const open = inset > CLOSE_INSET_THRESHOLD;
            if (open) lastPhysicalAboveCloseAt = Date.now();
            return { open, inset };
        }
        const open = inset >= OPEN_INSET_THRESHOLD;
        if (open) lastPhysicalAboveCloseAt = Date.now();
        return { open, inset };
    }

    function withinOpenHold() {
        return Date.now() < openHoldUntil || Date.now() - lastOpenGestureAt < GESTURE_FOCUS_MS;
    }

    function syncFromViewport(reason = 'viewport') {
        if (!host.isTouchDevice?.()) return snapshot();
        const { open, inset } = measurePhysical();
        const active = getActiveElement();
        const stillOnEditable = isEditableElement(active);

        // CRITICAL: while an editable still has focus, NEVER auto-close from
        // visualViewport noise / parent layout resize. Only blur/close() dismisses.
        // This kills the "keyboard opens then dies in ~1s" loop.
        if (state.intent === SoftKeyboardIntent.OPEN && stillOnEditable) {
            if (open) commitPhysical(true, inset, `${reason}:open-focused`);
            else log('keep-open-while-focused', { reason, inset });
            return snapshot();
        }

        // System dismissed keyboard (Android back) while we still desired open.
        // Accept only when: past open-hold, AND no editable focused, AND physical closed.
        if (state.intent === SoftKeyboardIntent.OPEN && state.physicalOpen && !open) {
            if (withinOpenHold() || state.focusLikely) {
                log('await-system-dismiss-hold', { reason, inset });
                return snapshot();
            }
            setIntent(SoftKeyboardIntent.CLOSED, `${reason}:system-dismiss`);
            state.focusLikely = false;
            commitPhysical(false, 0, `${reason}:system-dismiss`);
            return snapshot();
        }

        // Desired closed but viewport still reports residual inset mid-animation: ignore open.
        if (state.intent === SoftKeyboardIntent.CLOSED) {
            if (!open) commitPhysical(false, 0, `${reason}:closed`);
            else if (inset < OPEN_INSET_THRESHOLD) commitPhysical(false, 0, `${reason}:noise`);
            // If physical is open but intent closed (race), force blur path again.
            else if (Date.now() - lastOpenGestureAt > GESTURE_FOCUS_MS && !stillOnEditable) {
                blurProxy(`${reason}:intent-closed-but-physical`);
                commitPhysical(false, 0, `${reason}:force-closed`);
            }
            return snapshot();
        }

        // Intent open, not on editable (focus already lost)
        if (open) {
            commitPhysical(true, inset, `${reason}:open`);
        } else if (state.focusLikely || withinOpenHold()) {
            // Focus landed / just opened but IME height not yet reported — keep waiting.
            log('await-physical-open', { reason, inset });
        } else if (state.physicalOpen) {
            // Lost physical without focus/hold: treat as system dismiss only if
            // we have not seen a healthy inset recently.
            if (Date.now() - lastPhysicalAboveCloseAt < 480) {
                log('ignore-lost-physical-jitter', { reason, inset });
                return snapshot();
            }
            commitPhysical(false, 0, `${reason}:lost-physical`);
            setIntent(SoftKeyboardIntent.CLOSED, `${reason}:lost-physical`);
        }
        return snapshot();
    }

    function scheduleSync(reason = 'viewport', delays = [0, 48, 120, 240, 480]) {
        window.clearTimeout(settleTimer);
        delays.forEach((delay, index) => {
            window.setTimeout(() => {
                if (index === delays.length - 1) syncFromViewport(`${reason}:settle`);
                else syncFromViewport(`${reason}:t${delay}`);
            }, delay);
        });
    }

    /**
     * Open keyboard. Must be called from a user gesture for iOS/WebKit reliability.
     * @param {string} reason
     * @param {{ gesture?: boolean, liftMode?: 'workspace'|'none' }} [opts]
     */
    function open(reason = 'open', { gesture = true, liftMode } = {}) {
        if (!host.isTouchDevice?.()) return false;
        if (host.isSelectionMode?.()) {
            log('open-blocked-selection', { reason });
            return false;
        }
        if (host.isGestureSuppressed?.() && gesture) {
            log('open-blocked-suppressed', { reason });
            return false;
        }
        if (liftMode === SoftKeyboardLiftMode.NONE || liftMode === SoftKeyboardLiftMode.WORKSPACE) {
            state.liftMode = liftMode;
        } else if (reason.includes('cmd')) {
            state.liftMode = SoftKeyboardLiftMode.NONE;
        } else {
            state.liftMode = SoftKeyboardLiftMode.WORKSPACE;
        }
        const layoutFrozen = state.liftMode === SoftKeyboardLiftMode.NONE;
        setIntent(SoftKeyboardIntent.OPEN, reason);
        state.focusLikely = true;
        state.lastGestureAt = Date.now();
        if (gesture) lastOpenGestureAt = Date.now();
        openHoldUntil = Date.now() + OPEN_HOLD_MS;
        suppressRefocusUntil = 0;
        // Command bar owns the real focus — do NOT steal it with the IME proxy.
        let focused = true;
        if (!layoutFrozen) {
            focused = focusProxy(reason);
        } else {
            // Ensure proxy is not holding focus over the command textarea.
            try {
                const proxy = host.ensureProxy?.();
                if (proxy && getActiveElement() === proxy) proxy.blur?.();
            } catch (_) {}
        }
        // Immediate optimistic UI so aux bar / button react before viewport settles.
        if (!state.physicalOpen) {
            emit();
            try {
                // Always report layout-closed for cmd; parent must not clip/lift.
                host.notifyParent?.(parentPayload(false, 0, `${reason}:intent-open`));
            } catch (_) {}
        }
        if (!layoutFrozen) scheduleSync(reason);
        else scheduleSync(reason, [0, 120, 320]);
        log('open', { reason, focused, liftMode: state.liftMode, layoutFrozen });
        return focused;
    }

    function close(reason = 'close', { force = false, blurCmd = true } = {}) {
        const wasCmd = state.liftMode === SoftKeyboardLiftMode.NONE;
        setIntent(SoftKeyboardIntent.CLOSED, reason);
        state.focusLikely = false;
        openHoldUntil = 0;
        suppressRefocusUntil = Date.now() + REFOCUS_GUARD_MS;
        window.clearTimeout(refocusTimer);
        blurProxy(reason);
        // Blur cmd only when explicitly closing the command bar (or force).
        // Terminal IME close must not yank focus from an unrelated field.
        if (blurCmd && (force || wasCmd || reason.includes('cmd'))) {
            try {
                const active = getActiveElement();
                const tag = active?.tagName?.toLowerCase?.();
                if (tag === 'textarea' || tag === 'input') active.blur?.();
            } catch (_) {}
        }
        state.liftMode = SoftKeyboardLiftMode.WORKSPACE;
        commitPhysical(false, 0, reason);
        scheduleSync(reason, force ? [0, 80, 200, 480] : [0, 120, 320, 680]);
        log('close', { reason, force, wasCmd });
        return true;
    }

    function toggle(reason = 'toggle') {
        if (state.intent === SoftKeyboardIntent.OPEN || state.physicalOpen) {
            return close(`${reason}:to-closed`, { force: true });
        }
        return open(`${reason}:to-open`, { gesture: true, liftMode: SoftKeyboardLiftMode.WORKSPACE });
    }

    /**
     * Terminal body single-tap policy:
     * - closed → open (workspace lift)
     * - open → keep open / re-focus (do NOT dismiss)
     */
    function handleTerminalTap(reason = 'terminal-tap') {
        if (!host.isTouchDevice?.()) return false;
        if (host.isSelectionMode?.() || host.isGestureSuppressed?.()) return false;
        state.lastGestureAt = Date.now();
        if (state.intent === SoftKeyboardIntent.OPEN || state.physicalOpen) {
            // Re-assert focus without layout thrash; keep terminal lift mode.
            state.liftMode = SoftKeyboardLiftMode.WORKSPACE;
            setIntent(SoftKeyboardIntent.OPEN, `${reason}:retain`);
            openHoldUntil = Date.now() + OPEN_HOLD_MS;
            focusProxy(`${reason}:retain`);
            scheduleSync(`${reason}:retain`, [0, 80, 200]);
            return true;
        }
        return open(reason, { gesture: true, liftMode: SoftKeyboardLiftMode.WORKSPACE });
    }

    /**
     * Aux key / chrome pressed: never steal focus from IME proxy.
     */
    function retainForChrome(reason = 'chrome') {
        if (state.intent !== SoftKeyboardIntent.OPEN && !state.physicalOpen) return false;
        setIntent(SoftKeyboardIntent.OPEN, `${reason}:retain`);
        state.focusLikely = true;
        lastOpenGestureAt = Date.now();
        openHoldUntil = Date.now() + OPEN_HOLD_MS;
        focusProxy(`${reason}:retain`);
        return true;
    }

    function onProxyFocus(reason = 'proxy-focus') {
        // Focus alone does not flip intent to open unless we already desired open
        // or this focus was requested by open()/handleTerminalTap.
        if (state.intent === SoftKeyboardIntent.OPEN || Date.now() - lastOpenGestureAt < GESTURE_FOCUS_MS) {
            state.focusLikely = true;
            openHoldUntil = Math.max(openHoldUntil, Date.now() + 600);
            setIntent(SoftKeyboardIntent.OPEN, reason);
            scheduleSync(reason);
        }
    }

    function onProxyBlur(reason = 'proxy-blur') {
        state.focusLikely = false;
        if (Date.now() < suppressRefocusUntil) {
            scheduleSync(`${reason}:suppressed`);
            return;
        }
        // If intent is still open, a chrome button / layout thrash may have stolen
        // focus for one frame. Always try to recover before accepting dismiss.
        if (state.intent === SoftKeyboardIntent.OPEN) {
            window.clearTimeout(refocusTimer);
            refocusTimer = window.setTimeout(() => {
                if (state.intent !== SoftKeyboardIntent.OPEN) return;
                if (Date.now() < suppressRefocusUntil) return;
                const { open } = measurePhysical();
                const active = getActiveElement();
                if (isEditableElement(active)) {
                    state.focusLikely = true;
                    return;
                }
                // Prefer recover while we still want open — parent layout must not kill IME.
                if (open || withinOpenHold() || state.physicalOpen) {
                    focusProxy(`${reason}:recover`);
                    return;
                }
                // Only now accept system dismiss: no focus, no physical, past hold.
                setIntent(SoftKeyboardIntent.CLOSED, `${reason}:system`);
                commitPhysical(false, 0, `${reason}:system`);
            }, 220);
        } else {
            scheduleSync(reason);
        }
    }

    function desiredOpen() {
        return state.intent === SoftKeyboardIntent.OPEN;
    }

    function physicalOpen() {
        return state.physicalOpen;
    }

    function isActive() {
        return desiredOpen() || physicalOpen() || state.focusLikely;
    }

    function getLiftMode() {
        return state.liftMode;
    }

    function reset(reason = 'reset') {
        return close(reason, { force: true });
    }

    function getState() {
        return snapshot();
    }

    return {
        open,
        close,
        toggle,
        handleTerminalTap,
        retainForChrome,
        onProxyFocus,
        onProxyBlur,
        syncFromViewport,
        scheduleSync,
        desiredOpen,
        physicalOpen,
        isActive,
        getLiftMode,
        reset,
        getState,
        // Expose thresholds for contract tests / diagnostics
        thresholds: {
            openInset: OPEN_INSET_THRESHOLD,
            closeInset: CLOSE_INSET_THRESHOLD,
            gestureFocusMs: GESTURE_FOCUS_MS,
            openHoldMs: OPEN_HOLD_MS,
        },
    };
}

export default createSshMobileSoftKeyboard;
