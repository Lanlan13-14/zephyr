import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const L = require('../public/liquid-glass-tab-layout.js');
const navSource = readFileSync(process.env.NAV_SOURCE || new URL('../public/liquid-glass-nav.js', import.meta.url), 'utf8');
const rendererSource = readFileSync(new URL('../public/liquid-glass-renderer.js', import.meta.url), 'utf8');
// Exercise the real shared transform without WebGL or a browser.
const transformSource = rendererSource.slice(rendererSource.indexOf('  function computeElementTransform('), rendererSource.indexOf('  // ../../var/minis/workspace/liquid-glass-webgl/src/components/liquid-glass/renderer/methods-render-glass-backdrop.ts'));
const transform = vm.runInNewContext(transformSource + '\ncomputeElementTransform', { DP: 1 });
const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
function harness() {
  let top = 10, offset = 0, width = 600, tabHeight = 32;
  const frames = [], observers = [];
  const cls = names => ({ contains: n => names.includes(n), add() {} });
  const style = () => ({ setProperty() {}, removeProperty() {}, getPropertyValue: () => '' });
  const tabs = Array.from({ length: 6 }, (_, i) => ({ classList: cls(i === 0 ? ['active'] : []), style: style(), dataset: { view: 'v' + i }, textContent: 'Tab ' + i, offsetWidth: 80,
    getBoundingClientRect: () => rect(50 + offset + width / 6 * i, top + 4, width / 6, tabHeight) }));
  const bar = { style: style(), querySelectorAll: () => tabs, getBoundingClientRect: () => rect(46 + offset, top, width + 8, 40), addEventListener() {} };
  const nav = { clientWidth: 1000, classList: cls([]), querySelector: s => s === '.nav-tabs' ? bar : null, addEventListener() {} };
  const canvas = { style: {}, getBoundingClientRect: () => rect(0, 0, 1000, 80) };
  const root = { style: style(), getAttribute: () => null };
  const document = { documentElement: root, body: { classList: cls([]) }, readyState: 'complete', querySelector: s => s === '.main-nav' ? nav : null,
    getElementById: id => id === 'liquidGlassCanvas' ? canvas : null,
    createElement: () => ({ width: 0, height: 0, getContext: () => ({ setTransform() {}, clearRect() {}, fillRect() {} }) }) };
  const cs = { display: 'flex', paddingLeft: '4', paddingRight: '4', paddingTop: '4', paddingBottom: '4', getPropertyValue: () => '' };
  class Observer { constructor(cb) { this.cb = cb; observers.push(this); } observe() {} }
  class Renderer {
    constructor() { this.quickToggles = {}; this.dpr = 0; this.rafId = null; this.buttonConfigs = []; this.toggleStates = new Map(); this.resizeCalls = []; this.draws = []; }
    requestRender() { if (this.rafId !== null) return; this.rafId = frames.length; frames.push(() => { this.rafId = null; this.render(); }); }
    render() { for (const el of this.buttonConfigs.filter(e => e.kind === 'glass-shape')) this.renderGlassElement(el, null, null, null, null, null, el.rect); }
    renderGlassElement(el, st, a, b, c, d, r) { this.draws.push({ id: el.id, t: transform.call(this, el, st, r) }); }
    resize(w, h) { this.resizeCalls.push([w, h, this.dpr]); this.requestRender(); }
    setBackgroundColor() {} loadWallpaperFromCanvas() {} setWallpaperClip() {}
    setButtons(items) { this.buttonConfigs = items; this.requestRender(); }
    setTabSelected(g, i) { if (!this.toggleStates.has(g)) this.toggleStates.set(g, { fraction: i, scaleX: 1, scaleY: 1, pressProgress: 0, panelOffset: 0, velocity: 0 }); }
  }
  const window = { LiquidGlassWebGL: { LiquidGlassRenderer: Renderer }, LiquidGlassTabLayout: L, getComputedStyle: () => cs, addEventListener() {}, devicePixelRatio: 1, innerWidth: 1000, innerHeight: 800 };
  vm.runInNewContext(navSource, { window, document, getComputedStyle: () => cs, MutationObserver: Observer, ResizeObserver: Observer, requestAnimationFrame: cb => frames.push(cb), setTimeout() {} });
  const renderer = window.ZephyrLiquidGlassBars.topNav.renderer;
  function flush() { let n = 0; while (frames.length) { assert.ok(++n < 30, 'idle nav must not perpetually schedule itself'); frames.shift()(); } }
  return { renderer, window, Renderer, flush, setTop: v => { top = v; }, setOffset: v => { offset = v; }, setWidth: v => { width = v; }, setTabHeight: v => { tabHeight = v; } };
}
function assertContained(r) {
  const latest = r.draws.slice(-2).map(d => d.t);
  const [c, i] = latest;
  assert.ok(i.sx >= c.sx - 1e-8 && i.sx + i.sw <= c.sx + c.sw + 1e-8, 'transformed lens inside container horizontally');
  assert.ok(i.sy >= c.sy - 1e-8 && i.sy + i.sh <= c.sy + c.sh + 1e-8, 'transformed lens inside container vertically');
}

test('settings shortcut tab maps to the same keyboard as SSH toolbar, including liquid-glass renderer',()=>{
 const iconSource=navSource.slice(navSource.indexOf('var ICON_COMMANDS = {'),navSource.indexOf('};',navSource.indexOf('var ICON_COMMANDS = {')));
 assert.ok(iconSource.includes("shortcuts: [\n      { op: 'rect', x: 2, y: 5, w: 20, h: 14, rx: 2 }"));
 assert.ok(iconSource.includes("{ op: 'line', x1: 6, y1: 9, x2: 6.01, y2: 9 }"));
 assert.ok(iconSource.includes("{ op: 'line', x1: 8, y1: 15, x2: 16, y2: 15 }"));
 assert.match(navSource,/ICON_COMMANDS\\[tabKey\\] \\|\\| ICON_COMMANDS\\.settings/);
});

test('queued old spring frame remeasures a y-only reflow before drawing; no idle loop', () => {
  const h = harness(); h.flush();
  h.renderer.requestRender(); h.setTop(37.375); h.flush();
  assert.equal(h.renderer.buttonConfigs[0].rect.y, 37.375);
  assertContained(h.renderer);
});
test('fractional movement and middle-cell height invalidate layout even with identical rounded x/width', () => {
  const h = harness(); h.flush(); h.setOffset(0.125); h.setTabHeight(31.75);
  h.window.ZephyrLiquidGlassBars.refreshAll(false); h.flush();
  assert.equal(h.renderer.buttonConfigs[0].rect.x, 46.125);
  assert.equal(h.renderer.buttonConfigs.at(-1).rect.h, 31.75);
});
test('same CSS size at new DPR reallocates via resize, no stale sampling dimensions', () => {
  const h = harness(); h.flush(); const n = h.renderer.resizeCalls.length;
  h.window.devicePixelRatio = 2.625; h.renderer.requestRender(); h.flush();
  assert.equal(h.renderer.resizeCalls.length, n + 1);
  assert.equal(h.renderer.dpr, 2.625);
});
test('real transform stays contained across resize, press overshoot, both velocity signs and end tabs', () => {
  const h = harness(); h.flush();
  const state = h.renderer.toggleStates.get('zephyr-nav');
  for (const width of [600, 240, 720.25]) for (const fraction of [0, 0.5, 2.4, 5]) for (const velocity of [-50, 0, 50]) for (const pressProgress of [0, 0.6, 1, 1.05]) {
    Object.assign(state, { fraction, scaleX: 1.5, scaleY: 1.6, pressProgress, panelOffset: 3, velocity });
    h.setWidth(width); h.renderer.requestRender(); h.flush(); assertContained(h.renderer);
    assert.equal(state.velocity, velocity, 'do not cancel the live spring');
  }
});
test('indicator backdrop bounds come from glass inner rect rather than oversized tab height', () => {
  const h = harness(); h.setTabHeight(44); h.flush();
  const meta = h.renderer.buttonConfigs.at(-1).isBottomTabIndicator;
  assert.equal(meta.containerRect.h, 32); assert.equal(meta.containerRect.y, 14);
});
test('geometry key includes y, fractional coordinates, and every cell; DPR follows renderer policy', () => {
  const a = [{ x: 1, y: 2, w: 3, h: 4 }, { x: 4, y: 2, w: 3, h: 4 }];
  const key = rs => L.navGeometryKey(rect(0, 0, 10, 10), { x: 0, y: 0 }, rs, { x: 1, y: 1, w: 8, h: 8 });
  for (const prop of ['x', 'y', 'w', 'h']) assert.notEqual(key(a), key([a[0], { ...a[1], [prop]: a[1][prop] + .125 }]));
  assert.deepEqual([1, 2, 2.625, 4].map(L.navPixelRatio), [2, 2, 2.625, 3]);
});

test('resting lens geometry unchanged and shared renderer prototype untouched', () => {
  const h = harness(); h.flush();
  assert.ok(Object.hasOwn(h.renderer, 'renderGlassElement'));
  const other = new h.Renderer();
  assert.equal(other.renderGlassElement, h.Renderer.prototype.renderGlassElement);
  assert.equal(other.render, h.Renderer.prototype.render);
  const el = h.renderer.buttonConfigs.at(-1), base = el.rect;
  const drawn = h.renderer.draws.at(-1).t;
  assert.equal(drawn.sx, base.x); assert.equal(drawn.sy, base.y);
  assert.equal(drawn.sw, base.w); assert.equal(drawn.sh, base.h);
});
