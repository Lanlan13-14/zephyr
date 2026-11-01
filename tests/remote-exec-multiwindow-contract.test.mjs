import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const appHtml = readFileSync(join(root, 'public/app.html'), 'utf8');
const terminalHtml = readFileSync(join(root, 'public/terminal.html'), 'utf8');
const telnetHtml = readFileSync(join(root, 'public/telnet-terminal.html'), 'utf8');
const terminalJs = readFileSync(join(root, 'public/terminal.js'), 'utf8');
const telnetJs = readFileSync(join(root, 'public/telnet-terminal.js'), 'utf8');
const appJs = readFileSync(join(root, 'public/app.js'), 'utf8');
const specCss = readFileSync(join(root, 'public/zephyr-terminal-spec.css'), 'utf8');

function extractRemoteViewHtml(html) {
    const start = html.indexOf('id="view-remote"');
    assert.ok(start >= 0, '#view-remote section must exist in public/app.html');
    const nextSection = html.indexOf('id="view-notes"', start);
    return nextSection > start ? html.slice(start, nextSection) : html.slice(start);
}

test('public/app.html #view-remote preserves legacy IDs and includes multi-window live stage controls', () => {
    const remoteSection = extractRemoteViewHtml(appHtml);

    const preservedIds = [
        'remoteServerList',
        'remoteExecForm',
        'remoteCommand',
        'remoteTimeout',
        'remoteResults',
    ];
    for (const id of preservedIds) {
        assert.ok(
            new RegExp(`id=["']${id}["']`).test(remoteSection),
            `#view-remote must preserve #${id}`
        );
    }

    const stageIds = [
        'remoteWorkspace',
        'remoteStageToolbar',
        'remoteStageTabs',
        'remoteBroadcastToggleBtn',
        'remoteExitZoomBtn',
        'remotePromoteActiveBtn',
        'remoteSelectAllBtn',
        'remoteClearSelectionBtn',
        'remoteSelectedCount',
        'remoteBatchCtrlCBtn',
        'remoteBatchClearBtn',
        'remoteBatchReconnectBtn',
        'remoteExecSubmitBtn',
    ];
    for (const id of stageIds) {
        assert.ok(
            new RegExp(`id=["']${id}["']`).test(remoteSection),
            `#view-remote must include multi-window stage element #${id}`
        );
    }
});

test('public/terminal.html and public/telnet-terminal.html bootstrap Lite Mode from ?lite=1', () => {
    for (const [name, html] of [
        ['public/terminal.html', terminalHtml],
        ['public/telnet-terminal.html', telnetHtml],
    ]) {
        assert.ok(
            /sp\.get\(['"]lite['"]\)\s*===\s*['"]1['"]/.test(html),
            `${name} must check sp.get('lite') === '1'`
        );
        assert.ok(
            /document\.documentElement\.dataset\.liteTerminal\s*=\s*['"]1['"]/.test(html),
            `${name} must set document.documentElement.dataset.liteTerminal = '1'`
        );
    }
});

test('public/terminal.js and public/telnet-terminal.js implement Lite Mode and Remote Execution messaging', () => {
    for (const [name, js] of [
        ['public/terminal.js', terminalJs],
        ['public/telnet-terminal.js', telnetJs],
    ]) {
        assert.ok(
            /\bpendingRemoteExecQueue\b/.test(js),
            `${name} must define pendingRemoteExecQueue`
        );
        assert.ok(
            /function\s+flushPendingRemoteExecQueue\s*\(/.test(js),
            `${name} must define flushPendingRemoteExecQueue()`
        );
        assert.ok(
            /setStatus\(['"]connected['"][\s\S]{0,160}?flushPendingRemoteExecQueue\(\)/.test(js),
            `${name} must call flushPendingRemoteExecQueue() on WebSocket ready`
        );
        assert.ok(
            /d\.type\s*===\s*['"]remote-exec-command['"]/.test(js),
            `${name} must handle d.type === 'remote-exec-command'`
        );
        assert.ok(
            /d\.type\s*===\s*['"]disconnect-terminal['"]/.test(js),
            `${name} must handle d.type === 'disconnect-terminal'`
        );
        assert.ok(
            /d\.type\s*===\s*['"]set-lite-mode['"]/.test(js),
            `${name} must handle d.type === 'set-lite-mode'`
        );
        assert.ok(
            /document\.documentElement\.dataset\.liteTerminal[\s\S]{0,240}?['"]remote-lite-click['"]/.test(js),
            `${name} must forward single-click (remote-lite-click) to window.parent in lite mode`
        );
        assert.ok(
            /document\.documentElement\.dataset\.liteTerminal[\s\S]{0,240}?['"]remote-lite-dblclick['"]/.test(js),
            `${name} must forward double-click (remote-lite-dblclick) to window.parent in lite mode`
        );
    }
});

test('public/app.js implements Multi-Window Live Remote Execution Workspace contract', () => {
    const stateIdentifiers = [
        'remoteExecSessions',
        'remoteExecConnectionToTab',
        'activeRemoteTab',
        'remoteZoomedTabId',
        'remoteBroadcastInputActive',
    ];
    for (const id of stateIdentifiers) {
        assert.ok(
            new RegExp(`\\b${id}\\s*=`).test(appJs),
            `public/app.js must define state variable ${id}`
        );
    }

    const requiredFunctions = [
        'openRemoteExecWindow',
        'closeRemoteExecWindow',
        'renderRemoteWorkspace',
        'zoomRemoteExecWindow',
        'exitRemoteExecZoom',
        'promoteRemoteWindowToFullTerminal',
        'stabilizeRemoteWorkspaceFrames',
        'remoteExecute',
    ];
    for (const fn of requiredFunctions) {
        assert.ok(
            new RegExp(`(?:async\\s+)?function\\s+${fn}\\s*\\(`).test(appJs),
            `public/app.js must implement ${fn}()`
        );
    }

    assert.ok(
        /Motion(?:\?\.)?\.terminalWindowAvoidance\b/.test(appJs)
            && /function\s+animateRemoteWindowLayoutFrom\s*\(/.test(appJs),
        'public/app.js must animate batch panes with the same Motion.terminalWindowAvoidance box morph the Terminal page uses'
    );
    assert.ok(
        /Motion(?:\?\.)?\.buttonPress\b/.test(appJs),
        'public/app.js must use Motion.buttonPress on execute button'
    );
    assert.ok(
        /Motion(?:\?\.)?\.terminalWindowFullscreenMorph\b/.test(appJs),
        'public/app.js must use Motion.terminalWindowFullscreenMorph for click-to-zoom morphs'
    );

    const promoteStart = appJs.indexOf('function promoteRemoteWindowToFullTerminal');
    assert.ok(promoteStart >= 0, 'promoteRemoteWindowToFullTerminal must exist in public/app.js');
    const promoteSlice = appJs.slice(promoteStart, promoteStart + 2800);
    assert.ok(
        /openTerminalConnection\s*\([\s\S]*?\bsessionId:\s*tabId\b/.test(promoteSlice)
            && /openTerminalConnection\s*\([\s\S]*?(?:,\s*tabId\b|\btabId\s*,|\btabId:\s*tabId\b)/.test(promoteSlice),
        'promoteRemoteWindowToFullTerminal must call openTerminalConnection with sessionId: tabId, tabId to preserve the running PTY session'
    );
});

test('public/zephyr-terminal-spec.css satisfies Lite Mode and Remote Execution multi-window design spec', () => {
    assert.ok(
        /html\[data-lite-terminal="1"\][\s\S]*?\.terminal-topbar\b[\s\S]*?display:\s*none\s*!important/.test(specCss),
        'zephyr-terminal-spec.css must hide .terminal-topbar when html[data-lite-terminal="1"]'
    );
    assert.ok(
        /html\[data-lite-terminal="1"\][\s\S]*?height:\s*100%\s*!important/.test(specCss),
        'zephyr-terminal-spec.css must fill 100% height when html[data-lite-terminal="1"]'
    );
    assert.ok(
        /\.remote-layout\.remote-desktop-shell\b[\s\S]*?300px/.test(specCss),
        'zephyr-terminal-spec.css must style .remote-layout.remote-desktop-shell with 300px sidebar'
    );
    assert.ok(
        /#remoteServerList\s*>\s*\.server-check\b[\s\S]*?border-radius:\s*12px/.test(specCss),
        'zephyr-terminal-spec.css must style #remoteServerList > .server-check with 12px radius'
    );
    assert.ok(
        /#remoteServerList\s*>\s*\.server-check[\s\S]*?:checked[\s\S]*?--accent/.test(specCss),
        'zephyr-terminal-spec.css must highlight #remoteServerList > .server-check with --accent when checked'
    );
    assert.ok(
        /\.remote-command\b[\s\S]*?var\(--z-radius-window,\s*24px\)/.test(specCss)
            && /\.remote-command\b[\s\S]*?padding:\s*16px/.test(specCss),
        'zephyr-terminal-spec.css must style .remote-command with var(--z-radius-window, 24px) and 16px padding'
    );
    assert.ok(
        /#remoteCommand\b[\s\S]*?JetBrains Mono/.test(specCss),
        'zephyr-terminal-spec.css must style #remoteCommand with JetBrains Mono'
    );

    for (const layoutClass of [
        'remote-layout-1',
        'remote-layout-2',
        'remote-layout-3',
        'remote-layout-4',
        'remote-layout-many',
    ]) {
        assert.ok(
            new RegExp(`#remoteWorkspace\\.${layoutClass}\\b`).test(specCss),
            `zephyr-terminal-spec.css must style #remoteWorkspace.${layoutClass}`
        );
    }

    assert.ok(
        /(?:#remoteWorkspace|\.remote-workspace)\.remote-zoomed\b/.test(specCss),
        'zephyr-terminal-spec.css must style #remoteWorkspace.remote-zoomed single-window zoom state'
    );
});
