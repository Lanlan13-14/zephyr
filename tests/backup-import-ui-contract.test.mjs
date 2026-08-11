import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const [html, js, en, zh] = await Promise.all([
  readFile(new URL('public/app.html', root), 'utf8'),
  readFile(new URL('public/app.js', root), 'utf8'),
  readFile(new URL('public/i18n/locales/en.json', root), 'utf8').then(JSON.parse),
  readFile(new URL('public/i18n/locales/zh-CN.json', root), 'utf8').then(JSON.parse),
]);

const start = js.indexOf('/* Backup import UI start.');
const endMarker = '/* Backup import UI end. */';
const end = js.indexOf(endMarker, start);
assert.ok(start >= 0 && end > start, 'backup import UI logic must remain independently testable');
const importSource = js.slice(start, end + endMarker.length);

function node(initial = {}) {
  return {
    value: '', files: [], disabled: false, dataset: {}, textContent: '', attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    focus() { this.focused = true; },
    ...initial,
  };
}

class FakeFormData {
  constructor() { this.parts = []; }
  append(name, value) { this.parts.push([name, value]); }
}

function response(status, payload) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function loadHarness({ fetchImpl } = {}) {
  const file = node({ files: [{ name: 'backup.enc' }] });
  const loginPassword = node({ value: 'login-password' });
  const backupPassword = node({ value: 'backup-password' });
  const button = node();
  const status = node();
  const form = node({ querySelectorAll: () => [file, loginPassword, backupPassword, button] });
  const elements = new Map([
    ['#importDataForm', form], ['#backupFile', file], ['#importLoginPassword', loginPassword],
    ['#backupPassword', backupPassword], ['#importDataBtn', button], ['#importDataStatus', status],
  ]);
  const context = {
    Error, FormData: FakeFormData, JSON, Number, String,
    fetch: fetchImpl || (async () => { throw new Error('unexpected fetch'); }),
    confirm: () => true, t: (key) => key,
    $: (selector) => elements.get(selector) || null,
  };
  vm.runInNewContext(`${importSource}\n;globalThis.backupImportExports = {
    submitBackupImport, backupImportUiState, backupImportErrorKey,
  };`, context, { filename: 'backup-import-ui.js' });
  return { ...context.backupImportExports, file, loginPassword, backupPassword, button, status, form };
}

test('backup import UI has a dedicated accessible status and guarded controls', () => {
  assert.match(html, /id="importDataForm"[^>]*aria-busy="false"[^>]*aria-describedby="importDataStatus"/);
  assert.match(html, /id="backupFile"[^>]*required[^>]*aria-describedby="importDataStatus"/);
  assert.match(html, /id="importLoginPassword"[^>]*required[^>]*aria-describedby="importDataStatus"/);
  assert.match(html, /id="importDataBtn"[^>]*type="submit"[^>]*aria-describedby="importDataStatus"/);
  assert.match(html, /id="importDataStatus"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/);
});

test('two-phase import sends the login password only to the grant endpoint and clears it before upload', async () => {
  const calls = [];
  let harness;
  const fetchImpl = async (url, options) => {
    calls.push({ url, options, loginValueAtRequest: harness.loginPassword.value });
    if (url.endsWith('/grant')) return response(200, { ok: true, grant: 'one-time-grant', expiresAt: Date.now() + 90_000 });
    return response(200, { ok: true, message: '导入完成' });
  };
  harness = loadHarness({ fetchImpl });

  const outcome = await harness.submitBackupImport({ fetchImpl, confirmImpl: () => true });
  assert.equal(outcome.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, '/api/data/import/grant');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].options.body), { password: 'login-password' });
  assert.equal(calls[1].url, '/api/data/import');
  assert.equal(calls[1].loginValueAtRequest, '', 'the login password field is cleared before upload starts');
  assert.equal(calls[1].options.headers['X-Zephyr-Backup-Import-Grant'], 'one-time-grant');
  assert.equal(Object.hasOwn(calls[1].options.headers, 'Content-Type'), false, 'the browser must set the multipart boundary');
  assert.deepEqual(calls[1].options.body.parts.map(([name]) => name), ['backup', 'backupPassword']);
  assert.equal(calls[1].options.body.parts.some(([name]) => name === 'loginPassword'), false);
  assert.equal(harness.loginPassword.value, '');
  assert.equal(harness.backupPassword.value, '');
  assert.equal(Object.hasOwn(harness.backupImportUiState, 'grant'), false);
});

test('grant failures never start an upload or retain the login password', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return response(403, { code: 'backup_import_step_up_failed' });
  };
  const harness = loadHarness({ fetchImpl });

  const outcome = await harness.submitBackupImport({ fetchImpl, confirmImpl: () => true });
  assert.equal(outcome.ok, false);
  assert.equal(calls.length, 1);
  assert.equal(harness.loginPassword.value, '');
  assert.equal(harness.status.textContent, '当前登录密码验证失败，请重试。');
  assert.equal(harness.button.disabled, false);
});

test('an upload transport failure reports an unknown outcome and does not retry the grant', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith('/grant')) return response(200, { grant: 'one-time-grant' });
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  };
  const harness = loadHarness({ fetchImpl });

  const outcome = await harness.submitBackupImport({ fetchImpl, confirmImpl: () => true });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.outcomeUnknown, true);
  assert.equal(calls.length, 2);
  assert.equal(harness.status.textContent, '导入请求已提交；结果可能已完成，请刷新页面确认。');
  assert.equal(harness.status.attributes['aria-live'], 'assertive');
});

test('a second import submission cannot race the active grant request', async () => {
  let resolveGrant;
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    if (url.endsWith('/grant')) return new Promise((resolve) => { resolveGrant = resolve; });
    return response(200, { ok: true });
  };
  const harness = loadHarness({ fetchImpl });
  const first = harness.submitBackupImport({ fetchImpl, confirmImpl: () => true });
  const second = await harness.submitBackupImport({ fetchImpl, confirmImpl: () => true });
  assert.equal(second.ok, false);
  assert.equal(second.busy, true);
  assert.equal(calls, 1);
  resolveGrant(response(200, { grant: 'one-time-grant' }));
  assert.equal((await first).ok, true);
});

test('import errors and status copy remain localized without storing grants or logging secrets', () => {
  assert.doesNotMatch(importSource, /localStorage|sessionStorage|console\.(?:log|debug|info)/);
  assert.doesNotMatch(importSource, /formData\.append\('loginPassword'/);
  for (const key of [
    '正在验证导入授权', '正在上传备份', '当前登录密码验证失败，请重试。',
    '导入授权无效或已过期，请重新验证当前登录密码。', '备份导入请求无效，请重新选择备份文件后重试。',
    '备份文件超过允许的大小限制。', '已有备份导入正在进行，请稍后重试。',
    '敏感操作过于频繁，请稍后重试。', '导入请求已提交；结果可能已完成，请刷新页面确认。',
  ]) {
    assert.equal(typeof zh[key], 'string', `zh-CN missing ${key}`);
    assert.equal(typeof en[key], 'string', `en missing ${key}`);
    assert.ok(en[key].length > 0, `en empty ${key}`);
  }
});

test('specified import errors have fixed, safe UI copy', () => {
  const { backupImportErrorKey } = loadHarness();
  const expected = new Map([
    ['backup_import_step_up_failed', '当前登录密码验证失败，请重试。'],
    ['backup_import_grant_invalid', '导入授权无效或已过期，请重新验证当前登录密码。'],
    ['invalid_backup_import_multipart', '备份导入请求无效，请重新选择备份文件后重试。'],
    ['backup_import_payload_too_large', '备份文件超过允许的大小限制。'],
    ['backup_import_busy', '已有备份导入正在进行，请稍后重试。'],
    ['webdav_sensitive_rate_limited', '敏感操作过于频繁，请稍后重试。'],
  ]);
  for (const [code, key] of expected) assert.equal(backupImportErrorKey({ code }), key);
});
