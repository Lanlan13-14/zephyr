/*
 * Android Adaptive Icon contract for Zephyr Agent.
 * Pins the complete chain: source palette -> vector foregrounds -> adaptive icons (v26 & v33)
 * -> monochrome layer -> manifest alias -> safe-zone compliance (no abnormal magnification).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AGENT = path.join(root, 'zephyr_agent');
const ANDROID_RES = path.join(AGENT, 'platform_assets/android/res');
const PREPARE_SCRIPT = path.join(AGENT, 'tool/prepare_android.sh');

const themes = [
  { wire: 'frost', alias: 'LauncherFrost', resource: 'ic_launcher_frost', colors: ['EEF2F7', 'A8B5C3', '6E7B88', '0A84FF'] },
  { wire: 'lava', alias: 'LauncherLava', resource: 'ic_launcher_lava', colors: ['F1E8DF', 'C79672', '8D5A3A', 'BF5A1F'] },
  { wire: 'asagi', alias: 'LauncherAsagi', resource: 'ic_launcher_asagi', colors: ['EDF4F2', '9BBDB5', '5E8F83', '4D9C8A'] },
  { wire: 'cyber', alias: 'LauncherCyber', resource: 'ic_launcher_cyber', colors: ['EEF3F5', '9EB7BD', '5D858D', '4F9DA6'] },
];

test('prepare_android.sh installs adaptive icon assets and defines exactly four launcher aliases', () => {
  const script = fs.readFileSync(PREPARE_SCRIPT, 'utf8');

  // Must copy adaptive icon resources into android res
  assert.match(script, /cp\s+-r\s+platform_assets\/android\/res\/\*\s+android\/app\/src\/main\/res\//);

  // MainActivity must not have launcher filter
  assert.match(script, /android\.intent\.category\.LAUNCHER/);

  for (const theme of themes) {
    assert.match(script, new RegExp(`android:name="\\.${theme.alias}"`));
    assert.match(script, new RegExp(`android:icon="@mipmap/${theme.resource}"`));
    assert.match(script, new RegExp(`android:roundIcon="@mipmap/${theme.resource}_round"`));
  }
});

test('all agent adaptive icons carry the matching source palette and monochrome layer', () => {
  for (const theme of themes) {
    const foregroundName = `ic_launcher_foreground_${theme.wire}.xml`;
    const foregroundPath = path.join(ANDROID_RES, 'drawable', foregroundName);
    assert.ok(fs.existsSync(foregroundPath), `missing ${foregroundPath}`);

    const foreground = fs.readFileSync(foregroundPath, 'utf8').toUpperCase();
    assert.match(foreground, /<VECTOR/);
    assert.match(foreground, /ANDROID:WIDTH="108DP"/);
    assert.match(foreground, /ANDROID:HEIGHT="108DP"/);
    assert.match(foreground, /ANDROID:VIEWPORTWIDTH="200"/);
    assert.match(foreground, /ANDROID:VIEWPORTHEIGHT="200"/);

    // Scale must be 0.7 to fit inside 66dp safe zone (avoid abnormal zoom)
    assert.match(foreground, /SCALEX="0.7"/);
    assert.match(foreground, /SCALEY="0.7"/);
    assert.match(foreground, /PIVOTX="100"/);
    assert.match(foreground, /PIVOTY="100"/);

    // Foreground must be transparent-backed (no full-bleed plate rect)
    assert.doesNotMatch(foreground, /<RECT/);

    for (const color of theme.colors) {
      assert.match(foreground, new RegExp(color), `${theme.wire} is missing #${color}`);
    }

    for (const version of ['mipmap-anydpi-v26', 'mipmap-anydpi-v33']) {
      for (const suffix of ['', '_round']) {
        const adaptiveFile = path.join(ANDROID_RES, version, `${theme.resource}${suffix}.xml`);
        assert.ok(fs.existsSync(adaptiveFile), `missing ${adaptiveFile}`);
        const adaptive = fs.readFileSync(adaptiveFile, 'utf8');

        assert.match(adaptive, /<background\s+android:drawable="@color\/ic_launcher_background"/);
        assert.match(adaptive, new RegExp(`<foreground\\s+android:drawable="@drawable/${foregroundName.replace('.xml', '')}"`));

        if (version === 'mipmap-anydpi-v33') {
          assert.match(adaptive, /<monochrome\s+android:drawable="@drawable\/ic_launcher_monochrome"/);
        }
      }
    }
  }

  // Monochrome drawable exists and is vector
  const monoPath = path.join(ANDROID_RES, 'drawable/ic_launcher_monochrome.xml');
  assert.ok(fs.existsSync(monoPath), 'missing ic_launcher_monochrome.xml');
  const mono = fs.readFileSync(monoPath, 'utf8');
  assert.match(mono, /<vector/);
  assert.match(mono, /scaleX="0.7"/);

  // Background values exist
  const bgLight = fs.readFileSync(path.join(ANDROID_RES, 'values/ic_launcher_background.xml'), 'utf8');
  assert.match(bgLight, /#FFFFFFFF/i);

  const bgDark = fs.readFileSync(path.join(ANDROID_RES, 'values-night/colors.xml'), 'utf8');
  assert.match(bgDark, /#FF10151C/i);
});

test('agent adaptive icon geometry fits comfortably inside 33dp radius safe zone', () => {
  // Cubic bezier evaluation
  function bezier(p0, p1, p2, p3, t) {
    return [
      (1 - t) ** 3 * p0[0] + 3 * (1 - t) ** 2 * t * p1[0] + 3 * (1 - t) * t ** 2 * p2[0] + t ** 3 * p3[0],
      (1 - t) ** 3 * p0[1] + 3 * (1 - t) ** 2 * t * p1[1] + 3 * (1 - t) * t ** 2 * p2[1] + t ** 3 * p3[1],
    ];
  }

  const pts = [];
  // Path 1
  for (let i = 0; i <= 50; i++) {
    const t = i / 50;
    pts.push([...bezier([43, 64], [84, 44], [138, 52], [160, 77], t), 5.0]);
    pts.push([...bezier([160, 77], [148, 94], [108, 104], [76, 123], t), 5.0]);
  }
  // Path 2
  for (let i = 0; i <= 50; i++) {
    const t = i / 50;
    pts.push([...bezier([49, 76], [89, 74], [126, 89], [145, 115], t), 3.0]);
    pts.push([...bezier([145, 115], [120, 134], [76, 153], [40, 135], t), 3.0]);
  }
  // Path 3
  for (let i = 0; i <= 50; i++) {
    const t = i / 50;
    pts.push([...bezier([80, 92], [108, 108], [137, 135], [162, 129], t), 1.75]);
  }
  // Focal dot
  pts.push([145, 115, 4.5]);

  const scale = 0.7;
  let maxDistDp = 0;
  for (const [x, y, r] of pts) {
    const sx = 100 + (x - 100) * scale;
    const sy = 100 + (y - 100) * scale;
    const dpX = sx * 0.54;
    const dpY = sy * 0.54;
    const dpR = r * scale * 0.54;
    const dist = Math.hypot(dpX - 54, dpY - 54) + dpR;
    if (dist > maxDistDp) maxDistDp = dist;
  }

  // Maximum distance must be strictly less than 33dp with at least 4dp safety margin
  assert.ok(maxDistDp < 30.0, `Farthest icon point is ${maxDistDp}dp from center, exceeding 30dp limit`);
  assert.ok(33.0 - maxDistDp >= 5.0, `Safe zone clearance must be >= 5dp, got ${33.0 - maxDistDp}dp`);
});
