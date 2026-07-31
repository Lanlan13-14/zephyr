import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appJs = readFileSync(path.join(root, 'public/app.js'), 'utf8');
const styleCss = readFileSync(path.join(root, 'public/style.css'), 'utf8');
const appHtml = readFileSync(path.join(root, 'public/app.html'), 'utf8');
const swJs = readFileSync(path.join(root, 'public/sw.js'), 'utf8');

const CACHE = '20260731-fullscreen-stretch1';

function extractFn(src, name) {
    const re = new RegExp(`function ${name}\\s*\\(`);
    const m = re.exec(src);
    assert.ok(m, `${name} missing`);
    /* Skip parameter-list braces like `{ instant = false }` and land on the body. */
    let i = m.index + m[0].length - 1; // at '('
    let depth = 0;
    for (; i < src.length; i++) {
        const c = src[i];
        if (c === '(') depth++;
        else if (c === ')') {
            depth--;
            if (depth === 0) { i++; break; }
        }
    }
    while (i < src.length && /\s/.test(src[i])) i++;
    assert.equal(src[i], '{', `${name} body missing`);
    const brace = i;
    depth = 0;
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

test('activity range tabs ship a sliding thumb element', () => {
    assert.match(appHtml, /class="activity-range-tabs"/);
    assert.match(appHtml, /class="activity-range-thumb"/);
    for (const range of ['today', '7d', '30d', 'all', 'custom']) {
        assert.match(appHtml, new RegExp(`data-activity-range="${range}"`));
    }
});

test('CSS drives thumb geometry with width/transform transitions', () => {
    assert.match(styleCss, /\.activity-range-thumb\s*\{[\s\S]*?width:\s*var\(--activity-thumb-w\)/);
    assert.match(styleCss, /\.activity-range-thumb\s*\{[\s\S]*?transform:\s*translate3d\(var\(--activity-thumb-x\), 0, 0\)/);
    assert.match(styleCss, /\.activity-range-thumb\s*\{[\s\S]*?transition:[\s\S]*?transform 240ms[\s\S]*?width 240ms/);
    assert.match(styleCss, /\.activity-range-tabs\.no-thumb-transition \.activity-range-thumb\s*\{[\s\S]*?transition:\s*none/);
    assert.match(styleCss, /prefers-reduced-motion:\s*reduce[\s\S]*?\.activity-range-thumb[\s\S]*?transition:\s*none/);
    // Active chip no longer paints its own solid background — thumb owns the fill.
    assert.match(styleCss, /\.activity-range-btn\.active\s*\{[\s\S]*?background:\s*transparent/);
    assert.doesNotMatch(styleCss, /\.activity-range-btn\.active\s*\{[^}]*background:\s*var\(--accent-soft-bg\)/);
});

test('JS measures active chip and animates selection changes', () => {
    const syncFn = extractFn(appJs, 'syncActivityRangeThumb');
    assert.match(syncFn, /--activity-thumb-x/);
    assert.match(syncFn, /--activity-thumb-w/);
    assert.match(syncFn, /offsetLeft/);
    assert.match(syncFn, /offsetWidth/);
    assert.match(syncFn, /no-thumb-transition/);

    const setFn = extractFn(appJs, 'setActivityRangeSelection');
    assert.match(setFn, /classList\.toggle\('active'/);
    assert.match(setFn, /syncActivityRangeThumb\(\{\s*instant:\s*!animate\s*\}\)/);
    assert.match(setFn, /activityCustomRange/);

    assert.match(appJs, /setActivityRangeSelection\(next,\s*\{\s*animate:\s*true\s*\}\)/);
    assert.match(appJs, /setActivityRangeSelection\(activityRange,\s*\{\s*animate:\s*false\s*\}\)/);
    assert.match(appJs, /ResizeObserver/);
    // Locale re-render path must re-measure after label text changes.
    const renderFn = extractFn(appJs, 'renderActivities');
    assert.match(renderFn, /syncActivityRangeThumb\(\{\s*instant:\s*true\s*\}\)/);
});

test('cache bust revision is consistent across app shell assets', () => {
    assert.match(appHtml, new RegExp(`app\\.js\\?v=${CACHE}`));
    assert.match(appHtml, new RegExp(`style\\.css\\?v=${CACHE}`));
    assert.match(swJs, new RegExp(`app\\.js\\?v=${CACHE}`));
    assert.match(swJs, new RegExp(`style\\.css\\?v=${CACHE}`));
});
