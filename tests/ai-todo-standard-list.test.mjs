import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createSecureTestDataDir, removeSecureTestDataDir } from './helpers/secure-data-dir.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 18790 + (process.pid % 80);
const BASE = `http://127.0.0.1:${PORT}`;

let child; let cookie = ''; let dataFixture = null;

async function waitHealth() {
    for (let i = 0; i < 80; i++) {
        try {
            const r = await fetch(`${BASE}/healthz`);
            if (r.ok) return;
        } catch {}
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('server healthz timeout');
}

async function call(path, { method = 'GET', body, cookie: forced } = {}) {
    const r = await fetch(`${BASE}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...(forced || cookie ? { cookie: forced || cookie } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = r.headers.get('set-cookie');
    if (setCookie && !forced) cookie = setCookie.split(';')[0];
    const data = await r.json().catch(() => ({}));
    return { status: r.status, data };
}

before(async () => {
    /* The server asserts its data parent is service-owned and not
     * group/world-writable (durable-file.js). A bare mkdtemp under /tmp
     * inherits the sticky bit and fails that check on real Linux, so use the
     * same 0700 fixture helper every other server-spawning suite uses. */
    dataFixture = createSecureTestDataDir('ai-todo-e2e-');
    const dir = dataFixture.dataDir;
    child = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            ZEPHYR_ONE_USE_BUILTIN_SQLITE: '1',
            ZEPHYR_DATA_DIR: dir,
            ZEPHYR_DATA_MLKEM768_KEY_FILE: join(dir, 'crypto', 'key.json'),
            HTTP_ENABLED: 'true', HTTPS_ENABLED: 'false',
            PORT: String(PORT), ZEPHYR_BIND_HOST: '127.0.0.1',
            NODE_ENV: 'production',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.on('data', (d) => process.stderr.write(`[srv] ${d}`));
    await waitHealth();
});

after(() => {
    try { child?.kill('SIGKILL'); } catch {}
    if (dataFixture) removeSecureTestDataDir(dataFixture);
});

test('standard todo: web CRUD + AI tool surface share one account-scoped store', async () => {
    // login as admin (default first user; password 'admin' is the seeded default in this env)
    const PWD = 'Todo-E2e-12345';
    let login = await call('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin' } });
    if (login.data?.mustChangePassword || login.status !== 200) {
        const ch = await call('/api/auth/change-password', { method: 'POST', body: { currentPassword: 'admin', newPassword: PWD } });
        assert.equal(ch.status, 200, `change-password failed: ${JSON.stringify(ch.data)}`);
        login = await call('/api/auth/login', { method: 'POST', body: { username: 'admin', password: PWD } });
    }
    assert.equal(login.status, 200, `login failed: ${JSON.stringify(login.data)}`);

    // Enable the AI assistant (global switch gates /api/ai/tools/run)
    const enable = await call('/api/settings', { method: 'PUT', body: { ai: { enabled: true } } });
    assert.equal(enable.status, 200, `enable ai failed: ${JSON.stringify(enable.data)}`);

    // 1. Web create
    const created = await call('/api/ai/todos', { method: 'POST', body: { title: '检查磁盘', priority: 'high', steps: [{ title: 'df -h' }, { title: '清理日志' }] } });
    assert.equal(created.status, 200, JSON.stringify(created.data));
    assert.equal(created.data.todo.status, 'pending');
    assert.equal(created.data.todo.source, 'web');
    assert.equal(created.data.todo.steps.length, 2);
    const id = created.data.todo.todoId;

    // 2. Web patch: complete step 1
    const patched = await call(`/api/ai/todos/${id}`, { method: 'PATCH', body: { steps: [{ id: created.data.todo.steps[0].id, title: 'df -h', done: true }, { id: created.data.todo.steps[1].id, title: '清理日志', done: false }], status: 'in_progress' } });
    assert.equal(patched.status, 200);
    assert.equal(patched.data.todo.status, 'in_progress');
    assert.equal(patched.data.todo.steps[0].done, true);
    assert.equal(patched.data.todo.revision, 2);

    // 3. AI tool todo_create (source: ai)
    const aiCreate = await call('/api/ai/tools/run', { method: 'POST', body: { tool: 'todo_create', args: { title: 'AI 排查任务', steps: ['查看日志'] }, context: {} } });
    assert.equal(aiCreate.status, 200, JSON.stringify(aiCreate.data));
    // canonical tools wrap the payload as {ok, data, meta}
    const aiCreateResult = aiCreate.data.result || {};
    const aiTodo = aiCreateResult.todo || aiCreateResult.data?.todo || aiCreate.data.todo;
    assert.ok(aiTodo?.todoId, `todo_create must return a todo: ${JSON.stringify(aiCreateResult).slice(0, 200)}`);
    assert.equal(aiTodo.source, 'ai');

    // 4. AI todo_list sees both rows
    const list = await call('/api/ai/todos');
    assert.equal(list.data.todos.length, 2);

    // 5. AI deletes its own todo — no confirmation gate
    const aiDel = await call('/api/ai/tools/run', { method: 'POST', body: { tool: 'todo_delete', args: { todoId: aiTodo.todoId }, context: {} } });
    assert.equal(aiDel.status, 200, JSON.stringify(aiDel.data));
    const aiDelResult = aiDel.data.result || {};
    const deleted = aiDelResult.deleted === true || aiDelResult.data?.deleted === true;
    assert.equal(deleted, true, `ai self-delete result: ${JSON.stringify(aiDel.data).slice(0, 300)}`);

    // 6. AI deletes the user-authored todo → confirmation required
    const aiDelUser = await call('/api/ai/tools/run', { method: 'POST', body: { tool: 'todo_delete', args: { todoId: id }, context: {} } });
    const r6 = aiDelUser.data.result || {};
    const pendingResult = r6.confirmationRequired === true || r6.data?.confirmationRequired === true || r6.confirmation?.confirmationRequired === true;
    assert.ok(pendingResult, `deleting a user-authored todo must require confirmation: ${JSON.stringify(r6).slice(0, 200)}`);

    // 7. Web delete works directly
    const webDel = await call(`/api/ai/todos/${id}`, { method: 'DELETE' });
    assert.equal(webDel.status, 200);
    assert.equal(webDel.data.deleted, true);

    // 8. Store is empty again
    const final = await call('/api/ai/todos');
    assert.equal(final.data.todos.length, 0);
});
