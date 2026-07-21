/**
 * KeyboardIntentStore — single source of truth for SSH soft-keyboard intent.
 *
 * Only three mutation entries:
 *   open(reason, opts)
 *   close(reason, opts)
 *   syncViewport({ inset, hasEditableFocus, now })
 *
 * Everything else is read-only snapshot.
 */

export const Intent = Object.freeze({
    OPEN: 'open',
    CLOSED: 'closed',
});

export const FocusOwner = Object.freeze({
    TERMINAL: 'terminal',
    CMD: 'cmd',
    NONE: null,
});

export const LiftMode = Object.freeze({
    WORKSPACE: 'workspace',
    NONE: 'none',
});

export const DEFAULT_INTENT_THRESHOLDS = Object.freeze({
    openInset: 80,
    closeInset: 12,
    /** After open gesture, ignore system-dismiss for this long (ms). */
    openGuardMs: 320,
    /** Require continuous low inset this long before accepting system dismiss. */
    dismissConfirmMs: 480,
});

/**
 * @typedef {object} IntentHost
 * @property {() => HTMLElement | null} ensureProxy
 * @property {(proxy: HTMLElement) => void} [onBeforeFocus]
 * @property {(label: string, details?: object) => void} [log]
 */

/**
 * @param {IntentHost} [host]
 * @param {Partial<typeof DEFAULT_INTENT_THRESHOLDS>} [thresholds]
 */
export function createKeyboardIntentStore(host = {}, thresholds = {}) {
    const t = { ...DEFAULT_INTENT_THRESHOLDS, ...thresholds };

    /** @type {{ intent: string, physical: string, focusOwner: string|null, inset: number, liftMode: string, lastReason: string, lastOpenAt: number, lastCloseAt: number, focusLikely: boolean }} */
    let state = {
        intent: Intent.CLOSED,
        physical: Intent.CLOSED,
        focusOwner: FocusOwner.NONE,
        inset: 0,
        liftMode: LiftMode.WORKSPACE,
        lastReason: 'init',
        lastOpenAt: 0,
        lastCloseAt: 0,
        focusLikely: false,
    };

    let lowSince = 0;
    let listeners = new Set();
    let suppressRefocusUntil = 0;

    function log(event, details = {}) {
        try { host.log?.(event, { ...details, state: snapshot() }); } catch (_) {}
    }

    function snapshot() {
        return { ...state };
    }

    function emit(reason) {
        const snap = snapshot();
        listeners.forEach((fn) => {
            try { fn(snap, reason); } catch (_) {}
        });
        return snap;
    }

    function subscribe(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
    }

    function getActiveElement() {
        try { return globalThis.document?.activeElement || null; } catch (_) { return null; }
    }

    function isEditable(el) {
        if (!el) return false;
        const tag = el.tagName;
        return tag === 'TEXTAREA' || tag === 'INPUT' || !!el.isContentEditable
            || !!el.classList?.contains?.('mobile-terminal-ime-proxy');
    }

    function focusProxy(reason) {
        const proxy = host.ensureProxy?.();
        if (!proxy) return false;
        try { host.onBeforeFocus?.(proxy); } catch (_) {}
        try {
            if (getActiveElement() !== proxy) proxy.focus({ preventScroll: true });
        } catch (_) {
            try { proxy.focus(); } catch (__) { return false; }
        }
        state.focusLikely = true;
        log('focus-proxy', { reason });
        return true;
    }

    function blurProxy(reason) {
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

    /**
     * @param {string} reason
     * @param {{ focusOwner?: string|null, liftMode?: string, gesture?: boolean, now?: number }} [opts]
     */
    function open(reason = 'open', opts = {}) {
        const now = Number.isFinite(opts.now) ? opts.now : Date.now();
        const focusOwner = opts.focusOwner === FocusOwner.CMD ? FocusOwner.CMD : FocusOwner.TERMINAL;
        const liftMode = opts.liftMode === LiftMode.NONE || focusOwner === FocusOwner.CMD
            ? LiftMode.NONE
            : LiftMode.WORKSPACE;

        state.intent = Intent.OPEN;
        state.focusOwner = focusOwner;
        state.liftMode = liftMode;
        state.lastReason = reason;
        state.lastOpenAt = now;
        state.focusLikely = true;
        lowSince = 0;
        suppressRefocusUntil = 0;

        // Cmd owns real focus — do not steal with proxy.
        if (focusOwner === FocusOwner.TERMINAL) {
            focusProxy(reason);
        } else {
            // Ensure proxy is not holding focus over cmd textarea.
            try {
                const proxy = host.ensureProxy?.();
                if (proxy && getActiveElement() === proxy) proxy.blur?.();
            } catch (_) {}
        }

        log('open', { reason, focusOwner, liftMode });
        return emit(reason);
    }

    /**
     * @param {string} reason
     * @param {{ force?: boolean, blurCmd?: boolean, now?: number }} [opts]
     */
    function close(reason = 'close', opts = {}) {
        const now = Number.isFinite(opts.now) ? opts.now : Date.now();
        const wasCmd = state.focusOwner === FocusOwner.CMD || state.liftMode === LiftMode.NONE;
        state.intent = Intent.CLOSED;
        state.focusOwner = FocusOwner.NONE;
        state.liftMode = LiftMode.WORKSPACE;
        state.lastReason = reason;
        state.lastCloseAt = now;
        state.focusLikely = false;
        state.physical = Intent.CLOSED;
        state.inset = 0;
        lowSince = 0;
        suppressRefocusUntil = now + 400;

        blurProxy(reason);
        if (opts.blurCmd !== false && (opts.force || wasCmd || /cmd|button|reset|finalize/i.test(reason))) {
            try {
                const active = getActiveElement();
                const tag = active?.tagName?.toLowerCase?.();
                if (tag === 'textarea' || tag === 'input') {
                    // Don't blur if it's the IME proxy (already blurred) — only cmd/other.
                    if (!active.classList?.contains?.('mobile-terminal-ime-proxy')) active.blur?.();
                }
            } catch (_) {}
        }

        log('close', { reason, force: !!opts.force });
        return emit(reason);
    }

    function toggle(reason = 'toggle', opts = {}) {
        if (state.intent === Intent.OPEN || state.physical === Intent.OPEN) {
            return close(`${reason}:to-closed`, { force: true, ...opts });
        }
        return open(`${reason}:to-open`, { focusOwner: FocusOwner.TERMINAL, liftMode: LiftMode.WORKSPACE, ...opts });
    }

    /**
     * Body tap policy: open or retain. Never dismiss.
     */
    function handleTerminalTap(reason = 'terminal-tap', opts = {}) {
        if (state.intent === Intent.OPEN || state.physical === Intent.OPEN) {
            state.focusOwner = FocusOwner.TERMINAL;
            state.liftMode = LiftMode.WORKSPACE;
            state.lastReason = `${reason}:retain`;
            state.lastOpenAt = Number.isFinite(opts.now) ? opts.now : Date.now();
            state.focusLikely = true;
            focusProxy(`${reason}:retain`);
            return emit(`${reason}:retain`);
        }
        return open(reason, { focusOwner: FocusOwner.TERMINAL, liftMode: LiftMode.WORKSPACE, ...opts });
    }

    function retainFocus(reason = 'retain') {
        if (state.intent !== Intent.OPEN && state.physical !== Intent.OPEN) return snapshot();
        if (state.focusOwner === FocusOwner.CMD) return snapshot();
        state.focusLikely = true;
        state.lastOpenAt = Date.now();
        focusProxy(reason);
        return emit(reason);
    }

    /**
     * Viewport sync. Only path that may auto-close (system dismiss).
     * Conditions (ALL required):
     *   1) intent === open
     *   2) physical was open, now inset low continuously >= dismissConfirmMs
     *   3) no editable focused
     *   4) past openGuardMs since last open gesture
     *
     * @param {{ inset: number, hasEditableFocus?: boolean, now?: number }} metrics
     */
    function syncViewport(metrics = {}) {
        const now = Number.isFinite(metrics.now) ? metrics.now : Date.now();
        const inset = Math.max(0, Math.round(Number(metrics.inset) || 0));
        const hasEditableFocus = metrics.hasEditableFocus !== undefined
            ? !!metrics.hasEditableFocus
            : isEditable(getActiveElement());

        const wasPhysicalOpen = state.physical === Intent.OPEN;
        let physicalOpen;
        if (wasPhysicalOpen) physicalOpen = inset > t.closeInset;
        else physicalOpen = inset >= t.openInset;

        if (physicalOpen) {
            lowSince = 0;
            state.physical = Intent.OPEN;
            state.inset = inset;
        } else {
            state.inset = 0;
            if (wasPhysicalOpen || state.intent === Intent.OPEN) {
                if (!lowSince) lowSince = now;
            }
        }

        // Intent closed: ignore residual physical noise.
        if (state.intent === Intent.CLOSED) {
            if (!physicalOpen) {
                state.physical = Intent.CLOSED;
                state.inset = 0;
            } else if (inset < t.openInset) {
                state.physical = Intent.CLOSED;
                state.inset = 0;
            } else if (!hasEditableFocus && now - state.lastCloseAt > t.openGuardMs) {
                // Physical open but intent closed and no focus — force blur path.
                blurProxy('intent-closed-but-physical');
                state.physical = Intent.CLOSED;
                state.inset = 0;
            }
            return emit('sync:closed');
        }

        // Intent open
        if (physicalOpen) {
            state.physical = Intent.OPEN;
            state.inset = inset;
            state.focusLikely = state.focusLikely || hasEditableFocus;
            return emit('sync:open');
        }

        // Physical low while intent open — maybe system dismiss.
        const lowFor = lowSince ? now - lowSince : 0;
        const sinceOpen = now - state.lastOpenAt;
        const inGuard = sinceOpen < t.openGuardMs;
        const confirmed = lowFor >= t.dismissConfirmMs && !inGuard && !hasEditableFocus;

        if (confirmed) {
            log('system-dismiss', { lowFor, sinceOpen, inset });
            return close('system-dismiss', { force: true, blurCmd: true, now });
        }

        // Keep waiting: physical not yet settled.
        state.physical = wasPhysicalOpen && lowFor < t.dismissConfirmMs ? Intent.OPEN : Intent.CLOSED;
        if (state.physical === Intent.OPEN) state.inset = Math.max(state.inset, inset);
        log('await-dismiss-confirm', { lowFor, sinceOpen, hasEditableFocus, inGuard });
        return emit('sync:await');
    }

    function onImeFocus(reason = 'ime-focus') {
        if (state.intent === Intent.OPEN || Date.now() - state.lastOpenAt < t.openGuardMs) {
            state.focusLikely = true;
            state.focusOwner = state.focusOwner || FocusOwner.TERMINAL;
            if (state.intent !== Intent.OPEN) {
                state.intent = Intent.OPEN;
                state.lastReason = reason;
            }
            return emit(reason);
        }
        // Unsolicited focus — do not flip intent open.
        state.focusLikely = true;
        return emit(`${reason}:unowned`);
    }

    function onImeBlur(reason = 'ime-blur') {
        state.focusLikely = false;
        if (Date.now() < suppressRefocusUntil) return emit(`${reason}:suppressed`);
        // Do not close on blur alone. system-dismiss only via syncViewport.
        return emit(reason);
    }

    function desiredOpen() {
        return state.intent === Intent.OPEN;
    }

    function physicalOpen() {
        return state.physical === Intent.OPEN;
    }

    function isActive() {
        return desiredOpen() || physicalOpen() || state.focusLikely;
    }

    function getLiftMode() {
        return state.liftMode;
    }

    function getFocusOwner() {
        return state.focusOwner;
    }

    function getInset() {
        return state.inset;
    }

    function getState() {
        return snapshot();
    }

    function reset(reason = 'reset') {
        return close(reason, { force: true });
    }

    return {
        open,
        close,
        toggle,
        handleTerminalTap,
        retainFocus,
        syncViewport,
        onImeFocus,
        onImeBlur,
        desiredOpen,
        physicalOpen,
        isActive,
        getLiftMode,
        getFocusOwner,
        getInset,
        getState,
        subscribe,
        reset,
        thresholds: t,
        Intent,
        FocusOwner,
        LiftMode,
    };
}

export default createKeyboardIntentStore;
