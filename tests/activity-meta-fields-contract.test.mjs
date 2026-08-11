import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertAssetVersion, cacheNameVersion, singleAssetVersion } from './helpers/cache-version.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const storageJs = readFileSync(path.join(root, 'storage.js'), 'utf8');
const serverJs = readFileSync(path.join(root, 'server.js'), 'utf8');
const appJs = readFileSync(path.join(root, 'public/app.js'), 'utf8');
const styleCss = readFileSync(path.join(root, 'public/style.css'), 'utf8');
const appHtml = readFileSync(path.join(root, 'public/app.html'), 'utf8');
const swJs = readFileSync(path.join(root, 'public/sw.js'), 'utf8');
const i18nRuntimeJs = readFileSync(path.join(root, 'public/i18n/runtime.js'), 'utf8');
const activityI18nJs = readFileSync(path.join(root, 'public/activity-i18n.js'), 'utf8');
const notesJs = readFileSync(path.join(root, 'public/notes.js'), 'utf8');
const previewMockJs = readFileSync(path.join(root, 'public/preview-mock.js'), 'utf8');

test('activities table persists sourceIp and durationMs (plus detail columns)', () => {
    assert.match(storageJs, /addColumnIfMissing\('activities', 'sourceIp'/);
    assert.match(storageJs, /addColumnIfMissing\('activities', 'durationMs'/);
    assert.match(storageJs, /addColumnIfMissing\('activities', 'category'/);
    assert.match(storageJs, /addColumnIfMissing\('activities', 'outcome'/);
    assert.match(storageJs, /addColumnIfMissing\('activities', 'connectionId'/);
    assert.match(storageJs, /INSERT INTO activities[\s\S]*sourceIp[\s\S]*durationMs[\s\S]*connectionId/);
});

test('server addActivity accepts meta and stamps request IP', () => {
    assert.match(serverJs, /function addActivity\(message, userId = null, meta = \{\}\)/);
    assert.match(serverJs, /function activityFromReq\(req, extra = \{\}\)/);
    assert.match(serverJs, /sourceIp:\s*extra\.sourceIp \|\| \(req \? clientIp\(req\) : null\)/);
    assert.match(serverJs, /durationMs:\s*Number\.isFinite\(Number\(extra\.durationMs\)\)/);
    // Timed paths must write duration (message uses fullwidth colon ：)
    assert.match(serverJs, /addActivity\(`测试连接：\$\{conn\.name[\s\S]*?durationMs: result\.durationMs/);
    assert.match(serverJs, /addActivity\(`远程执行：\$\{targets\.length[\s\S]*?durationMs: Date\.now\(\) - started/);
    // Open connection stamps protocol/target/IP
    assert.match(serverJs, /addActivity\(`打开连接：\$\{raw\.name\}`[\s\S]*?activityFromReq\(req/);
    // No leftover bare two-arg-only writes that skip meta (except the definition).
    const callLines = serverJs.split('\n').filter((line) => line.includes('addActivity(')
        && !line.includes('function addActivity')
        && !line.includes('storage.addActivity'));
    assert.ok(callLines.length > 10, 'expected many activity writes');
    for (const line of callLines) {
        assert.match(line, /activityFromReq/, `missing meta: ${line.trim()}`);
    }
});

test('frontend renders real sourceIp and hides empty cells without duration UI', () => {
    assert.match(appJs, /const sourceIp = String\(activity\.sourceIp \|\| ''\)\.trim\(\);/);
    assert.match(appJs, /detail\.sourceIp \? `/);
    assert.match(appJs, /t\('来源 IP'\)/);
    // Activity cards no longer surface duration; storage/server still keep durationMs.
    assert.doesNotMatch(appJs, /detail\.duration \? `/);
    assert.doesNotMatch(appJs, /t\('耗时'\)/);
    assert.doesNotMatch(appJs, /durationMs:\s*Number\.isFinite\(durationMs\) \? Math\.max\(0, Math\.round\(durationMs\)\) : null/);
    // Old bug: compared em-dash field against ASCII hyphen, so empty always rendered.
    assert.doesNotMatch(appJs, /detail\.sourceIp !== '-'/);
    assert.doesNotMatch(appJs, /detail\.duration !== '-'/);
});

test('activity cards keep hover affordance without per-card entrance storms', () => {
    assert.match(styleCss, /\.activity-detail-item\s*\{[\s\S]*content-visibility:\s*auto/);
    assert.match(styleCss, /\.activity-detail-item\s*\{[\s\S]*contain-intrinsic-size:\s*auto 180px/);
    assert.match(styleCss, /\.activity-detail-item\s*\{[\s\S]*animation:\s*none/);
    assert.match(styleCss, /\.activity-detail-item:hover/);
    assert.doesNotMatch(styleCss, /\.activity-detail-item\s*\{[\s\S]*animation:\s*activityCardIn/);
});

test('app shell cache versions stay aligned across HTML, i18n, and service worker', () => {
    const appVersion = singleAssetVersion(appHtml, 'app.js', 'app.html app.js references');
    const styleVersion = singleAssetVersion(appHtml, 'style.css', 'app.html style.css references');
    const htmlI18nVersion = singleAssetVersion(appHtml, 'i18n/runtime.js', 'app.html i18n runtime references');
    const appI18nVersion = singleAssetVersion(appJs, 'i18n/runtime.js', 'app.js i18n runtime import');
    const catalogVersionMatch = i18nRuntimeJs.match(/url\.searchParams\.set\('v', '([^']+)'\)/);
    assert.ok(catalogVersionMatch, 'i18n catalog requests must set a cache version');
    const catalogVersion = catalogVersionMatch[1];

    assert.equal(styleVersion, appVersion);
    assert.equal(htmlI18nVersion, appVersion);
    assert.equal(appI18nVersion, appVersion);
    assert.equal(catalogVersion, appVersion);
    assertAssetVersion(appJs, 'activity-i18n.js', appVersion, 'app.js activity i18n import');
    assertAssetVersion(appJs, 'notes.js', appVersion, 'app.js notes import');
    assertAssetVersion(appHtml, 'preview-mock.js', appVersion, 'app.html preview mock script');
    assertAssetVersion(activityI18nJs, 'i18n/runtime.js', appVersion, 'activity i18n runtime import');
    assertAssetVersion(notesJs, 'i18n/runtime.js', appVersion, 'notes i18n runtime import');
    assertAssetVersion(previewMockJs, 'i18n/runtime.js', appVersion, 'preview mock i18n runtime import');
    assert.equal(cacheNameVersion(swJs), appVersion);
    assertAssetVersion(swJs, 'app.js', appVersion, 'service worker app.js');
    assertAssetVersion(swJs, 'style.css', appVersion, 'service worker style.css');
    assertAssetVersion(swJs, 'i18n/runtime.js', appVersion, 'service worker i18n runtime');
    assertAssetVersion(swJs, 'i18n/locales/en.json', appVersion, 'service worker English catalog');
    assertAssetVersion(swJs, 'i18n/locales/zh-CN.json', appVersion, 'service worker Chinese catalog');
    assertAssetVersion(swJs, 'activity-i18n.js', appVersion, 'service worker activity i18n');
    assertAssetVersion(swJs, 'notes.js', appVersion, 'service worker notes');
    assertAssetVersion(swJs, 'preview-mock.js', appVersion, 'service worker preview mock');
});
