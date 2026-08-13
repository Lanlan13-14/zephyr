/**
 * Zephyr One
 *
 * - Runs full Zephyr product UI against a **local** embedded Zephyr core.
 * - Remote Zephyr main is used only for optional account data sync.
 * - Optional "启动时要求系统解锁" (default OFF) → OS authenticator only.
 * - Hides multi-user admin / server security policy / backup import-export
 *   via CSS when loading the local app.
 */

import { invoke } from '@tauri-apps/api/core';
import { createNativeRdpShellController } from './rdp/native-rdp-client.js';

const $ = (sel) => document.querySelector(sel);
const STORAGE_KEY = 'zephyr_one.local.v2';

const state = {
  requireUnlock: false,
  isTauri: typeof window !== 'undefined' && !!(window.__TAURI_INTERNALS__ || window.__TAURI__),
  caps: null,
  runtime: null,
  /** optional remote main for sync only */
  syncServerUrl: '',
};

function createOperationStatus() {
  const liveRegion = $('#operationStatus');
  const pending = new WeakMap();

  function announce(message) {
    if (liveRegion) liveRegion.textContent = message || '';
  }

  function setGateBusy(gate, busy) {
    if (!gate) return;
    gate.setAttribute('aria-busy', String(busy));
    gate.querySelectorAll('button, input').forEach((control) => {
      if (busy) {
        if (!control.disabled) control.dataset.operationWasEnabled = 'true';
        control.disabled = true;
        control.setAttribute('aria-busy', 'true');
      } else if (control.dataset.operationWasEnabled === 'true') {
        control.disabled = false;
        control.removeAttribute('aria-busy');
        delete control.dataset.operationWasEnabled;
      }
    });
  }

  function setControlPending(control, busy, pendingLabel) {
    if (!control) return;
    if (busy) {
      control.setAttribute('aria-busy', 'true');
      if (control.tagName === 'BUTTON') {
        control.dataset.operationLabel = control.textContent;
        control.textContent = pendingLabel || 'Working...';
      }
      return;
    }
    control.removeAttribute('aria-busy');
    if (control.tagName === 'BUTTON' && control.dataset.operationLabel !== undefined) {
      control.textContent = control.dataset.operationLabel;
      delete control.dataset.operationLabel;
    }
  }

  function run({ gate, control, message, pendingLabel }, operation) {
    const key = gate || control;
    const active = key && pending.get(key);
    if (active) return active;

    announce(message);
    setGateBusy(gate, true);
    setControlPending(control, true, pendingLabel);
    const promise = Promise.resolve()
      .then(operation)
      .finally(() => {
        setControlPending(control, false);
        setGateBusy(gate, false);
        if (key) pending.delete(key);
      });
    if (key) pending.set(key, promise);
    return promise;
  }

  return { announce, run };
}

const operationStatus = createOperationStatus();
let nativeRdpController = null;

function loadLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    state.requireUnlock = data.requireUnlock === true;
    state.syncServerUrl = data.syncServerUrl || '';
  } catch {
    /* ignore */
  }
}

function saveLocal() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      requireUnlock: state.requireUnlock === true,
      syncServerUrl: state.syncServerUrl || '',
    }),
  );
}

async function safeInvoke(cmd, args = {}) {
  if (!state.isTauri) {
    if (cmd === 'auth_capabilities') {
      return { available: false, biometry: false, reason: '非 Tauri 运行时' };
    }
    if (cmd === 'auth_unlock') {
      return { ok: false, error: '非 Tauri 运行时' };
    }
    if (cmd === 'runtime_start' || cmd === 'runtime_info') {
      // Dev browser: point at a local zephyr if developer runs npm start
      return {
        running: true,
        baseUrl: 'http://127.0.0.1:3000',
        port: 3000,
        dataDir: '',
        mode: 'dev-external',
      };
    }
    return null;
  }
  return invoke(cmd, args);
}

function show(el) {
  el?.classList.remove('force-hidden');
}
function hide(el) {
  el?.classList.add('force-hidden');
}

function focusGate(gate) {
  const target = gate?.querySelector('[data-gate-focus], h1, [autofocus], button, input');
  if (!target) return;
  if (!target.matches('button, input, select, textarea, a[href], iframe')) target.tabIndex = -1;
  requestAnimationFrame(() => target.focus({ preventScroll: true }));
}

function only(el) {
  ['#appGate', '#lockGate', '#bootGate', '#securityGate', '#errorGate'].forEach((s) => hide($(s)));
  show(el);
  focusGate(el);
}

async function requestSystemUnlock(reason) {
  const caps = state.caps || (await safeInvoke('auth_capabilities'));
  state.caps = caps;
  if (!caps?.available) {
    throw new Error(
      caps?.reason ||
        '系统解锁不可用。请关闭「启动时要求系统解锁」，或在系统中配置指纹/面容/锁屏密码。',
    );
  }
  const r = await safeInvoke('auth_unlock', { reason: reason || '解锁 Zephyr One' });
  if (!r?.ok) throw new Error(r?.error || '系统解锁失败或已取消');
  return true;
}

/**
 * Keep the trusted Tauri document as the outer shell and load the local core in
 * an iframe. The loopback page intentionally has no Tauri IPC capability; the
 * outer shell filters source/origin and accepts only an opaque connection id.
 * Native code resolves and authorizes the connection atomically.
 */
function openLocalZephyr(baseUrl) {
  const u = new URL(baseUrl);
  u.searchParams.set('zephyrOne', '1');
  const frame = $('#localAppFrame');
  const host = $('#appGate');
  if (!frame || !host) throw new Error('Local Zephyr app host is unavailable.');

  nativeRdpController?.dispose();
  nativeRdpController = createNativeRdpShellController({
    frame,
    expectedOrigin: u.origin,
    invoke,
    isTauri: state.isTauri,
    onStatus(action) {
      if (action === 'error') operationStatus.announce('Native RDP operation failed.');
      else if (action === 'open') operationStatus.announce('Native RDP window opened.');
    },
  });

  host.setAttribute('aria-busy', 'true');
  frame.addEventListener('load', () => {
    host.setAttribute('aria-busy', 'false');
    operationStatus.announce('Zephyr One is ready.');
  }, { once: true });
  only(host);
  frame.src = u.toString();
}

function startAndEnter(control) {
  return operationStatus.run(
    {
      gate: $('#bootGate'),
      control,
      message: 'Starting the local Zephyr core.',
      pendingLabel: 'Starting...',
    },
    async () => {
  only($('#bootGate'));
  const status = $('#bootStatus');
  if (status) {
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.setAttribute('aria-atomic', 'true');
    status.textContent =
      '正在启动内置 Zephyr 核心…';
  }
  try {
    const info = await safeInvoke('runtime_start');
    operationStatus.announce('Local core is ready. Opening Zephyr One.');
    if (!info?.baseUrl) throw new Error('本地运行时未返回地址');
    const bootstrapUrl = info.baseUrl;
    const cleanOrigin = new URL(bootstrapUrl).origin;
    state.runtime = { ...info, baseUrl: cleanOrigin };
    if (status) status.textContent = '本地核心就绪，正在进入完整界面…';
    openLocalZephyr(bootstrapUrl);
  } catch (e) {
    operationStatus.announce('Startup failed.');
    only($('#errorGate'));
    const err = $('#errorText');
    const msg = e?.message || String(e);
    if (err) {
      err.textContent =
        msg +
        '\n\n若反复失败：请保留此错误并重新安装最新版；运行日志位于应用数据目录的 zephyr-data/zephyr-node.log。';
    }
  }
    },
  );
}

function unlockThenEnter(control = $('#unlockBtn')) {
  return operationStatus.run(
    {
      gate: $('#lockGate'),
      control,
      message: 'Waiting for system authentication.',
      pendingLabel: 'Authenticating...',
    },
    async () => {
  const err = $('#lockError');
  if (err) {
    err.hidden = true;
    err.textContent = '';
  }
  try {
    await requestSystemUnlock('解锁 Zephyr One');
    operationStatus.announce('System authentication succeeded. Starting Zephyr One.');
    await startAndEnter();
  } catch (e) {
    operationStatus.announce('System authentication failed.');
    if (err) {
      err.hidden = false;
      err.textContent = e?.message || String(e);
    }
  }
    },
  );
}

async function refreshCapabilityHints() {
  try {
    state.caps = await safeInvoke('auth_capabilities');
  } catch {
    state.caps = { available: false, biometry: false, reason: '无法探测' };
  }
  const detail = $('#unlockCapabilityDetail');
  if (!detail) return;
  if (state.caps?.available) {
    detail.textContent = `系统能力：${state.caps.reason || '可用'}`;
  } else {
    detail.textContent = `系统解锁不可用：${state.caps?.reason || '未知'}（可保持开关关闭）`;
  }
}

function openSecurity() {
  only($('#securityGate'));
  const toggle = $('#requireUnlockToggle');
  if (toggle) toggle.checked = state.requireUnlock === true;
  const syncInput = $('#syncServerUrl');
  if (syncInput) syncInput.value = state.syncServerUrl || '';
  refreshCapabilityHints();
}

/* The iframe lives on the loopback core's origin and cannot invoke Tauri
   commands, so a core that lost its session asks for a restart by message.
   Only the exact origin of the runtime we started is trusted. */
let coreRestartInFlight = null;
window.addEventListener('message', (event) => {
  if (event.data?.type !== 'zephyr-one:restart') return;
  if (!state.runtime?.baseUrl || event.origin !== new URL(state.runtime.baseUrl).origin) return;
  if (event.source !== $('#localAppFrame')?.contentWindow) return;
  if (coreRestartInFlight) return;
  coreRestartInFlight = (async () => {
    try { await safeInvoke('runtime_stop'); } catch { /* best effort */ }
    try {
      await startAndEnter();
      $('#localAppFrame')?.contentWindow?.postMessage(
        { type: 'zephyr-one:restarted' },
        new URL(state.runtime.baseUrl).origin,
      );
    } catch { /* startAndEnter already surfaces the error gate */ }
    finally { coreRestartInFlight = null; }
  })();
});
function wire() {
  $('#unlockBtn')?.addEventListener('click', () => unlockThenEnter($('#unlockBtn')));
  $('#retryBootBtn')?.addEventListener('click', () => startAndEnter($('#retryBootBtn')));
  $('#openSecurityFromBoot')?.addEventListener('click', () => openSecurity());
  $('#openSecurityFromError')?.addEventListener('click', () => openSecurity());
  $('#securityDoneBtn')?.addEventListener('click', () => {
    const syncInput = $('#syncServerUrl');
    if (syncInput) {
      state.syncServerUrl = String(syncInput.value || '').trim();
      saveLocal();
    }
    if (state.requireUnlock) only($('#lockGate'));
    else startAndEnter($('#securityDoneBtn'));
  });

  $('#requireUnlockToggle')?.addEventListener('change', (e) => operationStatus.run(
    {
      gate: $('#securityGate'),
      control: e.target,
      message: 'Confirming system authentication availability.',
    },
    async () => {
    const on = !!e.target.checked;
    const err = $('#securityError');
    err?.setAttribute('role', 'alert');
    err?.removeAttribute('aria-live');
    if (err) err.style.color = '';
    if (err) {
      err.hidden = true;
      err.textContent = '';
    }
    if (on) {
      try {
        await requestSystemUnlock('确认启用系统解锁');
      } catch (ex) {
        e.target.checked = false;
        state.requireUnlock = false;
        saveLocal();
        if (err) {
          err.hidden = false;
          err.textContent = ex?.message || String(ex);
        }
        return;
      }
    }
    state.requireUnlock = on;
    saveLocal();
    },
  ));

  $('#testSystemUnlockBtn')?.addEventListener('click', () => operationStatus.run(
    {
      gate: $('#securityGate'),
      control: $('#testSystemUnlockBtn'),
      message: 'Testing system authentication.',
      pendingLabel: 'Testing...',
    },
    async () => {
    const err = $('#securityError');
    err?.setAttribute('role', 'alert');
    err?.removeAttribute('aria-live');
    if (err) err.style.color = '';
    if (err) {
      err.hidden = true;
      err.textContent = '';
    }
    try {
      await requestSystemUnlock('测试系统解锁');
      if (err) {
        err.hidden = false;
        err.setAttribute('role', 'status');
        err.setAttribute('aria-live', 'polite');
        err.style.color = 'var(--accent)';
        operationStatus.announce('System authentication test succeeded.');
        err.textContent = '系统解锁成功';
      }
    } catch (ex) {
      if (err) {
        err.hidden = false;
        err.setAttribute('role', 'alert');
        err.removeAttribute('aria-live');
        err.style.color = '';
        operationStatus.announce('System authentication test failed.');
        err.textContent = ex?.message || String(ex);
      }
    }
    },
  ));
}

async function boot() {
  loadLocal();
  wire();

  if (location.hash === '#security' || location.search.includes('security=1')) {
    openSecurity();
    return;
  }

  if (state.requireUnlock === true) {
    only($('#lockGate'));
    unlockThenEnter().catch(() => {});
    return;
  }

  await startAndEnter();
}

boot();

window.addEventListener('beforeunload', () => nativeRdpController?.dispose(), { once: true });
