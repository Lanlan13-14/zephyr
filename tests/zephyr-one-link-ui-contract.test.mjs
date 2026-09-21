import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(root, 'public/app.html'), 'utf8');
const css = readFileSync(path.join(root, 'public/style.css'), 'utf8');
const appJs = readFileSync(path.join(root, 'public/app.js'), 'utf8');
const ui = readFileSync(path.join(root, 'zephyr-one-link-ui.js'), 'utf8');

test('Link panel markup matches Android FileSyncScreen groups, not a native form', () => {
    assert.match(html, /id="settings-link"/);
    assert.match(html, /class="link-hero"/);
    assert.match(html, /id="linkSyncNowBtn"/);
    assert.match(html, /id="linkIntervalSelect"/);
    assert.match(html, /id="linkNetworkPolicySelect"/);
    assert.match(html, /id="linkAutoSyncToggle"/);
    assert.match(html, /data-i18n="冲突中心"/);
    assert.match(html, /data-i18n="One 设备"/);
    assert.match(html, /data-i18n="诊断"/);
    assert.match(html, /data-i18n="策略"/);
    assert.doesNotMatch(html, /label class="z-check"/);
    const panel = html.slice(html.indexOf('id="settings-link"'), html.indexOf('id="settings-data"'));
    assert.match(panel, /<select id="linkIntervalSelect">/);
    assert.match(panel, /<select id="linkNetworkPolicySelect">/);
});

test('Link interval and network selects join the homepage toggle + mac motion set', () => {
    assert.match(appJs, /const TOGGLE_SELECT_IDS = \[[\s\S]*?'linkIntervalSelect'[\s\S]*?'linkNetworkPolicySelect'/);
    assert.match(appJs, /const MOTION_FILTER_SELECT_IDS = \[[\s\S]*?'linkIntervalSelect'[\s\S]*?'linkNetworkPolicySelect'/);
    assert.match(appJs, /window\.enhanceToggleSelect = enhanceToggleSelect/);
    assert.match(appJs, /window\.syncToggleSelectFace = syncToggleSelectFace/);
});

test('Link overlay uses the homepage toggle helpers and Android phase copy', () => {
    assert.match(ui, /enhanceToggleSelect/);
    assert.match(ui, /syncToggleSelectFace/);
    assert.match(ui, /正在同步/);
    assert.match(ui, /镜像已同步/);
    assert.match(ui, /未绑定主端 · 本机工作区可离线使用/);
    assert.match(ui, /待推送 \{count\}/);
    assert.match(ui, /link-hero/);
    assert.doesNotMatch(ui, /z-check/);
});

test('Link motion CSS stays GPU-only with press scale and reduced-motion', () => {
    assert.match(css, /#settings-link/);
    assert.match(css, /\.link-hero/);
    assert.match(css, /transform: scale\(0\.97\)/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\n\s*\.link-hero-progress > span/);
    assert.match(css, /cubic-bezier\(0\.23, 1, 0\.32, 1\)/);
    assert.doesNotMatch(css.slice(css.indexOf('/* Zephyr Link')), /transition:\s*all/);
    assert.doesNotMatch(css.slice(css.indexOf('/* Zephyr Link')), /scale\(0\)/);
});
