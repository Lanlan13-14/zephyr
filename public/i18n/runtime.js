/**
 * Zephyr i18n runtime — lightweight gettext-style catalog loader.
 * Keys are source Chinese strings (or stable ids); values are locale translations.
 * Supports {name} / {0} interpolation.
 */
const SUPPORTED = Object.freeze(['zh-CN', 'en']);
const STORAGE_KEY = 'zephyr-locale';
const DEFAULT_LOCALE = 'zh-CN';

/** @type {Record<string, Record<string, string>>} */
const catalogs = Object.create(null);
/** @type {string} */
let currentLocale = DEFAULT_LOCALE;
/** @type {Set<(locale: string) => void>} */
const listeners = new Set();
/** @type {Promise<void> | null} */
let loadPromise = null;

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
    const cat = catalogs[currentLocale];
    if (cat && Object.prototype.hasOwnProperty.call(cat, k) && cat[k] != null) return cat[k];
    // zh-CN is source language: missing entry means identity.
    if (currentLocale === 'zh-CN') return k;
    const zh = catalogs['zh-CN'];
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
    return currentLocale;
}

export function getSupportedLocales() {
    return SUPPORTED.slice();
}

export function onLocaleChange(fn) {
    if (typeof fn === 'function') listeners.add(fn);
    return () => listeners.delete(fn);
}

export function registerCatalog(locale, dict) {
    const loc = normalizeLocale(locale);
    catalogs[loc] = { ...(catalogs[loc] || {}), ...(dict || {}) };
}

async function fetchCatalog(locale) {
    const loc = normalizeLocale(locale);
    if (catalogs[loc] && Object.keys(catalogs[loc]).length) return catalogs[loc];
    const url = new URL(`./locales/${loc}.json`, import.meta.url);
    url.searchParams.set('v', '20260811-webdav1');
    const res = await fetch(url.href, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`i18n catalog ${loc} HTTP ${res.status}`);
    const dict = await res.json();
    registerCatalog(loc, dict);
    return catalogs[loc];
}

export async function ensureCatalogs(locales = SUPPORTED) {
    /* A failed first fetch must not permanently poison the module: pages can
     * load before a service worker/network transition settles. Keep a promise
     * only for the in-flight batch, then clear it so a later locale change can
     * retry catalogs that are still empty. */
    if (loadPromise) return loadPromise;
    const requested = [...new Set(locales.map(normalizeLocale))];
    const pending = Promise.all(
        requested.map((loc) => fetchCatalog(loc).catch((err) => {
            console.warn('[i18n] failed to load', loc, err);
            return null;
        })),
    ).then(() => undefined);
    loadPromise = pending;
    try {
        await pending;
    } finally {
        if (loadPromise === pending) loadPromise = null;
    }
}

function setDocumentLang(locale) {
    try {
        document.documentElement.lang = locale === 'zh-CN' ? 'zh-CN' : 'en';
        document.documentElement.dataset.locale = locale;
    } catch {}
}

/**
 * Apply static DOM translations:
 *  data-i18n="key"            → textContent
 *  data-i18n-html="key"       → innerHTML (trusted catalog only)
 *  data-i18n-placeholder="k"  → placeholder
 *  data-i18n-title="k"        → title
 *  data-i18n-aria-label="k"   → aria-label
 *  data-i18n-value="k"        → value (buttons/inputs)
 *  data-i18n-label="k" on <option> → textContent
 */
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

export async function setLocale(next, { persist = true, applyDom = true } = {}) {
    const locale = normalizeLocale(next);
    await ensureCatalogs([locale, 'zh-CN']);
    const changed = locale !== currentLocale;
    currentLocale = locale;
    if (persist) writeStoredLocale(locale);
    setDocumentLang(locale);
    if (applyDom) applyDomI18n(document);
    if (changed) {
        listeners.forEach((fn) => {
            try { fn(locale); } catch (err) { console.warn('[i18n] listener error', err); }
        });
    }
    return locale;
}

/**
 * Resolve initial locale:
 * 1) explicit override (settings)
 * 2) localStorage
 * 3) browser
 * 4) zh-CN
 */
export async function initI18n({ locale, applyDom = true } = {}) {
    const resolved = locale
        ? normalizeLocale(locale)
        : (readStoredLocale() || detectBrowserLocale() || DEFAULT_LOCALE);
    currentLocale = resolved;
    await ensureCatalogs(SUPPORTED);
    if (applyDom) {
        setDocumentLang(currentLocale);
        applyDomI18n(document);
    }
    return currentLocale;
}

export function localeCompareValue(a, b) {
    const loc = currentLocale === 'zh-CN' ? 'zh-CN' : 'en';
    return String(a).localeCompare(String(b), loc);
}

export function formatNumber(n, options) {
    try {
        return new Intl.NumberFormat(currentLocale === 'zh-CN' ? 'zh-CN' : 'en', options).format(n);
    } catch {
        return String(n);
    }
}

export function formatDateTime(ts, options) {
    if (!ts) return t('从未连接');
    try {
        return new Date(ts).toLocaleString(currentLocale === 'zh-CN' ? 'zh-CN' : 'en', options);
    } catch {
        return String(ts);
    }
}

// Eager identity catalog so t() works before fetch resolves for zh-CN keys.
registerCatalog('zh-CN', {});
registerCatalog('en', {});
