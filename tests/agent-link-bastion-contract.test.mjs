import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('Agent bastion advertisement is explicit and disabled by default', () => {
  const state = read('zephyr_agent/lib/agent/agent_state.dart');
  const controller = read('zephyr_agent/lib/agent/agent_controller.dart');
  const manager = read('file-agent-manager.js');
  const ui = read('zephyr_agent/lib/screens/home_screen.dart');
  assert.match(state, /bastionEnabled = false/);
  assert.match(state, /json\['bastionEnabled'\] as bool\? \?\? false/);
  assert.match(controller, /'bastion': _config\.bastionEnabled/);
  assert.match(manager, /'bastion'/);
  assert.match(manager, /listBastionAgentsForUser/);
  assert.match(manager, /GET \/api\/rdp\/agent-bastions/);
  assert.match(ui, /作为跳板机/);
});

test('bastion candidate listing remains owner-scoped and online-only', () => {
  const manager = read('file-agent-manager.js');
  assert.match(manager, /listAgentsForUser\(ownerId\)\.filter/);
  assert.match(manager, /agent\.capabilities\?\.bastion === true/);
  assert.match(manager, /agent\.bastionEnabled === true/);
});
