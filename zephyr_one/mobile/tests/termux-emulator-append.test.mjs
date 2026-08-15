/*
 * CI failed on main at
 *   :feature-sessions:compileReleaseJavaWithJavac
 * because TerminalSession.appendFromRemote called
 *   mEmulator.append(data, offset, count)
 * while TerminalEmulator only declared append(byte[], int).
 *
 * 9a49a84 fixed the Kotlin wrapper to the two-arg form and left the Java remote
 * path compiling against a method that does not exist. This suite is the cheap
 * half that runs without the Android SDK: if either side of that pair drifts,
 * assemblePrerelease fails again with the same one-line diagnostic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JAVA = path.join(
  ROOT,
  'android/feature-sessions/src/main/java/com/termux/terminal',
);
const KT = path.join(
  ROOT,
  'android/feature-sessions/src/main/kotlin/one/zephyr/mobile/feature/sessions',
);

const read = (dir, name) => fs.readFileSync(path.join(dir, name), 'utf8');

function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
}

function javaMethods(source, name) {
  const clean = codeOnly(source);
  const out = [];
  const re = new RegExp(
    String.raw`(?:public|protected|private)\s+(?:static\s+|final\s+)*[\w.<>,?\[\]\s]+\s+${name}\s*\(([^)]*)\)`,
    'g',
  );
  for (const match of clean.matchAll(re)) {
    const args = match[1].trim();
    out.push(args === '' ? 0 : args.split(',').length);
  }
  return out;
}

const emulator = read(JAVA, 'TerminalEmulator.java');
const session = read(JAVA, 'TerminalSession.java');
const wrapper = read(KT, 'TermuxTerminalEmulator.kt');
const bridge = read(KT, 'TermuxSessionBridge.kt');

test('TerminalEmulator accepts both a prefix and a window of bytes', () => {
  const arities = javaMethods(emulator, 'append').sort((a, b) => a - b);
  assert.deepEqual(
    arities,
    [2, 3],
    'append(byte[], int) and append(byte[], int, int) must both exist; CI died on the missing three-arg form',
  );
  assert.match(
    codeOnly(emulator),
    /public void append\(\s*byte\[\] buffer,\s*int offset,\s*int length\s*\)/,
  );
  assert.match(
    codeOnly(emulator),
    /for\s*\(\s*int i = offset;\s*i < end;\s*i\+\+\s*\)/,
    'the three-arg form must walk the window, not restart at index 0',
  );
});

test('the two-arg form is only a prefix of the three-arg form', () => {
  const twoArg = codeOnly(emulator).match(
    /public void append\(\s*byte\[\] buffer,\s*int length\s*\)\s*\{([^}]+)\}/,
  );
  assert.ok(twoArg, 'append(byte[], int) must remain for the local PTY reader');
  assert.match(twoArg[1], /append\(\s*buffer,\s*0,\s*length\s*\)/);
});

test('remote bytes keep their offset instead of being copied to index 0', () => {
  const clean = codeOnly(session);
  assert.match(
    clean,
    /public void appendFromRemote\(\s*byte\[\] data,\s*int offset,\s*int count\s*\)/,
  );
  assert.match(clean, /mEmulator\.append\(\s*data,\s*offset,\s*count\s*\)/);
  assert.doesNotMatch(
    clean,
    /mEmulator\.append\(\s*data,\s*count\s*\)/,
    'dropping the offset would feed the wrong slice of a reused receive buffer',
  );
});

test('Kotlin feed paths use a signature the emulator actually declares', () => {
  const wrapperClean = codeOnly(wrapper);
  const bridgeClean = codeOnly(bridge);
  assert.match(wrapperClean, /emulator\.append\(\s*bytes,\s*bytes\.size\s*\)/);
  assert.match(bridgeClean, /session\.appendFromRemote\(\s*bytes,\s*0,\s*bytes\.size\s*\)/);
  assert.doesNotMatch(
    wrapperClean,
    /emulator\.append\(\s*bytes,\s*0,\s*bytes\.size\s*\)/,
    'the wrapper talks to TerminalEmulator, which has no required offset when the array is exact',
  );
});

test('deleting the three-arg overload fails this suite the same way CI failed', () => {
  const stripped = emulator.replace(
    /public void append\(\s*byte\[\] buffer,\s*int offset,\s*int length\s*\)\s*\{[\s\S]*?\n    \}/,
    '',
  );
  const arities = javaMethods(stripped, 'append');
  assert.deepEqual(arities, [2], 'mutation must leave only the two-arg form');
  assert.throws(() => {
    if (!arities.includes(3)) {
      throw new Error('method append cannot be applied to byte[],int,int');
    }
  }, /byte\[\],int,int/);
});
