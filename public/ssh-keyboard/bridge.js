/**
 * ParentBridge — single postMessage channel for SSH keyboard metrics.
 *
 * Child → parent:  { source:'zephyr-terminal', type:'ssh-kb', phase, intent, inset, tabId, liftMode }
 * Parent → child:  { source:'zephyr-app', type:'ssh-kb-reset' | 'ssh-kb-freeze', ... }
 *
 * Also emits legacy `keyboard-metrics` during migration so old app.js keeps working
 * until parent handler is switched.
 */

export const SSH_KB_MSG = 'ssh-kb';
export const SSH_KB_RESET = 'ssh-kb-reset';
export const SSH_KB_FREEZE = 'ssh-kb-freeze';

/**
 * @typedef {object} BridgeHost
 * @property {() => boolean} [isEmbedded]
 * @property {() => string} [getTabId]
 * @property {(message: object) => void} [postToParent]
 * @property {(label: string, details?: object) => void} [log]
 * @property {boolean} [emitLegacyMetrics=false]
 */

/**
 * @param {BridgeHost} [host]
 */
export function createParentBridge(host = {}) {
    let last = {
        phase: 'closed',
        intent: 'closed',
        inset: 0,
        liftMode: 'workspace',
        signature: '',
    };
    let freezeUntil = 0;

    function log(event, details = {}) {
        try { host.log?.(event, details); } catch (_) {}
    }

    function canPost() {
        if (host.isEmbedded && !host.isEmbedded()) return false;
        return true;
    }

    function post(message) {
        if (!canPost()) return false;
        try {
            if (typeof host.postToParent === 'function') {
                host.postToParent(message);
                return true;
            }
            const w = globalThis.window;
            if (w?.parent && w.parent !== w) {
                w.parent.postMessage(message, '*');
                return true;
            }
        } catch (_) {}
        return false;
    }

    /**
     * Publish layout/intent snapshot. Dedupes on phase+intent+rounded inset+liftMode.
     * @param {{ phase: string, intent: string, inset: number, liftMode?: string, physical?: string, reason?: string }} state
     */
    function publish(state = {}) {
        if (Date.now() < freezeUntil) {
            log('publish-frozen', { state });
            return false;
        }
        const phase = String(state.phase || 'closed');
        const intent = String(state.intent || 'closed');
        const inset = Math.max(0, Math.round(Number(state.inset) || 0));
        const liftMode = state.liftMode === 'none' ? 'none' : 'workspace';
        const rounded = Math.round(inset / 4) * 4;
        const signature = `${phase}|${intent}|${rounded}|${liftMode}`;
        if (signature === last.signature) return false;

        last = { phase, intent, inset, liftMode, signature };

        const tabId = host.getTabId?.() || '';
        const open = intent === 'open' && liftMode !== 'none' && (phase === 'open' || phase === 'opening' || inset > 0);

        const msg = {
            source: 'zephyr-terminal',
            type: SSH_KB_MSG,
            tabId,
            phase,
            intent,
            inset: liftMode === 'none' ? 0 : inset,
            liftMode,
            physical: state.physical || (inset >= 80 ? 'open' : 'closed'),
            reason: state.reason || '',
            keyboardOpen: open && liftMode !== 'none',
            keyboardInset: liftMode === 'none' ? 0 : inset,
        };
        post(msg);

        // Legacy path for old parent handlers during migration.
        if (host.emitLegacyMetrics === true) {
            let viewportHeight = 0;
            let layoutHeight = 0;
            let offsetTop = 0;
            try {
                viewportHeight = Math.round(globalThis.window?.visualViewport?.height || globalThis.window?.innerHeight || 0);
                layoutHeight = Math.round(globalThis.window?.innerHeight || globalThis.document?.documentElement?.clientHeight || 0);
                offsetTop = Math.round(globalThis.window?.visualViewport?.offsetTop || 0);
            } catch (_) {}
            post({
                source: 'zephyr-terminal',
                type: 'keyboard-metrics',
                tabId,
                keyboardOpen: liftMode === 'none' ? false : open,
                keyboardInset: liftMode === 'none' ? 0 : inset,
                viewportHeight,
                layoutHeight,
                offsetTop,
                stableInput: true,
                liftMode,
                source: liftMode === 'none' ? 'cmd' : 'terminal-ime',
                inputSource: liftMode === 'none' ? 'cmd' : 'terminal-ime',
                reason: state.reason || '',
            });
        }

        log('publish', msg);
        return true;
    }

    function freeze(ms = 900, reason = 'freeze') {
        freezeUntil = Date.now() + Math.max(0, Number(ms) || 0);
        log('freeze', { ms, reason, until: freezeUntil });
    }

    function unfreeze(reason = 'unfreeze') {
        freezeUntil = 0;
        log('unfreeze', { reason });
    }

    function isFrozen() {
        return Date.now() < freezeUntil;
    }

    /**
     * Handle parent → child control messages.
     * @returns {'reset'|'freeze'|null}
     */
    function handleParentMessage(data) {
        if (!data || data.source !== 'zephyr-app') return null;
        if (data.type === SSH_KB_RESET || data.type === 'reset-mobile-keyboard') {
            return 'reset';
        }
        if (data.type === SSH_KB_FREEZE || data.type === 'keyboard-freeze') {
            if (data.frozen) freeze(Number(data.settleMs) || 900, data.reason || 'parent-freeze');
            else unfreeze(data.reason || 'parent-unfreeze');
            return 'freeze';
        }
        return null;
    }

    function getLast() {
        return { ...last };
    }

    return {
        publish,
        freeze,
        unfreeze,
        isFrozen,
        handleParentMessage,
        getLast,
        SSH_KB_MSG,
        SSH_KB_RESET,
        SSH_KB_FREEZE,
    };
}

/**
 * Parent-side helper: reduce child ssh-kb / keyboard-metrics into workspace metrics.
 * Pure function — no DOM.
 */
export function reduceParentKeyboardMessage(data, prev = { open: false, inset: 0 }) {
    if (!data) return { ...prev, changed: false };
    if (data.type !== SSH_KB_MSG && data.type !== 'keyboard-metrics') {
        return { ...prev, changed: false };
    }
    if (data.liftMode === 'none' || data.source === 'cmd' || data.inputSource === 'cmd') {
        if (!prev.open && prev.inset === 0) return { open: false, inset: 0, changed: false, cmd: true };
        return { open: false, inset: 0, changed: true, cmd: true };
    }
    const inset = Math.max(0, Math.round(Number(data.keyboardInset ?? data.inset) || 0));
    const intentOpen = data.intent === 'open' || data.keyboardOpen === true || data.phase === 'open' || data.phase === 'opening';
    // Single hysteresis owned here for parent: open ≥80, stay until <12.
    let open = prev.open;
    if (!open && (intentOpen || inset >= 80)) open = true;
    if (open && inset < 12 && data.intent !== 'open' && data.phase !== 'opening') open = false;
    if (!intentOpen && inset < 12) open = false;
    const nextInset = open ? inset : 0;
    const changed = open !== prev.open || Math.abs(nextInset - prev.inset) >= 4;
    return { open, inset: nextInset, changed, cmd: false, phase: data.phase || '', intent: data.intent || '' };
}

export default createParentBridge;
