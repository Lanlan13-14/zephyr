import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createLinkHandoffRegistry, assertLiveSessionEpoch } = require('../link-handoff-session.js');

function registry() {
  const handoff = createLinkHandoffRegistry();
  handoff.register({
    sessionId: 'sess-1',
    ownerUserId: 'user-a',
    ownerDeviceId: 'dev-a',
    protocol: 'SSH',
  });
  return handoff;
}

test('handoff increments epoch and rejects stale input from the previous owner', () => {
  const handoff = registry();
  const transferred = handoff.requestHandoff({
    sessionId: 'sess-1',
    requestId: 'req_handoff_1',
    fromDeviceId: 'dev-a',
    toDeviceId: 'dev-b',
    toUserId: 'user-a',
    sameAccount: true,
  });
  assert.equal(transferred.sessionEpoch, 2);
  assert.equal(transferred.ownerDeviceId, 'dev-b');
  assert.throws(
    () => handoff.acceptInput({ sessionId: 'sess-1', deviceId: 'dev-a', sessionEpoch: 1 }),
    (err) => err.code === 'stale_owner' || err.code === 'stale_epoch',
  );
  assert.throws(
    () => handoff.acceptInput({ sessionId: 'sess-1', deviceId: 'dev-b', sessionEpoch: 1 }),
    (err) => err.code === 'stale_epoch',
  );
  const ok = handoff.acceptInput({ sessionId: 'sess-1', deviceId: 'dev-b', sessionEpoch: 2 });
  assert.equal(ok.ok, true);
});

test('two concurrent handoff requests leave a single owner', () => {
  const handoff = registry();
  const first = handoff.requestHandoff({
    sessionId: 'sess-1',
    requestId: 'req_one',
    fromDeviceId: 'dev-a',
    toDeviceId: 'dev-b',
    toUserId: 'user-a',
    sameAccount: true,
  });
  assert.throws(
    () => handoff.requestHandoff({
      sessionId: 'sess-1',
      requestId: 'req_two',
      fromDeviceId: 'dev-a',
      toDeviceId: 'dev-c',
      toUserId: 'user-a',
      sameAccount: true,
    }),
    (err) => err.code === 'not_session_owner',
  );
  assert.equal(handoff.get('sess-1').ownerDeviceId, first.ownerDeviceId);
  assert.equal(handoff.get('sess-1').sessionEpoch, 2);
});

test('cross-user handoff without approval is approval_required', () => {
  const handoff = registry();
  assert.throws(
    () => handoff.requestHandoff({
      sessionId: 'sess-1',
      requestId: 'req_cross',
      fromDeviceId: 'dev-a',
      toDeviceId: 'dev-x',
      toUserId: 'user-b',
      sameAccount: false,
    }),
    (err) => err.code === 'approval_required',
  );
  assert.equal(handoff.get('sess-1').sessionEpoch, 1);
});

test('Smartbar opens an explicit primary SSH PTY receiver, not fake per-device takeover', () => {
  const app = fs.readFileSync('public/app.js', 'utf8');
  assert.match(app, /terminal\.html\?handoff=1/);
  assert.match(app, /data-handoff-device/);
});

test('live SSH session input without epoch stays compatible; stale epoch is rejected', () => {
  const session = { sessionEpoch: 2, ownerDeviceId: 'dev-b' };
  assert.equal(assertLiveSessionEpoch(session, {}), true);
  assert.throws(
    () => assertLiveSessionEpoch(session, { sessionEpoch: 1, deviceId: 'dev-b' }),
    (err) => err.code === 'stale_epoch',
  );
  const server = fs.readFileSync('server.js', 'utf8');
  assert.match(server, /primaryPtyHandoff\.assertSocket\(ptySocketAuth, attachedSshSession, msg\.sessionEpoch\)/);
  assert.match(server, /if \(existingSession\.handoff\)/);
});
