/* ============================================================
 * 顶部栏 tab 等宽格子：纯函数，供接入层与单测共用。
 *
 * 原项目 Bottom Tabs 指示器位移是
 *   x = glassX + fraction * tabWidth
 * tabWidth 必须对每个格子相同，否则第 N 项的字心和胶囊心会错开。
 * Zephyr 的 .nav-tab 是 flex:1 1 0 + 内容宽度，远程执行/仪表盘/笔记
 * 宽度不同，必须先把 DOM 和 canvas 都锁成同一格宽。
 * ============================================================ */
(function (root) {
  'use strict';

  function pickEqualTabWidth(naturalWidths, maxInner) {
    if (!naturalWidths || !naturalWidths.length) return 0;
    var max = 0;
    for (var i = 0; i < naturalWidths.length; i++) {
      var w = Number(naturalWidths[i]);
      if (w > max) max = w;
    }
    if (maxInner != null && isFinite(maxInner) && maxInner > 0) {
      var fit = maxInner / naturalWidths.length;
      if (max > fit) return fit;
    }
    return max;
  }

  function equalTabCells(glassX, glassY, glassW, glassH, n) {
    var cells = [];
    if (!(n > 0)) return cells;
    var tabW = glassW / n;
    for (var i = 0; i < n; i++) {
      cells.push({
        x: glassX + tabW * i,
        y: glassY,
        w: tabW,
        h: glassH,
      });
    }
    return cells;
  }

  function indicatorRect(glassX, glassY, tabW, glassH, fraction) {
    return {
      x: glassX + fraction * tabW,
      y: glassY,
      w: tabW,
      h: glassH,
    };
  }

  function cellCenter(cell) {
    return {
      x: cell.x + cell.w / 2,
      y: cell.y + cell.h / 2,
    };
  }

  function cumulativeCells(startX, y, widths, h) {
    var cells = [];
    var x = startX;
    for (var i = 0; i < widths.length; i++) {
      cells.push({ x: x, y: y, w: widths[i], h: h });
      x += widths[i];
    }
    return cells;
  }

  /* nav.clientWidth 已含 padding。flex 主轴可用宽度 =
   * clientWidth - padL - padR - brand - actions - gap×缝数。
   * extraInset 是 .nav-tabs 的左右 padding（默认 4+4）。 */
  function remainingForTabs(navClientWidth, brandW, actionsW, padL, padR, gap, extraInset) {
    extraInset = extraInset == null ? 8 : extraInset;
    var used = (padL || 0) + (padR || 0) + (brandW || 0) + (actionsW || 0);
    var seams = 0;
    if (brandW > 0) seams += 1;
    if (actionsW > 0) seams += 1;
    used += (gap || 0) * seams;
    return Math.max(0, (navClientWidth || 0) - used - extraInset);
  }

  /* 与 rasterizeText 一致：字画在格子水平中心。
   * 返回墨水包围盒（不含 halo），便于断言相对格子/胶囊居中。 */
  function textInkBox(cell, textWidth) {
    var cx = cell.x + cell.w / 2;
    return {
      x: cx - textWidth / 2,
      y: cell.y,
      w: textWidth,
      h: cell.h,
      centerX: cx,
    };
  }

  /* 点按 vs 拖拽。旧实现 pointerdown 就 beginTabDrag，移动 >3px
   * 就算拖；松手 endTabDrag 吸附回当前项，并且 preventDefault 吃掉
   * 原生 click → 只能拖、不能点。触控点按抖动常 >3px。
   * 点按：等松手再按命中项切换，不要先 beginTabDrag。 */
  var TAP_SLOP_MOUSE = 8;
  var TAP_SLOP_TOUCH = 12;

  function dragThresholdPx(pointerType) {
    return pointerType === 'touch' || pointerType === 'pen'
      ? TAP_SLOP_TOUCH
      : TAP_SLOP_MOUSE;
  }

  function hitIndexFromX(x, glassX, glassW, n) {
    if (!(n > 0) || !(glassW > 0)) return -1;
    var i = Math.floor((x - glassX) / (glassW / n));
    if (i < 0) return 0;
    if (i >= n) return n - 1;
    return i;
  }

  /* DOM 必须铺满 glassW，不能用 max(自然宽)。max 自然宽会把按钮挤在
   * 左边，canvas 字仍按整栏等分；点画面上的「活动」会打到左边更靠后
   * 的 DOM 按钮（远程执行）。 */
  function fillTabWidth(innerWidth, n) {
    if (!(n > 0)) return 0;
    innerWidth = Number(innerWidth) || 0;
    if (!(innerWidth > 0)) return 0;
    return innerWidth / n;
  }

  function glassRectFromBar(bar, padL, padT, padR, padB, borderL, borderT, borderR, borderB) {
    bar = bar || {};
    padL = Number(padL) || 0;
    padT = Number(padT) || 0;
    padR = Number(padR) || 0;
    padB = Number(padB) || 0;
    borderL = Number(borderL) || 0;
    borderT = Number(borderT) || 0;
    borderR = Number(borderR) || 0;
    borderB = Number(borderB) || 0;
    var left = bar.left != null ? bar.left : (bar.x || 0);
    var top = bar.top != null ? bar.top : (bar.y || 0);
    return {
      x: left + borderL + padL,
      y: top + borderT + padT,
      w: Math.max(0, (bar.width || 0) - borderL - borderR - padL - padR),
      h: Math.max(0, (bar.height || 0) - borderT - borderB - padT - padB),
    };
  }

  /* hug = max(自然宽)。
   * fill=false（桌面 inline-flex）：岛 hug，绝不按当前栏宽均分。
   *   旧实现把 inner 当成「必须铺满的栏宽」，桌面 .nav-tabs 没有确定宽度，
   *   子项 width:0 把岛压成 padding，字叠成一团。
   * fill=true（手机 width:100%）：按 availableInner/n 铺满。
   * availableInner 是剩余空间，不是已经塌掉的 getBoundingClientRect().width。 */
  function chooseTabWidth(naturals, availableInner, fill) {
    var hug = pickEqualTabWidth(naturals);
    var n = naturals && naturals.length;
    if (!(n > 0)) return 0;
    availableInner = Number(availableInner) || 0;
    if (fill) {
      if (availableInner > 0) return availableInner / n;
      return hug;
    }
    if (availableInner > 0 && hug * n > availableInner + 0.5) {
      return availableInner / n;
    }
    return hug;
  }

  function isFillIsland(mode) {
    return String(mode || '').trim().toLowerCase() === 'fill';
  }

  /* 桌面截图复现：inline-flex 父级 + 子项 width:0 / flex 1 1 0%。
   * shrink-to-fit 宽度 = padding，标签叠成一团。 */
  function shrinkToFitIslandWidth(padL, padR, n, childSpecifiedWidth) {
    n = n || 0;
    var child = childSpecifiedWidth == null ? 0 : Number(childSpecifiedWidth);
    if (!(n > 0)) return (padL || 0) + (padR || 0);
    return (padL || 0) + (padR || 0) + n * Math.max(0, child);
  }

  /* 原项目 Bottom Tabs：按下指示器 scale = 78/56 ≈ 1.393，整栏
   * 再微扩 16dp/W。顶栏 canvas 若等于 nav 盒子，放大后的玻璃被裁掉，
   * 看起来「小了、局限了」。多出来的高度画出栏下，壁纸只铺 nav 盒子。 */
  var TAB_PRESSED_SCALE = 78 / 56;
  var CONTAINER_SHADOW_PAD = 24;

  function pressOverflowPx(tabH) {
    tabH = Number(tabH) || 0;
    var extra = Math.ceil(tabH * (TAB_PRESSED_SCALE - 1) / 2);
    return Math.max(CONTAINER_SHADOW_PAD, extra + 8);
  }

  function overlayCanvasSize(navClientW, navClientH, tabH) {
    var grow = pressOverflowPx(tabH == null ? 32 : tabH);
    return {
      w: Math.max(1, Number(navClientW) || 0),
      h: Math.max(1, Number(navClientH) || 0) + grow,
      shadowPad: grow,
      wallpaperH: Math.max(1, Number(navClientH) || 0),
    };
  }

  function overlayCoversShelfPadding(contentH, restPad, openPad) {
    var rest = overlayCanvasSize(1280, contentH + restPad, 32);
    var open = overlayCanvasSize(1280, contentH + openPad, 32);
    var grow = pressOverflowPx(32);
    return rest.h === contentH + restPad + grow &&
      open.h === contentH + openPad + grow &&
      rest.h !== open.h;
  }

  function layoutSizeKey(w, h) {
    return Math.round(Number(w) || 0) + 'x' + Math.round(Number(h) || 0);
  }

  /* content-box ResizeObserver 不报 padding-bottom。货架 27→12 只改
   * padding，tab 岛高度不变。旧 key 用 barH 不含 navH → canvas 卡在
   * 终端高度，看起来底部栏没收起。 */
  function contentBoxNotifiesPaddingChange() {
    return false;
  }

  function shelfKeyStuckIfOmitsNavHeight(openNavH, restNavH, barH) {
    var openKey = layoutSizeKey(1280, barH);
    var restKey = layoutSizeKey(1280, barH);
    return openKey === restKey && Number(openNavH) !== Number(restNavH);
  }

  function shelfFollowDelays(durationMs) {
    durationMs = durationMs == null ? 560 : Number(durationMs);
    var out = [0, 16, 32, 80, 140, 220, 340, 500];
    if (durationMs > 500) {
      out.push(durationMs);
      out.push(durationMs + 120);
    }
    return out;
  }

  /* 独立壁纸采样要求 backgroundColor === null。设了 solid 之后
   * independent=false，拖动放大采到 scene FBO 的白底，灰岛变白。 */
  function shouldUseSolidBackground() {
    return false;
  }

  function mapClientRects(clientRects, origin) {
    origin = origin || { x: 0, y: 0 };
    var ox = origin.x || 0;
    var oy = origin.y || 0;
    var out = [];
    if (!clientRects) return out;
    for (var i = 0; i < clientRects.length; i++) {
      var r = clientRects[i] || {};
      var left = r.left != null ? r.left : (r.x || 0);
      var top = r.top != null ? r.top : (r.y || 0);
      var w = r.width != null ? r.width : (r.w != null ? r.w : ((r.right || 0) - left));
      var h = r.height != null ? r.height : (r.h != null ? r.h : ((r.bottom || 0) - top));
      out.push({
        left: left,
        top: top,
        right: left + w,
        bottom: top + h,
        x: left - ox,
        y: top - oy,
        w: w,
        h: h,
      });
    }
    return out;
  }

  function avgEqualWidth(rects) {
    if (!rects || !rects.length) return 0;
    var first = rects[0];
    var last = rects[rects.length - 1];
    var left = first.x != null ? first.x : first.left;
    var lastLeft = last.x != null ? last.x : last.left;
    var lastW = last.w != null ? last.w : (last.right - lastLeft);
    return (lastLeft + lastW - left) / rects.length;
  }

  function hitIndexFromRects(x, y, rects) {
    if (!rects || !rects.length) return -1;
    var i;
    for (i = 0; i < rects.length; i++) {
      var r = rects[i];
      var l = r.left != null ? r.left : r.x;
      var t = r.top != null ? r.top : r.y;
      var w = r.w != null ? r.w : (r.right - l);
      var h = r.h != null ? r.h : (r.bottom - t);
      if (x >= l && x < l + w) {
        if (y == null || (y >= t && y < t + h)) return i;
      }
    }
    var best = 0;
    var bestD = Infinity;
    for (i = 0; i < rects.length; i++) {
      var rr = rects[i];
      var ll = rr.left != null ? rr.left : rr.x;
      var ww = rr.w != null ? rr.w : (rr.right - ll);
      var d = Math.abs(x - (ll + ww / 2));
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  function packedIndexFromX(x, startX, widths) {
    if (!widths || !widths.length) return -1;
    var pos = startX || 0;
    if (x <= pos) return 0;
    for (var i = 0; i < widths.length; i++) {
      var next = pos + widths[i];
      if (x < next) return i;
      pos = next;
    }
    return widths.length - 1;
  }

  function resolveTabGesture(opts) {
    opts = opts || {};
    var threshold = dragThresholdPx(opts.pointerType);
    var dragged = opts.didDrag != null
      ? !!opts.didDrag
      : Math.abs(opts.dx || 0) > threshold;
    if (dragged) {
      return {
        kind: 'drag',
        index: opts.snappedIndex,
        suppressClick: true,
      };
    }
    return {
      kind: 'tap',
      index: opts.hitIndex,
      suppressClick: opts.hitIndex >= 0,
    };
  }

  function createTabPointerMachine(opts) {
    var pointerType = (opts && opts.pointerType) || 'mouse';
    var threshold = dragThresholdPx(pointerType);
    var down = false;
    var dragged = false;
    var startX = 0;
    var lastX = 0;
    var hitIndex = -1;
    var startIndex = 0;
    return {
      down: function (x, hit, start) {
        down = true;
        dragged = false;
        startX = x;
        lastX = x;
        hitIndex = hit;
        startIndex = start;
        return { beginDrag: false };
      },
      move: function (x) {
        if (!down) return { drag: false, beginDrag: false, dx: 0 };
        lastX = x;
        var dx = x - startX;
        if (!dragged && Math.abs(dx) <= threshold) {
          return { drag: false, beginDrag: false, dx: dx };
        }
        var first = !dragged;
        dragged = true;
        return { drag: true, beginDrag: first, dx: dx };
      },
      up: function (snapped, x) {
        if (!down) return { activate: -1, suppressClick: false, kind: 'idle' };
        if (x != null && isFinite(x)) lastX = x;
        down = false;
        var result = resolveTabGesture({
          dx: lastX - startX,
          pointerType: pointerType,
          hitIndex: hitIndex,
          snappedIndex: snapped,
          didDrag: dragged,
        });
        dragged = false;
        return {
          activate: result.index,
          suppressClick: result.suppressClick,
          kind: result.kind,
        };
      },
      cancel: function () {
        var wasDragged = dragged;
        down = false;
        dragged = false;
        return { endDrag: wasDragged };
      },
      isDown: function () { return down; },
      isDragged: function () { return dragged; },
      startIndex: function () { return startIndex; },
      hitIndex: function () { return hitIndex; },
      dx: function () { return lastX - startX; },
    };
  }

  var api = {
    pickEqualTabWidth: pickEqualTabWidth,
    equalTabCells: equalTabCells,
    indicatorRect: indicatorRect,
    cellCenter: cellCenter,
    cumulativeCells: cumulativeCells,
    remainingForTabs: remainingForTabs,
    textInkBox: textInkBox,
    TAP_SLOP_MOUSE: TAP_SLOP_MOUSE,
    TAP_SLOP_TOUCH: TAP_SLOP_TOUCH,
    dragThresholdPx: dragThresholdPx,
    hitIndexFromX: hitIndexFromX,
    fillTabWidth: fillTabWidth,
    glassRectFromBar: glassRectFromBar,
    packedIndexFromX: packedIndexFromX,
    chooseTabWidth: chooseTabWidth,
    isFillIsland: isFillIsland,
    shrinkToFitIslandWidth: shrinkToFitIslandWidth,
    TAB_PRESSED_SCALE: TAB_PRESSED_SCALE,
    CONTAINER_SHADOW_PAD: CONTAINER_SHADOW_PAD,
    pressOverflowPx: pressOverflowPx,
    overlayCanvasSize: overlayCanvasSize,
    overlayCoversShelfPadding: overlayCoversShelfPadding,
    layoutSizeKey: layoutSizeKey,
    contentBoxNotifiesPaddingChange: contentBoxNotifiesPaddingChange,
    shelfKeyStuckIfOmitsNavHeight: shelfKeyStuckIfOmitsNavHeight,
    shelfFollowDelays: shelfFollowDelays,
    shouldUseSolidBackground: shouldUseSolidBackground,
    mapClientRects: mapClientRects,
    avgEqualWidth: avgEqualWidth,
    hitIndexFromRects: hitIndexFromRects,
    resolveTabGesture: resolveTabGesture,
    createTabPointerMachine: createTabPointerMachine,
  };

  root.LiquidGlassTabLayout = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
