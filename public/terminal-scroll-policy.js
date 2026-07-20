/**
 * Terminal buffer scroll policy (Netcatty-aligned).
 *
 * Rules:
 * 1. At-bottom is decided by the terminal API / viewport metrics — not DOM rect heuristics.
 * 2. Already at bottom ⇒ never call scrollToBottom (0 scroll API calls).
 * 3. One event ⇒ at most one scroll decision / one scroll API call.
 * 4. Printable input may follow; control/ESC sequences default not to.
 * 5. Remote output does NOT auto-scroll by default (stick-to-bottom is the
 *    terminal core's job while already at bottom).
 * 6. Composition / IME intermediate updates never scroll.
 *
 * Reference: binaricat/Netcatty domain/terminalScroll.ts
 */

/**
 * @typedef {object} TerminalScrollSettings
 * @property {boolean} [scrollOnInput]
 * @property {boolean} [scrollOnOutput]
 * @property {boolean} [scrollOnKeyPress]
 * @property {boolean} [scrollOnPaste]
 */

/**
 * @typedef {object} TerminalScrollTarget
 * @property {() => boolean} [isAtBottom]
 * @property {() => void} [scrollToBottom]
 * @property {{ atBottom?: boolean, maxScroll?: number, scrollTop?: number }} [viewport]
 * @property {() => { atBottom?: boolean, maxScroll?: number, scrollTop?: number }} [getViewportState]
 * @property {{ active?: { baseY?: number, viewportY?: number } }} [buffer]
 */

export const DEFAULT_TERMINAL_SCROLL_SETTINGS = Object.freeze({
    scrollOnInput: true,
    scrollOnOutput: false,
    scrollOnKeyPress: false,
    scrollOnPaste: true,
});

/**
 * Printable user input (Netcatty hasPrintableTerminalInput).
 * Any ESC byte ⇒ not printable. Space..~ and non-ASCII (CJK etc.) count.
 * @param {string} data
 */
export function hasPrintableTerminalInput(data) {
    const text = String(data || '');
    if (!text) return false;
    if (text.includes('\x1b')) return false;
    for (const char of text) {
        const codePoint = char.codePointAt(0);
        if (codePoint === undefined) continue;
        // Exclude DEL (0x7f) and C0 controls below 0x20. ESC already rejected.
        if (codePoint >= 0x20 && codePoint !== 0x7f) return true;
    }
    return false;
}

/**
 * @param {Partial<TerminalScrollSettings> | null | undefined} settings
 */
export function shouldEnableNativeUserInputAutoScroll(settings) {
    return settings?.scrollOnInput ?? DEFAULT_TERMINAL_SCROLL_SETTINGS.scrollOnInput;
}

/**
 * @param {Partial<TerminalScrollSettings> | null | undefined} settings
 * @param {string} data
 */
export function shouldScrollOnTerminalInput(settings, data) {
    const scrollOnInput = settings?.scrollOnInput ?? DEFAULT_TERMINAL_SCROLL_SETTINGS.scrollOnInput;
    const scrollOnKeyPress = settings?.scrollOnKeyPress ?? DEFAULT_TERMINAL_SCROLL_SETTINGS.scrollOnKeyPress;
    if (!scrollOnInput && !scrollOnKeyPress) return false;
    return hasPrintableTerminalInput(data) ? scrollOnInput : scrollOnKeyPress;
}

/**
 * @param {Partial<TerminalScrollSettings> | null | undefined} settings
 */
export function shouldScrollOnTerminalOutput(settings) {
    return settings?.scrollOnOutput ?? DEFAULT_TERMINAL_SCROLL_SETTINGS.scrollOnOutput;
}

/**
 * @param {Partial<TerminalScrollSettings> | null | undefined} settings
 */
export function shouldScrollOnTerminalPaste(settings) {
    return settings?.scrollOnPaste ?? DEFAULT_TERMINAL_SCROLL_SETTINGS.scrollOnPaste;
}

/**
 * Prefer terminal buffer / public API. Fall back to viewport snapshot.
 * Never uses getBoundingClientRect.
 * @param {TerminalScrollTarget | null | undefined} terminal
 * @param {number} [pixelSlop=5]
 */
export function isTerminalScrollAtBottom(terminal, pixelSlop = 5) {
    if (!terminal) return true;

    // xterm-like buffer coordinates (Netcatty): viewportY >= baseY ⇒ at bottom
    const active = terminal.buffer?.active;
    if (active && Number.isFinite(active.baseY) && Number.isFinite(active.viewportY)) {
        return active.viewportY >= active.baseY;
    }

    if (typeof terminal.isAtBottom === 'function') {
        try {
            return !!terminal.isAtBottom();
        } catch (_) { /* fall through */ }
    }

    if (terminal.viewport && typeof terminal.viewport.atBottom === 'boolean') {
        return terminal.viewport.atBottom;
    }

    let state = null;
    if (typeof terminal.getViewportState === 'function') {
        try { state = terminal.getViewportState(); } catch (_) { state = null; }
    }
    if (state && typeof state.atBottom === 'boolean') return state.atBottom;
    if (state && Number.isFinite(state.maxScroll) && Number.isFinite(state.scrollTop)) {
        return (state.maxScroll - state.scrollTop) <= pixelSlop;
    }

    return true;
}

/**
 * Scroll to bottom only when not already there. Returns whether scroll ran.
 * @param {TerminalScrollTarget | null | undefined} terminal
 */
export function scrollTerminalToBottomIfNeeded(terminal) {
    if (!terminal) return false;
    if (isTerminalScrollAtBottom(terminal)) return false;
    if (typeof terminal.scrollToBottom !== 'function') return false;
    terminal.scrollToBottom();
    return true;
}

/**
 * @param {TerminalScrollTarget | null | undefined} terminal
 * @param {Partial<TerminalScrollSettings> | null | undefined} settings
 * @param {string} data
 */
export function scrollTerminalToBottomAfterInputIfEnabled(terminal, settings, data) {
    if (!shouldScrollOnTerminalInput(settings, data)) return false;
    return scrollTerminalToBottomIfNeeded(terminal);
}

/**
 * @param {TerminalScrollTarget | null | undefined} terminal
 * @param {Partial<TerminalScrollSettings> | null | undefined} settings
 */
export function scrollTerminalToBottomAfterOutputIfEnabled(terminal, settings) {
    if (!shouldScrollOnTerminalOutput(settings)) return false;
    return scrollTerminalToBottomIfNeeded(terminal);
}

/**
 * @param {TerminalScrollTarget | null | undefined} terminal
 * @param {Partial<TerminalScrollSettings> | null | undefined} settings
 */
export function scrollTerminalToBottomAfterPasteIfEnabled(terminal, settings) {
    if (!shouldScrollOnTerminalPaste(settings)) return false;
    return scrollTerminalToBottomIfNeeded(terminal);
}

/**
 * Classify an input reason for mobile IME paths.
 * Composition intermediate updates must never trigger scroll.
 * @param {string} reason
 * @param {{ composing?: boolean }} [opts]
 */
export function shouldScrollForInputReason(reason = '', { composing = false } = {}) {
    if (composing) return false;
    const label = String(reason || '').toLowerCase();
    if (/compositionupdate|composition-update|ime-update/.test(label)) return false;
    if (/compositionend|composition|beforeinput|input-fallback|paste|sent-visible|:sent/.test(label)) {
        return true;
    }
    if (/enter|return|backspace|control|keypad|command-box/.test(label)) {
        // control keys: only when scrollOnKeyPress would allow — caller passes data
        return true;
    }
    return false;
}

/**
 * Single-settle phase list (Netcatty: one event → ≤1 scroll).
 * Keep a short optional settle only for paste/enter after PTY echo.
 * @param {'input'|'paste'|'enter'|'output'|'layout'|'none'} kind
 * @returns {number[]}
 */
export function scrollSettlePhases(kind = 'none') {
    switch (kind) {
        case 'paste':
            return [0, 80];
        case 'enter':
            return [0, 40];
        case 'input':
            return [0];
        case 'output':
            return [0];
        case 'layout':
            // Layout/keyboard must not multi-phase chase scroll.
            return [];
        default:
            return [];
    }
}

/**
 * Zephyr product geometry: pin the cursor line just above bottom chrome
 * (tools + aux / keyboard bars). NEVER chase DOM maxScroll into bottom blank.
 *
 * @param {object} p
 * @param {number} p.scrollTop current scrollTop
 * @param {number} p.maxScroll el.scrollHeight - el.clientHeight
 * @param {number} p.scrollportHeight el.clientHeight
 * @param {number} p.cursorBottomInContent distance from content top to cursor bottom (px)
 * @param {number} [p.cursorTopInContent] distance from content top to cursor top (px)
 * @param {number} p.chromeHeight overlay height covering bottom of scrollport (tools+aux)
 * @param {number} [p.lineHeight=17]
 * @param {number} [p.padPx] gap between cursor bottom and chrome top (default ~0.2 line)
 * @param {boolean} [p.sameLineInput=false] plain typing on same line: only scroll if clipped
 * @returns {{ scrollTop: number, changed: boolean, reason: string }}
 */
export function computeCursorAboveChromeScrollTop(p = {}) {
    const scrollTop = Math.max(0, Number(p.scrollTop) || 0);
    const maxScroll = Math.max(0, Number(p.maxScroll) || 0);
    const scrollportHeight = Math.max(0, Number(p.scrollportHeight) || 0);
    const cursorBottom = Number(p.cursorBottomInContent);
    const cursorTop = Number.isFinite(p.cursorTopInContent)
        ? Number(p.cursorTopInContent)
        : (Number.isFinite(cursorBottom) ? cursorBottom - (Number(p.lineHeight) || 17) : NaN);
    const chromeHeight = Math.max(0, Number(p.chromeHeight) || 0);
    const lineHeight = Math.max(1, Number(p.lineHeight) || 17);
    const padPx = Number.isFinite(p.padPx) ? Math.max(0, p.padPx) : Math.round(lineHeight * 0.2);
    const sameLineInput = !!p.sameLineInput;

    if (!scrollportHeight || !Number.isFinite(cursorBottom)) {
        return { scrollTop, changed: false, reason: 'missing-metrics' };
    }

    // Visible band inside the scrollport, above chrome overlay.
    const visibleHeight = Math.max(lineHeight, scrollportHeight - chromeHeight);
    const visibleTop = 0;
    const visibleBottom = visibleHeight - padPx;

    // Sparse content / no overflow: never invent a black void under the prompt.
    if (maxScroll <= 0) {
        return {
            scrollTop: 0,
            changed: scrollTop > 1,
            reason: 'sparse-zero-max',
        };
    }

    // Cursor edges relative to current scrollport top.
    const cursorBottomVisible = cursorBottom - scrollTop;
    const cursorTopVisible = cursorTop - scrollTop;
    const clippedBottom = cursorBottomVisible > visibleBottom + 1;
    const clippedTop = cursorTopVisible < visibleTop - 1;
    const fullyVisible = !clippedBottom && !clippedTop;

    // Fully visible ⇒ never touch scrollTop (force only bypasses caller locks,
    // not "already correct geometry"). This is what stops per-keystroke jitter.
    if (fullyVisible) {
        return {
            scrollTop,
            changed: false,
            reason: sameLineInput ? 'same-line-visible' : 'already-visible',
        };
    }

    // Desire: cursor bottom sits on visibleBottom (just above chrome).
    // scrollTop = cursorBottom - visibleBottom
    let next = cursorBottom - visibleBottom;

    // Also never hide cursor above the top of the scrollport.
    if (cursorTop - next < visibleTop) {
        next = cursorTop - visibleTop;
    }

    // Hard cap: do not scroll past "cursor at bottom of useful viewport".
    // This is what kills the mid-screen prompt + huge black void (user fig.3).
    const maxUseful = Math.max(0, cursorBottom - visibleBottom);
    next = Math.min(next, maxUseful);

    next = Math.max(0, Math.min(maxScroll, next));
    // Row-height align to avoid fighting WTerm grid snap.
    next = Math.floor(next / lineHeight) * lineHeight;

    if (Math.abs(next - scrollTop) < 2) {
        return { scrollTop, changed: false, reason: 'within-slop' };
    }
    return {
        scrollTop: next,
        changed: true,
        reason: clippedBottom ? 'unclip-bottom' : (clippedTop ? 'unclip-top' : 'cursor-above-chrome'),
    };
}

/**
 * Whether a scroll delta is allowed during plain same-line typing.
 * @param {{ changed: boolean, reason: string }} decision
 */
export function allowScrollDuringTyping(decision) {
    if (!decision?.changed) return false;
    return decision.reason === 'unclip-bottom' || decision.reason === 'unclip-top';
}

export default {
    DEFAULT_TERMINAL_SCROLL_SETTINGS,
    hasPrintableTerminalInput,
    shouldEnableNativeUserInputAutoScroll,
    shouldScrollOnTerminalInput,
    shouldScrollOnTerminalOutput,
    shouldScrollOnTerminalPaste,
    isTerminalScrollAtBottom,
    scrollTerminalToBottomIfNeeded,
    scrollTerminalToBottomAfterInputIfEnabled,
    scrollTerminalToBottomAfterOutputIfEnabled,
    scrollTerminalToBottomAfterPasteIfEnabled,
    shouldScrollForInputReason,
    scrollSettlePhases,
    computeCursorAboveChromeScrollTop,
    allowScrollDuringTyping,
};
