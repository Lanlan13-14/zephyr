import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Zephyr One embedded surface: the browser-era credential wall must be gone.
 *
 * Zephyr One runs the core as a local child process on loopback and the real
 * product gate is the OS unlock the Tauri shell performs before the WebView
 * loads. Password rotation / TOTP / Passkey / login-email / IP-whitelist /
 * CAPTCHA all authenticate a *remote browser* client and are redundant there.
 *
 * These assertions run against the real public/app.html, so a markup change
 * that would silently defeat the transform fails here instead of shipping.
 */

const require = createRequire(import.meta.url);
const { applyEmbeddedSurface, countOccurrences, regionOf, EDITS, EMBED_STYLESHEET } =
    require('../zephyr-one-embed-surface.js');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_HTML = readFileSync(path.join(root, 'public/app.html'), 'utf8');
const SERVER_JS = readFileSync(path.join(root, 'server.js'), 'utf8');
const STAGE_SH = readFileSync(path.join(root, 'zephyr_one/scripts/stage-zephyr-core.sh'), 'utf8');
const APP_JS = readFileSync(path.join(root, 'public/app.js'), 'utf8');

test('every fragment the transform depends on appears exactly once in its scope', () => {
    /* A fragment matching 0 times means the transform silently no-ops; matching
     * 2+ times means it could edit an unintended element.
     *
     * Scope matters: `<h2 data-i18n="Zephyr Client">` legitimately appears
     * twice in app.html — once in the settings panel that One renames to
     * 文件同步, and once in the About panel as a download link that must keep
     * its name. That edit is region-bounded, so uniqueness is asserted inside
     * the region, using the transform's own helper rather than a copy of it. */
    for (const edit of EDITS) {
        const region = regionOf(APP_HTML, edit);
        assert.ok(region, `"${edit.name}" region anchor ${edit.within} not found`);
        const slice = APP_HTML.slice(region.start, region.end);
        assert.equal(
            countOccurrences(slice, edit.from),
            1,
            `"${edit.name}" source fragment must appear exactly once in its scope`,
        );
    }
});

test('region-scoped edits really are bounded, not accidentally global', () => {
    /* If `within`/`until` were ignored the heading rename would still "work"
     * on the first match, so a passing rename proves nothing by itself. This
     * asserts the bound is real: the fragment is ambiguous globally, unique
     * inside the region, and the region stops before the About panel. */
    const scoped = EDITS.filter((e) => e.within);
    assert.ok(scoped.length > 0, 'at least one edit must be region-scoped');

    for (const edit of scoped) {
        const region = regionOf(APP_HTML, edit);
        const slice = APP_HTML.slice(region.start, region.end);
        assert.equal(countOccurrences(slice, edit.from), 1);
        assert.ok(
            region.end < APP_HTML.length,
            `"${edit.name}" must stop at ${edit.until}, not run to end of file`,
        );
        // The About panel is outside every scoped region.
        assert.equal(slice.includes('id="settings-about"'), false);
    }

    // And the specific ambiguity this mechanism exists for.
    const heading = '<h2 data-i18n="Zephyr Client">Zephyr Client</h2>';
    assert.equal(countOccurrences(APP_HTML, heading), 2, 'heading must be globally ambiguous');
});

test('transform removes the security tab and the logout button', () => {
    const { html, applied } = applyEmbeddedSurface(APP_HTML);

    // All five structural edits actually fired against real markup.
    assert.deepEqual(applied, EDITS.map((e) => e.name));

    // The security tab BUTTON is gone from the DOM, not merely hidden. app.js
    // resolves [data-settings="security"] in three places; a CSS-hidden element
    // still matches those selectors, a removed one does not.
    assert.equal(html.includes('data-settings="security"'), false);

    // Logout is gone: the shell re-adopts the local account on the next
    // request, so logging out either bounces back in or looks broken.
    assert.equal(html.includes('id="logoutBtn"'), false);
});

test('Settings lands on a real panel instead of a hidden one', () => {
    const { html } = applyEmbeddedSurface(APP_HTML);

    // Exactly one active tab and one active panel, and they agree.
    assert.equal(countOccurrences(html, 'class="settings-tab active"'), 1);
    assert.equal(countOccurrences(html, 'class="settings-panel active"'), 1);
    assert.match(html, /<button class="settings-tab active" data-settings="language"/);
    assert.match(html, /class="settings-panel active" id="settings-language"/);

    // The security panel is no longer the default-active one.
    assert.equal(html.includes('class="settings-panel active" id="settings-security"'), false);
});

test('unmodified app.html would strand Settings on a CSS-hidden panel', () => {
    /* Proves the bug this transform fixes is real and not hypothetical:
     * shipped 0.1.9 hid #settings-security via CSS while it was still the
     * default-active panel, so opening Settings showed a blank pane. */
    assert.match(APP_HTML, /class="settings-panel active" id="settings-security"/);
    assert.match(APP_HTML, /<button class="settings-tab active" data-settings="security"/);

    // And app.js really does fall back to that exact tab.
    assert.equal(APP_JS.includes('.settings-tab[data-settings="security"]'), true);
});

test('transform is idempotent', () => {
    const once = applyEmbeddedSurface(APP_HTML).html;
    const twice = applyEmbeddedSurface(once);
    assert.equal(twice.html, once);
    // Second pass finds results already in place rather than sources.
    assert.deepEqual(twice.applied, []);
    assert.deepEqual(twice.skipped, EDITS.map((e) => e.name));
});

test('embed stylesheet is injected once, inside head', () => {
    const { html } = applyEmbeddedSurface(APP_HTML);
    assert.equal(countOccurrences(html, EMBED_STYLESHEET), 1);
    const linkAt = html.indexOf(EMBED_STYLESHEET);
    assert.ok(linkAt > 0 && linkAt < html.indexOf('</head>'), 'stylesheet must land inside <head>');
});

test('a markup change that defeats the transform throws instead of degrading', () => {
    // Source absent AND result absent → app.html changed shape.
    const mangled = APP_HTML.replace(
        'class="settings-panel" id="settings-language"',
        'class="settings-panel" id="settings-locale"',
    );
    assert.throws(() => applyEmbeddedSurface(mangled), /promote-language-panel/);

    // Duplicated fragment → ambiguous target.
    const duplicated = APP_HTML.replace(
        '<button class="btn-sm danger" id="logoutBtn" data-i18n="登出">登出</button>',
        '<button class="btn-sm danger" id="logoutBtn" data-i18n="登出">登出</button>'.repeat(2),
    );
    assert.throws(() => applyEmbeddedSurface(duplicated), /matched 2 times/);
});

test('server.js routes embedded page loads through the transform', () => {
    assert.match(SERVER_JS, /require\('\.\/zephyr-one-embed-surface'\)/);
    assert.match(SERVER_JS, /applyEmbeddedSurface\(html\)/);
    // The old inline CSS-only injection must be gone, or it would shadow the
    // structural transform.
    assert.equal(
        SERVER_JS.includes("const inject = '<link rel=\"stylesheet\" href=\"/zephyr-one-embed.css\">'"),
        false,
        'inline stylesheet-only injection should be replaced by the transform',
    );
});

test('embedded mode skips the login page entirely', () => {
    // Root redirect: index.html's boot path is GET /api/auth/me -> redirect,
    // which would flash the credential wall for one frame.
    assert.match(SERVER_JS, /app\.get\(\['\/', '\/index\.html'\]/);
    assert.match(SERVER_JS, /return res\.redirect\('\/app\.html'\)/);

    // Local account adoption + the loopback pin that makes it safe.
    assert.match(SERVER_JS, /function adoptEmbeddedLocalSession/);
    assert.match(SERVER_JS, /app\.use\(adoptEmbeddedLocalSession\)/);
    assert.match(SERVER_JS, /mustChangePassword: false/);
    assert.match(SERVER_JS, /const EMBEDDED_LISTEN_HOST = ZEPHYR_ONE_EMBEDDED/);
    assert.match(SERVER_JS, /\? '127\.0\.0\.1'/);
});

test('stage script still hides the web-only settings tabs it owns', () => {
    // The transform removes the security tab structurally; the stylesheet
    // covers the multi-user / deployment tabs that stay in the DOM.
    for (const selector of ['admin', 'mail', 'beian']) {
        assert.ok(
            STAGE_SH.includes(`.settings-tab[data-settings="${selector}"]`),
            `embed CSS should hide the ${selector} settings tab`,
        );
    }
});

test('backup / restore stays reachable in One', () => {
    /* PRODUCT_REQUIREMENTS.md names 备份恢复 twice: in the required mobile
     * capability list, and again as "服务器设置和备份恢复保留；不能因为它们由
     * 主端执行就擅自从One移除". The tab acts on the local core's own
     * zephyr.db, so hiding it removed a contract capability. */
    assert.ok(
        !STAGE_SH.includes('.settings-tab[data-settings="data"]'),
        'embed CSS must not hide the data (backup/restore) tab button',
    );
    assert.ok(
        !STAGE_SH.includes('#settings-data'),
        'embed CSS must not hide the data (backup/restore) panel',
    );

    // The transform must not remove it structurally either.
    const removals = EDITS.filter((edit) => edit.to === '');
    for (const edit of removals) {
        assert.ok(
            !edit.from.includes('data-settings="data"'),
            `edit ${edit.name} must not delete the backup/restore tab`,
        );
    }

    // And it must survive the real transform end to end.
    const { html } = applyEmbeddedSurface(APP_HTML);
    assert.match(html, /<button class="settings-tab" data-settings="data"/);
    assert.match(html, /id="settings-data"/);
    assert.match(html, /id="exportDataBtn"/);
    assert.match(html, /id="importDataForm"/);
});
