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
const CACHE = '20260731-fullscreen-stretch1';

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

test('cache revision covers app + motion module', () => {
    assert.match(appHtml, new RegExp(`app\\.js\\?v=${CACHE}`));
    assert.match(appHtml, new RegExp(`style\\.css\\?v=${CACHE}`));
    assert.match(appHtml, new RegExp(`zephyr-motion/index\\.js\\?v=${CACHE}`));
    assert.match(swJs, new RegExp(`app\\.js\\?v=${CACHE}`));
    assert.match(appJs, new RegExp(`zephyr-motion/index\\.js\\?v=${CACHE}`));
});
