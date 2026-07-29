import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import defaults from '../ai-defaults.js';
import playbooks from '../ai-playbooks.js';
import agentService from '../ai-agent-service.js';
import runtimeBridge from '../ai-runtime-bridge.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const storageSource = fs.readFileSync(path.join(root, 'storage.js'), 'utf8');
const appSource = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');

test('all built-in guidance composes into one ordered unified Skill', () => {
    const unified = defaults.buildUnifiedZephyrSkill(playbooks.PLAYBOOKS);
    assert.equal(unified.id, 'zephyr-unified-operator');
    assert.equal(unified.builtin, true);
    for (const playbook of playbooks.PLAYBOOKS) {
        assert.match(unified.prompt, new RegExp(`内置规程：.*${playbook.id}`));
        assert.match(unified.prompt, new RegExp(playbook.prompt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 80)));
    }
});

test('unified Skill teaches deterministic list, open, remote_execute and terminal chains', () => {
    const prompt = defaults.buildUnifiedZephyrSkill(playbooks.PLAYBOOKS).prompt;
    assert.match(prompt, /列出\/有哪些\/显示机器[\s\S]*connection_list_v1/);
    assert.match(prompt, /连接\/打开\/进入 X 机器[\s\S]*connection_open_v1/);
    assert.match(prompt, /在 X 机器执行 Y 命令[\s\S]*remote_execute/);
    assert.match(prompt, /当前 SSH\/TELNET 终端[\s\S]*terminal_read_v1[\s\S]*terminal_send_v1[\s\S]*terminal_wait_v1/);
    assert.match(prompt, /禁止只回复步骤、命令示例、按钮位置/);
});

test('unified Skill covers workspace L1, L2 sandbox matrix, and subagents', () => {
    const prompt = defaults.buildUnifiedZephyrSkill(playbooks.PLAYBOOKS).prompt;
    assert.match(prompt, /会话工作区 L1/);
    assert.match(prompt, /workspace_list_v1/);
    assert.match(prompt, /workspace_write_v1/);
    assert.match(prompt, /user_attachment_read_v1/);
    assert.match(prompt, /会话沙箱 L2/);
    assert.match(prompt, /session_sandbox_status_v1/);
    assert.match(prompt, /session_exec_v1/);
    assert.match(prompt, /Python[\s\S]*完全支持|完全支持[\s\S]*Python/);
    assert.match(prompt, /Node\.js[\s\S]*部分支持|部分支持[\s\S]*Node/);
    assert.match(prompt, /FFmpeg|ffmpeg/);
    assert.match(prompt, /禁止 -c/);
    assert.match(prompt, /subagent_list_profiles_v1/);
    assert.match(prompt, /subagent_parallel_v1/);
    assert.match(prompt, /subagent_fleet_v1/);
    assert.match(prompt, /readonly-scout/);
    assert.match(prompt, /Economy|economy/);
    assert.match(prompt, /与 remote_execute 分工/);
});

test('legacy and Runtime paths inject exactly one built-in Skill plus user Skills', () => {
    const legacy = agentService.mergeZephyrDefaultSkills([
        { id: 'zephyr-local-operator', prompt: 'old' },
        { id: 'playbook:asset-management-v1', prompt: 'old-playbook' },
        { id: 'custom-one', name: 'Custom', prompt: 'CUSTOM_BODY', enabled: true },
    ]);
    assert.deepEqual(legacy.map((item) => item.id), ['zephyr-unified-operator', 'custom-one']);

    const bridge = new runtimeBridge.AiRuntimeBridge({ aiUrl: 'http://127.0.0.1:1' });
    const compose = bridge.buildSystemCompose({
        skills: [
            { id: 'zephyr-local-operator', prompt: 'old', enabled: true },
            { id: 'playbook:asset-management-v1', prompt: 'old-playbook', enabled: true },
            { id: 'custom-one', name: 'Custom', prompt: 'CUSTOM_BODY', enabled: true },
        ],
    }, '', []);
    assert.deepEqual(compose.skills.map((item) => item.id), ['zephyr-unified-operator', 'custom-one']);
    assert.equal(compose.skills.filter((item) => item.id.startsWith('playbook:')).length, 0);
});

test('settings persist only user Skills and UI renders built-in Skill read-only', () => {
    const normalized = agentService.normalizeAiSettingsInput({}, {
        skills: [
            { id: 'zephyr-unified-operator', name: 'built-in', prompt: 'do not persist' },
            { id: 'playbook:asset-management-v1', name: 'old', prompt: 'old' },
            { id: 'custom-one', name: 'Custom', prompt: 'CUSTOM_BODY' },
        ],
    });
    assert.deepEqual(normalized.skills.map((item) => item.id), ['custom-one']);
    assert.match(storageSource, /skills:\s*\[\]/);
    assert.match(storageSource, /legacyBuiltinIds/);
    assert.match(appSource, /zephyr-unified-operator/);
    assert.match(appSource, /s\.builtin[\s\S]*内置只读/);
});

test('guidance version advances for existing installations', () => {
    assert.equal(defaults.DEFAULT_ZEPHYR_AI_GUIDANCE_VERSION, 19);
});
