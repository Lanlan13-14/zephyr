import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeServerUrl, agentWebSocketUriForServerUrl } from '../src/js/agent/url.js';

// Minimal localStorage polyfill for token-backup module under node:test
if (!globalThis.localStorage) {
  const map = new Map();
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  };
}

const { addLocalToken, listLocalTokens, exportLocalTokens, importLocalTokensJson, removeLocalToken } =
  await import('../src/js/agent/token-backup.js');

test('normalizeServerUrl strips path and upgrades scheme', () => {
  assert.equal(normalizeServerUrl('wss://ssh.example.com/agent'), 'https://ssh.example.com');
  assert.equal(normalizeServerUrl('ws://10.0.0.1:3000/'), 'http://10.0.0.1:3000');
  assert.equal(normalizeServerUrl('ssh.example.com'), 'https://ssh.example.com');
  assert.equal(normalizeServerUrl('https://ssh.example.com/app/'), 'https://ssh.example.com');
});

test('agent websocket path is /agent/files', () => {
  assert.equal(
    agentWebSocketUriForServerUrl('https://ssh.example.com'),
    'wss://ssh.example.com/agent/files',
  );
  assert.equal(
    agentWebSocketUriForServerUrl('http://127.0.0.1:3000'),
    'ws://127.0.0.1:3000/agent/files',
  );
});

test('token backup mutual format roundtrip', () => {
  localStorage.clear();
  addLocalToken({ token: 'tok_abc123456789', name: 'Device A' });
  addLocalToken({ token: 'tok_xyz987654321', name: 'Device B' });
  assert.equal(listLocalTokens().length, 2);
  const json = exportLocalTokens();
  const parsed = JSON.parse(json);
  assert.equal(parsed.version, 2);
  assert.equal(parsed.source, 'zephyr-one');
  assert.equal(parsed.tokens.length, 2);

  localStorage.clear();
  const n = importLocalTokensJson(json);
  assert.equal(n, 2);
  assert.equal(listLocalTokens().length, 2);

  // Server-style agent-tokens.json
  localStorage.clear();
  const serverShape = {
    version: 2,
    tokens: [{ id: 'tok_1', ownerId: 'admin', name: '默认 Token', token: 'server_token_value', createdAt: 1, updatedAt: 1 }],
  };
  assert.equal(importLocalTokensJson(JSON.stringify(serverShape)), 1);
  assert.equal(listLocalTokens()[0].token, 'server_token_value');

  removeLocalToken(listLocalTokens()[0].id);
  assert.equal(listLocalTokens().length, 0);
});
