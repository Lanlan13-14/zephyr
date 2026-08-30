import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const require = createRequire(import.meta.url);
const { createDatabase } = require(path.join(repoRoot, 'sqlite-driver.js'));
const { MobileV1Api } = require(path.join(repoRoot, 'mobile-v1-routes.js'));
const { MobileV1Store } = require(path.join(repoRoot, 'mobile-v1-store.js'));
const { createPersonalEntityAdapters } = require(path.join(repoRoot, 'mobile-v1-personal-entities.js'));
const registry = JSON.parse(fs.readFileSync(
  path.join(here, '..', 'contracts', 'registries', 'entity-registry.json'),
  'utf8',
));
const spec = registry.entities.find((entity) => entity.type === 'oneUserSettings');
const user = { userId: 'owner-1', username: 'owner' };
const device = { device_id: 'device-1', owner_user_id: user.userId, refresh_generation: 1 };

function response() {
  return {
    statusCode: 200, body: null,
    status(value) { this.statusCode = value; return this; },
    setHeader() {},
    json(value) { this.body = value; return value; },
  };
}

function bootstrap(row) {
  const db = createDatabase(':memory:', { forceBuiltin: true });
  const store = new MobileV1Store({ db, entityRegistry: registry });
  store._hmacKey = Buffer.alloc(32, 0x71);
  const service = {
    list: () => [row], read: () => row, residency: () => 'owned',
    currentRevision: () => row.revision, patchSection: () => row,
    resetSection: () => true, restoreSection: () => row,
  };
  const api = Object.create(MobileV1Api.prototype);
  api.requireDevice = () => ({ user, device });
  api.bootstrapTypes = ['oneUserSettings'];
  api.entityByType = new Map([['oneUserSettings', spec]]);
  api.adapters = createPersonalEntityAdapters({ personalSettingsService: service });
  api.store = store;
  const res = response();
  api.handleBootstrap({ mobileRequestId: 'request-1', query: {} }, res);
  try { return res; } finally { try { db.close(); } catch {} }
}

test('bootstrap with opaque personal settings emits a client-valid complete replacement', () => {
  const res = bootstrap({
    sectionKey: 'appearance', userId: user.userId, revision: 3, updatedAt: 4,
    'appearance.theme': 'dark',
    'appearance.customCss': '.private-theme{}',
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.complete, true);
  assert.equal(res.body.entities.length, 1);
  assert.deepEqual(res.body.entities[0].fieldMask, []);
  assert.equal(res.body.entities[0].payload['appearance.theme'], 'dark');
  assert.equal(res.body.entities[0].payload['appearance.customCss'], '.private-theme{}');
});

test('bootstrap with editable-only personal settings retains the exact editable patch mask', () => {
  const res = bootstrap({
    sectionKey: 'appearance', userId: user.userId, revision: 3, updatedAt: 4,
    'appearance.theme': 'dark',
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.entities[0].fieldMask, ['appearance.theme']);
});
