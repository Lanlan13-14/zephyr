/**
 * KeyboardLayoutGate — hard isolation between keyboard phases and WTerm resize/scroll.
 *
 * Phases: closed → opening → open → closing → closed
 * During opening/open/closing:
 *   - allowResize() === false
 *   - allowNonPinScroll() === false
 *   - only DOM writes: --ssh-kb-inset + html.ssh-kb-open (+ legacy mirrors)
 */

export const LayoutPhase = Object.freeze({
    CLOSED: 'closed',
    OPENING: 'opening',
    OPEN: 'open',
    CLOSING: 'closing',
});

export const SSH_KB_INSET_VAR = '--ssh-kb-inset';
export const SSH_KB_OPEN_CLASS = 'ssh-kb-open';

/** Legacy mirrors so existing CSS keeps working until Step 7 full CSS purge. */
const LEGACY_INSET_VARS = ['--keyboard-inset', '--ime-chrome-bottom'];
const LEGACY_OPEN_CLASSES = ['keyboard-open', 'mobile-keyboard-open'];

/**
 * @typedef {object} LayoutHost
 * @property {() => Document | null} [getDocument]
 * @property {(phase: string, inset: number, meta?: object) => void} [onPhaseChange]
 * @property {(label: string, details?: object) => void} [log]
 * @property {boolean} [mirrorLegacy=true]  also write old CSS vars/classes during migration
 */

/**
 * @param {LayoutHost} [host]
 */
export function createKeyboardLayoutGate(host = {}) {
    let phase = LayoutPhase.CLOSED;
    let inset = 0;
    let liftMode = 'workspace'; // workspace | none
    let queuedResizes = [];
    let listeners = new Set();

    function doc() {
        try { return host.getDocument?.() || globalThis.document || null; } catch (_) { return null; }
    }

    function log(event, details = {}) {
        try { host.log?.(event, { ...details, phase, inset, liftMode }); } catch (_) {}
    }

    function snapshot() {
        return {
            phase,
            inset,
            liftMode,
            resizeBlocked: phase !== LayoutPhase.CLOSED,
            scrollBlocked: phase !== LayoutPhase.CLOSED,
            queuedResizeCount: queuedResizes.length,
        };
    }

    function emit(reason) {
        const snap = snapshot();
        listeners.forEach((fn) => {
            try { fn(snap, reason); } catch (_) {}
        });
        try { host.onPhaseChange?.(phase, inset, { liftMode, reason }); } catch (_) {}
        return snap;
    }

    function subscribe(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
    }

    function writeDom(nextInset, open) {
        // kb-flow2: terminal.js applyMobileStableKeyboardInset is the SOLE writer
        // of --ssh-kb-inset / .ssh-kb-open. Layout gate only tracks phase state.
        // Writing DOM here raced parent-overlap (intent closed tick wiped 336px
        // inset → black flash + gray void on real phones).
        if (host.mirrorLegacy === false || host.writeDom === false) {
            return;
        }
        const d = doc();
        if (!d?.documentElement) return;
        const root = d.documentElement;
        const value = `${Math.max(0, Math.round(nextInset || 0))}px`;
        try {
            root.style.setProperty(SSH_KB_INSET_VAR, value);
            root.classList.toggle(SSH_KB_OPEN_CLASS, !!open);
        } catch (_) {}

        try {
            LEGACY_INSET_VARS.forEach((name) => {
                // ime-chrome-bottom is chrome height, not full keyboard — only zero on close.
                if (name === '--ime-chrome-bottom' && open) return;
                root.style.setProperty(name, open ? value : '0px');
            });
            if (!open) root.style.setProperty('--ime-chrome-bottom', '0px');
            LEGACY_OPEN_CLASSES.forEach((cls) => {
                if (cls === 'mobile-keyboard-open') {
                    d.getElementById?.('terminalContainer')?.classList.toggle(cls, !!open);
                } else {
                    root.classList.toggle(cls, !!open);
                }
            });
        } catch (_) {}
    }

    function flushQueuedResizes(reason = 'phase-closed') {
        if (!queuedResizes.length) return;
        const jobs = queuedResizes.slice();
        queuedResizes = [];
        log('flush-queued-resizes', { count: jobs.length, reason });
        jobs.forEach((job) => {
            try { job.fn?.(reason); } catch (_) {}
        });
    }

    /**
     * Apply intent snapshot from IntentStore.
     * @param {{ intent: string, physical: string, inset: number, liftMode?: string }} state
     * @param {string} [reason]
     */
    function applyIntentState(state, reason = 'intent') {
        const desiredOpen = state.intent === 'open';
        const physicalOpen = state.physical === 'open';
        const nextLift = state.liftMode === 'none' ? 'none' : 'workspace';
        liftMode = nextLift;

        // cmd bar (lift none): never apply workspace inset / open phase for layout.
        if (nextLift === 'none') {
            const prev = phase;
            phase = LayoutPhase.CLOSED;
            inset = 0;
            writeDom(0, false);
            if (prev !== LayoutPhase.CLOSED) flushQueuedResizes(`${reason}:cmd-freeze`);
            log('apply-cmd-freeze', { reason });
            return emit(`${reason}:cmd`);
        }

        // F2-fix: desiredOpen alone enters OPENING phase (writeDom class on).
        // Physical/inset arrive later via syncViewport / parent-overlap.
        const layoutOpen = desiredOpen;
        const nextInset = layoutOpen ? Math.max(0, Math.round(Number(state.inset) || 0)) : 0;

        if (desiredOpen && !physicalOpen && phase === LayoutPhase.CLOSED) {
            phase = LayoutPhase.OPENING;
            inset = nextInset;
            writeDom(inset, true);
            log('phase-opening', { reason });
            return emit(`${reason}:opening`);
        }

        if (desiredOpen && physicalOpen) {
            const was = phase;
            phase = LayoutPhase.OPEN;
            inset = nextInset || inset;
            writeDom(inset, true);
            log('phase-open', { reason, was, inset });
            return emit(`${reason}:open`);
        }

        if (!desiredOpen && phase !== LayoutPhase.CLOSED) {
            if (phase === LayoutPhase.OPEN || phase === LayoutPhase.OPENING) {
                phase = LayoutPhase.CLOSING;
                inset = 0;
                writeDom(0, false);
                log('phase-closing', { reason });
                // Closing is brief — immediately settle closed so queued resizes can run.
                phase = LayoutPhase.CLOSED;
                flushQueuedResizes(`${reason}:closed`);
                return emit(`${reason}:closed`);
            }
        }

        if (!desiredOpen && phase === LayoutPhase.CLOSED) {
            inset = 0;
            writeDom(0, false);
            return emit(`${reason}:stay-closed`);
        }

        // Opening still waiting for physical height.
        if (phase === LayoutPhase.OPENING) {
            inset = nextInset;
            writeDom(Math.max(inset, 0), true);
            return emit(`${reason}:opening-hold`);
        }

        return emit(reason);
    }

    function allowResize(reason = '') {
        const ok = phase === LayoutPhase.CLOSED;
        if (!ok) log('resize-blocked', { reason, phase });
        return ok;
    }

    function allowNonPinScroll(reason = '') {
        const ok = phase === LayoutPhase.CLOSED;
        if (!ok) log('scroll-blocked', { reason, phase });
        return ok;
    }

    /**
     * Queue a resize callback until phase returns to closed.
     * If already closed, runs immediately.
     */
    function runOrQueueResize(fn, reason = 'resize') {
        if (typeof fn !== 'function') return false;
        if (allowResize(reason)) {
            try { fn('immediate'); } catch (_) {}
            return true;
        }
        queuedResizes.push({ fn, reason, at: Date.now() });
        log('resize-queued', { reason, queue: queuedResizes.length });
        return false;
    }

    function forceClosed(reason = 'force-closed') {
        phase = LayoutPhase.CLOSED;
        inset = 0;
        liftMode = 'workspace';
        writeDom(0, false);
        flushQueuedResizes(reason);
        return emit(reason);
    }

    function getPhase() {
        return phase;
    }

    function getInset() {
        return inset;
    }

    function getState() {
        return snapshot();
    }

    return {
        applyIntentState,
        allowResize,
        allowNonPinScroll,
        runOrQueueResize,
        forceClosed,
        getPhase,
        getInset,
        getState,
        subscribe,
        writeDom,
        LayoutPhase,
        SSH_KB_INSET_VAR,
        SSH_KB_OPEN_CLASS,
    };
}

export default createKeyboardLayoutGate;
