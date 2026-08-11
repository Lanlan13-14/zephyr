import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { AiRuntimeBridge } from '../ai-runtime-bridge.js';
import { executeAiToolForHost } from '../ai-agent-service.js';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function jsonResponse(data, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        async json() { return data; },
    };
}

function startPayload(sessionId = 'session-1') {
    return { sessionId, provider: {}, model: 'model-1', message: 'hello' };
}

test('maintenance invalidates old runs and drains abort plus in-flight host RPC', async () => {
    const abortGate = deferred();
    let startBody;
    const bridge = new AiRuntimeBridge({
        baseUrl: 'http://runtime.test',
        adminToken: 'admin',
        fetchImpl: async (url, options = {}) => {
            const path = new URL(url).pathname;
            if (path === '/admin/runs') {
                startBody = JSON.parse(options.body);
                return jsonResponse({ ok: true, runId: 'run-1', ticket: 'ticket-1' });
            }
            if (path === '/admin/runs/run-1/abort') {
                await abortGate.promise;
                return jsonResponse({ ok: true });
            }
            throw new Error(`unexpected runtime request ${path}`);
        },
    });

    await bridge.startRun({ userId: 'alice' }, startPayload());
    assert.ok(startBody.databaseGeneration);
    assert.ok(startBody.runNonce);

    assert.throws(() => bridge.beginHostCall({
        userId: 'bob',
        runId: 'run-1',
        databaseGeneration: startBody.databaseGeneration,
        runNonce: startBody.runNonce,
    }), (error) => error.code === 'ai_run_forbidden');

    const releaseHost = bridge.beginHostCall({
        userId: 'alice',
        runId: 'run-1',
        databaseGeneration: startBody.databaseGeneration,
        runNonce: startBody.runNonce,
    });
    const drain = bridge.beginMaintenance();
    await assert.rejects(
        bridge.startRun({ userId: 'alice' }, startPayload('session-2')),
        (error) => error.code === 'database_maintenance',
    );

    let drained = false;
    drain.then(() => { drained = true; });
    abortGate.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(drained, false, 'maintenance must still wait for the admitted host RPC');
    releaseHost();
    await drain;

    bridge.endMaintenance();
    assert.notEqual(bridge.databaseGeneration, startBody.databaseGeneration);
    assert.throws(() => bridge.beginHostCall({
        userId: 'alice',
        runId: 'run-1',
        databaseGeneration: startBody.databaseGeneration,
        runNonce: startBody.runNonce,
    }), (error) => error.code === 'ai_run_generation_expired');
    assert.throws(() => bridge.assertRunAccess({ userId: 'alice' }, 'run-1'), (error) => error.code === 'ai_run_generation_expired');
});

test('a start overlapping maintenance is aborted and cannot publish an old-generation token', async () => {
    const startGate = deferred();
    const bridge = new AiRuntimeBridge({
        baseUrl: 'http://runtime.test',
        fetchImpl: async (url, options = {}) => {
            const path = new URL(url).pathname;
            if (path === '/admin/runs') {
                await startGate.promise;
                return jsonResponse({ ok: true, runId: 'late-run', ticket: 'old-ticket' });
            }
            throw new Error(`unexpected runtime request ${path}`);
        },
    });

    const start = bridge.startRun({ userId: 'alice' }, startPayload());
    await new Promise((resolve) => setImmediate(resolve));
    const drain = bridge.beginMaintenance();
    await assert.rejects(start, (error) => error.code === 'ai_run_generation_expired');
    await drain;
    bridge.endMaintenance();

    // A transport that ignores abort may still resolve after maintenance. Its
    // response must remain detached from the retired generation.
    startGate.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(bridge.runLeasesById.has('late-run'), false);
    assert.equal(bridge.runLeasesByNonce.size, 0);
});

test('maintenance aborts an admitted host tool call before waiting for its release', async () => {
    const hostAbort = new AbortController();
    let startBody;
    const bridge = new AiRuntimeBridge({
        baseUrl: 'http://runtime.test',
        fetchImpl: async (url, options = {}) => {
            const path = new URL(url).pathname;
            if (path === '/admin/runs') {
                startBody = JSON.parse(options.body);
                return jsonResponse({ ok: true, runId: 'run-host', ticket: 'ticket-host' });
            }
            if (path === '/admin/runs/run-host/abort') return jsonResponse({ ok: true });
            throw new Error(`unexpected runtime request ${path}`);
        },
    });
    await bridge.startRun({ userId: 'alice' }, startPayload());
    const releaseHost = bridge.beginHostCall({
        userId: 'alice',
        runId: 'run-host',
        databaseGeneration: startBody.databaseGeneration,
        runNonce: startBody.runNonce,
        abortController: hostAbort,
    });

    const drain = bridge.beginMaintenance();
    assert.equal(hostAbort.signal.aborted, true, 'maintenance must cancel admitted host tool execution');
    releaseHost();
    await drain;
});

test('rollback reopen and process replacement each use a fresh runtime generation', async () => {
    const first = new AiRuntimeBridge({ baseUrl: 'http://runtime.test', fetchImpl: async () => jsonResponse({ ok: true }) });
    const beforeImport = first.databaseGeneration;
    await first.beginMaintenance();
    first.endMaintenance();
    assert.notEqual(first.databaseGeneration, beforeImport, 'rollback must not revive the retired generation');

    const afterKill = new AiRuntimeBridge({ baseUrl: 'http://runtime.test', fetchImpl: async () => jsonResponse({ ok: true }) });
    assert.notEqual(afterKill.databaseGeneration, first.databaseGeneration, 'a restart in the import kill window must invalidate old tokens');
});

test('maintenance cancels a hung pending start without waiting for the transport to settle', async () => {
    const startGate = deferred();
    let startSignal;
    const bridge = new AiRuntimeBridge({
        baseUrl: 'http://runtime.test',
        maintenanceTimeoutMs: 100,
        fetchImpl: async (url, options = {}) => {
            if (new URL(url).pathname !== '/admin/runs') throw new Error(`unexpected runtime request ${url}`);
            startSignal = options.signal;
            return startGate.promise;
        },
    });

    const start = bridge.startRun({ userId: 'alice' }, startPayload());
    await new Promise((resolve) => setImmediate(resolve));
    await bridge.beginMaintenance();
    await assert.rejects(start, (error) => error.code === 'ai_run_generation_expired');
    assert.equal(startSignal.aborted, true);
    assert.equal(bridge.pendingStarts.size, 0);
    bridge.endMaintenance();

    startGate.resolve(jsonResponse({ ok: true, runId: 'late-start' }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(bridge.runLeasesById.has('late-start'), false);
});

test('maintenance deadline rejects a hung runtime abort without treating an admitted host call as drained', async () => {
    let startBody;
    let abortSignal;
    const hostAbort = new AbortController();
    const bridge = new AiRuntimeBridge({
        baseUrl: 'http://runtime.test',
        maintenanceTimeoutMs: 35,
        fetchImpl: async (url, options = {}) => {
            const path = new URL(url).pathname;
            if (path === '/admin/runs') {
                startBody = JSON.parse(options.body);
                return jsonResponse({ ok: true, runId: 'hung-abort', ticket: 'ticket' });
            }
            if (path === '/admin/runs/hung-abort/abort') {
                abortSignal = options.signal;
                return new Promise(() => {});
            }
            throw new Error(`unexpected runtime request ${path}`);
        },
    });

    await bridge.startRun({ userId: 'alice' }, startPayload());
    const releaseHost = bridge.beginHostCall({
        userId: 'alice',
        runId: 'hung-abort',
        databaseGeneration: startBody.databaseGeneration,
        runNonce: startBody.runNonce,
        abortController: hostAbort,
    });

    await assert.rejects(
        bridge.beginMaintenance(),
        (error) => error.code === 'ai_runtime_maintenance_timeout',
    );
    assert.equal(abortSignal.aborted, true, 'runtime abort receives the maintenance controller signal');
    assert.equal(hostAbort.signal.aborted, true, 'host tool receives cancellation before the deadline');
    assert.equal(bridge.inFlightHostCalls, 1, 'a non-cooperative host call must keep maintenance from claiming a drain');
    assert.throws(() => releaseHost.assertLive(), (error) => error.code === 'ai_run_generation_expired');
    releaseHost();
    assert.equal(bridge.inFlightHostCalls, 0);
    bridge.endMaintenance();
});

test('maintenance cancels an SSE monitor whose reader ignores its abort signal', async () => {
    const readGate = deferred();
    let monitorSignal;
    const historyController = { beginRun() {}, observeEvent() {} };
    const bridge = new AiRuntimeBridge({
        baseUrl: 'http://runtime.test',
        maintenanceTimeoutMs: 100,
        historyController,
        fetchImpl: async (url, options = {}) => {
            const path = new URL(url).pathname;
            if (path === '/admin/runs') return jsonResponse({ ok: true, runId: 'run-monitor', ticket: 'ticket-monitor' });
            if (path === '/v1/runs/run-monitor/events') {
                monitorSignal = options.signal;
                return {
                    ok: true,
                    status: 200,
                    body: { getReader: () => ({ read: () => readGate.promise }) },
                };
            }
            if (path === '/admin/runs/run-monitor/abort') return jsonResponse({ ok: true });
            throw new Error(`unexpected runtime request ${path}`);
        },
    });

    await bridge.startRun({ userId: 'alice' }, {
        ...startPayload(),
        historyCommit: { conversationId: 'conversation-1', userMessage: { content: 'hello' } },
    });
    await new Promise((resolve) => setImmediate(resolve));
    const monitor = bridge.historyMonitors.get('run-monitor');
    assert.ok(monitor, 'monitor must be registered before maintenance starts');

    await bridge.beginMaintenance();
    await assert.rejects(monitor, (error) => error?.name === 'AbortError' || error?.code === 'ai_run_generation_expired');
    assert.equal(monitorSignal.aborted, true);
    assert.equal(bridge.historyMonitors.size, 0);
    bridge.endMaintenance();
});

test('the absolute maintenance deadline wins a simultaneous late abort completion', async () => {
    let startBody;
    let abortSignal;
    const bridge = new AiRuntimeBridge({
        baseUrl: 'http://runtime.test',
        maintenanceTimeoutMs: 35,
        fetchImpl: async (url, options = {}) => {
            const path = new URL(url).pathname;
            if (path === '/admin/runs') {
                startBody = JSON.parse(options.body);
                return jsonResponse({ ok: true, runId: 'deadline-race', ticket: 'ticket' });
            }
            if (path === '/admin/runs/deadline-race/abort') {
                abortSignal = options.signal;
                return new Promise((resolve) => {
                    options.signal.addEventListener('abort', () => resolve(jsonResponse({ ok: true })), { once: true });
                });
            }
            throw new Error(`unexpected runtime request ${path}`);
        },
    });

    await bridge.startRun({ userId: 'alice' }, startPayload());
    const retiredGeneration = startBody.databaseGeneration;
    await assert.rejects(
        bridge.beginMaintenance(),
        (error) => error.code === 'ai_runtime_maintenance_timeout',
    );
    assert.equal(abortSignal.aborted, true);
    assert.notEqual(bridge.databaseGeneration, retiredGeneration);
    assert.throws(
        () => bridge.assertRunAccess({ userId: 'alice' }, 'deadline-race'),
        (error) => error.code === 'database_maintenance',
    );
    bridge.endMaintenance();
});

test('late host completion after rollback cannot write activity through a retired host lease', async () => {
    const remoteGate = deferred();
    let startBody;
    let activities = 0;
    const hostAbort = new AbortController();
    const bridge = new AiRuntimeBridge({
        baseUrl: 'http://runtime.test',
        maintenanceTimeoutMs: 35,
        fetchImpl: async (url, options = {}) => {
            const path = new URL(url).pathname;
            if (path === '/admin/runs') {
                startBody = JSON.parse(options.body);
                return jsonResponse({ ok: true, runId: 'late-host', ticket: 'ticket' });
            }
            if (path === '/admin/runs/late-host/abort') return jsonResponse({ ok: true });
            throw new Error(`unexpected runtime request ${path}`);
        },
    });
    await bridge.startRun({ userId: 'alice' }, startPayload());
    const releaseHost = bridge.beginHostCall({
        userId: 'alice',
        runId: 'late-host',
        databaseGeneration: startBody.databaseGeneration,
        runNonce: startBody.runNonce,
        abortController: hostAbort,
    });
    assert.equal(Object.getOwnPropertyDescriptor(releaseHost, 'assertLive').writable, false);

    const tool = executeAiToolForHost('remote_execute', {
        connectionIds: ['connection-1'], command: 'echo safe', timeoutSeconds: 1,
    }, {
        user: { userId: 'alice', role: 'user' },
        confirmedToolId: 'remote_execute',
        runId: 'late-host',
        signal: hostAbort.signal,
        hostCallGuard: releaseHost.assertLive,
        deps: {
            storage: { getSettings: () => ({ ai: { permissions: { remoteExecute: true } } }) },
            resourceService: {
                listConnections: () => [{ id: 'connection-1', protocol: 'SSH', name: 'host', host: 'example.test', username: 'alice' }],
            },
            runRemoteCommand: () => remoteGate.promise,
            addActivity: () => { activities += 1; },
        },
    });
    await new Promise((resolve) => setImmediate(resolve));

    await assert.rejects(
        bridge.beginMaintenance(),
        (error) => error.code === 'ai_runtime_maintenance_timeout',
    );
    assert.equal(bridge.inFlightHostCalls, 1, 'rollback must retain the unfinished host lease');
    bridge.endMaintenance();

    remoteGate.resolve({ stdout: 'late result', exitCode: 0 });
    await assert.rejects(tool, (error) => error.code === 'ai_run_generation_expired');
    assert.equal(activities, 0, 'the reopened rollback database must not receive late host activity');
    releaseHost();
    assert.equal(bridge.inFlightHostCalls, 0);
});

test('late promise microtasks cannot resolve past the absolute maintenance deadline', async () => {
    const bridge = new AiRuntimeBridge({ baseUrl: 'http://runtime.test' });
    const deadline = Date.now() + 20;
    const lateMicrotask = bridge._awaitAbortable(Promise.resolve('late'), null, deadline);
    const blockedUntil = Date.now() + 35;
    while (Date.now() < blockedUntil) {}

    await assert.rejects(
        lateMicrotask,
        (error) => error.code === 'ai_runtime_maintenance_timeout',
    );
});

test('maintenance deadline keeps a standalone process alive until it rejects, then releases its timer', () => {
    const script = `
        const { AiRuntimeBridge } = require('./ai-runtime-bridge.js');
        const bridge = new AiRuntimeBridge({ baseUrl: 'http://runtime.test', maintenanceTimeoutMs: 25 });
        bridge.pendingStarts.add({ abortController: new AbortController(), operation: new Promise(() => {}) });
        bridge.beginMaintenance().then(
            () => { process.exitCode = 1; },
            (error) => { process.stdout.write(String(error.code || error.name)); },
        );
    `;
    const child = spawnSync(process.execPath, ['-e', script], {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 2_000,
    });
    assert.equal(child.error, undefined, child.error?.message);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, 'ai_runtime_maintenance_timeout');
});
