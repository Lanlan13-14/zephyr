/* ============================================================
 * Zephyr Liquid Glass Slider — Complete Port from
 * martin65536/liquid-glass-webgl (build-slider.ts + helpers-slider.ts
 * + helpers-drag.ts + methods-toggle.ts + palettes.ts)
 *
 * Uses window.LiquidGlassWebGL.LiquidGlassRenderer with:
 *   - 6dp capsule track (G2 continuous-curvature SDF)
 *   - Dynamic theme-aware bottom fill line (isSliderFill, tracks --accent)
 *   - 40×24 G2 capsule knob (isToggleKnob, pressedScale=1.5, velocityDivisor=10)
 *     Frosted white pebble at rest (alpha=1, blur=8dp) → morphs on press/drag
 *     into clear 3D refractive liquid glass lens (refractionHeight=10dp,
 *     refractionAmount=-14dp, chromaticAberration=true, innerShadow=4dp@0.3,
 *     ambient rim highlight) refracting the colored fill line underneath.
 *   - 100% stepless (continuous float, zero quantization/snap) adjustment.
 * ============================================================ */
(function () {
  'use strict';

  var DP = 1;
  var SLIDER_TRACK_H = 6 * DP;
  var SLIDER_KNOB_W = 40 * DP;
  var SLIDER_KNOB_H = 24 * DP;
  var SLIDER_CANVAS_H = 44 * DP;
  var SLIDER_PAD_X = 24 * DP;

  var LIGHT_TRACK_OFF = [0x78 / 255, 0x78 / 255, 0x78 / 255, 0.20];
  var DARK_TRACK_OFF = [0x78 / 255, 0x78 / 255, 0x80 / 255, 0.36];

  function clamp01(v) {
    v = Number(v);
    if (!Number.isFinite(v)) return 0;
    return Math.max(0, Math.min(1, v));
  }

  function isLightTheme() {
    return (document.documentElement.getAttribute('data-theme') || 'light') !== 'dark';
  }

  function parseCssColorToRgb255(str, fallback) {
    if (!str) return fallback || [10, 132, 255];
    var s = String(str).trim();
    if (s.charAt(0) === '#') {
      var h = s.slice(1);
      if (h.length === 3) {
        h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
      }
      if (h.length >= 6) {
        return [
          parseInt(h.slice(0, 2), 16) || 0,
          parseInt(h.slice(2, 4), 16) || 0,
          parseInt(h.slice(4, 6), 16) || 0,
        ];
      }
    }
    var m = s.match(/rgba?\(\s*([0-9.]+)[\s,]+([0-9.]+)[\s,]+([0-9.]+)/i);
    if (m) {
      return [
        Math.max(0, Math.min(255, Math.round(parseFloat(m[1]) || 0))),
        Math.max(0, Math.min(255, Math.round(parseFloat(m[2]) || 0))),
        Math.max(0, Math.min(255, Math.round(parseFloat(m[3]) || 0))),
      ];
    }
    return fallback || [10, 132, 255];
  }

  /**
   * Resolve the active theme's accent color as 0..1 RGB tuple [r, g, b].
   * Reads --accent (and --color-primary when custom scheme is active) so the
   * slider bottom fill line always matches Frost / Lava / Asagi / Cyber / Custom.
   */
  function resolveThemeAccent01() {
    var rootStyle = getComputedStyle(document.documentElement);
    var raw = rootStyle.getPropertyValue('--accent').trim();
    if (!raw || raw.indexOf('var(') !== -1) {
      raw = rootStyle.getPropertyValue('--color-primary').trim();
    }
    if (raw && (raw.charAt(0) === '#' || raw.indexOf('rgb') === 0)) {
      var directRgb = parseCssColorToRgb255(raw, isLightTheme() ? [0, 136, 255] : [0, 145, 255]);
      return [directRgb[0] / 255, directRgb[1] / 255, directRgb[2] / 255];
    }
    var probe = document.getElementById('__zephyrLgAccentProbe');
    if (!probe && document.body) {
      probe = document.createElement('span');
      probe.id = '__zephyrLgAccentProbe';
      probe.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;pointer-events:none;opacity:0;transition:none !important;color:var(--accent, #0a84ff);';
      document.body.appendChild(probe);
    }
    var resolved = probe ? getComputedStyle(probe).color : raw;
    var rgb = parseCssColorToRgb255(resolved || raw, isLightTheme() ? [0, 136, 255] : [0, 145, 255]);
    return [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255];
  }

  /**
   * Resolve the solid RGB backdrop [r, g, b] (0..1) of the slider card so the
   * WebGL FBO background matches the DOM card seamlessly and the glass lens
   * refracts the card surface + track + theme-colored fill line accurately.
   */
  function resolveSliderCardBg01(cardEl) {
    var light = isLightTheme();
    var fallback = light ? [248, 250, 253] : [30, 35, 45];
    var rootStyle = getComputedStyle(document.documentElement);
    var surfaceRgb = parseCssColorToRgb255(rootStyle.getPropertyValue('--surface'), light ? [255, 255, 255] : [26, 30, 38]);
    var bgRgb = parseCssColorToRgb255(rootStyle.getPropertyValue('--bg'), light ? [240, 244, 249] : [15, 19, 26]);
    var mixR = Math.round(surfaceRgb[0] * 0.72 + bgRgb[0] * 0.28);
    var mixG = Math.round(surfaceRgb[1] * 0.72 + bgRgb[1] * 0.28);
    var mixB = Math.round(surfaceRgb[2] * 0.72 + bgRgb[2] * 0.28);
    if (cardEl) {
      cardEl.style.setProperty('--lg-slider-card-bg', 'rgba(' + mixR + ', ' + mixG + ', ' + mixB + ', ' + (light ? '0.42' : '0.42') + ')');
    }
    return [
      (Number.isFinite(mixR) ? mixR : fallback[0]) / 255,
      (Number.isFinite(mixG) ? mixG : fallback[1]) / 255,
      (Number.isFinite(mixB) ? mixB : fallback[2]) / 255,
    ];
  }

  var instances = new Map();

  function createSliderController(input) {
    if (!input || instances.has(input.id)) return instances.get(input && input.id);
    var Renderer = window.LiquidGlassWebGL && window.LiquidGlassWebGL.LiquidGlassRenderer;

    // Ensure 100% stepless native range attributes
    input.setAttribute('step', 'any');

    var host = input.closest('.zephyr-lg-slider');
    if (!host) {
      host = document.createElement('div');
      host.className = 'zephyr-lg-slider';
      host.dataset.lgSliderFor = input.id || '';
      input.parentNode.insertBefore(host, input);
      host.appendChild(input);
    }
    var cardEl = host.closest('.lg-slider-group') || host.parentElement;
    if (cardEl) cardEl.classList.add('lg-slider-card');

    input.classList.add('lg-slider-native-input');

    var canvas = host.querySelector('.zephyr-lg-slider-canvas');
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.className = 'zephyr-lg-slider-canvas';
      canvas.setAttribute('aria-hidden', 'true');
      host.appendChild(canvas);
    }

    var renderer = null;
    if (Renderer) {
      try {
        renderer = new Renderer(canvas);
        renderer.usePerElementFbo = true;
        if (renderer.quickToggles) renderer.quickToggles.perElementFbo = true;
        renderer.useKawaseBlur = true;
        renderer.useBlurCache = true;
        renderer.noContinuousSdf = false;
        renderer.directBackdropSample = false;
        renderer.capsuleShape = true;
        host.classList.add('lg-webgl-ready');
      } catch (err) {
        renderer = null;
        host.classList.add('lg-webgl-fallback');
      }
    } else {
      host.classList.add('lg-webgl-fallback');
    }

    var groupId = 'lg-slider-' + (input.id || Math.random().toString(36).slice(2, 8));
    var lastW = 0;
    var lastH = 0;
    var lastStyleKey = '';
    var isDragging = false;
    var didDrag = false;
    var dragStartX = 0;
    var dragStartFraction = 0;
    var internalWrite = false;

    function getBounds() {
      var min = parseFloat(input.min);
      var max = parseFloat(input.max);
      if (!Number.isFinite(min)) min = 0;
      if (!Number.isFinite(max) || max <= min) max = 1;
      return { min: min, max: max };
    }

    function readInputFraction() {
      var b = getBounds();
      var val = parseFloat(input.value);
      if (!Number.isFinite(val)) val = b.min;
      return clamp01((val - b.min) / (b.max - b.min));
    }

    function fractionToRawValue(frac) {
      var b = getBounds();
      var f = clamp01(frac);
      var raw = b.min + f * (b.max - b.min);
      // Preserve stepless floating point precision without floating-point noise
      return Number(raw.toFixed(4));
    }

    function getTrackGeometry(w) {
      var width = Math.max(96, w || host.clientWidth || 240);
      var trackX = SLIDER_PAD_X;
      var trackW = Math.max(48, width - 2 * SLIDER_PAD_X);
      var trackY = (SLIDER_CANVAS_H - SLIDER_TRACK_H) / 2;
      var knobBaseX = trackX - SLIDER_KNOB_W / 4;
      var knobY = trackY + (SLIDER_TRACK_H - SLIDER_KNOB_H) / 2;
      var dragW = Math.max(1, trackW - SLIDER_KNOB_W / 2);
      return {
        canvasW: width,
        canvasH: SLIDER_CANVAS_H,
        trackX: trackX,
        trackY: trackY,
        trackW: trackW,
        knobBaseX: knobBaseX,
        knobY: knobY,
        dragW: dragW,
      };
    }

    function buildScene(forceRebuild) {
      if (!renderer) return;
      var rect = host.getBoundingClientRect();
      var w = Math.round(rect.width || host.clientWidth || 0);
      var h = SLIDER_CANVAS_H;
      if (w < 32) return;

      var light = isLightTheme();
      var accent01 = resolveThemeAccent01();
      var cardBg01 = resolveSliderCardBg01(cardEl);
      var trackOff = light ? LIGHT_TRACK_OFF : DARK_TRACK_OFF;
      var styleKey = w + 'x' + h + ':' + (light ? 'L' : 'D') + ':' + accent01.map(function (c) { return c.toFixed(3); }).join(',') + ':' + cardBg01.map(function (c) { return c.toFixed(3); }).join(',');

      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';

      if (w !== lastW || h !== lastH) {
        lastW = w;
        lastH = h;
        renderer.resize(w, h);
      }

      if (typeof renderer.setBackgroundColor === 'function') {
        renderer.setBackgroundColor(cardBg01);
      } else {
        renderer.backgroundColor = cardBg01;
      }

      var frac = readInputFraction();
      var st = renderer.ensureToggleState(groupId, frac, 1.5, 1);
      if (!isDragging && Math.abs(st.targetFraction - frac) > 0.0001) {
        st.fraction = frac;
        st.targetFraction = frac;
      }

      if (!forceRebuild && styleKey === lastStyleKey) {
        renderer.markGroupDirty(groupId);
        renderer.requestRender();
        return;
      }
      lastStyleKey = styleKey;

      var g = getTrackGeometry(w);
      var elements = [];

      // 1. Track (6dp capsule, G2 smooth corners)
      elements.push({
        id: groupId + '-track',
        kind: 'plain-rect',
        rect: { x: g.trackX, y: g.trackY, w: g.trackW, h: SLIDER_TRACK_H },
        cornerRadius: SLIDER_TRACK_H / 2,
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
        plainRect: { color: trackOff.slice() },
        useContinuousSdf: true,
      });

      // 2. Active Fill Line (bottom line under the glass knob — matches theme --accent)
      elements.push({
        id: groupId + '-fill',
        kind: 'plain-rect',
        rect: { x: g.trackX, y: g.trackY, w: Math.max(SLIDER_TRACK_H, frac * g.trackW), h: SLIDER_TRACK_H },
        cornerRadius: SLIDER_TRACK_H / 2,
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
        plainRect: { color: [accent01[0], accent01[1], accent01[2], 1] },
        isSliderFill: {
          groupId: groupId,
          trackX: g.trackX,
          trackW: g.trackW,
          knobW: SLIDER_KNOB_W,
          minW: 0,
        },
      });

      // 3. Liquid Glass Knob (faithful to LiquidSlider.kt / build-slider.ts)
      elements.push({
        id: groupId + '-knob',
        kind: 'glass-shape',
        rect: { x: g.knobBaseX, y: g.knobY, w: SLIDER_KNOB_W, h: SLIDER_KNOB_H },
        cornerRadius: SLIDER_KNOB_H / 2,
        refractionHeight: 10 * DP,
        refractionAmount: -14 * DP,
        depthEffect: false,
        chromaticAberration: true,
        blurRadius: 8 * DP,
        saturation: 1.0,
        brightness: 0,
        contrast: 1,
        tintColor: [0, 0, 0, 0],
        surfaceColor: [0, 0, 0, 0],
        highlight: {
          mode: 1,
          color: [1, 1, 1],
          angle: Math.PI / 4,
          falloff: 1.0,
          alpha: 1.0,
          widthDp: 0.5 / 1.5,
          blurRadiusDp: 0.25 / 1.5,
        },
        outerShadow: {
          radius: 8 * DP,
          alpha: light ? 0.24 : 0.42,
          offsetX: 0,
          offsetY: 1.5 * DP,
          color: [0, 0, 0],
        },
        innerShadow: {
          radius: 4 * DP,
          alpha: 0.3,
          offsetX: 0,
          offsetY: 4 * DP,
        },
        label: '',
        labelColor: [0, 0, 0, 1],
        showChevron: false,
        isInteractive: false,
        scroll: false,
        independentBackdrop: false,
        useContinuousSdf: true,
        isToggleKnob: {
          groupId: groupId,
          dragWidth: g.dragW,
          velocityDivisor: 10,
        },
      });

      renderer.setButtons(elements);
      controller.lastElements = elements;
      controller.lastAccent01 = accent01;
      renderer.markAllDirty();
      renderer.requestRender();
    }

    function emitFractionToInput(frac, fireChange) {
      var nextVal = fractionToRawValue(frac);
      internalWrite = true;
      input.value = String(nextVal);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      if (fireChange) {
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      internalWrite = false;
    }

    function pointerXInCanvas(e) {
      var r = canvas.getBoundingClientRect();
      return e.clientX - r.left;
    }

    function fractionFromPointerX(px) {
      var g = getTrackGeometry(lastW || host.clientWidth);
      var knobStartCenterX = g.trackX + SLIDER_KNOB_W / 4;
      return clamp01((px - knobStartCenterX) / g.dragW);
    }

    host.addEventListener('pointerdown', function (e) {
      if (!renderer) return;
      if (e.button != null && e.button !== 0) return;
      if (input.disabled) return;
      e.preventDefault();
      var g = getTrackGeometry(lastW || host.clientWidth);
      var px = pointerXInCanvas(e);
      var curFrac = renderer.getToggleFraction(groupId);
      var knobCenterX = g.trackX + SLIDER_KNOB_W / 4 + curFrac * g.dragW;
      var hitKnob = Math.abs(px - knobCenterX) <= SLIDER_KNOB_W * 0.65;

      isDragging = true;
      didDrag = false;
      dragStartX = px;
      host.classList.add('is-dragging');

      if (hitKnob) {
        dragStartFraction = renderer.getToggleTarget(groupId);
        renderer.beginToggleDrag(groupId, dragStartFraction);
      } else {
        // Clicked on track: jump knob to pointer X and start continuous drag from there
        dragStartFraction = fractionFromPointerX(px);
        renderer.beginToggleDrag(groupId, dragStartFraction);
        renderer.setSliderDragPosition(groupId, dragStartFraction);
        emitFractionToInput(dragStartFraction, false);
      }
      try {
        host.setPointerCapture(e.pointerId);
      } catch (_) {}
    });

    host.addEventListener('pointermove', function (e) {
      if (!isDragging || !renderer) return;
      if (e.cancelable) e.preventDefault();
      var px = pointerXInCanvas(e);
      if (Math.abs(px - dragStartX) > 2) didDrag = true;
      var g = getTrackGeometry(lastW || host.clientWidth);
      renderer.dragToggle(groupId, dragStartFraction, px, dragStartX, g.dragW);
      var targetF = renderer.getToggleTarget(groupId);
      emitFractionToInput(targetF, false);
    }, { passive: false });

    function finishPointer(e) {
      if (!isDragging || !renderer) return;
      isDragging = false;
      host.classList.remove('is-dragging');
      try {
        if (e && e.pointerId != null) host.releasePointerCapture(e.pointerId);
      } catch (_) {}
      var finalF = renderer.endSliderDrag(groupId);
      emitFractionToInput(finalF, true);
    }

    host.addEventListener('pointerup', finishPointer);
    host.addEventListener('pointercancel', finishPointer);

    // Sync when input.value is updated programmatically or via keyboard
    input.addEventListener('input', function () {
      if (internalWrite || !renderer) return;
      var f = readInputFraction();
      var st = renderer.ensureToggleState(groupId, f, 1.5, 1);
      st.fraction = f;
      st.targetFraction = f;
      renderer.markGroupDirty(groupId);
      renderer.requestRender();
    });

    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(function () {
        buildScene(false);
      }).observe(host);
    }

    var controller = {
      input: input,
      host: host,
      canvas: canvas,
      renderer: renderer,
      groupId: groupId,
      refresh: function (force) {
        if (renderer) {
          var f = readInputFraction();
          var st = renderer.ensureToggleState(groupId, f, 1.5, 1);
          if (!isDragging) {
            st.fraction = f;
            st.targetFraction = f;
          }
        }
        buildScene(Boolean(force));
      },
      setFraction: function (frac, animate) {
        var f = clamp01(frac);
        emitFractionToInput(f, true);
        if (!renderer) return;
        if (animate) {
          renderer.setToggleTarget(groupId, f);
        } else {
          var st = renderer.ensureToggleState(groupId, f, 1.5, 1);
          st.fraction = f;
          st.targetFraction = f;
          renderer.markGroupDirty(groupId);
          renderer.requestRender();
        }
      },
    };

    instances.set(input.id, controller);
    buildScene(true);
    requestAnimationFrame(function () { buildScene(true); });
    return controller;
  }

  function initAllSliders() {
    var ids = ['globalBgOpacity', 'globalBgBlur', 'terminalBgOpacity', 'terminalBgBlur'];
    ids.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) createSliderController(el);
    });
  }

  function isSettingsAppearanceVisible() {
    var settingsView = document.getElementById('view-settings');
    var appearPanel = document.getElementById('settings-appearance');
    return (!settingsView || settingsView.classList.contains('active')) &&
           (!appearPanel || appearPanel.classList.contains('active'));
  }

  function refreshAllSliders(force) {
    initAllSliders();
    if (!force && !isSettingsAppearanceVisible()) return;
    instances.forEach(function (ctrl) {
      ctrl.refresh(Boolean(force));
    });
  }

  var sliderRafPending = false;
  function scheduleRefreshAllSliders(force) {
    if (sliderRafPending) return;
    sliderRafPending = true;
    requestAnimationFrame(function () {
      sliderRafPending = false;
      if (isSettingsAppearanceVisible()) {
        refreshAllSliders(Boolean(force));
      }
    });
  }

  // Watch for theme or color-scheme changes on <html> so bottom fill line & track update immediately without firing on every --theme-clip-r style mutation
  if (typeof MutationObserver !== 'undefined') {
    var rootObserver = new MutationObserver(function () {
      if (window.__zephyrThemeTransitioning) return;
      scheduleRefreshAllSliders(false);
    });
    rootObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-color-scheme'],
    });
    var appearPanel = document.getElementById('settings-appearance');
    if (appearPanel) {
      new MutationObserver(function () {
        if (appearPanel.classList.contains('active')) {
          scheduleRefreshAllSliders(true);
        }
      }).observe(appearPanel, { attributes: true, attributeFilter: ['class'] });
    }
  }

  window.addEventListener('resize', function () {
    refreshAllSliders(false);
  });

  window.ZephyrLiquidGlassSliders = {
    initAll: initAllSliders,
    refreshAll: refreshAllSliders,
    get: function (id) { return instances.get(id) || null; },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAllSliders);
  } else {
    initAllSliders();
  }
})();
