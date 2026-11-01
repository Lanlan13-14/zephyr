import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const json = (name) => JSON.parse(read(name));
const zh = json('public/i18n/locales/zh-CN.json');
const en = json('public/i18n/locales/en.json');
const app = read('public/app.js');
const html = read('public/app.html');
const timeoutKeys = [
    '命令已超时，已发送 Ctrl+C 停止：{name}',
    '命令超时，但无法确认已停止：{name}',
    '命令超时，但终端未确认 Ctrl+C：{name}',
];
const remoteSource = app.slice(app.indexOf('function getRemoteMotionEngine('), app.indexOf('async function legacyRemoteExecute('));
const remoteHtml = html.slice(html.indexOf('id="view-remote"'), html.indexOf('id="view-notes"'));
const keys = new Set([
    '超时停止命令', '双击放大 / 单击聚焦', '窗口手柄', ...timeoutKeys,
    '清屏', '重连', '进入终端页', '关闭', '终端',
    '背景强度', '模糊强度',
    ...[...remoteSource.matchAll(/\bt\(\s*(['"])(.*?)\1/g)].map((m) => m[2]),
    ...[...remoteHtml.matchAll(/data-i18n(?:-[\w-]+)?="([^"]+)"/g)].map((m) => m[1]),
]);
const placeholders = (text) => [...text.matchAll(/\{([\w]+)\}/g)].map((m) => m[1]).sort();

function runtime() {
    const context = vm.createContext({ console });
    const source = read('public/i18n/runtime.js').replace(/^export /gm, '')
        .replace(/import\.meta\.url/g, JSON.stringify(new URL('../public/i18n/runtime.js', import.meta.url).href));
    vm.runInContext(source, context);
    context.registerCatalog('zh-CN', zh);
    context.registerCatalog('en', en);
    return context;
}

function windowFactory(context) {
    class Element {
        constructor(tag) { this.tagName = tag; this.dataset = {}; this.children = []; this.attributes = {}; }
        append(...children) { this.children.push(...children); }
        appendChild(child) { this.append(child); }
        setAttribute(name, value) { this.attributes[name] = value; }
        addEventListener() {}
    }
    context.document = { createElement: (tag) => new Element(tag) };
    context.connections = [{ id: 'test', name: 'test', protocol: 'SSH' }];
    context.settings = {};
    context.terminalProbeLatency = new Map();
    context.isIpProtectionEnabled = () => true;
    context.remoteExecLabel = () => 'test';
    context.terminalProtocolClass = () => 'ssh';
    context.initializeRemoteExecFrame = () => {};
    vm.runInContext(app.slice(app.indexOf('function createRemoteExecWindowElement('), app.indexOf('function renderRemoteWorkspace(')), context);
    return () => context.createRemoteExecWindowElement({ id: 'test', connectionId: 'test', sessionId: 'test', status: 'connected' });
}
const descendants = (node) => [node, ...node.children.flatMap(descendants)];

test('batch timeout label means stop command, not close window, in both locales', () => {
    assert.match(remoteHtml, /<strong data-i18n="超时停止命令">超时停止命令<\/strong>/);
    assert.equal(en['超时停止命令'], 'Stop command on timeout');
    for (const source of [html, ...[zh, en].map(JSON.stringify)]) {
        assert.doesNotMatch(source, /超时自动关闭|批量执行已超时并关闭/);
    }
});

test('batch execution, dynamic action, grip and slider keys have matching catalogs and placeholders', () => {
    for (const key of keys) {
        assert.ok(Object.hasOwn(zh, key), `zh missing ${key}`);
        assert.ok(Object.hasOwn(en, key), `en missing ${key}`);
        if (/[\u3400-\u9fff]/.test(key)) assert.notEqual(en[key], key, `untranslated ${key}`);
        assert.deepEqual(placeholders(zh[key]), placeholders(en[key]), key);
    }
});

test('timeout toasts use t() with live session labels and interpolate in both languages', async () => {
    const context = runtime();
    for (const locale of ['en', 'zh-CN']) {
        await context.setLocale(locale, { persist: false, applyDom: false, broadcast: false });
        for (const key of timeoutKeys) {
            assert.ok(app.includes(`toast(t('${key}', { name: remoteExecLabel(session) }));`), key);
            const output = context.t(key, { name: 'server-A' });
            assert.ok(output.includes('server-A'));
            assert.doesNotMatch(output, /\{name\}/);
            if (locale === 'en') assert.doesNotMatch(output, /[\u3400-\u9fff]/);
        }
    }
});

test('new remote window buttons, tooltips and grip render translated without a browser', async () => {
    const context = runtime();
    const createWindow = windowFactory(context);
    for (const locale of ['en', 'zh-CN']) {
        await context.setLocale(locale, { persist: false, applyDom: false, broadcast: false });
        const nodes = descendants(createWindow());
        const grip = nodes.find((node) => node.dataset.remoteGrip);
        assert.equal(grip.title, context.t('双击放大 / 单击聚焦'));
        assert.equal(grip.attributes['aria-label'], context.t('窗口手柄'));
        const expected = { 'ctrl-c': 'Ctrl+C', clear: '清屏', reconnect: '重连', promote: '进入终端页', close: '关闭' };
        for (const node of nodes.filter((item) => item.dataset.remoteAction)) {
            assert.equal(node.title, context.t(expected[node.dataset.remoteAction]));
            assert.equal(node.attributes['aria-label'], node.title);
            if (locale === 'en') assert.doesNotMatch(node.innerHTML, /[\u3400-\u9fff]/);
        }
    }
});

test('slider labels translate via DOM without replacing numeric inputs', async () => {
    const context = runtime();
    const labels = ['背景强度', '模糊强度'].map((key) => ({
        textContent: key,
        getAttribute: (name) => name === 'data-i18n' ? key : null,
    }));
    const scope = { querySelectorAll: () => labels };
    for (const locale of ['en', 'zh-CN']) {
        await context.setLocale(locale, { persist: false, applyDom: false, broadcast: false });
        context.applyDomI18n(scope);
        assert.deepEqual(labels.map((el) => el.textContent), ['背景强度', '模糊强度'].map((key) => context.t(key)));
    }
    for (const id of ['globalBgOpacity', 'globalBgBlur', 'terminalBgOpacity', 'terminalBgBlur']) {
        assert.ok(html.includes(`data-lg-slider-for="${id}"`));
        assert.match(html, new RegExp(`<input id="${id}"[^>]*type="range"`));
    }
    assert.doesNotMatch(read('public/liquid-glass-slider.js'), /[\u3400-\u9fff]/);
});

test('catalog build inputs preserve the complete existing key and English map sets', () => {
    assert.deepEqual(json('public/i18n/keys.json'), Object.keys(zh));
    assert.deepEqual(json('public/i18n/en-map.json'), en);
});
