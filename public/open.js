/**
 * /open deep-link hand-off.
 *
 * 1. Read sensitive payload from location.hash only (never query).
 * 2. Stash in sessionStorage under a nonce while the user logs in.
 * 3. POST /api/deeplinks/prepare → get a one-time token + display draft.
 * 4. Prefer handing off into the already-open app via BroadcastChannel /
 *    postMessage; otherwise bounce to /app.html#transient=<token>.
 *
 * Never writes passwords into localStorage, draft DOM values, or logs.
 */

import { t, initI18n, applyDomI18n } from './i18n/runtime.js?v=20260727-ai-settings-fix1';

const STORAGE_KEY = 'zephyr:deeplink:pending';
const channel = ('BroadcastChannel' in window) ? new BroadcastChannel('zephyr-deeplink') : null;

const el = {
    card: document.getElementById('openCard'),
    title: document.getElementById('openTitle'),
    sub: document.getElementById('openSub'),
    banner: document.getElementById('openBanner'),
    error: document.getElementById('openError'),
    status: document.getElementById('openStatus'),
    statusText: document.getElementById('openStatusText'),
    actions: document.getElementById('openActions'),
    retry: document.getElementById('openRetryBtn'),
    openApp: document.getElementById('openAppBtn'),
};

function setStatus(text, { spinning = true } = {}) {
    el.statusText.textContent = text;
    el.status.querySelector('.open-spinner')?.style.setProperty('display', spinning ? '' : 'none');
}

function showError(message) {
    el.error.textContent = message;
    el.error.classList.add('show');
    el.actions.hidden = false;
    setStatus(t('无法继续'), { spinning: false });
}

function clearError() {
    el.error.textContent = '';
    el.error.classList.remove('show');
}

function readUriFromHash() {
    const hash = String(location.hash || '').replace(/^#/, '');
    if (!hash) return '';
    const params = new URLSearchParams(hash);
    const uri = params.get('uri') || params.get('u') || '';
    // also accept raw fragment like #ssh://...
    if (!uri && /^(ssh|telnet|jms):\/\//i.test(hash)) return hash;
    try { return decodeURIComponent(uri); } catch { return uri; }
}

function stashPending(uri) {
    const payload = { uri, nonce: crypto.randomUUID(), at: Date.now() };
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload)); } catch {}
    return payload;
}

function takePending() {
    try {
        const raw = sessionStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        sessionStorage.removeItem(STORAGE_KEY);
        const parsed = JSON.parse(raw);
        if (!parsed?.uri || Date.now() - Number(parsed.at || 0) > 10 * 60 * 1000) return null;
        return parsed;
    } catch {
        return null;
    }
}

async function authMe() {
    const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
    if (res.status === 401) return null;
    if (!res.ok) throw new Error(t('无法验证登录状态'));
    return res.json();
}

async function prepare(uri) {
    const res = await fetch('/api/deeplinks/prepare', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ uri }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || t('准备临时连接失败'));
    return body;
}

function handOff(token, draft) {
    const payload = { type: 'zephyr-transient-connect', token, draft, at: Date.now() };
    try { channel?.postMessage(payload); } catch {}
    try {
        if (window.opener && !window.opener.closed) {
            window.opener.postMessage(payload, location.origin);
        }
    } catch {}
    // Always land in the app with a non-sensitive token reference.
    const target = `/app.html#transient=${encodeURIComponent(token)}`;
    el.title.textContent = draft?.name ? t('连接 {name}', { name: draft.name }) : t('临时连接已就绪');
    el.sub.textContent = draft?.hasTransientCredential
        ? t('已载入一次性凭据。打开应用后可检查参数，再测试或连接。')
        : t('打开应用后可检查参数，再测试或连接。');
    el.banner.hidden = false;
    setStatus(t('正在打开应用…'), { spinning: true });
    // Small delay so the status text is readable; under reduced-motion skip.
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    setTimeout(() => { location.replace(target); }, reduce ? 0 : 180);
}

async function run() {
    await initI18n({ applyDom: true });
    applyDomI18n(document);
    clearError();
    el.actions.hidden = true;
    // enter animation
    requestAnimationFrame(() => { el.card.dataset.state = ''; });

    let uri = readUriFromHash();
    if (!uri) {
        const pending = takePending();
        uri = pending?.uri || '';
    }
    if (!uri) {
        showError(t('链接中没有可识别的连接参数。'));
        el.title.textContent = t('无效的 Deep Link');
        el.sub.textContent = t('请从笔记、JumpServer 或系统协议处理器重新打开。');
        return;
    }

    setStatus(t('检查登录状态…'));
    let me;
    try {
        me = await authMe();
    } catch (err) {
        showError(err.message || t('网络错误'));
        return;
    }
    if (!me) {
        setStatus(t('需要登录，正在跳转…'));
        stashPending(uri);
        // returnTo is non-sensitive; the raw URI stays in sessionStorage.
        location.replace(`/?returnTo=${encodeURIComponent('/open')}`);
        return;
    }

    setStatus(t('准备一次性凭据…'));
    try {
        const prepared = await prepare(uri);
        // Wipe hash so the sensitive URI does not linger in history.
        history.replaceState(null, '', location.pathname + location.search);
        handOff(prepared.token, prepared.draft);
    } catch (err) {
        showError(err.message || t('准备失败'));
        el.retry.onclick = () => run();
        el.openApp.onclick = () => { location.href = '/app.html'; };
    }
}

run();
