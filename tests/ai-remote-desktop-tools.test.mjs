import test from 'node:test';
import assert from 'node:assert/strict';
import remoteTools from '../ai-remote-desktop-tools.js';

const snapshot = {
  tabId: 'rdp-1', protocol: 'RDP', frameAt: 12345,
  width: 640, height: 360, originalWidth: 1920, originalHeight: 1080,
  dataUrl: 'data:image/jpeg;base64,abc',
};

test('remote desktop capture id is deterministic for one frame', () => {
  const capture = remoteTools.publicCapture(snapshot);
  assert.equal(capture.captureId, 'rdp-1:12345:640:360');
  assert.equal(remoteTools.captureIdFor({ ...snapshot }), capture.captureId);
  assert.equal(capture.hasScreenshot, true);
});

test('remote desktop action validates capture and screenshot coordinates', () => {
  const captureId = remoteTools.captureIdFor(snapshot);
  const current = remoteTools.validateActionAgainstCapture({ action: 'mouse', captureId, x: 120, y: 80 }, snapshot);
  assert.equal(current.captureId, captureId);
  assert.throws(() => remoteTools.validateActionAgainstCapture({ action: 'mouse', captureId: 'stale', x: 1, y: 1 }, snapshot), (error) => error.code === 'stale_capture');
  assert.throws(() => remoteTools.validateActionAgainstCapture({ action: 'mouse', captureId, x: 900, y: 1 }, snapshot), (error) => error.code === 'invalid_remote_coordinates');
});

test('runtime-scoped capture ledger supersedes frozen request context', () => {
  const stored = remoteTools.rememberCapture({ userId: 'u1', runId: 'run-1', snapshot });
  assert.equal(stored.captureId, 'rdp-1:12345:640:360');
  assert.equal(stored.dataUrl, undefined);
  assert.equal(stored.hasScreenshot, true);
  assert.equal(remoteTools.getRememberedCapture({ userId: 'u1', runId: 'run-1', tabId: 'rdp-1' }).captureId, stored.captureId);
  assert.equal(remoteTools.getRememberedCapture({ userId: 'u2', runId: 'run-1', tabId: 'rdp-1' }), null);
  assert.equal(remoteTools.consumeRememberedCapture({ userId: 'u1', runId: 'run-1', tabId: 'rdp-1', captureId: stored.captureId }).captureId, stored.captureId);
  assert.equal(remoteTools.getRememberedCapture({ userId: 'u1', runId: 'run-1', tabId: 'rdp-1' }), null);
  assert.throws(() => remoteTools.consumeRememberedCapture({ userId: 'u1', runId: 'run-1', tabId: 'rdp-1', captureId: stored.captureId }), (error) => error.code === 'stale_capture');
});

test('remote desktop client action preserves capture binding', () => {
  const action = remoteTools.clientAction({ tabId: 'rdp-1', action: 'send_text', captureId: 'cap-1', frameAt: 12345, text: 'https://example.com', paste: true });
  assert.equal(action.action, 'remote_desktop_send_text');
  assert.equal(action.captureId, 'cap-1');
  assert.equal(action.frameAt, 12345);
  assert.equal(action.coordinateSpace, 'screenshot');
});

test('remote desktop cert state and decide action are structured', () => {
  const cert = remoteTools.publicCertState({
    tabId: 'rdp-1',
    protocol: 'RDP',
    certPhase: 'pending',
    connectionPhase: 'cert_pending',
    certDialog: { host: '1.2.3.4', port: 3389, fingerprint: 'FF:EE', reasons: ['self signed'] },
  });
  assert.equal(cert.pending, true);
  assert.equal(cert.fingerprint, 'FF:EE');
  const decide = remoteTools.clientCertDecideAction({ tabId: 'rdp-1', decision: 'reject', remember: false });
  assert.equal(decide.action, 'remote_desktop_cert_decide');
  assert.equal(decide.decision, 'reject');
});
