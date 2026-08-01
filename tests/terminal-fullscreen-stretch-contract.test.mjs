import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appJs = readFileSync(path.join(root, 'public/app.js'), 'utf8');
const styleCss = readFileSync(path.join(root, 'public/style.css'), 'utf8');
const motionJs = readFileSync(path.join(root, 'public/vendor/zephyr-motion/motion.js'), 'utf8');
const presetsJs = readFileSync(path.join(root, 'public/vendor/zephyr-motion/presets.js'), 'utf8');
const appHtml = readFileSync(path.join(root, 'public/app.html'), 'utf8');
const swJs = readFileSync(path.join(root, 'public/sw.js'), 'utf8');
const APP_CACHE = '20260801-dock-notes-fullscreen1';
const STYLE_CACHE = '20260801-dock-notes-fullscreen1';
const MOTION_CACHE = '20260731-motion-mobile-fix2';

test('Motion.stretchExpand is Go-standard driven (no CSS transition)', () => {
    assert.match(motionJs, /async stretchExpand\(el, opts = \{\}\)/);
    assert.match(motionJs, /'stretchExpand'/);
    assert.match(presetsJs, /stretchExpandOpen:\s*7/);
    assert.match(presetsJs, /stretchExpandClose:\s*8/);
    assert.match(presetsJs, /\[MOTION_STANDARDS\.stretchExpandOpen\]:\s*\{\s*response:\s*0\.48,\s*damping:\s*1\.00\s*\}/);
    assert.match(presetsJs, /\[MOTION_STANDARDS\.stretchExpandClose\]:\s*\{\s*response:\s*0\.48,\s*damping:\s*1\.00\s*\}/);
    // Driven by Motion.to + Go standard id — not CSS transition/animation.
    assert.match(motionJs, /MOTION_STANDARDS\.stretchExpandOpen/);
    assert.match(motionJs, /MOTION_STANDARDS\.stretchExpandClose/);
    assert.match(motionJs, /await this\.to\(el, \{\s*h: endH, radius: radiusTo\s*\}, \{/);
    assert.match(motionJs, /standard,/);
    // Explicitly kill host CSS transitions — never animate via CSS.
    assert.match(motionJs, /el\.style\.transition\s*=\s*'none'/);
    assert.match(motionJs, /setProperty\('height', `\$\{startH\}px`, 'important'\)/);
    assert.match(motionJs, /engine\.bind\(heightSlot\.id, v => \{/);
    assert.match(motionJs, /setProperty\('height', `\$\{v\}px`, 'important'\)/);
    assert.doesNotMatch(motionJs, /el\.style\.transition\s*=\s*['"`][^'"`]*(height|transform|border)/);
    // Bottom-anchored pin; full-bleed X (no horizontal left/width spring)
    assert.match(motionJs, /el\.style\.bottom\s*=/);
    assert.match(motionJs, /el\.style\.top\s*=\s*'auto'/);
    assert.match(motionJs, /fullBleedX/);
    assert.match(motionJs, /width = '100vw'/);
    assert.match(appJs, /fullBleedX:\s*true/);
    assert.doesNotMatch(appJs, /left: origin\?\.left/);
    // Go source of truth
    const standardsGo = readFileSync(path.join(root, 'motion-wasm/motion/standards.go'), 'utf8');
    assert.match(standardsGo, /StandardStretchExpandOpen/);
    assert.match(standardsGo, /StandardStretchExpandClose/);
    assert.match(standardsGo, /case StandardStretchExpandOpen:[\s\S]*Response:\s*0\.48,\s*Damping:\s*1\.00/);
    assert.match(standardsGo, /case StandardStretchExpandClose:[\s\S]*Response:\s*0\.48,\s*Damping:\s*1\.00/);
});

test('mobile fullscreen uses stretchExpand and deletes spinner loader path', () => {
    assert.match(appJs, /function animateMobileTerminalFullscreen/);
    assert.match(appJs, /Motion\.stretchExpand\(workspace/);
    assert.match(appJs, /await animateMobileTerminalFullscreen\(workspace, \{\s*open: entering\s*\}\)/);
    assert.match(appJs, /animateMobileTerminalFullscreen\(workspace, \{\s*open: false\s*\}/);
    // Old spinner path must be gone.
    assert.doesNotMatch(appJs, /showFullscreenLoading|hideFullscreenLoading|ensureFullscreenLoader|terminal-fullscreen-loader|fullscreen-loading/);
    assert.doesNotMatch(styleCss, /terminal-fullscreen-loader|fullscreen-loading|fullscreen-transitioning/);
});

test('mobile fullscreen exit reveals nav through Motion and serializes close/minimize', () => {
    assert.match(appJs, /let terminalFullscreenExitPromise = null/);
    assert.match(appJs, /document\.body\.classList\.add\('terminal-fullscreen-exiting'\)/);
    assert.match(appJs, /Motion\.set\(nav, \{ y: -Math\.max\(1, nav\.getBoundingClientRect\(\)\.height\), opacity: 0 \}\)/);
    assert.match(appJs, /Motion\.to\(nav, \{ y: 0, opacity: 1 \}, \{ preset: \{ response: 0\.30, damping: 1 \} \}\)/);
    assert.match(appJs, /await Promise\.all\(\[[\s\S]*exitTerminalFullscreen\(\{ renderAfter: false \}\),[\s\S]*closeMotion/);
    assert.match(appJs, /const exitJob = exitTerminalFullscreen\(\{ renderAfter: false \}\);[\s\S]*minimizeTerminalSession\(tabId\);[\s\S]*exitJob\.finally/);
    assert.match(styleCss, /terminal-custom-fullscreen-open:not\(\.terminal-fullscreen-exiting\) \.main-nav/);
    assert.match(styleCss, /terminal-custom-fullscreen-open\.terminal-fullscreen-exiting \.main-nav/);
});

test('cache revision covers app + motion module', () => {
    assert.match(appHtml, new RegExp(`app\\.js\\?v=${APP_CACHE}`));
    assert.match(appHtml, new RegExp(`style\\.css\\?v=${STYLE_CACHE}`));
    assert.match(appHtml, new RegExp(`zephyr-motion/index\\.js\\?v=${MOTION_CACHE}`));
    assert.match(swJs, new RegExp(`app\\.js\\?v=${APP_CACHE}`));
    assert.match(appJs, new RegExp(`zephyr-motion/index\\.js\\?v=${MOTION_CACHE}`));
});
