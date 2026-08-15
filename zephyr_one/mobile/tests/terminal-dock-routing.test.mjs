/*
 * assemblePrerelease died in ZephyrOneRoot.onTerminalDock:
 *   'when' expression must be exhaustive. Add the 'COPY', 'PASTE', 'STATS', 'THEME' branches
 *   Unresolved reference 'SESSIONS'
 *
 * The dock enum moved to the demo 9-item set. The host mapper must stay exhaustive on that set
 * and must not mention the deleted SESSIONS entry. This is the cheap half; the JVM test in
 * :app asserts the runtime mapping.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ANDROID = path.join(ROOT, 'android');

const read = (rel) => fs.readFileSync(path.join(ANDROID, rel), 'utf8');

function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
}

function enumEntries(source, name) {
  const match = source.match(new RegExp(`enum class ${name}\\s*\\{([\\s\\S]*?);`));
  assert.ok(match, name + ' enum must exist');
  return [...match[1].matchAll(/\b([A-Z][A-Z0-9_]*)\b/g)].map((m) => m[1]);
}

const dockSource = read(
  'feature-sessions/src/main/kotlin/one/zephyr/mobile/feature/sessions/TerminalViewModel.kt',
);
const rootSource = read('app/src/main/kotlin/one/zephyr/mobile/app/ZephyrOneRoot.kt');
const routesSource = read(
  'feature-sessions/src/main/kotlin/one/zephyr/mobile/feature/sessions/SessionRoutes.kt',
);

const dockItems = enumEntries(dockSource, 'TerminalDockItem');

test('the demo dock is the nine-item set, not the old SESSIONS row', () => {
  assert.deepEqual(dockItems, [
    'KEYBOARD',
    'COPY',
    'PASTE',
    'FILES',
    'SNIPPETS',
    'NOTES',
    'STATS',
    'THEME',
    'DISCONNECT',
  ]);
});

test('the host mapper names every dock item and never SESSIONS', () => {
  const mapper = codeOnly(rootSource).match(
    /internal fun terminalDockLeave\(item: TerminalDockItem\): TerminalDockLeave = when \(item\) \{([\s\S]*?)\n\}/,
  );
  assert.ok(mapper, 'terminalDockLeave must be an exhaustive when on TerminalDockItem');
  for (const item of dockItems) {
    assert.match(mapper[1], new RegExp(`TerminalDockItem\\.${item}\\b`), item);
  }
  assert.doesNotMatch(codeOnly(rootSource), /TerminalDockItem\.SESSIONS/);
});

test('ExtraKeys tool actions open the in-session workspace first', () => {
  const clean = codeOnly(routesSource);
  assert.match(clean, /openDockTool\(/);
  assert.match(clean, /TerminalWorkspace\.openTool/);
  assert.match(clean, /TerminalAction\.toDockItem/);
});

test('the previous SESSIONS-only when fails this suite', () => {
  const broken = `
    when (item) {
        TerminalDockItem.SESSIONS -> navigate(RootRoute.Root(IslandDestination.SESSIONS))
        TerminalDockItem.FILES -> navigate(RootRoute.Files)
        TerminalDockItem.SNIPPETS -> navigate(RootRoute.Snippets)
        TerminalDockItem.NOTES -> navigate(RootRoute.Notes)
        TerminalDockItem.KEYBOARD, TerminalDockItem.DISCONNECT -> Unit
    }
  `;
  assert.match(broken, /TerminalDockItem\.SESSIONS/);
  for (const missing of ['COPY', 'PASTE', 'STATS', 'THEME']) {
    assert.doesNotMatch(broken, new RegExp(`TerminalDockItem\\.${missing}\\b`));
  }
  assert.throws(() => {
    if (/TerminalDockItem\.SESSIONS/.test(broken) || !/TerminalDockItem\.COPY/.test(broken)) {
      throw new Error('when is not exhaustive');
    }
  }, /not exhaustive/);
});
