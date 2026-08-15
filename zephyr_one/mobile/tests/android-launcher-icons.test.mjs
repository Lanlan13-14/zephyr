/*
 * The four source icons were committed before Android could select them. This contract pins the
 * complete chain: source palette -> vector -> adaptive icon -> manifest alias -> runtime switch.
 * It is intentionally independent of Gradle so a resource or alias can never disappear unnoticed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MOBILE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(MOBILE_ROOT, 'android/app/src/main');
const RES = path.join(APP, 'res');
const manifest = fs.readFileSync(path.join(APP, 'AndroidManifest.xml'), 'utf8');
const controller = fs.readFileSync(
  path.join(APP, 'kotlin/one/zephyr/mobile/app/LauncherIconController.kt'),
  'utf8',
);
const activity = fs.readFileSync(
  path.join(APP, 'kotlin/one/zephyr/mobile/app/MainActivity.kt'),
  'utf8',
);

const themes = [
  { wire: 'frost', enumName: 'FROST', alias: 'FrostLauncher', resource: 'ic_launcher', colors: ['EEF2F7', 'A8B5C3', '6E7B88', '0A84FF', '8E99A6'] },
  { wire: 'lava', enumName: 'LAVA', alias: 'LavaLauncher', resource: 'ic_launcher_lava', colors: ['F1E8DF', 'C79672', '8D5A3A', 'BF5A1F', 'A58A78'] },
  { wire: 'asagi', enumName: 'ASAGI', alias: 'AsagiLauncher', resource: 'ic_launcher_asagi', colors: ['EDF4F2', '9BBDB5', '5E8F83', '4D9C8A', '829B96'] },
  { wire: 'cyber', enumName: 'CYBER', alias: 'CyberLauncher', resource: 'ic_launcher_cyber', colors: ['EEF3F5', '9EB7BD', '5D858D', '4F9DA6', '7F9298'] },
];

function blockForAlias(alias) {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return manifest.match(new RegExp(`<activity-alias[\\s\\S]*?android:name="\\.app\\.${escaped}"[\\s\\S]*?</activity-alias>`))?.[0];
}

test('manifest exposes exactly four launcher aliases and MainActivity is not a launcher', () => {
  const aliases = [...manifest.matchAll(/<activity-alias\b/g)];
  assert.equal(aliases.length, themes.length);
  const activityBlock = manifest.match(/<activity\b[\s\S]*?android:name="\.app\.MainActivity"[\s\S]*?\/>/)?.[0];
  assert.ok(activityBlock, 'MainActivity must be a non-launcher activity');
  assert.doesNotMatch(activityBlock, /android\.intent\.category\.LAUNCHER/);

  for (const theme of themes) {
    const block = blockForAlias(theme.alias);
    assert.ok(block, `${theme.alias} manifest alias is missing`);
    assert.match(block, /android:targetActivity="\.app\.MainActivity"/);
    assert.match(block, new RegExp(`android:icon="@mipmap/${theme.resource}"`));
    assert.match(block, /android\.intent\.category\.LAUNCHER/);
    assert.match(block, new RegExp(`android:enabled="${theme.wire === 'frost'}"`));
  }
});

test('all adaptive icons carry the matching source palette and monochrome layer', () => {
  for (const theme of themes) {
    const foregroundName = theme.wire === 'frost' ? 'ic_launcher_foreground.xml' : `ic_launcher_foreground_${theme.wire}.xml`;
    const foreground = fs.readFileSync(path.join(RES, 'drawable', foregroundName), 'utf8').toUpperCase();
    for (const color of theme.colors) assert.match(foreground, new RegExp(color), `${theme.wire} is missing #${color}`);

    for (const version of ['mipmap-anydpi-v26', 'mipmap-anydpi-v33']) {
      const adaptive = fs.readFileSync(path.join(RES, version, `${theme.resource}.xml`), 'utf8');
      const expectedForeground = theme.wire === 'frost' ? 'ic_launcher_foreground' : `ic_launcher_foreground_${theme.wire}`;
      assert.match(adaptive, new RegExp(`@drawable/${expectedForeground}`));
      if (version.endsWith('v33')) assert.match(adaptive, /<monochrome android:drawable="@drawable\/ic_launcher_monochrome"/);
    }
  }
});

test('runtime plan maps every theme to one manifest alias', () => {
  for (const theme of themes) {
    assert.match(controller, new RegExp(`${theme.enumName}\\(ZephyrThemeId\\.${theme.enumName}, "one\\.zephyr\\.mobile\\.app\\.${theme.alias}"`));
  }
  assert.match(controller, /setComponentEnabledSettings/);
  assert.match(controller, /setComponentEnabledSetting/);
  assert.match(controller, /launcherIconPlan\(themeId: ZephyrThemeId\)/);
  assert.match(activity, /container\.launcherIcons\.apply\(it\.themeId\)/);
  assert.match(activity, /loadedThemePrefs\?\.let/);
});
