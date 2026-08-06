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
function only(el) {
  ['#lockGate', '#bootGate', '#securityGate', '#errorGate'].forEach((s) => hide($(s)));
  show(el);
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
 * Navigate WebView to local full Zephyr UI (same public/app as server).
 * Appends zephyrOne=1 for optional CSS/filters; injects hide-extras when same-origin.
 */
function openLocalZephyr(baseUrl) {
  const u = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  u.searchParams.set('zephyrOne', '1');
  // Prefer app shell when already logged in cookie exists; server routes handle auth.
  // Use root so login → app flow is identical to browser.
  window.location.replace(u.toString());
}

async function startAndEnter() {
  only($('#bootGate'));
  const status = $('#bootStatus');
  if (status) status.textContent = '正在启动本地 Zephyr 核心…';
  try {
    const info = await safeInvoke('runtime_start');
    state.runtime = info;
    if (!info?.baseUrl) throw new Error('本地运行时未返回地址');
    if (status) status.textContent = `本地核心就绪 ${info.baseUrl}，正在进入完整界面…`;
    openLocalZephyr(info.baseUrl);
  } catch (e) {
    only($('#errorGate'));
    const err = $('#errorText');
    if (err) err.textContent = e?.message || String(e);
  }
}

async function unlockThenEnter() {
  const err = $('#lockError');
  if (err) {
    err.hidden = true;
    err.textContent = '';
  }
  try {
    await requestSystemUnlock('解锁 Zephyr One');
    await startAndEnter();
  } catch (e) {
    if (err) {
      err.hidden = false;
      err.textContent = e?.message || String(e);
    }
  }
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

function wire() {
  $('#unlockBtn')?.addEventListener('click', () => unlockThenEnter());
  $('#retryBootBtn')?.addEventListener('click', () => startAndEnter());
  $('#openSecurityFromBoot')?.addEventListener('click', () => openSecurity());
  $('#openSecurityFromError')?.addEventListener('click', () => openSecurity());
  $('#securityDoneBtn')?.addEventListener('click', () => {
    const syncInput = $('#syncServerUrl');
    if (syncInput) {
      state.syncServerUrl = String(syncInput.value || '').trim();
      saveLocal();
    }
    if (state.requireUnlock) only($('#lockGate'));
    else startAndEnter();
  });

  $('#requireUnlockToggle')?.addEventListener('change', async (e) => {
    const on = !!e.target.checked;
    const err = $('#securityError');
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
  });

  $('#testSystemUnlockBtn')?.addEventListener('click', async () => {
    const err = $('#securityError');
    if (err) {
      err.hidden = true;
      err.textContent = '';
    }
    try {
      await requestSystemUnlock('测试系统解锁');
      if (err) {
        err.hidden = false;
        err.style.color = 'var(--accent)';
        err.textContent = '系统解锁成功';
      }
    } catch (ex) {
      if (err) {
        err.hidden = false;
        err.style.color = '';
        err.textContent = ex?.message || String(ex);
      }
    }
  });
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
