import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appJs = readFileSync(path.join(root, 'public/app.js'), 'utf8');
const styleCss = readFileSync(path.join(root, 'public/style.css'), 'utf8');

function bodyOf(name) {
    const start = appJs.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `${name} missing`);
    const next = appJs.indexOf('\nfunction ', start + 10);
    return appJs.slice(start, next > start ? next : appJs.length);
}

test('mobile fullscreen vertical Dock stays above fixed workspace', () => {
    assert.match(styleCss, /terminal-custom-fullscreen-open \.terminal-smartbar[\s\S]*?z-index:\s*1012\s*!important/);
    assert.match(styleCss, /terminal-custom-fullscreen-open \.terminal-smartbar \.smartbar-panel[\s\S]*?overflow:\s*visible\s*!important/);
    assert.match(styleCss, /terminal-custom-fullscreen-open \.terminal-smartbar \.smartbar-dock[\s\S]*?overflow:\s*visible\s*!important/);
});

test('mobile fullscreen Dock trigger is compact but keeps circular hit target', () => {
    assert.match(styleCss, /mobile-fullscreen-dock-toggle[\s\S]*?width:\s*24px\s*!important/);
    assert.match(styleCss, /mobile-fullscreen-dock-toggle[\s\S]*?height:\s*24px\s*!important/);
    assert.match(styleCss, /mobile-fullscreen-dock-toggle span[\s\S]*?width:\s*5px\s*!important/);
});

test('leaving terminal while fullscreen awaits existing exit animation first', () => {
    const helper = bodyOf('exitTerminalFullscreenThenSwitchView');
    assert.match(helper, /await exitTerminalFullscreen\(\{ renderAfter: false \}\)/);
    assert.match(helper, /switchView\(target, \{ \.\.\.options, fullscreenExitHandled: true \}\)/);
    const switchFn = bodyOf('switchView');
    assert.match(switchFn, /shouldExitTerminalFullscreenBeforeView\(target\)/);
    assert.match(switchFn, /return exitTerminalFullscreenThenSwitchView\(target, options\)/);
});

test('terminal notes request uses fullscreen-exit-before-notes flow', () => {
    const listener = appJs.slice(appJs.indexOf("data.type !== 'open-notes-for-connection'"), appJs.indexOf('// ─── Multi-user management UI'));
    assert.match(listener, /Promise\.resolve\(switchView\('notes', \{ source: 'terminal-notes-button' \}\)\)/);
    assert.match(listener, /\.then\(\(\) => \{[\s\S]*?filterByConnection/);
    assert.doesNotMatch(listener, /\nswitchView\('notes'\);/);
});
