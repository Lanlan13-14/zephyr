import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { projectPayload } = require(path.join(root, 'mobile-v1-entities.js'));

const registry = JSON.parse(fs.readFileSync(
  path.join(root, 'zephyr_one', 'mobile', 'contracts', 'registries', 'entity-registry.json'),
  'utf8',
));
const spec = registry.entities.find((entity) => entity.type === 'connection');

test('owned-sync wire turns empty sshKeyId TEXT into JSON null', () => {
  const wire = projectPayload(spec, {
    id: 'c-1',
    ownerUserId: 'alice',
    name: 'Yunyo FRA',
    host: '10.0.0.1',
    port: 22,
    protocol: 'SSH',
    username: 'root',
    password: '',
    privateKey: '',
    sshKeyId: '',
    proxyId: '',
    jumpHostId: '   ',
    jumpHostIds: [],
    connectionMode: 'direct',
  });
  assert.equal(wire.sshKeyId, null);
  assert.equal(wire.proxyId, null);
  assert.equal(wire.jumpHostId, null);
  assert.equal(wire.password, undefined);
  assert.equal(wire.hasPassword, false);
});

test('owned-sync wire keeps a real sshKeyId', () => {
  const wire = projectPayload(spec, {
    id: 'c-1',
    ownerUserId: 'alice',
    name: 'Yunyo FRA',
    host: '10.0.0.1',
    protocol: 'SSH',
    sshKeyId: 'key-1',
    password: 'secret',
  });
  assert.equal(wire.sshKeyId, 'key-1');
  assert.equal(wire.hasPassword, true);
  assert.equal(wire.password, undefined);
});
