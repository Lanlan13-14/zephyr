'use strict';

function cap(id, title, risk, confirmation, toolIds, playbookId) {
    return Object.freeze({ id, title, risk, confirmation, toolIds: Object.freeze(toolIds), playbookId });
}

const EXTENDED_CAPABILITIES = Object.freeze([
    cap('ui.act', 'Operate the current Zephyr interface', 'R2', 'always', ['ui_action'], 'ui-operations-v1'),
    cap('web.search', 'Search the public web', 'R0', 'never', ['web_search'], 'web-research-v1'),
    cap('web.fetch', 'Fetch a public web page', 'R0', 'never', ['fetch_url'], 'web-research-v1'),
    cap('browser.navigate', 'Navigate an external browser session', 'R1', 'always', ['browser_navigate'], 'browser-automation-v1'),
    cap('browser.observe', 'Observe external browser state', 'R0', 'never', ['browser_screenshot', 'browser_text', 'browser_wait'], 'browser-automation-v1'),
    cap('browser.viewport', 'Scroll an external browser page', 'R1', 'always', ['browser_scroll'], 'browser-automation-v1'),
    cap('browser.key', 'Send a key to an external browser page', 'R2', 'always', ['browser_key'], 'browser-automation-v1'),
    cap('browser.close', 'Close an external browser session', 'R1', 'always', ['browser_close'], 'browser-automation-v1'),
    cap('notes.read', 'Read personal notes', 'R0', 'never', ['note_list', 'note_search', 'note_get'], 'notes-management-v1'),
    cap('notes.write', 'Create or update a personal note', 'R1', 'always', ['note_create', 'note_update'], 'notes-management-v1'),
    cap('notes.delete', 'Delete a personal note', 'R3', 'always', ['note_delete'], 'notes-management-v1'),
    cap('memory.read', 'Search scoped AI memory', 'R0', 'never', ['memory_search'], 'memory-management-v1'),
    cap('memory.write', 'Save scoped AI memory', 'R2', 'always', ['memory_save'], 'memory-management-v1'),
    cap('env.list', 'List AI environment variable metadata', 'R0', 'never', ['list_env_vars'], 'environment-variables-v1'),
    cap('env.get', 'Read one enabled AI environment variable', 'R4', 'always', ['get_env_var'], 'environment-variables-v1'),
    cap('env.write', 'Create update or delete AI environment variables', 'R3', 'always', ['env_set_v1', 'env_delete_v1'], 'environment-variables-v1'),
    cap('plan.create', 'Create an AI execution plan', 'R0', 'never', ['plan_task'], 'plan-management-v1'),
    cap('plan.update', 'Update AI plan state', 'R1', 'always', ['plan_update'], 'plan-management-v1'),
    cap('plan.delete', 'Delete an AI plan', 'R3', 'always', ['plan_delete'], 'plan-management-v1'),
    cap('ssh.execute', 'Execute a command on authorized SSH connections', 'R2', 'always', ['remote_execute'], 'ssh-operations-v1'),
    cap('ssh.file_read', 'Read a file from an authorized SSH connection', 'R0', 'never', ['remote_read_file'], 'ssh-file-operations-v1'),
    cap('ssh.file_write', 'Write a file on an authorized SSH connection', 'R3', 'always', ['remote_write_file'], 'ssh-file-operations-v1'),
    cap('ssh.file_rollback', 'Restore an SSH file snapshot', 'R2', 'always', ['remote_file_rollback'], 'ssh-file-operations-v1'),
    cap('ssh.file_snapshots', 'List SSH file snapshots', 'R0', 'never', ['remote_file_snapshot_list'], 'ssh-file-operations-v1'),
    cap('workspace.list', 'List AI session workspace files', 'R0', 'never', ['workspace_list_v1'], 'asset-management-v1'),
    cap('workspace.read', 'Read AI session workspace or upload files', 'R0', 'never', ['workspace_read_v1', 'user_attachment_read_v1', 'user_attachment_view_v1'], 'asset-management-v1'),
    cap('workspace.write', 'Write AI session workspace drafts/outputs', 'R1', 'always', ['workspace_write_v1'], 'asset-management-v1'),
    cap('subagent.list', 'List subagent profiles', 'R0', 'never', ['subagent_list_profiles_v1'], 'capability-discovery-v1'),
    cap('subagent.task', 'Run one nested subagent task', 'R1', 'never', ['subagent_task_v1'], 'capability-discovery-v1'),
    cap('subagent.parallel', 'Run parallel readonly subagent tasks', 'R1', 'never', ['subagent_parallel_v1'], 'capability-discovery-v1'),
    cap('subagent.fleet', 'Run subagent fleet with resource lock preflight', 'R2', 'never', ['subagent_fleet_v1'], 'capability-discovery-v1'),
    cap('sandbox.status', 'Inspect session sandbox isolation capabilities', 'R0', 'never', ['session_sandbox_status_v1'], 'asset-management-v1'),
    cap('sandbox.exec', 'Run whitelist command in conversation sandbox', 'R2', 'always', ['session_exec_v1'], 'asset-management-v1'),
]);

const TOOL_TO_CAPABILITY = new Map();
for (const capability of EXTENDED_CAPABILITIES) {
    for (const toolId of capability.toolIds) {
        if (TOOL_TO_CAPABILITY.has(toolId)) throw new Error(`duplicate extended capability tool binding: ${toolId}`);
        TOOL_TO_CAPABILITY.set(toolId, capability);
    }
}

function policyForExtendedTool(toolId = '') {
    const capability = TOOL_TO_CAPABILITY.get(String(toolId || ''));
    if (!capability) return null;
    return Object.freeze({
        capabilityId: capability.id,
        risk: capability.risk,
        confirmation: capability.confirmation,
        playbookId: capability.playbookId,
        readOnly: capability.risk === 'R0',
        parallelSafe: capability.risk === 'R0',
    });
}

module.exports = { EXTENDED_CAPABILITIES, policyForExtendedTool };
