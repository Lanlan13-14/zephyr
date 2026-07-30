import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const appJs = read('public/app.js');
const terminalJs = read('public/terminal.js');
const telnetJs = read('public/telnet-terminal.js');
const styleCss = read('public/style.css');
const motionJs = read('public/vendor/zephyr-motion/motion.js');
const appHtml = read('public/app.html');

test('motion engine exposes toast / toastDismiss / toastPush stack', () => {
    assert.match(motionJs, /toast\s*\(\s*el/);
    assert.match(motionJs, /toastDismiss\s*\(/);
    assert.match(motionJs, /toastPush\s*\(/);
    assert.match(motionJs, /_toastStacks/);
    assert.match(motionJs, /stack\.items\.unshift/);
    assert.match(motionJs, /reflowStack/);
    assert.match(motionJs, /preset:\s*opts\.preset \?\? 'snappy'/);
    assert.match(motionJs, /DEFAULT_ENTER_SCALE:\s*0\.96/);
});

test('app toast uses toastPush host stack — not a singleton node', () => {
    assert.match(appHtml, /id="toastHost"/);
    assert.match(appHtml, /class="toast-container"/);
    assert.doesNotMatch(appHtml, /id="toast"/);
    assert.match(appJs, /function toast\(/);
    assert.match(appJs, /function ensureAppToastHost\(/);
    assert.match(appJs, /function ensureToastMotion\(/);
    assert.match(appJs, /Motion\.toastPush\(/);
    assert.match(appJs, /toastHost/);
    assert.match(appJs, /gap:\s*8/);
    assert.match(appJs, /position\s*=\s*'absolute'/);
    assert.match(appJs, /kind:\s*'info'/);
    assert.doesNotMatch(appJs, /\$\('#toast'\)/);
    assert.doesNotMatch(appJs, /Motion\.toast\(/);
    assert.doesNotMatch(appJs, /fallbackShow|showToastCssFallback/);
    assert.match(appJs, /toast skipped/);
});

test('terminal and telnet toasts also use absolute toastPush stack without kind colors', () => {
    for (const src of [terminalJs, telnetJs]) {
        assert.match(src, /function showToast\(/);
        assert.match(src, /terminalToastMotion/);
        assert.match(src, /Motion\.toastPush\(/);
        assert.match(src, /gap:\s*8/);
        assert.match(src, /position\s*=\s*'absolute'/);
        assert.match(src, /kind:\s*'info'/);
        assert.doesNotMatch(src, /showToastCssFallback/);
        assert.doesNotMatch(src, /className = `toast \$\{kind\}/);
        assert.doesNotMatch(src, /removeAttribute\('style'\)/);
        assert.match(src, /toast skipped/);
    }
});

test('toast CSS is neutral and has zero enter/exit transitions', () => {
    const base = styleCss.match(/\/\* 通用 Toast[\s\S]*?\.toast\s*\{[^}]+\}/);
    assert.ok(base, 'missing base .toast rule');
    assert.match(base[0], /transition:\s*none\s*!important/);
    assert.doesNotMatch(base[0], /transition:\s*opacity/);
    assert.doesNotMatch(styleCss, /\.toast:not\(\.motion-driven\)/);
    // kind 类保持中性，不改文字色
    assert.match(styleCss, /\.toast\.success,\s*\.toast\.error,\s*\.toast\.info\s*\{[\s\S]*?color:\s*var\(--text\)/);
    assert.doesNotMatch(styleCss, /\.toast\.error\s*\{[^}]*color:\s*var\(--danger\)/);
    assert.match(styleCss, /body\.app-body\s*>\s*\.toast-container/);
});
