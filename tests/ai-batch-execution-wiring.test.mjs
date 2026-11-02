import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';

// This is not a local build/test entry: run only in the remote test container.
const file = process.env.BATCH_WIRED_APP || new URL('../public/app.js', import.meta.url);
test('parent app wiring candidate parses and covers both runtime subscribers plus Legacy confirmation', () => {
    const source = fs.readFileSync(file, 'utf8');
    execFileSync(process.execPath, ['--input-type=module', '--check'], { input: source, encoding: 'utf8' });
    const part = name => {
        const start = source.indexOf(`function ${name}(`);
        assert.notEqual(start, -1);
        const end = source.indexOf('\nfunction ', start + 1);
        return source.slice(start, end < 0 ? undefined : end);
    };
    assert.match(part('collectAiContext'), /batchExecution: getAiBatchExecutionBridge\(\).snapshot\(\)/);
    assert.match(part('applySwitchViewCore'), /aiBatchExecutionBridge\?\.invalidate/);
    assert.match(part('syncAiToolSideEffects'), /getAiBatchExecutionBridge\(\).execute/);
    assert.match(part('resolveAiConfirmation'), /capture\.toolCallId/);
    assert.match(part('resolveAiConfirmation'), /evType === 'permission.ask'/);
    assert.match(source, /captureType === 'batch_execution_action_v1'/);
});
test('actual app adapter invokes existing operations and never creates another execution endpoint', async () => {
    const source = fs.readFileSync(file, 'utf8');
    const start = source.indexOf('function getAiBatchExecutionBridge()');
    const end = source.indexOf('\nfunction armRemoteCommandTimeout', start);
    let adapter; const calls = [];
    const session = { id: 's1', frame: { contentWindow: {} }, status: 'connected' };
    const context = vm.createContext({
        createBatchExecutionBridge: value => { adapter = value; return {}; }, aiBatchExecutionBridge: null,
        api: () => {}, myIdentity: { userId: 'alice' }, currentAppView: 'remote', activeRemoteTab: 's1',
        remoteExecSessions: new Map([['s1', session]]), connections: [], terminalTabs: [],
        window: { __zephyrRemoteExecViewPolicy: () => ({ canControl: true }) },
        getRemoteToolDispatcher: () => ({ send: (...args) => { calls.push(['send', ...args]); return {}; } }),
        openRemoteExecWindow: id => { calls.push(['select', id]); return id; },
        closeRemoteExecWindow: id => { calls.push(['deselect', id]); return true; },
        activateRemoteExecWindow: (...args) => { calls.push(['focus', ...args]); return true; },
        promoteRemoteWindowToFullTerminal: async id => { calls.push(['promote', id]); },
        runRemoteExecAction: (...args) => { calls.push(['action', ...args]); session.status = 'connecting'; },
        document: { getElementById: () => null },
    });
    vm.runInContext(source.slice(start, end), context); vm.runInContext('getAiBatchExecutionBridge()', context);
    assert.equal(adapter.getAccountId(), 'alice'); assert.equal(adapter.getView(), 'remote');
    assert.equal(adapter.canControl(session), true);
    await adapter.select('c1'); await adapter.deselect('s1'); await adapter.focus('s1'); await adapter.promote('s1'); await adapter.reconnect('s1');
    await adapter.dispatch('remote-exec-tool-command', { command: 'echo hi' }, { targetIds: ['s1'] });
    assert.deepEqual(calls.map(x => x[0]), ['select', 'deselect', 'focus', 'promote', 'action', 'send']);
    assert.equal(adapter.getTimeoutSeconds(), null);
});
