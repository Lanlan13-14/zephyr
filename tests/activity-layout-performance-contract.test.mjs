import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
test('activity cards skip off-screen layout and avoid per-item entrances', () => {
  const block = /\.activity-detail-item\s*\{([^}]*)\}/.exec(css)?.[1] || '';
  assert.match(block, /animation:\s*none/);
  assert.match(block, /content-visibility:\s*auto/);
  assert.match(block, /contain-intrinsic-size:\s*auto 180px/);
});
