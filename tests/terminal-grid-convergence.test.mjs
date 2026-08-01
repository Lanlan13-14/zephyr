import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { decideTerminalGridGrowth } from '../public/terminal-grid-convergence.js';

const terminal = fs.readFileSync(new URL('../public/terminal.js', import.meta.url), 'utf8');
const telnet = fs.readFileSync(new URL('../public/telnet-terminal.js', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

const base = {
    currentCols: 100,
    currentRows: 42,
    measuredCols: 100,
    measuredRows: 72,
    width: 1000,
    height: 1440,
    keyboardOpen: false,
    visible: true,
};

test('fullscreen/IME-close recovery permits grow-only row convergence', () => {
    assert.deepEqual(decideTerminalGridGrowth(base), {
        apply: true,
        reason: 'grow-only',
        cols: 100,
        rows: 72,
    });
});

test('recovery never shrinks rows while keyboard opens or viewport contracts', () => {
    assert.equal(decideTerminalGridGrowth({ ...base, measuredRows: 30 }).apply, false);
    assert.equal(decideTerminalGridGrowth({ ...base, keyboardOpen: true }).apply, false);
    assert.equal(decideTerminalGridGrowth({ ...base, visible: false }).apply, false);
});

test('growth is clamped to server PTY limits', () => {
    const result = decideTerminalGridGrowth({ ...base, measuredCols: 900, measuredRows: 900 });
    assert.deepEqual(result, { apply: true, reason: 'grow-only', cols: 500, rows: 200 });
});

test('minor measurement jitter is ignored', () => {
    assert.equal(decideTerminalGridGrowth({ ...base, measuredRows: 43 }).reason, 'already-converged');
    assert.equal(decideTerminalGridGrowth({ ...base, measuredCols: 99, measuredRows: 42 }).reason, 'already-converged');
});

test('SSH and Telnet converge after keyboard close and fullscreen layout messages', () => {
    for (const [label, source] of [['ssh', terminal], ['telnet', telnet]]) {
        assert.match(source, /decideTerminalGridGrowth/, `${label}: decision helper`);
        assert.match(source, /function scheduleMobileTerminalGridConvergence/, `${label}: convergence scheduler`);
        assert.match(source, /settled-growth/, `${label}: keyboard close convergence`);
        assert.match(source, /e\.data\.customFullscreen/, `${label}: fullscreen convergence`);
        assert.match(source, /force-mobile-grow:/, `${label}: force grow resize`);
        assert.match(source, /useExplicitForceSize/, `${label}: explicit PTY growth size`);
        assert.match(source, /child-layout-lag/, `${label}: waits for iframe flex layout`);
        assert.match(source, /parent-terminal-workspace-height/, `${label}: parent height authority`);
        assert.match(source, /terminalGridGrowthScheduleGeneration/, `${label}: stale phase cancellation`);
        assert.match(source, /setStableViewportHeight\(\{ force: true \}\)/, `${label}: clears stale cropped stable-vh`);
        assert.doesNotMatch(source, /__zephyr(?:ConvergeTerminalGrid|GetTerminalGridState|LastTerminalGridGrowth)/, `${label}: no production debug hooks`);
    }
});

test('parent layout message carries authoritative fullscreen geometry state', () => {
    const start = app.indexOf('function postTerminalLayoutStabilize');
    const body = app.slice(start, start + 3000);
    assert.match(body, /fullscreen:\s*!!fullscreenElement/);
    assert.match(body, /customFullscreen:/);
    assert.match(body, /workspaceHeight:/);
});
