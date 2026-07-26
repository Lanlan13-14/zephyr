import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('i18n runtime exports core API', async () => {
    const mod = await import(pathToFileURL(path.join(root, 'public/i18n/runtime.js')).href);
    for (const name of ['t', 'initI18n', 'setLocale', 'getLocale', 'applyDomI18n', 'registerCatalog']) {
        assert.equal(typeof mod[name], 'function', name);
    }
});

test('login catalogs cover login UI keys', () => {
    const zh = JSON.parse(read('public/i18n/locales/zh-CN.json'));
    const en = JSON.parse(read('public/i18n/locales/en.json'));
    const required = [
        '终端管理系统', '账号', '密码', '记住我', '忘记密码？', '登录',
        '使用 Passkey 登录', '两步验证', '请输入 6 位动态验证码',
        '动态验证码', '验证并登录', '重置密码', '发送验证码',
        '修改默认密码', '保存并进入系统', '切换主题', '语言',
        '请求失败', '请先完成人机验证', '{brand} - 登录',
        '两次输入的新密码不一致',
    ];
    for (const key of required) {
        assert.ok(Object.prototype.hasOwnProperty.call(zh, key), `zh missing ${key}`);
        assert.ok(Object.prototype.hasOwnProperty.call(en, key), `en missing ${key}`);
        assert.notEqual(en[key], key, `en still source for ${key}`);
    }
});

test('index.html marks login strings with data-i18n and locale switch', () => {
    const html = read('public/index.html');
    assert.match(html, /data-i18n="终端管理系统"/);
    assert.match(html, /data-i18n="登录"/);
    assert.match(html, /data-i18n="使用 Passkey 登录"/);
    assert.match(html, /id="localeSelectLogin"/);
    assert.match(html, /client\.js\?v=20260726-ai-context1/);
});

test('client.js uses i18n runtime for user-facing strings', () => {
    const js = read('public/client.js');
    assert.match(js, /from '\.\/i18n\/runtime\.js\?v=20260726-ai-context1'/);
    assert.match(js, /t\('请求失败'\)/);
    assert.match(js, /t\('请先完成人机验证'\)/);
    assert.match(js, /t\('\{brand\} - 登录'/);
    assert.match(js, /initI18n\(/);
    assert.match(js, /setLocale\(/);
    assert.doesNotMatch(js, /throw new Error\('请先完成人机验证'\)/);
    assert.doesNotMatch(js, /document\.title = `\$\{brandName\} - 登录`/);
});

test('failed catalog loads are retried instead of freezing the locale runtime', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
        calls += 1;
        if (calls <= 2) throw new Error('temporary network failure');
        return { ok: true, json: async () => ({ '请求失败': 'Request failed after retry' }) };
    };
    try {
        const mod = await import(pathToFileURL(path.join(root, 'public/i18n/runtime.js')).href + `?retry=${Date.now()}`);
        await mod.setLocale('en', { persist: false, applyDom: false });
        assert.equal(mod.t('请求失败'), '请求失败');
        await mod.setLocale('en', { persist: false, applyDom: false });
        assert.equal(mod.t('请求失败'), 'Request failed after retry');
        assert.ok(calls >= 3);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('t() interpolates and falls back correctly', async () => {
    const mod = await import(pathToFileURL(path.join(root, 'public/i18n/runtime.js')).href + `?t=${Date.now()}`);
    mod.registerCatalog('en', {
        '请求失败': 'Request failed',
        '{brand} - 登录': '{brand} - Sign in',
    });
    await mod.setLocale('en', { persist: false, applyDom: false });
    assert.equal(mod.t('请求失败'), 'Request failed');
    assert.equal(mod.t('{brand} - 登录', { brand: 'Zephyr' }), 'Zephyr - Sign in');
    await mod.setLocale('zh-CN', { persist: false, applyDom: false });
    assert.equal(mod.t('请求失败'), '请求失败');
});
