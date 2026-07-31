import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const storageJs = readFileSync(path.join(root, 'storage.js'), 'utf8');
const serverJs = readFileSync(path.join(root, 'server.js'), 'utf8');
const appJs = readFileSync(path.join(root, 'public/app.js'), 'utf8');
const styleCss = readFileSync(path.join(root, 'public/style.css'), 'utf8');
const appHtml = readFileSync(path.join(root, 'public/app.html'), 'utf8');
const swJs = readFileSync(path.join(root, 'public/sw.js'), 'utf8');
const CACHE = '20260731-mobile-motion-fix2';

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

test('cache revision bumped for activity meta fix', () => {
    assert.match(appHtml, new RegExp(`app\\.js\\?v=${CACHE}`));
    assert.match(appHtml, new RegExp(`style\\.css\\?v=${CACHE}`));
    assert.match(swJs, new RegExp(`app\\.js\\?v=${CACHE}`));
    assert.match(swJs, new RegExp(`style\\.css\\?v=${CACHE}`));
});
