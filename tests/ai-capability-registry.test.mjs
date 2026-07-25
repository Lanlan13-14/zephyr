import test from 'node:test';
import assert from 'node:assert/strict';
import registry from '../ai-capability-registry.js';
import { executeCanonicalTool } from '../ai-tool-executor.js';

const {
    defineCapabilities,
    capabilityCoverageReport,
} = registry;

test('implemented AI capabilities require at least one tool binding', () => {
    assert.throws(() => defineCapabilities([{
        id: 'connection.rename',
        title: 'Rename connection',
        mode: 'ai',
        state: 'implemented',
        risk: 'R1',
    }]), /requires tool ids/);
});

test('human-only capability requires a reason and cannot expose a tool', () => {
    assert.throws(() => defineCapabilities([{
        id: 'security.password_change',
        title: 'Change password',
        mode: 'humanOnly',
        state: 'implemented',
        risk: 'R4',
    }]), /requires a reason/);

    assert.throws(() => defineCapabilities([{
        id: 'security.password_change',
        title: 'Change password',
        mode: 'humanOnly',
        state: 'implemented',
        risk: 'R4',
        humanOnlyReason: 'Requires direct human reauthentication.',
        toolIds: ['security_password_change'],
    }]), /cannot expose tools/);
});

test('coverage report rejects implemented capability whose tool is absent', () => {
    const capabilities = defineCapabilities([
        {
            id: 'connection.rename',
            title: 'Rename connection',
            mode: 'ai',
            state: 'implemented',
            risk: 'R1',
            toolIds: ['connection_rename_v1'],
            playbookId: 'asset-manager',
        },
        {
            id: 'security.password_change',
            title: 'Change password',
            mode: 'humanOnly',
            state: 'implemented',
            risk: 'R4',
            humanOnlyReason: 'Requires direct human reauthentication.',
        },
    ]);

    const report = capabilityCoverageReport(capabilities, ['connection_update_v1']);
    assert.equal(report.ok, false);
    assert.deepEqual(report.missingToolBindings, [{
        id: 'connection.rename',
        missingTools: ['connection_rename_v1'],
    }]);
    assert.deepEqual(report.humanOnly, ['security.password_change']);
});

test('coverage report accepts available implemented tool binding', () => {
    const capabilities = defineCapabilities([{
        id: 'connection.rename',
        title: 'Rename connection',
        mode: 'ai',
        state: 'implemented',
        risk: 'R1',
        confirmation: 'always',
        toolIds: ['connection_rename_v1'],
    }]);
    const report = capabilityCoverageReport(capabilities, ['connection_rename_v1']);
    assert.equal(report.ok, true);
    assert.deepEqual(report.missingToolBindings, []);
});

test('canonical executor validates arguments before execution', async () => {
    let executed = false;
    await assert.rejects(() => executeCanonicalTool({
        toolId: 'connection_get_v1',
        schema: { type: 'object', properties: { connectionId: { type: 'string' } }, required: ['connectionId'], additionalProperties: false },
        args: { connectionId: 'x', unexpected: true },
        ctx: {},
        execute: async () => { executed = true; },
    }), (error) => error.code === 'invalid_tool_arguments');
    assert.equal(executed, false);
});

test('canonical executor runs authorization before issuing confirmation', async () => {
    await assert.rejects(() => executeCanonicalTool({
        toolId: 'connection_rename_v1',
        schema: { type: 'object', properties: { connectionId: { type: 'string' }, name: { type: 'string' }, expectedRevision: { type: 'number' } }, required: ['connectionId', 'name', 'expectedRevision'], additionalProperties: false },
        args: { connectionId: 'hidden', name: 'renamed', expectedRevision: 1 },
        ctx: { requireConfirmation: () => ({ confirmationRequired: true }) },
        authorize: () => { const error = new Error('forbidden'); error.code = 'forbidden_resource_edit'; throw error; },
        execute: async () => { throw new Error('must not run'); },
    }), (error) => error.code === 'forbidden_resource_edit');
});

test('canonical executor asks before R1 execution and annotates success', async () => {
    let executed = false;
    const pending = await executeCanonicalTool({
        toolId: 'connection_rename_v1',
        schema: { type: 'object', properties: { connectionId: { type: 'string' }, name: { type: 'string' }, expectedRevision: { type: 'number' } }, required: ['connectionId', 'name', 'expectedRevision'], additionalProperties: false },
        args: { connectionId: 'x', name: 'renamed', expectedRevision: 1 },
        ctx: { requireConfirmation: () => ({ confirmationRequired: true }) },
        execute: async () => { executed = true; },
    });
    assert.deepEqual(pending, { confirmationRequired: true });
    assert.equal(executed, false);

    const wrongConfirmation = await executeCanonicalTool({
        toolId: 'connection_rename_v1',
        schema: { type: 'object', properties: { connectionId: { type: 'string' }, name: { type: 'string' }, expectedRevision: { type: 'number' } }, required: ['connectionId', 'name', 'expectedRevision'], additionalProperties: false },
        args: { connectionId: 'x', name: 'renamed', expectedRevision: 1 },
        ctx: { confirmedToolId: 'another_tool', requireConfirmation: () => ({ confirmationRequired: true }) },
        execute: async () => { throw new Error('must not run'); },
    });
    assert.deepEqual(wrongConfirmation, { confirmationRequired: true });

    const result = await executeCanonicalTool({
        toolId: 'connection_rename_v1',
        schema: { type: 'object', properties: { connectionId: { type: 'string' }, name: { type: 'string' }, expectedRevision: { type: 'number' } }, required: ['connectionId', 'name', 'expectedRevision'], additionalProperties: false },
        args: { connectionId: 'x', name: 'renamed', expectedRevision: 1 },
        ctx: { confirmedToolId: 'connection_rename_v1' },
        execute: async () => ({ connection: { id: 'x' } }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.meta.capabilityId, 'connection.rename');
    assert.equal(result.meta.risk, 'R1');
});
