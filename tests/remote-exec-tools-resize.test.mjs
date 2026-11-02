import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/remote-exec-tools.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../public/remote-exec-tools.css', import.meta.url), 'utf8');
const spec = fs.readFileSync(new URL('../public/zephyr-terminal-spec.css', import.meta.url), 'utf8');
const authority = fs.readFileSync(new URL('../public/vendor/zephyr-pro/terminal-sftp-pro.js', import.meta.url), 'utf8');
const context = vm.createContext({});
vm.runInContext(source.slice(source.indexOf('const BOX_KEYS'), source.indexOf('const ICONS')).replace('export function', 'function'), context);
const box = (...args) => JSON.parse(JSON.stringify(context.remoteExecToolBox(...args)));
const start = { left: 40, top: 30, width: 420, height: 360 };
const area = { width: 1100, height: 720 };

test('Tier-1 resize uses 320x220 minimum, 8px gutter and anchored bottom corners', () => {
    assert.deepEqual(box(start, area, { edge: 'right', x: 80, y: 60 }), { left: 40, top: 30, width: 500, height: 420 });
    assert.deepEqual(box(start, area, { edge: 'right', x: -10000, y: -10000 }), { left: 40, top: 30, width: 320, height: 220 });
    assert.deepEqual(box(start, area, { edge: 'left', x: 10000, y: 10000 }), { left: 140, top: 30, width: 320, height: 682 });
    assert.deepEqual(box(start, area, { edge: 'left', x: -10000, y: 0 }), { left: 8, top: 30, width: 452, height: 360 });
    assert.equal(box(start, area, { edge: 'right', x: 10000, y: 10000 }).width, 1052);
    assert.match(authority, /const minW = 320;\s*const minH = 220/);
});

test('all resize edges and refits remain bounded, including host smaller than minimum', () => {
    for (const width of [1, 32, 160, 320, 640, 1100]) for (const height of [1, 32, 150, 220, 720]) {
        for (const left of [-120, 0, 40, 2000]) for (const edge of [null, 'left', 'right']) for (const delta of [-10000, 0, 10000]) {
            const result = box({ ...start, left, top: left }, { width, height }, edge ? { edge, x: delta, y: delta } : null);
            assert.ok(Object.values(result).every(Number.isFinite));
            assert.ok(result.left >= 0 && result.top >= 0);
            assert.ok(result.width > 0 && result.height > 0);
            assert.ok(result.left + result.width <= width + 1, JSON.stringify({ width, height, result }));
            assert.ok(result.top + result.height <= height + 1, JSON.stringify({ width, height, result }));
        }
    }
});

test('batch binds exact shared rings and owns capture, cancellation and teardown', () => {
    assert.match(source, /for \(const edge of \['left', 'right'\]\)/);
    assert.match(source, /`panel-resize-handle \$\{edge\}`/);
    for (const token of ['setPointerCapture', 'releasePointerCapture', 'lostpointercapture', 'pointercancel', 'cleanup.abort()', 'ev.pointerId !== event.pointerId', "win.addEventListener('blur'"]) assert.ok(source.includes(token), token);
    assert.match(source, /const destroy = \(\) => \{\s*if \(destroyed\) return;\s*finishResize\(\)/);
    assert.match(source, /const setPinned =[\s\S]*?finishResize\(\)/);
    assert.match(source, /state\.panel\.classList\.toggle\('panel-fullscreen', state\.fullscreen\)/);
    assert.match(source, /if \(state\.fullscreen\) \{\s*paintBox\(state, \{ left: 0, top: 0, \.\.\.area \}\)/);
    assert.match(source, /gesture\.state\.freeStyle = captureBox/);
    assert.doesNotMatch(source, /listen\([^\n]*'(pointerenter|mouseenter|focusin)'/);
    assert.match(source, /motion\(\)\.panelResizeRing\(state\.panel, focused\)/);
    assert.match(css, /remote-exec-tool-panel:not\(\.docked-right\):not\(\.docked-left\) \{ overflow:visible!important/);
    assert.doesNotMatch(css, /resize\s*:\s*(both|horizontal|vertical)/);
});

test('batch shell/window/titlebar use terminal 14/12 proportions without AI-dependent overrides', () => {
    assert.match(css, /#view-remote \.remote-exec-tool-panel \{ border-radius:16px!important/);
    assert.match(css, /remote-exec-tool-panel\.docked-right \{ border-radius:14px!important/);
    assert.match(css, /remote-exec-tool-body \{ border-radius:0 0 15px 15px/);
    assert.match(spec, /\.terminal-page > \.z-unified-panel\.open:not\(\.docked-right\):not\(\.docked-left\) \{[^}]*border-radius: 16px !important/);
    assert.match(css, /remote-stage-shell \{[^}]*border-radius:14px/);
    assert.match(source, /morph\?\.\(stageShell, from, \{ preset: 'mac', radiusFrom: 14, radiusTo: 14/);
    const windows = spec.slice(spec.indexOf('#remoteWorkspace > .terminal-window.remote-exec-window,')).split('\n}')[0];
    assert.match(windows, /border-radius: 14px !important/);
    const title = spec.slice(spec.indexOf('.remote-window-titlebar {')).split('\n}')[0];
    assert.match(title, /border-radius: 12px 12px 0 0 !important/);
});
