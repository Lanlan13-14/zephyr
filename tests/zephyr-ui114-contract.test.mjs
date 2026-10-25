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
const motionJs = read('public/vendor/zephyr-motion/motion.js');
const sftpProJs = read('public/vendor/zephyr-pro/terminal-sftp-pro.js');
const terminalJs = read('public/terminal.js');
const floatingPanelJs = read('public/floating-panel.js');

test('1. Smartbar handle (.smartbar-handle) is locked in 0ms same-frame sync with topbar and collapse arrows via shared WASM vars', () => {
  assert.match(motionJs, /topbarShelfCollapse\(mainNav,\s*collapsed[\s\S]*?const sharedVars\s*=\s*\{[\s\S]*?'--smartbar-top':\s*targetH[\s\S]*?'--topbar-collapse-offset':\s*targetOffset/);
  assert.match(motionJs, /async topbarViewShelf\(mainNav,\s*enteringTerminal[\s\S]*?const targets\s*=\s*\[mainNav,\s*root,\s*smartbar\]\.filter\(Boolean\)/);
  assert.match(appJs, /document\.documentElement\.dataset\.topbarCollapseInFlight\s*===\s*'1'\s*\|\|\s*document\.documentElement\.dataset\.shelfTransitioning\s*===\s*'1'/);
  assert.match(specCss, /html body\.app-body #sessionTabs\.terminal-smartbar[\s\S]*?top:\s*calc\(56px \+ var\(--z-shelf-ext, 0px\) \+ var\(--topbar-collapse-offset, 0px\) - 19px\)\s*!important/);
  assert.match(specCss, /html body\.app-body\.terminal-mode #sessionTabs\.terminal-smartbar \.smartbar-handle[\s\S]*?transition:\s*none\s*!important/);
});

test('2. Smartbar "+" Picker and Back/Close transitions use true shared-bounds bidirectional morph AND close when operating inside workspace below topbar', () => {
  assert.equal(typeof Motion.smartbarPickerMorph, 'function');
  assert.match(appJs, /function openSmartbarPickerFromDock\(\)/);
  assert.match(appJs, /function closeSmartbarPicker\(\{\s*backToDock\s*=\s*false\s*\}\s*=\s*\{\}\)/);
  assert.match(appJs, /data-smartbar-picker-back/);
  assert.match(appJs, /smartbarRoot\.dataset\.closingFromPicker\s*=\s*'1'/);
  assert.match(appJs, /function noteTerminalWorkspaceActivity\(\)\s*\{[\s\S]*?setTerminalSmartbarOpen\(false\)/);
  assert.match(motionJs, /smartbarEl\?\.classList\?\.add\('picker-morphing'\)/);
  assert.match(specCss, /html body\.app-body\.terminal-mode #sessionTabs\.picker-morphing \.smartbar-panel[\s\S]*?opacity:\s*var\(--sb-panel-alpha,\s*0\)\s*!important/);
  assert.match(specCss, /html body\.app-body\.terminal-mode #sessionTabs\[data-closing-from-picker="1"\] \.smartbar-panel[\s\S]*?opacity:\s*0\s*!important/);
});

test('3. Multi-window dock rule & Equal Left/Right tile widths: operated terminal arranges tiles Left & Right with 100% equal widths and min-width: 0', () => {
  assert.match(appJs, /const isActiveWin = win\.classList\.contains\('active'\) \|\| \(!isTwo && !isThree && !isFour\);/);
  assert.match(appJs, /if \(isActiveWin\) \{[\s\S]*?slotSide = isThree && win\.classList\.contains\('slot-2'\) \? 'middle-active' : 'single';/);
  assert.match(sftpProJs, /function applyPinnedPanelsGridAssignment\(page\)/);
  assert.match(sftpProJs, /function reconcilePinnedPanelsForSlotSide\(page/);
  assert.match(sftpProJs, /if \(!needsChange\) return;/);
  assert.match(sftpProJs, /hostWin\.style\.setProperty\('--z-dual-dock-w'/);
  assert.doesNotMatch(specCss, /\.docked-slot-top/);
  assert.doesNotMatch(specCss, /\.docked-slot-bottom/);
  assert.match(specCss, /\.terminal-page > \.docked-left[\s\S]*?min-width:\s*0\s*!important/);
  assert.match(specCss, /\.terminal-page\.has-docked-left\.has-docked-right:not\(\.z-dock-cols-morphing\)[\s\S]*?grid-template-columns:\s*var\(--z-dual-dock-w\)\s+minmax\(0,\s*1fr\)\s+var\(--z-dual-dock-w\)\s*!important/);
});

test('4. Floating panels never drift (+1px clampPanel bug and status message loop eliminated) and morph with synchronous frame-0 vars & animated dock column widths', () => {
  assert.match(appJs, /if \(e\.data\.type && e\.data\.type !== 'status'\) return;/);
  assert.match(terminalJs, /if \(Math\.abs\(left - curL\) < 1 && Math\.abs\(top - curT\) < 1\) return;/);
  assert.match(floatingPanelJs, /if \(Math\.abs\(left - curL\) < 1 && Math\.abs\(top - curT\) < 1\) return;/);
  assert.match(motionJs, /dt\.classList\.add\('z-dock-cols-morphing'\)/);
  assert.match(sftpProJs, /function rememberPreDockRect\(panel\)/);
  assert.match(sftpProJs, /function restorePreDockOrDefaultRect\(panel\)/);
  assert.match(sftpProJs, /function closeUnifiedPanel\(panel/);
});

test('5. Desktop/Web AI Floating & Docked Panel (#aiAgentPanel) uses Unified Tier-1 Chrome, WASM Open/Close/Dock Morphs, and Host Workspace Reflow', () => {
  assert.match(appJs, /function toggleAiPanelDockState\(panel,\s*explicitSide\)/);
  assert.match(appJs, /function openAiUnifiedMorePopover\(panel,\s*moreBtn\)/);
  assert.match(appJs, /function syncHostAiDockState\(panel\)/);
  assert.match(appJs, /window\.__zephyrCloseDockedAiPanel\s*=\s*function closeDockedAiPanel/);
  assert.match(motionJs, /if \(opts\.mode === 'wasm' \|\| \(panel\.classList\?\.contains\?\.\('z-unified-panel'\) && opts\.mode !== 'flip'\)\) \{\s*return this\.panelOpenWasm\(panel, trigger, opts\);/);
  assert.match(motionJs, /if \(opts\.mode === 'wasm' \|\| \(panel\.classList\?\.contains\?\.\('z-unified-panel'\) && opts\.mode !== 'flip'\)\) \{\s*return this\.panelCloseWasm\(panel, trigger, opts\);/);
  assert.match(specCss, /#aiAgentPanel\.ai-agent-panel\.pinned\.docked-left:not\(\.z-panel-morphing\)/);
  assert.match(specCss, /#aiAgentPanel\.ai-agent-panel\.pinned\.docked-right:not\(\.z-panel-morphing\)/);
  assert.match(specCss, /body\.app-body\.terminal-mode\.ai-docked-right \.app-main/);
});

test('UI118 Contract: AI docked card uses 14px radius + concentric 12px composer, terminal has no double bottom radius, animations exclude AI dock width, topbar has frosted glass, and Dashboard/Notes use full width', () => {
  assert.match(appJs, /function getTerminalWorkspaceStageMetrics\(\)/);
  assert.match(motionJs, /wsWidthOverride = 0/);
  assert.match(specCss, /#aiAgentPanel\.ai-agent-panel\.pinned\.docked-right:not\(\.z-panel-morphing\)[\s\S]*?border-radius:\s*14px\s*!important/);
  assert.match(specCss, /#aiAgentPanel\.pinned\s+\.ai-composer-box\.ai-input-area[\s\S]*?border-radius:\s*12px\s*!important/);
  assert.match(specCss, /#terminalWorkspace:not\(\.custom-fullscreen\)[\s\S]*?border:\s*0\s*!important;\s*border-radius:\s*0\s*!important/);
  assert.match(specCss, /\.terminal-page\s+\.terminal-container[\s\S]*?margin:\s*0\s*!important;\s*border:\s*0\s*!important;\s*border-radius:\s*0\s*!important/);
  assert.match(specCss, /html\[data-theme="light"\]\s+\.main-nav[\s\S]*?backdrop-filter:\s*blur\(24px\)\s+saturate\(180%\)\s*!important/);
  assert.match(specCss, /--z-main-max-width:\s*100%/);
});


test('UI120 & UI121 Contract: Zero-jump page transitions, toolbar horizontal scroll (wheel/drag/arrows), full-width behind-AI terminal & bottom alignment, and unified macOS traffic lights vs Windows controls', () => {
  assert.ok(motionJs.includes('async navTabSlide(navTabsEl, fromRect, toRect, { preset = { response: 0.22, damping: 1.0 } } = {})'));
  assert.ok(motionJs.includes("async viewSwitch(fromViewEl, toViewEl, { dir = 1, axis = 'x', preset = { response: 0.18, damping: 1.0 } } = {})"));
  assert.ok(motionJs.includes("const startX = axis === 'x' ? Math.round((dir >= 0 ? 1 : -1) * 6) : 0;"));
  assert.ok(motionJs.includes('const startScale = 1;'));
  assert.ok(appJs.includes('function resolveEffectiveShortcutPlatform()'));
  assert.ok(appJs.includes('mac-traffic-lights'));
  assert.ok(sftpProJs.includes('topbarActions.dataset.hScrollEnhanced'));
  assert.ok(sftpProJs.includes('pane-slot-inactive'));
  assert.ok(specCss.includes('margin-bottom: calc(-1 * var(--z-shelf-ext, 0px)) !important;'));
  assert.ok(specCss.includes('.terminal-window-titlebar .z1-tb-actions.mac-traffic-lights'));
  assert.ok(specCss.includes('.terminal-page.pane-slot-inactive:not(.z-dock-cols-morphing) > .z-unified-panel.pinned'));
  assert.ok(specCss.includes('--z-pane-w: calc(var(--z-stage-w) * 0.8 - 23px);'));
  assert.ok(specCss.includes('.terminal-page.pane-slot-inactive:not(.z-dock-cols-morphing) > .terminal-topbar'));
  assert.ok(specCss.includes('calc(100% - 16px) 100%,'));
  assert.ok(sftpProJs.includes('const dockedRight = !isInactiveSlot && rawDockedRight;'));
});
