import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const appJs = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const appHtml = fs.readFileSync(new URL('../public/app.html', import.meta.url), 'utf8');
const userSettings = fs.readFileSync(new URL('../user-settings-service.js', import.meta.url), 'utf8');
const terminalJs = fs.readFileSync(new URL('../public/terminal.js', import.meta.url), 'utf8');
const telnetJs = fs.readFileSync(new URL('../public/telnet-terminal.js', import.meta.url), 'utf8');
const terminalHtml = fs.readFileSync(new URL('../public/terminal.html', import.meta.url), 'utf8');
const telnetHtml = fs.readFileSync(new URL('../public/telnet-terminal.html', import.meta.url), 'utf8');
const sw = fs.readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
const en = JSON.parse(fs.readFileSync(new URL('../public/i18n/locales/en.json', import.meta.url), 'utf8'));

test('personalization exposes the default-on session persistence switch', () => {
    assert.match(appHtml, /id="sessionPersistenceEnabled"[^>]*checked/);
    assert.match(appHtml, /data-i18n="会话持久化"/);
    assert.match(appHtml, /data-i18n="关闭页面后再次打开时，恢复之前的页面和会话。"/);
    assert.equal(en['会话持久化'], 'Session persistence');
    assert.ok(en['关闭页面后再次打开时，恢复之前的页面和会话。']);
});

test('session persistence is a personal setting and defaults to enabled', () => {
    assert.match(userSettings, /'workspace\.sessionPersistence'/);
    assert.match(appJs, /function isSessionPersistenceEnabled\(\)/);
    assert.match(appJs, /settings\?\.workspace\?\.sessionPersistence !== false/);
    assert.match(appJs, /#sessionPersistenceEnabled[^\n]*\.checked = isSessionPersistenceEnabled\(\)/);
    assert.match(appJs, /sessionPersistence:\s*true/);
});

test('disabled persistence skips restore, autosave, snapshots, and last-view replay', () => {
    assert.match(appJs, /function scheduleWorkspaceSave[\s\S]*?!isSessionPersistenceEnabled\(\)/);
    assert.match(appJs, /async function saveWorkspaceNow[\s\S]*?!isSessionPersistenceEnabled\(\)/);
    assert.match(appJs, /async function restoreLastWorkspace[\s\S]*?!isSessionPersistenceEnabled\(\)/);
    assert.match(appJs, /function rememberLastAppView[\s\S]*?if \(!isSessionPersistenceEnabled\(\)\)/);
    assert.match(appJs, /const lastView = isSessionPersistenceEnabled\(\)[\s\S]*?localStorage\.getItem\('zephyr\.lastView'\)/);
    assert.match(appJs, /const flushWorkspace = \(\) => \{[\s\S]*?if \(isSessionPersistenceEnabled\(\)\)/);
    assert.match(appJs, /type:\s*'terminal-settings'[\s\S]*?workspace:\s*settings\.workspace/);
});

test('turning persistence off removes local restore state and best-effort deletes the saved workspace', () => {
    assert.match(appJs, /async function setSessionPersistenceEnabled/);
    assert.match(appJs, /method:\s*'DELETE'/);
    assert.match(appJs, /failed to delete saved automatic workspace/);
    assert.match(appJs, /sessionStorage\.removeItem\(TERMINAL_SNAPSHOT_STORAGE_KEY\)/);
    assert.match(appJs, /localStorage\.removeItem\('zephyr\.lastView'\)/);
});

test('terminal unload policy follows the setting so detached SSH sessions do not linger', () => {
    for (const source of [terminalJs, telnetJs]) {
        assert.match(source, /let sessionPersistenceEnabled = localStorage\.getItem\('zephyr\.sessionPersistence\.disabled'\) !== '1'/);
        assert.match(source, /sessionPersistenceEnabled = e\.data\.workspace\.sessionPersistence !== false/);
        assert.match(source, /const shouldDetach = sessionPersistenceEnabled/);
        assert.match(source, /closeWebSocketOnly\(t\('页面卸载'\), \{ sendDisconnect: !shouldDetach \}\)/);
    }
});

test('updated app and terminal assets use the current cache revision', () => {
    assert.match(appHtml, /app\.js\?v=20260801-dock-notes-fullscreen1/);
    assert.match(terminalHtml, /terminal\.js\?v=20260801-terminal-grid-converge1/);
    assert.match(telnetHtml, /telnet-terminal\.js\?v=20260801-terminal-grid-converge1/);
    assert.match(sw, /zephyr-static-20260801-dock-notes-fullscreen1/);
});
