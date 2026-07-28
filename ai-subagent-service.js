'use strict';

const crypto = require('crypto');

/**
 * S6/S7 Subagent harness (Reasonix-inspired).
 * Runs nested tool loops on the Node host with isolated transcript.
 * Parent only receives the final summary tool_result.
 */

const DEFAULT_MAX_CONCURRENCY = 3;
const DEFAULT_MAX_WRITERS = 1;
const DEFAULT_MAX_STEPS = 8;

const PROFILES = Object.freeze({
    'readonly-scout': Object.freeze({
        id: 'readonly-scout',
        title: '只读勘察',
        description: '多机/资产只读勘察：list/get、terminal_read、remote_read、workspace/attachment read',
        readOnly: true,
        maxSteps: 8,
        allow: Object.freeze([
            'capability_search',
            'connection_list_v1', 'connection_get_v1', 'connection_test_v1',
            'proxy_list_v1', 'proxy_get_v1',
            'ssh_key_list_v1', 'ssh_key_get_v1', 'ssh_key_validate_v1',
            'jump_host_list_v1', 'jump_host_get_v1',
            'snippet_list_v1', 'snippet_get_v1',
            'terminal_read_v1', 'terminal_wait_v1',
            'remote_read_file', 'remote_file_snapshot_list',
            'workspace_list_v1', 'workspace_read_v1',
            'user_attachment_read_v1', 'user_attachment_view_v1',
            'memory_search', 'note_list', 'note_search', 'note_get',
            'list_env_vars', 'agent_list_v1', 'agent_get_v1',
            'agent_file_list_v1', 'agent_file_stat_v1', 'agent_file_read_text_v1',
            'subagent_list_profiles_v1',
        ]),
        deny: Object.freeze(['memory_save', 'get_env_var', 'session_exec_v1']),
    }),
    'log-analyst': Object.freeze({
        id: 'log-analyst',
        title: '日志分析',
        description: '分析会话附件与 workspace 日志草稿',
        readOnly: true,
        maxSteps: 10,
        allow: Object.freeze([
            'capability_search',
            'workspace_list_v1', 'workspace_read_v1',
            'user_attachment_read_v1', 'user_attachment_view_v1',
            'memory_search', 'note_search', 'note_get',
            'subagent_list_profiles_v1',
        ]),
        deny: Object.freeze(['memory_save', 'session_exec_v1']),
    }),
    'vision-operator': Object.freeze({
        id: 'vision-operator',
        title: '远程桌面视觉子循环',
        description: 'RDP/VNC capture/action/verify；写操作仍回主代理确认',
        readOnly: false,
        maxSteps: 12,
        allow: Object.freeze([
            'capability_search',
            'connection_list_v1', 'connection_get_v1', 'connection_open_v1',
            'remote_desktop_capture_v1', 'remote_desktop_action_v1', 'remote_desktop_verify_v1',
            'ui_action',
            'workspace_list_v1', 'workspace_read_v1',
            'subagent_list_profiles_v1',
        ]),
        deny: Object.freeze(['memory_save', 'remote_execute', 'remote_write_file', 'session_exec_v1']),
    }),
    'doc-writer': Object.freeze({
        id: 'doc-writer',
        title: '报告撰写',
        description: '读取附件/workspace 并写入 outputs 报告',
        readOnly: false,
        maxSteps: 8,
        allow: Object.freeze([
            'capability_search',
            'workspace_list_v1', 'workspace_read_v1', 'workspace_write_v1',
            'user_attachment_read_v1', 'user_attachment_view_v1',
            'memory_search', 'note_search', 'note_get', 'note_create', 'note_update',
            'subagent_list_profiles_v1',
        ]),
        deny: Object.freeze(['memory_save', 'remote_execute', 'remote_write_file', 'get_env_var', 'session_exec_v1']),
    }),
});

function listProfiles() {
    return Object.values(PROFILES).map((p) => ({
        id: p.id,
        title: p.title,
        description: p.description,
        readOnly: !!p.readOnly,
        maxSteps: p.maxSteps,
        toolCount: p.allow.length,
    }));
}

function getProfile(id) {
    return PROFILES[String(id || '').trim()] || null;
}

/** Simple in-process resource lock table (per Node process). */
class ResourceLockTable {
    constructor() {
        this.locks = new Map(); // key → { owner, mode: 'read'|'write' }
    }
    _key(kind, id) {
        return `${kind}:${id}`;
    }
    preflight(claims = [], owner = '') {
        for (const c of claims) {
            const kind = String(c.kind || c.type || 'resource');
            const id = String(c.id || c.connectionId || c.tabId || c.path || '').trim();
            if (!id) continue;
            const mode = c.mode === 'write' || c.write ? 'write' : 'read';
            const key = this._key(kind, id);
            const cur = this.locks.get(key);
            if (!cur) continue;
            if (cur.owner === owner) continue;
            if (mode === 'write' || cur.mode === 'write') {
                const err = new Error(`resource_lock_conflict: ${key} held by ${cur.owner}`);
                err.code = 'resource_lock_conflict';
                err.status = 409;
                throw err;
            }
        }
        return true;
    }
    acquire(claims = [], owner = '') {
        this.preflight(claims, owner);
        const held = [];
        for (const c of claims) {
            const kind = String(c.kind || c.type || 'resource');
            const id = String(c.id || c.connectionId || c.tabId || c.path || '').trim();
            if (!id) continue;
            const mode = c.mode === 'write' || c.write ? 'write' : 'read';
            const key = this._key(kind, id);
            this.locks.set(key, { owner, mode });
            held.push(key);
        }
        return () => {
            for (const key of held) {
                const cur = this.locks.get(key);
                if (cur && cur.owner === owner) this.locks.delete(key);
            }
        };
    }
}

const globalLocks = new ResourceLockTable();
let activeSubagents = 0;
let activeWriters = 0;

function extractClaimsFromPrompt(prompt = '', args = {}) {
    const claims = Array.isArray(args.resourceClaims) ? args.resourceClaims.slice() : [];
    if (args.connectionId) claims.push({ kind: 'connection', id: args.connectionId, mode: args.readOnly === false ? 'write' : 'read' });
    if (Array.isArray(args.connectionIds)) {
        for (const id of args.connectionIds) claims.push({ kind: 'connection', id, mode: 'read' });
    }
    if (args.tabId) claims.push({ kind: 'tab', id: args.tabId, mode: 'write' });
    if (args.workspacePath) claims.push({ kind: 'workspace', id: args.workspacePath, mode: args.readOnly === false ? 'write' : 'read' });
    return claims;
}

/**
 * Run a single subagent task by delegating tool execution to executeAiTool.
 * Model turns use a lightweight provider complete via deps.completeSubagentTurn
 * if provided; otherwise returns a structured plan for the parent model
 * (fail-closed without inventing provider calls).
 */
async function runSubagentTask({
    profileId = 'readonly-scout',
    prompt = '',
    args = {},
    ctx = {},
    deps = {},
    executeTool,
    completeTurn,
} = {}) {
    const profile = getProfile(profileId) || getProfile('readonly-scout');
    const owner = `sub-${crypto.randomBytes(6).toString('hex')}`;
    const readOnly = profile.readOnly || args.readOnly === true;
    if (!readOnly && activeWriters >= DEFAULT_MAX_WRITERS) {
        const err = new Error('subagent_writer_limit');
        err.code = 'subagent_writer_limit';
        err.status = 429;
        throw err;
    }
    if (activeSubagents >= (Number(process.env.ZEPHYR_MAX_SUBAGENT_CONCURRENCY) || DEFAULT_MAX_CONCURRENCY)) {
        const err = new Error('subagent_concurrency_limit');
        err.code = 'subagent_concurrency_limit';
        err.status = 429;
        throw err;
    }

    const claims = extractClaimsFromPrompt(prompt, args);
    // Writers require exclusive connection/tab claims when provided.
    if (!readOnly) {
        for (const c of claims) {
            if (c.kind === 'connection' || c.kind === 'tab') c.mode = c.mode || 'write';
        }
    }
    const release = globalLocks.acquire(claims, owner);
    activeSubagents += 1;
    if (!readOnly) activeWriters += 1;

    const maxSteps = Math.min(
        Number(args.maxSteps) || profile.maxSteps || DEFAULT_MAX_STEPS,
        16
    );
    const allowed = new Set(profile.allow);
    const denied = new Set([...(profile.deny || []), ...(readOnly ? ['memory_save', 'get_env_var'] : [])]);
    // Hard ban YOLO / memory writes / L2 sandbox exec from subagents
    denied.add('memory_save');
    denied.add('session_exec_v1');

    const toolTrace = [];
    let finalText = '';
    const childCtx = {
        ...ctx,
        confirmed: false, // never inherit YOLO auto-confirm for nested writes
        confirmedToolId: '',
        _subagent: true,
        _subagentProfile: profile.id,
        _subagentOwner: owner,
        requireConfirmation: () => ({
            ok: false,
            confirmationRequired: true,
            error: 'subagent_write_requires_parent',
            message: '子代理写操作需回到主代理确认，不会代批 YOLO',
        }),
    };

    try {
        if (typeof completeTurn !== 'function') {
            // Without a model loop, execute zero tools and return profile-bound brief.
            return {
                ok: true,
                profile: profile.id,
                readOnly,
                steps: 0,
                final: `子代理 ${profile.id} 已就绪。任务：${String(prompt || '').slice(0, 2000)}。可用工具：${[...allowed].slice(0, 20).join(', ')}。请主代理在需要时再次调用并配置 completeTurn，或直接用只读工具完成。`,
                toolTrace,
                note: 'no_complete_turn',
            };
        }

        const messages = [
            {
                role: 'system',
                content: `你是 Zephyr 子代理，profile=${profile.id}（${profile.title}）。${readOnly ? '只读模式，禁止任何写操作。' : '写操作若触发确认则停止并回报主代理。'}不要保存 memory。完成后用简洁中文总结事实与证据。`,
            },
            { role: 'user', content: String(prompt || args.task || '').slice(0, 20000) },
        ];

        for (let step = 0; step < maxSteps; step += 1) {
            const turn = await completeTurn({
                messages,
                tools: [...allowed].filter((t) => !denied.has(t)),
                profile,
                step,
            });
            const content = String(turn?.content || turn?.message?.content || '');
            const calls = Array.isArray(turn?.tool_calls)
                ? turn.tool_calls
                : (Array.isArray(turn?.toolCalls) ? turn.toolCalls : []);
            if (!calls.length) {
                finalText = content || finalText;
                break;
            }
            messages.push({
                role: 'assistant',
                content,
                tool_calls: calls,
            });
            for (const raw of calls) {
                const name = raw?.function?.name || raw?.name || '';
                let callArgs = raw?.function?.arguments || raw?.arguments || {};
                if (typeof callArgs === 'string') {
                    try { callArgs = JSON.parse(callArgs); } catch { callArgs = {}; }
                }
                if (!allowed.has(name) || denied.has(name)) {
                    const blocked = { ok: false, error: 'tool_not_in_profile', tool: name };
                    toolTrace.push({ tool: name, result: blocked });
                    messages.push({
                        role: 'tool',
                        tool_call_id: raw.id || raw.toolCallId || crypto.randomUUID(),
                        name,
                        content: JSON.stringify(blocked),
                    });
                    continue;
                }
                if (readOnly && /write|delete|execute|create|update|send|action/i.test(name) && !/read|list|get|search|wait|capture|view|stat|validate|test/i.test(name)) {
                    const blocked = { ok: false, error: 'readonly_profile', tool: name };
                    toolTrace.push({ tool: name, result: blocked });
                    messages.push({
                        role: 'tool',
                        tool_call_id: raw.id || raw.toolCallId || crypto.randomUUID(),
                        name,
                        content: JSON.stringify(blocked),
                    });
                    continue;
                }
                let result;
                try {
                    result = await executeTool(name, callArgs, childCtx);
                } catch (err) {
                    result = { ok: false, error: err.message, code: err.code || 'tool_error' };
                }
                // Collapse huge results
                const compact = JSON.stringify(result);
                const clipped = compact.length > 60000 ? compact.slice(0, 60000) + '…(truncated)' : compact;
                toolTrace.push({ tool: name, ok: result?.ok !== false, bytes: clipped.length });
                messages.push({
                    role: 'tool',
                    tool_call_id: raw.id || raw.toolCallId || crypto.randomUUID(),
                    name,
                    content: clipped,
                });
                if (result?.confirmationRequired) {
                    finalText = `子代理在 ${name} 处需要主代理确认，已停止。`;
                    return {
                        ok: true,
                        profile: profile.id,
                        readOnly,
                        steps: step + 1,
                        final: finalText,
                        toolTrace,
                        pendingConfirmation: result,
                    };
                }
            }
            if (content) finalText = content;
        }
        if (!finalText) {
            finalText = `子代理 ${profile.id} 完成 ${toolTrace.length} 次工具调用。`;
        }
        return {
            ok: true,
            profile: profile.id,
            readOnly,
            steps: toolTrace.length,
            final: finalText.slice(0, 12000),
            toolTrace: toolTrace.slice(0, 40),
        };
    } finally {
        release();
        activeSubagents = Math.max(0, activeSubagents - 1);
        if (!readOnly) activeWriters = Math.max(0, activeWriters - 1);
    }
}

async function runParallelReadonly({
    tasks = [],
    profileId = 'readonly-scout',
    ctx,
    deps,
    executeTool,
    completeTurn,
} = {}) {
    const list = (Array.isArray(tasks) ? tasks : []).filter((t) => t && (t.prompt || t.task));
    if (list.length < 2) {
        const err = new Error('subagent_parallel_requires_at_least_2_tasks');
        err.code = 'invalid_tool_arguments';
        err.status = 400;
        throw err;
    }
    // Force readonly profile
    const profile = getProfile(profileId);
    if (profile && !profile.readOnly) {
        const err = new Error('parallel 仅允许只读 profile');
        err.code = 'subagent_parallel_readonly_only';
        err.status = 400;
        throw err;
    }
    const limited = list.slice(0, DEFAULT_MAX_CONCURRENCY);
    const results = await Promise.all(limited.map((task, index) => runSubagentTask({
        profileId: task.profileId || profileId || 'readonly-scout',
        prompt: task.prompt || task.task,
        args: { ...(task.args || {}), readOnly: true, connectionId: task.connectionId, connectionIds: task.connectionIds },
        ctx,
        deps,
        executeTool,
        completeTurn,
    }).then((r) => ({ index, ...r })).catch((err) => ({
        index,
        ok: false,
        error: err.message,
        code: err.code,
    }))));
    return {
        ok: true,
        count: results.length,
        results,
        summary: results.map((r) => `#${r.index} [${r.profile || profileId}] ${r.ok === false ? r.error : String(r.final || '').slice(0, 400)}`).join('\n\n'),
    };
}

async function runFleet({
    tasks = [],
    ctx,
    deps,
    executeTool,
    completeTurn,
} = {}) {
    const list = (Array.isArray(tasks) ? tasks : []).filter((t) => t && (t.prompt || t.task));
    if (!list.length) {
        const err = new Error('fleet 需要至少一个任务');
        err.code = 'invalid_tool_arguments';
        err.status = 400;
        throw err;
    }
    // Preflight all resource claims before any execution
    const owner = `fleet-${crypto.randomBytes(4).toString('hex')}`;
    const allClaims = [];
    for (const t of list) {
        allClaims.push(...extractClaimsFromPrompt(t.prompt || t.task, t));
    }
    globalLocks.preflight(allClaims, owner);

    const writers = list.filter((t) => {
        const p = getProfile(t.profileId || 'readonly-scout');
        return p && !p.readOnly;
    });
    if (writers.length > DEFAULT_MAX_WRITERS) {
        const err = new Error(`fleet 写任务过多（max ${DEFAULT_MAX_WRITERS}）`);
        err.code = 'subagent_writer_limit';
        err.status = 429;
        throw err;
    }

    // Run readonly in parallel, writers sequentially
    const readonlyTasks = list.filter((t) => {
        const p = getProfile(t.profileId || 'readonly-scout');
        return !p || p.readOnly;
    });
    const writeTasks = list.filter((t) => {
        const p = getProfile(t.profileId || 'readonly-scout');
        return p && !p.readOnly;
    });

    const roResults = readonlyTasks.length
        ? await Promise.all(readonlyTasks.map((task, index) => runSubagentTask({
            profileId: task.profileId || 'readonly-scout',
            prompt: task.prompt || task.task,
            args: { ...task, readOnly: true },
            ctx,
            deps,
            executeTool,
            completeTurn,
        }).then((r) => ({ index, kind: 'readonly', ...r }))
            .catch((err) => ({ index, kind: 'readonly', ok: false, error: err.message, code: err.code }))))
        : [];

    const wResults = [];
    for (let i = 0; i < writeTasks.length; i += 1) {
        const task = writeTasks[i];
        try {
            const r = await runSubagentTask({
                profileId: task.profileId || 'doc-writer',
                prompt: task.prompt || task.task,
                args: task,
                ctx,
                deps,
                executeTool,
                completeTurn,
            });
            wResults.push({ index: i, kind: 'write', ...r });
        } catch (err) {
            wResults.push({ index: i, kind: 'write', ok: false, error: err.message, code: err.code });
        }
    }

    const results = [...roResults, ...wResults];
    return {
        ok: true,
        count: results.length,
        results,
        summary: results.map((r) => `[${r.kind}] ${r.ok === false ? r.error : String(r.final || '').slice(0, 400)}`).join('\n\n'),
    };
}

module.exports = {
    PROFILES,
    listProfiles,
    getProfile,
    runSubagentTask,
    runParallelReadonly,
    runFleet,
    ResourceLockTable,
    globalLocks,
};
