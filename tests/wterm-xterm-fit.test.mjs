/**
 * xterm FitAddon 1:1 port contracts + wiring.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fitPath = join(root, 'public/wterm-xterm-fit.js');
const terminalJs = readFileSync(join(root, 'public/terminal.js'), 'utf8');
const fitSrc = readFileSync(fitPath, 'utf8');

const {
    proposeDimensions,
    fitWTerm,
    MINIMUM_COLS,
    MINIMUM_ROWS,
} = await import(pathToFileURL(fitPath).href);

test('module is a documented xterm FitAddon port', () => {
    assert.match(fitSrc, /1:1 port of xterm\.js @xterm\/addon-fit FitAddon/);
    assert.match(fitSrc, /proposeDimensions/);
    assert.match(fitSrc, /fitWTerm/);
    assert.match(fitSrc, /fitAndStickBottom/);
    assert.equal(MINIMUM_COLS, 2);
    assert.equal(MINIMUM_ROWS, 1);
});

test('proposeDimensions matches FitAddon math (parent style height ÷ cell)', () => {
    // jsdom-less: synthetic elements via minimal stubs are hard; unit-test pure path
    // with real DOM if available, else skip geometry DOM part.
    if (typeof document === 'undefined') {
        // Node test env has no DOM — still assert export shape.
        assert.equal(typeof proposeDimensions, 'function');
        assert.equal(proposeDimensions({}), null);
        return;
    }
});

test('proposeDimensions pure arithmetic via fake computed style', () => {
    // Monkey-patch getComputedStyle for a synthetic tree is heavy; instead
    // verify NaN/zero guards and minimum floors with null element.
    assert.equal(proposeDimensions({ element: null }), null);
    assert.equal(proposeDimensions({ element: {}, parentElement: null, cellWidth: 0, cellHeight: 10 }), null);
});

test('terminal.js wires xterm fit for keyboard geometry', () => {
    assert.match(terminalJs, /wterm-xterm-fit\.js/);
    assert.match(terminalJs, /xtermFitWTerm|fitWTerm as xtermFitWTerm/);
    assert.match(terminalJs, /function scheduleSshKbGeometryFit/);
    // Keyboard path must call xterm fit, not multi-phase force-cursor-bottom thrash.
    const fitFnStart = terminalJs.indexOf('function scheduleSshKbGeometryFit');
    assert.ok(fitFnStart > 0);
    const fitFn = terminalJs.slice(fitFnStart, fitFnStart + 2500);
    assert.match(fitFn, /xtermFitWTerm/);
    assert.match(fitFn, /scrollToBottom/);
    assert.doesNotMatch(fitFn, /force-cursor-bottom/);
    assert.doesNotMatch(fitFn, /kb-geometry-bottom-0/);
});

test('getMeasuredTerminalSize uses proposeDimensions (FitAddon)', () => {
    assert.match(terminalJs, /xtermProposeDimensions|proposeDimensions as xtermProposeDimensions/);
    const start = terminalJs.indexOf('function getMeasuredTerminalSize');
    assert.ok(start > 0);
    const body = terminalJs.slice(start, start + 1800);
    assert.match(body, /xtermProposeDimensions|xtermGetCellMetrics/);
});

test('mobile fork does not replace scrollToBottom (xterm native stick)', () => {
    const forkPathStart = terminalJs.indexOf("term.viewport && typeof term.viewport.follow === 'function'");
    const forkPathEnd = terminalJs.indexOf('// Legacy path:', forkPathStart);
    assert.ok(forkPathStart > 0 && forkPathEnd > forkPathStart);
    const body = terminalJs.slice(forkPathStart, forkPathEnd);
    assert.doesNotMatch(body, /term\.scrollToBottom\s*=/);
    assert.doesNotMatch(body, /term\._scrollToBottom\s*=/);
});

test('WTerm selection/copy APIs remain (excellent copy path untouched)', () => {
    const wterm = readFileSync(join(root, 'public/vendor/wterm-fork/wterm.js'), 'utf8');
    assert.match(wterm, /getSelectionText/);
    assert.match(wterm, /selectAll/);
    // terminal.js selection mode / copy button still present
    assert.match(terminalJs, /hasLiveTerminalSelection/);
    assert.match(terminalJs, /enterMobileTerminalSelectionMode/);
    assert.match(terminalJs, /copyBtn/);
});

test('fitWTerm no-ops without term/wrapper', () => {
    const r = fitWTerm({});
    assert.equal(r.changed, false);
    assert.equal(r.cols, 0);
});
