import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const en = JSON.parse(fs.readFileSync(path.join(root, 'public/i18n/locales/en.json'), 'utf8'));
const interpolate = (value, vars = {}) => String(value).replace(/\{([A-Za-z0-9_]+)\}/g, (_, name) => vars[name] ?? `{${name}}`);
const t = (key, vars) => interpolate(en[key] || key, vars);

function loadLocalizer() {
    let source = fs.readFileSync(path.join(root, 'public/activity-i18n.js'), 'utf8');
    source = source
        .replace(/^import .*\n/, '')
        .replace('export function localizeActivityMessage', 'function localizeActivityMessage')
        .concat('\nmodule.exports = { localizeActivityMessage };');
    const sandbox = { module: { exports: {} }, exports: {}, t };
    vm.runInNewContext(source, sandbox, { filename: 'activity-i18n.js' });
    return sandbox.module.exports.localizeActivityMessage;
}

test('persisted Chinese activity messages render in the selected locale', () => {
    const localizeActivityMessage = loadLocalizer();
    assert.equal(localizeActivityMessage('修改登录密码'), 'Changed sign-in password');
    assert.equal(localizeActivityMessage('用户登录：admin'), 'User signed in: admin');
    assert.equal(localizeActivityMessage('新增连接：prod-1'), 'Added connection: prod-1');
    assert.equal(localizeActivityMessage('测试连接：prod-1 - 成功'), 'Tested connection: prod-1 - 成功');
    assert.equal(localizeActivityMessage('自定义消息'), '自定义消息');
});

test('app renders activity messages through localizeActivityMessage', () => {
    const source = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
    assert.match(source, /import \{ localizeActivityMessage \}/);
    assert.match(source, /localizeActivityMessage\(activity\.message/);
});
