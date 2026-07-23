/**
 * Second soft-keyboard open must not be blocked by close-settle freeze,
 * and parent reset must clear awaiting state without 900ms child freeze.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const bridgeSrc = fs.readFileSync(join(ROOT, 'public/ssh-keyboard/bridge.js'), 'utf8');
const appSrc = fs.readFileSync(join(ROOT, 'public/app.js'), 'utf8');

test('bridge: open intent bypasses freeze', () => {
  assert.match(bridgeSrc, /isOpenIntent/);
  assert.match(bridgeSrc, /freeze-cleared-by-open|open must NEVER be blocked/i);
  assert.match(bridgeSrc, /unfreeze-republish/);
});

test('app reset: soft close does not 900ms freeze child', () => {
  // Must not call freeze 900 on ordinary close.
  assert.match(appSrc, /Ordinary close: do NOT freeze|soft-unfreeze|parent-keyboard-reset-soft-unfreeze/);
  assert.match(appSrc, /sshKbParentAwaiting = false/);
  // force path may freeze briefly, but not 900
  const resetBody = appSrc.match(/function resetTerminalWorkspaceKeyboard[\s\S]*?^function\s+\w+/m)?.[0] || '';
  assert.ok(resetBody);
  assert.equal(/settleMs:\s*900/.test(resetBody), false, 'reset must not freeze 900ms');
});

test('parent open intent unfreezes before apply', () => {
  assert.match(appSrc, /parent-child-open-intent/);
  assert.match(
    appSrc,
    /if \(reduced\.open\) \{[\s\S]*?postTerminalKeyboardFreeze\(false/,
  );
});

test('bridge publish behavioral: frozen open still posts', async () => {
  const mod = await import(pathToFileURL(join(ROOT, 'public/ssh-keyboard/bridge.js')).href);
  const posted = [];
  const bridge = mod.createParentBridge({
    isEmbedded: () => true,
    getTabId: () => 't1',
    postToParent: (msg) => posted.push(msg),
  });
  bridge.freeze(5000, 'test-close-settle');
  const ok = bridge.publish({
    phase: 'opening',
    intent: 'open',
    inset: 0,
    liftMode: 'workspace',
    reason: 'reopen',
  });
  assert.equal(ok, true, 'open must publish through freeze');
  assert.equal(posted.length, 1);
  assert.equal(posted[0].keyboardOpen, true);
  assert.equal(posted[0].intent, 'open');
  // closed while frozen is blocked
  bridge.freeze(5000, 'again');
  const blocked = bridge.publish({
    phase: 'closed',
    intent: 'closed',
    inset: 0,
    liftMode: 'workspace',
    reason: 'noise',
  });
  assert.equal(blocked, false);
});
