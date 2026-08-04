import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rdpJs = readFileSync(path.join(root, 'public/rdp-wasm-client.js'), 'utf8');
const vncJs = readFileSync(path.join(root, 'public/novnc.js'), 'utf8');
const rdpHtml = readFileSync(path.join(root, 'public/rdp.html'), 'utf8');
const vncHtml = readFileSync(path.join(root, 'public/novnc.html'), 'utf8');
const styleCss = readFileSync(path.join(root, 'public/style.css'), 'utf8');
const sshJs = readFileSync(path.join(root, 'public/telnet-terminal.js'), 'utf8');

function helperBody(src) {
    const start = src.indexOf('function setupHorizontalScrollbarVisibility');
    assert.ok(start >= 0, 'helper missing');
    const brace = src.indexOf('{', start);
    let depth = 0;
    for (let i = brace; i < src.length; i++) {
        if (src[i] === '{') depth++;
        if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
    }
    throw new Error('helper incomplete');
}

const sshHelper = helperBody(sshJs);

test('RDP and VNC copy the complete SSH horizontal scrollbar helper', () => {
    assert.equal(helperBody(rdpJs), sshHelper);
    assert.equal(helperBody(vncJs), sshHelper);
});

test('RDP and VNC copy SSH topbarActions id lookup and initialization', () => {
    for (const [html, js] of [[rdpHtml, rdpJs], [vncHtml, vncJs]]) {
        assert.match(html, /class="topbar-actions novnc-toolbar" id="topbarActions"/);
        assert.match(js, /const topbarActions = document\.getElementById\('topbarActions'\)/);
        assert.match(js, /setupHorizontalScrollbarVisibility\(topbarActions\)/);
    }
    assert.match(rdpHtml, /rdp-wasm-client\.js\?v=\d{8}-[a-z0-9-]+/);
    assert.match(vncHtml, /novnc\.js\?v=\d{8}-[a-z0-9-]+/);
});

test('late novnc selector restores WebKit height instead of overriding SSH to zero', () => {
    assert.match(styleCss, /\.novnc-page \.novnc-toolbar\.topbar-actions::-webkit-scrollbar\s*\{\s*height:\s*0/);
    assert.match(styleCss, /\.novnc-page \.novnc-toolbar\.topbar-actions\.scroll-active::-webkit-scrollbar[\s\S]*?height:\s*4px/);
    assert.match(styleCss, /\.novnc-page \.novnc-toolbar\.topbar-actions:hover::-webkit-scrollbar[\s\S]*?height:\s*4px/);
    assert.match(styleCss, /\.novnc-page \.novnc-toolbar\.topbar-actions:focus-within::-webkit-scrollbar[\s\S]*?height:\s*4px/);
});

test('desktop RDP toolbar wraps in a narrow floating window without changing mobile or VNC', () => {
    assert.match(rdpHtml, /class="novnc-page rdp-page rdp-protocol-page"/);
    assert.doesNotMatch(vncHtml, /rdp-protocol-page/);
    const selectorStart = styleCss.indexOf('.novnc-page.rdp-page.rdp-protocol-page .novnc-toolbar.topbar-actions');
    assert.ok(selectorStart >= 0, 'desktop RDP toolbar override missing');
    const desktopStart = styleCss.lastIndexOf('@media (hover: hover) and (pointer: fine)', selectorStart);
    const desktopEnd = styleCss.indexOf('.novnc-page .novnc-toolbar .btn-sm', selectorStart);
    const block = styleCss.slice(desktopStart, desktopEnd);
    assert.match(block, /\.novnc-page\.rdp-page\.rdp-protocol-page \.novnc-toolbar\.topbar-actions/);
    assert.match(block, /flex-wrap:\s*wrap/);
    assert.match(block, /overflow-x:\s*visible/);
    assert.doesNotMatch(block, /\.novnc-page:not\(\.rdp-page\)|\.novnc-page \.novnc-toolbar/);
});
