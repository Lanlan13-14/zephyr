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


test('timeout interrupts the current command with Ctrl+C and preserves SSH session/window', () => {
    assert.match(appHtml, /id="remoteTimeoutEnabled" type="checkbox"/);
    assert.match(appHtml, /id="remoteTimeout" type="number"[^>]*disabled/);
    assert.match(app, /session\.pendingTimeoutSeconds = timeoutEnabled \? timeoutSeconds : null/);
    assert.match(app, /data\.type === 'remote-exec-sent'[\s\S]*session\.timeoutTimer = setTimeout/);
    assert.match(app, /type: 'remote-exec-timeout'/);
    assert.match(app, /命令已超时，已发送 Ctrl\+C 停止/);
    assert.match(app, /命令超时，但终端未确认 Ctrl\+C/);
    const timeoutBranch = terminal.slice(terminal.indexOf("d.type === 'remote-exec-timeout'"), terminal.indexOf("} else if (d.source === 'zephyr-app' && d.type === 'disconnect-terminal')"));
    assert.match(timeoutBranch, /const canControl = !!getRemoteExecViewPolicy\(\)\.canControl/);
    assert.match(timeoutBranch, /if \(!connected \|\| !canControl\)/);
    assert.match(timeoutBranch, /sendData\(String\.fromCharCode\(3\)/);
    assert.doesNotMatch(timeoutBranch, /type: 'disconnect'|wsConnection\.close\(/);
    assert.match(timeoutBranch, /remote-exec-timeout-stopped/);
    assert.match(timeoutBranch, /remote-exec-timeout-failed/);
    assert.doesNotMatch(app, /remote-exec-timeout-stopped'[\s\S]{0,400}closeRemoteExecWindow/);
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
    const remote = { id: 'pty', connectionId: 'server', frame: { contentWindow: {}, closest: () => null } };
    const context = vm.createContext({ remoteExecSessions: new Map([['pty', remote]]),
        window: { matchMedia: () => ({ matches: true }) }, document: { querySelectorAll: () => [] }, CSS: { escape: value => value },
        activeRemoteTab: 'pty', openTerminalConnection: async () => 'pty',
        switchView(view, options) { context.switched = [view, options]; }, scheduleTerminalLayoutStabilize() {}, scheduleWorkspaceSave() {},
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

test('reverse promotion adapts to the shared card-flip open and handoff contract', () => {
    const flipTestSrc = app.slice(app.indexOf('async function animateRemoteExecPromoteFlip'), app.indexOf('async function promoteRemoteWindowToFullTerminal'));
    assert.match(flipTestSrc, /await playTerminalCardFlipOpen\(remoteWin, \{/);
    assert.match(flipTestSrc, /liveWindow: terminalWin/);
    assert.match(flipTestSrc, /originRect: origin/);
    assert.match(flipTestSrc, /direction: 'reverse'/);
    assert.match(flipTestSrc, /timeScale: 1\.5/);
    assert.match(flipTestSrc, /paintFront: \(front\) => createRemoteExecFlipFace\(remoteWin, front, origin\.width, origin\.height\)/);
    assert.match(flipTestSrc, /if \(!flipped\) return false;\s*await finishTerminalCardFlipOpenHandoff\(\)/);
    assert.match(flipTestSrc, /finally\s*\{[\s\S]*restoreCardFlipHostedWindow\(\)[\s\S]*releaseCardFlipWindowPins\(terminalWin\)[\s\S]*resetTerminalCardFlipSurface\(sshKeyMotion\.engine\)[\s\S]*phase = 'settled'/);
    assert.doesNotMatch(flipTestSrc, /Motion\.to\(|rotateY:|iosCardFlipOpen|createRemoteExecFlipFace\(terminalWin|appendChild\(remoteWin\)|appendChild\(terminalWin\)/);
    assert.match(flipTestSrc, /prefers-reduced-motion/);
    assert.match(app, /animateRemoteExecPromoteFlip\(remoteWin, fullTarget\)/);
    assert.match(app, /switchView\('terminal', \{ skipCardFlip: true \}\)/);
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
