import { applyZephyrColorScheme } from './theme-runtime.js?v=20260615-visual-color-picker';
import { t, initI18n } from './i18n/runtime.js?v=20260726-telnet-routes1';
window.__zephyrT = t;
import {
    createSshKeyboard,
    Intent as SoftKeyboardIntent,
    LiftMode as SoftKeyboardLiftMode,
} from './ssh-keyboard/index.js?v=20260723-sync2';
import { createTerminalRemoteHistory } from './terminal-remote-history.js?v=20260720-wterm-main1';
import {
    DEFAULT_TERMINAL_SCROLL_SETTINGS,
    allowScrollDuringTyping,
    computeCursorAboveChromeScrollTop,
    scrollSettlePhases,
    scrollTerminalToBottomAfterInputIfEnabled,
    scrollTerminalToBottomAfterOutputIfEnabled,
    scrollTerminalToBottomAfterPasteIfEnabled,
    scrollTerminalToBottomIfNeeded,
    shouldScrollForInputReason,
    shouldScrollOnTerminalOutput,
} from './terminal-scroll-policy.js?v=20260721-kb-reopen1';
import { createTerminalSurfaceController } from './terminal-surface-controller.js?v=20260721-kb-reopen1';

/** @type {ReturnType<typeof createTerminalSurfaceController> | null} */
let terminalSurface = null;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Netcatty-aligned settings (output follow OFF by default). */
function getTerminalScrollPolicySettings() {
    return {
        ...DEFAULT_TERMINAL_SCROLL_SETTINGS,
        // User reading history locks output follow regardless of setting.
        scrollOnOutput: false,
    };
}

/** Adapter so policy can call WTerm public scroll API without touching DOM scrollTop. */
function getWTermScrollTarget() {
    if (!term) return null;
    return {
        isAtBottom: () => {
            try {
                if (typeof term.isAtBottom === 'function') return !!term.isAtBottom();
                if (term.viewport && typeof term.viewport.atBottom === 'boolean') return !!term.viewport.atBottom;
                if (typeof term.getViewportState === 'function') return !!term.getViewportState()?.atBottom;
            } catch (_) {}
            return isTerminalAtBottom?.() ?? true;
        },
        scrollToBottom: () => {
            // Mobile: product geometry wins over WTerm maxScroll stick (fig.3).
            if (isMobileStableInputMode()) {
                applyCursorAboveChromeScroll('policy-scroll-to-bottom', { force: true });
                return;
            }
            try {
                if (typeof term.scrollToBottom === 'function') {
                    term.scrollToBottom();
                    return;
                }
                if (term.viewport && typeof term.viewport.scrollToBottom === 'function') {
                    term.viewport.scrollToBottom();
                    return;
                }
            } catch (_) {}
            followTerminalBottomNow('policy-scroll-to-bottom', { force: true });
        },
        getViewportState: () => {
            try {
                if (typeof term.getViewportState === 'function') return term.getViewportState();
                if (term.viewport && typeof term.viewport.state === 'function') return term.viewport.state();
            } catch (_) {}
            return null;
        },
    };
}

function setWTermImeActive(active, reason = 'ime') {
    const el = term?.element || wtermWrapper?.querySelector?.('.wterm') || wtermWrapper;
    if (!el?.classList) return;
    el.classList.toggle('ime-active', !!active);
    // Keep a solid cursor even if WTerm's hidden textarea is not focused.
    if (active) el.classList.add('cursor-blink');
    logTerminalLayoutDiagnostics?.('wterm-ime-active', { active: !!active, reason });
}

/**
 * One-shot policy scroll after real user input. No multi-phase chase.
 * @returns {boolean} whether scroll API ran
 */
function applyPolicyScrollAfterUserInput(data, reason = 'input') {
    if (mobileImeComposing) return false;
    if (!shouldScrollForInputReason(reason, { composing: mobileImeComposing })) return false;
    if (isMobileTerminalAutoFollowLocked() && !isMobileStableActualInputReason(reason)) return false;
    if (hasLiveTerminalSelection?.() || mobileTerminalSelectionMode) return false;
    clearMobileTerminalHistoryLock?.(`${reason}:policy-input`);
    setTerminalAutoFollow?.(true, `${reason}:policy-input`);
    const did = scrollTerminalToBottomAfterInputIfEnabled(
        getWTermScrollTarget(),
        getTerminalScrollPolicySettings(),
        data,
    );
    scheduleTerminalScrollbarUpdate?.();
    return did;
}

function applyPolicyScrollAfterPaste(reason = 'paste') {
    if (hasLiveTerminalSelection?.() || mobileTerminalSelectionMode) return false;
    clearMobileTerminalHistoryLock?.(`${reason}:policy-paste`);
    setTerminalAutoFollow?.(true, `${reason}:policy-paste`);
    const did = scrollTerminalToBottomAfterPasteIfEnabled(
        getWTermScrollTarget(),
        getTerminalScrollPolicySettings(),
    );
    // Paste may still need chrome-aware pin after WTerm stick.
    if (isMobileStableInputMode()) applyCursorAboveChromeScroll(`${reason}:paste-chrome`, { force: true });
    scheduleTerminalScrollbarUpdate?.();
    return did;
}

/**
 * Single control plane for mobile WTerm × keyboard × chrome-pin.
 * terminal.js becomes a host adapter; surface owns event routing.
 */
function ensureTerminalSurface() {
    if (terminalSurface) return terminalSurface;
    if (!isTouchKeyboardDevice()) return null;
    terminalSurface = createTerminalSurfaceController({
        isTouchDevice: () => isTouchKeyboardDevice(),
        isMobileStable: () => isMobileStableInputMode(),
        getTerm: () => term,
        getScrollElement: () => getTerminalScrollElement(),
        getWtermRoot: () => term?.element || wtermWrapper?.querySelector?.('.wterm') || wtermWrapper,
        ensureImeProxy: () => {
            setupMobileStableImeProxy();
            return mobileImeProxy;
        },
        getSoftKeyboard: () => {
            ensureSshKeyboard();
            return sshSoftKeyboard;
        },
        getViewportMetrics: () => getViewportKeyboardMetrics(),
        isSelectionMode: () => !!(mobileTerminalSelectionMode || hasLiveTerminalSelection?.()),
        isGestureSuppressed: () => !!(terminalTouchMoved || mobileTerminalSelectionMode || hasLiveTerminalSelection?.()),
        hasLiveSelection: () => !!(hasLiveTerminalSelection?.() || mobileTerminalSelectionMode),
        isUserReadingHistory: () => isTerminalUserReadingHistory?.() || false,
        getChromeHeight: () => getMobileBottomChromeHeight(),
        getCursorMetrics: () => getCursorContentMetrics(),
        getMaxScroll: () => getTerminalMaxScroll(getTerminalScrollElement()),
        // THE single scrollTop writer — surface only decides when.
        pinScroll: (reason, opts = {}) => applyCursorAboveChromeScroll(reason, opts),
        applyChromeLayout: (open, inset, meta = {}) => {
            // Facade owns terminal-ime chrome. Surface apply is only a cmd-freeze helper
            // or emergency path when facade is unavailable.
            if (sshKb) {
                applyFacadeChrome(meta.reason || 'surface-apply');
                return;
            }
            const layoutFrozen = !!meta.layoutFrozen
                || meta.liftMode === SoftKeyboardLiftMode.NONE
                || meta.source === 'cmd'
                || isCmdOverlayMode?.();
            if (layoutFrozen) {
                applyMobileStableKeyboardInset(0, false, meta.reason || 'surface-cmd-frozen');
                return;
            }
            applyMobileStableKeyboardInset(open ? inset : 0, !!open, meta.reason || 'surface');
            if (!open) {
                pinMobileImeChrome(false, 0);
                requestAnimationFrame(() => assertKeyboardLayoutSettled?.(meta.reason || 'surface-close'));
                scheduleKeyboardCloseFit?.(meta.reason || 'surface-close', 420);
            }
        },
        notifyParent: (metrics) => notifyParentKeyboardMetrics({ ...metrics, forceNotify: !sshKb }),
        onScrollbar: () => scheduleTerminalScrollbarUpdate(),
        // After each paint, glue the IME proxy to the real cursor cell so
        // Android/iOS candidate bars anchor correctly (not the 2px corner box).
        onCursorGeometry: (reason) => scheduleImeProxyCursorAnchor(reason || 'surface-render'),
        onSoftKeyboardState: (state) => {
            // Read-only mirror; do not invent authority when facade exists.
            if (sshKb) {
                applyFacadeChrome('surface-soft-state');
                return;
            }
            _sshKbLayoutOpenCache = !!state.physicalOpen && state.intent === SoftKeyboardIntent.OPEN;
            _sshKbInsetCache = state.physicalOpen ? (state.inset || 0) : 0;
        },
        log: (event, details) => logTerminalLayoutDiagnostics?.(event, details || {}),
    });
    // Bridge legacy sshSoftKeyboard variable so old call sites share the same instance.
    sshSoftKeyboard = terminalSurface.getSoftKeyboard?.() || sshSoftKeyboard;
    return terminalSurface;
}

/**
 * Live height of bottom chrome OVERLAYING the terminal scrollport.
 * Termux/kb-flow model: tools + aux are always in normal document flow under
 * the terminal, never position:fixed over the buffer. Therefore chromeHeight
 * for scroll math is always 0 — the scrollport ends where the toolbars begin.
 */
function getMobileBottomChromeHeight() {
    return 0;
}

/**
 * HARD PRODUCT RULE (user bottom line):
 * When the **last content-bearing row** would be covered by the toolbar,
 * shift the grid up so that row sits **above** the tools. Not "any cursor",
 * not chrome pin scrollTop — specifically the last line that still has text
 * (or the draft/caret if lower).
 *
 * Sets --term-active-line-shift on .wterm (translateY ≤ 0 on .term-grid).
 */
let _activeLineGuardRaf = 0;
function scheduleEnsureActiveLineAboveChrome(reason = 'active-line-guard') {
    if (!isMobileStableInputMode()) return;
    if (_activeLineGuardRaf) return;
    _activeLineGuardRaf = requestAnimationFrame(() => {
        _activeLineGuardRaf = 0;
        ensureActiveLineAboveChrome(reason);
    });
}

function getToolsTopY() {
    // Ceiling = top edge of the first toolbar under the terminal (actions strip).
    // That is what covers content when the shell is short.
    const actions = (typeof topbarActions !== 'undefined' && topbarActions)
        ? topbarActions
        : document.getElementById('topbarActions');
    const bottomBar = document.getElementById('terminalBottomBar');
    let top = Infinity;
    try {
        const a = actions?.getBoundingClientRect?.();
        if (a && a.height > 0 && a.width > 0) top = Math.min(top, a.top);
    } catch (_) {}
    try {
        const b = bottomBar?.getBoundingClientRect?.();
        // Aux bar is below actions; still a cover if actions not laid out yet.
        if (b && b.height > 0 && b.width > 0) top = Math.min(top, b.top);
    } catch (_) {}
    if (!Number.isFinite(top) || top === Infinity) {
        try {
            const c = terminalContainer?.getBoundingClientRect?.();
            if (c) return c.bottom;
        } catch (_) {}
        return window.innerHeight || 0;
    }
    return top;
}

/**
 * Bottom edge (viewport Y) of the last row that still has content.
 * Preference order (lowest on screen wins if several apply):
 *   1) last .term-row with non-whitespace textContent
 *   2) cursor / draft caret overlay bottom
 *   3) bridge cursor row geometry
 */
function getLastContentLineBottomY(root) {
    let bestBottom = null;
    let source = 'none';

    // 1) Last painted row with real glyphs (committed buffer + in-grid draft).
    try {
        const rows = root.querySelectorAll?.('.term-row:not(.term-scrollback-row)');
        if (rows && rows.length) {
            for (let i = rows.length - 1; i >= 0; i -= 1) {
                const row = rows[i];
                const text = String(row.textContent || '').replace(/\u00a0/g, ' ');
                // Treat non-space content as "has content". Cursor-only blank rows skip.
                if (!text.replace(/\s+/g, '')) continue;
                const r = row.getBoundingClientRect?.();
                if (r && r.height > 0) {
                    bestBottom = r.bottom;
                    source = `term-row:${i}`;
                    break;
                }
            }
        }
    } catch (_) {}

    // 2) Caret overlay — may sit past last glyph when draft is mid-line empty after wrap.
    try {
        const overlay = root.querySelector?.('.term-cursor-overlay');
        if (overlay && overlay.style.display !== 'none') {
            const r = overlay.getBoundingClientRect?.();
            if (r && r.height > 0) {
                if (bestBottom == null || r.bottom > bestBottom) {
                    bestBottom = r.bottom;
                    source = 'cursor-overlay';
                }
            }
        }
    } catch (_) {}

    // 3) Bridge geometry fallback (viewport-relative).
    if (bestBottom == null) {
        try {
            const m = getCursorContentMetrics?.();
            const host = (getTerminalScrollElement() || wtermWrapper)?.getBoundingClientRect?.();
            if (m && host) {
                bestBottom = host.top + (m.cursorBottomInViewport
                    ?? ((m.cursorTopInViewport || 0) + (m.lineHeight || 17)));
                source = m.source || 'bridge';
            }
        } catch (_) {}
    }

    return { bottom: bestBottom, source };
}

function ensureActiveLineAboveChrome(reason = 'active-line-guard') {
    if (!isMobileStableInputMode() || !wtermWrapper) return false;
    const root = term?.element || wtermWrapper.querySelector?.('.wterm') || wtermWrapper;
    if (!root) return false;

    // Reading history (ydisp < ybase): NEVER lift the grid. Lifting while
    // scrolled up creates a black slab above content and blocks "scroll up".
    if (!isTerminalAtBottom(undefined, TERMINAL_XTERM_SCROLL_LOCK_THRESHOLD)
        || isTerminalUserReadingHistory?.()
        || !terminalAutoFollowEnabled) {
        const cur = parseFloat(getComputedStyle(root).getPropertyValue('--term-active-line-shift')) || 0;
        if (cur !== 0) root.style.setProperty('--term-active-line-shift', '0px');
        return false;
    }

    // Anchor = LAST content-bearing line bottom (not "any" mid-screen cursor).
    const { bottom: contentBottom, source: contentSource } = getLastContentLineBottomY(root);
    if (contentBottom == null || !Number.isFinite(contentBottom)) {
        // No content → no shift (leave grid natural).
        root.style.setProperty('--term-active-line-shift', '0px');
        return false;
    }
 
    const toolsTop = getToolsTopY();
    const lineHeight = getTerminalCharMetrics?.()?.lineHeight
        || term?.getViewportState?.()?.rowHeight
        || 17;
    // Small gap so glyphs don't kiss the tool strip.
    const safeGap = Math.max(4, Math.round(lineHeight * 0.25));
    // Ceiling: top of toolbar. Content bottom must stay ≤ this.
    const ceiling = toolsTop - safeGap;

    // How far the last content line sticks into / under the toolbar.
    const overflow = contentBottom - ceiling;

    let currentShift = 0;
    try {
        currentShift = parseFloat(getComputedStyle(root).getPropertyValue('--term-active-line-shift')) || 0;
    } catch (_) {}

    let nextShift = currentShift;
    if (overflow > 0.5) {
        // Covered (or would be) → move grid UP by exactly the overflow.
        nextShift = currentShift - overflow;
    } else if (overflow < -(lineHeight * 0.75) && currentShift < -0.5) {
        // Plenty of room above tools → relax shift back toward 0 (don't over-lift).
        nextShift = Math.min(0, currentShift - overflow);
    }

    // Never shift down past 0; never more than ~grid height up.
    const gridH = Math.max(
        root.querySelector?.('.term-grid')?.scrollHeight || 0,
        root.scrollHeight || 0,
        root.clientHeight || 0,
    );
    const maxUp = -Math.max(lineHeight, gridH);
    nextShift = Math.max(maxUp, Math.min(0, nextShift));
    nextShift = Math.round(nextShift);

    if (Math.abs(nextShift - currentShift) < 1) {
        return false;
    }
    root.style.setProperty('--term-active-line-shift', `${nextShift}px`);
    logTerminalLayoutDiagnostics?.('last-content-above-tools', {
        reason,
        contentSource,
        contentBottom: Math.round(contentBottom),
        toolsTop: Math.round(toolsTop),
        ceiling: Math.round(ceiling),
        overflow: Math.round(overflow),
        shift: nextShift,
        prevShift: Math.round(currentShift),
    });
    return true;
}
 
/**
 * Cursor metrics for chrome-pin.
 *
 * NEVER return contentY = scrollTop + row*lh — that feedback-loops and the
 * cursor "flies" on every pin. WTerm cursor.row is viewport-relative.
 *
 * Preferred order:
 *  1) overlay getBoundingClientRect → viewport-relative edges (stable)
 *  2) bridge cursor.row * lineHeight → viewport-relative edges
 */
function getCursorContentMetrics() {
    const el = getTerminalScrollElement();
    const lineHeight = (term && term.getViewportState?.()?.rowHeight)
        || term?.viewport?.rowHeight
        || getTerminalCharMetrics?.()?.lineHeight
        || terminalFontSize * 1.35
        || 17;

    // 1) Live overlay in viewport coordinates (does not encode scrollTop).
    try {
        const overlay = wtermWrapper?.querySelector?.('.term-cursor-overlay');
        if (overlay && overlay.style.display !== 'none' && el) {
            const oRect = overlay.getBoundingClientRect?.();
            const pRect = el.getBoundingClientRect?.();
            if (oRect?.height && pRect?.height) {
                const top = oRect.top - pRect.top;
                return {
                    cursorTopInViewport: top,
                    cursorBottomInViewport: top + oRect.height,
                    lineHeight: oRect.height || lineHeight,
                    row: -1,
                    col: -1,
                    visible: true,
                    source: 'overlay-viewport',
                };
            }
        }
    } catch (_) {}

    // 2) Bridge: row is viewport-relative. Do NOT add scrollTop.
    try {
        const cursor = term?.bridge?.getCursor?.() || term?.getCursor?.();
        if (cursor && Number.isFinite(cursor.row)) {
            const top = cursor.row * lineHeight;
            return {
                cursorTopInViewport: top,
                cursorBottomInViewport: top + lineHeight,
                lineHeight,
                row: cursor.row,
                col: cursor.col,
                visible: cursor.visible !== false,
                source: 'bridge-viewport',
            };
        }
    } catch (_) {}

    // 3) Last non-empty painted row (viewport-relative via DOM).
    try {
        const rows = wtermWrapper
            ? Array.from(wtermWrapper.querySelectorAll('.term-row, .term-scrollback-row'))
            : [];
        const pRect = el?.getBoundingClientRect?.();
        for (let i = rows.length - 1; i >= 0; i -= 1) {
            const row = rows[i];
            if (!String(row.textContent || '').trim()) continue;
            const r = row.getBoundingClientRect?.();
            if (r?.height && pRect) {
                const top = r.top - pRect.top;
                return {
                    cursorTopInViewport: top,
                    cursorBottomInViewport: top + r.height,
                    lineHeight: r.height || lineHeight,
                    row: -1,
                    col: -1,
                    visible: true,
                    source: 'row-viewport',
                };
            }
        }
    } catch (_) {}

    return null;
}

/** Coalesce pin writes to ≤1 per animation frame — kills multi-writer thrash. */
let cursorPinRaf = 0;
let cursorPinQueued = null;
let cursorPinLastAt = 0;
let cursorPinInFlight = false;

/**
 * Product rule: pin cursor just above bottom toolbar.
 * Single writer for mobile scrollTop. Viewport-relative cursor only.
 *
 * @returns {boolean} whether scrollTop changed (or was queued)
 */
function applyCursorAboveChromeScroll(reason = 'cursor-above-chrome', {
    force = false,
    sameLineInput = false,
    immediate = false,
} = {}) {
    if (!isMobileStableInputMode()) return false;
    // Queue: last intent wins within the same frame.
    cursorPinQueued = { reason, force, sameLineInput };
    if (immediate) return flushCursorAboveChromeScroll();
    if (cursorPinRaf) return false;
    cursorPinRaf = requestAnimationFrame(() => {
        cursorPinRaf = 0;
        flushCursorAboveChromeScroll();
    });
    return false;
}

function flushCursorAboveChromeScroll() {
    const job = cursorPinQueued;
    cursorPinQueued = null;
    if (!job) return false;
    if (cursorPinInFlight) return false;

    const { reason, force, sameLineInput } = job;
    const el = getTerminalScrollElement();
    if (!el) return false;
    if (hasLiveTerminalSelection?.() || mobileTerminalSelectionMode) return false;
    if (mobileImeComposing && !force) return false;
    if (isMobileTerminalAutoFollowLocked() && !force && !isMobileStableActualInputReason(reason)) {
        return false;
    }
    // Hard rate limit: never pin more than once per 32ms even across rAFs.
    const now = performance.now();
    if (!force && now - cursorPinLastAt < 32) {
        scheduleTerminalScrollbarUpdate?.();
        return false;
    }

    const chromeHeight = getMobileBottomChromeHeight();
    const maxScroll = getTerminalMaxScroll(el);
    const lineHeight = (term && term.getViewportState?.()?.rowHeight)
        || term?.viewport?.rowHeight
        || getTerminalCharMetrics?.()?.lineHeight
        || terminalFontSize * 1.35
        || 17;

    // kb-flow2 / Termux: chrome never overlays the scrollport (chromeHeight===0).
    // Stick-to-bottom is plain maxScroll — no cursor-rect chase, no black void.
    let decision;
    if (chromeHeight <= 0) {
        const current = el.scrollTop || 0;
        // Sparse content: stay at 0. Otherwise snap to bottom (row-aligned).
        let next = maxScroll <= 0 ? 0 : Math.floor(maxScroll / lineHeight) * lineHeight;
        next = Math.max(0, Math.min(maxScroll, next));
        const delta = next - current;
        const already = Math.abs(delta) < 2;
        // same-line typing while already at bottom: no-op
        if (already) {
            decision = {
                scrollTop: current,
                changed: false,
                reason: maxScroll <= 0 ? 'sparse-zero-max' : 'already-at-bottom',
                delta: 0,
            };
        } else if (sameLineInput && !force && current >= maxScroll - lineHeight) {
            decision = { scrollTop: current, changed: false, reason: 'same-line-near-bottom', delta: 0 };
        } else {
            decision = {
                scrollTop: next,
                changed: true,
                reason: maxScroll <= 0 ? 'sparse-zero-max' : 'stick-bottom',
                delta: next - current,
            };
        }
    } else {
        const metrics = getCursorContentMetrics();
        if (!metrics) {
            scheduleTerminalScrollbarUpdate?.();
            return false;
        }
        decision = computeCursorAboveChromeScrollTop({
            scrollTop: el.scrollTop || 0,
            maxScroll,
            scrollportHeight: el.clientHeight || 0,
            cursorBottomInViewport: metrics.cursorBottomInViewport,
            cursorTopInViewport: metrics.cursorTopInViewport,
            cursorBottomInContent: metrics.cursorBottomInContent,
            cursorTopInContent: metrics.cursorTopInContent,
            chromeHeight,
            lineHeight: metrics.lineHeight || lineHeight,
            sameLineInput,
            force,
        });
    }

    logTerminalScrollDiagnostics('cursor-above-chrome', {
        reason,
        ...decision,
        chromeHeight,
        sameLineInput,
        force,
    });

    // stick-bottom is always allowed (Termux). Other unclip reasons still gate on typing.
    if (sameLineInput && !force && decision.reason !== 'stick-bottom' && !allowScrollDuringTyping(decision)) {
        scheduleTerminalScrollbarUpdate?.();
        return false;
    }
    if (!decision.changed) {
        scheduleTerminalScrollbarUpdate?.();
        return false;
    }

    cursorPinInFlight = true;
    cursorPinLastAt = now;
    isProgrammaticTerminalScroll = true;
    try {
        writeTerminalScrollTop(el, decision.scrollTop, reason, { pin: true });
        if (wtermWrapper && wtermWrapper !== el) {
            writeTerminalScrollTop(wtermWrapper, Math.min(decision.scrollTop, getTerminalMaxScroll(wtermWrapper)), reason, { pin: true });
        }
        if (force || decision.reason !== 'sparse-zero-max') {
            mobileStableLastBottomIntent = true;
            setTerminalAutoFollow?.(true, `${reason}:${decision.reason}`);
        }
    } finally {
        scheduleTerminalScrollbarUpdate?.();
        // DOM scrollTop stick is insufficient for xterm-viewport; always run
        // the hard clip/shift guard so the caret cannot sit under tools.
        scheduleEnsureActiveLineAboveChrome(`${reason}:after-pin`);
        requestAnimationFrame(() => {
            isProgrammaticTerminalScroll = false;
            cursorPinInFlight = false;
        });
 
}
    return true;
}

function getParams() {
    try {
        const qs = new URLSearchParams(location.search);
        const tabId = qs.get('tabId');
        const key = tabId ? `zephyr_ssh_params_${tabId}` : 'zephyr_ssh_params';
        const raw = sessionStorage.getItem(key);
        const params = raw ? JSON.parse(raw) : null;
        if (params && tabId) params.tabId = tabId;
        return params;
    } catch { return null; }
}

const params = getParams();
let terminalHistorySessionId = String(params?.tabId || params?.sessionId || params?.connectionId || '');
let terminalRemoteHistory = null;
let pendingWorkspaceRestoreState = null;
const embeddedMode = new URLSearchParams(location.search).get('embed') === '1' || !!params?.embedded;
function notifyParentStatus(status) {
    if (embeddedMode && window.parent && window.parent !== window) {
        window.parent.postMessage({ source: 'zephyr-terminal', tabId: params?.tabId, status }, '*');
    }
}
function notifyParentCloseRequest(reason = 'terminal-closed') {
    if (embeddedMode && window.parent && window.parent !== window) {
        console.info('[TerminalClose]', 'request parent to close tab', {
            tabId: params?.tabId,
            reason,
            connected: isConnected,
            readyState: wsConnection?.readyState,
        });
        window.parent.postMessage({ source: 'zephyr-terminal', type: 'close-request', tabId: params?.tabId, reason }, '*');
    }
}
function notifyParentActivity() {
    if (embeddedMode && window.parent && window.parent !== window) {
        window.parent.postMessage({ source: 'zephyr-terminal', type: 'activity', tabId: params?.tabId }, '*');
    }
}
function notifyParentSharedClipboardText(text = '') {
    if (embeddedMode && window.parent && window.parent !== window && text) {
        window.parent.postMessage({ source: 'zephyr-terminal', type: 'shared-clipboard-text', tabId: params?.tabId, text: String(text) }, '*');
    }
}
function requestParentSharedFileClipboard() {
    if (embeddedMode && window.parent && window.parent !== window) {
        window.parent.postMessage({ source: 'zephyr-terminal', type: 'request-shared-file-clipboard', tabId: params?.tabId }, '*');
    }
}
function consumeParentSharedFileClipboard(files = [], sourceTabId = '') {
    if (embeddedMode && window.parent && window.parent !== window) {
        window.parent.postMessage({ source: 'zephyr-terminal', type: 'shared-file-clipboard-consume', tabId: params?.tabId, sourceTabId, files }, '*');
    }
}
['keydown', 'pointerdown', 'mousedown', 'touchstart'].forEach((eventName) => {
    document.addEventListener(eventName, notifyParentActivity, { passive: true, capture: true });
});
if (!params) {
    if (!embeddedMode) window.location.href = '/';
    throw new Error(t('缺少连接参数'));
}
// Glyph defs are inserted after DOM bindings are ready.

// ---------- DOM 元素 ----------
const statusDot = $('#statusDot');
const statusText = $('#statusText');
const connInfo = $('#connInfo');
const terminalOverlay = $('#terminalOverlay');
const overlayMsg = $('#overlayMsg');
const terminalContainer = $('#terminalContainer');
const wtermWrapper = $('#wtermWrapper');
const terminalScrollbar = $('#terminalScrollbar');
const terminalScrollbarThumb = $('#terminalScrollbarThumb');
const topbarActions = $('#topbarActions');
const reconnectBtn = $('#reconnectBtn');
const disconnectBtn = $('#disconnectBtn');
const themeToggle = $('#themeToggle');
const wtermThemeToggle = $('#wtermThemeToggle');
const cmdInput = $('#cmdInput');
const terminalInputPanel = $('#terminalBottomBar');  // mobile: bottom aux-key bar
const cmdSendBtn = $('#cmdSendBtn');
const copyBtn = $('#copyBtn');
const pasteBtn = $('#pasteBtn');
const fileBtn = $('#fileBtn');
const infoBtn = $('#infoBtn');
const dockerBtn = $('#dockerBtn');
const snippetBtn = $('#snippetBtn');
const shortcutBtn = $('#shortcutBtn');


const snippetPanel = $('#snippetPanel');
const snippetSearch = $('#snippetSearch');
const snippetList = $('#snippetList');
const snippetEmpty = $('#snippetEmpty');
const shortcutPanel = $('#shortcutPanel');
const fontDecreaseBtn = $('#fontDecreaseBtn');
const fontIncreaseBtn = $('#fontIncreaseBtn');

// 文件管理器 DOM
const fmTransferBtn = $('#fmTransferBtn');
const fileManager = $('#fileManager');
const fmBackBtn = $('#fmBackBtn');
const fmPathInput = $('#fmPathInput');
const fmGoBtn = $('#fmGoBtn');
const fmRefreshBtn = $('#fmRefreshBtn');
const fmCloseBtn = $('#fmCloseBtn');
const fmNewFolderBtn = $('#fmNewFolderBtn');
const fmNewFileBtn = $('#fmNewFileBtn');
const fmSelectBtn = $('#fmSelectBtn');
const fmPasteBtn = $('#fmPasteBtn');
const fmUploadInput = $('#fmUploadInput');
const fmDropOverlay = $('#fmDropOverlay');
const fmSearchInput = $('#fmSearchInput');
const fmList = $('#fmList');
let selectedFilePaths = new Set();
let fileManagerWindowSeq = 0;
const fileManagerWindowsByRequestId = new Map();
const extraFileManagerWindows = new Set();
let lastFileClick = { path: '', time: 0 };
let fileContextMenu = null;
let fileContextOverlay = null;
let filePropertiesModal = null;
let filePropertiesOverlay = null;
let fileLongPressTimer = null;
let mobileFileSelectMode = false;
let sftpClipboardAvailable = false;
let terminalShortcutPlatform = localStorage.getItem('zephyr-shortcut-platform') || 'auto';
let terminalAppearance = {};
let fmEditorModal = $('#fmEditorModal');
let fmEditorTitle = $('#fmEditorTitle');
let fmEditorMain = $('#fmEditorMain');
let fmEditorTextarea = $('#fmEditorTextarea');
let fmEditorLineNumbers = $('#fmEditorLineNumbers');
let fmEditorHighlight = $('#fmEditorHighlight');
let fmEditorIndentGuides = $('#fmEditorIndentGuides');
let fmEditorMinimap = $('#fmEditorMinimap');
let fmEditorMinimapCode = $('#fmEditorMinimapCode');
let fmEditorMinimapToggle = $('#fmEditorMinimapToggle');
let fmEditorCompactBtn = $('#fmEditorCompactBtn');
let fmEditorPaletteBtn = $('#fmEditorPaletteBtn');
let fmEditorAiBtn = $('#fmEditorAiBtn');
let fmEditorFormatBtn = $('#fmEditorFormatBtn');
let fmEditorSaveBtn = $('#fmEditorSaveBtn');
let fmEditorCancelBtn = $('#fmEditorCancelBtn');
let fmEditorCloseBtn = $('#fmEditorCloseBtn');
let fmEditorUndoBtn = $('#fmEditorUndoBtn');
let fmEditorRedoBtn = $('#fmEditorRedoBtn');
let fmEditorEncoding = $('#fmEditorEncoding');
let fmEditorLineEnding = $('#fmEditorLineEnding');
let fmEditorTabSize = $('#fmEditorTabSize');
let fmEditorWrap = $('#fmEditorWrap');
let fmEditorStatus = $('#fmEditorStatus');

// 监控相关 DOM
const infoModal = $('#infoModal');
const infoCloseBtn = $('#infoCloseBtn');
const infoBody = $('#infoBody');

// Docker 面板 DOM
const dockerPanel = $('#dockerPanel');
const dockerCloseBtn = $('#dockerCloseBtn');
const dockerRestartBtn = $('#dockerRestartBtn');
const dockerRefreshBtn = $('#dockerRefreshBtn');
const dockerStatus = $('#dockerStatus');
const dockerInstallHint = $('#dockerInstallHint');
const dockerContent = $('#dockerContent');
const dockerContainersBody = $('#dockerContainersBody');
const dockerImagesBody = $('#dockerImagesBody');
const dockerPullInput = $('#dockerPullInput');
const dockerPullBtn = $('#dockerPullBtn');
const dockerPullLog = $('#dockerPullLog');
const dockerMirrorList = $('#dockerMirrorList');
const dockerMirrorInput = $('#dockerMirrorInput');
const dockerMirrorAddBtn = $('#dockerMirrorAddBtn');
const dockerMirrorSaveBtn = $('#dockerMirrorSaveBtn');
const dockerLogDrawer = $('#dockerLogDrawer');
const dockerLogTitle = $('#dockerLogTitle');
const dockerLogPauseBtn = $('#dockerLogPauseBtn');
const dockerLogDownloadBtn = $('#dockerLogDownloadBtn');
const dockerLogCloseBtn = $('#dockerLogCloseBtn');
const dockerContainerLog = $('#dockerContainerLog');
const toolbar = topbarActions;  // mobile: original CSS-icon actions row

// ---------- 全局变量 ----------
let term = null;
let wsConnection = null;
let isConnected = false;
let sftpReady = false;
let currentPath = '.';
let allFiles = [];
let pendingUploadFiles = [];
const activeSftpUploads = new Map();
const activeSftpDownloads = new Map();
const imagePreviewPanelsByPath = new Map();
let activeImagePreview = null;
const mediaPreviewPanelsByPath = new Map();
let activeMediaPreview = null;
let transferPopover = null;
let transferPopoverHideTimer = 0;
let transferRenderRaf = 0;
let fileDragDepth = 0;
let searchQuery = '';
let editorFilePath = null;
let editorLanguage = 'plain';
let editorRawBytes = null;
let editorMinimapHidden = localStorage.getItem('zephyr-editor-minimap-hidden') === '1';
let activeEditorPanel = null;
let floatingPanelZIndexSeed = 260;
let editorZIndexSeed = 260;
const FLOATING_PANEL_SELECTOR = '.file-manager, .info-modal, .docker-panel, .snippet-panel, .shortcut-panel, .fm-editor-modal.editor-window, .image-preview-modal, .media-preview-modal';
const editorPanelsByPath = new Map();
const pendingEditorReads = new Map();
const pendingRemoteSubtitleReads = new Map();
const pendingWorkspaceSearches = new Map();
const SFTP_VIDEO_EXTENSIONS = new Set(['mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'flv', 'f4v', 'mpeg', 'mpg', 'mpe', 'ts', 'mts', 'm2ts', 'vob', 'ogv', '3gp', '3g2', 'asf', 'rm', 'rmvb', 'divx', 'mxf']);
const SFTP_AUDIO_EXTENSIONS = new Set(['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'oga', 'opus', 'weba', 'wma', 'alac', 'aiff', 'aif', 'ape', 'amr', 'mid', 'midi', 'mka', 'caf', 'ac3', 'dts', 'm4b']);
const SFTP_ARCHIVE_ICON_EXTENSIONS = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'tbz', 'tbz2', 'xz', 'txz', 'zst', 'lz', 'lzma', 'br', 'jar', 'war', 'ear', 'apk', 'ipa', 'deb', 'rpm', 'pkg', 'dmg', 'iso']);
function sftpFileExt(filePath = '') { const base = String(filePath || '').split(/[\\/]/).pop() || ''; const idx = base.lastIndexOf('.'); return idx > -1 ? base.slice(idx + 1).toLowerCase() : ''; }
function isSftpArchiveFile(filePath = '') { return SFTP_ARCHIVE_ICON_EXTENSIONS.has(sftpFileExt(filePath)); }
function isSftpMediaFile(filePath = '') { const ext = sftpFileExt(filePath); return SFTP_VIDEO_EXTENSIONS.has(ext) || SFTP_AUDIO_EXTENSIONS.has(ext); }
function isSftpVideoFile(filePath = '') { return SFTP_VIDEO_EXTENSIONS.has(sftpFileExt(filePath)); }

const ZEPHYR_GLYPH_DEFS = `<svg width="0" height="0" class="zephyr-glyph-defs" aria-hidden="true" focusable="false"><defs><linearGradient id="macBlue" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#5AC8FA"/><stop offset="100%" stop-color="#007AFF"/></linearGradient><linearGradient id="macGold" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#FFD60A"/><stop offset="100%" stop-color="#FF9F0A"/></linearGradient><linearGradient id="macCyan" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#32ADE6"/><stop offset="100%" stop-color="#007AFF"/></linearGradient><linearGradient id="macGreen" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#34C759"/><stop offset="100%" stop-color="#248A3D"/></linearGradient><linearGradient id="macPurple" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#AF52DE"/><stop offset="100%" stop-color="#5E5CE6"/></linearGradient><linearGradient id="macIndigo" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#5E5CE6"/><stop offset="100%" stop-color="#403EAB"/></linearGradient><linearGradient id="macRed" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#FF5252"/><stop offset="100%" stop-color="#E53935"/></linearGradient><linearGradient id="macDark" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#48484A"/><stop offset="100%" stop-color="#1C1C1E"/></linearGradient></defs></svg>`;
const ZEPHYR_GLYPHS = {
    folder: '<path d="M2 7C2 5.3 3.3 4 5 4H9.3C10.1 4 10.9 4.4 11.5 5L12.5 6.1C12.8 6.4 13.2 6.6 13.6 6.6H19C20.7 6.6 22 7.9 22 9.6V17C22 18.7 20.7 20 19 20H5C3.3 20 2 18.7 2 17V7Z" fill="url(#macBlue)"/>',
    archive: '<path d="M2 7C2 5.3 3.3 4 5 4H9.3C10.1 4 10.9 4.4 11.5 5L12.5 6.1C12.8 6.4 13.2 6.6 13.6 6.6H19C20.7 6.6 22 7.9 22 9.6V17C22 18.7 20.7 20 19 20H5C3.3 20 2 18.7 2 17V7Z" fill="url(#macGold)"/><line x1="12" y1="7" x2="12" y2="15" stroke="#8E8E93" stroke-width="2" stroke-dasharray="2 2" stroke-linecap="round"/><rect x="10.5" y="14" width="3" height="4" rx="1.5" fill="#FFFFFF" stroke="#8E8E93" stroke-width="1"/>',
    file: '<path d="M14 2H6C4.9 2 4 2.9 4 4V20C4 21.1 4.9 22 6 22H18C19.1 22 20 21.1 20 20V8L14 2Z" fill="#FFFFFF" stroke="#C7C7CC" stroke-width="1.5" stroke-linejoin="round"/><path d="M14 2V8H20" fill="#E5E5EA" stroke="#C7C7CC" stroke-width="1.5" stroke-linejoin="round"/><line x1="8" y1="13" x2="16" y2="13" stroke="#007AFF" stroke-width="1.5" stroke-linecap="round"/><line x1="8" y1="17" x2="14" y2="17" stroke="#8E8E93" stroke-width="1.5" stroke-linecap="round"/>',
    upload: '<path d="M17.5 19C20 19 22 17 22 14.5C22 12.1 20.2 10.2 17.9 10C17.4 6.6 14.5 4 11 4C7.1 4 4 7.1 4 11C4 11.2 4 11.5 4.1 11.7C2.3 12.3 1 14 1 16C1 18.2 2.8 20 5 20" fill="url(#macCyan)"/><path d="M11 16V9M8 12L11 9L14 12" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    download: '<path d="M17.5 19C20 19 22 17 22 14.5C22 12.1 20.2 10.2 17.9 10C17.4 6.6 14.5 4 11 4C7.1 4 4 7.1 4 11C4 11.2 4 11.5 4.1 11.7C2.3 12.3 1 14 1 16C1 18.2 2.8 20 5 20" fill="url(#macGreen)"/><path d="M11 9V16M8 13L11 16L14 13" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    copy: '<rect x="5" y="5" width="12" height="13" rx="2" fill="url(#macIndigo)"/><rect x="9" y="9" width="12" height="13" rx="2" fill="#FFFFFF" stroke="#C7C7CC" stroke-width="1.5"/><line x1="12" y1="13" x2="18" y2="13" stroke="#8E8E93" stroke-width="1.5" stroke-linecap="round"/><line x1="12" y1="17" x2="16" y2="17" stroke="#8E8E93" stroke-width="1.5" stroke-linecap="round"/>',
    video: '<rect x="2" y="7" width="14" height="10" rx="3" fill="url(#macPurple)"/><path d="M16 10L21 7.5C21.6 7.2 22 7.4 22 8V16C22 16.6 21.6 16.8 21 16.5L16 14V10Z" fill="url(#macPurple)"/>',
    audio: '<path d="M8 16V4C8 3.4 8.4 3 9 3H19C19.6 3 20 3.4 20 4V14" fill="none" stroke="#FF2D55" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/><line x1="8" y1="6" x2="20" y2="4" stroke="#FF2D55" stroke-width="3" stroke-linecap="round"/><circle cx="6" cy="16" r="3" fill="#D30F3B"/><circle cx="18" cy="14" r="3" fill="#D30F3B"/>',
    delete: '<path d="M4 6H20" stroke="#FF5252" stroke-width="2" stroke-linecap="round"/><path d="M9 6V4C9 3.4 9.4 3 10 3H14C14.6 3 15 3.4 15 4V6" fill="none" stroke="#FF5252" stroke-width="2" stroke-linecap="round"/><path d="M5 6L6.5 19.5C6.5 20.9 7.6 22 9 22H15C16.4 22 17.5 20.9 17.5 19.5L19 6H5Z" fill="url(#macRed)"/><line x1="10" y1="10" x2="10" y2="18" stroke="#FFFFFF" stroke-width="1.5" stroke-linecap="round"/><line x1="14" y1="10" x2="14" y2="18" stroke="#FFFFFF" stroke-width="1.5" stroke-linecap="round"/>',
    status: '<rect x="2" y="4" width="20" height="16" rx="4" fill="url(#macDark)"/><path d="M 3 12 H 8.5 L 10.5 7 L 13.5 17 L 15.5 12 H 21" fill="none" stroke="#32D74B" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
};
function ensureZephyrGlyphDefs() {
    const target = document.body || document.documentElement;
    if (!target || document.getElementById('zephyrGlyphDefs')) return;
    const holder = document.createElement('div');
    holder.id = 'zephyrGlyphDefs';
    holder.innerHTML = ZEPHYR_GLYPH_DEFS;
    target.prepend(holder);
}
function zephyrGlyph(name, className = 'zephyr-glyph', label = '') {
    const body = ZEPHYR_GLYPHS[name] || ZEPHYR_GLYPHS.file;
    const aria = label ? ` role="img" aria-label="${escapeHtml(label)}"` : ' aria-hidden="true" focusable="false"';
    return `<svg class="${className}" viewBox="0 0 24 24"${aria}>${body}</svg>`;
}
function zephyrFileGlyph(file) {
    ensureZephyrGlyphDefs();
    if (file?.type === 'd') return zephyrGlyph('folder', 'zephyr-glyph fm-file-glyph', t('文件夹'));
    if (isSftpArchiveFile(file?.name || '')) return zephyrGlyph('archive', 'zephyr-glyph fm-file-glyph', t('压缩包'));
    if (isSftpMediaFile(file?.name || '')) return zephyrGlyph(isSftpVideoFile(file.name) ? 'video' : 'audio', 'zephyr-glyph fm-file-glyph', isSftpVideoFile(file.name) ? t('视频') : t('音乐'));
    return zephyrGlyph('file', 'zephyr-glyph fm-file-glyph', t('文件'));
}
function zephyrButtonGlyph(name, label = '') {
    ensureZephyrGlyphDefs();
    return zephyrGlyph(name, 'zephyr-glyph fm-button-glyph', label);
}
function setZephyrIconButton(button, iconName, label) {
    if (!button) return;
    button.innerHTML = zephyrButtonGlyph(iconName, label);
    if (label) button.setAttribute('aria-label', label);
}

const DOCKER_ACTION_GLYPH_DEFS = `<svg width="0" height="0" class="docker-action-glyph-defs" aria-hidden="true" focusable="false"><defs><linearGradient id="dockerStartGreen" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#34C759"/><stop offset="100%" stop-color="#28A745"/></linearGradient><linearGradient id="dockerRestartBlue" x1="0%" y1="20%" x2="100%" y2="80%"><stop offset="0%" stop-color="#007AFF"/><stop offset="100%" stop-color="#5E5CE8"/></linearGradient><linearGradient id="dockerLogDark" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#2C2C2E"/><stop offset="100%" stop-color="#1C1C1E"/></linearGradient><linearGradient id="dockerStopRed" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#FF453A"/><stop offset="100%" stop-color="#D70015"/></linearGradient><linearGradient id="dockerDeleteRed" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#FF5252"/><stop offset="100%" stop-color="#E53935"/></linearGradient></defs></svg>`;
const DOCKER_ACTION_GLYPHS = {
    start: '<circle cx="12" cy="12" r="10" fill="url(#dockerStartGreen)"/><path d="M10 8L16 12L10 16V8Z" fill="#FFFFFF"/>',
    restart: '<path d="M12 4C7.58 4 4 7.58 4 12C4 16.42 7.58 20 12 20C16.42 20 20 16.42 20 12H18C18 15.31 15.31 18 12 18C8.69 18 6 15.31 6 12C6 8.69 8.69 6 12 6V9L16 5.5L12 2V4Z" fill="url(#dockerRestartBlue)"/>',
    logs: '<rect x="4" y="3" width="16" height="18" rx="2" fill="url(#dockerLogDark)"/><line x1="7" y1="7" x2="17" y2="7" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round"/><line x1="7" y1="11" x2="17" y2="11" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round"/><line x1="7" y1="15" x2="13" y2="15" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round"/>',
    stop: '<circle cx="12" cy="12" r="10" fill="url(#dockerStopRed)"/><rect x="8.5" y="8.5" width="7" height="7" rx="1.5" fill="#FFFFFF"/>',
    remove: '<path d="M4 6H20" stroke="#FF5252" stroke-width="2" stroke-linecap="round"/><path d="M9 6V4C9 3.4 9.4 3 10 3H14C14.6 3 15 3.4 15 4V6" fill="none" stroke="#FF5252" stroke-width="2" stroke-linecap="round"/><path d="M5 6L6.5 19.5C6.5 20.9 7.6 22 9 22H15C16.4 22 17.5 20.9 17.5 19.5L19 6H5Z" fill="url(#dockerDeleteRed)"/><line x1="10" y1="10" x2="10" y2="18" stroke="#FFFFFF" stroke-width="1.5" stroke-linecap="round"/><line x1="14" y1="10" x2="14" y2="18" stroke="#FFFFFF" stroke-width="1.5" stroke-linecap="round"/>'
};
function ensureDockerActionGlyphDefs() {
    const target = document.body || document.documentElement;
    if (!target || document.getElementById('dockerActionGlyphDefs')) return;
    const holder = document.createElement('div');
    holder.id = 'dockerActionGlyphDefs';
    holder.innerHTML = DOCKER_ACTION_GLYPH_DEFS;
    target.prepend(holder);
}
function dockerActionGlyph(action, label = '') {
    ensureDockerActionGlyphDefs();
    const body = DOCKER_ACTION_GLYPHS[action] || DOCKER_ACTION_GLYPHS.logs;
    const aria = label ? ` role="img" aria-label="${escapeHtml(label)}"` : ' aria-hidden="true" focusable="false"';
    return `<svg class="docker-action-glyph" viewBox="0 0 24 24"${aria}>${body}</svg>`;
}

let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 3;
let activeConnectionToken = 0;
let reconnectTimer = 0;
let userClosedConnection = false;
let reconnectInProgress = false;

let dockerChecked = false;
let dockerInstalled = false;
let dockerMirrors = [];
let dockerCurrentLogContainer = null;
let dockerAutoScrollLog = true;
let dockerLogBuffer = '';

// 图表实例管理
let chartInstances = {};
let latestStatsData = null;
let monitorPage = 0;
let monitorPrevPage = 0;
let monitorSwitchDirection = 1;
let monitorPageSwitching = false;
let monitorRenderRaf = 0;
let processSearch = '';
let processSort = 'cpu';
let processBusyPid = 0;
let terminalScrollRaf = 0;
let terminalScrollbarRaf = 0;
let isProgrammaticTerminalScroll = false;
let terminalScrollCleanup = null;
let terminalResizeCleanup = null;
let suppressWTermResizeEvent = false;
let terminalFontSize = 14;
let terminalAllowLigatures = localStorage.getItem('zephyr-terminal-allow-ligatures') === '1';
function getTerminalAllowLigatures() {
    return !!terminalAllowLigatures;
}
function applyTerminalLigatures(enabled, { persist = true } = {}) {
    terminalAllowLigatures = !!enabled;
    try { term?.setLigatures?.(terminalAllowLigatures); } catch (_) {}
    try {
        if (term?.element?.classList) term.element.classList.toggle('allow-ligatures', terminalAllowLigatures);
        document.documentElement.classList.toggle('wterm-allow-ligatures', terminalAllowLigatures);
        wtermWrapper?.classList?.toggle('allow-ligatures', terminalAllowLigatures);
    } catch (_) {}
    if (persist) localStorage.setItem('zephyr-terminal-allow-ligatures', terminalAllowLigatures ? '1' : '0');
}

// Mobile devices get a larger default for readability
const TERMINAL_FONT_MOBILE_DEFAULT = 16;
// DoD: no independent open state. These are READ accessors over sshKb only.
// Cached mirror fields exist solely for applyMobileStableKeyboardInset geometry; never decide intent.
let _sshKbLayoutOpenCache = false;
let _sshKbInsetCache = 0;
let mobileWTermInputGuard = null;
let mobileClipboardActionInProgress = false;
let mobileKeyboardResizeFreezeUntil = 0;

function isSshKbDesiredOpen() {
    try {
        if (sshKb) return !!sshKb.desiredOpen?.();
        if (sshSoftKeyboard) return !!sshSoftKeyboard.desiredOpen?.();
    } catch (_) {}
    return false;
}
function isSshKbPhysicalOpen() {
    try {
        if (sshKb) return !!sshKb.physicalOpen?.();
        if (sshSoftKeyboard) return !!sshSoftKeyboard.physicalOpen?.();
    } catch (_) {}
    return false;
}
/** Layout-open: workspace should treat keyboard chrome as raised. */
function isSshKbLayoutOpen() {
    if (isCmdOverlayMode?.()) return false;
    try {
        if (sshKb) {
            // F2: desired open alone is enough — physical height may lag.
            if (sshKb.desiredOpen?.()) return true;
            const phase = sshKb.getPhase?.();
            if (phase === 'open' || phase === 'opening') return true;
        }
    } catch (_) {}
    return !!_sshKbLayoutOpenCache;
}
function getSshKbInset() {
    try {
        if (sshKb) return Math.max(0, Math.round(Number(sshKb.getInset?.() || 0) || 0));
    } catch (_) {}
    return Math.max(0, _sshKbInsetCache || 0);
}
function isSshKbFocusLikely() {
    return isSshKbDesiredOpen() || isSshKbPhysicalOpen() || document.activeElement === mobileImeProxy;
}

/** Pin scrolls always allowed. Non-pin terminal scroll blocked while keyboard phase active. */
function writeTerminalScrollTop(el, value, reason = 'scroll', { pin = false } = {}) {
    if (!el) return false;
    if (!pin && sshKb && !sshKb.allowNonPinScroll?.(reason)) {
        logTerminalLayoutDiagnostics?.('scroll:blocked-ssh-kb-gate', { reason, phase: sshKb.getPhase?.() });
        scheduleTerminalScrollbarUpdate?.();
        return false;
    }
    el.scrollTop = value;
    return true;
}
// Backward-compat names used widely: become live getters via defineProperty below after vars removed.
let keyboardViewportBaseline = 0;
let keyboardFallbackTimer = 0;
let keyboardFallbackActive = false;
let keyboardFallbackAppliedAt = 0;
let pinchStartDistance = 0;
let pinchStartFontSize = 14;
let pinchLastAppliedFontSize = 14;
let suppressNextLayoutClick = false;
let viewportAnimationRaf = 0;
let viewportAnimationResizeTimer = 0;
let cachedSelectionText = '';
let mobileTerminalSelectionMode = false;
let mobileTerminalSelectionTimer = 0;
let mobileTerminalSelectionRestoreTimer = 0;
let terminalTouchFocusTimer = 0;
let terminalTouchStartX = 0;
let terminalTouchStartY = 0;
let terminalTouchMoved = false;
let mobileTerminalLastTap = { at: 0, x: 0, y: 0, target: null };
const TERMINAL_COPY_DIAGNOSTICS = false;
const MOBILE_STABLE_INPUT_MODE = isMobileStableInputCandidate();
const MOBILE_KEYBOARD_RESIZE_REASONS = /keyboard|viewport|visual|ime|focus|input|fallback/i;
let mobileStableInputEnabled = false;
/* getSshKbInset() → getSshKbInset() */
let mobileImeProxy = null;
let mobileImeComposing = false;
/** Last compositionupdate/start time — stuck IME compositions are force-cleared. */
let mobileImeComposingAt = 0;
let mobileImeComposeWatchdog = 0;
/** After compositionend, suppress duplicate beforeinput/input for the same text. */
let mobileImeComposeSuppressUntil = 0;
let mobileImeLastComposedText = '';
/** After Enter unsticks a stuck Latin composition, drop late compositionend (kimikimi). */
let mobileImeEnterSuppressCompositionEndUntil = 0;
let mobileStableLastBottomIntent = true;
let mobileStableOrientationResizeUntil = 0;
let mobileTerminalAutoFollowLockUntil = 0;
let mobileTerminalAutoFollowLockReason = '';
let mobileStableKeyboardGridRepairTimers = [];
let mobileStableKeyboardOpenGrid = null;
let mobileImeLastSent = { text: '', source: '', at: 0 };
let mobileImeLastControl = { seq: '', source: '', at: 0 };
/**
 * Text already delivered to PTY on the current pre-Enter line (progressive
 * keystrokes or composition commits). Enter leftover flush must not re-send
 * when English IME re-fills the proxy with the same word (first-word kimikimi).
 */
let mobileImeLineAcc = '';
let mobileStableLastFocusGestureAt = 0;
/** @type {ReturnType<typeof createSshKeyboard>['asSoftKeyboard'] extends Function ? any : any} */
/** @type {ReturnType<typeof createSshKeyboard> | null} */
let sshKb = null;
let sshSoftKeyboard = null;
let mobileStableLastActualInputAt = 0;
let mobileStableSuppressScrollUntil = 0;
let mobileStableScrollRestoreToken = 0;
let mobileStableScrollRestoreTimers = [];
let terminalBottomFollowToken = 0;
let terminalBottomFollowTimers = [];
let terminalUserScrollGestureUntil = 0;
let mobileStableTypingUntil = 0;
let mobileStableEchoSuppressUntil = 0;

function logTerminalCopyDiagnostics(event, details = {}) {
    if (!TERMINAL_COPY_DIAGNOSTICS) return;
    try {
        const selection = window.getSelection?.();
        const viewport = window.visualViewport;
        console.info('[TerminalCopyDiagnostics]', {
            event,
            touchKeyboardDevice: isTouchKeyboardDevice?.(),
            activeElement: document.activeElement?.id || document.activeElement?.className || document.activeElement?.tagName,
            selectionCollapsed: selection?.isCollapsed,
            selectionLength: selection?.toString?.().length || 0,
            cachedSelectionLength: cachedSelectionText.length,
            sshKbLayoutOpen: !!isSshKbLayoutOpen?.(),
            sshKbFocusLikely: !!isSshKbFocusLikely?.(),
            mobileTerminalSelectionMode,
            viewportHeight: Math.round(viewport?.height || 0),
            viewportOffsetTop: Math.round(viewport?.offsetTop || 0),
            innerHeight: Math.round(window.innerHeight || 0),
            ...details,
        });
    } catch (err) {
        console.info('[TerminalCopyDiagnostics]', event, details, err);
    }
}

function hasLiveTerminalSelection() {
    const selection = window.getSelection?.();
    return Boolean(selection && !selection.isCollapsed && (selection.toString?.().length || 0) > 0);
}

function blurTerminalInputsForSelection() {
    if (isTouchKeyboardDevice()) return;
    try { cmdInput?.blur?.(); } catch (_) {}
    try { document.activeElement?.blur?.(); } catch (_) {}
}

function enterMobileTerminalSelectionMode(reason = 'selection') {
    if (!isTouchKeyboardDevice()) return;
    window.clearTimeout(mobileTerminalSelectionRestoreTimer);
    window.clearTimeout(terminalTouchFocusTimer);
    window.clearTimeout(mobileTerminalSelectionTimer);
    const wasActive = mobileTerminalSelectionMode;
    mobileTerminalSelectionMode = true;
    blurTerminalInputsForSelection();
    // 移动端选择/复制时不强制收键盘，避免布局回弹。
    // 如果用户想收键盘，让系统返回键或键盘按钮自己处理。
    if (!isTouchKeyboardDevice()) {
        if (isSshKbLayoutOpen() || getViewportKeyboardMetrics().keyboardInset > 8) {
            finalizeKeyboardClose({ force: true });
        }
    }
    document.documentElement.classList.add('terminal-selection-mode');
    const scrollEl = getTerminalScrollElement();
    if (isMobileStableInputMode() && scrollEl && !isTerminalAtBottom(scrollEl, TERMINAL_XTERM_SCROLL_LOCK_THRESHOLD)) {
        setTerminalAutoFollow(false, `${reason}:selection-history`);
        lockMobileTerminalAutoFollow(`${reason}:selection-history`, 3200);
    }
    logTerminalCopyDiagnostics(wasActive ? 'selection-mode-keep' : 'selection-mode-enter', { reason });
}

function scheduleExitMobileTerminalSelectionMode(delay = 900) {
    window.clearTimeout(mobileTerminalSelectionRestoreTimer);
    mobileTerminalSelectionRestoreTimer = window.setTimeout(() => {
        if (hasLiveTerminalSelection()) {
            scheduleExitMobileTerminalSelectionMode(900);
            return;
        }
        mobileTerminalSelectionMode = false;
        document.documentElement.classList.remove('terminal-selection-mode');
        logTerminalCopyDiagnostics('selection-mode-exit');
    }, delay);
}

function scheduleMobileLongPressSelectionGuard(reason = 'touchstart') {
    if (!isTouchKeyboardDevice()) return;
    window.clearTimeout(mobileTerminalSelectionTimer);
    const delay = isMobileStableInputMode() ? 650 : 260;
    mobileTerminalSelectionTimer = window.setTimeout(() => {
        enterMobileTerminalSelectionMode(reason);
    }, delay);
}

function getTerminalTextNodeAtPoint(x, y) {
    if (!wtermWrapper || !document.caretRangeFromPoint && !document.caretPositionFromPoint) return null;
    let node = null;
    let offset = 0;
    try {
        if (document.caretRangeFromPoint) {
            const range = document.caretRangeFromPoint(x, y);
            node = range?.startContainer || null;
            offset = range?.startOffset || 0;
        } else if (document.caretPositionFromPoint) {
            const pos = document.caretPositionFromPoint(x, y);
            node = pos?.offsetNode || null;
            offset = pos?.offset || 0;
        }
    } catch (_) {
        return null;
    }
    if (!node || !wtermWrapper.contains(node)) return null;
    if (node.nodeType !== Node.TEXT_NODE) {
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        const first = walker.nextNode();
        if (!first) return null;
        node = first;
        offset = 0;
    }
    return { node, offset: Math.max(0, Math.min(offset, node.textContent?.length || 0)) };
}

/**
 * xterm.js default wordSeparator (OptionsService): ' ()[]{}\',"\`'
 * Double-click selects the minimal unit bounded by these separators
 * (or a run of spaces). DOM selection + browser copy — not whole buffer.
 */
// xterm OptionsService default: space ( ) [ ] { } ' , " `
const XTERM_WORD_SEPARATORS = " ()[]{}',\"" + '`';
 
function isXtermWordSeparatorChar(ch = '') {
    if (!ch) return true;
    return XTERM_WORD_SEPARATORS.indexOf(ch) >= 0;
}

function getSmartTerminalSelectionBounds(text = '', offset = 0) {
    const value = String(text || '');
    if (!value) return null;
    const clamp = (n) => Math.max(0, Math.min(value.length, n));
    let pos = clamp(offset);
    if (pos >= value.length && value.length) pos = value.length - 1;
    // Prefer the char under the caret; if on a separator and previous is word, step left.
    if (isXtermWordSeparatorChar(value[pos]) && pos > 0 && !isXtermWordSeparatorChar(value[pos - 1])) {
        pos -= 1;
    }
    let start = pos;
    let end = pos;
    if (value[pos] === ' ') {
        // Whitespace run (xterm: expand while char is space)
        while (start > 0 && value[start - 1] === ' ') start -= 1;
        while (end + 1 < value.length && value[end + 1] === ' ') end += 1;
        end += 1;
    } else {
        // Expand until separator (xterm _getWordAt / _isCharWordSeparator)
        while (start > 0 && !isXtermWordSeparatorChar(value[start - 1])) start -= 1;
        while (end + 1 < value.length && !isXtermWordSeparatorChar(value[end + 1])) end += 1;
        end += 1;
    }
    if (end <= start) return null;
    // Reject pure-whitespace-only if empty after trim? xterm allows space runs when allowWhitespaceOnly.
    return { start, end };
}
 
function showNativeSelectionMenu() {
    try { document.execCommand?.('copy', false, null); } catch (_) {}
}

/**
 * Select the xterm word under (x,y) using DOM Range.
 * Copy is left to the browser (document 'copy' / clipboard API) from that selection only.
 */
function selectTerminalTextAtPoint(x, y, reason = 'double-tap', { autoCopy = false } = {}) {
    if (!wtermWrapper) return false;
    const hit = getTerminalTextNodeAtPoint(x, y);
    const text = hit?.node?.textContent || '';
    const bounds = getSmartTerminalSelectionBounds(text, hit?.offset || 0);
    if (!hit || !bounds) return false;
    const range = document.createRange();
    range.setStart(hit.node, bounds.start);
    range.setEnd(hit.node, bounds.end);
    const selection = window.getSelection?.();
    if (!selection) return false;
    selection.removeAllRanges();
    selection.addRange(range);
    if (isTouchKeyboardDevice()) enterMobileTerminalSelectionMode(reason);
    cachedSelectionText = normalizeCopiedTerminalText(
        getTerminalSelectionTextFromDom(selection) || selection.toString?.() || '',
    );
    // Never copy the whole buffer — only the live selection. Optional autoCopy
    // is for mobile double-tap convenience; desktop uses browser Cmd/Ctrl+C.
    if (autoCopy && navigator.clipboard?.writeText && cachedSelectionText) {
        navigator.clipboard.writeText(cachedSelectionText).catch(() => {});
        window.setTimeout(showNativeSelectionMenu, 30);
    }
    logTerminalCopyDiagnostics('word-select', {
        reason,
        textLength: cachedSelectionText.length,
        autoCopy: !!autoCopy,
        sample: cachedSelectionText.slice(0, 40),
    });
    return true;
}
 
function handleMobileTerminalDoubleTap(e) {
    if (!isTouchKeyboardDevice()) return false;
    const x = e.clientX ?? e.changedTouches?.[0]?.clientX ?? e.touches?.[0]?.clientX ?? 0;
    const y = e.clientY ?? e.changedTouches?.[0]?.clientY ?? e.touches?.[0]?.clientY ?? 0;
    const now = performance.now();
    const previous = mobileTerminalLastTap;
    mobileTerminalLastTap = { at: now, x, y, target: e.target };
    if (!previous.at || now - previous.at > 360 || Math.hypot(x - previous.x, y - previous.y) > 24) return false;
    e.preventDefault?.();
    e.stopPropagation?.();
    window.clearTimeout(mobileTerminalSelectionTimer);
    window.clearTimeout(terminalTouchFocusTimer);
    // Mobile: select word + soft auto-copy of selection only (not whole buffer).
    return selectTerminalTextAtPoint(x, y, 'double-tap', { autoCopy: true });
}

/** Desktop: xterm-style double-click word select; browser owns copy. */
function handleTerminalDesktopDblClick(e) {
    if (isTouchKeyboardDevice()) return;
    if (!wtermWrapper || e.button !== 0) return;
    // App mouse mode: leave to VT mouse protocol.
    if (term?.bridge?.mouseMode?.() > 0 && !e.shiftKey) return;
    e.preventDefault();
    e.stopPropagation();
    selectTerminalTextAtPoint(e.clientX, e.clientY, 'dblclick', { autoCopy: false });
}
 
const viewportAnimationState = {
    currentHeight: 0,
    currentOffsetTop: 0,
    targetHeight: 0,
    targetOffsetTop: 0,
    startHeight: 0,
    startOffsetTop: 0,
    startTime: 0,
    duration: 560,
};

const TERMINAL_FONT_MIN = 10;
const TERMINAL_FONT_MAX = 28;
const TERMINAL_FONT_STEP = 1;
const TERMINAL_FONT_STORAGE_KEY = 'zephyr-terminal-font-size';
const TERMINAL_BOTTOM_THRESHOLD = 8;
const TERMINAL_SCROLLBAR_MIN_THUMB = 28;
const TERMINAL_XTERM_SCROLL_LOCK_THRESHOLD = 18;
const TERMINAL_ALT_SCROLL_REPEAT_MS = 16;
const TERMINAL_LINK_PROTOCOL_RE = /\b(?:https?:\/\/|ftp:\/\/|ssh:\/\/|telnet:\/\/|mailto:)[^\s<>'"`\u3000]+/ig;
const TERMINAL_LAYOUT_DIAGNOSTICS = true;
const TERMINAL_SCROLL_DIAGNOSTICS = false;
const TERMINAL_MIN_RESIZE_WIDTH = 120;
const TERMINAL_MIN_RESIZE_HEIGHT = 80;
const TERMINAL_RESIZE_DEBOUNCE_MS = 120;
const TERMINAL_KEYBOARD_RESIZE_FREEZE_MS = 1400;
const TERMINAL_KEYBOARD_STABLE_RESIZE_DELAY = 520;
const TERMINAL_LAYOUT_SIGNATURE_PX = 2;
let lastSentTerminalSize = { cols: 0, rows: 0 };
let pendingTerminalResize = { cols: 0, rows: 0, timer: 0, reason: '' };
let terminalFitSnapshot = null;
let terminalStableResizeTimer = 0;
let terminalViewportFreezeUntil = 0;
let terminalKeyboardSettlingTimer = 0;
/* terminalVisualHistory removed (P0-2): text-regression self-heal deleted */
const TERMINAL_STABLE_LAYOUT_DELAYS = [0, 60, 160, 360, 720];
const TERMINAL_OVERSIZED_ROWS_RATIO = 1.18;
let terminalAutoFollowEnabled = true;
let terminalUserScrolledAway = false;
let terminalLastUserScrollAt = 0;
let terminalLastWheelAt = 0;
let parentKeyboardResizeFreezeUntil = 0;
const terminalMouseState = {
    enabled: false,
    sgr: false,
    mode: 'none',
    buttonDown: false,
};

function logTerminalScrollDiagnostics(event, details = {}) {
    if (!TERMINAL_SCROLL_DIAGNOSTICS) return;
    try {
        const el = getTerminalScrollElement?.();
        const viewport = window.visualViewport;
        console.info('[TerminalScrollDiagnostics]', {
            event,
            isProgrammaticTerminalScroll,
            sshKbLayoutOpen: !!isSshKbLayoutOpen?.(),
            sshKbFocusLikely: !!isSshKbFocusLikely?.(),
            keyboardFallbackActive,
            activeElement: document.activeElement?.id || document.activeElement?.className || document.activeElement?.tagName,
            scroll: el ? {
                top: Math.round(el.scrollTop || 0),
                height: Math.round(el.scrollHeight || 0),
                clientHeight: Math.round(el.clientHeight || 0),
                bottomDistance: Math.round(getTerminalBottomDistance?.(el) || 0),
                atBottom: Boolean(isTerminalAtBottom?.(el)),
            } : null,
            viewport: viewport ? {
                height: Math.round(viewport.height || 0),
                offsetTop: Math.round(viewport.offsetTop || 0),
            } : null,
            ...details,
        });
    } catch (err) {
        console.info('[TerminalScrollDiagnostics]', event, details, err);
    }
}

function logTerminalLayoutDiagnostics(event, details = {}) {
    if (!TERMINAL_LAYOUT_DIAGNOSTICS) return;
    try {
        const viewport = window.visualViewport;
        const wrapperRect = wtermWrapper?.getBoundingClientRect?.();
        const containerRect = terminalContainer?.getBoundingClientRect?.();
        const gridRect = wtermWrapper?.querySelector?.('.term-grid')?.getBoundingClientRect?.();
        console.info('[TerminalLayoutDiagnostics]', {
            event,
            embeddedMode,
            visibility: document.visibilityState,
            sshKbLayoutOpen: !!isSshKbLayoutOpen?.(),
            sshKbFocusLikely: !!isSshKbFocusLikely?.(),
            wrapper: wrapperRect ? {
                width: Math.round(wrapperRect.width),
                height: Math.round(wrapperRect.height),
                top: Math.round(wrapperRect.top),
                left: Math.round(wrapperRect.left),
                scrollTop: Math.round(wtermWrapper?.scrollTop || 0),
                scrollHeight: Math.round(wtermWrapper?.scrollHeight || 0),
                clientHeight: Math.round(wtermWrapper?.clientHeight || 0),
            } : null,
            container: containerRect ? {
                width: Math.round(containerRect.width),
                height: Math.round(containerRect.height),
                top: Math.round(containerRect.top),
                left: Math.round(containerRect.left),
            } : null,
            grid: gridRect ? {
                width: Math.round(gridRect.width),
                height: Math.round(gridRect.height),
            } : null,
            viewport: viewport ? {
                width: Math.round(viewport.width || 0),
                height: Math.round(viewport.height || 0),
                offsetTop: Math.round(viewport.offsetTop || 0),
                offsetLeft: Math.round(viewport.offsetLeft || 0),
            } : null,
            inner: {
                width: Math.round(window.innerWidth || 0),
                height: Math.round(window.innerHeight || 0),
            },
            term: term ? {
                cols: Number(term.cols ?? term._cols ?? term.options?.cols ?? 0),
                rows: Number(term.rows ?? term._rows ?? term.options?.rows ?? 0),
            } : null,
            ...details,
        });
    } catch (err) {
        console.info('[TerminalLayoutDiagnostics]', event, details, err);
    }
}

function getCssPxVar(name) {
    return Math.round(parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)) || 0);
}

function getVirtualKeyboardInset() {
    const rect = navigator.virtualKeyboard?.boundingRect;
    const height = Math.round(rect?.height || 0);
    return height > 0 ? height : 0;
}

/**
 * Distance from the layout viewport bottom to the visual viewport bottom.
 * This is the true keyboard top gap and must NOT use inflated baseline heights
 * (those produce a black seam between chrome and IME).
 */
function measureImeChromeBottom() {
    try {
        const vk = navigator.virtualKeyboard?.boundingRect;
        if (vk && Number(vk.height) > 40) {
            return Math.max(0, Math.round(Number(vk.height) || 0));
        }
    } catch (_) {}
    const vv = window.visualViewport;
    if (!vv) return 0;
    const layoutH = Math.round(window.innerHeight || document.documentElement.clientHeight || 0);
    const vvBottom = Math.round((vv.offsetTop || 0) + (vv.height || 0));
    return Math.max(0, layoutH - vvBottom);
}

function pinMobileImeChrome(open, inset = 0, { authoritative = false } = {}) {
    if (!isMobileStableInputMode()) return;
    // kb-flow2: chrome is in document flow. --ime-chrome-bottom is unused for
    // positioning (always 0). Keep measuring aux/actions for diagnostics only.
    void authoritative;
    void inset;
    document.documentElement.style.setProperty('--ime-chrome-bottom', '0px');
    const auxH = Math.max(
        36,
        Math.round(terminalInputPanel?.getBoundingClientRect?.().height || terminalInputPanel?.offsetHeight || 44),
    );
    document.documentElement.style.setProperty('--mobile-aux-keys-height', `${auxH}px`);
    const actionsH = Math.max(
        36,
        Math.round(topbarActions?.getBoundingClientRect?.().height || topbarActions?.offsetHeight || 46),
    );
    document.documentElement.style.setProperty('--mobile-bottom-actions-height', `${actionsH}px`);
    // Page height shrink is driven by --ssh-kb-inset (written by applyMobileStableKeyboardInset).
    if (!open) {
        // nothing else — inset cleared by caller
    }
}

function isTouchKeyboardDevice() {
    return (navigator.maxTouchPoints || 0) > 0
        || window.matchMedia?.('(hover: none) and (pointer: coarse)')?.matches;
}

function isMobileStableInputCandidate() {
    return !!window.matchMedia?.('(hover: none) and (pointer: coarse)')?.matches
        || ((navigator.maxTouchPoints || 0) > 0 && !!window.matchMedia?.('(max-width: 700px)')?.matches);
}

function getKeyboardBaselineHeight() {
    return Math.round(Math.max(
        keyboardViewportBaseline || 0,
        getCssPxVar('--stable-vh'),
        window.innerHeight || 0,
        document.documentElement.clientHeight || 0,
        window.visualViewport?.height || 0,
    ));
}

function getEstimatedKeyboardInset() {
    // F2: never invent provisional height (0.33 / 230–380). Fake estimates made
    // tools fly to a wrong edge then correct ~1s later when live vv arrived.
    try {
        const m = getViewportKeyboardMetrics();
        if (m.keyboardOpen && m.keyboardInset >= 80) return m.keyboardInset;
    } catch (_) {}
    return 0;
}

/** Top command bar owns IME; page layout must not move at all. */
let cmdOverlayMode = false;

function isCmdOverlayMode() {
    return cmdOverlayMode
        || document.activeElement === cmdInput
        || document.documentElement.dataset.keyboardLiftMode === SoftKeyboardLiftMode.NONE;
}

function enterCmdOverlayMode(reason = 'cmd-overlay') {
    cmdOverlayMode = true;
    document.documentElement.dataset.keyboardLiftMode = SoftKeyboardLiftMode.NONE;
    document.documentElement.classList.add('ssh-kb-cmd');
    // Hard zero layout side-effects from the terminal keyboard path.
    _sshKbInsetCache = 0;
    _sshKbLayoutOpenCache = false;
    document.documentElement.style.setProperty('--keyboard-inset', '0px');
    document.documentElement.classList.remove('ssh-kb-open', 'viewport-updating');
    terminalContainer?.classList.remove('ssh-kb-open');
    notifyParentKeyboardMetrics({
        keyboardOpen: false,
        keyboardInset: 0,
        viewportHeight: Math.round(window.visualViewport?.height || window.innerHeight || 0),
        layoutHeight: Math.round(window.innerHeight || document.documentElement.clientHeight || 0),
        offsetTop: 0,
        liftMode: SoftKeyboardLiftMode.NONE,
        source: 'cmd',
        reason: `${reason}:layout-frozen`,
    });
    logTerminalLayoutDiagnostics?.('cmd-overlay:enter', { reason });
}

function leaveCmdOverlayMode(reason = 'cmd-overlay-leave') {
    if (!cmdOverlayMode && document.documentElement.dataset.keyboardLiftMode !== SoftKeyboardLiftMode.NONE) return;
    cmdOverlayMode = false;
    document.documentElement.classList.remove('ssh-kb-cmd');
    if (document.documentElement.dataset.keyboardLiftMode === SoftKeyboardLiftMode.NONE) {
        document.documentElement.dataset.keyboardLiftMode = SoftKeyboardLiftMode.WORKSPACE;
    }
    logTerminalLayoutDiagnostics?.('cmd-overlay:leave', { reason });
}

function getActiveKeyboardLiftMode(metrics = {}) {
    if (metrics.liftMode === SoftKeyboardLiftMode.NONE || metrics.liftMode === SoftKeyboardLiftMode.WORKSPACE) {
        return metrics.liftMode;
    }
    if (metrics.source === 'cmd') return SoftKeyboardLiftMode.NONE;
    if (cmdOverlayMode || document.activeElement === cmdInput) return SoftKeyboardLiftMode.NONE;
    try {
        if (sshSoftKeyboard?.getLiftMode) return sshSoftKeyboard.getLiftMode();
    } catch (_) {}
    return SoftKeyboardLiftMode.WORKSPACE;
}

function notifyParentKeyboardMetrics(metrics = {}) {
    if (!(embeddedMode && window.parent && window.parent !== window)) return;
    const liftMode = getActiveKeyboardLiftMode(metrics);
    const isCmd = liftMode === SoftKeyboardLiftMode.NONE || metrics.source === 'cmd' || metrics.inputSource === 'cmd';
    const kb = ensureSshKeyboard?.() || sshKb;
    // Sole parent protocol: type ssh-kb (never keyboard-metrics).
    if (kb?._bridge?.publish) {
        try {
            const st = kb.getState?.() || {};
            const phase = isCmd ? 'closed' : (st.layout?.phase || kb.getPhase?.() || 'closed');
            const intent = isCmd
                ? (kb.desiredOpen?.() ? 'open' : 'closed')
                : (st.intent?.intent || (kb.desiredOpen?.() ? 'open' : 'closed'));
            const inset = isCmd ? 0 : (st.layout?.inset ?? st.intent?.inset ?? kb.getInset?.() ?? metrics.keyboardInset ?? 0);
            kb._bridge.publish({
                phase,
                intent,
                inset: Math.max(0, Math.round(Number(inset) || 0)),
                liftMode: isCmd ? 'none' : (st.intent?.liftMode || kb.getLiftMode?.() || 'workspace'),
                physical: isCmd ? 'closed' : (st.intent?.physical || (kb.physicalOpen?.() ? 'open' : 'closed')),
                reason: metrics.reason || 'notify-parent',
            });
        } catch (_) {}
        return;
    }
    // No facade yet: still emit ssh-kb shape only.
    window.parent.postMessage({
        source: 'zephyr-terminal',
        type: 'ssh-kb',
        tabId: params?.tabId,
        phase: isCmd ? 'closed' : (metrics.keyboardOpen ? 'open' : 'closed'),
        intent: metrics.keyboardOpen || metrics.intent === 'open' ? 'open' : 'closed',
        inset: isCmd ? 0 : (metrics.keyboardInset || 0),
        liftMode: isCmd ? 'none' : (liftMode || 'workspace'),
        physical: metrics.keyboardOpen ? 'open' : 'closed',
        keyboardOpen: !isCmd && !!metrics.keyboardOpen,
        keyboardInset: isCmd ? 0 : (metrics.keyboardInset || 0),
        reason: metrics.reason || '',
        stableInput: isMobileStableInputMode(),
    }, '*');
}


function getViewportKeyboardMetrics() {
    const viewport = window.visualViewport;
    const layoutHeight = Math.round(window.innerHeight || document.documentElement.clientHeight || 0);
    const stableHeight = getCssPxVar('--stable-vh');
    const baselineHeight = Math.max(layoutHeight, stableHeight || 0, keyboardViewportBaseline || 0);
    const rawViewportHeight = Math.round(viewport?.height || layoutHeight || 0);
    const offsetTop = Math.round(viewport?.offsetTop || 0);
    const visualViewportInset = viewport ? Math.max(0, baselineHeight - rawViewportHeight - offsetTop) : 0;
    const virtualKeyboardInset = getVirtualKeyboardInset();
    const keyboardInset = Math.max(visualViewportInset, virtualKeyboardInset);
    const viewportHeight = virtualKeyboardInset > visualViewportInset
        ? Math.max(1, baselineHeight - virtualKeyboardInset - offsetTop)
        : rawViewportHeight;
    const roundedInset = Math.round(keyboardInset);
    // F5: single threshold set (80 open / 12 close) matching intent.js.
    const wantsAvoidance = isKeyboardAvoidanceTarget();
    const keyboardOpen = (wantsAvoidance || isSshKbLayoutOpen())
        && roundedInset > (isSshKbLayoutOpen() ? 12 : 80);
    return {
        layoutHeight: baselineHeight || layoutHeight,
        viewportHeight,
        offsetTop,
        keyboardInset: roundedInset,
        keyboardOpen,
        wantsAvoidance,
    };
}

function isViewportVisuallyRestored(metrics, tolerance = 8) {
    if (!window.visualViewport) return true;
    return metrics.keyboardInset <= tolerance
        || metrics.viewportHeight >= metrics.layoutHeight - tolerance;
}

function isKeyboardAvoidanceTarget(element = document.activeElement) {
    if (!element) return false;
    // Top command bar is layout-frozen: never counts as avoidance target.
    if (element === cmdInput || cmdOverlayMode) return false;
    const tag = element.tagName?.toLowerCase();
    const editable = tag === 'textarea'
        || (tag === 'input' && !['button', 'checkbox', 'radio', 'submit', 'reset', 'file', 'range', 'color'].includes((element.type || '').toLowerCase()))
        || element.isContentEditable;
    return Boolean(editable || terminalContainer?.contains(element));
}

function setViewportCssMetrics(height, offsetTop) {
    if (isMobileStableInputMode()) {
        const roundedHeight = Math.max(1, Math.round(getKeyboardBaselineHeight() || height || window.innerHeight || document.documentElement.clientHeight || 1));
        document.documentElement.style.setProperty('--visual-vh', `${roundedHeight}px`);
        document.documentElement.style.setProperty('--visual-offset-top', '0px');
        return;
    }
    const roundedHeight = Math.max(1, Math.round(height));
    const roundedOffset = Math.round(offsetTop);
    document.documentElement.style.setProperty('--visual-vh', `${roundedHeight}px`);
    document.documentElement.style.setProperty('--visual-offset-top', `${roundedOffset}px`);
}

function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
}

function animateViewportCssMetrics(targetHeight, targetOffsetTop, { immediate = false } = {}) {
    const targetH = Math.max(1, Math.round(targetHeight || window.innerHeight || document.documentElement.clientHeight || 1));
    const targetY = Math.round(targetOffsetTop || 0);
    if (viewportAnimationRaf) cancelAnimationFrame(viewportAnimationRaf);
    viewportAnimationRaf = 0;
    viewportAnimationState.currentHeight = targetH;
    viewportAnimationState.currentOffsetTop = targetY;
    viewportAnimationState.targetHeight = targetH;
    viewportAnimationState.targetOffsetTop = targetY;
    document.documentElement.classList.toggle('viewport-updating', !immediate);
    setViewportCssMetrics(targetH, targetY);
    window.clearTimeout(viewportAnimationResizeTimer);
    viewportAnimationResizeTimer = window.setTimeout(() => {
        document.documentElement.classList.remove('viewport-updating');
        requestTerminalAutoFollow('viewport-css-animation-settled');
        requestStableTerminalLayout('viewport-css-animation-settled', { includeResize: true });
    }, immediate ? 40 : 600);  // 增加延迟到 600ms 以匹配更长的 transition
}

function animateViewportCssMetricsOld(targetHeight, targetOffsetTop, { immediate = false } = {}) {
    const targetH = Math.max(1, Math.round(targetHeight || window.innerHeight || document.documentElement.clientHeight || 1));
    const targetY = Math.round(targetOffsetTop || 0);
    if (!viewportAnimationState.currentHeight || immediate) {
        viewportAnimationState.currentHeight = targetH;
        viewportAnimationState.currentOffsetTop = targetY;
        viewportAnimationState.targetHeight = targetH;
        viewportAnimationState.targetOffsetTop = targetY;
        setViewportCssMetrics(targetH, targetY);
        window.clearTimeout(viewportAnimationResizeTimer);
        viewportAnimationResizeTimer = window.setTimeout(scheduleTerminalResize, 80);
        return;
    }

    viewportAnimationState.targetHeight = targetH;
    viewportAnimationState.targetOffsetTop = targetY;
    if (viewportAnimationRaf) return;

    const step = () => {
        viewportAnimationRaf = 0;
        const state = viewportAnimationState;
        const heightDelta = state.targetHeight - state.currentHeight;
        const offsetDelta = state.targetOffsetTop - state.currentOffsetTop;
        const stiffness = isSshKbLayoutOpen() ? 0.24 : 0.20;

        state.currentHeight += heightDelta * stiffness;
        state.currentOffsetTop += offsetDelta * stiffness;

        if (Math.abs(heightDelta) < 0.75 && Math.abs(offsetDelta) < 0.75) {
            state.currentHeight = state.targetHeight;
            state.currentOffsetTop = state.targetOffsetTop;
        }

        setViewportCssMetrics(state.currentHeight, state.currentOffsetTop);

        if (state.currentHeight !== state.targetHeight || state.currentOffsetTop !== state.targetOffsetTop) {
            viewportAnimationRaf = requestAnimationFrame(step);
        } else {
            requestTerminalAutoFollow('viewport-css-animation-old-step-settled');
            scheduleTerminalResize();
        }
    };

    viewportAnimationRaf = requestAnimationFrame(step);
    window.clearTimeout(viewportAnimationResizeTimer);
    viewportAnimationResizeTimer = window.setTimeout(() => {
        requestTerminalAutoFollow('viewport-css-animation-old-timer-settled');
        scheduleTerminalResize();
    }, isSshKbLayoutOpen() ? 360 : 420);
}

function setStableViewportHeight({ force = false } = {}) {
    if (isMobileStableInputMode()) {
        const height = Math.round(Math.max(
            getCssPxVar('--stable-vh') || 0,
            window.innerHeight || 0,
            document.documentElement.clientHeight || 0,
            window.screen?.height ? Math.min(window.screen.height, window.screen.width || window.screen.height) : 0,
        ));
        if (height > 0) {
            document.documentElement.style.setProperty('--stable-vh', `${height}px`);
            document.documentElement.style.setProperty('--visual-vh', `${height}px`);
            document.documentElement.style.setProperty('--visual-offset-top', '0px');
        }
        return;
    }
    if (embeddedMode) {
        document.documentElement.style.setProperty('--stable-vh', '100vh');
        document.documentElement.style.setProperty('--visual-vh', '100vh');
        document.documentElement.style.setProperty('--visual-offset-top', '0px');
        document.documentElement.style.setProperty('--keyboard-inset', '0px');
        document.documentElement.classList.remove('ssh-kb-open', 'viewport-updating');
        return;
    }
    const { keyboardOpen } = getViewportKeyboardMetrics();
    if (!force && keyboardOpen) return;
    const height = Math.round(Math.max(
        window.innerHeight || 0,
        document.documentElement.clientHeight || 0,
        !keyboardOpen && window.visualViewport ? window.visualViewport.height || 0 : 0,
    ));
    if (height > 0) {
        document.documentElement.style.setProperty('--stable-vh', `${height}px`);
        if (!keyboardOpen) {
            document.documentElement.style.setProperty('--keyboard-inset', '0px');
            document.documentElement.classList.remove('ssh-kb-open');
            animateViewportCssMetrics(height, 0, { immediate: force });
        }
    }
}

setStableViewportHeight({ force: true });

// ---------- 主题管理 ----------
const TERMINAL_THEME_OVERRIDE_KEY = 'zephyr-terminal-theme-override';
function hasTerminalThemeOverride() {
    const saved = localStorage.getItem(TERMINAL_THEME_OVERRIDE_KEY);
    return saved === 'light' || saved === 'dark';
}
function getSystemTheme() { return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; }
function getPreferredTheme() {
    const terminalOverride = localStorage.getItem(TERMINAL_THEME_OVERRIDE_KEY);
    if (terminalOverride === 'light' || terminalOverride === 'dark') return terminalOverride;
    const saved = localStorage.getItem('zephyr-theme');
    if (saved === 'light' || saved === 'dark') return saved;
    const appearanceTheme = terminalAppearance?.theme;
    if (terminalAppearance?.autoThemeEnabled === false && (appearanceTheme === 'light' || appearanceTheme === 'dark')) return appearanceTheme;
    return getSystemTheme();
}
function applyTheme(theme, { persist = false, terminalOverride = false } = {}) {
    if (document.documentElement.getAttribute('data-theme') !== theme) {
        document.documentElement.classList.add('theme-transitioning');
        window.clearTimeout(applyTheme._transitionTimer);
        applyTheme._transitionTimer = window.setTimeout(() => {
            document.documentElement.classList.remove('theme-transitioning');
        }, 300);
    }
    document.documentElement.setAttribute('data-theme', theme);
    applyZephyrColorScheme(terminalAppearance || {}, { theme, page: 'terminal' });
    applyTerminalAppearance(terminalAppearance || {});
    if (terminalOverride) localStorage.setItem(TERMINAL_THEME_OVERRIDE_KEY, theme);
    else if (persist) localStorage.setItem('zephyr-theme', theme);
    themeToggle.textContent = theme === 'dark' ? '☀️' : '🌙';
}
applyTheme(getPreferredTheme());

function normalizeTerminalHexColor(value = '') {
    return /^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value).toLowerCase() : '';
}
function invertTerminalHexColor(value = '') {
    const hex = normalizeTerminalHexColor(value);
    if (!hex) return '';
    const n = parseInt(hex.slice(1), 16);
    const r = 255 - ((n >> 16) & 255);
    const g = 255 - ((n >> 8) & 255);
    const b = 255 - (n & 255);
    return `#${[r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}
function resolveTerminalFontColors(appearance = {}) {
    const colors = appearance.terminalFontColors || {};
    const dark = normalizeTerminalHexColor(colors.dark || appearance.terminalFontColor || '');
    const light = normalizeTerminalHexColor(colors.light || '') || (dark ? invertTerminalHexColor(dark) : '');
    return { dark, light };
}
function resolveTerminalSolidBgColors(appearance = {}) {
    const colors = appearance.terminalSolidBgColors || appearance.terminalBgColors || {};
    const dark = normalizeTerminalHexColor(colors.dark || '');
    const light = normalizeTerminalHexColor(colors.light || '') || (dark ? invertTerminalHexColor(dark) : '');
    return { dark, light };
}
function resolveTerminalSelectionColors(appearance = {}) {
    const sel = appearance.terminalSelection || {};
    const bgIn = sel.bg || {};
    const fgIn = sel.fg || {};
    const bgDark = normalizeTerminalHexColor(bgIn.dark || sel.bgDark || '');
    const bgLight = normalizeTerminalHexColor(bgIn.light || sel.bgLight || '') || bgDark;
    const fgDark = normalizeTerminalHexColor(fgIn.dark || sel.fgDark || '');
    const fgLight = normalizeTerminalHexColor(fgIn.light || sel.fgLight || '') || fgDark;
    return { bg: { dark: bgDark, light: bgLight }, fg: { dark: fgDark, light: fgLight } };
}
function isWtermLightTheme(themeAttr = '') {
    const theme = themeAttr || document.documentElement.getAttribute('data-wterm-theme') || getPreferredWtermTheme();
    return theme === 'light' || theme === 'custom-light';
}
function currentTerminalFontColor(appearance = terminalAppearance) {
    const colors = resolveTerminalFontColors(appearance || {});
    return isWtermLightTheme() ? (colors.light || colors.dark) : colors.dark;
}
function currentTerminalSolidBg(appearance = terminalAppearance) {
    const colors = resolveTerminalSolidBgColors(appearance || {});
    return isWtermLightTheme() ? (colors.light || colors.dark) : colors.dark;
}
function currentTerminalSelection(appearance = terminalAppearance) {
    const sel = resolveTerminalSelectionColors(appearance || {});
    const light = isWtermLightTheme();
    return {
        bg: light ? (sel.bg.light || sel.bg.dark) : sel.bg.dark,
        fg: light ? (sel.fg.light || sel.fg.dark) : sel.fg.dark,
    };
}
/** Solid hex → rgba for ::selection background (wterm uses DOM selection). */
function terminalHexToRgba(hex, alpha = 0.28) {
    const raw = normalizeTerminalHexColor(hex);
    if (!raw) return '';
    const n = parseInt(raw.slice(1), 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    const a = Math.max(0, Math.min(1, Number(alpha) || 0));
    return `rgba(${r},${g},${b},${a})`;
}
function applyTerminalAppearance(appearance = {}) {
    terminalAppearance = appearance || {};
    const root = document.documentElement;
    const bg = terminalAppearance.terminalBackground || {};
    const hasBg = (bg.type === 'upload' || bg.type === 'url') && bg.url;
    const safeUrl = String(bg.url || '').replace(/"/g, '%22');
    if (hasBg) {
        root.style.setProperty('--wterm-custom-bg-image', `url("${safeUrl}")`);
        root.style.setProperty('--wterm-custom-bg-size', bg.fit || 'cover');
        const bgOpacity = Math.max(0, Math.min(1, Number(bg.opacity ?? 0.35)));
        root.style.setProperty('--wterm-custom-bg-opacity', String(bgOpacity));
        root.style.setProperty('--wterm-custom-bg-overlay', String(1 - bgOpacity));
        root.style.setProperty('--wterm-custom-bg-overlay-percent', `${Math.round((1 - bgOpacity) * 100)}%`);
        root.style.setProperty('--wterm-custom-bg-overlay-dark', `rgba(10, 10, 10, ${1 - bgOpacity})`);
        root.style.setProperty('--wterm-custom-bg-overlay-light', `rgba(245, 245, 247, ${1 - bgOpacity})`);
        const bgBlur = Math.max(0, Number(bg.blur ?? 0));
        root.style.setProperty('--wterm-custom-bg-blur', `${bgBlur}px`);
    } else {
        root.style.removeProperty('--wterm-custom-bg-image');
        root.style.removeProperty('--wterm-custom-bg-size');
        root.style.removeProperty('--wterm-custom-bg-opacity');
        root.style.removeProperty('--wterm-custom-bg-overlay');
        root.style.removeProperty('--wterm-custom-bg-overlay-percent');
        root.style.removeProperty('--wterm-custom-bg-overlay-dark');
        root.style.removeProperty('--wterm-custom-bg-overlay-light');
        root.style.removeProperty('--wterm-custom-bg-blur');
    }
    const fontColor = currentTerminalFontColor(terminalAppearance);
    if (fontColor) {
        root.style.setProperty('--wterm-custom-fg', fontColor);
        root.style.setProperty('--wterm-fg', fontColor);
        root.style.setProperty('--term-fg', fontColor);
        root.setAttribute('data-wterm-font-custom', '1');
    } else {
        root.style.removeProperty('--wterm-custom-fg');
        // Do not strip --wterm-fg permanently; theme CSS owns it when no custom font.
        root.style.removeProperty('--wterm-fg');
        root.style.removeProperty('--term-fg');
        root.removeAttribute('data-wterm-font-custom');
    }

    // Solid canvas background — all data-wterm-theme modes (default/light/custom-*).
    // wterm DOM paints default cells with transparent bg → container uses --wterm-bg.
    const solidBg = currentTerminalSolidBg(terminalAppearance);
    if (solidBg) {
        root.style.setProperty('--wterm-custom-solid-bg', solidBg);
        root.style.setProperty('--wterm-bg', solidBg);
        root.style.setProperty('--term-bg', solidBg);
        root.setAttribute('data-wterm-solid-bg', '1');
        // When image bg is also on, build overlay from solid color instead of fixed black/white.
        if (hasBg) {
            const bgOpacity = Math.max(0, Math.min(1, Number((terminalAppearance.terminalBackground || {}).opacity ?? 0.35)));
            const overlayA = 1 - bgOpacity;
            root.style.setProperty('--wterm-custom-bg-overlay-from-solid', terminalHexToRgba(solidBg, overlayA) || solidBg);
        } else {
            root.style.removeProperty('--wterm-custom-bg-overlay-from-solid');
        }
    } else {
        root.style.removeProperty('--wterm-custom-solid-bg');
        root.style.removeProperty('--wterm-custom-bg-overlay-from-solid');
        root.removeAttribute('data-wterm-solid-bg');
        // Let CSS theme vars reclaim --wterm-bg (inline style would pin it).
        root.style.removeProperty('--wterm-bg');
        root.style.removeProperty('--term-bg');
    }

    // Selection: DOM ::selection (see FREEZE/XTERM_DOM_STACK — wterm DOM is paint/selection shell).
    // Not xterm self-drawn selection; CSS --wterm-selection is the correct hook.
    const sel = currentTerminalSelection(terminalAppearance);
    if (sel.bg || sel.fg) {
        root.setAttribute('data-wterm-selection-custom', '1');
        if (sel.bg) {
            const fill = terminalHexToRgba(sel.bg, isWtermLightTheme() ? 0.28 : 0.32) || sel.bg;
            root.style.setProperty('--wterm-selection', fill);
            root.style.setProperty('--wterm-selection-solid', sel.bg);
        } else {
            root.style.removeProperty('--wterm-selection');
            root.style.removeProperty('--wterm-selection-solid');
        }
        if (sel.fg) {
            root.style.setProperty('--wterm-selection-fg', sel.fg);
        } else {
            root.style.removeProperty('--wterm-selection-fg');
        }
    } else {
        root.removeAttribute('data-wterm-selection-custom');
        root.style.removeProperty('--wterm-selection');
        root.style.removeProperty('--wterm-selection-solid');
        root.style.removeProperty('--wterm-selection-fg');
    }
}

function getPreferredWtermTheme() {
    const saved = localStorage.getItem('zephyr-wterm-theme');
    return saved === 'light' ? 'light' : 'default';
}

function hasCustomTerminalAppearance() {
    const bg = terminalAppearance?.terminalBackground || {};
    const colors = resolveTerminalFontColors(terminalAppearance || {});
    const solid = resolveTerminalSolidBgColors(terminalAppearance || {});
    const sel = resolveTerminalSelectionColors(terminalAppearance || {});
    return !!(
        ((bg.type === 'upload' || bg.type === 'url') && bg.url)
        || colors.dark || colors.light
        || solid.dark || solid.light
        || sel.bg.dark || sel.bg.light || sel.fg.dark || sel.fg.light
    );
}

function applyWtermTheme(theme) {
    const customTerm = hasCustomTerminalAppearance();
    const requested = theme === 'light' ? 'light' : 'default';
    const normalized = customTerm ? `custom-${requested}` : requested;
    const changed = document.documentElement.getAttribute('data-wterm-theme') !== normalized;
    if (changed) {
        document.documentElement.classList.add('wterm-theme-transitioning');
        terminalContainer?.classList.remove('wterm-theme-animating');
        wtermThemeToggle?.classList.remove('switching');
        void terminalContainer?.offsetWidth;
        terminalContainer?.classList.add('wterm-theme-animating');
        wtermThemeToggle?.classList.add('switching');
        window.clearTimeout(applyWtermTheme._transitionTimer);
        applyWtermTheme._transitionTimer = window.setTimeout(() => {
            document.documentElement.classList.remove('wterm-theme-transitioning');
            terminalContainer?.classList.remove('wterm-theme-animating');
            wtermThemeToggle?.classList.remove('switching');
        }, 460);
    }
    document.documentElement.setAttribute('data-wterm-theme', normalized);
    localStorage.setItem('zephyr-wterm-theme', requested);
    if (wtermThemeToggle) {
        wtermThemeToggle.textContent = customTerm
            ? (requested === 'light' ? t('终端: 自定义 Light') : t('终端: 自定义'))
            : (requested === 'light' ? t('终端: Light') : t('终端: 默认'));
        wtermThemeToggle.classList.toggle('active', requested === 'light' || customTerm);
        wtermThemeToggle.setAttribute('aria-pressed', requested === 'light' || customTerm ? 'true' : 'false');
    }
    try { term?.setOption?.('theme', requested === 'light' ? 'light' : 'default'); } catch (_) {}
    applyTerminalAppearance(terminalAppearance || {});
    scheduleTerminalScrollbarUpdate();
}

applyWtermTheme(getPreferredWtermTheme());
wtermThemeToggle?.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-wterm-theme');
    const currentMode = current === 'light' || current === 'custom-light' ? 'light' : 'default';
    applyWtermTheme(currentMode === 'light' ? 'default' : 'light');
});

themeToggle.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    applyTheme(current === 'dark' ? 'light' : 'dark', { terminalOverride: true });
});

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (!localStorage.getItem('zephyr-theme')) {
        applyTheme(e.matches ? 'dark' : 'light');
    }
});

window.addEventListener('message', (e) => {
    if (e.data?.source !== 'zephyr-app') return;
    if (e.data.type === 'restore-workspace-state') {
        pendingWorkspaceRestoreState = e.data.state && typeof e.data.state === 'object' ? e.data.state : null;
        applyTerminalWorkspaceState();
        return;
    }
    if (e.data.type === 'notes-enabled') {
        applyNotesFeatureEnabled(!!e.data.enabled);
        return;
    }
    if (e.data.type === 'theme-change' && ['light', 'dark'].includes(e.data.theme)) {
        if (e.data.appearance) terminalAppearance = e.data.appearance || {};
        applyZephyrColorScheme(terminalAppearance || {}, { theme: e.data.theme, page: 'terminal' });
        applyTerminalAppearance(terminalAppearance || {});
        applyWtermTheme(getPreferredWtermTheme());
        if (!hasTerminalThemeOverride()) applyTheme(e.data.theme);
        requestStableTerminalLayout('parent-theme-change', { includeResize: false });
    }
    if ((e.data.type === 'terminal-settings' || e.data.terminal) && e.data.terminal && Object.prototype.hasOwnProperty.call(e.data.terminal, 'allowLigatures')) {
        applyTerminalLigatures(!!e.data.terminal.allowLigatures);
    }
    if (e.data.type === 'focus-terminal') {
        requestStableTerminalLayout('parent-focus-terminal', { includeResize: true, focus: true });
        if (isMobileStableInputMode() && (terminalAutoFollowEnabled || mobileStableLastBottomIntent || isMobileStableAtVisualBottom())) {
            ensureTerminalSurface()?.pinCursorAboveChrome?.('parent-focus-terminal', { force: true });
        }
    }
    if (e.data.type === 'reconnect-terminal') {
        reconnectBtn?.click?.();
    }
    if (e.data.type === 'ai-terminal-toolbar') {
        const controls = { file: fileBtn, info: infoBtn, docker: dockerBtn, snippet: snippetBtn, shortcut: shortcutBtn, copy: copyBtn, paste: pasteBtn, theme: themeToggle, 'wterm-theme': wtermThemeToggle, reconnect: reconnectBtn, disconnect: disconnectBtn };
        const btn = controls[String(e.data.control || '')];
        if (btn) btn.click?.();
        else showToast(`未知 AI 工具栏动作：${e.data.control || ''}`, 'error');
        return;
    }
    if (e.data.type === 'ai-terminal-send-input') {
        const text = String(e.data.text || '');
        cmdInput.value = text;
        resizeCommandInput();
        cmdInput.focus?.();
        if (e.data.run !== false) sendCommand();
        return;
    }
    if (e.data.type === 'shared-clipboard-text') {
        const text = String(e.data.text || '');
        if (text) {
            sendData(prepareTerminalPastePayload(text), { source: 'shared-clipboard-text', forceFollow: true, applyModifiers: false });
            showToast(`已粘贴跨窗口文本 ${text.length} 字符`, 'success');
        }
        return;
    }
    if (e.data.type === 'shared-file-clipboard-available') {
        handleSharedFileClipboardAvailable(e.data.files || [], String(e.data.sourceTabId || ''), String(e.data.sourcePage || ''));
        return;
    }
    if (e.data.type === 'shared-file-clipboard-data') {
        if (e.data.error) showToast(`跨窗口文件读取失败：${e.data.error}`, 'error');
        else uploadSharedClipboardFiles(e.data.files || []);
        return;
    }
    if (e.data.type === 'shared-file-clipboard-read') {
        /* Another tab requests actual file data. Instead of reading entire
         * files into base64 (OOMs on large files), generate SFTP download
         * tokens and return server-side URLs for streaming download. */
        const requestId = String(e.data.requestId || '');
        const requestedFiles = Array.from(e.data.files || []);
        const respondFiles = [];

        (async () => {
            for (const f of requestedFiles) {
                if (!f.remotePath && !f.path) continue;
                const remotePath = f.remotePath || f.path;
                try {
                    const tokenPromise = new Promise((resolve, reject) => {
                        const handler = (ev) => {
                            let msg;
                            try { msg = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data; } catch { return; }
                            if (msg.type === 'sftp-download-ready' && msg.path === remotePath) {
                                wsConnection.removeEventListener('message', handler);
                                resolve(msg);
                            } else if (msg.type === 'sftp-download' && msg.path === remotePath && msg.error) {
                                wsConnection.removeEventListener('message', handler);
                                reject(new Error(msg.error));
                            }
                        };
                        wsConnection.addEventListener('message', handler);
                        wsConnection.send(JSON.stringify({ type: 'sftp-download', path: remotePath }));
                        setTimeout(() => { wsConnection.removeEventListener('message', handler); reject(new Error('timeout')); }, 30000);
                    });
                    const dlInfo = await tokenPromise;
                    respondFiles.push({ name: f.name || remotePath.split('/').pop(), size: Number(dlInfo.size) || 0, transitUrl: dlInfo.url, path: remotePath });
                } catch (err) {
                    console.warn('[shared-file-clipboard-read] failed for', remotePath, err.message);
                }
            }
            window.parent?.postMessage?.({ source: 'zephyr-terminal', type: 'shared-file-clipboard-data', tabId: params?.tabId, requestId, files: respondFiles, error: '' }, '*');
        })();
        return;
    }
    if (e.data.type === 'reset-mobile-keyboard' || e.data.type === 'ssh-kb-reset') {
        // Parent geometry reset must NOT kill a live IME session. The old path
        // blurred the proxy on every layout tick → keyboard open/close loop.
        const active = document.activeElement;
        const imeAlive = !!(
            sshKb?.desiredOpen?.()
            || sshSoftKeyboard?.desiredOpen?.()
            || active === mobileImeProxy
            || active === cmdInput
            || cmdOverlayMode
            || (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT' || active.isContentEditable))
        );
        if (imeAlive) {
            logTerminalLayoutDiagnostics?.('parent-reset-ignored-ime-alive', { reason: e.data.reason || '' });
            if (cmdOverlayMode || active === cmdInput) enterCmdOverlayMode('parent-reset-ignored');
            return;
        }
        const kb = ensureSshKeyboard();
        if (kb) {
            kb.handleParentMessage({ ...e.data, source: 'zephyr-app', type: 'ssh-kb-reset' });
        } else if (sshSoftKeyboard) {
            sshSoftKeyboard.reset(`parent-reset:${e.data.reason || ''}`);
        } else {
            try { mobileImeProxy?.blur?.(); } catch (_) {}
            try { cmdInput?.blur?.(); } catch (_) {}
            finalizeKeyboardClose({ force: true });
        }
        return;
    }
    if (e.data.type === 'keyboard-freeze' || e.data.type === 'ssh-kb-freeze') {
        const settleMs = Math.max(300, Math.min(2500, Number(e.data.settleMs) || 1000));
        parentKeyboardResizeFreezeUntil = e.data.frozen ? Date.now() + settleMs : 0;
        ensureSshKeyboard()?.handleParentMessage?.({
            source: 'zephyr-app',
            type: 'ssh-kb-freeze',
            frozen: !!e.data.frozen,
            settleMs,
            reason: e.data.reason || '',
        });
        if (isTouchKeyboardDevice()) {
            if (e.data.frozen) stabilizeWTermAfterViewportOnlyChange(`parent-keyboard-freeze:${e.data.reason || ''}`);
            else scheduleKeyboardCloseFit(`parent-keyboard-freeze-release:${e.data.reason || ''}`, 420);
        }
        logTerminalLayoutDiagnostics('parent-keyboard-freeze-message', { payload: e.data, freezeUntil: parentKeyboardResizeFreezeUntil });
        scheduleTerminalScrollbarUpdate();
        if (!e.data.frozen) window.setTimeout(() => repairOversizedWTermRows(`keyboard-freeze-release:${e.data.reason || ''}`, { force: false }), 180);
        return;
    }
    if (e.data.type === 'keyboard-overlap') {
        // Parent-shell-managed: parent cropped iframe to keyboard top.
        // Child page stays height 100% (inset 0). Only toggle ssh-kb-open for chrome CSS.
        const parentShellManaged = !!e.data.parentShellManaged;
        const overlap = Math.max(0, Math.round(Number(e.data.keyboardOverlap) || 0));
        const parentSaysOpen = !!e.data.keyboardOpen;
        const heightSource = String(e.data.heightSource || '');
        const awaitingPhysical = heightSource === 'await-physical';
        const open = parentShellManaged ? parentSaysOpen : (parentSaysOpen && overlap >= 48);
        if (isCmdOverlayMode()) {
            applyMobileStableKeyboardInset(0, false, 'parent-overlap:cmd-frozen');
            return;
        }
        const kb = ensureSshKeyboard();

        if (open) {
            // F1 CRITICAL: parentShellManaged means parent already cropped the iframe
            // to the keyboard top. Child page height must stay 100% with inset=0.
            // NEVER feed shellH into child --ssh-kb-inset (shellH is the visible
            // terminal height, often 400+, which double-shrinks the page and makes
            // the bottom bar fly up and cover the whole terminal).
            if (parentShellManaged || e.data.parentShellManaged) {
                setSshKbParentShellManaged(true, `parent-overlap:${e.data.reason || ''}`);
            }
            writeSshKbPageGeometry(0, true, { fromParent: true });
            // Keep cache at 0 so applyFacadeChrome / getSshKbInset cannot re-inflate.
            _sshKbInsetCache = 0;
            _sshKbLayoutOpenCache = true;
            _sshKbParentGeomAt = Date.now();
            try { updateTerminalInputPanelMetrics(); } catch (_) {}
            if (!awaitingPhysical) {
                try {
                    // Physical confirm for intent only — use real keyboard height
                    // (parentInset / screen keyboard), NEVER shellH (cropped frame h).
                    // NOTE: this updates intent.inset for open/close state only;
                    // writeSshKbPageGeometry must still force child CSS inset to 0.
                    const physicalInset = Math.max(
                        0,
                        Math.round(Number(e.data.parentInset) || 0),
                    );
                    if (physicalInset >= 80) {
                        kb?._intent?.syncViewport?.({
                            inset: physicalInset,
                            hasEditableFocus: true,
                            now: Date.now(),
                        });
                    }
                } catch (_) {}
                scheduleSshKbGeometryFit(`parent-overlap:${e.data.reason || ''}:open`, true, true);
            }
            logTerminalLayoutDiagnostics?.('child:parent-shell', {
                parentShellManaged,
                exact,
                parentSaysOpen,
                awaitingPhysical,
                shellH: e.data.shellH,
                heightSource,
                keyboardTop: e.data.keyboardTop,
            });
        } else {
            // Parent says closed. Ignore while awaiting first physical or proxy focused
            // (Android VV flicker mid-rise must not blur IME).
            const proxyFocused = !!(
                document.activeElement === mobileImeProxy
                || document.activeElement === cmdInput
                || document.activeElement?.classList?.contains?.('mobile-terminal-ime-proxy')
            );
            if (awaitingPhysical || (kb?.desiredOpen?.() && proxyFocused)) {
                return;
            }
            forceClearSshKbShell(`parent-overlap:${e.data.reason || ''}:close`);
            try {
                kb?._intent?.syncViewport?.({
                    inset: 0,
                    hasEditableFocus: false,
                    now: Date.now(),
                });
            } catch (_) {}
            if (kb?.desiredOpen?.()) {
                try { kb.close('parent-physical-close', { force: false, blurCmd: false }); } catch (_) {}
            }
        }
        return;
    }
 
    if (e.data.type === 'layout-stabilize') {
        const reason = e.data.reason || 'parent-layout-stabilize';
        // 如果 parent 发来了 keyboard 指标（parent 的 visualViewport 可靠检测键盘打开），
        // 即使 iframe 自身因 overlays-content 无法检测，也应用正确的键盘状态。
        if (e.data.keyboardOpen !== undefined) {
            const parentKeyboardOpen = !!e.data.keyboardOpen;
            const parentInset = Math.max(0, Math.round(Number(e.data.keyboardInset) || 0));
            // Feed parent metrics into facade physical state — never parallel applyInset.
            const kb = ensureSshKeyboard();
            if (kb) {
                const hasFocus = !!(
                    document.activeElement === mobileImeProxy
                    || document.activeElement === cmdInput
                    || cmdOverlayMode
                );
                if (parentKeyboardOpen && parentInset >= 80) {
                    kb._intent?.syncViewport?.({
                        inset: parentInset,
                        hasEditableFocus: hasFocus || kb.desiredOpen?.(),
                        now: Date.now(),
                    });
                } else if (!parentKeyboardOpen) {
                    const proxyFocused = !!(
                        document.activeElement === mobileImeProxy
                        || document.activeElement === cmdInput
                        || hasFocus
                    );
                    if (!(kb.desiredOpen?.() && proxyFocused)) {
                        kb._intent?.syncViewport?.({ inset: 0, hasEditableFocus: false, now: Date.now() });
                        if (kb.desiredOpen?.() && !proxyFocused) {
                            try { kb.close('parent-layout-close', { force: false, blurCmd: false }); } catch (_) {}
                        }
                    }
                }
                applyFacadeChrome(`parent-layout:${reason}`);
            } else if (parentKeyboardOpen && parentInset >= 80) {
                writeSshKbPageGeometry(0, true, { fromParent: true });
            } else if (!parentKeyboardOpen && isSshKbLayoutOpen()) {
                if (!document.documentElement.classList.contains('ssh-kb-open')) {
                    finalizeKeyboardClose({ force: true });
                }
            }
        }
 
        const keyboardRelated = isTouchKeyboardDevice() && (
            String(reason).includes('keyboard')
            || String(reason).includes('viewport')
            || String(reason).includes('visual')
        );
        logTerminalLayoutDiagnostics('parent-layout-stabilize-message', { payload: e.data });
        if (keyboardRelated) {
            // Mobile stable mode: keyboard open/close is only bottom clipping in the parent.
            // Do not resize, repair, flush, or scroll WTerm here; those cause the black blank
            // area and the up/down jump at the bottom. Real input paths call
            // ensureMobileStableCursorVisible() and will scroll only if the cursor is covered.
            if (isMobileStableInputMode()) {
                if (terminalAutoFollowEnabled || mobileStableLastBottomIntent || isMobileStableAtVisualBottom()) {
                    ensureTerminalSurface()?.pinCursorAboveChrome?.(`parent-layout:${reason}:stable`, { force: true });
                } else {
                    scheduleTerminalScrollbarUpdate();
                }
                return;
            }
            stabilizeWTermAfterViewportOnlyChange(`keyboard-related:${reason}`);
            scheduleTerminalScrollbarUpdate();
            window.setTimeout(() => repairOversizedWTermRows(`keyboard-related:${reason}`, { force: false }), 900);
            return;
        }
        requestStableTerminalLayout(reason, { includeResize: true, focus: !!e.data.focus });
    }
});

// ---------- 终端字体缩放 ----------
function clampTerminalFontSize(size) {
    return Math.min(TERMINAL_FONT_MAX, Math.max(TERMINAL_FONT_MIN, Math.round(size)));
}

function getStoredTerminalFontSize() {
    const saved = Number(localStorage.getItem(TERMINAL_FONT_STORAGE_KEY));
    if (Number.isFinite(saved)) return clampTerminalFontSize(saved);
    // Mobile defaults to larger font
    return isTouchKeyboardDevice() ? TERMINAL_FONT_MOBILE_DEFAULT : terminalFontSize;
}

function updateFontSizeButtons() {
    if (fontDecreaseBtn) fontDecreaseBtn.disabled = terminalFontSize <= TERMINAL_FONT_MIN;
    if (fontIncreaseBtn) fontIncreaseBtn.disabled = terminalFontSize >= TERMINAL_FONT_MAX;
}

function getTerminalCharMetrics() {
    // Single source of truth: WTerm.getCellMetrics() (measured + CSS-var written).
    // Never Math.max multi-source — that inflated rowHeight, under-counted rows,
    // and made the cursor pin / resize loop fight itself.
    try {
        const m = term?.getCellMetrics?.();
        if (m && Number.isFinite(m.charWidth) && m.charWidth > 0
            && Number.isFinite(m.rowHeight) && m.rowHeight > 0) {
            return { lineHeight: m.rowHeight, charWidth: m.charWidth };
        }
    } catch (_) {}
    try {
        const st = term?.getViewportState?.();
        if (st && Number.isFinite(st.rowHeight) && st.rowHeight > 0) {
            const cw = Number.isFinite(st.charWidth) && st.charWidth > 0
                ? st.charWidth
                : (Number(term?.viewport?.charWidth) || 0);
            if (cw > 0) return { lineHeight: st.rowHeight, charWidth: cw };
        }
    } catch (_) {}

    // Fallback only before term is ready.
    const root = getTerminalScrollElement?.() || wtermWrapper;
    const grid = wtermWrapper?.querySelector?.('.term-grid');
    const computed = getComputedStyle(root || document.documentElement);
    const fontSize = terminalFontSize || parseFloat(computed.fontSize) || 14;
    const cssRowHeight = parseFloat(computed.getPropertyValue('--term-row-height')) || 0;
    const cssCellWidth = parseFloat(computed.getPropertyValue('--term-cell-width')) || 0;
    const existingRow = grid?.querySelector?.('.term-row, .term-scrollback-row');
    const existingRowHeight = existingRow?.getBoundingClientRect?.().height || 0;

    if (cssCellWidth > 0 && (cssRowHeight > 0 || existingRowHeight > 0)) {
        return {
            lineHeight: Math.max(1, existingRowHeight || cssRowHeight),
            charWidth: cssCellWidth,
        };
    }

    const rowProbe = document.createElement('div');
    rowProbe.className = 'term-row zephyr-measure-row';
    rowProbe.style.position = 'absolute';
    rowProbe.style.visibility = 'hidden';
    rowProbe.style.pointerEvents = 'none';
    rowProbe.style.whiteSpace = 'pre';
    const span = document.createElement('span');
    span.textContent = 'W'.repeat(32);
    span.style.whiteSpace = 'pre';
    span.style.fontVariantLigatures = 'none';
    rowProbe.appendChild(span);
    (grid || root || document.body).appendChild(rowProbe);
    const rowProbeRect = rowProbe.getBoundingClientRect();
    const spanRect = span.getBoundingClientRect();
    rowProbe.remove();

    const lineHeight = Math.max(1, existingRowHeight || rowProbeRect.height || cssRowHeight || fontSize * 1.2);
    const charWidth = Math.max(1, (spanRect.width > 0 ? spanRect.width / 32 : 0) || cssCellWidth || fontSize * 0.6);
    return { lineHeight, charWidth };
}

function getMeasuredTerminalSize() {
    normalizeWTermContainerLayout('measure-terminal-size');
    const rect = getStableTerminalSurfaceRect();
    const style = getComputedStyle(wtermWrapper);
    const paddingX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
    const paddingY = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
    const { lineHeight, charWidth } = getTerminalCharMetrics();
    let effectiveHeight = Math.max(0, rect.height - paddingY);
    const effectiveWidth = Math.max(0, rect.width - paddingX);
    const measuredRows = Math.max(2, Math.floor(effectiveHeight / Math.max(1, lineHeight)));
    const measuredCols = Math.max(20, Math.floor(effectiveWidth / Math.max(1, charWidth)));
    const rows = Math.min(200, measuredRows);
    const cols = Math.min(500, measuredCols);
    return {
        cols,
        rows,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        effectiveWidth: Math.round(effectiveWidth),
        effectiveHeight: Math.round(effectiveHeight),
        lineHeight,
        charWidth,
    };
}

function getInitialTerminalSize() {
    const measured = getMeasuredTerminalSize();
    return {
        cols: Math.max(20, Math.floor(measured.cols || Number(term?.cols || 80))),
        rows: Math.max(2, Math.floor(measured.rows || Number(term?.rows || 24))),
    };
}

function isEmbeddedTerminalFrameVisible() {
    if (!embeddedMode) return true;
    try {
        const frame = window.frameElement;
        if (!frame) return true;
        const rect = frame.getBoundingClientRect();
        const style = window.parent?.getComputedStyle?.(frame);
        const parentWidth = window.parent?.innerWidth || rect.right;
        const parentHeight = window.parent?.innerHeight || rect.bottom;
        return rect.width >= TERMINAL_MIN_RESIZE_WIDTH
            && rect.height >= TERMINAL_MIN_RESIZE_HEIGHT
            && rect.right > 0
            && rect.bottom > 0
            && rect.left < parentWidth
            && rect.top < parentHeight
            && style?.display !== 'none'
            && style?.visibility !== 'hidden';
    } catch (_) {
        return true;
    }
}

function normalizeWTermContainerLayout(reason = 'normalize-layout') {
    if (!wtermWrapper) return;
    // @wterm/dom 在 autoResize:false 时会 _lockHeight()，给根元素写入 rows*rowHeight 的 inline height。
    // 该根元素在本项目中同时是 flex 滚动容器；页面/标签隐藏、分屏比例变化后，旧 inline height 会污染下一次测量，
    // 造成“大量空行”或“只剩一行高”。这里强制恢复为由外层 flex/viewport 决定尺寸，模拟 xterm.js FitAddon 的容器语义。
    if (wtermWrapper.style.height) wtermWrapper.style.height = '';
    if (wtermWrapper.style.minHeight) wtermWrapper.style.minHeight = '';
    if (wtermWrapper.style.maxHeight) wtermWrapper.style.maxHeight = '';
    wtermWrapper.style.flex = '1 1 auto';
    wtermWrapper.style.width = '100%';
    wtermWrapper.style.overflowY = 'auto';
    wtermWrapper.style.overflowX = 'hidden';
    logTerminalLayoutDiagnostics('wterm-layout:normalized-container', { reason });
}

function getStableTerminalSurfaceRect() {
    normalizeWTermContainerLayout('measure-surface');
    const wrapperRect = wtermWrapper?.getBoundingClientRect?.();
    const containerRect = terminalContainer?.getBoundingClientRect?.();
    if (wrapperRect && wrapperRect.width >= TERMINAL_MIN_RESIZE_WIDTH && wrapperRect.height >= TERMINAL_MIN_RESIZE_HEIGHT) return wrapperRect;
    if (containerRect && containerRect.width >= TERMINAL_MIN_RESIZE_WIDTH && containerRect.height >= TERMINAL_MIN_RESIZE_HEIGHT) return containerRect;
    return wrapperRect || containerRect || { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
}

function repairWTermLayoutAfterVisibilityChange(reason = 'layout-repair', { sendResize = true, follow = null } = {}) {
    if (!term || !wtermWrapper || document.visibilityState !== 'visible' || !isEmbeddedTerminalFrameVisible()) return false;
    if (isTouchKeyboardDevice() && isMobileKeyboardActiveOrSettling() && !String(reason).includes(':settled-fit')) {
        stabilizeWTermAfterViewportOnlyChange(`repair-suppressed:${reason}`);
        return false;
    }
    normalizeWTermContainerLayout(reason);
    const rect = getStableTerminalSurfaceRect();
    if (!rect || rect.width < TERMINAL_MIN_RESIZE_WIDTH || rect.height < TERMINAL_MIN_RESIZE_HEIGHT || wtermWrapper.offsetParent === null) {
        logTerminalLayoutDiagnostics('wterm-layout:repair-skipped-hidden-or-tiny', {
            reason,
            width: Math.round(rect?.width || 0),
            height: Math.round(rect?.height || 0),
        });
        return false;
    }
    const shouldFollow = follow ?? (terminalAutoFollowEnabled || isTerminalAtBottom(undefined, TERMINAL_XTERM_SCROLL_LOCK_THRESHOLD));
    const measured = getMeasuredTerminalSize();
    const cols = Math.max(20, measured.cols);
    const rows = Math.max(2, measured.rows);
    const changed = Number(term.cols ?? term._cols ?? 0) !== cols || Number(term.rows ?? term._rows ?? 0) !== rows;
    resizeWTermSafely(cols, rows, reason);
    repairOversizedWTermRows(`${reason}:oversized-check`, { force: false });
    normalizeWTermContainerLayout(`${reason}:after-resize`);
    try { term._scheduleRender?.(); } catch (_) {}
    if (sendResize && changed) sendTerminalResize(cols, rows, { reason, force: true });
    requestAnimationFrame(() => {
        normalizeWTermContainerLayout(`${reason}:raf`);
        const el = getTerminalScrollElement();
        if (el && !shouldFollow) writeTerminalScrollTop(el, Math.min(el.scrollTop, getTerminalMaxScroll(el)), `${reason}:clamp`, { pin: false });
        if (shouldFollow) requestTerminalAutoFollow(`${reason}:follow`);
        else scheduleTerminalScrollbarUpdate();
    });
    return true;
}

function repairOversizedWTermRows(reason = 'oversized-rows-repair', { force = false } = {}) {
    if (!term || !wtermWrapper || document.visibilityState !== 'visible' || !isEmbeddedTerminalFrameVisible()) return false;
    const forceStableFit = String(reason).includes(':settled-fit');
    if (!forceStableFit && shouldSuppressTerminalGridResize(reason)) return false;
    normalizeWTermContainerLayout(`${reason}:normalize`);
    const measured = getMeasuredTerminalSize();
    const currentRows = Number(term.rows ?? term._rows ?? term.options?.rows ?? 0);
    const currentCols = Number(term.cols ?? term._cols ?? term.options?.cols ?? 0);
    if (!currentRows || !measured.rows) return false;
    const currentPixelHeight = currentRows * measured.lineHeight;
    const allowedPixelHeight = measured.effectiveHeight * TERMINAL_OVERSIZED_ROWS_RATIO;
    const rowsTooLarge = currentRows > measured.rows + 2 && currentPixelHeight > allowedPixelHeight;
    const colsTooLarge = currentCols > measured.cols + 2;
    if (!rowsTooLarge && !colsTooLarge) return false;
    const nextRows = Math.max(2, measured.rows);
    const nextCols = Math.max(20, measured.cols);
    logTerminalLayoutDiagnostics('wterm-layout:oversized-rows-repair', {
        reason,
        currentRows,
        currentCols,
        nextRows,
        nextCols,
        currentPixelHeight: Math.round(currentPixelHeight),
        allowedPixelHeight: Math.round(allowedPixelHeight),
        effectiveHeight: measured.effectiveHeight,
        lineHeight: measured.lineHeight,
    });
    resizeWTermSafely(nextCols, nextRows, reason);
    sendTerminalResize(nextCols, nextRows, { reason, force: true });
    requestAnimationFrame(() => requestTerminalAutoFollow(`${reason}:follow`));
    return true;
}

function resizeWTermSafely(cols, rows, reason = 'safe-resize') {
    if (!term || !wtermWrapper) return false;
    const nextCols = Math.floor(Number(cols));
    const nextRows = Math.floor(Number(rows));
    if (!Number.isFinite(nextCols) || !Number.isFinite(nextRows) || nextCols < 20 || nextRows < 2) {
        logTerminalLayoutDiagnostics('wterm-layout:ignored-tiny-safe-resize', {
            reason,
            cols: nextCols,
            rows: nextRows,
        });
        return false;
    }

    const currentCols = Number(term.cols ?? term._cols ?? term.options?.cols ?? 0);
    const currentRows = Number(term.rows ?? term._rows ?? term.options?.rows ?? 0);
    // Soft keyboard must NOT change buffer rows/cols. CSS --ssh-kb-inset only
    // clips the visible shell; xterm keeps painting the same grid.
    const reasonText = String(reason || '');
    const keyboardDriven = /keyboard|viewport|visual|ime|ssh-kb|kb-flow|parent-overlap|soft-?kb/i.test(reasonText)
        || isSshKbLayoutOpen?.()
        || document.documentElement.classList.contains('ssh-kb-open');
    if (keyboardDriven && currentRows > 0 && nextRows < currentRows) {
        logTerminalLayoutDiagnostics('wterm-layout:blocked-kb-row-shrink', {
            reason: reasonText,
            currentRows,
            nextRows,
            currentCols,
            nextCols,
        });
        return false;
    }
 
try {
        if ((currentCols !== nextCols || currentRows !== nextRows) && typeof term.resize === 'function') {
            suppressWTermResizeEvent = true;
            try {
                term.resize(nextCols, nextRows);
            } finally {
                suppressWTermResizeEvent = false;
            }
        } else if (term.options) {
            term.options.cols = nextCols;
            term.options.rows = nextRows;
        }
        try { term.refresh?.(); } catch (_) {}
        rememberTerminalFitSnapshot(`${reason}:resizeWTermSafely`);
        normalizeWTermContainerLayout(`${reason}:resizeWTermSafely`);
        logTerminalLayoutDiagnostics('wterm-layout:safe-resized', {
            reason,
            cols: nextCols,
            rows: nextRows,
            previousCols: currentCols,
            previousRows: currentRows,
        });
        return true;
    } catch (err) {
        logTerminalLayoutDiagnostics('wterm-layout:safe-resize-failed', {
            reason,
            cols: nextCols,
            rows: nextRows,
            error: err?.message || String(err),
        });
        try { term.refresh?.(); } catch (_) {}
        return false;
    }
}

function invokeWTermLayoutRefresh(reason = 'layout-refresh') {
    if (!term || !wtermWrapper) return;
    const rect = wtermWrapper.getBoundingClientRect();
    if (rect.width < TERMINAL_MIN_RESIZE_WIDTH || rect.height < TERMINAL_MIN_RESIZE_HEIGHT) {
        logTerminalLayoutDiagnostics('wterm-layout:skipped-unstable-rect', {
            reason,
            width: Math.round(rect.width),
            height: Math.round(rect.height),
        });
        return;
    }

    const measured = getMeasuredTerminalSize();
    resizeWTermSafely(measured.cols, measured.rows, reason);

    logTerminalLayoutDiagnostics('wterm-layout:refreshed-safe', {
        reason,
        measuredCols: measured.cols,
        measuredRows: measured.rows,
        measuredWidth: measured.width,
        measuredHeight: measured.height,
    });
}

function requestStableTerminalLayout(reason = 'stable-layout', { includeResize = true, focus = false } = {}) {
    if (isTouchKeyboardDevice() && /keyboard|viewport|visual/.test(String(reason))) {
        scheduleTerminalScrollbarUpdate();
        return;
    }
    window.clearTimeout(requestStableTerminalLayout._coalesceTimer);
    requestStableTerminalLayout._pendingReason = reason;
    requestStableTerminalLayout._focus = requestStableTerminalLayout._focus || focus;
    requestStableTerminalLayout._coalesceTimer = window.setTimeout(() => {
        const runReason = requestStableTerminalLayout._pendingReason || reason;
        const shouldFocus = !!requestStableTerminalLayout._focus;
        requestStableTerminalLayout._pendingReason = '';
        requestStableTerminalLayout._focus = false;

        logTerminalLayoutDiagnostics('stable-layout:official-refresh', { reason: runReason, includeResize, focus: shouldFocus });
        // 仅在可见且尺寸稳定后刷新渲染/可视区；不要因父页面切换或 focus 主动滚到底。
        requestAnimationFrame(() => {
            if (includeResize) {
                if (isTouchKeyboardDevice() && isMobileKeyboardActiveOrSettling()) refreshTerminalAfterVisibilityRestore(runReason, { focus: shouldFocus });
                else scheduleTerminalResize(runReason, isTouchKeyboardDevice() ? 240 : 160);
            } else {
                refreshTerminalAfterVisibilityRestore(runReason, { focus: shouldFocus });
            }
            scheduleTerminalScrollbarUpdate();
            if (shouldFocus && !isTouchKeyboardDevice()) {
                try { term?.focus?.(); } catch (_) {}
            }
        });
    }, 24);
}

function sendTerminalResize(cols, rows, { reason = 'direct', force = false } = {}) {
    const allowDespiteKb = force
        || /force|orientation|font-size|xterm-fit|fit-raf|fit-settle|fit-late|kb-/.test(String(reason || ''));
    if (sshKb && !sshKb.allowResize?.(reason) && !allowDespiteKb) {
        logTerminalLayoutDiagnostics('send-resize:blocked-ssh-kb-gate', { reason, phase: sshKb.getPhase?.() });
        return false;
    }
    if (!wsConnection || wsConnection.readyState !== WebSocket.OPEN || !isConnected) return;
    const explicitCols = Math.floor(Number(cols));
    const explicitRows = Math.floor(Number(rows));

    if (!allowDespiteKb && shouldSuppressTerminalGridResize(reason)) {
        logTerminalLayoutDiagnostics('resize:ignored-mobile-viewport-settling', { reason, explicitCols, explicitRows, frozen: isTerminalViewportResizeFrozen() });
        if (isTouchKeyboardDevice()) stabilizeWTermAfterViewportOnlyChange(`send-resize-blocked:${reason}`);
        return;
    }

    if (reason === 'wterm-onResize') {
        // WTerm 的 ResizeObserver 在 iframe 被隐藏/最小化/父标签切换时会收到 0/1px 的瞬时尺寸。
        // ssh2 的 Channel#setWindow(rows, cols, height, width) 会立刻改变远端 PTY；
        // 如果把这些瞬时小尺寸发给后端，远端程序会按 1~几列重排，回来后就出现截图里的竖向破损。
        if (!Number.isFinite(explicitCols) || !Number.isFinite(explicitRows) || explicitCols < 20 || explicitRows < 2) {
            logTerminalLayoutDiagnostics('resize:ignored-invalid-wterm-size', {
                reason,
                explicitCols,
                explicitRows,
            });
            return;
        }
        const rect = wtermWrapper?.getBoundingClientRect?.();
        const visibleSurface = rect
            && rect.width >= TERMINAL_MIN_RESIZE_WIDTH
            && rect.height >= TERMINAL_MIN_RESIZE_HEIGHT
            && wtermWrapper?.offsetParent !== null
            && document.visibilityState === 'visible'
            && isEmbeddedTerminalFrameVisible();
        if (!visibleSurface) {
            logTerminalLayoutDiagnostics('resize:defer-hidden-wterm-size', {
                reason,
                explicitCols,
                explicitRows,
                rectWidth: Math.round(rect?.width || 0),
                rectHeight: Math.round(rect?.height || 0),
            });
            pendingTerminalResize.cols = explicitCols;
            pendingTerminalResize.rows = explicitRows;
            pendingTerminalResize.reason = reason;
            return;
        }
        window.clearTimeout(pendingTerminalResize.timer);
        pendingTerminalResize = { cols: explicitCols, rows: explicitRows, reason, timer: window.setTimeout(() => {
            if (!wsConnection || wsConnection.readyState !== WebSocket.OPEN || !isConnected) return;
            if (!isEmbeddedTerminalFrameVisible()) return;
            const freshRect = wtermWrapper?.getBoundingClientRect?.();
            if (!freshRect || freshRect.width < TERMINAL_MIN_RESIZE_WIDTH || freshRect.height < TERMINAL_MIN_RESIZE_HEIGHT || document.visibilityState !== 'visible') return;
            const measured = getMeasuredTerminalSize();
            if (Math.abs(measured.cols - explicitCols) > 1 || Math.abs(measured.rows - explicitRows) > 1) {
                logTerminalLayoutDiagnostics('resize:ignored-stale-wterm-size', { reason, explicitCols, explicitRows, measuredCols: measured.cols, measuredRows: measured.rows });
                return;
            }
            if (lastSentTerminalSize.cols === explicitCols && lastSentTerminalSize.rows === explicitRows && !force) return;
            lastSentTerminalSize = { cols: explicitCols, rows: explicitRows };
            wsConnection.send(JSON.stringify({ type: 'resize', rows: explicitRows, cols: explicitCols }));
            logTerminalLayoutDiagnostics('resize:sent', { reason, force, cols: explicitCols, rows: explicitRows });
        }, TERMINAL_RESIZE_DEBOUNCE_MS) };
        return;
    }

    if (reason === 'stable-visible-resize' || reason === 'resize-observer-stable' || reason === 'initial-visible-resize' || reason === 'pageshow-visible' || reason === 'visibility-visible' || reason === 'window-resize' || reason === 'parent-focus-terminal' || String(reason).startsWith('render-terminal-workspace') || String(reason).startsWith('switch-view-terminal') || String(reason).startsWith('terminal-window-morph')) {
        if (!Number.isFinite(explicitCols) || !Number.isFinite(explicitRows) || explicitCols < 20 || explicitRows < 2) return;
        const rect = wtermWrapper?.getBoundingClientRect?.();
        const visibleSurface = rect
            && rect.width >= TERMINAL_MIN_RESIZE_WIDTH
            && rect.height >= TERMINAL_MIN_RESIZE_HEIGHT
            && wtermWrapper?.offsetParent !== null
            && document.visibilityState === 'visible'
            && isEmbeddedTerminalFrameVisible();
        if (!visibleSurface) {
            logTerminalLayoutDiagnostics('resize:ignored-hidden-stable-size', { reason, explicitCols, explicitRows, rectWidth: Math.round(rect?.width || 0), rectHeight: Math.round(rect?.height || 0) });
            return;
        }
        if (isTouchKeyboardDevice() && isMobileKeyboardActiveOrSettling() && /keyboard|viewport|visual|resize-observer/.test(String(reason))) {
            logTerminalLayoutDiagnostics('resize:ignored-mobile-keyboard-settling', { reason, explicitCols, explicitRows });
            return;
        }
        const measured = getMeasuredTerminalSize();
        if (Math.abs(measured.cols - explicitCols) > 1 || Math.abs(measured.rows - explicitRows) > 1) {
            logTerminalLayoutDiagnostics('resize:ignored-stale-stable-size', { reason, explicitCols, explicitRows, measuredCols: measured.cols, measuredRows: measured.rows });
            return;
        }
        if (lastSentTerminalSize.cols === explicitCols && lastSentTerminalSize.rows === explicitRows && !force) return;
        lastSentTerminalSize = { cols: explicitCols, rows: explicitRows };
        wsConnection.send(JSON.stringify({ type: 'resize', rows: explicitRows, cols: explicitCols }));
        logTerminalLayoutDiagnostics('resize:sent', { reason, force, cols: explicitCols, rows: explicitRows });
        return;
    }

    const measured = getMeasuredTerminalSize();
    if (!isEmbeddedTerminalFrameVisible()) return;
    if (!force && (measured.width < TERMINAL_MIN_RESIZE_WIDTH || measured.height < TERMINAL_MIN_RESIZE_HEIGHT)) {
        logTerminalLayoutDiagnostics('resize:skipped-unstable-rect', {
            reason,
            width: measured.width,
            height: measured.height,
        });
        return;
    }

    const nextCols = measured.cols;
    const nextRows = measured.rows;

    wsConnection.send(JSON.stringify({ type: 'resize', rows: nextRows, cols: nextCols }));
    logTerminalLayoutDiagnostics('resize:sent', {
        reason,
        force,
        cols: nextCols,
        rows: nextRows,
        measuredWidth: measured.width,
        measuredHeight: measured.height,
        effectiveWidth: measured.effectiveWidth,
        effectiveHeight: measured.effectiveHeight,
        lineHeight: Number(measured.lineHeight.toFixed(2)),
        charWidth: Number(measured.charWidth.toFixed(2)),
    });
}

function isParentKeyboardResizeFrozen() {
    return Date.now() < parentKeyboardResizeFreezeUntil;
}

function isMobileKeyboardActiveOrSettling() {
    if (isParentKeyboardResizeFrozen()) return true;
    if (!isTouchKeyboardDevice()) return false;
    const metrics = getViewportKeyboardMetrics();
    return Boolean(
        isSshKbLayoutOpen()
        || isSshKbFocusLikely()
        || metrics.keyboardInset > 8
        || document.documentElement.classList.contains('ssh-kb-open')
    );
}

function freezeTerminalViewportResize(reason = 'viewport-freeze', duration = TERMINAL_KEYBOARD_RESIZE_FREEZE_MS) {
    if (!isTouchKeyboardDevice()) return;
    const until = Date.now() + Math.max(200, Number(duration) || TERMINAL_KEYBOARD_RESIZE_FREEZE_MS);
    terminalViewportFreezeUntil = Math.max(terminalViewportFreezeUntil || 0, until);
    window.clearTimeout(terminalKeyboardSettlingTimer);
    terminalKeyboardSettlingTimer = window.setTimeout(() => {
        terminalViewportFreezeUntil = 0;
        requestInitialMobileRenderFlush(`${reason}:settled-render`);
    }, Math.max(180, until - Date.now()));
    logTerminalLayoutDiagnostics('resize:viewport-freeze', { reason, duration, until: terminalViewportFreezeUntil });
}

function isTerminalViewportResizeFrozen() {
    return Date.now() < terminalViewportFreezeUntil;
}

function getTerminalFitSignature(measured = getMeasuredTerminalSize()) {
    const q = TERMINAL_LAYOUT_SIGNATURE_PX;
    return [
        Math.round((measured.width || 0) / q) * q,
        Math.round((measured.height || 0) / q) * q,
        Number(measured.cols || 0),
        Number(measured.rows || 0),
        Math.round((measured.lineHeight || 0) * 100) / 100,
        Math.round((measured.charWidth || 0) * 100) / 100,
    ].join(':');
}

function rememberTerminalFitSnapshot(reason = 'fit-snapshot') {
    if (!term || !wtermWrapper || document.visibilityState !== 'visible' || !isEmbeddedTerminalFrameVisible()) return null;
    const measured = getMeasuredTerminalSize();
    if (measured.width < TERMINAL_MIN_RESIZE_WIDTH || measured.height < TERMINAL_MIN_RESIZE_HEIGHT) return null;
    terminalFitSnapshot = {
        reason,
        cols: measured.cols,
        rows: measured.rows,
        width: measured.width,
        height: measured.height,
        signature: getTerminalFitSignature(measured),
        at: performance.now(),
    };
    return terminalFitSnapshot;
}

function terminalLayoutMatchesSnapshot(tolerance = 1) {
    if (!terminalFitSnapshot || !term || !wtermWrapper || document.visibilityState !== 'visible' || !isEmbeddedTerminalFrameVisible()) return false;
    const measured = getMeasuredTerminalSize();
    return Math.abs(measured.cols - terminalFitSnapshot.cols) <= tolerance
        && Math.abs(measured.rows - terminalFitSnapshot.rows) <= tolerance
        && Math.abs(measured.width - terminalFitSnapshot.width) <= Math.max(TERMINAL_LAYOUT_SIGNATURE_PX * 2, 4)
        && Math.abs(measured.height - terminalFitSnapshot.height) <= Math.max(TERMINAL_LAYOUT_SIGNATURE_PX * 2, 4);
}

function isMobileStableInputMode() {
    return !!mobileStableInputEnabled;
}

function shouldIgnoreMobileKeyboardResizeReason(reason = '') {
    return isMobileStableInputMode() && MOBILE_KEYBOARD_RESIZE_REASONS.test(String(reason));
}

function shouldSuppressTerminalGridResize(reason = '') {
    if (runWithMobileStableResizeBypass.active) return false;
    if (shouldIgnoreMobileKeyboardResizeReason(reason)) return true;
    if (!isTouchKeyboardDevice()) return false;
    const label = String(reason);
    if (label.includes(':settled') || label.includes(':fit')) return false;
    return isTerminalViewportResizeFrozen()
        || isMobileKeyboardActiveOrSettling()
        || /keyboard|viewport|visual/.test(label);
}

function scheduleStableTerminalGridResize(reason = 'stable-terminal-grid-resize', delay = TERMINAL_KEYBOARD_STABLE_RESIZE_DELAY) {
    if (shouldIgnoreMobileKeyboardResizeReason(reason)) {
        scheduleTerminalScrollbarUpdate();
        ensureMobileStableCursorVisible(`${reason}:visible-only`);
        return;
    }
    window.clearTimeout(terminalStableResizeTimer);
    terminalStableResizeTimer = window.setTimeout(() => {
        terminalStableResizeTimer = 0;
        if (!term || !wtermWrapper || document.visibilityState !== 'visible' || !isEmbeddedTerminalFrameVisible()) return;
        const forceStableFit = String(reason).includes(':settled-fit');
        if (!forceStableFit && isTouchKeyboardDevice() && (isTerminalViewportResizeFrozen() || isMobileKeyboardActiveOrSettling())) {
            scheduleStableTerminalGridResize(`${reason}:still-settling`, TERMINAL_KEYBOARD_STABLE_RESIZE_DELAY);
            return;
        }
        const measured = getMeasuredTerminalSize();
        const signature = getTerminalFitSignature(measured);
        if (terminalFitSnapshot?.signature === signature || terminalLayoutMatchesSnapshot(1)) {
            requestInitialMobileRenderFlush(`${reason}:same-fit`);
            return;
        }
        // 根因规避：@wterm/core 当前 resize 会把被裁掉的底部行按错误顺序写入 scrollback。
        // xterm 的 FitAddon 只在稳定容器上调用 resize，但不会牺牲历史可视文本；这里在移动端键盘/按钮扰动后的稳定 fit 阶段，
        // 如果真实行数会变小，仅同步外层尺寸与后端 PTY，保持 WTerm buffer rows 不变，避免 ping 等输出少一行或乱序。
        const currentRows = Number(term?.bridge?.getRows?.() || term?.rows || 0);
        if (forceStableFit && measured.rows < currentRows) {
            sendTerminalResize(measured.cols, measured.rows, { reason: `${reason}:pty-only`, force: true });
            rememberTerminalFitSnapshot(`${reason}:pty-only-remember`);
            requestInitialMobileRenderFlush(`${reason}:pty-only-render`);
            return;
        }
        repairWTermLayoutAfterVisibilityChange(`${reason}:fit`, { sendResize: true, follow: terminalAutoFollowEnabled || isTerminalAtBottom(undefined, TERMINAL_XTERM_SCROLL_LOCK_THRESHOLD) });
        rememberTerminalFitSnapshot(`${reason}:remember`);
    }, delay);
}

function collectWTermBufferLines() {
    if (!term?.bridge) return [];
    const bridge = term.bridge;
    const cols = Math.max(1, Number(bridge.getCols?.() || term.cols || 0));
    const rows = Math.max(0, Number(bridge.getRows?.() || term.rows || 0));
    const readCellLine = (getter) => {
        let text = '';
        for (let col = 0; col < cols; col += 1) {
            const cp = getter(col)?.char || 0;
            text += bridge.getGrapheme?.(cp) || (cp >= 32 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ' ');
        }
        return cleanTerminalRowText(text);
    };
    const lines = [];
    try {
        const scrollbackCount = Math.max(0, Number(bridge.getScrollbackCount?.() || 0));
        for (let offset = scrollbackCount - 1; offset >= 0; offset -= 1) {
            lines.push(readCellLine((col) => bridge.getScrollbackCell(offset, col)));
        }
        for (let row = 0; row < rows; row += 1) {
            lines.push(readCellLine((col) => bridge.getCell(row, col)));
        }
    } catch (_) {
        return [];
    }
    return lines;
}

function floatingPanelWorkspaceState(panel) {
    if (!panel) return { open: false };
    return {
        open: panel.classList.contains('open'),
        left: panel.style.left || '',
        top: panel.style.top || '',
        width: panel.style.width || '',
        height: panel.style.height || '',
    };
}

function getTerminalWorkspaceState() {
    const viewport = term?.getViewportState?.() || {};
    const rowHeight = Math.max(1, Number(viewport.rowHeight) || getTerminalCharMetrics?.()?.lineHeight || terminalFontSize * 1.35);
    return {
        viewport: {
            atBottom: viewport.atBottom !== false,
            scrollLine: Math.max(0, Math.round((Number(viewport.scrollTop) || 0) / rowHeight)),
        },
        fontSize: terminalFontSize,
        panels: {
            fileManager: { ...floatingPanelWorkspaceState(fileManager), path: currentPath || '.' },
            docker: { ...floatingPanelWorkspaceState(dockerPanel), logContainer: dockerCurrentLogContainer || '', logTitle: dockerLogTitle?.textContent || '' },
            info: floatingPanelWorkspaceState(infoModal),
        },
    };
}

function applyFloatingPanelWorkspaceState(panel, state = {}) {
    if (!panel || !state) return;
    ['left', 'top', 'width', 'height'].forEach((key) => {
        if (typeof state[key] === 'string' && state[key]) panel.style[key] = state[key];
    });
    clampPanel?.(panel);
}

function applyTerminalWorkspaceState(state = pendingWorkspaceRestoreState) {
    if (!state || typeof state !== 'object') return false;
    pendingWorkspaceRestoreState = state;
    if (Number.isFinite(Number(state.fontSize))) applyTerminalFontSize(Number(state.fontSize), { persist: false });
    if (!term || !isConnected) return false;

    const panels = state.panels || {};
    if (panels.fileManager?.open) {
        currentPath = String(panels.fileManager.path || '.');
        if (fmPathInput) fmPathInput.value = currentPath;
        showFileManager();
        applyFloatingPanelWorkspaceState(fileManager, panels.fileManager);
    }
    if (panels.docker?.open) {
        showDockerPanel();
        applyFloatingPanelWorkspaceState(dockerPanel, panels.docker);
        if (panels.docker.logContainer) openDockerLogs(panels.docker.logContainer, String(panels.docker.logTitle || '').replace(/^容器日志\s*·\s*/, ''));
    }
    if (panels.info?.open) {
        showInfoModal();
        applyFloatingPanelWorkspaceState(infoModal, panels.info);
    }

    const restoreViewport = () => {
        if (state.viewport?.atBottom !== false) {
            term?.scrollToBottom?.();
            setTerminalAutoFollow?.(true, 'workspace-restore-bottom');
            return;
        }
        const line = Math.max(0, Number(state.viewport?.scrollLine) || 0);
        term?.scrollToLine?.(line);
        setTerminalAutoFollow?.(false, 'workspace-restore-history');
    };
    [0, 120, 360].forEach((delay) => window.setTimeout(restoreViewport, delay));
    pendingWorkspaceRestoreState = null;
    return true;
}

window.__zephyrGetWorkspaceState = getTerminalWorkspaceState;
window.__zephyrGetScreenText = () => {
    const rows = Math.max(1, Number(term?.bridge?.getRows?.() || term?.rows || 24));
    return collectWTermBufferLines().slice(-rows).join('\n').slice(-64 * 1024);
};

function normalizeTerminalSnapshotLines(lines = []) {
    return lines.map((line) => String(line || '').replace(/\s+$/g, ''));
}

function nonEmptyTerminalLines(text = '') {
    return String(text || '').split('\n').map((line) => line.trimEnd()).filter((line) => line.trim());
}

function terminalLineMultiset(lines = []) {
    const map = new Map();
    lines.forEach((line) => map.set(line, (map.get(line) || 0) + 1));
    return map;
}

function terminalMultisetMissingCount(previousLines = [], currentLines = []) {
    const current = terminalLineMultiset(currentLines);
    let missing = 0;
    previousLines.forEach((line) => {
        const count = current.get(line) || 0;
        if (count > 0) current.set(line, count - 1);
        else missing += 1;
    });
    return missing;
}

function terminalOrderInversionCount(previousLines = [], currentLines = []) {
    const queues = new Map();
    previousLines.forEach((line, index) => {
        if (!queues.has(line)) queues.set(line, []);
        queues.get(line).push(index);
    });
    let last = -1;
    let inversions = 0;
    currentLines.forEach((line) => {
        const queue = queues.get(line);
        if (!queue?.length) return;
        const index = queue.shift();
        if (index < last) inversions += 1;
        last = Math.max(last, index);
    });
    return inversions;
}

function collectTerminalOutputLinesForAi() {
    if (!term || !wtermWrapper) return [];
    const bufferLines = collectWTermBufferLines();
    const domRows = Array.from(wtermWrapper.querySelectorAll('.term-row, .term-scrollback-row'));
    const domLines = domRows.map((row) => cleanTerminalRowText(row.textContent || ''));
    const bufferText = bufferLines.join('\n').replace(/[\s\n]+$/g, '');
    const domText = domLines.join('\n').replace(/[\s\n]+$/g, '');
    let lines = bufferText.trim().length >= domText.trim().length ? bufferLines : domLines;
    if (!lines.some((line) => String(line || '').trim())) {
        const fallback = String(wtermWrapper.innerText || wtermWrapper.textContent || '').split(/\r?\n/).map(cleanTerminalRowText);
        if (fallback.some((line) => line.trim())) lines = fallback;
    }
    return normalizeTerminalSnapshotLines(lines);
}
function getAiTerminalOutputSnapshot(options = {}) {
    const maxChars = Math.max(1000, Math.min(60000, Number(options.maxChars) || 24000));
    const lines = collectTerminalOutputLinesForAi();
    let text = lines.join('\n').replace(/[\s\n]+$/g, '');
    const originalLength = text.length;
    const truncated = originalLength > maxChars;
    if (truncated) text = text.slice(-maxChars);
    return {
        tabId: params?.tabId || '',
        connectionId: params?.connectionId || '',
        host: params?.host || '',
        port: params?.port || '',
        username: params?.username || '',
        status: statusText?.textContent || '',
        currentInput: cmdInput?.value || '',
        text,
        lineCount: text ? text.split(/\r?\n/).length : 0,
        originalLength,
        truncated,
        cols: Number(term?.bridge?.getCols?.() || term?.cols || 0),
        rows: Number(term?.bridge?.getRows?.() || term?.rows || 0),
        scrollbackCount: Number(term?.bridge?.getScrollbackCount?.() || 0),
        at: Date.now(),
    };
}
window.__zephyrGetTerminalOutput = getAiTerminalOutputSnapshot;

function runWithSuppressedWTermResizeEvent(callback) {
    suppressWTermResizeEvent = true;
    try {
        return callback?.();
    } finally {
        suppressWTermResizeEvent = false;
    }
}

function updateWTermLocalGridSize(cols, rows, reason = 'local-grid-size') {
    if (!term || !term.bridge || !term.renderer) return false;
    const nextCols = Math.floor(Number(cols));
    const nextRows = Math.floor(Number(rows));
    if (!Number.isFinite(nextCols) || !Number.isFinite(nextRows) || nextCols < 20 || nextRows < 2) return false;
    const currentCols = Number(term.cols ?? term.bridge?.getCols?.() ?? 0);
    const currentRows = Number(term.rows ?? term.bridge?.getRows?.() ?? 0);
    if (currentCols === nextCols && currentRows === nextRows) return false;
    runWithSuppressedWTermResizeEvent(() => {
        term.cols = nextCols;
        term.rows = nextRows;
        term.bridge.resize(nextCols, nextRows);
        term.renderer.setup(nextCols, nextRows);
        term._scheduleRender?.();
    });
    normalizeWTermContainerLayout(`${reason}:local-grid`);
    logTerminalLayoutDiagnostics('wterm-layout:local-grid-resized', { reason, cols: nextCols, rows: nextRows, previousCols: currentCols, previousRows: currentRows });
    return true;
}

function syncWTermGridToLastPty(reason = 'sync-grid-to-pty') {
    if (!lastSentTerminalSize.cols || !lastSentTerminalSize.rows) return false;
    return updateWTermLocalGridSize(lastSentTerminalSize.cols, lastSentTerminalSize.rows, reason);
}

function runWithMobileStableResizeBypass(callback) {
    const previous = runWithMobileStableResizeBypass.active;
    runWithMobileStableResizeBypass.active = true;
    try {
        return callback?.();
    } finally {
        runWithMobileStableResizeBypass.active = previous;
    }
}

function stabilizeWTermAfterViewportOnlyChange(reason = 'viewport-only-change') {
    freezeTerminalViewportResize(reason);
    // Mobile stable input: keyboard/viewport changes are purely visual clipping.
    // Touching WTerm bridge rows here is the root cause of phantom blank rows,
    // text reordering, and the ugly slide-down recovery after IME close.
    if (isMobileStableInputMode() && MOBILE_KEYBOARD_RESIZE_REASONS.test(String(reason))) {
        normalizeWTermContainerLayout(`${reason}:visual-only`);
        requestInitialMobileRenderFlush(reason);
        scheduleTerminalScrollbarUpdate();
        return;
    }
    syncWTermGridToLastPty(`${reason}:keep-pty-size`);
    normalizeWTermContainerLayout(`${reason}:normalize`);
    requestInitialMobileRenderFlush(reason);
    scheduleTerminalScrollbarUpdate();
}

function scheduleKeyboardCloseFit(reason = 'keyboard-close-fit', delay = TERMINAL_KEYBOARD_STABLE_RESIZE_DELAY) {
    if (isMobileStableInputMode()) {
        freezeTerminalViewportResize(`${reason}:freeze`, Math.max(delay, TERMINAL_KEYBOARD_RESIZE_FREEZE_MS));
        // Keyboard close in stable mode is purely visual — the page height never changed.
        // Do NOT restore/repair the WTerm grid. Just normalize the flex container and flush.
        window.clearTimeout(scheduleKeyboardCloseFit._mobileTimer);
        scheduleKeyboardCloseFit._mobileTimer = window.setTimeout(() => {
            normalizeWTermContainerLayout(`${reason}:settled`);
            requestInitialMobileRenderFlush(`${reason}:settled`);
            if (isMobileTerminalAutoFollowLocked() || isTerminalUserReadingHistory()) {
                lockMobileTerminalAutoFollow(`${reason}:history-preserved`, 1600);
                scheduleTerminalScrollbarUpdate();
            } else {
                ensureMobileStableCursorVisible(`${reason}:settled`);
                scheduleTerminalScrollbarUpdate();
            }
        }, Math.max(80, delay));
        return;
    }
    freezeTerminalViewportResize(`${reason}:freeze`, Math.max(delay, TERMINAL_KEYBOARD_RESIZE_FREEZE_MS));
    scheduleStableTerminalGridResize(`${reason}:settled-fit`, Math.max(delay, TERMINAL_KEYBOARD_RESIZE_FREEZE_MS + 80));
}

function scheduleTerminalResize(reason = 'scheduled', delay = 120) {
    // Hard gate: keyboard opening/open/closing must never refit WTerm grid.
    if (sshKb && !sshKb.allowResize?.(reason) && !/force|orientation|font-size|settled-fit/.test(String(reason))) {
        logTerminalLayoutDiagnostics('resize:blocked-ssh-kb-gate', { reason, phase: sshKb.getPhase?.() });
        sshKb.runOrQueueResize?.(() => scheduleTerminalResize(`${reason}:queued-after-kb`, 0), reason);
        return;
    }
    if (shouldIgnoreMobileKeyboardResizeReason(reason)) {
        logTerminalLayoutDiagnostics('resize:blocked-mobile-stable-keyboard', { reason });
        ensureMobileStableCursorVisible(`${reason}:visible-only`);
        scheduleTerminalScrollbarUpdate();
        return;
    }
    if (shouldSuppressTerminalGridResize(reason)) {
        logTerminalLayoutDiagnostics('resize:blocked-mobile-viewport-settling', { reason, frozen: isTerminalViewportResizeFrozen() });
        if (isTouchKeyboardDevice()) stabilizeWTermAfterViewportOnlyChange(`resize-blocked:${reason}`);
        scheduleTerminalScrollbarUpdate();
        return;
    }
    const shouldFollowAfterResize = terminalAutoFollowEnabled || isTerminalAtBottom(undefined, TERMINAL_XTERM_SCROLL_LOCK_THRESHOLD);
    window.clearTimeout(scheduleTerminalResize._timer);
    scheduleTerminalResize._timer = window.setTimeout(() => {
        if (!term || !wtermWrapper || document.visibilityState !== 'visible' || !isEmbeddedTerminalFrameVisible()) return;
        const rect = wtermWrapper.getBoundingClientRect();
        if (rect.width < TERMINAL_MIN_RESIZE_WIDTH || rect.height < TERMINAL_MIN_RESIZE_HEIGHT || wtermWrapper.offsetParent === null) {
            logTerminalLayoutDiagnostics('resize:skipped-hidden-or-tiny-refresh', {
                reason,
                width: Math.round(rect.width || 0),
                height: Math.round(rect.height || 0),
            });
            return;
        }
        const measured = getMeasuredTerminalSize();
        const cols = Math.max(20, measured.cols);
        const rows = Math.max(2, measured.rows);
        const changed = lastSentTerminalSize.cols !== cols || lastSentTerminalSize.rows !== rows;
        repairWTermLayoutAfterVisibilityChange(`scheduled:${reason}`, { sendResize: false, follow: shouldFollowAfterResize });
        if (changed) {
            sendTerminalResize(cols, rows, { reason, force: true });
        }
        if (shouldFollowAfterResize) requestAnimationFrame(() => requestTerminalAutoFollow(`resize:${reason}`));
        else scheduleTerminalScrollbarUpdate();
    }, delay);
    logTerminalLayoutDiagnostics('resize:scheduled-stable-refresh', { reason, delay });
    scheduleTerminalScrollbarUpdate();
}

function setupStableTerminalResizeObserver() {
    if (!window.ResizeObserver || !wtermWrapper) return () => {};
    const observer = new ResizeObserver(() => {
        normalizeWTermContainerLayout('resize-observer');
        if (shouldSuppressTerminalGridResize('resize-observer-stable')) {
            stabilizeWTermAfterViewportOnlyChange('resize-observer-stable');
            return;
        }
        scheduleTerminalResize('resize-observer-stable', 160);
    });
    observer.observe(wtermWrapper);
    if (terminalContainer) observer.observe(terminalContainer);
    return () => observer.disconnect();
}

function applyTerminalFontSize(size, { persist = true } = {}) {
    terminalFontSize = clampTerminalFontSize(size);
    const wasAtBottom = isTerminalAtBottom(undefined, TERMINAL_XTERM_SCROLL_LOCK_THRESHOLD) || terminalAutoFollowEnabled;
    document.documentElement.style.setProperty('--terminal-font-size', `${terminalFontSize}px`);
    wtermWrapper.style.fontSize = `${terminalFontSize}px`;
    try { term?.setOption?.('fontSize', terminalFontSize); } catch (_) {}
    try { term?.options && (term.options.fontSize = terminalFontSize); } catch (_) {}
    // Authoritative remeasure: writes --term-row-height + --term-cell-width and
    // pushes px metrics into the cursor overlay / canvas renderer.
    try {
        if (typeof term?.refreshCellMetrics === 'function') term.refreshCellMetrics();
        else term?._setRowHeight?.();
    } catch (_) {}
    if (persist) localStorage.setItem(TERMINAL_FONT_STORAGE_KEY, String(terminalFontSize));
    updateFontSizeButtons();
    if (!isTouchKeyboardDevice()) scheduleTerminalResize('font-size-change', 80);
    if (wasAtBottom) requestAnimationFrame(() => requestTerminalAutoFollow('font-size-change'));
    else scheduleTerminalScrollbarUpdate();
    // Keep IME proxy glued to the new cell size.
    if (isMobileStableInputMode()) scheduleImeProxyCursorAnchor('font-size-change');
}

function getTouchDistance(touches) {
    const [a, b] = touches;
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

function setupTerminalPinchZoom() {
    wtermWrapper.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 2) return;
        e.preventDefault();
        pinchStartDistance = getTouchDistance(e.touches);
        pinchStartFontSize = terminalFontSize;
        pinchLastAppliedFontSize = terminalFontSize;
    }, { passive: false });

    wtermWrapper.addEventListener('touchmove', (e) => {
        if (e.touches.length !== 2 || !pinchStartDistance) return;
        e.preventDefault();
        const distance = getTouchDistance(e.touches);
        const nextSize = clampTerminalFontSize(pinchStartFontSize * (distance / pinchStartDistance));
        if (nextSize !== pinchLastAppliedFontSize) {
            pinchLastAppliedFontSize = nextSize;
            applyTerminalFontSize(nextSize);
        }
    }, { passive: false });

    const endPinch = () => { pinchStartDistance = 0; };
    wtermWrapper.addEventListener('touchend', endPinch, { passive: true });
    wtermWrapper.addEventListener('touchcancel', endPinch, { passive: true });
}

applyTerminalFontSize(getStoredTerminalFontSize(), { persist: false });
fontDecreaseBtn?.addEventListener('click', () => applyTerminalFontSize(terminalFontSize - TERMINAL_FONT_STEP));
fontIncreaseBtn?.addEventListener('click', () => applyTerminalFontSize(terminalFontSize + TERMINAL_FONT_STEP));
setupTerminalPinchZoom();

// ---------- 复制功能 ----------
copyBtn.addEventListener('click', async () => {
    const text = getCopyableSelectionText();
    if (!text) {
        toast?.(t('请先选择要复制的终端内容'));
        return;
    }
    mobileClipboardActionInProgress = true;
    enterMobileTerminalSelectionMode('copy-button');
    const originalText = copyBtn.textContent;
    try {
        await navigator.clipboard.writeText(text);
        notifyParentSharedClipboardText(text);
        copyBtn.textContent = t('已复制');
    } catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', 'readonly');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        ta.style.top = '0';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        const active = document.activeElement;
        ta.select();
        try { document.execCommand('copy'); copyBtn.textContent = t('已复制'); } catch (_) { copyBtn.textContent = t('失败'); }
        document.body.removeChild(ta);
        try { active?.focus?.({ preventScroll: true }); } catch (_) {}
    } finally {
        window.setTimeout(() => { mobileClipboardActionInProgress = false; }, 220);
    }
    scheduleExitMobileTerminalSelectionMode(1200);
    setTimeout(() => { copyBtn.textContent = originalText; }, 1500);
});

pasteBtn?.addEventListener('click', async () => {
    mobileClipboardActionInProgress = true;
    try {
        const pasted = await pasteClipboardIntoTerminal('mobile-paste-button');
        if (!pasted) toast?.(t('剪贴板为空或浏览器未授权'));
    } finally {
        window.setTimeout(() => { mobileClipboardActionInProgress = false; }, 220);
    }
});

copyBtn.addEventListener('pointerdown', (e) => e.preventDefault(), { passive: false });
copyBtn.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
pasteBtn?.addEventListener('pointerdown', (e) => e.preventDefault(), { passive: false });
pasteBtn?.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });

document.addEventListener('copy', (e) => {
    const selection = window.getSelection?.();
    const text = getTerminalSelectionTextFromDom(selection);
    if (!text) return;
    e.preventDefault();
    e.clipboardData?.setData('text/plain', text);
    cachedSelectionText = text;
    notifyParentSharedClipboardText(text);
    console.debug('[TerminalCopy]', 'native copy overridden', {
        length: text.length,
        newlines: (text.match(/\n/g) || []).length,
    });
});

function normalizeCopiedTerminalText(text = '') {
    let value = String(text)
        .replace(/\u00a0/g, ' ')
        .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
        .replace(/\r\n?/g, '\n');
    // 仅作为兜底：如果浏览器默认 selection 已经把 URI 内部软换行变成空白，
    // 这里会把常见 URI 片段拼回去。真正的根治在 getTerminalSelectionTextFromDom：
    // 按终端屏幕行宽区分软换行/真实换行。
    value = value.replace(/\b([a-z][a-z0-9+.-]{1,31}:\/\/[^\s<>'"]+(?:[ \t\n]+[^\s<>'"]+)*)/gi, (match) => {
        const compact = match.replace(/[ \t\n]+/g, '');
        return /^[a-z][a-z0-9+.-]{1,31}:\/\//i.test(compact) ? compact : match;
    });
    return value;
}

function getSelectionTextFromRanges(selection) {
    if (!selection || selection.rangeCount === 0) return '';
    const parts = [];
    for (let i = 0; i < selection.rangeCount; i++) {
        const range = selection.getRangeAt(i);
        parts.push(range.cloneContents().textContent || range.toString() || '');
    }
    return parts.join('');
}

function getTerminalColsForCopy() {
    const optionCols = Number(term?.cols ?? term?._cols ?? term?.options?.cols);
    if (Number.isFinite(optionCols) && optionCols > 0) return Math.floor(optionCols);
    const rect = wtermWrapper?.getBoundingClientRect?.();
    if (!rect?.width) return 80;
    const { charWidth } = getTerminalCharMetrics();
    return Math.max(2, Math.floor(rect.width / Math.max(1, charWidth)));
}

function terminalDisplayColumns(text = '') {
    let columns = 0;
    for (const ch of String(text)) {
        if (ch === '\t') columns += 8 - (columns % 8 || 0);
        else if (/[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(ch)) columns += 2;
        else columns += 1;
    }
    return columns;
}

function cleanTerminalRowText(text = '') {
    return String(text)
        .replace(/\u00a0/g, ' ')
        .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
        .replace(/[ \t]+$/g, '');
}

function selectionTouchesTerminal(selection) {
    if (!selection || selection.rangeCount === 0 || !wtermWrapper) return false;
    for (let i = 0; i < selection.rangeCount; i++) {
        const range = selection.getRangeAt(i);
        if (wtermWrapper.contains(range.commonAncestorContainer)) return true;
        const rows = wtermWrapper.querySelectorAll?.('.term-row') || [];
        for (const row of rows) {
            try {
                if (range.intersectsNode(row)) return true;
            } catch (_) {}
        }
    }
    return false;
}

function getRangeIntersectionText(range, node) {
    const nodeRange = document.createRange();
    nodeRange.selectNodeContents(node);
    if (range.compareBoundaryPoints(Range.END_TO_START, nodeRange) <= 0 || range.compareBoundaryPoints(Range.START_TO_END, nodeRange) >= 0) {
        return '';
    }
    const intersection = range.cloneRange();
    if (intersection.compareBoundaryPoints(Range.START_TO_START, nodeRange) < 0) {
        intersection.setStart(nodeRange.startContainer, nodeRange.startOffset);
    }
    if (intersection.compareBoundaryPoints(Range.END_TO_END, nodeRange) > 0) {
        intersection.setEnd(nodeRange.endContainer, nodeRange.endOffset);
    }
    const text = intersection.cloneContents().textContent || intersection.toString() || '';
    nodeRange.detach?.();
    intersection.detach?.();
    return text;
}

function bridgeCellToChar(cell) {
    const cp = Number(cell?.char || 0);
    return term?.bridge?.getGrapheme?.(cp) || (cp >= 32 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ' ');
}

function readMainBufferRowText(rowIndex, cols) {
    const bridge = term?.bridge;
    if (!bridge || rowIndex < 0) return '';
    let text = '';
    for (let col = 0; col < cols; col++) text += bridgeCellToChar(bridge.getCell(rowIndex, col));
    return cleanTerminalRowText(text);
}

function readScrollbackBufferRowText(rowEl, cols) {
    const bridge = term?.bridge;
    const renderer = term?.renderer;
    if (!bridge || !renderer?._scrollbackRowEls) return '';
    const index = renderer._scrollbackRowEls.indexOf(rowEl);
    const count = bridge.getScrollbackCount?.() || 0;
    if (index < 0 || count <= 0) return '';

    // renderer.syncScrollback() 以 offset 从大到小插入 DOM，因此 DOM 中第 0 个 scrollback row
    // 对应最老的 scrollback offset = count - 1。
    const offset = count - 1 - index;
    if (offset < 0) return '';

    const lineLen = Math.max(0, Math.min(cols, bridge.getScrollbackLineLen(offset) || 0));
    let text = '';
    for (let col = 0; col < lineLen; col++) text += bridgeCellToChar(bridge.getScrollbackCell(offset, col));
    const fromBridge = cleanTerminalRowText(text);
    const fromDom = cleanTerminalRowText(rowEl.textContent || '');

    // 如果 offset 映射因 wterm 内部滚动更新而不一致，回退 DOM 行文本，避免复制错行或空白。
    if (fromBridge && (!fromDom || fromBridge === fromDom || fromDom.includes(fromBridge) || fromBridge.includes(fromDom))) return fromBridge;
    return fromDom;
}

function readWTermBufferRowText(rowEl, cols) {
    const renderer = term?.renderer;
    if (!rowEl || !renderer) return cleanTerminalRowText(rowEl?.textContent || '');
    if (rowEl.classList.contains('term-scrollback-row')) return readScrollbackBufferRowText(rowEl, cols);

    const rowIndex = renderer.rowEls?.indexOf(rowEl) ?? -1;
    const fromBridge = readMainBufferRowText(rowIndex, cols);
    const fromDom = cleanTerminalRowText(rowEl.textContent || '');

    // 主屏行没有 lineLen API，bridge 读取后需要 trim；若异常则回退 DOM。
    return fromBridge || fromDom;
}

function getTerminalRowSelectionText(row, selection) {
    let text = '';
    if (!row || !selection) return text;
    for (let i = 0; i < selection.rangeCount; i++) {
        try {
            text += getRangeIntersectionText(selection.getRangeAt(i), row);
        } catch (_) {}
    }
    return cleanTerminalRowText(text);
}

function getSelectedTerminalRowSlice(row, bufferText, selectedDomText) {
    const selectedText = cleanTerminalRowText(selectedDomText);
    const fullBufferText = cleanTerminalRowText(bufferText);
    const fullDomText = cleanTerminalRowText(row?.textContent || '');
    if (!selectedText) {
        return {
            text: '',
            startOffset: 0,
            endOffset: 0,
            startsAtRowStart: true,
            endsAtRowEnd: true,
            partial: false,
        };
    }

    const referenceText = fullDomText || fullBufferText;
    const startOffset = referenceText ? referenceText.indexOf(selectedText) : -1;
    const isFullDomRow = referenceText && selectedText === referenceText;
    const isFullBufferRow = fullBufferText && selectedText === fullBufferText;

    if (startOffset >= 0 && !isFullDomRow && fullBufferText) {
        const sliced = fullBufferText.slice(startOffset, startOffset + selectedText.length);
        return {
            text: sliced || selectedText,
            startOffset,
            endOffset: startOffset + selectedText.length,
            startsAtRowStart: startOffset <= 0,
            endsAtRowEnd: startOffset + selectedText.length >= referenceText.length,
            partial: true,
        };
    }

    if (isFullDomRow || isFullBufferRow) {
        return {
            text: fullBufferText || selectedText,
            startOffset: 0,
            endOffset: referenceText.length,
            startsAtRowStart: true,
            endsAtRowEnd: true,
            partial: false,
        };
    }

    // DOM 选区文本和 buffer 文本无法可靠对齐时，优先返回浏览器真实选中的片段，
    // 避免再次退化成“复制整行”。
    return {
        text: selectedText,
        startOffset: 0,
        endOffset: selectedText.length,
        startsAtRowStart: false,
        endsAtRowEnd: false,
        partial: true,
    };
}

function getTerminalSelectionTextFromDom(selection = window.getSelection?.()) {
    if (!selection || selection.rangeCount === 0 || !selectionTouchesTerminal(selection)) return '';
    const fallbackText = getSelectionTextFromRanges(selection) || selection.toString?.() || '';
    if (!fallbackText || !fallbackText.trim()) return '';

    const rows = Array.from(wtermWrapper.querySelectorAll('.term-row'));
    if (!rows.length || !term?.bridge) return normalizeCopiedTerminalText(fallbackText);

    const cols = Math.max(2, Number(term.bridge.getCols?.() || getTerminalColsForCopy()));
    const selectedRows = [];
    for (const row of rows) {
        const selectedDomText = getTerminalRowSelectionText(row, selection);
        if (!selectedDomText) continue;

        const bufferText = readWTermBufferRowText(row, cols);
        const slice = getSelectedTerminalRowSlice(row, bufferText, selectedDomText);
        if (!slice.text) continue;

        selectedRows.push({
            text: slice.text,
            fullColumns: terminalDisplayColumns(bufferText || row.textContent || ''),
            selectedColumns: terminalDisplayColumns(slice.text),
            startsAtRowStart: slice.startsAtRowStart,
            endsAtRowEnd: slice.endsAtRowEnd,
            partial: slice.partial,
            source: row.classList.contains('term-scrollback-row') ? 'scrollback' : 'screen',
        });
    }

    if (!selectedRows.length) return normalizeCopiedTerminalText(fallbackText);

    let result = '';
    let softWrapJoins = 0;
    let hardLineBreaks = 0;
    selectedRows.forEach((row, index) => {
        result += row.text;
        if (index >= selectedRows.length - 1) return;
        const nextRow = selectedRows[index + 1];
        const isSoftWrapped = row.fullColumns >= cols && row.endsAtRowEnd && nextRow.startsAtRowStart;
        if (isSoftWrapped) softWrapJoins += 1;
        else {
            hardLineBreaks += 1;
            result += '\n';
        }
    });

    const normalized = normalizeCopiedTerminalText(result);
    if (!normalized.trim()) return normalizeCopiedTerminalText(fallbackText);
    console.debug('[TerminalCopy]', 'selection reconstructed from wterm bridge with row slicing', {
        rows: selectedRows.length,
        cols,
        softWrapJoins,
        hardLineBreaks,
        partialRows: selectedRows.filter((row) => row.partial).length,
        fallbackLength: fallbackText.length,
        rawLength: result.length,
        normalizedLength: normalized.length,
        rawNewlines: (result.match(/\n/g) || []).length,
        normalizedNewlines: (normalized.match(/\n/g) || []).length,
        sources: [...new Set(selectedRows.map((row) => row.source))],
    });
    return normalized;
}

function getCopyableSelectionText() {
    const selection = window.getSelection();
    const terminalText = getTerminalSelectionTextFromDom(selection);
    const liveText = terminalText || normalizeCopiedTerminalText(getSelectionTextFromRanges(selection) || selection?.toString?.() || '');
    if (liveText) {
        cachedSelectionText = liveText;
        return liveText;
    }
    return cachedSelectionText;
}

document.addEventListener('selectionchange', () => {
    const selection = window.getSelection();
    if (!selection) return;
    logTerminalCopyDiagnostics('selectionchange', {
        collapsed: selection.isCollapsed,
        textLength: selection.toString?.().length || 0,
    });
    if (selection.isCollapsed) {
        if (mobileTerminalSelectionMode) scheduleExitMobileTerminalSelectionMode(900);
        return;
    }
    const text = normalizeCopiedTerminalText(getSelectionTextFromRanges(selection) || selection.toString());
    if (text) {
        cachedSelectionText = text;
        enterMobileTerminalSelectionMode('selectionchange');
    }
}, { passive: true });

// ---------- Ctrl+C 智能判断 ----------
document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'c') {
        const selection = window.getSelection();
        const text = selection.toString();
        if (text) return;
        e.preventDefault();
        sendData('\x03', { source: 'keyboard-shortcut', forceFollow: false });
    }
});

function formatTransferSize(bytes) {
    const value = Number(bytes) || 0;
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = value;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
    return `${size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
}

function formatTransferSpeed(bytesPerSecond) {
    const speed = Number(bytesPerSecond) || 0;
    return speed > 0 ? `${formatTransferSize(speed)}/s` : '—';
}

function updateTransferMetrics(item, loaded) {
    const now = Date.now();
    const previousLoaded = Number(item.loaded) || 0;
    const previousAt = Number(item.updatedAt) || now;
    if (Number(loaded || 0) < previousLoaded) {
        item.speed = 0;
        item.loaded = Number(loaded) || 0;
        item.updatedAt = now;
        return;
    }
    // Use at least 1s window to avoid spike from rapid server updates
    const deltaTime = Math.max(1, (now - previousAt) / 1000);
    const deltaBytes = Math.max(0, Number(loaded || 0) - previousLoaded);
    const instantSpeed = deltaBytes / deltaTime;
    const currentSpeed = Number(item.speed) || 0;
    // Exponential moving average (smoother with longer window)
    item.speed = instantSpeed > 0 ? (currentSpeed ? currentSpeed * 0.85 + instantSpeed * 0.15 : instantSpeed) : currentSpeed;
    item.loaded = Number(loaded) || 0;
    item.updatedAt = now;
}

function getTransferItems() {
    const uploads = Array.from(activeSftpUploads.entries()).map(([id, item]) => ({ ...item, id: item.id || id, direction: 'upload' }));
    const downloads = Array.from(activeSftpDownloads.entries()).map(([id, item]) => ({ ...item, id: item.id || item.downloadId || id, direction: item.direction || 'download' }));
    return [...uploads, ...downloads].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function ensureTransferPopover() {
    if (transferPopover) return transferPopover;
    transferPopover = document.createElement('div');
    transferPopover.className = 'transfer-popover';
    transferPopover.innerHTML = `<div class="transfer-popover-head"><strong>${t('文件传输')}</strong><button type="button" class="transfer-popover-close" aria-label="${t('关闭')}">×</button></div><div class="transfer-popover-body"></div>`;
    document.body.appendChild(transferPopover);
    transferPopover.querySelector('.transfer-popover-close')?.addEventListener('click', (e) => { e.stopPropagation(); hideTransferPopover(true); });
    transferPopover.addEventListener('pointerdown', (e) => {
        if (e.target.closest?.('[data-transfer-action]')) return;
        e.stopPropagation();
    });
    transferPopover.addEventListener('pointerenter', () => window.clearTimeout(transferPopoverHideTimer));
    return transferPopover;
}

function positionTransferPopover() {
    const popover = ensureTransferPopover();
    const rect = fmTransferBtn?.getBoundingClientRect?.();
    if (!rect) return;
    const width = Math.min(360, Math.max(280, window.innerWidth - 24));
    const left = Math.max(12, Math.min(window.innerWidth - width - 12, rect.left));
    const top = Math.min(window.innerHeight - 80, rect.bottom + 8);
    popover.style.width = `${width}px`;
    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(top)}px`;
}

function renderTransferPopover() {
    const items = getTransferItems();
    const hasActive = items.some((item) => item.status === 'active' || item.status === 'pending' || item.status === 'cancelling');
    fmTransferBtn?.classList.toggle('active', items.length > 0);
    fmTransferBtn?.classList.toggle('transfer-active', hasActive);
    fmTransferBtn?.setAttribute('data-count', String(items.length || ''));
    if (!transferPopover?.classList.contains('open')) return;
    positionTransferPopover();
    const body = transferPopover.querySelector('.transfer-popover-body');
    if (!body) return;

    // 有任务时必须移除上一次留下的空状态，否则新任务会被 append 到空状态后面，形成顶部空行
    if (items.length) {
        body.querySelector('.transfer-empty')?.remove();
    }

    // Track rendered items by data-transfer-id — update existing, create new
    const existingIds = new Set();
    body.querySelectorAll('[data-transfer-id]').forEach((el) => {
        const id = el.dataset.transferId;
        const item = items.find((it) => it.id === id);
        if (!item) {
            el.remove();
            return;
        }
        existingIds.add(id);
        // 更新已存在项的状态/按钮/进度（updateTransferItemElement 只在 status 变化时替换按钮）
        updateTransferItemElement(el, item);
    });

    // Add new items
    for (const item of items) {
        if (existingIds.has(item.id)) continue;
        const el = createTransferItemElement(item);
        body.appendChild(el);
    }

    // Empty state (only when truly empty)
    if (!items.length) {
        if (!body.querySelector('.transfer-empty')) {
            body.innerHTML = `<div class="transfer-empty">${t('暂无上传或下载任务')}</div>`;
        }
    }
}

// Update progress display for a single item WITHOUT re-rendering the whole popover
function updateProgressDisplay(id) {
    const item = activeSftpUploads.get(id) || activeSftpDownloads.get(id);
    if (!item) return;
    if (!transferPopover?.classList.contains('open')) return;
    const el = transferPopover.querySelector(`[data-transfer-id="${id}"]`);
    if (!el) return;

    const loaded = Number(item.loaded ?? 0) || 0;
    const total = Number(item.size ?? 0) || 0;
    const pct = total > 0 ? Math.max(0, Math.min(100, (loaded / total) * 100)) : 0;
    const activeIndeterminate = !total && (item.status === 'active' || item.status === 'pending');

    el.className = `transfer-item ${item.status || 'active'} ${activeIndeterminate ? 'indeterminate' : ''}`;

    // Update progress bar width
    const bar = el.querySelector('.transfer-progress-bar');
    if (bar) bar.style.width = (activeIndeterminate ? 38 : pct) + '%';

    // Update status text (always, not just active)
    const statusEl = el.querySelector('.transfer-status');
    if (statusEl) statusEl.textContent = transferStatusText(item);

    // Update meta text (size + speed)
    const metaEl = el.querySelector('.transfer-meta-text');
    if (metaEl) {
        const speedText = item.speed && item.status === 'active' ? ' · ' + formatTransferSpeed(item.speed) : '';
        metaEl.textContent = formatTransferSize(loaded) + ' / ' + (total ? formatTransferSize(total) : t('未知大小')) + speedText;
    }

    // Update action buttons when status changes
    const actionsEl = el.querySelector('.transfer-actions');
    if (actionsEl) {
        const prevStatus = actionsEl.dataset.itemStatus;
        if (prevStatus !== item.status) {
            actionsEl.innerHTML = actionButtons(item);
            actionsEl.dataset.itemStatus = item.status;
        }
    }
    // 每次更新时重新绑 onclick
    const direction = item.direction || (activeSftpUploads.has(id) ? 'upload' : 'download');
    bindCancelBtn(el, id, direction);
}

function createTransferItemElement(item) {
    const loaded = Number(item.loaded ?? item.offset ?? 0) || 0;
    const total = Number(item.size ?? item.total ?? 0) || 0;
    const pct = total > 0 ? Math.max(0, Math.min(100, (loaded / total) * 100)) : 0;
    const activeIndeterminate = !total && (item.status === 'active' || item.status === 'pending');
    const iconClass = item.direction === 'upload' ? 'upload' : 'download';
    const el = document.createElement('div');
    el.className = `transfer-item ${item.status || 'active'} ${activeIndeterminate ? 'indeterminate' : ''}`;
    el.dataset.transferId = item.id;
    el.innerHTML = `<div class="transfer-item-row"><span class="transfer-icon ${iconClass}" aria-hidden="true"></span><span class="transfer-name" title="${escapeHtml(item.path || item.name || '')}">${escapeHtml(item.name || String(item.path || '').split('/').pop() || t('文件'))}</span><span class="transfer-status">${transferStatusText(item)}</span><span class="transfer-actions">${actionButtons(item)}</span></div><div class="transfer-progress"><span class="transfer-progress-bar" style="width:${activeIndeterminate ? '38' : pct}%"></span></div><div class="transfer-meta"><span class="transfer-meta-text">${metaText(item)}</span></div></div>`;
    bindCancelBtn(el, item.id, item.direction);
    return el;
}

function updateTransferItemElement(el, item) {
    const loaded = Number(item.loaded ?? item.offset ?? 0) || 0;
    const total = Number(item.size ?? item.total ?? 0) || 0;
    const pct = total > 0 ? Math.max(0, Math.min(100, (loaded / total) * 100)) : 0;
    const activeIndeterminate = !total && (item.status === 'active' || item.status === 'pending');

    el.className = `transfer-item ${item.status || 'active'} ${activeIndeterminate ? 'indeterminate' : ''}`;

    // Update status text
    const statusEl = el.querySelector('.transfer-status');
    if (statusEl) statusEl.textContent = transferStatusText(item);

    // Update progress bar width
    const bar = el.querySelector('.transfer-progress-bar');
    if (bar) bar.style.width = (activeIndeterminate ? 38 : pct) + '%';

    // Update meta text
    const metaEl = el.querySelector('.transfer-meta-text');
    if (metaEl) metaEl.textContent = metaText(item);

    // Update action buttons (only when status actually changes)
    const actionsEl = el.querySelector('.transfer-actions');
    if (actionsEl) {
        const prevStatus = actionsEl.dataset.itemStatus;
        if (prevStatus !== item.status) {
            actionsEl.innerHTML = actionButtons(item);
            actionsEl.dataset.itemStatus = item.status;
        }
    }
    // 每次更新时重新绑 onclick（保险，防止 DOM 重建后 handler 丢失）
    bindCancelBtn(el, item.id, item.direction);
}

function transferStatusText(item) {
    if (item.status === 'done') return t('已完成');
    if (item.status === 'error') return item.cancelled ? t('已取消') : t('失败');
    if (item.status === 'cancelling') return t('取消中');
    if (item.status === 'paused') return t('已暂停');
    if (item.status === 'pending') return t('等待中');
    if (item.direction === 'copy') return t('复制中');
    if (item.direction === 'move') return t('移动中');
    if (item.direction === 'archive') {
        const phase = item.phase || '';
        if (phase === 'scan') return t('扫描中');
        if (phase === 'download') return t('拉取到主端');
        if (phase === 'compress') return t('主端压缩中');
        if (phase === 'extract') return t('主端解压中');
        if (phase === 'upload') return t('传回远端');
        return t('处理中');
    }
    const loaded = Number(item.loaded ?? 0) || 0;
    const total = Number(item.size ?? 0) || 0;
    if (!total && (item.status === 'active' || item.status === 'pending')) return t('准备中');
    return total > 0 ? (Math.min(100, (loaded / total) * 100)).toFixed(0) + '%' : t('传输中');
}

function metaText(item) {
    const loaded = Number(item.loaded ?? 0) || 0;
    const total = Number(item.size ?? 0) || 0;
    const speedText = item.status === 'active' && item.speed ? ' · ' + formatTransferSpeed(item.speed) : '';
    return formatTransferSize(loaded) + ' / ' + (total ? formatTransferSize(total) : t('未知大小')) + speedText;
}

function actionButtons(item) {
    if (item.cancellable === false) return '';
    if (item.status === 'done' || item.status === 'error' || item.status === 'cancelling') return '';
    return `<button type="button" class="transfer-cancel-btn" data-transfer-action="cancel" data-transfer-id="${escapeHtml(item.id || '')}" data-transfer-direction="${escapeHtml(item.direction || '')}" title="${t('取消')}" aria-label="${t('取消')}"><span aria-hidden="true">×</span></button>`;
}

// 取消按钮必须在 pointer/touch 阶段就吞掉事件；移动端合成 click 若落到下层按钮，可能误触发断开/跳转。
function bindCancelBtn(containerEl, id, direction) {
    const btn = containerEl.querySelector('.transfer-cancel-btn');
    if (!btn) return;
    btn.dataset.transferAction = 'cancel';
    btn.dataset.transferId = id || '';
    btn.dataset.transferDirection = direction || '';
    const consume = (e) => {
        e?.preventDefault?.();
        e?.stopPropagation?.();
        e?.stopImmediatePropagation?.();
    };
    const fire = (e) => {
        consume(e);
        if (!id || btn.dataset.cancelFired === '1') return;
        btn.dataset.cancelFired = '1';
        if (direction === 'upload') cancelUploadTransfer(id);
        else if (direction === 'download') cancelDownloadTransfer(id);
        else if (direction === 'copy' || direction === 'move') cancelClipboardTransfer(id);
        else if (direction === 'archive') cancelArchiveTransfer(id);
    };
    // 在按下阶段立即取消，避免移动端 pointerup/click 丢失导致“点了没反应”。
    btn.onpointerdown = fire;
    btn.onmousedown = fire;
    btn.ontouchstart = fire;
    btn.onpointerup = consume;
    btn.ontouchend = consume;
    btn.onclick = fire;
}

// Throttled transfer render: at most once per 300ms to avoid re-rendering on every chunk
let transferRenderThrottled = null;
function scheduleTransferRender() {
    if (transferRenderThrottled) return;
    transferRenderThrottled = true;
    window.requestAnimationFrame(() => {
        transferRenderThrottled = false;
        renderTransferPopover();
    });
}

function showTransferPopover({ autoHide = false } = {}) {
    ensureTransferPopover().classList.add('open');
    fmTransferBtn?.setAttribute('aria-expanded', 'true');
    window.clearTimeout(transferPopoverHideTimer);
    positionTransferPopover();
    renderTransferPopover();
    if (autoHide) {
        transferPopoverHideTimer = window.setTimeout(() => hideTransferPopover(), 5200);
    }
}

function hideTransferPopover(force = false) {
    if (!transferPopover) return;
    // Allow explicit close (X button) even with active transfers
    if (!force && getTransferItems().some((item) => item.status === 'active' || item.status === 'pending' || item.status === 'cancelling')) return;
    window.clearTimeout(transferPopoverHideTimer);
    transferPopover.classList.remove('open');
    fmTransferBtn?.setAttribute('aria-expanded', 'false');
}

function markDownloadProgress(id, patch) {
    const current = activeSftpDownloads.get(id) || { id, loaded: 0, size: 0, status: 'pending', updatedAt: Date.now(), speed: 0 };
    if (current._ignoreRemote && patch.status && patch.status !== 'error') return;
    if (current.status === 'cancelling' && (!patch.status || patch.status === 'active' || patch.status === 'pending')) return;
    const next = { ...current, ...patch };
    const statusChanged = patch.status && patch.status !== current.status;
    const wasIgnored = current._ignoreRemote;
    if (patch.loaded !== undefined) {
        updateTransferMetrics(current, patch.loaded);
        next.loaded = current.loaded;
        next.updatedAt = current.updatedAt;
        next.speed = current.speed;
    } else next.updatedAt = Date.now();
    if (wasIgnored) next._ignoreRemote = true;
    activeSftpDownloads.set(id, next);
    if (statusChanged) scheduleTransferRender();
    else updateProgressDisplay(id);
}

async function sha256HexFromBlob(blob) {
    if (!window.crypto?.subtle) throw new Error(t('当前浏览器不支持 SHA-256 校验'));
    const buffer = await blob.arrayBuffer();
    const digest = await window.crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function canUseVerifiedChunkedDownload(download, totalSize, fileName = '') {
    if (!(totalSize > 0 && totalSize <= 1024 * 1024 * 1024 && download?.hashUrl)) return false;
    // HTTP 非安全上下文通常没有 crypto.subtle；媒体文件用 Blob 拼接也容易在移动端占满内存。
    // 这些场景走浏览器原生流式下载，更稳定，也避免下载触发 iframe 导航导致终端会话被卸载。
    if (!window.crypto?.subtle) return false;
    if (isSftpMediaFile(fileName || download?.path || '')) return false;
    return true;
}

function triggerNativeDownloadUrl(url, fileName = 'download') {
    const absoluteUrl = new URL(url, location.href).href;
    if (embeddedMode && window.parent && window.parent !== window) {
        window.parent.postMessage({ source: 'zephyr-terminal', type: 'download-url', url: absoluteUrl, name: fileName }, '*');
        return;
    }
    const a = document.createElement('a');
    a.href = absoluteUrl;
    a.download = fileName;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    window.setTimeout(() => { try { a.remove(); } catch {} }, 1000);
}

// === 浏览器原生下载：通过父页面打开独立下载目标，避免当前 app/terminal 被下载响应替换 ===
// 传输面板通过服务端进度轮询反映真实进度
// 暂停：终止服务端流（浏览器会看到下载失败）
// 继续：重新发起下载（从零开始，服务端支持 Range）
async function startChunkedDownload(download) {
    if (!download || !download.url) return;
    const id = download.downloadId || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const totalSize = Number(download.size) || 0;
    const fileName = download.name || (download.path || 'download').split('/').pop() || 'download';

    if (!activeSftpDownloads.has(id)) {
        activeSftpDownloads.set(id, {
            id, downloadId: id,
            path: download.path, name: fileName, size: totalSize, loaded: 0,
            status: 'active', url: download.url,
            progressUrl: download.progressUrl || '', controlUrl: download.controlUrl || '', hashUrl: download.hashUrl || '',
            speed: 0, updatedAt: Date.now(), _offset: 0,
        });
    } else {
        const entry = activeSftpDownloads.get(id);
        Object.assign(entry, {
            id, downloadId: id,
            path: download.path || entry.path,
            name: fileName,
            size: totalSize || entry.size || 0,
            status: 'active',
            url: download.url || entry.url,
            progressUrl: download.progressUrl || entry.progressUrl || '',
            controlUrl: download.controlUrl || entry.controlUrl || '',
            hashUrl: download.hashUrl || entry.hashUrl || '',
            updatedAt: Date.now(),
        });
    }

    // 小文件可选浏览器端 SHA-256 校验；HTTP 非安全上下文/媒体文件优先走原生流式下载，避免内存和会话问题。
    if (canUseVerifiedChunkedDownload(download, totalSize, fileName)) {
        verifiedChunkedDownload(id, fileName, download.url, totalSize, download.hashUrl).catch((err) => {
            markDownloadProgress(id, { status: 'error' });
            showToast('下载校验失败: ' + (err.message || t('未知错误')), 'error');
        });
        return;
    }
    nativeDownload(id, fileName, download.url, totalSize);
}

async function verifiedChunkedDownload(id, fileName, url, totalSize, hashUrl) {
    const hashRes = await fetch(hashUrl, { credentials: 'same-origin', cache: 'no-store' });
    if (!hashRes.ok) throw new Error(t('获取远端 SHA-256 失败：HTTP {status}', { status: hashRes.status }));
    const hashData = await hashRes.json();
    const expectedHash = String(hashData.sha256 || '').toLowerCase();
    if (!expectedHash) throw new Error(t('远端 SHA-256 为空'));
    const chunkSize = 8 * 1024 * 1024;
    const chunks = [];
    let loaded = 0;
    for (let start = 0; start < totalSize; start += chunkSize) {
        const end = Math.min(totalSize - 1, start + chunkSize - 1);
        const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store', headers: { Range: `bytes=${start}-${end}` } });
        if (!(res.ok || res.status === 206)) throw new Error(t('下载分片失败：HTTP {status}', { status: res.status }));
        const blob = await res.blob();
        chunks.push(blob);
        loaded += blob.size;
        markDownloadProgress(id, { loaded, size: totalSize, status: 'active' });
    }
    const finalBlob = new Blob(chunks);
    const actualHash = await sha256HexFromBlob(finalBlob);
    if (actualHash !== expectedHash) throw new Error(t('SHA-256 不一致（远端 {remote}，本地 {local}）', { remote: expectedHash, local: actualHash }));
    const objectUrl = URL.createObjectURL(finalBlob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = fileName;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    window.setTimeout(() => { try { URL.revokeObjectURL(objectUrl); a.remove(); } catch {} }, 2000);
    markDownloadProgress(id, { loaded: totalSize, size: totalSize, status: 'done' });
    showToast('下载完成，SHA-256 校验通过', 'success');
    window.setTimeout(() => { activeSftpDownloads.delete(id); scheduleTransferRender(); }, 5000);
}

function nativeDownload(id, fileName, url, totalSize) {
    const entry = activeSftpDownloads.get(id);
    if (!entry) return;

    // 触发浏览器原生下载。必须避免隐藏 iframe：部分 Android/HTTP 环境会把下载响应当成页面导航，导致看起来像退出登录。
    triggerNativeDownloadUrl(url, fileName);

    // 开始轮询服务端进度
    startProgressPoll(id, totalSize, entry.progressUrl || '');
}

function startProgressPoll(id, size = 0, progressUrl = '') {
    const total = Number(size) || 0;
    const tick = async () => {
        const item = activeSftpDownloads.get(id);
        if (!item || item.status === 'done' || item.status === 'error') return;
        if (item.status === 'paused') {
            item._timer = window.setTimeout(tick, 1000);
            return;
        }
        if (progressUrl) {
            try {
                const res = await fetch(progressUrl, { credentials: 'same-origin', cache: 'no-store' });
                if (res.ok) {
                    const data = await res.json();
                    markDownloadProgress(id, { loaded: Number(data.loaded) || 0, size: Number(data.size) || total, status: data.status || 'active' });
                    if (data.status === 'done' || data.status === 'error') {
                        window.setTimeout(() => { activeSftpDownloads.delete(id); scheduleTransferRender(); }, data.status === 'done' ? 5000 : 8000);
                        return;
                    }
                }
            } catch (_) {}
        }
        const current = activeSftpDownloads.get(id);
        if (!current || current.status === 'done' || current.status === 'error') return;
        current._timer = window.setTimeout(tick, 900);
    };
    tick();
}

function markUploadProgress(id, patch) {
    const current = activeSftpUploads.get(id);
    if (!current) return;
    const statusChanged = patch.status && patch.status !== current.status;
    if (patch.loaded !== undefined) {
        updateTransferMetrics(current, patch.loaded);
        const preservedMetrics = { loaded: current.loaded, updatedAt: current.updatedAt, speed: current.speed };
        Object.assign(current, patch, preservedMetrics);
    } else {
        Object.assign(current, patch);
        current.updatedAt = Date.now();
    }
    if (statusChanged) scheduleTransferRender();
    else updateProgressDisplay(id);
}

function sendDownloadControl(download, action) {
    if (!download?.controlUrl) return Promise.resolve(null);
    return fetch(download.controlUrl, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
    }).catch(() => null);
}

function cancelUploadTransfer(id) {
    const upload = activeSftpUploads.get(id);
    if (!upload) return;
    upload.cancelled = true;
    upload.status = 'error';
    upload.controller?.abort?.();
    markUploadProgress(id, { status: 'error' });
    if (wsConnection?.readyState === WebSocket.OPEN && isConnected) {
        sendJsonMessage({ type: 'sftp-upload-cancel', uploadId: id });
    }
    showToast('已取消上传', 'info');
    window.setTimeout(() => { activeSftpUploads.delete(id); scheduleTransferRender(); }, 1200);
}

function pauseUploadTransfer(id) {
    const upload = activeSftpUploads.get(id);
    if (!upload) return;
    upload.paused = true;
    upload.controller?.abort?.();
    markUploadProgress(id, { status: 'paused' });
}

function resumeUploadTransfer(id) {
    const upload = activeSftpUploads.get(id);
    if (!upload) return;
    showToast('继续上传', 'info');
    // Reuse existing URL and resume from saved offset
    if (upload.url) {
        markUploadProgress(id, { status: 'active' });
        sendSftpUploadChunk(upload, upload._offset || 0);
    } else {
        // Fallback: request new token
        sendJsonMessage({ type: 'sftp-upload-start', uploadId: upload.id, path: upload.path, name: upload.file.name, size: upload.file.size, sha256: upload.sha256 || '' });
    }
}

function cancelDownloadTransfer(id) {
    const download = activeSftpDownloads.get(id);
    if (!download) return;
    download.cancelled = true;
    download.status = 'error';
    markDownloadProgress(id, { status: 'error' });
    sendDownloadControl(download, 'cancel');
    showToast('已取消下载', 'info');
    window.setTimeout(() => { activeSftpDownloads.delete(id); scheduleTransferRender(); }, 1200);
}

function cancelClipboardTransfer(id) {
    const item = activeSftpDownloads.get(id);
    if (!item || item.status === 'cancelling' || item.status === 'error' || item.status === 'done') return;
    item.cancelled = true;
    item._ignoreRemote = true;
    markDownloadProgress(id, { status: 'cancelling', cancelled: true });
    sendJsonMessage({ type: 'sftp-clipboard-cancel', transferId: id });
    showToast('正在取消复制任务...', 'info');
    window.setTimeout(() => {
        const latest = activeSftpDownloads.get(id);
        if (latest?.status === 'cancelling') markDownloadProgress(id, { status: 'error', cancelled: true });
    }, 1800);
    window.setTimeout(() => { activeSftpDownloads.delete(id); scheduleTransferRender(); }, 4200);
}

function cancelArchiveTransfer(id) {
    const item = activeSftpDownloads.get(id);
    if (!item || item.status === 'cancelling' || item.status === 'error' || item.status === 'done') return;
    item.cancelled = true;
    item._ignoreRemote = true;
    markDownloadProgress(id, { status: 'cancelling', cancelled: true, cancellable: true });
    sendJsonMessage({ type: 'sftp-archive-cancel', transferId: id });
    showToast('正在取消归档任务...', 'info');
    window.setTimeout(() => {
        const latest = activeSftpDownloads.get(id);
        if (latest?.status === 'cancelling') markDownloadProgress(id, { status: 'error', cancelled: true });
    }, 1800);
    window.setTimeout(() => { activeSftpDownloads.delete(id); scheduleTransferRender(); }, 4200);
}

function pauseDownloadTransfer(id) {
    const download = activeSftpDownloads.get(id);
    if (!download) return;
    if (download.status === 'paused') return; // 已暂停
    download.status = 'paused';
    // 让服务端中止流（浏览器原生下载会显示失败，但面板显示已暂停）
    sendDownloadControl(download, 'pause');
    markDownloadProgress(id, { status: 'paused' });
}

function resumeDownloadTransfer(id) {
    const download = activeSftpDownloads.get(id);
    if (!download?.url) return;
    // 浏览器原生下载无法从偏移继续 → 重新从头开始 <a> 标签下载
    markDownloadProgress(id, { status: 'active', loaded: 0 });
    showToast('重新开始下载', 'info');
    startChunkedDownload(download);
}

function handleTransferActionClick(e) {
    // 只处理 transfer-popover 内的取消按钮
    if (!transferPopover?.classList.contains('open')) return;
    if (!e.target.closest('.transfer-popover')) return;
    const btn = e.target.closest('[data-transfer-action]');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const id = btn.dataset.transferId;
    const direction = btn.dataset.transferDirection;
    if (direction === 'upload') {
        cancelUploadTransfer(id);
    } else if (direction === 'download') {
        cancelDownloadTransfer(id);
    } else if (direction === 'copy' || direction === 'move') {
        cancelClipboardTransfer(id);
    }
}

// ---------- 通用提示 ----------
function showToast(message, type = 'info', timeout = 2800) {
    let container = document.querySelector('.toast-container');
    if (!container) {
        container = document.createElement('div');
        container.className = 'toast-container';
        document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    window.setTimeout(() => {
        toast.classList.remove('show');
        window.setTimeout(() => toast.remove(), 220);
    }, timeout);
}

function sendJsonMessage(payload) {
    if (!wsConnection || wsConnection.readyState !== WebSocket.OPEN || !isConnected) {
        showToast('SSH 尚未连接', 'error');
        return false;
    }
    wsConnection.send(JSON.stringify(payload));
    return true;
}

function animatePanelFromButton(panel, button, opening = true) {
    if (!panel || !button) return;
    const panelRect = panel.getBoundingClientRect?.();
    const buttonRect = button.getBoundingClientRect?.();
    if (!panelRect || !buttonRect || panelRect.width <= 1 || panelRect.height <= 1) return;
    const originX = ((buttonRect.left + buttonRect.width / 2 - panelRect.left) / panelRect.width) * 100;
    const originY = ((buttonRect.top + buttonRect.height / 2 - panelRect.top) / panelRect.height) * 100;
    panel.style.setProperty('--panel-origin-x', `${Math.max(8, Math.min(92, originX))}%`);
    panel.style.setProperty('--panel-origin-y', `${Math.max(8, Math.min(92, originY))}%`);
    panel.classList.remove('panel-opening', 'panel-closing');
    void panel.offsetWidth;
    panel.classList.add(opening ? 'panel-opening' : 'panel-closing');
}
function clearPanelMotion(panel) {
    if (!panel) return;
    panel.classList.remove('panel-opening', 'panel-closing');
}


function updateFileButtonActiveState() {
    fileBtn?.classList.toggle('active', fileManager.classList.contains('open') || extraFileManagerWindows.size > 0);
}
function refreshExtraFileManagerWindows() {
    extraFileManagerWindows.forEach((state) => state?.refresh?.());
}
function refreshAllOpenFileManagers() {
    refreshFileList();
    refreshExtraFileManagerWindows();
}
function getNextFileManagerOffset() {
    const n = Math.max(0, fileManagerWindowSeq - 1);
    return { dx: 28 * (n % 8), dy: 24 * (n % 8) };
}
function createFileManagerWindow({ path = currentPath } = {}) {
    const panel = fileManager.cloneNode(true);
    const seq = ++fileManagerWindowSeq;
    const requestPrefix = `fmw-${seq}-${Date.now().toString(36)}`;
    const state = { panel, requestPrefix, currentPath: path || '.', allFiles: [], selectedFilePaths: new Set(), searchQuery: '', mobileSelectMode: false };
    state.refresh = refresh;
    panel.id = `fileManagerWindow${seq}`;
    panel.querySelectorAll('[id]').forEach((el) => { el.removeAttribute('id'); });
    panel.querySelector('.fm-editor-modal')?.remove();
    panel.querySelectorAll('[data-drag-panel]').forEach((el) => el.removeAttribute('data-drag-panel'));
    panel.querySelectorAll('[data-resize-panel]').forEach((el) => el.removeAttribute('data-resize-panel'));
    panel.classList.remove('open', 'front', 'front-switching', 'panel-opening', 'panel-closing', 'dragging', 'resizing', 'drag-over');
    panel.style.display = 'flex';
    const mount = fileManager.parentElement || terminalContainer.parentElement || document.querySelector('.terminal-page') || document.body;
    mount.appendChild(panel);

    const backBtn = panel.querySelector('.fm-back-btn');
    const transferBtn = panel.querySelector('.fm-transfer-btn');
    const pathInput = panel.querySelector('.fm-path-input');
    const goBtn = panel.querySelector('.fm-path-box .tool-btn');
    const refreshBtn = panel.querySelector('.fm-refresh-btn');
    const closeBtn = panel.querySelector('.fm-close-btn');
    const searchInput = panel.querySelector('.fm-search-input');
    const newFolderBtn = Array.from(panel.querySelectorAll('.fm-toolbar .tool-btn')).find((btn) => btn.textContent.includes(t('新建文件夹')));
    const newFileBtn = Array.from(panel.querySelectorAll('.fm-toolbar .tool-btn')).find((btn) => btn.textContent.includes(t('新建文件')));
    const uploadInput = panel.querySelector('input[type="file"]');
    const uploadLabel = panel.querySelector('.fm-upload-label');
    const selectBtn = panel.querySelector('.fm-select-btn');
    const pasteBtn = panel.querySelector('.fm-paste-btn');
    const dropOverlay = panel.querySelector('.fm-drop-overlay');
    const listEl = panel.querySelector('.fm-list');
    const layoutBtn = panel.querySelector('.panel-traffic-btn');
    if (layoutBtn) {
        layoutBtn.dataset.layoutPanel = panel.id;
        layoutBtn.dataset.extraFileManagerLayout = requestPrefix;
    }
    const dragHandles = [panel.querySelector('.panel-drag-handle'), panel.querySelector('.panel-titlebar')].filter(Boolean);
    const resizeHandles = panel.querySelectorAll('.panel-resize-handle');
    const uploadInputId = `fmUploadInputWindow${seq}`;
    if (uploadInput) uploadInput.id = uploadInputId;
    if (uploadLabel) uploadLabel.setAttribute('for', uploadInputId);

    function fullPath(name) { return state.currentPath.replace(/\/+$/, '') + '/' + name; }
    function selectedFiles() { return [...state.selectedFilePaths].map((filePath) => { const file = state.allFiles.find((f) => fullPath(f.name) === filePath) || {}; return { ...file, path: filePath, name: file.name || filePath.split('/').pop() || filePath, type: file.type || '-' }; }); }
    function updateSelectionUI() { listEl?.querySelectorAll('.fm-item').forEach((item) => item.classList.toggle('selected', state.selectedFilePaths.has(item.dataset.filePath))); updateMobileActions(); }
    function selectSingle(filePath) { state.selectedFilePaths = new Set([filePath]); updateSelectionUI(); }
    function toggleSelection(filePath) { if (state.selectedFilePaths.has(filePath)) state.selectedFilePaths.delete(filePath); else state.selectedFilePaths.add(filePath); updateSelectionUI(); }
    function clearSelection() { state.selectedFilePaths.clear(); updateSelectionUI(); }
    function syncGlobalFileContext() {
        currentPath = state.currentPath;
        allFiles = state.allFiles;
        selectedFilePaths = new Set(state.selectedFilePaths);
        if (fmPathInput) fmPathInput.value = currentPath;
    }
    function updateMobileActions() {
        const touch = isTouchLikeDevice();
        if (selectBtn) { selectBtn.style.display = touch ? 'inline-flex' : 'none'; selectBtn.classList.toggle('active', state.mobileSelectMode); selectBtn.textContent = state.mobileSelectMode ? `完成${state.selectedFilePaths.size ? `(${state.selectedFilePaths.size})` : ''}` : t('选择'); }
        if (pasteBtn) pasteBtn.style.display = touch && sftpClipboardAvailable ? 'inline-flex' : 'none';
    }
    function refresh() {
        syncGlobalFileContext();
        if (!sftpReady || !wsConnection || wsConnection.readyState !== WebSocket.OPEN) return;
        const requestId = `${requestPrefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        fileManagerWindowsByRequestId.set(requestId, state);
        wsConnection.send(JSON.stringify({ type: 'sftp-list', requestId, path: state.currentPath }));
        if (pathInput) pathInput.value = state.currentPath;
    }
    function navigate(path) { state.currentPath = path; state.searchQuery = ''; if (searchInput) searchInput.value = ''; state.mobileSelectMode = false; updateMobileActions(); refresh(); }
    function render(files) {
        state.allFiles = sortFiles(files || []);
        const filtered = filterFiles(state.allFiles, state.searchQuery);
        if (!listEl) return;
        listEl.innerHTML = '';
        filtered.forEach((file) => {
            const item = document.createElement('div');
            item.className = 'fm-item';
            const itemPath = fullPath(file.name);
            item.dataset.fileName = file.name;
            item.dataset.fileType = file.type;
            item.dataset.filePath = itemPath;
            item.classList.toggle('selected', state.selectedFilePaths.has(itemPath));
            const nameSpan = document.createElement('span');
            nameSpan.className = 'fm-item-name';
            nameSpan.innerHTML = `${zephyrFileGlyph(file)}<span class="fm-item-filename">${escapeHtml(file.name)}</span>`;
            nameSpan.title = file.type === 'd' ? t('打开文件夹') : t('打开文件');
            nameSpan.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); selectSingle(itemPath); });
            nameSpan.addEventListener('dblclick', (e) => { e.preventDefault(); e.stopPropagation(); openItem(itemPath, file.type); });
            const actions = document.createElement('div');
            actions.className = 'fm-item-actions';
            if (file.type !== 'd') {
                const downloadBtn = document.createElement('button');
                setZephyrIconButton(downloadBtn, 'download', t('下载'));
                downloadBtn.title = t('下载');
                downloadBtn.addEventListener('click', (e) => { e.stopPropagation(); downloadBtn.disabled = true; window.setTimeout(() => { downloadBtn.disabled = false; }, 2400); requestDownload({ ...file, path: itemPath }); });
                actions.appendChild(downloadBtn);
            }
            const renameBtn = document.createElement('button');
            renameBtn.innerHTML = svgIcon('rename');
            renameBtn.setAttribute('aria-label', t('重命名'));
            renameBtn.title = t('重命名');
            renameBtn.addEventListener('click', (e) => { e.stopPropagation(); const newName = prompt(t('新名称:'), file.name); if (!newName) return; wsConnection.send(JSON.stringify({ type: 'sftp-rename', oldPath: itemPath, newPath: fullPath(newName) })); });
            const deleteBtn = document.createElement('button');
            setZephyrIconButton(deleteBtn, 'delete', t('删除'));
            deleteBtn.title = t('删除');
            deleteBtn.addEventListener('click', (e) => { e.stopPropagation(); if (confirm(t('确认删除 {name}?', { name: file.name }))) wsConnection.send(JSON.stringify({ type: 'sftp-delete', path: itemPath })); });
            actions.appendChild(renameBtn); actions.appendChild(deleteBtn);
            item.appendChild(nameSpan); item.appendChild(actions); listEl.appendChild(item);
        });
    }
    function openItem(filePath, fileType) {
        if (fileType === 'd') { navigate(filePath); return; }
        if (window.ZephyrImagePreview?.isImage?.(filePath)) { openImagePreview(filePath); return; }
        if (isSftpMediaFile(filePath)) { openMediaPreview(filePath); return; }
        openEditor(filePath);
    }
    function close() {
        if (typeof closePanelLayoutMenu === 'function') closePanelLayoutMenu({ instant: true });
        animatePanelFromButton(panel, fileBtn, false);
        panel.classList.remove('open');
        extraFileManagerWindows.delete(state);
        for (const [requestId, owner] of fileManagerWindowsByRequestId.entries()) if (owner === state) fileManagerWindowsByRequestId.delete(requestId);
        updateFileButtonActiveState();
        window.setTimeout(() => panel.remove(), 320);
    }
    function newFolder() { const name = prompt(t('请输入文件夹名称:')); if (name) wsConnection.send(JSON.stringify({ type: 'sftp-mkdir', path: fullPath(name) })); }
    function newFile() { const name = prompt(t('请输入文件名:')); if (name) wsConnection.send(JSON.stringify({ type: 'sftp-touch', path: fullPath(name) })); }
    function uploadLocalFiles(fileList) {
        const previous = currentPath;
        currentPath = state.currentPath;
        try { uploadFiles(fileList); }
        finally { currentPath = previous; }
    }
    state.close = close;

    refreshBtn?.addEventListener('click', refresh);
    closeBtn?.addEventListener('click', close);
    goBtn?.addEventListener('click', () => { const p = pathInput?.value.trim(); if (p) navigate(p); });
    pathInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const p = pathInput.value.trim(); if (p) navigate(p); } });
    backBtn?.addEventListener('click', () => { const parts = state.currentPath.replace(/\/+$/, '').split('/'); parts.pop(); navigate(parts.join('/') || '/'); });
    searchInput?.addEventListener('input', () => { state.searchQuery = searchInput.value.trim(); render(state.allFiles); });
    newFolderBtn?.addEventListener('click', newFolder);
    newFileBtn?.addEventListener('click', newFile);
    selectBtn?.addEventListener('click', (e) => { e.preventDefault(); state.mobileSelectMode = !state.mobileSelectMode; if (!state.mobileSelectMode) clearSelection(); updateMobileActions(); });
    pasteBtn?.addEventListener('click', (e) => { e.preventDefault(); syncGlobalFileContext(); if (consumePendingSharedFiles()) return; handleFileMenuAction('paste'); });
    transferBtn?.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); if (transferPopover?.classList.contains('open')) hideTransferPopover(true); else showTransferPopover(); });
    uploadInput?.addEventListener('change', (e) => { uploadLocalFiles(e.target.files); uploadInput.value = ''; });
    listEl?.addEventListener('click', (e) => { if (e.target.closest('.fm-item-actions') || fileContextMenu?.classList.contains('show')) return; const item = e.target.closest('.fm-item'); if (!item) { clearSelection(); return; } const filePath = item.dataset.filePath; if (!filePath) return; if (!isTouchLikeDevice() && (e.ctrlKey || e.metaKey)) toggleSelection(filePath); else if (isTouchLikeDevice() && state.mobileSelectMode) toggleSelection(filePath); else selectSingle(filePath); });
    listEl?.addEventListener('dblclick', (e) => { if (e.target.closest('.fm-item-actions') || fileContextMenu?.classList.contains('show')) return; const item = e.target.closest('.fm-item'); if (!item) return; const filePath = item.dataset.filePath; if (!filePath) return; e.preventDefault(); e.stopPropagation(); openItem(filePath, item.dataset.fileType); });
    listEl?.addEventListener('contextmenu', (e) => { e.preventDefault(); syncGlobalFileContext(); const item = e.target.closest('.fm-item'); if (item?.dataset.filePath) { selectSingle(item.dataset.filePath); selectedFilePaths = new Set(state.selectedFilePaths); } showFileContextMenu(e.clientX, e.clientY, !!item); });
    [dropOverlay, listEl].filter(Boolean).forEach((target) => {
        target.addEventListener('dragenter', (e) => { if (!hasDraggedFiles(e)) return; e.preventDefault(); panel.classList.add('drag-over'); }, { passive: false });
        target.addEventListener('dragover', (e) => { if (!hasDraggedFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; panel.classList.add('drag-over'); }, { passive: false });
        target.addEventListener('dragleave', () => panel.classList.remove('drag-over'), { passive: true });
        target.addEventListener('drop', (e) => { if (!hasDraggedFiles(e)) return; e.preventDefault(); panel.classList.remove('drag-over'); uploadLocalFiles(e.dataTransfer?.files); }, { passive: false });
    });
    layoutBtn?.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); bringPanelToFront(panel); if (navigator.vibrate) navigator.vibrate(8); if (panelLayoutMenu && panelLayoutButton === layoutBtn) closePanelLayoutMenu(); else openPanelLayoutMenu(layoutBtn, panel); });
    dragHandles.forEach((handle) => handle.addEventListener('pointerdown', (e) => {
        if (e.target.closest('button,input,select,textarea,label')) return;
        e.preventDefault(); bringPanelToFront(panel); panel.classList.add('dragging'); handle.setPointerCapture?.(e.pointerId);
        const startX = e.clientX, startY = e.clientY, startLeft = panel.offsetLeft, startTop = panel.offsetTop;
        const onMove = (ev) => { ev.preventDefault(); panel.style.left = `${startLeft + ev.clientX - startX}px`; panel.style.top = `${startTop + ev.clientY - startY}px`; panel.style.right = 'auto'; panel.style.bottom = 'auto'; clampPanel(panel); };
        const onUp = () => { panel.classList.remove('dragging'); window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
        window.addEventListener('pointermove', onMove, { passive: false }); window.addEventListener('pointerup', onUp, { once: true });
    }));
    resizeHandles.forEach((handle) => handle.addEventListener('pointerdown', (e) => {
        e.preventDefault(); bringPanelToFront(panel); panel.classList.add('resizing'); handle.setPointerCapture?.(e.pointerId);
        const startX = e.clientX, startY = e.clientY, startWidth = panel.offsetWidth, startHeight = panel.offsetHeight, startLeft = panel.offsetLeft;
        const edge = handle.classList.contains('left') ? 'left' : 'right';
        const parentRect = panel.parentElement.getBoundingClientRect();
        const minWidth = isCompactScreen() ? 260 : 420, minHeight = isCompactScreen() ? 240 : 320;
        const onMove = (ev) => { ev.preventDefault(); let nextLeft = startLeft; let nextWidth = startWidth + ev.clientX - startX; if (edge === 'left') { nextWidth = startWidth - (ev.clientX - startX); nextLeft = startLeft + (ev.clientX - startX); if (nextWidth < minWidth) { nextLeft -= minWidth - nextWidth; nextWidth = minWidth; } if (nextLeft < 8) { nextWidth += nextLeft - 8; nextLeft = 8; } panel.style.left = `${nextLeft}px`; } const maxWidth = edge === 'left' ? startLeft + startWidth - 8 : parentRect.width - panel.offsetLeft - 12; const maxHeight = parentRect.height - panel.offsetTop - 12; panel.style.width = `${Math.min(Math.max(minWidth, nextWidth), maxWidth)}px`; panel.style.height = `${Math.min(Math.max(minHeight, startHeight + ev.clientY - startY), maxHeight)}px`; };
        const onUp = () => { panel.classList.remove('resizing'); window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
        window.addEventListener('pointermove', onMove, { passive: false }); window.addEventListener('pointerup', onUp, { once: true });
    }));
    panel.addEventListener('pointerdown', () => bringPanelToFront(panel));

    ensureFloatingPanel(panel, getDefaultPanelOptions(fileManager));
    const base = getDefaultPanelOptions(fileManager);
    const { dx, dy } = getNextFileManagerOffset();
    Object.assign(panel.style, { left: `${(base.left || 16) + dx}px`, top: `${(base.top || 52) + dy}px`, width: `${base.width}px`, height: `${base.height}px`, right: 'auto', bottom: 'auto' });
    extraFileManagerWindows.add(state);
    panel.classList.add('open');
    updateFileButtonActiveState();
    updateMobileActions();
    bringPanelToFront(panel);
    requestAnimationFrame(() => animatePanelFromButton(panel, fileBtn, true));
    if (!sftpReady) initSFTP(); else refresh();
    return state;
}
function handleExtraFileManagerListMessage(msg) {
    const requestId = String(msg.requestId || '');
    if (!requestId) return false;
    const state = fileManagerWindowsByRequestId.get(requestId);
    if (!state) return false;
    fileManagerWindowsByRequestId.delete(requestId);
    const pathInput = state.panel.querySelector('.fm-path-input');
    if (msg.error) showToast('列出目录失败: ' + msg.error, 'error');
    else {
        state.selectedFilePaths.clear();
        state.currentPath = msg.path;
        if (pathInput) pathInput.value = state.currentPath;
        const listEl = state.panel.querySelector('.fm-list');
        state.allFiles = sortFiles(msg.files || []);
        const filtered = filterFiles(state.allFiles, state.searchQuery || '');
        if (listEl) {
            listEl.innerHTML = '';
            filtered.forEach((file) => {
                const item = document.createElement('div');
                item.className = 'fm-item';
                const itemPath = state.currentPath.replace(/\/+$/, '') + '/' + file.name;
                item.dataset.fileName = file.name; item.dataset.fileType = file.type; item.dataset.filePath = itemPath;
                const nameSpan = document.createElement('span'); nameSpan.className = 'fm-item-name'; nameSpan.innerHTML = `${zephyrFileGlyph(file)}<span class="fm-item-filename">${escapeHtml(file.name)}</span>`; nameSpan.title = file.type === 'd' ? t('打开文件夹') : t('打开文件');
                nameSpan.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); state.selectedFilePaths = new Set([itemPath]); listEl.querySelectorAll('.fm-item').forEach((el) => el.classList.toggle('selected', el.dataset.filePath === itemPath)); });
                nameSpan.addEventListener('dblclick', (e) => { e.preventDefault(); e.stopPropagation(); if (file.type === 'd') { state.currentPath = itemPath; state.searchQuery = ''; const si = state.panel.querySelector('.fm-search-input'); if (si) si.value = ''; const rid = `${state.requestPrefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`; fileManagerWindowsByRequestId.set(rid, state); wsConnection.send(JSON.stringify({ type: 'sftp-list', requestId: rid, path: state.currentPath })); } else openFileItem(itemPath, file.type); });
                const actions = document.createElement('div'); actions.className = 'fm-item-actions';
                if (file.type !== 'd') { const downloadBtn = document.createElement('button'); setZephyrIconButton(downloadBtn, 'download', t('下载')); downloadBtn.title = t('下载'); downloadBtn.addEventListener('click', (e) => { e.stopPropagation(); requestDownload({ ...file, path: itemPath }); }); actions.appendChild(downloadBtn); }
                const renameBtn = document.createElement('button');
                renameBtn.innerHTML = svgIcon('rename');
                renameBtn.setAttribute('aria-label', t('重命名'));
                renameBtn.title = t('重命名'); renameBtn.addEventListener('click', (e) => { e.stopPropagation(); const newName = prompt(t('新名称:'), file.name); if (newName) wsConnection.send(JSON.stringify({ type: 'sftp-rename', oldPath: itemPath, newPath: state.currentPath.replace(/\/+$/, '') + '/' + newName })); });
                const deleteBtn = document.createElement('button'); setZephyrIconButton(deleteBtn, 'delete', t('删除')); deleteBtn.title = t('删除'); deleteBtn.addEventListener('click', (e) => { e.stopPropagation(); if (confirm(t('确认删除 {name}?', { name: file.name }))) wsConnection.send(JSON.stringify({ type: 'sftp-delete', path: itemPath })); });
                actions.appendChild(renameBtn); actions.appendChild(deleteBtn); item.appendChild(nameSpan); item.appendChild(actions); listEl.appendChild(item);
            });
        }
    }
    return true;
}

// ---------- 文件管理器 ----------
function showFileManager() {
    ensureFloatingPanel(fileManager, getDefaultPanelOptions(fileManager));
    fileManager.classList.add('open');
    updateFileButtonActiveState();
    updateMobileFileActions();
    bringPanelToFront(fileManager);
    requestAnimationFrame(() => animatePanelFromButton(fileManager, fileBtn, true));
    if (!sftpReady) {
        initSFTP();
    } else {
        refreshFileList();
    }
}
function hideFileManager() {
    if (typeof closePanelLayoutMenu === 'function') closePanelLayoutMenu({ instant: true });
    if (typeof closeEditorCommandPalette === 'function') closeEditorCommandPalette(fileManager);
    animatePanelFromButton(fileManager, fileBtn, false);
    fileManager.classList.remove('open');
    updateFileButtonActiveState();
    mobileFileSelectMode = false;
    updateMobileFileActions();
    window.setTimeout(() => clearPanelMotion(fileManager), 320);
}
fileBtn.addEventListener('click', () => {
    if (!fileManager.classList.contains('open') && extraFileManagerWindows.size === 0) showFileManager();
    else createFileManagerWindow({ path: currentPath });
});
fmCloseBtn.addEventListener('click', hideFileManager);

const SNIPPET_STORAGE_KEY = 'zephyr-ssh-snippets';
function loadTerminalSnippets() {
    if (Array.isArray(params?.snippets)) return params.snippets.filter((item) => item && item.command);
    try {
        const data = JSON.parse(localStorage.getItem(SNIPPET_STORAGE_KEY) || '[]');
        return Array.isArray(data) ? data.filter((item) => item && item.command) : [];
    } catch { return []; }
}
function renderSnippetPanel() {
    if (!snippetList) return;
    const query = String(snippetSearch?.value || '').trim().toLowerCase();
    const snippets = loadTerminalSnippets().filter((item) => !query
        || String(item.name || '').toLowerCase().includes(query)
        || String(item.group || '').toLowerCase().includes(query)
        || String(item.command || '').toLowerCase().includes(query));
    snippetList.innerHTML = '';
    snippets.forEach((item) => {
        const btn = document.createElement('button');
        btn.className = 'snippet-item';
        btn.type = 'button';
        btn.innerHTML = `<strong>${escapeHtml(item.name || t('未命名片段'))}</strong><em>${escapeHtml(item.group || t('未分组'))} · ${item.autoRun ? t('直接执行') : t('填入输入框')}</em><code>${escapeHtml(item.command || '')}</code>`;
        btn.addEventListener('click', () => {
            const command = String(item.command || '');
            if (item.autoRun) sendData(command.endsWith('\n') || command.endsWith('\r') ? command : command + '\r', { normalizeNewlines: true, source: 'snippet-run', forceFollow: true });
            else {
                cmdInput.value = command;
                resizeCommandInput();
                cmdInput.focus();
            }
        });
        snippetList.appendChild(btn);
    });
    if (snippetEmpty) snippetEmpty.style.display = snippets.length ? 'none' : 'block';
}
function showSnippetPanel() {
    ensureFloatingPanel(snippetPanel, getDefaultPanelOptions(snippetPanel));
    snippetPanel.style.display = 'flex';
    renderSnippetPanel();
    requestAnimationFrame(() => {
        snippetPanel.classList.add('open');
        snippetBtn?.classList.add('active');
        bringPanelToFront(snippetPanel);
        animatePanelFromButton(snippetPanel, snippetBtn, true);
    });
}
function hideSnippetPanel() {
    if (typeof closePanelLayoutMenu === 'function') closePanelLayoutMenu({ instant: true });
    animatePanelFromButton(snippetPanel, snippetBtn, false);
    snippetPanel.classList.remove('open');
    snippetBtn?.classList.remove('active');
    window.setTimeout(() => { clearPanelMotion(snippetPanel); if (!snippetPanel.classList.contains('open')) snippetPanel.style.display = 'none'; }, 320);
}
function showShortcutPanel() {
    ensureFloatingPanel(shortcutPanel, getDefaultPanelOptions(shortcutPanel));
    shortcutPanel.style.display = 'flex';
    requestAnimationFrame(() => {
        shortcutPanel.classList.add('open');
        shortcutBtn?.classList.add('active');
        bringPanelToFront(shortcutPanel);
        animatePanelFromButton(shortcutPanel, shortcutBtn, true);
    });
}
function hideShortcutPanel() {
    if (typeof closePanelLayoutMenu === 'function') closePanelLayoutMenu({ instant: true });
    animatePanelFromButton(shortcutPanel, shortcutBtn, false);
    shortcutPanel.classList.remove('open');
    shortcutBtn?.classList.remove('active');
    window.setTimeout(() => { clearPanelMotion(shortcutPanel); if (!shortcutPanel.classList.contains('open')) shortcutPanel.style.display = 'none'; }, 320);
}
snippetBtn?.addEventListener('click', () => snippetPanel.classList.contains('open') ? hideSnippetPanel() : showSnippetPanel());
// Notes side panel: postMessage to parent (app.js) to open notes filtered by
// the current connection. The terminal iframe doesn't own the notes UI; the
// app shell does (it has the notesController and ACL context).
const notesBtn = document.getElementById('notesBtn');
let notesFeatureEnabled = false;
function applyNotesFeatureEnabled(enabled) {
    notesFeatureEnabled = !!enabled;
    notesBtn?.classList.toggle('force-hidden', !notesFeatureEnabled);
    if (notesBtn) notesBtn.hidden = !notesFeatureEnabled;
}
applyNotesFeatureEnabled(false);
notesBtn?.addEventListener('click', () => {
    if (!notesFeatureEnabled) {
        showToast('笔记功能未开启，请在设置中启用', 'error');
        return;
    }
    if (embeddedMode && window.parent && window.parent !== window) {
        window.parent.postMessage({
            source: 'zephyr-terminal',
            type: 'open-notes-for-connection',
            tabId: params?.tabId,
            connectionId: params?.connectionId || '',
        }, '*');
    } else {
        showToast('笔记面板需要在应用主界面打开');
    }
});
snippetSearch?.addEventListener('input', renderSnippetPanel);
shortcutBtn?.addEventListener('click', () => shortcutPanel.classList.contains('open') ? hideShortcutPanel() : showShortcutPanel());
window.addEventListener('storage', (event) => { if (event.key === SNIPPET_STORAGE_KEY && snippetPanel?.classList.contains('open')) renderSnippetPanel(); });

function initSFTP() {
    if (!wsConnection || wsConnection.readyState !== WebSocket.OPEN) return;
    wsConnection.send(JSON.stringify({ type: 'sftp-init' }));
}
function refreshFileList() {
    if (!sftpReady) return;
    wsConnection.send(JSON.stringify({ type: 'sftp-list', path: currentPath }));
    fmPathInput.value = currentPath;
}
fmRefreshBtn.addEventListener('click', refreshFileList);

function navigateTo(path) {
    currentPath = path;
    searchQuery = '';
    fmSearchInput.value = '';
    mobileFileSelectMode = false;
    updateMobileFileActions();
    refreshFileList();
}
fmGoBtn.addEventListener('click', () => {
    const p = fmPathInput.value.trim();
    if (p) navigateTo(p);
});
fmPathInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        const p = fmPathInput.value.trim();
        if (p) navigateTo(p);
    }
});
fmBackBtn.addEventListener('click', () => {
    const parts = currentPath.replace(/\/+$/, '').split('/');
    parts.pop();
    navigateTo(parts.join('/') || '/');
});
fmSearchInput.addEventListener('input', () => {
    searchQuery = fmSearchInput.value.trim();
    renderFileList(allFiles);
});

function sortFiles(files) {
    return [...files].sort((a, b) => {
        if (a.type === b.type) return a.name.localeCompare(b.name);
        return a.type === 'd' ? -1 : 1;
    });
}
function filterFiles(files, query) {
    if (!query) return files;
    return files.filter(f => f.name.toLowerCase().includes(query.toLowerCase()));
}


function getShortcutPlatform() {
    if (terminalShortcutPlatform === 'mac' || terminalShortcutPlatform === 'windows') return terminalShortcutPlatform;
    return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || '') ? 'mac' : 'windows';
}
function shortcutLabel(action) {
    const mac = getShortcutPlatform() === 'mac';
    const map = {
        copy: mac ? '⌘C' : 'Ctrl+C', cut: mac ? '⌘X' : 'Ctrl+X', paste: mac ? '⌘V' : 'Ctrl+V',
        rename: 'F2', delete: mac ? '⌫' : 'Del', properties: mac ? '⌘I' : 'Alt+Enter', refresh: mac ? '⌘R' : 'F5',
    };
    return map[action] || '';
}
async function loadTerminalSettings() {
    try {
        const res = await fetch('/api/me/settings', { credentials: 'same-origin', cache: 'no-store' });
        if (!res.ok) return;
        const payload = await res.json();
        const data = payload?.settings || {};
        terminalShortcutPlatform = data?.terminal?.shortcutPlatform || localStorage.getItem('zephyr-shortcut-platform') || 'auto';
        terminalAppearance = data?.appearance || {};
        localStorage.setItem('zephyr-shortcut-platform', terminalShortcutPlatform);
        if (Object.prototype.hasOwnProperty.call(data?.terminal || {}, 'allowLigatures')) {
            terminalAllowLigatures = !!data.terminal.allowLigatures;
            localStorage.setItem('zephyr-terminal-allow-ligatures', terminalAllowLigatures ? '1' : '0');
        }
        applyTheme(getPreferredTheme());
        applyWtermTheme(getPreferredWtermTheme());
        applyTerminalLigatures(terminalAllowLigatures, { persist: false });
        applyNotesFeatureEnabled(!!data?.notes?.enabled);
    } catch (_) {
        applyNotesFeatureEnabled(false);
    }
}
loadTerminalSettings();
function fullFilePath(name) { return currentPath.replace(/\/+$/, '') + '/' + name; }
function getFileByPath(filePath) { return allFiles.find((f) => fullFilePath(f.name) === filePath); }
function getSelectedFiles() {
    return [...selectedFilePaths].map((filePath) => {
        const file = getFileByPath(filePath) || {};
        return { ...file, path: filePath, name: file.name || filePath.split('/').pop() || filePath, type: file.type || '-' };
    });
}
function clearFileSelection() {
    selectedFilePaths.clear();
    updateFileSelectionUI();
    updateMobileFileActions();
}
function selectSingleFile(filePath) {
    selectedFilePaths = new Set([filePath]);
    updateFileSelectionUI();
    updateMobileFileActions();
}
function toggleFileSelection(filePath) {
    if (selectedFilePaths.has(filePath)) selectedFilePaths.delete(filePath);
    else selectedFilePaths.add(filePath);
    updateFileSelectionUI();
    updateMobileFileActions();
}
function updateFileSelectionUI() {
    fmList.querySelectorAll('.fm-item').forEach((item) => {
        item.classList.toggle('selected', selectedFilePaths.has(item.dataset.filePath));
    });
}
function openFileItem(filePath, fileType) {
    if (fileType === 'd') { navigateTo(filePath); return; }
    if (window.ZephyrImagePreview?.isImage?.(filePath)) { openImagePreview(filePath); return; }
    if (isSftpMediaFile(filePath)) { openMediaPreview(filePath); return; }
    openEditor(filePath);
}
function isTouchLikeDevice() {
    return window.matchMedia?.('(pointer: coarse)')?.matches || navigator.maxTouchPoints > 0;
}
function updateMobileFileActions() {
    const touch = isTouchLikeDevice();
    if (fmSelectBtn) {
        fmSelectBtn.style.display = touch ? 'inline-flex' : 'none';
        fmSelectBtn.classList.toggle('active', mobileFileSelectMode);
        fmSelectBtn.textContent = mobileFileSelectMode ? `完成${selectedFilePaths.size ? `(${selectedFilePaths.size})` : ''}` : t('选择');
    }
    if (fmPasteBtn) {
        fmPasteBtn.style.display = touch && sftpClipboardAvailable ? 'inline-flex' : 'none';
    }
}
fmSelectBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    mobileFileSelectMode = !mobileFileSelectMode;
    if (!mobileFileSelectMode) clearFileSelection();
    updateMobileFileActions();
});
fmPasteBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    if (consumePendingSharedFiles()) return;
    handleFileMenuAction('paste');
});
window.addEventListener('resize', updateMobileFileActions);
fmList.addEventListener('click', (e) => {
    if (e.target.closest('.fm-item-actions') || fileContextMenu?.classList.contains('show')) return;
    const item = e.target.closest('.fm-item');
    if (!item) { clearFileSelection(); return; }
    const filePath = item.dataset.filePath;
    if (!filePath) return;
    if (!isTouchLikeDevice() && (e.ctrlKey || e.metaKey)) toggleFileSelection(filePath);
    else if (isTouchLikeDevice() && mobileFileSelectMode) toggleFileSelection(filePath);
    else selectSingleFile(filePath);
});
fmList.addEventListener('dblclick', (e) => {
    if (e.target.closest('.fm-item-actions') || fileContextMenu?.classList.contains('show')) return;
    const item = e.target.closest('.fm-item');
    if (!item) return;
    const filePath = item.dataset.filePath;
    const fileType = item.dataset.fileType;
    if (!filePath) return;
    e.preventDefault();
    e.stopPropagation();
    openFileItem(filePath, fileType);
});
fmList.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const item = e.target.closest('.fm-item');
    if (item?.dataset.filePath && !selectedFilePaths.has(item.dataset.filePath)) selectSingleFile(item.dataset.filePath);
    else if (!item) clearFileSelection();
    showFileContextMenu(e.clientX, e.clientY, !!item);
});
fmList.addEventListener('touchstart', (e) => {
    const item = e.target.closest('.fm-item');
    if (!item) return;
    const touch = e.touches?.[0];
    clearTimeout(fileLongPressTimer);
    fileLongPressTimer = window.setTimeout(() => {
        navigator.vibrate?.(10);
        selectSingleFile(item.dataset.filePath);
        showFileContextMenu(touch?.clientX || 24, touch?.clientY || 24, true);
    }, mobileFileSelectMode ? 900 : 460);
}, { passive: true });
['touchend', 'touchmove', 'touchcancel'].forEach((name) => fmList.addEventListener(name, () => clearTimeout(fileLongPressTimer), { passive: true }));

function svgIcon(name) {
    const icons = {
        copy: '<rect x="9" y="4" width="10" height="12" rx="2"></rect><rect x="5" y="8" width="10" height="12" rx="2"></rect>',
        paste: '<path d="M16 4h-2.18A2 2 0 0 0 12 3a2 2 0 0 0-1.82 1H8a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z"></path><rect x="9" y="8" width="6" height="6" rx="1"></rect>',
        cut: '<path d="M14.5 9.5L21 3"></path><path d="M3 21l7-7"></path><circle cx="6" cy="6" r="3"></circle><circle cx="15" cy="15" r="3"></circle>',
        zip: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v6"></path><path d="M12 17V11"></path><path d="M9 14l3 3 3-3"></path>',
        unzip: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v6"></path><path d="M12 11v6"></path><path d="M9 14l3-3 3 3"></path>',
        rename: '<path d="M3 21l3-1 11-11a2.5 2.5 0 0 0-3.5-3.5L6.5 16.5 5 20z"></path><path d="M14 7l3 3"></path>',
        delete: '<polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path>',
        download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line>',
        info: '<rect x="3" y="6" width="18" height="12" rx="2"></rect><path d="M8 9h6"></path><circle cx="8" cy="15" r="1.2"></circle><circle cx="12" cy="12" r="1.2"></circle><circle cx="16" cy="9" r="1.2"></circle>',
        chmod: '<rect x="4" y="10" width="16" height="10" rx="2"></rect><path d="M8 10V7a4 4 0 0 1 7.5-2"></path><path d="M12 14v2"></path><circle cx="12" cy="14" r="1"></circle>',
        refresh: '<path d="M21 12a9 9 0 0 1-15.5 6.2"></path><path d="M3 12A9 9 0 0 1 18.5 5.8"></path><path d="M18 2v4h4"></path><path d="M6 22v-4H2"></path>',
        newFolder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><path d="M12 9.8v6"></path><path d="M9 12.8h6"></path>',
        newFile: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><path d="M14 2v6h6"></path><path d="M12 9.8v6"></path><path d="M9 12.8h6"></path>',
        folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>',
        file: '<path d="M6 3h8l4 4v14H6z"></path><path d="M14 3v5h5"></path>',
        open: '<path d="M14 3h7v7"></path><path d="M10 14L21 3"></path><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"></path>',
    };
    return `<span class="fm-menu-icon"><svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.info}</svg></span>`;
}
function ensureFileContextMenu() {
    if (fileContextMenu) return;
    fileContextOverlay = document.createElement('div');
    fileContextOverlay.className = 'fm-context-overlay';
    fileContextMenu = document.createElement('div');
    fileContextMenu.className = 'fm-context-menu';
    document.body.appendChild(fileContextOverlay);
    document.body.appendChild(fileContextMenu);
    fileContextOverlay.addEventListener('click', hideFileContextMenu);
    fileContextMenu.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const action = btn.dataset.action;
        hideFileContextMenu();
        handleFileMenuAction(action);
    });
}
function hideFileContextMenu() {
    fileContextOverlay?.classList.remove('show');
    fileContextMenu?.classList.remove('show');
}
function menuButton(action, label, icon, shortcut = '', danger = false) {
    return `<button type="button" class="fm-context-item${danger ? ' danger' : ''}" data-action="${action}"><span class="fm-menu-left">${svgIcon(icon)}<span>${escapeHtml(label)}</span></span>${shortcut ? `<span class="fm-menu-shortcut">${escapeHtml(shortcut)}</span>` : ''}</button>`;
}
function isArchiveFile(name = '') { return /\.(zip|tar|tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz|gz|bz2|xz|7z|rar)$/i.test(name); }
const SFTP_ARCHIVE_EXTENSIONS = ['.zip', '.tar.gz', '.tgz', '.tar.bz2', '.tbz2', '.tar.xz', '.txz', '.tar', '.7z', '.gz', '.bz2', '.xz'];
let sftpPasteConflictMemory = null;
const pendingSftpConflictChecks = new Map();
const pendingSftpProperties = new Map();
function showFileContextMenu(x, y, onItem) {
    ensureFileContextMenu();
    const selected = getSelectedFiles();
    const single = selected.length === 1 ? selected[0] : null;
    let html = '';
    if (selected.length) {
        html += menuButton('copy', t('复制'), 'copy', shortcutLabel('copy'));
        html += menuButton('cut', t('剪切'), 'cut', shortcutLabel('cut'));
        html += menuButton('paste', t('粘贴'), 'paste', shortcutLabel('paste'));
        html += '<div class="fm-context-divider"></div>';
        if (single && single.type !== 'd' && isArchiveFile(single.name)) html += menuButton('extract', t('解压'), 'unzip');
        if (!single || single.type === 'd' || !isArchiveFile(single.name)) html += menuButton('compress', t('压缩'), 'zip');
        if (single) html += menuButton('rename', t('重命名'), 'rename', shortcutLabel('rename'));
        html += menuButton('delete', t('删除'), 'delete', shortcutLabel('delete'), true);
        html += '<div class="fm-context-divider"></div>';
        html += menuButton('download', selected.length > 1 ? t('打包下载') : t('下载'), 'download');
        html += menuButton('properties', t('属性'), 'info', shortcutLabel('properties'));
    } else {
        html += menuButton('refresh', t('刷新'), 'refresh', shortcutLabel('refresh'));
        html += menuButton('newFolder', t('新建文件夹'), 'newFolder');
        html += menuButton('newFile', t('新建文件'), 'newFile');
        html += menuButton('paste', t('粘贴'), 'paste', shortcutLabel('paste'));
    }
    fileContextMenu.innerHTML = html;
    fileContextMenu.style.left = '0px';
    fileContextMenu.style.top = '0px';
    fileContextMenu.style.maxHeight = Math.max(180, window.innerHeight - 24) + 'px';
    fileContextOverlay.classList.add('show');
    fileContextMenu.classList.add('show');
    const rect = fileContextMenu.getBoundingClientRect();
    const menuWidth = rect.width || 260;
    const menuHeight = Math.min(rect.height || 420, window.innerHeight - 24);
    x = Math.min(x, window.innerWidth - menuWidth - 12);
    if (y + menuHeight > window.innerHeight - 12) y = window.innerHeight - menuHeight - 12;
    fileContextMenu.style.left = Math.max(8, x) + 'px';
    fileContextMenu.style.top = Math.max(8, y) + 'px';
}
function archiveExtensionOf(name = '') {
    const lower = String(name || '').toLowerCase();
    return SFTP_ARCHIVE_EXTENSIONS.find((ext) => lower.endsWith(ext)) || '';
}
function withArchiveExtension(name, ext) {
    let text = String(name || '').trim();
    if (!text) return text;
    const current = archiveExtensionOf(text);
    if (current) text = text.slice(0, -current.length);
    return `${text}${ext || '.tar.gz'}`;
}
function chooseArchiveTargetPath(defaultName) {
    const extList = SFTP_ARCHIVE_EXTENSIONS.join(' / ');
    const input = prompt(t('压缩到（支持 {extensions}）：', { extensions: extList }), fullFilePath(defaultName));
    if (!input) return '';
    if (archiveExtensionOf(input)) return input;
    return withArchiveExtension(input, '.tar.gz');
}
function checkPasteTargetConflicts(targetDir) {
    return new Promise((resolve) => {
        if (!wsConnection || wsConnection.readyState !== WebSocket.OPEN) return resolve({ success: false, error: t('连接未就绪') });
        const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const timer = window.setTimeout(() => {
            pendingSftpConflictChecks.delete(requestId);
            resolve({ success: false, error: t('同名检查超时') });
        }, 12000);
        pendingSftpConflictChecks.set(requestId, (msg) => {
            window.clearTimeout(timer);
            resolve(msg);
        });
        wsConnection.send(JSON.stringify({ type: 'sftp-clipboard-check-conflicts', requestId, targetDir }));
    });
}

function requestPasteConflictChoice() {
    if (sftpPasteConflictMemory) return Promise.resolve(sftpPasteConflictMemory);
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'fm-conflict-overlay show';
        const modal = document.createElement('div');
        modal.className = 'fm-conflict-modal show';
        modal.innerHTML = `
            <div class="fm-conflict-head"><strong>${t('目标已存在同名项目')}</strong><button type="button" class="fm-conflict-close" data-conflict-cancel>×</button></div>
            <div class="fm-conflict-body">
                <button type="button" class="fm-conflict-choice" data-conflict-mode="overwrite"><b>${t('覆盖')}</b><span>${t('删除目标同名文件/文件夹后粘贴')}</span></button>
                <button type="button" class="fm-conflict-choice" data-conflict-mode="skip"><b>${t('跳过')}</b><span>${t('保留目标已有项目，只粘贴未冲突项目')}</span></button>
                <button type="button" class="fm-conflict-choice primary" data-conflict-mode="compatible"><b>${t('兼容')}</b><span>${t('自动追加“-复制”“-复制2”…，可重复粘贴')}</span></button>
                <label class="fm-conflict-remember"><input type="checkbox" data-conflict-remember> <span>${t('记住选择（仅本次网页连接有效）')}</span></label>
            </div>`;
        const cleanup = (choice) => {
            overlay.remove();
            modal.remove();
            resolve(choice || null);
        };
        overlay.addEventListener('click', () => cleanup(null));
        modal.addEventListener('click', (e) => {
            if (e.target.closest('[data-conflict-cancel]')) return cleanup(null);
            const btn = e.target.closest('[data-conflict-mode]');
            if (!btn) return;
            const choice = { mode: btn.dataset.conflictMode, remember: !!modal.querySelector('[data-conflict-remember]')?.checked };
            if (choice.remember) sftpPasteConflictMemory = choice;
            cleanup(choice);
        });
        document.body.appendChild(overlay);
        document.body.appendChild(modal);
    });
}

function requestEditorCloseChoice() {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'fm-conflict-overlay show';
        const modal = document.createElement('div');
        modal.className = 'fm-conflict-modal show';
        modal.innerHTML = `
            <div class="fm-conflict-head"><strong>${t('文件有未保存修改')}</strong><button type="button" class="fm-conflict-close" data-editor-close-choice="cancel">×</button></div>
            <div class="fm-conflict-body">
                <button type="button" class="fm-conflict-choice primary" data-editor-close-choice="save"><b>${t('保存并关闭')}</b><span>${t('先保存当前内容，然后关闭编辑窗口')}</span></button>
                <button type="button" class="fm-conflict-choice" data-editor-close-choice="discard"><b>${t('放弃修改')}</b><span>${t('不保存本次修改，直接关闭窗口')}</span></button>
                <button type="button" class="fm-conflict-choice" data-editor-close-choice="cancel"><b>${t('取消关闭')}</b><span>${t('返回编辑器继续编辑')}</span></button>
            </div>`;
        const cleanup = (choice) => { overlay.remove(); modal.remove(); resolve(choice || 'cancel'); };
        overlay.addEventListener('click', () => cleanup('cancel'));
        modal.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-editor-close-choice]');
            if (btn) cleanup(btn.dataset.editorCloseChoice || 'cancel');
        });
        document.body.appendChild(overlay);
        document.body.appendChild(modal);
    });
}

function rightsToMode(rights = '') {
    const text = String(rights || '');
    if (text.length < 10) return '';
    const bits = [text.slice(1, 4), text.slice(4, 7), text.slice(7, 10)].map((part) =>
        (part[0] === 'r' ? 4 : 0) + (part[1] === 'w' ? 2 : 0) + ((part[2] === 'x' || part[2] === 's' || part[2] === 't') ? 1 : 0)
    );
    return bits.join('');
}
function ensureFilePropertiesModal() {
    if (filePropertiesModal) return;
    filePropertiesOverlay = document.createElement('div');
    filePropertiesOverlay.className = 'fm-props-overlay';
    filePropertiesModal = document.createElement('div');
    filePropertiesModal.className = 'fm-props-modal';
    document.body.appendChild(filePropertiesOverlay);
    document.body.appendChild(filePropertiesModal);
    filePropertiesOverlay.addEventListener('click', hideFilePropertiesModal);
    filePropertiesModal.addEventListener('click', (e) => {
        const closeBtn = e.target.closest('[data-props-close]');
        if (closeBtn) { hideFilePropertiesModal(); return; }
        const copyBtn = e.target.closest('[data-props-copy-path]');
        if (copyBtn) {
            const pathText = copyBtn.dataset.path || '';
            navigator.clipboard?.writeText(pathText).then(() => showToast('路径已复制', 'success')).catch(() => {
                const ta = document.createElement('textarea');
                ta.value = pathText;
                document.body.appendChild(ta);
                ta.select();
                try { document.execCommand('copy'); showToast('路径已复制', 'success'); } catch { showToast('复制失败', 'error'); }
                ta.remove();
            });
            return;
        }
        const chmodBtn = e.target.closest('[data-props-chmod]');
        if (chmodBtn) {
            const targetPath = chmodBtn.dataset.path || '';
            const currentMode = chmodBtn.dataset.mode || '';
            const mode = prompt(t('输入权限模式（例如 644 / 755）:'), currentMode || '644');
            if (!mode) return;
            if (!/^[0-7]{3,4}$/.test(mode.trim())) { showToast('权限格式不正确，请输入 644 或 0755', 'error'); return; }
            wsConnection.send(JSON.stringify({ type: 'sftp-chmod', path: targetPath, mode: mode.trim() }));
            showToast('正在修改权限...', 'info');
        }
    });
}
function hideFilePropertiesModal() {
    filePropertiesOverlay?.classList.remove('show');
    filePropertiesModal?.classList.remove('show');
}
function renderFilePropertiesModal(selected, extra = null) {
    ensureFilePropertiesModal();
    const fallbackTotal = selected.reduce((sum, f) => sum + (Number(f.size) || 0), 0);
    const single = selected.length === 1 ? selected[0] : null;
    const remoteSingle = extra?.items?.length === 1 ? extra.items[0] : null;
    const totalSize = Number(extra?.totalSize ?? remoteSingle?.size ?? fallbackTotal) || 0;
    const fileCount = Number(extra?.fileCount ?? remoteSingle?.fileCount ?? 0) || 0;
    const dirCount = Number(extra?.dirCount ?? remoteSingle?.dirCount ?? 0) || 0;
    const rows = single ? [
        [t('名称'), single.name || '-'],
        [t('路径'), single.path || '-'],
        [t('大小'), extra ? formatTransferSize(totalSize) : `${formatTransferSize(single.size || 0)}（正在统计真实大小...）`],
        ...(single.type === 'd' && extra ? [[t('内容'), `${fileCount} 个文件，${Math.max(0, dirCount - 1)} 个子文件夹`]] : []),
        [t('修改时间'), single.modifyTime ? new Date(single.modifyTime).toLocaleString() : '-'],
        [t('权限'), single.rights || '-'],
    ] : [
        [t('已选择'), `${selected.length} 项`],
        [t('总大小'), extra ? formatTransferSize(totalSize) : `${formatTransferSize(fallbackTotal)}（正在统计真实大小...）`],
        ...(extra ? [[t('内容'), `${fileCount} 个文件，${dirCount} 个文件夹`]] : []),
        [t('当前路径'), currentPath],
    ];
    const mode = single ? rightsToMode(single.rights) : '';
    filePropertiesModal.innerHTML = `
        <div class="fm-props-head"><strong>${t('属性')}</strong><button type="button" class="fm-props-close" data-props-close>×</button></div>
        <div class="fm-props-body">${rows.map(([label, value]) => `<div class="fm-props-row"><span>${escapeHtml(label)}</span><code title="${escapeHtml(value)}">${escapeHtml(value)}</code></div>`).join('')}</div>
        <div class="fm-props-actions">
            ${single ? `<button type="button" class="tool-btn fm-props-action" data-props-copy-path data-path="${escapeHtml(single.path || '')}">${svgIcon('copy')}复制路径</button><button type="button" class="tool-btn fm-props-action" data-props-chmod data-path="${escapeHtml(single.path || '')}" data-mode="${escapeHtml(mode)}">${svgIcon('chmod')}修改权限</button>` : ''}
            <button type="button" class="tool-btn fm-props-action primary" data-props-close>${t('确定')}</button>
        </div>`;
}
function requestRemoteProperties(selected) {
    if (!wsConnection || wsConnection.readyState !== WebSocket.OPEN) return;
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    pendingSftpProperties.set(requestId, { selected });
    wsConnection.send(JSON.stringify({ type: 'sftp-properties', requestId, items: selected.map((item) => ({ path: item.path })) }));
}
function showFilePropertiesModal(selected) {
    ensureFilePropertiesModal();
    renderFilePropertiesModal(selected, null);
    filePropertiesOverlay.classList.add('show');
    filePropertiesModal.classList.add('show');
    requestRemoteProperties(selected);
}
// Native download target is opened only after the signed URL is ready.

function requestDownload(file) {
    const downloadId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    markDownloadProgress(downloadId, { name: file.name, path: file.path, size: file.size, loaded: 0, status: 'pending', controlUrl: '', progressUrl: '' });
    showTransferPopover({ autoHide: true });
    wsConnection.send(JSON.stringify({ type: 'sftp-download', path: file.path, downloadId }));
}
function handleFileMenuAction(action) {
    const selected = getSelectedFiles();
    const single = selected[0];
    if (action === 'refresh') return refreshFileList();
    if (action === 'newFolder') return fmNewFolderBtn.click();
    if (action === 'newFile') return fmNewFileBtn.click();
    if (action === 'copy' || action === 'cut') {
        if (!selected.length) return;
        wsConnection.send(JSON.stringify({ type: 'sftp-clipboard-set', mode: action, items: selected }));
        showToast(`正在${action === 'copy' ? t('复制') : t('剪切')} ${selected.length} 项...`, 'info');
        return;
    }
    if (action === 'paste') {
        checkPasteTargetConflicts(currentPath).then((result) => {
            if (!result.success) { showToast('同名检查失败: ' + (result.error || t('未知错误')), 'error'); return; }
            const choose = result.hasConflict ? requestPasteConflictChoice() : Promise.resolve({ mode: 'compatible', remember: false });
            choose.then((choice) => {
                if (!choice) return;
                wsConnection.send(JSON.stringify({ type: 'sftp-clipboard-paste', targetDir: currentPath, conflict: choice.mode }));
                const label = choice.mode === 'overwrite' ? t('覆盖') : choice.mode === 'skip' ? t('跳过') : result.hasConflict ? t('兼容命名') : t('无同名');
                showToast(`正在粘贴（同名：${label}），进度可在传输面板查看`, 'info');
            });
        });
        return;
    }
    if (action === 'rename' && single) {
        const newName = prompt(t('新名称:'), single.name);
        if (!newName) return;
        wsConnection.send(JSON.stringify({ type: 'sftp-rename', oldPath: single.path, newPath: fullFilePath(newName) }));
        return;
    }
    if (action === 'delete') {
        if (!selected.length || !confirm(t('确认删除选中的 {count} 项?', { count: selected.length }))) return;
        selected.forEach((file) => wsConnection.send(JSON.stringify({ type: 'sftp-delete', path: file.path })));
        return;
    }
    if (action === 'compress') {
        if (!selected.length) return;
        const defaultName = selected.length === 1 ? `${selected[0].name}.zip` : `archive-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)}.zip`;
        const targetPath = chooseArchiveTargetPath(defaultName);
        if (!targetPath) return;
        const transferId = `archive-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        markDownloadProgress(transferId, { name: `压缩: ${targetPath.split('/').pop() || t('压缩包')}`, path: targetPath, direction: 'archive', phase: 'prepare', size: 0, loaded: 0, status: 'pending', cancellable: true });
        showTransferPopover({ autoHide: true });
        wsConnection.send(JSON.stringify({ type: 'sftp-compress', items: selected, targetPath, transferId }));
        showToast('正在压缩，进度可在传输面板查看', 'info');
        return;
    }
    if (action === 'extract' && single) {
        const targetDir = prompt(t('解压到:'), currentPath);
        if (!targetDir) return;
        const transferId = `archive-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        markDownloadProgress(transferId, { name: `解压: ${single.name || t('压缩包')}`, path: single.path, direction: 'archive', phase: 'prepare', size: 0, loaded: 0, status: 'pending', cancellable: true });
        showTransferPopover({ autoHide: true });
        wsConnection.send(JSON.stringify({ type: 'sftp-extract', path: single.path, targetDir, transferId }));
        showToast('正在解压，进度可在传输面板查看', 'info');
        return;
    }
    if (action === 'download') {
        if (selected.length === 1 && selected[0].type !== 'd') return requestDownload(selected[0]);
        const downloadId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const name = `zephyr-download-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)}.tar.gz`;
        markDownloadProgress(downloadId, { name, path: currentPath, size: 0, loaded: 0, status: 'pending', controlUrl: '', progressUrl: '' });
        showTransferPopover({ autoHide: true });
        wsConnection.send(JSON.stringify({ type: 'sftp-download-bundle', items: selected, baseDir: currentPath, downloadId, name }));
        showToast('正在打包下载...', 'info');
        return;
    }
    if (action === 'properties') {
        if (!selected.length) return;
        showFilePropertiesModal(selected);
    }
}

function isFileManagerShortcutBlocked(e) {
    const target = e?.target;
    const active = document.activeElement;
    const isEditable = (el) => {
        if (!el) return false;
        const tag = el.tagName?.toLowerCase();
        return tag === 'textarea'
            || (tag === 'input' && !['button', 'checkbox', 'radio', 'submit', 'reset', 'file', 'range', 'color'].includes((el.type || '').toLowerCase()))
            || el.isContentEditable
            || !!el.closest?.('.cm-editor, .cm-content, .fm-editor-modal');
    };
    return isEditable(target) || isEditable(active) || !!document.querySelector('.fm-editor-modal.open .cm-focused');
}

document.addEventListener('keydown', (e) => {
    if (!fileManager?.classList.contains('open')) return;
    if (isFileManagerShortcutBlocked(e)) return;
    const mac = getShortcutPlatform() === 'mac';
    const mod = mac ? e.metaKey : e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'c') { e.preventDefault(); handleFileMenuAction('copy'); }
    else if (mod && e.key.toLowerCase() === 'x') { e.preventDefault(); handleFileMenuAction('cut'); }
    else if (mod && e.key.toLowerCase() === 'v') { e.preventDefault(); if (consumePendingSharedFiles()) return; handleFileMenuAction('paste'); }
    else if (e.key === 'F2') { e.preventDefault(); handleFileMenuAction('rename'); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { if (selectedFilePaths.size) { e.preventDefault(); handleFileMenuAction('delete'); } }
    else if (mod && e.key.toLowerCase() === 'i') { e.preventDefault(); handleFileMenuAction('properties'); }
});

function renderFileList(files) {
    allFiles = sortFiles(files);
    const filtered = filterFiles(allFiles, searchQuery);
    fmList.innerHTML = '';
    filtered.forEach(file => {
        const item = document.createElement('div');
        item.className = 'fm-item';
        const itemPath = fullFilePath(file.name);
        item.dataset.fileName = file.name;
        item.dataset.fileType = file.type;
        item.dataset.filePath = itemPath;
        item.classList.toggle('selected', selectedFilePaths.has(itemPath));
        const nameSpan = document.createElement('span');
        nameSpan.className = 'fm-item-name';
        nameSpan.innerHTML = `${zephyrFileGlyph(file)}<span class="fm-item-filename">${escapeHtml(file.name)}</span>`;
        nameSpan.title = file.type === 'd' ? t('打开文件夹') : t('打开文件');
        nameSpan.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            selectSingleFile(itemPath);
        });
        nameSpan.addEventListener('dblclick', (e) => {
            e.preventDefault();
            e.stopPropagation();
            openFileItem(itemPath, file.type);
        });
        const actions = document.createElement('div');
        actions.className = 'fm-item-actions';

        const renameBtn = document.createElement('button');
        renameBtn.innerHTML = svgIcon('rename');
        renameBtn.setAttribute('aria-label', t('重命名'));
        renameBtn.title = t('重命名');
        renameBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const newName = prompt(t('新名称:'), file.name);
            if (!newName) return;
            const oldPath = currentPath.replace(/\/+$/, '') + '/' + file.name;
            const newPath = currentPath.replace(/\/+$/, '') + '/' + newName;
            wsConnection.send(JSON.stringify({ type: 'sftp-rename', oldPath, newPath }));
        });

        const deleteBtn = document.createElement('button');
        setZephyrIconButton(deleteBtn, 'delete', t('删除'));
        deleteBtn.title = t('删除');
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (confirm(t('确认删除 {name}?', { name: file.name }))) {
                wsConnection.send(JSON.stringify({
                    type: 'sftp-delete',
                    path: currentPath.replace(/\/+$/, '') + '/' + file.name
                }));
            }
        });

        if (file.type !== 'd') {
            const downloadBtn = document.createElement('button');
            setZephyrIconButton(downloadBtn, 'download', t('下载'));
            downloadBtn.title = t('下载');
            downloadBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                downloadBtn.disabled = true;
                window.setTimeout(() => { downloadBtn.disabled = false; }, 2400);
                requestDownload({ ...file, path: fullFilePath(file.name) });
            });
            actions.appendChild(downloadBtn);
        }

        actions.appendChild(renameBtn);
        actions.appendChild(deleteBtn);
        item.appendChild(nameSpan);
        item.appendChild(actions);
        fmList.appendChild(item);
    });
}

// 新建文件夹
fmNewFolderBtn.addEventListener('click', () => {
    const name = prompt(t('请输入文件夹名称:'));
    if (!name) return;
    wsConnection.send(JSON.stringify({ type: 'sftp-mkdir', path: currentPath.replace(/\/+$/, '') + '/' + name }));
});
// 新建文件
fmNewFileBtn.addEventListener('click', () => {
    const name = prompt(t('请输入文件名:'));
    if (!name) return;
    wsConnection.send(JSON.stringify({ type: 'sftp-touch', path: currentPath.replace(/\/+$/, '') + '/' + name }));
});
// 上传文件：先通过 WebSocket 签发同源 HTTP 上传地址，再让浏览器把 File 作为请求体流式上传，避免 base64/JSON 改写二进制内容。
// 分片上传：将文件分成固定大小分片，逐片发送 HTTP POST + X-Upload-Offset
// 分片上传：顺序发送，成功翻倍失败减半（无上限）
// 顺序（非并发）确保 chunkSize 在每次成功后正确翻倍
const UPLOAD_MIN_CHUNK = 512 * 1024;    // 最小分片 512KB
const UPLOAD_INIT_CHUNK = 8 * 1024 * 1024; // 初始分片 8MB，避免小分片多轮次拖慢速度

async function sendSftpUploadChunk(upload, startOffset) {
    if (!upload || upload.cancelled) return;
    if (!upload.url) {
        showToast(`上传失败：缺少上传地址（${upload.file.name}）`, 'error');
        markUploadProgress(upload.id, { status: 'error' });
        return;
    }
    // Reset controller for a fresh run
    const controller = new AbortController();
    upload.controller = controller;
    upload.paused = false;
    const file = upload.file;
    const totalSize = file.size;
    markUploadProgress(upload.id, { status: 'active', loaded: startOffset || 0, size: totalSize });

    let chunkSize = upload._chunkSize || Math.min(UPLOAD_INIT_CHUNK, Math.max(UPLOAD_MIN_CHUNK, totalSize || Infinity));
    let offset = typeof startOffset === 'number' ? startOffset : (upload._offset || 0);

    while (offset < totalSize) {
        // Check pause/cancel before each chunk
        if (upload.cancelled) return;
        if (upload.paused) {
            markUploadProgress(upload.id, { status: 'paused' });
            upload.controller = null;
            // Save offset for resume
            upload._offset = offset;
            upload._chunkSize = chunkSize;
            return;
        }

        const end = Math.min(offset + chunkSize, totalSize);
        const url = upload.url + '?offset=' + offset;

        try {
            const res = await fetch(url, {
                method: 'POST',
                credentials: 'same-origin',
                cache: 'no-store',
                headers: { 'Content-Type': 'application/octet-stream' },
                body: file.slice(offset, end),
                signal: controller.signal,
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            await res.json();

            // Success — advance offset and double chunk size
            offset = end;
            upload._offset = offset;
            chunkSize = Math.min(chunkSize * 2, 64 * 1024 * 1024); // double, cap at 64MB
            upload._chunkSize = chunkSize;
            markUploadProgress(upload.id, { loaded: offset, size: totalSize });
        } catch (err) {
            if (upload.cancelled) return;
            if (err?.name === 'AbortError') {
                if (upload.paused) {
                    markUploadProgress(upload.id, { status: 'paused' });
                    upload._offset = offset;
                    upload._chunkSize = chunkSize;
                }
                upload.controller = null;
                return;
            }
            // Failure — halve chunk size and retry same offset
            if (chunkSize <= UPLOAD_MIN_CHUNK) {
                upload.controller = null;
                markUploadProgress(upload.id, { status: 'error' });
                window.setTimeout(() => { activeSftpUploads.delete(upload.id); scheduleTransferRender(); }, 8000);
                showToast('上传失败', 'error');
                return;
            }
            chunkSize = Math.max(Math.floor(chunkSize / 2), UPLOAD_MIN_CHUNK);
        }
    }

    // All chunks sent — finalize
    upload.controller = null;
    try {
        const r = await fetch(upload.url + '/complete', {
            method: 'POST', credentials: 'same-origin', cache: 'no-store',
        });
        if (!r.ok) {
            let errorText = `HTTP ${r.status}`;
            try { const data = await r.json(); errorText = data.error || errorText; } catch {}
            throw new Error(errorText);
        }
        markUploadProgress(upload.id, { status: 'done', loaded: totalSize, size: totalSize });
        window.setTimeout(() => { activeSftpUploads.delete(upload.id); scheduleTransferRender(); }, 5000);
        refreshFileList();
        showToast('文件上传完成', 'success');
    } catch (err) {
        markUploadProgress(upload.id, { status: 'error', loaded: totalSize, size: totalSize });
        window.setTimeout(() => { activeSftpUploads.delete(upload.id); scheduleTransferRender(); }, 8000);
        showToast('上传校验失败：' + (err.message || t('未知错误')), 'error');
    }
}

function uploadFile(file) {
    if (!file || !sftpReady || !wsConnection || wsConnection.readyState !== WebSocket.OPEN) return;
    const upload = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        file,
        path: currentPath.replace(/\/+$/, '') + '/' + file.name,
        cancelled: false,
        name: file.name,
        size: file.size,
        loaded: 0,
        status: 'pending',
        paused: false,
        updatedAt: Date.now(),
        speed: 0,
        _offset: 0,
    };
    activeSftpUploads.set(upload.id, upload);
    showTransferPopover({ autoHide: true });
    scheduleTransferRender();
    sha256HexFromBlob(file).then((sha256) => {
        upload.sha256 = sha256;
        wsConnection.send(JSON.stringify({ type: 'sftp-upload-start', uploadId: upload.id, path: upload.path, name: file.name, size: file.size, sha256 }));
    }).catch((err) => {
        activeSftpUploads.delete(upload.id);
        scheduleTransferRender();
        showToast('上传失败：无法计算本地 SHA-256（' + (err.message || t('未知错误')) + '）', 'error');
    });
}

function handleSharedFileClipboardAvailable(files = [], sourceTabId = '', sourcePage = '') {
    const list = Array.from(files || []);
    if (!list.length) return;
    sftpClipboardAvailable = true;
    pendingSharedFileSource = sourceTabId;
    pendingSharedFileMeta = list;
    pendingSharedFileSourcePage = sourcePage;
    updateMobileFileActions();
    const names = list.map((f) => f.name || String(f.path || '').split('/').pop() || 'file').slice(0, 3).join('、');
    showToast(`剪贴板有 ${list.length} 个文件（${names}），右键粘贴或 Ctrl+V 传输到 ${currentPath}`, 'info');
}
let pendingSharedFileSource = '';
let pendingSharedFileMeta = [];
let pendingSharedFileSourcePage = '';
function consumePendingSharedFiles() {
    if (pendingSharedFileMeta.length && pendingSharedFileSource) {
        const isRdpSource = pendingSharedFileSourcePage === 'rdp' || pendingSharedFileSourcePage === 'novnc';
        if (isRdpSource) {
            /* RDP/VNC source — files are in the other tab's browser memory.
             * Send consume so app.js relays shared-file-clipboard-read to the
             * source tab, which uploads via /api/clipboard/upload and returns
             * transitUrl for us to download. */
            window.parent?.postMessage?.({
                source: 'zephyr-terminal',
                type: 'shared-file-clipboard-consume',
                tabId: params?.tabId,
                sourceTabId: pendingSharedFileSource,
                files: pendingSharedFileMeta,
                sourcePage: pendingSharedFileSourcePage,
            }, '*');
            showToast(`正在从远程桌面获取文件并上传到 ${currentPath}`, 'info');
            pendingSharedFileSource = '';
            pendingSharedFileMeta = [];
            pendingSharedFileSourcePage = '';
            return true;
        }
    }
    // Default: server-side SFTP clipboard paste (SSH→SSH or same connection)
    if (sftpReady && wsConnection && wsConnection.readyState === WebSocket.OPEN) {
        wsConnection.send(JSON.stringify({ type: 'sftp-clipboard-paste', targetDir: currentPath, conflict: 'compatible' }));
        showToast(`正在粘贴到 ${currentPath}`, 'info');
        return true;
    }
    return false;
}
async function uploadRemotePathFiles(files = []) {
    const list = Array.from(files || []).filter((file) => file?.remotePath);
    if (!list.length) return;
    showToast(`正在从 RDP 远程下载 ${list.length} 个文件并上传到 ${currentPath}`, 'info');
    for (const file of list) {
        try {
            const res = await fetch('/api/rdp/clipboard-file?' + new URLSearchParams({ path: file.remotePath, name: file.name || '' }));
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const blob = await res.blob();
            const localFile = new File([blob], file.name || 'remote-file', { type: 'application/octet-stream' });
            await new Promise((resolve) => { uploadFile(localFile); setTimeout(resolve, 200); });
        } catch (err) {
            showToast(`下载远程文件失败：${file.name || ''} ${err.message || err}`, 'error');
        }
    }
}
async function uploadSharedClipboardFiles(files = []) {
    const list = Array.from(files || []).filter((file) => file?.name && (file?.dataUrl || file?.transitUrl));
    if (!list.length) return;
    const converted = [];
    for (const file of list) {
        try {
            const url = file.transitUrl || file.dataUrl;
            const res = await fetch(url);
            const blob = await res.blob();
            converted.push(new File([blob], file.name, { type: file.mime || blob.type || 'application/octet-stream' }));
        } catch (err) {
            showToast(`读取跨窗口文件失败：${file.name || ''} ${err.message || err}`, 'error');
        }
    }
    if (converted.length) uploadFiles(converted);
}

function uploadFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    if (!sftpReady) {
        pendingUploadFiles.push(...files);
        showToast('SFTP 正在初始化，文件将在就绪后自动上传', 'info');
        showFileManager();
        initSFTP();
        return;
    }
    showToast(`开始上传 ${files.length} 个文件到 ${currentPath}`, 'info');
    files.forEach(uploadFile);
}

function flushPendingUploads() {
    if (!pendingUploadFiles.length || !sftpReady) return;
    const files = pendingUploadFiles.splice(0);
    uploadFiles(files);
}

function hasDraggedFiles(e) {
    return Array.from(e.dataTransfer?.types || []).includes('Files');
}

function setFileDragActive(active) {
    fileManager.classList.toggle('drag-over', active);
}

fmTransferBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (transferPopover?.classList.contains('open')) hideTransferPopover(true);
    else showTransferPopover();
});
document.addEventListener('pointerdown', (e) => {
    if (!transferPopover?.classList.contains('open')) return;
    if (e.target.closest('.transfer-popover') || e.target.closest('#fmTransferBtn')) return;
    hideTransferPopover(true);
}, { capture: true });
window.addEventListener('resize', () => { if (transferPopover?.classList.contains('open')) positionTransferPopover(); });

fmUploadInput.addEventListener('change', (e) => {
    uploadFiles(e.target.files);
    fmUploadInput.value = '';
});

document.addEventListener('dragenter', (e) => {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    fileDragDepth += 1;
    if (!fileManager.classList.contains('open')) showFileManager();
    setFileDragActive(true);
}, { passive: false });

document.addEventListener('dragover', (e) => {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!fileManager.classList.contains('open')) showFileManager();
    setFileDragActive(true);
}, { passive: false });

document.addEventListener('dragleave', (e) => {
    if (!hasDraggedFiles(e)) return;
    fileDragDepth = Math.max(0, fileDragDepth - 1);
    if (fileDragDepth === 0 || !e.relatedTarget) setFileDragActive(false);
}, { passive: true });

document.addEventListener('drop', (e) => {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    fileDragDepth = 0;
    setFileDragActive(false);
    if (!fileManager.classList.contains('open')) showFileManager();
    uploadFiles(e.dataTransfer?.files);
}, { passive: false });

// 直接在文件管理器上处理拖拽
fmDropOverlay.addEventListener('dragenter', (e) => {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
}, { passive: false });

fmDropOverlay.addEventListener('dragover', (e) => {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
}, { passive: false });

fmDropOverlay.addEventListener('drop', (e) => {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    fileDragDepth = 0;
    setFileDragActive(false);
    uploadFiles(e.dataTransfer?.files);
}, { passive: false });

fmList.addEventListener('dragenter', (e) => {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    fileDragDepth += 1;
    setFileDragActive(true);
}, { passive: false });

fmList.addEventListener('dragover', (e) => {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    setFileDragActive(true);
}, { passive: false });

fmList.addEventListener('dragleave', (e) => {
    if (!hasDraggedFiles(e)) return;
    fileDragDepth = Math.max(0, fileDragDepth - 1);
    if (fileDragDepth === 0) setFileDragActive(false);
}, { passive: true });

fmList.addEventListener('drop', (e) => {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    fileDragDepth = 0;
    setFileDragActive(false);
    uploadFiles(e.dataTransfer?.files);
}, { passive: false });
// ── 本地文件粘贴上传（Local → SSH）──
let termPasteFileHandlerInstalled = false;
function installTerminalPasteFileHandler() {
    if (termPasteFileHandlerInstalled) return;
    termPasteFileHandlerInstalled = true;
    document.addEventListener('paste', (e) => {
        const files = Array.from(e.clipboardData?.files || []);
        if (!files.length) return;
        // Only capture on terminal page (not inside inputs/textareas)
        if (e.target.closest?.('input, textarea, [contenteditable]')) return;
        e.preventDefault();
        uploadFiles(files);
        showToast(`正在上传 ${files.length} 个文件到 ${currentPath}`, 'info');
    });
}
installTerminalPasteFileHandler();

// ── 通知父页 SSH 文件剪贴板 ──
function notifyParentSftpClipboardSet(mode = 'copy', count = 0) {
    if (embeddedMode && window.parent && window.parent !== window && count > 0) {
        /* Include real file metadata so RDP tabs can display names/sizes and
         * consume the clipboard without a round-trip back to this tab. */
        const selected = getSelectedFiles();
        const files = selected.map(f => ({
            name: f.name || '',
            size: Number(f.size) || 0,
            path: f.path || '',
            type: f.type || '-',
            remotePath: f.path || '',
        }));
        window.parent.postMessage({ source: 'zephyr-terminal', type: 'shared-file-clipboard-remote', tabId: params?.tabId, files: files.length ? files : [{ path: 'sftp-clipboard', count, mode }] }, '*');
    }
}

// // 编辑器
function base64ToBytes(base64) {
    const binary = atob(base64 || '');
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

function bytesToBase64(bytes) {
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
}

function decodeBytes(bytes, encoding) {
    if (!bytes) return '';
    if (encoding === 'utf-16be') {
        const swapped = new Uint8Array(bytes.length);
        for (let i = 0; i < bytes.length; i += 2) {
            swapped[i] = bytes[i + 1] || 0;
            swapped[i + 1] = bytes[i] || 0;
        }
        return new TextDecoder('utf-16le').decode(swapped);
    }
    const decoderEncoding = encoding === 'latin1' ? 'iso-8859-1' : encoding;
    return new TextDecoder(decoderEncoding).decode(bytes);
}

function encodeText(text, encoding) {
    if (encoding === 'utf-16le' || encoding === 'utf-16be') {
        const bytes = new Uint8Array(text.length * 2);
        for (let i = 0; i < text.length; i++) {
            const code = text.charCodeAt(i);
            const offset = i * 2;
            if (encoding === 'utf-16le') {
                bytes[offset] = code & 0xff;
                bytes[offset + 1] = code >> 8;
            } else {
                bytes[offset] = code >> 8;
                bytes[offset + 1] = code & 0xff;
            }
        }
        return bytes;
    }
    if (encoding === 'latin1') {
        const bytes = new Uint8Array(text.length);
        for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
        return bytes;
    }
    return new TextEncoder().encode(text);
}

function detectEncoding(bytes) {
    if (!bytes || bytes.length < 2) return 'utf-8';
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
    return 'utf-8';
}

function detectLineEnding(text) {
    return /\r\n/.test(text) ? 'crlf' : 'lf';
}

function normalizeLineEnding(text, lineEnding) {
    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    return lineEnding === 'crlf' ? normalized.replace(/\n/g, '\r\n') : normalized;
}


function getEditorInstance(panel = activeEditorPanel || fmEditorModal) {
    return panel?._codeEditor || null;
}

function getEditorText(panel = activeEditorPanel || fmEditorModal) {
    const instance = getEditorInstance(panel);
    if (window.ZephyrCodeEditor?.getText && instance) return window.ZephyrCodeEditor.getText(instance);
    return '';
}

function updateEditorStatus() {
    const instance = getEditorInstance();
    if (instance && window.ZephyrCodeEditor?.updateOptions) {
        window.ZephyrCodeEditor.updateOptions(instance, { language: editorLanguage, tabSize: Number(fmEditorTabSize?.value) || 4, wrap: fmEditorWrap?.checked !== false });
        fmEditorMinimapToggle?.classList.toggle('active', !!instance.minimap);
        fmEditorCompactBtn?.classList.toggle('active', !!instance.compact);
        return;
    }
    if (fmEditorStatus) fmEditorStatus.textContent = t('CodeMirror 初始化中...');
}

const EDITOR_LANGUAGE_BY_EXT = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
    ts: 'typescript', tsx: 'typescript', json: 'json', jsonc: 'javascript',
    html: 'html', htm: 'html', xml: 'html', vue: 'html', svelte: 'html',
    css: 'css', scss: 'css', sass: 'css', less: 'css',
    py: 'python', rb: 'ruby', php: 'php',
    sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell', ksh: 'shell',
    yml: 'yaml', yaml: 'yaml', toml: 'toml', ini: 'ini', env: 'shell',
    md: 'markdown', markdown: 'markdown',
    go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin',
    c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
    cs: 'csharp', swift: 'swift', sql: 'sql', lua: 'lua',
};

const EDITOR_LANGUAGE_BY_NAME = {
    dockerfile: 'dockerfile', containerfile: 'dockerfile', makefile: 'makefile',
    'compose.yml': 'yaml', 'compose.yaml': 'yaml',
};

const EDITOR_LANGUAGE_LABELS = {
    plain: 'Plain Text', javascript: 'JavaScript', typescript: 'TypeScript', json: 'JSON',
    html: 'HTML/XML', css: 'CSS', python: 'Python', shell: 'Shell', yaml: 'YAML',
    markdown: 'Markdown', go: 'Go', rust: 'Rust', java: 'Java', c: 'C', cpp: 'C++',
    csharp: 'C#', php: 'PHP', ruby: 'Ruby', sql: 'SQL', lua: 'Lua', dockerfile: 'Dockerfile',
    makefile: 'Makefile', toml: 'TOML', ini: 'INI', kotlin: 'Kotlin', swift: 'Swift',
};

const EDITOR_KEYWORDS = {
    javascript: new Set('as async await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch this throw try typeof var void while with yield null true false undefined'.split(' ')),
    typescript: new Set('abstract any as async await boolean break case catch class const constructor continue debugger declare default delete do else enum export extends false finally for from function get if implements import in infer instanceof interface is keyof let module namespace never new null number object of private protected public readonly return set static string super switch symbol this throw true try type typeof undefined unknown var void while with yield'.split(' ')),
    json: new Set('true false null'.split(' ')),
    python: new Set('and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield self'.split(' ')),
    shell: new Set('alias bg bind break builtin case cd command continue do done echo elif else esac eval exec exit export false fg fi for function getopts hash if in jobs kill let local logout popd printf pushd pwd read readonly return select set shift source test then time trap true type typeset ulimit umask unalias unset until wait while sudo'.split(' ')),
    yaml: new Set('true false null yes no on off'.split(' ')),
    css: new Set('important import media supports keyframes from to and or not only screen print all root'.split(' ')),
    go: new Set('break default func interface select case defer go map struct chan else goto package switch const fallthrough if range type continue for import return var nil true false iota'.split(' ')),
    rust: new Set('as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while'.split(' ')),
    java: new Set('abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long native new null package private protected public return short static strictfp super switch synchronized this throw throws transient true try void volatile while'.split(' ')),
    c: new Set('auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while null NULL'.split(' ')),
    cpp: new Set('alignas alignof and asm auto bitand bitor bool break case catch char char16_t char32_t class compl const constexpr const_cast continue decltype default delete do double dynamic_cast else enum explicit export extern false final float for friend goto if inline int long mutable namespace new noexcept not nullptr operator or override private protected public register reinterpret_cast return short signed sizeof static static_assert static_cast struct switch template this thread_local throw true try typedef typeid typename union unsigned using virtual void volatile wchar_t while xor'.split(' ')),
    php: new Set('abstract and array as break callable case catch class clone const continue declare default die do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile eval exit extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list namespace new null or print private protected public require require_once return static switch throw trait try unset use var while xor yield true false'.split(' ')),
    ruby: new Set('BEGIN END alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield'.split(' ')),
    sql: new Set('add all alter and as asc by case check column constraint create database default delete desc distinct drop else exists foreign from group having in index inner insert into is join key left like limit not null on or order outer primary references right select set table then union unique update values view where true false'.split(' ')),
    lua: new Set('and break do else elseif end false for function goto if in local nil not or repeat return then true until while'.split(' ')),
    dockerfile: new Set('FROM RUN CMD LABEL MAINTAINER EXPOSE ENV ADD COPY ENTRYPOINT VOLUME USER WORKDIR ARG ONBUILD STOPSIGNAL HEALTHCHECK SHELL AS'.split(' ')),
    makefile: new Set('include define endef ifeq ifneq ifdef ifndef else endif export unexport override private vpath'.split(' ')),
    markdown: new Set(), toml: new Set('true false'.split(' ')), ini: new Set('true false yes no on off'.split(' ')),
};

function detectEditorLanguage(filePath = '') {
    const fileName = (filePath.split('/').pop() || '').toLowerCase();
    if (EDITOR_LANGUAGE_BY_NAME[fileName]) return EDITOR_LANGUAGE_BY_NAME[fileName];
    const ext = fileName.includes('.') ? fileName.split('.').pop() : '';
    return EDITOR_LANGUAGE_BY_EXT[ext] || 'plain';
}

function getEditorLanguageLabel(language) {
    return EDITOR_LANGUAGE_LABELS[language] || EDITOR_LANGUAGE_LABELS.plain;
}

function escapeHtml(text = '') {
    return String(text).replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

function tok(type, text) {
    if (!text) return '';
    return `<span class="tok-${type}">${escapeHtml(text)}</span>`;
}

function getLineComment(language) {
    if (['python', 'shell', 'yaml', 'ruby', 'toml', 'ini', 'dockerfile', 'makefile'].includes(language)) return '#';
    if (['sql', 'lua'].includes(language)) return '--';
    if (language === 'plain' || language === 'json') return '';
    return '//';
}

function getBlockComment(language) {
    if (['javascript', 'typescript', 'css', 'go', 'rust', 'java', 'c', 'cpp', 'csharp', 'php', 'swift', 'kotlin'].includes(language)) {
        return ['/*', '*/'];
    }
    return null;
}

function readQuoted(line, start, quote, language, state) {
    const triple = (language === 'python' || language === 'ruby') && (quote === '"' || quote === "'") && line.startsWith(quote.repeat(3), start);
    const delimiter = triple ? quote.repeat(3) : quote;
    let i = start + delimiter.length;
    while (i < line.length) {
        if (!triple && line[i] === '\\') {
            i += 2;
            continue;
        }
        if (line.startsWith(delimiter, i)) {
            i += delimiter.length;
            return { end: i, closed: true, delimiter };
        }
        i++;
    }
    const canContinue = triple || quote === '`' || (!triple && line.endsWith('\\'));
    if (canContinue) state.stringQuote = delimiter;
    return { end: line.length, closed: false, delimiter };
}

function finishOpenString(line, state) {
    const delimiter = state.stringQuote;
    let i = 0;
    while (i < line.length) {
        if (delimiter.length === 1 && line[i] === '\\') {
            i += 2;
            continue;
        }
        if (line.startsWith(delimiter, i)) {
            i += delimiter.length;
            state.stringQuote = '';
            return { html: tok('string', line.slice(0, i)), index: i };
        }
        i++;
    }
    return { html: tok('string', line), index: line.length };
}

function classifyIdentifier(identifier, line, start, end, language) {
    const keywords = EDITOR_KEYWORDS[language] || EDITOR_KEYWORDS.plain;
    const upper = identifier.toUpperCase();
    const normalized = language === 'dockerfile' ? upper : identifier;
    const after = line.slice(end).trimStart();
    const before = line.slice(0, start).trimEnd();

    if (keywords?.has(normalized) || keywords?.has(identifier)) return tok('keyword', identifier);
    if (/^(true|false|null|nil|None|True|False|undefined|NaN|Infinity)$/i.test(identifier)) return tok('literal', identifier);
    if ((language === 'json' || language === 'yaml' || language === 'toml' || language === 'ini') && after.startsWith(':')) return tok('attr', identifier);
    if (language === 'css' && (after.startsWith(':') || identifier.startsWith('--'))) return tok(identifier.startsWith('--') ? 'variable' : 'attr', identifier);
    if (after.startsWith('(') && !before.endsWith('.')) return tok('function', identifier);
    if (before.endsWith('.') || before.endsWith('::')) return tok('property', identifier);
    if (/^[A-Z][A-Za-z0-9_$]*$/.test(identifier)) return tok('type', identifier);
    return escapeHtml(identifier);
}

function highlightHtmlTag(rawTag) {
    const match = rawTag.match(/^(<\/?)([^\s>/]+)([\s\S]*?)(\/?>)$/);
    if (!match) return tok('tag', rawTag);
    const [, open, name, attrs, close] = match;
    let html = `${tok('punctuation', open)}${tok('tag', name)}`;
    const attrRegex = /([:@A-Za-z_][\w:.-]*)(\s*=\s*)?("[^"]*"|'[^']*'|[^\s"'=<>`]+)?/g;
    let lastIndex = 0;
    let attrMatch;
    while ((attrMatch = attrRegex.exec(attrs))) {
        html += escapeHtml(attrs.slice(lastIndex, attrMatch.index));
        html += tok('attr', attrMatch[1]);
        if (attrMatch[2]) html += tok('operator', attrMatch[2]);
        if (attrMatch[3]) html += tok('string', attrMatch[3]);
        lastIndex = attrRegex.lastIndex;
    }
    html += escapeHtml(attrs.slice(lastIndex));
    html += tok('punctuation', close);
    return html;
}

function highlightHtmlLine(line, state) {
    let html = '';
    let i = 0;
    while (i < line.length) {
        if (state.htmlComment) {
            const end = line.indexOf('-->', i);
            if (end === -1) return html + tok('comment', line.slice(i));
            html += tok('comment', line.slice(i, end + 3));
            state.htmlComment = false;
            i = end + 3;
            continue;
        }
        if (line.startsWith('<!--', i)) {
            const end = line.indexOf('-->', i + 4);
            if (end === -1) {
                state.htmlComment = true;
                return html + tok('comment', line.slice(i));
            }
            html += tok('comment', line.slice(i, end + 3));
            i = end + 3;
            continue;
        }
        if (line[i] === '<') {
            const end = line.indexOf('>', i + 1);
            if (end !== -1) {
                html += highlightHtmlTag(line.slice(i, end + 1));
                i = end + 1;
                continue;
            }
        }
        if (line[i] === '&') {
            const entity = line.slice(i).match(/^&[A-Za-z0-9#]+;/)?.[0];
            if (entity) {
                html += tok('literal', entity);
                i += entity.length;
                continue;
            }
        }
        html += escapeHtml(line[i]);
        i++;
    }
    return html;
}

function highlightMarkdownLine(line) {
    if (/^\s{0,3}#{1,6}\s/.test(line)) return tok('keyword', line);
    if (/^\s{0,3}([-*+]\s|\d+\.\s)/.test(line)) return line.replace(/^([\s\d.*+-]+)/, (m) => tok('operator', m));
    return highlightGenericLine(line, 'plain', {});
}

function highlightGenericLine(line, language, state) {
    if (language === 'html') return highlightHtmlLine(line, state);
    if (language === 'markdown') return highlightMarkdownLine(line);

    let html = '';
    let i = 0;
    const lineComment = getLineComment(language);
    const blockComment = getBlockComment(language);

    while (i < line.length) {
        if (state.stringQuote) {
            const open = finishOpenString(line.slice(i), state);
            html += open.html;
            i += open.index;
            continue;
        }

        if (state.blockComment) {
            const end = line.indexOf(state.blockComment, i);
            if (end === -1) return html + tok('comment', line.slice(i));
            html += tok('comment', line.slice(i, end + state.blockComment.length));
            i = end + state.blockComment.length;
            state.blockComment = '';
            continue;
        }

        if (blockComment && line.startsWith(blockComment[0], i)) {
            const end = line.indexOf(blockComment[1], i + blockComment[0].length);
            if (end === -1) {
                state.blockComment = blockComment[1];
                return html + tok('comment', line.slice(i));
            }
            html += tok('comment', line.slice(i, end + blockComment[1].length));
            i = end + blockComment[1].length;
            continue;
        }

        if (lineComment && line.startsWith(lineComment, i)) {
            html += tok('comment', line.slice(i));
            break;
        }

        const rest = line.slice(i);
        if (language === 'markdown' && /^\s{0,3}>/.test(rest)) {
            html += tok('comment', rest);
            break;
        }

        const ch = line[i];
        if (ch === '"' || ch === "'" || ch === '`') {
            const quoted = readQuoted(line, i, ch, language, state);
            html += tok('string', line.slice(i, quoted.end));
            i = quoted.end;
            continue;
        }

        const atRule = rest.match(/^@[A-Za-z_-][\w-]*/)?.[0];
        if (atRule && (language === 'css' || language === 'java' || language === 'typescript')) {
            html += tok('keyword', atRule);
            i += atRule.length;
            continue;
        }

        const number = rest.match(/^(0x[\da-fA-F]+|0b[01]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/)?.[0];
        if (number && !/[\w$]/.test(line[i - 1] || '')) {
            html += tok('number', number);
            i += number.length;
            continue;
        }

        const identifier = rest.match(/^[A-Za-z_$-][\w$-]*/)?.[0];
        if (identifier && !identifier.startsWith('-')) {
            html += classifyIdentifier(identifier, line, i, i + identifier.length, language);
            i += identifier.length;
            continue;
        }

        const operator = rest.match(/^(===|!==|=>|->|::|&&|\|\||\+\+|--|==|!=|<=|>=|[-+*/%=&|^!~?:]+)/)?.[0];
        if (operator) {
            html += tok('operator', operator);
            i += operator.length;
            continue;
        }

        if (/^[{}()[\],.;]$/.test(ch)) {
            html += tok('punctuation', ch);
            i++;
            continue;
        }

        html += escapeHtml(ch);
        i++;
    }
    return html;
}

function highlightCode(text, language) {
    const normalized = String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = normalized.split('\n');
    const state = { blockComment: '', stringQuote: '', htmlComment: false };
    const highlighted = lines.map(line => highlightGenericLine(line, language, state));
    return highlighted.join('\n') || '&#8203;';
}

function getEditorLines(text = '') {
    return String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

function getDisplayColumnCount(line = '', tabSize = Number(fmEditorTabSize?.value) || 4) {
    let columns = 0;
    for (const ch of String(line)) {
        if (ch === '\t') {
            columns += tabSize - (columns % tabSize || 0);
        } else if (/[^\x00-\xff]/.test(ch)) {
            columns += 2;
        } else {
            columns += 1;
        }
    }
    return columns;
}

function getEditorWrapColumns() {
    if (!fmEditorTextarea) return 120;
    const computed = getComputedStyle(fmEditorTextarea);
    const fontSize = parseFloat(computed.fontSize) || 13;
    const charWidth = fontSize * 0.62;
    const paddingLeft = parseFloat(computed.paddingLeft) || 0;
    const paddingRight = parseFloat(computed.paddingRight) || 0;
    const codeWidth = Math.max(charWidth, fmEditorTextarea.clientWidth - paddingLeft - paddingRight);
    return Math.max(1, Math.floor(codeWidth / charWidth));
}

function getEditorVisualRows(lines) {
    const wrapEnabled = fmEditorWrap?.checked !== false && fmEditorMain?.classList.contains('wrap-enabled');
    if (!wrapEnabled) return lines.map(() => 1);
    const columns = getEditorWrapColumns();
    const tabSize = Number(fmEditorTabSize?.value) || 4;
    return lines.map((line) => Math.max(1, Math.ceil(Math.max(1, getDisplayColumnCount(line, tabSize)) / columns)));
}

function syncEditorCodeScroll() {
    if (!fmEditorTextarea) return;
    if (fmEditorHighlight) {
        fmEditorHighlight.style.transform = `translate3d(${-fmEditorTextarea.scrollLeft}px, ${-fmEditorTextarea.scrollTop}px, 0)`;
    }
    if (fmEditorIndentGuides) {
        fmEditorIndentGuides.style.transform = `translate3d(${-fmEditorTextarea.scrollLeft}px, ${-fmEditorTextarea.scrollTop}px, 0)`;
    }
    if (fmEditorLineNumbers) {
        fmEditorLineNumbers.style.transform = `translate3d(0, ${-fmEditorTextarea.scrollTop}px, 0)`;
    }
    updateEditorMinimapViewport();
}

function renderEditorCodeLayers() {
    if (!fmEditorTextarea) return;
    const text = fmEditorTextarea.value || '';
    const lines = getEditorLines(text);
    const visualRows = getEditorVisualRows(lines);
    const highlighted = highlightCode(text, editorLanguage);
    if (fmEditorHighlight) fmEditorHighlight.innerHTML = highlighted;
    renderEditorIndentGuides(lines, visualRows);
    renderEditorLineNumbers(lines, visualRows);
    syncEditorMinimapMetrics();
    if (fmEditorMinimapCode && !editorMinimapHidden) fmEditorMinimapCode.innerHTML = renderMinimapCode(lines, editorLanguage, visualRows);
    syncEditorCodeScroll();
}

function ensureEditorLineNumbers() {
    if (!fmEditorMain) return null;
    if (!fmEditorLineNumbers) {
        fmEditorLineNumbers = document.createElement('div');
        fmEditorLineNumbers.id = 'fmEditorLineNumbers';
        fmEditorLineNumbers.className = 'fm-editor-line-numbers';
        fmEditorLineNumbers.setAttribute('aria-hidden', 'true');
        fmEditorMain.insertBefore(fmEditorLineNumbers, fmEditorMain.firstChild);
    }
    return fmEditorLineNumbers;
}

function ensureEditorIndentGuides() {
    if (!fmEditorMain) return null;
    if (!fmEditorIndentGuides) {
        fmEditorIndentGuides = document.createElement('pre');
        fmEditorIndentGuides.id = 'fmEditorIndentGuides';
        fmEditorIndentGuides.className = 'fm-editor-indent-guides';
        fmEditorIndentGuides.setAttribute('aria-hidden', 'true');
        fmEditorMain.insertBefore(fmEditorIndentGuides, fmEditorHighlight || fmEditorTextarea);
    }
    return fmEditorIndentGuides;
}

function getLeadingIndentColumns(line = '', tabSize = Number(fmEditorTabSize?.value) || 4) {
    let columns = 0;
    for (const ch of String(line)) {
        if (ch === ' ') columns += 1;
        else if (ch === '\t') columns += tabSize - (columns % tabSize || 0);
        else break;
    }
    return columns;
}

function getEditorCharWidth() {
    if (!fmEditorTextarea) return 8;
    const computed = getComputedStyle(fmEditorTextarea);
    const fontSize = parseFloat(computed.fontSize) || 13;
    const probe = document.createElement('span');
    probe.textContent = 'mmmmmmmmmm';
    probe.style.position = 'fixed';
    probe.style.left = '-9999px';
    probe.style.top = '-9999px';
    probe.style.visibility = 'hidden';
    probe.style.font = computed.font;
    probe.style.fontFamily = computed.fontFamily;
    probe.style.fontSize = computed.fontSize;
    probe.style.fontWeight = computed.fontWeight;
    probe.style.letterSpacing = computed.letterSpacing;
    document.body.appendChild(probe);
    const width = probe.getBoundingClientRect().width / 10;
    probe.remove();
    return Number.isFinite(width) && width > 0 ? width : fontSize * 0.62;
}

function getEditorIndentGuideColumns(lines, index, tabSize) {
    const line = String(lines[index] ?? '');
    if (line.trim()) return getLeadingIndentColumns(line, tabSize);

    // VSCode 风格：空白行不会简单变成 0，而是继承相邻代码块中较小的缩进层级，
    // 这样块内部空行的参考线保持连续，但块之间不会错误贯穿。
    let previous = 0;
    for (let i = index - 1; i >= 0; i--) {
        if (String(lines[i] ?? '').trim()) {
            previous = getLeadingIndentColumns(lines[i], tabSize);
            break;
        }
    }

    let next = 0;
    for (let i = index + 1; i < lines.length; i++) {
        if (String(lines[i] ?? '').trim()) {
            next = getLeadingIndentColumns(lines[i], tabSize);
            break;
        }
    }

    if (previous && next) return Math.min(previous, next);
    return previous || next || 0;
}

function renderEditorIndentGuides(lines = getEditorLines(fmEditorTextarea?.value || ''), visualRows = getEditorVisualRows(lines)) {
    const layer = ensureEditorIndentGuides();
    if (!layer || !fmEditorTextarea) return;
    const tabSize = Number(fmEditorTabSize?.value) || 4;
    const lineHeight = parseFloat(getComputedStyle(fmEditorTextarea).lineHeight) || 20.15;
    const charWidth = getEditorCharWidth();
    const step = Math.max(1, tabSize * charWidth);
    const guideColumns = lines.map((_, index) => getEditorIndentGuideColumns(lines, index, tabSize));
    const signature = `${lines.length}:${tabSize}:${step.toFixed(2)}:${visualRows.join(',')}:${guideColumns.join(',')}`;
    if (layer._signature === signature) return;
    layer._signature = signature;
    layer.style.setProperty('--editor-indent-step', `${step}px`);
    layer.innerHTML = lines.map((line, index) => {
        const columns = guideColumns[index];
        const levels = Math.floor(columns / tabSize);
        const rowHeight = Math.max(1, visualRows[index] || 1) * lineHeight;
        const guideWidth = Math.max(0, levels * step);
        return `<span class="fm-indent-guide-line" style="--editor-indent-line-height:${rowHeight}px;--editor-indent-guide-width:${guideWidth}px"></span>`;
    }).join('');

    console.debug('[EditorIndentGuides]', {
        lines: lines.length,
        tabSize,
        charWidth: Number(charWidth.toFixed(3)),
        step: Number(step.toFixed(3)),
        sampleGuideColumns: guideColumns.slice(0, 20),
    });
}

function renderEditorLineNumbers(lines = getEditorLines(fmEditorTextarea?.value || ''), visualRows = getEditorVisualRows(lines)) {
    const gutter = ensureEditorLineNumbers();
    if (!gutter) return;
    const lineCount = Math.max(1, lines.length);
    const digits = String(lineCount).length;
    const gutterWidth = Math.max(48, 22 + digits * 8);
    fmEditorMain?.style.setProperty('--editor-gutter-width', `${gutterWidth}px`);
    const lineHeight = parseFloat(getComputedStyle(fmEditorTextarea).lineHeight) || 20.15;
    const signature = `${lineCount}:${gutterWidth}:${visualRows.join(',')}`;
    if (gutter._signature === signature) return;
    gutter._signature = signature;
    gutter.innerHTML = Array.from({ length: lineCount }, (_, i) => {
        const rowHeight = Math.max(1, visualRows[i] || 1) * lineHeight;
        return `<span style="--editor-line-number-height:${rowHeight}px">${i + 1}</span>`;
    }).join('');
}

function syncEditorMinimapMetrics() {
    if (!fmEditorTextarea || !fmEditorMinimap) return;
    const computed = getComputedStyle(fmEditorTextarea);
    const fontSize = parseFloat(computed.fontSize) || 13;
    const lineHeight = parseFloat(computed.lineHeight) || fontSize * 1.55;
    const paddingTop = parseFloat(computed.paddingTop) || 0;
    const paddingLeft = parseFloat(computed.paddingLeft) || 0;
    const scale = Number(getComputedStyle(fmEditorMinimap).getPropertyValue('--minimap-scale')) || 0.22;
    fmEditorMinimap.style.setProperty('--minimap-font-size', `${Math.max(3, fontSize * scale)}px`);
    fmEditorMinimap.style.setProperty('--minimap-line-height', `${Math.max(4, lineHeight * scale)}px`);
    fmEditorMinimap.style.setProperty('--minimap-padding-top', `${Math.max(0, paddingTop * scale)}px`);
    fmEditorMinimap.style.setProperty('--minimap-padding-left', `${Math.max(0, paddingLeft * scale)}px`);
}

function renderMinimapCode(textOrLines = '', language = 'plain', visualRows = null) {
    const lines = Array.isArray(textOrLines) ? textOrLines : getEditorLines(textOrLines);
    const rows = visualRows || getEditorVisualRows(lines);
    return lines.map((line, index) => {
        const trimmed = line.trim();
        const commentPrefix = getLineComment(language);
        const type = commentPrefix && trimmed.startsWith(commentPrefix)
            ? 'comment'
            : (/^<\/?[A-Za-z]/.test(trimmed) ? 'tag'
                : (/^(const|let|var|function|class|if|else|for|while|return|import|export|def|class|from|async|await|public|private|protected|static)\b/.test(trimmed) ? 'keyword'
                    : (/(['"`]).*\1/.test(trimmed) ? 'string'
                        : (/\b\d+(\.\d+)?\b/.test(trimmed) ? 'number' : 'text'))));
        const preview = escapeHtml(line.slice(0, 120)) || '&nbsp;';
        const lineRows = Math.max(1, rows[index] || 1);
        return `<span class="fm-minimap-line" style="height:calc(var(--minimap-line-height) * ${lineRows})"><span class="fm-minimap-seg ${type}">${preview}</span></span>`;
    }).join('');
}

function updateEditorMinimap() {
    if (!fmEditorMinimap) return;
    fmEditorModal.classList.toggle('minimap-hidden', editorMinimapHidden);
    fmEditorMinimapToggle?.classList.toggle('active', !editorMinimapHidden);
    renderEditorCodeLayers();
}

function updateEditorMinimapViewport() {
    if (!fmEditorMinimap || !fmEditorTextarea) return;
    if (editorMinimapHidden) return;
    const maxScroll = Math.max(1, fmEditorTextarea.scrollHeight - fmEditorTextarea.clientHeight);
    const ratio = fmEditorTextarea.scrollTop / maxScroll;
    const viewportRatio = Math.min(1, fmEditorTextarea.clientHeight / Math.max(fmEditorTextarea.scrollHeight, 1));
    const heightPercent = Math.max(10, viewportRatio * 100);
    fmEditorMinimap.style.setProperty('--minimap-view-top', `${ratio * (100 - heightPercent)}%`);
    fmEditorMinimap.style.setProperty('--minimap-view-height', `${heightPercent}%`);
    if (fmEditorMinimapCode) {
        const overflow = Math.max(0, fmEditorMinimapCode.scrollHeight - fmEditorMinimap.clientHeight);
        fmEditorMinimap.style.setProperty('--minimap-code-top', `${-(ratio * overflow)}px`);
    }
}

function setEditorScrollFromMinimap(clientY) {
    if (!fmEditorMinimap || editorMinimapHidden) return;
    const rect = fmEditorMinimap.getBoundingClientRect();
    const maxScroll = Math.max(0, fmEditorTextarea.scrollHeight - fmEditorTextarea.clientHeight);
    const viewportRatio = Math.min(1, fmEditorTextarea.clientHeight / Math.max(fmEditorTextarea.scrollHeight, 1));
    const thumbHeight = Math.max(18, rect.height * viewportRatio);
    const ratio = Math.min(1, Math.max(0, (clientY - rect.top - thumbHeight / 2) / Math.max(1, rect.height - thumbHeight)));
    fmEditorTextarea.scrollTop = ratio * maxScroll;
    syncEditorCodeScroll();
}


function allocateFloatingPanelZIndex(panel) {
    const currentZIndex = Number(panel?.style?.zIndex || 0) || 0;
    let maxZIndex = Math.max(floatingPanelZIndexSeed, editorZIndexSeed, currentZIndex);
    document.querySelectorAll(FLOATING_PANEL_SELECTOR).forEach((item) => {
        maxZIndex = Math.max(maxZIndex, Number(item.style.zIndex || 0) || 0);
    });
    floatingPanelZIndexSeed = maxZIndex + 1;
    editorZIndexSeed = Math.max(editorZIndexSeed, floatingPanelZIndexSeed);
    return floatingPanelZIndexSeed;
}

function dockEditorPanel(panel) {
    if (!panel) return panel;
    const terminalPage = document.querySelector('.terminal-page');
    if (!terminalPage || panel.parentElement === terminalPage) return panel;
    const rect = panel.getBoundingClientRect?.();
    const pageRect = terminalPage.getBoundingClientRect?.();
    terminalPage.appendChild(panel);
    if (rect && pageRect) {
        panel.style.left = `${Math.round(rect.left - pageRect.left)}px`;
        panel.style.top = `${Math.round(rect.top - pageRect.top)}px`;
    }
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    return panel;
}

function updateEditorZIndex(panel) {
    if (!panel?.classList?.contains('editor-window')) return;
    panel.style.zIndex = String(allocateFloatingPanelZIndex(panel));
}

function updateActiveEditorRefs(panel = activeEditorPanel || fmEditorModal) {
    if (!panel) return;
    activeEditorPanel = panel;
    fmEditorModal = panel;
    fmEditorTitle = panel.querySelector('[data-editor-role="title"], #fmEditorTitle');
    fmEditorMain = panel.querySelector('[data-editor-role="main"], #fmEditorMain');
    fmEditorTextarea = panel.querySelector('[data-editor-role="textarea"], #fmEditorTextarea') || panel.querySelector('.cm-content');
    fmEditorLineNumbers = panel.querySelector('[data-editor-role="lineNumbers"], #fmEditorLineNumbers');
    fmEditorHighlight = panel.querySelector('[data-editor-role="highlight"], #fmEditorHighlight');
    fmEditorIndentGuides = panel.querySelector('[data-editor-role="indentGuides"], #fmEditorIndentGuides');
    fmEditorMinimap = panel.querySelector('[data-editor-role="minimap"], #fmEditorMinimap');
    fmEditorMinimapCode = panel.querySelector('[data-editor-role="minimapCode"], #fmEditorMinimapCode');
    fmEditorMinimapToggle = panel.querySelector('[data-editor-action="minimap"], #fmEditorMinimapToggle');
    fmEditorCompactBtn = panel.querySelector('[data-editor-action="compact"], #fmEditorCompactBtn');
    fmEditorPaletteBtn = panel.querySelector('[data-editor-action="palette"], #fmEditorPaletteBtn');
    fmEditorAiBtn = panel.querySelector('[data-editor-action="ai-complete"], #fmEditorAiBtn');
    fmEditorFormatBtn = panel.querySelector('[data-editor-action="format"], #fmEditorFormatBtn');
    fmEditorSaveBtn = panel.querySelector('[data-editor-action="save"], #fmEditorSaveBtn');
    fmEditorCancelBtn = panel.querySelector('[data-editor-action="cancel"], #fmEditorCancelBtn');
    fmEditorCloseBtn = panel.querySelector('[data-editor-action="close"], #fmEditorCloseBtn');
    fmEditorUndoBtn = panel.querySelector('[data-editor-action="undo"], #fmEditorUndoBtn');
    fmEditorRedoBtn = panel.querySelector('[data-editor-action="redo"], #fmEditorRedoBtn');
    fmEditorEncoding = panel.querySelector('[data-editor-field="encoding"], #fmEditorEncoding');
    fmEditorLineEnding = panel.querySelector('[data-editor-field="lineEnding"], #fmEditorLineEnding');
    fmEditorTabSize = panel.querySelector('[data-editor-field="tabSize"], #fmEditorTabSize');
    fmEditorWrap = panel.querySelector('[data-editor-field="wrap"], #fmEditorWrap');
    fmEditorStatus = panel.querySelector('[data-editor-role="status"], #fmEditorStatus');
    editorFilePath = panel.dataset.editorPath || editorFilePath;
    editorLanguage = panel._editorLanguage || detectEditorLanguage(editorFilePath || '');
    editorRawBytes = panel._editorRawBytes || null;
}

function markEditorRoles(panel) {
    if (!panel || panel._editorRolesReady) return;
    panel._editorRolesReady = true;
    const pairs = [
        ['#fmEditorTitle', 'data-editor-role', 'title'],
        ['#fmEditorMain', 'data-editor-role', 'main'],
        ['#fmEditorStatus', 'data-editor-role', 'status'],
        ['#fmEditorCompactBtn', 'data-editor-action', 'compact'],
        ['#fmEditorMinimapToggle', 'data-editor-action', 'minimap'],
        ['#fmEditorPaletteBtn', 'data-editor-action', 'palette'],
        ['#fmEditorAiBtn', 'data-editor-action', 'ai-complete'],
        ['#fmEditorFormatBtn', 'data-editor-action', 'format'],
        ['#fmEditorUndoBtn', 'data-editor-action', 'undo'],
        ['#fmEditorRedoBtn', 'data-editor-action', 'redo'],
        ['#fmEditorCloseBtn', 'data-editor-action', 'close'],
        ['#fmEditorSaveBtn', 'data-editor-action', 'save'],
        ['#fmEditorCancelBtn', 'data-editor-action', 'cancel'],
        ['#fmEditorEncoding', 'data-editor-field', 'encoding'],
        ['#fmEditorLineEnding', 'data-editor-field', 'lineEnding'],
        ['#fmEditorTabSize', 'data-editor-field', 'tabSize'],
        ['#fmEditorWrap', 'data-editor-field', 'wrap'],
    ];
    pairs.forEach(([selector, attr, value]) => panel.querySelector(selector)?.setAttribute(attr, value));
}

markEditorRoles(fmEditorModal);
updateActiveEditorRefs(fmEditorModal);

function refreshCodeMirrorLayout() {
    window.requestAnimationFrame(() => getEditorInstance()?.view?.requestMeasure?.());
}

async function closeEditor({ animated = true, force = false } = {}) {
    const panel = fmEditorModal;
    if (typeof closeEditorCommandPalette === 'function') closeEditorCommandPalette(panel);
    if (!force && window.ZephyrCodeEditor?.dirty?.(panel?._codeEditor)) {
        const choice = await requestEditorCloseChoice();
        if (choice === 'save') { saveActiveEditor({ closeAfterSave: true, forceClose: true }); return; }
        if (choice !== 'discard') return;
    }
    const closingPath = panel?.dataset.editorPath || editorFilePath;
    const closingId = panel?.dataset.editorId || '';
    const removePanel = () => {
        window.ZephyrCodeEditor?.destroy?.(panel._codeEditor);
        panel._codeEditor = null;
        panel.style.display = 'none';
        panel.classList.remove('open', 'closing');
        if (closingId) editorPanelsByPath.delete(closingId);
        else if (closingPath) {
            for (const [key, value] of editorPanelsByPath.entries()) {
                if (value === panel || value.dataset.editorPath === closingPath) editorPanelsByPath.delete(key);
            }
        }
        delete panel.dataset.editorPath;
        panel._editorRawBytes = null;
        panel._editorLanguage = null;
        if (panel !== document.getElementById('fmEditorModal')) panel.remove();
    };
    if (!animated) { removePanel(); return; }
    panel.classList.remove('open');
    panel.classList.add('closing');
    panel._closeTimer && window.clearTimeout(panel._closeTimer);
    panel._closeTimer = window.setTimeout(removePanel, 260);
}

function applyEditorOptions() {
    const instance = getEditorInstance();
    window.ZephyrCodeEditor?.updateOptions?.(instance, { tabSize: Number(fmEditorTabSize?.value) || 4, wrap: fmEditorWrap?.checked !== false, language: editorLanguage });
    fmEditorMain?.classList.toggle('wrap-enabled', fmEditorWrap?.checked !== false);
    updateEditorStatus();
}

function loadEditorFromBytes(bytes, encoding = fmEditorEncoding.value) {
    editorRawBytes = bytes;
    if (activeEditorPanel) activeEditorPanel._editorRawBytes = bytes;
    let text = decodeBytes(bytes, encoding);
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    fmEditorLineEnding.value = detectLineEnding(text);
    const create = () => {
        window.ZephyrCodeEditor?.destroy?.(fmEditorModal._codeEditor);
        fmEditorModal._codeEditor = window.ZephyrCodeEditor.create({
            panel: fmEditorModal,
            parent: fmEditorMain,
            path: editorFilePath,
            language: editorLanguage,
            text,
            size: bytes?.length || fmEditorModal._editorSize || 0,
            mtimeMs: fmEditorModal._editorMtimeMs || 0,
            tabSize: Number(fmEditorTabSize?.value) || 4,
            wrap: fmEditorWrap?.checked !== false,
            autoSave: false,
            minimap: localStorage.getItem('zephyr-editor-minimap-hidden') !== '1',
            compact: localStorage.getItem('zephyr-editor-compact') === '1' || isCompactScreen(),
            titleEl: fmEditorTitle,
            statusEl: fmEditorStatus,
            notify: showToast,
            onSave: ({ silent } = {}) => saveActiveEditor({ closeAfterSave: !silent }),
            onDiagnostics: (diags) => {
                fmEditorModal._diagnostics = diags || [];
                const btn = fmEditorModal.querySelector('[data-editor-action="problems"]');
                if (btn) btn.classList.toggle('active', (diags || []).length > 0);
            },
            onOutline: (items) => showEditorSidepanel(fmEditorModal, 'outline', items || []),
        });
        updateActiveEditorRefs(fmEditorModal);
        updateEditorStatus();
        renderEditorTabs(fmEditorModal);
    };
    if (window.ZephyrCodeEditor?.create) create();
    else window.setTimeout(create, 80);
}

function setupEditorPanel(panel) {
    if (!panel || panel._editorPanelReady) return panel;
    panel._editorPanelReady = true;
    markEditorRoles(panel);
    panel.classList.add('editor-window');
    if (panel === document.getElementById('fmEditorModal') && panel.parentElement !== document.querySelector('.terminal-page')) {
        const rect = fileManager.getBoundingClientRect();
        dockEditorPanel(panel);
        const pageRect = panel.parentElement.getBoundingClientRect();
        panel.style.left = `${Math.round(rect.left - pageRect.left + 16 + (editorPanelsByPath.size % 4) * 22)}px`;
        panel.style.top = `${Math.round(rect.top - pageRect.top + 52 + (editorPanelsByPath.size % 4) * 22)}px`;
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
    }
    updateEditorZIndex(panel);
    if (!panel.querySelector('[data-editor-resize-edge="left"]')) {
        const leftHandle = document.createElement('div');
        leftHandle.className = 'panel-resize-handle left';
        leftHandle.dataset.editorResizeEdge = 'left';
        leftHandle.title = t('拖动调整大小');
        const rightHandle = document.createElement('div');
        rightHandle.className = 'panel-resize-handle right';
        rightHandle.dataset.editorResizeEdge = 'right';
        rightHandle.title = t('拖动调整大小');
        panel.append(leftHandle, rightHandle);
    }
    panel.addEventListener('pointerdown', (e) => {
        updateActiveEditorRefs(panel);
        updateEditorZIndex(panel);
        bringPanelToFront(panel);
    }, { capture: true });
    panel.querySelector('.fm-editor-header')?.addEventListener('pointerdown', (e) => {
        // Buttons + the horizontally-scrollable actions strip must not start window drag.
        if (e.target.closest('button,input,select,textarea,label,.fm-editor-header-actions')) return;
        e.preventDefault();
        e.stopPropagation();
        updateActiveEditorRefs(panel);
        updateEditorZIndex(panel);
        bringPanelToFront(panel);
        panel.classList.add('dragging');
        panel.setPointerCapture?.(e.pointerId);
        const startX = e.clientX;
        const startY = e.clientY;
        const startLeft = panel.offsetLeft;
        const startTop = panel.offsetTop;
        const onMove = (ev) => {
            ev.preventDefault();
            panel.style.left = `${startLeft + ev.clientX - startX}px`;
            panel.style.top = `${startTop + ev.clientY - startY}px`;
            panel.dataset.editorMoved = '1';
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
            clampPanel(panel);
        };
        const onUp = () => {
            panel.classList.remove('dragging');
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
        };
        window.addEventListener('pointermove', onMove, { passive: false });
        window.addEventListener('pointerup', onUp, { once: true });
    });
    const editorLayoutButton = panel.querySelector('[data-layout-panel="editor"]');
    if (editorLayoutButton && !editorLayoutButton._editorLayoutReady) {
        editorLayoutButton._editorLayoutReady = true;
        editorLayoutButton.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            updateActiveEditorRefs(panel);
            bringPanelToFront(panel);
            editorLayoutButton.classList.add('pressing');
            editorLayoutButton.setPointerCapture?.(e.pointerId);
            const startX = e.clientX;
            const startY = e.clientY;
            const startLeft = panel.offsetLeft;
            const startTop = panel.offsetTop;
            let moved = false;
            const onMove = (ev) => {
                ev.preventDefault();
                const dx = ev.clientX - startX;
                const dy = ev.clientY - startY;
                if (!moved && Math.hypot(dx, dy) > 7) { moved = true; closePanelLayoutMenu({ instant: true }); panel.classList.add('dragging'); }
                if (!moved) return;
                panel.style.left = `${startLeft + dx}px`;
                panel.style.top = `${startTop + dy}px`;
                panel.style.right = 'auto';
                panel.style.bottom = 'auto';
                panel.dataset.editorMoved = '1';
                clampPanel(panel);
            };
            const onUp = () => {
                panel.classList.remove('dragging');
                editorLayoutButton.classList.remove('pressing');
                suppressNextLayoutClick = moved;
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
                window.removeEventListener('pointercancel', onUp);
            };
            window.addEventListener('pointermove', onMove, { passive: false });
            window.addEventListener('pointerup', onUp, { once: true });
            window.addEventListener('pointercancel', onUp, { once: true });
        });
        editorLayoutButton.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (suppressNextLayoutClick) { suppressNextLayoutClick = false; return; }
            updateActiveEditorRefs(panel);
            bringPanelToFront(panel);
            if (navigator.vibrate) navigator.vibrate(8);
            if (panelLayoutMenu && panelLayoutButton === editorLayoutButton) closePanelLayoutMenu();
            else openPanelLayoutMenu(editorLayoutButton, panel);
        });
    }

    const titlebar = panel.querySelector('.fm-editor-window-titlebar');
    if (titlebar && !titlebar._editorTitlebarDragReady) {
        titlebar._editorTitlebarDragReady = true;
        titlebar.addEventListener('pointerdown', (e) => {
            if (e.target.closest('button,input,select,textarea,label')) return;
            e.preventDefault();
            e.stopPropagation();
            updateActiveEditorRefs(panel);
            bringPanelToFront(panel);
            panel.classList.add('dragging');
            titlebar.setPointerCapture?.(e.pointerId);
            const startX = e.clientX;
            const startY = e.clientY;
            const startLeft = panel.offsetLeft;
            const startTop = panel.offsetTop;
            const onMove = (ev) => {
                ev.preventDefault();
                panel.style.left = `${startLeft + ev.clientX - startX}px`;
                panel.style.top = `${startTop + ev.clientY - startY}px`;
                panel.dataset.editorMoved = '1';
                panel.style.right = 'auto';
                panel.style.bottom = 'auto';
                clampPanel(panel);
            };
            const onUp = () => {
                panel.classList.remove('dragging');
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
                window.removeEventListener('pointercancel', onUp);
            };
            window.addEventListener('pointermove', onMove, { passive: false });
            window.addEventListener('pointerup', onUp, { once: true });
            window.addEventListener('pointercancel', onUp, { once: true });
        });
    }

    panel.querySelectorAll('[data-editor-resize-edge]').forEach((handle) => {
        handle.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            handle.setPointerCapture?.(e.pointerId);
            updateActiveEditorRefs(panel);
            updateEditorZIndex(panel);
            bringPanelToFront(panel);
            panel.classList.add('resizing');
            const startX = e.clientX;
            const startY = e.clientY;
            const startWidth = panel.offsetWidth;
            const startHeight = panel.offsetHeight;
            const startLeft = panel.offsetLeft;
            const edge = handle.dataset.editorResizeEdge || 'right';
            const parentRect = panel.parentElement.getBoundingClientRect();
            const minWidth = isCompactScreen() ? 260 : 420;
            const minHeight = isCompactScreen() ? 220 : 320;
            const onMove = (ev) => {
                ev.preventDefault();
                let nextLeft = startLeft;
                let nextWidth = startWidth + ev.clientX - startX;
                if (edge === 'left') {
                    nextWidth = startWidth - (ev.clientX - startX);
                    nextLeft = startLeft + (ev.clientX - startX);
                    if (nextWidth < minWidth) {
                        nextLeft -= minWidth - nextWidth;
                        nextWidth = minWidth;
                    }
                    if (nextLeft < 0) {
                        nextWidth += nextLeft;
                        nextLeft = 0;
                    }
                    panel.style.left = `${nextLeft}px`;
                }
                const maxWidth = edge === 'left' ? startLeft + startWidth : parentRect.width - panel.offsetLeft;
                const maxHeight = parentRect.height - panel.offsetTop;
                const width = Math.max(minWidth, Math.min(nextWidth, Math.max(minWidth, maxWidth)));
                const height = Math.max(minHeight, Math.min(startHeight + ev.clientY - startY, Math.max(minHeight, maxHeight)));
                panel.style.width = `${width}px`;
                panel.style.height = `${height}px`;
                panel.dataset.editorResized = '1';
                refreshCodeMirrorLayout();
            };
            const onUp = () => {
                panel.classList.remove('resizing');
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
            };
            window.addEventListener('pointermove', onMove, { passive: false });
            window.addEventListener('pointerup', onUp, { once: true });
        });
    });
    return panel;
}

function createEditorPanel(filePath) {
    const template = document.getElementById('fmEditorModal') || fmEditorModal;
    markEditorRoles(template);
    const panel = template.cloneNode(true);
    panel.removeAttribute('id');
    panel.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
    dockEditorPanel(panel);
    panel.dataset.editorPath = filePath;
    panel.style.display = 'flex';
    if (panel.parentElement === document.querySelector('.terminal-page') && !panel.style.left && !panel.style.top) {
        if (!panel.dataset.editorMoved && !panel.dataset.editorResized) {
            if (isCompactScreen()) {
                panel.style.width = 'calc(100vw - 12px)';
                panel.style.left = '6px';
                panel.style.top = '6px';
            } else {
                const rect = fileManager.getBoundingClientRect();
                const pageRect = panel.parentElement.getBoundingClientRect();
                panel.style.left = `${Math.round(rect.left - pageRect.left + 16 + (editorPanelsByPath.size % 4) * 22)}px`;
                panel.style.top = `${Math.round(rect.top - pageRect.top + 52 + (editorPanelsByPath.size % 4) * 22)}px`;
            }
        }
        updateEditorZIndex(panel);
    } else {
        panel.style.left = panel.style.left || `${16 + (editorPanelsByPath.size % 4) * 22}px`;
        panel.style.top = panel.style.top || `${52 + (editorPanelsByPath.size % 4) * 22}px`;
    }
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.width = panel.style.width || '';
    panel.style.height = panel.style.height || '';
    setupEditorPanel(panel);
    setupClonedEditorEvents(panel);
    const key = `${filePath}#${Date.now()}-${Math.random().toString(36).slice(2)}`;
    panel.dataset.editorId = key;
    editorPanelsByPath.set(key, panel);
    return panel;
}

function openImagePreview(filePath) {
    if (!window.ZephyrImagePreview) {
        showToast('图片预览模块未加载', 'error');
        return;
    }
    const existingEntry = Array.from(imagePreviewPanelsByPath.entries()).find(([path, instance]) => path === filePath || instance.currentPath === filePath);
    let preview = existingEntry?.[1];
    if (!preview) {
        preview = new window.ZephyrImagePreview({
            path: filePath,
            index: imagePreviewPanelsByPath.size,
            send: (payload) => {
                if (!wsConnection || wsConnection.readyState !== WebSocket.OPEN) {
                    showToast('SSH 尚未连接，无法预览图片', 'error');
                    return;
                }
                wsConnection.send(JSON.stringify(payload));
            },
            notify: showToast,
            bringToFront: bringPanelToFront,
            allocateZIndex: allocateFloatingPanelZIndex,
            layoutMenu: { open: openPanelLayoutMenu, close: closePanelLayoutMenu },
            formatSize: formatTransferSize,
            getImages: (currentImagePath = '') => {
                const dir = String(currentImagePath || currentPath).replace(/\/[^/]*$/, '') || currentPath;
                return allFiles.filter((file) => file.type !== 'd' && window.ZephyrImagePreview?.isImage?.(file.name)).map((file) => ({ ...file, path: (dir.replace(/\/+$/, '') || '/') + '/' + file.name }));
            },
            onFocus: (instance) => { activeImagePreview = instance; },
            onClose: (instance) => {
                if (activeImagePreview === instance) activeImagePreview = null;
                if (instance?.currentPath) imagePreviewPanelsByPath.delete(instance.currentPath);
                for (const [path, previewInstance] of imagePreviewPanelsByPath.entries()) {
                    if (previewInstance === instance) imagePreviewPanelsByPath.delete(path);
                }
            },
        });
        imagePreviewPanelsByPath.set(filePath, preview);
    }
    activeImagePreview = preview;
    preview.open(filePath);
}

function ensureMediaPreviewModule() {
    if (window.ZephyrMediaPreview) return Promise.resolve(true);
    if (window.__zephyrMediaPreviewLoading) return window.__zephyrMediaPreviewLoading;
    window.__zephyrMediaPreviewLoading = new Promise((resolve) => {
        const script = document.createElement('script');
        const done = () => {
            window.__zephyrMediaPreviewLoading = null;
            resolve(!!window.ZephyrMediaPreview);
        };
        script.addEventListener('load', done, { once: true });
        script.addEventListener('error', () => {
            window.__zephyrMediaPreviewLoading = null;
            resolve(false);
        }, { once: true });
        script.src = `preview/media/media-preview.js?v=20260720-telnet-ui-motion2-${Date.now()}`;
        document.body.appendChild(script);
    });
    return window.__zephyrMediaPreviewLoading;
}

async function openMediaPreview(filePath) {
    if (!window.ZephyrMediaPreview) {
        const loaded = await ensureMediaPreviewModule();
        if (!loaded || !window.ZephyrMediaPreview) {
            const script = document.querySelector('script[src*="preview/media/media-preview.js"]');
            showToast(`媒体预览模块未加载${script ? t('，请强制刷新页面后重试') : t('，当前页面缺少 media-preview.js')}`, 'error');
            console.error('[SFTP-MEDIA]', 'ZephyrMediaPreview missing', { filePath, scriptPresent: !!script });
            return;
        }
    }
    const existingEntry = Array.from(mediaPreviewPanelsByPath.entries()).find(([path, instance]) => path === filePath || instance.currentPath === filePath);
    let preview = existingEntry?.[1];
    if (!preview) {
        preview = new window.ZephyrMediaPreview({
            path: filePath,
            index: mediaPreviewPanelsByPath.size,
            send: (payload) => {
                if (!wsConnection || wsConnection.readyState !== WebSocket.OPEN) {
                    showToast('SSH 尚未连接，无法预览媒体', 'error');
                    console.error('[SFTP-MEDIA]', 'websocket not open', { path: payload?.path, readyState: wsConnection?.readyState });
                    return;
                }
                console.info('[SFTP-MEDIA]', 'send preview request', payload);
                wsConnection.send(JSON.stringify(payload));
            },
            notify: showToast,
            bringToFront: bringPanelToFront,
            allocateZIndex: allocateFloatingPanelZIndex,
            layoutMenu: { open: openPanelLayoutMenu, close: closePanelLayoutMenu },
            formatSize: formatTransferSize,
            remoteSubtitlePicker: pickRemoteSubtitleForMedia,
            onFocus: (instance) => { activeMediaPreview = instance; },
            onClose: (instance) => {
                if (activeMediaPreview === instance) activeMediaPreview = null;
                if (instance?.currentPath) mediaPreviewPanelsByPath.delete(instance.currentPath);
                for (const [path, previewInstance] of mediaPreviewPanelsByPath.entries()) {
                    if (previewInstance === instance) mediaPreviewPanelsByPath.delete(path);
                }
            },
        });
        mediaPreviewPanelsByPath.set(filePath, preview);
    }
    activeMediaPreview = preview;
    preview.open(filePath);
}

function promptRemoteSubtitlePath(mediaPath = '') {
    const mediaDir = String(mediaPath || currentPath).replace(/\/[^/]*$/, '') || currentPath || '.';
    const mediaBase = String(mediaPath || '').split('/').pop()?.replace(/\.[^.]+$/, '') || '';
    const selected = getSelectedFiles().find((file) => file.type !== 'd' && /\.(vtt|srt|ass|ssa|sub)$/i.test(file.name || file.path || ''));
    const guess = selected?.path || (mediaBase ? `${mediaDir.replace(/\/+$/, '')}/${mediaBase}.srt` : mediaDir);
    return prompt(t('输入远程字幕路径（也可以先在文件列表选中字幕文件）:'), guess);
}

function readRemoteSubtitleFile(filePath) {
    return new Promise((resolve, reject) => {
        if (!filePath) { resolve(null); return; }
        if (!/\.(vtt|srt|ass|ssa|sub)$/i.test(filePath)) {
            reject(new Error(t('仅支持 .vtt/.srt/.ass/.ssa/.sub 字幕')));
            return;
        }
        if (!wsConnection || wsConnection.readyState !== WebSocket.OPEN) {
            reject(new Error(t('SSH 尚未连接，无法读取路径字幕')));
            return;
        }
        const requestId = `subtitle-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const timer = window.setTimeout(() => {
            pendingRemoteSubtitleReads.delete(requestId);
            reject(new Error(t('读取路径字幕超时')));
        }, 15000);
        pendingRemoteSubtitleReads.set(requestId, { resolve, reject, timer, path: filePath });
        wsConnection.send(JSON.stringify({ type: 'sftp-readfile', path: filePath, requestId, purpose: 'subtitle' }));
    });
}

async function pickRemoteSubtitleForMedia(mediaPath = '') {
    const filePath = promptRemoteSubtitlePath(mediaPath);
    if (!filePath) return null;
    return readRemoteSubtitleFile(filePath.trim());
}

function handleEditorSaveConflict(panel, msg = {}) {
    const p = panel || fmEditorModal;
    if (!p) {
        showToast('保存冲突：远端文件已修改', 'error');
        return;
    }
    const remoteMtime = Number(msg.mtimeMs) || 0;
    const body = p.querySelector('[data-editor-role="sidepanelBody"]');
    const title = p.querySelector('[data-editor-role="sidepanelTitle"]');
    const side = p.querySelector('[data-editor-role="sidepanel"]');
    if (title) title.textContent = t('保存冲突');
    if (body) {
        body.innerHTML = `
            <p style="margin:6px 8px 10px;font-size:12px;line-height:1.45;color:var(--text-secondary)">
              远端文件在打开后已被修改（mtime 冲突）。可覆盖远端，或重新加载丢弃本地未保存修改。
            </p>
            <button type="button" class="fm-editor-sidepanel-item" data-conflict-act="overwrite"><strong>${t('覆盖远端')}</strong><small>${t('用当前编辑器内容强制写入')}</small></button>
            <button type="button" class="fm-editor-sidepanel-item" data-conflict-act="reload"><strong>${t('重新加载远端')}</strong><small>${t('丢弃本地未保存修改')}</small></button>
            <button type="button" class="fm-editor-sidepanel-item" data-conflict-act="cancel"><strong>${t('取消')}</strong><small>${t('继续编辑，稍后再保存')}</small></button>
        `;
        body.querySelectorAll('[data-conflict-act]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const act = btn.dataset.conflictAct;
                if (act === 'overwrite') {
                    closeEditorSidepanel(p);
                    saveActiveEditor({ closeAfterSave: false, forceOverwrite: true });
                } else if (act === 'reload') {
                    closeEditorSidepanel(p);
                    const path = p.dataset.editorPath || editorFilePath;
                    const requestId = `${p.dataset.editorId || path}-reload-${Date.now()}`;
                    pendingEditorReads.set(requestId, p);
                    wsConnection.send(JSON.stringify({ type: 'sftp-readfile', path, requestId }));
                    if (fmEditorStatus) fmEditorStatus.textContent = t('重新加载中...');
                } else {
                    if (remoteMtime) p._editorMtimeMs = remoteMtime;
                    closeEditorSidepanel(p);
                }
            });
        });
    }
    side?.classList.add('open');
    showToast('保存冲突：远端文件已变更', 'error');
}

function closeEditorSidepanel(panel = fmEditorModal) {
    panel?.querySelector?.('[data-editor-role="sidepanel"]')?.classList.remove('open');
}

function showEditorSidepanel(panel, kind, items = [], meta = {}) {
    const p = panel || fmEditorModal;
    if (!p) return;
    const side = p.querySelector('[data-editor-role="sidepanel"]');
    const title = p.querySelector('[data-editor-role="sidepanelTitle"]');
    const body = p.querySelector('[data-editor-role="sidepanelBody"]');
    if (!side || !body) return;
    const label = kind === 'outline' ? t('大纲') : kind === 'problems' ? t('问题') : kind === 'search' ? t('搜索结果') : t('面板');
    if (title) title.textContent = label + (meta.query ? ` · ${meta.query}` : '');
    if (!items.length) {
        body.innerHTML = `<div class="empty-state" style="padding:12px;font-size:12px">${
            kind === 'search' ? t('无匹配') : kind === 'problems' ? t('暂无问题') : t('暂无符号')
        }${meta.filesScanned != null ? `<br><small>${t('已扫描 {count} 个文件', { count: meta.filesScanned })}</small>` : ''}</div>`;
    } else if (kind === 'problems') {
        body.innerHTML = items.map((d, i) => {
            const line = p._codeEditor?.view ? p._codeEditor.view.state.doc.lineAt(Math.min(p._codeEditor.view.state.doc.length, d.from || 0)).number : '?';
            return `<button type="button" class="fm-editor-sidepanel-item" data-goto-from="${Number(d.from) || 0}"><strong>${escapeHtml(d.severity || 'error')}</strong> L${line}<small>${escapeHtml(d.message || '')}</small></button>`;
        }).join('');
        body.querySelectorAll('[data-goto-from]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const from = Number(btn.dataset.gotoFrom) || 0;
                const view = getEditorInstance()?.view;
                if (!view) return;
                view.dispatch({ selection: { anchor: from }, effects: window.ZephyrCodeEditor ? undefined : undefined });
                try {
                    const { EditorView } = view.constructor;
                } catch {}
                window.ZephyrCodeEditor?.gotoLine?.(getEditorInstance(), view.state.doc.lineAt(from).number);
            });
        });
    } else if (kind === 'search') {
        body.innerHTML = items.map((m) => `<button type="button" class="fm-editor-sidepanel-item" data-open-path="${escapeHtml(m.path)}" data-open-line="${Number(m.line) || 1}"><strong>${escapeHtml(editorBaseName(m.path))}</strong> :${Number(m.line) || 1}<small>${escapeHtml(m.text || '')}</small></button>`).join('');
        body.querySelectorAll('[data-open-path]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const path = btn.dataset.openPath;
                const line = Number(btn.dataset.openLine) || 1;
                openEditor(path);
                window.setTimeout(() => window.ZephyrCodeEditor?.gotoLine?.(getEditorInstance(), line), 120);
            });
        });
    } else {
        // outline
        body.innerHTML = items.map((it) => `<button type="button" class="fm-editor-sidepanel-item" data-goto-line="${Number(it.line) || 1}"><strong>${escapeHtml(it.name || '')}</strong><small>L${Number(it.line) || 1}</small></button>`).join('');
        body.querySelectorAll('[data-goto-line]').forEach((btn) => {
            btn.addEventListener('click', () => window.ZephyrCodeEditor?.gotoLine?.(getEditorInstance(), Number(btn.dataset.gotoLine) || 1));
        });
    }
    side.classList.add('open');
}

function toggleWorkspaceSearchBar(panel, open) {
    const p = panel || fmEditorModal;
    const bar = p?.querySelector?.('[data-editor-role="workspaceSearch"]');
    if (!bar) return;
    bar.classList.toggle('open', open !== false ? (open === true ? true : !bar.classList.contains('open')) : false);
    if (bar.classList.contains('open')) bar.querySelector('input')?.focus?.();
}

function runWorkspaceSearch(panel) {
    const p = panel || fmEditorModal;
    const input = p?.querySelector?.('[data-editor-role="workspaceSearch"] input');
    const query = String(input?.value || '').trim();
    if (!query) return showToast('请输入搜索词', 'info');
    if (!wsConnection || wsConnection.readyState !== WebSocket.OPEN) return showToast('SFTP 未连接', 'error');
    // search root = directory of current file or FM path
    const filePath = p?.dataset?.editorPath || editorFilePath || '';
    let root = (typeof currentPath === 'string' && currentPath) ? currentPath : '.';
    if (filePath.includes('/')) root = filePath.replace(/\/[^/]*$/, '') || root || '/';
    const requestId = `ws-search-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    pendingWorkspaceSearches.set(requestId, p);
    showEditorSidepanel(p, 'search', [], { query });
    const body = p.querySelector('[data-editor-role="sidepanelBody"]');
    if (body) body.innerHTML = `<div class="empty-state" style="padding:12px;font-size:12px">${t('搜索中…')}</div>`;
    wsConnection.send(JSON.stringify({
        type: 'sftp-workspace-search',
        requestId,
        path: root || '.',
        query,
        maxFiles: 80,
        maxMatches: 60,
        maxDepth: 2,
    }));
}

function findEditorPanelByPath(filePath = '') {
    const path = String(filePath || '');
    if (!path) return null;
    for (const panel of editorPanelsByPath.values()) {
        if (panel?.dataset?.editorPath === path && panel.style.display !== 'none' && !panel.classList.contains('closing')) return panel;
    }
    return null;
}

function editorBaseName(filePath = '') {
    const parts = String(filePath || '').split(/[\\/]/);
    return parts[parts.length - 1] || filePath || 'untitled';
}

function renderEditorTabs(activePanel = fmEditorModal) {
    const host = activePanel?.querySelector?.('[data-editor-role="tabs"]') || document.getElementById('fmEditorTabs');
    if (!host) return;
    const open = [];
    for (const panel of editorPanelsByPath.values()) {
        if (!panel || panel.style.display === 'none' || panel.classList.contains('closing')) continue;
        open.push(panel);
    }
    // Always include active if missing from map briefly
    if (activePanel && !open.includes(activePanel) && activePanel.dataset?.editorPath) open.push(activePanel);
    host.innerHTML = open.map((panel) => {
        const path = panel.dataset.editorPath || '';
        const dirty = !!window.ZephyrCodeEditor?.dirty?.(panel._codeEditor);
        const active = panel === activePanel;
        return `<button type="button" class="fm-editor-tab${active ? ' active' : ''}${dirty ? ' dirty' : ''}" data-editor-tab-id="${escapeHtml(panel.dataset.editorId || '')}" title="${escapeHtml(path)}">${escapeHtml(editorBaseName(path))}</button>`;
    }).join('');
    host.querySelectorAll('[data-editor-tab-id]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const id = btn.dataset.editorTabId;
            const panel = editorPanelsByPath.get(id);
            if (!panel) return;
            updateActiveEditorRefs(panel);
            panel.style.display = 'flex';
            panel.classList.add('open');
            bringPanelToFront(panel);
            updateEditorZIndex(panel);
            renderEditorTabs(panel);
            window.ZephyrCodeEditor?.focus?.(panel._codeEditor);
        });
    });
}

function openEditor(filePath) {
    const existing = findEditorPanelByPath(filePath);
    if (existing) {
        updateActiveEditorRefs(existing);
        existing.style.display = 'flex';
        existing.classList.remove('closing');
        requestAnimationFrame(() => existing.classList.add('open'));
        updateEditorZIndex(existing);
        bringPanelToFront(existing);
        renderEditorTabs(existing);
        window.ZephyrCodeEditor?.focus?.(existing._codeEditor);
        return existing;
    }
    const panel = createEditorPanel(filePath);
    updateActiveEditorRefs(panel);
    editorFilePath = filePath;
    editorLanguage = detectEditorLanguage(filePath);
    panel._editorLanguage = editorLanguage;
    panel._editorMtimeMs = 0;
    panel.style.display = 'flex';
    panel.classList.remove('closing');
    requestAnimationFrame(() => panel.classList.add('open'));
    if (fmEditorTitle) fmEditorTitle.textContent = t('编辑: {path}', { path: filePath });
    if (fmEditorStatus) fmEditorStatus.textContent = t('读取中...');
    if (fmEditorMain) fmEditorMain.innerHTML = '';
    updateEditorZIndex(panel);
    bringPanelToFront(panel);
    renderEditorTabs(panel);
    const requestId = panel.dataset.editorId || `${filePath}#${Date.now()}-${Math.random().toString(36).slice(2)}`;
    pendingEditorReads.set(requestId, panel);
    wsConnection.send(JSON.stringify({ type: 'sftp-readfile', path: filePath, requestId }));
    return panel;
}

function saveActiveEditor({ closeAfterSave = true, forceClose = false, forceOverwrite = false } = {}) {
    if (!editorFilePath) return;
    const panel = fmEditorModal;
    const text = normalizeLineEnding(getEditorText(panel), fmEditorLineEnding?.value || 'lf');
    const bytes = encodeText(text, fmEditorEncoding?.value || 'utf-8');
    const expectedMtimeMs = forceOverwrite ? undefined : (panel?._codeEditor?.mtimeMs || panel?._editorMtimeMs || undefined);
    panel._pendingSave = { text, closeAfterSave, forceClose };
    wsConnection.send(JSON.stringify({
        type: 'sftp-writefile',
        editorId: panel?.dataset.editorId || '',
        path: editorFilePath,
        data: bytesToBase64(bytes),
        encoding: 'base64',
        expectedMtimeMs: expectedMtimeMs || undefined,
    }));
}

function closeEditorCommandPalette(panel = null) {
    const root = panel || document;
    root.querySelectorAll?.('[data-editor-role="commandPalette"].open').forEach((palette) => palette.classList.remove('open'));
    document.querySelectorAll('.fm-editor-palette-btn.active, [data-editor-action="palette"].active').forEach((btn) => {
        if (!panel || panel.contains(btn)) btn.classList.remove('active');
    });
}
function handleEditorCommandPaletteOutside(e) {
    const palette = e.target.closest?.('[data-editor-role="commandPalette"]');
    const paletteButton = e.target.closest?.('.fm-editor-palette-btn, [data-editor-action="palette"]');
    if (palette || paletteButton) return;
    closeEditorCommandPalette();
}
document.addEventListener('pointerdown', handleEditorCommandPaletteOutside, { capture: true });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeEditorCommandPalette(); });

fmEditorCloseBtn?.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); updateActiveEditorRefs(fmEditorCloseBtn.closest('.fm-editor-modal')); closeEditor(); });
fmEditorUndoBtn?.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); updateActiveEditorRefs(fmEditorUndoBtn.closest('.fm-editor-modal')); window.ZephyrCodeEditor?.undo?.(getEditorInstance()); });
fmEditorRedoBtn?.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); updateActiveEditorRefs(fmEditorRedoBtn.closest('.fm-editor-modal')); window.ZephyrCodeEditor?.redo?.(getEditorInstance()); });
fmEditorMinimapToggle?.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); updateActiveEditorRefs(fmEditorMinimapToggle.closest('.fm-editor-modal')); window.ZephyrCodeEditor?.toggleMinimap?.(getEditorInstance()); localStorage.setItem('zephyr-editor-minimap-hidden', getEditorInstance()?.minimap ? '0' : '1'); updateEditorStatus(); });
fmEditorCompactBtn?.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); updateActiveEditorRefs(fmEditorCompactBtn.closest('.fm-editor-modal')); window.ZephyrCodeEditor?.toggleCompact?.(getEditorInstance()); localStorage.setItem('zephyr-editor-compact', getEditorInstance()?.compact ? '1' : '0'); updateEditorStatus(); });
fmEditorPaletteBtn?.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); updateActiveEditorRefs(fmEditorPaletteBtn.closest('.fm-editor-modal')); const instance = getEditorInstance(); window.ZephyrCodeEditor?.openPalette?.(instance); fmEditorPaletteBtn?.classList.toggle('active', !!instance?.panel?.querySelector('[data-editor-role="commandPalette"]')?.classList.contains('open')); });
fmEditorAiBtn?.addEventListener('click', async (e) => { e.preventDefault(); e.stopPropagation(); updateActiveEditorRefs(fmEditorAiBtn.closest('.fm-editor-modal')); const ok = await window.ZephyrCodeEditor?.aiComplete?.(getEditorInstance()); if (ok) showToast('AI 补全已处理', 'success'); });
fmEditorSaveBtn?.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); updateActiveEditorRefs(fmEditorSaveBtn.closest('.fm-editor-modal')); saveActiveEditor({ closeAfterSave: false }); });
fmEditorEncoding?.addEventListener('change', () => { updateActiveEditorRefs(fmEditorEncoding.closest('.fm-editor-modal')); if (editorRawBytes) loadEditorFromBytes(editorRawBytes, fmEditorEncoding.value); });
fmEditorLineEnding?.addEventListener('change', () => { updateActiveEditorRefs(fmEditorLineEnding.closest('.fm-editor-modal')); updateEditorStatus(); });
fmEditorTabSize?.addEventListener('change', () => { updateActiveEditorRefs(fmEditorTabSize.closest('.fm-editor-modal')); applyEditorOptions(); });
fmEditorWrap?.addEventListener('change', () => { updateActiveEditorRefs(fmEditorWrap.closest('.fm-editor-modal')); applyEditorOptions(); });

document.getElementById('fmEditorFormatBtn')?.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    updateActiveEditorRefs(e.currentTarget.closest('.fm-editor-modal'));
    const ok = await window.ZephyrCodeEditor?.format?.(getEditorInstance());
    if (ok) showToast('格式化完成', 'success');
});

function setupClonedEditorEvents(panel) {
    if (!panel || panel._clonedEditorEventsReady) return;
    panel._clonedEditorEventsReady = true;
    panel.addEventListener('click', async (e) => {
        const actionEl = e.target.closest('[data-editor-action]');
        if (!actionEl || !panel.contains(actionEl)) return;
        const action = actionEl.dataset.editorAction;
        if (!action) return;
        e.preventDefault();
        e.stopPropagation();
        updateActiveEditorRefs(panel);
        bringPanelToFront(panel);
        if (action === 'close') closeEditor();
        else if (action === 'minimap') { window.ZephyrCodeEditor?.toggleMinimap?.(getEditorInstance()); localStorage.setItem('zephyr-editor-minimap-hidden', getEditorInstance()?.minimap ? '0' : '1'); updateEditorStatus(); }
        else if (action === 'compact') { window.ZephyrCodeEditor?.toggleCompact?.(getEditorInstance()); localStorage.setItem('zephyr-editor-compact', getEditorInstance()?.compact ? '1' : '0'); updateEditorStatus(); }
        else if (action === 'palette') { const instance = getEditorInstance(); window.ZephyrCodeEditor?.openPalette?.(instance); actionEl.classList.toggle('active', !!instance?.panel?.querySelector('[data-editor-role="commandPalette"]')?.classList.contains('open')); }
        else if (action === 'ai' || action === 'ai-complete') { const ok = await window.ZephyrCodeEditor?.aiComplete?.(getEditorInstance()); if (ok) showToast('AI 补全已处理', 'success'); }
        else if (action === 'undo') window.ZephyrCodeEditor?.undo?.(getEditorInstance());
        else if (action === 'redo') window.ZephyrCodeEditor?.redo?.(getEditorInstance());
        else if (action === 'save') saveActiveEditor({ closeAfterSave: false });
        else if (action === 'format') {
            const ok = await window.ZephyrCodeEditor?.format?.(getEditorInstance());
            if (ok) showToast('格式化完成', 'success');
        } else if (action === 'outline') {
            const items = window.ZephyrCodeEditor?.getOutline?.(getEditorInstance()) || [];
            showEditorSidepanel(panel, 'outline', items);
        } else if (action === 'problems') {
            showEditorSidepanel(panel, 'problems', panel._diagnostics || getEditorInstance()?._diagnostics || []);
        } else if (action === 'sidepanel-close') {
            closeEditorSidepanel(panel);
        } else if (action === 'workspace-search') {
            toggleWorkspaceSearchBar(panel, true);
        } else if (action === 'workspace-search-close') {
            toggleWorkspaceSearchBar(panel, false);
        } else if (action === 'workspace-search-run') {
            runWorkspaceSearch(panel);
        }
    });
    panel.querySelector('[data-editor-role="workspaceSearch"] input')?.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
            ev.preventDefault();
            updateActiveEditorRefs(panel);
            runWorkspaceSearch(panel);
        }
    });
    panel.addEventListener('change', (e) => {
        updateActiveEditorRefs(panel);
        if (e.target.matches('[data-editor-field="encoding"]')) {
            if (editorRawBytes) loadEditorFromBytes(editorRawBytes, fmEditorEncoding.value);
        } else if (e.target.matches('[data-editor-field="lineEnding"]')) updateEditorStatus();
        else if (e.target.matches('[data-editor-field="tabSize"], [data-editor-field="wrap"]')) applyEditorOptions();
    });
}

if (window.ResizeObserver && fmEditorMain) {
    const editorResizeObserver = new ResizeObserver(() => refreshCodeMirrorLayout());
    editorResizeObserver.observe(fmEditorMain);
}

// ---------- SFTP 消息处理 ----------
function handleSFTPMessage(msg) {
    switch (msg.type) {
        case 'sftp-ready': sftpReady = true; refreshAllOpenFileManagers(); flushPendingUploads(); break;
        case 'sftp-list':
            if (handleExtraFileManagerListMessage(msg)) break;
            if (msg.error) alert(`${t('列出目录失败:')} ${msg.error}`);
            else { selectedFilePaths.clear(); renderFileList(msg.files); currentPath = msg.path; fmPathInput.value = currentPath; updateMobileFileActions(); }
            break;
        case 'sftp-mkdir': case 'sftp-touch': case 'sftp-delete': case 'sftp-rename': case 'sftp-upload': case 'sftp-chmod':
            if (msg.success) { refreshAllOpenFileManagers(); if (msg.type === 'sftp-upload') showToast('文件上传完成', 'success'); if (msg.type === 'sftp-chmod') { hideFilePropertiesModal(); showToast('权限已修改', 'success'); } }
            else showToast('操作失败: ' + (msg.error || t('未知错误')), 'error');
            break;
        case 'sftp-upload-ready': {
            const upload = activeSftpUploads.get(msg.uploadId);
            if (upload) {
                upload.url = msg.url || '';
                markUploadProgress(msg.uploadId, { status: 'active', loaded: 0, size: upload.file?.size || upload.size || 0 });
                sendSftpUploadChunk(upload, 0);
            }
            break;
        }
        case 'sftp-upload-progress': {
            const upload = activeSftpUploads.get(msg.uploadId);
            if (upload) markUploadProgress(msg.uploadId, { status: 'active', loaded: Number(msg.nextOffset) || 0, size: Number(msg.size) || upload.size || 0 });
            break;
        }
        case 'sftp-upload-complete': {
            const upload = activeSftpUploads.get(msg.uploadId);
            if (upload) markUploadProgress(msg.uploadId, { status: 'done', loaded: upload.size || upload.file?.size || 0 });
            window.setTimeout(() => { activeSftpUploads.delete(msg.uploadId); scheduleTransferRender(); }, 5000);
            refreshAllOpenFileManagers();
            showToast('文件上传完成', 'success');
            break;
        }
        case 'sftp-upload-error':
            markUploadProgress(msg.uploadId, { status: 'error' });
            window.setTimeout(() => { activeSftpUploads.delete(msg.uploadId); scheduleTransferRender(); }, 8000);
            showToast('上传失败: ' + (msg.error || t('未知错误')), 'error');
            break;
        case 'sftp-transfer-progress': {
            const id = msg.transferId || msg.downloadId || msg.uploadId;
            if (!id) break;
            if (msg.direction === 'download') {
                markDownloadProgress(id, { path: msg.path, size: Number(msg.size) || 0, loaded: Number(msg.loaded) || 0, status: msg.status || 'active' });
                if (msg.status === 'done' || msg.status === 'error') window.setTimeout(() => { activeSftpDownloads.delete(id); scheduleTransferRender(); }, msg.status === 'done' ? 5000 : 8000);
            } else if (msg.direction === 'copy' || msg.direction === 'move') {
                const existing = activeSftpDownloads.get(id);
                if (existing?.cancelled || existing?.status === 'cancelling') {
                    if (msg.status === 'error') markDownloadProgress(id, { status: 'error', cancelled: true });
                    break;
                }
                const label = msg.direction === 'move' ? t('移动') : t('复制');
                markDownloadProgress(id, { name: `${label}: ${(msg.path || '').split('/').pop() || t('文件')}`, path: msg.path, direction: msg.direction, size: Number(msg.size) || 0, loaded: Number(msg.loaded) || 0, status: msg.status || 'active', cancellable: msg.cancellable !== false });
                if (msg.status === 'done' || msg.status === 'error') window.setTimeout(() => { activeSftpDownloads.delete(id); scheduleTransferRender(); }, msg.status === 'done' ? 5000 : 8000);
            } else if (msg.direction === 'archive') {
                const label = msg.phase === 'upload' ? t('传回远端') : msg.phase === 'download' ? t('拉取到主端') : msg.phase === 'extract' ? t('主端解压') : msg.phase === 'compress' ? t('主端压缩') : t('归档处理');
                markDownloadProgress(id, { name: `${label}: ${(msg.path || '').split('/').pop() || t('压缩包')}`, path: msg.path, direction: 'archive', phase: msg.phase || '', size: Number(msg.size) || 0, loaded: Number(msg.loaded) || 0, status: msg.status || 'active', cancellable: msg.cancellable !== false });
                if (msg.status === 'done' || msg.status === 'error') window.setTimeout(() => { activeSftpDownloads.delete(id); scheduleTransferRender(); }, msg.status === 'done' ? 5000 : 8000);
            } else if (msg.direction === 'upload') {
                markUploadProgress(id, { path: msg.path, size: Number(msg.size) || 0, loaded: Number(msg.loaded) || 0, status: msg.status || 'active' });
                if (msg.status === 'done' || msg.status === 'error') window.setTimeout(() => { activeSftpUploads.delete(id); scheduleTransferRender(); }, msg.status === 'done' ? 5000 : 8000);
            }
            break;
        }
        case 'sftp-download':
            if (msg.downloadId) markDownloadProgress(msg.downloadId, { status: 'error' });
            if (msg.error) alert(`${t('下载失败:')} ${msg.error}`);
            break;
        case 'sftp-download-ready': {
            if (msg.error) {
                alert(`${t('下载失败:')} ${msg.error}`);
                break;
            }
            if (!msg.url) {
                alert(t('下载失败: 缺少下载地址'));
                break;
            }
            const downloadId = msg.downloadId || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
            const existing = activeSftpDownloads.get(downloadId) || {};
            const download = {
                ...existing,
                id: downloadId,
                downloadId,
                path: msg.path,
                name: msg.name || (msg.path || 'download').split('/').pop() || 'download',
                size: Number(msg.size) || 0,
                loaded: Number(existing.loaded) || 0,
                status: 'active',
                url: msg.url,
                progressUrl: msg.progressUrl || '',
                controlUrl: msg.controlUrl || '',
                updatedAt: Date.now(),
                speed: Number(existing.speed) || 0,
            };
            activeSftpDownloads.set(downloadId, download);
            showTransferPopover({ autoHide: true });
            showToast('已开始下载，进度可在传输面板查看', 'success');
            startChunkedDownload(download);
            break;
        }
        case 'sftp-clipboard-set':
            if (msg.success) {
                const mode = msg.mode === 'cut' ? t('剪切') : t('复制');
                const count = msg.count || 0;
                sftpClipboardAvailable = true;
                updateMobileFileActions();
                showToast(`${mode} ${count} 项，可到任意 SSH 文件管理器或 RDP 远程桌面粘贴`, 'success');
                notifyParentSftpClipboardSet(msg.mode, count);
            } else {
                sftpClipboardAvailable = false;
                updateMobileFileActions();
                alert(`${t('剪贴板操作失败:')} ${msg.error || t('未知错误')}`);
            }
            break;
        case 'sftp-properties': {
            const pending = pendingSftpProperties.get(msg.requestId);
            if (pending) pendingSftpProperties.delete(msg.requestId);
            if (msg.success && pending) renderFilePropertiesModal(pending.selected, msg);
            else if (!msg.success) showToast('统计属性失败: ' + (msg.error || t('未知错误')), 'error');
            break;
        }
        case 'sftp-clipboard-conflicts': {
            const handler = pendingSftpConflictChecks.get(msg.requestId);
            if (handler) {
                pendingSftpConflictChecks.delete(msg.requestId);
                handler(msg);
            }
            break;
        }
        case 'sftp-clipboard-paste':
            if (msg.success) { showToast('粘贴完成', 'success'); refreshAllOpenFileManagers(); }
            else alert(`${t('粘贴失败:')} ${msg.error || t('未知错误')}`);
            break;
        case 'sftp-compress':
            if (msg.transferId) {
                const current = activeSftpDownloads.get(msg.transferId) || {};
                const finalSize = Number(msg.size) || Number(current.size) || 0;
                markDownloadProgress(msg.transferId, { status: msg.success ? 'done' : 'error', loaded: finalSize || current.loaded || 0, size: finalSize, cancelled: !!msg.cancelled || !!current.cancelled });
                window.setTimeout(() => { activeSftpDownloads.delete(msg.transferId); scheduleTransferRender(); }, msg.success ? 5000 : 8000);
            }
            if (msg.success) { showToast('压缩完成', 'success'); refreshAllOpenFileManagers(); }
            else if (msg.cancelled) showToast('压缩已取消', 'info');
            else alert(`${t('压缩失败:')} ${msg.error || t('未知错误')}`);
            break;
        case 'sftp-extract':
            if (msg.transferId) {
                const current = activeSftpDownloads.get(msg.transferId) || {};
                const finalSize = Number(msg.size) || Number(current.size) || 0;
                markDownloadProgress(msg.transferId, { status: msg.success ? 'done' : 'error', loaded: finalSize || current.loaded || 0, size: finalSize, cancelled: !!msg.cancelled || !!current.cancelled });
                window.setTimeout(() => { activeSftpDownloads.delete(msg.transferId); scheduleTransferRender(); }, msg.success ? 5000 : 8000);
            }
            if (msg.success) { showToast('解压完成', 'success'); refreshAllOpenFileManagers(); }
            else if (msg.cancelled) showToast('解压已取消', 'info');
            else alert(`${t('解压失败:')} ${msg.error || t('未知错误')}`);
            break;
        case 'sftp-readfile': {
            const pendingSubtitle = msg.requestId ? pendingRemoteSubtitleReads.get(msg.requestId) : null;
            if (pendingSubtitle) {
                pendingRemoteSubtitleReads.delete(msg.requestId);
                window.clearTimeout(pendingSubtitle.timer);
                if (msg.error) pendingSubtitle.reject(new Error(msg.error));
                else {
                    const bytes = msg.encoding === 'base64' ? base64ToBytes(msg.data) : new TextEncoder().encode(msg.data || '');
                    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
                    pendingSubtitle.resolve({ path: msg.path || pendingSubtitle.path, name: String(msg.path || pendingSubtitle.path || '').split('/').pop() || t('路径字幕'), text });
                }
                break;
            }
            const panel = pendingEditorReads.get(msg.requestId) || (msg.editorId ? editorPanelsByPath.get(msg.editorId) : null) || Array.from(editorPanelsByPath.values()).reverse().find((p) => p.dataset.editorPath === msg.path);
            if (msg.requestId) pendingEditorReads.delete(msg.requestId);
            if (panel) updateActiveEditorRefs(panel);
            if (msg.error) {
                showToast('读取失败: ' + msg.error, 'error');
                if (fmEditorStatus) fmEditorStatus.textContent = t('读取失败');
            } else {
                const bytes = msg.encoding === 'base64' ? base64ToBytes(msg.data) : new TextEncoder().encode(msg.data || '');
                if (panel) {
                    panel._editorMtimeMs = Number(msg.mtimeMs) || 0;
                    panel._editorSize = Number(msg.size) || bytes.length || 0;
                }
                if (fmEditorEncoding) fmEditorEncoding.value = detectEncoding(bytes);
                loadEditorFromBytes(bytes, fmEditorEncoding?.value || 'utf-8');
                renderEditorTabs(panel || fmEditorModal);
            }
            break;
        }
        case 'sftp-writefile': {
            const panel = msg.editorId ? editorPanelsByPath.get(msg.editorId) : Array.from(editorPanelsByPath.values()).reverse().find((p) => p.dataset.editorPath === msg.path);
            if (panel) updateActiveEditorRefs(panel);
            if (msg.success) {
                const pending = panel?._pendingSave;
                if (panel?._codeEditor) {
                    window.ZephyrCodeEditor?.markSaved?.(panel._codeEditor, {
                        text: pending?.text,
                        mtimeMs: Number(msg.mtimeMs) || Date.now(),
                        size: Number(msg.size) || undefined,
                    });
                    panel._editorMtimeMs = Number(msg.mtimeMs) || panel._editorMtimeMs || 0;
                }
                if (panel) panel._pendingSave = null;
                refreshAllOpenFileManagers();
                showToast('已保存', 'success');
                renderEditorTabs(panel || fmEditorModal);
                if (pending?.closeAfterSave) closeEditor({ force: !!pending.forceClose });
            } else if (msg.conflict || msg.code === 'mtime_conflict') {
                handleEditorSaveConflict(panel, msg);
            } else {
                showToast('保存失败: ' + (msg.error || t('未知错误')), 'error');
            }
            break;
        }
        case 'sftp-workspace-search': {
            const panel = msg.requestId ? pendingWorkspaceSearches.get(msg.requestId) : null;
            if (msg.requestId) pendingWorkspaceSearches.delete(msg.requestId);
            const host = panel || fmEditorModal;
            if (msg.error) {
                showToast('目录搜索失败: ' + msg.error, 'error');
                break;
            }
            showEditorSidepanel(host, 'search', msg.matches || [], { query: msg.query, filesScanned: msg.filesScanned });
            break;
        }
        case 'sftp-error': alert(`${t('SFTP 错误:')} ${msg.message}`); sftpReady = false; break;
    }
}

// ---------- Docker 管理面板 ----------
function setDockerStatus(message, loading = false, type = 'info') {
    if (!dockerStatus) return;
    dockerStatus.textContent = message;
    dockerStatus.classList.toggle('loading', loading);
    dockerStatus.dataset.type = type;
}

function dockerSend(payload) {
    return sendJsonMessage(payload);
}

function dockerRefreshAll() {
    if (!dockerInstalled) return;
    dockerSend({ type: 'docker-list-containers' });
    dockerSend({ type: 'docker-list-images' });
    dockerSend({ type: 'docker-mirrors-get' });
}

function checkDockerStatus({ force = false } = {}) {
    if (!force && dockerChecked) {
        if (dockerInstalled) dockerRefreshAll();
        return;
    }
    setDockerStatus(t('正在检测 Docker...'), true);
    dockerInstallHint.style.display = 'none';
    dockerContent.style.display = 'none';
    dockerSend({ type: 'docker-check' });
}

function showDockerPanel() {
    if (!wsConnection || wsConnection.readyState !== WebSocket.OPEN || !isConnected) {
        showToast('请先连接 SSH', 'error');
        return;
    }
    ensureFloatingPanel(dockerPanel, getDefaultPanelOptions(dockerPanel));
    dockerPanel.style.display = 'flex';
    requestAnimationFrame(() => {
        dockerPanel.classList.add('open');
        dockerBtn.classList.add('active');
        bringPanelToFront(dockerPanel);
        animatePanelFromButton(dockerPanel, dockerBtn, true);
    });
    checkDockerStatus();
}

function hideDockerPanel() {
    if (typeof closePanelLayoutMenu === 'function') closePanelLayoutMenu({ instant: true });
    animatePanelFromButton(dockerPanel, dockerBtn, false);
    dockerPanel.classList.remove('open');
    dockerBtn.classList.remove('active');
    window.setTimeout(() => {
        clearPanelMotion(dockerPanel);
        if (!dockerPanel.classList.contains('open')) dockerPanel.style.display = 'none';
    }, 320);
}

function normalizeContainer(row = {}) {
    return {
        id: row.ID || row.IDs || row.ContainerID || '',
        name: row.Names || row.Name || row.names || 'N/A',
        image: row.Image || 'N/A',
        status: row.Status || row.State || 'N/A',
        ports: row.Ports || '—',
        created: row.CreatedAt || row.Created || 'N/A',
    };
}

function normalizeImage(row = {}) {
    return {
        id: row.ID || row.ImageID || '',
        repository: row.Repository || 'N/A',
        tag: row.Tag || 'N/A',
        size: row.Size || 'N/A',
        created: row.CreatedAt || row.CreatedSince || row.Created || 'N/A',
    };
}

function shortId(id = '') {
    return String(id).replace(/^sha256:/, '').slice(0, 12) || '';
}

function renderDockerContainers(containers = []) {
    if (!dockerContainersBody) return;
    dockerContainersBody.innerHTML = '';
    if (!containers.length) {
        dockerContainersBody.innerHTML = `<tr><td colspan="6">${t('暂无容器')}</td></tr>`;
        return;
    }
    containers.map(normalizeContainer).forEach((container) => {
        const tr = document.createElement('tr');
        const target = container.id || container.name;
        const running = /up|running/i.test(container.status);
        tr.innerHTML = `
            <td title="${escapeHtml(container.id)}">${escapeHtml(container.name)}<div class="docker-sub-id">${escapeHtml(shortId(container.id))}</div></td>
            <td>${escapeHtml(container.image)}</td>
            <td><span class="docker-badge ${running ? 'running' : 'stopped'}">${escapeHtml(container.status)}</span></td>
            <td>${escapeHtml(container.ports || '—')}</td>
            <td>${escapeHtml(container.created)}</td>
            <td><div class="docker-actions"></div></td>
        `;
        const actions = tr.querySelector('.docker-actions');
        const actionButtons = [
            ['start', t('启动')],
            ['stop', t('停止')],
            ['restart', t('重启')],
            ['logs', t('日志')],
            ['remove', t('删除')],
        ];
        actionButtons.forEach(([action, label]) => {
            const btn = document.createElement('button');
            btn.className = `tool-btn docker-action-btn ${action === 'remove' ? 'danger-text' : ''}`;
            btn.innerHTML = `${dockerActionGlyph(action, label)}<span>${escapeHtml(label)}</span>`;
            btn.disabled = (action === 'start' && running) || (action === 'stop' && !running);
            btn.addEventListener('click', () => {
                if (action === 'logs') return openDockerLogs(target, container.name);
                if (action === 'remove' && !confirm(t('确认删除容器 {name}?', { name: container.name }))) return;
                setDockerStatus(t('正在执行容器{action}操作...', { action: label }), true);
                dockerSend({ type: 'docker-container-action', action, id: target });
            });
            actions.appendChild(btn);
        });
        dockerContainersBody.appendChild(tr);
    });
}

function renderDockerImages(images = []) {
    if (!dockerImagesBody) return;
    dockerImagesBody.innerHTML = '';
    if (!images.length) {
        dockerImagesBody.innerHTML = `<tr><td colspan="5">${t('暂无镜像')}</td></tr>`;
        return;
    }
    images.map(normalizeImage).forEach((image) => {
        const imageRef = image.repository !== '<none>' && image.tag !== '<none>' ? `${image.repository}:${image.tag}` : image.id;
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td title="${escapeHtml(image.id)}">${escapeHtml(image.repository)}<div class="docker-sub-id">${escapeHtml(shortId(image.id))}</div></td>
            <td>${escapeHtml(image.tag)}</td>
            <td>${escapeHtml(image.size)}</td>
            <td>${escapeHtml(image.created)}</td>
            <td><div class="docker-actions"></div></td>
        `;
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'tool-btn docker-action-btn danger-text';
        deleteBtn.innerHTML = `${dockerActionGlyph('remove', t('删除'))}<span>${t('删除')}</span>`;
        deleteBtn.addEventListener('click', () => {
            if (!confirm(t('确认删除镜像 {image}?', { image: imageRef }))) return;
            setDockerStatus(t('正在检查镜像使用情况...'), true);
            dockerSend({ type: 'docker-delete-image', image: imageRef, id: image.id });
        });
        tr.querySelector('.docker-actions').appendChild(deleteBtn);
        dockerImagesBody.appendChild(tr);
    });
}

function renderDockerMirrors() {
    if (!dockerMirrorList) return;
    dockerMirrorList.innerHTML = '';
    if (!dockerMirrors.length) {
        const empty = document.createElement('div');
        empty.className = 'docker-empty-row';
        empty.textContent = t('尚未配置镜像加速器');
        dockerMirrorList.appendChild(empty);
        return;
    }
    dockerMirrors.forEach((mirror, index) => {
        const row = document.createElement('div');
        row.className = 'docker-mirror-item';
        const input = document.createElement('input');
        input.value = mirror;
        input.addEventListener('input', () => { dockerMirrors[index] = input.value.trim(); });
        const del = document.createElement('button');
        del.className = 'tool-btn danger-text';
        del.textContent = t('删除');
        del.addEventListener('click', () => {
            dockerMirrors.splice(index, 1);
            renderDockerMirrors();
        });
        row.append(input, del);
        dockerMirrorList.appendChild(row);
    });
}

function openDockerLogs(containerId, name) {
    if (!containerId) return;
    if (dockerCurrentLogContainer) dockerSend({ type: 'docker-logs-stop', id: dockerCurrentLogContainer });
    dockerCurrentLogContainer = containerId;
    dockerLogBuffer = '';
    dockerAutoScrollLog = true;
    dockerContainerLog.textContent = '';
    dockerLogTitle.textContent = t('容器日志 · {name}', { name: name || shortId(containerId) });
    dockerLogPauseBtn.textContent = t('暂停滚动');
    dockerLogDrawer.style.display = 'flex';
    dockerSend({ type: 'docker-logs-start', id: containerId });
}

function appendDockerLog(data = '') {
    dockerLogBuffer += data;
    dockerContainerLog.textContent += data;
    if (dockerAutoScrollLog) dockerContainerLog.scrollTop = dockerContainerLog.scrollHeight;
}

function closeDockerLogs() {
    if (dockerCurrentLogContainer) dockerSend({ type: 'docker-logs-stop', id: dockerCurrentLogContainer });
    dockerCurrentLogContainer = null;
    dockerLogDrawer.style.display = 'none';
}

function handleDockerMessage(msg) {
    switch (msg.type) {
        case 'docker-status':
            dockerChecked = true;
            dockerInstalled = !!msg.installed;
            if (!dockerInstalled) {
                setDockerStatus(t('未检测到 Docker，请先安装 Docker'), false, 'warning');
                dockerInstallHint.style.display = 'flex';
                dockerContent.style.display = 'none';
            } else {
                setDockerStatus(msg.version || t('Docker 已安装，正在加载资源...'), true, 'success');
                dockerInstallHint.style.display = 'none';
                dockerContent.style.display = 'flex';
                dockerRefreshAll();
            }
            break;
        case 'docker-containers':
            if (msg.error) { setDockerStatus(t('容器列表加载失败：{error}', { error: msg.error }), false, 'error'); return; }
            renderDockerContainers(msg.containers || []);
            setDockerStatus(t('容器列表已更新'), false, 'success');
            break;
        case 'docker-images':
            if (msg.error) { setDockerStatus(t('镜像列表加载失败：{error}', { error: msg.error }), false, 'error'); return; }
            renderDockerImages(msg.images || []);
            break;
        case 'docker-action':
            showToast('Docker 容器操作完成', 'success');
            dockerRefreshAll();
            break;
        case 'docker-image-delete':
            if (msg.requiresForce) {
                const ok = confirm(t('该镜像正在被以下容器使用：\n{containers}\n\n是否强制删除？', { containers: msg.usedBy }));
                if (ok) dockerSend({ type: 'docker-delete-image', image: msg.image, force: true });
                else setDockerStatus(t('已取消删除镜像'), false);
                return;
            }
            if (msg.success) { showToast('镜像已删除', 'success'); dockerRefreshAll(); }
            else showToast(`镜像删除失败：${msg.error || t('未知错误')}`, 'error');
            break;
        case 'docker-pull-start':
            dockerPullBtn.disabled = true;
            dockerPullLog.textContent = t('开始拉取 {image}...\n', { image: msg.image });
            setDockerStatus(t('正在拉取镜像...'), true);
            break;
        case 'docker-pull-log':
            dockerPullLog.textContent += msg.data || '';
            dockerPullLog.scrollTop = dockerPullLog.scrollHeight;
            break;
        case 'docker-pull-complete':
            dockerPullBtn.disabled = false;
            setDockerStatus(msg.success ? t('镜像拉取完成') : `镜像拉取失败（code=${msg.code ?? 'N/A'}）`, false, msg.success ? 'success' : 'error');
            showToast(msg.success ? t('镜像拉取完成') : t('镜像拉取失败'), msg.success ? 'success' : 'error');
            dockerRefreshAll();
            break;
        case 'docker-mirrors':
            dockerMirrors = Array.isArray(msg.mirrors) ? msg.mirrors : [];
            renderDockerMirrors();
            break;
        case 'docker-mirrors-save':
            showToast('镜像加速器配置已保存，请重启 Docker 服务', 'success', 4200);
            dockerMirrors = Array.isArray(msg.mirrors) ? msg.mirrors : dockerMirrors;
            renderDockerMirrors();
            setDockerStatus(t('配置已保存，请重启 Docker 服务'), false, 'success');
            break;
        case 'docker-service-restart':
            setDockerStatus(t('Docker 服务已重启，正在刷新资源...'), true, 'success');
            showToast('Docker 服务已重启', 'success');
            window.setTimeout(() => checkDockerStatus({ force: true }), 1200);
            break;
        case 'docker-log-start':
            appendDockerLog('--- 日志流已连接 ---\n');
            break;
        case 'docker-log-data':
            appendDockerLog(msg.data || '');
            break;
        case 'docker-log-end':
            if (msg.container === dockerCurrentLogContainer) appendDockerLog('\n--- 日志流已结束 ---\n');
            break;
        case 'docker-log-error':
        case 'docker-error':
            setDockerStatus(msg.message || msg.error || t('Docker 操作失败'), false, 'error');
            showToast(msg.message || msg.error || t('Docker 操作失败'), 'error');
            dockerPullBtn.disabled = false;
            break;
    }
}

function resetFeatureStateAfterReconnect() {
    sftpReady = false;
    dockerChecked = false;
    dockerInstalled = false;
    dockerCurrentLogContainer = null;
    dockerLogBuffer = '';
    dockerAutoScrollLog = true;
    if (dockerLogDrawer) dockerLogDrawer.style.display = 'none';
    if (dockerPullBtn) dockerPullBtn.disabled = false;
    if (dockerPanel?.classList.contains('open')) checkDockerStatus({ force: true });
    if (fileManager?.classList.contains('open')) initSFTP();
}

dockerBtn?.addEventListener('click', () => {
    if (dockerPanel.classList.contains('open')) {
        bringPanelToFront(dockerPanel);
        return;
    }
    showDockerPanel();
});
dockerCloseBtn?.addEventListener('click', hideDockerPanel);
dockerRefreshBtn?.addEventListener('click', () => checkDockerStatus({ force: true }));
dockerRestartBtn?.addEventListener('click', () => {
    if (!confirm(t('确认重启目标主机 Docker 服务？运行中的容器通常会继续运行，但 Docker API 会短暂不可用。'))) return;
    setDockerStatus(t('正在重启 Docker 服务...'), true);
    dockerSend({ type: 'docker-restart-service' });
});
document.querySelectorAll('[data-docker-tab]').forEach((tab) => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('[data-docker-tab]').forEach((item) => item.classList.toggle('active', item === tab));
        document.querySelectorAll('.docker-tab-panel').forEach((panel) => panel.classList.remove('active'));
        const target = document.getElementById(`docker${tab.dataset.dockerTab[0].toUpperCase()}${tab.dataset.dockerTab.slice(1)}Panel`);
        target?.classList.add('active');
    });
});
dockerPullBtn?.addEventListener('click', () => {
    const image = dockerPullInput.value.trim();
    if (!image) { showToast('请输入镜像名，例如 nginx:alpine', 'error'); return; }
    dockerSend({ type: 'docker-pull-image', image });
});
dockerPullInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') dockerPullBtn.click(); });
dockerMirrorAddBtn?.addEventListener('click', () => {
    const value = dockerMirrorInput.value.trim();
    if (!value) return;
    dockerMirrors.push(value);
    dockerMirrorInput.value = '';
    renderDockerMirrors();
});
dockerMirrorSaveBtn?.addEventListener('click', () => {
    dockerMirrors = dockerMirrors.map((item) => item.trim()).filter(Boolean);
    setDockerStatus(t('正在保存镜像加速器配置...'), true);
    dockerSend({ type: 'docker-mirrors-set', mirrors: dockerMirrors });
});
dockerLogCloseBtn?.addEventListener('click', closeDockerLogs);
dockerLogPauseBtn?.addEventListener('click', () => {
    dockerAutoScrollLog = !dockerAutoScrollLog;
    dockerLogPauseBtn.textContent = dockerAutoScrollLog ? t('暂停滚动') : t('继续滚动');
    if (dockerAutoScrollLog) dockerContainerLog.scrollTop = dockerContainerLog.scrollHeight;
});
dockerContainerLog?.addEventListener('scroll', () => {
    const atBottom = dockerContainerLog.scrollHeight - dockerContainerLog.scrollTop - dockerContainerLog.clientHeight < 24;
    if (!atBottom) {
        dockerAutoScrollLog = false;
        dockerLogPauseBtn.textContent = t('继续滚动');
    }
}, { passive: true });
dockerLogDownloadBtn?.addEventListener('click', () => {
    const blob = new Blob([dockerLogBuffer || dockerContainerLog.textContent], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(dockerLogTitle.textContent || 'container').replace(/[^\w.-]+/g, '_')}.log`;
    a.click();
    URL.revokeObjectURL(url);
});

// ---------- 监控面板 ----------
function safeVal(val, fallback = 0) {
    return (val != null && !isNaN(val)) ? val : fallback;
}

function destroyCharts() {
    Object.values(chartInstances).forEach(chart => {
        try { chart.destroy(); } catch (_) {}
    });
    chartInstances = {};
}

// 自定义插件：环形图中心显示百分比
const centerTextPlugin = {
    id: 'centerText',
    afterDraw(chart) {
        const { ctx, chartArea, config: { type } } = chart;
        if (type !== 'doughnut' || !chartArea) return;
        const { left, top, right, bottom } = chartArea;
        if ([left, top, right, bottom].some((v) => typeof v !== 'number' || isNaN(v))) return;
        const centerX = (left + right) / 2;
        const centerY = (top + bottom) / 2 + (bottom - top) * 0.05;
        const value = chart.data.datasets[0].data[0] || 0;
        ctx.save();
        const textColor = getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#f4f4f6';
        ctx.font = 'bold 18px "JetBrains Mono", "Fira Code", monospace';
        ctx.fillStyle = textColor;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${Math.round(value)}%`, centerX, centerY);
        ctx.restore();
    }
};

function initCharts() {
    destroyCharts();

    const commonDoughnut = {
        type: 'doughnut',
        data: { datasets: [{ data: [0, 100], backgroundColor: ['#3fb950', 'rgba(139,148,158,0.25)'], borderWidth: 0 }] },
        options: {
            circumference: 270,
            rotation: 225,
            cutout: '80%',
            responsive: true,
            maintainAspectRatio: true,
            animation: { duration: 0 },
            plugins: { legend: { display: false }, tooltip: { enabled: false } }
        },
        plugins: [centerTextPlugin]
    };

    const commonLine = {
        type: 'line',
        data: { labels: Array(20).fill(''), datasets: [{ data: Array(20).fill(0), borderWidth: 1.5, pointRadius: 0, tension: 0.2 }] },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 0 },
            plugins: { legend: { display: false }, tooltip: { enabled: false } },
            scales: { x: { display: false }, y: { display: false } }
        }
    };

    document.querySelectorAll('.doughnut-wrap canvas').forEach(canvas => {
        const id = canvas.id;
        if (!id) return;
        chartInstances[id] = new Chart(canvas, commonDoughnut);
    });

    document.querySelectorAll('.sparkline-row canvas, .line-canvas').forEach(canvas => {
        const id = canvas.id;
        if (!id) return;
        const color = canvas.dataset.color || '#3fb950';
        const config = JSON.parse(JSON.stringify(commonLine));
        config.data.datasets[0].borderColor = color;
        config.data.datasets[0].fill = false;
        chartInstances[id] = new Chart(canvas, config);
    });
}

function updateDoughnut(id, value) {
    const chart = chartInstances[id];
    if (!chart) return;
    const p = Math.min(100, Math.max(0, safeVal(value)));
    if (chart.data.datasets[0].data[0] === p) return; // 无变化不更新
    chart.data.datasets[0].data = [p, 100 - p];
    const color = p < 50 ? '#3fb950' : p < 80 ? '#d2991d' : '#f85149';
    chart.data.datasets[0].backgroundColor = [color, 'rgba(139,148,158,0.25)'];
    chart.update('none');
}

function updateLine(id, value) {
    const chart = chartInstances[id];
    if (!chart) return;
    const data = chart.data.datasets[0].data;
    data.push(safeVal(value));
    if (data.length > 20) data.shift();
    chart.update('none');
}

function getTerminalScrollElement() {
    return wtermWrapper;
}

/**
 * Distance from bottom of history viewport.
 * xterm path: ybase - ydisp in **rows** (then * lineHeight for px-compatible callers).
 * DOM path: scrollHeight - scrollTop - clientHeight.
 */
function getXtermHistoryMetrics() {
    try {
        const bridge = term?.bridge;
        if (bridge && (bridge.kind === 'xterm' || bridge.virtualViewport || typeof bridge.getViewportY === 'function')) {
            const ydisp = typeof bridge.getViewportY === 'function' ? (bridge.getViewportY() | 0) : 0;
            const ybase = typeof bridge.getBaseY === 'function' ? (bridge.getBaseY() | 0) : ydisp;
            const rowsAbove = Math.max(0, ybase - ydisp);
            const rh = term?.getViewportState?.()?.rowHeight
                || getTerminalCharMetrics?.()?.lineHeight
                || 17;
            return {
                active: true,
                ydisp,
                ybase,
                rowsAbove,
                pxAbove: rowsAbove * rh,
                atBottom: typeof bridge.isAtBottom === 'function'
                    ? !!bridge.isAtBottom()
                    : rowsAbove === 0,
                lineHeight: rh,
            };
        }
    } catch (_) {}
    return null;
}

function getTerminalBottomDistance(el = getTerminalScrollElement()) {
    const xm = getXtermHistoryMetrics();
    if (xm?.active) return xm.pxAbove;
    if (!el) return 0;
    return el.scrollHeight - el.scrollTop - el.clientHeight;
}

function isTerminalAtBottom(el = getTerminalScrollElement(), threshold = TERMINAL_BOTTOM_THRESHOLD) {
    const xm = getXtermHistoryMetrics();
    if (xm?.active) {
        // threshold is px; convert to rows (at least 0 = strict bottom).
        const rowSlop = Math.max(0, Math.ceil((Number(threshold) || 0) / Math.max(1, xm.lineHeight)));
        return xm.rowsAbove <= rowSlop;
    }
    if (!el) return true;
    return getTerminalBottomDistance(el) <= threshold;
}

/** Coalesce follow/lock side-effects across multi-line touch pans (one per frame). */
let _historyScrollUiRaf = 0;
let _historyScrollUiPending = null;

function _flushHistoryScrollUi() {
    _historyScrollUiRaf = 0;
    const pending = _historyScrollUiPending;
    _historyScrollUiPending = null;
    if (!pending || !term) return;
    const { reason } = pending;
    const atBottom = isTerminalAtBottom(undefined, TERMINAL_XTERM_SCROLL_LOCK_THRESHOLD);
    if (atBottom) {
        clearMobileTerminalHistoryLock?.(`${reason}:at-bottom`);
        setTerminalAutoFollow?.(true, `${reason}:at-bottom`);
        scheduleEnsureActiveLineAboveChrome?.(`${reason}:follow`);
    } else {
        try {
            const root = term?.element || wtermWrapper?.querySelector?.('.wterm');
            root?.style?.setProperty?.('--term-active-line-shift', '0px');
        } catch (_) {}
        lockMobileTerminalAutoFollow?.(`${reason}:history`, 2400);
        setTerminalAutoFollow?.(false, `${reason}:history`);
        terminalUserScrolledAway = true;
        if (isMobileStableInputMode()) terminalUserScrollGestureUntil = Date.now() + 1400;
    }
    scheduleTerminalScrollbarUpdate?.();
}

/** Drive xterm history by N rows (negative = into history / up). */
function scrollTerminalHistoryLines(amount, reason = 'history-scroll') {
    const n = Math.trunc(Number(amount) || 0);
    if (!n || !term) return false;
    try {
        if (typeof term.bridge?.scrollLines === 'function') {
            term.bridge.scrollLines(n);
            try { term._scheduleRender?.(); } catch (_) {}
        } else if (typeof term.scrollLines === 'function') {
            term.scrollLines(n);
        } else {
            return false;
        }
    } catch (_) {
        return false;
    }
    // Defer lock/follow/chrome work to one rAF — touch pans fire many times/frame.
    _historyScrollUiPending = { reason: String(reason || 'history-scroll') };
    if (!_historyScrollUiRaf) {
        _historyScrollUiRaf = requestAnimationFrame(_flushHistoryScrollUi);
    }
    logTerminalScrollDiagnostics?.('history-scroll-lines', {
        reason,
        amount: n,
        ...((() => { try { return getXtermHistoryMetrics(); } catch (_) { return {}; } })() || {}),
    });
    return true;
}
 
function getMobileStableFollowThreshold() {
    const lineHeight = getTerminalCharMetrics?.()?.lineHeight || terminalFontSize * 1.35 || 20;
    return Math.max(TERMINAL_XTERM_SCROLL_LOCK_THRESHOLD, Math.round(lineHeight * 3));
}

function isMobileStableKeyboardActive() {
    return isMobileStableInputMode() && (isSshKbLayoutOpen() || getSshKbInset() > 8 || document.documentElement.classList.contains('ssh-kb-open'));
}

function isMobileStableAtVisualBottom(el = getTerminalScrollElement()) {
    if (!el) return true;
    const threshold = isMobileStableKeyboardActive() ? getMobileStableFollowThreshold() : TERMINAL_XTERM_SCROLL_LOCK_THRESHOLD;
    return isTerminalAtBottom(el, threshold);
}

function isTerminalUserReadingHistory() {
    const el = getTerminalScrollElement();
    if (!el) return false;
    const threshold = isMobileStableKeyboardActive()
        ? getMobileStableFollowThreshold()
        : TERMINAL_XTERM_SCROLL_LOCK_THRESHOLD;
    return !terminalAutoFollowEnabled && !isTerminalAtBottom(el, threshold);
}

function clearMobileTerminalHistoryLock(reason = 'clear-history-lock') {
    if (!isMobileStableInputMode()) return;
    mobileTerminalAutoFollowLockUntil = 0;
    mobileTerminalAutoFollowLockReason = '';
    terminalUserScrolledAway = false;
    terminalAutoFollowEnabled = true;
    mobileStableLastBottomIntent = true;
    terminalContainer?.classList.remove('terminal-follow-paused');
    terminalContainer?.classList.add('terminal-following');
    logTerminalScrollDiagnostics('auto-follow:mobile-lock-clear', { reason });
}

function lockMobileTerminalAutoFollow(reason = 'mobile-history-lock', duration = 1800) {
    if (!isMobileStableInputMode()) return;
    const el = getTerminalScrollElement();
    const threshold = isMobileStableKeyboardActive()
        ? getMobileStableFollowThreshold()
        : TERMINAL_XTERM_SCROLL_LOCK_THRESHOLD;
    if (!el || isTerminalAtBottom(el, threshold)) return;
    const lockDuration = Math.max(300, Math.min(6000, Number(duration) || 1800));
    mobileTerminalAutoFollowLockUntil = Math.max(mobileTerminalAutoFollowLockUntil || 0, Date.now() + lockDuration);
    mobileTerminalAutoFollowLockReason = String(reason || 'mobile-history-lock');
    terminalUserScrolledAway = true;
    terminalAutoFollowEnabled = false;
    terminalContainer?.classList.toggle('terminal-follow-paused', true);
    terminalContainer?.classList.toggle('terminal-following', false);
    logTerminalScrollDiagnostics('auto-follow:mobile-lock-set', {
        reason: mobileTerminalAutoFollowLockReason,
        lockDuration,
        until: mobileTerminalAutoFollowLockUntil,
    });
}

function isMobileTerminalAutoFollowLocked() {
    const threshold = isMobileStableKeyboardActive()
        ? getMobileStableFollowThreshold()
        : TERMINAL_XTERM_SCROLL_LOCK_THRESHOLD;
    return isMobileStableInputMode()
        && Date.now() < (mobileTerminalAutoFollowLockUntil || 0)
        && !isTerminalAtBottom(undefined, threshold);
}

function setTerminalAutoFollow(enabled, reason = 'unknown') {
    terminalAutoFollowEnabled = !!enabled;
    terminalUserScrolledAway = !terminalAutoFollowEnabled;
    terminalContainer?.classList.toggle('terminal-follow-paused', !terminalAutoFollowEnabled);
    terminalContainer?.classList.toggle('terminal-following', terminalAutoFollowEnabled);
    // Keep surface mode in lockstep — avoid dual brains on follow state.
    try { ensureTerminalSurface()?.setFollowEnabled?.(terminalAutoFollowEnabled, reason); } catch (_) {}
    logTerminalScrollDiagnostics('auto-follow:set', { enabled: terminalAutoFollowEnabled, reason });
}

function updateTerminalAutoFollowFromScroll(reason = 'scroll') {
    const el = getTerminalScrollElement();
    if (!el) return true;
    const threshold = isMobileStableKeyboardActive()
        ? getMobileStableFollowThreshold()
        : TERMINAL_XTERM_SCROLL_LOCK_THRESHOLD;
    const atBottom = isTerminalAtBottom(el, threshold);
    if (atBottom) {
        mobileStableLastBottomIntent = true;
        setTerminalAutoFollow(true, reason);
    }
    else if (isMobileStableInputMode() && Date.now() < terminalUserScrollGestureUntil) {
        cancelTerminalBottomFollow(`${reason}:user-scroll`);
        cancelMobileStableScrollRestore(`${reason}:user-scroll`);
        terminalLastUserScrollAt = Date.now();
        mobileStableLastBottomIntent = false;
        setTerminalAutoFollow(false, reason);
        lockMobileTerminalAutoFollow(reason, 3200);
    }
    else if (isMobileStableInputMode()) {
        // Android/WebView emits scroll events during keyboard animation, WTerm render,
        // and our own visibility repairs. Treat mobile stable scroll-away as history
        // only when a real touch/wheel/scrollbar gesture marked terminalUserScrollGestureUntil.
        scheduleTerminalScrollbarUpdate();
    }
    else if (!isProgrammaticTerminalScroll) {
        cancelTerminalBottomFollow(`${reason}:user-scroll`);
        cancelMobileStableScrollRestore(`${reason}:user-scroll`);
        terminalLastUserScrollAt = Date.now();
        mobileStableLastBottomIntent = false;
        setTerminalAutoFollow(false, reason);
        lockMobileTerminalAutoFollow(reason, 2200);
    }
    return terminalAutoFollowEnabled;
}

function scrollTerminalToBottom(reason = 'scroll-bottom') {
    const el = getTerminalScrollElement();
    if (!el) return;
    if (isMobileStableInputMode()) {
        // Single writer: never maxScroll / activeTarget DOM chase here.
        if (Date.now() < mobileStableSuppressScrollUntil && !isMobileStableActualInputReason(reason)) {
            scheduleTerminalScrollbarUpdate();
            return;
        }
        if (shouldBlockMobileStableAutoFollowReason(reason)) {
            scheduleTerminalScrollbarUpdate();
            return;
        }
        mobileTerminalAutoFollowLockUntil = 0;
        mobileTerminalAutoFollowLockReason = '';
        applyCursorAboveChromeScroll(reason, { force: true });
        return;
    }
    if (shouldBlockMobileStableAutoFollowReason(reason)) {
        logTerminalScrollDiagnostics('scroll-bottom:blocked-mobile-stable-layout', { reason });
        scheduleTerminalScrollbarUpdate();
        return;
    }
    if (sshKb && !sshKb.allowNonPinScroll?.(reason)) {
        // During keyboard phase use chrome-pin instead of maxScroll chase.
        return applyCursorAboveChromeScroll(reason, { force: true }) || false;
    }
    isProgrammaticTerminalScroll = true;
    try {
        const maxScroll = getTerminalMaxScroll(el);
        writeTerminalScrollTop(el, maxScroll, reason, { pin: false });
        const nextMaxScroll = getTerminalMaxScroll(el);
        writeTerminalScrollTop(el, nextMaxScroll, reason, { pin: false });
        if (wtermWrapper && wtermWrapper !== el) {
            writeTerminalScrollTop(wtermWrapper, getTerminalMaxScroll(wtermWrapper), reason, { pin: false });
        }
        mobileTerminalAutoFollowLockUntil = 0;
        mobileTerminalAutoFollowLockReason = '';
        setTerminalAutoFollow(true, reason);
    } finally {
        scheduleTerminalScrollbarUpdate();
        requestAnimationFrame(() => { isProgrammaticTerminalScroll = false; });
    }
}

function getTerminalMaxScroll(el = getTerminalScrollElement()) {
    const xm = getXtermHistoryMetrics();
    // xterm: max scroll in px = ybase * lineHeight (ydisp=0 → top of history).
    if (xm?.active) return Math.max(0, (xm.ybase | 0) * Math.max(1, xm.lineHeight));
    if (!el) return 0;
    return Math.max(0, el.scrollHeight - el.clientHeight);
}
 
function updateTerminalScrollbarNow() {
    const el = getTerminalScrollElement();
    if (!el || !terminalContainer || !terminalScrollbar || !terminalScrollbarThumb) return;
    const xm = getXtermHistoryMetrics();
    let maxScroll = 0;
    let scrollTop = 0;
    let viewH = el.clientHeight || 1;
    let contentH = el.scrollHeight || 1;
    if (xm?.active) {
        maxScroll = Math.max(0, (xm.ybase | 0) * Math.max(1, xm.lineHeight));
        scrollTop = Math.max(0, (xm.ydisp | 0) * Math.max(1, xm.lineHeight));
        // Fake content height so thumb size ≈ viewport/buffer.
        contentH = maxScroll + viewH;
    } else {
        maxScroll = getTerminalMaxScroll(el);
        scrollTop = el.scrollTop || 0;
        contentH = Math.max(el.scrollHeight, 1);
    }
    const scrollable = maxScroll > 1;
    const atBottom = isTerminalAtBottom(el, 8);
    terminalContainer.classList.toggle('scrollable', scrollable);
    terminalContainer.classList.toggle('terminal-following', atBottom && scrollable);
    el.classList.toggle('terminal-scrollable', scrollable);
    if (terminalScrollbar) terminalScrollbar.style.display = scrollable ? 'block' : 'none';
    if (!scrollable) {
        terminalScrollbar.style.setProperty('--terminal-scroll-thumb-top', '0px');
        terminalScrollbar.style.setProperty('--terminal-scroll-thumb-height', '100%');
        return;
    }

    const trackHeight = terminalScrollbar.clientHeight || terminalScrollbar.getBoundingClientRect().height || 1;
    const thumbHeight = Math.min(trackHeight, Math.max(TERMINAL_SCROLLBAR_MIN_THUMB, (viewH / Math.max(contentH, 1)) * trackHeight));
    const movable = Math.max(1, trackHeight - thumbHeight);
    const ratio = maxScroll > 0 ? Math.min(1, Math.max(0, scrollTop / maxScroll)) : 0;
    terminalScrollbar.style.setProperty('--terminal-scroll-thumb-height', `${thumbHeight}px`);
    terminalScrollbar.style.setProperty('--terminal-scroll-thumb-top', `${ratio * movable}px`);
}
 
function scheduleTerminalScrollbarUpdate() {
    if (terminalScrollbarRaf) return;
    terminalScrollbarRaf = requestAnimationFrame(() => {
        terminalScrollbarRaf = 0;
        updateTerminalScrollbarNow();
    });
}

function shouldBlockMobileStableAutoFollowReason(reason = '') {
    if (!isMobileStableInputMode()) return false;
    const label = String(reason || '').toLowerCase();
    if (isMobileStableActualInputReason(label)) return false;
    if (/terminal-data|write-follow|render-follow|scheduled-render-follow|wterm-render-scroll-bottom|wterm-scroll-bottom|manual-bottom|resize-observer-follow/.test(label)) {
        return false;
    }
    // Rendering, resize, layout, keyboard and focus events must not scroll WTerm.
    // They can otherwise push the viewport into WTerm's bottom blank space, producing
    // the all-black terminal on first connect / keyboard reopen.
    return /render|resize|layout|keyboard|viewport|visual|focus|ready|repair|scheduled|suppressed/.test(label);
}

function requestTerminalAutoFollow(reason = 'auto-follow') {
    const el = getTerminalScrollElement();
    if (!el) return;
    const actualInputReason = isMobileStableActualInputReason(reason);
    const outputFollowReason = isMobileStableInputMode() && /terminal-data|write-follow|render-follow|scheduled-render-follow|wterm-render-scroll-bottom|wterm-scroll-bottom/.test(String(reason || '').toLowerCase());
    if (isMobileStableInputMode() && Date.now() < mobileStableSuppressScrollUntil && !outputFollowReason) {
        scheduleTerminalScrollbarUpdate();
        return;
    }
    if (shouldBlockMobileStableAutoFollowReason(reason)) {
        logTerminalScrollDiagnostics('auto-follow:blocked-mobile-stable-layout', { reason });
        scheduleTerminalScrollbarUpdate();
        return;
    }
    if (isMobileTerminalAutoFollowLocked() && !actualInputReason && !outputFollowReason) {
        logTerminalScrollDiagnostics('auto-follow:mobile-history-transient-locked', { reason, lockReason: mobileTerminalAutoFollowLockReason });
        scheduleTerminalScrollbarUpdate();
        return;
    }
    if (isMobileStableInputMode() && isTerminalUserReadingHistory() && !actualInputReason && !outputFollowReason) {
        logTerminalScrollDiagnostics('auto-follow:mobile-history-locked', { reason });
        scheduleTerminalScrollbarUpdate();
        return;
    }
    if (hasLiveTerminalSelection() || mobileTerminalSelectionMode) {
        logTerminalScrollDiagnostics('auto-follow:selection-active', { reason });
        scheduleTerminalScrollbarUpdate();
        return;
    }
    if (!terminalAutoFollowEnabled && !isTerminalAtBottom(el, TERMINAL_XTERM_SCROLL_LOCK_THRESHOLD) && !actualInputReason && !outputFollowReason) {
        logTerminalScrollDiagnostics('auto-follow:paused', { reason });
        scheduleTerminalScrollbarUpdate();
        return;
    }
    scrollTerminalToBottom(reason);
}

function stopTerminalAutoScrollObserver() {
    if (terminalScrollRaf) {
        cancelAnimationFrame(terminalScrollRaf);
        terminalScrollRaf = 0;
    }
    if (terminalScrollbarRaf) {
        cancelAnimationFrame(terminalScrollbarRaf);
        terminalScrollbarRaf = 0;
    }
    cancelMobileStableScrollRestore('stop-scroll-observer');
    cancelTerminalBottomFollow('stop-scroll-observer');
    terminalScrollCleanup?.();
    terminalScrollCleanup = null;
    isProgrammaticTerminalScroll = false;
}

function getTerminalAltScreenActive() {
    try { return !!term?.bridge?.usingAltScreen?.(); } catch (_) { return false; }
}

function sendTerminalAltScroll(deltaY) {
    if (!getTerminalAltScreenActive() || !wsConnection || wsConnection.readyState !== WebSocket.OPEN || !isConnected) return false;
    if (hasLiveTerminalSelection()) return false;
    const now = Date.now();
    if (now - terminalLastWheelAt < TERMINAL_ALT_SCROLL_REPEAT_MS) return true;
    terminalLastWheelAt = now;
    const seq = deltaY < 0 ? '\x1b[A' : '\x1b[B';
    const repeats = Math.max(1, Math.min(5, Math.round(Math.abs(deltaY) / 48)));
    sendData(seq.repeat(repeats), { source: 'alt-screen-wheel', forceFollow: true });
    return true;
}

function updateTerminalInputPanelMetrics() {
    if (!terminalInputPanel) return;
    const rect = terminalInputPanel.getBoundingClientRect?.();
    const height = Math.max(42, Math.round(rect?.height || terminalInputPanel.offsetHeight || 52));
    document.documentElement.style.setProperty('--terminal-input-panel-height', `${height}px`);
    const actionsRect = topbarActions?.getBoundingClientRect?.();
    const actionsHeight = Math.max(42, Math.round(actionsRect?.height || topbarActions?.offsetHeight || 46));
    document.documentElement.style.setProperty('--mobile-bottom-actions-height', `${actionsHeight}px`);
    scheduleTerminalScrollbarUpdate?.();
}

function setupTerminalInputPanelMetrics() {
    updateTerminalInputPanelMetrics();
    if (window.ResizeObserver && terminalInputPanel) {
        const observer = new ResizeObserver(updateTerminalInputPanelMetrics);
        observer.observe(terminalInputPanel);
        if (topbarActions) observer.observe(topbarActions);
    }
    window.addEventListener('resize', updateTerminalInputPanelMetrics, { passive: true });
}

function mountMobileStableBarsInFlow() {
    if (!isMobileStableInputMode() || !topbarActions || !terminalInputPanel) return;
    const page = document.querySelector('.terminal-page');
    if (!page) return;
    if (topbarActions.parentElement !== page || topbarActions.nextElementSibling !== terminalInputPanel) {
        page.insertBefore(topbarActions, terminalInputPanel);
    }
}

function enableMobileStableInputMode() {
    if (!MOBILE_STABLE_INPUT_MODE || mobileStableInputEnabled) return;
    mobileStableInputEnabled = true;
    // Intent starts closed. Only an explicit user gesture may open the soft keyboard.
    document.documentElement.classList.add('mobile-stable-input');
    document.body?.classList.add('mobile-stable-input');
    try { if (navigator.virtualKeyboard) navigator.virtualKeyboard.overlaysContent = true; } catch (_) {}
    setStableViewportHeight({ force: true });
    mountMobileStableBarsInFlow();
}

function isMobileStableActualInputReason(reason = '') {
    const label = String(reason || '').toLowerCase();
    return /beforeinput|composition|input-fallback|paste|backspace|enter|mobile-ime-key:|mobile-ime-control|command-box|keypad|:sent-visible|:sent/.test(label);
}

function cancelMobileStableScrollRestore(reason = 'cancel-mobile-restore') {
    mobileStableScrollRestoreToken += 1;
    mobileStableScrollRestoreTimers.forEach((timer) => window.clearTimeout(timer));
    mobileStableScrollRestoreTimers = [];
    logTerminalScrollDiagnostics('mobile-stable:restore-cancelled', { reason });
}

function cancelTerminalBottomFollow(reason = 'cancel-bottom-follow') {
    terminalBottomFollowToken += 1;
    terminalBottomFollowTimers.forEach((timer) => window.clearTimeout(timer));
    terminalBottomFollowTimers = [];
    logTerminalScrollDiagnostics('mobile-stable:bottom-follow-cancelled', { reason });
}

function followTerminalBottomNow(reason = 'bottom-follow', { force = false } = {}) {
    const el = getTerminalScrollElement();
    if (!el) return false;
    if (hasLiveTerminalSelection() || mobileTerminalSelectionMode) return false;
    const canFollow = force
        || terminalAutoFollowEnabled
        || isMobileStableAtVisualBottom(el)
        || isMobileStableActualInputReason(reason);
    if (!canFollow) return false;

    // Mobile stable: NEVER chase DOM maxScroll (creates fig.3 black void).
    // Pin cursor just above bottom chrome; sparse content → scrollTop 0.
    if (isMobileStableInputMode()) {
        mobileTerminalAutoFollowLockUntil = 0;
        mobileTerminalAutoFollowLockReason = '';
        const label = String(reason || '').toLowerCase();
        const sameLine = /beforeinput|input-fallback|composition|sent-visible|typing|printable/.test(label)
            && !/enter|return|paste|control|keypad|command-box/.test(label);
        return applyCursorAboveChromeScroll(reason, { force: true, sameLineInput: sameLine });
    }

    if (sshKb && !sshKb.allowNonPinScroll?.(reason)) {
        return applyCursorAboveChromeScroll(reason, { force: true });
    }
    isProgrammaticTerminalScroll = true;
    try {
        const maxScroll = getTerminalMaxScroll(el);
        const rh = (term && typeof term.viewport !== 'undefined' && term.viewport.rowHeight)
            || getTerminalCharMetrics?.()?.lineHeight
            || terminalFontSize * 1.35
            || 17;
        const aligned = Math.floor(Math.max(0, maxScroll) / rh) * rh;
        writeTerminalScrollTop(el, aligned, reason, { pin: false });
        if (wtermWrapper && wtermWrapper !== el) {
            writeTerminalScrollTop(wtermWrapper, Math.max(0, Math.min(getTerminalMaxScroll(wtermWrapper), aligned)), reason, { pin: false });
        }
        mobileTerminalAutoFollowLockUntil = 0;
        mobileTerminalAutoFollowLockReason = '';
        mobileStableLastBottomIntent = true;
        setTerminalAutoFollow(true, reason);
    } finally {
        scheduleTerminalScrollbarUpdate();
        requestAnimationFrame(() => { isProgrammaticTerminalScroll = false; });
    }
    return true;
}

function scheduleTerminalBottomFollow(reason = 'bottom-follow', { force = false, phases } = {}) {
    const el = getTerminalScrollElement();
    if (!el) return;
    // Netcatty discipline: never multi-phase chase. Callers that still use this
    // helper get a single rAF shot unless they explicitly pass short settle phases
    // from scrollSettlePhases() (paste/enter ≤2).
    const label = String(reason || '').toLowerCase();
    let resolvedPhases = Array.isArray(phases) ? phases : null;
    if (!resolvedPhases) {
        if (/paste/.test(label)) resolvedPhases = scrollSettlePhases('paste');
        else if (/enter|return/.test(label)) resolvedPhases = scrollSettlePhases('enter');
        else if (/keyboard|viewport|layout|visual|focus|resize|open|close/.test(label)) {
            resolvedPhases = scrollSettlePhases('layout'); // []
        } else {
            resolvedPhases = scrollSettlePhases('input'); // [0]
        }
    }
    if (!resolvedPhases.length) {
        scheduleTerminalScrollbarUpdate();
        return;
    }
    cancelMobileStableScrollRestore(`${reason}:bottom-follow`);
    cancelTerminalBottomFollow(reason);
    const token = terminalBottomFollowToken;
    const run = () => {
        if (token !== terminalBottomFollowToken) return;
        if (force || terminalAutoFollowEnabled || isMobileStableAtVisualBottom(el)) {
            // One path only — chrome pin (mobile) or followTerminalBottomNow (desktop).
            followTerminalBottomNow(reason, { force: true });
        } else {
            scheduleTerminalScrollbarUpdate();
        }
    };
    resolvedPhases.forEach((delay) => {
        const timer = window.setTimeout(() => requestAnimationFrame(run), Math.max(0, delay));
        terminalBottomFollowTimers.push(timer);
    });
}

/** Quantize + debounce kb page geometry so Android vv jitter cannot thrash fit/paint. */
let _sshKbGeomSettleTimer = 0;
let _sshKbGeomPending = null;
let _sshKbLastFitAt = 0;
let _sshKbLastFitSignature = '';

/** Last time parent-overlap wrote an OPEN geometry (sticky against facade close). */
let _sshKbParentGeomAt = 0;
/**
 * Sticky: parent app already cropped the iframe to the keyboard top.
 * While true, child MUST keep --ssh-kb-inset=0 and height:100%.
 * Re-applying physical keyboard height (e.g. after tapping ↑ / retainFocus)
 * double-shrinks the page and makes the bottom bar "fly" into the terminal.
 */
let _sshKbParentShellManaged = false;

function setSshKbParentShellManaged(active, reason = '') {
    _sshKbParentShellManaged = !!active;
    try {
        document.documentElement.classList.toggle('ssh-kb-parent-shell', !!active);
    } catch (_) {}
    if (active) _sshKbParentGeomAt = Date.now();
    logTerminalLayoutDiagnostics?.('ssh-kb-parent-shell', {
        active: !!active,
        reason: String(reason || ''),
    });
}

function measureSshKbChromeHeights() {
    let aux = 48;
    let tools = 52;
    try {
        const bar = document.getElementById('terminalBottomBar');
        const r = bar?.getBoundingClientRect?.();
        if (r?.height > 20) aux = Math.round(r.height);
    } catch (_) {}
    try {
        const actions = document.getElementById('topbarActions') || topbarActions;
        const r = actions?.getBoundingClientRect?.();
        if (r?.height > 20) tools = Math.round(r.height);
    } catch (_) {}
    return { aux, tools };
}

function writeSshKbPageGeometry(safeInset, layoutOpen, { fromParent = false } = {}) {
    // Parent-shell-managed: iframe already ends at keyboard top → child inset is always 0.
    // Ignoring this is the root cause of the bottom bar flying up on aux-key taps.
    let inset = Math.max(0, Math.round(Number(safeInset) || 0));
    if (layoutOpen && (fromParent || _sshKbParentShellManaged)) {
        inset = 0;
        setSshKbParentShellManaged(true, fromParent ? 'write-from-parent' : 'write-sticky');
    } else if (!layoutOpen) {
        setSshKbParentShellManaged(false, 'write-close');
    } else if (inset > 0) {
        // Standalone (no parent crop): allow real inset, clear sticky flag.
        setSshKbParentShellManaged(false, 'write-standalone-inset');
    }
    _sshKbInsetCache = inset;
    _sshKbLayoutOpenCache = !!layoutOpen;
    if (layoutOpen && fromParent) _sshKbParentGeomAt = Date.now();
    if (!layoutOpen && fromParent) _sshKbParentGeomAt = 0;

    // Always keep mobile-stable class for the fixed-chrome CSS path.
    try {
        document.documentElement.classList.add('mobile-stable-input');
        document.body?.classList?.add?.('mobile-stable-input');
    } catch (_) {}

    document.documentElement.style.setProperty('--keyboard-inset', `${inset}px`);
    document.documentElement.style.setProperty('--ssh-kb-inset', `${inset}px`);
    document.documentElement.style.setProperty('--ime-chrome-bottom', '0px');

    // Measure chrome after toggle so fixed bottom offsets are correct.
    document.documentElement.classList.toggle('ssh-kb-open', !!layoutOpen);
    terminalContainer?.classList.toggle('ssh-kb-open', !!layoutOpen);
    document.documentElement.classList.remove('viewport-updating');

    const heights = measureSshKbChromeHeights();
    document.documentElement.style.setProperty('--ssh-kb-aux-height', `${heights.aux}px`);
    document.documentElement.style.setProperty('--ssh-kb-tools-height', `${heights.tools}px`);

    // Re-measure after one frame (fixed layout can change heights).
    if (layoutOpen) {
        requestAnimationFrame(() => {
            const h2 = measureSshKbChromeHeights();
            document.documentElement.style.setProperty('--ssh-kb-aux-height', `${h2.aux}px`);
            document.documentElement.style.setProperty('--ssh-kb-tools-height', `${h2.tools}px`);
        });
    }

    pinMobileImeChrome(layoutOpen, inset, { authoritative: true });
    if (!cmdOverlayMode) {
        document.documentElement.dataset.keyboardLiftMode = SoftKeyboardLiftMode.WORKSPACE;
    }
    logTerminalLayoutDiagnostics?.('ssh-kb-page-geometry', {
        inset,
        layoutOpen: !!layoutOpen,
        fromParent: !!fromParent,
        aux: heights.aux,
        tools: heights.tools,
    });
}
 
/**
 * Keyboard geometry (user model 2026-07-21):
 * - xterm/wterm KEEP the same rows×cols (buffer still renders the same grid).
 * - Only the *visible shell* shrinks via --ssh-kb-inset (CSS static fill above IME).
 * - Never term.resize / PTY setWindow on keyboard open/close — that was the
 *   black-flash / cursor-fly root. Stick-bottom = xterm ydisp via scrollToBottom.
 * - Selection/copy paths are not touched.
 */
function scheduleSshKbGeometryFit(reason, layoutOpen, wasFollowing) {
    const sig = `${layoutOpen ? 1 : 0}:${Math.round((_sshKbInsetCache || 0) / 48)}`;
    const now = Date.now();
    if (sig === _sshKbLastFitSignature && now - _sshKbLastFitAt < 80) return;
    _sshKbLastFitSignature = sig;
    _sshKbLastFitAt = now;

    const hardStickBottom = (label) => {
        if (!wasFollowing && !layoutOpen) {
            // Closing without follow intent: do not yank user history view.
            // Opening still sticks so the prompt stays in the clipped shell.
        }
        try {
            if (layoutOpen || wasFollowing) {
                mobileTerminalAutoFollowLockUntil = 0;
                mobileTerminalAutoFollowLockReason = '';
                mobileStableLastBottomIntent = true;
                terminalAutoFollowEnabled = true;
                setTerminalAutoFollow?.(true, label);
            }
        } catch (_) {}
        // Authority: xterm ydisp (bridge/WTerm.scrollToBottom), not DOM scrollTop.
        try {
            if (layoutOpen || wasFollowing) {
                if (typeof term?.bridge?.scrollToBottom === 'function') term.bridge.scrollToBottom();
                else if (typeof term?.scrollToBottom === 'function') term.scrollToBottom();
                try { term?._scheduleRender?.(); } catch (_) {}
            }
        } catch (_) {}
        // DOM overflow is zero for xterm-viewport; keep scrollTop 0 so chrome metrics stay stable.
        try {
            const el = getTerminalScrollElement() || wtermWrapper || term?.element;
            if (el && term?.element?.classList?.contains('xterm-viewport')) {
                isProgrammaticTerminalScroll = true;
                el.scrollTop = 0;
                if (wtermWrapper && wtermWrapper !== el) wtermWrapper.scrollTop = 0;
                requestAnimationFrame(() => { isProgrammaticTerminalScroll = false; });
            } else if (el && (layoutOpen || wasFollowing)) {
                const max = Math.max(0, (el.scrollHeight || 0) - (el.clientHeight || 0));
                isProgrammaticTerminalScroll = true;
                el.scrollTop = max;
                requestAnimationFrame(() => { isProgrammaticTerminalScroll = false; });
            }
        } catch (_) {}
        scheduleTerminalScrollbarUpdate?.();
        logTerminalLayoutDiagnostics?.('ssh-kb-viewport-stick', {
            reason: label,
            layoutOpen: !!layoutOpen,
            wasFollowing: !!wasFollowing,
            rows: Number(term?.rows || term?.bridge?.getRows?.() || 0),
            cols: Number(term?.cols || term?.bridge?.getCols?.() || 0),
            ydisp: term?.bridge?.getViewportY?.(),
            ybase: term?.bridge?.getBaseY?.(),
            inset: _sshKbInsetCache || 0,
        });
    };

    // Viewport-only settle: CSS already applied --ssh-kb-inset. Do NOT resize grid.
    // Single rAF + one stick. No multi-phase normalize/fit (that flashed the page).
    const settleViewport = (label) => {
        if (_sshKbLastFitSignature !== sig) return null;
        if (!term || !wtermWrapper) return null;
        const box = terminalContainer || wtermWrapper;
        const rect = box.getBoundingClientRect?.() || { width: 0, height: 0 };
        const h = Math.round(rect.height || 0);
        const w = Math.round(rect.width || 0);
        const rows = Number(term.rows ?? term.bridge?.getRows?.() ?? 0);
        const cols = Number(term.cols ?? term.bridge?.getCols?.() ?? 0);
        console.info('[ssh-kb-viewport-only]', {
            reason: label,
            layoutOpen: !!layoutOpen,
            boxH: h, boxW: w,
            cols, rows,
            inset: _sshKbInsetCache || 0,
            resized: false,
            draftLen: 0,
        });
        logTerminalLayoutDiagnostics?.('ssh-kb-viewport-only', {
            reason: label, layoutOpen: !!layoutOpen, boxH: h, boxW: w, cols, rows,
            inset: _sshKbInsetCache || 0,
        });
        hardStickBottom(`${label}:stick`);
        // Keyboard shell changed height — re-pin caret above tools (clip + shift).
        scheduleEnsureActiveLineAboveChrome(`${label}:kb-shell`);
        return { cols, rows, resized: false };
    };

    requestAnimationFrame(() => settleViewport(`${reason}:vp-raf`));
}
 
/**
 * Soft-keyboard shell geometry.
 * Open: shrink page by inset. Close: IMMEDIATELY clear inset/class — never lag.
 * Stuck "half keyboard" blank under tools is almost always a delayed/blocked close.
 */
let _sshKbLowInsetSince = 0;
let _sshKbForceCloseTimer = 0;

function forceClearSshKbShell(reason = 'force-clear') {
    window.clearTimeout(_sshKbGeomSettleTimer);
    window.clearTimeout(_sshKbForceCloseTimer);
    _sshKbGeomSettleTimer = 0;
    _sshKbForceCloseTimer = 0;
    _sshKbGeomPending = null;
    _sshKbLowInsetSince = 0;
    _sshKbParentGeomAt = 0;
    setSshKbParentShellManaged(false, reason || 'force-clear');
    const wasOpen = !!_sshKbLayoutOpenCache || (_sshKbInsetCache || 0) > 0
        || document.documentElement.classList.contains('ssh-kb-open');
    writeSshKbPageGeometry(0, false, { fromParent: true });
    try { updateTerminalInputPanelMetrics(); } catch (_) {}
    try { assertKeyboardLayoutSettled?.(reason); } catch (_) {}
    if (wasOpen) {
        try {
            const el = getTerminalScrollElement();
            const wasFollowing = Boolean(el && (terminalAutoFollowEnabled || mobileStableLastBottomIntent || isMobileStableAtVisualBottom?.(el)));
            if (wasFollowing) scheduleSshKbGeometryFit(`${reason}:close`, false, true);
            else scheduleEnsureActiveLineAboveChrome?.(`${reason}:close`);
        } catch (_) {}
    }
    logTerminalLayoutDiagnostics?.('ssh-kb-shell-force-clear', { reason, wasOpen });
    return wasOpen;
}

function applyMobileStableKeyboardInset(inset = 0, keyboardOpen = false, reason = 'keyboard-inset') {
    // DOM geometry only. kb-flow2 (Termux): --ssh-kb-inset shrinks .terminal-page.
    // CRITICAL: never thrash fit/resize on every vv tick — that paints black frames.
    const reasonText = String(reason || '');
    if (isCmdOverlayMode() || /\bcmd-frozen\b|:cmd\b|cmd-overlay/i.test(reasonText)) {
        forceClearSshKbShell(`${reasonText || 'cmd-frozen'}:cmd`);
        document.documentElement.dataset.keyboardLiftMode = SoftKeyboardLiftMode.NONE;
        return;
    }

    const el = getTerminalScrollElement();
    const wasFollowing = Boolean(el && (terminalAutoFollowEnabled || mobileStableLastBottomIntent || isMobileStableAtVisualBottom(el)));
    const measured = measureImeChromeBottom();
    const reported = Math.max(0, Math.round(Number(inset) || 0));
    const parentAuthoritative = /parent-overlap|parent-layout|parent-physical/.test(reasonText);
    const explicitClose = !keyboardOpen
        || /:close\b|facade-close|finalize|force-clear|system-dismiss|physical-close|keyboard-close/.test(reasonText);
    const open = !!keyboardOpen && !explicitClose;

    // -------- CLOSE (must be immediate) --------
    if (!open) {
        forceClearSshKbShell(reasonText || 'close');
        if (!isMobileStableInputMode()) return;
        return;
    }

    // -------- OPEN --------
    // F1/F2: open may arrive with inset=0 (shell-managed parent crop, or
    // awaiting first physical height). Still toggle ssh-kb-open class.
    // Never forceClear just because height is not ready — that was why the
    // keyboard could never open after provisional physical was removed.
    let pinInset = 0;
    if (_sshKbParentShellManaged || parentAuthoritative) {
        // Parent already cropped iframe: child inset is ALWAYS 0.
        // Intent may hold physical height for state machine; never paint it as
        // child CSS --ssh-kb-inset (double crop → bottom bar flies).
        pinInset = 0;
    } else if (reported >= 80) {
        pinInset = reported;
    } else if (measured >= 80) {
        pinInset = measured;
    } else {
        // Intent open, no real height yet — keep class, inset stays 0.
        pinInset = 0;
    }
    // Quantize to 4px so tools track keyboard edge more tightly.
    const safeInset = pinInset > 0 ? Math.round(pinInset / 4) * 4 : 0;
    const prevOpen = _sshKbLayoutOpenCache;
    const prevInset = _sshKbInsetCache || 0;

    _sshKbLowInsetSince = 0;
    // Open / inset update: skip no-ops within 4px only (keep toolbar glued).
    if (prevOpen && Math.abs(prevInset - safeInset) < 4) {
        // Still ensure class is on (prevOpen may have been true but class dropped).
        if (!document.documentElement.classList.contains('ssh-kb-open')) {
            writeSshKbPageGeometry(safeInset, true, { fromParent: parentAuthoritative });
        }
        return;
    }

    const commitOpen = (job, { fromParent = false } = {}) => {
        window.clearTimeout(_sshKbForceCloseTimer);
        _sshKbForceCloseTimer = 0;
        _sshKbLowInsetSince = 0;
        writeSshKbPageGeometry(job.safeInset, true, { fromParent });
        try { updateTerminalInputPanelMetrics(); } catch (_) {}
        // Viewport shell only + one stick. Never resize rows/cols.
        scheduleSshKbGeometryFit(job.reason, true, job.wasFollowing !== false);
    };

    const job = { safeInset, layoutOpen: true, reason: reasonText, wasFollowing };

    // Parent-overlap is exact — commit immediately. Open-without-height also
    // commits immediately (class only); real height will re-commit later.
    if (parentAuthoritative || safeInset === 0) {
        window.clearTimeout(_sshKbGeomSettleTimer);
        _sshKbGeomPending = null;
        commitOpen(job, { fromParent: parentAuthoritative });
        return;
    }

    // Local vv with real height: single debounce.
    _sshKbGeomPending = job;
    window.clearTimeout(_sshKbGeomSettleTimer);
    const delay = prevOpen ? 64 : 96;
    _sshKbGeomSettleTimer = window.setTimeout(() => {
        _sshKbGeomSettleTimer = 0;
        const pending = _sshKbGeomPending;
        _sshKbGeomPending = null;
        if (!pending) return;
        commitOpen(pending);
    }, delay);
}
  
/** Force-clear residual keyboard layout so the page never stays half-lifted. */
function assertKeyboardLayoutSettled(reason = 'keyboard-settled') {
    // F2: while intent still desires open, never clear shell / publish closed.
    // Physical may lag behind intent (parent crop not yet delivered).
    const desired = !!(sshKb?.desiredOpen?.() || sshSoftKeyboard?.desiredOpen?.());
    if (desired) return;
    _sshKbLayoutOpenCache = false;
    _sshKbInsetCache = 0;
    _sshKbParentGeomAt = 0;
    document.documentElement.style.setProperty('--keyboard-inset', '0px');
    document.documentElement.style.setProperty('--ssh-kb-inset', '0px');
    document.documentElement.style.setProperty('--ime-chrome-bottom', '0px');
    document.documentElement.classList.remove('ssh-kb-open', 'viewport-updating');
    terminalContainer?.classList.remove('ssh-kb-open');
    pinMobileImeChrome(false, 0);

    // Publish closed via ssh-kb only.
    ensureSshKeyboard()?._bridge?.publish?.({
        phase: 'closed',
        intent: 'closed',
        inset: 0,
        liftMode: 'workspace',
        physical: 'closed',
        reason: `${reason}:assert-clear`,
    });
}


function getMobileStableSafeGap() {
    return Math.max(18, Math.round((getTerminalCharMetrics()?.lineHeight || terminalFontSize * 1.35) * 1.5));
}

function getMobileStableActiveLineRect() {
    // Deprecated as a geometry source: always derive from getCursorContentMetrics
    // so pin / target / IME anchor share one viewport-relative path.
    if (!wtermWrapper) return null;
    const metrics = getCursorContentMetrics();
    const scrollEl = getTerminalScrollElement() || wtermWrapper;
    const hostRect = scrollEl?.getBoundingClientRect?.();
    if (metrics && hostRect?.height && Number.isFinite(metrics.cursorTopInViewport)) {
        const top = hostRect.top + metrics.cursorTopInViewport;
        const height = metrics.lineHeight
            || (metrics.cursorBottomInViewport - metrics.cursorTopInViewport)
            || getTerminalCharMetrics()?.lineHeight
            || 17;
        return {
            top,
            bottom: top + height,
            left: hostRect.left,
            right: hostRect.right,
            height,
            width: Math.max(1, hostRect.width || 0),
            _fromMetrics: true,
            source: metrics.source,
            scrollTop: scrollEl?.scrollTop || 0,
        };
    }
    const overlay = wtermWrapper.querySelector('.term-cursor-overlay');
    if (overlay && overlay.style.display !== 'none') {
        const overlayRect = overlay.getBoundingClientRect?.();
        if (overlayRect?.height) return overlayRect;
    }
    return null;
}

function getMobileStableActiveLineScrollTarget(el = getTerminalScrollElement(), reason = 'active-line-target') {
    if (!isMobileStableInputMode() || !el) return null;
    const activeRect = getMobileStableActiveLineRect();
    const viewportRect = el.getBoundingClientRect?.();
    if (!activeRect || !viewportRect?.height) return null;
    const lineHeight = getTerminalCharMetrics?.()?.lineHeight || terminalFontSize * 1.35 || 20;
    const topTolerance = Math.max(4, Math.round(lineHeight * 0.45));
    const bottomTolerance = Math.max(3, Math.round(lineHeight * 0.18));
    // Do not reserve a full line of bottom gap while typing: when the cursor is on
    // the last visible line, every echoed character would otherwise scroll by the
    // gap amount and then settle back, producing the observed up/down jitter.
    // Scroll only when the active line is actually clipped.
    const visibleTop = viewportRect.top + topTolerance;
    const visibleBottom = viewportRect.bottom - bottomTolerance;
    let target = el.scrollTop;
    if (activeRect.bottom > visibleBottom) {
        target += Math.ceil(activeRect.bottom - visibleBottom);
    } else if (activeRect.top < visibleTop) {
        target -= Math.ceil(visibleTop - activeRect.top);
    }
    const maxScroll = getTerminalMaxScroll(el);
    // P0-4 fix: row-height align so we do not fight fork _scrollToBottom.
    const rh = (term && typeof term.viewport !== "undefined" && term.viewport.rowHeight) || lineHeight || 17;
    const clamped = Math.floor(Math.max(0, Math.min(maxScroll, Math.round(target))) / rh) * rh;
    logTerminalScrollDiagnostics('mobile-stable:active-line-target', {
        reason,
        currentTop: Math.round(el.scrollTop || 0),
        target: clamped,
        maxScroll,
        activeTop: Math.round(activeRect.top),
        activeBottom: Math.round(activeRect.bottom),
        visibleTop: Math.round(visibleTop),
        visibleBottom: Math.round(visibleBottom),
    });
    return clamped;
}

function ensureMobileStableCursorVisible(reason = 'mobile-stable-visible') {
    // LEGACY PATH DISABLED as a scroll writer.
    // All mobile pin geometry goes through applyCursorAboveChromeScroll
    // (viewport-relative, rAF-coalesced, single writer). Calling the old
    // overlap/maxStep stepper in parallel is a primary cause of cursor flying.
    if (!isMobileStableInputMode()) return false;
    const label = String(reason || '');
    const sameLine = /beforeinput|input-fallback|composition|sent-visible|typing|printable/.test(label.toLowerCase())
        && !/enter|return|paste|control|keypad|command-box/.test(label.toLowerCase());
    return applyCursorAboveChromeScroll(reason, {
        force: isMobileStableActualInputReason(label) && !sameLine,
        sameLineInput: sameLine,
    });
}

function imeTextEqual(a, b) {
    // Case-insensitive: Android Chinese IME often re-delivers Latin via
    // compositionend as "Kimi" after we already flushed "kimi" on Enter.
    return String(a || '').toLowerCase() === String(b || '').toLowerCase();
}

function imeLineAccNoteSent(text = '') {
    const payload = String(text || '');
    if (!payload) return;
    mobileImeLineAcc = `${mobileImeLineAcc || ''}${payload}`;
}

function imeLineAccClear(reason = '') {
    if (!mobileImeLineAcc) return;
    logTerminalLayoutDiagnostics?.('ime-line-acc-clear', {
        reason: String(reason || ''),
        len: mobileImeLineAcc.length,
    });
    mobileImeLineAcc = '';
}

/**
 * True when leftover is already fully on the current line (progressive
 * k+i+m+i or a prior full-word commit). English IME often re-inserts the
 * whole word into the proxy on first Enter → kimikimi without this check.
 *
 * Only exact / already-suffix matches. Do NOT treat leftover.endsWith(lineAcc)
 * as "already sent" — that would drop "kimi" after only "ki" was typed.
 */
function imeLeftoverAlreadyOnLine(leftover = '') {
    const b = String(leftover || '').toLowerCase();
    if (!b) return true;
    const a = String(mobileImeLineAcc || '').toLowerCase();
    if (!a) return false;
    return a === b || a.endsWith(b);
}

/**
 * Unsent suffix of leftover relative to lineAcc.
 * "kimi" after progressive "ki" → "mi"; after full "kimi" → "".
 */
function imeLeftoverDelta(leftover = '') {
    const raw = String(leftover || '');
    if (!raw) return '';
    const b = raw.toLowerCase();
    const a = String(mobileImeLineAcc || '').toLowerCase();
    if (!a) return raw;
    if (a === b || a.endsWith(b)) return '';
    if (b.startsWith(a)) return raw.slice(String(mobileImeLineAcc || '').length);
    return raw;
}

function imeTextAlreadySent(text, windowMs = 900) {
    const payload = String(text || '');
    if (!payload) return false;
    const now = performance.now();
    if (mobileImeLastSent.text
        && imeTextEqual(mobileImeLastSent.text, payload)
        && now - mobileImeLastSent.at < windowMs) {
        return true;
    }
    if (mobileImeLastComposedText
        && imeTextEqual(mobileImeLastComposedText, payload)
        && now < mobileImeComposeSuppressUntil) {
        return true;
    }
    // Progressive "kimi" then Enter leftover "kimi" (IME re-fill).
    if (imeLeftoverAlreadyOnLine(payload)) return true;
    return false;
}

function sendMobileStableImeText(text = '', source = 'mobile-ime', { paste = false, forceImmediate = false } = {}) {
    let payload = String(text || '');
    if (!payload) return false;
    // Ctrl modifier: convert typed character to control code and release the modifier.
    if (!paste && modifierState.ctrl && payload.length === 1 && payload >= 'a' && payload <= 'z') {
        payload = String.fromCharCode(payload.charCodeAt(0) - 96);
        modifierState.ctrl = false;
        const ctrlBtn = document.querySelector('.aux-key[data-key="ctrl"], .modifier[data-key="ctrl"]');
        if (ctrlBtn) ctrlBtn.classList.remove('aux-active', 'active');
        return sendMobileStableControl(payload, `${source}:ctrl`);
    }

    const now = performance.now();
    const isComposeCommit = forceImmediate || /composition|compose-commit/i.test(source);
    // Dedup re-deliveries of the *same already-sent* payload (kimikimi).
    // forceImmediate / composition commits skip the "last composed" pre-check
    // because commitComposedImeText arms suppress only AFTER a successful send.
    // Case-insensitive: compositionend "Kimi" after Enter flush "kimi".
    const duplicateWindow = paste ? 320 : (payload.length > 1 ? 320 : 100);
    if (mobileImeLastSent.text
        && imeTextEqual(mobileImeLastSent.text, payload)
        && now - mobileImeLastSent.at < duplicateWindow) {
        return false;
    }
    if (
        !isComposeCommit
        && mobileImeLastComposedText
        && imeTextEqual(payload, mobileImeLastComposedText)
        && now < mobileImeComposeSuppressUntil
    ) {
        return false;
    }
    mobileImeLastSent = { text: payload, source, at: now };
    mobileStableLastActualInputAt = Date.now();
    mobileStableTypingUntil = Date.now() + (paste || isComposeCommit ? 260 : 180);
    mobileStableSuppressScrollUntil = Math.max(mobileStableSuppressScrollUntil, Date.now() + 180);
    cancelTerminalBottomFollow(`${source}:typing`);
    cancelMobileStableScrollRestore(`${source}:typing`);
    clearMobileTerminalHistoryLock(`${source}:input`);
    // Composition commit and paste: stick bottom so the user sees the glyphs.
    sendData(paste ? prepareTerminalPastePayload(payload) : payload, {
        source,
        forceFollow: !!(paste || isComposeCommit),
        applyModifiers: false,
    });
    // Track pre-Enter line so leftover flush cannot re-send progressive text.
    if (!paste) imeLineAccNoteSent(payload);
    const surface = ensureTerminalSurface();
    if (paste || isComposeCommit) {
        if (surface && isMobileStableInputMode()) {
            surface.onUserInputCommitted?.(payload, source, { paste: !!paste });
        } else if (paste) {
            applyPolicyScrollAfterPaste(`${source}:paste`);
        }
    }
    return true;
}
 
/**
 * Android IME frequently leaves isComposing/compositionstart stuck after
 * committing English/Latin words (e.g. "kimi") without compositionend.
 * While mobileImeComposing is true, keydown Enter and beforeinput are blocked
 * → user cannot press Enter and further input appears frozen.
 *
 * quiet=true: clear local flags only. Do NOT call handleCompositionEnd /
 * onCompositionEnd — those publish facade state and can re-apply physical
 * keyboard height → bottom bar flies mid-screen (especially on Enter).
 */
function clearStuckImeComposition(reason = 'compose-clear', { commit = false, quiet = false, keepValue = false } = {}) {
    if (mobileImeComposeWatchdog) {
        window.clearTimeout(mobileImeComposeWatchdog);
        mobileImeComposeWatchdog = 0;
    }
    if (!mobileImeComposing && !(mobileImeProxy?.value)) return '';
    const leftover = String(mobileImeProxy?.value || '');
    mobileImeComposing = false;
    mobileImeComposingAt = 0;
    if (!quiet) {
        try { ensureSshKeyboard()?.handleCompositionEnd?.(); } catch (_) {}
        try { ensureTerminalSurface()?.onCompositionEnd?.(); } catch (_) {}
    }
    // keepValue: only drop the stuck flag so a following input event can flush.
    if (!keepValue && mobileImeProxy) mobileImeProxy.value = '';
    if (commit && leftover) {
        mobileImeLastComposedText = leftover;
        mobileImeComposeSuppressUntil = performance.now() + 900;
    }
    logTerminalLayoutDiagnostics?.('ime-compose-clear', {
        reason,
        leftoverLen: leftover.length,
        commit: !!commit,
        quiet: !!quiet,
        keepValue: !!keepValue,
    });
    return commit ? leftover : '';
}

/**
 * Single Enter path while IME is (or was) composing.
 * - Unsticks mobileImeComposing without chrome publish (quiet).
 * - Flushes leftover only if not already on the current line (prevents first
 *   English-word kimikimi when IME re-fills proxy after progressive send).
 * - Sends one CR. Never double-sends text or CR.
 * - Does not touch facade / aux / parent shell geometry.
 */
function flushMobileImeEnter(source = 'mobile-ime-enter') {
    const leftover = String(mobileImeProxy?.value || '');
    const wasComposing = !!mobileImeComposing;
    // Quiet clear: no handleCompositionEnd → no applyFacadeChrome (bar fly).
    clearStuckImeComposition(`${source}:stuck-clear`, { commit: false, quiet: true });
    // English first-word: progressive k+i+m+i already on PTY; IME re-fills
    // proxy with "kimi" → send only unsent delta (usually empty).
    const delta = imeLeftoverDelta(leftover);
    if (delta && !imeTextAlreadySent(delta, 900)) {
        sendMobileStableImeText(delta, `${source}:flush`);
        mobileImeLastComposedText = leftover || delta;
        mobileImeComposeSuppressUntil = performance.now() + 900;
    } else if (leftover) {
        logTerminalLayoutDiagnostics?.('ime-enter-leftover-skip', {
            source,
            leftoverLen: leftover.length,
            deltaLen: delta.length,
            wasComposing,
            lineAccLen: (mobileImeLineAcc || '').length,
            preview: leftover.slice(0, 16),
        });
    }
    if (mobileImeProxy) mobileImeProxy.value = '';
    // Swallow a late compositionend that Android may still fire after Enter.
    mobileImeEnterSuppressCompositionEndUntil = performance.now() + 900;
    sendMobileStableControl('\r', source);
    return true;
}

function armImeComposeWatchdog() {
    if (mobileImeComposeWatchdog) window.clearTimeout(mobileImeComposeWatchdog);
    // While focused, keep waiting — user may still be on the OS 选词 strip.
    mobileImeComposeWatchdog = window.setTimeout(() => {
        mobileImeComposeWatchdog = 0;
        if (!mobileImeComposing) return;
        try {
            if (document.activeElement === mobileImeProxy) {
                armImeComposeWatchdog();
                return;
            }
            if (!(mobileImeProxy?.value || '').length) {
                clearStuckImeComposition('compose-watchdog-empty', { commit: false });
            }
        } catch (_) {}
    }, 8000);
}

function commitComposedImeText(text, source = 'mobile-ime-composition') {
    // Prefer explicit compositionend data; fall back to proxy buffer if IME
    // left the final glyphs there with empty e.data (common on some Android IMEs).
    let payload = String(text || '');
    if (!payload && mobileImeProxy?.value) {
        payload = String(mobileImeProxy.value || '');
    }
    mobileImeComposing = false;
    mobileImeComposingAt = 0;
    if (mobileImeComposeWatchdog) {
        window.clearTimeout(mobileImeComposeWatchdog);
        mobileImeComposeWatchdog = 0;
    }
    if (mobileImeProxy) mobileImeProxy.value = '';
    if (!payload) {
        logTerminalLayoutDiagnostics?.('ime-compose-empty', { source });
        return false;
    }
    // Late compositionend after Enter already flushed the same Latin word → drop.
    if (imeTextAlreadySent(payload, 900)) {
        logTerminalLayoutDiagnostics?.('ime-compose-dup-drop', {
            source,
            preview: payload.slice(0, 16),
        });
        mobileImeLastComposedText = payload;
        mobileImeComposeSuppressUntil = performance.now() + 900;
        return false;
    }
    // CRITICAL: send FIRST, then arm suppress. Setting suppress before send
    // made sendMobileStableImeText drop the first commit → 选了「你好」终端空白.
    const ok = sendMobileStableImeText(payload, source, { forceImmediate: true });
    mobileImeLastComposedText = payload;
    mobileImeComposeSuppressUntil = performance.now() + 900;
    logTerminalLayoutDiagnostics?.('ime-compose-commit', {
        source,
        len: payload.length,
        ok: !!ok,
        preview: payload.slice(0, 16),
    });
    return ok;
}

function isImeCompositionActive(e) {
    if (mobileImeComposing) return true;
    if (e && (e.isComposing || e.keyCode === 229 || e.key === 'Process')) return true;
    return false;
}

function sendMobileStableControl(seq = '', source = 'mobile-ime-control') {
    const payload = String(seq || '');
    if (!payload) return false;
    const now = performance.now();
    if (mobileImeLastControl.seq === payload && mobileImeLastControl.source !== source && now - mobileImeLastControl.at < 90) {
        return false;
    }
    // Never invent a commit from leftover composition text here.
    // Real CJK commit is only compositionend → commitComposedImeText.
    // Enter leftover flush is owned by flushMobileImeEnter (quiet, single path).
    const isEnterLike = payload === '\r' || /enter|return/i.test(source);
    if (mobileImeComposing && isEnterLike) {
        // Quiet: no handleCompositionEnd → no facade re-apply (bar fly).
        clearStuckImeComposition(`${source}:pre-control`, { commit: false, quiet: true });
    }
    mobileImeLastControl = { seq: payload, source, at: now };
    mobileStableLastActualInputAt = Date.now();

    mobileStableTypingUntil = Date.now() + (isEnterLike ? 40 : 160);
    mobileStableSuppressScrollUntil = Math.max(mobileStableSuppressScrollUntil, Date.now() + 160);
    cancelTerminalBottomFollow(`${source}:control`);
    cancelMobileStableScrollRestore(`${source}:control`);
    clearMobileTerminalHistoryLock(`${source}:control`);
    sendData(payload, { source, forceFollow: false, applyModifiers: false });
    // Keep lineAcc aligned with PTY: BS pops one code unit (Latin path).
    if (payload === '\x7f' || payload === '\b') {
        if (mobileImeLineAcc) mobileImeLineAcc = mobileImeLineAcc.slice(0, -1);
    }
    const surface = ensureTerminalSurface();
    if (isEnterLike) {
        // New shell line — progressive buffer no longer applies.
        imeLineAccClear(`${source}:enter`);
        clearMobileTerminalHistoryLock(`${source}:enter`);
        setTerminalAutoFollow(true, `${source}:enter`);
        if (surface && isMobileStableInputMode()) surface.onEnterCommitted?.(source);
        else if (typeof term?.bridge?.scrollToBottom === 'function') term.bridge.scrollToBottom();
        else applyCursorAboveChromeScroll(`${source}:enter`, { force: true, sameLineInput: false });
    }
    return true;
}
 
function restoreMobileStableScrollTop(previousTop = 0, reason = 'restore-scroll') {
    // No delayed scrollTop restore. It was a second writer at 0/80/180/360ms
    // and directly fought Surface chrome-pin, producing cursor jumps/flicker.
    // Browser preserves current history position; following state uses surface pin.
    if (!isMobileStableInputMode()) return;
    if (terminalAutoFollowEnabled || mobileStableLastBottomIntent || isMobileStableAtVisualBottom()) {
        ensureTerminalSurface()?.pinCursorAboveChrome?.(`${reason}:following`, { force: true });
    }
    scheduleTerminalScrollbarUpdate();
}


function rememberMobileStableKeyboardGrid(reason = 'mobile-keyboard-open-grid') {
    if (!isMobileStableInputMode() || !term) return null;
    const cols = Math.floor(Number(term.cols ?? term.bridge?.getCols?.() ?? lastSentTerminalSize.cols ?? 0));
    const rows = Math.floor(Number(term.rows ?? term.bridge?.getRows?.() ?? lastSentTerminalSize.rows ?? 0));
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 20 || rows < 2) return null;
    mobileStableKeyboardOpenGrid = {
        cols,
        rows,
        sentCols: lastSentTerminalSize.cols || cols,
        sentRows: lastSentTerminalSize.rows || rows,
        at: Date.now(),
        reason,
    };
    logTerminalLayoutDiagnostics('mobile-stable-grid:remember', mobileStableKeyboardOpenGrid);
    return mobileStableKeyboardOpenGrid;
}

function restoreMobileStableKeyboardGrid(reason = 'mobile-stable-grid-restore') {
    // Soft keyboard must never change buffer rows/cols. Grid "repair" that
    // re-resized was a primary flicker source. No-op by design.
    logTerminalLayoutDiagnostics?.('mobile-stable-grid:restore-skipped', {
        reason,
        policy: 'viewport-shell-only',
        rows: Number(term?.rows || term?.bridge?.getRows?.() || 0),
        cols: Number(term?.cols || term?.bridge?.getCols?.() || 0),
    });
    return false;
}

function scheduleMobileStableKeyboardGridRepair(reason = 'mobile-stable-grid-repair') {
    // Cancel any queued multi-phase repair timers from older paths.
    if (Array.isArray(mobileStableKeyboardGridRepairTimers)) {
        mobileStableKeyboardGridRepairTimers.forEach((timer) => window.clearTimeout(timer));
        mobileStableKeyboardGridRepairTimers = [];
    }
    logTerminalLayoutDiagnostics?.('mobile-stable-grid:repair-disabled', { reason });
}
 
/**
 * Mobile IME host: a normal browser textarea (invisible).
 * No custom virtual compose UI — system IME owns 拼音/选词 completely.
 * We only collect final text and send it to the PTY so the terminal shows it.
 */
let imeProxyAnchorRaf = 0;
let imeProxyComposeOrigin = null;

function scheduleImeProxyCursorAnchor(reason = 'cursor-anchor') {
    if (!isMobileStableInputMode()) return;
    // Keep host geometry stable during composition (moving it drops OS candidates).
    if (mobileImeComposing && reason !== 'compositionstart' && reason !== 'compositionend' && reason !== 'force') {
        return;
    }
    if (imeProxyAnchorRaf) return;
    imeProxyAnchorRaf = requestAnimationFrame(() => {
        imeProxyAnchorRaf = 0;
        anchorImeProxyToCursor(reason);
    });
}

function anchorImeProxyToCursor(reason = 'cursor-anchor') {
    if (!mobileImeProxy || !isMobileStableInputMode()) return;
    const scrollEl = getTerminalScrollElement();
    const hostRect = scrollEl?.getBoundingClientRect?.()
        || terminalContainer?.getBoundingClientRect?.()
        || { top: 0, left: 0, width: window.innerWidth || 320, height: 200 };
    const metrics = getCursorContentMetrics?.();
    const { lineHeight, charWidth } = getTerminalCharMetrics?.() || { lineHeight: 20, charWidth: 10 };
    const topInViewport = Number.isFinite(metrics?.cursorTopInViewport) ? metrics.cursorTopInViewport : Math.max(0, (hostRect.height || 0) - 28);
    let leftInViewport = 0;
    try {
        const cursor = term?.bridge?.getCursor?.() || term?.getCursor?.();
        if (cursor && Number.isFinite(cursor.col)) leftInViewport = cursor.col * (charWidth || 10);
    } catch (_) {}

    let cssTop = Math.round((hostRect.top || 0) + topInViewport);
    let cssLeft = Math.round((hostRect.left || 0) + Math.max(0, leftInViewport));
    if (mobileImeComposing) {
        if (!imeProxyComposeOrigin || reason === 'compositionstart') {
            imeProxyComposeOrigin = { top: cssTop, left: cssLeft };
        } else {
            cssTop = imeProxyComposeOrigin.top;
            cssLeft = imeProxyComposeOrigin.left;
        }
    } else {
        imeProxyComposeOrigin = null;
    }

    // Invisible but real-sized host (browser search field style for the OS IME).
    // Users never see our box; they only see the system keyboard + 选词.
    const w = Math.max(160, Math.min(280, Math.round((hostRect.width || 280) * 0.55)));
    const h = Math.max(24, Math.round(lineHeight || 24));
    const s = mobileImeProxy.style;
    s.position = 'fixed';
    s.top = `${cssTop}px`;
    s.left = `${cssLeft}px`;
    s.bottom = 'auto';
    s.right = 'auto';
    s.width = `${w}px`;
    s.height = `${h}px`;
    s.minWidth = `${w}px`;
    s.minHeight = `${h}px`;
    s.maxWidth = `${w}px`;
    s.maxHeight = `${h}px`;
    s.fontSize = '16px';
    s.lineHeight = `${h}px`;
    s.opacity = '0';
    s.color = 'transparent';
    s.caretColor = 'transparent';
    s.background = 'transparent';
    s.border = '0';
    s.padding = '0';
    s.margin = '0';
    s.outline = 'none';
    s.resize = 'none';
    s.overflow = 'hidden';
    s.pointerEvents = 'none';
    s.zIndex = '5';
    s.webkitUserSelect = 'text';
    s.userSelect = 'text';
    mobileImeProxy.dataset.anchorReason = String(reason || '');
}

function setupMobileStableImeProxy() {
    if (!isMobileStableInputMode() || mobileImeProxy) return;
    // Plain browser textarea — same role as the search box in Chrome address bar.
    // No custom compose UI. System IME paints 拼音/选词; we only receive final text.
    const proxy = document.createElement('textarea');
    proxy.id = 'mobileTerminalImeProxy';
    proxy.className = 'mobile-terminal-ime-proxy';
    proxy.rows = 1;
    proxy.autocomplete = 'off';
    proxy.autocorrect = 'off';
    proxy.autocapitalize = 'off';
    proxy.inputMode = 'text';
    proxy.enterKeyHint = 'enter';
    proxy.spellcheck = false;
    proxy.readOnly = false;
    proxy.disabled = false;
    try { proxy.removeAttribute('lang'); } catch (_) {}
    proxy.setAttribute('aria-label', t('终端输入'));
    proxy.setAttribute('inputmode', 'text');
    proxy.setAttribute('enterkeyhint', 'enter');

    proxy.addEventListener('focus', () => {
        mobileTerminalSelectionMode = false;
        document.documentElement.classList.remove('terminal-selection-mode');
        setWTermImeActive(true, 'ime-proxy-focus');
        ensureSshKeyboard()?.handleImeFocus?.('ime-proxy-focus');
        markKeyboardFocusActive();
        try {
            if (sshKb?.desiredOpen?.() || sshSoftKeyboard?.desiredOpen?.() || isSshKbDesiredOpen()) {
                sshSoftKeyboard?.onProxyFocus?.('ime-proxy-focus');
            } else {
                sshSoftKeyboard?.onProxyFocus?.('ime-proxy-focus-unowned');
            }
        } catch (_) {}
        updateViewportInsets();
        scheduleImeProxyCursorAnchor('focus');
    });
    proxy.addEventListener('blur', () => {
        ensureSshKeyboard()?.handleImeBlur?.('ime-proxy-blur');
        window.setTimeout(() => {
            if (document.activeElement !== mobileImeProxy) setWTermImeActive(false, 'ime-proxy-blur');
        }, 200);
        markKeyboardFocusInactive();
        try { sshSoftKeyboard?.onProxyBlur?.('ime-proxy-blur'); } catch (_) {}
        updateViewportInsets();
    });

    // ---- System IME owns the whole composition (pinyin → candidates → 汉字) ----
    proxy.addEventListener('compositionstart', () => {
        mobileImeComposing = true;
        mobileImeComposingAt = Date.now();
        ensureSshKeyboard()?.handleCompositionStart?.();
        cancelTerminalBottomFollow('compositionstart');
        cancelMobileStableScrollRestore('compositionstart');
        mobileStableSuppressScrollUntil = Math.max(mobileStableSuppressScrollUntil, Date.now() + 8000);
        ensureTerminalSurface()?.onCompositionStart?.();
        armImeComposeWatchdog();
        anchorImeProxyToCursor('compositionstart');
    });
    proxy.addEventListener('compositionupdate', () => {
        mobileImeComposing = true;
        mobileImeComposingAt = Date.now();
        armImeComposeWatchdog();
        // No value write, no re-anchor — browser + OS IME own the buffer/UI.
    });
    proxy.addEventListener('compositionend', (e) => {
        // Enter already unstuck + flushed Latin (kimi) — drop late end (kimikimi).
        // Real CJK 选词 always lands here first; Enter-after-选词 does not re-enter compose.
        if (performance.now() < mobileImeEnterSuppressCompositionEndUntil) {
            mobileImeComposing = false;
            mobileImeComposingAt = 0;
            if (mobileImeProxy) mobileImeProxy.value = '';
            imeProxyComposeOrigin = null;
            logTerminalLayoutDiagnostics?.('ime-compose-end-swallowed', {
                reason: 'post-enter-suppress',
                dataLen: e?.data != null ? String(e.data).length : 0,
            });
            return;
        }
        ensureSshKeyboard()?.handleCompositionEnd?.();
        ensureTerminalSurface()?.onCompositionEnd?.();
        mobileStableSuppressScrollUntil = Math.max(mobileStableSuppressScrollUntil, Date.now() + 120);
        // Final chosen text only (e.g. "你好"). Empty = cancel.
        const text = (e && e.data != null) ? String(e.data) : '';
        commitComposedImeText(text, 'mobile-ime-composition');
        imeProxyComposeOrigin = null;
        scheduleImeProxyCursorAnchor('compositionend');
    });

    // Controls: during 选词 Space/Backspace stay with OS IME.
    // Enter escapes ONLY when our compose flag is stuck but the key event is
    // not a live IME composition (isComposing/229/Process). Live 选词 Enter
    // must stay with the OS so candidate confirm is not turned into pinyin+CR.
    proxy.addEventListener('keydown', (e) => {
        if (isModifierOnlyKeyEvent(e)) return;
        if (isImeCompositionActive(e)) {
            if (e.key === 'Enter') {
                const liveCompose = !!(e.isComposing || e.keyCode === 229 || e.key === 'Process');
                // Stuck flag after Latin (kimi) without compositionend: event is a
                // normal Enter (keyCode 13), but mobileImeComposing stayed true.
                if (mobileImeComposing && !liveCompose) {
                    e.preventDefault();
                    e.stopPropagation();
                    flushMobileImeEnter('mobile-ime-key:Enter');
                    return;
                }
                // Live OS composition / 选词: do not steal Enter.
                armImeComposeWatchdog();
                return;
            }
            armImeComposeWatchdog();
            return; // system IME handles candidate confirm (Space / 数字键)
        }
        const seqMap = {
            Enter: '\r',
            Backspace: '\x7f',
            Tab: '\t',
            Escape: '\x1b',
            ArrowUp: '\x1b[A',
            ArrowDown: '\x1b[B',
            ArrowLeft: '\x1b[D',
            ArrowRight: '\x1b[C',
            Home: '\x1b[1~',
            End: '\x1b[4~',
            PageUp: '\x1b[5~',
            PageDown: '\x1b[6~',
            Delete: '\x1b[3~',
        };
        const seq = seqMap[e.key];
        if (!seq) return;
        if (e.key === 'Enter') {
            e.preventDefault();
            // Single path (same as stuck-compose Enter) — one flush + one CR.
            flushMobileImeEnter('mobile-ime-key:Enter');
            return;
        }
        if (e.key === 'Backspace' && proxy.value) {
            // Let browser edit local buffer; plain English buffer before flush.
            return;
        }
        e.preventDefault();
        sendMobileStableControl(seq, `mobile-ime-key:${e.key}`);
        proxy.value = '';
    });

    // Do NOT preventDefault insertText — that is what lets the OS IME run 选词.
    proxy.addEventListener('beforeinput', (e) => {
        const type = e.inputType || '';
        const liveCompose = !!(e && (e.isComposing || e.keyCode === 229 || /Composition/i.test(type)));
        // Stuck flag but event is plain typing → quiet unstick so input is not frozen.
        // keepValue: do not wipe proxy; following input/enter will flush leftover.
        if (mobileImeComposing && !liveCompose && (type === 'insertText' || type === 'deleteContentBackward'
            || type === 'insertLineBreak' || type === 'insertParagraph')) {
            clearStuckImeComposition('beforeinput:unstick', { commit: false, quiet: true, keepValue: true });
        }
        if (
            type === 'insertText'
            || type === 'insertCompositionText'
            || type === 'deleteCompositionText'
            || type === 'insertFromComposition'
            || type === 'deleteByComposition'
            || isImeCompositionActive(e)
        ) {
            if (isImeCompositionActive(e) || /Composition/i.test(type)) armImeComposeWatchdog();
            return; // browser keeps the text
        }
        if (type === 'insertFromPaste') {
            const text = e.dataTransfer?.getData?.('text/plain') || e.data || '';
            if (text) {
                e.preventDefault();
                sendMobileStableImeText(text, 'mobile-ime-paste', { paste: true });
                proxy.value = '';
            }
            return;
        }
        if (type === 'deleteContentBackward') {
            if (proxy.value) return; // browser deletes local buffer
            e.preventDefault();
            sendMobileStableControl('\x7f', 'mobile-ime-backspace');
            return;
        }
        if (type === 'insertLineBreak' || type === 'insertParagraph') {
            e.preventDefault();
            // Same single Enter path as keydown (stuck compose + leftover + one CR).
            flushMobileImeEnter('mobile-ime-enter');
        }
    });

    // After OS finishes (or plain ASCII typing): push to PTY, terminal echo shows it.
    proxy.addEventListener('input', (e) => {
        const liveCompose = !!(e && e.isComposing);
        if (mobileImeComposing && !liveCompose) {
            // Flag stuck after Latin without compositionend — quiet unstick, keep buffer.
            clearStuckImeComposition('input:unstick', { commit: false, quiet: true, keepValue: true });
        }
        if (isImeCompositionActive()) {
            armImeComposeWatchdog();
            return;
        }
        const text = proxy.value || '';
        if (!text) return;
        // Case-insensitive: drop re-delivery after Enter flush / compositionend.
        if (imeTextAlreadySent(text, 900)) {
            proxy.value = '';
            return;
        }
        sendMobileStableImeText(text, 'mobile-ime-input');
        proxy.value = '';
    });

    proxy.addEventListener('paste', (e) => {
        const text = e.clipboardData?.getData?.('text/plain') || '';
        if (!text) return;
        e.preventDefault();
        sendMobileStableImeText(text, 'mobile-ime-paste-event', { paste: true });
        proxy.value = '';
    });

    document.body.appendChild(proxy);
    mobileImeProxy = proxy;
    const textarea = term?.input?.textarea;
    if (textarea) {
        textarea.setAttribute('readonly', 'readonly');
        textarea.setAttribute('tabindex', '-1');
        textarea.style.pointerEvents = 'none';
    }
    scheduleImeProxyCursorAnchor('ime-proxy-created');
}

function setupTerminalScrollHooks({ followOnConnect = true } = {}) {
    stopTerminalAutoScrollObserver();
    resetTerminalScrollState();
    setTerminalAutoFollow(!!followOnConnect, 'connect-init');

    const onScroll = () => {
        updateTerminalAutoFollowFromScroll('user-scroll');
        // Toggle scrolling class to prevent text selection during active scroll
        if (isMobileStableInputMode()) {
            const el = getTerminalScrollElement();
            if (el) {
                el.classList.add('is-scrolling');
                window.clearTimeout(onScroll._clearTimer);
                onScroll._clearTimer = window.setTimeout(() => el.classList.remove('is-scrolling'), 220);
            }
        }
        scheduleTerminalScrollbarUpdate();
    };

    const onWheel = (e) => {
        if (sendTerminalMouseWheelEvent(e)) {
            e.preventDefault();
            return;
        }
        if (sendTerminalAltScroll(e.deltaY)) {
            e.preventDefault();
            return;
        }
        // xterm-owned history: wterm._onVirtualWheel already scrolls + stopPropagation
        // on the .wterm element. Only drive ydisp from the host when the event did
        // NOT originate inside .wterm (wrapper/chrome), or wterm listener is absent.
        const fromWtermEl = !!(e.target && term?.element && (term.element === e.target || term.element.contains?.(e.target)));
        if (fromWtermEl && term?.element?.classList?.contains('xterm-viewport')
            && typeof term.bridge?.scrollLines === 'function') {
            // wterm owns this path — do not double-scroll (double mark dirty → jank).
            terminalLastWheelAt = Date.now();
            return;
        }
        if (term?.element?.classList?.contains('xterm-viewport') || term?.bridge?.virtualViewport
            || typeof term?.bridge?.scrollLines === 'function') {
            e.preventDefault();
            const rh = Math.max(1, term?.getViewportState?.()?.rowHeight
                || getTerminalCharMetrics?.()?.lineHeight
                || 17);
            let lines = 0;
            if (e.deltaMode === 1) lines = e.deltaY;
            else if (e.deltaMode === 2) lines = e.deltaY * Math.max(1, (term?.rows || 24) - 1);
            else lines = e.deltaY / rh;
            const amount = lines > 0 ? Math.max(1, Math.round(lines)) : lines < 0 ? Math.min(-1, Math.round(lines)) : 0;
            if (amount) scrollTerminalHistoryLines(amount, 'wheel');
            terminalLastWheelAt = Date.now();
            return;
        }
        terminalLastWheelAt = Date.now();
        if (isMobileStableInputMode()) terminalUserScrollGestureUntil = Date.now() + 1400;
        scheduleTerminalScrollbarUpdate();
    };
 
    let resizeObserver = null;
    if (window.ResizeObserver) {
        resizeObserver = new ResizeObserver(() => {
            // 模仿 xterm.js：尺寸/内容变化时，如果用户原本在底部才跟随；历史区阅读时不抢滚动。
            if (terminalAutoFollowEnabled || isMobileStableAtVisualBottom()) {
                requestTerminalAutoFollow('resize-observer-follow');
            } else {
                scheduleTerminalScrollbarUpdate();
            }
        });
        resizeObserver.observe(wtermWrapper);
        const grid = wtermWrapper.querySelector('.term-grid');
        if (grid) resizeObserver.observe(grid);
    }

    wtermWrapper.addEventListener('scroll', onScroll, { passive: true });
    wtermWrapper.addEventListener('wheel', onWheel, { passive: false, capture: true });

    setupTerminalCustomScrollbar();
    terminalScrollCleanup = () => {
        wtermWrapper.removeEventListener('scroll', onScroll);
        wtermWrapper.removeEventListener('wheel', onWheel, { capture: true });
        resizeObserver?.disconnect();
    };

    scheduleTerminalScrollbarUpdate();
}

function isModifierOnlyKeyEvent(e) {
    return ['Alt', 'Control', 'Meta', 'Shift', 'CapsLock'].includes(e.key);
}

function setupTerminalInputActivityHooks() {
    // 以官方 @wterm/dom 行为为准：不要在外层监听 keydown 并滚动。
    // WTerm 的 InputHandler 会在输入 onData 前执行内部滚动；外层再次滚动会造成输入上下跳动。
}

function setupTerminalCustomScrollbar() {
    if (!terminalScrollbar || !terminalScrollbarThumb || terminalScrollbar._zephyrReady) return;
    terminalScrollbar._zephyrReady = true;

    const setScrollFromClientY = (clientY) => {
        const el = getTerminalScrollElement();
        const maxScroll = getTerminalMaxScroll(el);
        if (!el || maxScroll <= 0) return;
        const rect = terminalScrollbar.getBoundingClientRect();
        const thumbHeight = terminalScrollbarThumb.getBoundingClientRect().height || TERMINAL_SCROLLBAR_MIN_THUMB;
        const ratio = Math.min(1, Math.max(0, (clientY - rect.top - thumbHeight / 2) / Math.max(1, rect.height - thumbHeight)));
        if (isMobileStableInputMode()) terminalUserScrollGestureUntil = Date.now() + 1200;
        const xm = getXtermHistoryMetrics();
        if (xm?.active && typeof term?.bridge?.scrollToLine === 'function') {
            // ratio 0 = top of history (ydisp=0), 1 = bottom (ydisp=ybase)
            const target = Math.round(ratio * (xm.ybase | 0));
            try {
                term.bridge.scrollToLine(target);
                term._scheduleRender?.();
            } catch (_) {}
            const atBottom = isTerminalAtBottom(undefined, TERMINAL_XTERM_SCROLL_LOCK_THRESHOLD);
            if (atBottom) {
                clearMobileTerminalHistoryLock?.('scrollbar-drag:bottom');
                setTerminalAutoFollow?.(true, 'scrollbar-drag:bottom');
            } else {
                lockMobileTerminalAutoFollow?.('scrollbar-drag:history', 2400);
                setTerminalAutoFollow?.(false, 'scrollbar-drag:history');
                try {
                    (term?.element || wtermWrapper)?.style?.setProperty?.('--term-active-line-shift', '0px');
                } catch (_) {}
            }
            scheduleTerminalScrollbarUpdate();
            return;
        }
        isProgrammaticTerminalScroll = true;
        writeTerminalScrollTop(el, ratio * maxScroll, 'scrollbar-drag', { pin: true });
        scheduleTerminalScrollbarUpdate();
        requestAnimationFrame(() => { isProgrammaticTerminalScroll = false; });
    };
 
    terminalScrollbar.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        terminalScrollbar.classList.add('dragging');
        terminalScrollbar.setPointerCapture?.(e.pointerId);
        setScrollFromClientY(e.clientY);
        const onMove = (ev) => {
            ev.preventDefault();
            setScrollFromClientY(ev.clientY);
        };
        const onUp = () => {
            terminalScrollbar.classList.remove('dragging');
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            if (!isTouchKeyboardDevice()) term?.focus?.();
        };
        window.addEventListener('pointermove', onMove, { passive: false });
        window.addEventListener('pointerup', onUp, { once: true });
    }, { passive: false });
}

function getFallbackKeyboardMetrics() {
    const layoutHeight = getKeyboardBaselineHeight() || Math.round(window.innerHeight || document.documentElement.clientHeight || 720);
    const keyboardInset = getEstimatedKeyboardInset();
    return {
        layoutHeight,
        viewportHeight: Math.max(240, layoutHeight - keyboardInset),
        offsetTop: 0,
        keyboardInset,
        keyboardOpen: true,
        wantsAvoidance: true,
        fallback: true,
    };
}

function applyKeyboardFallbackAvoidance() {
    if (!isTouchKeyboardDevice()) return false;
    const kb = ensureSshKeyboard();
    // Never invent open/height. Only refine when live visualViewport reports real inset.
    if (!kb?.desiredOpen?.()) return false;
    let live = 0;
    try {
        const m = getViewportKeyboardMetrics();
        if (m.keyboardOpen && m.keyboardInset >= 80) live = m.keyboardInset;
    } catch (_) {}
    if (live < 80) return false;
    kb._intent?.syncViewport?.({
        inset: live,
        hasEditableFocus: isEditableKeyboardTarget(document.activeElement),
        now: Date.now(),
    });
    applyFacadeChrome('keyboard-fallback-applied');
    keyboardFallbackActive = true;
    keyboardFallbackAppliedAt = performance.now();
    scheduleTerminalScrollbarUpdate();
    return true;
}

function scheduleKeyboardFallbackAvoidance() {
    if (!isTouchKeyboardDevice()) return;
    // Stable path: facade owns physical detection via visualViewport listeners.
    if (isMobileStableInputMode()) return;
    if (!isSshKbDesiredOpen()) return;
    window.clearTimeout(keyboardFallbackTimer);
    keyboardFallbackTimer = window.setTimeout(() => {
        if (!isSshKbDesiredOpen()) return;
        // Only apply estimated inset if facade still has no physical open.
        if (isSshKbPhysicalOpen() || isSshKbLayoutOpen()) return;
        applyKeyboardFallbackAvoidance();
    }, 220);
}

function markKeyboardFocusActive() {
    keyboardViewportBaseline = Math.max(getKeyboardBaselineHeight(), keyboardViewportBaseline || 0);
    if (!isTouchKeyboardDevice()) return;
    // No open invent. Facade owns physical via viewport listeners.
    if (isMobileStableInputMode()) {
        keyboardFallbackActive = false;
        window.clearTimeout(keyboardFallbackTimer);
        ensureSshKeyboard()?.handleViewportChange?.('mark-focus-active');
        applyFacadeChrome('mark-focus-active');
        return;
    }
    updateViewportInsets();
}


function markKeyboardFocusInactive() {
    if (mobileClipboardActionInProgress) return;
    if (isMobileStableInputMode()) {
        ensureSshKeyboard()?.handleImeBlur?.('mark-focus-inactive');
        ensureSshKeyboard()?.handleViewportChange?.('mark-focus-inactive');
        applyFacadeChrome('mark-focus-inactive');
        return;
    }
    window.clearTimeout(keyboardFallbackTimer);
}


function updateViewportInsets() {
    if (embeddedMode && !isMobileStableInputMode()) return;
    if (mobileTerminalSelectionMode && !mobileClipboardActionInProgress) return;
    if (mobileClipboardActionInProgress) return;
    if (!isTouchKeyboardDevice()) return;

    if (isCmdOverlayMode()) {
        applyMobileStableKeyboardInset(0, false, 'cmd-overlay-freeze');
        notifyParentKeyboardMetrics({
            keyboardOpen: false,
            keyboardInset: 0,
            viewportHeight: Math.round(window.visualViewport?.height || window.innerHeight || 0),
            layoutHeight: Math.round(window.innerHeight || document.documentElement.clientHeight || 0),
            offsetTop: 0,
            liftMode: SoftKeyboardLiftMode.NONE,
            source: 'cmd',
            reason: 'cmd-overlay-freeze',
            forceNotify: true,
        });
        return;
    }

    const hiddenEmbeddedFrame = embeddedMode && window.innerWidth > 700 && isMobileStableInputMode();
    if (hiddenEmbeddedFrame) {
        if (sshKb?.desiredOpen?.() || isSshKbLayoutOpen()) finalizeKeyboardClose({ force: true });
        return;
    }

    // Sole path: facade sync + DOM projection. No independent open threshold.
    const kb = ensureSshKeyboard();
    if (!kb) return;
    kb.handleViewportChange('updateViewportInsets');
    applyFacadeChrome('updateViewportInsets');
}

function finalizeKeyboardClose({ force = false } = {}) {
    const kb = ensureSshKeyboard();
    if (kb) {
        kb.close(force ? 'finalize-force' : 'finalize', { force: !!force });
        applyFacadeChrome(force ? 'finalize-force' : 'finalize');
        // Always hard-clear shell geometry — do not leave residual inset.
        forceClearSshKbShell(force ? 'finalize-force' : 'finalize');
        return;
    }
    if (sshSoftKeyboard) {
        try { sshSoftKeyboard.close(force ? 'finalize-force' : 'finalize', { force: !!force }); } catch (_) {}
    }
    forceClearSshKbShell('keyboard-close-final');
}
 

function restoreMobileWTermNativeInput() {
    if (isMobileStableInputMode()) {
        setupMobileStableImeProxy();
        return;
    }
    if (!isTouchKeyboardDevice() || !term?.input?.textarea) return;
    const textarea = term.input.textarea;
    textarea.removeAttribute('readonly');
    textarea.setAttribute('tabindex', '0');
    textarea.removeAttribute('inputmode');
    textarea.style.pointerEvents = 'auto';
    textarea.style.webkitTextSecurity = '';
    if (mobileWTermInputGuard) {
        try { textarea.removeEventListener('focus', mobileWTermInputGuard.guard, true); } catch (_) {}
        try { textarea.removeEventListener('beforeinput', mobileWTermInputGuard.guard, true); } catch (_) {}
        try { textarea.removeEventListener('input', mobileWTermInputGuard.guard, true); } catch (_) {}
        try { wtermWrapper.removeEventListener('click', mobileWTermInputGuard.stopPointer, true); } catch (_) {}
        try { wtermWrapper.removeEventListener('pointerdown', mobileWTermInputGuard.stopPointer, true); } catch (_) {}
        try { wtermWrapper.removeEventListener('touchstart', mobileWTermInputGuard.stopPointer, true); } catch (_) {}
        if (mobileWTermInputGuard.originalFocus) term.focus = mobileWTermInputGuard.originalFocus;
        if (mobileWTermInputGuard.originalInputFocus) term.input.focus = mobileWTermInputGuard.originalInputFocus;
        mobileWTermInputGuard = null;
    }
}

function setupHorizontalScrollbarVisibility(...elements) {
    elements.filter(Boolean).forEach((el) => {
        let timer = 0;
        const show = () => {
            el.classList.add('scroll-active');
            window.clearTimeout(timer);
            timer = window.setTimeout(() => el.classList.remove('scroll-active'), 1100);
        };
        el.addEventListener('pointerdown', show, { passive: true });
        el.addEventListener('touchstart', show, { passive: true });
        el.addEventListener('wheel', show, { passive: true });
        el.addEventListener('scroll', show, { passive: true });
        el.addEventListener('mouseenter', show, { passive: true });
        el.addEventListener('mouseleave', () => {
            window.clearTimeout(timer);
            timer = window.setTimeout(() => el.classList.remove('scroll-active'), 260);
        }, { passive: true });
    });
}

/**
 * Single place that mirrors facade → legacy flags + DOM chrome.
 * Callers must NOT independently set isSshKbLayoutOpen() / apply inset for IME.
 */
function applyFacadeChrome(reason = 'mirror') {
    // Project facade → DOM. Parent-overlap is height authority when present.
    // overlays-content: measured inset is often 0 while IME is up — use estimate.
    // CLOSE is always allowed: never keep a stale inset after physical dismiss.
    const kb = sshKb || ensureSshKeyboard?.();
    if (!kb) return false;
    if (isCmdOverlayMode?.()) {
        applyMobileStableKeyboardInset(0, false, `${reason}:cmd-overlay`);
        return true;
    }
    const phase = kb.getPhase?.() || 'closed';
    const liftNone = kb.getLiftMode?.() === 'none' || kb.getLiftMode?.() === SoftKeyboardLiftMode.NONE;
    const desired = !!kb.desiredOpen?.();
    const physical = !!kb.physicalOpen?.();
    let inset = Math.max(0, Math.round(Number(kb.getInset?.() || 0) || 0));
    const proxyFocused = !!(document.activeElement === mobileImeProxy
        || document.activeElement?.classList?.contains?.('mobile-terminal-ime-proxy'));
    const parentAge = Date.now() - (_sshKbParentGeomAt || 0);
    const parentLive = !!_sshKbLayoutOpenCache && (_sshKbInsetCache || 0) >= 80 && parentAge < 500;
    // Only treat parent as "fresh open" for a short window while still desired.
    const parentFreshOpen = desired && parentAge < 280 && (_sshKbInsetCache || 0) >= 80;

    if (liftNone) {
        applyMobileStableKeyboardInset(0, false, `${reason}:facade-lift-none`);
        return true;
    }

    // Explicit closed phase / undesired: clear shell NOW.
    // Do NOT require !proxyFocused — Android often leaves focus for a tick after IME hides,
    // and waiting for blur left the half-height blank under tools.
    if (phase === 'closed' || (!desired && !physical)) {
        applyMobileStableKeyboardInset(0, false, `${reason}:facade-close`);
        return true;
    }

    // F2: desired open without physical yet is the NORMAL open path
    // (parent shell-managed crop delivers height later). Never self-close here.
    // Close authority: parent keyboard-overlap(close) or intent.close / system-dismiss.
    if (desired || phase === 'open' || phase === 'opening' || proxyFocused) {
        // Parent shell-managed is STICKY until force-clear / parent close.
        // Aux-key taps (↑ etc.) call retainFocus → applyFacadeChrome; if we then
        // write intent.physical inset into the child, the bar flies mid-screen.
        const parentShellManagedOpen = !!_sshKbParentShellManaged
            || (!!_sshKbLayoutOpenCache && parentAge < 8000 && (_sshKbInsetCache || 0) < 8);
        if (parentShellManagedOpen || parentLive || parentFreshOpen) {
            writeSshKbPageGeometry(0, true, { fromParent: true });
            _sshKbInsetCache = 0;
            return true;
        }
        // Standalone (no parent crop): may use real inset.
        if (inset < 64) inset = Math.max(inset, _sshKbInsetCache || 0);
        applyMobileStableKeyboardInset(inset, true, `${reason}:facade-open`);
        return true;
    }

    applyMobileStableKeyboardInset(0, false, `${reason}:facade-close`);
    return true;
}
 
/** @deprecated alias */
function syncLegacyKeyboardMirrorFromFacade(reason = 'mirror') {
    return applyFacadeChrome(reason);
}


function ensureSshKeyboard() {
    if (sshKb) return sshKb;
    if (!isTouchKeyboardDevice()) return null;
    sshKb = createSshKeyboard({
        isTouchDevice: () => isTouchKeyboardDevice(),
        isMobileStable: () => isMobileStableInputMode(),
        ensureProxy: () => {
            setupMobileStableImeProxy();
            return mobileImeProxy;
        },
        getViewportMetrics: () => getViewportKeyboardMetrics(),
        hasSelection: () => !!(hasLiveTerminalSelection?.() || mobileTerminalSelectionMode),
        isSelectionMode: () => !!(mobileTerminalSelectionMode || hasLiveTerminalSelection?.()),
        getTabId: () => params?.tabId || '',
        isEmbedded: () => !!embeddedMode,
        getDocument: () => document,
        onImeActive: (active, reason) => setWTermImeActive(!!active, reason || 'ssh-kb'),
        // Intent/layout changes → one mirror. No second judgment path.
        onLayout: (phase, inset, meta = {}) => {
            applyFacadeChrome(meta?.reason || `layout:${phase}`);
        },
        onStateChange: (state, reason = 'state') => {
            applyFacadeChrome(reason || 'state');
        },
        log: (event, details) => logTerminalLayoutDiagnostics?.(event, details || {}),
    });
    // Compat instance for surface / legacy call sites
    sshSoftKeyboard = sshKb.asSoftKeyboard();
    return sshKb;
}

function ensureSshSoftKeyboard() {
    // Single authority: SshKeyboard facade. Surface reuses the same instance.
    const kb = ensureSshKeyboard();
    if (!kb) return null;
    sshSoftKeyboard = kb.asSoftKeyboard();
    // Ensure surface exists and picks up injected keyboard
    ensureTerminalSurface();
    return sshSoftKeyboard;
}


function setupMobileKeyboardAvoidance() {
    enableMobileStableInputMode();
    // Boot keyboard facade FIRST (single authority), then surface reuses it.
    ensureSshKeyboard();
    ensureSshSoftKeyboard();
    ensureTerminalSurface();
    if (embeddedMode && !isMobileStableInputMode()) return;
    if (!window.visualViewport && !navigator.virtualKeyboard && !isTouchKeyboardDevice()) return;
    try {
        if (navigator.virtualKeyboard) navigator.virtualKeyboard.overlaysContent = true;
    } catch (_) {}

    const onViewport = (reason) => {
        updateViewportInsets();
    };

    // 如果 navigator.virtualKeyboard 不可用，用 window.resize 作为后备
    // （即使 overlays-content 下 visualViewport 不变化，某些 WebView 仍会触发 window.resize）
    window.visualViewport?.addEventListener('resize', () => onViewport('vv-resize'), { passive: true });
    window.addEventListener('resize', () => {
        if (!navigator.virtualKeyboard) {
            window.clearTimeout(setupMobileKeyboardAvoidance._windowResizeTimer);
            setupMobileKeyboardAvoidance._windowResizeTimer = window.setTimeout(() => onViewport('window-resize'), 40);
        }
    }, { passive: true });
    window.visualViewport?.addEventListener('scroll', () => onViewport('vv-scroll'), { passive: true });
    navigator.virtualKeyboard?.addEventListener?.('geometrychange', () => onViewport('vk-geometry'));

    document.addEventListener('focusin', (e) => {
        // Top command bar: always allow native focus. Never steal/blur it.
        if (e.target === cmdInput) {
            enterCmdOverlayMode('focusin-cmd');
            return;
        }
        if (e.target === mobileImeProxy) {
            // While command bar owns focus, ignore proxy focus races.
            if (isCmdOverlayMode() || document.activeElement === cmdInput) {
                try { e.target.blur?.(); } catch (_) {}
                return;
            }
            ensureSshKeyboard()?.handleImeFocus?.('focusin-proxy');
            sshSoftKeyboard?.onProxyFocus?.('focusin-proxy');
            applyFacadeChrome('focusin-proxy');
            return;
        }
        if (isKeyboardAvoidanceTarget(e.target)) markKeyboardFocusActive();
    }, true);
    document.addEventListener('focusout', (e) => {
        if (mobileClipboardActionInProgress) return;
        if (e.target === cmdInput) return; // handled by cmdInput blur
        if (e.target === mobileImeProxy) {
            if (isCmdOverlayMode()) return;
            ensureSshKeyboard()?.handleImeBlur?.('focusout-proxy');
            sshSoftKeyboard?.onProxyBlur?.('focusout-proxy');
            applyFacadeChrome('focusout-proxy');
            return;
        }
        if (isKeyboardAvoidanceTarget(e.target)) markKeyboardFocusInactive();
    }, true);

    cmdInput?.addEventListener('focus', () => {
        mobileTerminalSelectionMode = false;
        document.documentElement.classList.remove('terminal-selection-mode');
        window.clearTimeout(mobileTerminalSelectionRestoreTimer);
        // Layout-frozen overlay: only show system IME above the page. Zero geometry change.
        if (isTouchKeyboardDevice()) {
            enterCmdOverlayMode('cmd-input-focus');
            const surface = ensureTerminalSurface();
            ensureSshSoftKeyboard();
            if (surface) surface.onCmdFocus('cmd-input-focus');
            else {
                sshSoftKeyboard?.open?.('cmd-input-focus', {
                    gesture: true,
                    liftMode: SoftKeyboardLiftMode.NONE,
                });
            }
            // Keep real focus on the command textarea (open() no longer steals it).
            try {
                if (document.activeElement !== cmdInput) cmdInput.focus({ preventScroll: true });
            } catch (_) {
                try { cmdInput.focus(); } catch (__) {}
            }
            try { mobileImeProxy?.blur?.(); } catch (_) {}
        }
        // Re-assert frozen layout after any async viewport tick.
        [0, 80, 200, 480].forEach((delay) => window.setTimeout(() => {
            if (document.activeElement === cmdInput || cmdOverlayMode) {
                enterCmdOverlayMode(`cmd-input-focus:t${delay}`);
            }
        }, delay));
    });
    cmdInput?.addEventListener('blur', () => {
        // Leave overlay after a short settle so IME dismiss animation does not thrash.
        window.setTimeout(() => {
            if (document.activeElement === cmdInput) return;
            leaveCmdOverlayMode('cmd-input-blur');
            const surface = ensureTerminalSurface();
            if (surface) surface.onCmdBlur('cmd-input-blur');
            else if (sshSoftKeyboard?.getLiftMode?.() === SoftKeyboardLiftMode.NONE
                || sshSoftKeyboard?.desiredOpen?.()) {
                sshSoftKeyboard?.close?.('cmd-input-blur', { force: false, blurCmd: false });
            }
            // Only re-enter terminal keyboard path if IME proxy is actually focused.
            if (document.activeElement === mobileImeProxy) {
                updateViewportInsets();
            }
        }, 120);
    });
    updateViewportInsets();
}

function renderProcessRows(processes = []) {
    const q = processSearch.trim().toLowerCase();
    const sorted = Array.from(processes || []).filter((p) => {
        if (!q) return true;
        return String(p.pid).includes(q) || String(p.user || '').toLowerCase().includes(q) || String(p.command || '').toLowerCase().includes(q) || String(p.args || '').toLowerCase().includes(q);
    }).sort((a, b) => {
        if (processSort === 'mem') return safeVal(b.mem) - safeVal(a.mem);
        if (processSort === 'pid') return safeVal(a.pid) - safeVal(b.pid);
        return safeVal(b.cpu) - safeVal(a.cpu);
    }).slice(0, 60);
    if (!sorted.length) return `<div class="process-empty">${t('暂无进程数据')}</div>`;
    return sorted.map((p) => `
        <div class="process-row" data-pid="${p.pid}">
            <div class="process-main">
                <div class="process-name"><b>${escapeHtml(p.command || 'process')}</b><span>PID ${p.pid}</span></div>
                <div class="process-args">${escapeHtml(p.args || '')}</div>
                <div class="process-meta"><span>${escapeHtml(p.user || '-')}</span><span>${escapeHtml(p.stat || '-')}</span><span>CPU ${safeVal(p.cpu).toFixed(1)}%</span><span>MEM ${safeVal(p.mem).toFixed(1)}%</span></div>
            </div>
            <div class="process-actions">
                <button class="tool-btn" data-process-signal="TERM" data-pid="${p.pid}" ${processBusyPid === p.pid ? 'disabled' : ''}>${t('结束')}</button>
                <button class="tool-btn danger" data-process-signal="KILL" data-pid="${p.pid}" ${processBusyPid === p.pid ? 'disabled' : ''}>${t('强制')}</button>
            </div>
        </div>
    `).join('');
}
function renderProcessesPage(d = latestStatsData) {
    const processes = Array.isArray(d?.processes) ? d.processes : [];
    return `
        <div class="monitor-process-toolbar">
            <input id="processSearch" class="snippet-search process-search" placeholder="${t('搜索 PID / 用户 / 命令')}" value="${escapeHtml(processSearch)}">
            <select id="processSort" class="process-sort">
                <option value="cpu" ${processSort === 'cpu' ? 'selected' : ''}>CPU</option>
                <option value="mem" ${processSort === 'mem' ? 'selected' : ''}>${t('内存优先')}</option>
                <option value="pid" ${processSort === 'pid' ? 'selected' : ''}>PID</option>
            </select>
            <button class="tool-btn" id="processRefreshBtn">${t('刷新')}</button>
        </div>
        <div class="process-summary"><span>${processes.length} 个进程</span></div>
        <div class="process-list">${renderProcessRows(processes)}</div>
    `;
}
function bindProcessPageEvents() {
    $('#processSearch')?.addEventListener('input', (event) => { processSearch = event.target.value || ''; renderStats(latestStatsData); });
    $('#processSort')?.addEventListener('change', (event) => { processSort = event.target.value || 'cpu'; renderStats(latestStatsData); });
    $('#processRefreshBtn')?.addEventListener('click', () => wsConnection?.send?.(JSON.stringify({ type: 'stats-request' })));
    $$('.process-row [data-process-signal]').forEach((btn) => btn.addEventListener('click', () => {
        const pid = Number(btn.dataset.pid);
        const signal = btn.dataset.processSignal || 'TERM';
        if (!pid) return;
        if (signal === 'KILL' && !confirm(t('确定强制结束进程 {pid}？', { pid }))) return;
        processBusyPid = pid;
        renderStats(latestStatsData);
        wsConnection?.send?.(JSON.stringify({ type: 'process-signal', pid, signal }));
    }));
}
function updateMonitorTabThumb({ immediate = false } = {}) {
    const tabsWrap = $('.monitor-tabs');
    if (!tabsWrap) return;
    const thumb = tabsWrap.querySelector('.monitor-tab-thumb');
    if (!thumb) return;
    if (immediate) thumb.style.transition = 'none';
    // The two equal grid tracks let CSS own the geometry. Measuring while the
    // monitor panel is scaled by its opening motion used to shrink the blue
    // thumb until another click forced a settled-layout measurement.
    tabsWrap.dataset.monitorPage = String(monitorPage);
    if (immediate) {
        void thumb.offsetWidth;
        requestAnimationFrame(() => thumb.style.removeProperty('transition'));
    }
}
function finishMonitorPageSwitch({ render = false } = {}) {
    const viewport = $('.monitor-pages-viewport');
    const tabsWrap = $('.monitor-tabs');
    monitorPageSwitching = false;
    monitorPrevPage = monitorPage;
    tabsWrap?.classList.remove('switching');
    if (viewport) {
        viewport.classList.remove('switching');
        viewport.querySelectorAll('.monitor-page').forEach((pageEl) => {
            const isActive = pageEl.classList.contains(`monitor-page-${monitorPage}`);
            pageEl.classList.toggle('active', isActive);
            pageEl.classList.remove('leaving');
            pageEl.toggleAttribute('hidden', !isActive);
            pageEl.style.removeProperty('display');
        });
    }
    updateMonitorTabThumb({ immediate: true });
    if (render && latestStatsData) renderStats(latestStatsData);
}
function setMonitorPage(page, { render = true } = {}) {
    const next = Math.max(0, Math.min(1, Number(page) || 0));
    if (next === monitorPage) {
        updateMonitorTabThumb({ immediate: false });
        return;
    }
    monitorPrevPage = monitorPage;
    monitorSwitchDirection = next > monitorPage ? 1 : -1;
    monitorPage = next;
    monitorPageSwitching = true;
    const viewport = $('.monitor-pages-viewport');
    const tabsWrap = $('.monitor-tabs');
    const tabs = $$('.monitor-tab');
    if (viewport && tabsWrap && tabs.length) {
        viewport.setAttribute('data-monitor-dir', String(monitorSwitchDirection));
        viewport.setAttribute('data-monitor-page', String(monitorPage));
        viewport.setAttribute('data-monitor-prev-page', String(monitorPrevPage));
        viewport.classList.add('switching');
        tabsWrap.classList.add('switching');
        tabsWrap.dataset.monitorPage = String(monitorPage);
        const oldPage = viewport.querySelector(`.monitor-page-${monitorPrevPage}`);
        const newPage = viewport.querySelector(`.monitor-page-${monitorPage}`);
        tabs.forEach((btn) => {
            const active = Number(btn.dataset.monitorPage) === monitorPage;
            btn.classList.toggle('active', active);
            btn.setAttribute('aria-selected', active ? 'true' : 'false');
            btn.tabIndex = active ? 0 : -1;
        });
        updateMonitorTabThumb({ immediate: false });
        [oldPage, newPage].forEach((p) => {
            if (!p) return;
            p.removeAttribute('hidden');
            p.style.display = 'block';
        });
        if (oldPage) {
            oldPage.classList.remove('active');
            oldPage.classList.add('leaving');
        }
        if (newPage) {
            newPage.classList.remove('active', 'leaving');
            void newPage.offsetWidth;
            newPage.classList.add('active');
        }
        window.clearTimeout(renderStats._monitorSwitchTimer);
        window.clearTimeout(renderStats._monitorSwitchCleanup);
        renderStats._monitorSwitchTimer = window.setTimeout(() => finishMonitorPageSwitch({ render: false }), 360);
        return;
    }
    monitorPageSwitching = false;
    if (render && latestStatsData) renderStats(latestStatsData);
}
function bindMonitorPager() {
    $$('.monitor-tab').forEach((btn) => {
        btn.addEventListener('click', () => setMonitorPage(Number(btn.dataset.monitorPage) || 0));
        btn.addEventListener('keydown', (event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            setMonitorPage(event.key === 'ArrowRight' ? monitorPage + 1 : monitorPage - 1);
        });
    });
    updateMonitorTabThumb({ immediate: !monitorPageSwitching });
    if (!bindMonitorPager._resizeBound) {
        bindMonitorPager._resizeBound = true;
        window.addEventListener('resize', () => updateMonitorTabThumb({ immediate: true }), { passive: true });
    }
    const viewport = $('.monitor-pages-viewport');
    if (!viewport) return;
    let startX = 0;
    let startY = 0;
    let tracking = false;
    viewport.addEventListener('pointerdown', (event) => {
        if (event.pointerType === 'mouse' || event.target.closest('button,input,select,textarea,label')) return;
        startX = event.clientX;
        startY = event.clientY;
        tracking = true;
        viewport.setPointerCapture?.(event.pointerId);
    }, { passive: true });
    viewport.addEventListener('pointerup', (event) => {
        if (!tracking) return;
        tracking = false;
        const dx = event.clientX - startX;
        const dy = event.clientY - startY;
        const threshold = Math.max(90, Math.min(150, viewport.clientWidth * 0.28));
        if (Math.abs(dx) < threshold || Math.abs(dx) < Math.abs(dy) * 1.6) return;
        setMonitorPage(dx < 0 ? monitorPage + 1 : monitorPage - 1);
    }, { passive: true });
    viewport.addEventListener('pointercancel', () => { tracking = false; }, { passive: true });
}

function ensureStatsSkeleton(d) {
    /* Build the monitor DOM once per open; subsequent stats pushes only
     * update text nodes and chart data (FREEZE plan §2.3). Rebuilding the
     * whole innerHTML on every stats tick is the direct cause of the panel
     * flicker - canvas teardown + recreation + re-layout flashes visibly. */
    if (infoBody.dataset.statsSkeleton === '1' && !monitorPageSwitching) return;
    const diskDevices = Array.isArray(d.disk?.devices) ? d.disk.devices : [];
    const diskDeviceCards = diskDevices.map(device => `
        <div class="doughnut-item disk-card" data-disk-id="${device.id}">
            <div class="disk-card-meta">
                <div class="doughnut-label">${device.mountpoint}</div>
                <div class="doughnut-text" data-disk-text="${device.id}">${device.usedGB} / ${device.totalGB} GB</div>
                <div class="doughnut-sub" data-disk-fs="${device.id}">${device.filesystem}</div>
                <div class="doughnut-sub" data-disk-pct="${device.id}">${t('已用 {usage}', { usage: device.usageLabel })}</div>
                <div class="doughnut-sub" data-disk-rw="${device.id}">${t('读 {read} KB/s · 写 {write} KB/s', { read: device.readKBps, write: device.writeKBps })}</div>
            </div>
            <div class="doughnut-wrap"><canvas id="${device.id}"></canvas></div>
        </div>
    `).join('');

    const monitorPageClass = (page) => [
        'monitor-page',
        `monitor-page-${page}`,
        page === 0 ? 'monitor-overview-page' : 'monitor-process-page',
        monitorPage === page ? 'active' : '',
    ].filter(Boolean).join(' ');
    const monitorPageHidden = (page) => (monitorPage === page) ? '' : 'hidden';

    infoBody.innerHTML = `
        <div class="monitor-tabs" role="tablist" aria-label="${t('监控分页')}" data-monitor-page="${monitorPage}">
            <span class="monitor-tab-thumb" aria-hidden="true"></span>
            <button class="monitor-tab ${monitorPage === 0 ? 'active' : ''}" data-monitor-page="0" type="button" role="tab" aria-selected="${monitorPage === 0 ? 'true' : 'false'}" tabindex="${monitorPage === 0 ? '0' : '-1'}">${t('概览')}</button>
            <button class="monitor-tab ${monitorPage === 1 ? 'active' : ''}" data-monitor-page="1" type="button" role="tab" aria-selected="${monitorPage === 1 ? 'true' : 'false'}" tabindex="${monitorPage === 1 ? '0' : '-1'}">${t('进程')}</button>
        </div>
        <div class="monitor-pages-viewport" data-monitor-page="${monitorPage}">
            <section class="${monitorPageClass(0)}" ${monitorPageHidden(0)}>
        <div class="doughnut-row">
            <div class="doughnut-item disk-card full-width">
                <div class="disk-card-meta">
                    <div class="doughnut-label">${t('主机')}</div>
                    <div class="doughnut-text" data-stat="hostName">N/A</div>
                    <div class="doughnut-sub" data-stat="hostOS">N/A</div>
                </div>
            </div>
        </div>
        <div class="doughnut-row">
            <div class="doughnut-item disk-card full-width">
                <div class="disk-card-meta">
                    <div class="doughnut-label">CPU</div>
                    <div class="doughnut-text" data-stat="cpuModel">N/A</div>
                    <div class="doughnut-sub" data-stat="cpuFreq">N/A</div>
                    <div class="doughnut-sub" data-stat="cpuCores">0 ${t('核心')}</div>
                </div>
                <div class="doughnut-wrap"><canvas id="cpuDoughnut"></canvas></div>
            </div>
        </div>
        <div class="doughnut-row two-col">
            <div class="doughnut-item">
                <div class="doughnut-label">${t('内存')}</div>
                <div class="doughnut-wrap"><canvas id="ramDoughnut"></canvas></div>
                <div class="doughnut-text" data-stat="memText">0 / 0 GB</div>
            </div>
            <div class="doughnut-item">
                <div class="doughnut-label">Swap</div>
                <div class="doughnut-wrap"><canvas id="swapDoughnut"></canvas></div>
                <div class="doughnut-text" data-stat="swapText">0 / 0 GB</div>
            </div>
        </div>
        <div class="doughnut-row disk-card-row">
            ${diskDeviceCards}
        </div>
        <div class="doughnut-row two-col">
            <div class="doughnut-item">
                <div class="doughnut-label">${t('下载')}</div>
                <div class="doughnut-text" data-stat="rxText">0 Mbps</div>
                <div class="sparkline-row">
                    <canvas id="rxLine" data-color="#3fb950" class="line-canvas" height="30"></canvas>
                </div>
            </div>
            <div class="doughnut-item">
                <div class="doughnut-label">${t('上传')}</div>
                <div class="doughnut-text" data-stat="txText">0 Mbps</div>
                <div class="sparkline-row">
                    <canvas id="txLine" data-color="#0a84ff" class="line-canvas" height="30"></canvas>
                </div>
            </div>
        </div>
        <div class="ip-section">
            <div class="ip-box"><span>IPv4</span><code data-stat="ipv4">N/A</code><button class="copy-ip-btn" aria-label="${t('复制 IPv4')}" data-copy-stat="ipv4">${zephyrButtonGlyph('copy', t('复制'))}</button></div>
            <div class="ip-box"><span>IPv6</span><code data-stat="ipv6">N/A</code><button class="copy-ip-btn" aria-label="${t('复制 IPv6')}" data-copy-stat="ipv6">${zephyrButtonGlyph('copy', t('复制'))}</button></div>
        </div>
            </section>
            <section class="${monitorPageClass(1)}" ${monitorPageHidden(1)}>
                ${renderProcessesPage(d)}
            </section>
        </div>
    `;
    infoBody.dataset.statsSkeleton = '1';
    bindMonitorPager();
    bindProcessPageEvents();
    infoBody.querySelectorAll('[data-copy-stat]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const name = btn.dataset.copyStat;
            const code = infoBody.querySelector(`[data-stat="${name}"]`);
            const value = code?.textContent || '';
            if (value) navigator.clipboard.writeText(value).then(() => showToast('已复制', 'success')).catch(() => {});
        });
    });
    requestAnimationFrame(() => updateMonitorTabThumb({ immediate: true }));
    try { initCharts(); } catch (err) { console.warn(t('[Stats] 图表初始化失败:'), err); }
}

function setTextStat(name, value) {
    const el = infoBody.querySelector(`[data-stat="${name}"]`);
    if (el && el.textContent !== value) el.textContent = value;
}

function renderStats(d) {
    if (!infoBody || !d) return;
    latestStatsData = d;
    // Rebuild skeleton when disk devices change (mount added/removed) or on
    // monitor page switch; otherwise keep the DOM and update in place.
    const diskDevices = Array.isArray(d.disk?.devices) ? d.disk.devices : [];
    const knownDiskIds = Array.from(infoBody.querySelectorAll('[data-disk-id]')).map((el) => el.dataset.diskId);
    const diskChanged = diskDevices.length !== knownDiskIds.length
        || diskDevices.some((dev, i) => dev.id !== knownDiskIds[i]);
    if (infoBody.dataset.statsSkeleton !== '1' || diskChanged || monitorPageSwitching) {
        delete infoBody.dataset.statsSkeleton;
        ensureStatsSkeleton(d);
    }

    const cpuUsage = safeVal(d.cpu?.usage);
    const memUsedGB = (safeVal(d.memUsed) / 1024).toFixed(1);
    const memTotalGB = (safeVal(d.memTotal) / 1024).toFixed(1);
    const swapUsedGB = (safeVal(d.swapUsed) / 1024).toFixed(1);
    const swapTotalGB = (safeVal(d.swapTotal) / 1024).toFixed(1);
    const rxMbps = safeVal(d.net?.rx).toFixed(1);
    const txMbps = safeVal(d.net?.tx).toFixed(1);

    setTextStat('hostName', d.host?.hostname || 'N/A');
    setTextStat('hostOS', d.host?.os || 'N/A');
    setTextStat('cpuModel', d.cpu?.model || 'N/A');
    setTextStat('cpuFreq', d.cpu?.freq || 'N/A');
    setTextStat('cpuCores', `${d.cpu?.cores || 0} 核心`);
    setTextStat('memText', `${memUsedGB} / ${memTotalGB} GB`);
    setTextStat('swapText', `${swapUsedGB} / ${swapTotalGB} GB`);
    setTextStat('rxText', `${rxMbps} Mbps`);
    setTextStat('txText', `${txMbps} Mbps`);
    setTextStat('ipv4', d.ip?.ipv4 || 'N/A');
    setTextStat('ipv6', d.ip?.ipv6 || 'N/A');

    diskDevices.forEach((device) => {
        setTextStatName(`[data-disk-text="${device.id}"]`, `${device.usedGB} / ${device.totalGB} GB`);
        setTextStatName(`[data-disk-pct="${device.id}"]`, `已用 ${device.usageLabel}`);
        setTextStatName(`[data-disk-rw="${device.id}"]`, `读 ${device.readKBps} KB/s · 写 ${device.writeKBps} KB/s`);
    });

    if (monitorPage === 1) {
        const procSection = infoBody.querySelector('.monitor-page-1');
        if (procSection) {
            const next = renderProcessesPage(d);
            if (procSection.innerHTML !== next) procSection.innerHTML = next;
            bindProcessPageEvents();
        }
    }

    try {
        updateDoughnut('cpuDoughnut', cpuUsage);
        updateDoughnut('ramDoughnut', (safeVal(d.memUsed) / safeVal(d.memTotal)) * 100);
        updateDoughnut('swapDoughnut', safeVal(d.swapTotal) ? (safeVal(d.swapUsed) / safeVal(d.swapTotal)) * 100 : 0);
        diskDevices.forEach(device => updateDoughnut(device.id, device.percent));
        updateLine('rxLine', rxMbps);
        updateLine('txLine', txMbps);
    } catch (err) {
        console.warn(t('[Stats] 图表更新失败:'), err);
    }
}

function setTextStatName(selector, value) {
    const el = infoBody.querySelector(selector);
    if (el && el.textContent !== value) el.textContent = value;
}

function setInfoButtonActive(active = infoModal?.classList?.contains('open')) {
    infoBtn?.classList?.toggle('active', !!active);
    infoBtn?.setAttribute?.('aria-expanded', active ? 'true' : 'false');
}

function positionMonitorPanel() {
    if (!infoModal) return;
    const defaults = getDefaultPanelOptions(infoModal);
    const rect = infoModal.parentElement?.getBoundingClientRect?.() || { width: window.innerWidth, height: window.innerHeight };
    const wasInitialized = panelState.has(infoModal);
    if (!wasInitialized) ensureFloatingPanel(infoModal, defaults);
    const width = Math.min(Number(infoModal.offsetWidth) || defaults.width, Math.max(260, rect.width - 16));
    const height = Math.min(Number(infoModal.offsetHeight) || defaults.height, Math.max(260, rect.height - 52));
    if (!wasInitialized || isCompactScreen()) {
        Object.assign(infoModal.style, {
            width: `${defaults.width}px`,
            height: `${defaults.height}px`,
            left: `${defaults.left ?? Math.max(8, rect.width - defaults.width - 12)}px`,
            top: `${defaults.top ?? 52}px`,
            right: 'auto',
            bottom: 'auto',
        });
    } else if (width !== infoModal.offsetWidth || height !== infoModal.offsetHeight) {
        infoModal.style.width = `${width}px`;
        infoModal.style.height = `${height}px`;
    }
    clampPanel(infoModal);
}

function renderStatsSoon(data) {
    latestStatsData = data || latestStatsData;
    if (!infoModal?.classList?.contains('open') || !latestStatsData) return;
    if (monitorPageSwitching) return;
    if (monitorRenderRaf) return;
    monitorRenderRaf = requestAnimationFrame(() => {
        monitorRenderRaf = 0;
        renderStats(latestStatsData);
    });
}

function showInfoModal() {
    if (!wsConnection || wsConnection.readyState !== WebSocket.OPEN || !isConnected) {
        showToast('请先连接 SSH', 'error');
        return;
    }
    if (!infoModal) return;
    infoModal.style.display = 'flex';
    infoModal.classList.remove('panel-closing');
    positionMonitorPanel();
    if (latestStatsData) {
        renderStats(latestStatsData);
    } else if (infoBody) {
        infoBody.innerHTML = `<div class="info-loading">${t('正在加载服务器实时监控数据...')}</div>`;
    }
    if (wsConnection?.readyState === WebSocket.OPEN) {
        wsConnection.send(JSON.stringify({ type: 'stats-request' }));
    }
    // display 从 none 切换为 flex 后，下一帧再加 open，确保浏览器能播放开启动画。
    requestAnimationFrame(() => {
        infoModal.classList.add('open');
        setInfoButtonActive(true);
        bringPanelToFront(infoModal);
        animatePanelFromButton(infoModal, infoBtn, true);
    });
}

function patchWTermScrollBehavior() {
    if (!term || term._zephyrScrollPatched) return;

    // Fork path: @wterm/dom fork exposes a public viewport API. Don't
    // monkey-patch private methods; just bridge the fork's public API to the
    // legacy term.viewport facade so the rest of the app works unchanged.
    if (term.viewport && typeof term.viewport.follow === 'function' && typeof term.isAtBottom === 'function') {
        term._zephyrScrollPatched = true;
        term._zephyrForkViewport = true;
        // Bridge fork public API -> legacy facade contract used by callers
        const forkViewport = term.viewport;
        term.viewport = {
            get atBottom() { return forkViewport.atBottom; },
            get followEnabled() { return terminalAutoFollowEnabled; },
            state() {
                return {
                    atBottom: forkViewport.atBottom,
                    followEnabled: terminalAutoFollowEnabled,
                    programmaticScroll: isProgrammaticTerminalScroll,
                    hasSelection: hasLiveTerminalSelection?.() || false,
                    maxScroll: forkViewport.maxScroll || 0,
                    scrollTop: forkViewport.scrollTop || 0,
                };
            },
            follow(reason = 'viewport-follow', opts = {}) {
                // Mobile: chrome-pin only. Do NOT ask fork to maxScroll-stick.
                followTerminalBottomNow(reason, { force: true, ...opts });
                setTerminalAutoFollow(true, reason);
                if (!isMobileStableInputMode()) forkViewport.follow();
                else {
                    try { term.lockBottom?.(); } catch (_) {}
                    try { term._shouldScrollToBottom = false; } catch (_) {}
                }
            },
            lock(reason = 'viewport-lock') {
                setTerminalAutoFollow(false, reason);
                forkViewport.lock();
            },
            unlock(reason = 'viewport-unlock') {
                setTerminalAutoFollow(true, reason);
                if (!isMobileStableInputMode()) forkViewport.follow();
                else {
                    try { term.lockBottom?.(); } catch (_) {}
                    try { term._shouldScrollToBottom = false; } catch (_) {}
                    followTerminalBottomNow(reason, { force: true });
                }
            },
        };

        // xterm-reflow1 / FitAddon path needs the REAL resize + scrollToBottom.
        // Always stash unpatched entry points before any further wrapping.
        if (typeof term.resize === 'function' && !term._zephyrOriginalResize) {
            term._zephyrOriginalResize = term.resize.bind(term);
        }
        if (typeof term.scrollToBottom === 'function' && !term._zephyrOriginalScrollToBottom) {
            term._zephyrOriginalScrollToBottom = term.scrollToBottom.bind(term);
        }
        if (typeof term._scrollToBottom === 'function' && !term._zephyrOriginal_scrollToBottom) {
            term._zephyrOriginal_scrollToBottom = term._scrollToBottom.bind(term);
        }

        // Mobile fork (xterm model):
        // - Do NOT replace scrollToBottom with chrome-pin (breaks FitAddon stick).
        // - Do NOT replace write.
        // - followBottom when auto-follow; lockBottom when user reads history.
        // - Patch _doRender only to stop the "no scrollback → scrollTop=0" clobber
        //   right after we programmatically stick for IME fit.
        if (isMobileStableInputMode()) {
            try {
                if (terminalAutoFollowEnabled || mobileStableLastBottomIntent) term.followBottom?.();
                else term.lockBottom?.();
            } catch (_) {}
            if (typeof term._doRender === 'function' && !term._zephyrDoRenderPinned) {
                term._zephyrDoRenderPinned = true;
                const originalDoRenderFork = term._doRender.bind(term);
                term._doRender = () => {
                    const el = term.element || wtermWrapper;
                    const keepTop = isProgrammaticTerminalScroll ? (el?.scrollTop ?? null) : null;
                    const result = originalDoRenderFork();
                    // WTerm forces scrollTop=0 when !hasScrollback; restore after IME stick.
                    if (keepTop != null && el && Math.abs((el.scrollTop || 0) - keepTop) > 1) {
                        el.scrollTop = keepTop;
                    }
                    return result;
                };
            }
        }
        return;
    }

    // Legacy path: stock @wterm/dom - monkey-patch private methods.
    const originalScrollToBottom = typeof term._scrollToBottom === 'function' ? term._scrollToBottom.bind(term) : null;
    const originalIsScrolledToBottom = typeof term._isScrolledToBottom === 'function' ? term._isScrolledToBottom.bind(term) : null;
    const originalDoRender = typeof term._doRender === 'function' ? term._doRender.bind(term) : null;
    const originalScheduleRender = typeof term._scheduleRender === 'function' ? term._scheduleRender.bind(term) : null;
    const originalWrite = typeof term.write === 'function' ? term.write.bind(term) : null;
    const originalResize = typeof term.resize === 'function' ? term.resize.bind(term) : null;
    if (originalResize && !term._zephyrOriginalResize) term._zephyrOriginalResize = originalResize;
    if (typeof term.scrollToBottom === 'function' && !term._zephyrOriginalScrollToBottom) {
        term._zephyrOriginalScrollToBottom = term.scrollToBottom.bind(term);
    }

    if (originalScrollToBottom) {
        term._scrollToBottom = () => {
            const fromRender = term._zephyrRenderingDepth > 0;
            const scrollReason = fromRender ? 'wterm-render-scroll-bottom' : 'wterm-scroll-bottom';
            const alreadyAtBottom = isMobileStableInputMode()
                ? isMobileStableAtVisualBottom()
                : (originalIsScrolledToBottom ? originalIsScrolledToBottom() : isTerminalAtBottom());
            const outputFollowAllowed = isMobileStableInputMode() && terminalAutoFollowEnabled && !hasLiveTerminalSelection() && !mobileTerminalSelectionMode;
            const lockedAwayFromBottom = !alreadyAtBottom && !outputFollowAllowed && (
                isMobileTerminalAutoFollowLocked()
                || mobileTerminalSelectionMode
                || hasLiveTerminalSelection()
                || (isMobileStableInputMode() && !terminalAutoFollowEnabled)
            );
            if (lockedAwayFromBottom) {
                scheduleTerminalScrollbarUpdate();
                return;
            }
            if (!fromRender && !alreadyAtBottom && !terminalAutoFollowEnabled) {
                scheduleTerminalScrollbarUpdate();
                return;
            }
            if (isMobileStableInputMode()) {
                followTerminalBottomNow(scrollReason, { force: outputFollowAllowed || alreadyAtBottom });
                return;
            }
            if (shouldBlockMobileStableAutoFollowReason(scrollReason)) {
                scheduleTerminalScrollbarUpdate();
                return;
            }
            isProgrammaticTerminalScroll = true;
            try {
                if (sshKb && !sshKb.allowNonPinScroll?.(scrollReason)) {
                    applyCursorAboveChromeScroll(scrollReason, { force: true });
                } else {
                    originalScrollToBottom();
                    const el = getTerminalScrollElement();
                    if (el) writeTerminalScrollTop(el, getTerminalMaxScroll(el), scrollReason, { pin: false });
                    if (wtermWrapper && wtermWrapper !== el) writeTerminalScrollTop(wtermWrapper, getTerminalMaxScroll(wtermWrapper), scrollReason, { pin: false });
                }
                setTerminalAutoFollow(true, scrollReason);
            } finally {
                scheduleTerminalScrollbarUpdate();
                requestAnimationFrame(() => { isProgrammaticTerminalScroll = false; });
            }
        };
    }

    if (originalIsScrolledToBottom) {
        term._isScrolledToBottom = () => isMobileStableInputMode()
            ? isMobileStableAtVisualBottom()
            : (originalIsScrolledToBottom() || isTerminalAtBottom(undefined, TERMINAL_BOTTOM_THRESHOLD));
    }

    if (originalWrite) {
        term.write = (data) => {
            const blockedByHistory = isMobileTerminalAutoFollowLocked() || isTerminalUserReadingHistory() || mobileTerminalSelectionMode || hasLiveTerminalSelection();
            const plainEchoSuppressed = isMobileStableInputMode() && Date.now() < mobileStableEchoSuppressUntil;
            const wasAtBottom = isMobileStableInputMode()
                ? isMobileStableAtVisualBottom()
                : (originalIsScrolledToBottom ? originalIsScrolledToBottom() : isTerminalAtBottom());
            // Netcatty: output does not app-layer scroll by default. Keep WTerm's
            // internal stick-to-bottom only when already following / at bottom.
            const policyOutput = shouldScrollOnTerminalOutput(getTerminalScrollPolicySettings());
            const shouldFollow = !plainEchoSuppressed && !blockedByHistory
                && (policyOutput || terminalAutoFollowEnabled || wasAtBottom);
            term._zephyrShouldFollowAfterRender = shouldFollow && wasAtBottom;
            const result = originalWrite(data);
            if (policyOutput && !blockedByHistory) {
                scrollTerminalToBottomAfterOutputIfEnabled(getWTermScrollTarget(), getTerminalScrollPolicySettings());
            }
            // Never schedule multi-phase write-follow — WTerm render handles stick.
            scheduleTerminalScrollbarUpdate();
            return result;
        };
    }

    if (originalResize) {
        term._zephyrOriginalResize = originalResize;
        if (typeof term.scrollToBottom === 'function' && !term._zephyrOriginalScrollToBottom) {
            term._zephyrOriginalScrollToBottom = term.scrollToBottom.bind(term);
        }
        term.resize = (cols, rows) => {
            // FitAddon IME path sets runWithMobileStableResizeBypass.active — must shrink.
            if (shouldSuppressTerminalGridResize('wterm-resize-call')
                && !runWithMobileStableResizeBypass.active) {
                const keepCols = lastSentTerminalSize.cols || Number(term.cols ?? term.bridge?.getCols?.() ?? cols);
                const keepRows = lastSentTerminalSize.rows || Number(term.rows ?? term.bridge?.getRows?.() ?? rows);
                logTerminalLayoutDiagnostics('wterm-layout:resize-suppressed-during-keyboard', {
                    requestedCols: cols, requestedRows: rows, keepCols, keepRows,
                });
                try {
                    sendTerminalResize(cols, rows, { reason: 'suppressed-wterm-resize:pty-visible', force: true });
                } catch (_) {}
                if (isMobileStableInputMode()) {
                    normalizeWTermContainerLayout('suppressed-wterm-resize:visual-only');
                    requestInitialMobileRenderFlush('suppressed-wterm-resize');
                    scheduleTerminalScrollbarUpdate();
                    return false;
                }
                return updateWTermLocalGridSize(keepCols, keepRows, 'suppressed-wterm-resize');
            }
            const shouldFollow = terminalAutoFollowEnabled || (originalIsScrolledToBottom ? originalIsScrolledToBottom() : isTerminalAtBottom());
            term._zephyrShouldFollowAfterRender = shouldFollow;
            const result = originalResize(cols, rows);
            rememberTerminalFitSnapshot('wterm-resize');
            if (shouldFollow) requestAnimationFrame(() => requestTerminalAutoFollow('resize-follow'));
            else scheduleTerminalScrollbarUpdate();
            return result;
        };
    }

    if (originalDoRender) {
        term._doRender = () => {
            term._zephyrRenderingDepth = (term._zephyrRenderingDepth || 0) + 1;
            const echoSuppressed = isMobileStableInputMode() && Date.now() < mobileStableEchoSuppressUntil;
            const shouldFollow = !!term._zephyrShouldFollowAfterRender || (terminalAutoFollowEnabled && !echoSuppressed);
            const previousWTermShouldScroll = term._shouldScrollToBottom;
            const mobile = isMobileStableInputMode();
            // Desktop: WTerm internal stick-to-bottom is fine.
            // Mobile: WTerm _scrollToBottom chases maxScroll → fig.3 black void.
            // Force internal flag OFF; chrome-pin runs once after render if needed.
            if (mobile) {
                term._shouldScrollToBottom = false;
            } else if (shouldFollow && !echoSuppressed) {
                term._shouldScrollToBottom = true;
            }
            try {
                return originalDoRender();
            } finally {
                term._shouldScrollToBottom = previousWTermShouldScroll;
                term._zephyrRenderingDepth = Math.max(0, (term._zephyrRenderingDepth || 1) - 1);
                // Render is NOT a scroll authority on mobile. WTerm internal
                // stick is already forced OFF. Input / open-keyboard / enter
                // own pin. Render only updates scrollbar chrome.
                term._zephyrShouldFollowAfterRender = false;
                scheduleTerminalScrollbarUpdate();
                void mobile;
                void shouldFollow;
                void echoSuppressed;
                updateTerminalWebLinks();
            }
        };
    }

    if (originalScheduleRender) {
        term._scheduleRender = () => {
            originalScheduleRender();
            requestAnimationFrame(() => {
                scheduleTerminalScrollbarUpdate();
                updateTerminalWebLinks();
            });
        };
    }

    term._zephyrOriginalScrollToBottom = originalScrollToBottom;
    term._zephyrOriginalIsScrolledToBottom = originalIsScrolledToBottom;
    term._zephyrOriginalDoRender = originalDoRender;
    term._zephyrOriginalScheduleRender = originalScheduleRender;
    term._zephyrScrollPatched = true;

    /* Public viewport facade (FREEZE plan §3.8 transitional layer).
     * Business code should call term.viewport.* instead of touching
     * term._scrollToBottom / _isScrolledToBottom / _doRender. When the WTerm
     * fork exposes these as real public methods, only this facade moves. */
    if (!term.viewport) {
        term.viewport = {
            get atBottom() {
                return isMobileStableInputMode()
                    ? isMobileStableAtVisualBottom()
                    : (originalIsScrolledToBottom ? originalIsScrolledToBottom() : isTerminalAtBottom());
            },
            get followEnabled() { return terminalAutoFollowEnabled; },
            state() {
                const el = getTerminalScrollElement();
                return {
                    atBottom: this.atBottom,
                    followEnabled: terminalAutoFollowEnabled,
                    programmaticScroll: isProgrammaticTerminalScroll,
                    hasSelection: hasLiveTerminalSelection?.() || false,
                    maxScroll: el ? getTerminalMaxScroll(el) : 0,
                    scrollTop: el ? el.scrollTop : 0,
                };
            },
            follow(reason = 'viewport-follow', opts = {}) {
                followTerminalBottomNow(reason, { force: true, ...opts });
                setTerminalAutoFollow(true, reason);
            },
            lock(reason = 'viewport-lock') {
                setTerminalAutoFollow(false, reason);
            },
            unlock(reason = 'viewport-unlock') {
                setTerminalAutoFollow(true, reason);
            },
        };
    }
}

function requestInitialMobileRenderFlush(reason = 'mobile-initial-render') {
    if (!isTouchKeyboardDevice()) return;
    // 移动端页面/键盘恢复只刷新渲染和滚动条；不强制滚到底、不改变远端 PTY。
    // 这避免 iOS/Android WebView 恢复后 viewport 与 buffer 错配造成空白撑开、截断和光标漂移。
    const keyboardRelated = /keyboard|viewport|visual/.test(String(reason));
    if (keyboardRelated && !isMobileStableInputMode()) syncWTermGridToLastPty(`${reason}:render-flush-keep-pty`);
    const delays = keyboardRelated ? [0, 80, 220, 520] : [0, 40, 120, 260, 520];
    delays.forEach((delay) => {
        window.setTimeout(() => {
            if (!term || !wtermWrapper || document.visibilityState !== 'visible') return;
            try { term._scheduleRender?.(); } catch (_) {}
            scheduleTerminalScrollbarUpdate();
        }, delay);
    });
}

function isMobileStablePlainEchoData(data = '') {
    if (!isMobileStableInputMode()) return false;
    if (Date.now() - (mobileStableLastActualInputAt || 0) > 450) return false;
    const text = String(data || '');
    if (!text || text.length > 16) return false;
    // Printable echo only. Newlines, carriage returns, ANSI escapes and control
    // sequences can create/move lines and must keep the normal follow path.
    return !/[\r\n\x00-\x1f\x7f\x1b]/.test(text);
}

function writeTerminalData(data = '') {
    if (!term?.write) return;
    updateTerminalMouseTrackingFromData(data);
    const plainEcho = isMobileStablePlainEchoData(data);
    if (plainEcho) mobileStableEchoSuppressUntil = Date.now() + 180;
    const historyLocked = isMobileTerminalAutoFollowLocked() || isTerminalUserReadingHistory() || mobileTerminalSelectionMode || hasLiveTerminalSelection();
    const wasAtBottom = !historyLocked && Boolean(term._isScrolledToBottom ? term._isScrolledToBottom() : isTerminalAtBottom());
    logTerminalScrollDiagnostics('terminal-data:before-write-surface', {
        length: String(data).length,
        wasAtBottom,
        historyLocked,
        plainEcho,
    });
    term.write(data);
    // Surface owns output stick policy (default OFF + chrome-pin when following).
    const surface = ensureTerminalSurface();
    if (surface && isMobileStableInputMode() && !historyLocked && !plainEcho) {
        surface.onOutput('terminal-data');
    } else {
        requestAnimationFrame(scheduleTerminalScrollbarUpdate);
    }
}

function hideInfoModal() {
    if (typeof closePanelLayoutMenu === 'function') closePanelLayoutMenu({ instant: true });
    window.cancelAnimationFrame(monitorRenderRaf);
    monitorRenderRaf = 0;
    animatePanelFromButton(infoModal, infoBtn, false);
    infoModal.classList.remove('open');
    setInfoButtonActive(false);
    window.setTimeout(() => {
        clearPanelMotion(infoModal);
        if (!infoModal.classList.contains('open')) {
            infoModal.style.display = 'none';
            // Tear down the skeleton so the next open starts fresh (new disk
            // set, theme, or terminal instance). Charts are destroyed here,
            // not on every stats tick (FREEZE plan §2.3).
            try { destroyCharts(); } catch (_) {}
            if (infoBody) {
                delete infoBody.dataset.statsSkeleton;
                infoBody.innerHTML = `<div class="info-loading">${t('正在加载服务器实时监控数据...')}</div>`;
            }
        }
    }, 320);
}

function toggleInfoModal() {
    if (infoModal.classList.contains('open')) hideInfoModal();
    else showInfoModal();
}

infoBtn.addEventListener('click', toggleInfoModal);

infoCloseBtn.addEventListener('click', hideInfoModal);

// ---------- 浮动面板拖动 / 缩放 ----------
const panelState = new WeakMap();

function ensureFloatingPanel(panel, defaults = {}) {
    if (!panel || panelState.has(panel)) return;
    const parentRect = panel.parentElement.getBoundingClientRect();
    const width = defaults.width || Math.min(parentRect.width * 0.72, 760);
    const height = defaults.height || Math.min(parentRect.height * 0.72, 560);
    const left = defaults.left ?? Math.max(12, (parentRect.width - width) / 2);
    const top = defaults.top ?? 52;

    Object.assign(panel.style, {
        left: `${left}px`,
        top: `${top}px`,
        right: 'auto',
        bottom: 'auto',
        width: `${width}px`,
        height: `${height}px`,
    });
    panelState.set(panel, { left, top, width, height });
}

function detectInteractionEnvironment() {
    const ua = String(navigator.userAgent || '').toLowerCase();
    const mobileUA = /android|iphone|ipod|blackberry|iemobile|opera mini/i.test(ua);
    const iPadOS = navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1;
    const width = window.innerWidth || document.documentElement.clientWidth || 0;
    const height = window.innerHeight || document.documentElement.clientHeight || 0;
    const smallScreen = Math.min(width, height) <= 820;
    const touch = 'ontouchstart' in window || (navigator.maxTouchPoints || 0) > 0;
    const coarse = window.matchMedia?.('(pointer: coarse)')?.matches || false;
    const hover = window.matchMedia?.('(hover: hover)')?.matches || false;
    const platform = String(navigator.platform || '').toLowerCase();
    const desktopPlatform = /win|mac|linux/.test(platform);
    let mobileScore = 0;
    if (mobileUA) mobileScore += 3;
    if (iPadOS) mobileScore += 3;
    if (smallScreen) mobileScore += 2;
    if (touch) mobileScore += 1;
    if (coarse) mobileScore += 2;
    if (!hover) mobileScore += 1;
    let desktopScore = 0;
    if (desktopPlatform) desktopScore += 2;
    if (hover) desktopScore += 2;
    if (!coarse) desktopScore += 1;
    if (!smallScreen) desktopScore += 2;
    let type = mobileScore >= desktopScore ? 'mobile' : 'desktop';
    let category = type === 'mobile' ? (width >= 768 ? 'tablet' : 'phone') : 'desktop';
    if (category === 'tablet') type = 'desktop';
    return { type, category, width, height, touch, coarse, hover, platform, ua, mobileScore, desktopScore };
}
function isPhoneLikeEnvironment() {
    const env = detectInteractionEnvironment();
    const explicitPhoneUA = /android.*mobile|iphone|ipod|blackberry|iemobile|opera mini/i.test(env.ua);
    const desktopClassInput = env.hover && !env.coarse;
    if (desktopClassInput) return false;
    return explicitPhoneUA && env.coarse && Math.min(env.width, env.height) <= 700;
}
function isCompactScreen() {
    return isPhoneLikeEnvironment();
}

function getDefaultPanelOptions(panel) {
    const parentRect = panel?.parentElement?.getBoundingClientRect?.() || { width: window.innerWidth, height: window.innerHeight };
    if (isCompactScreen()) {
        return {
            left: 8,
            top: 44,
            width: Math.max(280, parentRect.width - 16),
            height: Math.max(300, parentRect.height - 58),
        };
    }
    if (panel === fileManager) {
        return { width: Math.min(parentRect.width * 0.72, 820), height: Math.min(parentRect.height * 0.68, 620), left: 16, top: 52 };
    }
    if (panel === dockerPanel) {
        return { width: Math.min(parentRect.width * 0.8, 980), height: Math.min(parentRect.height * 0.72, 660), left: 28, top: 52 };
    }
    if (panel === snippetPanel) {
        return { width: Math.min(460, parentRect.width - 24), height: Math.min(parentRect.height * 0.62, 520), left: 42, top: 64 };
    }
    if (panel === shortcutPanel) {
        return { width: Math.min(420, parentRect.width - 24), height: Math.min(parentRect.height * 0.46, 360), left: 72, top: 74 };
    }
    return { width: Math.min(480, parentRect.width - 24), height: Math.min(parentRect.height * 0.72, 620), top: 52 };
}

function clampPanel(panel) {
    const rect = panel.getBoundingClientRect();
    const parentRect = panel.parentElement.getBoundingClientRect();
    const minVisible = isCompactScreen() ? 140 : 80;
    const left = Math.min(Math.max(rect.left - parentRect.left, -rect.width + minVisible), parentRect.width - minVisible);
    const top = Math.min(Math.max(rect.top - parentRect.top, 8), parentRect.height - minVisible);
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
}

function applyPanelLayout(panel, layout) {
    if (!panel) return;
    const parentRect = panel.parentElement.getBoundingClientRect();
    const margin = isCompactScreen() ? 6 : 12;
    const topbar = isCompactScreen() ? 38 : 52;
    let left = margin;
    let top = topbar;
    let width = parentRect.width - margin * 2;
    let height = parentRect.height - topbar - margin;

    if (layout === 'half') {
        width = parentRect.width;
        height = Math.max(260, parentRect.height / 2);
        left = 0;
        top = parentRect.height - height;
    } else if (layout === 'left-quarter') {
        width = Math.max(260, parentRect.width / 4);
        height = parentRect.height - topbar;
        left = 0;
        top = topbar;
    } else if (layout === 'right-quarter') {
        width = Math.max(260, parentRect.width / 4);
        height = parentRect.height - topbar;
        left = parentRect.width - width;
        top = topbar;
    }

    panel.classList.add('layout-animating');
    window.clearTimeout(panel._layoutAnimationTimer);
    Object.assign(panel.style, {
        left: `${left}px`,
        top: `${top}px`,
        right: 'auto',
        bottom: 'auto',
        width: `${width}px`,
        height: `${height}px`,
    });
    bringPanelToFront(panel);
    panel._layoutAnimationTimer = window.setTimeout(() => {
        panel.classList.remove('layout-animating');
        clampPanel(panel);
    }, 480);
}

function hidePanelByElement(panel) {
    if (panel === fileManager) hideFileManager();
    else if (panel?.classList?.contains('file-manager')) {
        const owner = Array.from(extraFileManagerWindows).find((entry) => entry?.panel === panel);
        if (owner?.close) owner.close();
        else panel.remove();
    }
    else if (panel === infoModal) hideInfoModal();
    else if (panel === dockerPanel) hideDockerPanel();
    else if (panel === snippetPanel) hideSnippetPanel();
    else if (panel === shortcutPanel) hideShortcutPanel();
    else if (panel?.classList?.contains('fm-editor-modal')) { updateActiveEditorRefs(panel); closeEditor(); }
    else if (panel?.classList?.contains('image-preview-modal')) panel._imagePreviewInstance?.close?.();
    else if (panel?.classList?.contains('media-preview-modal')) panel._mediaPreviewInstance?.close?.();
}

let panelLayoutMenu = null;
let panelLayoutButton = null;
function positionPanelLayoutMenu(menu, button, { collapsed = false } = {}) {
    if (!menu || !button) return;
    const rect = button.getBoundingClientRect();
    const viewport = window.visualViewport;
    const vvLeft = viewport?.offsetLeft || 0;
    const vvTop = viewport?.offsetTop || 0;
    const vvWidth = viewport?.width || window.innerWidth;
    const vvHeight = viewport?.height || window.innerHeight;
    const anchorX = rect.left + rect.width / 2;
    const finalWidth = Math.min(284, Math.max(160, vvWidth - 16));
    const finalHeight = 50;
    const finalLeft = anchorX - finalWidth / 2;
    const finalTop = rect.top;
    menu.style.left = `${collapsed ? rect.left : finalLeft}px`;
    menu.style.top = `${finalTop}px`;
    menu.style.setProperty('--panel-island-menu-width', `${collapsed ? rect.width : finalWidth}px`);
    menu.style.setProperty('--panel-island-menu-height', `${collapsed ? rect.height : finalHeight}px`);
    menu.style.setProperty('--panel-island-radius', `${Math.round((collapsed ? rect.height : 36) / 2)}px`);
    menu.dataset.placement = 'inline';
}
function closePanelLayoutMenu({ instant = false } = {}) {
    const menu = panelLayoutMenu;
    const button = panelLayoutButton;
    if (!menu) {
        button?.classList.remove('active-layout');
        panelLayoutButton = null;
        return;
    }
    window.clearTimeout(menu._closeTimer);
    if (instant || !button?.isConnected) {
        button?.classList.remove('active-layout');
        button?.style.removeProperty('opacity');
        menu.remove();
        panelLayoutMenu = null;
        panelLayoutButton = null;
        return;
    }
    menu.style.transition = 'none';
    positionPanelLayoutMenu(menu, button, { collapsed: false });
    menu.style.opacity = '1';
    void menu.offsetWidth;
    menu.classList.remove('island-open');
    menu.classList.add('island-closing', 'island-animating');
    button.classList.remove('active-layout');
    button.style.opacity = '0';
    requestAnimationFrame(() => {
        menu.style.removeProperty('transition');
        positionPanelLayoutMenu(menu, button, { collapsed: true });
    });
    menu._closeTimer = window.setTimeout(() => {
        button.classList.remove('active-layout');
        button.style.opacity = '1';
        requestAnimationFrame(() => button.style.removeProperty('opacity'));
        menu.remove();
        if (panelLayoutMenu === menu) panelLayoutMenu = null;
        if (panelLayoutButton === button) panelLayoutButton = null;
    }, 460);
}

function openPanelLayoutMenu(button, panel) {
    closePanelLayoutMenu({ instant: true });
    panelLayoutButton = button;
    button?.classList.remove('active-layout');
    const menu = document.createElement('div');
    menu.className = 'panel-layout-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', t('窗口布局'));
    menu.innerHTML = `
        <button data-layout="full" title="${t('全屏')}" aria-label="${t('全屏')}"><span class="panel-layout-icon full"></span></button>
        <button data-layout="half" title="${t('半屏')}" aria-label="${t('半屏')}"><span class="panel-layout-icon half"></span></button>
        <button data-layout="left-quarter" title="${t('左侧四分之一')}" aria-label="${t('左侧四分之一')}"><span class="panel-layout-icon left"></span></button>
        <button data-layout="right-quarter" title="${t('右侧四分之一')}" aria-label="${t('右侧四分之一')}"><span class="panel-layout-icon right"></span></button>
        <button data-layout="close" class="panel-layout-close" title="${t('关闭窗口')}" aria-label="${t('关闭窗口')}"><span class="panel-layout-icon close"></span></button>
    `;
    menu.style.transition = 'none';
    menu.style.zIndex = String(Math.max(10000, allocateFloatingPanelZIndex(panel) + 20));
    document.body.appendChild(menu);
    panelLayoutMenu = menu;
    positionPanelLayoutMenu(menu, button, { collapsed: true });
    button.style.opacity = '0';
    menu.style.opacity = '1';
    menu.classList.add('island-animating');
    void menu.offsetWidth;
    requestAnimationFrame(() => {
        menu.style.removeProperty('transition');
        button?.classList.add('active-layout');
        menu.classList.add('island-open');
        positionPanelLayoutMenu(menu, button, { collapsed: false });
        window.setTimeout(() => {
            menu.classList.remove('island-animating');
            menu.style.removeProperty('opacity');
        }, 540);
    });
    menu.addEventListener('click', (event) => {
        const item = event.target.closest('[data-layout]');
        if (!item) return;
        if (item.dataset.layout === 'close') {
            hidePanelByElement(panel);
            closePanelLayoutMenu({ instant: true });
            return;
        }
        applyPanelLayout(panel, item.dataset.layout);
        closePanelLayoutMenu();
    });
    if (panelLayoutMenu !== menu) panelLayoutMenu = menu;
}

function setupPanelLayoutMenu() {
    document.querySelectorAll('[data-layout-panel]').forEach((button) => {
        const getPanel = () => button.dataset.layoutPanel === 'editor' ? button.closest('.fm-editor-modal') : document.getElementById(button.dataset.layoutPanel);
        const panel = getPanel();
        if (!panel) return;
        button.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            bringPanelToFront(panel);
            button.classList.add('pressing');
            button.setPointerCapture?.(e.pointerId);

            const startX = e.clientX;
            const startY = e.clientY;
            const startLeft = panel.offsetLeft;
            const startTop = panel.offsetTop;
            let moved = false;

            const onMove = (ev) => {
                ev.preventDefault();
                const dx = ev.clientX - startX;
                const dy = ev.clientY - startY;
                if (!moved && Math.hypot(dx, dy) > 7) {
                    moved = true;
                    closePanelLayoutMenu({ instant: true });
                    panel.classList.add('dragging');
                }
                if (!moved) return;
                panel.style.left = `${startLeft + dx}px`;
                panel.style.top = `${startTop + dy}px`;
                panel.style.right = 'auto';
                panel.style.bottom = 'auto';
                clampPanel(panel);
            };

            const onUp = () => {
                panel.classList.remove('dragging');
                button.classList.remove('pressing');
                suppressNextLayoutClick = moved;
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
                window.removeEventListener('pointercancel', onUp);
            };

            window.addEventListener('pointermove', onMove, { passive: false });
            window.addEventListener('pointerup', onUp, { once: true });
            window.addEventListener('pointercancel', onUp, { once: true });
        });
        button.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (suppressNextLayoutClick) {
                suppressNextLayoutClick = false;
                return;
            }
            bringPanelToFront(panel);
            console.info('[DynamicIslandDiagnostics]', {
                event: 'layout-menu-toggle',
                panelId: panel?.id || '',
                buttonId: button?.id || '',
                open: !panelLayoutMenu,
                suppressNextLayoutClick: false,
            });
            if (navigator.vibrate) navigator.vibrate(8);
            if (panelLayoutMenu && panelLayoutButton === button) closePanelLayoutMenu();
            else openPanelLayoutMenu(button, panel);
        });
    });
    document.addEventListener('pointerdown', (e) => {
        if (panelLayoutMenu && !e.target.closest('.panel-layout-menu') && !e.target.closest('[data-layout-panel]')) {
            closePanelLayoutMenu();
        }
    });
    window.addEventListener('resize', closePanelLayoutMenu);
}

function bringPanelToFront(panel) {
    if (!panel) return;
    if (panel.classList?.contains('editor-window') || panel.classList?.contains('image-preview-modal') || panel.classList?.contains('media-preview-modal')) {
        document.querySelectorAll('.fm-editor-modal.editor-window, .image-preview-modal, .media-preview-modal').forEach((p) => {
            if (p !== panel) p.classList.remove('front-switching');
        });
        const nextZ = allocateFloatingPanelZIndex(panel);
        panel.style.zIndex = String(nextZ);
        panel.style.setProperty('--panel-z', String(nextZ));
        panel.classList.add('front');
        return;
    }
    const wasFront = panel.classList.contains('front');
    document.querySelectorAll('.file-manager, .info-modal, .docker-panel, .snippet-panel, .shortcut-panel').forEach((p) => {
        if (p !== panel) p.classList.remove('front');
        if (p !== panel) p.classList.remove('front-switching');
    });
    const nextZ = allocateFloatingPanelZIndex(panel);
    panel.style.zIndex = String(nextZ);
    panel.style.setProperty('--panel-z', String(nextZ));
    panel.classList.add('front');
    if (!wasFront) {
        panel.classList.remove('front-switching');
        // 重新触发布局动画：模拟 iPadOS 窗口切到前台时的轻微弹性抬起感。
        void panel.offsetWidth;
        panel.classList.add('front-switching');
        window.clearTimeout(panel._frontSwitchTimer);
        panel._frontSwitchTimer = window.setTimeout(() => {
            panel.classList.remove('front-switching');
        }, 360);
    }
}

function setupFloatingPanel(panel, options) {
    ensureFloatingPanel(panel, options);
    panel.addEventListener('pointerdown', (event) => {
        if (event.target.closest('.panel-traffic-btn, .panel-layout-menu')) return;
        bringPanelToFront(panel);
    });
}

function setupPanelDrag() {
    const handles = [
        ...document.querySelectorAll('[data-drag-panel]'),
        ...document.querySelectorAll('.panel-titlebar'),
    ];
    handles.forEach((handle) => {
        const panel = handle.dataset.dragPanel
            ? document.getElementById(handle.dataset.dragPanel)
            : handle.closest('.file-manager, .info-modal, .docker-panel');
        if (!panel) return;
        handle.addEventListener('pointerdown', (e) => {
            if (e.target.closest('button,input,select,textarea,label')) return;
            e.preventDefault();
            bringPanelToFront(panel);
            panel.classList.add('dragging');
            handle.setPointerCapture?.(e.pointerId);
            const startX = e.clientX;
            const startY = e.clientY;
            const startLeft = panel.offsetLeft;
            const startTop = panel.offsetTop;

            const onMove = (ev) => {
                ev.preventDefault();
                panel.style.left = `${startLeft + ev.clientX - startX}px`;
                panel.style.top = `${startTop + ev.clientY - startY}px`;
                panel.style.right = 'auto';
                panel.style.bottom = 'auto';
                clampPanel(panel);
            };
            const onUp = () => {
                panel.classList.remove('dragging');
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
            };
            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp, { once: true });
        });
    });
}

function setupPanelResize() {
    document.querySelectorAll('[data-resize-panel]').forEach((handle) => {
        const panel = document.getElementById(handle.dataset.resizePanel);
        if (!panel) return;
        handle.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            bringPanelToFront(panel);
            panel.classList.add('resizing');
            handle.setPointerCapture?.(e.pointerId);
            const startX = e.clientX;
            const startY = e.clientY;
            const startWidth = panel.offsetWidth;
            const startHeight = panel.offsetHeight;
            const startLeft = panel.offsetLeft;
            const edge = handle.dataset.resizeEdge || 'right';
            const parentRect = panel.parentElement.getBoundingClientRect();
            const compact = isCompactScreen();
            const minWidth = compact ? 260 : (Number(getComputedStyle(panel).minWidth.replace('px', '')) || 420);
            const minHeight = compact ? 240 : (Number(getComputedStyle(panel).minHeight.replace('px', '')) || 320);

            const onMove = (ev) => {
                ev.preventDefault();
                let nextLeft = startLeft;
                let nextWidth = startWidth + ev.clientX - startX;
                if (edge === 'left') {
                    nextWidth = startWidth - (ev.clientX - startX);
                    nextLeft = startLeft + (ev.clientX - startX);
                    if (nextWidth < minWidth) {
                        nextLeft -= minWidth - nextWidth;
                        nextWidth = minWidth;
                    }
                    if (nextLeft < 8) {
                        nextWidth += nextLeft - 8;
                        nextLeft = 8;
                    }
                    panel.style.left = `${nextLeft}px`;
                }
                const maxWidth = edge === 'left' ? startLeft + startWidth - 8 : parentRect.width - panel.offsetLeft - 12;
                const maxHeight = parentRect.height - panel.offsetTop - 12;
                const width = Math.min(Math.max(minWidth, nextWidth), maxWidth);
                const height = Math.min(Math.max(minHeight, startHeight + ev.clientY - startY), maxHeight);
                panel.style.width = `${width}px`;
                panel.style.height = `${height}px`;
            };
            const onUp = () => {
                panel.classList.remove('resizing');
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
            };
            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp, { once: true });
        });
    });
}

setupFloatingPanel(fileManager, getDefaultPanelOptions(fileManager));
setupFloatingPanel(infoModal, getDefaultPanelOptions(infoModal));
setupFloatingPanel(dockerPanel, getDefaultPanelOptions(dockerPanel));
setupFloatingPanel(snippetPanel, getDefaultPanelOptions(snippetPanel));
setupFloatingPanel(shortcutPanel, getDefaultPanelOptions(shortcutPanel));
setupPanelLayoutMenu();
setupPanelDrag();
setupPanelResize();
setupTerminalInputActivityHooks();
setupTerminalInputPanelMetrics();
setupMobileKeyboardAvoidance();
setupHorizontalScrollbarVisibility(topbarActions, toolbar);
window.addEventListener('resize', () => {
    setStableViewportHeight();
    [fileManager, infoModal, dockerPanel, snippetPanel, shortcutPanel, ...Array.from(extraFileManagerWindows, (entry) => entry.panel), ...Array.from(imagePreviewPanelsByPath.values(), (preview) => preview.modal), ...Array.from(mediaPreviewPanelsByPath.values(), (preview) => preview.modal)].forEach((panel) => panel && clampPanel(panel));
    updateViewportInsets();
    logTerminalLayoutDiagnostics('window-resize');
    if (!isTouchKeyboardDevice()) requestStableTerminalLayout('window-resize', { includeResize: true });
});
window.visualViewport?.addEventListener('resize', () => {
    logTerminalLayoutDiagnostics('visual-viewport-resize');
    if (isTouchKeyboardDevice()) updateViewportInsets();
    else requestStableTerminalLayout('visual-viewport-resize', { includeResize: true });
}, { passive: true });
window.visualViewport?.addEventListener('scroll', () => {
    logTerminalLayoutDiagnostics('visual-viewport-scroll');
    if (isTouchKeyboardDevice()) updateViewportInsets();
    else requestStableTerminalLayout('visual-viewport-scroll', { includeResize: true });
}, { passive: true });
window.addEventListener('resize', () => {
    if (fmEditorModal?.classList.contains('editor-window')) {
        refreshCodeMirrorLayout();
    }
});
window.addEventListener('pageshow', (e) => {
    logTerminalLayoutDiagnostics('pageshow', { persisted: !!e.persisted });
    refreshTerminalAfterVisibilityRestore('pageshow', { focus: true });
    if (!isTouchKeyboardDevice()) scheduleTerminalResize('pageshow-visible', 220);
});
document.addEventListener('visibilitychange', () => {
    logTerminalLayoutDiagnostics('visibilitychange');
    if (document.visibilityState === 'visible') {
        refreshTerminalAfterVisibilityRestore('visibility-visible', { focus: true });
        if (!isTouchKeyboardDevice()) scheduleTerminalResize('visibility-visible', 220);
    }
});

// ---------- 辅助键 / 终端输入 ----------
const modifierState = { ctrl: false, alt: false, shift: false };
const modifierButtons = document.querySelectorAll('.modifier');
function updateModifierUI() {
    modifierButtons.forEach(btn => btn.classList.toggle('active', modifierState[btn.dataset.key]));
}
function processModifiers(data) {
    if (!modifierState.ctrl && !modifierState.alt && !modifierState.shift) return data;
    let result = '';
    for (const ch of data) {
        const code = ch.charCodeAt(0);
        let transformed = ch;
        if (modifierState.ctrl) {
            if (code >= 65 && code <= 90) transformed = String.fromCharCode(code - 64);
            else if (code >= 97 && code <= 122) transformed = String.fromCharCode(code - 96);
        }
        if (modifierState.alt) transformed = '\x1b' + transformed;
        result += transformed;
    }
    return result;
}
function normalizeTerminalInputNewlines(data = '') {
    return String(data).replace(/\r\n/g, '\r').replace(/\n/g, '\r');
}
function logTerminalPasteDiagnostics(source, text = '') {
    const raw = String(text);
    console.info('[TerminalPaste]', {
        source,
        length: raw.length,
        lf: (raw.match(/\n/g) || []).length,
        cr: (raw.match(/\r/g) || []).length,
        preview: raw.slice(0, 120).replace(/\r/g, '\\r').replace(/\n/g, '\\n'),
    });
}

function sendData(data, { normalizeNewlines = false, source = 'unknown', forceFollow = false, applyModifiers = true } = {}) {
    if (wsConnection && wsConnection.readyState === WebSocket.OPEN && isConnected) {
        const fromWTerm = source === 'wterm-onData';
        if (forceFollow) setTerminalAutoFollow(true, `${source}:force-follow`);
        // 官方 SSH 示例中 WTerm onData 只负责把数据发给后端，不参与外层滚动状态机。
        // 本项目仍需 JSON 包装以匹配现有 /ssh 协议，但 payload 保持 WTerm 产生的原始字节序列。
        const payload = fromWTerm ? data : (normalizeNewlines ? normalizeTerminalInputNewlines(data) : data);
        const input = fromWTerm || !applyModifiers ? payload : processModifiers(payload);
        wsConnection.send(JSON.stringify({ type: 'input', data: input }));
        if (forceFollow) requestTerminalAutoFollow(`${source}:sent`);
        else scheduleTerminalScrollbarUpdate();
    }
}
 
function preserveTerminalScrollWhileEditingCommandInput(reason = 'command-input-edit', callback = () => {}) {
    // Command-bar resizing must never restore a stale terminal scrollTop.
    // On mobile it previously wrote the old value immediately and again in rAF,
    // fighting cursor pin / causing the apparent cursor jump.
    try {
        callback();
    } finally {
        scheduleTerminalScrollbarUpdate();
        logTerminalScrollDiagnostics('command-input:resize-only', { reason });
    }
}

function resizeCommandInput() {
    if (!cmdInput) return;
    cmdInput.style.height = 'auto';
    const maxHeight = parseFloat(getComputedStyle(cmdInput).maxHeight) || 112;
    cmdInput.style.height = `${Math.min(maxHeight, Math.max(34, cmdInput.scrollHeight))}px`;
    updateTerminalInputPanelMetrics();
}

function sendCommand() {
    const text = cmdInput.value;
    if (text && wsConnection && wsConnection.readyState === WebSocket.OPEN && isConnected) {
        logTerminalPasteDiagnostics('command-box-send', text);
        mobileStableLastActualInputAt = Date.now();
        if (isMobileStableInputMode()) {
            mobileTerminalAutoFollowLockUntil = 0;
            mobileTerminalAutoFollowLockReason = '';
            setTerminalAutoFollow(true, 'command-box-send:before-send');
            ensureTerminalSurface()?.onEnterCommitted?.('command-box-send');
        }
        sendData(text + '\r', { normalizeNewlines: true, source: 'command-box-send', forceFollow: isMobileStableInputMode() });
    }
    cmdInput.value = '';
    resizeCommandInput();
}
cmdInput.addEventListener('input', () => {
    preserveTerminalScrollWhileEditingCommandInput('cmdInput-input', resizeCommandInput);
});
cmdInput.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text/plain') || '';
    if (!text.includes('\n') && !text.includes('\r')) {
        window.setTimeout(resizeCommandInput, 0);
        return;
    }
    e.preventDefault();
    logTerminalPasteDiagnostics('command-box-paste', text);
    const { selectionStart, selectionEnd, value } = cmdInput;
    cmdInput.value = value.slice(0, selectionStart) + text + value.slice(selectionEnd);
    const nextPos = selectionStart + text.length;
    cmdInput.selectionStart = cmdInput.selectionEnd = nextPos;
    resizeCommandInput();
});
cmdInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (e.shiftKey) {
        window.setTimeout(resizeCommandInput, 0);
        return;
    }
    e.preventDefault();
    sendCommand();
});
cmdSendBtn.addEventListener('click', sendCommand);
resizeCommandInput();

document.querySelectorAll('.func, .arrow, .combo, .modifier').forEach(btn => {
    btn.addEventListener('click', () => {
        const key = btn.dataset.key;
        if (btn.classList.contains('modifier')) { modifierState[key] = !modifierState[key]; updateModifierUI(); return; }
        if (keySequences[key]) sendData(keySequences[key], { source: 'keypad', forceFollow: true });
        if (comboSequences[key]) sendData(comboSequences[key], { source: 'keypad', forceFollow: true });
    });
});

// ── Mobile auxiliary keys handler ──
const mobileAuxKeys = $('#mobileAuxKeys');
if (mobileAuxKeys) {
    const auxSeqMap = {
        esc: '\x1b', tab: '\t',
        up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C',
        home: '\x1b[1~', end: '\x1b[4~',
        pgup: '\x1b[5~', pgdn: '\x1b[6~',
    };
    let auxPointerState = null;
    let auxLastHandledAt = -Infinity;

    mobileAuxKeys.querySelectorAll('.aux-key').forEach((btn) => {
        btn.type = 'button';
        btn.tabIndex = -1;
        btn.addEventListener('focus', () => keepMobileAuxImeFocused('mobile-aux-focus-guard'));
    });

    function keepMobileAuxImeFocused(reason = 'mobile-aux-focus') {
        if (!isMobileStableInputMode()) return false;
        const kb = ensureSshKeyboard();
        if (!kb) return false;
        if (!kb.desiredOpen?.() && !kb.physicalOpen?.()) return false;
        // Parent already crops the iframe: keep child geometry at inset=0 before
        // retainFocus, otherwise facade may briefly re-apply physical height and
        // the bottom bar jumps mid-screen when tapping ↑/Ctrl/etc.
        if (_sshKbParentShellManaged || (_sshKbLayoutOpenCache && (_sshKbInsetCache || 0) < 8)) {
            writeSshKbPageGeometry(0, true, { fromParent: true });
            _sshKbInsetCache = 0;
        }
        // Single retain — no multi-phase raf/timeout thrash.
        kb.retainFocus(reason);
        // Re-assert after retain (state publish → applyFacadeChrome).
        if (_sshKbParentShellManaged) {
            writeSshKbPageGeometry(0, true, { fromParent: true });
            _sshKbInsetCache = 0;
        }
        return true;
    }


    function releaseMobileAuxModifiers() {
        if (modifierState.ctrl) {
            modifierState.ctrl = false;
            const ctrlBtn = mobileAuxKeys.querySelector('.aux-key[data-key="ctrl"]');
            if (ctrlBtn) ctrlBtn.classList.remove('aux-active');
            document.querySelectorAll('.modifier[data-key="ctrl"]').forEach(b => b.classList.remove('active'));
        }
        if (modifierState.alt) {
            modifierState.alt = false;
            document.querySelectorAll('.modifier[data-key="alt"]').forEach(b => b.classList.remove('active'));
        }
    }

    function handleMobileAuxKey(btn, trigger = 'mobile-aux-key') {
        if (!btn) return false;
        keepMobileAuxImeFocused(`${trigger}:before`);
        const key = btn.dataset.key;
        if (key === 'ctrl') {
            modifierState.ctrl = !modifierState.ctrl;
            btn.classList.toggle('aux-active', modifierState.ctrl);
            // Keep the floating shortcut panel Ctrl button in sync
            document.querySelectorAll('.modifier[data-key="ctrl"]').forEach(b => b.classList.toggle('active', modifierState.ctrl));
            keepMobileAuxImeFocused(`${trigger}:ctrl`);
            return true;
        }
        const seq = auxSeqMap[key];
        if (seq) {
            const payload = modifierState.ctrl && key.length === 1 ? String.fromCharCode(key.charCodeAt(0) - 96) : seq;
            mobileStableLastActualInputAt = Date.now();
            mobileStableSuppressScrollUntil = Math.max(mobileStableSuppressScrollUntil, Date.now() + 400);
            const previousTop = wtermWrapper?.scrollTop ?? getTerminalScrollElement()?.scrollTop ?? 0;
            sendData(modifierState.alt ? '\x1b' + payload : payload, { source: 'mobile-aux-key', forceFollow: false });
            restoreMobileStableScrollTop(previousTop, 'mobile-aux-key:restore-after');
        } else {
            // Direct character keys: /, |, etc.
            const ch = String(key || '');
            if (ch) {
                let payload = ch;
                if (modifierState.ctrl && ch.length === 1 && ch >= 'a' && ch <= 'z') {
                    payload = String.fromCharCode(ch.charCodeAt(0) - 96);
                }
                mobileStableLastActualInputAt = Date.now();
                mobileStableSuppressScrollUntil = Math.max(mobileStableSuppressScrollUntil, Date.now() + 400);
                const previousTop = wtermWrapper?.scrollTop ?? getTerminalScrollElement()?.scrollTop ?? 0;
                sendData(modifierState.alt ? '\x1b' + payload : payload, { source: 'mobile-aux-key', forceFollow: false });
                restoreMobileStableScrollTop(previousTop, 'mobile-aux-key-char:restore-after');
            }
        }
        // Auto-release Ctrl, Alt after one non-modifier key press (sticky modifier)
        releaseMobileAuxModifiers();
        keepMobileAuxImeFocused(`${trigger}:after`);
        return true;
    }

    function pointInsideAuxButton(btn, e) {
        if (!btn || typeof e.clientX !== 'number' || typeof e.clientY !== 'number') return true;
        const rect = btn.getBoundingClientRect();
        const pad = 8;
        return e.clientX >= rect.left - pad && e.clientX <= rect.right + pad
            && e.clientY >= rect.top - pad && e.clientY <= rect.bottom + pad;
    }

    // Keep keyboard open: aux buttons must never take focus away from the hidden IME proxy.
    // pointerdown is intentionally non-passive so preventDefault can stop Android/WebView
    // from focusing the button and closing the soft keyboard before click runs.
    mobileAuxKeys.addEventListener('pointerdown', (e) => {
        const btn = e.target.closest('.aux-key');
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        auxPointerState = {
            pointerId: e.pointerId,
            btn,
            x: e.clientX,
            y: e.clientY,
            scrollLeft: mobileAuxKeys.scrollLeft,
            moved: false,
        };
        btn.classList.add('aux-pressing');
        try { btn.setPointerCapture?.(e.pointerId); } catch (_) {}
        keepMobileAuxImeFocused('mobile-aux-pointerdown');
    }, { passive: false });

    mobileAuxKeys.addEventListener('pointermove', (e) => {
        if (!auxPointerState || auxPointerState.pointerId !== e.pointerId) return;
        const dx = e.clientX - auxPointerState.x;
        const dy = e.clientY - auxPointerState.y;
        if (Math.abs(dx) > 6 || Math.abs(dy) > 8) auxPointerState.moved = true;
        if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 4) {
            e.preventDefault();
            e.stopPropagation();
            mobileAuxKeys.scrollLeft = auxPointerState.scrollLeft - dx;
        }
    }, { passive: false });

    mobileAuxKeys.addEventListener('pointerup', (e) => {
        if (!auxPointerState || auxPointerState.pointerId !== e.pointerId) return;
        const state = auxPointerState;
        auxPointerState = null;
        e.preventDefault();
        e.stopPropagation();
        state.btn.classList.remove('aux-pressing');
        try { state.btn.releasePointerCapture?.(e.pointerId); } catch (_) {}
        if (!state.moved && pointInsideAuxButton(state.btn, e)) {
            auxLastHandledAt = performance.now();
            handleMobileAuxKey(state.btn, 'mobile-aux-pointerup');
        }
        keepMobileAuxImeFocused('mobile-aux-pointerup');
    }, { passive: false });

    mobileAuxKeys.addEventListener('pointercancel', (e) => {
        if (!auxPointerState || auxPointerState.pointerId !== e.pointerId) return;
        auxPointerState.btn?.classList.remove('aux-pressing');
        auxPointerState = null;
        keepMobileAuxImeFocused('mobile-aux-pointercancel');
    }, { passive: true });

    mobileAuxKeys.addEventListener('click', (e) => {
        const btn = e.target.closest('.aux-key');
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        keepMobileAuxImeFocused('mobile-aux-click');
        if (performance.now() - auxLastHandledAt < 350) return;
        auxLastHandledAt = performance.now();
        handleMobileAuxKey(btn, 'mobile-aux-click');
    }, { passive: false });
}

const keySequences = {
    esc: '\x1b', tab: '\t', home: '\x1b[1~', end: '\x1b[4~',
    up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C',
    f1: '\x1bOP', f2: '\x1bOQ', f3: '\x1bOR', f4: '\x1bOS',
    f5: '\x1b[15~', f6: '\x1b[17~', f7: '\x1b[18~', f8: '\x1b[19~',
    f9: '\x1b[20~', f10: '\x1b[21~', f11: '\x1b[23~', f12: '\x1b[24~',
};
const comboSequences = Object.fromEntries('abcdefghijklmnopqrstuvwxyz'.split('').map((ch) => [`ctrl-${ch}`, String.fromCharCode(ch.charCodeAt(0) - 96)]));

// 保留选区
wtermWrapper.addEventListener('mouseup', () => {
    const selection = window.getSelection();
    if (mobileTerminalSelectionMode || selection?.toString?.().length > 0 || isTouchKeyboardDevice()) return;
    term?.focus?.();
});
async function pasteClipboardIntoTerminal(source = 'terminal-contextmenu') {
    let text = '';
    try {
        text = await navigator.clipboard?.readText?.() || '';
    } catch (err) {
        console.warn('[terminal-paste]', 'clipboard read failed', err);
    }
    if (!text) return false;
    logTerminalPasteDiagnostics(source, text);
    sendData(prepareTerminalPastePayload(text), { source, forceFollow: true, applyModifiers: false });
    if (!isTouchKeyboardDevice()) {
        try { term?.focus?.(); } catch (_) {}
    }
    return true;
}

function prepareTerminalPastePayload(text = '') {
    const raw = String(text);
    const bridge = term?.bridge;
    try {
        if (bridge?.bracketedPaste?.()) {
            return '\x1b[200~' + raw.replace(/\x1b/g, '') + '\x1b[201~';
        }
    } catch (_) {}
    return raw;
}

function terminalPointerCellFromEvent(e) {
    if (!wtermWrapper) return null;
    const rect = wtermWrapper.getBoundingClientRect();
    const style = getComputedStyle(wtermWrapper);
    const paddingLeft = parseFloat(style.paddingLeft) || 0;
    const paddingTop = parseFloat(style.paddingTop) || 0;
    const { lineHeight, charWidth } = getTerminalCharMetrics();
    const x = (e.clientX ?? e.touches?.[0]?.clientX ?? 0) - rect.left - paddingLeft;
    const y = (e.clientY ?? e.touches?.[0]?.clientY ?? 0) - rect.top - paddingTop + (wtermWrapper.scrollTop || 0);
    const col = Math.max(0, Math.min(Number(term?.cols || 80) - 1, Math.floor(x / Math.max(1, charWidth))));
    const absoluteRow = Math.max(0, Math.floor(y / Math.max(1, lineHeight)));
    const scrollback = Number(term?.bridge?.getScrollbackCount?.() || 0);
    const row = Math.max(0, Math.min(Number(term?.rows || 24) - 1, absoluteRow - scrollback));
    return { col, row };
}

function encodeSgrMouse(button, col, row, suffix = 'M') {
    return `\x1b[<${button};${col + 1};${row + 1}${suffix}`;
}

function updateTerminalMouseTrackingFromData(data = '') {
    const text = String(data || '');
    if (!text.includes('\x1b[')) return;
    const re = /\x1b\[\?([0-9;]+)([hl])/g;
    let match;
    while ((match = re.exec(text))) {
        const params = match[1].split(';').map(Number);
        const enable = match[2] === 'h';
        for (const p of params) {
            if (p === 1006) terminalMouseState.sgr = enable;
            if (p === 1000 || p === 1002 || p === 1003) {
                terminalMouseState.enabled = enable;
                terminalMouseState.mode = enable ? String(p) : 'none';
            }
        }
    }
    terminalContainer?.classList.toggle('terminal-mouse-mode', terminalMouseState.enabled);
}

function terminalMouseTrackingEnabled() {
    return !!terminalMouseState.enabled && !!terminalMouseState.sgr;
}

function sendTerminalMouseEvent(e, kind = 'press') {
    if (!terminalMouseTrackingEnabled()) return false;
    const cell = terminalPointerCellFromEvent(e);
    if (!cell) return false;
    const base = e.button === 2 ? 2 : e.button === 1 ? 1 : 0;
    let button = kind === 'release' ? 3 : base;
    if (e.shiftKey) button += 4;
    if (e.altKey) button += 8;
    if (e.ctrlKey) button += 16;
    if (kind === 'move') button = 32 + (terminalMouseState.buttonDown ? base : 3);
    if (kind === 'press') terminalMouseState.buttonDown = true;
    if (kind === 'release') terminalMouseState.buttonDown = false;
    sendData(encodeSgrMouse(button, cell.col, cell.row, kind === 'release' ? 'm' : 'M'), { source: 'mouse-sgr', applyModifiers: false });
    return true;
}

function sendTerminalMouseWheelEvent(e) {
    if (!terminalMouseTrackingEnabled()) return false;
    const cell = terminalPointerCellFromEvent(e);
    if (!cell) return false;
    const button = e.deltaY < 0 ? 64 : 65;
    sendData(encodeSgrMouse(button, cell.col, cell.row, 'M'), { source: 'mouse-wheel-sgr', applyModifiers: false });
    return true;
}

function updateTerminalWebLinks() {
    // 只给整行纯文本输出做链接化；如果 wterm 已经用 span 渲染颜色/样式，绝不重写 DOM，避免破坏 ANSI 颜色和复制。
    if (!wtermWrapper || updateTerminalWebLinks._raf) return;
    updateTerminalWebLinks._raf = requestAnimationFrame(() => {
        updateTerminalWebLinks._raf = 0;
        const rows = wtermWrapper.querySelectorAll?.('.term-row, .term-scrollback-row') || [];
        rows.forEach((row) => {
            const text = row.textContent || '';
            if (row.dataset.zephyrLinks === '1' && row.dataset.zephyrLinkText === text) return;
            if (row.dataset.zephyrLinks === '1' && row.dataset.zephyrLinkText !== text) {
                delete row.dataset.zephyrLinks;
                delete row.dataset.zephyrLinkText;
            }
            if (row.children.length > 0) return;
            TERMINAL_LINK_PROTOCOL_RE.lastIndex = 0;
            if (!TERMINAL_LINK_PROTOCOL_RE.test(text)) return;
            TERMINAL_LINK_PROTOCOL_RE.lastIndex = 0;
            const frag = document.createDocumentFragment();
            let last = 0;
            let match;
            while ((match = TERMINAL_LINK_PROTOCOL_RE.exec(text))) {
                const start = match.index;
                const url = match[0].replace(/[),.;:!?]+$/g, '');
                if (start > last) frag.appendChild(document.createTextNode(text.slice(last, start)));
                const a = document.createElement('a');
                a.className = 'terminal-link';
                a.href = url;
                a.target = '_blank';
                a.rel = 'noopener noreferrer';
                a.textContent = url;
                frag.appendChild(a);
                last = start + url.length;
                if (url.length < match[0].length) frag.appendChild(document.createTextNode(match[0].slice(url.length)));
            }
            if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
            row.textContent = '';
            row.appendChild(frag);
            row.dataset.zephyrLinks = '1';
            row.dataset.zephyrLinkText = text;
        });
    });
}

wtermWrapper.addEventListener('contextmenu', async (e) => {
    const selection = window.getSelection();
    if (selection?.toString?.().length > 0) return;
    // 移动端长按需要留给系统文本选择/复制；自动读剪贴板粘贴会和选区手势冲突。
    // 桌面端仍保留右键粘贴。
    if (isTouchKeyboardDevice()) return;
    if (terminalMouseTrackingEnabled()) {
        sendTerminalMouseEvent(e, 'press');
        return;
    }
    e.preventDefault();
    const ok = await pasteClipboardIntoTerminal('terminal-right-click-paste');
    if (!ok) console.info('[terminal-paste]', t('右键粘贴需要浏览器剪贴板权限或非空文本剪贴板'));
});
 // 粘贴交给 @wterm/dom 官方 InputHandler 处理：
 // - 支持 bracketed paste；
 // - 在 onData 前执行 WTerm 内置输入滚动；
 // - 避免外层捕获 paste 后强制滚到底。
// Mobile keyboard gestures: single facade path (ssh-keyboard). No parallel open chains.
['pointerdown', 'touchstart'].forEach((eventName) => {
    wtermWrapper.addEventListener(eventName, (e) => {
        terminalTouchMoved = false;
        terminalTouchStartX = e.clientX ?? e.touches?.[0]?.clientX ?? 0;
        terminalTouchStartY = e.clientY ?? e.touches?.[0]?.clientY ?? 0;
        scheduleMobileLongPressSelectionGuard(eventName);
        logTerminalCopyDiagnostics('wterm-wrapper-touch-start', {
            eventName,
            pointerType: e.pointerType || '',
            touches: e.touches?.length || 0,
        });

        const shouldHandleTap = eventName === 'pointerdown'
            ? e.pointerType === 'touch'
            : !window.PointerEvent;
        if (shouldHandleTap && handleMobileTerminalDoubleTap(e)) {
            e.preventDefault?.();
            e.stopPropagation?.();
            return;
        }

        window.clearTimeout(terminalTouchFocusTimer);
        if (eventName === 'pointerdown' && e.pointerType !== 'touch' && !hasLiveTerminalSelection() && sendTerminalMouseEvent(e, 'press')) {
            e.preventDefault();
            return;
        }

        if (isMobileStableInputMode() && !mobileTerminalSelectionMode && !hasLiveTerminalSelection()) {
            ensureSshKeyboard()?.handlePointerDown?.(e);
        }
    }, { passive: true });
});

['pointermove', 'touchmove'].forEach((eventName) => {
    wtermWrapper.addEventListener(eventName, (e) => {
        const x = e.clientX ?? e.touches?.[0]?.clientX ?? terminalTouchStartX;
        const y = e.clientY ?? e.touches?.[0]?.clientY ?? terminalTouchStartY;
        if (Math.hypot(x - terminalTouchStartX, y - terminalTouchStartY) > 8) {
            terminalTouchMoved = true;
            if (isMobileStableInputMode()) terminalUserScrollGestureUntil = Date.now() + 1400;
            if (eventName === 'pointermove' && e.pointerType !== 'touch' && terminalMouseState.buttonDown && sendTerminalMouseEvent(e, 'move')) {
                e.preventDefault();
            }
            window.clearTimeout(terminalTouchFocusTimer);
            window.clearTimeout(mobileTerminalSelectionTimer);
        }
        if (isMobileStableInputMode()) ensureSshKeyboard()?.handlePointerMove?.(e);
    }, { passive: true });
});

['pointerup', 'touchend', 'touchcancel'].forEach((eventName) => {
    wtermWrapper.addEventListener(eventName, (e) => {
        if (eventName === 'pointerup' && e.pointerType !== 'touch' && sendTerminalMouseEvent(e, 'release')) {
            e.preventDefault();
        }
        window.clearTimeout(mobileTerminalSelectionTimer);

        if (isMobileStableInputMode()) {
            const kb = ensureSshKeyboard();
            if (eventName === 'touchcancel' || e.type === 'pointercancel') {
                kb?.handlePointerCancel?.(e);
            } else if (!mobileTerminalSelectionMode && !hasLiveTerminalSelection() && !terminalTouchMoved) {
                const result = kb?.handlePointerUp?.(e);
                if (result?.opened) {
                    mobileStableLastFocusGestureAt = performance.now();
                    // Surface pin after open
                    try { ensureTerminalSurface()?.pinCursorAboveChrome?.('terminal-tap-open', { force: true }); } catch (_) {}
                }
            } else if (terminalTouchMoved) {
                // Consume pan/fling so intent does not open later
                kb?.handlePointerUp?.(e);
            }
        }

        window.setTimeout(() => {
            if (hasLiveTerminalSelection()) enterMobileTerminalSelectionMode(eventName);
            else if (mobileTerminalSelectionMode) scheduleExitMobileTerminalSelectionMode(900);
        }, 80);
        notifyParentActivity();
    }, { passive: true });
});

// ---------- 状态指示 ----------
function setStatus(state, msg) {
    notifyParentStatus(state === 'connected' ? 'connected' : state === 'error' ? 'error' : state === 'disconnected' ? 'closed' : 'connecting');
    statusDot.className = 'status-dot';
    if (state === 'connecting') {
        statusText.textContent = msg || t('连接中...');
        terminalOverlay.classList.remove('hidden');
        overlayMsg.textContent = msg || t('正在建立 SSH 连接...');
    } else if (state === 'connected') {
        statusDot.classList.add('connected');
        statusText.textContent = msg || t('已连接');
        terminalOverlay.classList.add('hidden');
        isConnected = true;
    } else if (state === 'disconnected') {
        statusDot.classList.add('disconnected');
        statusText.textContent = msg || t('已断开');
        isConnected = false;
        terminalOverlay.classList.remove('hidden');
        overlayMsg.textContent = msg || t('连接已断开');
    } else if (state === 'error') {
        statusDot.classList.add('disconnected');
        statusText.textContent = t('错误');
        isConnected = false;
        terminalOverlay.classList.remove('hidden');
        overlayMsg.textContent = msg || t('连接出错');
    }
}
{
    const proto = String(params.protocol || 'SSH').toUpperCase();
    const userHost = params.username
        ? `${params.username}@${params.host}:${params.port}`
        : `${params.host}:${params.port}`;
    connInfo.textContent = proto === 'TELNET' ? `TELNET · ${userHost}` : userHost;
}

function clearReconnectTimer() {
    if (reconnectTimer) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = 0;
    }
}

function stopTerminalResizeObserver() {
    terminalResizeCleanup?.();
    terminalResizeCleanup = null;
    window.clearTimeout(scheduleTerminalResize._timer);
    window.clearTimeout(pendingTerminalResize.timer);
    window.clearTimeout(terminalStableResizeTimer);
    window.clearTimeout(terminalKeyboardSettlingTimer);
    pendingTerminalResize = { cols: 0, rows: 0, timer: 0, reason: '' };
    terminalStableResizeTimer = 0;
    terminalViewportFreezeUntil = 0;
    terminalFitSnapshot = null;
}

function refreshTerminalAfterVisibilityRestore(reason = 'visibility-restore', { focus = false } = {}) {
    if (!term || !wtermWrapper || document.visibilityState !== 'visible') return;
    const wasAtBottom = Boolean(term._isScrolledToBottom ? term._isScrolledToBottom() : isTerminalAtBottom());
    const run = (phase) => {
        if (!term || !wtermWrapper || document.visibilityState !== 'visible' || !isEmbeddedTerminalFrameVisible()) return;
        normalizeWTermContainerLayout(`${reason}:${phase}:before`);
        const rect = getStableTerminalSurfaceRect();
        if (!rect || rect.width < TERMINAL_MIN_RESIZE_WIDTH || rect.height < TERMINAL_MIN_RESIZE_HEIGHT || wtermWrapper.offsetParent === null) {
            logTerminalLayoutDiagnostics('restore:skip-hidden-or-tiny', { reason, phase, width: Math.round(rect?.width || 0), height: Math.round(rect?.height || 0) });
            return;
        }
        repairWTermLayoutAfterVisibilityChange(`${reason}:${phase}`, { follow: wasAtBottom });
        scheduleTerminalScrollbarUpdate();
        if (focus && !isTouchKeyboardDevice()) {
            try { term.focus?.(); } catch (_) {}
        }
    };
    [0, 60, 160, 360, 720, 1200].forEach((delay, index) => window.setTimeout(() => run(`phase-${index}`), delay));
}

function resetTerminalScrollState() {
    isProgrammaticTerminalScroll = false;
    terminalAutoFollowEnabled = true;
    terminalUserScrolledAway = false;
    terminalLastUserScrollAt = 0;
    terminalLastWheelAt = 0;
    terminalUserScrollGestureUntil = 0;
    cancelMobileStableScrollRestore('reset-scroll-state');
    cancelTerminalBottomFollow('reset-scroll-state');
    parentKeyboardResizeFreezeUntil = 0;
    terminalMouseState.enabled = false;
    terminalMouseState.sgr = false;
    terminalMouseState.mode = 'none';
    terminalMouseState.buttonDown = false;
    terminalContainer?.classList.remove('terminal-follow-paused', 'terminal-mouse-mode');
    terminalContainer?.classList.add('terminal-following');
}

function destroyTerminalInstance({ clear = true } = {}) {
    stopTerminalAutoScrollObserver();
    stopTerminalResizeObserver();
    if (term) {
        try { term.destroy?.(); } catch (_) {}
        term = null;
    }
    resetTerminalScrollState();
    if (clear) wtermWrapper.innerHTML = '';
}

function closeWebSocketOnly(reason = t('重建连接'), { sendDisconnect = false } = {}) {
    const ws = wsConnection;
    wsConnection = null;
    if (!ws) return;
    try {
        if (sendDisconnect && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'disconnect' }));
    } catch (_) {}
    try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(1000, reason);
    } catch (_) {}
}

function disconnect({ userInitiated = true, updateStatus = true, destroyTerminal = true } = {}) {
    userClosedConnection = userInitiated;
    reconnectInProgress = false;
    clearReconnectTimer();
    activeConnectionToken += 1;
    closeWebSocketOnly(userInitiated ? t('用户主动断开') : t('重建连接'), { sendDisconnect: userInitiated });
    if (destroyTerminal) destroyTerminalInstance();
    isConnected = false;
    sftpReady = false;
    if (updateStatus) setStatus('disconnected', t('已断开'));
}

function syncFeaturePanelsAfterConnection() {
    // 重置所有特性状态
    sftpReady = false;
    dockerChecked = false;
    dockerInstalled = false;
    dockerCurrentLogContainer = null;
    dockerLogBuffer = '';
    dockerAutoScrollLog = true;
    if (dockerLogDrawer) dockerLogDrawer.style.display = 'none';
    if (dockerPullBtn) dockerPullBtn.disabled = false;
    
    // 现在重新初始化打开的面板
    if (fileManager?.classList.contains('open')) {
        initSFTP();
    }
    if (dockerPanel?.classList.contains('open')) {
        checkDockerStatus({ force: true });
    }
    
    // 确保桌面端终端获得焦点并可见；移动端只能通过键盘按钮唤起输入法。
    setTimeout(() => {
        if (!isTouchKeyboardDevice() && term && typeof term.focus === 'function') {
            try { term.focus(); } catch (_) {}
        }
    }, 100);
}

function sleep(ms) {
    return new Promise((resolve) => { reconnectTimer = window.setTimeout(resolve, ms); });
}

async function startFreshConnection({ message = t('正在建立 SSH 连接...'), resetAttempts = false, followOnConnect = true } = {}) {
    clearReconnectTimer();
    userClosedConnection = false;
    activeConnectionToken += 1;
    const token = activeConnectionToken;
    closeWebSocketOnly(t('重建连接'));
    destroyTerminalInstance();
    setStatus('connecting', message);
    if (resetAttempts) reconnectAttempts = 0;
    await initWTerm(token, { followOnConnect });
    await connectWebSocket(token, { followOnConnect });
    if (token !== activeConnectionToken) throw new Error(t('连接已被新的会话替换'));
    syncFeaturePanelsAfterConnection();
    if (!isTouchKeyboardDevice()) scheduleTerminalResize();
}

async function startAutoReconnect(reason = t('连接已断开')) {
    if (userClosedConnection || reconnectInProgress) return;
    reconnectInProgress = true;
    while (!userClosedConnection && !isConnected && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts += 1;
        const label = `正在重连 (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`;
        setStatus('connecting', label);
        showToast(`${reason}，${label}`, 'info', 2200);
        try {
            await sleep(2000);
            reconnectTimer = 0;
            if (userClosedConnection || isConnected) break;
            await startFreshConnection({ message: label, resetAttempts: false, followOnConnect: false });
            reconnectAttempts = 0;
            reconnectInProgress = false;
            showToast('自动重连成功', 'success');
            return;
        } catch (err) {
            reconnectTimer = 0;
            if (userClosedConnection || isConnected) break;
            console.warn(t('[SSH] 自动重连失败:'), err.message);
        }
    }
    reconnectInProgress = false;
    if (!userClosedConnection && !isConnected) {
        setStatus('error', '自动重连失败，请手动点击“重连”');
        showToast('自动重连失败，请手动点击“重连”', 'error', 4200);
    }
}

// ---------- WTerm 初始化 ----------
let terminalUserGestureAt = 0;
function noteTerminalUserGesture() { terminalUserGestureAt = Date.now(); }
function decodeOsc52Base64(value) {
    const input = String(value || '');
    if (!input || input.length > 65535 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input)) return null;
    try { const binary = atob(input), bytes = new Uint8Array(binary.length); for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i); return new TextDecoder().decode(bytes); }
    catch { return null; }
}
async function handleTerminalClipboardRequest(request) {
    const query = !!request?.query, detail = { selection: String(request?.selection || 'c'), query, text: null, allowed: false };
    if (query) { window.dispatchEvent(new CustomEvent('wterm-clipboard-query-blocked', { detail })); return; }
    const text = decodeOsc52Base64(request?.base64); if (text == null) return; detail.text = text;
    if (!window.dispatchEvent(new CustomEvent('wterm-clipboard-write', { detail, cancelable: true }))) return;
    if (!document.hasFocus() || Date.now() - terminalUserGestureAt > 10000 || !navigator.clipboard?.writeText) { if (typeof showToast === 'function') showToast('终端请求写入剪贴板，请先点击终端后重试'); return; }
    try { await navigator.clipboard.writeText(text); detail.allowed = true; }
    catch { if (typeof showToast === 'function') showToast('浏览器阻止了终端剪贴板写入'); }
}

async function initWTerm(connectionToken = activeConnectionToken, { followOnConnect = true } = {}) {
    mobileWTermInputGuard = null;
    let WTermClass;
    // Default engine: xterm.js headless (VT/buffer) + wterm DOM renderer.
    // Register the Terminal ctor before WTerm.init so XtermBridge.load works
    // without a bare npm resolver in the browser.
    try {
        await import('/vendor/wterm-fork/core/xterm-headless-register.js?v=20260723-sync2');
    } catch (err) {
        console.error('[terminal] xterm-headless register failed', err);
        throw err;
    }
    try {
        // Zephyr fork of @wterm/dom with public viewport API. DOM/input/viewport
        // stay wterm; core is XtermBridge over vendored xterm (see /xterm).
        const module = await import('/vendor/wterm-fork/index.js?v=20260723-sync2');
        WTermClass = module.WTerm;
    } catch {
        try {
            const module = await import('/vendor/@wterm/dom/dist/index.js');
            WTermClass = module.WTerm;
        } catch {
            const module = await import('/vendor/@wterm/dom/dist/wterm.js');
            WTermClass = module.WTerm || module.default;
        }
    }
    if (connectionToken !== activeConnectionToken) throw new Error(t('终端初始化已取消'));
    wtermWrapper.innerHTML = '';
    normalizeWTermContainerLayout('init-before-create');
    try {
        term = new WTermClass(wtermWrapper, {
            cols: 80,
            rows: 24,
            // xterm headless = VT/buffer/reflow; wterm DOM = paint/selection/IME shell.
            engine: 'xterm',
            scrollback: 5000,
            // 滚动逻辑完全交给 DOM 层 write()/InputHandler；
            // resize 仍由项目层在“可见且尺寸稳定”时手动转发到 ssh2，避免隐藏 iframe/iOS 恢复时的 0px 瞬时尺寸破坏 PTY。
            autoResize: false,
            cursorBlink: true,
            theme: getPreferredWtermTheme() === 'light' ? 'light' : 'default',
            fontSize: terminalFontSize,
            allowLigatures: getTerminalAllowLigatures(),
            renderer: (localStorage.getItem('zephyr-terminal-renderer') === 'canvas' ? 'canvas' : 'dom'),
            // Mobile is an EXTERNAL input surface: the only IME is
            // #mobileTerminalImeProxy → TerminalSurface. WTerm must not focus
            // its hidden textarea or self-scroll before Zephyr decides.
            inputMode: isTouchKeyboardDevice() ? 'external' : 'native',
            onExternalInputRequest: () => {
                if (isMobileStableInputMode()) ensureTerminalSurface()?.onTerminalTap?.('wterm-external-input');
            },
            onData: (data) => sendData(data, { source: 'wterm-onData' }),
            onClipboard: (request) => { void handleTerminalClipboardRequest(request); },
            onResize: (cols, rows) => {
                if (!suppressWTermResizeEvent) sendTerminalResize(cols, rows, { reason: 'wterm-onResize' });
            },
        });
    } catch {
        term = new WTermClass(wtermWrapper, { engine: 'xterm' });
        if (typeof term.onData === 'function') term.onData(data => sendData(data, { source: 'wterm-onData' }));
        else if (typeof term.on === 'function') term.on('data', data => sendData(data, { source: 'wterm-onData' }));
    }
    term.onClipboard = (request) => { void handleTerminalClipboardRequest(request); };
    wtermWrapper.addEventListener('pointerdown', noteTerminalUserGesture, { passive: true });
    wtermWrapper.addEventListener('keydown', noteTerminalUserGesture, true);
    // Desktop double-click → xterm word separators; browser copies selection only.
    if (!wtermWrapper._zephyrWordSelectBound) {
        wtermWrapper._zephyrWordSelectBound = true;
        wtermWrapper.addEventListener('dblclick', handleTerminalDesktopDblClick);
    }
    // Touch vertical pan → xterm ydisp history (DOM scroll is disabled).
    if (!wtermWrapper._zephyrHistoryPanBound) {
        wtermWrapper._zephyrHistoryPanBound = true;
        let panY0 = 0;
        let panAccum = 0;
        let panActive = false;
        let panMoved = false;
        const rhOf = () => Math.max(1, term?.getViewportState?.()?.rowHeight
            || getTerminalCharMetrics?.()?.lineHeight || 17);
        const onPanStart = (e) => {
            if (!term?.bridge?.scrollLines) return;
            // One finger only; ignore multi-touch pinch.
            if (e.touches && e.touches.length !== 1) return;
            if (e.pointerType && e.pointerType !== 'touch') return;
            if (mobileTerminalSelectionMode || hasLiveTerminalSelection?.()) return;
            panY0 = e.clientY ?? e.touches?.[0]?.clientY ?? 0;
            panAccum = 0;
            panActive = true;
            panMoved = false;
        };
        const onPanMove = (e) => {
            if (!panActive || !term?.bridge?.scrollLines) return;
            if (e.touches && e.touches.length !== 1) return;
            const y = e.clientY ?? e.touches?.[0]?.clientY ?? panY0;
            const dy = y - panY0;
            if (!panMoved && Math.abs(dy) < 6) return;
            panMoved = true;
            // Finger up → content follows finger → show older history (negative lines).
            // dy>0 (finger down) ⇒ scrollLines negative.
            panAccum += -dy;
            panY0 = y;
            const rh = rhOf();
            if (Math.abs(panAccum) < rh) {
                if (panMoved) e.preventDefault?.();
                return;
            }
            const lines = Math.trunc(panAccum / rh);
            panAccum -= lines * rh;
            if (lines) {
                e.preventDefault?.();
                scrollTerminalHistoryLines(lines, 'touch-pan');
            }
        };
        const onPanEnd = () => {
            panActive = false;
            panMoved = false;
            panAccum = 0;
        };
        // Prefer PointerEvent when available (one path). Dual touch+pointer on
        // Android doubles every scrollLines → 2× full paint jank.
        const usePointer = typeof window.PointerEvent === 'function';
        if (usePointer) {
            wtermWrapper.addEventListener('pointerdown', (e) => {
                if (e.pointerType === 'touch' || e.pointerType === 'pen') onPanStart(e);
            }, { passive: true });
            wtermWrapper.addEventListener('pointermove', (e) => {
                if ((e.pointerType === 'touch' || e.pointerType === 'pen') && panActive) onPanMove(e);
            }, { passive: false });
            wtermWrapper.addEventListener('pointerup', onPanEnd, { passive: true });
            wtermWrapper.addEventListener('pointercancel', onPanEnd, { passive: true });
        } else {
            wtermWrapper.addEventListener('touchstart', onPanStart, { passive: true });
            wtermWrapper.addEventListener('touchmove', onPanMove, { passive: false });
            wtermWrapper.addEventListener('touchend', onPanEnd, { passive: true });
            wtermWrapper.addEventListener('touchcancel', onPanEnd, { passive: true });
        }
    }
    if (typeof term.init === 'function') await term.init();
    // After every paint, enforce last-content above tools ONLY while following.
    // Skip while reading history — measure+layout every frame during touch pan is jank.
    try {
        term?.onRenderComplete?.(() => {
            if (!terminalAutoFollowEnabled || isTerminalUserReadingHistory?.()) return;
            if (!isTerminalAtBottom(undefined, TERMINAL_XTERM_SCROLL_LOCK_THRESHOLD)) return;
            scheduleEnsureActiveLineAboveChrome('wterm-render-complete');
        });
    } catch (_) {}
 
terminalRemoteHistory?.destroy?.();
    terminalRemoteHistory = createTerminalRemoteHistory({
        wrapper: wtermWrapper,
        getSessionId: () => terminalHistorySessionId,
        maxCachedRows: 2000,
        pageSize: 200,
    });
    normalizeWTermContainerLayout('init-after-wterm-init');
    if (connectionToken !== activeConnectionToken) throw new Error(t('终端初始化已取消'));
    lastSentTerminalSize = { cols: Number(term.cols || 80), rows: Number(term.rows || 24) };
    rememberTerminalFitSnapshot('init-wterm');
    applyWtermTheme(getPreferredWtermTheme());
    applyTerminalFontSize(terminalFontSize, { persist: false });
    applyTerminalLigatures(terminalAllowLigatures, { persist: false });
    // Font/theme may have changed CSS before first paint — force one more
    // authoritative cell measure so cursor overlay px matches the live font.
    try { term?.refreshCellMetrics?.(); } catch (_) {}
    patchWTermScrollBehavior();
    // Bind unified surface to this term (mobile scroll/keyboard control plane).
    if (isMobileStableInputMode() || isTouchKeyboardDevice()) {
        const surface = ensureTerminalSurface();
        surface?.attachTerm?.('term-created');
        surface?.setFollowEnabled?.(!!terminalAutoFollowEnabled, 'term-created');
    }
    restoreMobileWTermNativeInput();
    // External mode is declared in WTerm source; no readonly/pointer-event
    // outer guard or focus monkey-patch is allowed on mobile.
    if (isMobileStableInputMode()) {
        rememberMobileStableKeyboardGrid('init-wterm-grid');
    }

    // 滚动逻辑使用 @wterm/dom 官方实现；项目层只在 iframe/页面可见且尺寸稳定时调用 term.resize，并同步 ssh2 setWindow。
    terminalResizeCleanup = setupStableTerminalResizeObserver();
    scheduleTerminalResize('initial-visible-resize', 80);
    setupTerminalScrollHooks({ followOnConnect });
    if (isMobileStableInputMode()) {
        [180, 520].forEach((delay) => window.setTimeout(() => rememberMobileStableKeyboardGrid(`initial-visible-grid:${delay}`), delay));
    }
}

// ---------- WebSocket 连接 ----------
function connectWebSocket(connectionToken = activeConnectionToken, { followOnConnect = true } = {}) {
    writeTerminalData._mobileFirstDataFlushed = false;
    return new Promise((resolve, reject) => {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(`${proto}//${location.host}/ssh`);
        let settled = false;
        let ready = false;
        const fail = (err) => {
            if (settled) return;
            settled = true;
            reject(err instanceof Error ? err : new Error(String(err || t('连接失败'))));
        };
        const timeout = setTimeout(() => {
            try { ws.close(); } catch (_) {}
            fail(new Error(t('连接超时')));
        }, 10000);

        ws.addEventListener('open', () => {
            if (connectionToken !== activeConnectionToken) { try { ws.close(); } catch (_) {} return; }
            clearTimeout(timeout);
            const initialSize = getInitialTerminalSize();
            ws.send(JSON.stringify({
                type: 'connect',
                sessionId: params.tabId || params.sessionId || params.connectionId || '',
                connectionId: params.connectionId || '',
                host: params.host,
                port: params.port,
                username: params.username,
                password: params.password || '',
                privateKey: params.privateKey || '',
                sshKeyId: params.sshKeyId || '',
                connectionMode: params.connectionMode || 'direct',
                proxyId: params.proxyId || '',
                jumpHostId: params.jumpHostId || '',
                jumpHostIds: Array.isArray(params.jumpHostIds) ? params.jumpHostIds : [],
                protocol: params.protocol || params.transientOverrides?.protocol || 'SSH',
                encoding: params.encoding || params.transientOverrides?.encoding || 'utf-8',
                // One-time Deep Link credential (FREEZE plan §5.4); server
                // consumes it atomically and never writes it to assets.
                transientToken: params.transientToken || '',
                transientOverrides: params.transientOverrides || null,
                // Ad-hoc temporary connect from "新建连接 → 临时连接" — never saved.
                ephemeral: !!params.ephemeral || !!params.transient,
                init: params.init || '',
                cols: initialSize.cols,
                rows: initialSize.rows
            }));
        });

        ws.addEventListener('message', (event) => {
            if (connectionToken !== activeConnectionToken) return;
            try {
                const msg = JSON.parse(event.data);
                if (msg.type === 'stats') { renderStatsSoon(msg.data); return; }
                if (msg.type === 'stats-error') {
                    if (infoModal?.classList?.contains('open') && infoBody && (!latestStatsData || infoBody.querySelector('.info-loading'))) {
                        infoBody.innerHTML = `<div class="info-loading error">实时监控数据加载失败：${escapeHtml(msg.message || t('未知错误'))}</div>`;
                    }
                    return;
                }
                if (msg.type === 'process-action-result') {
                    processBusyPid = 0;
                    showToast(msg.message || (msg.ok ? t('进程操作已发送') : t('进程操作失败')), msg.ok ? 'success' : 'error');
                    wsConnection?.send?.(JSON.stringify({ type: 'stats-request' }));
                    return;
                }
                if (msg.type?.startsWith('sftp-')) {
                    const mediaPanel = msg.path
                        ? (mediaPreviewPanelsByPath.get(msg.path) || Array.from(mediaPreviewPanelsByPath.values()).find((instance) => instance?.currentPath === msg.path || instance?.pending?.has?.(msg.path)))
                        : activeMediaPreview;
                    if (mediaPanel?.handleMessage?.(msg)) return;
                    const imagePanel = msg.path
                        ? (imagePreviewPanelsByPath.get(msg.path) || Array.from(imagePreviewPanelsByPath.values()).find((instance) => instance?.currentPath === msg.path || instance?.pending?.has?.(msg.path)))
                        : activeImagePreview;
                    if (imagePanel?.handleMessage?.(msg)) return;
                    handleSFTPMessage(msg);
                    return;
                }
                if (msg.type?.startsWith('docker-')) { handleDockerMessage(msg); return; }
                switch (msg.type) {
                    case 'ready':
                        if (msg.sessionId) {
                            terminalHistorySessionId = String(msg.sessionId);
                            terminalRemoteHistory?.setSession?.(terminalHistorySessionId);
                        }
                        // Surface protocol / encoding / plaintext warning in the top bar.
                        {
                            const proto = String(msg.protocol || params.protocol || 'SSH').toUpperCase();
                            const enc = String(msg.encoding || params.encoding || '').toLowerCase();
                            const userHost = params.username
                                ? `${params.username}@${params.host}:${params.port}`
                                : `${params.host}:${params.port}`;
                            let label = proto === 'TELNET' ? `TELNET · ${userHost}` : userHost;
                            if (proto === 'TELNET' && enc && enc !== 'utf-8' && enc !== 'utf8') label += ` · ${enc.toUpperCase()}`;
                            if (connInfo) connInfo.textContent = label;
                            if (proto === 'TELNET' && msg.warning) {
                                try { showToast?.(msg.warning, 'warning'); } catch (_) {}
                            }
                                                }
                        ready = true;
                        settled = true;
                        if (msg.cols && msg.rows) {
                            const readyCols = Math.floor(Number(msg.cols));
                            const readyRows = Math.floor(Number(msg.rows));
                            if (Number.isFinite(readyCols) && Number.isFinite(readyRows) && readyCols >= 20 && readyRows >= 2) {
                                const measured = getInitialTerminalSize();
                                const sameAsCurrentView = Math.abs(measured.cols - readyCols) <= 1 && Math.abs(measured.rows - readyRows) <= 1;
                                const attachedReady = !!msg.attached;
                                const mobileStableReady = isMobileStableInputMode();
                                lastSentTerminalSize = { cols: readyCols, rows: readyRows };
                                if (mobileStableReady) {
                                    runWithMobileStableResizeBypass(() => resizeWTermSafely(readyCols, readyRows, attachedReady ? 'attach-existing-pty' : 'ready-pty'));
                                    rememberMobileStableKeyboardGrid('ready-pty');
                                } else if (attachedReady || sameAsCurrentView) {
                                    resizeWTermSafely(readyCols, readyRows, attachedReady ? 'attach-existing-pty' : 'ready-pty');
                                }
                                rememberTerminalFitSnapshot('ready-pty');
                            }
                        }
                        setStatus('connected', msg.attached ? t('已恢复会话') : t('已连接'));
                        applyTerminalWorkspaceState();
                        if (!isMobileStableInputMode()) {
                            window.setTimeout(() => repairOversizedWTermRows('ready-oversized-rows', { force: true }), 120);
                        }
                        if (!isTouchKeyboardDevice() && term?.focus) term.focus();
                        reconnectAttempts = 0;
                        // After replaying a detached session, always pin to the latest line so the
                        // restored surface matches "what I left open", not a mid-history viewport.
                        if (followOnConnect || msg.attached || msg.replayed) {
                            requestAnimationFrame(() => {
                                try { term?.scrollToBottom?.(); } catch (_) {}
                                scheduleTerminalScrollbarUpdate();
                            });
                        } else {
                            scheduleTerminalScrollbarUpdate();
                        }
                        requestInitialMobileRenderFlush('connect-ready');
                        resolve(ws);
                        break;
                    case 'data':
                        writeTerminalData(msg.data);
                        if (msg.replay || msg.extra?.replay) {
                            // Keep the viewport on the live end while history is replaying.
                            try { term?.scrollToBottom?.(); } catch (_) {}
                        }
                        if (isTouchKeyboardDevice() && !writeTerminalData._mobileFirstDataFlushed) {
                            writeTerminalData._mobileFirstDataFlushed = true;
                            requestInitialMobileRenderFlush('first-data');
                        }
                        break;
                    case 'error':
                        setStatus('error', msg.message);
                        fail(new Error(msg.message));
                        break;
                    case 'close': {
                        const closeCode = String(msg.code || '');
                        const closeMsg = msg.message
                            || (closeCode === 'remote_close' ? t('对端关闭了连接')
                                : closeCode === 'remote_error' ? t('连接异常断开')
                                : closeCode === 'detached_ttl' ? t('会话因空闲超时已关闭')
                                : t('会话已关闭'));
                        setStatus('disconnected', closeMsg);
                        // Remote peer close/error: allow auto-reconnect. Client-initiated / TTL: do not thrash.
                        const allowReconnect = !userClosedConnection && closeCode !== 'detached_ttl' && closeCode !== 'client_disconnect';
                        if (allowReconnect) {
                            try { ws.close(4000, 'session-close'); } catch (_) {}
                            startAutoReconnect(closeMsg);
                        } else if (embeddedMode && userClosedConnection) {
                            notifyParentCloseRequest('ssh-session-close');
                        } else if (embeddedMode && closeCode === 'detached_ttl') {
                            notifyParentCloseRequest('session-ttl');
                        }
                        break;
                    }
                    case 'banner':
                        writeTerminalData(msg.data);
                        break;
                }
            } catch (_) {}
        });

        ws.addEventListener('error', () => clearTimeout(timeout));
        ws.addEventListener('close', (e) => {
            clearTimeout(timeout);
            if (connectionToken !== activeConnectionToken) return;
            if (wsConnection === ws) wsConnection = null;
            if (!ready) {
                fail(new Error(`连接已关闭 (${e.code || 'N/A'})`));
                return;
            }
            if (isConnected) setStatus('disconnected', `断开 (${e.code})`);
            if (!userClosedConnection) {
                startAutoReconnect(`连接已断开 (${e.code || 'N/A'})`);
            } else if (embeddedMode) {
                notifyParentCloseRequest(`websocket-close-${e.code || 'N/A'}`);
            }
        });

        if (connectionToken === activeConnectionToken) wsConnection = ws;
        else { try { ws.close(); } catch (_) {} }
    });
}

async function reconnect() {
    if (reconnectInProgress) return;
    reconnectInProgress = true;
    reconnectBtn.disabled = true;
    try {
        await startFreshConnection({ message: t('正在重连...'), resetAttempts: true });
        showToast('重连成功', 'success');
    } catch (err) {
        setStatus('error', err.message);
        showToast(`重连失败：${err.message}`, 'error', 4200);
    } finally {
        reconnectInProgress = false;
        reconnectBtn.disabled = false;
    }
}

async function main() {
    try {
        await initI18n({ applyDom: true });
        await startFreshConnection({ message: t('正在初始化终端...'), resetAttempts: true });
    } catch (err) {
        setStatus('error', err.message);
        startAutoReconnect(err.message);
    }
}

reconnectBtn.addEventListener('click', reconnect);

// ---------- 移动端软键盘处理 ----------
function handleKeyboardShow() {
    ensureSshKeyboard()?.openTerminal?.('legacy-show');
    applyFacadeChrome('legacy-show');
}

function handleKeyboardHide() {
    ensureSshKeyboard()?.close?.('legacy-hide', { force: true });
    applyFacadeChrome('legacy-hide');
}

if (typeof visualViewport !== 'undefined') {
    // 监听已在 setupMobileKeyboardAvoidance 中统一注册，避免重复触发布局更新造成跳动。
}

window.addEventListener('orientationchange', () => {
    mobileStableOrientationResizeUntil = Date.now() + 1800;
    mobileStableKeyboardOpenGrid = null;
    setTimeout(() => {
        setStableViewportHeight({ force: true });
        handleKeyboardHide();
        if (!isTouchKeyboardDevice()) scheduleTerminalResize();
        else if (isMobileStableInputMode()) scheduleTerminalResize('orientationchange-settled', 900);
    }, 300);
});
disconnectBtn.addEventListener('click', () => {
    disconnect({ userInitiated: true });
    sessionStorage.removeItem(params?.tabId ? `zephyr_ssh_params_${params.tabId}` : 'zephyr_ssh_params');
    if (embeddedMode) {
        notifyParentStatus('closed');
        notifyParentCloseRequest('user-disconnect-button');
        document.body.innerHTML = `<div class="terminal-placeholder" style="padding:24px;color:#9a9ca3">${t('会话已断开，正在关闭此终端窗口...')}</div>`;
    } else {
        window.location.href = '/';
    }
});
window.addEventListener('beforeunload', () => {
    userClosedConnection = true;
    clearReconnectTimer();
    closeWebSocketOnly(t('页面卸载'), { sendDisconnect: false });
});

main();
requestParentSharedFileClipboard();
