import { ensureFloatingPanel, ensureFloatingPanelPhysicsDrag, bringPanelToFront, bakePanelTransform } from './floating-panel.js';
import { normalizeTerminalShortcuts, shortcutLabel } from './terminal-shortcuts.js';

const MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Meta'];
const ICONS = {
    pin: '<path d="M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 1 1 0 0 0 1-1V4a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v1a1 1 0 0 0 1 1 1 1 0 0 1 1 1z"/>',
    free: '<rect x="4" y="5" width="16" height="15" rx="3"/><path d="M4 10h16M9 3v4m6-4v4"/>',
    close: '<path d="m18 6-12 12M6 6l12 12"/>',
};

/** Tier-1 batch tools. Does not own sessions, focus selection or transmission.
 * onShortcut(item,{focusOnly}), onSnippet(item,{focusOnly}), onFont(delta,{focusOnly}).
 * The parent MUST resolve focusOnly against its retained activeRemoteTab, never
 * document.activeElement, and MUST fail closed when that target is absent.
 * Toolbar buttons are automatically bound; do not also bind them in app.js.
 */
export function createRemoteExecTools({
    root, stageContent, dock, layoutRoot = dock?.parentElement, getShortcuts = () => undefined, getSnippets = () => [],
    onShortcut, onSnippet, onFont, onLayoutChange = () => {},
    getMotion = () => globalThis.window?.Motion, t = text => text,
} = {}) {
    if (!root || !stageContent || !dock || !layoutRoot || !root.contains(dock) || !root.contains(stageContent) || !layoutRoot.contains(stageContent)) {
        throw new TypeError('Remote tools require root, stageContent and a sibling right-side dock');
    }
    const doc = root.ownerDocument;
    const win = doc.defaultView;
    const abort = new win.AbortController();
    const panels = new Map();
    const layer = doc.createElement('div');
    layer.className = 'remote-exec-tools-layer app-shell';
    root.append(layer);
    const ownedRootClass = !root.classList.contains('remote-exec-tools-root');
    const ownedContentClass = !stageContent.classList.contains('remote-exec-stage-content');
    const ownedLayoutClass = !layoutRoot.classList.contains('remote-exec-tools-layout');
    const stageShell = stageContent.closest('.remote-stage-shell') || stageContent;
    layoutRoot.classList.add('remote-exec-tools-layout');
    const ownedDockClass = !dock.classList.contains('remote-exec-tools-dock');
    root.classList.add('remote-exec-tools-root');
    stageContent.classList.add('remote-exec-stage-content');
    dock.classList.add('remote-exec-tools-dock');
    const originalDockHidden = dock.hidden;
    let destroyed = false;
    let resizeFrame = 0;
    let lastWidth = layoutRoot.getBoundingClientRect().width;
    let activeMore = null;
    let activeMoreAnchor = null;
    const closeMore = (instant = false) => {
        const pop = activeMore;
        const anchor = activeMoreAnchor;
        activeMore = activeMoreAnchor = null;
        anchor?.classList.remove('active');
        if (!pop) return;
        if (!instant && motion()?.panelMorePopover) void motion().panelMorePopover(pop, anchor, false, { onClosed: () => pop.remove() });
        else pop.remove();
    };
    // The SSH tier-1 authority is terminal-sftp-pro's openUnifiedMorePopover,
    // not floating-panel.js's retired island layout menu. Keep its exact DOM,
    // action names, shared CSS and M15 spring presentation here. Batch owns the
    // grid mutation because terminal's closure is intentionally not exported.
    const openMore = state => {
        if (activeMoreAnchor === state.more) { closeMore(); return; }
        closeMore(true);
        const pop = element('div', 'z-panel-more-popover z-glass-thick');
        pop.setAttribute('role', 'menu');
        pop.setAttribute('aria-label', tr('窗口布局'));
        const svg = path => `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
        const add = (action, text, path, selected = false) => {
            const button = element('button', `z-more-item${selected ? ' active' : ''}`);
            button.type = 'button'; button.dataset.moreAction = action;
            button.innerHTML = svg(path);
            button.append(element('span', '', tr(text)));
            if (selected) button.append(element('span', 'z-more-check', '✓'));
            pop.append(button);
        };
        if (!state.pinned) add('fullscreen', state.fullscreen ? '还原窗口' : '全屏', state.fullscreen ? '<rect x="4" y="8" width="12" height="12" rx="1.5"/><path d="M8 8V5.5A1.5 1.5 0 0 1 9.5 4h9A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H16"/>' : '<rect x="4" y="4" width="16" height="16" rx="2"/>', state.fullscreen);
        add('right', '钉到右侧', '<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="15" y1="4" x2="15" y2="20"/>', state.pinned && state.side !== 'left');
        if (state.pinned || state.fullscreen) add('float', '自由浮窗', '<rect x="5" y="6" width="14" height="12" rx="2"/><path d="M9 10h6"/>');
        doc.body.append(pop); activeMore = pop; activeMoreAnchor = state.more;
        state.more.classList.add('active');
        if (motion()?.panelMorePopover) void motion().panelMorePopover(pop, state.more, true);
        else { const rect = state.more.getBoundingClientRect(); Object.assign(pop.style, { display: 'flex', left: `${Math.max(8, rect.right - 188)}px`, top: `${rect.bottom + 6}px` }); }
        listen(pop, 'click', event => {
            const item = event.target.closest('[data-more-action]');
            if (!item) return;
            event.preventDefault(); event.stopPropagation(); closeMore(true);
            if (item.dataset.moreAction === 'fullscreen') void setFullscreen(state, !state.fullscreen);
            else if (item.dataset.moreAction === 'float') void (state.fullscreen ? setFullscreen(state, false) : setPinned(state.kind, false));
            else void setPinned(state.kind, true, item.dataset.moreAction);
        });
    };
    const tr = text => t(text) || text;
    const listen = (el, event, fn, options = {}) => el?.addEventListener(event, fn, { ...options, signal: abort.signal });
    const element = (tag, className, text) => {
        const el = doc.createElement(tag);
        if (className) el.className = className;
        if (text !== undefined) el.textContent = text;
        return el;
    };
    const icon = (button, name, label) => {
        button.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
        button.title = tr(label);
        button.setAttribute('aria-label', tr(label));
    };
    const scope = state => ({ focusOnly: state.scope.checked === true });
    const error = (state, message = '') => { state.status.textContent = message; };
    // Call synchronously to snapshot the parent's retained blue-ring target at
    // click time. No await/RAF before dispatch, and never infer a DOM focus target.
    const dispatch = (state, fn, ...args) => {
        error(state);
        if (typeof fn !== 'function') return error(state, tr('此操作暂不可用'));
        try {
            Promise.resolve(fn(...args, scope(state))).catch(err => {
                if (!destroyed) error(state, err?.message || tr('操作失败'));
            });
        } catch (err) { error(state, err?.message || tr('操作失败')); }
    };
    const motion = () => {
        try { return getMotion?.() || null; } catch { return null; }
    };
    const resetMotion = state => {
        const engine = motion();
        engine?.stop?.(state.panel);
        engine?.release?.(state.panel);
        engine?.release?.(state.body);
        state.panel.classList.remove('z-panel-morphing', 'z-panel-closing', 'panel-opening', 'panel-closing');
        for (const property of ['--z-morph-l', '--z-morph-t', '--z-morph-w', '--z-morph-h', '--z-morph-r', '--z-morph-opacity']) state.panel.style.removeProperty(property);
        for (const property of ['display', 'transform', 'transform-origin', 'opacity', 'filter', 'visibility', 'pointer-events', 'will-change', 'clip-path']) {
            state.panel.style.removeProperty(property);
        }
    };
    const layout = reason => {
        const pinned = [...panels.values()].filter(state => state.open && state.pinned).map(state => state.kind);
        layoutRoot.classList.toggle('remote-exec-tools-compact', layoutRoot.getBoundingClientRect().width <= 900);
        dock.hidden = pinned.length === 0;
        layoutRoot.classList.toggle('remote-exec-has-tools', pinned.length > 0);
        layoutRoot.classList.remove('remote-exec-tools-left');
        dock.dataset.panelCount = String(pinned.length);
        if (reason !== 'init') onLayoutChange({ reason, pinned, dockWidth: pinned.length ? dock.getBoundingClientRect().width : 0 });
    };
    // Capture the live presentation, commit real grid allocation, then let the
    // SAME WASM FLIP engine animate stage avoidance. Never reparent/reload frames.
    const captureStage = () => stageShell.getBoundingClientRect();
    const animateStage = async from => {
        try {
            const engine = motion();
            engine?.stop?.(stageShell);
            engine?.release?.(stageShell);
            await engine?.morph?.(stageShell, from, { preset: 'mac', radiusFrom: 22, radiusTo: 22 });
        } catch { /* Final grid layout remains usable without Motion. */ }
    };
    const fitFree = (state, reset = false) => {
        if (state.pinned) return;
        const width = Math.max(0, layer.clientWidth || root.clientWidth);
        const height = Math.max(0, layer.clientHeight || root.clientHeight);
        const margin = Math.min(12, width / 4);
        const availableWidth = Math.max(1, width - margin * 2);
        const availableHeight = Math.max(1, height - 24);
        if (reset || !state.panel.style.width) {
            ensureFloatingPanel(state.panel, {
                width: Math.min(state.kind === 'shortcuts' ? 420 : 480, availableWidth), height: Math.min(state.kind === 'shortcuts' ? 360 : 520, availableHeight),
                left: Math.min(24 + (state.kind === 'snippets' ? 32 : 0), margin), top: 12,
            });
        }
        const style = state.panel.style;
        style.width = `${Math.min(parseFloat(style.width) || 460, availableWidth)}px`;
        style.height = `${Math.min(parseFloat(style.height) || 520, availableHeight)}px`;
        style.left = `${Math.max(margin, Math.min(parseFloat(style.left) || margin, width - parseFloat(style.width) - margin))}px`;
        style.top = `${Math.max(0, Math.min(parseFloat(style.top) || 12, height - parseFloat(style.height)))}px`;
    };
    const updatePin = state => {
        icon(state.pin, state.pinned ? 'free' : 'pin', state.pinned ? '恢复自由浮窗' : '停靠到右侧');
        state.pin.setAttribute('aria-pressed', String(state.pinned));
        state.panel.classList.toggle('docked-right', state.pinned);
        if (state.pinned) state.panel.dataset.pinSide = 'right';
        else delete state.panel.dataset.pinSide;
    };
    const renderShortcuts = state => {
        state.items = normalizeTerminalShortcuts(getShortcuts());
        state.grid.replaceChildren();
        for (const item of state.items) {
            const modifier = item.keys.length === 1 && MODIFIERS.includes(item.keys[0]);
            const button = element('button', `tool-btn ${modifier ? 'modifier' : 'func'}${/^F\d+$/.test(item.keys[0]) ? ' fn-key' : ''}`, shortcutLabel(item));
            button.type = 'button';
            button.dataset.shortcutId = item.id;
            button.title = item.keys.join('+');
            button.disabled = !modifier && typeof onShortcut !== 'function';
            if (modifier) {
                button.dataset.modifier = item.keys[0];
                button.classList.toggle('active', state.modifiers.has(item.keys[0]));
                button.setAttribute('aria-pressed', String(state.modifiers.has(item.keys[0])));
            }
            state.grid.append(button);
        }
        // Font actions are deliberately not shortcuts and never become PTY bytes.
        // No dead controls when a host has not installed font routing.
        if (typeof onFont === 'function') {
            for (const delta of [-1, 1]) {
                const button = element('button', 'tool-btn font-size-btn', delta < 0 ? 'A−' : 'A+');
                button.type = 'button';
                button.dataset.fontDelta = String(delta);
                button.title = tr(delta < 0 ? '缩小终端字体' : '放大终端字体');
                state.grid.append(button);
            }
        }
    };
    const sendShortcut = (state, item) => {
        const key = item.keys.find(value => !MODIFIERS.includes(value));
        const modifiers = MODIFIERS.filter(value => state.modifiers.has(value) || item.keys.includes(value));
        const normalized = normalizeTerminalShortcuts([{ ...item, keys: [...modifiers, key] }]);
        if (!normalized.length) {
            error(state, tr('不支持此组合键，请取消部分修饰键'));
            return;
        }
        dispatch(state, onShortcut, normalized[0]);
    };
    const renderSnippets = state => {
        const query = state.search.value.trim().toLocaleLowerCase();
        const source = getSnippets();
        state.items = Array.isArray(source) ? source.filter(item => item && typeof item === 'object') : [];
        state.list.replaceChildren();
        let count = 0;
        state.items.forEach((item, index) => {
            if (query && ![item.name, item.group, item.command].some(value => String(value || '').toLocaleLowerCase().includes(query))) return;
            const button = element('button', 'snippet-item');
            button.type = 'button';
            button.dataset.snippetIndex = String(index);
            button.disabled = typeof onSnippet !== 'function';
            button.append(element('strong', '', item.name || tr('未命名片段')),
                element('em', '', `${item.group || tr('未分组')} · ${tr(item.autoRun ? '直接执行' : '填入输入框')}`),
                element('code', '', String(item.command || '')));
            state.list.append(button);
            count++;
        });
        state.empty.hidden = count > 0;
        state.empty.textContent = tr(query ? '没有匹配的片段' : '暂无代码片段，请到首页 设置 → 代码片段 添加。');
    };
    const makePanel = (kind, title, triggerId) => {
        const panel = element('section', `remote-exec-tool-panel floating-panel z-unified-panel ${kind === 'shortcuts' ? 'shortcut-panel' : 'snippet-panel'}`);
        panel.id = kind === 'shortcuts' ? 'remoteExecShortcutsPanel' : 'remoteExecSnippetsPanel';
        panel.hidden = true;
        panel.setAttribute('role', 'region');
        panel.setAttribute('aria-label', tr(title));
        const handle = element('div', 'panel-drag-handle remote-exec-tool-handle');
        handle.title = tr('拖动移动窗口');

        const header = element('div', 'snippet-panel-header panel-titlebar remote-exec-tool-header');
        const heading = element('strong', '', tr(title));
        const actions = element('div', 'panel-head-controls remote-exec-tool-actions');
        const pin = element('button', 'tool-btn panel-pin-toggle remote-exec-tool-pin');
        pin.type = 'button';
        pin.dataset.action = 'pin';
        const closeButton = element('button', 'tool-btn panel-close-btn');
        closeButton.type = 'button';
        closeButton.dataset.action = 'close';
        icon(closeButton, 'close', '关闭');
        const more = element('button', 'tool-btn panel-more-btn');
        more.type = 'button';
        more.title = tr('窗口布局'); more.setAttribute('aria-label', tr('窗口布局'));
        more.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/></svg>';
        listen(more, 'click', () => openMore(state));
        actions.append(pin, more, closeButton);
        header.append(heading, actions);
        const scopeRow = element('label', 'settings-switch-option remote-exec-tool-scope');
        const scopeId = `${panel.id}FocusOnly`;
        scopeRow.htmlFor = scopeId;
        const copy = element('span', 'settings-switch-copy');
        copy.append(element('strong', 'settings-switch-label', tr('仅对焦点机器生效')));
        const toggle = element('span', 'connection-share-switch');
        const input = element('input');
        input.type = 'checkbox';
        input.id = scopeId;
        input.checked = false;
        const track = element('span');
        track.setAttribute('aria-hidden', 'true');
        toggle.append(input, track);
        scopeRow.append(copy, toggle);
        const body = element('div', 'remote-exec-tool-body snippet-panel-body');
        const status = element('p', 'remote-exec-tool-status');
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        panel.append(handle, header, scopeRow, body, status);
        const state = { kind, panel, handle: header, body, pin, more, scope: input, status,
            trigger: root.querySelector(`#${triggerId}`), open: false, pinned: false, side: 'right', fullscreen: false,
            modifiers: new Set(), items: [], revision: 0, freeStyle: null };
        if (kind === 'shortcuts') {
            state.grid = element('div', 'shortcut-grid');
            body.replaceWith(state.grid);
            state.grid.classList.add('remote-exec-tool-body');
            listen(state.grid, 'click', event => {
                const button = event.target.closest('button');
                if (!button || button.disabled) return;
                if (button.dataset.fontDelta) {
                    dispatch(state, onFont, Number(button.dataset.fontDelta));
                    return;
                }
                const item = state.items.find(candidate => candidate.id === button.dataset.shortcutId);
                if (!item) return;
                if (button.dataset.modifier) {
                    const modifier = button.dataset.modifier;
                    if (state.modifiers.has(modifier)) state.modifiers.delete(modifier);
                    else state.modifiers.add(modifier);
                    button.setAttribute('aria-pressed', String(state.modifiers.has(modifier)));
                    button.classList.toggle('active', state.modifiers.has(modifier));
                    error(state);
                } else sendShortcut(state, item);
            });
            // Sticky modifiers also combine with an ordinary physical key while
            // this panel owns keyboard focus. Space/Enter on buttons keep native
            // activation; they do not accidentally send a second command.
            listen(panel, 'keydown', event => {
                if (!state.modifiers.size || event.isComposing || event.defaultPrevented ||
                    event.target.matches('input, textarea') || [' ', 'Enter'].includes(event.key) || MODIFIERS.includes(event.key)) return;
                const keys = [event.key === 'Control' ? 'Ctrl' : event.key];
                const item = normalizeTerminalShortcuts([{ id: 'sticky-key', keys }])[0];
                if (!item || MODIFIERS.includes(item.keys[0])) return;
                event.preventDefault();
                event.stopPropagation();
                sendShortcut(state, item);
            });
        } else {
            state.search = element('input', 'snippet-search');
            state.search.type = 'search';
            state.search.placeholder = tr('搜索片段...');
            state.search.setAttribute('aria-label', tr('搜索片段...'));
            state.list = element('div', 'snippet-list');
            state.empty = element('p', 'snippet-empty');
            body.append(state.search, state.list, state.empty);
            listen(state.search, 'input', () => renderSnippets(state));
            listen(state.list, 'click', event => {
                const button = event.target.closest('[data-snippet-index]');
                if (!button || button.disabled) return;
                const item = state.items[Number(button.dataset.snippetIndex)];
                if (item) dispatch(state, onSnippet, item);
            });
        }
        listen(input, 'change', () => error(state));
        listen(pin, 'click', () => setPinned(kind, !state.pinned));
        listen(closeButton, 'click', () => close(kind));
        listen(state.trigger, 'click', () => togglePanel(kind));
        state.trigger?.setAttribute('aria-controls', panel.id);
        state.trigger?.setAttribute('aria-expanded', 'false');
        listen(panel, 'pointerdown', () => {
            if (!state.pinned) bringPanelToFront(panel);
        });
        listen(panel, 'keydown', event => {
            if (event.key !== 'Escape' || event.defaultPrevented) return;
            event.preventDefault();
            event.stopPropagation();
            void close(kind).then(() => state.trigger?.focus({ preventScroll: true }));
        });
        layer.append(panel);
        updatePin(state);
        panels.set(kind, state);
        return state;
    };
    const resolve = kind => panels.get(kind === 'shortcut' ? 'shortcuts' : kind === 'snippet' ? 'snippets' : kind);
    const refresh = kind => {
        if (destroyed) return;
        for (const state of kind ? [resolve(kind)].filter(Boolean) : panels.values()) {
            if (state.kind === 'shortcuts') renderShortcuts(state);
            else renderSnippets(state);
        }
    };
    const open = async (kind, anchor) => {
        const state = resolve(kind);
        if (destroyed || !state) return false;
        if (state.open) { if (!state.pinned) bringPanelToFront(state.panel); return true; }
        const revision = ++state.revision;
        resetMotion(state);
        state.open = true;
        state.panel.hidden = false;
        state.panel.classList.add('open');
        state.trigger?.classList.add('active');
        state.trigger?.setAttribute('aria-expanded', 'true');
        refresh(state.kind);
        fitFree(state, !state.freeStyle);
        bringPanelToFront(state.panel);
        // M06: use the exact terminal/RDP physics binder. No local drag engine,
        // CSS keyframes or HTML draggable. Its handle listeners die with panel.
        void ensureFloatingPanelPhysicsDrag(state.panel, { handle: state.handle }).catch(() => {});
        try {
            await motion()?.panelOpenWasm?.(state.panel, anchor || state.trigger, { preset: 'mac' });
        } catch { /* Engine unavailable: leave a fully usable static panel. */ }
        return !destroyed && state.revision === revision && state.open;
    };
    const close = async kind => {
        const state = resolve(kind);
        if (destroyed || !state || !state.open) return false;
        const revision = ++state.revision;
        const wasPinned = state.pinned;
        const stageFrom = wasPinned ? captureStage() : null;
        state.open = false;
        state.trigger?.classList.remove('active');
        state.trigger?.setAttribute('aria-expanded', 'false');
        if (!wasPinned) {
            try { closeMore(true); await motion()?.panelCloseWasm?.(state.panel, state.trigger, { preset: 'snappy' }); }
            catch { /* No CSS animation fallback. */ }
        }
        if (destroyed || state.revision !== revision || state.open) return false;
        // Dock close is immediate and releases the real column: no tiny FLIP
        // residue, no terminal iframe detach/recreate and no hidden placeholder.
        resetMotion(state);
        state.panel.hidden = true;
        state.panel.classList.remove('open', 'front');
        if (wasPinned) {
            state.pinned = false;
            layer.append(state.panel);
            restoreFree(state);
            updatePin(state);
            layout('close');
            await animateStage(stageFrom);
        }
        state.modifiers.clear();
        return true;
    };
    const restoreFree = state => {
        if (state.freeStyle) Object.assign(state.panel.style, state.freeStyle);
        fitFree(state);
    };
    const setFullscreen = async (state, value) => {
        if (state.pinned) await setPinned(state.kind, false);
        const from = state.panel.getBoundingClientRect();
        bakePanelTransform(state.panel, motion()); resetMotion(state);
        if (value) {
            state.fullscreenStyle = Object.fromEntries(['left', 'top', 'width', 'height', 'right', 'bottom'].map(key => [key, state.panel.style[key]]));
            Object.assign(state.panel.style, { left:'0px', top:'0px', right:'auto', bottom:'auto', width:`${layer.clientWidth}px`, height:`${layer.clientHeight}px` });
        } else {
            if (state.fullscreenStyle) Object.assign(state.panel.style, state.fullscreenStyle);
            fitFree(state);
        }
        state.fullscreen = !!value;
        state.panel.classList.toggle('remote-exec-fullscreen', state.fullscreen);
        await motion()?.morph?.(state.panel, from, { preset:'mac', radiusFrom:22, radiusTo:22 });
    };
    const setPinned = async (kind, value = true, side = 'right') => {
        side = 'right'; // Batch supports only the sibling right-hand tool dock.
        const state = resolve(kind);
        if (destroyed || !state) return false;
        if (!state.open) await open(state.kind);
        if (state.fullscreen) await setFullscreen(state, false);
        if (destroyed || !state.open || (state.pinned === !!value && (!value || state.side === side))) return false;
        const revision = ++state.revision;
        const engine = motion();
        const candidates = [...new Set([state.panel, ...[...panels.values()]
            .filter(other => other.open && other.pinned).map(other => other.panel), stageShell])];
        // Preserve flex slots while the shared box-morph engine temporarily
        // takes docked panels out of normal flow. Placeholders paint nothing.
        const slots = [];
        let stageMotion = false;
        const mutate = () => {
            layoutRoot.classList.add('remote-exec-dock-morphing');
            stageMotion = true;
            bakePanelTransform(state.panel, engine);
            state.pinned = !!value;
            if (state.pinned) {
                state.side = 'right';
                if (state.panel.parentElement !== dock) state.freeStyle = Object.fromEntries(['left', 'top', 'width', 'height', 'right', 'bottom'].map(key => [key, state.panel.style[key]]));
                dock.append(state.panel);
                for (const property of ['left', 'top', 'right', 'bottom', 'width', 'height']) state.panel.style.removeProperty(property);
            } else {
                layer.append(state.panel);
                restoreFree(state);
                bringPanelToFront(state.panel);
            }
            updatePin(state);
            layout(state.pinned ? 'pin' : 'free');
            for (const other of panels.values()) if (other.open && other.pinned) {
                const slot = element('div', 'remote-exec-dock-morph-slot');
                slot.setAttribute('aria-hidden', 'true');
                dock.insertBefore(slot, other.panel);
                slots.push(slot);
            }
        };
        try {
            // Exactly the terminal's dock/float engine and spring. Both the
            // panels and the stage use real box channels, not scale FLIP.
            if (engine?.panelDockMorph) await engine.panelDockMorph(candidates, mutate, {
                preset: { response: 0.22, damping: 0.98 }, coordinateRoot: root, layoutOnly: [stageShell],
                onDone: () => slots.forEach(slot => slot.remove()),
            });
            else mutate();
        } finally {
            slots.forEach(slot => slot.remove());
            if (stageMotion) layoutRoot.classList.remove('remote-exec-dock-morphing');
        }
        return !destroyed && state.revision === revision;
    };
    const togglePanel = kind => resolve(kind)?.open ? close(kind) : open(kind);
    // Leaving the view closes only free floaters. Docked state and independent
    // focus-only preferences survive; the root view's hidden/display state also
    // hides pinned panels because no panel is portalled to document.body.
    const leave = () => Promise.all([...panels.values()]
        .filter(state => state.open && !state.pinned).map(state => close(state.kind)));
    const getState = () => Object.fromEntries([...panels].map(([kind, state]) => [kind, {
        open: state.open, pinned: state.pinned, focusOnly: state.scope.checked === true,
    }]));
    const destroy = () => {
        if (destroyed) return;
        destroyed = true;
        abort.abort();
        closeMore(true);
        observer?.disconnect();
        win.cancelAnimationFrame(resizeFrame);
        for (const state of panels.values()) {
            ++state.revision;
            resetMotion(state);
            state.panel.remove();
            state.trigger?.classList.remove('active');
            state.trigger?.removeAttribute('aria-controls');
            state.trigger?.removeAttribute('aria-expanded');
        }
        layer.remove();
        if (ownedRootClass) root.classList.remove('remote-exec-tools-root');
        if (ownedContentClass) stageContent.classList.remove('remote-exec-stage-content');
        if (ownedDockClass) dock.classList.remove('remote-exec-tools-dock');
        if (ownedLayoutClass) layoutRoot.classList.remove('remote-exec-tools-layout');
        motion()?.release?.(stageShell);
        layoutRoot.classList.remove('remote-exec-has-tools', 'remote-exec-tools-compact');
        delete dock.dataset.panelCount;
        dock.hidden = originalDockHidden;
        onLayoutChange({ reason: 'destroy', pinned: [], dockWidth: 0 });
    };
    makePanel('shortcuts', '⌨️ 快捷键', 'remoteShortcutBtn');
    makePanel('snippets', '⚡ 代码片段', 'remoteSnippetBtn');
    layout('init');
    // Container rather than viewport observation handles sidebar size changes,
    // and container-query breakpoint changes also refit the retained terminals.
    const resize = () => {
        if (destroyed) return;
        win.cancelAnimationFrame(resizeFrame);
        resizeFrame = win.requestAnimationFrame(() => {
            for (const state of panels.values()) if (state.open && !state.pinned) fitFree(state);
            const width = layoutRoot.getBoundingClientRect().width;
            if (Math.abs(width - lastWidth) > 0.5) { lastWidth = width; layout('resize'); }
        });
    };
    const observer = win.ResizeObserver ? new win.ResizeObserver(resize) : null;
    observer?.observe(layoutRoot);
    observer?.observe(stageContent);
    observer?.observe(root);
    listen(doc, 'pointerdown', event => {
        if (activeMore && !event.target.closest('.z-panel-more-popover, .panel-more-btn')) closeMore();
    }, { capture:true });
    listen(doc, 'keydown', event => { if (event.key === 'Escape' && activeMore) { event.preventDefault(); event.stopPropagation(); closeMore(); } }, { capture:true });
    listen(win, 'resize', () => closeMore(true));
    listen(win, 'resize', resize);
    return { open, close, toggle: togglePanel, pin: kind => setPinned(kind, true),
        free: kind => setPinned(kind, false), setPinned, refresh, getState, leave, destroy };
}
