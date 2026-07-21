/**
 * SshKeyboard facade — single entry for terminal.js / surface.
 *
 * Wires: gesture → intent → layout → bridge
 */

import { createGestureClassifier, GestureKind } from './gesture.js';
import { createKeyboardIntentStore, FocusOwner, Intent, LiftMode } from './intent.js';
import { createKeyboardLayoutGate, LayoutPhase } from './layout.js';
import { createParentBridge, SSH_KB_MSG } from './bridge.js';

/**
 * @typedef {object} SshKeyboardHost
 * @property {() => boolean} isTouchDevice
 * @property {() => boolean} [isMobileStable]
 * @property {() => HTMLTextAreaElement | null} ensureProxy
 * @property {() => { keyboardInset: number }} getViewportMetrics
 * @property {() => boolean} [hasSelection]
 * @property {() => boolean} [isSelectionMode]
 * @property {() => string} [getTabId]
 * @property {() => boolean} [isEmbedded]
 * @property {(message: object) => void} [postToParent]
 * @property {(state: object, reason: string) => void} [onStateChange]
 * @property {(phase: string, inset: number, meta?: object) => void} [onLayout]
 * @property {(open: boolean, reason: string) => void} [onImeActive]
 * @property {(label: string, details?: object) => void} [log]
 * @property {() => Document | null} [getDocument]
 */

/**
 * @param {SshKeyboardHost} host
 */
export function createSshKeyboard(host) {
    const log = (event, details = {}) => {
        try { host.log?.(`ssh-kb:${event}`, details); } catch (_) {}
    };

    const gesture = createGestureClassifier();
    const intent = createKeyboardIntentStore({
        ensureProxy: () => host.ensureProxy?.() || null,
        log: (e, d) => log(`intent:${e}`, d),
    });
    const layout = createKeyboardLayoutGate({
        getDocument: () => host.getDocument?.() || globalThis.document || null,
        // terminal.js applyMobileStableKeyboardInset is the sole chrome CSS writer.
        mirrorLegacy: false,
        onPhaseChange: (phase, inset, meta) => {
            try { host.onLayout?.(phase, inset, meta); } catch (_) {}
        },
        log: (e, d) => log(`layout:${e}`, d),
    });
    const bridge = createParentBridge({
        isEmbedded: () => (host.isEmbedded ? !!host.isEmbedded() : true),
        getTabId: () => host.getTabId?.() || '',
        postToParent: host.postToParent,
        emitLegacyMetrics: false,
        log: (e, d) => log(`bridge:${e}`, d),
    });

    let composing = false;
    let lastPublishReason = '';

    function publish(reason = '') {
        const i = intent.getState();
        const l = layout.getState();
        lastPublishReason = reason || lastPublishReason;
        bridge.publish({
            phase: l.phase,
            intent: i.intent,
            inset: l.inset || i.inset,
            liftMode: i.liftMode,
            physical: i.physical,
            reason: lastPublishReason,
        });
        try {
            host.onStateChange?.({
                ...i,
                phase: l.phase,
                layoutInset: l.inset,
                composing,
                gesture: gesture.snapshot(),
            }, reason);
        } catch (_) {}
        try {
            host.onImeActive?.(i.intent === Intent.OPEN && i.focusOwner === FocusOwner.TERMINAL, reason);
        } catch (_) {}
    }

    // Intent → layout → bridge pipeline
    intent.subscribe((state, reason) => {
        layout.applyIntentState(state, reason);
        publish(reason);
    });

    function blockedBySelection() {
        return !!(host.isSelectionMode?.() || host.hasSelection?.());
    }

    function pointFromEvent(e) {
        const x = e.clientX ?? e.changedTouches?.[0]?.clientX ?? e.touches?.[0]?.clientX ?? 0;
        const y = e.clientY ?? e.changedTouches?.[0]?.clientY ?? e.touches?.[0]?.clientY ?? 0;
        const pointerCount = e.touches?.length
            || (e.pointerType ? 1 : 0)
            || 1;
        return {
            x,
            y,
            time: typeof performance !== 'undefined' ? performance.now() : Date.now(),
            pointerCount: e.touches?.length || pointerCount,
        };
    }

    function handlePointerDown(e) {
        if (!host.isTouchDevice?.()) return null;
        return gesture.pointerDown(pointFromEvent(e));
    }

    function handlePointerMove(e) {
        if (!host.isTouchDevice?.()) return null;
        return gesture.pointerMove(pointFromEvent(e));
    }

    /**
     * Finalize gesture. Opens keyboard only on clean tap.
     * @returns {{ kind: string, opened: boolean }}
     */
    function handlePointerUp(e) {
        if (!host.isTouchDevice?.()) return { kind: GestureKind.IDLE, opened: false };
        const result = gesture.pointerUp(pointFromEvent(e));
        if (result.kind === GestureKind.TAP && !result.suppressOpen && !blockedBySelection()) {
            // Pass provisional inset so page shrinks immediately on overlays devices.
            const snap = intent.getState?.() || {};
            if (snap.intent === 'open' || snap.physical === 'open') {
                intent.handleTerminalTap('terminal-tap');
            } else {
                intent.open('terminal-tap', {
                    focusOwner: FocusOwner.TERMINAL,
                    liftMode: LiftMode.WORKSPACE,
                    inset: provisionalInset(),
                });
            }
            return { kind: result.kind, opened: true, result };
        }
        // pan/fling/pinch/longpress: never open
        if (result.kind === GestureKind.LONGPRESS) {
            // selection path owned by caller; we just refuse open
        }
        return { kind: result.kind, opened: false, result };
    }

    function handlePointerCancel(e) {
        return gesture.pointerCancel(pointFromEvent(e || {}));
    }

    function provisionalInset() {
        try {
            const m = host.getViewportMetrics?.() || {};
            const live = Math.max(0, Math.round(Number(m.keyboardInset) || 0));
            if (live >= 80) return live;
            // overlays-content: estimate ~33% of baseline, clamp 230–380.
            const baseline = Math.max(
                Number(m.layoutHeight) || 0,
                Number(globalThis.innerHeight) || 0,
                640,
            );
            return Math.round(Math.min(380, Math.max(230, baseline * 0.33)));
        } catch (_) {
            return 280;
        }
    }

    /** Explicit open from button or other UI (must be in user gesture stack). */
    function buttonClick(reason = 'keyboard-button') {
        if (!host.isTouchDevice?.()) return intent.getState();
        // toggle open needs provisional inset too
        if (intent.desiredOpen?.()) return intent.close(`${reason}:to-closed`, { force: true });
        return intent.open(`${reason}:to-open`, {
            focusOwner: FocusOwner.TERMINAL,
            liftMode: LiftMode.WORKSPACE,
            inset: provisionalInset(),
        });
    }

    function openTerminal(reason = 'open-terminal') {
        if (blockedBySelection()) return false;
        return intent.open(reason, {
            focusOwner: FocusOwner.TERMINAL,
            liftMode: LiftMode.WORKSPACE,
            inset: provisionalInset(),
        });
    }

    function openCmd(reason = 'open-cmd') {
        return intent.open(reason, { focusOwner: FocusOwner.CMD, liftMode: LiftMode.NONE });
    }

    function close(reason = 'close', opts = {}) {
        return intent.close(reason, opts);
    }

    function retainFocus(reason = 'retain') {
        return intent.retainFocus(reason);
    }

    function handleViewportChange(reason = 'viewport') {
        if (!host.isTouchDevice?.()) return intent.getState();
        if (bridge.isFrozen()) {
            log('viewport-frozen', { reason });
            return intent.getState();
        }
        const metrics = host.getViewportMetrics?.() || { keyboardInset: 0 };
        const inset = Math.max(0, Math.round(Number(metrics.keyboardInset) || 0));
        let hasEditableFocus = false;
        try {
            const el = globalThis.document?.activeElement;
            const tag = el?.tagName;
            hasEditableFocus = !!(el && (tag === 'TEXTAREA' || tag === 'INPUT' || el.isContentEditable
                || el.classList?.contains?.('mobile-terminal-ime-proxy')));
        } catch (_) {}
        return intent.syncViewport({ inset, hasEditableFocus });
    }

    function handleImeFocus(reason = 'ime-focus') {
        return intent.onImeFocus(reason);
    }

    function handleImeBlur(reason = 'ime-blur') {
        return intent.onImeBlur(reason);
    }

    function handleCompositionStart() {
        composing = true;
        publish('composition-start');
        return composing;
    }

    function handleCompositionEnd() {
        composing = false;
        publish('composition-end');
        return composing;
    }

    function handleParentMessage(data) {
        const action = bridge.handleParentMessage(data);
        if (action === 'reset') {
            intent.reset(`parent:${data?.reason || 'reset'}`);
            layout.forceClosed(`parent:${data?.reason || 'reset'}`);
            publish('parent-reset');
        }
        return action;
    }

    function allowResize(reason = '') {
        return layout.allowResize(reason);
    }

    function allowNonPinScroll(reason = '') {
        return layout.allowNonPinScroll(reason);
    }

    function runOrQueueResize(fn, reason = 'resize') {
        return layout.runOrQueueResize(fn, reason);
    }

    function getState() {
        return {
            intent: intent.getState(),
            layout: layout.getState(),
            gesture: gesture.snapshot(),
            composing,
            bridge: bridge.getLast(),
        };
    }

    function desiredOpen() {
        return intent.desiredOpen();
    }

    function physicalOpen() {
        return intent.physicalOpen();
    }

    function isActive() {
        return intent.isActive();
    }

    function getLiftMode() {
        return intent.getLiftMode();
    }

    function getPhase() {
        return layout.getPhase();
    }

    function getInset() {
        return layout.getInset() || intent.getInset();
    }

    // Compatibility shim matching old ssh-mobile-keyboard surface used by terminal-surface-controller
    const softKeyboardCompat = {
        open: (reason, opts = {}) => {
            if (host.isSelectionMode?.() || host.hasSelection?.()) return false;
            if (host.isGestureSuppressed?.() && opts.gesture !== false) return false;
            if (opts.liftMode === LiftMode.NONE || opts.liftMode === 'none') return openCmd(reason);
            const r = openTerminal(reason);
            return r === false ? false : true;
        },
        close: (reason, opts) => close(reason, opts),
        toggle: (reason) => buttonClick(reason),
        handleTerminalTap: (reason) => {
            if (host.isSelectionMode?.() || host.hasSelection?.() || host.isGestureSuppressed?.()) return false;
            const r = intent.handleTerminalTap(reason);
            return r === false ? false : true;
        },
        retainForChrome: (reason) => retainFocus(reason),
        onProxyFocus: (reason) => handleImeFocus(reason),
        onProxyBlur: (reason) => handleImeBlur(reason),
        syncFromViewport: (reason) => handleViewportChange(reason),
        scheduleSync: (reason) => handleViewportChange(reason),
        desiredOpen: () => desiredOpen(),
        physicalOpen: () => physicalOpen(),
        isActive: () => isActive(),
        getLiftMode: () => getLiftMode(),
        reset: (reason) => close(reason, { force: true }),
        getState: () => intent.getState(),
        thresholds: intent.thresholds,
    };

    return {
        // event API
        handlePointerDown,
        handlePointerMove,
        handlePointerUp,
        handlePointerCancel,
        handleViewportChange,
        handleImeFocus,
        handleImeBlur,
        handleCompositionStart,
        handleCompositionEnd,
        handleParentMessage,
        // commands
        buttonClick,
        openTerminal,
        openCmd,
        close,
        retainFocus,
        // gates
        allowResize,
        allowNonPinScroll,
        runOrQueueResize,
        // reads
        getState,
        desiredOpen,
        physicalOpen,
        isActive,
        getLiftMode,
        getPhase,
        getInset,
        isComposing: () => composing,
        // compat for existing surface controller
        asSoftKeyboard: () => softKeyboardCompat,
        // internals for tests
        _gesture: gesture,
        _intent: intent,
        _layout: layout,
        _bridge: bridge,
        GestureKind,
        Intent,
        FocusOwner,
        LiftMode,
        LayoutPhase,
        SSH_KB_MSG,
    };
}

export {
    createGestureClassifier,
    createKeyboardIntentStore,
    createKeyboardLayoutGate,
    createParentBridge,
    GestureKind,
    Intent,
    FocusOwner,
    LiftMode,
    LayoutPhase,
    SSH_KB_MSG,
};

export default createSshKeyboard;
