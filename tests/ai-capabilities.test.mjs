import test from 'node:test';
import assert from 'node:assert/strict';
import capabilitiesModule from '../ai-capabilities.js';
import agentModule from '../ai-agent-service.js';

const { CAPABILITIES, reportCapabilityCoverage } = capabilitiesModule;
const { listToolCatalog, toolDefinitions, CANONICAL_TOOL_SCHEMAS } = agentModule;

test('first capability inventory preserves explicit human-only security boundary', () => {
    const passwordChange = CAPABILITIES.find((item) => item.id === 'security.password.change');
    const revealSecret = CAPABILITIES.find((item) => item.id === 'security.secret.reveal');

    assert.equal(passwordChange.mode, 'humanOnly');
    assert.equal(passwordChange.risk, 'R4');
    assert.match(passwordChange.humanOnlyReason, /reauthentication/i);
    assert.equal(revealSecret.mode, 'humanOnly');
    assert.equal(revealSecret.toolIds.length, 0);
});

test('first implemented capability inventory fails closed until canonical tools exist', () => {
    const report = reportCapabilityCoverage([]);
    assert.equal(report.ok, false);
    assert.deepEqual(report.missingToolBindings.map((item) => item.id), CAPABILITIES
        .filter((item) => item.mode === 'ai' && item.state === 'implemented')
        .map((item) => item.id));
});

test('first implemented capability inventory accepts matching canonical tools', () => {
    const report = reportCapabilityCoverage(CAPABILITIES
        .filter((item) => item.mode === 'ai' && item.state === 'implemented')
        .flatMap((item) => item.toolIds.map((name) => ({ name }))));
    assert.equal(report.ok, true);
    assert.deepEqual(report.missingToolBindings, []);
});

test('runtime tool catalog contains every first-batch canonical capability tool', () => {
    const catalog = listToolCatalog({});
    const report = reportCapabilityCoverage(catalog);
    assert.equal(report.ok, true);
    const names = new Set(catalog.map((tool) => tool.name));
    for (const capability of CAPABILITIES.filter((item) => item.mode === 'ai' && item.state === 'implemented')) {
        for (const toolId of capability.toolIds) assert.ok(names.has(toolId), `${capability.id} must expose ${toolId}`);
    }
});

test('canonical tool catalog and executor use the same strict schemas', () => {
    const definitions = toolDefinitions({});
    for (const name of ['connection_list_v1', 'connection_get_v1', 'connection_rename_v1', 'connection_create_v1', 'connection_update_v1', 'connection_delete_v1', 'connection_test_v1', 'connection_open_v1', 'proxy_list_v1', 'proxy_get_v1', 'proxy_create_v1', 'proxy_update_v1', 'proxy_delete_v1', 'ssh_key_list_v1', 'ssh_key_get_v1', 'ssh_key_validate_v1', 'ssh_key_rename_v1', 'ssh_key_update_metadata_v1', 'ssh_key_delete_v1']) {
        const definition = definitions.find((item) => item.function?.name === name);
        assert.equal(definition.function.parameters, CANONICAL_TOOL_SCHEMAS[name]);
        assert.equal(definition.function.parameters.additionalProperties, false);
    }
    const renamed = listToolCatalog({}).find((tool) => tool.name === 'connection_rename_v1');
    assert.equal(renamed.capabilityId, 'connection.rename');
    assert.equal(renamed.risk, 'R1');
    assert.equal(renamed.confirmation, 'always');
});
