/**
 * zephyr-anim-ui.js  v2
 * =====================
 * Connects ZephyrAnimEngine to EVERY animated component in Zephyr SSH.
 *
 * Strategy
 * --------
 * We cannot monkey-patch app.js module-scope functions directly.
 * Instead we use MutationObserver + pointer-event delegation to intercept
 * animations at the DOM boundary:
 *   - Class additions (.closing / .minimizing / .island-pressing / .open …)
 *     are caught and replaced with spring-driven CSS custom properties.
 *   - Pointer events drive magnification / drag springs in real time.
 *   - Per-element springs use the dynamic pool (IDs 64-255).
 *
 * Named spring IDs (0-63, fixed):
 *   0  ISLAND_SX       terminal-grip / AI floating btn scale-x
 *   1  ISLAND_SY       scale-y
 *   2  ISLAND_BLUR     blur
 *   3  MORPH_TY        AI panel translateY
 *   4  MORPH_SCALE     AI panel scale
 *   5  MORPH_OPACITY   AI panel opacity
 *   6  SHELF_TY        smartbar shelf translateY (relative offset)
 *   7  SHELF_OPACITY   smartbar panel opacity
 *   8  MENU_SCALE      AI layout menu scale
 *   9  MENU_OPACITY    AI layout menu opacity
 *  10-19  DOCK_BASE+i  smartbar tab scale (up to 10 tabs)
 *  20  CARD_SCALE      connection card press
 *  21  MODAL_TY        connection modal hero (Y only; X/W/H via springEl pool)
 *  30  WIN_SCALE       terminal window close/minimize scale
 *  31  WIN_TY          terminal window close/minimize translateY
 *  32  WIN_OPACITY     terminal window opacity
 *  40  DRAG_TY         drag handle
 *  50  BTN_SCALE       generic button delegated scale
 *
 * CSS custom properties driven:
 *   --za-island-sx/sy/blur
 *   --za-morph-ty/scale/opacity
 *   --za-shelf-ty/opacity (new, read by zephyr-anim.css)
 *   --za-menu-scale/opacity
 *   --za-dock-scale  (per element via springEl)
 *   --za-dock-lift/shift  (per element via springEl)
 *   --za-card-scale
 *   --za-win-scale/ty/opacity  (per window via springEl)
 *   --za-drag-ty
 *   --za-btn-scale
 *   --za-hero-*  (per modal-layer rect via springEl)
 */

import { animEngine } from './zephyr-anim.js';

const S = {
  ISLAND_SX: 0, ISLAND_SY: 1, ISLAND_BLUR: 2,
  MORPH_TY: 3, MORPH_SCALE: 4, MORPH_OPACITY: 5,
  SHELF_TY: 6, SHELF_OPACITY: 7,
  MENU_SCALE: 8, MENU_OPACITY: 9,
  DOCK_BASE: 10,
  CARD_SCALE: 20,
  MODAL_TY: 21,
  WIN_SCALE: 30, WIN_TY: 31, WIN_OPACITY: 32,
  DRAG_TY: 40,
  BTN_SCALE: 50,
};

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// ─────────────────────────────────────────────────────────────────────────────
class AnimUI {

  async init() {
    await animEngine.init(256);
    this._configureSprings();
    this._hookIsland();
    this._hookMorphPanel();
    this._hookShelf();
    this._hookDock();
    this._hookConnectionCards();
    this._hookConnectionModal();
    this._hookTerminalWindows();
    this._hookDragHandle();
    this._hookButtons();
    this._hookClassWatcher();
    return this;
  }

  // ── Spring parameters ──────────────────────────────────────────────────────
  _configureSprings() {
    animEngine.configure(S.ISLAND_SX,   'island');
    animEngine.configure(S.ISLAND_SY,   'island');
    animEngine.configure(S.ISLAND_BLUR, 'snappy');
    animEngine.configure(S.MORPH_TY,    'sheet');
    animEngine.configure(S.MORPH_SCALE, 'snappy');
    animEngine.configure(S.MORPH_OPACITY,'stiff');
    animEngine.configure(S.SHELF_TY,    'sheet');
    animEngine.configure(S.SHELF_OPACITY,'stiff');
    animEngine.configure(S.MENU_SCALE,  'island');
    animEngine.configure(S.MENU_OPACITY,'stiff');
    for (let i = 0; i < 10; i++) animEngine.configure(S.DOCK_BASE + i, 'dock');
    animEngine.configure(S.CARD_SCALE,  'snappy');
    animEngine.configure(S.MODAL_TY,    'hero');
    animEngine.configure(S.WIN_SCALE,   'window_close');
    animEngine.configure(S.WIN_TY,      'window_close');
    animEngine.configure(S.WIN_OPACITY, 'stiff');
    animEngine.configure(S.DRAG_TY,     'flick');
    animEngine.configure(S.BTN_SCALE,   'bouncy');

    // Pointer tracker 0 = global pointer, 1 = drag handle, 2 = dock magnify
    animEngine.trackerInit(0);
    animEngine.trackerInit(1);
    animEngine.trackerInit(2);
    document.addEventListener('pointermove', e => {
      animEngine.trackerPush(0, e.timeStamp, e.clientX, e.clientY);
    }, { passive: true });
  }

  // ── Dynamic Island / terminal-grip / AI floating btn ──────────────────────
  _hookIsland() {
    const hookEl = (el) => {
      if (!el || el.__zaIslandHooked) return;
      el.__zaIslandHooked = true;

      animEngine.setValue(S.ISLAND_SX, 1.0);
      animEngine.setValue(S.ISLAND_SY, 1.0);
      animEngine.setValue(S.ISLAND_BLUR, 0.0);
      animEngine.bind(S.ISLAND_SX,   el, '--za-island-sx');
      animEngine.bind(S.ISLAND_SY,   el, '--za-island-sy');
      animEngine.bind(S.ISLAND_BLUR, el, '--za-island-blur', 'px');

      el.addEventListener('mouseenter', () => {
        animEngine.animateTo(S.ISLAND_SX, 1.06);
        animEngine.animateTo(S.ISLAND_SY, 1.06);
      });
      el.addEventListener('mouseleave', () => {
        if (!el.classList.contains('island-pressing')) {
          animEngine.animateTo(S.ISLAND_SX, 1.0);
          animEngine.animateTo(S.ISLAND_SY, 1.0);
        }
      });
      el.addEventListener('pointerdown', () => {
        // Squish: wide in X, squeeze in Y — exactly like Dynamic Island
        animEngine.configure(S.ISLAND_SX, 'island');
        animEngine.configure(S.ISLAND_SY, 'island');
        animEngine.animateTo(S.ISLAND_SX, 1.12);
        animEngine.animateTo(S.ISLAND_SY, 0.84);
        animEngine.animateTo(S.ISLAND_BLUR, 1.8);
      }, { passive: true });
      const release = () => {
        animEngine.animateTo(S.ISLAND_SX, 1.0);
        animEngine.animateTo(S.ISLAND_SY, 1.0);
        animEngine.animateTo(S.ISLAND_BLUR, 0.0);
      };
      el.addEventListener('pointerup',     release, { passive: true });
      el.addEventListener('pointercancel', release, { passive: true });
    };

    // Hook existing floating btn
    hookEl(document.getElementById('aiFloatingBtn'));
    hookEl(document.querySelector('.ai-floating-btn'));

    // Hook terminal-grip elements as they're created
    new MutationObserver(() => {
      document.querySelectorAll('.terminal-grip:not([data-za-island])').forEach(el => {
        el.dataset.zaIsland = '1';
        // terminal-grip uses per-element springs (each has its own slot)
        animEngine.springEl(el, '--za-island-sx', 1.0, 'island');
        animEngine.springEl(el, '--za-island-sy', 1.0, 'island');
        animEngine.springEl(el, '--za-island-blur', 0.0, 'snappy', 'px');

        el.addEventListener('pointerdown', () => {
          animEngine.springEl(el, '--za-island-sx', 1.14, 'island');
          animEngine.springEl(el, '--za-island-sy', 0.82, 'island');
          animEngine.springEl(el, '--za-island-blur', 2.0, 'snappy', 'px');
        }, { passive: true });
        const rel = () => {
          animEngine.springEl(el, '--za-island-sx', 1.0, 'island');
          animEngine.springEl(el, '--za-island-sy', 1.0, 'island');
          animEngine.springEl(el, '--za-island-blur', 0.0, 'snappy', 'px');
        };
        el.addEventListener('pointerup',     rel, { passive: true });
        el.addEventListener('pointercancel', rel, { passive: true });
        el.addEventListener('mouseenter', () => {
          animEngine.springEl(el, '--za-island-sx', 1.05, 'island');
          animEngine.springEl(el, '--za-island-sy', 1.05, 'island');
        });
        el.addEventListener('mouseleave', () => {
          animEngine.springEl(el, '--za-island-sx', 1.0, 'island');
          animEngine.springEl(el, '--za-island-sy', 1.0, 'island');
        });
      });
    }).observe(document.body, { childList: true, subtree: true });
  }

  // ── AI morph panel ─────────────────────────────────────────────────────────
  _hookMorphPanel() {
    const panel = document.getElementById('aiPanel')
               ?? document.querySelector('.ai-panel, [data-ai-panel]');
    if (!panel) return;

    animEngine.setValue(S.MORPH_TY,      44.0);
    animEngine.setValue(S.MORPH_SCALE,   0.94);
    animEngine.setValue(S.MORPH_OPACITY, 0.0);
    animEngine.bind(S.MORPH_TY,      panel, '--za-morph-ty',      'px');
    animEngine.bind(S.MORPH_SCALE,   panel, '--za-morph-scale');
    animEngine.bind(S.MORPH_OPACITY, panel, '--za-morph-opacity');

    const setOpen = open => {
      if (open) {
        animEngine.animateTo(S.MORPH_TY,      0.0);
        animEngine.animateTo(S.MORPH_SCALE,   1.0);
        animEngine.animateTo(S.MORPH_OPACITY, 1.0);
      } else {
        animEngine.animateTo(S.MORPH_TY,      44.0);
        animEngine.animateTo(S.MORPH_SCALE,   0.94);
        animEngine.animateTo(S.MORPH_OPACITY, 0.0);
      }
    };

    this.openMorphPanel  = () => setOpen(true);
    this.closeMorphPanel = () => setOpen(false);

    new MutationObserver(() => {
      const open = panel.classList.contains('active') ||
                   panel.classList.contains('open')   ||
                   panel.dataset.panelState === 'open';
      setOpen(open);
    }).observe(panel, { attributes: true, attributeFilter: ['class', 'data-panel-state'] });
  }

  // ── Smartbar shelf open/close ──────────────────────────────────────────────
  _hookShelf() {
    const smartbar = document.getElementById('sessionTabs')
                  ?? document.querySelector('.terminal-smartbar');
    if (!smartbar) return;

    animEngine.setValue(S.SHELF_TY, 0.0);
    animEngine.setValue(S.SHELF_OPACITY, 1.0);

    const panel = () => smartbar.querySelector('.smartbar-panel');

    const syncShelf = () => {
      const isOpen    = smartbar.classList.contains('open');
      const isClosing = smartbar.classList.contains('closing');
      const p = panel();
      if (p) {
        animEngine.unbind(S.SHELF_OPACITY);
        animEngine.bind(S.SHELF_OPACITY, p, '--za-shelf-opacity');
        if (isClosing) {
          animEngine.animateTo(S.SHELF_OPACITY, 0.0);
        } else if (isOpen) {
          animEngine.animateTo(S.SHELF_OPACITY, 1.0);
        }
      }
    };

    new MutationObserver(syncShelf)
      .observe(smartbar, { attributes: true, attributeFilter: ['class'] });

    this.openShelf  = syncShelf;
    this.closeShelf = syncShelf;
  }

  // ── Dock / smartbar tab items ──────────────────────────────────────────────
  _hookDock() {
    const smartbar = document.getElementById('sessionTabs')
                  ?? document.querySelector('.terminal-smartbar');
    if (!smartbar) return;

    // Magnification spring — follows pointer in real time
    const updateMagnify = clientX => {
      const dock = smartbar.querySelector('.smartbar-dock');
      if (!dock) return;
      const items = dock.querySelectorAll('.smartbar-session, .smartbar-add');
      const vertical = document.body.classList.contains('terminal-custom-fullscreen-open');
      const influence = vertical ? 118 : 142;

      items.forEach(item => {
        const rect   = item.getBoundingClientRect();
        const center = vertical
          ? rect.top  + rect.height / 2
          : rect.left + rect.width  / 2;
        const d       = Math.abs(clientX - center);
        const t       = Math.max(0, 1 - d / influence);
        const eased   = 1 - Math.pow(1 - t, 3);
        const dir     = Math.sign(center - clientX);
        const scale   = 1 + eased * 0.26;
        const lift    = -eased * (vertical ? 6 : 15);
        const shift   = dir * eased * (vertical ? 9 : 8);

        // Per-element spring — very stiff for real-time magnify follow
        animEngine.springEl(item, '--dock-scale', scale,    'magnify');
        animEngine.springEl(item, '--dock-lift',  lift,     'magnify', 'px');
        animEngine.springEl(item, '--dock-shift', shift,    'magnify', 'px');
      });
    };

    const resetMagnify = () => {
      const dock = smartbar.querySelector('.smartbar-dock');
      if (!dock) return;
      dock.querySelectorAll('.smartbar-session, .smartbar-add').forEach(item => {
        animEngine.springEl(item, '--dock-scale', 1.0,  'snappy');
        animEngine.springEl(item, '--dock-lift',  0.0,  'snappy', 'px');
        animEngine.springEl(item, '--dock-shift', 0.0,  'snappy', 'px');
      });
    };

    smartbar.addEventListener('pointermove', e => updateMagnify(e.clientX), { passive: true });
    smartbar.addEventListener('pointerleave', resetMagnify, { passive: true });

    // Press bounce
    const attachTab = (item, idx) => {
      if (idx >= 10 || item.__zaHooked) return;
      item.__zaHooked = true;
      const sid = S.DOCK_BASE + idx;

      animEngine.setValue(sid, 1.0);
      animEngine.bind(sid, item, '--za-dock-scale');

      item.addEventListener('pointerdown', () => {
        animEngine.configure(sid, 'snappy');
        animEngine.animateTo(sid, 0.86);
      }, { passive: true });
      const up = () => {
        animEngine.configure(sid, 'bouncy');
        animEngine.animateTo(sid, 1.0);
        setTimeout(() => animEngine.configure(sid, 'dock'), 700);
      };
      item.addEventListener('pointerup',    up, { passive: true });
      item.addEventListener('pointercancel',up, { passive: true });
    };

    const scanTabs = () => {
      smartbar.querySelectorAll('.terminal-tab, [data-dock-item], .session-tab')
        .forEach((el, i) => attachTab(el, i));
    };

    // ── Dock bloom: spring-driven open animation per item ──────────────────
    // When smartbar gains class "open", bloom each item in with a spring
    // instead of the CSS @keyframes dockItemBloom.
    const bloomItems = () => {
      const dock = smartbar.querySelector('.smartbar-dock');
      if (!dock) return;
      const items = dock.querySelectorAll('.smartbar-session, .smartbar-add');
      items.forEach((item, idx) => {
        // Teleport to closed state
        animEngine.setEl(item, '--za-bloom-ty',      18.0, 'px');
        animEngine.setEl(item, '--za-bloom-scale',   0.78);
        animEngine.setEl(item, '--za-bloom-opacity', 0.0);
        item.classList.add('za-blooming');
        // Stagger: each item delays by 56ms, matching original dockItemBloom
        const delay = 160 + idx * 56;
        setTimeout(() => {
          // Spring to rest state with bouncy overshoot — same feel as Apple Dock
          animEngine.springEl(item, '--za-bloom-ty',      0.0, 'bouncy', 'px');
          animEngine.springEl(item, '--za-bloom-scale',   1.0, 'bouncy');
          animEngine.springEl(item, '--za-bloom-opacity', 1.0, 'stiff');
        }, delay);
        // Clean up bloom state after animation settles (~900ms total)
        setTimeout(() => {
          item.classList.remove('za-blooming');
          animEngine.releaseEl(item, '--za-bloom-ty');
          animEngine.releaseEl(item, '--za-bloom-scale');
          animEngine.releaseEl(item, '--za-bloom-opacity');
        }, delay + 900);
      });
    };

    let _wasOpen = smartbar.classList.contains('open');
    new MutationObserver(() => {
      const isOpen = smartbar.classList.contains('open');
      if (isOpen && !_wasOpen) bloomItems();
      _wasOpen = isOpen;
    }).observe(smartbar, { attributes: true, attributeFilter: ['class'] });

    scanTabs();
    new MutationObserver(scanTabs).observe(smartbar, { childList: true, subtree: true });
  }

  // ── Connection card press ──────────────────────────────────────────────────
  _hookConnectionCards() {
    const grid = document.getElementById('connectionGrid')
              ?? document.querySelector('.connection-grid');
    if (!grid) return;

    animEngine.setValue(S.CARD_SCALE, 1.0);
    let pressedCard = null;

    grid.addEventListener('pointerdown', e => {
      const card = e.target.closest('.connection-card, [data-edit], #addConnectionBtn, .add-btn');
      if (!card) return;
      pressedCard = card;
      animEngine.unbind(S.CARD_SCALE);
      animEngine.bind(S.CARD_SCALE, card, '--za-card-scale');
      const vy = animEngine.trackerVY(0);
      animEngine.configure(S.CARD_SCALE, 'snappy');
      animEngine.flickTo(S.CARD_SCALE, 0.962, vy * 0.001);
    }, { passive: true });

    const release = () => {
      if (!pressedCard) return;
      animEngine.configure(S.CARD_SCALE, 'bouncy');
      animEngine.animateTo(S.CARD_SCALE, 1.0);
      setTimeout(() => { animEngine.configure(S.CARD_SCALE, 'snappy'); pressedCard = null; }, 600);
    };

    grid.addEventListener('pointerup',     release, { passive: true });
    grid.addEventListener('pointercancel', release, { passive: true });
  }

  // ── Connection modal hero transition ──────────────────────────────────────
  // app.js drives this via CSS transition on top/left/width/height.
  // We intercept by observing the layer element and driving the same
  // geometry via springEl() — which overrides CSS vars the new stylesheet
  // reads. The CSS transition on the layer is suppressed in zephyr-anim.css.
  _hookConnectionModal() {
    this.openModal = (el) => {
      if (!el) return;
      // Teleport to starting state (will be set by caller before calling)
      animEngine.springElProps(el, {
        '--za-modal-ty':      { target: 0.0, unit: 'px' },
        '--za-modal-scale':   { target: 1.0 },
        '--za-modal-opacity': { target: 1.0 },
      }, 'sheet');
    };

    this.closeModal = (el, onDone) => {
      if (!el) { onDone?.(); return; }
      animEngine.springEl(el, '--za-modal-ty',      60.0, 'sheet',  'px');
      animEngine.springEl(el, '--za-modal-scale',   0.95, 'snappy');
      animEngine.springEl(el, '--za-modal-opacity', 0.0,  'stiff');
      setTimeout(() => onDone?.(), 440);
    };

    // MutationObserver for auto-opened modals
    new MutationObserver(muts => {
      for (const m of muts) {
        for (const node of m.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (node.matches('.connection-modal, .info-modal, .fm-editor-modal, [data-spring-modal]')) {
            animEngine.setEl(node, '--za-modal-ty',      60.0, 'px');
            animEngine.setEl(node, '--za-modal-scale',   0.95);
            animEngine.setEl(node, '--za-modal-opacity', 0.0);
            requestAnimationFrame(() => {
              animEngine.springEl(node, '--za-modal-ty',      0.0, 'sheet', 'px');
              animEngine.springEl(node, '--za-modal-scale',   1.0, 'snappy');
              animEngine.springEl(node, '--za-modal-opacity', 1.0, 'stiff');
            });
          }
        }
      }
    }).observe(document.body, { childList: true });
  }

  // ── Terminal windows: open, close, minimize ────────────────────────────────
  _hookTerminalWindows() {
    const workspace = document.getElementById('terminalWorkspace');
    if (!workspace) return;

    const hookWin = (win) => {
      if (win.__zaWinHooked) return;
      win.__zaWinHooked = true;

      // Initial state: animate in (replaces CSS @keyframes terminalWindowIn)
      animEngine.setEl(win, '--za-win-ty',      18.0, 'px');
      animEngine.setEl(win, '--za-win-scale',   0.965);
      animEngine.setEl(win, '--za-win-opacity', 0.0);
      requestAnimationFrame(() => {
        animEngine.springEl(win, '--za-win-ty',      0.0, 'window_open', 'px');
        animEngine.springEl(win, '--za-win-scale',   1.0, 'window_open');
        animEngine.springEl(win, '--za-win-opacity', 1.0, 'stiff');
      });
    };

    const watchClass = (win) => {
      if (win.__zaClassWatcherAttached) return;
      win.__zaClassWatcherAttached = true;

      new MutationObserver(() => {
        const closing    = win.classList.contains('closing');
        const minimizing = win.classList.contains('minimizing');

        if (closing) {
          animEngine.configure(S.WIN_SCALE,   'window_close');
          animEngine.configure(S.WIN_TY,      'window_close');
          animEngine.configure(S.WIN_OPACITY, 'stiff');
          animEngine.unbind(S.WIN_SCALE);
          animEngine.unbind(S.WIN_TY);
          animEngine.unbind(S.WIN_OPACITY);
          animEngine.bind(S.WIN_SCALE,   win, '--za-win-scale');
          animEngine.bind(S.WIN_TY,      win, '--za-win-ty', 'px');
          animEngine.bind(S.WIN_OPACITY, win, '--za-win-opacity');
          animEngine.animateTo(S.WIN_SCALE,   0.82);
          animEngine.animateTo(S.WIN_TY,      -12.0);
          animEngine.animateTo(S.WIN_OPACITY, 0.0);
        } else if (minimizing) {
          animEngine.configure(S.WIN_SCALE,   'window_close');
          animEngine.configure(S.WIN_TY,      'window_close');
          animEngine.configure(S.WIN_OPACITY, 'stiff');
          animEngine.unbind(S.WIN_SCALE);
          animEngine.unbind(S.WIN_TY);
          animEngine.unbind(S.WIN_OPACITY);
          animEngine.bind(S.WIN_SCALE,   win, '--za-win-scale');
          animEngine.bind(S.WIN_TY,      win, '--za-win-ty', 'px');
          animEngine.bind(S.WIN_OPACITY, win, '--za-win-opacity');
          animEngine.animateTo(S.WIN_SCALE,   0.72);
          animEngine.animateTo(S.WIN_TY,      -34.0);
          animEngine.animateTo(S.WIN_OPACITY, 0.0);
        } else if (!closing && !minimizing) {
          // Restored: spring back in
          animEngine.springEl(win, '--za-win-ty',      0.0, 'window_open', 'px');
          animEngine.springEl(win, '--za-win-scale',   1.0, 'window_open');
          animEngine.springEl(win, '--za-win-opacity', 1.0, 'stiff');
        }
      }).observe(win, { attributes: true, attributeFilter: ['class'] });
    };

    // Watch for new windows
    new MutationObserver(muts => {
      for (const m of muts) {
        for (const node of m.addedNodes) {
          if (node instanceof Element && node.matches('.terminal-window')) {
            hookWin(node);
            watchClass(node);
          }
        }
      }
      // Also watch removed (release springs)
      for (const m of muts) {
        for (const node of m.removedNodes) {
          if (node instanceof Element && node.matches?.('.terminal-window')) {
            animEngine.releaseAllEl(node);
          }
        }
      }
    }).observe(workspace, { childList: true });

    // Existing windows
    workspace.querySelectorAll('.terminal-window').forEach(w => {
      hookWin(w);
      watchClass(w);
    });
  }

  // ── Drag handle ────────────────────────────────────────────────────────────
  _hookDragHandle() {
    const handle = document.querySelector('.mobile-fullscreen-dock-toggle, [data-smartbar-toggle]');
    if (!handle) return;

    animEngine.setValue(S.DRAG_TY, 0.0);
    animEngine.bind(S.DRAG_TY, handle, '--za-drag-ty', 'px');
    animEngine.trackerInit(1);

    let startY = 0;
    handle.addEventListener('pointerdown', e => {
      startY = e.clientY;
      animEngine.trackerClear(1);
      animEngine.trackerPush(1, e.timeStamp, 0, e.clientY);
      try { handle.setPointerCapture(e.pointerId); } catch {}
    }, { passive: true });

    handle.addEventListener('pointermove', e => {
      animEngine.trackerPush(1, e.timeStamp, 0, e.clientY);
      animEngine.setValue(S.DRAG_TY, clamp(e.clientY - startY, -60, 60));
    }, { passive: true });

    const end = () => {
      const vy = animEngine.trackerVY(1);
      animEngine.flickTo(S.DRAG_TY, 0.0, vy);
      animEngine.trackerClear(1);
    };
    handle.addEventListener('pointerup',     end, { passive: true });
    handle.addEventListener('pointercancel', end, { passive: true });
  }

  // ── Generic button micro-interactions ─────────────────────────────────────
  _hookButtons() {
    animEngine.setValue(S.BTN_SCALE, 1.0);
    let pressedBtn = null;

    document.addEventListener('pointerdown', e => {
      const btn = e.target.closest(
        '.btn, .btn-sm, .tool-btn, .icon-btn, .nav-tab, .settings-tab, [data-spring-btn]'
      );
      if (!btn) return;
      pressedBtn = btn;
      animEngine.unbind(S.BTN_SCALE);
      animEngine.bind(S.BTN_SCALE, btn, '--za-btn-scale');
      animEngine.configure(S.BTN_SCALE, 'snappy');
      animEngine.animateTo(S.BTN_SCALE, 0.952);
    }, { passive: true });

    document.addEventListener('pointerup', () => {
      if (!pressedBtn) return;
      animEngine.configure(S.BTN_SCALE, 'bouncy');
      animEngine.animateTo(S.BTN_SCALE, 1.0);
      setTimeout(() => { animEngine.configure(S.BTN_SCALE, 'snappy'); pressedBtn = null; }, 600);
    }, { passive: true });

    document.addEventListener('pointercancel', () => {
      if (!pressedBtn) return;
      animEngine.configure(S.BTN_SCALE, 'snappy');
      animEngine.animateTo(S.BTN_SCALE, 1.0);
      pressedBtn = null;
    }, { passive: true });
  }

  // ── Class watcher: intercept app.js CSS-class-driven animations ───────────
  // Watches class additions across the body and replaces CSS keyframes with
  // spring equivalents wherever we can intercept safely.
  _hookClassWatcher() {
    // island-pressing on terminal-grip is handled by _hookIsland per-element above.
    // AI layout menu open/close
    new MutationObserver(muts => {
      for (const m of muts) {
        if (!(m.target instanceof Element)) continue;
        const el = m.target;

        // AI layout menu: island-open / island-closing
        if (el.matches?.('.panel-layout-menu')) {
          const isOpen = el.classList.contains('island-open');
          if (isOpen && !el.__zaMenuOpenState) {
            el.__zaMenuOpenState = true;
            animEngine.springEl(el, '--za-menu-scale',   1.0, 'island');
            animEngine.springEl(el, '--za-menu-opacity', 1.0, 'stiff');
          } else if (!isOpen && el.__zaMenuOpenState) {
            el.__zaMenuOpenState = false;
            animEngine.springEl(el, '--za-menu-scale',   0.85, 'snappy');
            animEngine.springEl(el, '--za-menu-opacity', 0.0,  'stiff');
          }
        }

        // Terminal window dock-launching
        if (el.matches?.('.terminal-window') && el.classList.contains('dock-launching')) {
          // The window spring-open already started via _hookTerminalWindows;
          // here we just reset to starting state so the spring does the work
          animEngine.setEl(el, '--za-win-ty',      24.0, 'px');
          animEngine.setEl(el, '--za-win-scale',   0.88);
          animEngine.setEl(el, '--za-win-opacity', 0.0);
          requestAnimationFrame(() => {
            animEngine.springEl(el, '--za-win-ty',      0.0, 'window_open', 'px');
            animEngine.springEl(el, '--za-win-scale',   1.0, 'window_open');
            animEngine.springEl(el, '--za-win-opacity', 1.0, 'stiff');
          });
        }
      }
    }).observe(document.body, { attributes: true, attributeFilter: ['class'], subtree: true });
  }
}

export const ZephyrAnimUI = new AnimUI();
