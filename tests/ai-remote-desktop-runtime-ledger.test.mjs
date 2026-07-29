import test from 'node:test';
import assert from 'node:assert/strict';
import aiAgent from '../ai-agent-service.js';
import remoteTools from '../ai-remote-desktop-tools.js';

const baseDeps = {
  storage: { getSettings: () => ({ ai: { permissions: {} } }) },
};

function context(runId = 'run-ledger') {
  return {
    user: { userId: 'u-ledger', role: 'user' },
    runId,
    context: {
      remoteDesktopSnapshots: [{
        tabId: 'rdp-1', protocol: 'RDP', connected: true,
        frameAt: 100, captureId: 'old-frame', width: 640, height: 360,
        originalWidth: 1920, originalHeight: 1080,
      }],
    },
    confirmedToolId: 'remote_desktop_action_v1',
  };
}

test('remote desktop action validates against latest run capture ledger', async () => {
  remoteTools.rememberCapture({
    userId: 'u-ledger',
    runId: 'run-ledger',
    snapshot: {
      tabId: 'rdp-1', protocol: 'RDP', connected: true,
      frameAt: 200, captureId: 'new-frame', width: 640, height: 360,
      originalWidth: 1920, originalHeight: 1080, hasScreenshot: true,
    },
  });
  const result = await aiAgent.executeAiToolForHost('remote_desktop_action_v1', {
    tabId: 'rdp-1', action: 'mouse', captureId: 'new-frame',
    x: 120, y: 80, control: 'mouse_click',
  }, { ...context(), deps: baseDeps });
  assert.equal(result.ok, true);
  assert.equal(result.data.clientCaptureRequired, true);
  assert.equal(result.data.clientAction.captureId, 'new-frame');
  assert.equal(result.data.clientAction.screenshotWidth, 640);
  assert.equal(result.data.clientAction.originalWidth, 1920);
  assert.equal(result.data.clientAction.frameAt, 200);
  await assert.rejects(
    aiAgent.executeAiToolForHost('remote_desktop_action_v1', {
      tabId: 'rdp-1', action: 'mouse', captureId: 'new-frame',
      x: 120, y: 80, control: 'mouse_click',
    }, { ...context(), deps: baseDeps }),
    (error) => error.code === 'stale_capture',
  );
  await assert.rejects(
    aiAgent.executeAiToolForHost('remote_desktop_action_v1', {
      tabId: 'rdp-1', action: 'mouse', captureId: 'new-frame',
      x: 125, y: 82, control: 'mouse_click',
    }, { ...context(), deps: baseDeps }),
    (error) => error.code === 'stale_capture_retry_exhausted' && error.retryable === false,
  );
  const recapture = await aiAgent.executeAiToolForHost('remote_desktop_capture_v1', {
    tabId: 'rdp-1', maxWidth: 640,
  }, { ...context(), deps: baseDeps });
  assert.equal(recapture.ok, true);
  assert.equal(recapture.data.clientCaptureRequired, true);
  assert.equal(recapture.data.capture, null);
});

test('frozen context capture is rejected after ledger advances', async () => {
  await assert.rejects(
    aiAgent.executeAiToolForHost('remote_desktop_action_v1', {
      tabId: 'rdp-1', action: 'mouse', captureId: 'old-frame',
      x: 12, y: 8, control: 'mouse_click',
    }, { ...context('run-frozen'), deps: baseDeps }),
    (error) => error.code === 'stale_capture',
  );
});
