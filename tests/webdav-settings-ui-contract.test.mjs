import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const [html, js, css, en, zh] = await Promise.all([
  readFile(new URL('public/app.html', root), 'utf8'),
  readFile(new URL('public/app.js', root), 'utf8'),
  readFile(new URL('public/style.css', root), 'utf8'),
  readFile(new URL('public/i18n/locales/en.json', root), 'utf8').then(JSON.parse),
  readFile(new URL('public/i18n/locales/zh-CN.json', root), 'utf8').then(JSON.parse),
]);

const start = js.indexOf('/* WebDAV settings start.');
const endMarker = '/* WebDAV settings end. */';
const end = js.indexOf(endMarker, start);
assert.ok(start >= 0 && end > start, 'WebDAV settings logic block must remain testable');
const webDavSource = js.slice(start, end + endMarker.length);

function createNode(initial = {}) {
  const classes = new Set(initial.classes || []);
  return {
    value: '',
    checked: false,
    disabled: false,
    dataset: {},
    textContent: '',
    setAttribute(name, value) { this[name] = value; },
    setCustomValidity(value) { this.validationMessage = value; },
    reportValidity() { return !this.validationMessage; },
    focus() {},
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      toggle(name, force) {
        if (force === true) classes.add(name);
        else if (force === false) classes.delete(name);
        else if (classes.has(name)) classes.delete(name);
        else classes.add(name);
      },
      contains(name) { return classes.has(name); },
    },
    ...initial,
  };
}

function loadWebDavHarness({
  elements = new Map(),
  fetchImpl = async () => { throw new Error('unexpected fetch'); },
  tImpl = (key) => key,
} = {}) {
  const context = {
    AbortController,
    Date,
    Error,
    JSON,
    Number,
    String,
    URL,
    console,
    fetch: fetchImpl,
    document: { querySelectorAll: () => [] },
    $: (selector) => elements.get(selector) || null,
    setChecked: (selector, value) => { const node = elements.get(selector); if (node) node.checked = value; },
    setVal: (selector, value) => { const node = elements.get(selector); if (node) node.value = value; },
    t: tImpl,
    formatDateTime: (value) => `time:${value}`,
    requestSensitiveSecret: async () => 'verified-secret',
    confirm: () => true,
  };
  vm.runInNewContext(`${webDavSource}\n;globalThis.webDavExports = {
    requestWebDav, makeWebDavRequestError, webDavErrorKey, webDavRemoteStatusKey,
    collectWebDavDraft, populateWebDavForm, updateWebDavCredentialOriginHint, trackWebDavCredentialInputOrigin,
    showWebDavError, runWebDavOperation, cancelWebDavOperation,
    deleteWebDavSettings, webDavUiState,
  };`, context, { filename: 'webdav-settings-block.js' });
  return context.webDavExports;
}

test('data settings expose the complete accessible WebDAV workflow', () => {
  assert.match(html, /id="webDavSettingsSection"[^>]*aria-labelledby="webDavSettingsTitle"[^>]*aria-busy="true"/);
  assert.match(html, /id="webDavEnabled"[^>]*data-webdav-lock/);
  assert.match(html, /id="webDavBaseUrl"[^>]*type="url"[^>]*required/);
  assert.match(html, /id="webDavBaseUrl"[^>]*aria-describedby="webDavBaseUrlHint"/);
  assert.match(html, /id="webDavBaseUrlHint"/);
  assert.match(html, /id="webDavUsername"/);
  assert.match(html, /id="webDavRemotePath"/);
  assert.match(html, /id="webDavPassword"[^>]*type="password"[^>]*autocomplete="new-password"/);
  assert.doesNotMatch(html.match(/<input id="webDavPassword"[^>]*>/)?.[0] || '', /placeholder=/);
  assert.match(html, /id="webDavPasswordState"[^>]*aria-live="polite"/);
  assert.match(html, /id="webDavSaveBtn"/);
  assert.match(html, /id="webDavTestBtn"/);
  assert.match(html, /id="webDavSyncNowBtn"/);
  assert.match(html, /id="webDavDeleteBtn"[^>]*type="button"/);
  assert.match(html, /id="webDavDangerActions"/);
  assert.match(html, /id="webDavCancelBtn"/);
  assert.match(html, /id="webDavStatusBand"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /id="webDavError"[^>]*role="alert"[^>]*aria-live="assertive"[^>]*aria-atomic="true"/);
  assert.match(html, /id="webDavRetryBtn"/);
});

test('WebDAV UI is quiet, responsive, focus-visible, and reduced-motion aware', () => {
  assert.match(css, /\.data-settings-section \+ \.data-settings-section/);
  assert.match(css, /\.webdav-actions \.btn:focus-visible/);
  assert.match(css, /\.webdav-status-band:focus-visible/);
  assert.match(css, /@media \(max-width: 640px\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(js, /button\.setAttribute\('aria-busy', pending \? 'true' : 'false'\)/);
  assert.match(js, /button\.setAttribute\('aria-disabled', disabled \? 'true' : 'false'\)/);
  assert.match(css, /@media \(hover: hover\) and \(pointer: fine\)/);
  assert.doesNotMatch(css.match(/\.webdav-settings-section[\s\S]*?\.brand-upload-row/)?.[0] || '', /transition:\s*all/);
  assert.doesNotMatch(html.match(/<section class="data-settings-section webdav-settings-section"[\s\S]*?<\/section>/)?.[0] || '', /security-card/);
});

test('mock fetch observes the fixed routes, same-origin credentials, and sensitive payload', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(url.endsWith('/config')
        ? { ok: true, config: { configured: true, hasPassword: true } }
        : { ok: true, result: { reachable: true } }),
    };
  };
  const { requestWebDav } = loadWebDavHarness({ fetchImpl });

  await requestWebDav('/config', { fetchImpl });
  await requestWebDav('/test', {
    method: 'POST',
    body: { baseUrl: 'https://dav.example.test/', secret: 'step-up-secret' },
    fetchImpl,
  });
  await requestWebDav('/sync-now', {
    method: 'POST',
    body: { secret: 'step-up-secret' },
    fetchImpl,
  });

  assert.equal(calls[0].url, '/api/webdav-sync/config');
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.equal(calls[0].options.body, undefined);
  assert.equal(calls[1].url, '/api/webdav-sync/test');
  assert.equal(calls[1].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    baseUrl: 'https://dav.example.test/',
    secret: 'step-up-secret',
  });
  assert.equal(calls[2].url, '/api/webdav-sync/sync-now');
  assert.deepEqual(JSON.parse(calls[2].options.body), { secret: 'step-up-secret' });
});

test('deleting a configured WebDAV integration uses the guarded DELETE route and forgets the local projection', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, deleted: true }) };
  };
  const { deleteWebDavSettings, webDavUiState } = loadWebDavHarness({ fetchImpl });
  webDavUiState.config = { configured: true, enabled: true, hasPassword: true };

  await deleteWebDavSettings();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/webdav-sync/config');
  assert.equal(calls[0].options.method, 'DELETE');
  assert.deepEqual(JSON.parse(calls[0].options.body), { secret: 'verified-secret' });
  assert.equal(webDavUiState.config.configured, false);
  assert.equal(webDavUiState.config.hasPassword, false);
});

test('mock fetch cannot leak a server message or secret through ordinary errors', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 500,
    text: async () => JSON.stringify({
      ok: false,
      error: {
        code: 'webdav_backup_failed',
        message: 'internal database path C:/private and password must-not-leak',
        retryable: false,
      },
    }),
  });
  const { requestWebDav, webDavErrorKey } = loadWebDavHarness({ fetchImpl });

  await assert.rejects(
    requestWebDav('/sync-now', { method: 'POST', body: { secret: 'must-not-leak' }, fetchImpl }),
    (error) => {
      assert.equal(error.message, 'WebDAV request failed.');
      assert.equal(error.code, 'webdav_backup_failed');
      assert.equal(error.message.includes('must-not-leak'), false);
      assert.equal(webDavErrorKey(error), 'WebDAV 操作失败，未覆盖远程备份。');
      return true;
    },
  );
});

test('blank passwords are omitted and stored passwords are never echoed into the field', () => {
  const elements = new Map([
    ['#webDavEnabled', createNode({ checked: true })],
    ['#webDavBaseUrl', createNode({ value: ' https://dav.example.test/root/ ' })],
    ['#webDavUsername', createNode({ value: 'alice' })],
    ['#webDavRemotePath', createNode({ value: ' Zephyr/backups ' })],
    ['#webDavPassword', createNode({ value: '' })],
  ]);
  const { collectWebDavDraft, populateWebDavForm } = loadWebDavHarness({ elements });

  const keepStored = collectWebDavDraft();
  assert.equal(Object.hasOwn(keepStored, 'password'), false);
  elements.get('#webDavPassword').value = 'explicit-new-password';
  assert.equal(collectWebDavDraft().password, 'explicit-new-password');

  populateWebDavForm({
    configured: true,
    enabled: true,
    baseUrl: 'https://dav.example.test/root/',
    username: 'alice',
    remotePath: 'Zephyr/backups',
    hasPassword: true,
  });
  assert.equal(elements.get('#webDavPassword').value, '');
});

test('changing a saved WebDAV origin clears credential projections and only sends fresh credentials for that origin', () => {
  const elements = new Map([
    ['#webDavEnabled', createNode({ checked: true })],
    ['#webDavBaseUrl', createNode({ value: 'https://dav.example.test/root/' })],
    ['#webDavUsername', createNode({ value: 'alice' })],
    ['#webDavRemotePath', createNode({ value: 'Zephyr/backups' })],
    ['#webDavPassword', createNode({ value: 'old-password' })],
  ]);
  const {
    collectWebDavDraft, populateWebDavForm, updateWebDavCredentialOriginHint,
    trackWebDavCredentialInputOrigin, webDavUiState,
  } = loadWebDavHarness({ elements });
  webDavUiState.config = {
    configured: true, enabled: true, baseUrl: 'https://dav.example.test/root/',
    username: 'alice', remotePath: 'Zephyr/backups', hasPassword: true,
  };
  populateWebDavForm(webDavUiState.config);

  elements.get('#webDavBaseUrl').value = 'https://DAV.example.test:443/other/';
  updateWebDavCredentialOriginHint();
  assert.equal(webDavUiState.credentialOriginChanged, false, 'canonical same-origin edits retain the saved projection');
  assert.equal(elements.get('#webDavUsername').value, 'alice');

  elements.get('#webDavBaseUrl').value = 'https://new-dav.example.test/root/';
  updateWebDavCredentialOriginHint();
  assert.equal(webDavUiState.credentialOriginChanged, true);
  assert.equal(elements.get('#webDavUsername').value, '');
  assert.equal(elements.get('#webDavPassword').value, '');
  assert.equal(webDavUiState.config.username, '');
  assert.equal(webDavUiState.config.hasPassword, false);
  assert.equal(Object.hasOwn(collectWebDavDraft(), 'username'), false);
  assert.equal(Object.hasOwn(collectWebDavDraft(), 'password'), false);

  elements.get('#webDavUsername').value = 'new-alice';
  elements.get('#webDavPassword').value = 'new-password';
  trackWebDavCredentialInputOrigin();
  assert.deepEqual(JSON.parse(JSON.stringify(collectWebDavDraft())), {
    baseUrl: 'https://new-dav.example.test/root/', remotePath: 'Zephyr/backups', enabled: true,
    username: 'new-alice', password: 'new-password',
  });

  elements.get('#webDavBaseUrl').value = 'https://dav.example.test/returned/';
  updateWebDavCredentialOriginHint();
  assert.equal(elements.get('#webDavUsername').value, '', 'switching back must not resurrect the original username');
  assert.equal(elements.get('#webDavPassword').value, '', 'switching back must not resurrect a password');
  assert.equal(Object.hasOwn(collectWebDavDraft(), 'username'), false);
  assert.equal(Object.hasOwn(collectWebDavDraft(), 'password'), false);
});

test('an invalid WebDAV URL fails closed for credential submission after a saved origin was loaded', () => {
  const elements = new Map([
    ['#webDavEnabled', createNode({ checked: true })],
    ['#webDavBaseUrl', createNode({ value: 'https://dav.example.test/root/' })],
    ['#webDavUsername', createNode({ value: 'alice' })],
    ['#webDavRemotePath', createNode({ value: 'Zephyr/backups' })],
    ['#webDavPassword', createNode({ value: 'old-password' })],
  ]);
  const {
    collectWebDavDraft, populateWebDavForm, updateWebDavCredentialOriginHint, webDavUiState,
  } = loadWebDavHarness({ elements });
  webDavUiState.config = { configured: true, baseUrl: 'https://dav.example.test/root/', username: 'alice', hasPassword: true };
  populateWebDavForm(webDavUiState.config);
  elements.get('#webDavBaseUrl').value = 'not a URL';
  updateWebDavCredentialOriginHint();
  elements.get('#webDavUsername').value = 'must-not-send';
  elements.get('#webDavPassword').value = 'must-not-send';

  const draft = collectWebDavDraft();
  assert.equal(Object.hasOwn(draft, 'username'), false);
  assert.equal(Object.hasOwn(draft, 'password'), false);
});

test('operation guard prevents double submission and cancellation aborts the active work', async () => {
  const translatedKeys = [];
  const elements = new Map([
    ['#webDavStatusText', createNode()],
    ['#webDavRemoteStatus', createNode()],
  ]);
  const { runWebDavOperation, cancelWebDavOperation, webDavUiState } = loadWebDavHarness({
    elements,
    tImpl: (key) => {
      translatedKeys.push(key);
      return `translated:${key}`;
    },
  });
  let started = 0;
  let resolveWork;
  const first = runWebDavOperation('test', 'busy', (signal) => {
    started += 1;
    return new Promise((resolve, reject) => {
      resolveWork = resolve;
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'webdav_cancelled' })), { once: true });
    });
  }, () => {});
  const second = await runWebDavOperation('test', 'busy', async () => { started += 1; }, () => {});
  assert.equal(second.busy, true);
  assert.equal(started, 1);

  cancelWebDavOperation();
  assert.equal(webDavUiState.statusKey, 'webDav.status.cancellationRequested');
  assert.equal(webDavUiState.remoteStatusKey, 'webDav.remote.resultPendingConfirmation');
  assert.equal(typeof zh[webDavUiState.statusKey], 'string');
  assert.equal(typeof en[webDavUiState.statusKey], 'string');
  assert.ok(zh[webDavUiState.statusKey].length > 0);
  assert.ok(en[webDavUiState.statusKey].length > 0);
  assert.equal(elements.get('#webDavStatusText').textContent, 'translated:webDav.status.cancellationRequested');
  assert.equal(elements.get('#webDavRemoteStatus').textContent, 'translated:webDav.remote.resultPendingConfirmation');
  assert.ok(translatedKeys.includes('webDav.status.cancellationRequested'));
  assert.ok(translatedKeys.includes('webDav.remote.resultPendingConfirmation'));
  const cancelled = await first;
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.error.code, 'webdav_cancelled');
  assert.equal(webDavUiState.retryLabelKey, '刷新 WebDAV 状态');
  resolveWork?.();
});

test('browser cancellation reports an unknown outcome, while an explicit server confirmation may report no change', async () => {
  const abortingFetch = async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); };
  const { requestWebDav, webDavErrorKey, webDavRemoteStatusKey } = loadWebDavHarness({ fetchImpl: abortingFetch });

  await assert.rejects(requestWebDav('/sync-now', { fetchImpl: abortingFetch }), (error) => {
    assert.equal(error.code, 'webdav_cancelled');
    assert.equal(error.confirmedBeforeSideEffect, false);
    assert.equal(webDavErrorKey(error), '已停止等待 WebDAV 操作；操作可能已完成，请刷新状态。');
    assert.equal(webDavRemoteStatusKey(error), '操作结果待确认');
    assert.doesNotMatch(webDavErrorKey(error), /未更改/);
    return true;
  });

  const confirmedFetch = async () => ({
    ok: false,
    status: 409,
    text: async () => JSON.stringify({
      error: { code: 'webdav_cancelled', confirmedBeforeSideEffect: true },
    }),
  });
  const confirmed = loadWebDavHarness({ fetchImpl: confirmedFetch });
  await assert.rejects(requestWebDav('/sync-now', { fetchImpl: confirmedFetch }), (error) => {
    assert.equal(error.confirmedBeforeSideEffect, true);
    assert.equal(confirmed.webDavErrorKey(error), '已确认 WebDAV 操作在更改数据前取消。');
    assert.equal(confirmed.webDavRemoteStatusKey(error), '已确认未更改');
    return true;
  });
});

test('conflict, rate limiting, and unreachable states have distinct fixed labels', () => {
  const { makeWebDavRequestError, webDavErrorKey, webDavRemoteStatusKey, showWebDavError, webDavUiState } = loadWebDavHarness();
  const conflict = makeWebDavRequestError('webdav_conflict', 409);
  const rateLimited = makeWebDavRequestError('webdav_rate_limited', 429, true);
  const unreachable = makeWebDavRequestError('webdav_timeout', 504, true);
  const disconnected = makeWebDavRequestError('webdav_network_error', 0, true);
  const unknown = makeWebDavRequestError('webdav_sync_unknown', 502, true);
  assert.equal(webDavRemoteStatusKey(conflict), '检测到远程冲突');
  assert.equal(webDavRemoteStatusKey(rateLimited), '请求过于频繁');
  assert.equal(webDavRemoteStatusKey(unreachable), '当前不可达');
  assert.equal(webDavErrorKey(unknown), 'WebDAV 同步结果未知；远端可能已更新，请刷新状态。');
  assert.equal(webDavRemoteStatusKey(unknown), '远端状态待确认');
  assert.doesNotMatch(webDavErrorKey(unknown), /未覆盖远程/);
  assert.equal(webDavErrorKey(unreachable), 'WebDAV 服务器响应超时，请稍后重试。');
  assert.equal(webDavErrorKey(disconnected), '无法连接到 Zephyr 服务，请检查当前网络后重试。');
  showWebDavError(unknown, { retry: () => { throw new Error('must not retry the sync'); }, focus: false });
  assert.equal(webDavUiState.statusTone, 'warning');
  assert.equal(webDavUiState.retryLabelKey, '刷新 WebDAV 状态');
  assert.notEqual(webDavErrorKey(conflict), webDavErrorKey(rateLimited));
  assert.notEqual(webDavErrorKey(rateLimited), webDavErrorKey(unreachable));
});

test('new WebDAV copy stays in locale parity', () => {
  for (const key of [
    '启用 WebDAV 备份',
    'WebDAV HTTPS 地址',
    '删除 WebDAV 设置',
    '仅删除 Zephyr 保存的 WebDAV 设置和凭据，不会删除远程备份文件。',
    '删除 WebDAV 设置会移除 Zephyr 保存的凭据，但不会删除远程备份文件。继续？',
    '新 WebDAV 密码（仅更改时输入）',
    'WebDAV 地址来源已更改；旧密码不会用于新地址，请显式输入新凭据。',
    '正在验证 WebDAV 连接',
    '已确认 WebDAV 操作在更改数据前取消。',
    '已停止等待 WebDAV 操作；操作可能已完成，请刷新状态。',
    '已请求取消 WebDAV 操作。',
    '操作结果待确认',
    '已确认未更改',
    '刷新 WebDAV 状态',
    'WebDAV 同步结果未知；远端可能已更新，请刷新状态。',
    '远端状态待确认',
    'WebDAV 地址来源已变更；已清除用户名和密码，请显式输入此地址的凭据。',
    '远程备份已被修改，为避免覆盖，当前备份已停止。',
    'WebDAV 操作过于频繁，请稍后重试。',
    'WebDAV 服务当前不可用，请检查服务配置后重试。',
  ]) {
    assert.equal(typeof zh[key], 'string', `zh-CN missing ${key}`);
    assert.equal(typeof en[key], 'string', `en missing ${key}`);
    assert.ok(en[key].length > 0, `en empty ${key}`);
  }
});
