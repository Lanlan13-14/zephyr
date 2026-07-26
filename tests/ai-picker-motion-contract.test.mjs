import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appJs = readFileSync(path.join(root, 'public/app.js'), 'utf8');
const styleCss = readFileSync(path.join(root, 'public/style.css'), 'utf8');
const appHtml = readFileSync(path.join(root, 'public/app.html'), 'utf8');

test('AI field pickers are real selects, not custom buttons', () => {
    assert.match(appHtml, /<select id="aiDefaultProvider">/);
    assert.match(appHtml, /<select id="aiProviderType">/);
    assert.match(appHtml, /<select id="aiProviderApiMode">/);
    assert.match(appHtml, /<select id="aiProviderReasoningEffort">/);
    // 旧按钮 / hidden + data-ai-field-picker 必须彻底删除
    assert.doesNotMatch(appHtml, /data-ai-field-picker/);
    assert.doesNotMatch(appHtml, /aiDefaultProviderBtn|aiProviderTypeBtn|aiProviderApiModeBtn|aiProviderReasoningEffortBtn/);
    assert.doesNotMatch(appHtml, /ai-settings-picker/);
    assert.doesNotMatch(appHtml, /type="hidden" id="aiDefaultProvider"/);
    assert.doesNotMatch(appHtml, /type="hidden" id="aiProviderType"/);
});

test('AI selects join TOGGLE_SELECT_IDS and MOTION_FILTER_SELECT_IDS (CAPTCHA path)', () => {
    const toggle = appJs.match(/const TOGGLE_SELECT_IDS = \[([\s\S]*?)\];/);
    const motion = appJs.match(/const MOTION_FILTER_SELECT_IDS = \[([\s\S]*?)\];/);
    assert.ok(toggle && motion);
    for (const id of ['aiDefaultProvider', 'aiProviderType', 'aiProviderApiMode', 'aiProviderReasoningEffort', 'captchaProvider']) {
        assert.ok(toggle[1].includes(`'${id}'`), `TOGGLE missing ${id}`);
        assert.ok(motion[1].includes(`'${id}'`), `MOTION missing ${id}`);
    }
});

test('no openAiFieldPicker / setAiFieldPickerValue / AI_FIELD_PICKER leftovers', () => {
    assert.doesNotMatch(appJs, /function openAiFieldPicker|function setAiFieldPickerValue|AI_FIELD_PICKER_CHOICES|aiFieldPickerTargets|data-ai-field-picker/);
    assert.match(appJs, /function setAiFieldSelectValue/);
    assert.match(appJs, /function renderAiProviderOptions/);
    assert.match(appJs, /enhanceToggleSelect\(select\)/);
    assert.match(appJs, /syncToggleSelectFace\(select\)/);
});

test('open/close menu animation is only via openToggleSelectMenu (same as CAPTCHA)', () => {
    assert.match(appJs, /function openToggleSelectMenu/);
    assert.match(appJs, /function closeToggleSelectMenu/);
    assert.match(appJs, /Motion\.morph\(menu, from, \{/);
    assert.match(appJs, /preset:\s*'mac'/);
    assert.match(appJs, /preset: 'macClose'/);
    // 字段选择器不再有独立 morph
    assert.doesNotMatch(appJs, /Motion\.morph\(pop,/);
});

test('modal fill and hints use select values', () => {
    assert.match(appJs, /setAiFieldSelectValue\('aiProviderType'/);
    assert.match(appJs, /setAiFieldSelectValue\('aiProviderApiMode'/);
    assert.match(appJs, /setAiFieldSelectValue\('aiProviderReasoningEffort'/);
    assert.match(appJs, /modeSelect\.disabled = !isOpenAiLike/);
    assert.match(appJs, /aiProviderType'\)\?\.addEventListener\('change'/);
});

test('dead ai-settings-picker CSS fully removed', () => {
    assert.doesNotMatch(styleCss, /ai-settings-picker/);
    assert.doesNotMatch(styleCss, /picker-open/);
    assert.doesNotMatch(styleCss, /popover-motion/);
});

test('cache bust uses dated app and style markers', () => {
    assert.match(appHtml, /app\.js\?v=2026\d{4}[-\w]*/);
    assert.match(appHtml, /style\.css\?v=2026\d{4}[-\w]*/);
});
