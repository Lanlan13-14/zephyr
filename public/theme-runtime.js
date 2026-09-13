const DEFAULT_BRAND_ICON = '🌬️';
const SCHEME_IDS = new Set(['frost', 'lava', 'asagi', 'cyber', 'custom']);

/* ── Zephyr mark geometry (Apple HIG aligned) ──────────────────────────
 * Single source of truth for the inline mark, favicon and shipped SVG files.
 *
 * Three deliberate refinements under Apple HIG / fluid dynamics:
 *   1. The apex curve is G1/G2 continuous: the old (160,80) corner had a
 *      135° tangent discontinuity which looked like a kink.
 *   2. The focal dot dotA at (145,115) sits inside a 1.8px optical clearance
 *      cutout on the mid stroke, so it floats cleanly instead of mud-merging.
 *   3. The old ghost dot dotB at (75,125) was swallowed 100% by the stroke
 *      cap (r=3 < cap r=5) and has been removed completely to eliminate
 *      visual noise and keep the mark laser-focused.
 */
const PATH_MAIN = 'M 43 64 C 84 44, 138 52, 160 77 C 148 94, 108 104, 76 123';
const PATH_MID = 'M 49 76 C 89 74, 126 89, 145 115 C 120 134, 76 153, 40 135';
const PATH_TAIL = 'M 80 92 C 108 108, 137 135, 162 129';

const ONE_PATH_MAIN = PATH_MAIN;
const ONE_PATH_MID = PATH_MID;
const ONE_PATH_TAIL = 'M 78 88 C 108 106, 137 137, 170 128';
const ONE_WORDMARK_FONT = "system-ui, -apple-system, 'SF Pro Display', Roboto, Helvetica, Arial, sans-serif";
/** Ellipse punched out of the mid stroke to seat the wordmark's "O". */
const ONE_CUT = { cx: 145, cy: 115, rx: 5, ry: 4.8 };
/** Circle punched out of the mid stroke to give the core focal dot breathing space. */
const CORE_CUT = { cx: 145, cy: 115, r: 6.2 };

/** Dark mode App Icon background gradients (exactly matched per theme). */
const ICON_BG_DARK = Object.freeze({
    frost: { top: '#1e242c', bot: '#101419' },
    lava: { top: '#241c17', bot: '#15100c' },
    asagi: { top: '#17221f', bot: '#0e1614' },
    cyber: { top: '#152024', bot: '#0d1417' },
});

export const DEFAULT_CUSTOM_THEME_COLORS = Object.freeze({
    bgMain: '#101114',
    bgCard: '#1b1c20',
    primary: '#0a84ff',
    primaryHover: '#2997ff',
    text: '#f4f4f6',
    textSecondary: '#9a9ca3',
    border: '#303237',
    danger: '#ff453a',
    success: '#32d74b',
    warning: '#ffd60a',
});

const ICON_PALETTES = Object.freeze({
    frost: { main: '#eef2f7', mid: '#a8b5c3', dark: '#6e7b88', glow: 'rgba(10, 132, 255, 0.18)', title: '#0a84ff', dotA: '#0a84ff', midOffset: '58%', polar: false },
    lava: { main: '#f1e8df', mid: '#c79672', dark: '#8d5a3a', glow: 'rgba(191, 90, 31, 0.16)', title: '#bf5a1f', dotA: '#bf5a1f', midOffset: '58%', polar: false },
    asagi: { main: '#edf4f2', mid: '#9bbdb5', dark: '#5e8f83', glow: 'rgba(77, 156, 138, 0.15)', title: '#4d9c8a', dotA: '#4d9c8a', midOffset: '58%', polar: false },
    cyber: { main: '#eef3f5', mid: '#9eb7bd', dark: '#5d858d', glow: 'rgba(79, 157, 166, 0.15)', title: '#4f9da6', dotA: '#4f9da6', midOffset: '58%', polar: false },
});

const CUSTOM_COLOR_VARS = Object.freeze({
    bgMain: ['--bg-main', '--bg'],
    bgCard: ['--bg-card', '--surface'],
    primary: ['--color-primary', '--accent', '--brand-icon-color'],
    primaryHover: ['--color-primary-hover', '--accent-hover'],
    text: ['--text'],
    textSecondary: ['--text-secondary'],
    border: ['--border'],
    danger: ['--danger'],
    success: ['--success'],
    warning: ['--warning'],
});

let iconSeq = 0;

function escapeHtml(value = '') {
    return String(value || '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

function normalizeScheme(value = '') {
    const scheme = String(value || 'frost').toLowerCase();
    return SCHEME_IDS.has(scheme) ? scheme : 'frost';
}

function normalizeHex(value, fallback = '') {
    const text = String(value || '').trim();
    return /^#[0-9a-f]{6}$/i.test(text) ? text.toLowerCase() : fallback;
}

function hexToRgb(hex) {
    const safe = normalizeHex(hex, '#000000').slice(1);
    return { r: parseInt(safe.slice(0, 2), 16), g: parseInt(safe.slice(2, 4), 16), b: parseInt(safe.slice(4, 6), 16) };
}

function rgbToHex({ r, g, b }) {
    const to = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
    return `#${to(r)}${to(g)}${to(b)}`;
}

function rgba(hex, alpha = 1) {
    const { r, g, b } = hexToRgb(hex);
    const a = Math.max(0, Math.min(1, Number(alpha)));
    return `rgba(${r}, ${g}, ${b}, ${Number(a.toFixed(3))})`;
}

function mixHex(a, b, weightB = 0.5) {
    const ca = hexToRgb(a), cb = hexToRgb(b);
    const w = Math.max(0, Math.min(1, Number(weightB)));
    return rgbToHex({ r: ca.r * (1 - w) + cb.r * w, g: ca.g * (1 - w) + cb.g * w, b: ca.b * (1 - w) + cb.b * w });
}

export function normalizeCustomThemeColors(colors = {}) {
    const out = {};
    Object.entries(DEFAULT_CUSTOM_THEME_COLORS).forEach(([key, fallback]) => {
        out[key] = normalizeHex(colors?.[key], fallback);
    });
    return out;
}

function ensureCustomStyle(id, cssText = '') {
    let style = document.getElementById(id);
    if (!cssText) {
        style?.remove();
        return;
    }
    if (!style) {
        style = document.createElement('style');
        style.id = id;
        document.head.appendChild(style);
    }
    if (style.textContent !== cssText) style.textContent = cssText;
}

function runCustomJsOnce(jsText = '', context = {}) {
    const code = String(jsText || '').trim();
    if (!code) return;
    const key = `${context.page || 'app'}:${code}`;
    if (window.__zephyrCustomJsLastRun === key) return;
    window.__zephyrCustomJsLastRun = key;
    try {
        window.ZephyrCustomContext = { ...(window.ZephyrCustomContext || {}), ...context };
        new Function('ZephyrCustomContext', code)(window.ZephyrCustomContext);
    } catch (err) {
        console.warn('[theme-runtime]', 'custom JS failed', { page: context.page || 'app', error: err?.message || String(err) });
    }
}

function currentScheme() {
    return normalizeScheme(document.documentElement?.getAttribute('data-color-scheme') || 'frost');
}

function paletteForScheme(scheme = currentScheme()) {
    const normalized = normalizeScheme(scheme);
    if (normalized !== 'custom') return ICON_PALETTES[normalized] || ICON_PALETTES.frost;
    const root = document.documentElement;
    const primary = normalizeHex(root?.style?.getPropertyValue('--color-primary') || '', DEFAULT_CUSTOM_THEME_COLORS.primary);
    return {
        main: mixHex(primary, '#ffffff', 0.68),
        mid: mixHex(primary, '#ffffff', 0.34),
        dark: primary,
        glow: rgba(primary, 0.42),
        title: primary,
        dotA: primary,
        midOffset: '60%',
        polar: false,
    };
}

function applyIconPaletteVars(root, palette) {
    root.style.setProperty('--zephyr-icon-main', palette.main);
    root.style.setProperty('--zephyr-icon-mid', palette.mid);
    root.style.setProperty('--zephyr-icon-dark', palette.dark);
    root.style.setProperty('--zephyr-icon-glow', palette.glow);
    root.style.setProperty('--zephyr-icon-title', palette.title || palette.dark);
    root.style.setProperty('--zephyr-icon-dot-a', palette.dotA || palette.dark);
    // dotB ghost dot is eradicated under Apple HIG single-focal-point rule
    root.style.setProperty('--zephyr-icon-grad-start', palette.polar ? palette.dark : palette.main);
    root.style.setProperty('--zephyr-icon-grad-mid', palette.mid);
    root.style.setProperty('--zephyr-icon-grad-end', palette.polar ? palette.main : palette.dark);
    root.style.setProperty('--zephyr-icon-grad-mid-offset', palette.midOffset || '60%');
    root.style.setProperty('--brand-icon-color', palette.title || palette.dark);
    root.style.setProperty('--brand-icon-glow', palette.glow);
}

export function applyZephyrColorScheme(appearance = {}, { theme = '', page = 'app', executeCustomJs = true } = {}) {
    const root = document.documentElement;
    if (!root) return;
    const scheme = normalizeScheme(appearance.colorScheme || appearance.palette || 'frost');
    if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
    root.setAttribute('data-color-scheme', scheme);

    if (scheme === 'custom') {
        const colors = normalizeCustomThemeColors(appearance.customColors || {});
        Object.entries(CUSTOM_COLOR_VARS).forEach(([key, vars]) => {
            vars.forEach((name) => root.style.setProperty(name, colors[key]));
        });
        root.style.setProperty('--protocol-badge-bg', rgba(colors.primary, 0.14));
        root.style.setProperty('--protocol-badge-fg', colors.primaryHover || colors.primary);
        root.style.setProperty('--accent-soft-border', rgba(colors.primary, 0.48));
        root.style.setProperty('--accent-soft-bg', rgba(colors.primary, 0.12));
        root.style.setProperty('--accent-glow', rgba(colors.primary, 0.28));
        applyIconPaletteVars(root, paletteForScheme('custom'));
    } else {
        Object.values(CUSTOM_COLOR_VARS).flat().forEach((name) => root.style.removeProperty(name));
        ['--protocol-badge-bg', '--protocol-badge-fg', '--accent-soft-border', '--accent-soft-bg', '--accent-glow'].forEach((name) => root.style.removeProperty(name));
        applyIconPaletteVars(root, ICON_PALETTES[scheme] || ICON_PALETTES.frost);
    }

    ensureCustomStyle('zephyr-custom-css', scheme === 'custom' ? String(appearance.customCss || '') : '');
    if (scheme === 'custom' && executeCustomJs) runCustomJsOnce(appearance.customJs || '', { page, scheme, theme: root.getAttribute('data-theme') || theme || '' });
}

function coreCutMask(maskId) {
    return `<mask id="${maskId}" maskUnits="userSpaceOnUse" x="0" y="0" width="200" height="200"><rect width="200" height="200" fill="#ffffff"/><circle cx="${CORE_CUT.cx}" cy="${CORE_CUT.cy}" r="${CORE_CUT.r}" fill="#000000"/></mask>`;
}

function zephyrWindSvg({ gradientId = 'zephyr-brand-gradient', maskId = 'zephyr-core-cut', title = 'Zephyr' } = {}) {
    return `<svg class="zephyr-brand-svg" viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg" focusable="false"><title>${escapeHtml(title)}</title><defs><linearGradient id="${gradientId}" x1="15%" y1="15%" x2="85%" y2="85%"><stop offset="0%" stop-color="var(--zephyr-icon-grad-start, #e0f2fe)"/><stop offset="var(--zephyr-icon-grad-mid-offset, 60%)" stop-color="var(--zephyr-icon-grad-mid, #93c5fd)"/><stop offset="100%" stop-color="var(--zephyr-icon-grad-end, #60a5fa)"/></linearGradient>${coreCutMask(maskId)}</defs><path class="wind-path-main" d="${PATH_MAIN}" stroke="url(#${gradientId})"/><path class="wind-path-mid" d="${PATH_MID}" stroke="url(#${gradientId})" mask="url(#${maskId})"/><path class="wind-path-tail" d="${PATH_TAIL}" stroke="url(#${gradientId})"/><circle cx="145" cy="115" r="4.5" fill="var(--zephyr-icon-dot-a, #60a5fa)" opacity="0.9"/></svg>`;
}

/* Zephyr One's mark: the same wind strokes carrying an "One" wordmark.
 *
 * Three deliberate differences from the Zephyr mark above, matching the
 * shipped One artwork in zephyr_one/platform_assets/icons/:
 *   1. The tail sweeps wider (`M 78 88 …`) so it clears the wordmark.
 *   2. The mid stroke is masked by an ellipse at (145,115) — the wordmark's
 *      "O" sits in that gap, so the stroke must not run through it.
 *   3. There is no dot-a circle; the "O" occupies that position.
 *
 * The white rounded plate present in the app-icon SVGs is intentionally NOT
 * emitted here: that plate exists so the light-gray strokes stay visible on a
 * light OS taskbar, but inline it would punch a white square into a dark UI.
 *
 * Colours come from the same CSS custom properties as the Zephyr mark, so this
 * follows the active colour scheme with no extra wiring.
 */
function oneCutMask(maskId) {
    return `<mask id="${maskId}" maskUnits="userSpaceOnUse" x="0" y="0" width="200" height="200"><rect width="200" height="200" fill="#ffffff"/><ellipse cx="${ONE_CUT.cx}" cy="${ONE_CUT.cy}" rx="${ONE_CUT.rx}" ry="${ONE_CUT.ry}" fill="#000000"/></mask>`;
}

function oneWordmark(fill) {
    return `<g class="zephyr-one-wordmark" font-family="${ONE_WORDMARK_FONT}" font-size="15" font-weight="800" fill="${fill}" opacity="0.9"><text x="145" y="120.7" text-anchor="middle">O</text><text x="152.4" y="120.7">ne</text></g>`;
}

function zephyrOneWindSvg({ gradientId = 'zephyr-one-gradient', maskId = 'zephyr-one-cut', title = 'Zephyr One' } = {}) {
    return `<svg class="zephyr-brand-svg" viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg" focusable="false"><title>${escapeHtml(title)}</title><defs><linearGradient id="${gradientId}" x1="15%" y1="15%" x2="85%" y2="85%"><stop offset="0%" stop-color="var(--zephyr-icon-grad-start, #eef2f7)"/><stop offset="var(--zephyr-icon-grad-mid-offset, 58%)" stop-color="var(--zephyr-icon-grad-mid, #a8b5c3)"/><stop offset="100%" stop-color="var(--zephyr-icon-grad-end, #6e7b88)"/></linearGradient>${oneCutMask(maskId)}</defs><path class="wind-path-main" d="${ONE_PATH_MAIN}" stroke="url(#${gradientId})"/><path class="wind-path-mid" d="${ONE_PATH_MID}" stroke="url(#${gradientId})" mask="url(#${maskId})"/><path class="wind-path-tail" d="${ONE_PATH_TAIL}" stroke="url(#${gradientId})"/>${oneWordmark('var(--zephyr-icon-title, #0a84ff)')}</svg>`;
}

/** True when this document is the Zephyr One shell rather than Zephyr proper. */
function isOneProduct() {
    return document.documentElement?.dataset?.zephyrProduct === 'one';
}

/* The product name to show when the operator has not chosen one.
 *
 * One embeds the *main* product UI, so app.js was applying Zephyr's own
 * default and the One header read "Zephyr" with a browser tab titled
 * "Zephyr". The two products were indistinguishable by name, and the wind
 * mark beside it is the same artwork in both, so nothing on screen said which
 * product the user was in.
 *
 * A function rather than a constant because the answer depends on the
 * document, and the marker is set by the embed transform at serve time.
 */
export function zephyrDefaultBrandName() {
    return isOneProduct() ? 'Zephyr One' : 'Zephyr';
}

/* The brand name storage.js seeds into a fresh install.
 *
 * Not a preference: it is the value every new database starts with, before
 * any operator has opened the appearance settings.
 */
const SEEDED_BRAND_NAME = 'Zephyr';

/* Resolve the brand name to display from whatever the server has stored.
 *
 * Supplying a default was not enough. storage.js seeds appearance.brandName
 * with the literal 'Zephyr', so the stored value is never empty and a
 * `stored || default` fallback never fires -- One kept showing 'Zephyr' in the
 * header and the window title even with the product marker set correctly.
 *
 * So the seeded value is treated as "nobody has chosen a name", which is
 * exactly how the brand icon already behaves: zephyrBrandIconHtml() treats the
 * seeded wind emoji as unchosen and draws the product's own artwork instead.
 * Applying the same rule to the name keeps the two halves of the brand
 * consistent rather than having the mark say One and the text say Zephyr.
 *
 * The tradeoff, stated plainly: an operator who deliberately types 'Zephyr'
 * into One's appearance settings gets 'Zephyr One'. That spelling is
 * indistinguishable from the seed without a schema change to record
 * "customised", and PRODUCT_REQUIREMENTS.md requires One to identify itself,
 * so the seed reading wins. Any other name is honoured verbatim.
 */
export function zephyrResolveBrandName(stored) {
    const text = String(stored ?? '').trim();
    if (!text || text === SEEDED_BRAND_NAME) return zephyrDefaultBrandName();
    return text;
}

/* One's mark without the wordmark, for marks rendered small.
 *
 * Optical sizing, and the reason is measurable rather than aesthetic: the
 * wordmark is font-size 15 inside a 200-unit viewBox, so at the header's 24px
 * it renders 1.8px tall with a cap height near 1.3px. No renderer resolves
 * letterforms there; what appears is a grey smudge against the crisp strokes
 * beside it, which reads as a blurry logo rather than as a wordmark.
 *
 * Under optical sizing (Apple HIG), when the wordmark is stripped out for
 * small frames, the mark falls back to the exact pristine single-focal-point
 * wind geometry used by Zephyr Core, keeping the brand spark (dot-a) crisp.
 */
function zephyrOneCompactSvg({ gradientId = 'zephyr-one-gradient', title = 'Zephyr One' } = {}) {
    /* Optical sizing (Apple HIG): below the size the wordmark can be read at,
     * strip it AND the mask that punches its hole — a bare bite out of the
     * mid stroke reads worse than the smudge the mask was meant to fix. The
     * focus dot (dot-a) sits on top of the crossing, restoring the pristine
     * single-focal-point geometry of Zephyr Core. */
    return `<svg class="zephyr-brand-svg" viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg" focusable="false"><title>${escapeHtml(title)}</title><defs><linearGradient id="${gradientId}" x1="15%" y1="15%" x2="85%" y2="85%"><stop offset="0%" stop-color="var(--zephyr-icon-grad-start, #eef2f7)"/><stop offset="var(--zephyr-icon-grad-mid-offset, 58%)" stop-color="var(--zephyr-icon-grad-mid, #a8b5c3)"/><stop offset="100%" stop-color="var(--zephyr-icon-grad-end, #6e7b88)"/></linearGradient></defs><path class="wind-path-main" d="${ONE_PATH_MAIN}" stroke="url(#${gradientId})"/><path class="wind-path-mid" d="${ONE_PATH_MID}" stroke="url(#${gradientId})"/><path class="wind-path-tail" d="${ONE_PATH_TAIL}" stroke="url(#${gradientId})"/><circle cx="145" cy="115" r="4.5" fill="var(--zephyr-icon-dot-a, #0a84ff)" opacity="0.9"/></svg>`;
}

/**
 * @param {string} icon stored appearance value, or the default wind glyph
 * @param {{compact?: boolean}} [opts] `compact` drops One's wordmark; pass it
 *   wherever the mark is rendered below roughly 40px (see zephyrOneCompactSvg).
 */
export function zephyrBrandIconHtml(icon = DEFAULT_BRAND_ICON, opts = {}) {
    const value = String(icon || DEFAULT_BRAND_ICON).trim() || DEFAULT_BRAND_ICON;
    if (value.startsWith('data:image/')) return `<img src="${value}" alt="">`;
    if (value === DEFAULT_BRAND_ICON) {
        const seq = ++iconSeq;
        let svg;
        if (!isOneProduct()) {
            svg = zephyrWindSvg({ gradientId: `zephyr-brand-gradient-${seq}`, maskId: `zephyr-core-cut-${seq}` });
        } else if (opts.compact) {
            svg = zephyrOneCompactSvg({ gradientId: `zephyr-one-gradient-${seq}` });
        } else {
            svg = zephyrOneWindSvg({ gradientId: `zephyr-one-gradient-${seq}`, maskId: `zephyr-one-cut-${seq}` });
        }
        return `<span class="zephyr-brand-mark" aria-hidden="true">${svg}</span>`;
    }
    return escapeHtml(value);
}

function faviconSvgForPalette(palette) {
    const midOffset = palette.midOffset || '60%';
    const s0 = palette.polar ? palette.dark : palette.main;
    const s1 = palette.mid;
    const s2 = palette.polar ? palette.main : palette.dark;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" fill="none"><defs><linearGradient id="g" x1="15%" y1="15%" x2="85%" y2="85%"><stop offset="0%" stop-color="${s0}"/><stop offset="${midOffset}" stop-color="${s1}"/><stop offset="100%" stop-color="${s2}"/></linearGradient><mask id="core_cut" maskUnits="userSpaceOnUse" x="0" y="0" width="200" height="200"><rect width="200" height="200" fill="#ffffff"/><circle cx="145" cy="115" r="6.2" fill="#000000"/></mask></defs><path d="${PATH_MAIN}" stroke="url(#g)" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/><path d="${PATH_MID}" stroke="url(#g)" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" opacity="0.88" mask="url(#core_cut)"/><path d="${PATH_TAIL}" stroke="url(#g)" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.65"/><circle cx="145" cy="115" r="4.5" fill="${palette.dotA || palette.dark}" opacity="0.9"/></svg>`;
}

/* Favicon variant of the One mark. Same reasoning as oneWindSvg(): a `data:`
 * URL is rendered outside the document, so CSS custom properties resolve to
 * nothing and every colour must be a literal. No white plate here — a favicon
 * sits on the browser/webview chrome, not on an OS icon grid. */
function oneFaviconSvgForPalette(palette) {
    const midOffset = palette.midOffset || '60%';
    const s0 = palette.polar ? palette.dark : palette.main;
    const s1 = palette.mid;
    const s2 = palette.polar ? palette.main : palette.dark;
    const title = palette.title || palette.dark;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" fill="none"><defs><linearGradient id="g" x1="15%" y1="15%" x2="85%" y2="85%"><stop offset="0%" stop-color="${s0}"/><stop offset="${midOffset}" stop-color="${s1}"/><stop offset="100%" stop-color="${s2}"/></linearGradient>${oneCutMask('gcut')}</defs><path d="${ONE_PATH_MAIN}" stroke="url(#g)" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/><path d="${ONE_PATH_MID}" stroke="url(#g)" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" opacity="0.88" mask="url(#gcut)"/><path d="${ONE_PATH_TAIL}" stroke="url(#g)" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.65"/>${oneWordmark(title)}</svg>`;
}

export function zephyrFaviconHref(icon = DEFAULT_BRAND_ICON) {
    const value = String(icon || DEFAULT_BRAND_ICON).trim() || DEFAULT_BRAND_ICON;
    if (value.startsWith('data:image/')) return value;
    if (value === DEFAULT_BRAND_ICON) {
        const palette = paletteForScheme();
        const svg = isOneProduct() ? oneFaviconSvgForPalette(palette) : faviconSvgForPalette(palette);
        return `data:image/svg+xml,${encodeURIComponent(svg)}`;
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">${escapeHtml(value)}</text></svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
