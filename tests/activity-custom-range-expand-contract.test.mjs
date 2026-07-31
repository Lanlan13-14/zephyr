import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const motionJs = readFileSync(path.join(root, 'public/vendor/zephyr-motion/motion.js'), 'utf8');
const appJs = readFileSync(path.join(root, 'public/app.js'), 'utf8');
const styleCss = readFileSync(path.join(root, 'public/style.css'), 'utf8');
const appHtml = readFileSync(path.join(root, 'public/app.html'), 'utf8');
const swJs = readFileSync(path.join(root, 'public/sw.js'), 'utf8');
const CACHE = '20260731-activity-ux1';

test('Motion.expand provides Apple-style height+opacity expand/collapse', () => {
  assert.match(motionJs, /async expand\(el, opts = \{\}\)/);
  assert.match(motionJs, /hiddenClass/);
  assert.match(motionJs, /tween\(el, \{ h: targetH, opacity: 1 \}/);
  assert.match(motionJs, /tween\(el, \{ h: 0, opacity: 0 \}/);
  assert.match(motionJs, /el\.style\.overflow = 'hidden';/);
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
  assert.doesNotMatch(appJs, /#activityCustomRange'\)\?\.classList\.toggle\('force-hidden', activityRange !== 'custom'\)/);
  assert.match(styleCss, /#activityCustomRange\.activity-custom-range/);
});

test('cache revision covers activity custom expand', () => {
  assert.match(appHtml, new RegExp(`app\\.js\\?v=${CACHE}`));
  assert.match(appHtml, new RegExp(`style\\.css\\?v=${CACHE}`));
  assert.match(swJs, new RegExp(`app\\.js\\?v=${CACHE}`));
  assert.match(appHtml, /zephyr-motion\/index\.js\?v=20260731-motion-expand1/);
});
