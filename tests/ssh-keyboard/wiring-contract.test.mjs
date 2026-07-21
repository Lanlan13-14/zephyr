import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const terminalJs = readFileSync(join(root, 'public/terminal.js'), 'utf8');
const appJs = readFileSync(join(root, 'public/app.js'), 'utf8');
const surfaceJs = readFileSync(join(root, 'public/terminal-surface-controller.js'), 'utf8');
const terminalHtml = readFileSync(join(root, 'public/terminal.html'), 'utf8');

test('terminal imports ssh-keyboard facade', () => {
    assert.match(terminalJs, /createSshKeyboard/);
    assert.match(terminalJs, /ssh-keyboard\/index\.js/);
    assert.match(terminalJs, /function ensureSshKeyboard\(/);
});

test('terminal pointer path uses facade not triple open chain', () => {
    assert.match(terminalJs, /handlePointerDown/);
    assert.match(terminalJs, /handlePointerUp/);
    // old immediate multi-path marker should be gone
    assert.doesNotMatch(terminalJs, /surface\.onTerminalTap\('terminal-touch-immediate'\)/);
    assert.doesNotMatch(terminalJs, /terminal-touch-immediate/);
});

test('resize hard-gated by sshKb', () => {
    assert.match(terminalJs, /blocked-ssh-kb-gate/);
    assert.match(terminalJs, /allowResize/);
});

test('surface accepts injected soft keyboard', () => {
    assert.match(surfaceJs, /host\.getSoftKeyboard/);
    assert.match(terminalJs, /getSoftKeyboard:\s*\(\)\s*=>/);
});

test('parent handles ssh-kb via reduceParentKeyboardMessage', () => {
    assert.match(appJs, /reduceParentKeyboardMessage/);
    assert.match(appJs, /type === 'ssh-kb'/);
});

test('cache bust kb-xterm-fit2 on terminal entry', () => {
    assert.match(terminalHtml, /kb-xterm-fit2/);
    assert.match(terminalJs, /kb-xterm-fit2/);
});
