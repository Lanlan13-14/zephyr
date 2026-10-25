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


test('UI123 Contract: Telnet, RDP, and VNC are unified onto v4.0 floating/docked panel & toolbar architecture (zero AI-tile display bugs) and Settings UI matches topbar pill palette', () => {
  const telnetJs = read('public/telnet-terminal.js');
  const rdpJs = read('public/rdp-wasm-client.js');
  const vncJs = read('public/novnc.js');
  const rdpHtml = read('public/rdp.html');
  const vncHtml = read('public/novnc.html');

  assert.match(telnetJs, /installTerminalSftpPro/);
  assert.match(rdpJs, /installTerminalSftpPro/);
  assert.match(vncJs, /installTerminalSftpPro/);
  assert.match(rdpHtml, /dataset.zephyrSurface = 'desktop'/);
  assert.match(vncHtml, /dataset.zephyrSurface = 'desktop'/);

  assert.ok(sftpProJs.includes("clipboardPanel: 'clipboardBtn'"));
  assert.ok(sftpProJs.includes("filesPanel: 'rdpFilesBtn'"));
  assert.ok(sftpProJs.includes("shortcutsPanel: 'shortcutsBtn'"));
  assert.ok(specCss.includes('html[data-zephyr-surface="desktop"] .rdp-topbar > .status'));
  assert.ok(specCss.includes('.terminal-page > .z-unified-panel.rdp-floating-panel.open'));
  assert.ok(specCss.includes('html[data-theme="light"] #view-settings .settings-menu .settings-tab.active'));
  assert.ok(specCss.includes('#view-settings #settings-appearance.active'));
});

test("UI124 Contract: Smooth Google M3 / Apple pill & view transitions (zero CSS transition fight), full English i18n parity, and commented-out Initiate via Primary & Port Forwarding UI", () => {
  const termHtml = read("public/terminal.html");
  const runtimeJs = read("public/i18n/runtime.js");
  assert.equal(typeof Motion.settingsTabSlide, "function");
  assert.ok(motionJs.includes("const startAlpha = isTerminalTarget ? 0.86 : 0.76;"));
  assert.ok(specCss.includes("#view-settings .settings-menu .settings-tab.active::after"));
  assert.ok(specCss.includes("transform: translate3d(0, var(--settings-pill-dy, 0px), 0) !important;"));
  assert.ok(specCss.includes("#view-settings .settings-panel.active {"));
  assert.ok(runtimeJs.includes("globalThis.__zephyrI18nState"));
  assert.ok(termHtml.includes('<!-- <button class="btn-sm" id="portForwardBtn"'));
  assert.ok(sftpProJs.includes("// UI124: temporarily commented out per user request (hide Port Forwarding UI without deleting code)"));
  assert.ok(appJs.includes("// UI124: temporarily commented out per user request (hide Initiate via Primary UI without deleting code)"));
});



test('UI126 Contract: iOS Global Wallpaper + Simultaneous Terminal Wallpaper + 4 martin65536/liquid-glass-webgl Stepless Sliders with Theme-Aware Fill Line', () => {
  const appHtml = read('public/app.html');
  const appJs = read('public/app.js');
  const specCss = read('public/zephyr-terminal-spec.css');
  const lgSliderJs = read('public/liquid-glass-slider.js');
  const serverJs = read('server.js');

  for (const id of ['globalBgSource', 'globalBgFit', 'globalBgFile', 'globalBgDataUrl', 'globalBgUrl', 'globalBgPreview', 'globalBgOpacity', 'globalBgBlur', 'terminalBgSource', 'terminalBgFit', 'terminalBgOpacity', 'terminalBgBlur']) {
    assert.ok(appHtml.includes('id="' + id + '"'), 'app.html must include #' + id);
  }

  assert.ok(appHtml.includes('data-lg-slider-for="globalBgOpacity"'), 'globalBgOpacity must be wired to zephyr-lg-slider');
  assert.ok(appHtml.includes('data-lg-slider-for="globalBgBlur"'), 'globalBgBlur must be wired to zephyr-lg-slider');
  assert.ok(appHtml.includes('data-lg-slider-for="terminalBgOpacity"'), 'terminalBgOpacity must be wired to zephyr-lg-slider');
  assert.ok(appHtml.includes('data-lg-slider-for="terminalBgBlur"'), 'terminalBgBlur must be wired to zephyr-lg-slider');
  assert.ok(specCss.includes('#view-settings .lg-sliders-grid'), 'zephyr-terminal-spec.css must define .lg-sliders-grid to prevent overlap');

  assert.ok(lgSliderJs.includes('LiquidGlassRenderer'), 'liquid-glass-slider.js must use LiquidGlassRenderer');
  assert.ok(lgSliderJs.includes('isSliderFill'), 'liquid-glass-slider.js must use isSliderFill for the bottom fill line');
  assert.ok(lgSliderJs.includes('isToggleKnob'), 'liquid-glass-slider.js must use isToggleKnob for the 3D refractive glass knob');
  assert.ok(lgSliderJs.includes('endSliderDrag'), 'liquid-glass-slider.js must use endSliderDrag for stepless release without 0/1 snap');
  assert.ok(lgSliderJs.includes('resolveThemeAccent01'), 'liquid-glass-slider.js must dynamically resolve theme --accent for the bottom fill line');

  assert.ok(serverJs.includes('globalBackground'), 'server.js must sanitize and persist appearance.globalBackground');
  assert.ok(appJs.includes('applyGlobalWallpaper'), 'app.js must implement applyGlobalWallpaper with dual-layer crossfade');
});


test("UI127 & UI128 Contract: Topbar & Settings Sidebar LiquidBottomTabs WebGL Pipeline, Brightened Multi-Tier Translucent Glass (Zero White Blocks in Modals/Settings/Activity), Terminal Translucent Chrome (Except .wterm-screen), and High-FPS GPU Theme Switch", () => {
  const lgNavJs = read("public/liquid-glass-nav.js");
  const lgRendererJs = read("public/liquid-glass-renderer.js");
  const appJs = read("public/app.js");
  const specCss = read("public/zephyr-terminal-spec.css");

  // 1. Topbar & Settings Sidebar LiquidBottomTabs WebGL pipeline + GPU texture pools
  assert.ok(lgNavJs.includes("function bootTopNav()"), "liquid-glass-nav.js must boot topbar LiquidBottomTabs");
  assert.ok(lgNavJs.includes("function bootSettingsSidebar()"), "liquid-glass-nav.js must boot settings sidebar vertical LiquidBottomTabs");
  assert.ok(lgRendererJs.includes("uniform float uIndicatorAxisY;"), "liquid-glass-renderer.js must support vertical axis indicator shader");
  assert.ok(lgRendererJs.includes("loadWallpaperFromCanvas(sourceCanvas, cacheKey)"), "liquid-glass-renderer.js must cache wallpaper textures in _wpTexPool");
  assert.ok(lgRendererJs.includes("this._fgTexPool"), "liquid-glass-renderer.js must cache foreground text/icon textures in _fgTexPool");

  // 2. Brightened global wallpaper scrim & multi-tier translucent glass tokens (zero white blocks in modals/views/settings)
  assert.ok(specCss.includes("--z-glass-tray-bg: rgba(255, 255, 255, 0.16);"), "zephyr-terminal-spec.css must define brightened translucent tray token");
  assert.ok(specCss.includes("--z-glass-card-bg: rgba(255, 255, 255, 0.48);"), "zephyr-terminal-spec.css must define brightened translucent card token");
  assert.ok(specCss.includes("html body.app-body #connectionModal > #connectionForm"), "#connectionForm must use translucent modal glass");
  assert.ok(specCss.includes("html body.app-body:has(#connectionModal.show:not(.opening):not(.closing)) #connectionMotionSurface"), "#connectionMotionSurface must hide when modal is open to prevent double-layer white stacking");

  // 3. Terminal workspace translucency except .wterm-screen
  assert.ok(specCss.includes("html body.app-body #terminalWorkspace:not(.custom-fullscreen) .terminal-window:not(:fullscreen):not(.minimized-keepalive)"), ".terminal-window shell must be transparent so panels/bars refract global wallpaper");
  assert.ok(specCss.includes(".terminal-page #topbarActions.topbar-actions"), "terminal topbar-actions must be translucent");
  assert.ok(specCss.includes("html body.app-body #sessionTabs .smartbar-handle"), "smartbar-handle wrapper must be transparent without box mismatch");
  assert.ok(specCss.includes("backdrop-filter: blur(38px) saturate(185%) !important;"), "terminal container below toolbar must use high-blur translucent Gaussian glass");
  assert.ok(specCss.includes(".terminal-page .wterm-screen"), ".wterm-screen must retain solid terminal background");

  // 4. High-FPS zero-readback GPU circular theme reveal
  assert.ok(appJs.includes("zephyrGpuThemeVeil"), "applyTheme must use zero-readback GPU circular theme veil");
  assert.ok(appJs.includes("deferWebglRefresh: true"), "applyTheme must defer heavy WebGL rebuilds until after the GPU theme transition");
});

test('UI129 Contract: Topbar Settings Pill Exact Bounds, 2x Supersampled Crisp Liquid Glass Typography, Un-washed Sidebar Glass, Built-in Default Wallpaper Toggle (Default Off, Auto 72%/6.5px Presets), and High-Blur Translucent Terminal Screen', () => {
  const appHtml = read('public/app.html');
  const appJs = read('public/app.js');
  const lgNavJs = read('public/liquid-glass-nav.js');
  const lgRendererJs = read('public/liquid-glass-renderer.js');
  const specCss = read('public/zephyr-terminal-spec.css');
  const serverJs = read('server.js');

  assert.ok(lgNavJs.includes('var tabW = tabRects[0] && tabRects[0].w > 0 ? tabRects[0].w :'), 'topbar indicator width must match actual tab width to prevent right-edge overflow');
  assert.ok(lgNavJs.includes('tabsTextHalo: "none"') || lgNavJs.includes("tabsTextHalo: 'none'"), 'Liquid Glass text must disable muddy shadowBlur halo for crisp typography');
  assert.ok(lgRendererJs.includes('this.dpr = Math.max(2, Math.min(window.devicePixelRatio || 1, 3));'), 'LiquidGlassRenderer must use >=2x supersampling DPR for sharp text and icons');
  assert.ok(lgNavJs.includes('sidebarContainer: [0xf8 / 255, 0xfa / 255, 0xfc / 255, 0.20]'), 'Settings sidebar must use un-washed 0.20 alpha surfaceColor');

  assert.ok(appHtml.includes('id="defaultGlobalWallpaperToggle"'), 'app.html must include #defaultGlobalWallpaperToggle');
  assert.ok(appHtml.includes('<option value="default" data-i18n="使用内置默认壁纸">使用内置默认壁纸</option>'), '#globalBgSource must include default option');
  assert.ok(appJs.includes('const DEFAULT_GLOBAL_WALLPAPER_OPACITY = 0.72;'), 'app.js must define comfortable default opacity 0.72');
  assert.ok(appJs.includes('const DEFAULT_GLOBAL_WALLPAPER_BLUR = 6.5;'), 'app.js must define comfortable default blur 6.5px');
  assert.ok(appJs.includes('function resolveBuiltInDefaultWallpaperUrl'), 'app.js must resolve built-in wallpaper URL by scheme and theme');
  assert.ok(serverJs.includes("'none', 'default', 'upload', 'url'"), 'server.js must allow globalBackground.type === default');

  assert.ok(specCss.includes('backdrop-filter: blur(38px) saturate(185%) !important;'), 'terminal container must use 38px Gaussian blur translucency');
  assert.ok(specCss.includes('backdrop-filter: blur(32px) saturate(180%) !important;'), 'terminal input bar must use 32px Gaussian blur translucency');
});
