import { applyZephyrColorScheme, zephyrBrandIconHtml, zephyrFaviconHref } from './theme-runtime.js?v=20260615-visual-color-picker';
import { t, initI18n, setLocale, getLocale, applyDomI18n } from './i18n/runtime.js?v=20260726-i18n-fix7';

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

function syncLocaleSelects(locale = getLocale()) {
    ['#localeSelectLogin', '#localeSelectTotp', '#localeSelectForgot', '#localeSelectChange'].forEach((sel) => {
        const el = $(sel);
        if (el) el.value = locale === 'en' ? 'en' : 'zh-CN';
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
    syncLocaleSelects(getLocale());
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
        await api('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) });
        window.location.href = '/app.html';
    } catch (err) {
        showError(changeErrorBanner, err.message);
    }
});