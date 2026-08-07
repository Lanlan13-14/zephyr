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

/*
 * Folder-mapping overlay for the RDP settings panel.
 *
 * app.html already ships the 文件夹映射 switch plus its folder / device-name
 * fields, but nothing in the shared app.js reads or writes them: in the browser
 * product they cannot mean anything, because a server-side directory path is
 * not something a browser may choose or a WASM RDP client may mount.
 *
 * Inside One the same fields do mean something, so this script supplies the
 * behaviour: it opens a native OS folder dialog through the Tauri shell, and
 * persists {folder, deviceName} per connection so FreeRDP can redirect it as an
 * RDPDR drive.
 *
 * It is injected here rather than added to app.html because app.html is shared.
 * Adding a <script> tag there would make the browser product request a file it
 * does not ship (404) for a feature it cannot perform.
 */
const EMBED_RDP_SETTINGS_SCRIPT = '/zephyr-one-rdp-settings.js';

/** Exact markup fragments this transform depends on existing in app.html. */
const SECURITY_TAB_BUTTON = '<button class="settings-tab active" data-settings="security" data-i18n="安全设置">安全设置</button>';
const LOGOUT_BUTTON = '<button class="btn-sm danger" id="logoutBtn" data-i18n="登出">登出</button>';
const SECURITY_PANEL_OPEN = 'class="settings-panel active" id="settings-security"';
const LANGUAGE_TAB_BUTTON = '<button class="settings-tab" data-settings="language"';
const LANGUAGE_PANEL_OPEN = 'class="settings-panel" id="settings-language"';
const HTML_TAG = '<html lang="zh-CN" data-theme="dark">';

/* Zephyr Client → 文件同步 (One side only).
 *
 * The main product keeps the name "Zephyr Client" because there it really is
 * the client-management surface: Agent tokens, online agents, drive mappings,
 * plus the bound One devices. Inside One that framing is wrong — One *is* the
 * client, so the panel's job there is the file-sync relationship with the main
 * instance, and the product contract names that surface 文件同步.
 *
 * The heading text is not unique in app.html (the About panel carries the same
 * "Zephyr Client" h2 as a download link, which must keep its name), so this
 * rename is region-scoped to the agent panel. */
const AGENT_TAB_BUTTON = '<button class="settings-tab" data-settings="agent" data-i18n="Zephyr Client">Zephyr Client</button>';
const CLIENT_HEADING = '<h2 data-i18n="Zephyr Client">Zephyr Client</h2>';
const FILE_SYNC_HEADING = '<h2 data-i18n="文件同步">文件同步</h2>';
const AGENT_PANEL_ANCHOR = 'id="settings-agent"';
const DATA_PANEL_ANCHOR = '<div class="settings-panel" id="settings-data"';

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
    {
        name: 'rename-agent-tab',
        from: AGENT_TAB_BUTTON,
        to: '<button class="settings-tab" data-settings="agent" data-i18n="文件同步">文件同步</button>',
    },
    {
        /* Region-scoped: the same heading exists in the About panel and must
         * keep its name there. Bounding by the neighbouring panel ids instead
         * of matching indentation keeps this working if app.html is reflowed. */
        name: 'rename-agent-heading',
        from: CLIENT_HEADING,
        to: FILE_SYNC_HEADING,
        within: AGENT_PANEL_ANCHOR,
        until: DATA_PANEL_ANCHOR,
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
/**
 * Resolve the `[start, end)` slice an edit is allowed to touch.
 *
 * Most edits match a globally unique fragment. Some do not: the "Zephyr Client"
 * h2 appears both in the agent panel (which One renames) and in the About panel
 * (which must keep the name, it is a download link). For those, `within` /
 * `until` bound the search to one region so the edit cannot reach the other
 * occurrence — and so a duplicate *inside* the region is still an error rather
 * than a silent first-match replacement.
 *
 * @param {string} html
 * @param {{ within?: string, until?: string, name: string }} edit
 * @returns {{ start: number, end: number } | null} null when the region anchor
 *   is absent, which callers treat as "cannot apply here".
 */
function regionOf(html, edit) {
    if (!edit.within) return { start: 0, end: html.length };
    const start = html.indexOf(edit.within);
    if (start === -1) return null;
    if (!edit.until) return { start, end: html.length };
    const end = html.indexOf(edit.until, start);
    return { start, end: end === -1 ? html.length : end };
}

/**
 * Inject the folder-mapping overlay script, if not already present.
 *
 * Appended at the end of <body> rather than in <head>: the script queries
 * `#rdpStorageFolderPickBtn` and friends at load time, so it must run after
 * app.html's markup exists. It is deliberately *not* `defer`red into <head>
 * because app.js is a classic script too, and keeping both in body order means
 * the overlay observes the same DOM app.js has already wired.
 *
 * @param {string} html
 * @returns {string}
 */
function injectRdpSettingsScript(html) {
    if (html.includes(EMBED_RDP_SETTINGS_SCRIPT)) return html;
    const tag = `<script src="${EMBED_RDP_SETTINGS_SCRIPT}"></script>`;
    return html.includes('</body>')
        ? html.replace('</body>', `${tag}\n</body>`)
        : html + tag;
}

function applyEmbeddedSurface(source) {
    let html = String(source || '');
    const applied = [];
    const skipped = [];

    for (const edit of EDITS) {
        const region = regionOf(html, edit);
        const slice = region ? html.slice(region.start, region.end) : '';
        const occurrences = countOccurrences(slice, edit.from);
        if (occurrences === 1) {
            /* Splice rather than String.replace: replace() would scan from
             * index 0 and could hit an occurrence outside the region. */
            const at = region.start + slice.indexOf(edit.from);
            html = html.slice(0, at) + edit.to + html.slice(at + edit.from.length);
            applied.push(edit.name);
            continue;
        }
        if (occurrences > 1) {
            throw new Error(
                `zephyr-one embedded surface: "${edit.name}" matched ${occurrences} times; expected exactly 1`,
            );
        }
        // Already applied (idempotent) — the post-edit form is present instead.
        if (edit.to && slice.includes(edit.to)) {
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

    return {
        html: injectRdpSettingsScript(injectStylesheet(html)),
        applied,
        skipped,
    };
}

module.exports = {
    applyEmbeddedSurface,
    countOccurrences,
    /* Exported so the contract test asserts uniqueness against the *same*
     * region logic the transform uses. A reimplementation in the test could
     * drift and then agree with itself while disagreeing with production. */
    regionOf,
    EMBED_STYLESHEET,
    EMBED_RDP_SETTINGS_SCRIPT,
    EDITS,
};
