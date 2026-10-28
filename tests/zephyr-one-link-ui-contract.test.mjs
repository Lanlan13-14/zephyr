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
    assert.match(panel, /class="link-filter-bar"/);
    assert.doesNotMatch(panel, /link-row-select/);
    assert.doesNotMatch(panel, /link-select-block/);
    const bar = panel.slice(panel.indexOf('id="linkFilterBar"'), panel.indexOf('id="linkPolicyGroup"'));
    assert.match(bar, /id="linkIntervalSelect"/);
    assert.match(bar, /id="linkNetworkPolicySelect"/);
    const group = panel.slice(panel.indexOf('id="linkPolicyGroup"'));
    assert.doesNotMatch(group, /id="linkIntervalSelect"/);
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

test('Link conflict center and D1 import preview expose P2 contract hooks', () => {
    const panel = html.slice(html.indexOf('id="settings-link"'), html.indexOf('id="settings-data"'));
    assert.match(panel, /id="linkImportPanel"/);
    assert.match(panel, /id="linkImportApplyBtn"/);
    assert.match(panel, /id="linkConflictKeepLocal"/);
    assert.match(panel, /id="linkConflictKeepServer"/);
    assert.match(panel, /id="linkConflictCopy"/);
    assert.match(panel, /data-i18n="保留本机"/);
    assert.match(panel, /data-i18n="用主端"/);
    assert.match(panel, /data-i18n="另存副本"/);
    assert.match(panel, /data-i18n="应用导入决定"/);
    assert.match(panel, /data-i18n="需手动合并"/);
    assert.match(panel, /class="link-hero"/);
    assert.match(panel, /id="linkSyncNowBtn"/);
    assert.match(panel, /id="linkIntervalSelect"/);
    assert.match(ui, /\/api\/one\/link\/conflicts/);
    assert.match(ui, /\/api\/one\/link\/conflicts\/' \+ encodeURIComponent\(conflictId\) \+ '\/resolve/);
    assert.match(ui, /\/api\/one\/link\/conflicts\/' \+ encodeURIComponent\(conflictId\) \+ '\/copy/);
    assert.match(ui, /\/api\/one\/link\/import-preview/);
    assert.match(ui, /\/api\/one\/link\/import-apply/);
    assert.match(ui, /importDecisionRequired/);
    assert.match(ui, /keep_local/);
    assert.match(ui, /keep_server/);
    assert.match(ui, /copy_as_new/);
    assert.match(ui, /CONFLICT_MARKER = '<<<<<<<'/);
    assert.match(ui, /'link-import-' \+/);
    assert.doesNotMatch(ui, /resolution:\s*'manual_merge'/);
    const zh = JSON.parse(readFileSync(path.join(root, 'public/i18n/locales/zh-CN.json'), 'utf8'));
    const en = JSON.parse(readFileSync(path.join(root, 'public/i18n/locales/en.json'), 'utf8'));
    const keys = [
        '保留本机',
        '用主端',
        '另存副本',
        '导入',
        '仅保本地',
        '副本',
        '应用导入决定',
        '需手动合并',
        '先完成导入决定',
        '没有冲突',
    ];
    for (const key of keys) {
        assert.equal(typeof zh[key], 'string', key);
        assert.ok(zh[key].length > 0, key);
        assert.equal(typeof en[key], 'string', key);
        assert.ok(en[key].length > 0, key);
        assert.notEqual(en[key], key, key);
    }
    assert.equal(zh['保留本机'], '保留本机');
    assert.equal(en['保留本机'], 'Keep local');
    assert.equal(en['用主端'], 'Use server');
    assert.equal(en['另存副本'], 'Save a copy');
    assert.equal(en['导入'], 'Import');
    assert.equal(en['仅保本地'], 'Keep on this device');
    assert.equal(en['副本'], 'Copy as new');
    assert.equal(en['应用导入决定'], 'Apply import choices');
    assert.equal(en['需手动合并'], 'Needs manual merge');
    assert.equal(en['先完成导入决定'], 'Finish import choices first');
    assert.equal(en['没有冲突'], 'No conflicts');
});

test('Link interval/network dropdowns are the homepage pill, not a clipped row chip', () => {
    const linkCss = css.slice(css.indexOf('/* Zephyr Link'));
    assert.match(linkCss, /\.link-filter-bar \{/);
    assert.match(linkCss, /\.link-filter-bar \.ui-toggle-select \{[\s\S]*?width:\s*100%/);
    assert.doesNotMatch(linkCss, /link-select-block/);
    assert.doesNotMatch(linkCss, /link-row-select \.ui-toggle-select/);
    assert.doesNotMatch(linkCss, /width:\s*min\(220px/);
    assert.match(ui, /setHidden\(\$\('linkFilterBar'\)/);
    assert.match(appJs, /function enhanceToggleSelect\(select\)/);
    assert.match(appJs, /function openToggleSelectMenu\(shell\)/);
    assert.match(appJs, /Motion\.morph\(menu, from, \{[\s\S]*?preset:\s*'mac'/);
    assert.match(appJs, /MOTION_FILTER_SELECT_IDS\.includes\(shell\.dataset\?\.selectId/);
});
