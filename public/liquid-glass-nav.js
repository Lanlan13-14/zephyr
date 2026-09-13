/* ============================================================
 * Zephyr 顶部栏 · 原项目 LiquidGlassRenderer 完整接入
 * martin65536/liquid-glass-webgl Bottom Tabs 原参数，不简化。
 * 文字只画在 canvas 上（CombinedBackdrop 给选中项上主题色）；
 * DOM tab 透明可点，避免叠字。
 * ============================================================ */
(function () {
  'use strict';

  var Renderer = window.LiquidGlassWebGL && window.LiquidGlassWebGL.LiquidGlassRenderer;
  if (!Renderer) return;

  var DP = 1;
  var DEFAULT_HIGHLIGHT = {
    mode: 0,
    color: [1, 1, 1],
    angle: 45 * Math.PI / 180,
    falloff: 1.0,
    alpha: 0.5,
    widthDp: 0.5,
  };
  var DEFAULT_SHADOW = {
    radius: 24 * DP,
    alpha: 0.1,
    offsetX: 0,
    offsetY: (24 / 6) * DP,
    color: [0, 0, 0],
  };

  var LIGHT = {
    tabsContainer: [0xe8 / 255, 0xe8 / 255, 0xec / 255, 0.42],
    tabsContentColor: [0, 0, 0, 1],
    tabsTextHalo: 'dark',
    backIconColor: [0, 0, 0, 1],
  };
  var DARK = {
    tabsContainer: [0x12 / 255, 0x12 / 255, 0x12 / 255, 0.4],
    tabsContentColor: [1, 1, 1, 1],
    tabsTextHalo: 'light',
    backIconColor: [1, 1, 1, 1],
  };

  function isLightTheme() {
    return (document.documentElement.getAttribute('data-theme') || 'light') !== 'dark';
  }

  function parseRgb(str) {
    if (!str) return [245, 245, 247];
    str = String(str).trim();
    if (str.charAt(0) === '#') {
      var h = str.slice(1);
      if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
      return [parseInt(h.slice(0, 2), 16) || 0, parseInt(h.slice(2, 4), 16) || 0, parseInt(h.slice(4, 6), 16) || 0];
    }
    var m = str.match(/rgba?\(([^)]+)\)/);
    if (!m) return [245, 245, 247];
    var p = m[1].split(',');
    return [parseFloat(p[0]) || 0, parseFloat(p[1]) || 0, parseFloat(p[2]) || 0];
  }

  function themeAccent() {
    var raw = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    var rgb = parseRgb(raw || '#0a84ff');
    return [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255];
  }

  function visibleTabs(navTabs) {
    return Array.from(navTabs.querySelectorAll('.nav-tab')).filter(function (t) {
      if (t.classList.contains('force-hidden')) return false;
      var s = window.getComputedStyle(t);
      return s.display !== 'none' && s.visibility !== 'hidden';
    });
  }

  function boot() {
    var nav = document.querySelector('.main-nav');
    if (!nav) return;
    var navTabs = nav.querySelector('.nav-tabs');
    if (!navTabs) return;

    var canvas = document.createElement('canvas');
    canvas.id = 'liquidGlassCanvas';
    canvas.setAttribute('aria-hidden', 'true');
    nav.insertBefore(canvas, nav.firstChild);

    var renderer;
    try {
      renderer = new Renderer(canvas);
    } catch (e) {
      nav.classList.add('no-liquid-glass');
      return;
    }

    renderer.usePerElementFbo = true;
    renderer.quickToggles.perElementFbo = true;
    renderer.useKawaseBlur = true;
    renderer.useBlurCache = true;
    renderer.noContinuousSdf = true;
    renderer.directBackdropSample = true;
    renderer.capsuleShape = true;
    renderer.pendingExtraRenders = 1;

    nav.classList.add('liquid-glass-on');

    var GROUP = 'zephyr-nav';
    var pointerDown = false;
    var didDrag = false;
    var gesture = null;
    var suppressClick = false;
    var lastTabCount = -1;
    var lastLayoutKey = '';
    var lastSizeKey = '';
    var lastBgKey = '';
    var lastTerminal = document.body.classList.contains('terminal-mode');

    /* 壁纸 = --nav-fusion-bg 的不透明近似（75% surface + 25% bg）。
     * 不得 setBackgroundColor：independent 采样需要 wallpaper 且
     * backgroundColor === null。不得写 --lg-nav-fill：那是另一块实心
     * 色，canvas 盖不全时顶栏就会两种白。 */
    function navFillRgb() {
      var root = getComputedStyle(document.documentElement);
      var surface = parseRgb(root.getPropertyValue('--surface') || '#ffffff');
      var bgSrc = getComputedStyle(document.body).backgroundColor;
      if (!bgSrc || bgSrc === 'transparent' || bgSrc === 'rgba(0, 0, 0, 0)') {
        bgSrc = root.getPropertyValue('--bg') || '#f5f5f7';
      }
      var bg = parseRgb(bgSrc);
      return [
        Math.round(0.75 * surface[0] + 0.25 * bg[0]),
        Math.round(0.75 * surface[1] + 0.25 * bg[1]),
        Math.round(0.75 * surface[2] + 0.25 * bg[2]),
      ];
    }

    function applyBackground() {
      var rgb = navFillRgb();
      var key = rgb.join(',') + (isLightTheme() ? 'L' : 'D');
      var css = 'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')';
      nav.style.removeProperty('--lg-nav-fill');
      if (typeof renderer.setBackgroundColor === 'function') {
        renderer.setBackgroundColor(null);
      } else {
        renderer.backgroundColor = null;
      }
      if (key === lastBgKey) return;
      lastBgKey = key;
      var c = document.createElement('canvas');
      c.width = 8;
      c.height = 8;
      var ctx = c.getContext('2d');
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 8, 8);
      renderer.loadWallpaper(c.toDataURL('image/png')).catch(function () {});
    }

    function overlayCanvas() {
      var Layout = window.LiquidGlassTabLayout;
      var bar = navTabs.getBoundingClientRect();
      var size = Layout
        ? Layout.overlayCanvasSize(nav.clientWidth, nav.clientHeight, bar.height)
        : { w: Math.max(1, nav.clientWidth), h: Math.max(1, nav.clientHeight) + 24 };
      canvas.style.width = size.w + 'px';
      canvas.style.height = size.h + 'px';
      if (typeof renderer.setWallpaperClip === 'function') {
        renderer.setWallpaperClip(0, 0, size.w, nav.clientHeight);
      } else {
        renderer.wallpaperClipCss = { x: 0, y: 0, w: size.w, h: nav.clientHeight };
      }
      return { w: size.w, h: size.h, barH: bar.height };
    }

    function canvasOrigin() {
      var r = canvas.getBoundingClientRect();
      return { x: r.left, y: r.top };
    }

    function glassClient() {
      var Layout = window.LiquidGlassTabLayout;
      var bar = navTabs.getBoundingClientRect();
      if (!Layout) {
        return { x: bar.left + 4, y: bar.top + 4, w: Math.max(0, bar.width - 8), h: Math.max(0, bar.height - 8) };
      }
      var cs = window.getComputedStyle(navTabs);
      return Layout.glassRectFromBar(
        bar,
        parseFloat(cs.paddingLeft) || 0,
        parseFloat(cs.paddingTop) || 0,
        parseFloat(cs.paddingRight) || 0,
        parseFloat(cs.paddingBottom) || 0,
        parseFloat(cs.borderLeftWidth) || 0,
        parseFloat(cs.borderTopWidth) || 0,
        parseFloat(cs.borderRightWidth) || 0,
        parseFloat(cs.borderBottomWidth) || 0
      );
    }

    function measureDomRects(tabs, origin) {
      var Layout = window.LiquidGlassTabLayout;
      var raw = tabs.map(function (t) { return t.getBoundingClientRect(); });
      if (!Layout) {
        origin = origin || { x: 0, y: 0 };
        return raw.map(function (r) {
          return {
            left: r.left, top: r.top, right: r.right, bottom: r.bottom,
            x: r.left - origin.x, y: r.top - origin.y, w: r.width, h: r.height,
          };
        });
      }
      return Layout.mapClientRects(raw, origin || { x: 0, y: 0 });
    }

    function islandMode() {
      var Layout = window.LiquidGlassTabLayout;
      var raw = window.getComputedStyle(navTabs).getPropertyValue('--lg-island');
      if (Layout && Layout.isFillIsland(raw)) return 'fill';
      return 'hug';
    }

    function remainingInnerWidth() {
      var Layout = window.LiquidGlassTabLayout;
      if (!Layout) return 0;
      var cs = window.getComputedStyle(nav);
      var brand = nav.querySelector('.brand');
      var actions = nav.querySelector('.nav-actions');
      return Layout.remainingForTabs(
        nav.clientWidth,
        brand ? brand.getBoundingClientRect().width : 0,
        actions ? actions.getBoundingClientRect().width : 0,
        parseFloat(cs.paddingLeft) || 0,
        parseFloat(cs.paddingRight) || 0,
        parseFloat(cs.columnGap || cs.gap) || 0,
        8
      );
    }

    function equalizeDomTabs(tabs) {
      var Layout = window.LiquidGlassTabLayout;
      if (!Layout || !tabs.length) {
        navTabs.style.removeProperty('--lg-tab-w');
        return 0;
      }
      var fill = islandMode() === 'fill';
      navTabs.style.removeProperty('--lg-tab-w');
      var naturals = tabs.map(function (t) { return t.getBoundingClientRect().width; });
      var available = remainingInnerWidth();
      if (fill) {
        var glass = glassClient();
        if (glass.w > available) available = glass.w;
      }
      var tabW = Layout.chooseTabWidth(naturals, available, fill);
      if (tabW > 0) navTabs.style.setProperty('--lg-tab-w', tabW + 'px');
      else navTabs.style.removeProperty('--lg-tab-w');
      return tabW;
    }

    function buildElements() {
      var tabs = visibleTabs(navTabs);
      if (!tabs.length) return;
      var palette = isLightTheme() ? LIGHT : DARK;
      var accentT = themeAccent();
      var origin = canvasOrigin();
      var bar = navTabs.getBoundingClientRect();
      var Layout = window.LiquidGlassTabLayout;
      if (!Layout) return;

      var containerX = bar.left - origin.x;
      var containerY = bar.top - origin.y;
      var containerW = bar.width;
      var containerH = bar.height;
      var containerR = containerH / 2;
      var n = tabs.length;
      var pad = window.getComputedStyle(navTabs);
      var glass = Layout.glassRectFromBar(
        { left: containerX, top: containerY, width: containerW, height: containerH },
        parseFloat(pad.paddingLeft) || 0,
        parseFloat(pad.paddingTop) || 0,
        parseFloat(pad.paddingRight) || 0,
        parseFloat(pad.paddingBottom) || 0,
        parseFloat(pad.borderLeftWidth) || 0,
        parseFloat(pad.borderTopWidth) || 0,
        parseFloat(pad.borderRightWidth) || 0,
        parseFloat(pad.borderBottomWidth) || 0
      );
      var glassX = glass.x;
      var glassY = glass.y;
      var glassW = glass.w;
      var glassH = glass.h;
      var glassR = glassH / 2;
      var tabRects = measureDomRects(tabs, origin);
      if (!tabRects.length) {
        tabRects = Layout.equalTabCells(glassX, glassY, glassW, glassH, n);
      }
      var tabW = Layout.avgEqualWidth(tabRects) || (n ? glassW / n : 1);
      var activeIndex = Math.max(0, tabs.findIndex(function (t) {
        return t.classList.contains('active');
      }));

      var elements = [];

      var containerEl = {
        id: GROUP + '-container',
        kind: 'glass-shape',
        rect: { x: containerX, y: containerY, w: containerW, h: containerH },
        cornerRadius: containerR,
        refractionHeight: 24 * DP,
        refractionAmount: -24 * DP,
        depthEffect: true,
        chromaticAberration: false,
        blurRadius: 8 * DP,
        saturation: 1.5,
        brightness: 0,
        contrast: 1,
        tintColor: [0, 0, 0, 0],
        surfaceColor: palette.tabsContainer.slice(),
        highlight: Object.assign({}, DEFAULT_HIGHLIGHT, { alpha: 0.5 }),
        outerShadow: Object.assign({}, DEFAULT_SHADOW),
        innerShadow: null,
        label: '',
        labelColor: [0, 0, 0, 1],
        showChevron: false,
        isInteractive: false,
        scroll: false,
        independentBackdrop: true,
        useSeparableBlur: true,
        useContinuousSdf: true,
        isBottomTabContainer: { groupId: GROUP, tabsCount: n },
      };
      elements.push(containerEl);

      var tabContentIds = [];
      var tabContentRects = [];
      for (var i = 0; i < n; i++) {
        var id = GROUP + '-tab-' + i;
        var cell = {
          x: tabRects[i].x,
          y: tabRects[i].y,
          w: tabRects[i].w,
          h: tabRects[i].h,
        };
        tabContentIds.push(id);
        tabContentRects.push(cell);
        elements.push({
          id: id,
          kind: 'text',
          rect: cell,
          cornerRadius: 0,
          refractionHeight: 0,
          refractionAmount: 0,
          depthEffect: false,
          chromaticAberration: false,
          blurRadius: 0,
          saturation: 1,
          brightness: 0,
          contrast: 1,
          tintColor: [0, 0, 0, 0],
          surfaceColor: [0, 0, 0, 0],
          highlight: null,
          outerShadow: null,
          label: '',
          labelColor: [0, 0, 0, 1],
          showChevron: false,
          isInteractive: false,
          scroll: false,
          text: {
            content: tabs[i].textContent.trim(),
            color: palette.tabsContentColor.slice(),
            fontSizePx: 13,
            fontWeight: 500,
            align: 'center',
            wrap: false,
            paddingPx: 0,
            valign: 'center',
            halo: palette.tabsTextHalo,
          },
          isBottomTabContent: {
            groupId: GROUP,
            containerCenterX: containerX + containerW / 2,
            containerCenterY: containerY + containerH / 2,
            containerWidth: containerW,
          },
        });
      }

      var indicatorEl = {
        id: GROUP + '-indicator',
        kind: 'glass-shape',
        rect: { x: tabRects[0].x, y: glassY, w: tabW, h: glassH },
        cornerRadius: glassR,
        refractionHeight: 10 * DP,
        refractionAmount: -14 * DP,
        depthEffect: false,
        chromaticAberration: true,
        blurRadius: 0,
        saturation: 1.0,
        brightness: 0,
        contrast: 1,
        tintColor: [0, 0, 0, 0],
        surfaceColor: [0, 0, 0, 0],
        highlight: Object.assign({}, DEFAULT_HIGHLIGHT, { alpha: 0.5 }),
        outerShadow: Object.assign({}, DEFAULT_SHADOW),
        innerShadow: { radius: 8 * DP, alpha: 0.3, offsetX: 0, offsetY: 8 * DP },
        label: '',
        labelColor: [0, 0, 0, 1],
        showChevron: false,
        isInteractive: false,
        scroll: false,
        independentBackdrop: false,
        useContinuousSdf: true,
        isBottomTabIndicator: {
          groupId: GROUP,
          dragWidth: tabW,
          dimColor: palette.backIconColor.slice(),
          accentColor: accentT.slice(),
          containerRect: { x: glassX - 4, y: glassY, w: glassW + 8, h: glassH },
          containerCenterX: containerX + containerW / 2,
          containerCenterY: containerY + containerH / 2,
          containerWidth: containerW,
          tabContentIds: tabContentIds,
          tabContentRects: tabContentRects,
        },
      };
      elements.push(indicatorEl);

      renderer.setButtons(elements);
      if (lastTabCount !== n) {
        lastTabCount = n;
        renderer.setTabSelected(GROUP, activeIndex, n);
        renderer.pendingExtraRenders = 1;
      }
      renderer.requestRender();
    }

    function layout() {
      var Layout = window.LiquidGlassTabLayout;
      var tabs = visibleTabs(navTabs);
      equalizeDomTabs(tabs);
      var size = overlayCanvas();
      var w = size.w;
      var h = size.h;
      if (w < 2 || h < 2) return;
      var bar = navTabs.getBoundingClientRect();
      var measured = measureDomRects(tabs);
      var rectKey = tabs.length + ':' + Math.round(bar.width) + ':' + Math.round(bar.height);
      if (measured.length) {
        var a = measured[0];
        var b = measured[measured.length - 1];
        rectKey += ':' + Math.round(a.x) + ',' + Math.round(a.w) + ':' +
          Math.round(b.x) + ',' + Math.round(b.w);
      }
      var sizeKey = Layout && Layout.layoutSizeKey
        ? Layout.layoutSizeKey(w, h)
        : (Math.round(w) + 'x' + Math.round(h));
      var contentKey = tabs.length + ':' + Math.round(bar.width) + ':' + Math.round(bar.height) + ':' +
        (isLightTheme() ? 'L' : 'D') + ':' + rectKey + ':' + themeAccent().join(',');
      applyBackground();
      if (sizeKey !== lastSizeKey) {
        lastSizeKey = sizeKey;
        renderer.resize(w, h);
        if (typeof renderer.render === 'function') renderer.render();
      }
      if (contentKey !== lastLayoutKey) {
        lastLayoutKey = contentKey;
        renderer.pendingExtraRenders = 1;
        buildElements();
      }
    }

    function followShelfHeight() {
      var Layout = window.LiquidGlassTabLayout;
      var delays = Layout && Layout.shelfFollowDelays
        ? Layout.shelfFollowDelays(560)
        : [0, 16, 32, 80, 140, 220, 340, 500, 560, 680];
      if (followShelfHeight._timers) {
        followShelfHeight._timers.forEach(function (t) { clearTimeout(t); });
      }
      followShelfHeight._timers = delays.map(function (d) {
        return setTimeout(layout, d);
      });
    }

    function activateTab(i) {
      var tabs = visibleTabs(navTabs);
      if (i < 0 || i >= tabs.length) return;
      var view = tabs[i].dataset.view;
      if (typeof window.switchView === 'function' && view) {
        window.switchView(view, { cardFlipSource: tabs[i] });
      } else {
        tabs[i].click();
      }
    }

    function currentTabWidth() {
      var tabs = visibleTabs(navTabs);
      if (!tabs.length) return 1;
      var Layout = window.LiquidGlassTabLayout;
      var rects = measureDomRects(tabs);
      if (Layout && rects.length) {
        var w = Layout.avgEqualWidth(rects);
        if (w > 0) return w;
      }
      var glass = glassClient();
      return Math.max(1, glass.w / tabs.length);
    }

    function hitTabIndex(e) {
      var tabs = visibleTabs(navTabs);
      var Layout = window.LiquidGlassTabLayout;
      if (!Layout || !tabs.length) return -1;
      var rects = measureDomRects(tabs);
      var hit = Layout.hitIndexFromRects(e.clientX, e.clientY, rects);
      if (hit >= 0) return hit;
      var glass = glassClient();
      return Layout.hitIndexFromX(e.clientX, glass.x, glass.w, tabs.length);
    }

    navTabs.addEventListener('pointerdown', function (e) {
      if (e.button != null && e.button !== 0) return;
      var Layout = window.LiquidGlassTabLayout;
      if (!Layout) return;
      var n = visibleTabs(navTabs).length;
      if (!n) return;
      gesture = Layout.createTabPointerMachine({
        pointerType: e.pointerType || 'mouse',
      });
      gesture.down(e.clientX, hitTabIndex(e), renderer.getTabTarget(GROUP));
      pointerDown = true;
      didDrag = false;
    });

    navTabs.addEventListener('pointermove', function (e) {
      if (!gesture || !gesture.isDown()) return;
      var r = gesture.move(e.clientX);
      var tabs = visibleTabs(navTabs);
      var n = tabs.length;
      if (!n) return;
      if (r.beginDrag) {
        didDrag = true;
        renderer.beginTabDrag(GROUP, gesture.startIndex(), n);
        try { navTabs.setPointerCapture(e.pointerId); } catch (err) {}
      }
      if (!r.drag) return;
      if (e.cancelable) e.preventDefault();
      renderer.dragTab(
        GROUP,
        gesture.startIndex(),
        e.clientX,
        e.clientX - r.dx,
        currentTabWidth(),
        n
      );
    }, { passive: false });

    function endPointer(e) {
      if (!gesture || !gesture.isDown()) return;
      var tabs = visibleTabs(navTabs);
      var n = tabs.length;
      var wasDrag = gesture.isDragged();
      var snapped = wasDrag && n
        ? renderer.endTabDrag(GROUP, n)
        : gesture.startIndex();
      var x = e && e.clientX != null ? e.clientX : null;
      var r = gesture.up(snapped, x);
      pointerDown = false;
      didDrag = false;
      gesture = null;
      if (wasDrag) layout();
      if (r.activate >= 0) activateTab(r.activate);
      if (r.suppressClick) {
        suppressClick = true;
        setTimeout(function () { suppressClick = false; }, 0);
      }
    }

    navTabs.addEventListener('pointerup', endPointer);
    navTabs.addEventListener('pointercancel', function () {
      if (!gesture) {
        pointerDown = false;
        didDrag = false;
        return;
      }
      var n = visibleTabs(navTabs).length;
      var c = gesture.cancel();
      if (c.endDrag && n) renderer.endTabDrag(GROUP, n);
      pointerDown = false;
      didDrag = false;
      gesture = null;
      if (c.endDrag) layout();
    });

    navTabs.addEventListener('click', function (e) {
      if (!suppressClick) return;
      e.stopPropagation();
      e.stopImmediatePropagation();
      suppressClick = false;
    }, true);

    var syncObserver = new MutationObserver(function () {
      var tabs = visibleTabs(navTabs);
      var idx = tabs.findIndex(function (t) { return t.classList.contains('active'); });
      if (idx >= 0 && !didDrag && !pointerDown) {
        renderer.setTabSelected(GROUP, idx, tabs.length);
      }
      layout();
    });
    syncObserver.observe(navTabs, {
      attributes: true,
      attributeFilter: ['class'],
      subtree: true,
      childList: true,
    });

    var themeObserver = new MutationObserver(function () {
      lastLayoutKey = '';
      layout();
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(layout).observe(navTabs);
      try {
        new ResizeObserver(layout).observe(nav, { box: 'border-box' });
      } catch (err) {
        new ResizeObserver(layout).observe(nav);
      }
    }
    window.addEventListener('resize', layout);
    nav.addEventListener('transitionend', function (e) {
      if (e && e.propertyName && e.propertyName !== 'padding-bottom') return;
      layout();
    });
    var bodyObserver = new MutationObserver(function () {
      var now = document.body.classList.contains('terminal-mode');
      layout();
      if (now !== lastTerminal) {
        lastTerminal = now;
        followShelfHeight();
      }
    });
    bodyObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });

    layout();
    requestAnimationFrame(layout);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
