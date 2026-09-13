import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('FileBridge never falls back to legacy Agent WebSocket RPC', () => {
  const src = read('link-v2-file-bridge.js');
  assert.match(src, /callLinkFileBridge/);
  assert.doesNotMatch(src, /callAgentV2/);
  assert.match(src, /agent_link_required/);
});

test('FileBridge remains on the registered Link business kind', () => {
  const go = read('zephyr-link/internal/link/filebridge.go');
  const codec = read('zephyr-link/internal/codec/codec.go');
  assert.match(go, /Register\(codec\.KindFileBridge/);
  assert.match(codec, /KindFileBridge\s*=\s*10/);
  assert.match(codec, /ChannelFileBridge/);
});
