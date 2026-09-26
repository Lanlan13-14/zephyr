import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const { mountZephyrOneLinkRoutes } = createRequire(import.meta.url)('../zephyr-one-link-sync');

function listen(server) {
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
}

function getJson(port, pathname) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: '127.0.0.1', port, path: pathname, method: 'GET',
        }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
            });
        });
        req.on('error', reject);
        req.end();
    });
}

const express = createRequire(import.meta.url)('express');

function mount(localAgents) {
    const app = express();
    let relayed = false;
    mountZephyrOneLinkRoutes(app, {
        linkSync: {
            agentBastions: async () => {
                relayed = true;
                return [{ agentId: 'relayed-agent', online: true, bastionEnabled: true }];
            },
        },
        requireUser: (req, _res, next) => {
            req.user = { userId: 'owner-1' };
            next();
        },
        listLocalBastionAgents: () => localAgents,
    });
    return { app, relayed: () => relayed };
}

test('hosted main lists its own online bastion Agents even when a binding exists', async () => {
    const previous = process.env.ZEPHYR_ONE_EMBEDDED;
    delete process.env.ZEPHYR_ONE_EMBEDDED;
    const online = { agentId: 'agent_online', deviceName: 'Desk', online: true, bastionEnabled: true };
    const { app, relayed } = mount([online]);
    const server = http.createServer(app);
    const port = await listen(server);
    try {
        const response = await getJson(port, '/api/one/link/agent-bastions');
        assert.equal(response.status, 200);
        assert.equal(response.body.source, 'local');
        assert.deepEqual(response.body.agents, [online]);
        assert.equal(relayed(), false);
    } finally {
        server.close();
        if (previous === undefined) delete process.env.ZEPHYR_ONE_EMBEDDED;
        else process.env.ZEPHYR_ONE_EMBEDDED = previous;
    }
});

test('embedded One relays bastion candidates from the bound main', async () => {
    const previous = process.env.ZEPHYR_ONE_EMBEDDED;
    process.env.ZEPHYR_ONE_EMBEDDED = '1';
    const { app, relayed } = mount([{ agentId: 'local-must-not-win', online: true, bastionEnabled: true }]);
    const server = http.createServer(app);
    const port = await listen(server);
    try {
        const response = await getJson(port, '/api/one/link/agent-bastions');
        assert.equal(response.status, 200);
        assert.equal(response.body.source, 'main');
        assert.equal(response.body.agents[0].agentId, 'relayed-agent');
        assert.equal(relayed(), true);
    } finally {
        server.close();
        if (previous === undefined) delete process.env.ZEPHYR_ONE_EMBEDDED;
        else process.env.ZEPHYR_ONE_EMBEDDED = previous;
    }
});

test('embedded One falls back to local Agents only while unbound', async () => {
    const previous = process.env.ZEPHYR_ONE_EMBEDDED;
    process.env.ZEPHYR_ONE_EMBEDDED = '1';
    const app = express();
    const local = [{ agentId: 'agent_local', online: true, bastionEnabled: true }];
    mountZephyrOneLinkRoutes(app, {
        linkSync: {
            agentBastions: async () => {
                const err = new Error('尚未绑定主端');
                err.code = 'unbound';
                throw err;
            },
        },
        requireUser: (req, _res, next) => next(),
        listLocalBastionAgents: () => local,
    });
    const server = http.createServer(app);
    const port = await listen(server);
    try {
        const response = await getJson(port, '/api/one/link/agent-bastions');
        assert.equal(response.status, 200);
        assert.equal(response.body.source, 'local');
        assert.deepEqual(response.body.agents, local);
    } finally {
        server.close();
        if (previous === undefined) delete process.env.ZEPHYR_ONE_EMBEDDED;
        else process.env.ZEPHYR_ONE_EMBEDDED = previous;
    }
});
