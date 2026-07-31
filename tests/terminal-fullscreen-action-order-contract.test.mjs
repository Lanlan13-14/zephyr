import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appJs = readFileSync(path.join(root, 'public/app.js'), 'utf8');

function section(from, to) {
  const start = appJs.indexOf(from);
  assert.notEqual(start, -1, `${from} missing`);
  const end = appJs.indexOf(to, start + from.length);
  assert.notEqual(end, -1, `${to} missing`);
  return appJs.slice(start, end);
}

test('fullscreen close runs window shrink with nav/workspace collapse', () => {
  const body = section('async function closeTerminalTab', 'function applyTerminalWindowPreset');
  const closingAt = body.indexOf('closingTerminalTabs.add(tabId);');
  const closeMotionAt = body.indexOf('const closeMotion = playTerminalWindowCloseMotion(win);');
  const parallelAt = body.indexOf('await Promise.all([');
  const exitAt = body.indexOf('exitTerminalFullscreen({ renderAfter: false })', parallelAt);
  const closeAt = body.indexOf('closeMotion,', parallelAt);
  assert.ok(closingAt >= 0 && closeMotionAt > closingAt);
  assert.ok(parallelAt > closeMotionAt && exitAt > parallelAt && closeAt > exitAt);
});

test('fullscreen minimize starts before exit collapse settles', () => {
  const body = section('function applyTerminalWindowPreset', 'function captureTerminalWindowRects');
  const branch = body.slice(body.indexOf("if (action === 'minimize')"), body.indexOf("if (action === 'close')"));
  const exitAt = branch.indexOf('const exitJob = exitTerminalFullscreen({ renderAfter: false });');
  const minimizeAt = branch.indexOf('minimizeTerminalSession(tabId);');
  const settleAt = branch.indexOf('exitJob.finally(() => renderTerminalTabs());');
  assert.ok(exitAt >= 0 && minimizeAt > exitAt && settleAt > minimizeAt);
  assert.doesNotMatch(branch, /exitTerminalFullscreen\([^)]*\)\.finally\(\(\) => \{\s*minimizeTerminalSession/);
});

test('exit promise is shared so repeated controls cannot double-collapse', () => {
  const body = section('function exitTerminalFullscreen', 'async function playTerminalWindowCloseMotion');
  assert.match(body, /if \(terminalFullscreenExitPromise\) return terminalFullscreenExitPromise;/);
  assert.match(body, /terminalFullscreenExitPromise = animateMobileTerminalFullscreen/);
  assert.match(body, /terminalFullscreenExitPromise = null;/);
});
