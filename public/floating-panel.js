/**
 * Shared floating-panel interaction for SSH terminal and RDP page.
 * Coordinates are parent-relative (same model as public/terminal.js).
 */

const panelState = new WeakMap();
let floatingPanelZIndexSeed = 10080;
let panelLayoutMenu = null;
let panelLayoutButton = null;
let suppressNextLayoutClick = false;

import { t } from './i18n/runtime.js?v=20260726-telnet-routes1';

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
    const wasFront = panel.classList.contains('front');
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
    if (!wasFront) {
        panel.classList.remove('front-switching');
        void panel.offsetWidth;
        panel.classList.add('front-switching');
        window.clearTimeout(panel._frontSwitchTimer);
        panel._frontSwitchTimer = window.setTimeout(() => {
            panel.classList.remove('front-switching');
        }, 360);
    }
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
}

export function clearPanelMotion(panel) {
    if (!panel) return;
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

export function setupPanelInteractions(root = document, {
    panelSelector = '.rdp-floating-panel',
    onClosePanel,
} = {}) {
    // Titlebar drag (parent-relative coordinates, same as SSH).
    root.querySelectorAll('[data-drag-panel]').forEach((handle) => {
        if (handle.dataset.panelBound === '1') return;
        handle.dataset.panelBound = '1';
        handle.addEventListener('pointerdown', (e) => {
            if (e.target.closest('[data-layout-panel], button, input, select, textarea, label')) return;
            const panel = document.getElementById(handle.dataset.dragPanel) || handle.closest(panelSelector);
            if (!panel?.parentElement) return;
            e.preventDefault();
            bringPanelToFront(panel);
            panel.classList.add('dragging');
            handle.setPointerCapture?.(e.pointerId);
            const startX = e.clientX;
            const startY = e.clientY;
            const startLeft = panel.offsetLeft;
            const startTop = panel.offsetTop;
            const onMove = (ev) => {
                ev.preventDefault();
                panel.style.left = `${startLeft + ev.clientX - startX}px`;
                panel.style.top = `${startTop + ev.clientY - startY}px`;
                panel.style.right = 'auto';
                panel.style.bottom = 'auto';
                clampPanel(panel);
            };
            const onUp = () => {
                panel.classList.remove('dragging');
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
            };
            window.addEventListener('pointermove', onMove, { passive: false });
            window.addEventListener('pointerup', onUp, { once: true });
        });
    });

    // Traffic-light button: press-and-drag moves panel; click opens island menu.
    root.querySelectorAll('[data-layout-panel]').forEach((button) => {
        if (button.dataset.panelBound === '1') return;
        button.dataset.panelBound = '1';
        button.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const panel = document.getElementById(button.dataset.layoutPanel) || button.closest(panelSelector);
            if (!panel) return;
            bringPanelToFront(panel);
            button.classList.add('pressing');
            button.setPointerCapture?.(e.pointerId);
            const startX = e.clientX;
            const startY = e.clientY;
            const startLeft = panel.offsetLeft;
            const startTop = panel.offsetTop;
            let moved = false;
            const onMove = (ev) => {
                ev.preventDefault();
                const dx = ev.clientX - startX;
                const dy = ev.clientY - startY;
                if (!moved && Math.hypot(dx, dy) > 7) {
                    moved = true;
                    closePanelLayoutMenu({ instant: true });
                    panel.classList.add('dragging');
                }
                if (!moved) return;
                panel.style.left = `${startLeft + dx}px`;
                panel.style.top = `${startTop + dy}px`;
                panel.style.right = 'auto';
                panel.style.bottom = 'auto';
                clampPanel(panel);
            };
            const onUp = () => {
                panel.classList.remove('dragging');
                button.classList.remove('pressing');
                suppressNextLayoutClick = moved;
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
                window.removeEventListener('pointercancel', onUp);
            };
            window.addEventListener('pointermove', onMove, { passive: false });
            window.addEventListener('pointerup', onUp, { once: true });
            window.addEventListener('pointercancel', onUp, { once: true });
        });
        button.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (suppressNextLayoutClick) {
                suppressNextLayoutClick = false;
                return;
            }
            const panel = document.getElementById(button.dataset.layoutPanel) || button.closest(panelSelector);
            if (!panel) return;
            bringPanelToFront(panel);
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
