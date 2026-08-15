/*
 * After a successful SSH connect the terminal painted a blank Frost box.
 *
 * Two independent mistakes stacked:
 *   1. ZephyrOneRoot constructed SimpleVtEmulator and TerminalViewModel.termux did
 *      `emulator as? TermuxSessionBridge`, which is always null for that wrapper.
 *      TermuxTerminalPane then took FallbackComposeViewport, which drew an empty Box.
 *   2. TerminalSession.initializeEmulator treated a remote session as a local PTY
 *      (mShellPath == null) and walked into JNI.createSubprocess. SSH banners that
 *      arrived before layout were also dropped because mEmulator was still null.
 *
 * This suite is the cheap half. The JVM tests pin resize + contrast; CI compiles the
 * AndroidView path.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ANDROID = path.join(ROOT, 'android');
const read = (rel) => fs.readFileSync(path.join(ANDROID, rel), 'utf8');
const codeOnly = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

const root = read('app/src/main/kotlin/one/zephyr/mobile/app/ZephyrOneRoot.kt');
const vm = read('feature-sessions/src/main/kotlin/one/zephyr/mobile/feature/sessions/TerminalViewModel.kt');
const pane = read('feature-sessions/src/main/kotlin/one/zephyr/mobile/feature/sessions/TermuxTerminalPane.kt');
const session = read('feature-sessions/src/main/java/com/termux/terminal/TerminalSession.java');
const bridge = read('feature-sessions/src/main/kotlin/one/zephyr/mobile/feature/sessions/TermuxSessionBridge.kt');

test('the live route constructs a Termux session, not the snapshot wrapper', () => {
  const clean = codeOnly(root);
  assert.match(clean, /productionTerminalEmulator\(/);
  assert.doesNotMatch(clean, /emulator\s*=\s*SimpleVtEmulator\(/);
});

test('termux is only a TermuxSessionBridge, never a silent null from SimpleVtEmulator', () => {
  const clean = codeOnly(vm);
  assert.match(clean, /val termux: TermuxSessionBridge\? = emulator as\? TermuxSessionBridge/);
  assert.doesNotMatch(clean, /is SimpleVtEmulator -> emulator\.bridge/);
});

test('the fallback viewport draws glyphs instead of an empty Box', () => {
  const clean = codeOnly(pane);
  assert.match(clean, /FallbackComposeViewport/);
  assert.match(clean, /native\.drawText/);
  assert.match(clean, /TerminalCellPaint\.foreground/);
  assert.doesNotMatch(
    clean,
    /Box\(Modifier\.fillMaxSize\(\)\.background\(colors\.termBg\)\)\s*\/\*/,
  );
});

test('a remote session never calls JNI.createSubprocess', () => {
  const clean = codeOnly(session);
  assert.match(
    clean,
    /if \(mShellPath == null \|\| mCustomInputStream != null \|\| mCustomOutputStream != null \|\| mOutputListener != null\)/,
  );
  const remote = clean.slice(
    clean.indexOf('mShellPath == null'),
    clean.indexOf('JNI.createSubprocess'),
  );
  assert.match(remote, /return;/);
});

test('the bridge creates an emulator before the first remote byte and invalidates the view', () => {
  const clean = codeOnly(bridge);
  assert.match(clean, /created\.updateSize\(lastColumns, lastRows, 8, 16\)/);
  assert.match(clean, /fun productionTerminalEmulator/);
  assert.match(clean, /view\.onScreenUpdated\(\)/);
  assert.match(clean, /attachedView/);
});

test('the previous SimpleVtEmulator wiring fails this suite', () => {
  const broken = 'emulator = SimpleVtEmulator()';
  assert.match(broken, /SimpleVtEmulator\(/);
  assert.throws(() => {
    if (/emulator\s*=\s*SimpleVtEmulator\(/.test(broken)) {
      throw new Error('snapshot wrapper has no TerminalSession');
    }
  }, /no TerminalSession/);
});
