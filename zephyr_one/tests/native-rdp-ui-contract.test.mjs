import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  NATIVE_RDP_CHANNEL,
  createNativeRdpShellController,
} from '../src/rdp/native-rdp-client.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(root, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function nativeInvokeHarness() {
  const calls = [];
  const surfaces = new Set();
  async function invoke(command, args = {}) {
    calls.push({ command, args: structuredClone(args) });
    if (command === 'rdp_native_capabilities') {
      return {
        available: true,
        freerdpMajor: 3,
        clipboardAvailable: true,
        reason: '',
      };
    }
    if (command === 'rdp_native_surface_status') {
      return {
        platformSupported: true,
        sessionId: args.sessionId,
        created: surfaces.has(args.sessionId),
        attached: surfaces.has(args.sessionId),
        visible: true,
        focused: true,
        width: 1280,
        height: 720,
        diagnostic: 'must-not-cross-the-renderer-boundary',
      };
    }
    if (command === 'rdp_native_session_state') {
      return {
        live: true,
        stopping: false,
        frames: 1,
        bytes: 4,
        events: ['Connected', 'must-not-cross-the-renderer-boundary'],
      };
    }
    if (command === 'rdp_native_surface_create') {
      surfaces.add(args.sessionId);
      return { created: true, attached: true, sessionId: args.sessionId };
    }
    if (command === 'rdp_native_surface_close') {
      const existed = surfaces.has(args.sessionId);
      surfaces.delete(args.sessionId);
      return existed;
    }
    if (command === 'rdp_native_connect') {
      return { sessionId: args.request.sessionId, started: true };
    }
    if (command === 'rdp_native_surface_capture') {
      return {
        sessionId: args.sessionId,
        captureId: `${args.sessionId}:7:640:360`,
        frameAt: 12345,
        width: 640,
        height: 360,
        originalWidth: 1280,
        originalHeight: 720,
        dataUrl: 'data:image/png;base64,cG5n',
      };
    }
    if (command === 'rdp_native_send_text') return String(args.text || '').length;
    return { sessionId: args.sessionId };
  }
  return { calls, invoke, surfaces };
}

function openPayload(overrides = {}) {
  return {
    sessionId: 'tab_native_1',
    connectionId: 'connection-1',
    width: 1280,
    height: 720,
    dpi: 96,
    title: 'Test Remote Desktop',
    ...overrides,
  };
}

function controllerFor(harness, options = {}) {
  return createNativeRdpShellController({
    frame: options.frame || { contentWindow: {} },
    expectedOrigin: 'http://127.0.0.1:43123',
    invoke: options.invoke || harness.invoke,
    isTauri: options.isTauri ?? true,
    eventTarget: options.eventTarget || { addEventListener() {}, removeEventListener() {} },
  });
}

function sensitiveKeys(value, found = []) {
  if (!value || typeof value !== 'object') return found;
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:password|privateKey|folderPath|folderGrant|openCapability|grant|capability)$/i.test(key)) {
      found.push(key);
    }
    sensitiveKeys(child, found);
  }
  return found;
}

test('shell sends the native broker only an opaque connection intent', async () => {
  const harness = nativeInvokeHarness();
  const controller = controllerFor(harness);
  const result = await controller.dispatch('open', openPayload());

  const commands = harness.calls.map((call) => call.command);
  assert.ok(commands.indexOf('rdp_native_surface_create') < commands.indexOf('rdp_native_connect'));
  const connect = harness.calls.find((call) => call.command === 'rdp_native_connect');
  assert.deepEqual(connect.args, {
    request: {
      connectionId: 'connection-1',
      sessionId: 'tab_native_1',
      width: 1280,
      height: 720,
    },
  });
  assert.deepEqual(sensitiveKeys(harness.calls), []);
  assert.equal(result.phase, 'connected');
  assert.equal(result.surface.diagnostic, undefined);
  assert.equal(result.session.events, undefined);
  assert.deepEqual([...controller.ownedSessions], ['tab_native_1']);

  await controller.dispatch('close', { sessionId: 'tab_native_1' });
  assert.equal(controller.ownedSessions.size, 0);
});

test('open rejects every field outside the opaque intent before invoking native code', async () => {
  for (const field of [
    'request',
    'host',
    'password',
    'path',
    'drivePath',
    'privateKey',
    'folderPath',
    'folderGrant',
    'openCapability',
  ]) {
    const harness = nativeInvokeHarness();
    const controller = controllerFor(harness);
    await assert.rejects(
      controller.dispatch('open', openPayload({ [field]: 'renderer-controlled' })),
      /unexpected_intent_field/,
      field,
    );
    assert.equal(harness.calls.length, 0, field);
  }
});

test('message bridge accepts only the exact iframe source and loopback origin', async () => {
  const harness = nativeInvokeHarness();
  let listener = null;
  const responses = [];
  const child = { postMessage(message, origin) { responses.push({ message, origin }); } };
  const eventTarget = {
    addEventListener(type, fn) { if (type === 'message') listener = fn; },
    removeEventListener() {},
  };
  controllerFor(harness, { frame: { contentWindow: child }, eventTarget });
  const request = {
    channel: NATIVE_RDP_CHANNEL,
    direction: 'embedded-to-shell',
    requestId: 'request-1',
    action: 'capabilities',
    payload: {},
  };

  await listener({ source: child, origin: 'http://attacker.test', data: request });
  await listener({ source: {}, origin: 'http://127.0.0.1:43123', data: request });
  assert.equal(responses.length, 0);
  await listener({ source: child, origin: 'http://127.0.0.1:43123', data: request });
  assert.equal(responses.length, 1);
  assert.equal(responses[0].origin, 'http://127.0.0.1:43123');
  assert.equal(responses[0].message.ok, true);
});

test('postMessage request ids are one-use and responses contain no broker secrets', async () => {
  const harness = nativeInvokeHarness();
  let listener = null;
  const responses = [];
  const child = { postMessage(message) { responses.push(structuredClone(message)); } };
  controllerFor(harness, {
    frame: { contentWindow: child },
    eventTarget: {
      addEventListener(type, fn) { if (type === 'message') listener = fn; },
      removeEventListener() {},
    },
  });
  const message = {
    channel: NATIVE_RDP_CHANNEL,
    direction: 'embedded-to-shell',
    requestId: 'one-use-open',
    action: 'open',
    payload: openPayload(),
  };
  const event = { source: child, origin: 'http://127.0.0.1:43123', data: message };
  await listener(event);
  await listener(event);

  assert.equal(responses[0].ok, true);
  assert.equal(responses[1].ok, false);
  assert.equal(responses[1].error.code, 'rdp_ui_replayed_message');
  assert.deepEqual(sensitiveKeys([message, responses, harness.calls]), []);
  assert.equal(JSON.stringify(responses).includes('must-not-cross-the-renderer-boundary'), false);
});

test('an embedded page cannot adopt a native surface it did not open', async () => {
  const harness = nativeInvokeHarness();
  harness.surfaces.add('foreign_session');
  const controller = controllerFor(harness);
  await assert.rejects(
    controller.dispatch('open', openPayload({
      sessionId: 'foreign_session',
      connectionId: 'foreign-connection',
    })),
    /session_collision/,
  );
  assert.equal(harness.calls.some((call) => call.command === 'rdp_native_connect'), false);
});

test('native AI input is bound to one owner capture and cannot be replayed', async () => {
  const harness = nativeInvokeHarness();
  const controller = controllerFor(harness);
  await controller.dispatch('open', openPayload());
  const capture = await controller.dispatch('capture', { sessionId: 'tab_native_1', maxWidth: 640 });
  assert.equal(capture.captureId, 'tab_native_1:7:640:360');
  assert.equal(capture.dataUrl, 'data:image/png;base64,cG5n');

  const action = await controller.dispatch('input', {
    sessionId: 'tab_native_1',
    captureId: capture.captureId,
    control: 'mouse_click',
    x: 640,
    y: 360,
    button: 1,
  });
  assert.equal(action.ok, true);
  assert.deepEqual(
    harness.calls.filter((call) => call.command === 'rdp_native_send_mouse').map((call) => call.args.flags),
    [0x0800, 0x9000, 0x1000],
  );
  await assert.rejects(
    controller.dispatch('input', {
      sessionId: 'tab_native_1', captureId: capture.captureId, control: 'mouse_click', x: 1, y: 1,
    }),
    /stale_capture/,
  );
});

test('embedded and shell sources contain no legacy secret or path flow', () => {
  const embedded = read('src/rdp/native-rdp-embedded.js');
  const client = read('src/rdp/native-rdp-client.js');
  const main = read('src/main.js');
  const storage = fs.readFileSync(path.join(repo, 'zephyr-one-rdp-storage.js'), 'utf8');
  const settings = fs.readFileSync(path.join(repo, 'zephyr-one-rdp-settings.js'), 'utf8');
  const server = fs.readFileSync(path.join(repo, 'server.js'), 'utf8');

  const forbidden = /password|privateKey|folderPath|folderGrant|openCapability|authorizeOpen|\/api\/rdp\/credentials|storage-mapping\//i;
  assert.doesNotMatch(embedded, forbidden);
  assert.doesNotMatch(client, forbidden);
  assert.doesNotMatch(main, forbidden);
  assert.match(embedded, /shellRequest\('open', \{[\s\S]*sessionId:[\s\S]*connectionId:[\s\S]*width:[\s\S]*height:/);
  assert.doesNotMatch(embedded, /\bfetch\s*\(/);
  assert.match(client, /invoke\('rdp_native_connect', \{[\s\S]*request: \{ connectionId, sessionId, width, height \}/);
  assert.doesNotMatch(storage, /app\.get\('\/api\/one\/rdp\/storage-files|app\.get\('\/api\/one\/rdp\/storage-file/);
  assert.doesNotMatch(settings, /data\.path|request\.path|pickerCapability|folderGrant|openCapability/);
  const credentialRoute = server.slice(
    server.indexOf("app.post('/api/rdp/credentials'"),
    server.indexOf("app.post('/api/rdp/telemetry'"),
  );
  assert.match(credentialRoute, /if \(ZEPHYR_ONE_EMBEDDED\)[\s\S]*status\(404\)/);
  assert.ok(
    credentialRoute.indexOf('if (ZEPHYR_ONE_EMBEDDED)') < credentialRoute.indexOf('storage.getConnectionById'),
  );
});

test('embedded surface blocks browser RDP navigation and exposes accessible controls', () => {
  const embedded = read('src/rdp/native-rdp-embedded.js');
  const transform = fs.readFileSync(path.join(repo, 'zephyr-one-embed-surface.js'), 'utf8');
  assert.match(embedded, /Object\.defineProperty\(HTMLIFrameElement\.prototype, 'src'/);
  assert.match(embedded, /role', 'status'/);
  assert.match(embedded, /role', 'alert'/);
  assert.match(embedded, /prefers-reduced-motion:reduce/);
  assert.doesNotMatch(embedded, /rdp-wasm|WebSocket|rdp-proxy/i);
  assert.match(transform, /EMBED_NATIVE_RDP_SCRIPT = '\/zephyr-one-native-rdp\.js'/);
});
