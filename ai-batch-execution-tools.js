'use strict';

const crypto = require('crypto');
const { HttpError } = require('./authz');
const id = { type: 'string', minLength: 1, maxLength: 160 };
const SCHEMAS = Object.freeze({
    batch_execution_status_v1: { type: 'object', properties: {}, additionalProperties: false },
    batch_execution_action_v1: {
        type: 'object', properties: {
            snapshotId: id, requestId: id,
            action: { type: 'string', enum: ['select', 'deselect', 'focus', 'promote', 'reconnect', 'command', 'shortcut', 'font', 'interrupt', 'clear'] },
            targetIds: { type: 'array', items: id, minItems: 1, maxItems: 100, uniqueItems: true },
            connectionIds: { type: 'array', items: id, minItems: 1, maxItems: 100, uniqueItems: true },
            command: { type: 'string', minLength: 1, maxLength: 20000 },
            keys: { type: 'array', items: { type: 'string', maxLength: 32 }, minItems: 1, maxItems: 8 },
            delta: { type: 'integer', enum: [-1, 1] },
            timeoutSeconds: { type: 'integer', minimum: 1, maximum: 300 },
        }, required: ['snapshotId', 'requestId', 'action'], additionalProperties: false,
    },
});
const TTL = 10 * 60 * 1000;
const stores = new WeakMap();
const ledgerFor = (sessions) => {
    let value = stores.get(sessions);
    if (!value) { value = { snapshots: new Map(), requests: new Map(), tickets: new Map() }; stores.set(sessions, value); }
    return value;
};
// This closure is intentionally the only stable object outside Host proxies.
// It exposes no SSH/resources/settings API. Its invocation is itself guarded.
function bindLedger(deps) {
    if (!deps.batchExecutionLedger) deps.batchExecutionLedger = () => ledgerFor(deps.terminalSessions);
    // Detached lease checker has no dispatch capability and revalidates the
    // current run owner/generation at delivery, not a released Host-call token.
    if (!deps.batchExecutionRunChecker) deps.batchExecutionRunChecker = () => (user, runId) => {
        if (!deps.runtimeBridge?.assertRunAccess) fail('ai_run_expired', '来源 Run 不可用');
        deps.runtimeBridge.assertRunAccess(user, runId);
    };
}
function assertLive(ctx) {
    ctx?.hostCallGuard?.();
    if (ctx?.signal?.aborted) throw Object.assign(new Error('AI 请求已停止'), { name: 'AbortError' });
}
function fail(code, message, status = 409) { throw new HttpError(status, code, message); }
function actorKey(user) {
    if (!user?.userId) fail('app_session_expired', '未登录', 401);
    return String(user.userId);
}
function settings(deps, user) { return deps.userSettingsService?.runtimeAi(user) || deps.storage?.getSettings?.().ai || {}; }
function authorizeFeature(deps, user) {
    actorKey(user);
    const ai = settings(deps, user);
    if (!ai.enabled || ai.permissions?.remoteExecute === false) fail('batch_execution_disabled', 'AI 批量执行权限未开启', 403);
    const policy = deps.aiPolicyService || deps.aiPolicy;
    if (policy?.policyFor(user)?.mode === 'disabled') fail('ai_disabled', 'AI 已禁用', 403);
    if (!deps.resourceService || !deps.terminalSessions) fail('batch_execution_unavailable', '批量执行服务不可用', 503);
}
function store(deps) {
    const value = deps.batchExecutionLedger ? deps.batchExecutionLedger() : ledgerFor(deps.terminalSessions);
    const now = Date.now();
    for (const map of [value.snapshots, value.requests, value.tickets]) for (const [k, v] of map) if (v.expiresAt < now) map.delete(k);
    return value;
}
function reserve(map, key, value) {
    if (map.size >= 2000) fail('batch_execution_capacity', '批量操作账本已满，请稍后重试', 429);
    map.set(key, value);
}
function assertConnection(deps, user, connectionId, capability) {
    const conn = deps.resourceService.getRawAuthorized(user, 'connection', String(connectionId), capability);
    if (String(conn.protocol || '').toUpperCase() !== 'SSH') fail('invalid_terminal_protocol', '批量页仅支持 SSH', 400);
    return conn;
}
function ownedSession(deps, user, target) {
    const session = deps.terminalSessions.get(String(target.sessionId || target.id));
    if (!session || session.closed || String(session.userId || '') !== actorKey(user)
        || String(session.connectionId || session.connectionConfig?.id || '') !== String(target.connectionId)) {
        fail('batch_target_stale', '目标 SSH 会话已关闭、替换或不属于当前账户');
    }
    return session;
}
function status(deps, ctx) {
    assertLive(ctx);
    authorizeFeature(deps, ctx.user);
    const raw = ctx.context?.batchExecution;
    if (!raw || raw.accountId !== actorKey(ctx.user) || !raw.snapshotId || !Array.isArray(raw.targets)
        || !Number.isFinite(raw.capturedAt) || Math.abs(Date.now() - raw.capturedAt) > 120000) {
        fail('batch_snapshot_required', '需要当前账户的批量页面新快照；不可使用普通终端焦点推断目标');
    }
    const targets = [];
    const refs = new Map();
    for (const item of raw.targets.slice(0, 100)) {
        try {
            const conn = assertConnection(deps, ctx.user, item.connectionId, 'view');
            let session = null;
            try { session = ownedSession(deps, ctx.user, item); } catch {}
            let executable = false;
            try { assertConnection(deps, ctx.user, conn.id, 'execute'); assertConnection(deps, ctx.user, conn.id, 'control'); executable = true; } catch {}
            const target = {
                id: String(item.id), sessionId: String(item.sessionId || item.id), connectionId: String(conn.id),
                name: String(conn.name || ''), status: String(item.status || 'unknown'), loaded: item.loaded === true,
                connected: !!session?.sshStream?.writable && !session?.closed,
                canControl: raw.view === 'remote' && item.canControl === true && executable && !!session?.sshStream?.writable,
                sharedView: item.sharedView === true, lastSentAt: Number(item.lastSentAt) || 0,
                timeout: item.timeout ? { state: String(item.timeout.state || ''), at: Number(item.timeout.at) || 0 } : null,
            };
            targets.push(target);
            if (session) refs.set(target.id, session);
        } catch { /* inaccessible resources never enter the snapshot */ }
    }
    const available = deps.resourceService.listConnections(ctx.user).filter(c => String(c.protocol).toUpperCase() === 'SSH')
        .slice(0, 100).map(c => ({ connectionId: String(c.id), name: String(c.name || ''), selected: targets.some(t => t.connectionId === String(c.id)) }));
    const snapshot = {
        snapshotId: String(raw.snapshotId), accountId: actorKey(ctx.user), capturedAt: raw.capturedAt,
        expiresAt: Date.now() + TTL, view: String(raw.view || ''), focusedTargetId: String(raw.focusedTargetId || ''),
        targets, availableConnections: available,
        evidence: 'frontend_page_snapshot_with_server_session_and_acl_checks',
        receiptBoundary: 'sent means iframe/WebSocket accepted input, NOT shell completion or exit status',
    };
    assertLive(ctx);
    const state = store(deps);
    const key = `${snapshot.accountId}:${snapshot.snapshotId}`;
    if (!state.snapshots.has(key)) reserve(state.snapshots, key, { ...snapshot, refs });
    // A snapshot id is immutable even if the client submits newer data under it.
    const saved = state.snapshots.get(key);
    const { refs: _refs, ...result } = saved;
    return { ...result, receipts: [...state.requests.values()].filter(x => x.accountId === snapshot.accountId).slice(-30).map(x => ({ requestId: x.requestId, action: x.action, state: x.state, result: x.result || null })) };
}
function preflight(deps, ctx, args) {
    assertLive(ctx);
    authorizeFeature(deps, ctx.user);
    const state = store(deps);
    const snapshot = state.snapshots.get(`${actorKey(ctx.user)}:${args.snapshotId}`);
    if (!snapshot || snapshot.view !== 'remote') fail('batch_snapshot_stale', '批量页快照不存在、过期或不是当前可操作视图');
    const selecting = args.action === 'select';
    const ids = selecting ? args.connectionIds : args.targetIds;
    if (!Array.isArray(ids) || !ids.length) fail('invalid_tool_arguments', selecting ? 'select 必须指定 connectionIds' : '必须明确指定快照 targetIds', 400);
    if (['focus', 'promote'].includes(args.action) && ids.length !== 1) fail('invalid_tool_arguments', '聚焦/提升只能指定一个目标', 400);
    if (args.action === 'command' && !String(args.command || '').trim()) fail('invalid_tool_arguments', '请输入命令', 400);
    if (args.action === 'shortcut' && (!args.keys?.length || args.keys.length > 8)) fail('invalid_tool_arguments', '缺少快捷键', 400);
    if (args.action === 'font' && ![-1, 1].includes(args.delta)) fail('invalid_tool_arguments', '字号 delta 只能为 -1/1', 400);
    const targets = [];
    for (const targetId of ids) {
        if (selecting) {
            if (!snapshot.availableConnections.some(c => c.connectionId === targetId)) fail('batch_target_scope', '连接不在快照候选范围');
            assertConnection(deps, ctx.user, targetId, 'use');
            targets.push({ connectionId: targetId });
        } else {
            const target = snapshot.targets.find(t => t.id === targetId);
            if (!target) fail('batch_target_scope', '目标不在快照范围');
            assertConnection(deps, ctx.user, target.connectionId, 'control');
            if (snapshot.refs.has(targetId) && snapshot.refs.get(targetId) !== deps.terminalSessions.get(target.sessionId)) fail('batch_target_stale', '目标 SSH 会话已替换');
            if (['command', 'shortcut', 'interrupt', 'clear'].includes(args.action)) assertConnection(deps, ctx.user, target.connectionId, 'execute');
            if (!['deselect', 'focus', 'promote', 'reconnect'].includes(args.action)) {
                const session = ownedSession(deps, ctx.user, target);
                if (snapshot.refs.get(targetId) !== session || !target.canControl || !session.sshStream?.writable) fail('batch_target_stale', '目标不是快照中的可控制已连接会话');
            }
            targets.push(target);
        }
    }
    return { state, snapshot, targets };
}
function action(deps, ctx, args) {
    const { state, snapshot, targets } = preflight(deps, ctx, args);
    // Only the canonical wrapper / trusted Host permission decision may reach here.
    if (ctx.confirmedToolId !== 'batch_execution_action_v1') fail('confirmation_required', '需要用户审批', 403);
    const key = `${actorKey(ctx.user)}:${args.requestId}`;
    const fingerprint = JSON.stringify(args);
    const previous = state.requests.get(key);
    if (previous) {
        if (previous.fingerprint !== fingerprint) fail('batch_request_conflict', 'requestId 已绑定另一操作');
        return { requestId: args.requestId, state: previous.state, result: previous.result || null, duplicate: true, message: '不重新发送；如回执未知，先读取状态' };
    }
    assertLive(ctx);
    if (state.requests.size >= 2000 || state.tickets.size >= 2000) fail('batch_execution_capacity', '批量操作账本已满', 429);
    const ticketId = crypto.randomUUID();
    const entry = { accountId: actorKey(ctx.user), runId: String(ctx.runId || ''), checkRun: deps.batchExecutionRunChecker ? deps.batchExecutionRunChecker() : null, requestId: args.requestId, action: args.action, args: { ...args }, fingerprint, snapshot, targets, ticketId, state: 'approved_pending_client', expiresAt: Date.now() + TTL };
    reserve(state.requests, key, entry);
    reserve(state.tickets, ticketId, entry);
    return {
        requestId: args.requestId, state: entry.state, clientCaptureRequired: true,
        clientCapture: { type: 'batch_execution_action_v1', vision: false, ticketId, snapshotId: args.snapshotId, requestId: args.requestId },
        message: '用户已审批，等待原页面重新校验目标并经现有分派执行；此时尚未发送',
    };
}
function claim(deps, user, body) {
    authorizeFeature(deps, user);
    const entry = store(deps).tickets.get(String(body.ticketId || ''));
    if (!entry || entry.accountId !== actorKey(user)) fail('batch_ticket_not_found', '操作票据不存在', 404);
    if (entry.state !== 'approved_pending_client') fail('batch_ticket_consumed', '票据已消费，禁止重发');
    if (body.snapshotId !== entry.args.snapshotId) fail('batch_target_scope', '快照不匹配');
    if (entry.runId) {
        if (!entry.checkRun) fail('ai_run_expired', '来源 Run 不可用');
        entry.checkRun(user, entry.runId);
    }
    preflight(deps, { user }, entry.args);
    entry.state = 'claimed_delivery_unknown';
    return { ticketId: entry.ticketId, accountId: entry.accountId, args: entry.args, targets: entry.targets, expiresAt: entry.expiresAt };
}
function receipt(deps, user, body) {
    const entry = store(deps).tickets.get(String(body.ticketId || ''));
    if (!entry || entry.accountId !== actorKey(user)) fail('batch_ticket_not_found', '操作票据不存在', 404);
    if (entry.result) return entry.result;
    if (entry.state !== 'claimed_delivery_unknown') fail('batch_ticket_not_claimed', '操作未开始');
    // Never accept completed/exitCode from a browser: it only knows transport/UI receipts.
    const raw = body.result || {};
    entry.result = {
        requestId: entry.requestId, action: entry.action, at: Date.now(),
        state: ['cancelled_before_send', 'client_error', 'ui_applied', 'transport_receipt'].includes(raw.state) ? raw.state : 'delivery_unknown',
        sent: Math.max(0, Math.min(entry.targets.length, Number(raw.sent) || 0)),
        failed: Math.max(0, Math.min(entry.targets.length, Number(raw.failed) || 0)),
        total: entry.targets.length, error: String(raw.error || '').slice(0, 500), deliveryUnknown: raw.deliveryUnknown === true,
        postDispatchChanged: String(raw.postDispatchChanged || '').slice(0, 100),
        evidence: 'client_reported_iframe_transport_or_ui_only', commandCompleted: false,
        targets: (Array.isArray(raw.targets) ? raw.targets : []).filter(x => x && entry.targets.some(t => (t.id || t.connectionId) === x.id)).slice(0, 100)
            .map(x => ({ id: x.id, state: String(x.state || '').slice(0, 60), reason: String(x.reason || '').slice(0, 100), at: Number(x.at) || 0 })),
    };
    entry.state = entry.result.state;
    return entry.result;
}
function registerRoutes(app, deps, requireUser, handleError) {
    bindLedger(deps);
    for (const [route, fn] of [['claim', claim], ['receipt', receipt]]) {
        app.post(`/api/ai/batch-execution/${route}`, requireUser, (req, res) => {
            try { res.json(fn(deps, req.user, req.body || {})); } catch (err) { handleError(res, err, err.status || 400); }
        });
    }
}
module.exports = { SCHEMAS, bindLedger, authorizeFeature, status, preflight, action, claim, receipt, registerRoutes };
