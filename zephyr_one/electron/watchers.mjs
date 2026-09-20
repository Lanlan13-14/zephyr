import http from 'node:http';
import path from 'node:path';
import { nativeImage } from 'electron';
import { capabilities, unlock } from './auth.mjs';
import { currentBaseUrl, currentSessionId } from './runtime.mjs';
import { signHeaders } from './shell-auth.mjs';

const POLL_MS = 300;
const THEME_POLL_MS = 3000;
const DEFAULT_THEME = 'frost';

function requestJson(url, { method = 'GET', headers = {}, body, timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const sid = currentSessionId();
    const req = http.request(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...(sid ? { Cookie: `zephyr_sid=${sid}`, 'X-Zephyr-Sid': sid } : {}),
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {}),
        ...headers,
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
        resolve({ status: res.statusCode || 0, data, raw });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function schemeFromSettingsJson(body) {
  const scheme = body?.settings?.appearance?.colorScheme;
  return typeof scheme === 'string' ? scheme : null;
}

function resolveTheme(name) {
  const value = String(name || '').trim().toLowerCase();
  if (['frost', 'lava', 'asagi', 'cyber'].includes(value)) return value;
  return DEFAULT_THEME;
}

export function applyThemeIcon(windows, iconsDir, theme) {
  if (process.platform === 'darwin') {
    return { applied: false, theme: resolveTheme(theme), reason: 'macOS 无窗口级图标，Dock 使用安装包内的凝霜蓝图标' };
  }
  const resolved = resolveTheme(theme);
  const file = path.join(iconsDir, `zephyr-one-${resolved}.png`);
  const image = nativeImage.createFromPath(file);
  if (image.isEmpty()) {
    return { applied: false, theme: resolved, reason: '解码内置图标失败' };
  }
  let applied = false;
  for (const window of windows) {
    if (!window || window.isDestroyed()) continue;
    window.setIcon(image);
    applied = true;
  }
  return {
    applied,
    theme: resolved,
    reason: applied ? '' : '尚无窗口可设置图标',
  };
}

export function spawnThemeWatcher({ getWindows, iconsDir }) {
  let current = '';
  const tick = async () => {
    const base = currentBaseUrl();
    if (!base) {
      current = '';
      return;
    }
    try {
      const response = await requestJson(`${base.replace(/\/+$/, '')}/api/me/settings`);
      if (response.status !== 200) return;
      const scheme = schemeFromSettingsJson(response.data);
      if (!scheme) return;
      const resolved = resolveTheme(scheme);
      if (resolved === current) return;
      const result = applyThemeIcon(getWindows(), iconsDir, resolved);
      if (result.applied) current = resolved;
    } catch { /* ignore transient */ }
  };
  setInterval(() => { tick().catch(() => {}); }, THEME_POLL_MS).unref?.();
}

export function spawnUnlockWatcher({ identity }) {
  let published = false;
  const tick = async () => {
    const base = currentBaseUrl();
    if (!base) return;
    const root = base.replace(/\/+$/, '');
    if (!published) {
      try {
        const caps = capabilities();
        const fields = [caps.available ? '1' : '0', caps.biometry ? '1' : '0', caps.reason];
        await requestJson(`${root}/api/one/security/capabilities`, {
          method: 'POST',
          headers: signHeaders(identity, 'capabilities', fields),
          body: caps,
        });
        published = true;
      } catch { /* core may still be booting */ }
    }
    let claim;
    try {
      const response = await requestJson(`${root}/api/one/security/unlock-queue`, {
        headers: signHeaders(identity, 'unlock.claim', []),
      });
      if (response.status !== 200 || !response.data?.id) return;
      claim = response.data;
    } catch { return; }
    const reason = claim.reason || '查看敏感信息需要系统解锁';
    const verdict = await unlock(reason);
    const ok = !!verdict.ok;
    const method = ok ? (verdict.method || 'system') : '';
    const error = ok ? '' : (verdict.error || '系统解锁失败或已取消');
    const fields = [claim.id, claim.username, claim.purpose, ok ? '1' : '0', method, error];
    try {
      await requestJson(`${root}/api/one/security/unlock-queue/${encodeURIComponent(claim.id)}`, {
        method: 'POST',
        headers: signHeaders(identity, 'unlock.resolve', fields),
        body: {
          username: claim.username,
          purpose: claim.purpose,
          ok,
          method,
          error,
        },
      });
    } catch (err) {
      console.error('zephyr-one: unlock result not delivered:', err.message);
    }
  };
  setInterval(() => { tick().catch(() => {}); }, POLL_MS).unref?.();
}

export function spawnPickerWatcher({ identity, dialog, getWindow }) {
  const tick = async () => {
    const base = currentBaseUrl();
    if (!base) return;
    const root = base.replace(/\/+$/, '');
    let claim;
    try {
      const response = await requestJson(`${root}/api/one/rdp/picker-queue`, {
        headers: signHeaders(identity, 'rdp_picker.claim', []),
      });
      if (response.status !== 200 || !response.data?.id) return;
      claim = response.data;
    } catch { return; }
    const window = getWindow();
    const result = await dialog.showOpenDialog(window && !window.isDestroyed() ? window : undefined, {
      properties: ['openDirectory', 'createDirectory'],
    });
    const chosen = result.canceled || !result.filePaths?.[0] ? '' : result.filePaths[0];
    const ok = !!chosen;
    const fields = [claim.id, chosen, ''];
    try {
      await requestJson(`${root}/api/one/rdp/picker-queue/${encodeURIComponent(claim.id)}`, {
        method: 'POST',
        headers: signHeaders(identity, 'rdp_picker.resolve', fields),
        body: { path: chosen, error: '' },
      });
    } catch (err) {
      console.error('zephyr-one: folder picker result not delivered:', err.message);
    }
  };
  setInterval(() => { tick().catch(() => {}); }, POLL_MS).unref?.();
}
