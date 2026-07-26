import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appJs = readFileSync(path.join(root, 'public/app.js'), 'utf8');
const styleCss = readFileSync(path.join(root, 'public/style.css'), 'utf8');
const appHtml = readFileSync(path.join(root, 'public/app.html'), 'utf8');

function extractFn(src, name) {
    const re = new RegExp(`function ${name}\\s*\\(`);
    const m = re.exec(src);
    assert.ok(m, `${name} missing`);
    const brace = src.indexOf('{', m.index);
    let depth = 0;
    for (let j = brace; j < src.length; j++) {
        const c = src[j];
        if (c === '{') depth++;
        else if (c === '}') {
            depth--;
            if (depth === 0) return src.slice(m.index, j + 1);
        }
    }
    throw new Error(`failed to extract ${name}`);
}

test('motion opt-in set covers dashboard filters + settings/appearance/terminal selects', () => {
    const m = appJs.match(/const MOTION_FILTER_SELECT_IDS = \[([\s\S]*?)\];/);
    assert.ok(m, 'MOTION_FILTER_SELECT_IDS missing');
    const ids = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    const expected = [
        'protocolFilter', 'tagFilter', 'sortSelect',
        'captchaProvider',
        'colorSchemeSelect', 'themeModeSelect', 'terminalBgSource', 'terminalBgFit',
        'terminalMaxWindows', 'terminalSmartbarOrder', 'terminalShortcutPlatform',
        'aiDefaultProvider', 'aiProviderType', 'aiProviderApiMode', 'aiProviderReasoningEffort',
        // 设置 → 语言 与 代理弹窗 → 类型（2026-07-26 起与首页筛选同一套动画）
        'languageSelect', 'proxyType',
    ];
    assert.deepEqual(ids.sort(), expected.sort());
    // Connection modal selects must NOT opt in.
    assert.ok(!ids.includes('connProtocol'));
    assert.ok(!ids.includes('connSshKey'));
});

test('open uses Motion.morph with mac preset from trigger rect (demo §3 parity)', () => {
    const openFn = extractFn(appJs, 'openToggleSelectMenu');
    assert.match(openFn, /sshKeyMotion\._ensure\(\)/);
    assert.match(openFn, /trigger\.getBoundingClientRect\(\)/);
    assert.match(openFn, /Motion\.morph\(menu, from, \{/);
    assert.match(openFn, /preset:\s*'mac'/);
    assert.match(openFn, /radiusCompensate:\s*true/);
    assert.match(openFn, /opacityFrom:\s*0\.92/);
    assert.match(openFn, /opacityTo:\s*1/);
    assert.match(openFn, /forceFrom:\s*!midFlight/);
    // interrupt token
    assert.match(openFn, /shell\._menuToken/);
    // mid-flight reopen must not hide the menu (anti-flicker)
    assert.match(openFn, /if \(!midFlight\) \{[\s\S]*?visibility = 'hidden'/);
});

test('close uses setOriginFromAnchor + macClose scale-down fade (demo §3 parity)', () => {
    const closeFn = extractFn(appJs, 'closeToggleSelectMenu');
    assert.match(closeFn, /setOriginFromAnchor\?\.\(menu, trigger\)/);
    assert.match(closeFn, /Motion\.to\(menu, \{ opacity: 0, scale: 0\.94, y: -8, x: 0, blur: 0 \}, \{ preset: 'macClose' \}\)/);
    assert.match(closeFn, /menu-closing/);
    // engine not lazy-loaded on close (no flash of async init)
    assert.match(closeFn, /sshKeyMotion\.engine/);
    assert.doesNotMatch(closeFn, /_ensure\(\)/);
    // cleanup resets transform state so next open measures cleanly
    assert.match(closeFn, /Motion\.set\(menu, \{ x: 0, y: 0, scaleX: 1, scaleY: 1, scale: 1, opacity: 1, blur: 0, radius: 0 \}\)/);
    assert.match(closeFn, /menu\.style\.transform = ''/);
});

test('trigger/menu click routes through open/close helpers; no direct classList.toggle', () => {
    assert.match(appJs, /if \(willOpen\) openToggleSelectMenu\(shell\);\s*else closeToggleSelectMenu\(shell\);/);
    assert.match(appJs, /syncToggleSelectFace\(select\);\s*closeToggleSelectMenu\(shell\);/);
    const triggerBlock = appJs.match(/trigger\.addEventListener\('click'[\s\S]*?\}\);/);
    assert.ok(triggerBlock, 'trigger click handler present');
    assert.doesNotMatch(triggerBlock[0], /classList\.toggle\('open'/);
});

test('non-motion shells keep instant behavior via isMotionFilterShell guard', () => {
    assert.match(appJs, /function isMotionFilterShell\(shell\)/);
    assert.match(appJs, /MOTION_FILTER_SELECT_IDS\.includes\(shell\.dataset\?\.selectId/);
    /* Engine warmed at idle: first open animates like later ones. */
    assert.match(appJs, /requestIdleCallback\(warmSelectMotion, \{ timeout: 4000 \}\)/);
    assert.match(appJs, /setTimeout\(warmSelectMotion, 2000\)/);
    const openFn = extractFn(appJs, 'openToggleSelectMenu');
    const closeFn = extractFn(appJs, 'closeToggleSelectMenu');
    assert.match(openFn, /if \(!isMotionFilterShell\(shell\)\)/);
    assert.match(closeFn, /!isMotionFilterShell\(shell\)/);
});

test('CSS keeps menu displayed during close animation and blocks interaction', () => {
    assert.match(styleCss, /\.ui-toggle-select\.menu-closing \.ui-toggle-select-menu\s*\{[\s\S]*?display:\s*grid/);
    assert.match(styleCss, /\.ui-toggle-select\.menu-closing \.ui-toggle-select-menu\s*\{[\s\S]*?pointer-events:\s*none/);
    assert.match(styleCss, /will-change:\s*transform, opacity/);
});

test('cache bust includes dated motion marker', () => {
    assert.match(appHtml, /app\.js\?v=\d{8}-[a-z0-9-]+/);
    assert.match(appHtml, /style\.css\?v=\d{8}-[a-z0-9-]+/);
});

test('snippet empty state mirrors ssh-key dashed muted card', () => {
    assert.match(appJs, /<p class="muted">\$\{t\('暂无代码片段'\)\}<\/p>/);
    assert.match(appJs, /<p class="muted">\$\{t\('暂无 SSH 密钥'\)\}<\/p>/);
    assert.doesNotMatch(appJs, /暂无代码片段。/);
    assert.match(styleCss, /\.snippet-settings-list > \.muted:only-child/);
    assert.match(styleCss, /\.mini-list > \.muted:only-child,\s*\n\.snippet-settings-list > \.muted:only-child\s*\{[\s\S]*?1px dashed/);
});
