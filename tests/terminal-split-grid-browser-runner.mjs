/**
 * Real-browser geometry proof for the terminal workspace split grid.
 *
 * Static source assertions cannot prove "the resize bar does not cover a
 * terminal" or "two terminals sit side-by-side" — those are computed-layout
 * facts. This runner loads the shipped public/style.css in headless Chromium,
 * builds the exact DOM renderTerminalWorkspace() builds, and reads
 * getBoundingClientRect() for every window/splitter pair.
 *
 * NOTE: --virtual-time-budget must NOT be used here. With a 600KB stylesheet it
 * exhausts the budget before `load` fires and --dump-dom returns an empty body.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const candidates = [process.env.CHROMIUM_BIN, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].filter(Boolean);
const chromium = candidates.find(existsSync);
if (!chromium) { console.error('Chromium is required for test:split-grid-browser'); process.exit(2); }

const port = Number(process.env.SPLIT_GRID_SMOKE_PORT) || 18781;
const url = `http://127.0.0.1:${port}/tests/terminal-split-grid-browser-smoke.html`;
const server = spawn(process.execPath, ['tests/static-smoke-server.mjs', String(port)], { stdio: 'ignore' });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForServer() {
    for (let i = 0; i < 60; i++) {
        try { const response = await fetch(url); if (response.ok) return; } catch {}
        await wait(100);
    }
    throw new Error('static smoke server did not become ready');
}
function runChromium() {
    const profile = mkdtempSync(join(tmpdir(), 'zephyr-splitgrid-'));
    try {
        return spawnSync(chromium, [
            '--headless', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
            `--user-data-dir=${profile}`,
            '--window-size=1440,900',
            '--force-device-scale-factor=1',
            '--hide-scrollbars',
            '--dump-dom', url,
        ], { encoding: 'utf8', timeout: 90000 });
    } finally { rmSync(profile, { recursive: true, force: true }); }
}

const failures = [];
let checksRun = 0;
function check(name, ok, detail) {
    checksRun++;
    if (!ok) failures.push(`${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`);
}
/** Number of tracks in a computed grid-template-* string. */
const trackCount = (value) => String(value || '').trim().split(/\s+/).filter(Boolean).length;
const trackAt = (value, index) => parseFloat(String(value || '').trim().split(/\s+/)[index]);

try {
    await waitForServer();
    let result;
    for (let attempt = 1; attempt <= 2; attempt++) {
        result = runChromium();
        if (!result.error && result.status === 0 && /<pre id="out">[^<]/.test(result.stdout)) break;
        if (attempt === 1) await wait(800);
    }
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Chromium exited ${result.status}: ${result.stderr}`);
    const match = result.stdout.match(/<pre id="out">([\s\S]*?)<\/pre>/);
    if (!match || !match[1].trim()) throw new Error(`smoke produced no result (page never ran). stderr: ${result.stderr.slice(-2000)}`);
    const r = JSON.parse(match[1]
        .replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&'));
    if (r.error) throw new Error(`harness threw: ${r.error}\n${r.stack || ''}`);

    // ---- guard against a vacuous pass -------------------------------------
    check('production stylesheet actually loaded', r.env.cssLoaded === true, r.env);
    check('workspace is a grid', r.env.display === 'grid', r.env.display);
    check('window radius comes from the shell invariant', r.env.radius === '18px', r.env.radius);
    check('gutter token is 12px', r.env.gutter === '12px', r.env.gutter);
    check('splitter background is fully opaque (no corner smear)',
        /^rgb\(\d+, \d+, \d+\)$/.test(r.env.splitterBg), r.env.splitterBg);

    // ---- layout-1 ----------------------------------------------------------
    const l1 = r.layouts['1'];
    check('layout-1 has a single column track', trackCount(l1.cols) === 1, l1.cols);
    check('layout-1 has a single row track', trackCount(l1.rows) === 1, l1.rows);
    check('layout-1 mounts no splitter', l1.sx === null && l1.sy === null, { sx: l1.sx, sy: l1.sy });

    // ---- layout-2: side-by-side, disjoint boxes -----------------------------
    const l2 = r.layouts['2'];
    check('layout-2 grid is [window | gutter | window]', trackCount(l2.cols) === 3, l2.cols);
    check('layout-2 gutter track is exactly 12px', Math.abs(trackAt(l2.cols, 1) - 12) < 0.6, l2.cols);
    check('layout-2 grid gap stays 0 (the gutter track IS the spacing)', l2.gap === '0px', l2.gap);
    check('layout-2 terminals are SIDE-BY-SIDE', l2.sideBySide === true, l2.wins);
    check('layout-2 terminals are NOT stacked vertically', l2.stackedVertically === false, l2.wins);
    l2.splitterOverlaps.forEach((o) => {
        check(`layout-2 splitter ${o.splitter} does not cover window ${o.win}`, o.area === 0, o);
    });
    l2.windowOverlaps.forEach((o) => {
        check(`layout-2 window ${o.a} does not overlap window ${o.b}`, o.area === 0, o);
    });
    check('layout-2 bar left edge meets window 1 right edge exactly',
        l2.sxFillsGutter.leftEdgeMatchesW1Right < 0.6, l2.sxFillsGutter);
    check('layout-2 bar right edge meets window 2 left edge exactly',
        l2.sxFillsGutter.rightEdgeMatchesW2Left < 0.6, l2.sxFillsGutter);
    check('layout-2 bar is exactly the gutter width', Math.abs(l2.sxFillsGutter.width - 12) < 0.6, l2.sxFillsGutter);
    check('layout-2 splitter is a grid item, not an absolute overlay',
        l2.splitterPosition === 'relative', l2.splitterPosition);
    check('layout-2 splitter has no backdrop-filter', l2.splitterBackdrop === 'none', l2.splitterBackdrop);

    // ---- layout-3: 3-up, disjoint boxes ------------------------------------
    const l3 = r.layouts['3'];
    check('layout-3 grid has 3 column tracks', trackCount(l3.cols) === 3, l3.cols);
    check('layout-3 grid has 3 row tracks', trackCount(l3.rows) === 3, l3.rows);
    check('layout-3 row gutter track is exactly 12px', Math.abs(trackAt(l3.rows, 1) - 12) < 0.6, l3.rows);
    l3.splitterOverlaps.forEach((o) => {
        check(`layout-3 splitter ${o.splitter} does not cover window ${o.win}`, o.area === 0, o);
    });
    l3.windowOverlaps.forEach((o) => {
        check(`layout-3 window ${o.a} does not overlap window ${o.b}`, o.area === 0, o);
    });
    check('layout-3 vertical bar fills the column gutter',
        l3.sxFillsGutter.leftEdgeMatchesW1Right < 0.6 && l3.sxFillsGutter.rightEdgeMatchesW2Left < 0.6, l3.sxFillsGutter);
    check('layout-3 horizontal bar fills the row gutter',
        l3.syFillsGutter.topEdgeMatchesW2Bottom < 0.6 && l3.syFillsGutter.bottomEdgeMatchesW3Top < 0.6, l3.syFillsGutter);
    // Old bug: horizontal bar started at split-x + 12px, i.e. 12px inside the
    // right column, leaving a notch and covering window 3's top-left corner.
    check('layout-3 horizontal bar starts at the right column edge (no 12px notch)',
        l3.syFillsGutter.leftEdgeMatchesRightColumn < 0.6, l3.syFillsGutter);
    check('layout-3 left window spans the full height',
        Math.abs(l3.wins[0].h - (l3.wins[2].b - l3.wins[1].t)) < 1.2, { w1: l3.wins[0], w2: l3.wins[1], w3: l3.wins[2] });

    // ---- the reported bug can no longer render -----------------------------
    check('layout-1 holding a stale second window never stacks it into an implied row',
        r.staleSlot.impliedRow === false && r.staleSlot.sameCell === true, r.staleSlot);
    check('layout-1 never grows a second row track', trackCount(r.staleSlot.rows) === 1, r.staleSlot.rows);

    // ---- drag: grab point == bar centre ------------------------------------
    const unclamped = r.drags.filter((d) => !d.clamped);
    check('drag probe produced unclamped samples', unclamped.length >= 3, r.drags);
    const maxDrift = Math.max(...unclamped.map((d) => Math.abs(d.drift)));
    check('bar tracks the pointer with no drift inside the clamp range', maxDrift <= 0.75, { maxDrift, unclamped });
    check('drag clamps the low end', r.drags.some((d) => d.clamped && d.pct <= 24.01), r.drags);
    check('drag clamps the high end', r.drags.some((d) => d.clamped && d.pct >= 24), r.drags);
    const minTrailing = Math.min(...r.drags.map((d) => d.trailingWidth ?? Infinity));
    check('the trailing terminal is never collapsed by a drag', minTrailing >= 80, { minTrailing, drags: r.drags });

    // ---- radius compensation vs the !important shell invariant -------------
    const rad = r.radius;
    check('plain WAAPI border-radius is outranked by the invariant (why custom props are required)',
        rad.plainBlocked === '18px', rad.plainBlocked);
    check('shell radius is the expected 18px baseline', rad.rest === 18, rad.rest);
    // sx=2, sy=0.5 -> rx = 18/2 = 9, ry = 18/0.5 = 36.
    check('compensated radius is applied through the registered custom properties at offset 0',
        rad.startRadius === '9px 36px', rad.startRadius);
    // offset 0.5 -> cx = 1.5, cy = 0.75 -> rx = 12, ry = 24. An UNREGISTERED
    // custom property animates discretely and could not land on this value.
    check('compensated radius interpolates mid-timeline (properties are registered)',
        rad.midRadius === '12px 24px', rad.midRadius);
    check('mid-timeline radius differs from both endpoints (not a discrete hold)',
        rad.midRadius !== rad.startRadius && rad.midRadius !== rad.endRadius, rad);
    check('radius lands back on the shell radius at the end of the morph',
        rad.endRadius === '18px', rad.endRadius);
    check('radius returns to the invariant once the morph class is removed',
        rad.afterCleanup === '18px', rad.afterCleanup);
    // A move-only morph animates no --morph-* property. If the consuming rule
    // were keyed on .layout-morphing it would resolve to its fallback (or 0)
    // and square the corner for the whole 560ms — the bug being fixed.
    check('a MOVE-ONLY morph never engages the compensation rule',
        rad.moveOnlyRadius === '18px', rad.moveOnlyRadius);
    // The compensation is R/scale (a hyperbola) while WAAPI interpolates
    // linearly, so the track must be densified. Two keyframes measured 2.25px
    // (12.5%) of painted overshoot; this must stay sub-0.05px.
    check('geometry track is densified, not 2 keyframes',
        rad.frameCountAt2 >= 20, rad.frameCountAt2);
    check('frame count scales with the zoom ratio and stays bounded',
        rad.frameCountAt10 > rad.frameCountAt2 && rad.frameCountAt10 <= 64,
        { at2: rad.frameCountAt2, at10: rad.frameCountAt10 });
    check('PAINTED radius stays constant across the whole morph, for every scale',
        rad.worstPaintedErrorPx <= 0.05, { worst: rad.worstPaintedErrorPx, matrix: rad.matrix });
    (rad.matrix || []).forEach((m) => {
        check(`painted radius constant at sx=${m.sx} sy=${m.sy}`,
            m.worstPaintedErrorPx <= 0.05, m);
    });

    // ---- fill:both leak ----------------------------------------------------
    check('a leaked morph fill does freeze the author transform (proves the hazard)',
        r.fill.whileFilling === 'matrix(1, 0, 0, 1, 0, 0)', r.fill);
    check('cancel() releases it so .minimizing can scale again',
        /^matrix\(0\.72,/.test(r.fill.afterCancel), r.fill);

    // ---- settle gate: no invisible morph on a single-window open -----------
    // animateTerminalWindowLayoutFrom's own threshold is |dx|+|dy| > 1, and the
    // workspace's 1px border already puts a single window 1px off the stage box
    // on BOTH axes (sum = 2). Without the gate every single-terminal open would
    // run a 560ms morph whose only visible effect is `.layout-morphing`'s
    // `pointer-events: none` on the frame — the terminal would swallow clicks
    // and keys right after opening.
    const sg = r.settleGate;
    check('single-window handoff really is within 1px per axis of the stage box',
        Math.abs(sg.single.dx) <= 1.01 && Math.abs(sg.single.dy) <= 1.01, sg.single);
    check('that delta WOULD trip the naive 1px morph threshold (why the gate exists)',
        sg.single.wouldMorphWithoutGate === true, sg.single);
    check('the gate suppresses the invisible single-window morph',
        sg.single.gate === false, sg.single);
    check('the gate threshold is read from the gutter token, not hardcoded',
        sg.single.gutterSeen === '12px', sg.single);
    check('the gate still allows the real multi-window slot morph',
        sg.multi.gate === true, sg.multi);
    check('the multi-window delta is materially larger than one gutter',
        Math.abs(sg.multi.dx) >= 12, sg.multi);
    check('the gate rejects a null window', sg.degenerate.nullWin === false, sg.degenerate);
    check('the gate rejects a zero-sized stage box', sg.degenerate.zeroStage === false, sg.degenerate);

    // ---- the SHIPPED renderer, executed for real ---------------------------
    // These drive renderTerminalWorkspace() sliced out of public/app.js, so a
    // regression in the real function fails here — not just in a replica.
    const sr = r.shippedRender;
    const cls = (v) => String(v || '').trim().replace(/\s+/g, ' ');

    // The exact reported repro: one terminal already open, then a second is
    // opened from the dashboard with "multiple terminals per page" on.
    check('shipped renderer picks layout-2 for two visible terminals',
        / layout-2$/.test(cls(sr.two.cls)) || cls(sr.two.cls).includes('layout-2'), sr.two.cls);
    check('shipped renderer never leaves layout-1 with two visible terminals',
        !cls(sr.two.cls).includes('layout-1'), sr.two.cls);
    check('shipped renderer assigns slot-1 and slot-2 (not two slot-1s)',
        sr.two.windows.map((w) => cls(w.cls).match(/slot-\d/)?.[0]).join(',') === 'slot-1,slot-2',
        sr.two.windows);
    check('shipped renderer mounts exactly one vertical splitter for two terminals',
        sr.two.splitters.length === 1 && sr.two.splitters[0].includes('vertical'), sr.two.splitters);
    check('shipped renderer lays the two terminals out SIDE-BY-SIDE',
        sr.two.rects.length === 2
        && sr.two.rects[1].l > sr.two.rects[0].l + 1
        && Math.abs(sr.two.rects[1].t - sr.two.rects[0].t) < 1, sr.two.rects);
    check('shipped renderer does NOT stack the two terminals vertically',
        !(Math.abs(sr.two.rects[1].l - sr.two.rects[0].l) < 1 && sr.two.rects[1].t > sr.two.rects[0].t + 1),
        sr.two.rects);
    check('shipped renderer produces a 3-track column grid for two terminals',
        trackCount(sr.two.cols) === 3, sr.two.cols);
    check('shipped renderer keeps a single row track for two terminals',
        trackCount(sr.two.rows) === 1, sr.two.rows);
    check('shipped renderer populates visualLayout for two terminals',
        Array.isArray(sr.two.visualLayout) && sr.two.visualLayout.length === 2, sr.two.visualLayout);

    check('shipped renderer picks layout-3 for three visible terminals',
        cls(sr.three.cls).includes('layout-3'), sr.three.cls);
    check('shipped renderer assigns slot-1/2/3 for three terminals',
        sr.three.windows.map((w) => cls(w.cls).match(/slot-\d/)?.[0]).sort().join(',') === 'slot-1,slot-2,slot-3',
        sr.three.windows);
    check('shipped renderer mounts both splitters for three terminals',
        sr.three.splitters.length === 2
        && sr.three.splitters.some((c) => c.includes('vertical'))
        && sr.three.splitters.some((c) => c.includes('horizontal')), sr.three.splitters);
    check('shipped renderer produces a 3-track row grid for three terminals',
        trackCount(sr.three.rows) === 3, sr.three.rows);

    // The setting must still be honoured: maxWindows = 1 stays single-cell.
    check('shipped renderer honours maxWindows=1 with layout-1',
        cls(sr.single.cls).includes('layout-1'), sr.single.cls);
    check('shipped renderer mounts no splitter when only one terminal is visible',
        sr.single.splitters.length === 0, sr.single.splitters);
    check('shipped renderer parks the minimized keep-alive window offscreen',
        sr.single.rects.some((x) => x.l < -1000), sr.single.rects);

    // Reuse is the reason the card-flip mount may call the renderer at all: a
    // rebuilt window would drop the live PTY and reload the SSH iframe.
    check('shipped renderer rebuilds no window on a second pass (live iframes survive)',
        Array.isArray(sr.reuse.createdOnSecondPass) && sr.reuse.createdOnSecondPass.length === 0,
        sr.reuse);
    check('shipped renderer keeps the identical window nodes across renders',
        sr.reuse.sameNodes === true, sr.reuse);

    // ---- the SHIPPED entry point, driving the exact reported repro ---------
    // renderTerminalWorkspace() above was always correct; the defect lived in
    // mountConnectionLocallyForCardFlip(), which is what a dashboard tap calls.
    // These checks run that function twice with the first window still mounted.
    const sm = r.shippedMount;
    const slotsOf = (snap) => snap.windows.map((w) => cls(w.cls).match(/slot-\d/)?.[0] || 'none');
    const stackedIn = (snap) => {
        const w = snap.windows.filter((x) => !cls(x.cls).includes('minimized-keepalive'));
        if (w.length < 2) return false;
        return Math.abs(w[1].l - w[0].l) < 1 && w[1].t > w[0].t + 1;
    };
    const sideBySideIn = (snap) => {
        const w = snap.windows.filter((x) => !cls(x.cls).includes('minimized-keepalive'));
        if (w.length < 2) return false;
        return w[1].l > w[0].l + 1 && Math.abs(w[1].t - w[0].t) < 1;
    };

    // --- desktop, "multiple terminals per page" on (the default) -----------
    const dsk = sm.desktop;
    check('mount: first connection produces layout-1', cls(dsk.afterFirst.cls).includes('layout-1'), dsk.afterFirst.cls);
    check('mount: first connection clears the empty-state placeholder',
        dsk.afterFirst.placeholders === 0, dsk.afterFirst.placeholders);
    check('mount: SECOND connection switches the workspace to layout-2',
        cls(dsk.afterSecond.cls).includes('layout-2'), dsk.afterSecond.cls);
    check('mount: SECOND connection no longer leaves layout-1 (the shipped bug)',
        !cls(dsk.afterSecond.cls).includes('layout-1'), dsk.afterSecond.cls);
    check('mount: the two windows get slot-1 and slot-2, not two slot-1s',
        slotsOf(dsk.afterSecond).join(',') === 'slot-1,slot-2', dsk.afterSecond.windows);
    check('mount: the two terminals end up SIDE-BY-SIDE',
        sideBySideIn(dsk.afterSecond) === true, dsk.afterSecond.windows);
    // This is the reported symptom, measured at the real entry point.
    check('mount: the two terminals are NOT stacked vertically',
        stackedIn(dsk.afterSecond) === false, dsk.afterSecond.windows);
    check('mount: a vertical splitter is created for the second window',
        dsk.afterSecond.splitters.length === 1 && dsk.afterSecond.splitters[0].includes('vertical'),
        dsk.afterSecond.splitters);
    check('mount: the grid gains the gutter track (3 columns)',
        trackCount(dsk.afterSecond.cols) === 3, dsk.afterSecond.cols);
    check('mount: the grid never grows a second ROW track',
        trackCount(dsk.afterSecond.rows) === 1, dsk.afterSecond.rows);
    check('mount: visualLayout holds both tabs instead of only the new one',
        Array.isArray(dsk.afterSecond.visualLayout) && dsk.afterSecond.visualLayout.length === 2,
        dsk.afterSecond.visualLayout);
    check('mount: the newly opened tab becomes active',
        dsk.afterSecond.activeTerminalTab === dsk.id2, dsk.afterSecond.activeTerminalTab);
    // openConnectionWithCardFlip() bails out to the non-flip path if this fails.
    check('mount: the caller can still find the live window it must animate',
        dsk.callerCanFindNewWindow === true, dsk.callerCanFindNewWindow);
    // Rebuilding window 1 would reload its iframe and drop the live PTY.
    check('mount: the already-open window is NOT rebuilt',
        Array.isArray(dsk.recreatedOnSecondMount) && !dsk.recreatedOnSecondMount.includes('tabA'),
        dsk.recreatedOnSecondMount);
    check('mount: the already-open window keeps the identical DOM node',
        dsk.window1NodePreserved === true, dsk.window1NodePreserved);
    check('mount: session params are written for both tabs',
        Array.isArray(dsk.sessionParamsWritten) && dsk.sessionParamsWritten.every(Boolean),
        dsk.sessionParamsWritten);

    // --- desktop with the setting capped at one window ----------------------
    const cap = sm.capped;
    check('mount (maxWindows=1): stays on layout-1', cls(cap.afterSecond.cls).includes('layout-1'), cap.afterSecond.cls);
    check('mount (maxWindows=1): no splitter is created', cap.afterSecond.splitters.length === 0, cap.afterSecond.splitters);
    check('mount (maxWindows=1): nothing is stacked', stackedIn(cap.afterSecond) === false, cap.afterSecond.windows);
    check('mount (maxWindows=1): the previous window is parked offscreen as keep-alive',
        cap.afterSecond.windows.some((w) => cls(w.cls).includes('minimized-keepalive') && w.l < -1000),
        cap.afterSecond.windows);
    check('mount (maxWindows=1): the previous window is still not rebuilt',
        !cap.recreatedOnSecondMount.includes('tabA'), cap.recreatedOnSecondMount);

    // --- phone/compact: one window regardless of the setting ---------------
    const cmp = sm.compact;
    check('mount (compact): keeps the compact class', cls(cmp.afterSecond.cls).includes('compact'), cmp.afterSecond.cls);
    check('mount (compact): stays on layout-1', cls(cmp.afterSecond.cls).includes('layout-1'), cmp.afterSecond.cls);
    check('mount (compact): no splitter is created', cmp.afterSecond.splitters.length === 0, cmp.afterSecond.splitters);
    check('mount (compact): nothing is stacked', stackedIn(cmp.afterSecond) === false, cmp.afterSecond.windows);
    check('mount (compact): single cell grid', trackCount(cmp.afterSecond.cols) === 1, cmp.afterSecond.cols);

    if (failures.length) {
        console.error(`terminal split grid browser smoke FAILED (${failures.length} of ${checksRun} checks):`);
        failures.forEach((f) => console.error(`  - ${f}`));
        process.exitCode = 1;
    } else {
        console.log(JSON.stringify({
            ok: true,
            checks: checksRun,
            layout2Cols: l2.cols,
            layout3Rows: l3.rows,
            maxDragDrift: maxDrift,
            worstPaintedRadiusErrorPx: r.radius.worstPaintedErrorPx,
            shippedRenderTwo: cls(sr.two.cls),
            shippedRenderThree: cls(sr.three.cls),
            shippedMountSecondOpen: cls(sm.desktop.afterSecond.cls),
            shippedMountStacked: stackedIn(sm.desktop.afterSecond),
        }));
    }
} finally { server.kill('SIGTERM'); }
