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

test('snippet modal markup mirrors ssh-key iosApp structure', () => {
    assert.match(appHtml, /id="snippetModalScrim"/);
    assert.match(appHtml, /id="snippetModalInner"[^>]*class="snippet-modal-inner"/);
    assert.match(appHtml, /id="snippetForm"[\s\S]*?id="snippetModalInner"/);
    assert.match(appHtml, /id="addSnippetBtn"[^>]*>\s*＋ 新增代码片段/);
    const formIdx = appHtml.indexOf('id="snippetForm"');
    const innerIdx = appHtml.indexOf('id="snippetModalInner"');
    const headIdx = appHtml.indexOf('id="snippetModalTitle"');
    assert.ok(formIdx > 0 && innerIdx > formIdx && headIdx > innerIdx);
});

test('snippet open/close use iosApp* only — no home-blur fallback', () => {
    assert.match(appJs, /function openSnippetModal/);
    assert.match(appJs, /function closeSnippetModal/);
    assert.match(appJs, /function snippetScrimSet/);
    assert.match(appJs, /function snippetBtnRadius/);
    assert.match(appJs, /Motion\.iosAppOpen\(card, snippetModalTrigger/);
    assert.match(appJs, /armMotionModalOpen\(Motion, modal, card, inner, snippetModalTrigger, 'snippet1'\)/);
    assert.match(appJs, /for \(const id of \['addSshKeyBtn', 'addSnippetBtn', 'addProxyBtn', 'aiAddProviderBtn'\]\)/);
    const openFn = extractFn(appJs, 'openSnippetModal');
    const closeFn = extractFn(appJs, 'closeSnippetModal');
    assert.doesNotMatch(openFn, /connection-home-blur/);
    assert.doesNotMatch(closeFn, /connection-home-blur/);
    assert.doesNotMatch(openFn, /connectionTransitionLayer/);
    assert.match(openFn, /cloneSource:\s*true/);
    assert.match(closeFn, /clearSourceVisual:\s*false/);
});

test('snippet CSS is motion-only card (no scale fallback)', () => {
    assert.match(styleCss, /#snippetModalScrim/);
    assert.match(styleCss, /#snippetModalScrim/);
    assert.doesNotMatch(styleCss, /#snippetModalScrim[^{]*\{[^}]*backdrop-filter/);
    assert.match(styleCss, /#snippetModal \.snippet-modal/);
    assert.match(styleCss, /\.snippet-modal-inner/);
    assert.match(styleCss, /body\.snippet1-blurring #snippetModalScrim/);
    assert.match(styleCss, /#snippetModal \.snippet-modal[\s\S]*?transition:\s*none\s*!important/);
    assert.doesNotMatch(styleCss, /#snippetModal:not\(\.snippet1\)/);
    assert.match(styleCss, /#addSnippetBtn\.connection-pressing/);
});

test('snippet auto-run still uses connection-share-switch', () => {
    assert.match(appHtml, /for="snippetAutoRun"[\s\S]*?connection-share-switch[\s\S]*?id="snippetAutoRun"/);
    assert.doesNotMatch(appHtml, /settings-switch-control|settings-switch-track/);
});
