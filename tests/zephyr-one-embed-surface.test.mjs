import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Zephyr One embedded surface: the browser-era credential wall must be gone.
 *
 * Zephyr One runs the core as a local child process on loopback, so password
 * rotation / TOTP / Passkey / login-email / IP-whitelist / CAPTCHA all
 * authenticate a *remote browser* client and are redundant there.
 *
 * They are replaced rather than merely removed. An earlier revision deleted the
 * Security tab outright, which left One with no security surface at all; the
 * transform now swaps that panel's body for One's single switch -- viewing a
 * stored password or private key requires a system unlock first -- which is the
 * only security decision One can actually enforce.
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

/**
 * Find places where `selector` is looked up and immediately dereferenced with a
 * plain `.`, which throws when the element is absent.
 *
 * Matches both spellings app.js uses, `$(sel)` and `document.querySelector(sel)`,
 * and treats `?.` as safe. Returns the offending member expressions so a failure
 * names what to fix rather than only counting.
 *
 * @param {string} source
 * @param {string} selector
 * @returns {string[]}
 */
function unguardedDereferences(source, selector) {
    const quoted = selector.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
    const pattern = new RegExp(
        `(?:\\$|document\\.querySelector)\\(\\s*(['"\`])${quoted}\\1\\s*\\)(\\s*\\.\\s*[A-Za-z_$][\\w$]*)`,
        'g',
    );
    return [...source.matchAll(pattern)].map(([, , member]) => member.replace(/\s+/g, ''));
}

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

test('transform replaces the security panel body and removes logout', () => {
    const { html, applied } = applyEmbeddedSurface(APP_HTML);

    // Every structural edit fired against real markup, plus the panel rebuild.
    assert.deepEqual(applied, [...EDITS.map((e) => e.name), 'replace-security-panel']);

    /* The tab stays. It is a valid landing target again, and app.js falls back
     * to clicking `[data-settings="security"]` in two places when the active tab
     * is hidden -- with the tab gone those fallbacks silently did nothing. */
    assert.match(html, /<button class="settings-tab active" data-settings="security"/);

    // One's switch is present, with the ids the overlay script binds to.
    assert.match(html, /id="oneSecurityPanel"/);
    assert.match(html, /id="oneRevealRequiresUnlock"/);
    assert.match(html, /id="oneSecurityTestUnlock"/);

    /* Every browser-era account card is gone from the DOM, not merely hidden:
     * app.js reaches into these by id, and a CSS-hidden node still matches. */
    for (const id of ['passwordForm', 'profileForm', 'totpAction', 'addPasskeyBtn',
        'notifyLoginPersonal', 'platformSecuritySettings', 'securityPolicyForm']) {
        assert.equal(
            html.includes(`id="${id}"`),
            false,
            `${id} authenticates a remote browser client and must not survive into One`,
        );
    }

    // Logout is gone: the shell re-adopts the local account on the next
    // request, so logging out either bounces back in or looks broken.
    assert.equal(html.includes('id="logoutBtn"'), false);
});

test('Settings lands on a real panel instead of a hidden one', () => {
    const { html } = applyEmbeddedSurface(APP_HTML);

    // Exactly one active tab and one active panel, and they agree.
    assert.equal(countOccurrences(html, 'class="settings-tab active"'), 1);
    assert.equal(countOccurrences(html, 'class="settings-panel active"'), 1);
    assert.match(html, /<button class="settings-tab active" data-settings="security"/);
    assert.match(html, /class="settings-panel active" id="settings-security"/);

    /* And the panel it lands on has content. This is the assertion that would
     * have caught the earlier bug in the opposite direction: leaving security
     * active while the stage stylesheet hid it showed a blank pane. */
    const at = html.indexOf('class="settings-panel active" id="settings-security"');
    const panel = html.slice(at, html.indexOf('id="settings-appearance"', at));
    assert.match(panel, /id="oneRevealRequiresUnlock"/, 'the landing panel must not be empty');
});

test('the security panel is the landing target in both products', () => {
    /* app.html ships #settings-security as the default-active panel and its tab
     * as the default-active tab. One keeps both and rebuilds the body, so this
     * records the shared starting point the transform relies on. */
    assert.match(APP_HTML, /class="settings-panel active" id="settings-security"/);
    assert.match(APP_HTML, /<button class="settings-tab active" data-settings="security"/);

    // And app.js really does fall back to that exact tab, in two places. With
    // the tab removed those fallbacks resolved to null and silently did nothing.
    assert.equal(APP_JS.includes('.settings-tab[data-settings="security"]'), true);

    /* The hazard is now the reverse of the one an earlier revision hit: leaving
     * the panel active while the stage stylesheet hides it shows a blank pane.
     * The stylesheet must therefore NOT hide it. */
    assert.equal(
        STAGE_SH.includes('#settings-security {'),
        false,
        'embed CSS must not hide the panel One now uses for its own security switch',
    );
    assert.equal(
        STAGE_SH.includes('#settings-security,'),
        false,
        'embed CSS must not hide #settings-security as part of a selector list either',
    );
});

test('transform is idempotent', () => {
    const once = applyEmbeddedSurface(APP_HTML).html;
    const twice = applyEmbeddedSurface(once);
    assert.equal(twice.html, once);
    // Second pass finds results already in place rather than sources. The panel
    // rebuild detects its own marker and reports itself skipped for the same
    // reason, so a double-applied transform cannot nest two switches.
    assert.deepEqual(twice.applied, []);
    assert.deepEqual(twice.skipped, [...EDITS.map((e) => e.name), 'replace-security-panel']);
    assert.equal(countOccurrences(twice.html, 'id="oneRevealRequiresUnlock"'), 1);
});

test('embed stylesheet is injected once, inside head', () => {
    const { html } = applyEmbeddedSurface(APP_HTML);
    assert.equal(countOccurrences(html, EMBED_STYLESHEET), 1);
    const linkAt = html.indexOf(EMBED_STYLESHEET);
    assert.ok(linkAt > 0 && linkAt < html.indexOf('</head>'), 'stylesheet must land inside <head>');
});

test('a markup change that defeats the transform throws instead of degrading', () => {
    /* Source absent AND result absent -> app.html changed shape. Asserted on
     * `rename-agent-tab`, which is a real remaining edit; the language-promotion
     * edits this used to target were removed when security became the landing
     * panel again, and an assertion against a deleted edit would pass for the
     * wrong reason. */
    const mangled = APP_HTML.replace(
        '<button class="settings-tab" data-settings="agent" data-i18n="Zephyr Client">Zephyr Client</button>',
        '<button class="settings-tab" data-settings="client" data-i18n="Zephyr Client">Zephyr Client</button>',
    );
    assert.throws(() => applyEmbeddedSurface(mangled), /rename-agent-tab/);

    // Duplicated fragment -> ambiguous target.
    const duplicated = APP_HTML.replace(
        '<button class="btn-sm danger" id="logoutBtn" data-i18n="\u767b\u51fa">\u767b\u51fa</button>',
        '<button class="btn-sm danger" id="logoutBtn" data-i18n="\u767b\u51fa">\u767b\u51fa</button>'.repeat(2),
    );
    assert.throws(() => applyEmbeddedSurface(duplicated), /matched 2 times/);

    /* And the panel rebuild fails loudly rather than leaving the browser-era
     * account cards in place: showing One a password-change form for a password
     * its user never chose is exactly the silent degradation to avoid. */
    const noPanel = APP_HTML.replace(
        '<div class="settings-panel active" id="settings-security">',
        '<div class="settings-panel active" id="settings-account">',
    );
    assert.throws(() => applyEmbeddedSurface(noPanel), /security panel open tag not found/);
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

test('app.js never dereferences an element the transform removes', () => {
    /* The regression this locks down took the whole product surface down.
     *
     * `drop-logout-button` deletes #logoutBtn from app.html, but bindEvents()
     * still ran `$('#logoutBtn').addEventListener(...)`. In browser Zephyr the
     * element exists so the call is fine; inside One it resolves to null and
     * throws, and because bindEvents() is a single statement sequence called
     * from init(), everything after that line never ran: the header brand mark
     * kept app.html's literal emoji instead of the One wind-mark, and the rest
     * of the app's event wiring was silently dead. The favicon still updated,
     * which is why the failure looked like "wrong icon" rather than "crash".
     *
     * Derived from EDITS rather than a hand-written list so a future removal
     * edit is covered the moment it is added.
     */
    const removed = EDITS.filter((edit) => edit.to === '');
    assert.ok(removed.length > 0, 'at least one edit must remove an element');

    const selectors = [];
    for (const edit of removed) {
        for (const [, id] of edit.from.matchAll(/id="([^"]+)"/g)) {
            selectors.push(`#${id}`);
        }
        for (const [, value] of edit.from.matchAll(/data-settings="([^"]+)"/g)) {
            selectors.push(`[data-settings="${value}"]`);
        }
    }
    assert.ok(selectors.length > 0, 'removal edits must name at least one selector');

    for (const selector of selectors) {
        assert.deepEqual(
            unguardedDereferences(APP_JS, selector),
            [],
            `app.js must not dereference ${selector} without optional chaining: ` +
                'the embedded surface removes it, so the lookup is null inside One',
        );
    }
});

test('the unguarded-dereference detector actually catches the shipped bug', () => {
    /* Without this, the assertion above would pass just as happily against a
     * detector that never matches anything. Re-introduce the exact expression
     * that broke One and require the detector to report it. */
    const reintroduced = APP_JS.replace(
        "$('#logoutBtn')?.addEventListener(",
        "$('#logoutBtn').addEventListener(",
    );
    assert.notEqual(reintroduced, APP_JS, 'guarded logout binding should exist to un-guard');
    assert.deepEqual(unguardedDereferences(reintroduced, '#logoutBtn'), ['.addEventListener']);

    // querySelector spelling is caught too, not just the `$` helper.
    const viaQuerySelector = `document.querySelector('#logoutBtn').click();`;
    assert.deepEqual(unguardedDereferences(viaQuerySelector, '#logoutBtn'), ['.click']);

    // Optional chaining and a bare lookup are both fine.
    assert.deepEqual(unguardedDereferences(`$('#logoutBtn')?.focus();`, '#logoutBtn'), []);
    assert.deepEqual(unguardedDereferences(`const el = $('#logoutBtn');`, '#logoutBtn'), []);
});
