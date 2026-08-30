import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const require = createRequire(import.meta.url);
const { MobileV1Api } = require(path.join(repoRoot, 'mobile-v1-routes.js'));
const { createPersonalEntityAdapters } = require(path.join(repoRoot, 'mobile-v1-personal-entities.js'));
const registry = JSON.parse(fs.readFileSync(
  path.join(here, '..', 'contracts', 'registries', 'entity-registry.json'),
  'utf8',
));
const spec = registry.entities.find((entity) => entity.type === 'oneUserSettings');
const user = { userId: 'owner-1' };

function apiWith(row) {
  const service = {
    list: () => [row], read: () => row, residency: () => 'owned',
    currentRevision: () => row.revision, patchSection: () => row,
    resetSection: () => true, restoreSection: () => row,
  };
  const api = Object.create(MobileV1Api.prototype);
  api.entityByType = new Map([['oneUserSettings', spec]]);
  api.adapters = createPersonalEntityAdapters({ personalSettingsService: service });
  return api;
}

function change(fieldMask) {
  return {
    changeSeq: 1,
    entityType: 'oneUserSettings',
    entityId: 'appearance',
    action: 'upsert',
    revision: 2,
    actorDeviceId: null,
    changedAt: 3,
    fieldMask,
  };
}

test('changes with mixed editable and opaque fields become a complete canonical replacement', () => {
  const row = {
    sectionKey: 'appearance', userId: user.userId, revision: 2, updatedAt: 3,
    'appearance.theme': 'dark',
    'appearance.customCss': '.private-theme{}',
  };
  const hydrated = apiWith(row).hydrateChange(
    user,
    change(['appearance.theme', 'appearance.customCss']),
  );

  assert.deepEqual(hydrated.fieldMask, []);
  assert.equal(hydrated.payload['appearance.theme'], 'dark');
  assert.equal(hydrated.payload['appearance.customCss'], '.private-theme{}');
});

test('changes with an editable-only field retain patch semantics', () => {
  const row = {
    sectionKey: 'appearance', userId: user.userId, revision: 2, updatedAt: 3,
    'appearance.theme': 'dark',
  };
  const hydrated = apiWith(row).hydrateChange(user, change(['appearance.theme']));

  assert.deepEqual(hydrated.fieldMask, ['appearance.theme']);
});
