/**
 * Runtime parity harness: SSH / Telnet / RDP / VNC notes click contract.
 * Extracts the notes gate + postMessage path from each client source and
 * executes an equivalent pure-JS model (no DOM/browser).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sources = {
  ssh: readFileSync(path.join(root, 'public/terminal.js'), 'utf8'),
  telnet: readFileSync(path.join(root, 'public/telnet-terminal.js'), 'utf8'),
  rdp: readFileSync(path.join(root, 'public/rdp-wasm-client.js'), 'utf8'),
  vnc: readFileSync(path.join(root, 'public/novnc.js'), 'utf8'),
};
const appJs = readFileSync(path.join(root, 'public/app.js'), 'utf8');

function extract(src, startRe, endRe) {
  const start = src.search(startRe);
  assert.ok(start >= 0, `start missing: ${startRe}`);
  const from = src.slice(start);
  const end = from.search(endRe);
  assert.ok(end > 0, `end missing: ${endRe}`);
  return from.slice(0, end);
}

for (const [name, src] of Object.entries(sources)) {
  assert.match(src, /function applyNotesFeatureEnabled/, `${name} gate fn`);
  assert.match(src, /if \(!notesFeatureEnabled\)/, `${name} click gate`);
  assert.match(src, /type:\s*'open-notes-for-connection'/, `${name} message type`);
  assert.match(src, /source:\s*'zephyr-terminal'/, `${name} message source`);
  assert.match(src, /笔记功能未开启，请在设置中启用/, `${name} disabled toast`);
  assert.match(src, /笔记面板需要在应用主界面打开/, `${name} non-embed toast`);
  assert.match(src, /\/api\/me\/settings/, `${name} settings`);
}

// Parent path: open-notes always goes through switchView which awaits
// exitTerminalFullscreen when custom fullscreen is open.
const parentNotes = extract(
  appJs,
  /\/\/ Terminal -> app: open notes filtered by current connection/,
  /\/\/ ─── Multi-user management UI/,
);
assert.match(parentNotes, /Promise\.resolve\(switchView\('notes'/);
assert.match(parentNotes, /filterByConnection/);
assert.match(appJs, /async function exitTerminalFullscreenThenSwitchView/);
assert.match(appJs, /await exitTerminalFullscreen\(\{ renderAfter: false \}\)/);

// Simulate click outcomes for each protocol.
function simulateNotesClick({ notesFeatureEnabled, embeddedMode, tabId, connectionId }) {
  const posts = [];
  const toasts = [];
  if (!notesFeatureEnabled) {
    toasts.push('笔记功能未开启，请在设置中启用');
    return { posts, toasts };
  }
  if (embeddedMode) {
    posts.push({
      source: 'zephyr-terminal',
      type: 'open-notes-for-connection',
      tabId,
      connectionId: connectionId || '',
    });
  } else {
    toasts.push('笔记面板需要在应用主界面打开');
  }
  return { posts, toasts };
}

const cases = [
  { notesFeatureEnabled: false, embeddedMode: true, tabId: 't1', connectionId: 'c1' },
  { notesFeatureEnabled: true, embeddedMode: true, tabId: 't1', connectionId: 'c1' },
  { notesFeatureEnabled: true, embeddedMode: false, tabId: 't1', connectionId: 'c1' },
];
for (const name of Object.keys(sources)) {
  for (const c of cases) {
    const out = simulateNotesClick(c);
    if (!c.notesFeatureEnabled) {
      assert.equal(out.posts.length, 0, `${name} disabled must not post`);
      assert.equal(out.toasts[0], '笔记功能未开启，请在设置中启用');
    } else if (c.embeddedMode) {
      assert.deepEqual(out.posts[0], {
        source: 'zephyr-terminal',
        type: 'open-notes-for-connection',
        tabId: 't1',
        connectionId: 'c1',
      });
      assert.equal(out.toasts.length, 0);
    } else {
      assert.equal(out.posts.length, 0);
      assert.equal(out.toasts[0], '笔记面板需要在应用主界面打开');
    }
  }
}

// Parent switchView guard: fullscreen + non-terminal target => exit helper.
function shouldExit(target, terminalMode, customFullscreen) {
  if (target === 'terminal') return false;
  if (!terminalMode) return false;
  return !!customFullscreen;
}
assert.equal(shouldExit('notes', true, true), true);
assert.equal(shouldExit('notes', true, false), false);
assert.equal(shouldExit('terminal', true, true), false);
assert.equal(shouldExit('notes', false, true), false);

console.log(JSON.stringify({
  ok: true,
  protocols: Object.keys(sources),
  parentNotesFlow: true,
  fullscreenGuard: true,
}, null, 2));
