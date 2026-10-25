/**
 * Zephyr i18n runtime — lightweight gettext-style catalog loader.
 * Keys are source Chinese strings (or stable ids); values are locale translations.
 * Supports {name} / {0} interpolation.
 * Shared across all ES module specifiers via globalThis.__zephyrI18nState.
 */
const SUPPORTED = Object.freeze(['zh-CN', 'en']);
const STORAGE_KEY = 'zephyr-locale';
const DEFAULT_LOCALE = 'zh-CN';

const sharedState = (typeof globalThis !== 'undefined' && globalThis.__zephyrI18nState) || {
    catalogs: Object.create(null),
    currentLocale: DEFAULT_LOCALE,
    listeners: new Set(),
    loadPromise: null,
    syncBound: false,
};
if (typeof globalThis !== 'undefined') {
    globalThis.__zephyrI18nState = sharedState;
}

function normalizeLocale(value) {
    const raw = String(value || '').trim();
    if (!raw || raw === 'auto') return detectBrowserLocale();
    const lower = raw.toLowerCase().replace('_', '-');
    if (lower === 'zh' || lower.startsWith('zh-')) return 'zh-CN';
    if (lower === 'en' || lower.startsWith('en-')) return 'en';
    return SUPPORTED.includes(raw) ? raw : DEFAULT_LOCALE;
}

function detectBrowserLocale() {
    try {
        const nav = (typeof navigator !== 'undefined' && (navigator.language || navigator.userLanguage)) || '';
        return normalizeLocale(nav || DEFAULT_LOCALE);
    } catch {
        return DEFAULT_LOCALE;
    }
}

function readStoredLocale() {
    try {
        if (typeof window !== 'undefined' && window.parent && window.parent !== window) {
            const parentLoc = window.parent.document?.documentElement?.dataset?.locale;
            if (parentLoc) return normalizeLocale(parentLoc);
        }
    } catch {}
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) return normalizeLocale(stored);
    } catch {}
    return null;
}

function writeStoredLocale(locale) {
    try {
        localStorage.setItem(STORAGE_KEY, locale);
    } catch {}
}

function interpolate(template, params) {
    if (template == null) return '';
    const text = String(template);
    if (!params) return text;
    if (Array.isArray(params)) {
        return text.replace(/\{(\d+)\}/g, (_, i) => {
            const v = params[Number(i)];
            return v == null ? '' : String(v);
        });
    }
    if (typeof params === 'object') {
        return text.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => {
            if (Object.prototype.hasOwnProperty.call(params, key)) {
                const v = params[key];
                return v == null ? '' : String(v);
            }
            return `{${key}}`;
        });
    }
    return text;
}

function lookup(key) {
    if (key == null || key === '') return '';
    const k = String(key);
    const cat = sharedState.catalogs[sharedState.currentLocale];
    if (cat && Object.prototype.hasOwnProperty.call(cat, k) && cat[k] != null) return cat[k];
    if (sharedState.currentLocale === 'zh-CN') return k;
    const zh = sharedState.catalogs['zh-CN'];
    if (zh && Object.prototype.hasOwnProperty.call(zh, k) && zh[k] != null) return zh[k];
    return k;
}

/** Translate a key. Optional params for interpolation. */
export function t(key, params) {
    return interpolate(lookup(key), params);
}

/** Alias used in some call sites. */
export const i18n = t;

export function getLocale() {
    return sharedState.currentLocale;
}

export function getSupportedLocales() {
    return SUPPORTED.slice();
}

export function onLocaleChange(fn) {
    if (typeof fn === 'function') sharedState.listeners.add(fn);
    return () => sharedState.listeners.delete(fn);
}

export function registerCatalog(locale, dict) {
    const loc = normalizeLocale(locale);
    sharedState.catalogs[loc] = { ...(sharedState.catalogs[loc] || {}), ...(dict || {}) };
}

async function fetchCatalog(locale) {
    const loc = normalizeLocale(locale);
    if (sharedState.catalogs[loc] && Object.keys(sharedState.catalogs[loc]).length) return sharedState.catalogs[loc];
    try {
        if (typeof window !== 'undefined' && window.parent && window.parent !== window) {
            const parentCat = window.parent.__zephyrI18nState?.catalogs?.[loc];
            if (parentCat && Object.keys(parentCat).length) {
                registerCatalog(loc, parentCat);
                return sharedState.catalogs[loc];
            }
        }
    } catch {}
    const url = new URL(`./locales/${loc}.json`, import.meta.url);
    url.searchParams.set('v', '20261019-ui124');
    const res = await fetch(url.href, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`i18n catalog ${loc} HTTP ${res.status}`);
    const dict = await res.json();
    registerCatalog(loc, dict);
    return sharedState.catalogs[loc];
}

export async function ensureCatalogs(locales = SUPPORTED) {
    if (sharedState.loadPromise) return sharedState.loadPromise;
    const requested = [...new Set(locales.map(normalizeLocale))];
    const pending = Promise.all(
        requested.map((loc) => fetchCatalog(loc).catch((err) => {
            console.warn('[i18n] failed to load', loc, err);
            return null;
        })),
    ).then(() => undefined);
    sharedState.loadPromise = pending;
    try {
        await pending;
    } finally {
        if (sharedState.loadPromise === pending) sharedState.loadPromise = null;
    }
}

function setDocumentLang(locale) {
    try {
        document.documentElement.lang = locale === 'zh-CN' ? 'zh-CN' : 'en';
        document.documentElement.dataset.locale = locale;
    } catch {}
}

export function applyDomI18n(root = document) {
    const scope = root && root.querySelectorAll ? root : document;
    const nodes = scope.querySelectorAll
        ? scope.querySelectorAll('[data-i18n], [data-i18n-html], [data-i18n-placeholder], [data-i18n-title], [data-i18n-aria-label], [data-i18n-value], [data-i18n-label]')
        : [];
    nodes.forEach((el) => {
        const key = el.getAttribute('data-i18n');
        if (key != null && key !== '') {
            el.textContent = t(key);
        }
        const htmlKey = el.getAttribute('data-i18n-html');
        if (htmlKey != null && htmlKey !== '') {
            el.innerHTML = t(htmlKey);
        }
        const ph = el.getAttribute('data-i18n-placeholder');
        if (ph != null && ph !== '') el.setAttribute('placeholder', t(ph));
        const title = el.getAttribute('data-i18n-title');
        if (title != null && title !== '') el.setAttribute('title', t(title));
        const aria = el.getAttribute('data-i18n-aria-label');
        if (aria != null && aria !== '') el.setAttribute('aria-label', t(aria));
        const val = el.getAttribute('data-i18n-value');
        if (val != null && val !== '') el.setAttribute('value', t(val));
        const label = el.getAttribute('data-i18n-label');
        if (label != null && label !== '') el.textContent = t(label);
    });
}

function broadcastLocaleToChildFrames(locale) {
    if (typeof document === 'undefined') return;
    try {
        document.querySelectorAll('iframe').forEach((frame) => {
            try {
                frame.contentWindow?.postMessage({
                    source: 'zephyr-app',
                    type: 'locale-change',
                    locale,
                }, '*');
            } catch {}
        });
    } catch {}
}

export async function setLocale(next, { persist = true, applyDom = true, broadcast = true } = {}) {
    const locale = normalizeLocale(next);
    await ensureCatalogs([locale, 'zh-CN']);
    const changed = locale !== sharedState.currentLocale;
    sharedState.currentLocale = locale;
    if (persist) writeStoredLocale(locale);
    setDocumentLang(locale);
    if (applyDom) applyDomI18n(document);
    if (broadcast) broadcastLocaleToChildFrames(locale);
    if (changed) {
        sharedState.listeners.forEach((fn) => {
            try { fn(locale); } catch (err) { console.warn('[i18n] listener error', err); }
        });
    }
    return locale;
}

export async function initI18n({ locale, applyDom = true } = {}) {
    const resolved = locale
        ? normalizeLocale(locale)
        : (readStoredLocale() || detectBrowserLocale() || DEFAULT_LOCALE);
    sharedState.currentLocale = resolved;
    await ensureCatalogs(SUPPORTED);
    if (applyDom) {
        setDocumentLang(sharedState.currentLocale);
        applyDomI18n(document);
    }
    return sharedState.currentLocale;
}

export function localeCompareValue(a, b) {
    const loc = sharedState.currentLocale === 'zh-CN' ? 'zh-CN' : 'en';
    return String(a).localeCompare(String(b), loc);
}

export function formatNumber(n, options) {
    try {
        return new Intl.NumberFormat(sharedState.currentLocale === 'zh-CN' ? 'zh-CN' : 'en', options).format(n);
    } catch {
        return String(n);
    }
}

export function formatDateTime(ts, options) {
    if (!ts) return t('从未连接');
    try {
        return new Date(ts).toLocaleString(sharedState.currentLocale === 'zh-CN' ? 'zh-CN' : 'en', options);
    } catch {
        return String(ts);
    }
}

if (!sharedState.catalogs['zh-CN']) registerCatalog('zh-CN', {});
if (!sharedState.catalogs['en']) registerCatalog('en', {});

if (typeof window !== 'undefined' && !sharedState.syncBound) {
    sharedState.syncBound = true;
    window.__zephyrI18n = { t, setLocale, getLocale, applyDomI18n, onLocaleChange, initI18n };
    window.addEventListener('message', (ev) => {
        const d = ev?.data;
        if (d && d.source === 'zephyr-app' && d.type === 'locale-change' && d.locale) {
            setLocale(d.locale, { persist: false, applyDom: true, broadcast: false }).catch(() => {});
        }
    });
    window.addEventListener('storage', (ev) => {
        if (ev && ev.key === STORAGE_KEY && ev.newValue) {
            setLocale(ev.newValue, { persist: false, applyDom: true, broadcast: false }).catch(() => {});
        }
    });
}
