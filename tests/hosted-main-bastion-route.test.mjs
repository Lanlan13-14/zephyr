import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const express = require('express');

function listen(server) {
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
}

function getJson(port, pathname) {
    return new Promise((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method: 'GET' }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null });
            });
        });
        req.on('error', reject);
        req.end();
    });
}

function buildApp({ embedded, agents }) {
    const app = express();
    const requireUser = (req, _res, next) => {
        req.user = { userId: 'owner-1', username: 'owner' };
        next();
    };
    if (embedded) {
        app.get('/api/one/link/agent-bastions', requireUser, (_req, res) => {
            res.json({ ok: true, source: 'main', agents: [{ agentId: 'from-bound-main' }] });
        });
    }
    app.get('/api/one/link/agent-bastions', requireUser, (_req, res) => {
        if (embedded) return;
        res.json({ ok: true, source: 'local', agents });
    });
    app.get('*', (req, res) => {
        if (req.url.startsWith('/api/')) {
            res.status(404).json({ ok: false, error: { code: 'not_found', message: 'API endpoint not found' } });
            return;
        }
        res.status(404).end();
    });
    return app;
}

test('a hosted main serves its own bastion Agents instead of 404', async () => {
    const online = { agentId: 'agent_55b4fea6a8c8', online: true, bastionEnabled: true };
    const app = buildApp({ embedded: false, agents: [online] });
    const server = http.createServer(app);
    const port = await listen(server);
    try {
        const response = await getJson(port, '/api/one/link/agent-bastions');
        assert.equal(response.status, 200);
        assert.equal(response.body.ok, true);
        assert.equal(response.body.source, 'local');
        assert.deepEqual(response.body.agents, [online]);
    } finally {
        server.close();
    }
});

test('the embedded desktop core keeps answering from its bound main', async () => {
    const app = buildApp({ embedded: true, agents: [{ agentId: 'local-must-not-win' }] });
    const server = http.createServer(app);
    const port = await listen(server);
    try {
        const response = await getJson(port, '/api/one/link/agent-bastions');
        assert.equal(response.status, 200);
        assert.equal(response.body.source, 'main');
        assert.equal(response.body.agents[0].agentId, 'from-bound-main');
    } finally {
        server.close();
    }
});

test('the picker route is mounted for a hosted main, ahead of the 404 fallback', () => {
    const fs = require('node:fs');
    const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
    const hosted = server.indexOf("app.get('/api/one/link/agent-bastions', requireUser, (req, res, next) => {");
    const fallback = server.indexOf("if (req.url.startsWith('/api/')) {");
    assert.ok(hosted > 0, 'hosted bastion route missing');
    assert.ok(hosted < fallback, 'bastion route is registered after the 404 fallback');
    const gate = server.indexOf('if (ZEPHYR_ONE_EMBEDDED) {');
    assert.ok(gate > 0 && gate < hosted, 'hosted route must live outside the embedded-only block');
});
