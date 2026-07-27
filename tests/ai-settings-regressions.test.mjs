import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appJs = readFileSync(path.join(root, 'public/app.js'), 'utf8');
const appHtml = readFileSync(path.join(root, 'public/app.html'), 'utf8');
const styleCss = readFileSync(path.join(root, 'public/style.css'), 'utf8');
const serverJs = readFileSync(path.join(root, 'server.js'), 'utf8');

test('Ask Auto Yolo is stored per chat beside collaboration mode', () => {
    assert.match(appHtml, /data-i18n="协作模式">协作模式<[\s\S]*id="aiCollabMode"/);
    assert.match(appHtml, /data-i18n="权限模式">权限模式<[\s\S]*id="aiChatPermissionMode"[\s\S]*data-value="ask"[\s\S]*>Ask<[\s\S]*>Auto<[\s\S]*>Yolo</);
    assert.match(appJs, /s\.permissionMode = resolved;\s*saveAiChats\(\)/);
    assert.match(appJs, /setAiSegmentValue\('aiChatPermissionMode', session\.permissionMode \|\|/);
    assert.match(appJs, /const permissionMode = chatPermissionMode/);
});

test('auto-confirm is an explicit runtime run option', () => {
    assert.match(appJs, /autoConfirm:\s*!!aiCfg\.sensitive\?\.autoConfirm/);
    assert.match(appJs, /autoConfirmDelayMs:/);
    assert.match(serverJs, /autoConfirm:\s*!!ai\.sensitive\?\.autoConfirm/);
    assert.match(serverJs, /autoConfirmDelayMs:/);
});

test('provider modal uses flattened visible provider fields', () => {
    assert.match(appJs, /function normalizeVisibleAiProvider/);
    assert.match(appJs, /apiMode:\s*provider\.apiMode \?\? config\.apiMode/);
    assert.match(appJs, /options:[\s\S]*config\.options/);
    assert.match(appJs, /modelUserAgents:\s*provider\.modelUserAgents \?\? config\.modelUserAgents/);
});

test('requested AI checkboxes use the shared switch control', () => {
    for (const id of ['aiProviderVision', 'aiProviderUsePreviousResponse', 'aiProviderShareUsers', 'aiProviderShareAdmins', 'aiProviderEnabled']) {
        assert.match(appHtml, new RegExp(`<input type="checkbox" id="${id}"`));
        assert.match(appHtml, new RegExp(`settings-switch-option[^>]*for="${id}"`));
        assert.match(appHtml, new RegExp(`connection-share-switch[^>]*><input type="checkbox" id="${id}"`));
        assert.doesNotMatch(appHtml, new RegExp(`check-line[^>]*><input type="checkbox" id="${id}"`));
    }
});

test('provider sharing and previous-response switches use regular text with right-aligned toggles', () => {
    for (const [id, label] of [
        ['aiProviderVision', '支持图片输入（RDP/VNC AI 必需）'],
        ['aiProviderShareUsers', '共享给所有用户'],
        ['aiProviderShareAdmins', '共享给所有管理员'],
        ['aiProviderUsePreviousResponse', 'OpenAI Responses 使用 previous_response_id（兼容接口慎开）'],
    ]) {
        const row = new RegExp(`<label class="settings-switch-option" for="${id}">([\\s\\S]*?)</label>`).exec(appHtml)?.[1] || '';
        assert.match(row, new RegExp(`settings-switch-label[^>]*data-i18n="${label.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}"`));
        assert.doesNotMatch(row, /<strong/);
        assert.match(row, new RegExp(`connection-share-switch[^>]*><input type="checkbox" id="${id}"`));
    }
    assert.match(styleCss, /\.ai-provider-modal \.form-group > label\.settings-switch-option\s*\{[\s\S]*?display:\s*flex[\s\S]*?justify-content:\s*space-between/);
    assert.match(styleCss, /\.ai-provider-modal \.settings-switch-label\s*\{[\s\S]*?font-weight:\s*400/);
    assert.match(styleCss, /\.ai-provider-modal \.settings-switch-option > \.connection-share-switch\s*\{[^}]*margin-left:\s*auto/);
});

test('chat mode segments share control radius with adjacent UI buttons', () => {
    assert.match(styleCss, /\.ai-header-actions \.ui-btn,\s*\.ai-collab-segment,\s*\.ai-chat-permission-segment\s*\{\s*border-radius:\s*var\(--radius-control\)/);
    assert.doesNotMatch(styleCss, /\.ai-collab-segment[^{]*\{[^}]*radius-pill/);
});
