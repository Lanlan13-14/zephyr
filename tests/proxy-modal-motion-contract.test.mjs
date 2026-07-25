import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appHtml = readFileSync(path.join(root, 'public/app.html'), 'utf8');
const appJs = readFileSync(path.join(root, 'public/app.js'), 'utf8');
const styleCss = readFileSync(path.join(root, 'public/style.css'), 'utf8');

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

function normalizeOpts(block) {
    const open = block.match(/iosAppOpen\([\s\S]*?\{([\s\S]*?)\}\)/);
    const close = block.match(/iosAppClose\([\s\S]*?\{([\s\S]*?)\}\)/);
    assert.ok(open, 'iosAppOpen options missing');
    assert.ok(close, 'iosAppClose options missing');
    const pick = (body) => body
        .split('\n')
        .map((l) => l.replace(/\/\/.*$/, '').trim())
        .filter(Boolean)
        .map((l) => l.replace(/,$/, '').replace(/\s+/g, ' '))
        .filter((l) => !/^radiusFrom:/.test(l) && !/^radiusTo:/.test(l) && !/^contentEl:/.test(l))
        .join('\n');
    return { open: pick(open[1]), close: pick(close[1]) };
}

test('proxy modal markup mirrors ssh-key / snippet iosApp structure', () => {
    assert.match(appHtml, /id="proxyModalScrim"/);
    assert.match(appHtml, /id="proxyModalInner"[^>]*class="proxy-modal-inner"/);
    assert.match(appHtml, /id="proxyForm"[\s\S]*?id="proxyModalInner"/);
    assert.match(appHtml, /id="addProxyBtn"[^>]*>\s*＋ 新建代理/);
    const formIdx = appHtml.indexOf('id="proxyForm"');
    const innerIdx = appHtml.indexOf('id="proxyModalInner"');
    const headIdx = appHtml.indexOf('id="proxyModalTitle"');
    assert.ok(formIdx > 0 && innerIdx > formIdx && headIdx > innerIdx);
});

test('proxy open/close use iosApp* only — no home-blur or transition layer', () => {
    assert.match(appJs, /function openProxyModal/);
    assert.match(appJs, /function closeProxyModal/);
    assert.match(appJs, /function proxyScrimSet/);
    assert.match(appJs, /function proxyBtnRadius/);
    assert.match(appJs, /function armMotionModalOpen/);
    assert.match(appJs, /armMotionModalOpen\(Motion, modal, card, inner, proxyModalTrigger, 'proxy1'\)/);
    assert.match(appJs, /Motion\.iosAppOpen\(card, proxyModalTrigger/);
    assert.match(appJs, /Motion\.stop\(card\)/);
    assert.match(appJs, /data-motion-source-visual[\s\S]*?remove\(\)/);
    // form.reset 已从 open 路径移除（易触发 layout 闪）
    const openFnCheck = extractFn(appJs, 'openProxyModal');
    assert.doesNotMatch(openFnCheck, /resetProxyForm|form\.reset|\$\('#proxyForm'\)\?\.reset/);
    assert.match(appJs, /for \(const id of \['addSshKeyBtn', 'addSnippetBtn', 'aiAddProviderBtn'\]\)/);
    assert.doesNotMatch(appJs, /for \(const id of \['addSshKeyBtn', 'addSnippetBtn', 'addProxyBtn', 'aiAddProviderBtn'\]\)/);
    const openFn = extractFn(appJs, 'openProxyModal');
    const closeFn = extractFn(appJs, 'closeProxyModal');
    assert.doesNotMatch(openFn, /connection-home-blur/);
    assert.doesNotMatch(closeFn, /connection-home-blur/);
    assert.doesNotMatch(openFn, /connectionTransitionLayer/);
    assert.doesNotMatch(closeFn, /connectionTransitionLayer/);
    assert.doesNotMatch(openFn, /proxyModalOriginRect/);
    assert.doesNotMatch(closeFn, /proxyModalOriginRect/);
    const ssh = extractFn(appJs, 'openSshKeyModal') + '\n' + extractFn(appJs, 'closeSshKeyModal');
    const proxy = openFn + '\n' + closeFn;
    const a = normalizeOpts(ssh);
    const b = normalizeOpts(proxy);
    assert.equal(b.open, a.open);
    assert.equal(b.close, a.close);
});

test('proxy CSS is motion-only card', () => {
    assert.match(styleCss, /#proxyModalScrim/);
    assert.match(styleCss, /#proxyModalScrim/);
    assert.doesNotMatch(styleCss, /#proxyModalScrim[^{]*\{[^}]*backdrop-filter/);
    assert.match(styleCss, /#proxyModal \.proxy-modal/);
    assert.match(styleCss, /\.proxy-modal-inner/);
    assert.match(styleCss, /body\.proxy1-blurring #proxyModalScrim/);
    assert.match(styleCss, /#proxyModal \.proxy-modal[\s\S]*?transition:\s*none\s*!important/);
    assert.doesNotMatch(styleCss, /#proxyModal:not\(\.proxy1\)/);
    // 代理按钮禁止 CSS press/hover/active transform，只允许引擎动画
    assert.match(styleCss, /#addProxyBtn,\s*\n#addProxyBtn:hover/);
    assert.match(styleCss, /#addProxyBtn[\s\S]*?transform:\s*none\s*!important/);
    assert.doesNotMatch(styleCss, /#addProxyBtn\.connection-pressing,\s*\n#aiAddProviderBtn\.connection-pressing/);
});

test('proxy modal expands full content without internal max-height scroll lock', () => {
    // 移动端不再把 proxy 锁成 86vh 内滚；滚动交给 backdrop
    assert.match(styleCss, /#proxyModal \.proxy-modal[\s\S]*?max-height:\s*none\s*!important/);
    assert.match(styleCss, /#proxyModal \.proxy-modal[\s\S]*?overflow:\s*visible\s*!important/);
    assert.match(styleCss, /#proxyModal\.proxy1[\s\S]*?overflow-y:\s*auto/);
    const openFn = extractFn(appJs, 'openProxyModal');
    assert.doesNotMatch(openFn, /enhanceToggleSelect\(\$\('#proxyType'\)\);\s*\n\s*syncToggleSelectFace\(\$\('#proxyType'\)\);\s*\n\s*const btnRect/);
    assert.match(openFn, /card\.style\.overflow = 'visible'/);
    assert.match(openFn, /card\.style\.maxHeight = 'none'/);
    // 代理按钮不进 Motion.press 名单
    assert.doesNotMatch(appJs, /for \(const id of \['addSshKeyBtn', 'addSnippetBtn', 'addProxyBtn', 'aiAddProviderBtn'\]\)/);
    assert.match(appJs, /for \(const id of \['addSshKeyBtn', 'addSnippetBtn', 'aiAddProviderBtn'\]\)/);
});

test('proxy finish path keeps atomic twin handoff', () => {
    const closeFn = extractFn(appJs, 'closeProxyModal');
    assert.match(closeFn, /clearSourceVisual:\s*false/);
    assert.match(closeFn, /restoreSource:\s*false/);
    assert.match(closeFn, /Motion\.restoreSource\(trigger\)/);
    assert.match(closeFn, /data-motion-source-visual/);
    assert.match(closeFn, /Promise\.race\(\[closed, cap\]\)/);
});

test('proxy scrim uses shared motionScrimSet without cssVars', () => {
    const src = extractFn(appJs, 'proxyScrimSet');
    assert.match(src, /motionScrimSet\('proxyModalScrim'/);
    assert.doesNotMatch(src, /cssVars/);
});
