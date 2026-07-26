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

test('remote desktop client action preserves capture binding', () => {
  const action = remoteTools.clientAction({ tabId: 'rdp-1', action: 'send_text', captureId: 'cap-1', text: 'https://example.com', paste: true });
  assert.equal(action.action, 'remote_desktop_send_text');
  assert.equal(action.captureId, 'cap-1');
  assert.equal(action.coordinateSpace, 'screenshot');
});
