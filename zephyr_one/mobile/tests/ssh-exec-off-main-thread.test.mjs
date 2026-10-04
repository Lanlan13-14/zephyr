import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const src = readFileSync(
  new URL('../android/protocol-ssh/src/main/kotlin/one/zephyr/mobile/protocol/ssh/SshjEngine.kt', import.meta.url),
  'utf8',
);

function slice(name) {
  const start = src.indexOf(name);
  assert.ok(start > 0, `${name} missing`);
  return src.slice(start, start + 1400);
}

test('exec and execStream open the channel off the collecting thread', () => {
  for (const name of ['suspend fun exec(', 'fun execStream(']) {
    const body = slice(name);
    assert.match(body, /CompletableDeferred<Pair<Session, Session\.Command>>/);
    assert.match(body, /scope\.launch/);
    assert.doesNotMatch(body, /live\.client\.startSession\(\)\.use/);
  }
});

test('delete stats the link itself and recursion never follows one', () => {
  const del = slice('suspend fun delete(');
  assert.match(del, /lstat\(path\)/);
  assert.doesNotMatch(del, /(?<!l)stat\(path\)/);
  const tree = slice('fun removeTree(');
  assert.match(tree, /entry\.isDirectory/);
  assert.match(tree, /sftp\.rm\(entry\.path\)/);
});
