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

test('delete follows the hosted main end: stat, rm -rf for a directory, unlink otherwise', () => {
  const del = slice('suspend fun delete(');
  // stat() so a symlink is judged by its target, matching server.js sftp-delete.
  assert.match(del, /stat\(sessionId, path\)/);
  assert.match(del, /kind\.isDirectory/);
  assert.match(del, /rm -rf -- /);
  assert.match(del, /shellQuote\(path\)/);
  assert.match(del, /sftpUnit\(sessionId\) \{ rm\(path\) \}/);
  // The old per-entry SFTP walk stalled and was removed.
  assert.equal(src.includes('fun removeTree('), false);
  assert.match(del, /path != "\/"/);
});
