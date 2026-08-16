import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('terminal latency loop is controllable and its JVM tests cannot spin virtual time forever', () => {
  const source = read('android/feature-sessions/src/main/kotlin/one/zephyr/mobile/feature/sessions/TerminalViewModel.kt');
  const unit = read('android/feature-sessions/src/test/kotlin/one/zephyr/mobile/feature/sessions/TerminalViewModelTest.kt');

  assert.match(source, /private val latencyRefreshMs: Long = LATENCY_REFRESH_MS/);
  assert.match(source, /if \(latencyRefreshMs <= 0L\) break/);
  assert.match(source, /delay\(latencyRefreshMs\)/);
  assert.match(source, /latencyJob\?\.cancel\(\)/);
  assert.match(unit, /latencyRefreshMs: Long = 0L/);
  assert.match(unit, /latencyProbeRepeatsAtItsIntervalAndStopsWhenDisconnected/);
  assert.match(unit, /latencyRefreshMs = 5_000L/);
});

test('aggregate command still covers every current test module', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '../../.github/workflows/zephyr-one-mobile.yml'), 'utf8');
  const settings = read('android/settings.gradle.kts');
  const included = [...settings.matchAll(/include\(":([^"]+)"\)/g)].map((match) => match[1]);
  const testedModules = fs.readdirSync(path.join(ROOT, 'android'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((module) => {
      const dir = path.join(ROOT, 'android', module, 'src/test');
      if (!fs.existsSync(dir)) return false;
      const stack = [dir];
      while (stack.length) {
        const current = stack.pop();
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
          const full = path.join(current, entry.name);
          if (entry.isDirectory()) stack.push(full);
          else if (/Test\.(kt|java)$/.test(entry.name)) return true;
        }
      }
      return false;
    })
    .sort();

  const androidLibraries = testedModules.filter((module) =>
    !['app', 'core-contracts', 'core-model', 'protocol-telnet', 'protocol-zft2'].includes(module),
  );
  assert.ok(androidLibraries.every((module) => included.includes(module)));
  assert.match(workflow, /testReleaseUnitTest/);
  for (const module of ['app', 'core-contracts', 'core-model', 'protocol-telnet', 'protocol-zft2']) {
    assert.match(workflow, new RegExp(`:${module}:test`));
  }
  assert.equal(testedModules.length, 19);
});
