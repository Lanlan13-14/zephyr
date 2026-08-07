/*
 * zephyr-one-embed-surface.js — trim the browser-era credential surface out of
 * app.html when the core is running inside Zephyr One.
 *
 * Why this is a DOM transform and not just CSS:
 *   The stage script already ships zephyr-one-embed.css, which hides the
 *   security / admin / data settings tabs with `display:none !important`. That
 *   is not enough. `#settings-security` is the *default active* panel and its
 *   tab button carries `class="settings-tab active"`, so hiding it leaves
 *   Settings showing an invisible panel — a blank pane. app.js also falls back
 *   to `[data-settings="security"]` in three places (saving the active tab,
 *   restoring a saved sub-tab, and re-selecting when the active tab is hidden),
 *   and a CSS-hidden element still matches those selectors.
 *
 *   Removing the tab button outright makes all three fallbacks resolve to null,
 *   which turns them into no-ops, and promoting a different tab to `active`
 *   gives Settings a real landing panel.
 *
 * What is removed and why:
 *   - Security tab: password rotation, TOTP, Passkey, login-email notification,
 *     login event log, IP whitelist / brute-force policy, CAPTCHA. Every one of
 *     those authenticates or rate-limits a *remote* browser client. Zephyr One
 *     is a local child process on loopback whose real gate is the OS unlock
 *     (Biometric / Windows Hello / LocalAuthentication) performed by the shell
 *     before the WebView loads.
 *   - Logout button: the shell re-adopts the local account on the next request,
 *     so logging out either bounces straight back in or looks broken.
 *
 * Replacements are exact-string and asserted unique by the accompanying test,
 * so a markup change in app.html fails loudly instead of silently no-opping.
 */
'use strict';

const EMBED_STYLESHEET = '/zephyr-one-embed.css';

/** Exact markup fragments this transform depends on existing in app.html. */
const SECURITY_TAB_BUTTON = '<button class="settings-tab active" data-settings="security" data-i18n="安全设置">安全设置</button>';
const LOGOUT_BUTTON = '<button class="btn-sm danger" id="logoutBtn" data-i18n="登出">登出</button>';
const SECURITY_PANEL_OPEN = 'class="settings-panel active" id="settings-security"';
const LANGUAGE_TAB_BUTTON = '<button class="settings-tab" data-settings="language"';
const LANGUAGE_PANEL_OPEN = 'class="settings-panel" id="settings-language"';
const HTML_TAG = '<html lang="zh-CN" data-theme="dark">';

/**
 * Structural edits, in order. Each entry is asserted to apply exactly once.
 * `required: false` marks an edit that is allowed to be already applied
 * (idempotent re-entry), not one that may silently fail.
 */
const EDITS = [
    {
        name: 'drop-security-tab',
        from: SECURITY_TAB_BUTTON,
        to: '',
    },
    {
        name: 'drop-logout-button',
        from: LOGOUT_BUTTON,
        to: '',
    },
    {
        name: 'deactivate-security-panel',
        from: SECURITY_PANEL_OPEN,
        to: 'class="settings-panel" id="settings-security"',
    },
    {
        name: 'promote-language-tab',
        from: LANGUAGE_TAB_BUTTON,
        to: '<button class="settings-tab active" data-settings="language"',
    },
    {
        name: 'promote-language-panel',
        from: LANGUAGE_PANEL_OPEN,
        to: 'class="settings-panel active" id="settings-language"',
    },
    /* Product marker. theme-runtime.js reads
     * document.documentElement.dataset.zephyrProduct and draws the Zephyr One
     * wind-mark — same strokes, plus the "One" wordmark — instead of the Zephyr
     * mark, for both the header brand icon and the favicon. That is what makes
     * the two products visually distinguishable at a glance.
     *
     * It has to be an attribute on <html> rather than a script: the brand icon
     * is re-rendered by applyAppearance() on every locale/theme change, so any
     * one-shot DOM patch would be overwritten on the next repaint. Reading a
     * root attribute means every re-render picks the right shape. */
    {
        name: 'mark-one-product',
        from: HTML_TAG,
        to: '<html lang="zh-CN" data-theme="dark" data-zephyr-product="one">',
    },
];

/**
 * Count non-overlapping occurrences of a literal substring.
 * @param {string} haystack
 * @param {string} needle
 * @returns {number}
 */
function countOccurrences(haystack, needle) {
    if (!needle) return 0;
    let count = 0;
    let index = haystack.indexOf(needle);
    while (index !== -1) {
        count += 1;
        index = haystack.indexOf(needle, index + needle.length);
    }
    return count;
}

/**
 * Inject the embed stylesheet link, if not already present.
 * @param {string} html
 * @returns {string}
 */
function injectStylesheet(html) {
    if (html.includes(EMBED_STYLESHEET)) return html;
    const link = `<link rel="stylesheet" href="${EMBED_STYLESHEET}">`;
    return html.includes('</head>')
        ? html.replace('</head>', `${link}\n</head>`)
        : link + html;
}

/**
 * Apply the Zephyr One embedded surface to an app.html document.
 *
 * @param {string} source raw app.html
 * @returns {{ html: string, applied: string[], skipped: string[] }}
 * @throws {Error} when a required fragment is missing *and* its result is not
 *   already in place — that means app.html changed shape and the embedded
 *   surface would silently degrade.
 */
function applyEmbeddedSurface(source) {
    let html = String(source || '');
    const applied = [];
    const skipped = [];

    for (const edit of EDITS) {
        const occurrences = countOccurrences(html, edit.from);
        if (occurrences === 1) {
            html = html.replace(edit.from, edit.to);
            applied.push(edit.name);
            continue;
        }
        if (occurrences > 1) {
            throw new Error(
                `zephyr-one embedded surface: "${edit.name}" matched ${occurrences} times; expected exactly 1`,
            );
        }
        // Already applied (idempotent) — the post-edit form is present instead.
        if (edit.to && html.includes(edit.to)) {
            skipped.push(edit.name);
            continue;
        }
        // Removal edits have an empty `to`, so absence is indistinguishable
        // from "already removed". Treat that as satisfied.
        if (!edit.to) {
            skipped.push(edit.name);
            continue;
        }
        throw new Error(
            `zephyr-one embedded surface: "${edit.name}" found neither its source nor its result in app.html`,
        );
    }

    return { html: injectStylesheet(html), applied, skipped };
}

module.exports = {
    applyEmbeddedSurface,
    countOccurrences,
    EMBED_STYLESHEET,
    EDITS,
};
