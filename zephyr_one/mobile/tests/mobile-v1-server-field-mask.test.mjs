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
const { PERSONAL_EDITABLE_FIELDS, PERSONAL_OPAQUE_FIELDS } = require(
  path.join(repoRoot, 'personal-settings-section-service.js'),
);
const registry = JSON.parse(fs.readFileSync(
  path.join(here, '..', 'contracts', 'registries', 'entity-registry.json'),
  'utf8',
));
const settingsSpec = registry.entities.find((entity) => entity.type === 'oneUserSettings');

function maskApi() {
  const api = Object.create(MobileV1Api.prototype);
  api.entityByType = new Map([[settingsSpec.type, settingsSpec]]);
  return api;
}

function settingsAdapter(row) {
  return createPersonalEntityAdapters({
    personalSettingsService: {
      list: () => [row],
      read: () => row,
      residency: () => 'owned',
      currentRevision: () => row.revision,
      patchSection: () => row,
      resetSection: () => true,
      restoreSection: () => row,
    },
  }).get('oneUserSettings');
}

test('oneUserSettings adapter can describe opaque downlink fields without emitting them in a mask', () => {
  const row = {
    sectionKey: 'appearance', userId: 'owner-1', revision: 2, updatedAt: 3,
    'appearance.theme': 'dark',
    'appearance.customCss': '.private-theme{}',
  };
  const requested = settingsAdapter(row).fieldMaskOf(row);

  assert.deepEqual(requested, ['appearance.theme', 'appearance.customCss']);
  assert.deepEqual(maskApi().serverFieldMask('oneUserSettings', requested), []);
});

test('pure editable masks remain patches and mixed masks become complete replacement', () => {
  const api = maskApi();

  assert.deepEqual(
    api.serverFieldMask('oneUserSettings', ['appearance.theme', 'appearance.customColors']),
    ['appearance.theme', 'appearance.customColors'],
  );
  assert.deepEqual(
    api.serverFieldMask('oneUserSettings', ['appearance.theme', 'appearance.customCss']),
    [],
  );
  assert.deepEqual(api.serverFieldMask('oneUserSettings', ['unknown.futureField']), []);
  assert.deepEqual(api.serverFieldMask('oneUserSettings', ['appearance.theme', 'appearance.theme']), []);
});

test('personal editable and opaque declarations stay aligned with the frozen registry', () => {
  assert.deepEqual([...PERSONAL_EDITABLE_FIELDS].sort(), [...settingsSpec.editableFields].sort());
  assert.deepEqual([...PERSONAL_OPAQUE_FIELDS].sort(), [...settingsSpec.opaquePreserveFields].sort());
});
