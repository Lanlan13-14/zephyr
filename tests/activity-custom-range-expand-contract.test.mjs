import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertAssetVersion, singleAssetVersion } from './helpers/cache-version.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const motionJs = readFileSync(path.join(root, 'public/vendor/zephyr-motion/motion.js'), 'utf8');
const appJs = readFileSync(path.join(root, 'public/app.js'), 'utf8');
const styleCss = readFileSync(path.join(root, 'public/style.css'), 'utf8');
const appHtml = readFileSync(path.join(root, 'public/app.html'), 'utf8');
const swJs = readFileSync(path.join(root, 'public/sw.js'), 'utf8');

test('Motion.expand provides Apple-style height+opacity expand/collapse', () => {
  assert.match(motionJs, /async expand\(el, opts = \{\}\)/);
  assert.match(motionJs, /hiddenClass/);
  assert.match(motionJs, /tween\(el, \{ h: targetH, opacity: 1 \}/);
  assert.match(motionJs, /const hSlot = slotFor\(el, 'h'\)/);
  assert.match(motionJs, /const opacitySlot = slotFor\(el, 'opacity'\)/);
  assert.match(motionJs, /engine\.setValue\(hSlot\.id, startH \* \(1 - q\)\)/);
  assert.match(motionJs, /engine\.setValue\(opacitySlot\.id, startO \* \(1 - q\)\)/);
  assert.match(motionJs, /el\.style\.overflow = 'hidden';/);
  assert.match(motionJs, /marginTop/);
  assert.match(motionJs, /paddingTop/);
  assert.match(motionJs, /borderTopWidth/);
  assert.ok(motionJs.indexOf('paddingTop') < motionJs.lastIndexOf("el.style.height = '';"));
  assert.ok(motionJs.indexOf("el.classList.add(hiddenClass);") < motionJs.lastIndexOf("el.style.height = '';"));
  assert.match(motionJs, /bezier/);
  assert.match(motionJs, /0\.32, 0\.72, 0, 1/);
});

test('activity custom range uses Motion.expand instead of instant force-hidden toggle', () => {
  assert.match(appJs, /function setActivityCustomRangeVisible/);
  assert.match(appJs, /Motion\.expand\(el,/);
  assert.match(appJs, /setActivityCustomRangeVisible\(activityRange === 'custom'/);
  assert.match(appJs, /return customRangeMotion;/);
  assert.match(appJs, /await customRangeMotion;[\s\S]*await loadActivities\(\);/);
  assert.doesNotMatch(appJs, /#activityCustomRange'\)\?\.classList\.toggle\('force-hidden', activityRange !== 'custom'\)/);
  assert.match(styleCss, /\.activity-filter-bar\s*\{[\s\S]*?gap:\s*0;/);
  assert.match(styleCss, /\.activity-custom-range\s*\{[^}]*margin-top:\s*12px;/);
  assert.match(styleCss, /#activityCustomRange\.activity-custom-range/);
});

test('cache revision covers activity custom expand', () => {
  const appVersion = singleAssetVersion(appHtml, 'app.js', 'app shell app.js');
  assertAssetVersion(appHtml, 'style.css', appVersion, 'app shell style.css');
  assertAssetVersion(swJs, 'app.js', appVersion, 'service worker app.js');
  assert.match(appHtml, /zephyr-motion\/index\.js\?v=20260731-motion-mobile-fix2/);
});
