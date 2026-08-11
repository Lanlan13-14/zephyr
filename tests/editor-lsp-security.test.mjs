import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import editorLsp from '../editor-lsp-server.js';

const editorLspModulePath = fileURLToPath(new URL('../editor-lsp-server.js', import.meta.url));
const childAttemptFixture = fileURLToPath(new URL('./fixtures/editor-lsp-offline-child-attempt.cjs', import.meta.url));

const {
  applyDocumentChanges,
  createLspConnectionLifecycle,
  killChildProcessTree,
  MAX_FRAME_BYTES,
  parseClientMessage,
  safeYamlConfiguration,
} = editorLsp._security;
const { EditorLspAdmissionController } = editorLsp;

class FakeWebSocket extends EventEmitter {
  constructor() {
    super();
    this.OPEN = 1;
    this.readyState = this.OPEN;
    this.sent = [];
    this.closed = null;
  }

  send(payload) {
    this.sent.push(JSON.parse(String(payload)));
    this.emit('sent');
  }

  close(code = 1000, reason = '') {
    if (this.readyState !== this.OPEN) return;
    this.readyState = 3;
    this.closed = { code, reason };
    this.emit('close');
  }
}

function rpc(method, params, id) {
  const message = { jsonrpc: '2.0', method };
  if (params !== undefined) message.params = params;
  if (id !== undefined) message.id = id;
  return JSON.stringify(message);
}

function didOpen(text, uri = 'file:///workspace/test.yaml') {
  return rpc('textDocument/didOpen', {
    textDocument: { uri, languageId: 'yaml', version: 1, text },
  });
}

function waitForMessage(ws, predicate, timeoutMs = 10000) {
  const existing = ws.sent.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('sent', check);
      reject(new Error('Timed out waiting for LSP message'));
    }, timeoutMs);
    const check = () => {
      const found = ws.sent.find(predicate);
      if (!found) return;
      clearTimeout(timer);
      ws.off('sent', check);
      resolve(found);
    };
    ws.on('sent', check);
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeYamlRuntime() {
  const state = { spawnCount: 0, killCount: 0, disposeCount: 0, children: [] };
  class FakeReader { constructor(stream) { this.stream = stream; } }
  class FakeWriter { constructor(stream) { this.stream = stream; } }
  const transport = {
    StreamMessageReader: FakeReader,
    StreamMessageWriter: FakeWriter,
    createMessageConnection() {
      return {
        onNotification(handler) { this.notificationHandler = handler; },
        onRequest(handler) { this.requestHandler = handler; },
        listen() {},
        sendRequest(method) {
          if (method === 'initialize') return Promise.resolve({ capabilities: { completionProvider: { resolveProvider: false } } });
          return Promise.resolve(null);
        },
        sendNotification() {},
        dispose() { state.disposeCount += 1; },
      };
    },
  };
  const spawnProcess = () => {
    state.spawnCount += 1;
    const child = new EventEmitter();
    child.pid = 1000 + state.spawnCount;
    child.stdin = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    state.children.push(child);
    return child;
  };
  const killChildTree = () => { state.killCount += 1; };
  return { state, transport, spawnProcess, killChildTree };
}

test('YAML configuration is permanently offline', () => {
  const config = safeYamlConfiguration();
  assert.deepEqual(config.schemas, {});
  assert.deepEqual(config.schemaStore, { enable: false });
  assert.deepEqual(config.kubernetesCRDStore, { enable: false, url: '' });
  assert.equal(JSON.stringify(config).includes('http'), false);
});

test('offline YAML child guard blocks HTTP before redirects or DNS resolution', async () => {
  let hits = 0;
  const server = createServer((_request, response) => {
    hits += 1;
    response.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' });
    response.end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    const script = "try { require('http').get(process.argv[1]); process.exitCode = 2; } catch (error) { process.exitCode = error?.code === 'ERR_NETWORK_ACCESS_DENIED' ? 0 : 3; }";
    const child = spawn(process.execPath, [
      '--require', editorLspModulePath,
      '-e', script,
      `http://127.0.0.1:${address.port}/redirect`,
    ], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, ZEPHYR_EDITOR_LSP_OFFLINE_CHILD: '1' },
      stdio: 'ignore',
    });
    const [exitCode] = await once(child, 'exit');
    assert.equal(exitCode, 0);
    assert.equal(hits, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('offline YAML child guard freezes and rejects child_process execution APIs', async () => {
  const child = spawn(process.execPath, ['--require', editorLspModulePath, childAttemptFixture], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, ZEPHYR_EDITOR_LSP_OFFLINE_CHILD: '1' },
    stdio: 'ignore',
  });
  const [exitCode] = await once(child, 'exit');
  assert.equal(exitCode, 0);
});

test('server passes the immutable authenticated userId into LSP admission', () => {
  const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(source, /handleEditorLspConnection\(ws, req, \{ ownerId: req\.authSession\?\.userId \}\)/);
});

test('admission caps isolate owners and release connection and child slots idempotently', () => {
  const admission = new EditorLspAdmissionController({
    maxConnections: 3,
    maxConnectionsPerOwner: 2,
    maxYamlChildren: 2,
    maxYamlChildrenPerOwner: 1,
    globalRateLimit: 100,
    ownerRateLimit: 100,
  });
  const ownerAYaml = admission.admit('owner-a', 'yaml');
  assert.equal(ownerAYaml.ok, true);
  assert.equal(admission.admit('owner-a', 'yaml').reason, 'owner_children');
  const ownerAJson = admission.admit('owner-a', 'json');
  const ownerBYaml = admission.admit('owner-b', 'yaml');
  assert.equal(ownerAJson.ok, true);
  assert.equal(ownerBYaml.ok, true);
  assert.equal(admission.admit('owner-c', 'json').reason, 'global_connections');
  assert.deepEqual(admission.snapshot('owner-a'), {
    connections: 3, yamlChildren: 2, ownerConnections: 2, ownerYamlChildren: 1,
  });

  ownerAYaml.release();
  ownerAYaml.release();
  const ownerAReconnect = admission.admit('owner-a', 'yaml');
  assert.equal(ownerAReconnect.ok, true);
  assert.equal(admission.snapshot('owner-a').ownerYamlChildren, 1);
  ownerAReconnect.release();
  ownerAJson.release();
  ownerBYaml.release();
  assert.deepEqual(admission.snapshot('owner-a'), {
    connections: 0, yamlChildren: 0, ownerConnections: 0, ownerYamlChildren: 0,
  });
});

test('admission applies owner and global rate windows independently', () => {
  let now = 1000;
  const admission = new EditorLspAdmissionController({
    now: () => now,
    maxConnections: 10,
    maxConnectionsPerOwner: 10,
    maxYamlChildren: 10,
    maxYamlChildrenPerOwner: 10,
    globalRateLimit: 3,
    ownerRateLimit: 2,
    rateWindowMs: 100,
  });
  for (let index = 0; index < 2; index += 1) {
    const lease = admission.admit('owner-a', 'json');
    assert.equal(lease.ok, true);
    lease.release();
  }
  assert.equal(admission.admit('owner-a', 'json').reason, 'owner_rate');
  const ownerB = admission.admit('owner-b', 'json');
  assert.equal(ownerB.ok, true);
  ownerB.release();
  assert.equal(admission.admit('owner-c', 'json').reason, 'global_rate');
  now += 101;
  const afterWindow = admission.admit('owner-a', 'json');
  assert.equal(afterWindow.ok, true);
  afterWindow.release();
});

test('YAML caps reject before spawn and release permits owner reconnect', () => {
  const runtime = fakeYamlRuntime();
  const admission = new EditorLspAdmissionController({
    maxConnections: 4,
    maxConnectionsPerOwner: 2,
    maxYamlChildren: 2,
    maxYamlChildrenPerOwner: 1,
    globalRateLimit: 100,
    ownerRateLimit: 100,
  });
  const connect = (ownerId) => {
    const ws = new FakeWebSocket();
    const lifecycle = editorLsp.handleEditorLspConnection(ws, {
      url: '/editor-lsp?language=yaml', headers: { host: 'example.test' },
    }, {
      ownerId,
      admissionController: admission,
      transport: runtime.transport,
      spawnProcess: runtime.spawnProcess,
      killChildTree: runtime.killChildTree,
      initializationTimeoutMs: 1000,
      idleTimeoutMs: 1000,
    });
    return { ws, lifecycle };
  };

  const ownerA = connect('owner-a');
  assert.equal(runtime.state.spawnCount, 1);
  const ownerAOverflow = connect('owner-a');
  assert.equal(ownerAOverflow.lifecycle, null);
  assert.equal(ownerAOverflow.ws.closed.code, 1013);
  assert.equal(runtime.state.spawnCount, 1);
  const ownerB = connect('owner-b');
  assert.equal(runtime.state.spawnCount, 2);
  const globalOverflow = connect('owner-c');
  assert.equal(globalOverflow.lifecycle, null);
  assert.equal(runtime.state.spawnCount, 2);

  ownerA.ws.close();
  assert.equal(runtime.state.killCount, 1);
  assert.equal(admission.snapshot('owner-a').ownerYamlChildren, 0);
  const ownerAReconnect = connect('owner-a');
  assert.equal(ownerAReconnect.lifecycle.signal.aborted, false);
  assert.equal(runtime.state.spawnCount, 3);
  ownerAReconnect.ws.close();
  ownerB.ws.emit('error', new Error('parent disconnected'));
  assert.equal(ownerB.lifecycle.signal.aborted, true);
  assert.equal(admission.snapshot().connections, 0);
  assert.equal(runtime.state.killCount, 3);
});

test('initialization deadline aborts, releases, and allows reconnect', async () => {
  const admission = new EditorLspAdmissionController({
    maxConnections: 1,
    maxConnectionsPerOwner: 1,
    globalRateLimit: 100,
    ownerRateLimit: 100,
  });
  const ws = new FakeWebSocket();
  const lifecycle = editorLsp.handleEditorLspConnection(ws, {
    url: '/editor-lsp?language=json', headers: { host: 'example.test' },
  }, {
    ownerId: 'owner-timeout', admissionController: admission,
    initializationTimeoutMs: 15, idleTimeoutMs: 1000,
  });
  await delay(40);
  assert.equal(ws.closed.code, 1008);
  assert.equal(lifecycle.signal.aborted, true);
  assert.equal(admission.snapshot('owner-timeout').connections, 0);

  const reconnect = new FakeWebSocket();
  const reconnectLifecycle = editorLsp.handleEditorLspConnection(reconnect, {
    url: '/editor-lsp?language=json', headers: { host: 'example.test' },
  }, {
    ownerId: 'owner-timeout', admissionController: admission,
    initializationTimeoutMs: 1000, idleTimeoutMs: 1000,
  });
  assert.ok(reconnectLifecycle);
  reconnect.close();
  assert.equal(reconnectLifecycle.signal.aborted, true);
  assert.equal(admission.snapshot('owner-timeout').connections, 0);
});

test('open documents suppress idle timeout until the last document closes', async () => {
  const admission = new EditorLspAdmissionController({ globalRateLimit: 100, ownerRateLimit: 100 });
  const ws = new FakeWebSocket();
  const lifecycle = editorLsp.handleEditorLspConnection(ws, {
    url: '/editor-lsp?language=json', headers: { host: 'example.test' },
  }, {
    ownerId: 'owner-idle', admissionController: admission,
    initializationTimeoutMs: 200, idleTimeoutMs: 20,
  });
  ws.emit('message', rpc('initialize', { rootUri: 'file:///', capabilities: {} }, 31));
  ws.emit('message', rpc('initialized', {}));
  const uri = 'file:///workspace/held-open.json';
  ws.emit('message', rpc('textDocument/didOpen', {
    textDocument: { uri, languageId: 'json', version: 1, text: '{}' },
  }));
  await delay(50);
  assert.equal(ws.readyState, ws.OPEN);
  assert.equal(lifecycle.openDocumentCount, 1);
  ws.emit('message', rpc('textDocument/didClose', { textDocument: { uri } }));
  await delay(50);
  assert.equal(ws.closed.code, 1001);
  assert.equal(lifecycle.signal.aborted, true);
  assert.equal(admission.snapshot('owner-idle').connections, 0);
});

test('in-flight requests suppress idle timeout until request settlement', async () => {
  const ws = new FakeWebSocket();
  let terminated = 0;
  const lifecycle = createLspConnectionLifecycle(ws, {
    initializationTimeoutMs: 100,
    idleTimeoutMs: 15,
    onTerminate: () => { terminated += 1; },
  });
  lifecycle.markInitialized();
  const finishRequest = lifecycle.beginRequest();
  await delay(40);
  assert.equal(ws.readyState, ws.OPEN);
  assert.equal(lifecycle.pendingRequests, 1);
  finishRequest();
  await delay(35);
  assert.equal(ws.closed.code, 1001);
  assert.equal(lifecycle.signal.aborted, true);
  assert.equal(terminated, 1);
});

test('Windows child cleanup requests a full process-tree kill', () => {
  let invocation = null;
  let unrefCalled = false;
  killChildProcessTree({ pid: 4321 }, {
    platform: 'win32',
    spawnProcess(command, args, options) {
      invocation = { command, args, options };
      return { unref() { unrefCalled = true; } };
    },
  });
  assert.equal(invocation.command, 'taskkill');
  assert.deepEqual(invocation.args, ['/pid', '4321', '/t', '/f']);
  assert.equal(invocation.options.windowsHide, true);
  assert.equal(unrefCalled, true);
});

test('schema mutation and unknown JSON-RPC methods fail closed', () => {
  const methods = [
    'json/schemaAssociations',
    'json/schema/modify',
    'workspace/didChangeConfiguration',
    'yaml/registerCustomSchemaRequest',
    'yaml/registerContentRequest',
    'yaml/get/jsonSchema',
    'workspace/executeCommand',
    'unknown/method',
  ];
  for (const method of methods) {
    assert.throws(
      () => parseClientMessage(rpc(method, { schemas: { 'http://127.0.0.1/schema': '*.yaml' } }, 7)),
      (error) => error.code === -32601 && error.message === 'Method not found',
      method,
    );
  }
});

test('remote, local-file, UNC and relative YAML schema directives are rejected', () => {
  const schemaUris = [
    'http://127.0.0.1:8123/schema.json',
    'http://169.254.169.254/latest/meta-data/schema',
    'https://metadata.internal/schema.json',
    'https://example.test/redirect-to-private',
    'file:///etc/passwd',
    String.raw`\\server\share\schema.json`,
    '../private/schema.json',
  ];
  for (const schemaUri of schemaUris) {
    assert.throws(
      () => parseClientMessage(didOpen(`# yaml-language-server: $schema=${schemaUri}\nname: value\n`)),
      (error) => error.code === -32602 && error.message === 'Invalid params',
      schemaUri,
    );
  }
});

test('incremental edits cannot assemble a schema modeline across messages', () => {
  const prefix = '# yaml-language-server: $schema=';
  assert.throws(
    () => applyDocumentChanges(prefix, [{
      range: {
        start: { line: 0, character: prefix.length },
        end: { line: 0, character: prefix.length },
      },
      text: 'http://127.0.0.1/schema.json',
    }], 'yaml'),
    (error) => error.code === -32602 && error.message === 'Invalid params',
  );
});

test('external references are rejected outside document URI slots', () => {
  const urls = [
    'http://localhost:3000/schema',
    'http://[::1]/schema',
    'http://169.254.169.254/schema',
    'https://metadata.internal/schema',
    'file:///C:/Windows/win.ini',
    String.raw`\\host\share\schema.json`,
    String.raw`C:\private\schema.json`,
  ];
  for (const value of urls) {
    assert.throws(
      () => parseClientMessage(rpc('textDocument/completion', {
        textDocument: { uri: 'file:///workspace/safe.yaml' },
        position: { line: 0, character: 0 },
        context: { triggerKind: 1, schemaUri: value },
      }, 9)),
      (error) => error.code === -32602,
      value,
    );
  }
  assert.equal(parseClientMessage(didOpen('endpoint: https://api.example.test/v1\n')).method, 'textDocument/didOpen');
});

test('document URIs cannot name remote hosts or UNC paths', () => {
  for (const uri of ['http://127.0.0.1/a.yaml', 'https://example.test/a.yaml', 'file://server/share/a.yaml', String.raw`\\server\share\a.yaml`]) {
    assert.throws(() => parseClientMessage(didOpen('name: safe\n', uri)), (error) => error.code === -32602, uri);
  }
  assert.equal(parseClientMessage(didOpen('name: safe\n', 'file:///workspace/a.yaml')).method, 'textDocument/didOpen');
});

test('prototype pollution keys and resource exhaustion payloads are rejected', () => {
  const polluted = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"__proto__":{"polluted":true}}}';
  assert.throws(() => parseClientMessage(polluted), (error) => error.code === -32602);
  assert.equal({}.polluted, undefined);

  const deeplyNested = {};
  let cursor = deeplyNested;
  for (let index = 0; index < 24; index += 1) cursor = cursor.next = {};
  assert.throws(
    () => parseClientMessage(rpc('initialize', { capabilities: deeplyNested }, 2)),
    (error) => error.code === -32602,
  );
  assert.throws(
    () => parseClientMessage(' '.repeat(MAX_FRAME_BYTES + 1)),
    (error) => error.code === -32600,
  );
});

test('JSON LSP reports diagnostics and completion after a rejected method', async () => {
  const ws = new FakeWebSocket();
  editorLsp.wireJsonLanguageServer(ws);

  ws.emit('message', rpc('initialize', { rootUri: 'file:///', capabilities: {} }, 1));
  const initialized = await waitForMessage(ws, (message) => message.id === 1);
  assert.equal(initialized.result.capabilities.hoverProvider, true);

  ws.emit('message', rpc('workspace/didChangeConfiguration', {
    settings: { yaml: { schemas: { 'http://127.0.0.1/schema': '*.json' } } },
  }, 2));
  const rejected = await waitForMessage(ws, (message) => message.id === 2);
  assert.deepEqual(rejected.error, { code: -32601, message: 'Method not found' });
  assert.equal(ws.readyState, ws.OPEN);

  const uri = 'file:///workspace/test.json';
  ws.emit('message', rpc('textDocument/didOpen', {
    textDocument: { uri, languageId: 'json', version: 1, text: '{"name": }' },
  }));
  const diagnostics = await waitForMessage(ws, (message) => message.method === 'textDocument/publishDiagnostics' && message.params.uri === uri);
  assert.ok(diagnostics.params.diagnostics.length > 0);

  ws.emit('message', rpc('textDocument/completion', {
    textDocument: { uri }, position: { line: 0, character: 1 },
  }, 3));
  const completion = await waitForMessage(ws, (message) => message.id === 3);
  assert.ok(completion.result);
  assert.equal(completion.error, undefined);
});

test('YAML LSP stays usable after rejecting an SSRF schema modeline', { timeout: 20000 }, async () => {
  const ws = new FakeWebSocket();
  editorLsp.startYamlLanguageServer(ws);
  try {
    ws.emit('message', rpc('initialize', { rootUri: 'file:///', capabilities: {} }, 11));
    const initialized = await waitForMessage(ws, (message) => message.id === 11);
    assert.equal(initialized.error, undefined);
    assert.equal(initialized.result.capabilities.completionProvider.resolveProvider, false);
    ws.emit('message', rpc('initialized', {}));

    const blockedUri = 'file:///workspace/blocked.yaml';
    ws.emit('message', didOpen('# yaml-language-server: $schema=http://127.0.0.1:9/redirect\nname: blocked\n', blockedUri));
    assert.equal(ws.readyState, ws.OPEN);

    const safeUri = 'file:///workspace/safe.yaml';
    ws.emit('message', didOpen('name: safe\nitems:\n  - one\n', safeUri));
    const diagnostics = await waitForMessage(ws, (message) => message.method === 'textDocument/publishDiagnostics' && message.params.uri === safeUri);
    assert.ok(Array.isArray(diagnostics.params.diagnostics));
    assert.equal(ws.sent.some((message) => message.method === 'textDocument/publishDiagnostics' && message.params.uri === blockedUri), false);

    ws.emit('message', rpc('textDocument/completion', {
      textDocument: { uri: safeUri }, position: { line: 1, character: 0 },
    }, 12));
    const completion = await waitForMessage(ws, (message) => message.id === 12);
    assert.equal(completion.error, undefined);
    assert.ok(completion.result === null || Array.isArray(completion.result) || Array.isArray(completion.result.items));
  } finally {
    ws.close();
  }
});
