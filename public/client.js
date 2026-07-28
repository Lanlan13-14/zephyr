import { applyZephyrColorScheme, zephyrBrandIconHtml, zephyrFaviconHref } from './theme-runtime.js?v=20260615-visual-color-picker';
import { t, initI18n, setLocale, getLocale, applyDomI18n } from './i18n/runtime.js?v=20260728-ai-models-scroll1';

const $ = (sel) => document.querySelector(sel);
const errorBanner = $('#errorBanner');
const loginForm = $('#loginForm');
const themeToggleLogin = $('#themeToggleLogin');
const themeToggleChange = $('#themeToggleChange');
const themeToggleTotp = $('#themeToggleTotp');
const themeToggleForgot = $('#themeToggleForgot');
const loginCard = $('#loginCard');
const changePasswordCard = $('#changePasswordCard');
const totpCard = $('#totpCard');
const forgotCard = $('#forgotCard');
const changePasswordForm = $('#changePasswordForm');
const totpForm = $('#totpForm');
const forgotRequestForm = $('#forgotRequestForm');
const forgotResetForm = $('#forgotResetForm');
const changeErrorBanner = $('#changeErrorBanner');
const totpErrorBanner = $('#totpErrorBanner');
const forgotErrorBanner = $('#forgotErrorBanner');
const beianFooter = $('#beianFooter');
const REMEMBER_USERNAME_KEY = 'zephyr-remember-username';
const DEFAULT_BRAND_NAME = 'Zephyr';
const DEFAULT_BRAND_ICON = '🌬️';
let tempTotpToken = '';
let defaultUsername = 'admin';
let publicSettings = {};
let captchaConfig = { enabled: false, provider: 'turnstile', siteKey: '' };
let captchaState = { widgetId: null, token: '', loadedProvider: '', loadingPromise: null };
const CAPTCHA_SCRIPT_URLS = {
    turnstile: 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
    hcaptcha: 'https://js.hcaptcha.com/1/api.js?render=explicit',
    google: 'https://www.google.com/recaptcha/api.js?render=explicit',
    tencent: 'https://ssl.captcha.qq.com/TCaptcha.js',
    aliyun: 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js'
};

function ensureCaptchaBox() {
    let box = $('#captchaBox');
    if (!box) {
        box = document.createElement('div');
        box.id = 'captchaBox';
        box.className = 'captcha-box force-hidden';
        box.setAttribute('aria-live', 'polite');
        loginForm.querySelector('.auth-options')?.insertAdjacentElement('afterend', box);
    }
    return box;
}

function loadScriptOnce(id, src) {
    const existing = document.getElementById(id);
    if (existing?.dataset.loaded === 'true') return Promise.resolve();
    if (existing?.dataset.loading === 'true') return new Promise((resolve, reject) => {
        existing.addEventListener('load', resolve, { once: true });
        existing.addEventListener('error', () => reject(new Error(t('CAPTCHA 脚本加载失败'))), { once: true });
    });
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.id = id;
        script.src = src;
        script.async = true;
        script.defer = true;
        script.dataset.loading = 'true';
        script.onload = () => { script.dataset.loaded = 'true'; script.dataset.loading = 'false'; resolve(); };
        script.onerror = () => reject(new Error(t('CAPTCHA 脚本加载失败')));
        document.head.appendChild(script);
    });
}

function markCaptchaError(message) {
    const box = ensureCaptchaBox();
    box.className = 'captcha-box error';
    box.textContent = message;
    console.warn('[captcha-client]', message, captchaConfig);
}

function setCaptchaToken(token) {
    captchaState.token = String(token || '');
    console.debug('[captcha-client]', 'token updated', { provider: captchaConfig.provider, hasToken: !!captchaState.token });
}

async function renderCaptcha(config = captchaConfig) {
    captchaConfig = { enabled: !!config.enabled, provider: config.provider || 'turnstile', siteKey: config.siteKey || config.tencentCaptchaAppId || config.aliyunCaptchaId || '' };
    const box = ensureCaptchaBox();
    captchaState.token = '';
    captchaState.widgetId = null;
    captchaState.loadedProvider = captchaConfig.provider;
    box.innerHTML = '';
    if (!captchaConfig.enabled) {
        box.className = 'captcha-box force-hidden';
        console.debug('[captcha-client]', 'captcha disabled');
        return;
    }
    if (!captchaConfig.siteKey) {
        markCaptchaError(t('CAPTCHA 已启用但未配置 Site Key / AppId'));
        return;
    }
    box.className = 'captcha-box loading';
    console.debug('[captcha-client]', 'render captcha', { provider: captchaConfig.provider, hasSiteKey: !!captchaConfig.siteKey });
    try {
        await loadScriptOnce(`captcha-script-${captchaConfig.provider}`, CAPTCHA_SCRIPT_URLS[captchaConfig.provider]);
        box.className = 'captcha-box';
        if (captchaConfig.provider === 'turnstile') {
            captchaState.widgetId = window.turnstile.render(box, { sitekey: captchaConfig.siteKey, callback: setCaptchaToken, 'expired-callback': () => setCaptchaToken(''), 'error-callback': () => setCaptchaToken('') });
        } else if (captchaConfig.provider === 'hcaptcha') {
            captchaState.widgetId = window.hcaptcha.render(box, { sitekey: captchaConfig.siteKey, callback: setCaptchaToken, 'expired-callback': () => setCaptchaToken(''), 'error-callback': () => setCaptchaToken('') });
        } else if (captchaConfig.provider === 'google') {
            captchaState.widgetId = window.grecaptcha.render(box, { sitekey: captchaConfig.siteKey, callback: setCaptchaToken, 'expired-callback': () => setCaptchaToken(''), 'error-callback': () => setCaptchaToken('') });
        } else if (captchaConfig.provider === 'tencent') {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'btn';
            button.textContent = t('点击完成人机验证');
            button.addEventListener('click', () => {
                const captcha = new window.TencentCaptcha(captchaConfig.siteKey, (res) => {
                    if (res.ret === 0) setCaptchaToken(JSON.stringify({ ticket: res.ticket, randstr: res.randstr }));
                    else setCaptchaToken('');
                });
                captcha.show();
            });
            box.appendChild(button);
        } else if (captchaConfig.provider === 'aliyun') {
            const target = document.createElement('div');
            const trigger = document.createElement('button');
            target.id = 'aliyunCaptchaMount';
            target.style.width = '100%';
            trigger.id = 'aliyunCaptchaBtn';
            trigger.type = 'button';
            trigger.className = 'btn';
            trigger.textContent = t('点击完成人机验证');
            box.append(target, trigger);
            window.initAliyunCaptcha({
                SceneId: captchaConfig.siteKey,
                prefix: captchaConfig.siteKey,
                mode: 'popup',
                element: '#aliyunCaptchaMount',
                button: '#aliyunCaptchaBtn',
                captchaVerifyCallback: (captchaVerifyParam) => {
                    setCaptchaToken(typeof captchaVerifyParam === 'string' ? captchaVerifyParam : JSON.stringify(captchaVerifyParam || {}));
                    return { captchaResult: true };
                },
                onBizResultCallback: () => {},
                getInstance: (instance) => { captchaState.widgetId = instance; }
            });
        } else {
            markCaptchaError(t('不支持的 CAPTCHA provider：{provider}', { provider: captchaConfig.provider }));
        }
    } catch (err) {
        markCaptchaError(err.message || t('CAPTCHA 初始化失败'));
    }
}

function resetCaptcha() {
    const provider = captchaConfig.provider;
    captchaState.token = '';
    try {
        if (provider === 'turnstile' && window.turnstile && captchaState.widgetId !== null) window.turnstile.reset(captchaState.widgetId);
        else if (provider === 'hcaptcha' && window.hcaptcha && captchaState.widgetId !== null) window.hcaptcha.reset(captchaState.widgetId);
        else if (provider === 'google' && window.grecaptcha && captchaState.widgetId !== null) window.grecaptcha.reset(captchaState.widgetId);
        else if (provider === 'aliyun' && captchaState.widgetId?.refresh) captchaState.widgetId.refresh();
    } catch (err) {
        console.warn('[captcha-client]', 'reset failed', { provider, error: err.message });
    }
}

function getCaptchaTokenOrThrow() {
    if (!captchaConfig.enabled) return '';
    if (!captchaState.token) throw new Error(t('请先完成人机验证'));
    return captchaState.token;
}

function isAutoThemeEnabled() { return publicSettings.appearance?.autoThemeEnabled !== false; }
function getSystemTheme() { return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; }
function getPreferredTheme() {
    const appearance = publicSettings.appearance || {};
    if (isAutoThemeEnabled() || appearance.theme === 'auto') return getSystemTheme();
    if (appearance.theme === 'light' || appearance.theme === 'dark') return appearance.theme;
    const saved = localStorage.getItem('zephyr-theme');
    return saved === 'light' || saved === 'dark' ? saved : getSystemTheme();
}

function iconHtml(icon = DEFAULT_BRAND_ICON) { return zephyrBrandIconHtml(icon); }
function faviconHref(icon = DEFAULT_BRAND_ICON) { return zephyrFaviconHref(icon); }
function setFavicon(icon = DEFAULT_BRAND_ICON) {
    let link = document.querySelector('link[rel="icon"]');
    if (!link) {
        link = document.createElement('link');
        link.rel = 'icon';
        document.head.appendChild(link);
    }
    link.href = faviconHref(icon);
}
function applyBrand(appearance = {}) {
    const brandName = String(appearance.brandName || DEFAULT_BRAND_NAME).trim() || DEFAULT_BRAND_NAME;
    const brandIcon = String(appearance.brandIcon || DEFAULT_BRAND_ICON).trim() || DEFAULT_BRAND_ICON;
    document.title = t('{brand} - 登录', { brand: brandName });
    applyZephyrColorScheme(appearance || {}, { theme: getPreferredTheme(), page: 'login', executeCustomJs: false });
    setFavicon(brandIcon);
    document.querySelectorAll('.login-card .logo').forEach((el) => { el.innerHTML = iconHtml(brandIcon); });
    const loginTitle = loginCard?.querySelector('h1');
    if (loginTitle) loginTitle.textContent = brandName;
    console.debug('[appearance-client]', 'public brand applied', { brandName, customIcon: brandIcon !== DEFAULT_BRAND_ICON });
}

function applyTheme(theme, { persist = false } = {}) {
    document.documentElement.setAttribute('data-theme', theme);
    applyZephyrColorScheme(publicSettings.appearance || {}, { theme, page: 'login' });
    setFavicon((publicSettings.appearance || {}).brandIcon || DEFAULT_BRAND_ICON);
    if (persist) localStorage.setItem('zephyr-theme', theme);
    [themeToggleLogin, themeToggleChange, themeToggleTotp, themeToggleForgot].filter(Boolean).forEach((btn) => { btn.textContent = theme === 'dark' ? '☀️' : '🌙'; });
}

applyTheme(getPreferredTheme());

function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme');
    applyTheme(current === 'dark' ? 'light' : 'dark', { persist: true });
}
themeToggleLogin?.addEventListener('click', toggleTheme);
themeToggleChange?.addEventListener('click', toggleTheme);
themeToggleTotp?.addEventListener('click', toggleTheme);
themeToggleForgot?.addEventListener('click', toggleTheme);

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (isAutoThemeEnabled()) {
        console.debug('[appearance-client]', 'public system theme changed', { theme: e.matches ? 'dark' : 'light' });
        applyTheme(e.matches ? 'dark' : 'light');
    }
});

function api(path, options = {}) {
    return fetch(path, {
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
        credentials: 'same-origin',
        ...options,
    }).then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || t('请求失败'));
        return data;
    });
}

function showError(target, msg) {
    target.textContent = msg;
    target.classList.add('show');
    setTimeout(() => {
        target.classList.remove('show');
        target.textContent = '';
    }, 6000);
}

function showChangePassword() {
    loginCard.classList.add('force-hidden');
    totpCard.classList.add('force-hidden');
    forgotCard.classList.add('force-hidden');
    changePasswordCard.classList.remove('force-hidden');
    $('#newPassword').focus();
}
function mountCaptchaFor(form) {
    const box = ensureCaptchaBox();
    const anchor = form?.querySelector('.auth-options') || form?.querySelector('.form-group:last-of-type');
    if (anchor && box.parentElement !== form) anchor.insertAdjacentElement('afterend', box);
    if (captchaConfig.enabled) resetCaptcha();
}
function showLogin() { [changePasswordCard, totpCard, forgotCard].forEach((el) => el.classList.add('force-hidden')); loginCard.classList.remove('force-hidden'); mountCaptchaFor(loginForm); }
function showTotp(token) { tempTotpToken = token; loginCard.classList.add('force-hidden'); totpCard.classList.remove('force-hidden'); $('#totpCode').focus(); }
function showForgot() { loginCard.classList.add('force-hidden'); forgotCard.classList.remove('force-hidden'); mountCaptchaFor(forgotRequestForm); }

function base64urlToBuffer(value) { const s = String(value).replace(/-/g, '+').replace(/_/g, '/'); return Uint8Array.from(atob(s + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0)); }
function bufferToBase64url(buffer) { return btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }

async function loadBeian() {
    try {
        const s = await api('/api/public/settings');
        publicSettings = s || {};
        publicSettings.appearance = { brandName: DEFAULT_BRAND_NAME, brandIcon: DEFAULT_BRAND_ICON, theme: 'auto', autoThemeEnabled: true, colorScheme: 'frost', customThemeMode: 'dark', ...(publicSettings.appearance || {}) };
        applyBrand(publicSettings.appearance);
        applyTheme(getPreferredTheme());
        captchaConfig = publicSettings.captcha || { enabled: false, provider: 'turnstile', siteKey: '' };
        defaultUsername = s.defaultUsername || 'admin';
        const usernameInput = $('#username');
        if (usernameInput) usernameInput.placeholder = ' ';
        const passwordInput = $('#password');
        if (passwordInput) passwordInput.placeholder = ' ';
        const hint = $('.auth-hint');
        if (hint) hint.textContent = '';
        initRememberMe();
        await renderCaptcha(captchaConfig);
        if (!s.showBeian || (!s.icp && !s.policeBeian)) { beianFooter.innerHTML = ''; return; }
        const parts = [];
        const icpUrl = s.icpUrl || 'https://beian.miit.gov.cn';
        console.debug('[beian-client]', 'render beian footer', { hasIcp: !!s.icp, icpUrl, hasPolice: !!s.policeBeian, policeUrl: s.policeBeianUrl || '' });
        if (s.icp) parts.push(`<a href="${icpUrl}" target="_blank" rel="noreferrer">${s.icp}</a>`);
        if (s.policeBeian) parts.push(`<a href="${s.policeBeianUrl || 'https://www.beian.gov.cn/portal/registerSystemInfo'}" target="_blank" rel="noreferrer">🛡️ ${s.policeBeian}</a>`);
        beianFooter.innerHTML = parts.join('');
    } catch { beianFooter.innerHTML = ''; }
}

/* Login page locale selects → same toggle-select + zephyr-motion open/close
 * as the app (motion-feel §3: menu FLIPs down from the trigger, mac open /
 * macClose retract). Re-clicking the trigger while open closes the menu,
 * exactly like the in-app selects. Engine falls back to instant class path. */
const loginSelectMotion = {
    engine: null,
    failed: false,
    _ensure() {
        if (this.engine || this.failed) return Promise.resolve(this.engine);
        return import('./vendor/zephyr-motion/index.js?v=20260728-ai-models-scroll1')
            .then(async (mod) => {
                const Motion = mod?.Motion || window.Motion;
                if (!Motion) throw new Error('Motion missing from zephyr-motion module');
                try { await Motion.init({ capacity: 256 }); } catch {}
                this.engine = Motion;
                return Motion;
            })
            .catch((err) => {
                console.debug('[login-select]', 'motion engine unavailable, instant fallback:', err?.message || err);
                this.failed = true;
                return null;
            });
    },
};

function escLoginHtml(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function syncLoginToggleFace(select) {
    const shell = select?.closest?.('.ui-toggle-select');
    if (!shell) return;
    const trigger = shell.querySelector('.ui-toggle-select-trigger');
    const menu = shell.querySelector('.ui-toggle-select-menu');
    if (!trigger || !menu) return;
    const opts = Array.from(select.options || []);
    const current = opts.find((o) => o.value === select.value) || opts[0];
    trigger.textContent = current ? (current.textContent || current.value || '') : '';
    menu.innerHTML = opts.map((o) => {
        const selected = o.value === select.value;
        return `<button type="button" class="ui-toggle-select-option${selected ? ' is-selected' : ''}" role="option" data-value="${escLoginHtml(o.value)}" aria-selected="${selected ? 'true' : 'false'}">${escLoginHtml(o.textContent || o.value || '')}</button>`;
    }).join('');
}

async function openLoginToggleMenu(shell) {
    const trigger = shell.querySelector('.ui-toggle-select-trigger');
    const menu = shell.querySelector('.ui-toggle-select-menu');
    if (!trigger || !menu) return;
    shell.classList.remove('menu-closing');
    shell.classList.add('open');
    trigger.setAttribute('aria-expanded', 'true');
    const Motion = await loginSelectMotion._ensure();
    if (!Motion) { try { menu.scrollTop = 0; } catch (_) {} return; }
    const token = (shell._menuToken = (shell._menuToken || 0) + 1);
    const midFlight = Motion.isAnimating(menu);
    if (!midFlight) {
        menu.style.visibility = 'hidden';
        void menu.offsetWidth;
    }
    const from = trigger.getBoundingClientRect();
    menu.style.visibility = 'visible';
    try { menu.scrollTop = 0; } catch (_) {}
    const radiusFrom = parseFloat(getComputedStyle(trigger)?.borderRadius) || 18;
    try {
        await Motion.morph(menu, from, {
            preset: 'mac',
            radiusFrom,
            radiusTo: 14,
            radiusCompensate: true,
            opacityFrom: 0.92,
            opacityTo: 1,
            forceFrom: !midFlight,
        });
    } catch (err) {
        console.debug('[login-select]', 'open morph failed', err?.message || err);
    }
    if (token !== shell._menuToken) return;
}

function closeLoginToggleMenu(shell) {
    const trigger = shell.querySelector('.ui-toggle-select-trigger');
    const menu = shell.querySelector('.ui-toggle-select-menu');
    if (!trigger || !menu) return;
    const wasOpen = shell.classList.contains('open');
    shell.classList.remove('open');
    trigger.setAttribute('aria-expanded', 'false');
    if (!wasOpen) return;
    const Motion = loginSelectMotion.engine; // close 不懒加载引擎
    if (!Motion || loginSelectMotion.failed) return;
    const token = (shell._menuToken = (shell._menuToken || 0) + 1);
    shell.classList.add('menu-closing');
    Motion.setOriginFromAnchor?.(menu, trigger);
    Promise.resolve()
        .then(() => Motion.to(menu, { opacity: 0, scale: 0.94, y: -8, x: 0, blur: 0 }, { preset: 'macClose' }))
        .catch(() => {})
        .then(() => {
            if (token !== shell._menuToken) return;
            shell.classList.remove('menu-closing');
            Motion.stop(menu);
            Motion.set(menu, { x: 0, y: 0, scaleX: 1, scaleY: 1, scale: 1, opacity: 1, blur: 0, radius: 0 });
            menu.style.transform = '';
            menu.style.opacity = '';
        });
}

function closeAllLoginToggleSelects(exceptShell = null) {
    document.querySelectorAll('.login-locale-select.ui-toggle-select.open').forEach((shell) => {
        if (exceptShell && shell === exceptShell) return;
        closeLoginToggleMenu(shell);
    });
}

function enhanceLoginToggleSelect(select) {
    if (!select || select.tagName !== 'SELECT' || select.dataset.toggleSelect === '1') return null;
    const shell = document.createElement('div');
    shell.className = 'ui-toggle-select login-locale-select';
    shell.dataset.selectId = select.id || '';
    select.parentNode.insertBefore(shell, select);
    shell.appendChild(select);
    select.classList.add('ui-toggle-select-native');
    select.dataset.toggleSelect = '1';
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'ui-toggle-select-trigger';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    if (select.id) trigger.id = `${select.id}ToggleTrigger`;
    if (select.getAttribute('aria-label')) trigger.setAttribute('aria-label', select.getAttribute('aria-label'));

    const menu = document.createElement('div');
    menu.className = 'ui-toggle-select-menu';
    menu.setAttribute('role', 'listbox');

    shell.appendChild(trigger);
    shell.appendChild(menu);
    syncLoginToggleFace(select);

    trigger.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const willOpen = !shell.classList.contains('open');
        closeAllLoginToggleSelects(willOpen ? shell : null);
        if (willOpen) openLoginToggleMenu(shell);
        else closeLoginToggleMenu(shell);
    });
    menu.addEventListener('click', (e) => {
        const opt = e.target.closest?.('.ui-toggle-select-option');
        if (!opt) return;
        e.preventDefault();
        e.stopPropagation();
        const value = opt.getAttribute('data-value') ?? '';
        if (select.value !== value) {
            select.value = value;
            select.dispatchEvent(new Event('change', { bubbles: true }));
            select.dispatchEvent(new Event('input', { bubbles: true }));
        }
        syncLoginToggleFace(select);
        closeLoginToggleMenu(shell);
    });
    select.addEventListener('change', () => syncLoginToggleFace(select));
    return shell;
}

let _loginToggleDocBound = false;
function enhanceLoginLocaleSelects() {
    ['#localeSelectLogin', '#localeSelectTotp', '#localeSelectForgot', '#localeSelectChange'].forEach((sel) => {
        const el = $(sel);
        if (el) enhanceLoginToggleSelect(el);
    });
    if (_loginToggleDocBound) return;
    _loginToggleDocBound = true;
    document.addEventListener('click', (e) => {
        if (!e.target.closest?.('.login-locale-select.ui-toggle-select')) closeAllLoginToggleSelects();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAllLoginToggleSelects(); });
}

function syncLocaleSelects(locale = getLocale()) {
    ['#localeSelectLogin', '#localeSelectTotp', '#localeSelectForgot', '#localeSelectChange'].forEach((sel) => {
        const el = $(sel);
        if (el) {
            el.value = locale === 'en' ? 'en' : 'zh-CN';
            syncLoginToggleFace(el);
        }
    });
}

async function changeLocale(next) {
    await setLocale(next, { persist: true, applyDom: true });
    syncLocaleSelects(getLocale());
    applyBrand(publicSettings.appearance || {});
    applyDomI18n(document);
}

['#localeSelectLogin', '#localeSelectTotp', '#localeSelectForgot', '#localeSelectChange'].forEach((sel) => {
    $(sel)?.addEventListener('change', (e) => {
        changeLocale(e.target.value).catch((err) => console.warn('[i18n]', err));
    });
});

async function bootLoginPage() {
    await initI18n({ applyDom: true });
    enhanceLoginLocaleSelects();
    syncLocaleSelects(getLocale());
    /* Warm the motion engine at idle: lazy import would otherwise pop the
     * menu statically on first open, then restart with the FLIP once the
     * engine arrives — first open must animate identically to later ones. */
    const warmLoginMotion = () => loginSelectMotion._ensure();
    if ('requestIdleCallback' in window) window.requestIdleCallback(warmLoginMotion, { timeout: 2500 });
    else window.setTimeout(warmLoginMotion, 800);
    api('/api/auth/me').then((data) => {
        if (data.mustChangePassword) showChangePassword();
        else window.location.href = '/app.html';
    }).catch(() => {});
    loadBeian();
}

bootLoginPage().catch((err) => {
    console.warn('[i18n] init failed, continuing with source strings', err);
    api('/api/auth/me').then((data) => {
        if (data.mustChangePassword) showChangePassword();
        else window.location.href = '/app.html';
    }).catch(() => {});
    loadBeian();
});

function initRememberMe() {
    const remembered = localStorage.getItem(REMEMBER_USERNAME_KEY) || '';
    const usernameInput = $('#username');
    if (!usernameInput) return;
    usernameInput.value = remembered || '';
    $('#rememberMe').checked = !!remembered;
    console.debug('[login-client]', 'remember username initialized', { hasRemembered: !!remembered, defaultUsernameHintOnly: true });
    (remembered ? $('#password') : usernameInput)?.focus();
}

loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('#username').value.trim();
    const password = $('#password').value;
    if ($('#rememberMe')?.checked) localStorage.setItem(REMEMBER_USERNAME_KEY, username);
    else localStorage.removeItem(REMEMBER_USERNAME_KEY);
    try {
        const captchaToken = getCaptchaTokenOrThrow();
        const data = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password, remember: !!$('#rememberMe')?.checked, captchaToken }) });
        if (data.requireTotp) return showTotp(data.tempToken);
        if (data.mustChangePassword) showChangePassword();
        else window.location.href = '/app.html';
    } catch (err) {
        resetCaptcha();
        showError(errorBanner, err.message);
    }
});

totpForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { const data = await api('/api/auth/totp/verify', { method: 'POST', body: JSON.stringify({ tempToken: tempTotpToken, code: $('#totpCode').value }) }); if (data.mustChangePassword) showChangePassword(); else location.href = '/app.html'; }
    catch (err) { showError(totpErrorBanner, err.message); }
});

$('#forgotLink').addEventListener('click', (e) => { e.preventDefault(); showForgot(); });
$('#backLoginLink').addEventListener('click', (e) => { e.preventDefault(); showLogin(); });
forgotRequestForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { const captchaToken = getCaptchaTokenOrThrow(); await api('/api/auth/forgot-password/request', { method: 'POST', body: JSON.stringify({ email: $('#forgotEmail').value, captchaToken }) }); forgotRequestForm.classList.add('force-hidden'); forgotResetForm.classList.remove('force-hidden'); showError(forgotErrorBanner, t('如果邮箱匹配，验证码已发送')); }
    catch (err) { resetCaptcha(); showError(forgotErrorBanner, err.message); }
});
forgotResetForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('/api/auth/forgot-password/reset', { method: 'POST', body: JSON.stringify({ email: $('#forgotEmail').value, code: $('#resetCode').value, newPassword: $('#resetPassword').value }) }); showLogin(); showError(errorBanner, t('密码已重置，请重新登录')); }
    catch (err) { showError(forgotErrorBanner, err.message); }
});

$('#passkeyLoginBtn').addEventListener('click', async () => {
    try {
        if (!window.PublicKeyCredential) throw new Error(t('当前浏览器不支持 Passkey'));
        const username = ($('#username')?.value || '').trim();
        const options = await api('/api/passkeys/login/options', {
            method: 'POST',
            body: JSON.stringify(username ? { username } : {}),
        });
        options.challenge = base64urlToBuffer(options.challenge);
        (options.allowCredentials || []).forEach((c) => { c.id = base64urlToBuffer(c.id); });
        const cred = await navigator.credentials.get({ publicKey: options });
        const payload = { id: cred.id, rawId: bufferToBase64url(cred.rawId), type: cred.type, response: { authenticatorData: bufferToBase64url(cred.response.authenticatorData), clientDataJSON: bufferToBase64url(cred.response.clientDataJSON), signature: bufferToBase64url(cred.response.signature), userHandle: cred.response.userHandle ? bufferToBase64url(cred.response.userHandle) : null } };
        const data = await api('/api/passkeys/login/verify', { method: 'POST', body: JSON.stringify(payload) });
        if (data.mustChangePassword) showChangePassword(); else location.href = '/app.html';
    } catch (err) { showError(errorBanner, err.message); }
});

changePasswordForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const currentPassword = $('#currentPassword').value;
    const newPassword = $('#newPassword').value;
    const confirmPassword = $('#confirmPassword').value;
    if (newPassword !== confirmPassword) return showError(changeErrorBanner, t('两次输入的新密码不一致'));
    try {
        const result = await api('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) });
        /* Accounts without a mailbox get the one-time rollback link here —
         * the only notification channel they have. Everyone else already
         * received it by email and goes straight in. */
        if (result?.rollbackUrl) {
            changePasswordForm.classList.add('force-hidden');
            const notice = $('#changeRollbackNotice');
            notice.classList.remove('force-hidden');
            $('#changeRollbackUrl').value = result.rollbackUrl;
            $('#changeRollbackCopyBtn').onclick = async () => {
                try { await navigator.clipboard.writeText(result.rollbackUrl); $('#changeRollbackCopyBtn').textContent = t('链接已复制'); }
                catch { $('#changeRollbackUrl').select(); }
            };
            $('#changeRollbackContinueBtn').onclick = () => { window.location.href = '/app.html'; };
        } else {
            window.location.href = '/app.html';
        }
    } catch (err) {
        showError(changeErrorBanner, err.message);
    }
});