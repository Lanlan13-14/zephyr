import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { applyEmbeddedSurface } = require('../zephyr-one-embed-surface.js');

/** Every form of i18n key attribute applyDomI18n() honours in app.html. */
const I18N_ATTRS = ['data-i18n', 'data-i18n-placeholder', 'data-i18n-title', 'data-i18n-aria-label'];

/** Collect every i18n key referenced by an HTML string. */
function i18nKeysIn(html) {
    const keys = new Set();
    for (const attr of I18N_ATTRS) {
        const re = new RegExp(`${attr}="([^"]*)"`, 'g');
        for (const m of html.matchAll(re)) {
            if (m[1]) keys.add(m[1]);
        }
    }
    return keys;
}

/**
 * RDP editor: Zephyr Agent's folder share, folded into the RDP settings panel.
 *
 * Scope is deliberately narrow. Of the Agent's connection settings only the
 * mapped folder and the device name carry over. The Agent's main-server
 * address, Token, auto-shutdown timer and read/write permission rows are
 * absent on purpose: inside an RDP session the mapping target *is* the
 * session, so there is nothing to address, authenticate or time out.
 *
 * The fields are inert inside app.js by design, because app.js is shared with
 * browser Zephyr. In the One shell the injected overlay
 * (zephyr-one-rdp-settings.js) owns the handlers and the device-local
 * persistence; see tests/zephyr-one-rdp-folder-mapping.test.mjs. The
 * device-local assertion below records that split so it stays a decision on
 * record rather than drifting into app.js later.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/* Normalised to LF. The working tree is CRLF on Windows (core.autocrlf=true),
 * and several assertions below slice on a '\n}' needle to bound a function
 * body. Against CRLF that needle never matches, indexOf returns -1, and the
 * slice silently collapses to two characters — the assertion then fails on a
 * truncated string instead of on the code it was written to check. */
const read = (rel) => readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');

const APP_HTML = read('public/app.html');
const ONE_HTML = applyEmbeddedSurface(APP_HTML).html;
const APP_JS = read('public/app.js');
const STYLE_CSS = read('public/style.css');
const ONE_CSS = read('zephyr-one-embed.css');
const ONE_RDP_SETTINGS = read('zephyr-one-rdp-settings.js');
const BROWSER_SMOKE = read('tests/rdp-folder-mapping-browser-smoke.html');
const STATIC_SMOKE_SERVER = read('tests/static-smoke-server.mjs');
const ZH = JSON.parse(read('public/i18n/locales/zh-CN.json'));
const EN = JSON.parse(read('public/i18n/locales/en.json'));

/** Slice the #rdpSettingsPanel element out of app.html by tag balance. */
function rdpPanel(html = ONE_HTML) {
    const at = html.indexOf('id="rdpSettingsPanel"');
    assert.ok(at > 0, '#rdpSettingsPanel must exist');
    const open = html.lastIndexOf('<section', at);
    let i = open;
    let depth = 0;
    while (i < html.length) {
        const nextOpen = html.indexOf('<section', i + 1);
        const nextClose = html.indexOf('</section>', i + 1);
        assert.ok(nextClose !== -1, '#rdpSettingsPanel must be closed');
        if (nextOpen !== -1 && nextOpen < nextClose) {
            depth += 1;
            i = nextOpen;
            continue;
        }
        if (depth === 0) return html.slice(open, nextClose + '</section>'.length);
        depth -= 1;
        i = nextClose;
    }
    throw new Error('unbalanced <section> around #rdpSettingsPanel');
}

/** Direct element children of the panel, in document order. */
function panelChildren() {
    const panel = rdpPanel();
    const body = panel.slice(panel.indexOf('>') + 1);
    const out = [];
    let depth = 0;
    const tag = /<(\/?)([a-z0-9]+)([^>]*)>/gi;
    let m;
    while ((m = tag.exec(body))) {
        const [full, slash, name, attrs] = m;
        const selfClosing = attrs.trim().endsWith('/')
            || ['input', 'br', 'hr', 'img', 'link', 'meta'].includes(name.toLowerCase());
        if (slash) { depth -= 1; continue; }
        if (depth === 0) {
            out.push({
                name: name.toLowerCase(),
                cls: (attrs.match(/class="([^"]*)"/) || [, ''])[1],
                id: (attrs.match(/\bid="([^"]*)"/) || [, ''])[1],
            });
        }
        if (!selfClosing) depth += 1;
        void full;
    }
    return out;
}

test('browser RDP storage keeps the v1.1.500 online Zephyr Agent contract', () => {
    const panel = rdpPanel(APP_HTML);

    assert.match(panel, /data-i18n="Zephyr Agent 存储（磁盘映射）">Zephyr Agent 存储（磁盘映射）</);
    assert.match(panel, /data-i18n="需 Agent 在线">需 Agent 在线</);
    assert.match(panel, /id="rdpStorage"/);
    for (const oneOnlyId of ['rdpStorageDetail', 'rdpStorageFolder', 'rdpStorageFolderPickBtn', 'rdpStorageDeviceName']) {
        assert.equal(panel.includes(oneOnlyId), false, `${oneOnlyId} must stay out of browser Zephyr`);
    }
    assert.equal(panel.includes('data-i18n="文件夹映射"'), false);
    assert.equal(panel.includes('data-i18n="会话内以磁盘形式访问"'), false);
});

test('Zephyr One replaces the Agent row with its native folder controls', () => {
    const panel = rdpPanel();
    assert.equal(panel.includes('Zephyr Agent'), false, 'RDP panel must not say "Zephyr Agent"');
    assert.equal(panel.includes('需 Agent 在线'), false, 'the Agent-online hint must be gone');
    assert.match(panel, /data-i18n="文件夹映射">文件夹映射</);
    assert.match(panel, /data-i18n="会话内以磁盘形式访问"/);
    assert.match(panel, /id="rdpStorage"/);
});

test('the layout smoke exercises transformed One markup, not browser markup', () => {
    assert.match(BROWSER_SMOKE, /getSync\('\/__zephyr-one-app\.html'\)/);
    assert.match(STATIC_SMOKE_SERVER, /applyEmbeddedSurface\(source\)\.html/);
    assert.equal(BROWSER_SMOKE.includes("getSync('/public/app.html')"), false);
});

test('the detail block carries exactly the two fields that transfer from Agent', () => {
    const panel = rdpPanel();

    // Present: mapped folder (picker-driven, hence readonly) + device name.
    assert.match(panel, /id="rdpStorageFolder"[^>]*\breadonly\b/);
    assert.match(panel, /id="rdpStorageFolderPickBtn"/);
    assert.match(panel, /id="rdpStorageDeviceName"/);
    assert.match(panel, /data-i18n="映射文件夹">映射文件夹</);
    assert.match(panel, /data-i18n="设备名称">设备名称</);

    // Absent by design. Each of these is an Agent setting that has no meaning
    // for a folder mapped into an RDP session.
    for (const dropped of ['主端地址', 'Token', '自动关闭', '只读', '读写', '延长']) {
        assert.equal(
            panel.includes(dropped),
            false,
            `"${dropped}" is an Agent-only setting and must not appear in the RDP panel`,
        );
    }
    for (const droppedId of ['rdpStorageToken', 'rdpStorageServerUrl', 'rdpStorageAutoShutdown', 'rdpStorageReadOnly']) {
        assert.equal(panel.includes(droppedId), false, `${droppedId} must not exist`);
    }
});

test('the detail block is the immediate next sibling of its own toggle row', () => {
    /* Load-bearing for the CSS fallback: the `:has(#rdpStorage:checked) + …`
     * rule only matches an *adjacent* sibling. If markup drifts so the detail
     * is no longer directly after the storage row, the fallback silently dies
     * and only the JS class path keeps working. */
    const kids = panelChildren();
    const detailAt = kids.findIndex((k) => k.id === 'rdpStorageDetail');
    assert.ok(detailAt > 0, 'rdpStorageDetail must be a direct child of the panel');

    const prev = kids[detailAt - 1];
    assert.equal(prev.cls.includes('rdp-toggle-row'), true, 'previous sibling must be a toggle row');

    const panel = rdpPanel();
    const rowAt = panel.indexOf('id="rdpStorage"');
    const detailAttrAt = panel.indexOf('id="rdpStorageDetail"');
    assert.ok(rowAt > 0 && detailAttrAt > rowAt, 'the storage toggle must precede the detail block');

    /* Measure to the detail element's *tag start*, not its id attribute —
     * otherwise the detail's own `<div` lands inside the measured gap and
     * reports a phantom intervening element. */
    const rowCloseAt = panel.indexOf('</div>', rowAt);
    const detailTagAt = panel.lastIndexOf('<div', detailAttrAt);
    assert.ok(detailTagAt > rowCloseAt, 'detail tag must open after the row closes');

    const between = panel.slice(rowCloseAt + '</div>'.length, detailTagAt);
    assert.equal(between.trim(), '',
        'only whitespace may sit between the storage toggle row and the detail block');
});

test('collapse is animated, and animatable — not a display toggle', () => {
    const at = ONE_CSS.indexOf('.rdp-storage-detail {');
    assert.ok(at > 0, '.rdp-storage-detail rule must exist');
    const block = ONE_CSS.slice(at, at + 2600);

    // `display:none` is not animatable, which is why the other conditional
    // rows in this panel snap. grid-template-rows 0fr→1fr gives a real
    // auto-height collapse with no hard-coded max-height to drift.
    assert.match(block, /\.rdp-storage-detail \{[^}]*display: grid/);
    assert.match(block, /\.rdp-storage-detail \{[^}]*grid-template-rows: 0fr/);
    assert.match(block, /transition:[^;]*grid-template-rows/);
    assert.equal(/\.rdp-storage-detail \{[^}]*display: none/.test(block), false);

    // Open state reachable two ways: the JS class (primary) and :has() (CSS
    // fallback). Both must set the same declarations.
    assert.match(block, /\.rdp-storage-detail\.is-open,/);
    assert.match(block, /\.rdp-toggle-row:has\(#rdpStorage:checked\) \+ \.rdp-storage-detail/);
    const openRule = block.slice(block.indexOf('.rdp-storage-detail.is-open,'));
    assert.match(openRule, /grid-template-rows: 1fr/);

    // The inner wrapper must clip, or fields paint outside the collapsed track.
    assert.match(block, /\.rdp-storage-detail-inner \{[^}]*overflow: hidden/);
    assert.match(block, /\.rdp-storage-detail-inner \{[^}]*min-height: 0/);

    // Reduced motion collapses the duration rather than removing the mechanism.
    const rm = ONE_CSS.slice(at, at + 3200);
    assert.match(rm, /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,200}\.rdp-storage-detail/);
});

test('the JS toggle exists only in the One overlay', () => {
    /* :has() alone was not trusted here: it is the only place in this panel
     * where a *sibling* is restyled from a checkbox, and the repo's own
     * precedent for conditional rows (updateRdpTouchSettingsUi) is an explicit
     * classList.toggle. The class path is primary; :has() is a fallback. */
    assert.equal(APP_JS.includes('updateRdpStorageDetailUi'), false);
    assert.match(ONE_RDP_SETTINGS, /function updateStorageDetailUi\(\) \{/);
    const body = ONE_RDP_SETTINGS.slice(ONE_RDP_SETTINGS.indexOf('function updateStorageDetailUi()'));
    const fn = body.slice(0, body.indexOf('\n    }\n') + '\n    }'.length);

    assert.match(fn, /var open = !!toggle\.checked/);
    assert.match(fn, /classList\.toggle\('is-open', open\)/);
    // Collapsed fields must leave the tab order, or focus scrolls a clipped
    // region into view and traps the user in invisible inputs.
    assert.match(fn, /\.inert = !open/);
    assert.match(fn, /aria-hidden/);

    // Wired at both points: live toggling, and restoring a saved connection.
    assert.match(ONE_RDP_SETTINGS, /toggle\.addEventListener\('change'/);
    assert.match(ONE_RDP_SETTINGS, /if \(open && !wasOpen\) \{[\s\S]{0,160}updateStorageDetailUi\(\)/);
});

/** Assert one key is present in both catalogues and correctly shaped. */
function assertKeyResolves(key) {
    assert.ok(Object.prototype.hasOwnProperty.call(ZH, key), `zh-CN.json missing ${key}`);
    assert.ok(Object.prototype.hasOwnProperty.call(EN, key), `en.json missing ${key}`);
    // zh-CN is the source language and must stay a strict identity map.
    assert.equal(ZH[key], key, `zh-CN.json must map ${key} to itself`);
    // A copied Chinese value in en.json renders Chinese to English users;
    // scripts/audit-i18n.py fails on exactly this.
    assert.notEqual(EN[key], key, `en.json value for ${key} must be a real translation`);
}

test('every i18n key the One transform introduces resolves in both locales', () => {
    /* scripts/audit-i18n.py only scans static files under public/. The One
     * surface is produced by applyEmbeddedSurface() at request time, so any key
     * the transform introduces is invisible to that audit and would render as
     * raw Chinese to English users. Derive the set by diffing the transform's
     * output against its input rather than hard-coding a list, so a key added
     * to the transform later is covered without editing this test. */
    const before = i18nKeysIn(APP_HTML);
    const { html: after } = applyEmbeddedSurface(APP_HTML);
    const introduced = [...i18nKeysIn(after)].filter((k) => !before.has(k));

    assert.ok(
        introduced.length > 0,
        'the transform is expected to introduce at least one key; if it stopped, '
        + 'this test has gone vacuous and must be revisited',
    );
    assert.ok(introduced.includes('文件同步'), 'the File-sync rename must be among them');

    for (const key of introduced) assertKeyResolves(key);
});

test('browser and One storage labels resolve in both locales', () => {
    const keys = [
        'Zephyr Agent 存储（磁盘映射）', '需 Agent 在线',
        '文件夹映射', '会话内以磁盘形式访问', '映射文件夹',
        '尚未选择文件夹', '选择文件夹', '设备名称', '例如：我的电脑',
        '远程会话里显示的磁盘名称。',
    ];
    // These live in static markup, so audit-i18n.py sees them too; this test
    // fails faster and names the key, which the audit's bulk output does not.
    for (const key of keys) {
        assertKeyResolves(key);
    }
});


test('the mapping is device-local: absent from the synced record and from shared app.js', () => {
    /* Two deliberate absences, both still load-bearing now that the wiring
     * exists.
     *
     * connectionPayload() is what gets persisted to and synced from the
     * server. The mapped folder is a path on *this* device, so putting it
     * there would publish a meaningless (and on a shared connection,
     * misleading) path to every other device. One keeps it device-local
     * instead, keyed by connection id, in zephyr-one-rdp-storage.js.
     *
     * app.js leaves the three controls unhandled because it is shared with
     * browser Zephyr, where there is no local filesystem to enumerate and the
     * /api/one/rdp/* endpoints are not mounted at all. The handlers live in
     * the One-only overlay (zephyr-one-rdp-settings.js) that
     * applyEmbeddedSurface() injects; the overlay side is covered by
     * tests/zephyr-one-rdp-folder-mapping.test.mjs. A handler appearing here
     * would mean a pick button that 404s for every browser user. */
    const payloadAt = APP_JS.indexOf('function connectionPayload(');
    assert.ok(payloadAt > 0);
    const payload = APP_JS.slice(payloadAt, payloadAt + 6000);
    assert.equal(payload.includes('rdpStorageFolder'), false);
    assert.equal(payload.includes('rdpStorageDeviceName'), false);

    assert.equal(APP_JS.includes("$('#rdpStorageFolderPickBtn')"), false);
    assert.equal(APP_JS.includes('rdpStorageFolderPickBtn'), false);
});

test('opening the detail hides only its own row hairline, without reflow', () => {
    /* Every .rdp-toggle-row draws a border-bottom. The detail block is inserted
     * directly after the storage row, so with that border left alone a hairline
     * sits between the switch and the fields it owns, reading as two unrelated
     * rows. This is a regression the detail block introduced, not a pre-existing
     * quirk, so the fix belongs with it.
     *
     * The browser smoke (npm run test:folder-mapping-browser) proves the
     * rendered result — alpha 0.1 -> 0 with row height unchanged at 53px. This
     * static test exists so the rule cannot be deleted in a Chromium-less run. */
    const base = STYLE_CSS.match(/\.rdp-toggle-row \{[^}]*\}/);
    assert.ok(base, '.rdp-toggle-row base rule must exist');
    assert.match(base[0], /border-bottom:\s*1px solid/,
        'the fix assumes the row draws a 1px bottom border');

    const rule = ONE_CSS.match(
        /\.rdp-toggle-row\.is-open,\s*\n\.rdp-toggle-row:has\(#rdpStorage:checked\) \{[^}]*\}/,
    );
    assert.ok(rule, 'the open-row rule must cover both the class and :has() paths');

    /* border-bottom-color, not border-bottom / border-bottom-width: collapsing
     * the 1px would move every row below by a pixel when the panel opens. The
     * smoke asserts this too (closedRowH 53 === openRowH 53). */
    assert.match(rule[0], /border-bottom-color:\s*transparent/);
    assert.equal(/border-bottom:\s*none/.test(rule[0]), false,
        'border-bottom: none removes the 1px and shifts layout');
    assert.equal(/border-bottom-width/.test(rule[0]), false,
        'changing width shifts layout; only the colour may change');

    // Scoped: a bare `.rdp-toggle-row { border-bottom-color: transparent }`
    // would erase every divider in the panel, not just this one.
    assert.equal(
        /(^|\n)\.rdp-toggle-row \{[^}]*border-bottom-color:\s*transparent/.test(ONE_CSS),
        false,
        'the base row rule must not be the one going transparent',
    );

    // The JS path must reach the row, not only the detail, or the class half of
    // the rule above is dead on engines where :has() is unavailable.
    const fnAt = ONE_RDP_SETTINGS.indexOf('function updateStorageDetailUi()');
    const fn = ONE_RDP_SETTINGS.slice(fnAt, ONE_RDP_SETTINGS.indexOf('\n    }', fnAt));
    assert.match(fn, /closest\('\.rdp-toggle-row'\)/);
    assert.match(fn, /row\.classList\.toggle\('is-open', open\)/,
        'the toggle must put is-open on the row that owns the checkbox');
    /* closest() rather than previousElementSibling: if the markup ever drifts so
     * the detail is no longer adjacent, closest() still finds the right row,
     * while previousElementSibling would silently style an unrelated one. */
    assert.equal(fn.includes('previousElementSibling'), false);
});
