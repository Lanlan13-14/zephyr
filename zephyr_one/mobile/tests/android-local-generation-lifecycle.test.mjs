import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mobile = path.resolve(here, '..');
const read = (rel) => fs.readFileSync(path.join(mobile, rel), 'utf8');

test('binding preserves local fallback and erased legacy generation self-heals', () => {
  const coordinator = read('android/app/src/main/kotlin/one/zephyr/mobile/app/binding/BindingCoordinator.kt');
  const container = read('android/app/src/main/kotlin/one/zephyr/mobile/app/di/AppContainer.kt');

  assert.match(coordinator, /previous != null && !previous\.isDeviceLocal/);
  assert.match(container, /KEY_LOCAL_WORKSPACE_GENERATION/);
  assert.match(container, /boundAt = localWorkspaceGeneration\(\)/);
  assert.match(container, /account database generation has been erased/);
  assert.match(container, /binding = rotateLocalWorkspaceGeneration\(\)/);
  assert.match(container, /preferences\.edit\(\)[\s\S]*putLong\(KEY_LOCAL_WORKSPACE_GENERATION, generation\)[\s\S]*commit\(\)/);
});
