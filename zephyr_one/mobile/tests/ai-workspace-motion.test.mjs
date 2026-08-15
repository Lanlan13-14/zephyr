/*
 * Pixel-contract for the AI launcher / sheet.
 *
 * Gradle is not in this environment, so the Kotlin JUnit files cannot run here.
 * This file reads the same Kotlin sources CI will compile and fails if the demo
 * numbers, flick settle, back chain, or empty-transcript rule drift.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ANDROID = path.join(ROOT, 'android');
const MOTION = path.join(ANDROID, 'feature-ai/src/main/kotlin/one/zephyr/mobile/feature/ai/AiSheetMotion.kt');
const MODELS = path.join(ANDROID, 'feature-ai/src/main/kotlin/one/zephyr/mobile/feature/ai/AiWorkspaceModels.kt');
const OVERLAY = path.join(ANDROID, 'feature-ai/src/main/kotlin/one/zephyr/mobile/feature/ai/AiWorkspaceOverlay.kt');
const HOST = path.join(ANDROID, 'app/src/main/kotlin/one/zephyr/mobile/app/AiWorkspaceHost.kt');
const ROOT_KT = path.join(ANDROID, 'app/src/main/kotlin/one/zephyr/mobile/app/ZephyrOneRoot.kt');
const OLD_OVERLAY = path.join(ANDROID, 'app/src/main/kotlin/one/zephyr/mobile/app/AiWorkspaceOverlay.kt');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function constFloat(src, name) {
  const match = src.match(new RegExp('const val ' + name + ': Float = ([0-9.]+)f'));
  assert.ok(match, 'missing Float const ' + name);
  return Number(match[1]);
}

function constInt(src, name) {
  const match = src.match(new RegExp('const val ' + name + ': Int = ([0-9]+)'));
  assert.ok(match, 'missing Int const ' + name);
  return Number(match[1]);
}

function enumFraction(src, name) {
  const match = src.match(new RegExp(name + '\\(([0-9.]+)f\\)'));
  assert.ok(match, 'missing detent ' + name);
  return Number(match[1]);
}

function heightPx(detent, container, fractions) {
  return Math.round(container * fractions[detent]);
}

function nearest(current, container, fractions) {
  let best = 'PEEK';
  let bestDist = Infinity;
  for (const name of ['PEEK', 'HALF', 'EXPANDED']) {
    const dist = Math.abs(heightPx(name, container, fractions) - current);
    if (dist < bestDist) {
      bestDist = dist;
      best = name;
    }
  }
  return best;
}

function settle(current, container, vel, deltaY, layout, fractions, flickV, flickY, proj) {
  if (layout === 'PAD') return 'HALF';
  if (vel > flickV && deltaY > flickY) return null;
  const projected = current - vel * proj;
  return nearest(projected, container, fractions);
}

const motion = read(MOTION);
const models = read(MODELS);
const overlay = read(OVERLAY);
const host = read(HOST);
const root = read(ROOT_KT);

const fractions = {
  PEEK: enumFraction(motion, 'PEEK'),
  HALF: enumFraction(motion, 'HALF'),
  EXPANDED: enumFraction(motion, 'EXPANDED'),
};
const flickV = constFloat(motion, 'FLICK_VELOCITY_PX_PER_MS');
const flickY = constFloat(motion, 'FLICK_MIN_DELTA_Y_PX');
const proj = constFloat(motion, 'VELOCITY_PROJECTION_MS');
const peekFloor = constFloat(motion, 'PEEK_DRAG_FLOOR');
const phone = 800;

test('demo detent fractions and durations are still the compiled numbers', () => {
  assert.equal(fractions.PEEK, 0.3);
  assert.equal(fractions.HALF, 0.55);
  assert.equal(fractions.EXPANDED, 0.92);
  assert.equal(constInt(motion, 'SHEET_MS'), 420);
  assert.equal(constInt(motion, 'FAB_OPACITY_MS'), 240);
  assert.equal(constInt(motion, 'FAB_SCALE_MS'), 120);
  assert.equal(constFloat(motion, 'FAB_PRESS_SCALE'), 0.92);
  assert.equal(constFloat(motion, 'FAB_GONE_SCALE'), 0.9);
  assert.equal(constFloat(motion, 'FAB_SIZE_DP'), 50);
  assert.equal(constFloat(motion, 'FAB_END_DP'), 16);
  assert.equal(constFloat(motion, 'FAB_END_PAD_DP'), 22);
  assert.equal(constFloat(motion, 'FAB_BOTTOM_DP'), 96);
  assert.equal(constFloat(motion, 'PAD_BREAKPOINT_DP'), 768);
  assert.equal(constFloat(motion, 'CLOSED_TRANSLATE'), 1.05);
  assert.equal(flickV, 0.9);
  assert.equal(flickY, 40);
  assert.equal(proj, 140);
  assert.equal(peekFloor, 0.7);
  assert.equal(heightPx('PEEK', phone, fractions), 240);
  assert.equal(heightPx('HALF', phone, fractions), 440);
  assert.equal(heightPx('EXPANDED', phone, fractions), 736);
});

test('openAI lands on half, not peek or expanded', () => {
  assert.match(motion, /fun open\(\): AiDetent = AiDetent\.HALF/);
  assert.match(overlay, /detent = AiSheetMotion\.open\(\)/);
});

test('phone expanded is the only scrim; pad never shows one', () => {
  assert.match(motion, /layout == AiLayout\.PHONE && detent == AiDetent\.EXPANDED/);
  assert.match(overlay, /AiSheetMotion\.showScrim/);
  assert.match(overlay, /AiDetent\.PEEK/);
});

test('back walks expanded → half → peek → closed and picker first', () => {
  assert.match(motion, /AiDetent\.EXPANDED -> AiDetent\.HALF/);
  assert.match(motion, /AiDetent\.HALF -> AiDetent\.PEEK/);
  assert.match(motion, /AiDetent\.PEEK -> null/);
  assert.match(motion, /if \(state\.pickerOpen\) return state\.copy\(pickerOpen = false\)/);
  assert.match(overlay, /BackHandler\(enabled = sheet\.isOpen\)/);
  assert.match(overlay, /AiSheetMotion\.back\(sheet\)/);
});

test('handle uses direct manipulation, stable velocity and an interruptible spring', () => {
  assert.match(overlay, /AiHandleVelocityEstimator\(\)/);
  assert.match(overlay, /tracker\.velocityPxPerSecond\(\)/);
  const estimator = read(path.join(ANDROID, 'feature-ai/src/main/kotlin/one/zephyr/mobile/feature/ai/AiHandleVelocityEstimator.kt'));
  assert.match(estimator, /horizonMs: Long = 100L/);
  assert.match(estimator, /numerator \/ denominator \* 1_000f/);
  assert.match(overlay, /spring\(/);
  assert.match(overlay, /initialVelocity = -releaseVelocityPxPerSecond/);
  assert.match(overlay, /AiSheetGeometry\.dragHeightPx/);
  assert.match(overlay, /HANDLE_ACTIVE_WIDTH_DP \/ AiSheetGeometry\.HANDLE_WIDTH_DP/);
  assert.match(overlay, /graphicsLayer \{ scaleX = handleScaleX \}/);
  assert.match(motion, /RUBBER_BAND_CONSTANT/);
  assert.doesNotMatch(overlay, /System\.nanoTime\(\)/);
});

test('flick + 40px closes even when nearest detent is still half', () => {
  const current = heightPx('HALF', phone, fractions) - 50;
  assert.equal(nearest(current, phone, fractions), 'HALF');
  assert.equal(settle(current, phone, 1.2, 50, 'PHONE', fractions, flickV, flickY, proj), null);
  assert.equal(settle(current, phone, 0.2, 50, 'PHONE', fractions, flickV, flickY, proj), 'HALF');
  assert.equal(settle(heightPx('HALF', phone, fractions), phone, 1.4, 10, 'PHONE', fractions, flickV, flickY, proj), 'PEEK');
});

test('upward velocity projects to expanded instead of nearest', () => {
  assert.equal(nearest(500, phone, fractions), 'HALF');
  assert.equal(settle(500, phone, -2, -80, 'PHONE', fractions, flickV, flickY, proj), 'EXPANDED');
  assert.equal(settle(360, phone, 0.6, 30, 'PHONE', fractions, flickV, flickY, proj), 'PEEK');
});

test('pad ignores the phone flick-close and stays a right rail', () => {
  assert.equal(settle(200, phone, 2, 80, 'PAD', fractions, flickV, flickY, proj), 'HALF');
  assert.match(overlay, /AiLayout\.PAD/);
  assert.match(overlay, /padWidthPx \* slide/);
  assert.match(overlay, /sheetHeightPx \* slide/);
  assert.match(overlay, /IntOffset/);
});

test('hiding the panel does not cancel a run', () => {
  assert.match(motion, /fun hidePanel[\s\S]*detent = null[\s\S]*runActive/);
  assert.match(models, /收起面板不取消/);
});

test('unconfigured overlay does not invent the demo disk thread', () => {
  for (const [name, src] of [['overlay', overlay], ['host', host], ['models', models]]) {
    assert.doesNotMatch(src, /prod-web-01/);
    assert.doesNotMatch(src, /82%/);
    assert.doesNotMatch(src, /access\.log/);
    assert.doesNotMatch(src, /logrotate/);
    assert.doesNotMatch(src, /du -x --max-depth/);
  }
  assert.match(host, /AndroidAiRuntimeController/);
  assert.match(models, /Never invent the demo disk-usage thread/);
  assert.match(overlay, /AiEmptyTranscript/);
  assert.match(models, /还没有对话/);
  assert.equal(fs.existsSync(OLD_OVERLAY), false, 'app-module fake overlay must stay deleted');
});

test('root hosts the overlay as an overlay, not a pushed page', () => {
  assert.match(root, /BoundAiWorkspace\(/);
  assert.match(root, /onOpenSettings = \{ route = RootRoute\.AiSettings \}/);
  assert.match(host, /enabled = chrome\.enabled/);
});

test('chip controls match Docker and send uses the real runtime', () => {
  assert.match(models, /"standard", "plan", "goal"/);
  assert.match(models, /"economy", "balanced", "delivery"/);
  assert.match(models, /"ask", "auto", "yolo"/);
  assert.match(models, /"none", "minimal", "low", "medium", "high", "xhigh"/);
  assert.match(models, /选择图片或文件（单文件最多 12MB）/);
  assert.match(models, /计划模式会要求复杂任务先规划/);
  assert.match(overlay, /controller\.send\(text\)/);
  assert.doesNotMatch(overlay, /sendNotice\(/);
});
