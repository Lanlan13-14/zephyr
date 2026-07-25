import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appJs = readFileSync(path.join(root, 'public/app.js'), 'utf8');
const styleCss = readFileSync(path.join(root, 'public/style.css'), 'utf8');
const appHtml = readFileSync(path.join(root, 'public/app.html'), 'utf8');

test('crisis helpers exist and empty path prefers crisis card over bare empty', () => {
    assert.match(appJs, /function isCrisisSearchQuery/);
    assert.match(appJs, /function renderCrisisHelpEmptyCard/);
    assert.match(appJs, /function connectionListEmptyHtml/);
    assert.match(appJs, /connectionListEmptyHtml\(\)/);
    assert.match(appJs, /isCrisisSearchQuery\(q\)/);
    assert.doesNotMatch(
        appJs,
        /list\.length \? list\.map[\s\S]{0,2500}:\s*'<div class="empty-card">暂无连接/,
        'empty branch must go through connectionListEmptyHtml, not hard-coded bare empty'
    );
});

test('crisis keywords cover Chinese and English intent without everyday false positives', () => {
    assert.match(appJs, /\/自杀\//);
    assert.match(appJs, /\/轻生\//);
    assert.match(appJs, /\/想死\//);
    assert.match(appJs, /\/自残\//);
    assert.match(appJs, /\/suicide\/i/);
    assert.match(appJs, /\\bkill myself\\b\/i/);
    assert.match(appJs, /\\bwant to die\\b\/i/);
    // Must NOT treat vague everyday words as crisis triggers.
    assert.doesNotMatch(appJs, /\/抑郁\//);
    assert.doesNotMatch(appJs, /\/压力\//);
    assert.doesNotMatch(appJs, /\/焦虑\//);
});

test('crisis empty card copy matches reference messaging and exposes dial + copy', () => {
    assert.match(appJs, /你不孤单，我们都在/);
    assert.match(appJs, /全国24小时免费心理咨询热线/);
    assert.match(appJs, /24\/7 Free Psychological Counseling/);
    assert.match(appJs, /CRISIS_HELP_HOTLINE\s*=\s*'010-82951332'/);
    assert.match(appJs, /href="tel:\$\{tel\}"/);
    assert.match(appJs, /data-copy-hotline=/);
    assert.match(appJs, /class="empty-card crisis-help-card"/);
    assert.match(appJs, /role="region"/);
});

test('connection grid click copies hotline via shared clipboard helper', () => {
    assert.match(
        appJs,
        /connectionGrid[\s\S]*?data-copy-hotline[\s\S]*?copyTextToClipboard\([\s\S]*?热线号码已复制/
    );
});

test('crisis card styles span full grid and keep pink CTA', () => {
    assert.match(styleCss, /\.crisis-help-card\s*\{/);
    assert.match(styleCss, /grid-column:\s*1\s*\/\s*-1/);
    assert.match(styleCss, /\.crisis-help-title\s*\{/);
    assert.match(styleCss, /\.crisis-help-phone\s*\{/);
    assert.match(styleCss, /\.crisis-help-copy\s*\{/);
    assert.match(styleCss, /#f472b6/);
    assert.match(styleCss, /:root\[data-theme="dark"\]\s*\.crisis-help-card/);
});

test('cache bust is a dated marker (crisis-search2 or later)', () => {
    // cache 版本随后续功能迭代递增，只要求存在日期化版本串。
    assert.match(appHtml, /app\.js\?v=\d{8}-[a-z0-9-]+/);
    assert.match(appHtml, /style\.css\?v=\d{8}-[a-z0-9-]+/);
});

// Runtime unit checks without DOM: extract the pattern list and evaluate.
test('isCrisisSearchQuery logic via extracted patterns', () => {
    const block = appJs.match(/const CRISIS_SEARCH_PATTERNS = \[([\s\S]*?)\];/);
    assert.ok(block, 'CRISIS_SEARCH_PATTERNS array present');
    // Reconstruct patterns by eval-safe parsing of /.../ tokens.
    const raw = block[1];
    const patterns = [];
    const reToken = /\/((?:\\.|[^/\\])+)\/([a-z]*)/g;
    let m;
    while ((m = reToken.exec(raw))) {
        patterns.push(new RegExp(m[1], m[2]));
    }
    assert.ok(patterns.length >= 10, `expected many patterns, got ${patterns.length}`);

    const hit = (q) => patterns.some((re) => re.test(String(q || '').trim()));
    for (const q of ['自杀', '我想自杀', '轻生', '想死', '自残', 'suicide', 'kill myself', 'want to die', 'self-harm']) {
        assert.equal(hit(q), true, `should hit: ${q}`);
    }
    for (const q of ['', 'web-01', '生产机', '抑郁', '压力大', '焦虑', 'ssh', 'jump host']) {
        assert.equal(hit(q), false, `should miss: ${q}`);
    }
});
