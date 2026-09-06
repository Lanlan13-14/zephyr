import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestServer } from './test-server.mjs';

let server;
let cookie;

before(async () => {
    server = new TestServer();
    await server.start();
    ({ cookie } = await server.bootstrapAdmin('plan-delete-admin-pass'));
    const settings = await server.api(cookie, 'PUT', '/api/settings', { ai: { enabled: true } });
    assert.equal(settings.status, 200);
});

after(async () => {
    await server.cleanup();
});

test('manual plan deletion confirms the destructive tool and removes stored plan', async () => {
    const created = await server.api(cookie, 'POST', '/api/ai/tools/run', {
        tool: 'plan_task',
        args: { title: 'delete me', steps: ['first step'] },
    });
    assert.equal(created.status, 200);
    const planId = (created.body.result.data || created.body.result).plan.id;

    const pending = await server.api(cookie, 'POST', '/api/ai/tools/run', {
        tool: 'plan_delete',
        args: { planId },
    });
    assert.equal(pending.status, 200);
    assert.equal(pending.body.result.confirmationRequired, true);
    assert.equal(pending.body.result.confirmation.toolName, 'plan_delete');

    const confirmed = await server.api(cookie, 'POST', `/api/ai/confirm/${pending.body.result.confirmation.id}`, { approve: true });
    assert.equal(confirmed.status, 200);
    const confirmedData = confirmed.body.result.data || confirmed.body.result;
    assert.equal(confirmedData.deleted, true);
    assert.equal(confirmedData.planId, planId);
    assert.equal(confirmedData.plans.some((plan) => plan.id === planId), false);

    const status = await server.api(cookie, 'GET', '/api/ai/status');
    assert.equal(status.status, 200);
    assert.equal((status.body.ai.plans || []).some((plan) => plan.id === planId), false);
});
