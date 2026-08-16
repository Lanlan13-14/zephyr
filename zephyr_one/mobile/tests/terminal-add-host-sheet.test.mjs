import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mobile = path.resolve(here, '..');
const read = (relative) => fs.readFileSync(path.join(mobile, relative), 'utf8');

function blockAt(source, marker) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing ${marker}`);
  const brace = source.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(brace + 1, i);
    }
  }
  assert.fail(`unterminated ${marker}`);
}

function assertTerminalAddHost({ screen, root, zh, sftp }) {
  const overlay = blockAt(screen, 'Box(Modifier.fillMaxSize()) {');
  assert.match(overlay, /BoxWithConstraints\(Modifier\.fillMaxSize\(\)\.background\(colors\.termBg\)\)/,
    'terminal content must remain the base layer');
  assert.match(overlay, /ActionSheet\([\s\S]*?visible\s*=\s*ws\.addSheetOpen/,
    'the add-host sheet must be inside the same full-screen Box, above terminal content');
  assert.match(screen, /openConnectionIds[\s\S]*?it\.connectionId[\s\S]*?connection\.id !in openConnectionIds/,
    'the picker must offer only terminal connections not already open');
  assert.match(screen, /items\s*=\s*addableConnections\.map/,
    'the sheet rows must use the filtered host list');
  assert.match(root, /onAddSession\s*=\s*\{\s*connection\s*->[\s\S]*?routeForProtocol\(UUID\.randomUUID\(\)\.toString\(\), connection\.id, connection\.protocol\)/,
    'selecting a host must create and navigate to a real new terminal session');
  assert.match(zh, /<string name="terminal_new_session_title">再开一台主机<\/string>/,
    'terminal and SFTP must use the same add-host title');
  assert.match(sftp, /ActionSheet\([\s\S]*?title\s*=\s*"再开一台主机"/,
    'terminal behavior is intentionally aligned with the SFTP host picker');
}

test('terminal plus overlays the SFTP-style add-host picker', () => {
  assertTerminalAddHost({
    screen: read('android/feature-sessions/src/main/kotlin/one/zephyr/mobile/feature/sessions/TerminalScreen.kt'),
    root: read('android/app/src/main/kotlin/one/zephyr/mobile/app/ZephyrOneRoot.kt'),
    zh: read('android/feature-sessions/src/main/res/values/strings.xml'),
    sftp: read('android/feature-notes/src/main/kotlin/one/zephyr/mobile/feature/notes/SnippetScreens.kt'),
  });
});

test('terminal plus guard rejects the pre19 below-screen sheet', () => {
  const current = {
    screen: read('android/feature-sessions/src/main/kotlin/one/zephyr/mobile/feature/sessions/TerminalScreen.kt'),
    root: read('android/app/src/main/kotlin/one/zephyr/mobile/app/ZephyrOneRoot.kt'),
    zh: read('android/feature-sessions/src/main/res/values/strings.xml'),
    sftp: read('android/feature-notes/src/main/kotlin/one/zephyr/mobile/feature/notes/SnippetScreens.kt'),
  };
  assert.throws(
    () => assertTerminalAddHost({ ...current, screen: current.screen.replace('Box(Modifier.fillMaxSize()) {', 'Column(Modifier.fillMaxSize()) {') }),
    /missing Box\(Modifier\.fillMaxSize/,
  );
  assert.throws(
    () => assertTerminalAddHost({ ...current, screen: current.screen.replace('items = addableConnections.map', 'items = connections.map') }),
    /filtered host list/,
  );
});
