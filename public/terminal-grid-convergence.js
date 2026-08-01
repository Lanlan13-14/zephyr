export const TERMINAL_GRID_GROWTH_DEFAULTS = Object.freeze({
    minWidth: 120,
    minHeight: 80,
    rowTolerance: 1,
    colTolerance: 1,
    maxRows: 200,
    maxCols: 500,
});

/**
 * Decide whether a mobile terminal grid may converge to its now-larger shell.
 * Keyboard/viewport churn is still forbidden from shrinking the PTY. Only
 * expansion (or same-size repaint) is admitted after fullscreen/IME close.
 */
export function decideTerminalGridGrowth({
    currentCols = 0,
    currentRows = 0,
    measuredCols = 0,
    measuredRows = 0,
    width = 0,
    height = 0,
    keyboardOpen = false,
    visible = true,
    options = {},
} = {}) {
    const cfg = { ...TERMINAL_GRID_GROWTH_DEFAULTS, ...options };
    const curCols = Math.floor(Number(currentCols) || 0);
    const curRows = Math.floor(Number(currentRows) || 0);
    const nextCols = Math.min(cfg.maxCols, Math.floor(Number(measuredCols) || 0));
    const nextRows = Math.min(cfg.maxRows, Math.floor(Number(measuredRows) || 0));
    const stableRect = !!visible
        && Number(width) >= cfg.minWidth
        && Number(height) >= cfg.minHeight;
    if (!stableRect || keyboardOpen || curCols < 20 || curRows < 2 || nextCols < 20 || nextRows < 2) {
        return { apply: false, reason: keyboardOpen ? 'keyboard-open' : 'unstable', cols: curCols, rows: curRows };
    }

    const growsRows = nextRows > curRows + cfg.rowTolerance;
    const growsCols = nextCols > curCols + cfg.colTolerance;
    const shrinksRows = nextRows < curRows - cfg.rowTolerance;
    const shrinksCols = nextCols < curCols - cfg.colTolerance;

    // Never shrink from this recovery path. Width/height shrink is legitimate
    // during IME open and belongs to the normal keyboard controller.
    if (shrinksRows || shrinksCols) {
        return { apply: false, reason: 'would-shrink', cols: curCols, rows: curRows };
    }
    if (!growsRows && !growsCols) {
        return { apply: false, reason: 'already-converged', cols: curCols, rows: curRows };
    }
    return { apply: true, reason: 'grow-only', cols: nextCols, rows: nextRows };
}

export default { TERMINAL_GRID_GROWTH_DEFAULTS, decideTerminalGridGrowth };
