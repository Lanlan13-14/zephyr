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
    const re = new RegExp(`(?:async\\s+)?function ${name}\\s*\\(`);
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

test('ai provider modal markup mirrors iosApp structure', () => {
    assert.match(appHtml, /id="aiProviderModalScrim"/);
    assert.match(appHtml, /id="aiProviderModalInner"[^>]*class="ai-provider-modal-inner"/);
    assert.match(appHtml, /id="aiProviderForm"[\s\S]*?id="aiProviderModalInner"/);
    assert.match(appHtml, /id="aiAddProviderBtn"[^>]*>\s*添加模型供应商/);
    const formIdx = appHtml.indexOf('id="aiProviderForm"');
    const innerIdx = appHtml.indexOf('id="aiProviderModalInner"');
    const headIdx = appHtml.indexOf('id="aiProviderModalTitle"');
    assert.ok(formIdx > 0 && innerIdx > formIdx && headIdx > innerIdx);
});

test('ai provider open/close use iosApp* identical to SSH key', () => {
    assert.match(appJs, /function openAiProviderModal|async function openAiProviderModal/);
    assert.match(appJs, /function closeAiProviderModal/);
    assert.match(appJs, /function aiProviderScrimSet/);
    assert.match(appJs, /function aiProviderBtnRadius/);
    assert.match(appJs, /armMotionModalOpen\(Motion, modal, card, inner, aiProviderModalTrigger, 'aiprovider1'\)/);
    assert.match(appJs, /Motion\.iosAppOpen\(card, aiProviderModalTrigger/);
    assert.match(appJs, /for \(const id of \['addSshKeyBtn', 'addSnippetBtn'\]\)/);
    assert.doesNotMatch(appJs, /for \(const id of \[[^\]]*'aiAddProviderBtn'/);
    assert.match(appJs, /#aiAddProviderBtn/);
    assert.match(appJs, /aiProviderModalScrim/);
    const openFn = extractFn(appJs, 'openAiProviderModal');
    const closeFn = extractFn(appJs, 'closeAiProviderModal');
    assert.doesNotMatch(openFn, /connection-home-blur/);
    assert.doesNotMatch(closeFn, /connection-home-blur/);
    assert.doesNotMatch(openFn, /classList\.add\('show', 'app-visible'\)/);
    // share targets must fill after iosAppOpen settles (not mid-flight)
    assert.match(openFn, /iosAppOpen[\s\S]*?\.then\(\(\) => \{[\s\S]*?fillShareTargets\(\)/);
    const ssh = extractFn(appJs, 'openSshKeyModal') + '\n' + extractFn(appJs, 'closeSshKeyModal');
    const ai = openFn + '\n' + closeFn;
    const a = normalizeOpts(ssh);
    const b = normalizeOpts(ai);
    assert.equal(b.open, a.open, `open opts differ\nSSH:\n${a.open}\nAI:\n${b.open}`);
    assert.equal(b.close, a.close, `close opts differ\nSSH:\n${a.close}\nAI:\n${b.close}`);
});

test('ai provider expands fully and backdrop owns scroll on desktop too', () => {
    // 与编辑 RDP/新建代理一致：表单不锁 88vh，backdrop 可下滑
    assert.match(styleCss, /#aiProviderModal \.ai-provider-modal[\s\S]*?max-height:\s*none\s*!important/);
    assert.match(styleCss, /#aiProviderModal \.ai-provider-modal[\s\S]*?overflow:\s*visible\s*!important/);
    assert.match(styleCss, /#aiProviderModal\.aiprovider1[\s\S]*?overflow-y:\s*auto/);
    assert.match(styleCss, /#aiProviderModal\.aiprovider1 \.ai-provider-modal-inner[\s\S]*?max-height:\s*none\s*!important/);
    // open 落地后清 overflow/maxHeight（JS 已有；桌面 CSS 也必须不锁）
    const openFn = extractFn(appJs, 'openAiProviderModal');
    assert.match(openFn, /card\.style\.overflow = 'visible'/);
    assert.match(openFn, /card\.style\.maxHeight = 'none'/);
});

test('ai provider CSS is motion-only — old slide/fade removed', () => {
    assert.match(styleCss, /#aiProviderModalScrim/);
    assert.match(styleCss, /#aiProviderModalScrim/);
    assert.doesNotMatch(styleCss, /#aiProviderModalScrim[^{]*\{[^}]*backdrop-filter/);
    assert.match(styleCss, /#aiProviderModal \.ai-provider-modal/);
    assert.match(styleCss, /\.ai-provider-modal-inner/);
    assert.match(styleCss, /body\.aiprovider1-blurring #aiProviderModalScrim/);
    assert.match(styleCss, /#aiProviderModal \.ai-provider-modal[\s\S]*?transition:\s*none\s*!important/);
    assert.match(styleCss, /#aiProviderModal \.ai-provider-modal[\s\S]*?animation:\s*none\s*!important/);
    // descendant transitions killed during flight (AI input transform was flashing every frame)
    assert.match(styleCss, /#aiProviderModal\.aiprovider1 \.ai-provider-modal \*/);
    assert.match(styleCss, /#aiProviderModal\.aiprovider1 \.ai-provider-modal \*[\s\S]*?transition:\s*none\s*!important/);
    // old CSS sheet animation must not target the motion modal
    assert.doesNotMatch(styleCss, /#aiProviderModal\.show \.ai-provider-modal\s*\{[^}]*legacyAiSlideSheet/);
    assert.doesNotMatch(styleCss, /#aiProviderModal\.app-visible \.ai-provider-modal\s*\{[^}]*legacyAiSlideSheet/);
    assert.doesNotMatch(styleCss, /\.ai-provider-modal \.form-row\s*,[\s\S]{0,200}?legacyAiFadeLift/);
    assert.doesNotMatch(styleCss, /#aiAddProviderBtn\.connection-pressing/);
    // generic fade excludes ai-provider-modal
    assert.match(styleCss, /\.connection-modal:not\(#connectionForm\):not\(\.ssh-key-modal\):not\(\.snippet-modal\):not\(\.proxy-modal\):not\(\.ai-provider-modal\)/);
});

test('ai provider finish path keeps atomic twin handoff', () => {
    const closeFn = extractFn(appJs, 'closeAiProviderModal');
    assert.match(closeFn, /clearSourceVisual:\s*false/);
    assert.match(closeFn, /restoreSource:\s*false/);
    assert.match(closeFn, /Motion\.restoreSource\(trigger\)/);
    assert.match(closeFn, /data-motion-source-visual/);
    assert.match(closeFn, /Promise\.race\(\[closed, cap\]\)/);
});

test('ai provider scrim uses shared motionScrimSet without cssVars', () => {
    const src = extractFn(appJs, 'aiProviderScrimSet');
    assert.match(src, /motionScrimSet\('aiProviderModalScrim'/);
    assert.doesNotMatch(src, /cssVars/);
    const shared = extractFn(appJs, 'motionScrimSet');
    assert.match(shared, /opacity = '1'/);
    assert.doesNotMatch(shared, /cssVars|backdrop-filter/);
});
