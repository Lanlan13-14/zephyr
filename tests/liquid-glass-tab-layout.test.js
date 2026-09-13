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

function approx(a, b, eps) {
  eps = eps == null ? 1e-9 : eps;
  assert.ok(Math.abs(a - b) <= eps, 'expected ' + a + ' ≈ ' + b + ' (eps=' + eps + ')');
}

/* ------------------------------------------------------------------ */
test('empty widths → 0', function () {
  assert.strictEqual(L.pickEqualTabWidth([]), 0);
  assert.strictEqual(L.pickEqualTabWidth(null), 0);
});

test('pickEqualTabWidth takes the longest label', function () {
  // 仪表盘 / 活动 / 终端 / 远程执行 / 笔记 / 设置
  var widths = [78, 58, 58, 96, 58, 58];
  assert.strictEqual(L.pickEqualTabWidth(widths), 96);
});

test('pickEqualTabWidth clamps to available inner width', function () {
  var widths = [78, 58, 58, 96, 58, 58];
  assert.strictEqual(L.pickEqualTabWidth(widths, 480), 80);
  assert.strictEqual(L.pickEqualTabWidth(widths, 96 * 6), 96);
  assert.strictEqual(L.pickEqualTabWidth(widths, 0), 96);
});

test('equalTabCells: n=0 is empty', function () {
  assert.deepStrictEqual(L.equalTabCells(10, 4, 600, 32, 0), []);
});

test('equalTabCells: six equal slots fill glassW exactly', function () {
  var cells = L.equalTabCells(10, 4, 600, 32, 6);
  assert.strictEqual(cells.length, 6);
  cells.forEach(function (c, i) {
    approx(c.w, 100);
    approx(c.h, 32);
    approx(c.y, 4);
    approx(c.x, 10 + 100 * i);
  });
  var last = cells[5];
  approx(last.x + last.w, 10 + 600);
});

test('equalTabCells: one tab is the whole glass', function () {
  var cells = L.equalTabCells(8, 2, 240, 40, 1);
  assert.strictEqual(cells.length, 1);
  approx(cells[0].x, 8);
  approx(cells[0].w, 240);
});

test('indicator at integer fraction sits on that cell', function () {
  var glassX = 14;
  var glassY = 6;
  var glassW = 720;
  var glassH = 36;
  var n = 6;
  var tabW = glassW / n;
  var cells = L.equalTabCells(glassX, glassY, glassW, glassH, n);
  for (var i = 0; i < n; i++) {
    var ind = L.indicatorRect(glassX, glassY, tabW, glassH, i);
    approx(ind.x, cells[i].x);
    approx(ind.w, cells[i].w);
    approx(L.cellCenter(ind).x, L.cellCenter(cells[i]).x);
    approx(L.cellCenter(ind).y, L.cellCenter(cells[i]).y);
  }
});

test('indicator at fractional index sits between two cells', function () {
  var cells = L.equalTabCells(0, 0, 600, 32, 6);
  var ind = L.indicatorRect(0, 0, 100, 32, 4.3);
  approx(ind.x, 430);
  assert.ok(ind.x > cells[4].x);
  assert.ok(ind.x < cells[5].x);
});

test('REGRESSION: unequal DOM widths + first-tab dragWidth puts 笔记 left of pill', function () {
  // 截图复现：flex 内容宽，指示器 dragWidth = 第一格（仪表盘）
  var widths = [78, 58, 58, 96, 58, 58];
  var cells = L.cumulativeCells(0, 0, widths, 32);
  var notes = 4;
  var textCenter = L.cellCenter(cells[notes]).x;
  var ind = L.indicatorRect(0, 0, widths[0], 32, notes);
  var pillCenter = L.cellCenter(ind).x;
  var dx = pillCenter - textCenter;
  assert.ok(dx > 8, 'expected visible left-shift of text vs pill, got dx=' + dx);
  // 笔记格比胶囊窄
  assert.ok(cells[notes].w < ind.w);
});

test('after equalize, every label center matches its indicator', function () {
  var natural = [78, 58, 58, 96, 58, 58];
  var tabW = L.pickEqualTabWidth(natural);
  assert.strictEqual(tabW, 96);
  var equal = natural.map(function () { return tabW; });
  var cells = L.cumulativeCells(4, 4, equal, 32);
  var mathCells = L.equalTabCells(4, 4, tabW * natural.length, 32, natural.length);
  for (var i = 0; i < natural.length; i++) {
    var ind = L.indicatorRect(4, 4, tabW, 32, i);
    approx(L.cellCenter(cells[i]).x, L.cellCenter(ind).x);
    approx(mathCells[i].x, cells[i].x);
    approx(mathCells[i].w, cells[i].w);
  }
});

test('screenshot labels: 笔记 index 4 centers on equal cell 4', function () {
  var labels = ['仪表盘', '活动', '终端', '远程执行', '笔记', '设置'];
  var n = labels.length;
  var glassX = 20;
  var tabW = 90;
  var cells = L.equalTabCells(glassX, 8, tabW * n, 32, n);
  var notes = labels.indexOf('笔记');
  assert.strictEqual(notes, 4);
  var ind = L.indicatorRect(glassX, 8, tabW, 32, notes);
  approx(ind.x, glassX + 4 * tabW);
  approx(L.cellCenter(cells[notes]).x, glassX + 4 * tabW + tabW / 2);
  approx(L.cellCenter(ind).x, L.cellCenter(cells[notes]).x);
});

test('glass padding: container 4px inset, last cell meets inner right', function () {
  var container = { x: 40, y: 12, w: 488, h: 40 };
  var glassX = container.x + 4;
  var glassY = container.y + 4;
  var glassW = container.w - 8;
  var glassH = container.h - 8;
  var n = 6;
  var cells = L.equalTabCells(glassX, glassY, glassW, glassH, n);
  approx(cells[0].x, glassX);
  approx(cells[n - 1].x + cells[n - 1].w, container.x + container.w - 4);
  approx(cells[0].h, 32);
});

test('cumulativeCells preserves order and total width', function () {
  var widths = [10, 20, 30];
  var cells = L.cumulativeCells(5, 1, widths, 8);
  assert.strictEqual(cells.length, 3);
  approx(cells[0].x, 5);
  approx(cells[1].x, 15);
  approx(cells[2].x, 35);
  approx(cells[2].x + cells[2].w, 65);
});

test('nav.js actually uses the equal-cell helpers (not first-tab width)', function () {
  var src = fs.readFileSync(
    path.join(__dirname, '../public/liquid-glass-nav.js'),
    'utf8'
  );
  assert.ok(src.indexOf('measureDomRects') !== -1, 'canvas cells must come from measured DOM buttons');
  assert.ok(src.indexOf('chooseTabWidth') !== -1, 'DOM tabs must fill the bar when hug ≠ inner');
  assert.ok(src.indexOf('hitIndexFromRects') !== -1, 'hit testing must use the same measured rects');
  assert.ok(src.indexOf('avgEqualWidth') !== -1, 'dragWidth must be the measured equal step');
  assert.ok(src.indexOf('dragWidth: tabW') !== -1, 'indicator dragWidth must be equal tabW');
  assert.ok(src.indexOf("force-hidden") !== -1, 'hidden notes/AI must not take a slot');
  // 旧 bug：拿第一格 DOM 宽度当所有格的步长
  assert.ok(
    src.indexOf('rects[0].w') === -1 && src.indexOf('tabRects[0].w') === -1,
    'must not use first DOM rect width as the step'
  );
  assert.ok(src.indexOf('tabRects[0].x') !== -1, 'indicator origin is first equal cell');
});

test('app.html loads tab-layout.js before nav.js', function () {
  var html = fs.readFileSync(
    path.join(__dirname, '../public/app.html'),
    'utf8'
  );
  var layoutAt = html.indexOf('liquid-glass-tab-layout.js');
  var navAt = html.indexOf('liquid-glass-nav.js');
  assert.ok(layoutAt !== -1, 'app.html must include tab-layout.js');
  assert.ok(navAt !== -1, 'app.html must include nav.js');
  assert.ok(layoutAt < navAt, 'tab-layout.js must load before nav.js');
});

test('css locks glass tabs to --lg-tab-w', function () {
  var css = fs.readFileSync(
    path.join(__dirname, '../public/style.css'),
    'utf8'
  );
  assert.ok(css.indexOf('font-weight: 500') !== -1, 'lock weight so active tab does not grow');
  assert.ok(css.indexOf('width: max-content') !== -1, 'desktop island must hug labels');
  assert.ok(css.indexOf('--lg-island: hug') !== -1);
  assert.ok(css.indexOf('--lg-island: fill') !== -1, 'phone island fills 100%');
  assert.ok(css.indexOf('flex: 0 0 var(--lg-tab-w') !== -1, 'desktop tabs hug --lg-tab-w, not width:0');
  assert.ok(css.indexOf('overflow: visible') !== -1, 'canvas shadow must paint below the nav');
  assert.ok(css.indexOf('var(--lg-nav-fill') === -1, 'must not paint a second solid behind the canvas');
  assert.ok(css.indexOf('padding-bottom: 32px') === -1, 'must not fatten the header for the shadow');
  var canvasRule = css.slice(
    css.indexOf('.main-nav.liquid-glass-on #liquidGlassCanvas'),
    css.indexOf('.main-nav.liquid-glass-on > *:not(#liquidGlassCanvas)')
  );
  assert.ok(canvasRule.indexOf('inset: 0') === -1, 'inset:0 clips the 78/56 press overflow');
  assert.ok(canvasRule.indexOf('height: auto') !== -1, 'height follows JS so press overflow can hang below the nav');
  assert.ok(canvasRule.indexOf('bottom: auto') !== -1);
  assert.ok(canvasRule.indexOf('78/56') !== -1, 'comment must name the original press scale');
  assert.ok(css.indexOf('padding-bottom: var(--terminal-shelf-rest-padding)') !== -1, 'rest shelf uses GitHub rest padding');
  assert.ok(css.indexOf('padding-bottom: var(--terminal-shelf-open-padding)') !== -1, 'open shelf uses GitHub open padding');
  assert.ok(!/body:not\(\.terminal-mode\) \.main-nav\s*\{[^}]*padding-bottom:\s*10px/.test(css), 'must not freeze rest padding at 10px');
  assert.ok(css.indexOf('white-space: nowrap') !== -1, 'labels must not wrap and inflate hit rects');
  var themeAt = css.indexOf('.nav-actions #appThemeToggle {');
  assert.ok(themeAt !== -1, 'theme toggle rule must exist');
  var theme = css.slice(themeAt, themeAt + 520);
  assert.ok(theme.indexOf('height: 30px') !== -1, 'theme toggle must match .btn-sm 30px');
  assert.ok(theme.indexOf('height: 34px') === -1, '34px made the moon taller than 登出');
  var lastAi = css.lastIndexOf('.nav-actions .ai-floating-btn {');
  var aiChunk = css.slice(lastAi, lastAi + 520);
  assert.ok(aiChunk.indexOf('border-radius: 50%') !== -1, 'AI button must be a circle like the theme toggle');
  assert.ok(aiChunk.indexOf('width: 30px') !== -1, 'circle, not 42px capsule');
  assert.ok(aiChunk.indexOf('height: 30px') !== -1, 'AI circle matches theme/logout height');
  assert.ok(aiChunk.indexOf('width: 42px') === -1);
  assert.ok(aiChunk.indexOf('border-radius: 9999px') === -1);
  assert.ok(aiChunk.indexOf('border-radius: var(--radius-sm)') === -1);
  var lgOn = css.indexOf('.main-nav.liquid-glass-on {');
  assert.ok(lgOn !== -1);
  var lgChunk = css.slice(lgOn, lgOn + 700);
  assert.ok(lgChunk.indexOf('padding-bottom var(--terminal-shelf-duration)') !== -1, 'glass overlay must keep shelf padding transition');
  assert.ok(
    css.indexOf('--nav-fusion-bg: color-mix(in srgb, var(--surface) 75%, transparent);') !== -1,
    'test-machine glass material is 75% surface, not the old 88%'
  );
  assert.ok(
    css.indexOf('--nav-fusion-bg: color-mix(in srgb, var(--surface) 88%, transparent);') === -1,
    '88% fusion is the GitHub-only dull bar'
  );
  assert.ok(
    css.indexOf('backdrop-filter: blur(20px) saturate(180%);') !== -1,
    'test-machine bar uses Apple blur 20 / sat 180'
  );
  assert.ok(
    css.indexOf('.main-nav.liquid-glass-on .nav-tabs,\n.main-nav.liquid-glass-on .nav-tab {\n    touch-action: none;\n}') !== -1,
    'glass tabs must disable pan so horizontal drag is a tab gesture, not a scroll'
  );
  assert.ok(
    !/\.nav-tabs\s*\{[^}]*overflow-x:\s*auto/.test(css),
    'overflow-x:auto on .nav-tabs steals the horizontal drag'
  );
  assert.ok(css.indexOf('Apple-style Segmented Capsule Navigation') !== -1);
  assert.ok(css.indexOf('Apple-style Right Actions') !== -1);
  assert.ok(css.indexOf('.nav-actions #logoutBtn {') !== -1, 'logout pill lives next to the 30px circles');
  var appleAt = css.indexOf('/* Apple-style Segmented Capsule Navigation */');
  assert.ok(appleAt !== -1);
  var apple = css.slice(appleAt, css.indexOf('/* Settings tab maintains existing styling */'));
  assert.ok(apple.indexOf('display: inline-flex') !== -1, 'capsule is hug, not flex:1 overflow-x');
  assert.ok(apple.indexOf('overflow-x') === -1);
  assert.ok(apple.indexOf('border-radius: 9999px') !== -1);
});

test('THIRD_PARTY_NOTICES lists liquid-glass-webgl next to Kyant AndroidLiquidGlass', function () {
  var notices = fs.readFileSync(
    path.join(__dirname, '../THIRD_PARTY_NOTICES.md'),
    'utf8'
  );
  assert.ok(notices.indexOf('AndroidLiquidGlass') !== -1);
  assert.ok(notices.indexOf('liquid-glass-webgl') !== -1);
  assert.ok(notices.indexOf('https://github.com/martin65536/liquid-glass-webgl') !== -1);
  assert.ok(notices.indexOf('Apache-2.0') !== -1);
  assert.ok(notices.indexOf('public/liquid-glass-renderer.js') !== -1);
});

test('hidden notes/AI must not occupy a hit slot', function () {
  var visible = ['仪表盘', '活动', '终端', '远程执行', '设置'];
  var glassW = 1000;
  var cells5 = L.equalTabCells(0, 0, glassW, 32, visible.length);
  var x = L.cellCenter(cells5[1]).x;
  assert.strictEqual(visible[L.hitIndexFromX(x, 0, glassW, visible.length)], '活动');
  var withHidden = ['仪表盘', '活动', '终端', '远程执行', '笔记', 'AI', '设置'];
  assert.strictEqual(withHidden[L.hitIndexFromX(x, 0, glassW, withHidden.length)], '终端');
});

test('nav.js layout key includes measured first/last cells', function () {
  var src = fs.readFileSync(
    path.join(__dirname, '../public/liquid-glass-nav.js'),
    'utf8'
  );
  var layoutFn = src.slice(src.indexOf('function layout()'), src.indexOf('function activateTab'));
  assert.ok(layoutFn.indexOf('measureDomRects(tabs)') !== -1);
  assert.ok(layoutFn.indexOf('measured[0]') !== -1);
  assert.ok(layoutFn.indexOf('measured[measured.length - 1]') !== -1);
  assert.ok(layoutFn.indexOf('layoutSizeKey(w, h)') !== -1, 'size key must use canvas h (nav height), not barH');
  assert.ok(layoutFn.indexOf('size.barH') === -1, 'barH key ignores shelf padding so canvas stays extended');
  assert.ok(src.indexOf('function followShelfHeight') !== -1);
  assert.ok(src.indexOf("box: 'border-box'") !== -1, 'padding-only shelf must notify via border-box observer');
  assert.ok(src.indexOf("e.propertyName !== 'padding-bottom'") !== -1);
});

test('remainingForTabs subtracts padding, brand, actions, gaps, inset', function () {
  // 1280 client, pad 20+20, brand 140, actions 120, gap 16×2, inset 8
  var inner = L.remainingForTabs(1280, 140, 120, 20, 20, 16, 8);
  assert.strictEqual(inner, 1280 - 20 - 20 - 140 - 120 - 32 - 8);
  assert.strictEqual(L.remainingForTabs(400, 200, 200, 20, 20, 16, 8), 0);
  assert.strictEqual(L.remainingForTabs(800, 0, 0, 20, 20, 16, 8), 752);
});

test('textInkBox is symmetric around the cell and indicator', function () {
  var labels = ['仪表盘', '活动', '终端', '远程执行', '笔记', '设置'];
  function measure(s) {
    var w = 0;
    for (var i = 0; i < s.length; i++) w += s.charCodeAt(i) > 127 ? 13 : 7.5;
    return w;
  }
  var n = labels.length;
  var glassX = 20;
  var glassY = 8;
  var tabW = 90;
  var glassH = 32;
  var cells = L.equalTabCells(glassX, glassY, tabW * n, glassH, n);
  labels.forEach(function (label, i) {
    var ink = L.textInkBox(cells[i], measure(label));
    var ind = L.indicatorRect(glassX, glassY, tabW, glassH, i);
    approx(ink.centerX, L.cellCenter(cells[i]).x);
    approx(ink.centerX, L.cellCenter(ind).x);
    var leftGap = ink.x - ind.x;
    var rightGap = ind.x + ind.w - (ink.x + ink.w);
    approx(leftGap, rightGap, 1e-6);
    assert.ok(ink.w < ind.w, label + ' ink must fit in the pill');
  });
});

test('SCREENSHOT: 13px CJK + 14px pad, first-tab step leaves 笔记 left of pill', function () {
  // 复现用户截图：flex min-content 宽度，指示器按第一格（仪表盘）步进。
  var labels = ['仪表盘', '活动', '终端', '远程执行', '笔记', '设置'];
  function naturalW(s) {
    var text = 0;
    for (var i = 0; i < s.length; i++) text += s.charCodeAt(i) > 127 ? 13 : 7.5;
    return text + 14 * 2; // .nav-tab padding: 6px 14px
  }
  var widths = labels.map(naturalW);
  var cells = L.cumulativeCells(0, 0, widths, 32);
  var notes = labels.indexOf('笔记');
  var ink = L.textInkBox(cells[notes], naturalW(labels[notes]) - 28);
  var pill = L.indicatorRect(0, 0, widths[0], 32, notes);
  var dx = L.cellCenter(pill).x - ink.centerX;
  assert.ok(dx > 6, 'bug must produce visible left shift, dx=' + dx);
});

test('SCREENSHOT: after equalize, 笔记 ink sits on pill center', function () {
  var labels = ['仪表盘', '活动', '终端', '远程执行', '笔记', '设置'];
  function naturalW(s) {
    var text = 0;
    for (var i = 0; i < s.length; i++) text += s.charCodeAt(i) > 127 ? 13 : 7.5;
    return text + 14 * 2;
  }
  var widths = labels.map(naturalW);
  var tabW = L.pickEqualTabWidth(widths);
  var n = labels.length;
  var cells = L.equalTabCells(0, 0, tabW * n, 32, n);
  var notes = 4;
  var ink = L.textInkBox(cells[notes], naturalW('笔记') - 28);
  var pill = L.indicatorRect(0, 0, tabW, 32, notes);
  approx(ink.centerX, L.cellCenter(pill).x);
  var leftGap = ink.x - pill.x;
  var rightGap = pill.x + pill.w - (ink.x + ink.w);
  approx(leftGap, rightGap, 1e-6);
});

test('nav.js uses remainingForTabs and equalizes before measuring canvas', function () {
  var src = fs.readFileSync(
    path.join(__dirname, '../public/liquid-glass-nav.js'),
    'utf8'
  );
  assert.ok(src.indexOf('glassRectFromBar') !== -1);
  assert.ok(src.indexOf('glassClient') !== -1);
  var layoutFn = src.slice(src.indexOf('function layout()'));
  var eq = layoutFn.indexOf('equalizeDomTabs(tabs)');
  var overlay = layoutFn.indexOf('overlayCanvas()');
  assert.ok(eq !== -1 && overlay !== -1 && eq < overlay, 'DOM must be equalized before canvas size');
  assert.ok(src.indexOf('glassW / n') !== -1);
});

test('fillTabWidth spreads across the whole inner width', function () {
  assert.strictEqual(L.fillTabWidth(600, 6), 100);
  assert.strictEqual(L.fillTabWidth(0, 6), 0);
  assert.strictEqual(L.fillTabWidth(480, 0), 0);
  approx(L.fillTabWidth(488 - 8, 6), 80);
});

test('glassRectFromBar subtracts padding', function () {
  var g = L.glassRectFromBar({ left: 40, top: 12, width: 488, height: 40 }, 4, 4, 4, 4);
  approx(g.x, 44);
  approx(g.y, 16);
  approx(g.w, 480);
  approx(g.h, 32);
});

test('BUG: packed hug DOM + stretched canvas: click visual 活动 hits 远程执行', function () {
  var labels = ['仪表盘', '活动', '终端', '远程执行', '笔记', '设置'];
  var natural = [78, 58, 58, 96, 58, 58];
  var hug = L.pickEqualTabWidth(natural);
  assert.strictEqual(hug, 96);
  var glassX = 0;
  var glassW = 1200;
  var visual = L.equalTabCells(glassX, 0, glassW, 32, labels.length);
  var packedW = labels.map(function () { return hug; });
  var activityVisual = L.cellCenter(visual[1]).x;
  approx(activityVisual, 300);
  var packedHit = L.packedIndexFromX(activityVisual, glassX, packedW);
  assert.strictEqual(labels[packedHit], '远程执行');
  assert.strictEqual(L.hitIndexFromX(activityVisual, glassX, glassW, 6), 1);
  assert.notStrictEqual(packedHit, 1);
});

test('chooseTabWidth: desktop hug never fills leftover space', function () {
  var natural = [78, 58, 58, 96, 58, 58];
  approx(L.chooseTabWidth(natural, 1200, false), 96);
  approx(L.chooseTabWidth(natural, 96 * 6, false), 96);
  approx(L.chooseTabWidth(natural, 480, false), 80);
  approx(L.chooseTabWidth(natural, 1200, true), 200);
  approx(L.chooseTabWidth(natural, 480, true), 80);
});

test('SCREENSHOT desktop: width:0 children collapse inline-flex to padding', function () {
  var pad = 8;
  var n = 6;
  var collapsed = L.shrinkToFitIslandWidth(4, 4, n, 0);
  assert.strictEqual(collapsed, pad);
  assert.ok(collapsed < 40, 'collapsed island is a grey blob');
  var hug = L.pickEqualTabWidth([78, 58, 58, 96, 58, 58]);
  var healthy = L.shrinkToFitIslandWidth(4, 4, n, hug);
  assert.strictEqual(healthy, 4 + 4 + 96 * 6);
  assert.ok(healthy > 500);
});

test('overlay canvas covers the whole nav including shelf padding', function () {
  var rest = L.overlayCanvasSize(1280, 50 + 12, 32);
  assert.strictEqual(rest.w, 1280);
  assert.strictEqual(rest.wallpaperH, 62);
  assert.strictEqual(rest.h, 62 + L.pressOverflowPx(32));
  var open = L.overlayCanvasSize(1280, 50 + 27, 32);
  assert.strictEqual(open.wallpaperH, 77);
  assert.strictEqual(open.h, 77 + L.pressOverflowPx(32));
  assert.ok(L.overlayCoversShelfPadding(50, 12, 27));
  assert.strictEqual(L.shouldUseSolidBackground(), false);
});

test('press 78/56 glass sticks out of a nav-sized canvas and fits the grown one', function () {
  var tabH = 56;
  var navH = 56;
  var pressedH = tabH * L.TAB_PRESSED_SCALE;
  approx(L.TAB_PRESSED_SCALE, 78 / 56);
  approx(pressedH, 78);
  var extra = (pressedH - tabH) / 2;
  approx(extra, 11);
  var grown = L.overlayCanvasSize(1280, navH, tabH);
  assert.ok(navH < pressedH, 'a canvas equal to the 56dp island clips the 78dp pressed pill');
  assert.ok(grown.h >= navH + extra, 'grown canvas must fit the pressed pill');
  assert.ok(grown.shadowPad >= extra);
  assert.strictEqual(grown.wallpaperH, navH);
});

test('indicator press size is original 78/56 of the island, not frozen', function () {
  var island = { w: 90, h: 32 };
  var sx = island.w * L.TAB_PRESSED_SCALE;
  var sy = island.h * L.TAB_PRESSED_SCALE;
  approx(sx, 90 * 78 / 56);
  approx(sy, 32 * 78 / 56);
  assert.ok(sy > island.h + 10, 'must visibly grow on press; freezePressScale made this 0');
});

test('renderer uses original 78/56 press scale, freeze is opt-in not default', function () {
  var src = fs.readFileSync(
    path.join(__dirname, '../public/liquid-glass-renderer.js'),
    'utf8'
  );
  assert.ok(src.indexOf('TAB_PRESSED_SCALE = 78 / 56') !== -1);
  assert.ok(src.indexOf('TAB_PRESSED_SCALE = 86 / 56') === -1, '86/56 was a local drift');
  assert.ok(src.indexOf('setWallpaperClip') !== -1);
  assert.ok(src.indexOf('wallpaperClipCss') !== -1);
});

test('BUG: keying overlay on barH leaves canvas at terminal height after leave', function () {
  var openNavH = 50 + 27;
  var restNavH = 50 + 12;
  var barH = 40;
  assert.strictEqual(L.contentBoxNotifiesPaddingChange(), false);
  assert.ok(L.shelfKeyStuckIfOmitsNavHeight(openNavH, restNavH, barH), 'barH key cannot see 27→12 padding');
  assert.notStrictEqual(L.layoutSizeKey(1280, openNavH), L.layoutSizeKey(1280, restNavH));
  var open = L.overlayCanvasSize(1280, openNavH, barH);
  var rest = L.overlayCanvasSize(1280, restNavH, barH);
  var grow = L.pressOverflowPx(barH);
  assert.strictEqual(open.h, openNavH + grow);
  assert.strictEqual(rest.h, restNavH + grow);
  assert.strictEqual(open.wallpaperH, openNavH);
  assert.strictEqual(rest.wallpaperH, restNavH);
  assert.ok(open.h > rest.h);
});

test('shelfFollowDelays covers the 560ms GitHub shelf transition', function () {
  var d = L.shelfFollowDelays(560);
  assert.strictEqual(d[0], 0);
  assert.ok(d.indexOf(560) !== -1);
  assert.ok(d[d.length - 1] >= 560);
  assert.ok(d.length >= 8);
});

test('nav.js desktop hug + wallpaper independent (no solid bg)', function () {
  var src = fs.readFileSync(
    path.join(__dirname, '../public/liquid-glass-nav.js'),
    'utf8'
  );
  assert.ok(src.indexOf('islandMode') !== -1);
  assert.ok(src.indexOf('remainingInnerWidth') !== -1);
  assert.ok(src.indexOf("islandMode() === 'fill'") !== -1);
  var overlay = src.slice(src.indexOf('function overlayCanvas'), src.indexOf('function canvasOrigin'));
  assert.ok(overlay.indexOf('overlayCanvasSize') !== -1);
  assert.ok(overlay.indexOf('gesture.isDragged') === -1, 'drag must not resize canvas');
  assert.ok(overlay.indexOf('nav.clientHeight') !== -1, 'canvas must cover shelf padding');
  assert.ok(overlay.indexOf('bar.height') !== -1, 'press overflow uses the island height');
  assert.ok(overlay.indexOf('setWallpaperClip') !== -1, 'overflow below the nav must stay transparent');
  assert.ok(src.indexOf('setBackgroundColor(null)') !== -1, 'solid bg makes drag sample white');
  assert.ok(src.indexOf('setBackgroundColor([') === -1);
  assert.ok(src.indexOf("removeProperty('--lg-nav-fill')") !== -1, 'second solid is the two-white bug');
  assert.ok(src.indexOf('freezePressScale: true') === -1, 'must use original 78/56 press, not freeze it');
  assert.ok(src.indexOf('0.75 * surface') !== -1, 'wallpaper is nav-fusion grey, not page white');
  assert.ok(src.indexOf('renderer.render()') !== -1, 'resize must paint immediately (alpha:true still flashes if we wait for rAF)');
});

test('renderer uses a transparent WebGL buffer so resize is not a black flash', function () {
  var src = fs.readFileSync(
    path.join(__dirname, '../public/liquid-glass-renderer.js'),
    'utf8'
  );
  assert.ok(src.indexOf('alpha: true') !== -1);
  assert.ok(!/getContext\("webgl", \{[^}]*alpha: false/.test(src));
});

test('isFillIsland only true for fill', function () {
  assert.strictEqual(L.isFillIsland('fill'), true);
  assert.strictEqual(L.isFillIsland(' hug '), false);
  assert.strictEqual(L.isFillIsland(''), false);
});

test('hitIndexFromRects matches the button under the pointer', function () {
  var origin = { x: 10, y: 2 };
  var client = [
    { left: 10, top: 2, width: 200, height: 32 },
    { left: 210, top: 2, width: 200, height: 32 },
    { left: 410, top: 2, width: 200, height: 32 },
  ];
  var rects = L.mapClientRects(client, origin);
  approx(rects[1].x, 200);
  assert.strictEqual(L.hitIndexFromRects(209, 10, rects), 0);
  assert.strictEqual(L.hitIndexFromRects(210, 10, rects), 1);
  assert.strictEqual(L.hitIndexFromRects(250, 10, rects), 1);
  assert.strictEqual(L.hitIndexFromRects(409, 10, rects), 1);
  assert.strictEqual(L.hitIndexFromRects(410, 10, rects), 2);
  assert.strictEqual(L.avgEqualWidth(rects), 200);
});

test('after hug, DOM cell 活动 matches visual 活动', function () {
  var labels = ['仪表盘', '活动', '终端', '远程执行', '笔记', '设置'];
  var glassX = 40;
  var natural = [78, 58, 58, 96, 58, 58];
  var tabW = L.chooseTabWidth(natural, 1200, false);
  approx(tabW, 96);
  var glassW = tabW * labels.length;
  var visual = L.equalTabCells(glassX, 0, glassW, 32, labels.length);
  var dom = L.cumulativeCells(glassX, 0, labels.map(function () { return tabW; }), 32);
  var x = L.cellCenter(visual[1]).x;
  assert.strictEqual(L.hitIndexFromX(x, glassX, glassW, 6), 1);
  assert.strictEqual(L.packedIndexFromX(x, glassX, labels.map(function () { return tabW; })), 1);
  assert.strictEqual(L.hitIndexFromRects(x, 16, dom.map(function (c) {
    return { left: c.x, top: c.y, w: c.w, h: c.h, x: c.x, y: c.y };
  })), 1);
  approx(L.cellCenter(dom[1]).x, L.cellCenter(visual[1]).x);
});

test('phone fill still matches visual 活动', function () {
  var labels = ['仪表盘', '活动', '终端', '远程执行', '笔记', '设置'];
  var glassX = 0;
  var glassW = 1200;
  var tabW = L.chooseTabWidth([78, 58, 58, 96, 58, 58], glassW, true);
  approx(tabW, 200);
  var visual = L.equalTabCells(glassX, 0, glassW, 32, labels.length);
  var x = L.cellCenter(visual[1]).x;
  assert.strictEqual(L.hitIndexFromX(x, glassX, glassW, 6), 1);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
