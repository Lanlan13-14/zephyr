import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');

// Last top-level declaration wins in the cascade. Media-query copies of the same
// selector are narrowed screens only and must not count as the desktop rule.
function block(selector) {
  const found = [];
  const re = new RegExp(`(^|\\n)[ \\t]*${selector.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*\\{`, 'g');
  for (const hit of css.matchAll(re)) {
    const open = hit.index + hit[0].lastIndexOf('{');
    const before = css.slice(0, open);
    const depth = (before.match(/\{/g) || []).length - (before.match(/\}/g) || []).length;
    if (depth !== 0) continue;
    found.push(css.slice(open + 1, css.indexOf('}', open)));
  }
  assert.ok(found.length, `missing top-level rule ${selector}`);
  return found[found.length - 1];
}

test('dashboard filters share one height and never use fixed tracks', () => {
  const bar = block('.action-bar');
  assert.match(bar, /minmax\(0,\s*1fr\)\s+repeat\(3,\s*minmax\(132px,\s*180px\)\)/);
  assert.doesNotMatch(bar, /140px\s+140px\s+150px/);
  const trigger = block('.action-bar .ui-toggle-select-trigger');
  assert.match(trigger, /height:\s*44px/);
  assert.match(trigger, /white-space:\s*nowrap/);
  const floor = block('.action-bar .search-input,\n.action-bar .ui-toggle-select,\n.action-bar select');
  assert.match(floor, /min-height:\s*44px/);
});

test('connection cards wrap their actions instead of clipping them', () => {
  const grid = block('.connection-grid');
  assert.match(grid, /minmax\(min\(100%,\s*320px\),\s*1fr\)/);
  const row = block('.card-actions');
  assert.match(row, /flex-wrap:\s*wrap/);
  assert.match(row, /min-width:\s*0/);
  // .tool-btn later in the file forces min-width:max-content for the terminal
  // toolbar, so the card override must be the LAST .card-actions .tool-btn rule.
  const action = block('.card-actions .tool-btn');
  assert.match(action, /flex:\s*1\s+1\s+auto/);
  assert.match(action, /min-width:\s*max-content/);
  assert.match(action, /max-width:\s*100%/);
  assert.match(action, /overflow:\s*visible/);
  const connect = block('.card-actions .btn');
  assert.match(connect, /flex:\s*1\.4\s+1\s+auto/);
  assert.match(connect, /min-width:\s*max-content/);
  assert.match(connect, /overflow:\s*visible/);
  assert.doesNotMatch(connect, /text-overflow:\s*ellipsis/);
});

test('the add-connection button keeps its designed sizing', () => {
  const rules = [...css.matchAll(/(^|\n)[ \t]*(\.add-btn|#view-dashboard \.add-btn)\s*\{([^}]*)\}/g)]
    .map((m) => `${m[2]} {${m[3].trim()}}`);
  assert.deepEqual(rules, [
    '.add-btn {width: auto; min-width: 150px;}',
    '.add-btn {width: 100%;}',
  ]);
});
