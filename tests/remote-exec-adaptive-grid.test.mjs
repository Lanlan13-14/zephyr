import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const appJs = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../public/zephyr-terminal-spec.css', import.meta.url), 'utf8');

function loadGrid() {
    const start = appJs.indexOf('const REMOTE_PANE_MIN_W');
    const end = appJs.indexOf('function applyRemoteGridLayout');
    assert.ok(start > 0 && end > start, 'computeRemoteGrid source block must exist');
    const ctx = {};
    vm.createContext(ctx);
    vm.runInContext(appJs.slice(start, end) + '\nthis.computeRemoteGrid = computeRemoteGrid; this.MIN_W = REMOTE_PANE_MIN_W; this.MIN_H = REMOTE_PANE_MIN_H;', ctx);
    return ctx;
}

test('grid picks columns from stage area and never shrinks panes below the minimum', () => {
    const { computeRemoteGrid, MIN_W, MIN_H } = loadGrid();
    for (const [w, h] of [[916, 652], [1280, 800], [1920, 1000], [600, 900], [380, 700]]) {
        for (let n = 1; n <= 40; n++) {
            const g = computeRemoteGrid(n, w, h);
            assert.ok(g.cols >= 1 && g.rows >= 1 && g.cols * g.rows >= n, `cells cover ${n} @${w}x${h}`);
            assert.ok(g.cols <= n, 'no empty columns');
            assert.ok(g.rowH >= Math.min(MIN_H, h), `row height ${g.rowH} keeps panes readable (${n} @${w}x${h})`);
            if (g.cols > 1) assert.ok((w - (g.cols - 1) * 12) / g.cols >= MIN_W - 1, `column width ok (${n} @${w}x${h})`);
            if (!g.scroll) assert.ok(g.rows * g.rowH + (g.rows - 1) * 12 <= h, 'fits without scrolling');
        }
    }
});

test('1-4 panes keep the familiar full / split / quad layout, many panes scroll', () => {
    const { computeRemoteGrid } = loadGrid();
    assert.deepEqual(JSON.parse(JSON.stringify(computeRemoteGrid(1, 916, 652))), { cols: 1, rows: 1, rowH: 652, scroll: false });
    assert.equal(computeRemoteGrid(2, 916, 652).cols, 2);
    assert.equal(computeRemoteGrid(2, 916, 652).rows, 1);
    const four = computeRemoteGrid(4, 916, 652);
    assert.equal(four.cols, 2); assert.equal(four.rows, 2); assert.equal(four.scroll, false);
    const many = computeRemoteGrid(30, 916, 652);
    assert.equal(many.scroll, true);
    assert.equal(many.rowH, 300);
});

test('stage scrolls on its own; windows get explicit cells and no CSS keyframe replay', () => {
    assert.match(css, /remote-grid-scroll[\s\S]{0,300}overflow-y:\s*auto/);
    assert.match(css, /grid-column:\s*var\(--remote-gc/);
    assert.match(css, /grid-row:\s*var\(--remote-gr/);
    assert.match(css, /remote-exec-window[\s\S]{0,700}animation:\s*none\s*!important/);
    assert.match(css, /#remoteWorkspace\.terminal-workspace-grid\s*\{\s*contain:\s*none/);
    assert.match(appJs, /--remote-gc/);
    assert.match(appJs, /new ResizeObserver\(\(\) => \{[\s\S]{0,200}applyRemoteGridLayout/);
});
