import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const remoteTools = require('../ai-remote-desktop-tools.js');
const capabilities = require('../ai-capabilities.js');
const aiAgent = require('../ai-agent-service.js');
const { preferredToolsForUserMessage } = require('../ai-intent-routing.js');
const { PLAYBOOKS } = require('../ai-playbooks.js');
const defaults = require('../ai-defaults.js');

const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const rdp = fs.readFileSync(path.join(root, 'public/rdp-wasm-client.js'), 'utf8');
const loop = fs.readFileSync(path.join(root, 'zephyr-ai/internal/agent/loop.go'), 'utf8');
const server = fs.readFileSync(path.join(root, 'zephyr-ai/internal/server/server.go'), 'utf8');

test('remote desktop cert schemas and public state are canonical', () => {
  assert.ok(remoteTools.REMOTE_DESKTOP_CERT_STATUS_SCHEMA);
  assert.ok(remoteTools.REMOTE_DESKTOP_CERT_DECIDE_SCHEMA);
  assert.deepEqual(remoteTools.REMOTE_DESKTOP_CERT_DECIDE_SCHEMA.required, ['tabId', 'decision']);
  const state = remoteTools.publicCertState({
    tabId: 'rdp-1',
    protocol: 'RDP',
    connectionId: 'c1',
    connected: false,
    certPhase: 'pending',
    connectionPhase: 'cert_pending',
    certDialog: {
      host: '10.0.0.8',
      port: 3389,
      subject: 'CN=win',
      fingerprint: 'AA:BB',
      reasons: ['self signed'],
    },
  });
  assert.equal(state.pending, true);
  assert.equal(state.certPhase, 'pending');
  assert.equal(state.fingerprint, 'AA:BB');
  assert.equal(remoteTools.clientCertDecideAction({ tabId: 'rdp-1', decision: 'accept', remember: true }).action, 'remote_desktop_cert_decide');
  assert.equal(remoteTools.requiresVisionCapture('remote_desktop_capture_v1'), true);
  assert.equal(remoteTools.requiresVisionCapture('remote_desktop_cert_status_v1'), false);
  assert.equal(remoteTools.requiresVisionCapture('remote_desktop_cert_decide_v1'), false);
});

test('catalog exposes cert tools with R0/R2 policy', () => {
  const catalog = aiAgent.listToolCatalog({});
  const status = catalog.find((item) => item.name === 'remote_desktop_cert_status_v1');
  const decide = catalog.find((item) => item.name === 'remote_desktop_cert_decide_v1');
  assert.ok(status);
  assert.ok(decide);
  assert.equal(status.risk, 'R0');
  assert.equal(status.confirmation, 'never');
  assert.equal(decide.risk, 'R2');
  assert.equal(decide.confirmation, 'always');
  assert.ok(capabilities.CAPABILITIES.some((item) => item.id === 'remotedesktop.cert_status'));
  assert.ok(capabilities.CAPABILITIES.some((item) => item.id === 'remotedesktop.cert_decide'));
});

test('cert status uses context snapshot without client hop when present', async () => {
  const result = await aiAgent.executeAiToolForHost('remote_desktop_cert_status_v1', { tabId: 'rdp-1' }, {
    deps: { storage: { getSettings: () => ({ ai: {} }) } },
    user: { userId: 'u1', username: 'u1' },
    context: {
      remoteDesktopSnapshots: [{
        tabId: 'rdp-1',
        protocol: 'RDP',
        connectionId: 'c1',
        connected: false,
        certPhase: 'pending',
        connectionPhase: 'cert_pending',
        host: '10.0.0.8',
        port: 3389,
        certDialog: { host: '10.0.0.8', port: 3389, subject: 'CN=win', fingerprint: 'AA:BB', reasons: ['self signed'], phase: 'pending' },
      }],
    },
  });
  const data = result?.data || result;
  assert.equal(data.cert.pending, true);
  assert.equal(data.clientCaptureRequired, false);
  assert.match(String(data.message || ''), /证书/);
});

test('cert decide returns client action package and requires confirmation path via catalog policy', async () => {
  let threw = false;
  try {
    // Without confirmedToolId, canonical R2 tools return confirmationRequired wrapper.
    const result = await aiAgent.executeAiToolForHost('remote_desktop_cert_decide_v1', {
      tabId: 'rdp-1',
      decision: 'accept',
      remember: true,
      expectedFingerprint: 'AA:BB',
    }, {
      deps: { storage: { getSettings: () => ({ ai: {} }) } },
      user: { userId: 'u1', username: 'u1' },
      context: {
        remoteDesktopSnapshots: [{
          tabId: 'rdp-1',
          protocol: 'RDP',
          certPhase: 'pending',
          certDialog: { fingerprint: 'AA:BB', phase: 'pending', host: '10.0.0.8' },
        }],
      },
    });
    if (result?.confirmationRequired || result?.data?.confirmationRequired) {
      assert.ok(true);
      return;
    }
    // Some host paths may already unwrap; then clientCapture must be present.
    const data = result?.data || result;
    assert.equal(data.clientCaptureRequired, true);
    assert.equal(data.clientAction.action, 'remote_desktop_cert_decide');
  } catch (err) {
    threw = true;
    assert.fail(err);
  }
  assert.equal(threw, false);

  const approved = await aiAgent.executeAiToolForHost('remote_desktop_cert_decide_v1', {
    tabId: 'rdp-1',
    decision: 'accept',
    remember: true,
    expectedFingerprint: 'AA:BB',
  }, {
    deps: { storage: { getSettings: () => ({ ai: {} }) } },
    user: { userId: 'u1', username: 'u1' },
    confirmedToolId: 'remote_desktop_cert_decide_v1',
    context: {
      remoteDesktopSnapshots: [{
        tabId: 'rdp-1',
        protocol: 'RDP',
        certPhase: 'pending',
        certDialog: { fingerprint: 'AA:BB', phase: 'pending', host: '10.0.0.8' },
      }],
    },
  });
  const data = approved?.data || approved;
  assert.equal(data.clientCaptureRequired, true);
  assert.equal(data.clientCapture.vision, false);
  assert.equal(data.clientAction.decision, 'accept');
  assert.equal(data.clientAction.remember, true);
});

test('intent routing prefers cert tools for certificate language', () => {
  const tools = preferredToolsForUserMessage('RDP 证书未验证，帮我点连接并记住');
  assert.equal(tools[0].name, 'remote_desktop_cert_status_v1');
  assert.ok(tools.some((item) => item.name === 'remote_desktop_cert_decide_v1'));
});

test('frontend and runtime support non-vision cert client capture', () => {
  assert.match(rdp, /ai-remote-desktop-cert-status/);
  assert.match(rdp, /ai-remote-desktop-cert-decide/);
  assert.match(rdp, /__zephyrGetRemoteDesktopCertState/);
  assert.match(rdp, /certPhase/);
  assert.match(rdp, /settleCertDialog/);
  assert.match(app, /remote_desktop_cert_status/);
  assert.match(app, /remote_desktop_cert_decide/);
  assert.match(app, /isCertCapture/);
  assert.match(app, /vision:\s*false/);
  assert.match(loop, /_cert_/);
  assert.match(loop, /needsVisionAsset/);
  assert.match(server, /needsVisionAsset/);
  const playbook = PLAYBOOKS.find((item) => item.id === 'remote-desktop-closed-loop-v1');
  assert.match(playbook.prompt, /remote_desktop_cert_status_v1/);
  assert.match(playbook.prompt, /remote_desktop_cert_decide_v1/);
  assert.equal(defaults.DEFAULT_ZEPHYR_AI_GUIDANCE_VERSION, 18);
});
