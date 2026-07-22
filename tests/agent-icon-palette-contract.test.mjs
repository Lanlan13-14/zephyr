import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function extractIconPalettes(jsSource) {
  const match = jsSource.match(/const ICON_PALETTES = Object\.freeze\(\{([\s\S]*?)\}\);/);
  assert.ok(match, 'ICON_PALETTES missing from theme-runtime.js');
  // Minimal parse of frost entry colors
  const body = match[1];
  const frost = body.match(/frost:\s*\{([^}]+)\}/);
  assert.ok(frost, 'frost palette missing');
  const get = (key) => {
    const m = frost[1].match(new RegExp(`${key}:\\s*'([^']+)'`));
    assert.ok(m, `frost.${key} missing`);
    return m[1].toLowerCase();
  };
  return {
    main: get('main'),
    mid: get('mid'),
    dark: get('dark'),
    title: get('title'),
    dotA: get('dotA'),
    dotB: get('dotB'),
  };
}

test('agent frost palette matches web ICON_PALETTES', () => {
  const web = fs.readFileSync(path.join(root, 'public/theme-runtime.js'), 'utf8');
  const dart = fs.readFileSync(path.join(root, 'zephyr_agent/lib/theme/zephyr_colors.dart'), 'utf8');
  const logo = fs.readFileSync(path.join(root, 'zephyr_agent/assets/logo/zephyr-logo.svg'), 'utf8');
  const palette = extractIconPalettes(web);

  // Dart Color(0xFFeeF2F7) style
  const toDart = (hex) => `Color(0xFF${hex.slice(1).toUpperCase()})`;
  assert.match(dart, new RegExp(toDart(palette.main).replace(/[()]/g, '\\$&')));
  assert.match(dart, new RegExp(toDart(palette.mid).replace(/[()]/g, '\\$&')));
  assert.match(dart, new RegExp(toDart(palette.dark).replace(/[()]/g, '\\$&')));
  assert.match(dart, new RegExp(toDart(palette.dotA).replace(/[()]/g, '\\$&')));
  assert.match(dart, new RegExp(toDart(palette.dotB).replace(/[()]/g, '\\$&')));

  assert.match(logo, new RegExp(palette.main, 'i'));
  assert.match(logo, new RegExp(palette.mid, 'i'));
  assert.match(logo, new RegExp(palette.dark, 'i'));
  assert.match(logo, new RegExp(palette.dotA, 'i'));
  assert.match(logo, new RegExp(palette.dotB, 'i'));

  // Guard against the old Tailwind sky palette regressing into agent frost.
  assert.doesNotMatch(logo, /#e0f2fe/i);
  assert.doesNotMatch(logo, /#93c5fd/i);
  assert.doesNotMatch(logo, /#60a5fa/i);
});

test('generate_theme_icons script uses web frost stops', () => {
  const src = fs.readFileSync(
    path.join(root, 'zephyr_agent/tool/generate_theme_icons.py'),
    'utf8',
  );
  assert.match(src, /"main": "#eef2f7"/);
  assert.match(src, /"mid": "#a8b5c3"/);
  assert.match(src, /"dark": "#6e7b88"/);
  assert.match(src, /"dotA": "#0a84ff"/);
});
