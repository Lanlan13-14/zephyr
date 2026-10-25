/* ============================================================
 * Zephyr 顶栏 (.main-nav .nav-tabs) + 设置页左侧导航栏 (#view-settings .settings-menu)
 * 完整移植 martin65536/liquid-glass-webgl Bottom Tabs (LiquidBottomTabs)
 * - 栏本身 (containerEl) 与选中滑块 (indicatorEl) 均具备真实透视、折射与高光，零实心白块
 * - 支持横向 (顶栏 6 项) 与纵向 (设置侧栏 13/14 项) 点击弹簧过渡及拖拽 3D 液态玻璃透镜
 * - 实时同步全局壁纸切片、主题强调色 (--accent)、深浅色与中英文切换
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
    tabsContainer: [0xfa / 255, 0xfa / 255, 0xfa / 255, 0.36],
    sidebarContainer: [0xf8 / 255, 0xfa / 255, 0xfc / 255, 0.20],
    tabsContentColor: [0x0f / 255, 0x17 / 255, 0x2a / 255, 0.96],
    tabsTextHalo: 'none',
    backIconColor: [0, 0, 0, 1],
  };
  var DARK = {
    tabsContainer: [0x12 / 255, 0x16 / 255, 0x20 / 255, 0.40],
    sidebarContainer: [0x10 / 255, 0x14 / 255, 0x1e / 255, 0.32],
    tabsContentColor: [0xf8 / 255, 0xfa / 255, 0xfc / 255, 0.96],
    tabsTextHalo: 'none',
    backIconColor: [1, 1, 1, 1],
  };

  var ICON_COMMANDS = {
    dashboard: [
      { op: 'rect', x: 3, y: 3, w: 7, h: 7, rx: 1.5 },
      { op: 'rect', x: 14, y: 3, w: 7, h: 7, rx: 1.5 },
      { op: 'rect', x: 3, y: 14, w: 7, h: 7, rx: 1.5 },
      { op: 'rect', x: 14, y: 14, w: 7, h: 7, rx: 1.5 },
    ],
    activity: [
      { op: 'poly', pts: [[22, 12], [18, 12], [15, 21], [9, 3], [6, 12], [2, 12]] },
    ],
    terminal: [
      { op: 'poly', pts: [[4, 17], [10, 11], [4, 5]] },
      { op: 'line', x1: 12, y1: 19, x2: 20, y2: 19 },
    ],
    remote: [
      { op: 'circle', cx: 12, cy: 12, r: 4 },
      { op: 'path', d: 'M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41' },
    ],
    notes: [
      { op: 'path', d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' },
      { op: 'poly', pts: [[14, 2], [14, 8], [20, 8]] },
      { op: 'line', x1: 16, y1: 13, x2: 8, y2: 13 },
      { op: 'line', x1: 16, y1: 17, x2: 8, y2: 17 },
    ],
    settings: [
      { op: 'circle', cx: 12, cy: 12, r: 3 },
      { op: 'path', d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z' },
    ],
    security: [
      { op: 'path', d: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z' },
      { op: 'path', d: 'm9 12 2 2 4-4' },
    ],
    language: [
      { op: 'circle', cx: 12, cy: 12, r: 10 },
      { op: 'line', x1: 2, y1: 12, x2: 22, y2: 12 },
      { op: 'path', d: 'M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z' },
    ],
    beian: [
      { op: 'path', d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' },
      { op: 'poly', pts: [[14, 2], [14, 8], [20, 8]] },
      { op: 'path', d: 'm9 15 2 2 4-4' },
    ],
    network: [
      { op: 'rect', x: 2, y: 2, w: 20, h: 8, rx: 2 },
      { op: 'rect', x: 2, y: 14, w: 20, h: 8, rx: 2 },
      { op: 'circle', cx: 6, cy: 6, r: 0.9, fill: true },
      { op: 'circle', cx: 6, cy: 18, r: 0.9, fill: true },
    ],
    'ssh-keys': [
      { op: 'path', d: 'm21 2-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4' },
    ],
    snippets: [
      { op: 'poly', pts: [[16, 18], [22, 12], [16, 6]] },
      { op: 'poly', pts: [[8, 6], [2, 12], [8, 18]] },
    ],
    ai: [
      { op: 'path', d: 'M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3L12 3z' },
    ],
    agent: [
      { op: 'rect', x: 2, y: 3, w: 20, h: 14, rx: 2 },
      { op: 'line', x1: 8, y1: 21, x2: 16, y2: 21 },
      { op: 'line', x1: 12, y1: 17, x2: 12, y2: 21 },
    ],
    link: [
      { op: 'poly', pts: [[23, 4], [23, 10], [17, 10]] },
      { op: 'poly', pts: [[1, 20], [1, 14], [7, 14]] },
      { op: 'path', d: 'M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15' },
    ],
    data: [
      { op: 'ellipse', cx: 12, cy: 5, rx: 9, ry: 3 },
      { op: 'path', d: 'M21 12c0 1.66-4 3-9 3s-9-1.34-9-3' },
      { op: 'path', d: 'M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5' },
    ],
    appearance: [
      { op: 'circle', cx: 13.5, cy: 6.5, r: 0.7, fill: true },
      { op: 'circle', cx: 17.5, cy: 10.5, r: 0.7, fill: true },
      { op: 'circle', cx: 8.5, cy: 7.5, r: 0.7, fill: true },
      { op: 'circle', cx: 6.5, cy: 12.5, r: 0.7, fill: true },
      { op: 'path', d: 'M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z' },
    ],
    mail: [
      { op: 'path', d: 'M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z' },
      { op: 'poly', pts: [[22, 6], [12, 13], [2, 6]] },
    ],
    admin: [
      { op: 'path', d: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2' },
      { op: 'circle', cx: 9, cy: 7, r: 4 },
      { op: 'path', d: 'M23 21v-2a4 4 0 0 0-3-3.87' },
      { op: 'path', d: 'M16 3.13a4 4 0 0 1 0 7.75' },
    ],
    about: [
      { op: 'circle', cx: 12, cy: 12, r: 10 },
      { op: 'line', x1: 12, y1: 16, x2: 12, y2: 12 },
      { op: 'circle', cx: 12, cy: 8, r: 0.7, fill: true },
    ],
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

  var _cachedAccentKey = '';
  var _cachedAccentVal = [0.102, 0.451, 0.910];
  function themeAccent() {
    var root = document.documentElement;
    var theme = root.getAttribute('data-theme') || 'light';
    var scheme = root.getAttribute('data-color-scheme') || 'frost';
    var inlineAccent = root.style.getPropertyValue('--accent') || root.style.getPropertyValue('--color-primary') || '';
    var key = theme + '|' + scheme + '|' + inlineAccent;
    if (key === _cachedAccentKey) return _cachedAccentVal;
    var rootCs = getComputedStyle(root);
    var raw = rootCs.getPropertyValue('--accent').trim() || rootCs.getPropertyValue('--color-primary').trim();
    if (!raw || raw.indexOf('var(') !== -1) {
      raw = scheme === 'lava' ? '#b85c22' : scheme === 'asagi' ? '#3f8f82' : scheme === 'cyber' ? '#448e96' : '#1a73e8';
    }
    var rgb = parseRgb(raw);
    _cachedAccentKey = key;
    _cachedAccentVal = [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255];
    return _cachedAccentVal;
  }

  // Shared Global Wallpaper Image cache & viewport-slice backdrop synthesizer
  var cachedWpSrc = '';
  var cachedWpImg = null;
  var wpLoadListeners = [];

  function notifyWpReady() {
    for (var i = 0; i < wpLoadListeners.length; i++) {
      try { wpLoadListeners[i](); } catch (e) {}
    }
  }

  function ensureGlobalWpImage() {
    var host = document.getElementById('zephyrGlobalWallpaper');
    var hasGw = document.documentElement.getAttribute('data-global-wallpaper') === '1';
    var src = (hasGw && host && host.dataset && host.dataset.currentUrl) ? host.dataset.currentUrl : '';
    if (!src) {
      cachedWpSrc = '';
      cachedWpImg = null;
      return null;
    }
    if (src === cachedWpSrc && cachedWpImg && cachedWpImg.complete && cachedWpImg.naturalWidth > 0) {
      return cachedWpImg;
    }
    if (src !== cachedWpSrc) {
      cachedWpSrc = src;
      cachedWpImg = null;
      var img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = function () {
        if (cachedWpSrc === src) {
          cachedWpImg = img;
          notifyWpReady();
        }
      };
      img.src = src;
    }
    return cachedWpImg;
  }

  function renderBackdropSliceCanvas(targetCanvasRect, sliceCanvas) {
    var fullW = Math.max(16, Math.round(targetCanvasRect.width || 240));
    var fullH = Math.max(16, Math.round(targetCanvasRect.height || 56));
    var scale = 0.5;
    var w = Math.max(16, Math.round(fullW * scale));
    var h = Math.max(16, Math.round(fullH * scale));
    if (!sliceCanvas) sliceCanvas = document.createElement('canvas');
    if (sliceCanvas.width !== w) sliceCanvas.width = w;
    if (sliceCanvas.height !== h) sliceCanvas.height = h;
    var ctx = sliceCanvas.getContext('2d');
    if (!ctx) return sliceCanvas;

    var rootCs = getComputedStyle(document.documentElement);
    var light = isLightTheme();
    var bgRgb = parseRgb(rootCs.getPropertyValue('--bg') || (light ? '#eaeef4' : '#0d1015'));
    var surfRgb = parseRgb(rootCs.getPropertyValue('--surface') || (light ? '#ffffff' : '#161920'));
    var acc = themeAccent();
    var accR = Math.round(acc[0] * 255);
    var accG = Math.round(acc[1] * 255);
    var accB = Math.round(acc[2] * 255);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // 1. Base theme background fill
    ctx.fillStyle = 'rgb(' + bgRgb[0] + ',' + bgRgb[1] + ',' + bgRgb[2] + ')';
    ctx.fillRect(0, 0, w, h);

    // 2. If Global Wallpaper is active & loaded, draw the exact viewport slice behind this bar (NO software ctx.filter blur — WebGL Kawase blur handles it on GPU!)
    var wpImg = ensureGlobalWpImage();
    var vw = Math.max(1, window.innerWidth || 1440);
    var vh = Math.max(1, window.innerHeight || 900);
    var left = targetCanvasRect.left || 0;
    var top = targetCanvasRect.top || 0;

    if (wpImg && wpImg.naturalWidth > 0 && wpImg.naturalHeight > 0) {
      var wpOpacity = parseFloat(rootCs.getPropertyValue('--z-global-bg-opacity'));
      if (!Number.isFinite(wpOpacity)) wpOpacity = 0.45;
      var wpFit = (rootCs.getPropertyValue('--z-global-bg-size') || 'cover').trim();

      var stageX = -28;
      var stageY = -28;
      var stageW = vw + 56;
      var stageH = vh + 56;
      var iw = wpImg.naturalWidth;
      var ih = wpImg.naturalHeight;
      var drawW = stageW;
      var drawH = stageH;
      if (wpFit === 'contain') {
        var sContain = Math.min(stageW / iw, stageH / ih);
        drawW = iw * sContain;
        drawH = ih * sContain;
      } else if (wpFit === 'auto') {
        drawW = iw;
        drawH = ih;
      } else {
        var sCover = Math.max(stageW / iw, stageH / ih);
        drawW = iw * sCover;
        drawH = ih * sCover;
      }
      var drawX = stageX + (stageW - drawW) / 2;
      var drawY = stageY + (stageH - drawH) / 2;

      ctx.save();
      ctx.scale(scale, scale);
      ctx.translate(-left, -top);
      ctx.globalAlpha = Math.max(0, Math.min(1, wpOpacity));
      ctx.drawImage(wpImg, drawX, drawY, drawW, drawH);
      ctx.restore();

      // Subtle scrim matching .global-wp-scrim (no extra white wash!)
      ctx.fillStyle = light ? 'rgba(255, 255, 255, 0.08)' : 'rgba(14, 18, 26, 0.14)';
      ctx.fillRect(0, 0, w, h);
    } else {
      // 3. Ambient multi-stop light gradient ONLY when no global wallpaper is active
      var ambientAlpha = light ? 0.16 : 0.18;
      var grad = ctx.createLinearGradient(0, 0, w, h);
      grad.addColorStop(0, 'rgba(' + accR + ',' + accG + ',' + accB + ',' + (ambientAlpha * 0.85).toFixed(3) + ')');
      grad.addColorStop(0.5, 'rgba(' + surfRgb[0] + ',' + surfRgb[1] + ',' + surfRgb[2] + ',' + (ambientAlpha * 0.45).toFixed(3) + ')');
      grad.addColorStop(1, 'rgba(' + accR + ',' + accG + ',' + accB + ',' + (ambientAlpha * 0.65).toFixed(3) + ')');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
    }

    return sliceCanvas;
  }

  function buildBgSignature(rect) {
    var root = document.documentElement;
    var rootCs = getComputedStyle(root);
    return [
      isLightTheme() ? 'L' : 'D',
      root.getAttribute('data-color-scheme') || 'frost',
      root.getAttribute('data-global-wallpaper') || '0',
      (document.getElementById('zephyrGlobalWallpaper')?.dataset?.currentUrl || '').slice(-32),
      cachedWpImg ? 'img1' : 'img0',
      rootCs.getPropertyValue('--z-global-bg-opacity').trim(),
      rootCs.getPropertyValue('--z-global-bg-size').trim(),
      themeAccent().map(function (v) { return v.toFixed(3); }).join(','),
      Math.round(rect.left) + ',' + Math.round(rect.top) + ',' + Math.round(rect.width) + ',' + Math.round(rect.height),
    ].join('|');
  }

  function visibleTabs(containerEl, selector) {
    return Array.from(containerEl.querySelectorAll(selector)).filter(function (t) {
      if (t.classList.contains('force-hidden') || t.hidden || t.style.display === 'none') return false;
      if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
        if (window.getComputedStyle(t).display === 'none') return false;
      }
      return true;
    });
  }

  /* ========================================================================
   * 1. Topbar Horizontal Liquid Glass Bottom Tabs (.main-nav .nav-tabs)
   * ======================================================================== */
  function bootTopNav() {
    var nav = document.querySelector('.main-nav');
    if (!nav) return null;
    var navTabs = nav.querySelector('.nav-tabs');
    if (!navTabs) return null;

    var canvas = document.getElementById('liquidGlassCanvas');
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.id = 'liquidGlassCanvas';
      canvas.setAttribute('aria-hidden', 'true');
      nav.insertBefore(canvas, nav.firstChild);
    }

    var renderer;
    try {
      renderer = new Renderer(canvas);
    } catch (e) {
      nav.classList.add('no-liquid-glass');
      return null;
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
    var sliceCanvas = document.createElement('canvas');
    var pointerDown = false;
    var didDrag = false;
    var gesture = null;
    var suppressClick = false;
    var lastTabCount = -1;
    var lastLayoutKey = '';
    var lastSizeKey = '';
    var lastBgKey = '';
    var lastTerminal = document.body.classList.contains('terminal-mode');

    function overlayCanvas() {
      var Layout = window.LiquidGlassTabLayout;
      var bar = navTabs.getBoundingClientRect();
      var fixedNavH = 56;
      var size = Layout
        ? Layout.overlayCanvasSize(nav.clientWidth, fixedNavH, bar.height)
        : { w: Math.max(1, nav.clientWidth), h: fixedNavH + 24 };
      canvas.style.width = size.w + 'px';
      canvas.style.height = size.h + 'px';
      // Set 0.01x0.01 clip so fboA outside glass elements stays 100% transparent (0,0,0,0),
      // while wallpaperBlurFbo receives the full backdrop slice for refraction & blur!
      if (typeof renderer.setWallpaperClip === 'function') {
        renderer.setWallpaperClip(0, 0, 0.01, 0.01);
      } else {
        renderer.wallpaperClipCss = { x: 0, y: 0, w: 0.01, h: 0.01 };
      }
      return { w: size.w, h: size.h, barH: bar.height };
    }

    function canvasOrigin() {
      var r = canvas.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height, left: r.left, top: r.top };
    }

    function applyBackground(force) {
      var cRect = canvas.getBoundingClientRect();
      if (cRect.width < 2 || cRect.height < 2) return;
      var key = buildBgSignature(cRect);
      if (!force && key === lastBgKey) return;
      lastBgKey = key;
      if (typeof renderer.setBackgroundColor === 'function') {
        renderer.setBackgroundColor(null);
      } else {
        renderer.backgroundColor = null;
      }
      if (renderer._wpTexPool && renderer._wpTexPool.has(key) && typeof renderer.loadWallpaperFromCanvas === 'function') {
        renderer.loadWallpaperFromCanvas(null, key);
        return;
      }
      renderBackdropSliceCanvas(cRect, sliceCanvas);
      if (typeof renderer.loadWallpaperFromCanvas === 'function') {
        renderer.loadWallpaperFromCanvas(sliceCanvas, key);
      } else {
        renderer.loadWallpaper(sliceCanvas.toDataURL('image/png')).catch(function () {});
      }
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

    var cachedTabWKey = '';
    var cachedTabWVal = 0;
    function equalizeDomTabs(tabs) {
      var Layout = window.LiquidGlassTabLayout;
      if (!Layout || !tabs.length) {
        navTabs.style.removeProperty('--lg-tab-w');
        return 0;
      }
      var fill = islandMode() === 'fill';
      var available = remainingInnerWidth();
      if (fill) {
        var glass = glassClient();
        if (glass.w > available) available = glass.w;
      }
      var textSig = tabs.map(function (t) { return (t.textContent || '').trim(); }).join('|');
      var key = tabs.length + ':' + (fill ? 'F' : 'H') + ':' + Math.round(available) + ':' + textSig;
      if (key === cachedTabWKey && cachedTabWVal > 0) {
        navTabs.style.setProperty('--lg-tab-w', cachedTabWVal + 'px');
        return cachedTabWVal;
      }
      navTabs.style.removeProperty('--lg-tab-w');
      var naturals = tabs.map(function (t) { return t.offsetWidth || t.getBoundingClientRect().width; });
      var tabW = Layout.chooseTabWidth(naturals, available, fill);
      cachedTabWKey = key;
      cachedTabWVal = tabW;
      if (tabW > 0) navTabs.style.setProperty('--lg-tab-w', tabW + 'px');
      else navTabs.style.removeProperty('--lg-tab-w');
      return tabW;
    }

    function buildElements() {
      var tabs = visibleTabs(navTabs, '.nav-tab');
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
      var tabW = tabRects[0] && tabRects[0].w > 0 ? tabRects[0].w : (Layout.avgEqualWidth(tabRects) || (n ? glassW / n : 1));
      var tabOffsets = tabRects.map(function (r) { return r.x - tabRects[0].x; });
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
        isBottomTabContainer: { groupId: GROUP, tabsCount: n, axis: 'x' },
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
        var viewKey = tabs[i].dataset.view || '';
        var iconCmds = ICON_COMMANDS[viewKey] || null;
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
            content: (tabs[i].textContent || '').trim(),
            color: palette.tabsContentColor.slice(),
            fontSizePx: 13,
            fontWeight: 600,
            align: 'center',
            wrap: false,
            paddingPx: 0,
            valign: 'center',
            halo: palette.tabsTextHalo,
            icon: iconCmds ? {
              layout: 'inline-center',
              size: 15,
              gap: 6,
              viewport: 24,
              strokeWidth: 2,
              color: palette.tabsContentColor.slice(),
              commands: iconCmds,
            } : undefined,
          },
          isBottomTabContent: {
            groupId: GROUP,
            axis: 'x',
            containerCenterX: containerX + containerW / 2,
            containerCenterY: containerY + containerH / 2,
            containerWidth: containerW,
          },
        });
      }

      var indY = tabRects[0] ? tabRects[0].y : glassY;
      var indH = tabRects[0] && tabRects[0].h > 0 ? tabRects[0].h : glassH;
      var indR = indH / 2;
      var indicatorEl = {
        id: GROUP + '-indicator',
        kind: 'glass-shape',
        rect: { x: tabRects[0].x, y: indY, w: tabW, h: indH },
        cornerRadius: indR,
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
          axis: 'x',
          dragWidth: tabW,
          tabOffsets: tabOffsets,
          scaleXFactor: 1.0,
          scaleYFactor: 1.0,
          restRefractionFactor: 0.0,
          restHighlightAlpha: 0.44,
          restShadowAlpha: 0.07,
          dimColor: palette.backIconColor.slice(),
          accentColor: accentT.slice(),
          containerRect: { x: glassX, y: indY, w: glassW, h: indH },
          containerCornerRadius: indR,
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

    function layout(forceBg) {
      var Layout = window.LiquidGlassTabLayout;
      var tabs = visibleTabs(navTabs, '.nav-tab');
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
      var textSig = tabs.map(function (t) { return (t.textContent || '').trim(); }).join('|');
      var sizeKey = Layout && Layout.layoutSizeKey
        ? Layout.layoutSizeKey(w, h)
        : (Math.round(w) + 'x' + Math.round(h));
      var contentKey = tabs.length + ':' + Math.round(bar.width) + ':' + Math.round(bar.height) + ':' +
        (isLightTheme() ? 'L' : 'D') + ':' + rectKey + ':' + themeAccent().join(',') + ':' + textSig;
      if (sizeKey !== lastSizeKey) {
        lastSizeKey = sizeKey;
        renderer.resize(w, h);
      }
      applyBackground(Boolean(forceBg));
      if (contentKey !== lastLayoutKey || forceBg) {
        lastLayoutKey = contentKey;
        renderer.pendingExtraRenders = 1;
        buildElements();
      } else {
        renderer.requestRender();
      }
    }

    function followShelfHeight() {
      layout(false);
    }

    function activateTab(i) {
      var tabs = visibleTabs(navTabs, '.nav-tab');
      if (i < 0 || i >= tabs.length) return;
      var view = tabs[i].dataset.view;
      if (typeof window.switchView === 'function' && view) {
        window.switchView(view, { cardFlipSource: tabs[i] });
      } else {
        tabs[i].click();
      }
    }

    function currentTabWidth() {
      var tabs = visibleTabs(navTabs, '.nav-tab');
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
      var tabs = visibleTabs(navTabs, '.nav-tab');
      var Layout = window.LiquidGlassTabLayout;
      if (!Layout || !tabs.length) return -1;
      var rects = measureDomRects(tabs);
      var hit = Layout.hitIndexFromRects(e.clientX, e.clientY, rects);
      if (hit >= 0) return hit;
      var glass = glassClient();
      return Layout.hitIndexFromX(e.clientX, glass.x, glass.w, tabs.length);
    }

    var dragStartX = 0;
    var dragStartIndex = 0;
    var hitTabOnDown = -1;

    navTabs.addEventListener('pointerdown', function (e) {
      if (e.button != null && e.button !== 0) return;
      var n = visibleTabs(navTabs, '.nav-tab').length;
      if (!n) return;
      pointerDown = true;
      didDrag = false;
      dragStartX = e.clientX;
      hitTabOnDown = hitTabIndex(e);
      dragStartIndex = renderer.getTabTarget(GROUP);
    });

    navTabs.addEventListener('pointermove', function (e) {
      if (!pointerDown) return;
      var tabs = visibleTabs(navTabs, '.nav-tab');
      var n = tabs.length;
      if (!n) return;
      var dx = e.clientX - dragStartX;
      if (!didDrag && Math.abs(dx) > 3) {
        didDrag = true;
        // Start drag from the tab under the pointer if dragging a tab, or current target
        dragStartIndex = hitTabOnDown >= 0 ? hitTabOnDown : renderer.getTabTarget(GROUP);
        renderer.beginTabDrag(GROUP, dragStartIndex, n);
        try { navTabs.setPointerCapture(e.pointerId); } catch (err) {}
      }
      if (!didDrag) return;
      if (e.cancelable) e.preventDefault();
      renderer.dragTab(
        GROUP,
        dragStartIndex,
        e.clientX,
        dragStartX,
        currentTabWidth(),
        n
      );
    }, { passive: false });

    function endPointer(e) {
      if (!pointerDown) return;
      var tabs = visibleTabs(navTabs, '.nav-tab');
      var n = tabs.length;
      var wasDrag = didDrag;
      pointerDown = false;
      didDrag = false;
      gesture = null;
      if (wasDrag && n) {
        // Set suppressOnSelectGuard so syncObserver does NOT call setTabSelected and zero out drag velocity!
        endPointer._suppressSelectSync = true;
        var snapped = renderer.endTabDrag(GROUP, n);
        layout(false);
        activateTab(snapped);
        setTimeout(function () { endPointer._suppressSelectSync = false; }, 50);
        suppressClick = true;
        setTimeout(function () { suppressClick = false; }, 0);
      } else if (hitTabOnDown >= 0 && hitTabOnDown < n) {
        endPointer._suppressSelectSync = true;
        renderer.setTabSelected(GROUP, hitTabOnDown, n);
        activateTab(hitTabOnDown);
        setTimeout(function () { endPointer._suppressSelectSync = false; }, 50);
        suppressClick = true;
        setTimeout(function () { suppressClick = false; }, 0);
      }
    }

    navTabs.addEventListener('pointerup', endPointer);
    navTabs.addEventListener('pointercancel', function () {
      if (!pointerDown) return;
      var n = visibleTabs(navTabs, '.nav-tab').length;
      var wasDrag = didDrag;
      pointerDown = false;
      didDrag = false;
      gesture = null;
      if (wasDrag && n) {
        renderer.endTabDrag(GROUP, n);
        layout(false);
      }
    });

    navTabs.addEventListener('click', function (e) {
      if (!suppressClick) return;
      e.stopPropagation();
      e.stopImmediatePropagation();
      suppressClick = false;
    }, true);

    var syncObserver = new MutationObserver(function () {
      var tabs = visibleTabs(navTabs, '.nav-tab');
      var idx = tabs.findIndex(function (t) { return t.classList.contains('active'); });
      if (idx >= 0 && !didDrag && !pointerDown && !endPointer._suppressSelectSync) {
        renderer.setTabSelected(GROUP, idx, tabs.length);
      }
      layout(false);
    });
    syncObserver.observe(navTabs, {
      attributes: true,
      attributeFilter: ['class'],
      subtree: true,
      childList: true,
      characterData: true,
    });

    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(function () { layout(false); }).observe(navTabs);
      try {
        new ResizeObserver(function () { layout(false); }).observe(nav, { box: 'border-box' });
      } catch (err) {
        new ResizeObserver(function () { layout(false); }).observe(nav);
      }
    }
    nav.addEventListener('transitionend', function (e) {
      if (e && e.propertyName && e.propertyName !== 'padding-bottom') return;
      layout(false);
    });
    var bodyObserver = new MutationObserver(function () {
      var now = document.body.classList.contains('terminal-mode');
      layout(false);
      if (now !== lastTerminal) {
        lastTerminal = now;
        followShelfHeight();
      }
    });
    bodyObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });

    layout(true);
    requestAnimationFrame(function () { layout(true); });

    return {
      renderer: renderer,
      canvas: canvas,
      refresh: function (forceBg) {
        if (forceBg) lastLayoutKey = '';
        layout(Boolean(forceBg));
      },
    };
  }

  /* ========================================================================
   * 2. Settings Left Sidebar Vertical Liquid Glass Bottom Tabs (#view-settings .settings-menu)
   * ======================================================================== */
  function bootSettingsSidebar() {
    var menu = document.querySelector('#view-settings .settings-menu');
    if (!menu) return null;

    var canvas = document.getElementById('settingsLiquidGlassCanvas');
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.id = 'settingsLiquidGlassCanvas';
      canvas.className = 'settings-lg-canvas';
      canvas.setAttribute('aria-hidden', 'true');
      menu.insertBefore(canvas, menu.firstChild);
    }

    var renderer;
    try {
      renderer = new Renderer(canvas);
    } catch (e) {
      menu.classList.add('no-liquid-glass');
      return null;
    }

    renderer.usePerElementFbo = true;
    renderer.quickToggles.perElementFbo = true;
    renderer.useKawaseBlur = true;
    renderer.useBlurCache = true;
    renderer.noContinuousSdf = true;
    renderer.directBackdropSample = true;
    renderer.capsuleShape = true;
    renderer.pendingExtraRenders = 1;

    menu.classList.add('liquid-glass-on');

    var GROUP = 'zephyr-settings-nav';
    var PAD_OUTER = 14;
    var sliceCanvas = document.createElement('canvas');
    var pointerDown = false;
    var didDrag = false;
    var startY = 0;
    var startIdx = 0;
    var suppressClick = false;
    var lastTabCount = -1;
    var lastLayoutKey = '';
    var lastSizeKey = '';
    var lastBgKey = '';

    function overlayCanvas() {
      var bar = menu.getBoundingClientRect();
      var w = Math.max(1, Math.round(bar.width)) + PAD_OUTER * 2;
      var h = Math.max(1, Math.round(bar.height)) + PAD_OUTER * 2;
      canvas.style.left = (-PAD_OUTER) + 'px';
      canvas.style.top = (-PAD_OUTER) + 'px';
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
      if (typeof renderer.setWallpaperClip === 'function') {
        renderer.setWallpaperClip(0, 0, 0.01, 0.01);
      } else {
        renderer.wallpaperClipCss = { x: 0, y: 0, w: 0.01, h: 0.01 };
      }
      return { w: w, h: h, barW: bar.width, barH: bar.height };
    }

    function applyBackground(force) {
      var cRect = canvas.getBoundingClientRect();
      if (cRect.width < 10 || cRect.height < 10) return;
      var key = buildBgSignature(cRect);
      if (!force && key === lastBgKey) return;
      lastBgKey = key;
      if (typeof renderer.setBackgroundColor === 'function') {
        renderer.setBackgroundColor(null);
      } else {
        renderer.backgroundColor = null;
      }
      if (renderer._wpTexPool && renderer._wpTexPool.has(key) && typeof renderer.loadWallpaperFromCanvas === 'function') {
        renderer.loadWallpaperFromCanvas(null, key);
        return;
      }
      renderBackdropSliceCanvas(cRect, sliceCanvas);
      if (typeof renderer.loadWallpaperFromCanvas === 'function') {
        renderer.loadWallpaperFromCanvas(sliceCanvas, key);
      } else {
        renderer.loadWallpaper(sliceCanvas.toDataURL('image/png')).catch(function () {});
      }
    }

    function measureTabs() {
      var tabs = visibleTabs(menu, '.settings-tab');
      var cRect = canvas.getBoundingClientRect();
      return tabs.map(function (t) {
        var r = t.getBoundingClientRect();
        return {
          el: t,
          left: r.left,
          top: r.top,
          right: r.right,
          bottom: r.bottom,
          x: r.left - cRect.left,
          y: r.top - cRect.top,
          w: r.width,
          h: r.height,
        };
      });
    }

    function buildElements() {
      var measured = measureTabs();
      if (!measured.length) return;
      var bar = menu.getBoundingClientRect();
      var cRect = canvas.getBoundingClientRect();
      if (bar.width < 10 || bar.height < 10) return;

      var palette = isLightTheme() ? LIGHT : DARK;
      var accentT = themeAccent();
      var containerX = bar.left - cRect.left;
      var containerY = bar.top - cRect.top;
      var containerW = bar.width;
      var containerH = bar.height;
      var containerR = 16;
      var n = measured.length;

      var first = measured[0];
      var last = measured[n - 1];
      var stepY = n > 1 ? (last.y - first.y) / (n - 1) : first.h;
      var tabOffsets = measured.map(function (m) { return m.y - first.y; });
      var activeIndex = Math.max(0, measured.findIndex(function (m) {
        return m.el.classList.contains('active');
      }));

      var elements = [];

      // Layer 1: Outer translucent Liquid Glass sidebar container
      var containerEl = {
        id: GROUP + '-container',
        kind: 'glass-shape',
        rect: { x: containerX, y: containerY, w: containerW, h: containerH },
        cornerRadius: containerR,
        refractionHeight: 20 * DP,
        refractionAmount: -20 * DP,
        depthEffect: true,
        chromaticAberration: false,
        blurRadius: 8 * DP,
        saturation: 1.5,
        brightness: 0,
        contrast: 1,
        tintColor: [0, 0, 0, 0],
        surfaceColor: palette.sidebarContainer.slice(),
        highlight: Object.assign({}, DEFAULT_HIGHLIGHT, { alpha: 0.45 }),
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
        isBottomTabContainer: { groupId: GROUP, tabsCount: n, axis: 'y' },
      };
      elements.push(containerEl);

      // Layer 2: Tab contents (vector icon + text label per item)
      var tabContentIds = [];
      var tabContentRects = [];
      for (var i = 0; i < n; i++) {
        var id = GROUP + '-tab-' + i;
        var m = measured[i];
        var cell = { x: m.x, y: m.y, w: m.w, h: m.h };
        tabContentIds.push(id);
        tabContentRects.push(cell);
        var tabKey = m.el.dataset.settings || 'settings';
        var iconCmds = ICON_COMMANDS[tabKey] || ICON_COMMANDS.settings;
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
            content: (m.el.textContent || '').trim(),
            color: palette.tabsContentColor.slice(),
            fontSizePx: 13,
            fontWeight: 600,
            align: 'left',
            wrap: false,
            paddingPx: 16,
            valign: 'center',
            halo: palette.tabsTextHalo,
            icon: {
              layout: 'inline-left',
              size: 15,
              gap: 9,
              viewport: 24,
              strokeWidth: 2,
              color: palette.tabsContentColor.slice(),
              commands: iconCmds,
            },
          },
          isBottomTabContent: {
            groupId: GROUP,
            axis: 'y',
            containerCenterX: containerX + containerW / 2,
            containerCenterY: containerY + containerH / 2,
            containerWidth: containerH,
          },
        });
      }

      // Layer 3: Sliding Liquid Glass capsule indicator (translucent at rest, 3D refractive lens when sliding/dragging)
      var indicatorEl = {
        id: GROUP + '-indicator',
        kind: 'glass-shape',
        rect: { x: first.x, y: first.y, w: first.w, h: first.h },
        cornerRadius: first.h / 2,
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
          axis: 'y',
          dragWidth: stepY,
          dragHeight: stepY,
          tabOffsets: tabOffsets,
          scaleXFactor: 0.14,
          scaleYFactor: 0.92,
          restRefractionFactor: 0.0,
          restHighlightAlpha: 0.44,
          restShadowAlpha: 0.07,
          dimColor: palette.backIconColor.slice(),
          accentColor: accentT.slice(),
          containerRect: { x: containerX + 4, y: containerY + 4, w: containerW - 8, h: containerH - 8 },
          containerCornerRadius: 12,
          containerCenterX: containerX + containerW / 2,
          containerCenterY: containerY + containerH / 2,
          containerWidth: containerH,
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

    function layout(forceBg) {
      var bar = menu.getBoundingClientRect();
      if (bar.width < 10 || bar.height < 10) return;
      var size = overlayCanvas();
      var w = size.w;
      var h = size.h;
      var measured = measureTabs();
      if (!measured.length) return;
      var textSig = measured.map(function (m) { return (m.el.textContent || '').trim(); }).join('|');
      var sizeKey = w + 'x' + h;
      var contentKey = measured.length + ':' + Math.round(bar.width) + ':' + Math.round(bar.height) + ':' +
        (isLightTheme() ? 'L' : 'D') + ':' + themeAccent().join(',') + ':' + textSig;
      if (sizeKey !== lastSizeKey) {
        lastSizeKey = sizeKey;
        renderer.resize(w, h);
      }
      applyBackground(Boolean(forceBg));
      if (contentKey !== lastLayoutKey || forceBg) {
        lastLayoutKey = contentKey;
        renderer.pendingExtraRenders = 1;
        buildElements();
      } else {
        renderer.requestRender();
      }
    }

    function hitTabIndexY(clientY) {
      var measured = measureTabs();
      if (!measured.length) return -1;
      for (var i = 0; i < measured.length; i++) {
        if (clientY >= measured[i].top && clientY <= measured[i].bottom) return i;
      }
      var first = measured[0];
      var last = measured[measured.length - 1];
      if (clientY < first.top) return 0;
      if (clientY > last.bottom) return measured.length - 1;
      var step = (last.top - first.top) / Math.max(1, measured.length - 1);
      return Math.max(0, Math.min(measured.length - 1, Math.round((clientY - first.top) / Math.max(1, step))));
    }

    var hitOnDownY = -1;

    menu.addEventListener('pointerdown', function (e) {
      if (e.button != null && e.button !== 0) return;
      var measured = measureTabs();
      if (!measured.length) return;
      pointerDown = true;
      didDrag = false;
      startY = e.clientY;
      hitOnDownY = hitTabIndexY(e.clientY);
      startIdx = hitOnDownY >= 0 ? hitOnDownY : Math.round(renderer.getTabTarget(GROUP) || 0);
    });

    menu.addEventListener('pointermove', function (e) {
      if (!pointerDown) return;
      var dy = e.clientY - startY;
      var measured = measureTabs();
      var n = measured.length;
      if (!n) return;
      if (!didDrag && Math.abs(dy) > 3) {
        didDrag = true;
        renderer.beginTabDrag(GROUP, startIdx, n);
        try { menu.setPointerCapture(e.pointerId); } catch (err) {}
      }
      if (!didDrag) return;
      if (e.cancelable) e.preventDefault();
      var first = measured[0];
      var last = measured[n - 1];
      var stepY = n > 1 ? (last.y - first.y) / (n - 1) : first.h;
      renderer.dragTab(GROUP, startIdx, e.clientY, startY, Math.max(1, stepY), n);
    }, { passive: false });

    function endPointer(e) {
      if (!pointerDown) return;
      var measured = measureTabs();
      var n = measured.length;
      pointerDown = false;
      if (didDrag && n) {
        didDrag = false;
        endPointer._suppressSelectSync = true;
        var snapped = renderer.endTabDrag(GROUP, n);
        layout(false);
        if (measured[snapped] && measured[snapped].el) {
          suppressClick = false;
          measured[snapped].el.click();
        }
        setTimeout(function () { endPointer._suppressSelectSync = false; }, 50);
        suppressClick = true;
        setTimeout(function () { suppressClick = false; }, 0);
      } else if (hitOnDownY >= 0 && hitOnDownY < n && measured[hitOnDownY] && measured[hitOnDownY].el) {
        renderer.setTabSelected(GROUP, hitOnDownY, n);
      }
    }

    menu.addEventListener('pointerup', endPointer);
    menu.addEventListener('pointercancel', function () {
      if (!pointerDown) return;
      var measured = measureTabs();
      pointerDown = false;
      if (didDrag && measured.length) {
        didDrag = false;
        renderer.endTabDrag(GROUP, measured.length);
        layout(false);
      }
    });

    menu.addEventListener('click', function (e) {
      if (!suppressClick) return;
      e.stopPropagation();
      e.stopImmediatePropagation();
      suppressClick = false;
    }, true);

    var syncObserver = new MutationObserver(function () {
      var tabs = visibleTabs(menu, '.settings-tab');
      var idx = tabs.findIndex(function (t) { return t.classList.contains('active'); });
      if (idx >= 0 && !didDrag && !pointerDown && !endPointer._suppressSelectSync) {
        renderer.setTabSelected(GROUP, idx, tabs.length);
      }
      layout(false);
    });
    syncObserver.observe(menu, {
      attributes: true,
      attributeFilter: ['class'],
      subtree: true,
      childList: true,
      characterData: true,
    });

    var settingsView = document.getElementById('view-settings');
    if (settingsView) {
      new MutationObserver(function () {
        if (settingsView.classList.contains('active')) {
          requestAnimationFrame(function () { layout(true); });
        }
      }).observe(settingsView, { attributes: true, attributeFilter: ['class'] });
    }

    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(function () { layout(false); }).observe(menu);
    }

    layout(true);
    requestAnimationFrame(function () { layout(true); });

    return {
      renderer: renderer,
      canvas: canvas,
      refresh: function (forceBg) {
        if (forceBg) lastLayoutKey = '';
        layout(Boolean(forceBg));
      },
    };
  }

  function bootAll() {
    var topBarCtrl = bootTopNav();
    var settingsBarCtrl = bootSettingsSidebar();

    var settingsView = document.getElementById('view-settings');
    function isSettingsVisible() {
      return !settingsView || settingsView.classList.contains('active');
    }

    function refreshAll(forceBg) {
      if (topBarCtrl) topBarCtrl.refresh(forceBg);
      if (settingsBarCtrl && isSettingsVisible()) {
        settingsBarCtrl.refresh(forceBg);
      }
    }

    var rafRefreshPending = false;
    function scheduleRefreshAll(forceBg) {
      if (rafRefreshPending) return;
      rafRefreshPending = true;
      requestAnimationFrame(function () {
        rafRefreshPending = false;
        refreshAll(Boolean(forceBg));
      });
    }

    wpLoadListeners.push(function () {
      scheduleRefreshAll(true);
    });

    var rootObserver = new MutationObserver(function () {
      if (window.__zephyrThemeTransitioning) return;
      scheduleRefreshAll(false);
    });
    rootObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-color-scheme', 'data-global-wallpaper', 'data-locale', 'lang'],
    });

    window.addEventListener('resize', function () {
      scheduleRefreshAll(false);
    });

    window.ZephyrLiquidGlassBars = {
      topNav: topBarCtrl,
      settingsSidebar: settingsBarCtrl,
      refreshAll: refreshAll,
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootAll);
  } else {
    bootAll();
  }
})();
