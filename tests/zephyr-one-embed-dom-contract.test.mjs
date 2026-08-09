/*
 * The embed surface and app.js must agree about which elements exist.
 *
 * zephyr-one-embed-surface.js structurally removes the browser-era credential
 * surface from app.html before Zephyr One loads it -- password change, TOTP,
 * passkeys, CAPTCHA, IP policy, login events, the profile form: 43 element ids.
 * app.js is the same file in both products, and every binding for those ids was
 * written non-optionally, as `$('#id').addEventListener(...)` or
 * `$('#id').value = ...`.
 *
 * So in One the first of them threw `Cannot read properties of null` inside
 * bindEvents(), which aborted init() before applyAppearance() ever ran. Verified
 * in headless Chrome against a staged core: the static shell painted and nothing
 * else happened. That is what the packaged desktop app showed as a failed load,
 * and it is also why the header kept the emoji placeholder and the window title
 * stayed 'Zephyr' -- the branding code never executed.
 *
 * This test derives the removed ids from the real transform rather than a hand
 * list, so adding a removal to the transform without guarding its bindings fails
 * here instead of at runtime in the packaged app.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { applyEmbeddedSurface } = require(path.join(ROOT, 'zephyr-one-embed-surface.js'));

const APP_HTML = fs.readFileSync(path.join(ROOT, 'public', 'app.html'), 'utf8');
const APP_JS = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const LINES = APP_JS.split(/\r?\n/);

const ids = (html) => new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));

const REMOVED = [...ids(APP_HTML)].filter((id) => !ids(applyEmbeddedSurface(APP_HTML).html).has(id)).sort();

/** Enclosing top-level function declaration for a 0-based line index. */
const FUNC = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/;
function enclosingFunction(index) {
    for (let i = index; i >= 0; i -= 1) {
        const m = LINES[i].match(FUNC);
        if (m) return { name: m[1], line: i };
    }
    return { name: '(top level)', line: 0 };
}

/* A function is protected when it refuses to run without its surface, using the
 * house pattern already in updatePasswordFormFields(): look up, then bail.
 *
 * The window stops at the next top-level declaration. A fixed 3-line window let
 * the *following* function's guard count as this one's, so deleting the guard
 * from a one-line renderer stayed green -- renderPasskeys and
 * renderSecurityLists are adjacent one-liners and shielded each other.
 * Verified by mutation. */
function hasEntryGuard(declLine) {
    let end = declLine + 1;
    while (end < LINES.length && !FUNC.test(LINES[end])) end += 1;
    const body = LINES.slice(declLine, end).join('\n');
    return /if \(!\$\('#[\w-]+'\)\) return;/.test(body);
}

/* Inside bindEvents an access usually sits in a handler body, and a handler
 * cannot fire when the element it was bound to is absent. So the thing that has
 * to be optional is the registration, not the access.
 *
 * bindEvents' own statements are indented 4 spaces and handler bodies deeper, so
 * the owning statement is the nearest preceding line at exactly that depth. */
function owningRegistrationIsOptional(index) {
    /* A direct statement at bindEvents' own depth is not inside any handler, so
     * nothing shields it and it must be optional itself. */
    if (/^ {4}\S/.test(LINES[index])) return /\$\('#[\w-]+'\)\?\./.test(LINES[index]);

    for (let i = index - 1; i >= 0; i -= 1) {
        if (!/^ {4}\S/.test(LINES[i])) continue;
        return /\$\('#[\w-]+'\)\?\.addEventListener/.test(LINES[i]);
    }
    return false;
}

test('the embed transform still removes the credential surface', () => {
    /* If this ever reaches zero the rest of the file silently proves nothing. */
    assert.ok(
        REMOVED.length >= 40,
        `expected the transform to remove the credential surface, saw ${REMOVED.length} ids`,
    );
    for (const id of ['passwordForm', 'totpBox', 'passkeyList', 'captchaForm', 'profileForm']) {
        assert.ok(REMOVED.includes(id), `${id} is expected to be removed for One`);
    }
});

test('app.js never touches a removed element without guarding it', () => {
    /* The regression that shipped: 54 unguarded accesses across 10 functions,
     * the first of which aborted init(). */
    const unguarded = [];

    for (const id of REMOVED) {
        const pattern = new RegExp(String.raw`\$\('#${id}'\)\s*\.`);
        LINES.forEach((line, index) => {
            if (!pattern.test(line)) return;
            const fn = enclosingFunction(index);
            if (hasEntryGuard(fn.line)) return;
            if (fn.name === 'bindEvents' && owningRegistrationIsOptional(index)) return;
            unguarded.push(`  line ${index + 1} #${id} in ${fn.name}()\n      ${line.trim().slice(0, 120)}`);
        });
    }

    assert.equal(
        unguarded.length,
        0,
        'these would throw in Zephyr One, where the element does not exist:\n' + unguarded.join('\n'),
    );
});

test('the boot path applies branding before anything optional can fail', () => {
    /* applyAppearance() is what sets the header, the window title and the
     * favicon. It runs inside loadSettings(), which also fills the platform
     * security forms -- so an unguarded write there took the branding with it. */
    const loadSettings = APP_JS.slice(
        APP_JS.indexOf('async function loadSettings('),
        APP_JS.indexOf('function isNotesEnabled('),
    );
    assert.ok(loadSettings.length > 0, 'loadSettings must exist');
    assert.match(loadSettings, /applyAppearance\(settings\.appearance\)/);

    /* Writes into that surface must go through the null-safe helpers rather than
     * assigning to a possibly-null lookup. */
    assert.match(loadSettings, /setChecked\('#ipWhitelistEnabled'/);
    assert.match(loadSettings, /setVal\('#captchaSiteKey'/);
    assert.doesNotMatch(loadSettings, /\$\('#ipWhitelistEnabled'\)\.checked =/);
});

test('the null-safe helpers tolerate a missing element', () => {
    /* The REAL helper source is extracted from app.js and evaluated, rather than
     * retyped here. A test that re-implemented the helpers passed even when
     * withEl() stopped checking for null -- it was asserting its own copy, not
     * the shipped code. Verified by mutation.
     *
     * app.js cannot simply be imported: it is a browser module that pulls in
     * i18n, notes and a DOM on load. Slicing out the four helper declarations is
     * narrow enough to stay honest and needs no DOM. */
    const start = APP_JS.indexOf('const withEl =');
    const end = APP_JS.indexOf('function installClosestFallback');
    assert.ok(start > 0 && end > start, 'the helper block must be locatable');
    const source = APP_JS.slice(start, end);

    for (const name of ['withEl', 'setVal', 'setChecked']) {
        assert.match(source, new RegExp('const ' + name + ' ='), name + ' must exist');
    }

    /* Evaluated with a stub $ that reports every selector except one as absent,
     * which is exactly the shape One presents. */
    const factory = new Function('$', source + '\nreturn { withEl, setVal, setChecked };');
    const helpers = factory((sel) => (sel === '#present' ? { value: '', checked: false } : null));

    assert.equal(helpers.setVal('#absent', 'x'), null, 'a missing element must be skipped, not thrown on');
    assert.equal(helpers.setChecked('#absent', true), null);
    assert.equal(helpers.withEl('#absent', () => { throw new Error('must not run'); }), null);
    assert.equal(helpers.setVal('#present', 'x').value, 'x', 'a present element must still be written');
    assert.equal(helpers.setChecked('#present', true).checked, true);
});

test('One resolves its own brand name even though storage seeds Zephyr', () => {
    /* Supplying a default was not enough. storage.js seeds appearance.brandName
     * with the literal 'Zephyr', so `stored || default` never fired and One kept
     * showing the other product's name in the header and the window title.
     * Confirmed in headless Chrome before and after. */
    const storage = fs.readFileSync(path.join(ROOT, 'storage.js'), 'utf8');
    assert.match(storage, /brandName: 'Zephyr'/, 'the seeded value this must tolerate');

    const themeRuntime = fs.readFileSync(path.join(ROOT, 'public', 'theme-runtime.js'), 'utf8');
    assert.match(themeRuntime, /export function zephyrResolveBrandName\(stored\)/);
    assert.match(themeRuntime, /const SEEDED_BRAND_NAME = 'Zephyr';/);
    assert.match(
        themeRuntime,
        /if \(!text \|\| text === SEEDED_BRAND_NAME\) return zephyrDefaultBrandName\(\);/,
        'the seeded name must be treated as unchosen, matching how the icon already behaves',
    );

    assert.match(
        APP_JS,
        /const brandName = zephyrResolveBrandName\(appearance\.brandName\);/,
        'applyAppearance must resolve rather than default',
    );
    assert.doesNotMatch(
        APP_JS,
        /const brandName = String\(appearance\.brandName \|\| defaultBrandName\(\)\)/,
        'the old fallback could never fire against a seeded value',
    );
    assert.match(
        APP_JS,
        /^import \{[^}]*\bzephyrResolveBrandName\b[^}]*\} from '\.\/theme-runtime\.js/m,
        'and it must import the resolver',
    );
});
