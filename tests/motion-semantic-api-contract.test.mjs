import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const motionJs = readFileSync(path.join(root, 'public/vendor/zephyr-motion/motion.js'), 'utf8');
const feel = readFileSync(path.join(root, 'tests/motion-feel.html'), 'utf8');
const appJs = readFileSync(path.join(root, 'public/app.js'), 'utf8');
const styleCss = readFileSync(path.join(root, 'public/style.css'), 'utf8');

test('signature APIs: island expand/collapse + iOS app open/close', () => {
  for (const name of [
    'islandDots', 'islandExpand', 'islandCollapse', 'islandSquish',
    'iosAppOpen', 'iosAppClose', 'appIconTransition',
  ]) {
    assert.match(motionJs, new RegExp(`${name}\\s*\\(`), `missing ${name}`);
  }
  assert.match(motionJs, /terminalIslandSourceMelt/);
  assert.match(motionJs, /terminalIslandDotsReturn/);
  assert.match(motionJs, /listRecipes/);
  assert.match(motionJs, /signature:\s*\[/);
  // Continuous surface: clone icon into expanding card (no dual ghost)
  assert.match(motionJs, /_ensureSourceVisual/);
  assert.match(motionJs, /data-motion-source-visual/);
  assert.match(motionJs, /cloneSource/);
  // Inverse scale keeps glyph unstretched during FLIP
  assert.match(motionJs, /--motion-sx/);
  assert.match(motionJs, /1 \/ max\(var\(--motion-sx/);
  // Single-spring island open (no multi-phase brick wall)
  assert.match(motionJs, /islandDots\(g,\s*'melt'/);
  assert.doesNotMatch(motionJs, /scaleX:\s*1\.04/);
});

test('recipe catalog covers cards, AI, island, windows', () => {
  for (const r of [
    'connectionCardIn', 'aiIosPopIn', 'terminalWindowIn',
    'floatingPanelOpenFromButton', 'terminalIslandSourceMelt',
    'terminalIslandDotMelt', 'iosAppOpen',
  ]) {
    assert.match(motionJs, new RegExp(`${r}\\s*:`), `recipe missing: ${r}`);
  }
});

test('play routes island melt to islandDots helper', () => {
  assert.match(motionJs, /islandDots\(el,\s*'melt'/);
  assert.match(motionJs, /islandDots\(el,\s*'return'/);
});

test('enter defaults never use scale\(0\)', () => {
  assert.match(motionJs, /DEFAULT_ENTER_SCALE:\s*0\.96/);
  assert.doesNotMatch(motionJs, /DEFAULT_ENTER_SCALE:\s*0(?:\s|,|;|\}|$)/);
});

test('feel page is Chinese and demos signature merges', () => {
  assert.match(feel, /lang="zh-CN"/);
  assert.match(feel, /三点膨胀/);
  assert.match(feel, /合并收回/);
  assert.match(feel, /iOS 应用打开/);
  assert.match(feel, /islandExpand/);
  assert.match(feel, /iosAppOpen/);
  assert.match(feel, /配方目录/);
  assert.match(feel, /自检/);
});

test('toast stack API exists (push/dismiss)', () => {
  assert.match(motionJs, /toastDismiss\s*\(/);
  assert.match(motionJs, /toastPush\s*\(/);
  assert.match(motionJs, /_toastStacks/);
  // short travel default for banner feel
  assert.match(motionJs, /opts\.distance\)\)\s*\?\s*Number\(opts\.distance\)\s*:\s*28/);
  assert.match(motionJs, /distance:\s*28/);
});

test('press accepts multi-element and keyboard', () => {
  assert.match(motionJs, /press\(elOrList/);
  assert.match(motionJs, /keydown/);
  assert.match(motionJs, /Number\(opts\.scale\)\s*:\s*0\.97/);
});

test('switchThumb supports trackFill and pop', () => {
  assert.match(motionJs, /switchThumb\s*\(/);
  assert.match(motionJs, /trackFillEl/);
  assert.match(motionJs, /travel:\s*18|opts\.travel\)\s*\?\s*Number\(opts\.travel\)\s*:\s*18/);
});

test('feel page demos press switch toast stagger recipes', () => {
  assert.match(feel, /playStagger/);
  assert.match(feel, /connectionCardIn/);
  assert.match(feel, /demoSwitchThumb|switchThumb/);
  assert.match(feel, /toastPush/);
  assert.match(feel, /pressBtn3|Motion\.press\(\[/);
});

test('macPanel / connectionOpen / shelf standard APIs', () => {
  assert.match(motionJs, /macPanel\s*\(/);
  assert.match(motionJs, /macPanelOpen\s*\(/);
  assert.match(motionJs, /macPanelClose\s*\(/);
  assert.match(motionJs, /setOriginFromAnchor\s*\(/);
  assert.match(motionJs, /connectionOpen\s*\(/);
  assert.match(motionJs, /connectionClose\s*\(/);
  assert.match(motionJs, /shelf\s*\(/);
  assert.match(motionJs, /mode = opts\.mode \|\| 'flip'|mode \|\| 'flip'/);
  assert.match(motionJs, /open \? 'mac' : 'macClose'/);
  assert.match(motionJs, /btnRect\.left - layoutBox\.left/);
  // hideSource tracked + restorable; default OFF for toolbar UX
  assert.match(motionJs, /hideSource\s*\(/);
  assert.match(motionJs, /restoreSources\s*\(/);
  assert.match(motionJs, /_hiddenBySurface/);
  assert.match(motionJs, /hideSource === true/);
  // restore MUST release() first — sticky opacity channel bug
  assert.match(motionJs, /restoreSource\(sourceEl\)[\s\S]{0,500}this\.release\(sourceEl\)/);
  assert.match(feel, /hideSource: false/);
  assert.match(feel, /restoreAllAppIcons/);
  assert.match(feel, /macPanel|macFakePanel/);
  assert.match(feel, /FLIP 长出|mode: 'flip'|mode:'flip'/);
});

test('dock / AI / clip / islandSize APIs complete', () => {
  assert.match(motionJs, /dockMagnify\s*\(/);
  assert.match(motionJs, /dockMagnifyPointer\s*\(/);
  assert.match(motionJs, /dockMagnifyReset\s*\(/);
  assert.match(motionJs, /--dock-scale/);
  assert.match(motionJs, /aiPanelOpen\s*\(/);
  assert.match(motionJs, /aiPanelClose\s*\(/);
  assert.match(motionJs, /clipInset\s*\(/);
  assert.match(motionJs, /clipTop/);
  assert.match(motionJs, /islandSize\s*\(/);
  assert.match(motionJs, /--island-w/);
  assert.match(feel, /dockMagnifyPointer|demoDock/);
  assert.match(feel, /aiPanelOpen|aiDemoPanel/);
  assert.match(feel, /clipInset|clipDemo/);
  assert.match(feel, /DEAD_KF|deadKeyframes|terminalIslandFluidOpen/);
});

test('production UI still not calling Motion signature APIs', () => {
  assert.doesNotMatch(appJs, /Motion\.islandExpand\s*\(/);
  assert.doesNotMatch(appJs, /Motion\.iosAppOpen\s*\(/);
  assert.doesNotMatch(appJs, /Motion\.play\s*\(/);
  assert.doesNotMatch(appJs, /Motion\.toastPush\s*\(/);
  assert.doesNotMatch(appJs, /Motion\.toast\s*\(/);
  assert.doesNotMatch(appJs, /Motion\.press\s*\(/);
  assert.doesNotMatch(appJs, /Motion\.switchThumb\s*\(/);
  assert.doesNotMatch(appJs, /Motion\.playStagger\s*\(/);
  assert.doesNotMatch(appJs, /Motion\.macPanel\s*\(/);
  assert.doesNotMatch(appJs, /Motion\.connectionOpen\s*\(/);
  assert.doesNotMatch(appJs, /Motion\.dockMagnify/);
  assert.doesNotMatch(appJs, /Motion\.aiPanelOpen/);
  assert.doesNotMatch(appJs, /Motion\.clipInset/);
  // production still uses CSS keyframes for panels
  assert.match(styleCss, /@keyframes\s+floatingPanelOpenFromButton/);
  assert.match(styleCss, /@keyframes\s+terminalIslandSourceMelt/);
  assert.match(styleCss, /@keyframes\s+terminalIslandFluidOpen/);
  assert.match(styleCss, /--connection-ios-spring/);
  assert.match(styleCss, /--dock-scale/);
});
