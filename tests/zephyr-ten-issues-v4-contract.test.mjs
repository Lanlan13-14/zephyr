import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Motion } from '../public/vendor/zephyr-motion/motion.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const appJs = read('public/app.js');
const specCss = read('public/zephyr-terminal-spec.css');
const styleCss = read('public/style.css');
const motionJs = read('public/vendor/zephyr-motion/motion.js');
const floatingJs = read('public/floating-panel.js');
const sftpProJs = read('public/vendor/zephyr-pro/terminal-sftp-pro.js');
const terminalHtml = read('public/terminal.html');
const terminalJs = read('public/terminal.js');

test('Issue 1 & 2: Original Zephyr wind brand logo is preserved and #aiFloatingBtn respects .force-hidden', () => {
  assert.doesNotMatch(appJs, /brandEl\.innerHTML\s*=\s*['"`]<svg[^>]*polyline points="4 17 10 11 4 5"/);
  assert.match(specCss, /\.main-nav\s+\.brand\s+\.zephyr-brand-svg/);
  assert.doesNotMatch(appJs, /aiBtn\.classList\.remove\(['"]force-hidden['"]\)/);
  assert.match(specCss, /\.main-nav\s+\.nav-actions\s+#aiFloatingBtn\.force-hidden[\s\S]*?display:\s*none\s*!important/);
});

test('WASM Motion Engine exports splitDockSlide, topbarShelfCollapse, topbarViewShelf, panelOpenWasm, panelCloseWasm, panelDockMorph, terminalWindowFullscreenMorph', () => {
  assert.equal(typeof Motion.splitDockSlide, 'function');
  assert.equal(typeof Motion.topbarShelfCollapse, 'function');
  assert.equal(typeof Motion.topbarViewShelf, 'function');
  assert.equal(typeof Motion.panelOpenWasm, 'function');
  assert.equal(typeof Motion.panelCloseWasm, 'function');
  assert.equal(typeof Motion.panelDockMorph, 'function');
  assert.equal(typeof Motion.terminalWindowFullscreenMorph, 'function');
  assert.equal(typeof Motion.panelResizeRing, 'function');
  assert.equal(typeof Motion.panelMorePopover, 'function');
});

test('Tier-1 three-dots menu (openUnifiedMorePopover) contains only layout actions and NO close button', () => {
  const fnStart = sftpProJs.indexOf('function openUnifiedMorePopover');
  const fnEnd = sftpProJs.indexOf('function bindOuterRingResizeHandles');
  const popoverCode = sftpProJs.slice(fnStart, fnEnd);
  assert.match(popoverCode, /data-more-action="fullscreen"/);
  assert.match(popoverCode, /data-more-action="left"/);
  assert.match(popoverCode, /data-more-action="right"/);
  assert.match(popoverCode, /data-more-action="float"/);
  assert.doesNotMatch(popoverCode, /data-more-action="close"/);
});

test('All Tier-2 secondary floating windows have single [Fullscreen □] and [Close ×] buttons with deduplication on clones', () => {
  assert.match(sftpProJs, /function toggleSecondaryPanelFullscreen\(panel\)/);
  assert.match(sftpProJs, /const allMaxBtns = Array\.from\(rightCluster\.querySelectorAll\('\.panel-max-btn'\)\);/);
  assert.match(sftpProJs, /const allCloseBtns = Array\.from\(rightCluster\.querySelectorAll\('\.panel-close-btn, \.fm-editor-close-icon, \[data-editor-action="close"\]'\)\);/);
  assert.match(specCss, /\.panel-fullscreen:not\(\.z-panel-morphing\)/);
});

test('Physics drag (Motion.drag & floatingPanelDragBounds) uses position:fixed style.left/top and critically-damped non-overshoot velocity cap', () => {
  assert.match(floatingJs, /const styleLeft = parseFloat\(panel\?\.style\?\.left\);/);
  assert.match(motionJs, /const capVel = \(v, rem\) =>/);
  assert.match(specCss, /html body \.z-unified-secondary-panel:not\(\.z-panel-morphing\):not\(\.panel-fullscreen\)\s*\{\s*position:\s*fixed\s*!important;/);
});

test('Card flip target rect and surface placement land 1:1 on final terminal window box without inset="auto" overwrite', () => {
  assert.match(appJs, /surface\.style\.inset = 'auto';\s*surface\.style\.right = 'auto';\s*surface\.style\.bottom = 'auto';\s*surface\.style\.left =/);
  assert.match(appJs, /navBottom = Math\.max\(83, navBottom\);/);
});

test('Terminal window top-right hides Fullscreen button when only 1 terminal is visible, shows it when 2 are visible, and animates fullscreen via WASM', () => {
  assert.match(appJs, /const showFullscreenBtn = visibleCount >= 2 \|\| isFull \|\| isCompactTerminalWorkspace\(\);/);
  assert.match(appJs, /Motion\.terminalWindowFullscreenMorph\(win,\s*applyFullscreenLayout/);
});

test('Topbar view-switch and collapse/expand use WASM --z-shelf-ext and --topbar-collapse-offset without vertical bounce', () => {
  assert.match(appJs, /window\.Motion\.topbarViewShelf\(navEl,\s*enteringTerminal/);
  assert.match(motionJs, /'--topbar-collapse-offset':\s*targetOffset/);
  assert.match(specCss, /height:\s*calc\(56px \+ var\(--z-shelf-ext, 0px\) \+ var\(--topbar-collapse-offset, 0px\)\)\s*!important;/);
  assert.match(specCss, /body\.app-body\.terminal-mode\.terminal-topbar-collapsed\s+\.main-nav\s*\{\s*overflow:\s*hidden\s*!important;/);
});
