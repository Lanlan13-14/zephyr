import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertAssetVersion, cacheNameVersion, singleAssetVersion } from './helpers/cache-version.mjs';

const floating = readFileSync(new URL('../public/floating-panel.js', import.meta.url), 'utf8');
const terminal = readFileSync(new URL('../public/terminal.js', import.meta.url), 'utf8');
const telnet = readFileSync(new URL('../public/telnet-terminal.js', import.meta.url), 'utf8');
const novnc = readFileSync(new URL('../public/novnc.js', import.meta.url), 'utf8');
const rdp = readFileSync(new URL('../public/rdp-wasm-client.js', import.meta.url), 'utf8');
const image = readFileSync(new URL('../public/preview/image/image-preview.js', import.meta.url), 'utf8');
const media = readFileSync(new URL('../public/preview/media/media-preview.js', import.meta.url), 'utf8');
const style = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const appHtml = readFileSync(new URL('../public/app.html', import.meta.url), 'utf8');
const terminalHtml = readFileSync(new URL('../public/terminal.html', import.meta.url), 'utf8');
const sw = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
const CACHE = '20260731-panel-drag-physics4';

test('shared floating-panel exposes AI-parity physics + hard drag', () => {
  assert.match(floating, /export async function ensureFloatingPanelPhysicsDrag/);
  assert.match(floating, /export function startFloatingPanelHardDrag/);
  assert.match(floating, /Motion\.drag\(panel/);
  assert.match(floating, /handle:\s*dragHandle/);
  assert.match(floating, /Only the top gray \.panel-drag-handle owns physical dragging/);
  assert.match(floating, /Three-dot traffic light is separately wired to precise hard drag/);
  assert.match(floating, /activationThreshold:\s*4/);
  assert.match(floating, /rubberband:\s*true/);
  assert.match(floating, /floatingPanelDragBounds/);
  assert.match(floating, /bakePanelTransform/);
  assert.match(floating, /Hold-and-drag on ⋯ = precise hard drag/);
  assert.match(floating, /window\.ZephyrFloatingPanelPhysics/);
  assert.match(floating, /zephyr-motion\/index\.js\?v=20260731-motion-tween3/);
  // Open keyframe fill must not stick — auto-clear after open animation.
  assert.match(floating, /_panelMotionClearTimer/);
  assert.match(floating, /classList\.remove\('panel-opening'/);
  assert.match(floating, /Drop any CSS transform owner before Motion writes/);
  // Post-release jump fix: visual bake after detaching Motion writers.
  assert.match(floating, /export function floatingPanelVisualLimits/);
  assert.match(floating, /export function visualPanelLayoutPosition/);
  assert.match(floating, /borderLeft/);
  assert.match(floating, /minTop:\s*0/);
  assert.match(floating, /CRITICAL ORDER/);
  assert.match(floating, /Motion\?\.release\?\.\(panel\)/);
  assert.match(floating, /panel-physics-baking/);
  assert.match(floating, /double-offset|double-paints|super jump/);
  // finish must detach writers BEFORE clearing transform / writing left.
  const finishIdx = floating.indexOf('function finishFloatingPanelPhysicsDrag');
  assert.ok(finishIdx >= 0);
  const finishBody = floating.slice(finishIdx, finishIdx + 1600);
  assert.match(finishBody, /visualPanelLayoutPosition\(panel\)/);
  assert.match(finishBody, /release\?\.\(panel\)/);
  assert.match(finishBody, /transform:\s*['"]none['"]/);
  const visAt = finishBody.indexOf('visualPanelLayoutPosition(panel)');
  const relAt = finishBody.indexOf('Motion?.release?.(panel)');
  const trnAt = finishBody.search(/transform:\s*['"]none['"]/);
  assert.ok(visAt >= 0 && relAt >= 0 && trnAt >= 0, 'finish has capture/release/transform');
  assert.ok(visAt < trnAt, 'capture painted rect before clearing transform');
  assert.ok(relAt < trnAt, 'release writers before clearing transform');
});

test('bring-to-front never runs CSS transform animation (AI parity)', () => {
  // Root bug: front-switching rewrote transform and killed Motion.drag.
  for (const [name, src] of [
    ['floating-panel', floating],
    ['terminal', terminal],
    ['telnet', telnet],
    ['novnc', novnc],
  ]) {
    assert.match(src, /function bringPanelToFront/, `${name} has bringPanelToFront`);
    assert.doesNotMatch(
      src,
      /classList\.add\(['"]front-switching['"]\)/,
      `${name} must not add front-switching`,
    );
    assert.match(src, /classList\.remove\(['"]front-switching['"]\)/, `${name} clears front-switching`);
  }
  // AI panel never used front-switching at all.
  assert.doesNotMatch(app, /front-switching/);
  assert.match(app, /function bringAiPanelToFront/);
});

test('CSS frees transform for Motion.drag while open/dragging', () => {
  assert.match(style, /\.file-manager\.open:not\(\.panel-opening\):not\(\.panel-closing\):not\(\.layout-animating\)/);
  assert.match(style, /\.rdp-floating-panel\.open:not\(\.panel-opening\):not\(\.panel-closing\):not\(\.layout-animating\)/);
  assert.match(style, /\.snippet-panel\.open:not\(\.panel-opening\):not\(\.panel-closing\):not\(\.layout-animating\)/);
  assert.match(style, /\.info-modal\.open:not\(\.panel-opening\):not\(\.panel-closing\):not\(\.layout-animating\)/);
  // Dragging must kill BOTH transition and animation (animation was the killer).
  // Prefer the multi-selector terminal block (not the later AI override).
  const fileDragIdx = style.indexOf('.file-manager.dragging,\n.file-manager.resizing,');
  const fileDragBlock = fileDragIdx >= 0 ? style.slice(fileDragIdx, fileDragIdx + 700) : '';
  const rdpDragIdx = style.indexOf('.rdp-floating-panel.dragging,');
  const rdpDragBlock = rdpDragIdx >= 0 ? style.slice(rdpDragIdx, rdpDragIdx + 280) : '';
  for (const [name, block] of [['file-manager', fileDragBlock], ['rdp', rdpDragBlock]]) {
    assert.match(block, /animation:\s*none\s*!important/, `${name} animation none`);
    assert.match(block, /transition:\s*none\s*!important/, `${name} transition none`);
  }
  // Resting open frees transform channel and kills ALL geometry transitions.
  assert.ok(style.includes('.file-manager.open:not(.panel-opening):not(.panel-closing):not(.layout-animating)'));
  assert.ok(style.includes('.rdp-floating-panel.open:not(.panel-opening):not(.panel-closing):not(.layout-animating)'));
  const freeIdx = style.indexOf('.file-manager.open:not(.panel-opening):not(.panel-closing):not(.layout-animating)');
  assert.ok(freeIdx >= 0);
  const freeBlock = style.slice(freeIdx, freeIdx + 700);
  assert.match(freeBlock, /transform:\s*none;/);
  assert.match(freeBlock, /transition:\s*none\s*!important/);
  const rdpFreeIdx = style.indexOf('.rdp-floating-panel.open:not(.panel-opening):not(.panel-closing):not(.layout-animating)');
  assert.ok(rdpFreeIdx >= 0);
  const rdpFree = style.slice(rdpFreeIdx, rdpFreeIdx + 400);
  assert.match(rdpFree, /transform:\s*none;/);
  assert.match(rdpFree, /transition:\s*none\s*!important/);
  assert.match(style, /\.panel-physics-baking/);
});

test('SSH terminal wires physics drag, not titlebar hard drag', () => {
  assert.match(terminal, /ensureFloatingPanelPhysicsDrag/);
  assert.match(terminal, /AI panel parity: gray \.panel-drag-handle/);
  assert.match(terminal, /Title\/content are NOT drag surfaces/);
  assert.doesNotMatch(terminal, /querySelectorAll\('\.panel-titlebar'\)/);
  assert.match(terminal, /consumeLayoutClickSuppression/);
  assert.match(terminal, new RegExp(`floating-panel\\.js\\?v=${CACHE}`));
});

test('Telnet terminal mirrors SSH physics wiring', () => {
  assert.match(telnet, /ensureFloatingPanelPhysicsDrag/);
  assert.match(telnet, /AI panel parity: gray \.panel-drag-handle/);
  assert.doesNotMatch(telnet, /querySelectorAll\('\.panel-titlebar'\)/);
  assert.match(telnet, new RegExp(`floating-panel\\.js\\?v=${CACHE}`));
});

test('RDP imports physics-capable floating-panel revision', () => {
  assert.match(rdp, new RegExp(`floating-panel\\.js\\?v=${CACHE}`));
  assert.match(rdp, /setupPanelInteractions/);
});

test('noVNC uses shared physics drag helpers', () => {
  assert.match(novnc, /ensureFloatingPanelPhysicsDrag/);
  assert.match(novnc, /AI panel parity: gray strip/);
  assert.doesNotMatch(novnc, /novnc-panel \.panel-titlebar/);
  assert.match(novnc, new RegExp(`floating-panel\\.js\\?v=${CACHE}`));
});

test('image/media preview use shared physics, not header hard drag', () => {
  assert.match(image, /setupPhysicsDrag/);
  assert.match(image, /ZephyrFloatingPanelPhysics/);
  assert.doesNotMatch(image, /setupTitlebarDrag/);
  assert.doesNotMatch(image, /setupDrag\(modal\)/);
  assert.match(media, /setupPhysicsDrag/);
  assert.match(media, /ZephyrFloatingPanelPhysics/);
  assert.doesNotMatch(media, /startPanelDrag/);
});

test('cache revision pins style + terminal + floating-panel physics4 + desktop pin assets', () => {
  const appVersion = singleAssetVersion(appHtml, 'app.js', 'app shell app.js');
  const styleVersion = singleAssetVersion(appHtml, 'style.css', 'app shell style.css');
  const terminalVersion = singleAssetVersion(terminalHtml, 'terminal.js', 'terminal page script');
  const pinVersion = singleAssetVersion(appHtml, 'panel-pin.css', 'app shell panel pin css');
  // CACHE_NAME is app-wide (see activity/session contracts); panel assets are
  // pinned by their individual ?v revisions instead of by the cache bucket name.
  assert.equal(cacheNameVersion(sw), appVersion);
  assertAssetVersion(sw, 'style.css', styleVersion, 'service worker style.css');
  assertAssetVersion(sw, 'terminal.js', terminalVersion, 'service worker terminal.js');
  assertAssetVersion(sw, 'floating-panel.js', CACHE, 'service worker floating-panel.js');
  assertAssetVersion(sw, 'panel-pin.js', pinVersion, 'service worker panel pin js');
  assertAssetVersion(sw, 'panel-pin.css', pinVersion, 'service worker panel pin css');
});
