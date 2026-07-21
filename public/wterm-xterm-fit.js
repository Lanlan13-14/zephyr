/**
 * wterm-xterm-fit.js
 *
 * 1:1 port of xterm.js @xterm/addon-fit FitAddon (MIT, The xterm.js authors).
 * Source: https://github.com/xtermjs/xterm.js/blob/master/addons/addon-fit/src/FitAddon.ts
 *
 * Only adaptation: cell metrics come from WTerm (getCellMetrics / CSS vars /
 * measured row height) instead of xterm private _renderService.dimensions.
 *
 * Keyboard / IME geometry MUST go through fit() after the container height
 * changes — same as xterm apps that call fitAddon.fit() on visualViewport
 * resize. Do not invent multi-phase cursor-pin to fake a fit.
 */

/** @typedef {{ cols: number, rows: number, cellWidth: number, cellHeight: number, availableWidth: number, availableHeight: number }} FitDimensions */

const MINIMUM_COLS = 2;
const MINIMUM_ROWS = 1;

/**
 * @param {object} opts
 * @param {HTMLElement | null | undefined} opts.element  WTerm root (.wterm)
 * @param {HTMLElement | null | undefined} [opts.parentElement]  measure target; default element.parentElement
 * @param {number} opts.cellWidth
 * @param {number} opts.cellHeight
 * @param {number} [opts.scrollbarWidth=0]
 */
export function proposeDimensions(opts = {}) {
    const element = opts.element;
    if (!element) return null;
    const parent = opts.parentElement || element.parentElement;
    if (!parent) return null;

    const cellWidth = Number(opts.cellWidth) || 0;
    const cellHeight = Number(opts.cellHeight) || 0;
    if (!(cellWidth > 0) || !(cellHeight > 0)) return null;

    const scrollbarWidth = Math.max(0, Number(opts.scrollbarWidth) || 0);

    // Exact FitAddon: computed style height/width of PARENT, not getBoundingClientRect.
    const parentElementStyle = window.getComputedStyle(parent);
    const parentElementHeight = parseInt(parentElementStyle.getPropertyValue('height'), 10) || 0;
    const parentElementWidth = Math.max(0, parseInt(parentElementStyle.getPropertyValue('width'), 10) || 0);

    const elementStyle = window.getComputedStyle(element);
    const elementPadding = {
        top: parseInt(elementStyle.getPropertyValue('padding-top'), 10) || 0,
        bottom: parseInt(elementStyle.getPropertyValue('padding-bottom'), 10) || 0,
        right: parseInt(elementStyle.getPropertyValue('padding-right'), 10) || 0,
        left: parseInt(elementStyle.getPropertyValue('padding-left'), 10) || 0,
    };
    const elementPaddingVer = elementPadding.top + elementPadding.bottom;
    const elementPaddingHor = elementPadding.right + elementPadding.left;
    const availableHeight = parentElementHeight - elementPaddingVer;
    const availableWidth = parentElementWidth - elementPaddingHor - scrollbarWidth;

    if (!(availableHeight > 0) || !(availableWidth > 0)) return null;

    return {
        cols: Math.max(MINIMUM_COLS, Math.floor(availableWidth / cellWidth)),
        rows: Math.max(MINIMUM_ROWS, Math.floor(availableHeight / cellHeight)),
        cellWidth,
        cellHeight,
        availableWidth,
        availableHeight,
    };
}

/**
 * Resolve WTerm cell metrics without Math.max multi-source inflation.
 * @param {any} term
 * @param {HTMLElement | null} [wrapper]
 */
export function getWTermCellMetrics(term, wrapper = null) {
    try {
        const m = term?.getCellMetrics?.();
        if (m && m.charWidth > 0 && m.rowHeight > 0) {
            return { cellWidth: m.charWidth, cellHeight: m.rowHeight };
        }
    } catch (_) {}
    try {
        const st = term?.getViewportState?.() || term?.viewport?.state?.();
        if (st?.rowHeight > 0) {
            const cw = st.charWidth > 0 ? st.charWidth : (term?.viewport?.charWidth || 0);
            if (cw > 0) return { cellWidth: cw, cellHeight: st.rowHeight };
        }
    } catch (_) {}
    try {
        const el = term?.element || wrapper;
        if (el) {
            const cs = window.getComputedStyle(el);
            const rh = parseFloat(cs.getPropertyValue('--term-row-height')) || 0;
            const cw = parseFloat(cs.getPropertyValue('--term-cell-width')) || 0;
            if (rh > 0 && cw > 0) return { cellWidth: cw, cellHeight: rh };
        }
    } catch (_) {}
    return { cellWidth: 8, cellHeight: 17 };
}

/**
 * FitAddon.fit() for WTerm.
 *
 * @param {object} host
 * @param {any} host.term
 * @param {HTMLElement | null} host.wrapper  outer scroll container (parent of .wterm) OR the .wterm itself
 * @param {(cols:number, rows:number, reason:string) => boolean} [host.resize]  preferred resize writer
 * @param {string} [host.reason]
 * @param {boolean} [host.force=false]
 * @returns {{ changed: boolean, cols: number, rows: number, dims: FitDimensions | null }}
 */
export function fitWTerm(host = {}) {
    const term = host.term;
    const wrapper = host.wrapper;
    if (!term || !wrapper) {
        return { changed: false, cols: 0, rows: 0, dims: null };
    }

    // Clear locked inline height so parent flex/fixed geometry is authoritative
    // (WTerm _lockHeight pollution). Same container semantic as xterm element.parent.
    try {
        if (wrapper.style) {
            if (wrapper.style.height) wrapper.style.height = '';
            if (wrapper.style.minHeight) wrapper.style.minHeight = '';
            if (wrapper.style.maxHeight) wrapper.style.maxHeight = '';
        }
        const root = term.element;
        if (root?.style) {
            if (root.style.height && root.style.height.endsWith('px')) {
                // Only clear pixel lock from _lockHeight; leave %/auto alone.
                root.style.height = '';
            }
        }
    } catch (_) {}

    // Force layout before measure (xterm relies on post-style computed height).
    try { void wrapper.offsetHeight; } catch (_) {}

    const { cellWidth, cellHeight } = getWTermCellMetrics(term, wrapper);
    // Measure PARENT of the terminal root — FitAddon contract.
    // Our structure: #terminalContainer > #wtermWrapper.wterm  OR wrapper is the root.
    const termEl = term.element || wrapper;
    const parentEl = (termEl.parentElement && termEl.parentElement !== document.body)
        ? termEl.parentElement
        : wrapper;

    // Scrollbar: WTerm uses overlay/native; mobile hides custom bar. Use 0 like
    // xterm when scrollback draws inside the same box without reserved gutter,
    // unless a vertical classic scrollbar is visibly taking width.
    let scrollbarWidth = 0;
    try {
        const el = termEl;
        if (el && el.scrollHeight > el.clientHeight + 2) {
            scrollbarWidth = Math.max(0, el.offsetWidth - el.clientWidth);
        }
    } catch (_) {}

    const dims = proposeDimensions({
        element: termEl,
        parentElement: parentEl,
        cellWidth,
        cellHeight,
        scrollbarWidth,
    });
    if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) {
        return { changed: false, cols: 0, rows: 0, dims: null };
    }

    // SSH PTY: never go below 2 rows / 20 cols (xterm allows 1 row; shells hate it).
    const cols = Math.max(20, Math.min(500, dims.cols));
    const rows = Math.max(2, Math.min(200, dims.rows));

    const curCols = Number(term.cols ?? term._cols ?? term.options?.cols ?? 0);
    const curRows = Number(term.rows ?? term._rows ?? term.options?.rows ?? 0);
    if (!host.force && curCols === cols && curRows === rows) {
        return { changed: false, cols, rows, dims };
    }

    const reason = host.reason || 'xterm-fit';
    let ok = false;
    if (typeof host.resize === 'function') {
        ok = !!host.resize(cols, rows, reason);
    } else if (typeof term.resize === 'function') {
        try {
            term.resize(cols, rows);
            ok = true;
        } catch (_) { ok = false; }
    }

    return { changed: ok, cols, rows, dims };
}

/**
 * After container geometry change (IME open/close):
 *   fit() then scrollToBottom if was following — exact xterm app pattern.
 *
 * @param {object} host
 * @param {any} host.term
 * @param {HTMLElement | null} host.wrapper
 * @param {(cols:number, rows:number, reason:string) => boolean} [host.resize]
 * @param {() => boolean} [host.wasFollowing]
 * @param {() => void} [host.scrollToBottom]
 * @param {string} [host.reason]
 */
export function fitAndStickBottom(host = {}) {
    const following = typeof host.wasFollowing === 'function'
        ? !!host.wasFollowing()
        : true;

    // Double-rAF: wait for CSS height (keyboard inset) to commit, like waiting
    // for layout after viewport resize before FitAddon.fit() in xterm apps.
    const run = (label) => {
        const result = fitWTerm({
            term: host.term,
            wrapper: host.wrapper,
            resize: host.resize,
            reason: label,
            force: false,
        });
        if (following) {
            try {
                if (typeof host.scrollToBottom === 'function') host.scrollToBottom();
                else if (typeof host.term?.scrollToBottom === 'function') host.term.scrollToBottom();
                else if (host.term?.viewport?.scrollToBottom) host.term.viewport.scrollToBottom();
            } catch (_) {}
        }
        return result;
    };

    // Immediate attempt (may skip if height not committed).
    let first = null;
    try {
        first = run(`${host.reason || 'fit'}:immediate`);
    } catch (_) {}

    // Settled attempt after keyboard animation / CSS.
    if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                try { run(`${host.reason || 'fit'}:raf`); } catch (_) {}
            });
        });
    }

    return first;
}

export { MINIMUM_COLS, MINIMUM_ROWS };

export default {
    MINIMUM_COLS,
    MINIMUM_ROWS,
    proposeDimensions,
    getWTermCellMetrics,
    fitWTerm,
    fitAndStickBottom,
};
