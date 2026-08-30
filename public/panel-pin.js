/**
 * Desktop-only side pinning for Zephyr's secondary floating panels.
 * The toggle's geometry/motion are the exact 18px `.tgl` component from
 * tgl-pin.html; its colors deliberately follow the active Zephyr theme.
 */
const pinned = new Set();
let zSeed = 10100;

export function isDesktopPanelPinEnvironment() {
    return window.matchMedia?.('(hover: hover) and (pointer: fine)')?.matches === true
        && Math.min(window.innerWidth || 0, window.innerHeight || 0) > 700;
}

function pageFor(panel, page) {
    return page || panel.closest('.terminal-page, .rdp-page, .app-shell') || document.body;
}

function scopeFor(page) {
    const rect = page.getBoundingClientRect();
    const width = page.clientWidth || rect.width || window.innerWidth;
    const height = page.clientHeight || rect.height || window.innerHeight;
    const topbar = page.querySelector(':scope > .terminal-topbar, :scope > .rdp-topbar, :scope > .main-nav');
    const topbarHeight = topbar?.offsetHeight || 0;
    // Pinned windows use position:fixed so RDP/VNC windows (whose normal parent
    // is the display stage) can still cover the page chrome exactly like SSH.
    return { left: rect.left, top: rect.top, width, height, topbarHeight };
}

function rememberNormalGeometry(panel) {
    if (panel._pinRestore) return;
    const rect = panel.getBoundingClientRect();
    const parent = panel.offsetParent || panel.parentElement;
    const parentRect = parent?.getBoundingClientRect?.() || { left: 0, top: 0 };
    panel._pinRestore = {
        position: panel.style.position,
        left: panel.style.left || `${rect.left - parentRect.left}px`,
        top: panel.style.top || `${rect.top - parentRect.top}px`,
        width: panel.style.width || `${rect.width}px`,
        height: panel.style.height || `${rect.height}px`,
        right: panel.style.right,
        bottom: panel.style.bottom,
    };
}

function panelGroup(page) {
    return [...pinned].filter((panel) => panel.isConnected && panel._pinPage === page);
}

function dockedAt(page, side) {
    return panelGroup(page).filter((panel) => panel.dataset.pinSide === side && (panel.dataset.pinMode || 'side') === 'side');
}

function sideInset(page, side) {
    return dockedAt(page, side).reduce((max, panel) => Math.max(max, panel.offsetWidth || 0), 0);
}

function halfInset(page) {
    return panelGroup(page).reduce((max, panel) => {
        if (panel.dataset.pinMode !== 'half') return max;
        return Math.max(max, panel.offsetHeight || 0);
    }, 0);
}

function applyInsets(page) {
    const left = sideInset(page, 'left');
    const right = sideInset(page, 'right');
    const bottom = halfInset(page);
    page.style.setProperty('--pin-inset-left', `${left}px`);
    page.style.setProperty('--pin-inset-right', `${right}px`);
    page.style.setProperty('--pin-inset-bottom', `${bottom}px`);
    page.classList.toggle('pin-has-left', left > 0);
    page.classList.toggle('pin-has-right', right > 0);
    page.classList.toggle('pin-has-bottom', bottom > 0);
}

function bringToFront(panel) {
    zSeed += 1;
    panel.style.zIndex = String(zSeed);
    panel.style.setProperty('--panel-z', String(zSeed));
}

function quarterWidth(scope) {
    return Math.max(260, Math.min(560, Math.round(scope.width / 4)));
}

function startGeometryMotion(panel) {
    panel.classList.add('pin-animating');
    window.clearTimeout(panel._pinMotionTimer);
    panel._pinMotionTimer = window.setTimeout(() => {
        panel.classList.remove('pin-animating');
        panel.style.willChange = '';
    }, 560);
}

function clampHalfHeight(height, scope) {
    return Math.max(160, Math.min(scope.height - scope.topbarHeight - 80, Math.round(height)));
}

function place(panel, mode = panel.dataset.pinMode || 'side') {
    const page = panel._pinPage;
    const scope = scopeFor(page);
    const side = panel.dataset.pinSide || 'left';
    const fullHeight = scope.height;
    rememberNormalGeometry(panel);
    startGeometryMotion(panel);

    // The page can be a terminal page, an RDP/VNC page, or the web app shell.
    // Fixed coordinates make the same geometry reliable even when the panel's
    // normal containing block is a nested display stage.
    const fixed = { position: 'fixed', right: 'auto', bottom: 'auto', transform: 'none' };
    if (mode === 'full') {
        // ⋯ → full: retain the header (the user's red-line requirement).
        Object.assign(panel.style, fixed, {
            left: `${scope.left}px`, top: `${scope.top + scope.topbarHeight}px`, width: `${scope.width}px`,
            height: `${Math.max(1, fullHeight - scope.topbarHeight)}px`,
        });
        return;
    }
    if (mode === 'half') {
        // Bottom dock is genuinely a bottom band: the bottom row owns the full
        // width, while side rails remain only in the row above it.
        const height = clampHalfHeight(Number.parseFloat(panel.style.height) || Math.round(fullHeight / 2), scope);
        panel._pinHalfHeight = height;
        Object.assign(panel.style, fixed, {
            left: `${scope.left}px`, top: `${scope.top + fullHeight - height}px`, width: `${scope.width}px`, height: `${height}px`,
        });
        return;
    }

    const explicit = Number.parseFloat(panel.style.width);
    const width = Math.min(Number.isFinite(explicit) ? explicit : quarterWidth(scope), scope.width);
    // Side rails stop above any bottom-docked panel; the bottom band is the
    // only owner of the lower row, so the two modes never overlap.
    const height = fullHeight - halfInset(page);
    Object.assign(panel.style, fixed, {
        left: `${scope.left + (side === 'left' ? 0 : scope.width - width)}px`, top: `${scope.top}px`,
        width: `${width}px`, height: `${Math.max(1, height)}px`,
    });
}

function syncChrome(panel) {
    const side = panel.dataset.pinSide || '';
    const mode = panel.dataset.pinMode || 'side';
    panel.classList.toggle('pinned', !!side);
    // A bottom dock is not a left/right rail. Both 18px toggles lock together,
    // matching the demo's ON state while the panel is docked anywhere.
    const buttonOn = (button) => side ? (mode === 'half' || button.dataset.pinSide === side) : false;
    panel.querySelectorAll('.panel-pin-btn').forEach((button) => {
        const active = buttonOn(button);
        button.classList.toggle('on', active);
        button.setAttribute('aria-pressed', String(active));
    });
    panel.querySelectorAll('.panel-resize-handle').forEach((handle) => {
        const edge = handle.dataset.resizeEdge || (handle.classList.contains('left') ? 'left' : 'right');
        handle.style.display = side && mode === 'side' && edge === side ? 'none' : '';
    });
    if (!side) {
        // Demo parity: once released, ⋯ must be an ordinary window-layout button
        // again. Do not leave the pinned island's faded/hidden chrome behind.
        panel.querySelectorAll('.panel-traffic-btn, [data-layout-panel], [data-ai-agent-layout]').forEach((button) => {
            button.classList.remove('active-layout');
            button.style.removeProperty('opacity');
        });
    }
}

function pin(panel, side) {
    const page = panel._pinPage;
    const stack = dockedAt(page, side).filter((item) => item !== panel);
    const width = stack[0]?.offsetWidth || quarterWidth(scopeFor(page));
    panel.dataset.pinSide = side;
    panel.dataset.pinMode = 'side';
    panel.style.width = `${width}px`;
    pinned.add(panel);
    place(panel, 'side');
    syncChrome(panel);
    bringToFront(panel);
    applyInsets(page);
    if (navigator.vibrate) navigator.vibrate(12);
}

function unpin(panel) {
    const page = panel._pinPage;
    const scope = scopeFor(page);
    const width = panel.offsetWidth || 420;
    const height = Math.min(panel.offsetHeight || 460, Math.max(240, scope.height - scope.topbarHeight - 16));
    const restore = panel._pinRestore;
    delete panel.dataset.pinSide;
    delete panel.dataset.pinMode;
    delete panel._pinHalfHeight;
    pinned.delete(panel);
    startGeometryMotion(panel);
    if (restore) {
        Object.assign(panel.style, restore, { transform: 'none' });
        delete panel._pinRestore;
    } else {
        Object.assign(panel.style, {
            position: '', left: `${Math.max(16, Math.round((scope.width - width) / 2))}px`,
            top: `${Math.max(scope.topbarHeight + 12, Math.round((scope.height - height) / 3))}px`,
            width: `${width}px`, height: `${height}px`, right: 'auto', bottom: 'auto', transform: 'none',
        });
    }
    syncChrome(panel);
    panelGroup(page).forEach((other) => other !== panel && place(other));
    applyInsets(page);
    if (navigator.vibrate) navigator.vibrate([6, 16, 6]);
}

function closePinMenu(anchor = null, panel = null, { instant = false } = {}) {
    const menu = panel?._pinMenu || document.querySelector('.panel-pin-menu');
    const traffic = anchor || panel?.querySelector?.('.panel-traffic-btn, [data-layout-panel], [data-ai-agent-layout]');
    if (!menu) return;
    window.clearTimeout(menu._closeTimer);
    if (instant || !traffic?.isConnected) {
        traffic?.classList.remove('active-layout');
        traffic?.style.removeProperty('opacity');
        menu.remove();
        if (panel?._pinMenu === menu) delete panel._pinMenu;
        return;
    }
    const rect = traffic.getBoundingClientRect();
    menu.style.transition = 'none';
    menu.style.setProperty('--panel-island-menu-width', `${Math.max(188, Number.parseFloat(menu.style.getPropertyValue('--panel-island-menu-width')) || 336)}px`);
    menu.style.setProperty('--panel-island-menu-height', '50px');
    menu.style.setProperty('--panel-island-radius', '18px');
    void menu.offsetWidth;
    menu.classList.remove('island-open');
    menu.classList.add('island-closing', 'island-animating');
    traffic.classList.remove('active-layout');
    traffic.style.opacity = '0';
    requestAnimationFrame(() => {
        menu.style.removeProperty('transition');
        menu.style.left = `${rect.left}px`;
        menu.style.top = `${rect.top}px`;
        menu.style.setProperty('--panel-island-menu-width', `${rect.width}px`);
        menu.style.setProperty('--panel-island-menu-height', `${rect.height}px`);
        menu.style.setProperty('--panel-island-radius', `${Math.round(rect.height / 2)}px`);
    });
    menu._closeTimer = window.setTimeout(() => {
        traffic.classList.remove('active-layout');
        traffic.style.opacity = '1';
        requestAnimationFrame(() => traffic.style.removeProperty('opacity'));
        menu.remove();
        if (panel?._pinMenu === menu) delete panel._pinMenu;
    }, 460);
}

function openPinMenu(anchor, panel, onClose) {
    closePinMenu();
    const page = panel._pinPage;
    const side = panel.dataset.pinSide || 'left';
    const menu = document.createElement('div');
    // Same host classes, icon spans, island-open animation and stagger timing as
    // the ordinary unpinned ⋯ menu. Pinned state only changes available actions.
    menu.className = 'panel-layout-menu panel-pin-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', '钉住布局');
    menu.innerHTML = `
        <button data-pin-layout="full" title="全屏" aria-label="全屏"><span class="panel-layout-icon full"></span></button>
        <button data-pin-layout="half" title="下 1/2" aria-label="下 1/2"><span class="panel-layout-icon half"></span></button>
        <button data-pin-layout="switch-left" title="钉到左边" aria-label="钉到左边"><span class="panel-layout-icon left"></span></button>
        <button data-pin-layout="switch-right" title="钉到右边" aria-label="钉到右边"><span class="panel-layout-icon right"></span></button>
        <button data-pin-layout="unpin" title="取消钉住" aria-label="取消钉住"><span class="panel-layout-icon unpin"></span></button>
        <button data-pin-layout="close" class="panel-layout-close" title="关闭窗口" aria-label="关闭窗口"><span class="panel-layout-icon close"></span></button>`;
    menu.style.transition = 'none';
    menu.style.zIndex = String(Math.max(10000, (Number(panel.style.zIndex) || zSeed) + 20));
    document.body.appendChild(menu);
    panel._pinMenu = menu;
    anchor._pinMenuOpen = true;
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(336, Math.max(188, window.innerWidth - 16));
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.left + rect.width / 2 - width / 2));
    menu.style.left = `${left}px`;
    menu.style.top = `${rect.top}px`;
    menu.style.setProperty('--panel-island-menu-width', `${width}px`);
    menu.style.setProperty('--panel-island-menu-height', '50px');
    menu.style.setProperty('--panel-island-radius', `${Math.round(rect.height / 2)}px`);
    menu.style.opacity = '1';
    menu.classList.add('island-animating');
    void menu.offsetWidth;
    requestAnimationFrame(() => {
        menu.style.removeProperty('transition');
        anchor.classList.add('active-layout');
        menu.classList.add('island-open');
        menu.style.setProperty('--panel-island-radius', '18px');
        window.setTimeout(() => menu.classList.remove('island-animating'), 540);
    });

    const outside = (event) => {
        if (!menu.contains(event.target) && event.target !== anchor) {
            document.removeEventListener('pointerdown', outside, true);
            closePinMenu(anchor, panel);
        }
    };
    document.addEventListener('pointerdown', outside, true);
    menu.addEventListener('click', (event) => {
        const item = event.target.closest('[data-pin-layout]');
        if (!item) return;
        document.removeEventListener('pointerdown', outside, true);
        const action = item.dataset.pinLayout;
        closePinMenu(anchor, panel);
        if (action === 'close') { onClose?.(panel); return; }
        if (action === 'unpin') { unpin(panel); return; }
        if (action === 'switch-left' || action === 'switch-right') {
            panel.dataset.pinSide = action === 'switch-left' ? 'left' : 'right';
            panel.dataset.pinMode = 'side';
            panel.style.width = `${quarterWidth(scopeFor(page))}px`;
            place(panel, 'side');
            syncChrome(panel);
            bringToFront(panel);
            panelGroup(page).forEach((other) => other !== panel && place(other));
            applyInsets(page);
            return;
        }
        panel.dataset.pinMode = action;
        if (action === 'half') panel.style.height = `${panel._pinHalfHeight || Math.round(scopeFor(page).height / 2)}px`;
        place(panel, action);
        syncChrome(panel);
        bringToFront(panel);
        panelGroup(page).forEach((other) => other !== panel && place(other));
        applyInsets(page);
    });
}

function bindPinnedResize(panel, handle) {
    handle.addEventListener('pointerdown', (event) => {
        if (!panel.dataset.pinSide || (panel.dataset.pinMode || 'side') !== 'side') return;
        const edge = handle.dataset.resizeEdge || (handle.classList.contains('left') ? 'left' : 'right');
        if (edge === panel.dataset.pinSide) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const page = panel._pinPage;
        const scope = scopeFor(page);
        const side = panel.dataset.pinSide;
        const startX = event.clientX;
        const startWidth = panel.offsetWidth;
        panel.classList.add('resizing');
        const move = (ev) => {
            ev.preventDefault();
            const delta = ev.clientX - startX;
            const width = side === 'left' ? startWidth + delta : startWidth - delta;
            // Keep write local: place() adds a transition class and is for discrete
            // layouts only. Calling it each pointer frame made the bottom handle lag.
            const next = Math.max(220, Math.min(scope.width - 24, width));
            panel.style.width = `${next}px`;
            panel.style.left = `${scope.left + (side === 'left' ? 0 : scope.width - next)}px`;
        };
        const up = () => {
            panel.classList.remove('resizing');
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            applyInsets(page);
        };
        window.addEventListener('pointermove', move, { passive: false });
        window.addEventListener('pointerup', up, { once: true });
    }, true);
}

function bindPinnedVerticalDrag(panel, handle) {
    handle.addEventListener('pointerdown', (event) => {
        if (!panel.dataset.pinSide || panel.dataset.pinMode !== 'half') return;
        if (event.target.closest('.panel-pin-btn, .panel-traffic-btn, [data-layout-panel], [data-ai-agent-layout]')) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const page = panel._pinPage;
        const scope = scopeFor(page);
        const startY = event.clientY;
        const startHeight = panel.offsetHeight;
        panel.classList.add('resizing');
        const move = (ev) => {
            ev.preventDefault();
            const next = clampHalfHeight(startHeight + (startY - ev.clientY), scope);
            panel._pinHalfHeight = next;
            panel.style.height = `${next}px`;
            panel.style.top = `${scope.top + scope.height - next}px`;
        };
        const up = () => {
            panel.classList.remove('resizing');
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            // The terminal/content area must own only the space above the dock.
            // This reflow is what prevents the bottom band from covering it.
            panelGroup(page).forEach((other) => other !== panel && place(other));
            applyInsets(page);
        };
        window.addEventListener('pointermove', move, { passive: false });
        window.addEventListener('pointerup', up, { once: true });
    }, true);
}

/**
 * Attach only to a top-level secondary panel. Nested/third-level panels must
 * not inherit the parent pin state; callers simply do not invoke this on them.
 */
export function attachDesktopPanelPin(page, panel, { dragHandle, layoutButton, onClose } = {}) {
    if (!panel || panel.dataset.desktopPinWired === '1' || !isDesktopPanelPinEnvironment()) return false;
    panel.dataset.desktopPinWired = '1';
    panel._pinPage = pageFor(panel, page);

    // Defensive reset for cloned nested panels: default stays a normal floating window.
    delete panel.dataset.pinSide;
    delete panel.dataset.pinMode;
    delete panel._pinHalfHeight;
    panel.classList.remove('pinned', 'pin-animating');

    const handle = dragHandle || panel.querySelector('.panel-drag-handle');
    if (!handle) return false;
    // An older cloned DOM/template can carry the decorative controls but not the
    // listeners. Always de-duplicate before installing the real controls.
    handle.querySelectorAll('.panel-pin-btn').forEach((button) => button.remove());
    const makeButton = (side, label) => {
        const button = document.createElement('button');
        button.type = 'button';
        // `.tgl` deliberately reuses the exact button system delivered in tgl-pin.html.
        button.className = `tgl panel-pin-btn ${side}`;
        button.dataset.pinSide = side;
        button.title = label;
        button.setAttribute('aria-label', label);
        button.setAttribute('aria-pressed', 'false');
        button.oncontextmenu = () => false;
        return button;
    };
    handle.prepend(makeButton('left', '钉到左边'));
    handle.append(makeButton('right', '钉到右边'));

    handle.addEventListener('pointerdown', (event) => {
        if (event.target.closest('.panel-pin-btn')) event.stopPropagation();
    }, true);
    handle.addEventListener('click', (event) => {
        const button = event.target.closest('.panel-pin-btn');
        if (!button) return;
        event.preventDefault();
        event.stopPropagation();
        // Bottom dock locks both toggles; while it is active, toggles stay ON
        // rather than pretending to select a left/right rail. Use ⋯ to release.
        if (panel.dataset.pinMode === 'half') return;
        if (panel.dataset.pinSide === button.dataset.pinSide) unpin(panel);
        else pin(panel, button.dataset.pinSide);
    });

    const traffic = layoutButton || panel.querySelector('.panel-traffic-btn, [data-layout-panel]');
    if (traffic) {
        // Capture phase preserves ordinary original three-dot behavior exactly
        // while unpinned; only pinned state swaps its layout meanings.
        traffic.addEventListener('click', (event) => {
            if (!panel.dataset.pinSide) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            openPinMenu(traffic, panel, onClose);
        }, true);
    }

    panel.querySelectorAll('.panel-resize-handle').forEach((handleEl) => bindPinnedResize(panel, handleEl));
    bindPinnedVerticalDrag(panel, handle);
    panel.addEventListener('pointerdown', () => {
        if (panel.dataset.pinSide) bringToFront(panel);
    }, true);

    const observer = new MutationObserver(() => {
        const opened = panel.classList.contains('open') && panel.style.display !== 'none' && !panel.hidden;
        if (panel.dataset.pinSide && (!opened || !panel.isConnected)) {
            const owner = panel._pinPage;
            pinned.delete(panel);
            delete panel.dataset.pinSide;
            delete panel.dataset.pinMode;
            delete panel._pinHalfHeight;
            // Keep release semantics identical to the demo: a closed/docked panel
            // always comes back as an ordinary floating window with normal ⋯ chrome.
            syncChrome(panel);
            panelGroup(owner).forEach((other) => place(other));
            owner && applyInsets(owner);
        }
    });
    observer.observe(panel, { attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
    panel._pinObserver = observer;

    window.addEventListener('resize', () => {
        if (!panel.dataset.pinSide) return;
        place(panel);
        panelGroup(panel._pinPage).forEach((other) => other !== panel && place(other));
        applyInsets(panel._pinPage);
    });
    return true;
}

export function releaseDesktopPanelPin(panel) {
    if (!panel?.dataset?.pinSide) return;
    unpin(panel);
}

export function refreshDesktopPanelPin(page) {
    panelGroup(page).forEach((panel) => place(panel));
    applyInsets(page);
}

if (typeof window !== 'undefined') {
    window.ZephyrDesktopPanelPin = { attach: attachDesktopPanelPin, refresh: refreshDesktopPanelPin };
}
