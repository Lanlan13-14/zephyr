import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mobile = path.resolve(here, '..');
const read = (relative) => fs.readFileSync(path.join(mobile, relative), 'utf8');

function assertAiToggleGuard({ host, root }) {
  assert.match(host, /account\.localAi\.observe\(\)\.collectAsState\([\s\S]*?LocalAiCatalog\(enabled = false\)/,
    'AI overlay must observe the authoritative local catalog fail-closed');
  assert.match(host, /AiWorkspaceBinding\.chrome\(prefs, catalog\.enabled\)/,
    'AI chrome must combine legacy preferences with the catalog switch');
  assert.match(host, /enabled\s*=\s*catalogEnabled\s*&&\s*flag\(prefs, SettingsRepository\.PREF_AI_ENABLED, true\)/,
    'a disabled catalog must never be overridden by a stale preference');
  assert.match(host, /if\s*\(!chrome\.enabled\)\s*return[\s\S]*?val runtime = remember\(account\)/,
    'disabled AI must leave composition before the FAB/runtime are constructed');
  assert.match(root, /account\.localAi\.observe\(\)\.collectAsState[\s\S]*?AiWorkspaceBinding\.settingsSummary\(prefs, localAiCatalog\.enabled\)/,
    'the tools summary must report the same authoritative switch');
}

test('disabling local AI removes its floating button and runtime', () => {
  assertAiToggleGuard({
    host: read('android/app/src/main/kotlin/one/zephyr/mobile/app/AiWorkspaceHost.kt'),
    root: read('android/app/src/main/kotlin/one/zephyr/mobile/app/ZephyrOneRoot.kt'),
  });
});

test('AI toggle guard rejects the stale pre19 preference-only wiring', () => {
  const current = {
    host: read('android/app/src/main/kotlin/one/zephyr/mobile/app/AiWorkspaceHost.kt'),
    root: read('android/app/src/main/kotlin/one/zephyr/mobile/app/ZephyrOneRoot.kt'),
  };
  assert.throws(
    () => assertAiToggleGuard({ ...current, host: current.host.replace('if (!chrome.enabled) return', '') }),
    /must leave composition/,
  );
  assert.throws(
    () => assertAiToggleGuard({ ...current, host: current.host.replace('catalogEnabled && ', '') }),
    /must never be overridden/,
  );
});
