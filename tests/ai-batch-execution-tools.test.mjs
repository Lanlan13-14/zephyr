import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { createBatchExecutionBridge } from '../public/ai-batch-execution-bridge.js';
import { createRemoteToolDispatcher } from '../public/remote-exec-tool-dispatch.js';
const require = createRequire(import.meta.url);
const batch = require('../ai-batch-execution-tools.js');
const { executeAiToolForHost, listToolCatalog, registerAiRoutes } = require('../ai-agent-service.js');

function fixture() {
    const user = { userId: 'alice', username: 'alice' };
    const denied = new Set();
    const connection = { id: 'c1', name: 'server', protocol: 'SSH' };
    const session = { id: 's1', connectionId: 'c1', userId: 'alice', sshStream: { writable: true }, frame: { contentWindow: {} }, loaded: true, status: 'connected' };
    const deps = {
        storage: { getSettings: () => ({ ai: { enabled: true, permissions: { remoteExecute: true }, sensitive: { autoConfirm: true, requireConfirmation: false } } }) },
        terminalSessions: new Map([['s1', session]]),
        resourceService: {
            getRawAuthorized: (u, type, id, cap) => { if (u.userId !== 'alice' || id !== 'c1' || denied.has(cap)) throw new Error(`denied ${cap}`); return connection; },
            listConnections: () => [connection],
        },
    };
    const ctx = { user, context: { batchExecution: { accountId: 'alice', snapshotId: 'snap', capturedAt: Date.now(), view: 'remote', focusedTargetId: 's1', targets: [{ id: 's1', sessionId: 's1', connectionId: 'c1', loaded: true, status: 'connected', canControl: true }] } } };
    const args = { snapshotId: 'snap', requestId: 'request-1', action: 'command', targetIds: ['s1'], command: 'echo hello' };
    return { user, denied, session, deps, ctx, args };
}

test('catalog binds readonly observation and mandatory approval without model authorization fields', () => {
    const catalog = listToolCatalog({});
    const status = catalog.find(t => t.name === 'batch_execution_status_v1');
    const action = catalog.find(t => t.name === 'batch_execution_action_v1');
    assert.equal(status.readOnly, true); assert.equal(status.confirmation, 'never');
    assert.equal(action.readOnly, false); assert.equal(action.confirmation, 'always');
    assert.equal(action.parallelSafe, false);
    for (const key of ['confirmed', 'approved', 'autoConfirm', 'accountId', 'ticketId']) assert.equal(key in action.parameters.properties, false);
});
test('status distinguishes view/focus, authority and connection from frontend selection', () => {
    const f = fixture();
    f.ctx.context.batchExecution.view = 'terminal';
    f.denied.add('execute');
    const result = batch.status(f.deps, f.ctx);
    assert.equal(result.focusedTargetId, 's1'); assert.equal(result.targets[0].connected, true);
    assert.equal(result.targets[0].canControl, false); assert.equal(result.view, 'terminal');
    assert.throws(() => batch.preflight(f.deps, f.ctx, f.args), /批量页快照/);
});
test('canonical approval is unavoidable even if user sensitive settings auto-confirm everything', async () => {
    const f = fixture(); batch.status(f.deps, f.ctx);
    const result = await executeAiToolForHost('batch_execution_action_v1', f.args, { ...f.ctx, deps: f.deps });
    assert.equal(result.confirmationRequired, true);
    assert.equal(result.clientCaptureRequired, undefined);
    assert.throws(() => batch.action(f.deps, f.ctx, f.args), /用户审批/);
});
test('model supplied approval fields fail schema validation', async () => {
    const f = fixture(); batch.status(f.deps, f.ctx);
    await assert.rejects(executeAiToolForHost('batch_execution_action_v1', { ...f.args, confirmed: true }, { ...f.ctx, deps: f.deps }), e => e.code === 'invalid_tool_arguments');
});
test('target ACL, stale server sessions, missing scope and account changes fail closed', () => {
    const f = fixture(); batch.status(f.deps, f.ctx);
    f.denied.add('execute'); assert.throws(() => batch.preflight(f.deps, f.ctx, f.args), /denied execute/); f.denied.clear();
    assert.throws(() => batch.preflight(f.deps, f.ctx, { ...f.args, targetIds: ['other'] }), /快照范围/);
    assert.throws(() => batch.preflight(f.deps, f.ctx, { ...f.args, targetIds: undefined }), /明确指定/);
    f.deps.terminalSessions.set('s1', { ...f.session }); assert.throws(() => batch.preflight(f.deps, f.ctx, f.args), e => e.code === 'batch_target_stale');
    f.ctx.user = { userId: 'bob' }; assert.throws(() => batch.preflight(f.deps, f.ctx, f.args), /快照/);
});
test('approved ticket is at most once and cannot be altered or stolen; receipt is not exit status', () => {
    const f = fixture(); batch.status(f.deps, f.ctx);
    const ctx = { ...f.ctx, confirmedToolId: 'batch_execution_action_v1' };
    const result = batch.action(f.deps, ctx, f.args);
    assert.equal(result.state, 'approved_pending_client');
    assert.equal(batch.action(f.deps, ctx, f.args).duplicate, true);
    assert.throws(() => batch.action(f.deps, ctx, { ...f.args, command: 'rm -rf /tmp/example' }), /requestId/);
    const capture = result.clientCapture;
    assert.throws(() => batch.claim(f.deps, { userId: 'bob' }, capture), /票据不存在/);
    const claimed = batch.claim(f.deps, f.user, capture); assert.equal(claimed.args.command, 'echo hello');
    assert.throws(() => batch.claim(f.deps, f.user, capture), /票据已消费/);
    const receipt = batch.receipt(f.deps, f.user, { ...capture, result: { state: 'completed', exitCode: 0, sent: 100 } });
    assert.equal(receipt.state, 'delivery_unknown'); assert.equal(receipt.commandCompleted, false); assert.equal(receipt.sent, 1); assert.equal(receipt.exitCode, undefined);
    assert.deepEqual(batch.receipt(f.deps, f.user, { ...capture, result: { sent: 0 } }), receipt);
});
test('permission revocation between approval and delivery blocks ticket claim', () => {
    const f = fixture(); batch.status(f.deps, f.ctx);
    const result = batch.action(f.deps, { ...f.ctx, confirmedToolId: 'batch_execution_action_v1' }, f.args);
    f.denied.add('control'); assert.throws(() => batch.claim(f.deps, f.user, result.clientCapture), /denied control/);
});
test('host guarded dependency wrappers share immutable snapshot ledger across calls', async () => {
    const f = fixture(); let guarded = 0;
    const hostCtx = { ...f.ctx, deps: f.deps, hostCallGuard: () => guarded++ };
    await executeAiToolForHost('batch_execution_status_v1', {}, hostCtx);
    const result = await executeAiToolForHost('batch_execution_action_v1', f.args, { ...hostCtx, confirmedToolId: 'batch_execution_action_v1' });
    assert.equal(result.data.state, 'approved_pending_client'); assert.ok(guarded > 2);
});
function clientFixture() {
    const f = fixture(); let view = 'remote', account = 'alice', focused = 's1', sent = 0, claimed = 0;
    let all = [f.session]; let claimWait = null;
    const ticket = { accountId: 'alice', args: f.args, targets: [{ id: 's1', connectionId: 'c1' }], expiresAt: Date.now() + 60000 };
    const receipts = [];
    const bridge = createBatchExecutionBridge({
        getAccountId: () => account, getView: () => view, getFocusedId: () => focused, getSessions: () => all,
        getConnections: () => [{ id: 'c1', protocol: 'SSH' }], canControl: () => true, getTimeoutSeconds: () => 30,
        uuid: () => 'snap', api: async (url, options) => {
            if (url.endsWith('/claim')) { claimed++; if (claimWait) await claimWait; return ticket; }
            const body = JSON.parse(options.body); receipts.push(body.result); return body.result;
        },
        dispatch: async (type, payload, scope) => { sent++; assert.deepEqual(scope.targetIds, ['s1']); return { sent: 1, failed: 0, total: 1, targets: [{ id: 's1', state: 'transport_accepted' }] }; },
        select: () => true, deselect: () => true, focus: () => true, promote: () => true, reconnect: () => true,
    });
    bridge.snapshot();
    return { bridge, ticket, capture: { ticketId: 'ticket', snapshotId: 'snap' }, receipts,
        get sent() { return sent; }, get claimed() { return claimed; }, set view(x) { view = x; }, set account(x) { account = x; }, set focused(x) { focused = x; }, set all(x) { all = x; }, set wait(x) { claimWait = x; } };
}
test('frontend binds snapshot target not new focus and never sends duplicate event twice', async () => {
    const f = clientFixture(); f.focused = 'other';
    const first = f.bridge.execute(f.capture); const second = f.bridge.execute(f.capture);
    assert.equal(first, second); const result = await first;
    assert.equal(f.sent, 1); assert.equal(f.claimed, 1); assert.equal(result.commandCompleted, false);
});
test('frontend refuses changed view, account or frame/session identity after approval', async () => {
    for (const change of [f => { f.view = 'terminal'; }, f => { f.account = 'bob'; }, f => { f.all = []; }]) {
        const f = clientFixture(); change(f); const result = await f.bridge.execute(f.capture);
        assert.equal(f.sent, 0); assert.equal(result.state, 'client_error');
    }
});
test('cancellation during ticket claim never dispatches and records cancelled result', async () => {
    const f = clientFixture(); let release; f.wait = new Promise(r => { release = r; });
    const controller = new AbortController(); const flight = f.bridge.execute(f.capture, { signal: controller.signal });
    controller.abort(); release(); const result = await flight;
    assert.equal(f.sent, 0); assert.equal(result.state, 'cancelled_before_send'); assert.equal(f.receipts.length, 1);
});
test('dispatcher detailed receipts preserve timeout uncertainty and genuine negative ACK reasons', async () => {
    const a = { id: 'a', status: 'connected', loaded: true }, b = { id: 'b', status: 'connected', loaded: true };
    const messages = []; let timer;
    const d = createRemoteToolDispatcher({ getSessions: () => [a, b], getActiveId: () => 'a', isActive: () => true,
        postMessage: (s, m) => { messages.push(m); return true; }, setTimer: fn => { timer = fn; return 1; }, clearTimer: () => {} });
    const flight = d.send('remote-exec-tool-command', { command: 'echo hi' }, { detailed: true });
    assert.equal(d.acknowledge(a, { requestId: messages[0].requestId, type: 'remote-exec-tool-command-failed', reason: 'not-controller' }), true);
    timer(); const result = await flight;
    assert.equal(result.sent, 0); assert.equal(result.targets[0].reason, 'not-controller'); assert.equal(result.targets[1].state, 'delivery_unknown');
});

test('cancelled/revoked Host cannot mint tickets, including revocation during final ACL resolution', async () => {
    for (const mode of ['cancelled', 'revoked', 'revoked-during-acl']) {
        const f = fixture(); batch.status(f.deps, f.ctx);
        const controller = new AbortController(); let revoked = mode === 'revoked';
        if (mode === 'cancelled') controller.abort();
        const original = f.deps.resourceService.getRawAuthorized;
        f.deps.resourceService.getRawAuthorized = (...args) => { const result = original(...args); if (mode === 'revoked-during-acl' && args[3] === 'execute') revoked = true; return result; };
        await assert.rejects(executeAiToolForHost('batch_execution_action_v1', f.args, { ...f.ctx, deps: f.deps, signal: controller.signal,
            confirmedToolId: 'batch_execution_action_v1', hostCallGuard: () => { if (revoked) throw new Error('revoked lease'); } }));
        assert.throws(() => batch.claim(f.deps, f.user, { ticketId: 'not-minted', snapshotId: 'snap' }), /票据不存在/);
    }
});
test('source Run cancellation after approval blocks delivery even with valid ACL', async () => {
    const f = fixture(); let live = true;
    f.deps.runtimeBridge = { assertRunAccess(user, runId) { assert.equal(user.userId, 'alice'); assert.equal(runId, 'run1'); if (!live) throw new Error('ai_run_expired'); } };
    const host = { ...f.ctx, deps: f.deps, runId: 'run1', hostCallGuard: () => {} };
    await executeAiToolForHost('batch_execution_status_v1', {}, host);
    const approved = await executeAiToolForHost('batch_execution_action_v1', f.args, { ...host, confirmedToolId: 'batch_execution_action_v1' });
    live = false; assert.throws(() => batch.claim(f.deps, f.user, approved.data.clientCapture), /ai_run_expired/);
});
test('immutable snapshot never widens target scope on replay under same id', () => {
    const f = fixture(); batch.status(f.deps, f.ctx);
    f.ctx.context.batchExecution.targets.push({ id: 's2', sessionId: 's2', connectionId: 'c1', canControl: true });
    const replay = batch.status(f.deps, f.ctx); assert.equal(replay.targets.length, 1);
    assert.throws(() => batch.preflight(f.deps, f.ctx, { ...f.args, targetIds: ['s2'] }), /快照范围/);
});
test('cancel after dispatch returns its actual ACK instead of pretending remote command was cancelled', async () => {
    const f = clientFixture(); const controller = new AbortController();
    const result = await f.bridge.execute(f.capture, { signal: controller.signal }); controller.abort();
    assert.equal(result.sent, 1); assert.equal(result.state, 'transport_receipt'); assert.equal(result.commandCompleted, false);
});

test('leaving then returning to batch page invalidates old page scope instead of reviving it', async () => {
    const f = clientFixture(); f.bridge.invalidate(); f.view = 'remote';
    const result = await f.bridge.execute(f.capture); assert.equal(f.sent, 0); assert.match(result.error, /snapshot_stale/);
});
test('already aborted request never claims an approved ticket', async () => {
    const f = clientFixture(); const controller = new AbortController(); controller.abort();
    const result = await f.bridge.execute(f.capture, { signal: controller.signal });
    assert.equal(result.state, 'cancelled_before_send'); assert.equal(f.claimed, 0); assert.equal(f.sent, 0);
});

test('real existing confirmation route rejects or cross-account denies without minting any dispatch ticket', async () => {
    const f = fixture(); const routes = new Map();
    const app = Object.fromEntries(['get', 'post', 'patch', 'delete', 'put'].map(method => [method, (path, ...handlers) => routes.set(`${method}:${path}`, handlers.at(-1))]));
    registerAiRoutes(app, { ...f.deps, requireUser: (_req, _res, next) => next() });
    batch.status(f.deps, f.ctx);
    const confirmation = await executeAiToolForHost('batch_execution_action_v1', f.args, { ...f.ctx, deps: f.deps });
    async function decide(user, approve) {
        const req = Object.assign(new EventEmitter(), { user, params: { id: confirmation.confirmation.id }, body: { approve } });
        const res = Object.assign(new EventEmitter(), { writableEnded: false, statusCode: 200, payload: null,
            status(code) { this.statusCode = code; return this; }, json(body) { this.payload = body; this.writableEnded = true; return this; } });
        await routes.get('post:/api/ai/confirm/:id')(req, res); return res;
    }
    const stolen = await decide({ userId: 'bob' }, true); assert.equal(stolen.statusCode, 404);
    const denied = await decide(f.user, false); assert.equal(denied.payload.cancelled, true);
    const replay = await decide(f.user, true); assert.equal(replay.statusCode, 404);
    const status = batch.status(f.deps, f.ctx); assert.equal(status.receipts.length, 0);
});
