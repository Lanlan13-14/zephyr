import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appJs = readFileSync(path.join(root, 'public/app.js'), 'utf8');
const specCss = readFileSync(path.join(root, 'public/zephyr-terminal-spec.css'), 'utf8');
const motionJs = readFileSync(path.join(root, 'public/vendor/zephyr-motion/motion.js'), 'utf8');

test('1. Smartbar circles all currently on-screen terminals (.smartbar-onscreen-ring + .on-screen + .smartbar-slot-badge)', () => {
  assert.match(appJs, /function syncSmartbarOnScreenRing\(/);
  assert.match(appJs, /smartbar-onscreen-ring/);
  assert.match(appJs, /smartbar-slot-badge/);
  assert.match(appJs, /isOnScreen\s*\?\s*'on-screen'\s*:\s*''/);
  assert.match(specCss, /\.smartbar-dock\s*>\s*\.smartbar-onscreen-ring/);
  assert.match(specCss, /\.smartbar-session\.on-screen\s+\.smartbar-session-icon/);
  assert.match(specCss, /\.smartbar-session-icon\s+\.smartbar-slot-badge/);
});

test('2. Smartbar expand and collapse animations are driven by WASM Motion.smartbarExpand with persistent DOM', () => {
  assert.match(motionJs, /async smartbarExpand\(smartbarEl,\s*open/);
  assert.match(motionJs, /'--sb-panel-y'/);
  assert.match(motionJs, /'--sb-panel-sx'/);
  assert.match(motionJs, /'--sb-panel-sy'/);
  assert.match(motionJs, /'--sb-panel-alpha'/);
  assert.match(appJs, /window\.Motion\.smartbarExpand\(smartbarRoot,\s*true\)/);
  assert.match(appJs, /window\.Motion\.smartbarExpand\(smartbarRoot,\s*false\)/);
  assert.match(appJs, /dockEl\.dataset\.dockSignature\s*!==\s*dockSignature/);
});

test('3. Smartbar drag-to-replace preserves exact slot order, auto-dims panel outside dock, and plays WASM replacement animation', () => {
  assert.match(motionJs, /async terminalWindowReplaceMorph\(newWin,\s*fromRect,\s*toRect/);
  assert.match(motionJs, /terminal-replace-outgoing-ghost/);
  assert.match(appJs, /window\.Motion\.terminalWindowReplaceMorph\(/);
  assert.match(appJs, /\[openOrderStack\[iTargetOrder\],\s*openOrderStack\[iDraggedOrder\]\]\s*=\s*\[openOrderStack\[iDraggedOrder\],\s*openOrderStack\[iTargetOrder\]\]/);
  assert.match(appJs, /smartbar-dragging-outside/);
  assert.match(appJs, /updateWindowDropTargetBadges\(/);
  assert.match(appJs, /findSmartbarTabAtPoint\(/);
  assert.match(specCss, /\.terminal-replace-outgoing-ghost/);
  assert.match(specCss, /\.smartbar-window-drop-badge-pill/);
});

test('4. Drag-to-close target (.smartbar-trash-target) uses Liquid Glass danger capsule with SVG trash icon and dynamic label', () => {
  assert.match(appJs, /smartbar-trash-icon/);
  assert.match(appJs, /smartbar-trash-label/);
  assert.match(appJs, /松手立即关闭会话/);
  assert.match(appJs, /拖到此处关闭会话/);
  assert.match(specCss, /\.smartbar-trash-target\s*\{[\s\S]*?border-radius:\s*999px\s*!important/);
  assert.match(specCss, /\.smartbar-trash-target\s+\.smartbar-trash-label/);
});
