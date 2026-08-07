/**
 * Static contract for the terminal workspace split grid.
 *
 * Two shipped defects are locked down here:
 *
 * 1. Opening a second connection from the dashboard stacked the terminals
 *    vertically instead of side-by-side. The card-flip path hardcoded
 *    `layout-1` and appended a second window itself, so the already-open window
 *    was auto-placed into an implicit grid ROW.
 *
 * 2. The resize bar covered terminal pixels and the window corners were
 *    covered/lost. The bar was an absolutely-positioned overlay sized for a
 *    12px `gap`, but terminal-mode forces `gap: 0 !important`, so it sat on top
 *    of the neighbouring window instead of between the two.
 *
 * Computed-layout facts (no overlap, side-by-side, painted radius) are proved in
 * tests/terminal-split-grid-browser-runner.mjs against real Chromium. This file
 * covers what a screenshot cannot: cascade ordering, cross-file coupling and the
 * call graph.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(root, 'public/style.css'), 'utf8');
const appJs = readFileSync(join(root, 'public/app.js'), 'utf8');

/** Strip CSS comments. Negative assertions must never trip on prose. */
function stripCssComments(text) {
    return text.replace(/\/\*[\s\S]*?\*\//g, '');
}
/**
 * Declaration block for a selector, comments stripped.
 *
 * `exact` anchors the selector to the start of a line so that asking for
 * `.workspace-splitter.vertical` returns the standalone rule and not the
 * grid-placement rule `.terminal-workspace-grid.layout-2 > .workspace-splitter.vertical`,
 * which merely contains that substring.
 */
function cssRule(selector, { last = false, exact = false } = {}) {
    let at;
    if (exact) {
        const re = new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`, 'm');
        const m = re.exec(css);
        assert.ok(m, `selector not found at line start: ${selector}`);
        at = m.index;
    } else {
        at = last ? css.lastIndexOf(selector) : css.indexOf(selector);
        assert.ok(at >= 0, `selector not found: ${selector}`);
    }
    const open = css.indexOf('{', at);
    const close = css.indexOf('}', open);
    assert.ok(open >= 0 && close > open, `unterminated rule: ${selector}`);
    return stripCssComments(css.slice(open + 1, close));
}
/** Balanced-brace body of a top-level function declaration in app.js. */
function fnBody(name) {
    const at = appJs.indexOf(`function ${name}(`);
    assert.ok(at >= 0, `function not found: ${name}`);
    const open = appJs.indexOf('{', appJs.indexOf(')', at));
    let depth = 0;
    for (let i = open; i < appJs.length; i++) {
        if (appJs[i] === '{') depth++;
        else if (appJs[i] === '}' && --depth === 0) return appJs.slice(at, i + 1);
    }
    throw new Error(`unterminated function: ${name}`);
}
/** Same body with comments stripped, for negative assertions. */
function fnCode(name) {
    return fnBody(name)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// ---------------------------------------------------------------------------
// Bug 2 — the resize bar owns a real grid track
// ---------------------------------------------------------------------------

test('the splitter gutter is a real grid track, not a gap the bar overlays', () => {
    const grid = cssRule('.terminal-workspace-grid {');
    assert.match(grid, /--workspace-gutter:\s*12px/);
    // The gutter track IS the spacing. A non-zero gap would double the spacing
    // and, more importantly, desynchronise the bar from the drag math.
    assert.match(grid, /gap:\s*0\b/);
    assert.doesNotMatch(grid, /gap:\s*12px/);
});

test('layout-2 and layout-3 place windows around the gutter track', () => {
    const l2 = cssRule('.terminal-workspace-grid.layout-2 {');
    assert.match(l2, /grid-template-columns:\s*var\(--workspace-split-x\)\s+var\(--workspace-gutter\)\s+minmax\(0,\s*1fr\)/);

    // Column 2 is the gutter, so the trailing window must be column 3.
    assert.match(cssRule('.terminal-workspace-grid.layout-2 .slot-1 {'), /grid-column:\s*1\b/);
    assert.match(cssRule('.terminal-workspace-grid.layout-2 .slot-2 {'), /grid-column:\s*3\b/);

    const l3 = cssRule('.terminal-workspace-grid.layout-3 {');
    assert.match(l3, /grid-template-columns:\s*var\(--workspace-split-x\)\s+var\(--workspace-gutter\)\s+minmax\(0,\s*1fr\)/);
    assert.match(l3, /grid-template-rows:\s*var\(--workspace-split-y\)\s+var\(--workspace-gutter\)\s+minmax\(0,\s*1fr\)/);
    // Row 2 is the gutter, so the left window spans rows 1..4 and the bottom
    // window starts at row 3.
    assert.match(cssRule('.terminal-workspace-grid.layout-3 .slot-1 {'), /grid-row:\s*1\s*\/\s*4/);
    assert.match(cssRule('.terminal-workspace-grid.layout-3 .slot-2 {'), /grid-row:\s*1\b/);
    assert.match(cssRule('.terminal-workspace-grid.layout-3 .slot-3 {'), /grid-row:\s*3\b/);
});

test('both splitters are placed into the gutter tracks explicitly', () => {
    assert.match(cssRule('.terminal-workspace-grid.layout-2 > .workspace-splitter.vertical {'),
        /grid-column:\s*2\b/);
    assert.match(cssRule('.terminal-workspace-grid.layout-3 > .workspace-splitter.vertical {'),
        /grid-column:\s*2[\s\S]*grid-row:\s*1\s*\/\s*4/);
    // Old bug: the horizontal bar was offset by `--workspace-split-x + 12px`,
    // i.e. 12px INSIDE the right column, leaving a notch and covering the
    // bottom window's top-left corner.
    assert.match(cssRule('.terminal-workspace-grid.layout-3 > .workspace-splitter.horizontal {'),
        /grid-column:\s*3[\s\S]*grid-row:\s*2\b/);
});

test('the splitter is a grid item and no longer an absolute overlay', () => {
    const bar = cssRule('.workspace-splitter {');
    assert.match(bar, /position:\s*relative/);
    assert.doesNotMatch(bar, /position:\s*absolute/);
    // A translucent/backdrop-filtered bar samples the neighbouring window and
    // smears its rounded corner into the gutter, which reads as "the corner got
    // covered".
    assert.doesNotMatch(bar, /backdrop-filter/);
    assert.match(bar, /--splitter-bar-bg:\s*var\(--surface\)/);
});

test('splitter geometry comes from the track, with no offset math left', () => {
    // `exact` is required: the grid-placement rules
    // `.terminal-workspace-grid.layout-N > .workspace-splitter.vertical`
    // contain this selector as a substring and would be matched first.
    const vertical = cssRule('.workspace-splitter.vertical', { exact: true });
    const horizontal = cssRule('.workspace-splitter.horizontal', { exact: true });
    for (const rule of [vertical, horizontal]) {
        // Any of these would let the bar escape its track and cover a window.
        assert.doesNotMatch(rule, /--workspace-split-[xy]/);
        assert.doesNotMatch(rule, /translate[XY]\(-50%\)/);
        assert.doesNotMatch(rule, /^\s*(left|right|top|bottom):/m);
    }
    assert.match(vertical, /cursor:\s*col-resize/);
    assert.match(horizontal, /cursor:\s*row-resize/);
});

test('compact (phone) layout still collapses to one cell and hides the bars', () => {
    assert.match(css, /\.terminal-workspace-grid\.compact \.workspace-splitter \{ display: none; \}/);
    const compact = cssRule('.terminal-workspace-grid.compact.layout-1,');
    assert.match(compact, /grid-template-columns:\s*1fr/);
});

// ---------------------------------------------------------------------------
// Bug 2 — drag geometry
// ---------------------------------------------------------------------------

test('drag math resolves against the content box and centres the gutter', () => {
    const metrics = fnBody('workspaceGridMetrics');
    // Percentages resolve against the content box; getBoundingClientRect() is
    // the border box. Mixing them drifts the bar away from the pointer.
    assert.match(metrics, /borderLeftWidth/);
    assert.match(metrics, /paddingLeft/);
    assert.match(metrics, /--workspace-gutter/);

    const drag = fnBody('startWorkspaceSplitterDrag');
    assert.match(drag, /workspaceGridMetrics\(workspace\)/);
    assert.match(drag, /metrics\.gutter \/ 2/);
    // The old code used a hardcoded half-gap against the border box.
    assert.doesNotMatch(fnCode('startWorkspaceSplitterDrag'), /splitterGapHalf/);
    assert.doesNotMatch(fnCode('startWorkspaceSplitterDrag'), /rect\.width/);
});

test('the clamp reserves room for the gutter and the trailing window', () => {
    const clamp = fnBody('clampWorkspaceSplitPercent');
    assert.match(clamp, /total - gutter - minTrailing/);
    const drag = fnBody('startWorkspaceSplitterDrag');
    assert.match(drag, /clampWorkspaceSplitPercent\(px, metrics\.width, metrics\.gutter, 24, 82\)/);
    assert.match(drag, /clampWorkspaceSplitPercent\(px, metrics\.height, metrics\.gutter, 22, 78\)/);
});

// ---------------------------------------------------------------------------
// Bug 1 — the layout owner is the only thing that decides layout-N
// ---------------------------------------------------------------------------

test('the card-flip mount defers to the renderer instead of hardcoding a layout', () => {
    const mount = fnCode('mountConnectionLocallyForCardFlip');
    assert.match(mount, /renderTerminalWorkspace\(\)/);
    // Each of these is how the vertical stack was produced: a fixed one-cell
    // template plus a hand-appended window, while an earlier window was still
    // mounted.
    assert.doesNotMatch(mount, /layout-1/);
    assert.doesNotMatch(mount, /workspace\.className\s*=/);
    assert.doesNotMatch(mount, /visualLayout\s*=\s*\[tabId\]/);
    assert.doesNotMatch(mount, /workspace\.appendChild\(win\)/);
});

test('the card-flip handoff defers to the renderer too, after restoring the node', () => {
    const hand = fnCode('finishTerminalCardFlipOpenHandoff');
    assert.doesNotMatch(hand, /layout-1/);
    assert.match(hand, /syncVisualLayout\(\{ preserve: true \}\)/);
    assert.match(hand, /renderTerminalWorkspace\(\)/);
    // Restore first: the renderer reuses only a window it can find under
    // #terminalWorkspace, otherwise it builds a second live iframe and the PTY
    // is dropped.
    assert.ok(hand.indexOf('restoreCardFlipHostedWindow()') < hand.indexOf('renderTerminalWorkspace()'));
});

test('the renderer remains the single owner of layout-N, slot-N and splitters', () => {
    const render = fnBody('renderTerminalWorkspace');
    assert.match(render, /layout-\$\{Math\.min\(count, 3\)\}/);
    assert.match(render, /slot-\$\{index \+ 1\}/);
    assert.match(render, /workspace-splitter vertical/);
    assert.match(render, /workspace-splitter horizontal/);
    // Only these two call sites may assign the workspace class.
    const assigns = appJs.match(/workspace\.className = `terminal-workspace terminal-workspace-grid layout-/g) || [];
    assert.equal(assigns.length, 1, 'exactly one place may assign the workspace layout class');
});

test('layout-1 defensively pins any in-flow window to the single cell', () => {
    // Belt for a partial render: without this a stale second window would be
    // auto-placed into an implicit row, i.e. the reported vertical stack.
    const pin = cssRule('.terminal-workspace-grid.layout-1 .terminal-window:not(.minimized-keepalive) {');
    assert.match(pin, /grid-column:\s*1/);
    assert.match(pin, /grid-row:\s*1/);
});

// ---------------------------------------------------------------------------
// Bug 2 — corners: the flip pin must be released, and the morph compensated
// ---------------------------------------------------------------------------

test('card-flip pins are released so later morphs can move the window', () => {
    // `[data-card-flip-radius]` is matched by a rule carrying
    // `transform: none !important`. Author-important outranks the Animation
    // origin, so while that attribute stays the window cannot be moved by
    // element.animate() at all: its siblings morph around it and end up
    // overlapping it, which covers corners.
    const release = fnBody('releaseCardFlipWindowPins');
    assert.match(release, /delete win\.dataset\.cardFlipRadius/);
    assert.match(release, /removeProperty\('transform'\)/);
    assert.match(release, /removeProperty\('transition'\)/);
    assert.match(release, /removeProperty\('filter'\)/);
    // The inline `animation: none` is deliberately kept (clearing it replays
    // terminalWindowIn on an already-visible window), so class-driven keyframes
    // must outrank it.
    assert.doesNotMatch(release, /removeProperty\('animation'\)/);
    assert.match(cssRule('.terminal-window.dock-swapping {'), /animation:[^;]*!important/);

    assert.match(fnBody('finishTerminalCardFlipOpenHandoff'), /releaseCardFlipWindowPins\(win\)/);
});

test('radius compensation is registered, coupled to --radius-lg, and interpolatable', () => {
    // Unregistered custom properties animate DISCRETELY, which staircases the
    // painted corner (measured 0.56px worst error vs 0.019px when registered).
    const rx = cssRule('@property --morph-rx');
    const ry = cssRule('@property --morph-ry');
    for (const prop of [rx, ry]) {
        assert.match(prop, /syntax:\s*'<length>'/);
        assert.match(prop, /inherits:\s*false/);
    }
    // @property initial-value cannot reference var(--radius-lg), so the literal
    // is duplicated. Assert the coupling or it silently drifts and a move-only
    // morph would square the corners.
    const radiusLg = /--radius-lg:\s*([0-9.]+px)/.exec(css)?.[1];
    assert.ok(radiusLg, '--radius-lg must be defined');
    assert.match(rx, new RegExp(`initial-value:\\s*${radiusLg.replace('.', '\\.')}`));
    assert.match(ry, new RegExp(`initial-value:\\s*${radiusLg.replace('.', '\\.')}`));
});

test('the compensation rule outranks the shell radius invariant and keys on the animated class', () => {
    const invariant = '.terminal-workspace:not(.custom-fullscreen) .terminal-window:not(:fullscreen):not(.minimized-keepalive)';
    const morph = '.terminal-workspace:not(.custom-fullscreen) .terminal-window.layout-morphing-radius:not(:fullscreen):not(.minimized-keepalive)';
    assert.ok(css.includes(invariant), 'shell radius invariant must still exist');
    assert.ok(css.includes(morph), 'compensation rule must carry the extra class for specificity');
    // Specificity (0,6,0) vs (0,5,0), and it must come later in source order.
    assert.ok(css.indexOf(morph) > css.indexOf(invariant));

    const rule = cssRule(morph);
    assert.match(rule, /var\(--morph-rx, var\(--radius-lg\)\)/);
    assert.match(rule, /var\(--morph-ry, var\(--radius-lg\)\)/);
    assert.match(rule, /!important/);
    // Keying on `.layout-morphing` would apply to move-only morphs, where those
    // properties are not animated at all.
    assert.ok(!css.includes('.terminal-window.layout-morphing:not(:fullscreen):not(.minimized-keepalive) {'),
        'compensation must not be keyed on .layout-morphing');
});

test('the morph track is densified and the compensation only runs on a resize', () => {
    const count = fnBody('terminalMorphFrameCount');
    // Two keyframes overshoot the painted corner by 2.25px (12.5%) because
    // R/scale is a hyperbola and WAAPI interpolates chords.
    assert.match(count, /Math\.min\(64, Math\.max\(20/);

    const frames = fnBody('buildTerminalMorphFrames');
    assert.match(frames, /compensate \? terminalMorphFrameCount\(sx, sy\) : 1/);
    assert.match(frames, /radius \/ Math\.max\(0\.0001, Math\.abs\(cx\)\)/);
    assert.match(frames, /radius \/ Math\.max\(0\.0001, Math\.abs\(cy\)\)/);

    const morph = fnBody('animateTerminalWindowLayoutFrom');
    assert.match(morph, /const compensate = restRadius > 0 && resized/);
    assert.match(morph, /if \(compensate\) el\.classList\.add\('layout-morphing-radius'\)/);
    assert.match(morph, /buildTerminalMorphFrames\(\{ dx, dy, sx, sy, radius: restRadius, compensate \}\)/);
});

test('morph animations are cancelled so a filled end keyframe cannot freeze later transforms', () => {
    const morph = fnBody('animateTerminalWindowLayoutFrom');
    // `fill: 'both'` keeps the end keyframe in the Animation origin forever,
    // outranking author-normal declarations: a leaked fill froze .minimizing's
    // scale(.72) and .dragging's translate at identity.
    assert.match(morph, /fill:\s*'both'/);
    assert.match(morph, /anim\.cancel\(\)/);
    assert.match(morph, /cosmetic\.cancel\(\)/);
    // The watchdog must cancel too, not merely drop the classes.
    assert.match(morph, /running\.forEach\(\(anim\) => \{ try \{ anim\.cancel\(\); \} catch \{\} \}\)/);
});

test('the flip settles into its slot instead of snapping out of full-stage', () => {
    const hand = fnBody('finishTerminalCardFlipOpenHandoff');
    assert.match(hand, /const stageRect = win\.getBoundingClientRect\(\)/);
    assert.match(hand, /animateTerminalWindowLayoutFrom\(new Map\(\[\[win\.dataset\.window, stageRect\]\]\)/);
    // Measured before the node leaves the full-screen back face.
    assert.ok(hand.indexOf('const stageRect') < hand.indexOf('restoreCardFlipHostedWindow()'));
});

test('the settle morph is gated so a single-window open stays interactive', () => {
    const hand = fnCode('finishTerminalCardFlipOpenHandoff');
    // The morph must be behind the gate, never called unconditionally: with one
    // visible window the final box differs from the full-stage box only by the
    // workspace's 1px border, so |dx|+|dy| = 2 already passes
    // animateTerminalWindowLayoutFrom's 1px threshold. That morph is invisible
    // but still adds `.layout-morphing`, which sets `pointer-events: none` on
    // `.terminal-frame` — the terminal would drop clicks and keys for 560ms
    // immediately after opening.
    assert.match(hand, /if \(shouldSettleCardFlipIntoSlot\(win, stageRect\)\) \{\s*animateTerminalWindowLayoutFrom\(/);

    const gate = fnCode('shouldSettleCardFlipIntoSlot');
    // Degenerate inputs must never schedule a morph.
    assert.match(gate, /if \(!win\?\.isConnected \|\| !stageRect \|\| stageRect\.width <= 1 \|\| stageRect\.height <= 1\) return false/);
    assert.match(gate, /if \(now\.width <= 1 \|\| now\.height <= 1\) return false/);
    // The threshold is read from the CSS token, so it cannot drift from the
    // grid definition. A hardcoded number here would silently diverge.
    assert.match(gate, /getPropertyValue\('--workspace-gutter'\)/);
    assert.doesNotMatch(gate, />=\s*(?:8|12|16|24)\s*(?:\)|;|$)/m);
    // All four dimensions matter: a slot change can be a move, a resize, or both.
    assert.match(gate, /Math\.abs\(now\.left - stageRect\.left\) >= gutter/);
    assert.match(gate, /Math\.abs\(now\.top - stageRect\.top\) >= gutter/);
    assert.match(gate, /Math\.abs\(now\.width - stageRect\.width\) >= gutter/);
    assert.match(gate, /Math\.abs\(now\.height - stageRect\.height\) >= gutter/);

    // `--workspace-gutter` must stay an unregistered custom property: the gate
    // reads it off the WINDOW, which only resolves through inheritance from the
    // grid container. Registering it with inherits:false would break that read.
    assert.doesNotMatch(css, /@property\s+--workspace-gutter/);

    // The pointer-dead rule this gate exists to avoid must still be the reason.
    const morphFrame = cssRule('.terminal-window.layout-morphing .terminal-frame,');
    assert.match(morphFrame, /pointer-events:\s*none/);
});

// ---------------------------------------------------------------------------
// Cache busting — the SW is cache-first on ?v= URLs
// ---------------------------------------------------------------------------

test('app shell assets are cache-busted for the split-grid change', () => {
    const appHtml = readFileSync(join(root, 'public/app.html'), 'utf8');
    const sw = readFileSync(join(root, 'public/sw.js'), 'utf8');
    // The service worker returns any cached ?v= URL without revalidating, so a
    // returning browser would keep the old app.js/style.css forever.
    assert.match(sw, /caches\.match\(request\)/);
    assert.match(appHtml, /app\.js\?v=[^"']*splitgrid1/);
    assert.match(appHtml, /style\.css\?v=[^"']*splitgrid1/);
    const scriptTags = appHtml.match(/app\.js\?v=([^"']+)/g) || [];
    assert.ok(scriptTags.length >= 2, 'modulepreload and script tag must both be busted');
    assert.equal(new Set(scriptTags).size, 1, 'every app.js reference must use the same revision');
});
