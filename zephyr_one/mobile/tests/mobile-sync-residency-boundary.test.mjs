import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..', '..');
const mobile = path.resolve(here, '..');
const read = (base, relative) => fs.readFileSync(path.join(base, relative), 'utf8');

test('owned opaque values travel in canonical payload but never editable field masks', () => {
  const routes = read(repo, 'mobile-v1-routes.js');
  const fixture = JSON.parse(read(mobile, 'android/core-network/src/test/resources/production-sync-wire.json'));
  const settings = fixture.bootstrap.entities.find((change) => change.entityType === 'oneUserSettings');

  assert.match(routes, /return requiresFullReplacement \? \[\] : accepted/);
  assert.ok(settings.payload['appearance.customCss']);
  assert.deepEqual(settings.fieldMask, []);
});

test('shared-to-me stays online memory-only and provider credentials stay on main end', () => {
  const sharedStore = read(mobile, 'android/core-data/src/main/kotlin/one/zephyr/mobile/data/repository/SharedResourceStore.kt');
  const aiFactory = read(mobile, 'android/app/src/main/kotlin/one/zephyr/mobile/app/AiRuntimeControllerFactory.kt');
  const aiRoute = read(repo, 'ai-agent-service.js');

  assert.doesNotMatch(sharedStore, /androidx\.room|SharedPreferences|java\.io\.File/);
  assert.match(aiFactory, /else \{[\s\S]*AndroidAiRuntimeController/);
  assert.match(aiRoute, /if \(!req\.mobileDevice\) return res\.json\(\{ providers \}\)/);
  assert.match(aiRoute, /Runtime configuration and every credential-like/);
});
