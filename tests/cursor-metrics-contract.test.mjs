import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Cursor-metrics contract (20260721-cursor-metrics1).
 *
 * Locks the single-source cell geometry + pixel-precise cursor overlay so the
 * "cursor flies / misaligned" regression cannot re-enter via 1ch, Math.max
 * multi-source metrics, or render-path force-pin thrash.
 */

const root = path.resolve(import.meta.dirname, '..');
const forkDir = path.join(root, 'public', 'vendor', 'wterm-fork');
const wtermSrc = fs.readFileSync(path.join(forkDir, 'wterm.js'), 'utf8');
const rendererSrc = fs.readFileSync(path.join(forkDir, 'renderer.js'), 'utf8');
const canvasSrc = fs.readFileSync(path.join(forkDir, 'canvas-renderer.js'), 'utf8');
const cssSrc = fs.readFileSync(path.join(forkDir, 'terminal.css'), 'utf8');
const terminalJs = fs.readFileSync(path.join(root, 'public', 'terminal.js'), 'utf8');
const surfaceJs = fs.readFileSync(path.join(root, 'public', 'terminal-surface-controller.js'), 'utf8');
const styleCss = fs.readFileSync(path.join(root, 'public', 'style.css'), 'utf8');
const terminalHtml = fs.readFileSync(path.join(root, 'public', 'terminal.html'), 'utf8');
const wtermTs = fs.readFileSync(path.join(root, 'wterm/packages/@wterm/dom/src/wterm.ts'), 'utf8');
const rendererTs = fs.readFileSync(path.join(root, 'wterm/packages/@wterm/dom/src/renderer.ts'), 'utf8');
const cssTs = fs.readFileSync(path.join(root, 'wterm/packages/@wterm/dom/src/terminal.css'), 'utf8');

test('fork exposes getCellMetrics + refreshCellMetrics (built + source)', () => {
    for (const [label, src] of [['built', wtermSrc], ['ts', wtermTs]]) {
        assert.ok(/getCellMetrics\s*\(/.test(src), `${label}: getCellMetrics()`);
        assert.ok(/refreshCellMetrics\s*\(/.test(src), `${label}: refreshCellMetrics()`);
        assert.ok(/--term-cell-width/.test(src), `${label}: writes --term-cell-width`);
    }
});

test('refreshCellMetrics does NOT Math.ceil rowHeight (sub-pixel keep)', () => {
    // The old _setRowHeight did Math.ceil(h) which inflated rows/void.
    const fnIdx = wtermSrc.indexOf('refreshCellMetrics()');
    assert.ok(fnIdx > 0);
    const body = wtermSrc.slice(fnIdx, fnIdx + 800);
    assert.ok(!/Math\.ceil\s*\(\s*h\s*\)/.test(body), 'must not ceil measured height');
    assert.ok(!/Math\.ceil\s*\(\s*measured/.test(body), 'must not ceil measured.*');
});

test('renderer setCellMetrics + pixel cursor placement', () => {
    assert.ok(/setCellMetrics\s*\(/.test(rendererSrc), 'built renderer setCellMetrics');
    assert.ok(/setCellMetrics\s*\(/.test(rendererTs), 'ts renderer setCellMetrics');
    // Must write absolute top/left px, not only CSS vars.
    assert.ok(/top:\$\{top\}px/.test(rendererSrc) || /top:\s*\$\{top\}px/.test(rendererSrc),
        'cursor overlay must set top px');
    assert.ok(/left:\$\{left\}px/.test(rendererSrc) || /left:\s*\$\{left\}px/.test(rendererSrc),
        'cursor overlay must set left px');
    // Must account for scrollback offset above live grid.
    assert.ok(/_renderedScrollbackCount/.test(rendererSrc), 'scrollback offset for cursor top');
});

test('canvas renderer accepts host metrics', () => {
    assert.ok(/setCellMetrics\s*\(/.test(canvasSrc), 'canvas setCellMetrics');
    assert.ok(/_hostCellWidth/.test(canvasSrc), 'canvas host width field');
});

test('terminal.css: .term-grid is position:relative; cursor uses --term-cell-width', () => {
    for (const [label, src] of [['built', cssSrc], ['ts', cssTs]]) {
        assert.ok(/--term-cell-width/.test(src), `${label}: --term-cell-width var`);
        // .term-grid { ... position: relative
        assert.ok(/\.term-grid\s*\{[^}]*position:\s*relative/s.test(src),
            `${label}: .term-grid position:relative`);
        assert.ok(
            /\.term-cursor-overlay\s*\{[^}]*var\(--term-cell-width/s.test(src),
            `${label}: overlay left uses --term-cell-width`,
        );
        // Must NOT fall back to bare 1ch as the primary width for overlay.
        const overlayBlock = src.match(/\.term-cursor-overlay\s*\{[^}]+\}/s)?.[0] || '';
        assert.ok(overlayBlock.includes('--term-cell-width'), `${label}: overlay block has cell-width`);
        assert.ok(!/left:\s*calc\(var\(--cursor-col,\s*0\)\s*\*\s*1ch\)/.test(overlayBlock),
            `${label}: overlay must not use bare 1ch for left`);
    }
});

test('terminal.html loads fork terminal.css (not stock @wterm/dom)', () => {
    assert.ok(/\/vendor\/wterm-fork\/terminal\.css/.test(terminalHtml),
        'must load fork terminal.css');
    assert.ok(!/\/vendor\/@wterm\/dom\/terminal\.css/.test(terminalHtml),
        'must not load stock terminal.css as primary');
    assert.ok(/20260726-ai-unified-skill1/.test(terminalHtml), 'current cache-bust present');
});

test('getTerminalCharMetrics prefers term.getCellMetrics (no Math.max multi-source)', () => {
    const idx = terminalJs.indexOf('function getTerminalCharMetrics');
    assert.ok(idx > 0, 'function exists');
    const body = terminalJs.slice(idx, idx + 2200);
    assert.ok(/getCellMetrics/.test(body), 'must call getCellMetrics');
    // The multi-source Math.max of _rowHeight/probe/css/lineHeight/fontSize*1.2 is banned.
    assert.ok(!/Math\.max\s*\(\s*1\s*,[\s\S]*term\?\.\_rowHeight[\s\S]*fontSize\s*\*\s*1\.2/.test(body),
        'must not Math.max multi-source row heights');
});

test('applyTerminalFontSize calls refreshCellMetrics', () => {
    const idx = terminalJs.indexOf('function applyTerminalFontSize');
    assert.ok(idx > 0);
    const body = terminalJs.slice(idx, idx + 1200);
    assert.ok(/refreshCellMetrics/.test(body), 'font size change must remeasure');
});

test('surface onRenderComplete does NOT force-pin scroll', () => {
    const idx = surfaceJs.indexOf('function onRenderComplete');
    assert.ok(idx > 0);
    const body = surfaceJs.slice(idx, idx + 600);
    assert.ok(!/pinCursorAboveChrome/.test(body),
        'render complete must not call pinCursorAboveChrome');
    assert.ok(/onCursorGeometry|onScrollbar/.test(body),
        'render complete may update geometry/scrollbar only');
});

test('IME send dedups by payload regardless of source', () => {
    const idx = terminalJs.indexOf('function sendMobileStableImeText');
    assert.ok(idx > 0);
    const body = terminalJs.slice(idx, idx + 1600);
    // Old: source !== source gate. New: content-only window.
    assert.ok(!/mobileImeLastSent\.source\s*!==\s*source/.test(body),
        'must not require different source for dedup');
    assert.ok(/mobileImeLastSent\.text\s*===\s*payload/.test(body),
        'dedup by payload text');
    assert.ok(/Dedup by payload content only/.test(body), 'documents content-only dedup');
});

test('IME proxy anchor helpers exist and are wired', () => {
    assert.ok(/function anchorImeProxyToCursor/.test(terminalJs), 'anchorImeProxyToCursor');
    assert.ok(/function scheduleImeProxyCursorAnchor/.test(terminalJs), 'schedule helper');
    assert.ok(/onCursorGeometry/.test(terminalJs), 'host injects onCursorGeometry');
    assert.ok(/onCursorGeometry/.test(surfaceJs), 'surface calls onCursorGeometry');
});

test('mobile CSS does not hard-code line-height:1.35 on term-row', () => {
    // Ban the hard assignment that previously overrode --term-row-height.
    assert.ok(
        !/html\.mobile-stable-input[^\{]{0,200}\.term-row[\s\S]{0,300}?line-height:\s*1\.35\s*;/.test(styleCss),
        'mobile term-row must not hard-set line-height:1.35',
    );
    assert.ok(
        styleCss.includes('line-height: var(--term-row-height, 1.35em)'),
        'mobile term-row must use --term-row-height',
    );
});

test('wterm fork import uses the current cache-bust', () => {
    assert.ok(/wterm-fork\/index\.js\?v=20260723-sync2/.test(terminalJs));
});
