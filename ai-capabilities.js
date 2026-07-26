'use strict';

const {
    defineCapabilities,
    capabilityCoverageReport,
    searchCapabilities,
} = require('./ai-capability-registry');

/*
 * This is deliberately small at first. A capability becomes "implemented"
 * only after its canonical tool, authorization, playbook and tests land.
 */
const CAPABILITIES = defineCapabilities([
    {
        id: 'capability.search',
        title: 'Discover available AI capabilities and playbooks',
        mode: 'ai',
        state: 'implemented',
        risk: 'R0',
        confirmation: 'never',
        toolIds: ['capability_search'],
        keywords: ['能力', '接口', '工具', '能做什么', '帮助', 'capability', 'tool', 'help'],
        playbookId: 'capability-discovery-v1',
    },
    {
        id: 'connection.list',
        title: 'List visible connections',
        mode: 'ai',
        state: 'implemented',
        risk: 'R0',
        confirmation: 'never',
        toolIds: ['connection_list_v1'],
        keywords: ['连接', '服务器', '设备', '列表', '查找', 'search', 'list'],
        playbookId: 'asset-management-v1',
    },
    {
        id: 'connection.get',
        title: 'Read visible connection metadata',
        mode: 'ai',
        state: 'implemented',
        risk: 'R0',
        confirmation: 'never',
        toolIds: ['connection_get_v1'],
        keywords: ['连接', '详情', '查看', '读取', 'get'],
        playbookId: 'asset-management-v1',
    },
    {
        id: 'connection.rename',
        title: 'Rename a connection with revision protection',
        mode: 'ai',
        state: 'implemented',
        risk: 'R1',
        confirmation: 'always',
        toolIds: ['connection_rename_v1'],
        keywords: ['连接', '改名', '重命名', 'rename'],
        playbookId: 'asset-management-v1',
    },
    {
        id: 'connection.create',
        title: 'Create a connection without revealing credentials',
        mode: 'ai',
        state: 'implemented',
        risk: 'R2',
        confirmation: 'always',
        toolIds: ['connection_create_v1'],
        keywords: ['连接', '新增', '创建', '设备', '服务器', 'create'],
        playbookId: 'asset-management-v1',
    },
    {
        id: 'connection.update',
        title: 'Update connection metadata with revision protection',
        mode: 'ai',
        state: 'implemented',
        risk: 'R2',
        confirmation: 'always',
        toolIds: ['connection_update_v1'],
        keywords: ['连接', '修改', '更新', 'update'],
        playbookId: 'asset-management-v1',
    },
    {
        id: 'connection.delete',
        title: 'Delete a connection with revision protection',
        mode: 'ai',
        state: 'implemented',
        risk: 'R3',
        confirmation: 'always',
        toolIds: ['connection_delete_v1'],
        keywords: ['连接', '删除', '移除', 'delete'],
        playbookId: 'asset-management-v1',
    },
    {
        id: 'connection.test',
        title: 'Test a saved connection without exposing credentials',
        mode: 'ai',
        state: 'implemented',
        risk: 'R0',
        confirmation: 'never',
        toolIds: ['connection_test_v1'],
        keywords: ['连接', '测试', '连通性', '诊断', 'test'],
        playbookId: 'asset-management-v1',
    },
    {
        id: 'connection.open',
        title: 'Open a saved connection in the current workspace',
        mode: 'ai',
        state: 'implemented',
        risk: 'R2',
        confirmation: 'always',
        toolIds: ['connection_open_v1'],
        keywords: ['连接', '打开', '进入', '登录', 'open'],
        playbookId: 'asset-management-v1',
    },
    {
        id: 'proxy.list',
        title: 'List visible proxy metadata',
        mode: 'ai', state: 'implemented', risk: 'R0', confirmation: 'never',
        toolIds: ['proxy_list_v1'], keywords: ['代理', 'proxy', '列表', '查找'], playbookId: 'proxy-management-v1',
    },
    {
        id: 'proxy.get',
        title: 'Read proxy metadata without password',
        mode: 'ai', state: 'implemented', risk: 'R0', confirmation: 'never',
        toolIds: ['proxy_get_v1'], keywords: ['代理', 'proxy', '详情', '查看'], playbookId: 'proxy-management-v1',
    },
    {
        id: 'proxy.create',
        title: 'Create proxy metadata without password',
        mode: 'ai', state: 'implemented', risk: 'R2', confirmation: 'always',
        toolIds: ['proxy_create_v1'], keywords: ['代理', 'proxy', '新增', '创建'], playbookId: 'proxy-management-v1',
    },
    {
        id: 'proxy.update',
        title: 'Update proxy metadata with revision protection',
        mode: 'ai', state: 'implemented', risk: 'R2', confirmation: 'always',
        toolIds: ['proxy_update_v1'], keywords: ['代理', 'proxy', '修改', '更新'], playbookId: 'proxy-management-v1',
    },
    {
        id: 'proxy.delete',
        title: 'Delete proxy with revision protection',
        mode: 'ai', state: 'implemented', risk: 'R3', confirmation: 'always',
        toolIds: ['proxy_delete_v1'], keywords: ['代理', 'proxy', '删除', '移除'], playbookId: 'proxy-management-v1',
    },
    {
        id: 'sshkey.list', title: 'List SSH key metadata', mode: 'ai', state: 'implemented', risk: 'R0', confirmation: 'never',
        toolIds: ['ssh_key_list_v1'], keywords: ['SSH 密钥', '私钥', '密钥库', 'key', '列表'], playbookId: 'ssh-key-management-v1',
    },
    {
        id: 'sshkey.get', title: 'Read SSH key metadata and fingerprint', mode: 'ai', state: 'implemented', risk: 'R0', confirmation: 'never',
        toolIds: ['ssh_key_get_v1'], keywords: ['SSH 密钥', '指纹', '详情', '查看'], playbookId: 'ssh-key-management-v1',
    },
    {
        id: 'sshkey.validate', title: 'Validate SSH key format server-side', mode: 'ai', state: 'implemented', risk: 'R0', confirmation: 'never',
        toolIds: ['ssh_key_validate_v1'], keywords: ['SSH 密钥', '校验', '验证', '指纹'], playbookId: 'ssh-key-management-v1',
    },
    {
        id: 'sshkey.rename', title: 'Rename SSH key metadata', mode: 'ai', state: 'implemented', risk: 'R1', confirmation: 'always',
        toolIds: ['ssh_key_rename_v1'], keywords: ['SSH 密钥', '改名', '重命名'], playbookId: 'ssh-key-management-v1',
    },
    {
        id: 'sshkey.metadata_update', title: 'Update SSH key remark metadata', mode: 'ai', state: 'implemented', risk: 'R1', confirmation: 'always',
        toolIds: ['ssh_key_update_metadata_v1'], keywords: ['SSH 密钥', '备注', '修改'], playbookId: 'ssh-key-management-v1',
    },
    {
        id: 'sshkey.delete', title: 'Delete SSH key metadata', mode: 'ai', state: 'implemented', risk: 'R3', confirmation: 'always',
        toolIds: ['ssh_key_delete_v1'], keywords: ['SSH 密钥', '删除', '移除'], playbookId: 'ssh-key-management-v1',
    },
    {
        id: 'jumphost.list', title: 'List visible jump-host metadata', mode: 'ai', state: 'implemented', risk: 'R0', confirmation: 'never',
        toolIds: ['jump_host_list_v1'], keywords: ['跳板机', '堡垒机', 'jump host', 'bastion', '列表'], playbookId: 'jump-host-management-v1',
    },
    {
        id: 'jumphost.get', title: 'Read jump-host metadata and revision', mode: 'ai', state: 'implemented', risk: 'R0', confirmation: 'never',
        toolIds: ['jump_host_get_v1'], keywords: ['跳板机', '详情', '查看', 'jump host'], playbookId: 'jump-host-management-v1',
    },
    {
        id: 'jumphost.create', title: 'Create a jump host from a usable SSH connection', mode: 'ai', state: 'implemented', risk: 'R2', confirmation: 'always',
        toolIds: ['jump_host_create_v1'], keywords: ['跳板机', '新增', '创建', '堡垒机'], playbookId: 'jump-host-management-v1',
    },
    {
        id: 'jumphost.update', title: 'Update jump-host metadata with revision protection', mode: 'ai', state: 'implemented', risk: 'R2', confirmation: 'always',
        toolIds: ['jump_host_update_v1'], keywords: ['跳板机', '修改', '更新'], playbookId: 'jump-host-management-v1',
    },
    {
        id: 'jumphost.delete', title: 'Delete a jump host with revision protection', mode: 'ai', state: 'implemented', risk: 'R3', confirmation: 'always',
        toolIds: ['jump_host_delete_v1'], keywords: ['跳板机', '删除', '移除'], playbookId: 'jump-host-management-v1',
    },
    {
        id: 'snippet.list', title: 'List personal command snippets', mode: 'ai', state: 'implemented', risk: 'R0', confirmation: 'never',
        toolIds: ['snippet_list_v1'], keywords: ['代码片段', '命令片段', 'snippet', '列表'], playbookId: 'snippet-management-v1',
    },
    {
        id: 'snippet.get', title: 'Read a personal command snippet and revision', mode: 'ai', state: 'implemented', risk: 'R0', confirmation: 'never',
        toolIds: ['snippet_get_v1'], keywords: ['代码片段', '命令', '详情', 'snippet'], playbookId: 'snippet-management-v1',
    },
    {
        id: 'snippet.create', title: 'Create a personal command snippet', mode: 'ai', state: 'implemented', risk: 'R1', confirmation: 'always',
        toolIds: ['snippet_create_v1'], keywords: ['代码片段', '新增', '创建', 'snippet'], playbookId: 'snippet-management-v1',
    },
    {
        id: 'snippet.update', title: 'Update a personal command snippet with revision protection', mode: 'ai', state: 'implemented', risk: 'R1', confirmation: 'always',
        toolIds: ['snippet_update_v1'], keywords: ['代码片段', '修改', '更新', 'snippet'], playbookId: 'snippet-management-v1',
    },
    {
        id: 'snippet.delete', title: 'Delete a personal command snippet with revision protection', mode: 'ai', state: 'implemented', risk: 'R3', confirmation: 'always',
        toolIds: ['snippet_delete_v1'], keywords: ['代码片段', '删除', '移除', 'snippet'], playbookId: 'snippet-management-v1',
    },
    {
        id: 'secretref.list', title: 'Issue short-lived opaque references to usable stored credentials', mode: 'ai', state: 'implemented', risk: 'R0', confirmation: 'never',
        toolIds: ['secret_ref_list_v1'], keywords: ['secretRef', '凭据引用', 'SSH 密钥', '代理密码', '不透明引用'], playbookId: 'secret-ref-binding-v1',
    },
    {
        id: 'secretref.bind_ssh_key', title: 'Bind an opaque SSH-key reference to a connection without revealing it', mode: 'ai', state: 'implemented', risk: 'R2', confirmation: 'always',
        toolIds: ['connection_create_v1', 'connection_update_v1'], keywords: ['secretRef', '绑定', 'SSH 密钥', '连接凭据'], playbookId: 'secret-ref-binding-v1',
    },
    {
        id: 'agent.list', title: 'List online Zephyr Agent devices', mode: 'ai', state: 'implemented', risk: 'R0', confirmation: 'never',
        toolIds: ['agent_list_v1'], keywords: ['Agent', '设备', '手机', '文件共享', '在线'], playbookId: 'agent-device-files-v1',
    },
    {
        id: 'agent.get', title: 'Read one online Agent device metadata', mode: 'ai', state: 'implemented', risk: 'R0', confirmation: 'never',
        toolIds: ['agent_get_v1'], keywords: ['Agent', '设备', '详情', '版本', '只读'], playbookId: 'agent-device-files-v1',
    },
    {
        id: 'agent.files_read', title: 'List stat and read text files from an owned Agent', mode: 'ai', state: 'implemented', risk: 'R0', confirmation: 'never',
        toolIds: ['agent_file_list_v1', 'agent_file_stat_v1', 'agent_file_read_text_v1'], keywords: ['Agent', '文件', '目录', '读取', '手机'], playbookId: 'agent-device-files-v1',
    },
    {
        id: 'agent.files_write', title: 'Create rename or delete paths on a writable Agent share', mode: 'ai', state: 'implemented', risk: 'R3', confirmation: 'always',
        toolIds: ['agent_file_mkdir_v1', 'agent_file_rename_v1', 'agent_file_delete_v1'], keywords: ['Agent', '文件', '创建目录', '重命名', '删除'], playbookId: 'agent-device-files-v1',
    },
    {
        id: 'remotedesktop.capture', title: 'Capture RDP or VNC frame with a stable capture id', mode: 'ai', state: 'implemented', risk: 'R0', confirmation: 'never',
        toolIds: ['remote_desktop_capture_v1'], keywords: ['RDP', 'VNC', '远程桌面', '截图', 'captureId', '画面'], playbookId: 'remote-desktop-closed-loop-v1',
    },
    {
        id: 'remotedesktop.action', title: 'Act on RDP or VNC using a validated capture id', mode: 'ai', state: 'implemented', risk: 'R2', confirmation: 'always',
        toolIds: ['remote_desktop_action_v1'], keywords: ['RDP', 'VNC', '远程桌面', '点击', '输入', '快捷键', 'captureId'], playbookId: 'remote-desktop-closed-loop-v1',
    },
    {
        id: 'remotedesktop.verify', title: 'Verify RDP or VNC action with before and after captures', mode: 'ai', state: 'implemented', risk: 'R0', confirmation: 'never',
        toolIds: ['remote_desktop_verify_v1'], keywords: ['RDP', 'VNC', '验证', '闭环', 'captureId'], playbookId: 'remote-desktop-closed-loop-v1',
    },
    {
        id: 'browser.inspect', title: 'Inspect page elements and issue versioned element references', mode: 'ai', state: 'implemented', risk: 'R0', confirmation: 'never',
        toolIds: ['browser_inspect_v1'], keywords: ['浏览器', '网页', '元素', 'inspect', 'elementRef', 'DOM'], playbookId: 'browser-automation-v1',
    },
    {
        id: 'browser.click', title: 'Click a versioned browser element reference', mode: 'ai', state: 'implemented', risk: 'R1', confirmation: 'always',
        toolIds: ['browser_click_v1'], keywords: ['浏览器', '网页', '点击', 'elementRef'], playbookId: 'browser-automation-v1',
    },
    {
        id: 'browser.type', title: 'Type into a versioned browser element reference', mode: 'ai', state: 'implemented', risk: 'R2', confirmation: 'always',
        toolIds: ['browser_type_v1'], keywords: ['浏览器', '网页', '输入', '表单', 'elementRef'], playbookId: 'browser-automation-v1',
    },
    {
        id: 'terminal.read', title: 'Read authoritative SSH or TELNET session output', mode: 'ai', state: 'implemented', risk: 'R0', confirmation: 'never',
        toolIds: ['terminal_read_v1'], keywords: ['终端', 'SSH', 'TELNET', '输出', '读取', 'screen', 'scrollback'], playbookId: 'terminal-session-ops-v1',
    },
    {
        id: 'terminal.send', title: 'Send text to an active SSH or TELNET session', mode: 'ai', state: 'implemented', risk: 'R2', confirmation: 'always',
        toolIds: ['terminal_send_v1'], keywords: ['终端', 'SSH', 'TELNET', '发送', '输入', '执行'], playbookId: 'terminal-session-ops-v1',
    },
    {
        id: 'terminal.wait', title: 'Wait for SSH or TELNET session output pattern', mode: 'ai', state: 'implemented', risk: 'R0', confirmation: 'never',
        toolIds: ['terminal_wait_v1'], keywords: ['终端', 'SSH', 'TELNET', '等待', '匹配', 'prompt', 'pattern'], playbookId: 'terminal-session-ops-v1',
    },
    {
        id: 'agent.token_manage', title: 'Create reveal regenerate or revoke Agent enrollment tokens', mode: 'humanOnly', state: 'implemented', risk: 'R4', confirmation: 'always',
        humanOnlyReason: 'Agent enrollment tokens grant device access and must be managed by a reauthenticated human-only security flow.',
    },
    {
        id: 'sshkey.secret_manage', title: 'Import generate or reveal SSH private key material', mode: 'humanOnly', state: 'implemented', risk: 'R4', confirmation: 'always',
        humanOnlyReason: 'Private keys and passphrases must never enter model context; import, generation and reveal require a direct human-only secret flow.',
    },
    {
        id: 'security.password.change',
        title: 'Change account password',
        mode: 'humanOnly',
        state: 'implemented',
        risk: 'R4',
        confirmation: 'always',
        humanOnlyReason: 'Requires direct human reauthentication and must never expose a password to a model.',
    },
    {
        id: 'security.secret.reveal',
        title: 'Reveal stored secrets',
        mode: 'humanOnly',
        state: 'implemented',
        risk: 'R4',
        confirmation: 'always',
        humanOnlyReason: 'Passwords, private keys, API keys and tokens must never enter an AI tool result or model context.',
    },
]);

function reportCapabilityCoverage(toolCatalog = []) {
    const toolIds = toolCatalog.map((tool) => tool?.name || tool?.function?.name).filter(Boolean);
    return capabilityCoverageReport(CAPABILITIES, toolIds);
}

function searchAvailableCapabilities(query = '', options = {}) {
    return searchCapabilities(CAPABILITIES, query, options);
}

function capabilityForTool(toolId = '') {
    const name = String(toolId || '');
    return CAPABILITIES.find((capability) => capability.mode === 'ai' && capability.state === 'implemented' && capability.toolIds.includes(name)) || null;
}

function executionPolicyForTool(toolId = '') {
    const capability = capabilityForTool(toolId);
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

module.exports = {
    CAPABILITIES,
    reportCapabilityCoverage,
    searchAvailableCapabilities,
    capabilityForTool,
    executionPolicyForTool,
};
