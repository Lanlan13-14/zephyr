/**
 * Zephyr main HTTP API client for Zephyr One.
 * Cookie jar is manual: we store Set-Cookie zephyr_sid and send it back.
 */

function joinUrl(base, path) {
  const b = String(base || '').replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${b}${p}`;
}

export class ZephyrApi {
  constructor({ serverUrl, getSid, setSid } = {}) {
    this.serverUrl = serverUrl || '';
    this.getSid = getSid || (() => '');
    this.setSid = setSid || (() => {});
  }

  setServerUrl(url) {
    this.serverUrl = String(url || '').replace(/\/+$/, '');
  }

  async request(path, { method = 'GET', body, headers = {}, deviceToken } = {}) {
    if (!this.serverUrl) throw new Error('主端地址未配置');
    const url = joinUrl(this.serverUrl, path);
    const h = {
      Accept: 'application/json',
      ...headers,
    };
    let payload;
    if (body !== undefined) {
      h['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const sid = this.getSid();
    if (sid) {
      h.Cookie = `zephyr_sid=${encodeURIComponent(sid)}`;
      h['X-Zephyr-Sid'] = sid;
    }
    h['X-Zephyr-One-Client'] = '1';
    if (deviceToken) h.Authorization = `Bearer ${deviceToken}`;

    const res = await fetch(url, {
      method,
      headers: h,
      body: payload,
      credentials: 'omit', // we manage cookie/sid manually for cross-origin native client
    });

    // Capture Set-Cookie if exposed (often blocked in browser; Tauri http may allow)
    const setCookie = res.headers.get('set-cookie') || res.headers.get('Set-Cookie');
    if (setCookie) {
      const m = String(setCookie).match(/zephyr_sid=([^;]+)/);
      if (m) this.setSid(decodeURIComponent(m[1]));
    }

    let data = null;
    const text = await res.text();
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }

    // Some proxies return sid only in JSON (we also support explicit sid field)
    if (data?.sid) this.setSid(data.sid);
    if (data?.session?.sid) this.setSid(data.session.sid);

    if (!res.ok) {
      const msg = data?.error?.message || data?.error || data?.message || `HTTP ${res.status}`;
      const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
      err.status = res.status;
      err.code = data?.error?.code || data?.code || `http_${res.status}`;
      err.data = data;
      throw err;
    }
    return data;
  }

  login(username, password, { captchaToken, remember = true } = {}) {
    return this.request('/api/auth/login', {
      method: 'POST',
      body: { username, password, captchaToken, remember, returnSid: true },
    });
  }

  verifyTotp(tempToken, code) {
    return this.request('/api/auth/totp/verify', {
      method: 'POST',
      body: { tempToken, code, returnSid: true },
    });
  }

  me() {
    return this.request('/api/auth/me');
  }

  logout() {
    return this.request('/api/auth/logout', { method: 'POST', body: {} });
  }

  listTokens() {
    return this.request('/api/rdp/file-agent-tokens');
  }

  bindClient(body) {
    return this.request('/api/one/clients/bind', { method: 'POST', body });
  }

  pullSync(body, deviceToken) {
    return this.request('/api/one/sync/pull', {
      method: 'POST',
      body,
      deviceToken,
    });
  }

  syncStatus(clientId, deviceToken) {
    const q = clientId ? `?clientId=${encodeURIComponent(clientId)}` : '';
    return this.request(`/api/one/sync/status${q}`, { deviceToken });
  }
}
