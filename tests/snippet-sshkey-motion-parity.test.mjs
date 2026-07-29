import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appJs = readFileSync(path.join(root, 'public/app.js'), 'utf8');
const appHtml = readFileSync(path.join(root, 'public/app.html'), 'utf8');
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

test('open/close option bags are identical across sshkey/snippet/proxy', () => {
    const names = [
        ['openSshKeyModal', 'closeSshKeyModal'],
        ['openSnippetModal', 'closeSnippetModal'],
        ['openProxyModal', 'closeProxyModal'],
    ];
    const bags = names.map(([o, c]) => normalizeOpts(extractFn(appJs, o) + '\n' + extractFn(appJs, c)));
    assert.equal(bags[1].open, bags[0].open);
    assert.equal(bags[1].close, bags[0].close);
    assert.equal(bags[2].open, bags[0].open);
    assert.equal(bags[2].close, bags[0].close);
});

test('scrim uses shared motionScrimSet (no per-frame cssVars blur)', () => {
    assert.match(appJs, /function motionScrimSet/);
    const arm = extractFn(appJs, 'motionScrimSet');
    assert.match(arm, /scrim\.style\.opacity = '1'/);
    assert.doesNotMatch(arm, /cssVars/);
    for (const name of ['sshKeyScrimSet', 'snippetScrimSet', 'proxyScrimSet', 'aiProviderScrimSet']) {
        const src = extractFn(appJs, name);
        assert.match(src, /motionScrimSet\(/);
        assert.doesNotMatch(src, /cssVars/);
    }
});

test('HTML shell structure is parallel for three modals', () => {
    assert.match(appHtml, /id="sshKeyModalScrim"[\s\S]*?id="sshKeyModal"[\s\S]*?id="sshKeyForm"[\s\S]*?id="sshKeyModalInner"/);
    assert.match(appHtml, /id="snippetModalScrim"[\s\S]*?id="snippetModal"[\s\S]*?id="snippetForm"[\s\S]*?id="snippetModalInner"/);
    assert.match(appHtml, /id="proxyModalScrim"[\s\S]*?id="proxyModal"[\s\S]*?id="proxyForm"[\s\S]*?id="proxyModalInner"/);
});

test('CSS is motion-only for three modals — no scale/fade fallback', () => {
    assert.match(styleCss, /#sshKeyModal \.ssh-key-modal/);
    assert.match(styleCss, /#snippetModal \.snippet-modal/);
    assert.match(styleCss, /#proxyModal \.proxy-modal/);
    assert.match(styleCss, /#sshKeyModal \.ssh-key-modal[\s\S]*?transition:\s*none\s*!important/);
    // old per-modal scale CSS fallback removed
    assert.doesNotMatch(styleCss, /#sshKeyModal:not\(\.sshkey1\)/);
    assert.doesNotMatch(styleCss, /#snippetModal:not\(\.snippet1\)/);
    assert.doesNotMatch(styleCss, /#proxyModal:not\(\.proxy1\)/);
    assert.doesNotMatch(styleCss, /#sshKeyModal \.connection-modal \{ transform: scale/);
    // generic fade must exclude the three motion cards
    assert.match(styleCss, /\.connection-modal:not\(#connectionForm\):not\(\.ssh-key-modal\):not\(\.snippet-modal\):not\(\.proxy-modal\)/);
});

test('JS open/close never uses connection-home-blur for three modals', () => {
    for (const name of [
        'openSshKeyModal', 'closeSshKeyModal',
        'openSnippetModal', 'closeSnippetModal',
        'openProxyModal', 'closeProxyModal',
        'armMotionModalOpen',
    ]) {
        const fn = extractFn(appJs, name);
        assert.doesNotMatch(fn, /connection-home-blur/);
        assert.doesNotMatch(fn, /connectionTransitionLayer/);
    }
    const arm = extractFn(appJs, 'armMotionModalOpen');
    assert.match(arm, /Motion\.stop\(card\)/);
    assert.match(arm, /Motion\.release\(card\)/);
    assert.match(arm, /Motion\.stop\(trigger\)/);
    assert.match(arm, /data-motion-source-visual/);
    assert.match(arm, /connection-pressing/);
    assert.match(appJs, /armMotionModalOpen\(Motion, modal, card, inner, proxyModalTrigger, 'proxy1'\)/);
    assert.match(appJs, /armMotionModalOpen\(Motion, modal, card, inner, sshKeyModalTrigger, 'sshkey1'\)/);
    assert.match(appJs, /armMotionModalOpen\(Motion, modal, card, inner, snippetModalTrigger, 'snippet1'\)/);
});

test('finish path keeps atomic twin handoff', () => {
    for (const name of ['closeSshKeyModal', 'closeSnippetModal', 'closeProxyModal']) {
        const closeFn = extractFn(appJs, name);
        assert.match(closeFn, /clearSourceVisual:\s*false/);
        assert.match(closeFn, /restoreSource:\s*false/);
        assert.match(closeFn, /Motion\.restoreSource\(trigger\)/);
        assert.match(closeFn, /Promise\.race\(\[closed, cap\]\)/);
    }
});
