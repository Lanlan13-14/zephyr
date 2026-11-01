import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const appHtml = readFileSync(new URL('../public/app.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const terminal = readFileSync(new URL('../public/terminal.js', import.meta.url), 'utf8');
const policyStart = app.indexOf('window.__zephyrRemoteExecViewPolicy =');
const policyEnd = app.indexOf('\nfunction queueRemoteExecMessage', policyStart);

test('remote workspace click only focuses; double click zooms and promotion stays button-only', () => {
    assert.match(app, /workspace\.addEventListener\('click',[\s\S]*?activateRemoteExecWindow\(win\.dataset\.remoteTab\)/);
    assert.match(app, /workspace\.addEventListener\('dblclick',[\s\S]*?zoomRemoteExecWindow\(win\.dataset\.remoteTab\)/);
    assert.match(app, /if \(data\.type === 'remote-lite-click'\) activateRemoteExecWindow\(session\.id, \{ focusTerminal: false \}\)/);
    assert.match(app, /else if \(data\.type === 'remote-lite-dblclick'\) zoomRemoteExecWindow\(session\.id\)/);
    assert.match(app, /remotePromoteActiveBtn[^\n]*addEventListener\('click',[^\n]*promoteRemoteWindowToFullTerminal/);
    assert.doesNotMatch(app, /remote-lite-dblclick'\) promoteRemoteWindowToFullTerminal/);
});


test('optional timeout is unchecked by default and sends a destructive stop only on expiry', () => {
    assert.match(appHtml, /id="remoteTimeoutEnabled" type="checkbox"/);
    assert.match(appHtml, /id="remoteTimeout" type="number"[^>]*disabled/);
    assert.match(app, /session\.pendingTimeoutSeconds = timeoutEnabled \? timeoutSeconds : null/);
    assert.match(app, /data\.type === 'remote-exec-sent'[\s\S]*session\.timeoutTimer = setTimeout/);
    assert.match(app, /type: 'remote-exec-timeout'/);
    assert.match(terminal, /d\.type === 'remote-exec-timeout'[\s\S]*JSON\.stringify\(\{ type: 'disconnect' \}\)/);
});

test('closing a batch-only pane destroys its PTY and next open gets a unique session identity', () => {
    assert.match(app, /detachRemoteExecFrame\(session\.frame, \{ destroySession: !session\.sharedView \}\)/);
    assert.match(app, /if \(destroySession\)[\s\S]*type: 'disconnect-terminal'/);
    assert.match(app, /remoteExecConnectionToTab\.delete\(String\(session\.connectionId\)\)/);
    assert.match(app, /crypto\.randomUUID\(\)/);
});

test('batch workspace omits both the English eyebrow and Chinese page title', () => {
    const start = appHtml.indexOf('id="view-remote"');
    const end = appHtml.indexOf('id="view-notes"', start);
    const view = appHtml.slice(start, end);
    assert.doesNotMatch(view, /<p class="eyebrow">Remote Execution<\/p>/);
    assert.doesNotMatch(view, /<h1[^>]*data-i18n="批量执行"/);
});


test('promoting never deletes remote owner or detaches its live iframe', async () => {
    const start = app.indexOf('async function promoteRemoteWindowToFullTerminal(');
    const end = app.indexOf('// One control/resize owner', start);
    const remote = { id: 'pty', connectionId: 'server', frame: { contentWindow: {} } };
    const context = vm.createContext({ remoteExecSessions: new Map([['pty', remote]]),
        activeRemoteTab: 'pty', openTerminalConnection: async () => 'pty',
        switchView() {}, scheduleTerminalLayoutStabilize() {}, scheduleWorkspaceSave() {},
        toast(message) { throw Error(message); } });
    vm.runInContext(app.slice(start, end), context);
    assert.equal(await context.promoteRemoteWindowToFullTerminal('pty'), true);
    assert.equal(context.remoteExecSessions.get('pty'), remote);
    assert.equal(remote.sharedView, true);
    assert.equal(remote.promoting, false);
});


test('shared PTY control belongs to exactly one workspace and restores to remote after full close', () => {
    const remoteWindow = {}, fullWindow = {};
    const context = vm.createContext({ window: {},
        remoteExecSessions: new Map([['pty', { sharedView: true, frame: { contentWindow: remoteWindow } }]]),
        terminalTabs: [{ id: 'pty', remoteExecOwner: true }], closingTerminalTabs: new Set(),
        currentAppView: 'terminal', document: { querySelectorAll: () => [{ dataset: { frame: 'pty' }, contentWindow: fullWindow }] },
    });
    vm.runInContext(app.slice(policyStart, policyEnd), context);
    const policy = context.window.__zephyrRemoteExecViewPolicy;
    assert.equal(policy('pty', fullWindow).canControl, true);
    assert.equal(policy('pty', remoteWindow).canControl, false);
    context.currentAppView = 'remote';
    assert.equal(policy('pty', remoteWindow).canControl, true);
    assert.equal(policy('pty', fullWindow).canControl, false);
    context.terminalTabs = [];
    assert.equal(policy('pty', remoteWindow).shared, true);
    assert.equal(policy('pty', remoteWindow).canControl, true);
    assert.equal(context.remoteExecSessions.size, 1);
});

test('closing a promoted full-terminal view stays in Terminal and keeps only the remote PTY owner alive', () => {
    const start = app.indexOf('async function closeTerminalTab(');
    const end = app.indexOf('\nfunction applyTerminalWindowPreset', start);
    const closeSource = app.slice(start, end);
    assert.match(closeSource, /switchView\('terminal'\)/);
    assert.match(closeSource, /retainedRemote\.sharedView = false/);
    assert.match(closeSource, /postRemoteExecMessage\(retainedRemote, \{ type: 'set-lite-mode', lite: true \}\)/);
    assert.match(closeSource, /renderRemoteWorkspace\(\{ animateAvoidance: false \}\)/);
    assert.doesNotMatch(closeSource, /switchView\('remote'\)/);
    assert.doesNotMatch(closeSource, /recoveryTab|remoteExecHandoff/);
    assert.match(closeSource, /if \(typeof remoteExecSessions === 'undefined' \|\| !remoteExecSessions\.has\(tabId\)\)/);
});

test('remote frames cannot steal full-terminal pane activation when both share a PTY', () => {
    assert.match(app, /const remotePane = tabId && remoteExecSessions\.get\(tabId\);\s*if \(remotePane\?\.frame\?\.contentWindow === e\.source\)/);
});

test('shared views cannot send destructive disconnect and input/resize go through ownership guard', () => {
    assert.match(terminal, /function sendData\([^\n]+\n\s*if \(!getRemoteExecViewPolicy\(\)\.canControl\) return;/);
    assert.match(terminal, /function sendTerminalResize\([^\n]+\n\s*if \(!getRemoteExecViewPolicy\(\)\.canControl\) return false;/);
    assert.match(terminal, /sendDisconnect && !getRemoteExecViewPolicy\(\)\.shared/);
    assert.match(terminal, /if \(!getRemoteExecViewPolicy\(\)\.shared\) wsConnection.send\(JSON.stringify\(\{ type: 'disconnect' \}\)\)/);
    assert.match(terminal, /if \(!getRemoteExecViewPolicy\(\)\.shared\) sessionStorage.removeItem/);
    assert.match(app, /if \(typeof remoteExecSessions === 'undefined' \|\| !remoteExecSessions.has\(tabId\)\)/);
});
