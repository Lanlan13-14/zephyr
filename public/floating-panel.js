/**
 * Shared floating-panel interaction for SSH terminal and RDP page.
 * Coordinates are parent-relative (same model as public/terminal.js).
 */

const panelState = new WeakMap();
let floatingPanelZIndexSeed = 10080;
let panelLayoutMenu = null;
let panelLayoutButton = null;
let suppressNextLayoutClick = false;

/** Shared ⋯ drag→click suppression (AI panel parity). */
export function markLayoutClickSuppressed(value = true) {
    suppressNextLayoutClick = !!value;
}
export function consumeLayoutClickSuppression() {
    if (!suppressNextLayoutClick) return false;
    suppressNextLayoutClick = false;
    return true;
}
export function isLayoutClickSuppressed() {
    return suppressNextLayoutClick;
}

import { t } from './i18n/runtime.js?v=20260728-ai-handle-only-drag1';

export function detectInteractionEnvironment() {
    const ua = String(navigator.userAgent || '').toLowerCase();
    const mobileUA = /android|iphone|ipod|blackberry|iemobile|opera mini/i.test(ua);
    const iPadOS = navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1;
    const width = window.innerWidth || document.documentElement.clientWidth || 0;
    const height = window.innerHeight || document.documentElement.clientHeight || 0;
    const smallScreen = Math.min(width, height) <= 820;
    const touch = 'ontouchstart' in window || (navigator.maxTouchPoints || 0) > 0;
    const coarse = window.matchMedia?.('(pointer: coarse)')?.matches || false;
    const hover = window.matchMedia?.('(hover: hover)')?.matches || false;
    const platform = String(navigator.platform || '').toLowerCase();
    const desktopPlatform = /win|mac|linux/.test(platform);
    let mobileScore = 0;
    if (mobileUA) mobileScore += 3;
    if (iPadOS) mobileScore += 3;
    if (smallScreen) mobileScore += 2;
    if (touch) mobileScore += 1;
    if (coarse) mobileScore += 2;
    if (!hover) mobileScore += 1;
    let desktopScore = 0;
    if (desktopPlatform) desktopScore += 2;
    if (hover) desktopScore += 2;
    if (!coarse) desktopScore += 1;
    if (!smallScreen) desktopScore += 2;
    let type = mobileScore >= desktopScore ? 'mobile' : 'desktop';
    let category = type === 'mobile' ? (width >= 768 ? 'tablet' : 'phone') : 'desktop';
    if (category === 'tablet') type = 'desktop';
    return { type, category, width, height, touch, coarse, hover, platform, ua, mobileScore, desktopScore };
}

export function isPhoneLikeEnvironment() {
    const env = detectInteractionEnvironment();
    const explicitPhoneUA = /android.*mobile|iphone|ipod|blackberry|iemobile|opera mini/i.test(env.ua);
    const desktopClassInput = env.hover && !env.coarse;
    if (desktopClassInput) return false;
    return explicitPhoneUA && env.coarse && Math.min(env.width, env.height) <= 700;
}

export function isCompactScreen() {
    return isPhoneLikeEnvironment();
}

export function allocateFloatingPanelZIndex(panel, selector = '.floating-panel, .rdp-floating-panel, .file-manager, .info-modal, .docker-panel, .snippet-panel, .shortcut-panel') {
    const currentZIndex = Number(panel?.style?.zIndex || 0) || 0;
    let maxZIndex = Math.max(floatingPanelZIndexSeed, currentZIndex);
    document.querySelectorAll(selector).forEach((item) => {
        maxZIndex = Math.max(maxZIndex, Number(item.style.zIndex || 0) || 0);
    });
    floatingPanelZIndexSeed = maxZIndex + 1;
    return floatingPanelZIndexSeed;
}

export function ensureFloatingPanel(panel, defaults = {}) {
    if (!panel || panelState.has(panel)) return;
    const parentRect = panel.parentElement?.getBoundingClientRect?.() || { width: window.innerWidth, height: window.innerHeight };
    const width = defaults.width || Math.min(parentRect.width * 0.72, 760);
    const height = defaults.height || Math.min(parentRect.height * 0.72, 560);
    const left = defaults.left ?? Math.max(12, (parentRect.width - width) / 2);
    const top = defaults.top ?? 52;
    Object.assign(panel.style, {
        left: `${left}px`,
        top: `${top}px`,
        right: 'auto',
        bottom: 'auto',
        width: `${width}px`,
        height: `${height}px`,
    });
    panelState.set(panel, { left, top, width, height });
}

export function getDefaultPanelOptions(panel, kind = '') {
    const parentRect = panel?.parentElement?.getBoundingClientRect?.() || { width: window.innerWidth, height: window.innerHeight };
    if (isCompactScreen()) {
        return {
            left: 8,
            top: 44,
            width: Math.max(280, parentRect.width - 16),
            height: Math.max(300, parentRect.height - 58),
        };
    }
    if (kind === 'files' || panel?.id === 'filesPanel' || panel?.classList?.contains('file-manager')) {
        return { width: Math.min(parentRect.width * 0.72, 820), height: Math.min(parentRect.height * 0.68, 620), left: 16, top: 52 };
    }
    if (kind === 'clipboard' || panel?.id === 'clipboardPanel') {
        return { width: Math.min(420, parentRect.width - 24), height: Math.min(parentRect.height * 0.5, 380), left: 42, top: 64 };
    }
    if (kind === 'shortcuts' || panel?.id === 'shortcutsPanel' || panel?.classList?.contains('shortcut-panel')) {
        return { width: Math.min(420, parentRect.width - 24), height: Math.min(parentRect.height * 0.46, 360), left: 72, top: 74 };
    }
    if (kind === 'joystick' || panel?.id === 'joystickPanel') {
        return { width: Math.min(320, parentRect.width - 24), height: Math.min(parentRect.height * 0.42, 300), left: 90, top: 80 };
    }
    return { width: Math.min(480, parentRect.width - 24), height: Math.min(parentRect.height * 0.72, 620), top: 52, left: 24 };
}

export function clampPanel(panel) {
    if (!panel?.parentElement) return;
    const rect = panel.getBoundingClientRect();
    const parentRect = panel.parentElement.getBoundingClientRect();
    const minVisible = isCompactScreen() ? 140 : 80;
    const left = Math.min(Math.max(rect.left - parentRect.left, -rect.width + minVisible), parentRect.width - minVisible);
    const top = Math.min(Math.max(rect.top - parentRect.top, 8), parentRect.height - minVisible);
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
}

export function bringPanelToFront(panel, selector = '.rdp-floating-panel, .file-manager, .info-modal, .docker-panel, .snippet-panel, .shortcut-panel') {
    if (!panel) return;
    // AI panel parity: fronting only raises z-index. Never run CSS transform
    // animations here — they clobber Motion.drag's transform channel mid-gesture.
    document.querySelectorAll(selector).forEach((p) => {
        if (p !== panel) {
            p.classList.remove('front');
            p.classList.remove('front-switching');
        }
    });
    const nextZ = allocateFloatingPanelZIndex(panel, selector);
    panel.style.zIndex = String(nextZ);
    panel.style.setProperty('--panel-z', String(nextZ));
    panel.classList.add('front');
    panel.classList.remove('front-switching');
    window.clearTimeout(panel._frontSwitchTimer);
}

export function animatePanelFromButton(panel, button, opening = true) {
    if (!panel || !button) return;
    const panelRect = panel.getBoundingClientRect?.();
    const buttonRect = button.getBoundingClientRect?.();
    if (!panelRect || !buttonRect || panelRect.width <= 1 || panelRect.height <= 1) return;
    const originX = ((buttonRect.left + buttonRect.width / 2 - panelRect.left) / panelRect.width) * 100;
    const originY = ((buttonRect.top + buttonRect.height / 2 - panelRect.top) / panelRect.height) * 100;
    panel.style.setProperty('--panel-origin-x', `${Math.max(8, Math.min(92, originX))}%`);
    panel.style.setProperty('--panel-origin-y', `${Math.max(8, Math.min(92, originY))}%`);
    panel.classList.remove('panel-opening', 'panel-closing');
    void panel.offsetWidth;
    panel.classList.add(opening ? 'panel-opening' : 'panel-closing');
    // Critical: floatingPanelOpenFromButton uses animation-fill:both. If
    // .panel-opening sticks after the keyframe ends, the filled transform
    // permanently overrides Motion.drag's inline style → "can't drag".
    window.clearTimeout(panel._panelMotionClearTimer);
    const ms = opening ? 400 : 320;
    panel._panelMotionClearTimer = window.setTimeout(() => {
        if (opening) panel.classList.remove('panel-opening');
        else if (!panel.classList.contains('open')) panel.classList.remove('panel-closing');
    }, ms);
}

export function clearPanelMotion(panel) {
    if (!panel) return;
    window.clearTimeout(panel._panelMotionClearTimer);
    panel.classList.remove('panel-opening', 'panel-closing');
}

export function applyPanelLayout(panel, layout) {
    if (!panel?.parentElement) return;
    const parentRect = panel.parentElement.getBoundingClientRect();
    const margin = isCompactScreen() ? 6 : 12;
    const topbar = isCompactScreen() ? 38 : 52;
    let left = margin;
    let top = topbar;
    let width = parentRect.width - margin * 2;
    let height = parentRect.height - topbar - margin;

    if (layout === 'half') {
        width = parentRect.width;
        height = Math.max(260, parentRect.height / 2);
        left = 0;
        top = parentRect.height - height;
    } else if (layout === 'left-quarter') {
        width = Math.max(260, parentRect.width / 4);
        height = parentRect.height - topbar;
        left = 0;
        top = topbar;
    } else if (layout === 'right-quarter') {
        width = Math.max(260, parentRect.width / 4);
        height = parentRect.height - topbar;
        left = parentRect.width - width;
        top = topbar;
    }

    panel.classList.add('layout-animating');
    window.clearTimeout(panel._layoutAnimationTimer);
    Object.assign(panel.style, {
        left: `${left}px`,
        top: `${top}px`,
        right: 'auto',
        bottom: 'auto',
        width: `${width}px`,
        height: `${height}px`,
    });
    bringPanelToFront(panel);
    panel._layoutAnimationTimer = window.setTimeout(() => {
        panel.classList.remove('layout-animating');
        clampPanel(panel);
    }, 480);
}

function positionPanelLayoutMenu(menu, button, { collapsed = false } = {}) {
    if (!menu || !button) return;
    const rect = button.getBoundingClientRect();
    const viewport = window.visualViewport;
    const vvWidth = viewport?.width || window.innerWidth;
    const anchorX = rect.left + rect.width / 2;
    const finalWidth = Math.min(284, Math.max(160, vvWidth - 16));
    const finalHeight = 50;
    const finalLeft = Math.max(8, Math.min(vvWidth - finalWidth - 8, anchorX - finalWidth / 2));
    const finalTop = rect.top;
    menu.style.left = `${collapsed ? rect.left : finalLeft}px`;
    menu.style.top = `${finalTop}px`;
    menu.style.setProperty('--panel-island-menu-width', `${collapsed ? rect.width : finalWidth}px`);
    menu.style.setProperty('--panel-island-menu-height', `${collapsed ? rect.height : finalHeight}px`);
    menu.style.setProperty('--panel-island-radius', `${Math.round((collapsed ? rect.height : 36) / 2)}px`);
    menu.dataset.placement = 'inline';
}

export function closePanelLayoutMenu({ instant = false } = {}) {
    const menu = panelLayoutMenu;
    const button = panelLayoutButton;
    if (!menu) {
        button?.classList.remove('active-layout');
        panelLayoutButton = null;
        return;
    }
    window.clearTimeout(menu._closeTimer);
    if (instant || !button?.isConnected) {
        button?.classList.remove('active-layout');
        button?.style.removeProperty('opacity');
        menu.remove();
        panelLayoutMenu = null;
        panelLayoutButton = null;
        return;
    }
    menu.style.transition = 'none';
    positionPanelLayoutMenu(menu, button, { collapsed: false });
    menu.style.opacity = '1';
    void menu.offsetWidth;
    menu.classList.remove('island-open');
    menu.classList.add('island-closing', 'island-animating');
    button.classList.remove('active-layout');
    button.style.opacity = '0';
    requestAnimationFrame(() => {
        menu.style.removeProperty('transition');
        positionPanelLayoutMenu(menu, button, { collapsed: true });
    });
    menu._closeTimer = window.setTimeout(() => {
        button.classList.remove('active-layout');
        button.style.opacity = '1';
        requestAnimationFrame(() => button.style.removeProperty('opacity'));
        menu.remove();
        if (panelLayoutMenu === menu) panelLayoutMenu = null;
        if (panelLayoutButton === button) panelLayoutButton = null;
    }, 460);
}

export function openPanelLayoutMenu(button, panel, { onClosePanel } = {}) {
    closePanelLayoutMenu({ instant: true });
    panelLayoutButton = button;
    button?.classList.remove('active-layout');
    const menu = document.createElement('div');
    menu.className = 'panel-layout-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', t('窗口布局'));
    menu.innerHTML = `
        <button data-layout="full" title="${t('全屏')}" aria-label="${t('全屏')}"><span class="panel-layout-icon full"></span></button>
        <button data-layout="half" title="${t('半屏')}" aria-label="${t('半屏')}"><span class="panel-layout-icon half"></span></button>
        <button data-layout="left-quarter" title="${t('左侧四分之一')}" aria-label="${t('左侧四分之一')}"><span class="panel-layout-icon left"></span></button>
        <button data-layout="right-quarter" title="${t('右侧四分之一')}" aria-label="${t('右侧四分之一')}"><span class="panel-layout-icon right"></span></button>
        <button data-layout="close" class="panel-layout-close" title="${t('关闭窗口')}" aria-label="${t('关闭窗口')}"><span class="panel-layout-icon close"></span></button>
    `;
    menu.style.transition = 'none';
    menu.style.zIndex = String(Math.max(10000, allocateFloatingPanelZIndex(panel) + 20));
    document.body.appendChild(menu);
    panelLayoutMenu = menu;
    positionPanelLayoutMenu(menu, button, { collapsed: true });
    button.style.opacity = '0';
    menu.style.opacity = '1';
    menu.classList.add('island-animating');
    void menu.offsetWidth;
    requestAnimationFrame(() => {
        menu.style.removeProperty('transition');
        button?.classList.add('active-layout');
        menu.classList.add('island-open');
        positionPanelLayoutMenu(menu, button, { collapsed: false });
        window.setTimeout(() => {
            menu.classList.remove('island-animating');
            menu.style.removeProperty('opacity');
        }, 540);
    });
    menu.addEventListener('click', (event) => {
        const item = event.target.closest('[data-layout]');
        if (!item) return;
        if (item.dataset.layout === 'close') {
            if (typeof onClosePanel === 'function') onClosePanel(panel);
            else panel.classList.remove('open');
            closePanelLayoutMenu({ instant: true });
            return;
        }
        applyPanelLayout(panel, item.dataset.layout);
        closePanelLayoutMenu();
    });
}

/** Motion loader — same module path/revision as AI panel / terminal toast. */
const floatingPanelMotion = {
    engine: null,
    failed: false,
    _p: null,
    _ensure() {
        if (this.engine) return Promise.resolve(this.engine);
        if (this.failed && !this._p) return Promise.resolve(null);
        if (this._p) return this._p;
        this._p = import('./vendor/zephyr-motion/index.js?v=20260731-motion-tween3')
            .then(async (mod) => {
                const Motion = mod?.Motion || (typeof window !== 'undefined' ? window.Motion : null);
                if (!Motion || typeof Motion.drag !== 'function') throw new Error('Motion.drag unavailable');
                try { await Motion.init({ capacity: 256 }); } catch { /* ignore */ }
                this.engine = Motion;
                this.failed = false;
                return Motion;
            })
            .catch(() => {
                this.failed = true;
                this._p = null;
                return null;
            });
        return this._p;
    },
};

const panelPhysicsState = new WeakMap();

/**
 * Containing-block metrics for an absolute panel.
 * CSS left/top are relative to the parent's PADDING edge. getBoundingClientRect
 * is the border box — subtract border widths when converting visual→layout.
 * Prefer clientWidth/Height for size (padding box).
 */
export function panelParentRect(panel) {
    const parent = panel?.offsetParent || panel?.parentElement;
    if (!parent || parent === document.body || parent === document.documentElement) {
        // Fixed-like / viewport containing block (AI panel path).
        const viewport = window.visualViewport;
        return {
            left: viewport?.offsetLeft || 0,
            top: viewport?.offsetTop || 0,
            width: viewport?.width || window.innerWidth || document.documentElement.clientWidth || 0,
            height: viewport?.height || window.innerHeight || document.documentElement.clientHeight || 0,
            borderLeft: 0,
            borderTop: 0,
            isViewport: true,
        };
    }
    const rect = parent.getBoundingClientRect?.() || { left: 0, top: 0, width: 0, height: 0 };
    const cs = getComputedStyle(parent);
    const borderLeft = parseFloat(cs.borderLeftWidth) || 0;
    const borderTop = parseFloat(cs.borderTopWidth) || 0;
    return {
        left: rect.left,
        top: rect.top,
        width: parent.clientWidth || Math.max(0, rect.width - borderLeft - (parseFloat(cs.borderRightWidth) || 0)),
        height: parent.clientHeight || Math.max(0, rect.height - borderTop - (parseFloat(cs.borderBottomWidth) || 0)),
        borderLeft,
        borderTop,
        isViewport: false,
    };
}

/** Keep only enough chrome on-screen to grab again (traffic light / title). */
export function panelMinVisiblePx(panel) {
    const width = panel?.offsetWidth || panel?.getBoundingClientRect?.().width || 320;
    return Math.min(56, Math.max(44, Math.round(width * 0.12)));
}

function readMotionXY(panel, Motion) {
    let x = 0;
    let y = 0;
    if (Motion && typeof Motion.value === 'function') {
        const mx = Number(Motion.value(panel, 'x'));
        const my = Number(Motion.value(panel, 'y'));
        if (Number.isFinite(mx)) x = mx;
        if (Number.isFinite(my)) y = my;
        return { x, y };
    }
    try {
        const t = getComputedStyle(panel).transform;
        if (t && t !== 'none') {
            const m = new DOMMatrixReadOnly(t);
            x = Number(m.m41) || 0;
            y = Number(m.m42) || 0;
        }
    } catch { /* ignore */ }
    return { x, y };
}

/**
 * Convert the PAINTED box (getBoundingClientRect, includes transform) into
 * CSS left/top for the containing block's padding edge.
 */
export function visualPanelLayoutPosition(panel) {
    if (!panel) return { left: 0, top: 0 };
    const rect = panel.getBoundingClientRect();
    const parent = panelParentRect(panel);
    // padding-edge origin = border-box origin + border widths
    const left = rect.left - parent.left - (parent.borderLeft || 0);
    const top = rect.top - parent.top - (parent.borderTop || 0);
    return { left, top, rect, parent };
}

/**
 * Fold live Motion transform into CSS left/top WITHOUT leaving a frame where
 * both the new left AND the old translate are painted (that double-offset is
 * the "super jump"). Callers that own a Motion instance should prefer
 * finishFloatingPanelPhysicsDrag which detaches writers first.
 *
 * Safe path when Motion is provided:
 *   read visual → stop/release writers → write left/top + clear transform
 * Fallback without Motion:
 *   offsetLeft + parsed matrix (no engine writers to race)
 */
export function bakePanelTransform(panel, Motion = null) {
    if (!panel) return;
    // Capture painted position BEFORE detaching writers.
    const painted = visualPanelLayoutPosition(panel);
    if (Motion) {
        try {
            // Detach first so no rAF rewrites transform after we clear it.
            Motion.stop?.(panel, ['x', 'y']);
            Motion.release?.(panel);
        } catch { /* ignore */ }
    } else {
        // No engine: compose from layout + current matrix.
        const { x, y } = readMotionXY(panel, null);
        painted.left = panel.offsetLeft + x;
        painted.top = panel.offsetTop + y;
    }
    Object.assign(panel.style, {
        left: `${painted.left}px`,
        top: `${painted.top}px`,
        right: 'auto',
        bottom: 'auto',
        transform: 'none',
    });
}

/** Visual left/top limits in containing-block coordinates (same for drag + finish). */
export function floatingPanelVisualLimits(panel) {
    const parent = panelParentRect(panel);
    const width = panel?.offsetWidth || panel?.getBoundingClientRect?.().width || 0;
    const height = panel?.offsetHeight || panel?.getBoundingClientRect?.().height || 0;
    const parentW = parent.width || (window.innerWidth || 0);
    const parentH = parent.height || (window.innerHeight || 0);
    const minVisible = panelMinVisiblePx(panel);
    return {
        minLeft: minVisible - width,
        maxLeft: parentW - minVisible,
        minTop: 0,
        maxTop: Math.max(0, parentH - Math.min(56, height * 0.25)),
        width,
        height,
        parentW,
        parentH,
        minVisible,
    };
}

export function floatingPanelDragBounds(panel) {
    // Deltas relative to current baked left/top (layout, transform-free).
    const left = Number.isFinite(panel?.offsetLeft) ? panel.offsetLeft : (parseFloat(panel?.style?.left) || 0);
    const top = Number.isFinite(panel?.offsetTop) ? panel.offsetTop : (parseFloat(panel?.style?.top) || 0);
    const lim = floatingPanelVisualLimits(panel);
    return {
        minX: lim.minLeft - left,
        maxX: lim.maxLeft - left,
        minY: lim.minTop - top,
        maxY: lim.maxTop - top,
    };
}

function hardClampDragDelta(panel, x, y) {
    const b = floatingPanelDragBounds(panel);
    return {
        x: Math.min(b.maxX ?? Infinity, Math.max(b.minX ?? -Infinity, x)),
        y: Math.min(b.maxY ?? Infinity, Math.max(b.minY ?? -Infinity, y)),
    };
}

/**
 * Soft safety after bake. Same visual limits as drag bounds — never tighter.
 * No-op inside range so we never rewrite left/top for free.
 */
function softClampPanelEdge(panel) {
    if (!panel) return false;
    const lim = floatingPanelVisualLimits(panel);
    const left = Number.isFinite(panel.offsetLeft) ? panel.offsetLeft : (parseFloat(panel.style.left) || 0);
    const top = Number.isFinite(panel.offsetTop) ? panel.offsetTop : (parseFloat(panel.style.top) || 0);
    const nextLeft = Math.min(Math.max(left, lim.minLeft), lim.maxLeft);
    const nextTop = Math.min(Math.max(top, lim.minTop), lim.maxTop);
    if (Math.abs(nextLeft - left) < 0.5 && Math.abs(nextTop - top) < 0.5) return false;
    panel.style.left = `${nextLeft}px`;
    panel.style.top = `${nextTop}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    return true;
}

function finishFloatingPanelPhysicsDrag(panel, Motion, { onFinish } = {}) {
    // CRITICAL ORDER (AI never double-paints because it keeps transition:none and
    // its bake races less; terminal absolute panels were painting left+translate):
    //  1) freeze painted rect while transform still applied
    //  2) detach Motion writers (stop+release) so nothing rewrites transform
    //  3) write left/top = painted layout; transform none
    //  4) softClamp with SAME limits as drag (usually no-op)
    //  5) only then drop .dragging (CSS transitions must not animate the bake)
    panel.classList.add('panel-physics-baking');
    const painted = visualPanelLayoutPosition(panel);
    try {
        Motion?.stop?.(panel, ['x', 'y']);
        Motion?.release?.(panel);
    } catch { /* ignore */ }
    Object.assign(panel.style, {
        left: `${painted.left}px`,
        top: `${painted.top}px`,
        right: 'auto',
        bottom: 'auto',
        transform: 'none',
        willChange: '',
    });
    softClampPanelEdge(panel);
    panel.classList.remove('dragging', 'panel-physics-baking');
    if (typeof onFinish === 'function') {
        try { onFinish(panel); } catch { /* ignore */ }
    }
    window.setTimeout(() => {
        suppressNextLayoutClick = false;
        panel._suppressHeaderClick = false;
    }, 320);
}

/**
 * Precise 1:1 hard drag (no rubberband/inertia) — used by the ⋯ traffic light.
 * Gray strip uses Motion.drag physics instead.
 */
export function startFloatingPanelHardDrag(panel, e, {
    threshold = 4,
    suppressLayoutClick = false,
    onActivate,
    onFinish,
    bringToFront = bringPanelToFront,
} = {}) {
    if (!panel || !e) return;
    if (e.button !== undefined && e.button !== 0) return;
    try { bringToFront?.(panel); } catch { /* ignore */ }
    window.clearTimeout(panel._panelMotionClearTimer);
    panel.classList.remove('panel-opening', 'panel-closing', 'front-switching');
    // Fold residual Motion x/y into left/top before hard-drag owns layout.
    panel.classList.add('panel-physics-baking');
    bakePanelTransform(panel, floatingPanelMotion.engine);
    panel.classList.remove('panel-physics-baking');
    void floatingPanelMotion._ensure().then((Motion) => {
        try {
            // If engine was still booting, bake again with live Motion.
            if (Motion && Motion !== floatingPanelMotion.engine) {
                panel.classList.add('panel-physics-baking');
                bakePanelTransform(panel, Motion);
                panel.classList.remove('panel-physics-baking');
            }
            Motion?.set?.(panel, { x: 0, y: 0 });
        } catch { /* ignore */ }
    }).catch(() => {});
    const sx = e.clientX;
    const sy = e.clientY;
    const sl = panel.offsetLeft;
    const st = panel.offsetTop;
    let dragging = false;
    let raf = 0;
    let lastX = sx;
    let lastY = sy;
    const commit = () => {
        raf = 0;
        panel.style.left = `${sl + lastX - sx}px`;
        panel.style.top = `${st + lastY - sy}px`;
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
        panel.style.transform = '';
        softClampPanelEdge(panel);
    };
    const move = (ev) => {
        lastX = ev.clientX;
        lastY = ev.clientY;
        const dist = Math.hypot(lastX - sx, lastY - sy);
        if (!dragging && dist > threshold) {
            dragging = true;
            panel.classList.add('dragging');
            panel._suppressHeaderClick = true;
            if (suppressLayoutClick) {
                suppressNextLayoutClick = true;
                closePanelLayoutMenu({ instant: true });
            }
            if (typeof onActivate === 'function') {
                try { onActivate(panel); } catch { /* ignore */ }
            }
        }
        if (!dragging) return;
        ev.preventDefault();
        if (!raf) raf = requestAnimationFrame(commit);
    };
    const up = () => {
        if (raf) cancelAnimationFrame(raf);
        if (dragging) commit();
        panel.classList.remove('dragging');
        if (typeof onFinish === 'function') {
            try { onFinish(panel, { dragged: dragging }); } catch { /* ignore */ }
        }
        if (suppressLayoutClick && dragging) {
            window.setTimeout(() => { suppressNextLayoutClick = false; }, 700);
        }
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up, { once: true });
    window.addEventListener('pointercancel', up, { once: true });
}

/**
 * Bind AI-identical physics drag on the gray strip + hard drag on ⋯.
 * Title/content never receive drag listeners.
 */
export async function ensureFloatingPanelPhysicsDrag(panel, {
    handle,
    layoutButton,
    layoutSelector = '[data-layout-panel], [data-action="layout"], [data-ai-agent-layout]',
    onActivate,
    onFinish,
    bringToFront = bringPanelToFront,
    force = false,
} = {}) {
    if (!panel) return false;
    // Prefer explicit gray strip; fall back to window titlebar chrome when a
    // panel only has traffic-light titlebar (editor / image / media preview).
    const dragHandle = handle
        || panel.querySelector('.panel-drag-handle')
        || panel.querySelector('.fm-editor-window-titlebar, .image-preview-titlebar, .media-preview-titlebar');
    let state = panelPhysicsState.get(panel);
    if (!state) {
        state = { physicsReady: false, controller: null, hardBound: false, fallbackBound: false };
        panelPhysicsState.set(panel, state);
    }

    // Precise hard drag on ⋯ only.
    const traffic = layoutButton
        || panel.querySelector(layoutSelector)
        || panel.querySelector('.panel-traffic-btn');
    if (traffic && !state.hardBound) {
        state.hardBound = true;
        traffic.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            traffic.classList.add('pressing');
            // Hold-and-drag on ⋯ = precise hard drag; short click still opens layout menu.
            startFloatingPanelHardDrag(panel, e, {
                suppressLayoutClick: true,
                threshold: 4,
                onActivate,
                onFinish,
                bringToFront,
            });
            const up = () => {
                traffic.classList.remove('pressing');
                window.removeEventListener('pointerup', up);
                window.removeEventListener('pointercancel', up);
            };
            window.addEventListener('pointerup', up, { once: true });
            window.addEventListener('pointercancel', up, { once: true });
        });
    }

    if (state.physicsReady && !force) return true;
    const Motion = await floatingPanelMotion._ensure();
    if (!Motion || floatingPanelMotion.failed || typeof Motion.drag !== 'function') {
        // Engine unavailable: hard-drag fallback still limited to gray strip.
        if (dragHandle && !state.fallbackBound) {
            state.fallbackBound = true;
            dragHandle.addEventListener('pointerdown', (e) => {
                if (e.target.closest?.(layoutSelector + ', button, a, input, textarea, select, [role="button"], label')) return;
                startFloatingPanelHardDrag(panel, e, {
                    suppressLayoutClick: false,
                    threshold: 4,
                    onActivate,
                    onFinish,
                    bringToFront,
                });
            });
        }
        return false;
    }

    if (state.controller?.destroy) {
        try { state.controller.destroy(); } catch { /* ignore */ }
    }

    // Only the top gray .panel-drag-handle owns physical dragging.
    // Three-dot traffic light is separately wired to precise hard drag.
    state.controller = Motion.drag(panel, {
        handle: dragHandle,
        activationThreshold: 4,
        rubberband: true,
        decelRate: 0.997,
        preset: 'ui',
        bounds: () => floatingPanelDragBounds(panel),
        snap: (tx, ty, ctx) => {
            const b = floatingPanelDragBounds(panel);
            const cx = Number(ctx?.x);
            const cy = Number(ctx?.y);
            const pastEdge = Number.isFinite(cx) && (
                cx < (b.minX ?? -Infinity) - 0.5
                || cx > (b.maxX ?? Infinity) + 0.5
                || (Number.isFinite(cy) && (cy < (b.minY ?? -Infinity) - 0.5 || cy > (b.maxY ?? Infinity) + 0.5))
            );
            if (pastEdge) return hardClampDragDelta(panel, cx, cy);
            return hardClampDragDelta(panel, tx, ty);
        },
        filter: (e) => {
            if (!e || !dragHandle) return false;
            if (e.button != null && e.button !== 0) return false;
            if (e.target?.closest?.(layoutSelector)) return false;
            const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
            const fromHandle = path.includes?.(dragHandle)
                || dragHandle === e.target
                || dragHandle.contains?.(e.target);
            if (!fromHandle) return false;
            if (e.target?.closest?.('button, a, input, textarea, select, [role="button"], label')) return false;
            return true;
        },
        onActivate: () => {
            try { bringToFront?.(panel); } catch { /* ignore */ }
            closePanelLayoutMenu({ instant: true });
            suppressNextLayoutClick = true;
            panel._suppressHeaderClick = true;
            // Drop any CSS transform owner before Motion writes x/y.
            window.clearTimeout(panel._panelMotionClearTimer);
            panel.classList.remove('panel-opening', 'panel-closing', 'front-switching');
            panel.classList.add('panel-physics-baking');
            // Visual bake: freeze painted box, detach writers, write left/top.
            bakePanelTransform(panel, Motion);
            try { Motion.set(panel, { x: 0, y: 0 }); } catch { /* ignore */ }
            panel.classList.add('dragging');
            panel.classList.remove('panel-physics-baking');
            panel.style.willChange = 'transform';
            if (typeof onActivate === 'function') {
                try { onActivate(panel); } catch { /* ignore */ }
            }
        },
        onMove: () => {},
        onEnd: ({ settled }) => {
            if (settled && typeof settled.then === 'function') {
                settled.then(() => finishFloatingPanelPhysicsDrag(panel, Motion, { onFinish }))
                    .catch(() => finishFloatingPanelPhysicsDrag(panel, Motion, { onFinish }));
            } else {
                finishFloatingPanelPhysicsDrag(panel, Motion, { onFinish });
            }
        },
        onCancel: () => {
            panel.classList.remove('dragging');
        },
    });
    state.physicsReady = true;

    // Lazy rebind if first interaction happened before engine boot.
    if (!panel.dataset.panelPhysicsPointerBound) {
        panel.dataset.panelPhysicsPointerBound = '1';
        panel.addEventListener('pointerdown', () => {
            void ensureFloatingPanelPhysicsDrag(panel, {
                handle: dragHandle,
                layoutButton: traffic,
                layoutSelector,
                onActivate,
                onFinish,
                bringToFront,
            });
        });
    }
    return true;
}

export function setupPanelInteractions(root = document, {
    panelSelector = '.rdp-floating-panel',
    onClosePanel,
    bringToFront = bringPanelToFront,
} = {}) {
    // Physics on gray strip + hard drag on ⋯ (AI panel parity).
    // Title/content are NOT drag surfaces.
    const panels = new Set();
    root.querySelectorAll(panelSelector).forEach((panel) => panels.add(panel));
    root.querySelectorAll('[data-drag-panel]').forEach((handle) => {
        const panel = document.getElementById(handle.dataset.dragPanel) || handle.closest(panelSelector);
        if (panel) panels.add(panel);
    });
    panels.forEach((panel) => {
        if (panel.dataset.panelPhysicsWired === '1') return;
        panel.dataset.panelPhysicsWired = '1';
        const dragHandle = panel.querySelector('.panel-drag-handle');
        const layoutButton = panel.querySelector('[data-layout-panel], .panel-traffic-btn');
        void ensureFloatingPanelPhysicsDrag(panel, {
            handle: dragHandle,
            layoutButton,
            bringToFront,
        });
    });

    // Traffic-light click opens island menu (drag is handled by hard-drag binder).
    root.querySelectorAll('[data-layout-panel]').forEach((button) => {
        if (button.dataset.panelLayoutClickBound === '1') return;
        button.dataset.panelLayoutClickBound = '1';
        button.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (suppressNextLayoutClick) {
                suppressNextLayoutClick = false;
                return;
            }
            const panel = document.getElementById(button.dataset.layoutPanel) || button.closest(panelSelector);
            if (!panel) return;
            try { bringToFront?.(panel); } catch { /* ignore */ }
            if (navigator.vibrate) navigator.vibrate(8);
            if (panelLayoutMenu && panelLayoutButton === button) closePanelLayoutMenu();
            else openPanelLayoutMenu(button, panel, { onClosePanel });
        });
    });

    // Edge resize handles (parent-relative, same clamping as SSH).
    root.querySelectorAll('[data-resize-panel]').forEach((handle) => {
        if (handle.dataset.panelBound === '1') return;
        handle.dataset.panelBound = '1';
        handle.addEventListener('pointerdown', (e) => {
            const panel = document.getElementById(handle.dataset.resizePanel) || handle.closest(panelSelector);
            if (!panel?.parentElement) return;
            e.preventDefault();
            e.stopPropagation();
            bringPanelToFront(panel);
            panel.classList.add('resizing');
            handle.setPointerCapture?.(e.pointerId);
            const startX = e.clientX;
            const startY = e.clientY;
            const startWidth = panel.offsetWidth;
            const startHeight = panel.offsetHeight;
            const startLeft = panel.offsetLeft;
            const edge = handle.dataset.resizeEdge || (handle.classList.contains('left') ? 'left' : 'right');
            const parentRect = panel.parentElement.getBoundingClientRect();
            const minWidth = isCompactScreen() ? 260 : 320;
            const minHeight = isCompactScreen() ? 240 : 280;
            const onMove = (ev) => {
                ev.preventDefault();
                let nextLeft = startLeft;
                let nextWidth = startWidth + ev.clientX - startX;
                if (edge === 'left') {
                    nextWidth = startWidth - (ev.clientX - startX);
                    nextLeft = startLeft + (ev.clientX - startX);
                    if (nextWidth < minWidth) {
                        nextLeft -= minWidth - nextWidth;
                        nextWidth = minWidth;
                    }
                    if (nextLeft < 8) {
                        nextWidth += nextLeft - 8;
                        nextLeft = 8;
                    }
                    panel.style.left = `${nextLeft}px`;
                }
                const maxWidth = edge === 'left'
                    ? startLeft + startWidth - 8
                    : parentRect.width - panel.offsetLeft - 12;
                const maxHeight = parentRect.height - panel.offsetTop - 12;
                panel.style.width = `${Math.min(Math.max(minWidth, nextWidth), maxWidth)}px`;
                panel.style.height = `${Math.min(Math.max(minHeight, startHeight + ev.clientY - startY), maxHeight)}px`;
                panel.style.right = 'auto';
                panel.style.bottom = 'auto';
            };
            const onUp = () => {
                panel.classList.remove('resizing');
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
            };
            window.addEventListener('pointermove', onMove, { passive: false });
            window.addEventListener('pointerup', onUp, { once: true });
        });
    });

    root.querySelectorAll(panelSelector).forEach((panel) => {
        if (panel.dataset.panelFrontBound === '1') return;
        panel.dataset.panelFrontBound = '1';
        panel.addEventListener('pointerdown', (event) => {
            if (event.target.closest('.panel-traffic-btn, .panel-layout-menu')) return;
            bringPanelToFront(panel);
        });
    });

    if (!document.documentElement.dataset.panelLayoutOutsideBound) {
        document.documentElement.dataset.panelLayoutOutsideBound = '1';
        document.addEventListener('pointerdown', (e) => {
            if (panelLayoutMenu && !e.target.closest('.panel-layout-menu') && !e.target.closest('[data-layout-panel]')) {
                closePanelLayoutMenu();
            }
        });
        window.addEventListener('resize', () => closePanelLayoutMenu());
    }
}

export function openFloatingPanel(panel, button, {
    kind = '',
    defaults,
    refresh,
} = {}) {
    if (!panel) return;
    const opts = defaults || getDefaultPanelOptions(panel, kind);
    ensureFloatingPanel(panel, opts);
    panel.hidden = false;
    panel.removeAttribute('hidden');
    panel.style.display = 'flex';
    panel.classList.add('open');
    button?.classList?.add('active');
    bringPanelToFront(panel);
    if (typeof refresh === 'function') {
        try { refresh(); } catch {}
    }
    requestAnimationFrame(() => animatePanelFromButton(panel, button, true));
}

export function closeFloatingPanel(panel, button) {
    if (!panel) return;
    closePanelLayoutMenu({ instant: true });
    animatePanelFromButton(panel, button, false);
    panel.classList.remove('open', 'front');
    button?.classList?.remove('active');
    window.setTimeout(() => {
        clearPanelMotion(panel);
        // Keep display:flex so open/close CSS transitions still work; [hidden]
        // only blocks pointer events while closed (see style.css).
        panel.setAttribute('hidden', '');
    }, 320);
}

export function toggleFloatingPanel(panel, button, options = {}) {
    if (!panel) return false;
    const willOpen = !panel.classList.contains('open');
    if (willOpen) openFloatingPanel(panel, button, options);
    else closeFloatingPanel(panel, button);
    return willOpen;
}

// Preview IIFE modules (image/media) share the same drag policy via window.
if (typeof window !== 'undefined') {
    window.ZephyrFloatingPanelPhysics = {
        ensure: ensureFloatingPanelPhysicsDrag,
        hardDrag: startFloatingPanelHardDrag,
        markLayoutClickSuppressed,
        consumeLayoutClickSuppression,
        bake: bakePanelTransform,
        bounds: floatingPanelDragBounds,
    };
}
