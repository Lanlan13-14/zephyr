'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var L = require('../public/liquid-glass-tab-layout.js');

var failed = 0;
var passed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('ok  ' + name);
  } catch (err) {
    failed += 1;
    console.error('FAIL  ' + name);
    console.error('      ' + (err && err.stack ? err.stack : err));
  }
}

/* ------------------------------------------------------------------ */
test('hitIndexFromX clamps and uses equal cells', function () {
  // glass 0..600, 6 tabs → 100px each. x=450 is 笔记 (index 4)
  assert.strictEqual(L.hitIndexFromX(450, 0, 600, 6), 4);
  assert.strictEqual(L.hitIndexFromX(0, 0, 600, 6), 0);
  assert.strictEqual(L.hitIndexFromX(599, 0, 600, 6), 5);
  assert.strictEqual(L.hitIndexFromX(-20, 0, 600, 6), 0);
  assert.strictEqual(L.hitIndexFromX(800, 0, 600, 6), 5);
  assert.strictEqual(L.hitIndexFromX(100, 0, 600, 0), -1);
  assert.strictEqual(L.hitIndexFromX(50, 20, 600, 6), 0);
  assert.strictEqual(L.hitIndexFromX(120, 20, 600, 6), 1);
});

test('mouse tap 0px → activate hit, not start', function () {
  var r = L.resolveTabGesture({
    dx: 0, pointerType: 'mouse', hitIndex: 4, snappedIndex: 0,
  });
  assert.strictEqual(r.kind, 'tap');
  assert.strictEqual(r.index, 4);
  assert.strictEqual(r.suppressClick, true);
});

test('BUG: 5px mouse jitter used to be a 3px drag that snaps back to current', function () {
  var oldThreshold = 3;
  assert.ok(Math.abs(5) > oldThreshold, 'documents the old bug');
  var r = L.resolveTabGesture({
    dx: 5, pointerType: 'mouse', hitIndex: 4, snappedIndex: 0,
  });
  assert.strictEqual(r.kind, 'tap');
  assert.strictEqual(r.index, 4);
  assert.notStrictEqual(r.index, 0);
});

test('mouse 8px is still a tap (threshold is exclusive >)', function () {
  assert.strictEqual(L.dragThresholdPx('mouse'), 8);
  var r = L.resolveTabGesture({
    dx: 8, pointerType: 'mouse', hitIndex: 2, snappedIndex: 0,
  });
  assert.strictEqual(r.kind, 'tap');
  assert.strictEqual(r.index, 2);
});

test('mouse 9px is a drag and uses snapped index', function () {
  var r = L.resolveTabGesture({
    dx: 9, pointerType: 'mouse', hitIndex: 4, snappedIndex: 2,
  });
  assert.strictEqual(r.kind, 'drag');
  assert.strictEqual(r.index, 2);
  assert.strictEqual(r.suppressClick, true);
});

test('touch 12px tap, 13px drag (finger jitter)', function () {
  assert.strictEqual(L.dragThresholdPx('touch'), 12);
  assert.strictEqual(L.dragThresholdPx('pen'), 12);
  var tap = L.resolveTabGesture({
    dx: 12, pointerType: 'touch', hitIndex: 3, snappedIndex: 0,
  });
  assert.strictEqual(tap.kind, 'tap');
  assert.strictEqual(tap.index, 3);
  var drag = L.resolveTabGesture({
    dx: 13, pointerType: 'touch', hitIndex: 3, snappedIndex: 1,
  });
  assert.strictEqual(drag.kind, 'drag');
  assert.strictEqual(drag.index, 1);
});

test('explicit didDrag=false wins over large dx (up() must not reclassify)', function () {
  var r = L.resolveTabGesture({
    dx: 40, pointerType: 'mouse', hitIndex: 5, snappedIndex: 0, didDrag: false,
  });
  assert.strictEqual(r.kind, 'tap');
  assert.strictEqual(r.index, 5);
});

test('explicit didDrag=true wins over tiny dx', function () {
  var r = L.resolveTabGesture({
    dx: 1, pointerType: 'mouse', hitIndex: 5, snappedIndex: 2, didDrag: true,
  });
  assert.strictEqual(r.kind, 'drag');
  assert.strictEqual(r.index, 2);
});

test('machine: tap with 5px jitter never beginDrag, activates hit', function () {
  var m = L.createTabPointerMachine({ pointerType: 'mouse' });
  var d = m.down(100, 4, 0);
  assert.strictEqual(d.beginDrag, false);
  var mv = m.move(105);
  assert.strictEqual(mv.drag, false);
  assert.strictEqual(mv.beginDrag, false);
  assert.strictEqual(m.isDragged(), false);
  var up = m.up(0, 105);
  assert.strictEqual(up.kind, 'tap');
  assert.strictEqual(up.activate, 4);
  assert.strictEqual(up.suppressClick, true);
});

test('machine: crossing threshold begins drag once, up uses snap', function () {
  var m = L.createTabPointerMachine({ pointerType: 'mouse' });
  m.down(100, 0, 0);
  var still = m.move(107);
  assert.strictEqual(still.drag, false);
  var first = m.move(110);
  assert.strictEqual(first.drag, true);
  assert.strictEqual(first.beginDrag, true);
  var second = m.move(180);
  assert.strictEqual(second.drag, true);
  assert.strictEqual(second.beginDrag, false);
  var up = m.up(2, 180);
  assert.strictEqual(up.kind, 'drag');
  assert.strictEqual(up.activate, 2);
});

test('machine: cancel after tap does not endDrag', function () {
  var m = L.createTabPointerMachine({ pointerType: 'mouse' });
  m.down(10, 1, 1);
  m.move(12);
  var c = m.cancel();
  assert.strictEqual(c.endDrag, false);
});

test('machine: cancel after drag must endDrag so spring is released', function () {
  var m = L.createTabPointerMachine({ pointerType: 'mouse' });
  m.down(10, 1, 1);
  m.move(40);
  var c = m.cancel();
  assert.strictEqual(c.endDrag, true);
});

test('machine: idle up does nothing', function () {
  var m = L.createTabPointerMachine({ pointerType: 'mouse' });
  var up = m.up(3, 0);
  assert.strictEqual(up.kind, 'idle');
  assert.strictEqual(up.activate, -1);
});

test('machine: tap on same tab still reports that index', function () {
  var m = L.createTabPointerMachine({ pointerType: 'mouse' });
  m.down(200, 0, 0);
  var up = m.up(0, 200);
  assert.strictEqual(up.kind, 'tap');
  assert.strictEqual(up.activate, 0);
});

test('SIM: click notes while dashboard selected — must activate 4, not snap to 0', function () {
  var log = [];
  var current = 0;
  function begin() { log.push('begin'); }
  function endSnap() { log.push('end'); return current; }
  var m = L.createTabPointerMachine({ pointerType: 'mouse' });
  m.down(450, 4, current);
  m.move(454); // 4px jitter, old 3px threshold would drag
  assert.strictEqual(m.isDragged(), false);
  var up = m.up(current, 454);
  if (m.isDragged()) begin();
  if (up.kind === 'drag') endSnap();
  log.push('activate:' + up.activate);
  assert.deepStrictEqual(log, ['activate:4']);
});

test('SIM: drag from dashboard to notes — begin/end then activate snap', function () {
  var log = [];
  var m = L.createTabPointerMachine({ pointerType: 'mouse' });
  m.down(50, 0, 0);
  var a = m.move(200);
  if (a.beginDrag) log.push('begin');
  if (a.drag) log.push('drag');
  var up = m.up(4, 200);
  if (up.kind === 'drag') log.push('end');
  log.push('activate:' + up.activate);
  assert.deepStrictEqual(log, ['begin', 'drag', 'end', 'activate:4']);
});

test('nav.js: pointerdown must not beginTabDrag (that ate clicks)', function () {
  var src = fs.readFileSync(
    path.join(__dirname, '../public/liquid-glass-nav.js'),
    'utf8'
  );
  var down = src.slice(
    src.indexOf("navTabs.addEventListener('pointerdown'"),
    src.indexOf("navTabs.addEventListener('pointermove'")
  );
  assert.ok(down.indexOf('beginTabDrag') === -1, 'pointerdown must not beginTabDrag:\n' + down);
  assert.ok(down.indexOf('createTabPointerMachine') !== -1);
  assert.ok(down.indexOf('hitTabIndex') !== -1);
});

test('nav.js must not resize canvas on beginDrag (stretch + black flash)', function () {
  var src = fs.readFileSync(
    path.join(__dirname, '../public/liquid-glass-nav.js'),
    'utf8'
  );
  var move = src.slice(
    src.indexOf("navTabs.addEventListener('pointermove'"),
    src.indexOf('function endPointer')
  );
  assert.ok(move.indexOf('overlayCanvas()') === -1, 'beginDrag must not grow canvas');
  assert.ok(move.indexOf('renderer.resize') === -1);
  assert.ok(src.indexOf('freezePressScale: true') === -1, 'press must use original 78/56');
});

test('nav.js: beginTabDrag only when machine says beginDrag', function () {
  var src = fs.readFileSync(
    path.join(__dirname, '../public/liquid-glass-nav.js'),
    'utf8'
  );
  var move = src.slice(
    src.indexOf("navTabs.addEventListener('pointermove'"),
    src.indexOf('function endPointer')
  );
  assert.ok(move.indexOf('if (r.beginDrag)') !== -1);
  assert.ok(move.indexOf('beginTabDrag') !== -1);
  var idxIf = move.indexOf('if (r.beginDrag)');
  var idxBegin = move.indexOf('beginTabDrag');
  assert.ok(idxIf < idxBegin);
});

test('nav.js: tap path calls activateTab with machine result', function () {
  var src = fs.readFileSync(
    path.join(__dirname, '../public/liquid-glass-nav.js'),
    'utf8'
  );
  var end = src.slice(
    src.indexOf('function endPointer'),
    src.indexOf("navTabs.addEventListener('pointerup'")
  );
  assert.ok(end.indexOf('activateTab(r.activate)') !== -1);
  assert.ok(end.indexOf('wasDrag') !== -1);
  assert.ok(end.indexOf('endTabDrag') !== -1);
  // tap must not endTabDrag (never began)
  assert.ok(/wasDrag && n\s*\n\s*\? renderer\.endTabDrag/.test(end) ||
    end.indexOf('wasDrag && n') !== -1);
});

test('nav.js: click capture suppresses only the gesture-owned click', function () {
  var src = fs.readFileSync(
    path.join(__dirname, '../public/liquid-glass-nav.js'),
    'utf8'
  );
  assert.ok(src.indexOf("navTabs.addEventListener('click'") !== -1);
  assert.ok(src.indexOf('stopImmediatePropagation') !== -1);
  assert.ok(src.indexOf("setTimeout(function () { suppressClick = false; }, 0)") !== -1);
});

test('nav.js no longer uses the 3px drag slop', function () {
  var src = fs.readFileSync(
    path.join(__dirname, '../public/liquid-glass-nav.js'),
    'utf8'
  );
  assert.ok(src.indexOf('<= 3') === -1);
  assert.ok(src.indexOf('Math.abs(dx) <= 3') === -1);
});

test('nav.js hitTabIndex must not trust closest(.nav-tab)', function () {
  var src = fs.readFileSync(
    path.join(__dirname, '../public/liquid-glass-nav.js'),
    'utf8'
  );
  var hit = src.slice(
    src.indexOf('function hitTabIndex'),
    src.indexOf("navTabs.addEventListener('pointerdown'")
  );
  assert.ok(hit.indexOf("closest('.nav-tab')") === -1, 'packed DOM closest is why 活动 → 远程执行');
  assert.ok(hit.indexOf('hitIndexFromX') !== -1);
  assert.ok(hit.indexOf('glassClient') !== -1);
});

test('nav.js drag width uses the same measured rects as hit testing', function () {
  var src = fs.readFileSync(
    path.join(__dirname, '../public/liquid-glass-nav.js'),
    'utf8'
  );
  var current = src.slice(
    src.indexOf('function currentTabWidth'),
    src.indexOf('function hitTabIndex')
  );
  var hit = src.slice(
    src.indexOf('function hitTabIndex'),
    src.indexOf("navTabs.addEventListener('pointerdown'")
  );
  assert.ok(current.indexOf('measureDomRects') !== -1);
  assert.ok(hit.indexOf('measureDomRects') !== -1);
  assert.ok(hit.indexOf('hitIndexFromRects') !== -1);
  assert.ok(current.indexOf('bar.width - 8') === -1);
});

test('SIM: visual 活动 click must activate 1, not packed 远程执行', function () {
  var labels = ['仪表盘', '活动', '终端', '远程执行', '笔记', '设置'];
  var hug = L.pickEqualTabWidth([78, 58, 58, 96, 58, 58]);
  var packedW = labels.map(function () { return hug; });
  var glassX = 0;
  var glassW = 1200;
  var x = L.cellCenter(L.equalTabCells(glassX, 0, glassW, 32, 6)[1]).x;
  var visual = L.hitIndexFromX(x, glassX, glassW, 6);
  var packed = L.packedIndexFromX(x, glassX, packedW);
  assert.strictEqual(labels[visual], '活动');
  assert.strictEqual(labels[packed], '远程执行');
  var m = L.createTabPointerMachine({ pointerType: 'mouse' });
  m.down(x, visual, 0);
  var up = m.up(0, x);
  assert.strictEqual(up.kind, 'tap');
  assert.strictEqual(up.activate, 1);
  assert.notStrictEqual(up.activate, packed);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
