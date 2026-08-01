import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const terminal = fs.readFileSync(path.join(root, 'public/terminal.js'), 'utf8');
const telnet = fs.readFileSync(path.join(root, 'public/telnet-terminal.js'), 'utf8');
const gesture = fs.readFileSync(path.join(root, 'public/terminal-history-gesture.js'), 'utf8');
const wtermSrc = fs.readFileSync(path.join(root, 'wterm/packages/@wterm/dom/src/wterm.ts'), 'utf8');
const wtermBuilt = fs.readFileSync(path.join(root, 'public/vendor/wterm-fork/wterm.js'), 'utf8');

test('SSH and Telnet share the inertial history gesture controller', () => {
    for (const source of [terminal, telnet]) {
        assert.match(source, /createTerminalHistoryGesture/);
        assert.match(source, /scrollLines: \(lines, reason\) => scrollTerminalHistoryLines\(lines, reason\)/);
        assert.match(source, /historyGesture\.move\(y, e\.timeStamp/);
        assert.match(source, /historyGesture\.end\(\{ cancel:/);
        assert.doesNotMatch(source, /scrollRemainder \+= -dy/);
        assert.match(source, /scrollback:\s*20000/);
    }
});

test('history gesture has native touch direction, velocity smoothing and decaying fling', () => {
    assert.match(gesture, /dragGain:\s*1/);
    assert.match(gesture, /consumePixels\(-dy \* cfg\.dragGain/);
    assert.match(gesture, /-velocity \* dt \* cfg\.dragGain/);
    assert.match(gesture, /velocitySmoothing:\s*0\.72/);
    assert.match(gesture, /flingFrictionPer16Ms:\s*0\.94/);
    assert.match(gesture, /boundary/);
    assert.match(gesture, /requestFrame\(tick\)/);
});

test('desktop wheel direction stays native xterm direction', () => {
    for (const source of [terminal, telnet, wtermSrc, wtermBuilt]) {
        assert.match(source, /deltaY/);
        assert.doesNotMatch(source, /scrollLines\?\.\(-deltaLines\)/);
    }
});

test('history scroll reports actual movement so fling stops at boundaries', () => {
    for (const source of [terminal, telnet]) {
        assert.match(source, /const before = getXtermHistoryMetrics\(\)/);
        assert.match(source, /const moved = Math\.trunc\(\(after\?\.ydisp \|\| 0\) - \(before\?\.ydisp \|\| 0\)\)/);
        assert.match(source, /if \(!moved\) return 0/);
    }
});

test('WTerm clears stale wheel remainder at a scroll boundary in source and build', () => {
    for (const source of [wtermSrc, wtermBuilt]) {
        assert.match(source, /getViewportY/);
        assert.match(source, /after === before/);
        assert.match(source, /_wheelAccum = 0/);
    }
});
