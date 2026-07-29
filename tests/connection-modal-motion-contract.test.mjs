import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const js = readFileSync(path.join(root, 'public/app.js'), 'utf8');
const html = readFileSync(path.join(root, 'public/app.html'), 'utf8');
const css = readFileSync(path.join(root, 'public/style.css'), 'utf8');
function fn(name) {
  const i=js.indexOf(`function ${name}(`); assert.ok(i>=0, `${name} missing`);
  const sigEnd=js.indexOf(') {',i); const b=js.indexOf('{',sigEnd); let d=0;
  for(let j=b;j<js.length;j++){ if(js[j]==='{')d++; else if(js[j]==='}'&&!--d)return js.slice(i,j+1); }
  throw new Error(`unterminated ${name}`);
}
test('connection open/close reuses figure-four ios app motion', () => {
  const open=fn('openModal'), close=fn('closeModal');
  assert.match(open,/Motion\.iosAppOpen\(surface, source/);
  assert.match(close,/Motion\.iosAppClose\(surface, origin/);
  assert.match(open,/shapePreset:\s*'shape'/);
  assert.match(close,/shapePreset:\s*'shapeClose'/);
  assert.match(open,/cloneSource:\s*true/);
  assert.match(open,/hideSource:\s*true/);
  assert.match(open,/contentEl:\s*card/);
  assert.match(close,/contentEl:\s*card/);
});
test('retired handwritten connection transition is fully removed', () => {
  for (const src of [js, html, css]) {
    assert.doesNotMatch(src,/connectionTransitionLayer/);
    assert.doesNotMatch(src,/connection-transition-opening/);
    assert.doesNotMatch(src,/connection-home-blur/);
  }
});
test('connection modal owns a dedicated content and scrim layer', () => {
  assert.match(html,/id="connectionModalScrim"/);
  assert.match(html,/id="connectionMotionSurface"/);
  assert.match(html,/id="connectionModalInner" class="connection-modal-inner"/);
  assert.match(css,/#connectionMotionSurface[\s\S]*?contain:\s*strict/);
  assert.match(css,/#connectionModal #connectionForm[\s\S]*?will-change:\s*opacity/);
  assert.match(css,/body\.connection1-blurring #connectionModalScrim/);
});
test('connection selects reuse figure-five filter menu motion', () => {
  const block=js.match(/const MOTION_FILTER_SELECT_IDS = \[([\s\S]*?)\];/)?.[1] || '';
  for (const id of ['connProtocol','connSshKey','connEncoding','connRoute','rdpSoundMode','rdpResolution','rdpQuality','rdpFps','rdpTouchMode']) {
    assert.match(block,new RegExp(`'${id}'`));
  }
  assert.match(fn('openToggleSelectMenu'),/Motion\.morph\(menu, from/);
  assert.match(fn('closeToggleSelectMenu'),/preset:\s*'macClose'/);
});

test('connection motion is interruptible and never scales the long form', () => {
  const open=fn('openModal'), close=fn('closeModal');
  assert.match(open,/connectionModalMotion\.phase = 'opening'/);
  assert.match(close,/connectionModalMotion\.phase = 'closing'/);
  assert.match(open,/Motion\.iosAppOpen\(surface, source/);
  assert.match(close,/Motion\.iosAppClose\(surface, origin/);
  assert.doesNotMatch(open,/Motion\.iosAppOpen\(card/);
  assert.doesNotMatch(close,/getBoundingClientRect\(\).*origin/);
});
test('close target is the frozen pre-animation rect', () => {
  assert.match(fn('openModal'),/connectionModalMotion\.originRect = stableConnectionSourceRect\(source\)/);
  assert.match(fn('closeModal'),/const origin = connectionModalMotion\.originRect/);
  assert.doesNotMatch(fn('closeModal'),/trigger\?\.getBoundingClientRect/);
});
test('connection timing and curve options exactly match new proxy', () => {
  const open=fn('openModal'), close=fn('closeModal');
  for (const rule of [/contentDelay:\s*0\.16/, /faceDelay:\s*0\.05/, /faceInDelay:\s*0\.04/, /shapePreset:\s*'shape'/, /contentPreset:\s*'content'/]) assert.match(open, rule);
  for (const rule of [/faceInDelay:\s*0\.04/, /shapePreset:\s*'shapeClose'/, /contentPreset:\s*'contentClose'/, /setTimeout\(resolve, 900\)/]) assert.match(close, rule);
});
test('connection form fully expands and backdrop owns the only scroll', () => {
  assert.match(css, /#connectionModal #connectionForm[\s\S]*?max-height:\s*none\s*!important[\s\S]*?overflow:\s*visible\s*!important/);
  assert.match(css, /#connectionModal\.connection1[\s\S]*?overflow-y:\s*auto/);
  assert.match(fn('openModal'), /card\.style\.overflow = 'visible'/);
  assert.match(fn('openModal'), /card\.style\.maxHeight = 'none'/);
});
test('blank backdrop and scrim clicks interrupt opening via closeModal', () => {
  assert.match(js, /\$\('#connectionModal'\)\?\.addEventListener\('click',[\s\S]*?e\.target\.id === 'connectionModal'[\s\S]*?closeModal\(\)/);
  assert.match(js, /\$\('#connectionModalScrim'\)\?\.addEventListener\('click',[\s\S]*?classList\.contains\('show'\)[\s\S]*?closeModal\(\)/);
  assert.match(js, /e\.key === 'Escape'[\s\S]*?#connectionModal[\s\S]*?closeModal\(\)/);
});
