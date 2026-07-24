import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appHtml = readFileSync(path.join(root, 'public/app.html'), 'utf8');
const appJs = readFileSync(path.join(root, 'public/app.js'), 'utf8');
const styleCss = readFileSync(path.join(root, 'public/style.css'), 'utf8');
const terminalJs = readFileSync(path.join(root, 'public/terminal.js'), 'utf8');
const serverJs = readFileSync(path.join(root, 'server.js'), 'utf8');
const storageJs = readFileSync(path.join(root, 'storage.js'), 'utf8');
const resourceJs = readFileSync(path.join(root, 'resource-service.js'), 'utf8');

test('connection modal exposes temporary-connect toggle at top of create form', () => {
    assert.match(appHtml, /id="connectionEphemeralGroup"/);
    assert.match(appHtml, /id="connEphemeral"/);
    assert.match(appHtml, /临时连接[\s\S]*?不保存到主机库/);
    const ephemeralIdx = appHtml.indexOf('id="connectionEphemeralGroup"');
    const bannerIdx = appHtml.indexOf('id="transientConnectionBanner"');
    const protocolIdx = appHtml.indexOf('id="connProtocol"');
    assert.ok(ephemeralIdx > 0 && bannerIdx > ephemeralIdx, 'toggle must appear before transient banner');
    assert.ok(protocolIdx > ephemeralIdx, 'toggle must appear before protocol field');
});

test('share-style switch markup and styles are reused for temporary toggle', () => {
    // Same card chrome as 共享设置: share-group + option + switch (grid + radius + track).
    assert.match(appHtml, /connection-share-group connection-ephemeral-group[\s\S]*?connEphemeral[\s\S]*?connection-share-switch/);
    assert.match(appHtml, /connection-share-copy[^>]*>\s*<strong>临时连接<\/strong>\s*<small>/);
    assert.match(styleCss, /\.connection-ephemeral-group\s*\{/);
    assert.match(styleCss, /\.connection-share-group \.connection-share-option\s*\{/);
    assert.match(styleCss, /border-radius:\s*8px/);
    assert.match(styleCss, /\.connection-modal\.transient-mode \.connection-share-group:not\(\.connection-ephemeral-group\)/);
    assert.match(styleCss, /\.connection-modal\.transient-mode \.connection-action-normal/);
    assert.match(styleCss, /\.connection-modal\.transient-mode \.connection-action-transient/);
    // JS must not force-hide the ephemeral card when toggling share visibility.
    assert.match(appJs, /connection-share-group:not\(\.connection-ephemeral-group\)/);
});

test('frontend ephemeral mode flips save to connect and uses save-open-delete', () => {
    assert.match(appJs, /function isTransientConnectionMode/);
    assert.match(appJs, /function applyEphemeralToggleFromUi/);
    assert.match(appJs, /function openEphemeralSession/);
    assert.match(appJs, /function connectEphemeral/);
    assert.match(appJs, /function disposeEphemeralConnection/);
    assert.match(appJs, /connectionModalMode === 'ephemeral'/);
    assert.match(appJs, /connEphemeral.*addEventListener\('change'/);
    // Create with ephemeral:true, then openConnection, never leave row in library UI.
    assert.match(appJs, /ephemeral:\s*true/);
    assert.match(appJs, /openConnection\(connId/);
    assert.match(appJs, /ephemeralConnectionId/);
    assert.match(appJs, /disposeEphemeralConnection/);
    assert.match(appJs, /if \(isTransientConnectionMode\(\)\) \{[\s\S]*?connectEphemeral/);
    // VNC is no longer blocked on the temporary path.
    assert.doesNotMatch(appJs, /临时连接暂不支持 VNC/);
});

test('tab close deletes the one-shot connection row', () => {
    assert.match(appJs, /closeTerminalTab[\s\S]*?disposeEphemeralConnection/);
    assert.match(appJs, /ephemeralConnectionId[\s\S]*?tab-close/);
});

test('storage + resource service hide ephemeral rows from host library', () => {
    assert.match(storageJs, /addColumnIfMissing\('connections', 'ephemeral'/);
    assert.match(storageJs, /cleanupExpiredEphemeralConnections/);
    assert.match(storageJs, /ephemeral: !!plain\.ephemeral/);
    assert.match(resourceJs, /includeEphemeral/);
    assert.match(resourceJs, /!c\.ephemeral/);
    assert.match(resourceJs, /resource\.create_ephemeral/);
});

test('server has noVNC proxy and accepts ephemeral create flag', () => {
    assert.match(serverJs, /noVncWss\.on\('connection'/);
    assert.match(serverJs, /\[novnc-ws\]/);
    assert.match(serverJs, /authenticateVncServer/);
    assert.match(serverJs, /ephemeralCreate/);
    assert.match(serverJs, /body\.ephemeral/);
    assert.match(serverJs, /includeEphemeral:\s*true/);
    assert.match(serverJs, /cleanupExpiredEphemeralConnections/);
});

test('terminal connect envelope still carries ephemeral route fields', () => {
    assert.match(terminalJs, /sshKeyId: params\.sshKeyId/);
    assert.match(terminalJs, /connectionMode: params\.connectionMode/);
    assert.match(terminalJs, /ephemeral: !!params\.ephemeral/);
});
