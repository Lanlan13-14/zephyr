import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('login locale selects become toggle-selects with motion open/close', () => {
    const js = read('public/client.js');
    assert.match(js, /function enhanceLoginToggleSelect\(select\)/);
    assert.match(js, /function openLoginToggleMenu\(shell\)/);
    assert.match(js, /function closeLoginToggleMenu\(shell\)/);
    assert.match(js, /function syncLoginToggleFace\(select\)/);
    assert.match(js, /import\('\.\/vendor\/zephyr-motion\/index\.js\?v=20260726-password-code-layout1'\)/);
    assert.match(js, /preset: 'mac',/);
    assert.match(js, /\{ preset: 'macClose' \}/);
    assert.match(js, /Motion\.setOriginFromAnchor\?\.\(menu, trigger\)/);
    assert.match(js, /shell\.className = 'ui-toggle-select login-locale-select';/);
    /* All four login-page cards get enhanced at boot. */
    assert.match(js, /enhanceLoginLocaleSelects\(\);/);
    /* Engine is warmed at idle so the FIRST open animates identically to
     * later ones (lazy import would pop statically, then restart the FLIP). */
    assert.match(js, /requestIdleCallback\(warmLoginMotion, \{ timeout: 2500 \}\)/);
    assert.match(js, /setTimeout\(warmLoginMotion, 800\)/);
    for (const id of ['#localeSelectLogin', '#localeSelectTotp', '#localeSelectForgot', '#localeSelectChange']) {
        assert.ok(js.includes(`'${id}'`), id);
    }
});

test('login toggle re-click closes, outside click and Escape close too', () => {
    const js = read('public/client.js');
    /* Trigger handler toggles: willOpen false → closeToggleSelectMenu path. */
    assert.match(js, /const willOpen = !shell\.classList\.contains\('open'\);/);
    assert.match(js, /if \(willOpen\) openLoginToggleMenu\(shell\);\s*else closeLoginToggleMenu\(shell\);/);
    assert.match(js, /if \(!e\.target\.closest\?\.\('\.login-locale-select\.ui-toggle-select'\)\) closeAllLoginToggleSelects\(\);/);
    assert.match(js, /if \(e\.key === 'Escape'\) closeAllLoginToggleSelects\(\);/);
    /* Programmatic locale sync must refresh the custom face too. */
    assert.match(js, /syncLoginToggleFace\(el\);/);
    /* Selecting an option still drives the native select + change event. */
    assert.match(js, /select\.dispatchEvent\(new Event\('change', \{ bubbles: true \}\)\);/);
});

test('login toggle reuses the global trigger/menu styles (no custom pill look)', () => {
    const css = read('public/style.css');
    assert.match(css, /\.login-locale-select\.ui-toggle-select \{ width: auto; \}/);
    assert.match(css, /\.login-locale-select \.ui-toggle-select-menu \{ min-width: 132px; \}/);
    /* No pill radius or bespoke trigger overrides — identical to in-app selects. */
    const loginBlock = css.slice(css.indexOf('.login-locale-select'), css.indexOf('.login-locale-select') + 600);
    assert.doesNotMatch(loginBlock, /border-radius: 999px/);
    assert.doesNotMatch(loginBlock, /\.login-locale-select \.ui-toggle-select-trigger \{/);
});

test('settings language select and proxy type select join the motion open/close list', () => {
    const js = read('public/app.js');
    const listStart = js.indexOf('const MOTION_FILTER_SELECT_IDS = [');
    const listEnd = js.indexOf('];', listStart);
    const list = js.slice(listStart, listEnd);
    for (const id of ['languageSelect', 'proxyType', 'protocolFilter', 'captchaProvider']) {
        assert.ok(list.includes(`'${id}'`), `MOTION_FILTER_SELECT_IDS missing ${id}`);
    }
});

test('rollback page contract test revision stays in sync', () => {
    const js = read('public/password-rollback.js');
    assert.match(js, /i18n\/runtime\.js\?v=20260726-password-code-layout1/);
});
