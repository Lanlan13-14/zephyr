import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const json = name => JSON.parse(read(name));
const zh = json('public/i18n/locales/zh-CN.json');
const en = json('public/i18n/locales/en.json');
const keys = json('public/i18n/keys.json');
const enMap = json('public/i18n/en-map.json');
const settings = read('public/terminal-shortcut-settings.js');
const tools = read('public/remote-exec-tools.js');
const app = read('public/app.js');
const html = read('public/app.html');
const cjk = /[\u3400-\u9fff]/;
const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();

// Evaluate only the exported literal, never imports, DOM setup or motion code.
const tableMatch = settings.match(/export const TERMINAL_SHORTCUT_SETTINGS_TEXT = (Object\.freeze\(\{[\s\S]*?\}\));/);
assert.ok(tableMatch, 'shortcut settings must export the translation source table');
const settingsText = vm.runInNewContext(tableMatch[1]);
const strings = expression => [...expression.matchAll(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g)]
    .map(match => vm.runInNewContext(match[0])).filter(text => cjk.test(text));
// Include ternaries and helper arguments: audit-i18n.py only discovers literal t().
const toolKeys = [...tools.matchAll(/\b(?:tr|icon|makePanel)\(([^;\n]*?)\)/g)]
    .flatMap(match => strings(match[1]));
const remoteStart = app.indexOf('function getRemoteMotionEngine(');
const remoteEnd = app.indexOf('async function legacyRemoteExecute(');
const remoteSource = app.slice(remoteStart, remoteEnd);
const remoteHtml = html.slice(html.indexOf('id="view-remote"'), html.indexOf('id="view-notes"'));
const appKeys = [...remoteSource.matchAll(/\bt\(\s*(['"])(.*?)\1/g)].map(match => match[2]);
const htmlKeys = [...remoteHtml.matchAll(/data-i18n(?:-[\w-]+)?="([^"]+)"/g)].map(match => match[1]);
const required = [
    '没有可操作的已连接终端',
    '已发送至 {sent} 台，{failed} 台未确认',
    '此片段仅发送至：{name}',
    '此片段将发送至全部已连接终端',
    '终端工具', '右侧终端工具', '仅对焦点机器生效',
];
const featureKeys = new Set([...Object.values(settingsText), ...toolKeys, ...appKeys, ...htmlKeys, ...required]);

function runtime() {
    const context = vm.createContext({ console });
    const source = read('public/i18n/runtime.js').replace(/^export /gm, '')
        .replace(/import\.meta\.url/g, JSON.stringify(new URL('../public/i18n/runtime.js', import.meta.url).href));
    vm.runInContext(source, context);
    context.registerCatalog('zh-CN', zh);
    context.registerCatalog('en', en);
    context.TERMINAL_SHORTCUT_SETTINGS_TEXT = settingsText;
    const start = settings.indexOf('  const tr = (name, params = {}) => {');
    const end = settings.indexOf('  const el = ', start);
    assert.ok(start >= 0 && end > start, 'settings local interpolation helper');
    vm.runInContext(`${settings.slice(start, end)}; globalThis.translateSettings = tr;`, context);
    return context;
}

test('new shortcut settings and batch tool keys are complete in catalogs and build inputs', () => {
    assert.ok(Object.keys(settingsText).length >= 50, 'collect the full settings source table');
    assert.ok(toolKeys.includes('停靠/悬浮切换'), 'collect the stable SSH pin toggle label');
    assert.ok(!toolKeys.includes('恢复自由浮窗'), 'no batch-only conditional pin label');
    assert.ok(toolKeys.includes('暂无代码片段，请到首页 设置 → 代码片段 添加。'), 'collect conditional empty states');
    assert.ok(toolKeys.includes('⌨️ 快捷键') && toolKeys.includes('⚡ 代码片段'), 'collect helper panel titles');
    assert.ok(remoteStart >= 0 && remoteEnd > remoteStart, 'remote source boundaries');
    for (const key of featureKeys) {
        assert.equal(zh[key], key, `missing or changed Chinese source: ${key}`);
        assert.equal(typeof en[key], 'string', `English catalog missing: ${key}`);
        assert.ok(en[key].trim(), `empty English translation: ${key}`);
        assert.ok(!cjk.test(en[key]), `English translation contains Chinese: ${key}`);
        assert.deepEqual(placeholders(key), placeholders(zh[key]), `Chinese placeholders: ${key}`);
        assert.deepEqual(placeholders(key), placeholders(en[key]), `English placeholders: ${key}`);
        assert.ok(keys.includes(key), `build key missing: ${key}`);
        assert.equal(enMap[key], en[key], `build English mapping differs: ${key}`);
    }
    assert.deepEqual(keys, Object.keys(zh));
    assert.deepEqual(Object.keys(en), Object.keys(zh));
    assert.equal(new Set(keys).size, keys.length, 'no duplicate build keys');
    assert.deepEqual(enMap, en);
});

test('settings interpolation preserves user labels and key names in both locales', async () => {
    const context = runtime();
    // Deliberately match a translation key and include brace-like text.
    const params = { label: '删除 <用户> {name}', key: 'Ctrl+Alt+Delete', count: 2, position: 3 };
    for (const locale of ['zh-CN', 'en']) {
        await context.setLocale(locale, { persist: false, applyDom: false, broadcast: false });
        const catalog = locale === 'en' ? en : zh;
        for (const [id, key] of Object.entries(settingsText)) {
            const expected = catalog[key].replace(/\{(\w+)\}/g, (all, name) => String(params[name] ?? all));
            assert.equal(context.translateSettings(id, params), expected, `${locale}: ${id}`);
        }
        assert.ok(context.translateSettings('moved', params).includes(params.label));
        assert.ok(context.translateSettings('invalid', params).includes(params.key));
    }
});

test('batch toasts and draft scope hints interpolate counts and literal machine names', async () => {
    const context = runtime();
    const params = { sent: 2, failed: 1, name: '删除 <server> {sent}' };
    for (const locale of ['zh-CN', 'en']) {
        await context.setLocale(locale, { persist: false, applyDom: false, broadcast: false });
        assert.equal(context.t(required[1], params), (locale === 'en' ? en : zh)[required[1]]
            .replace('{sent}', '2').replace('{failed}', '1'));
        assert.ok(context.t(required[2], params).includes(params.name), 'machine name must remain literal');
        assert.ok(app.includes(`t('${required[1]}', { sent: result.sent, failed: result.failed })`));
        assert.ok(app.includes(`t('${required[2]}', { name: remoteSnippetDraftScope.name })`));
    }
});

test('new remote toolbar and dock aria labels use translated DOM attributes', async () => {
    const context = runtime();
    const elements = ['终端工具', '右侧终端工具'].map(key => ({
        attributes: { 'data-i18n-aria-label': key, 'aria-label': key },
        getAttribute(name) { return this.attributes[name] ?? null; },
        setAttribute(name, value) { this.attributes[name] = value; },
    }));
    for (const key of ['终端工具', '右侧终端工具']) {
        assert.ok(remoteHtml.includes(`aria-label="${key}" data-i18n-aria-label="${key}"`), key);
    }
    for (const locale of ['zh-CN', 'en']) {
        await context.setLocale(locale, { persist: false, applyDom: false, broadcast: false });
        context.applyDomI18n({ querySelectorAll: () => elements });
        for (const element of elements) {
            assert.equal(element.attributes['aria-label'], context.t(element.attributes['data-i18n-aria-label']));
        }
    }
});

test('user shortcut labels, snippet names, groups and commands bypass translation', () => {
    const context = vm.createContext({});
    vm.runInContext(read('public/terminal-shortcuts.js').replace(/^export /gm, ''), context);
    const label = '删除 <自定义> {count}';
    assert.equal(context.shortcutLabel({ label, keys: ['Ctrl', 'A'] }), label);
    const render = tools.slice(tools.indexOf('    const renderSnippets = '), tools.indexOf('    const makePanel = '));
    assert.ok(render.includes("item.name || tr('未命名片段')"));
    assert.ok(render.includes("item.group || tr('未分组')"));
    assert.ok(render.includes("String(item.command || '')"));
    assert.doesNotMatch(render, /\b(?:tr|t)\(\s*item\.(?:name|group|command)/);
    assert.doesNotMatch(tools, /\b(?:tr|t)\(\s*shortcutLabel\(/);
    assert.doesNotMatch(settings, /\bt\(\s*(?:shortcutLabel\(|(?:item|editor)\.label)/);
});

test('catalog fetches use the batch-tools28 dictionary version', () => {
    assert.ok(read('public/i18n/runtime.js').includes("url.searchParams.set('v', '20261101-batch-tools28');"));
});
