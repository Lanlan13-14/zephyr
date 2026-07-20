import { applyZephyrColorScheme, DEFAULT_CUSTOM_THEME_COLORS, normalizeCustomThemeColors, zephyrBrandIconHtml, zephyrFaviconHref } from './theme-runtime.js?v=20260615-visual-color-picker';import { createNotesController } from './notes.js?v=20260720-notes-craft1';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
function installClosestFallback() {
    const define = (proto, fn) => {
        if (!proto || proto.closest) return;
        try { Object.defineProperty(proto, 'closest', { value: fn, configurable: true }); } catch {}
    };
    define(window.Text?.prototype, function closestFromText(selector) { return this.parentElement?.closest?.(selector) || null; });
    define(window.Document?.prototype, function closestFromDocument() { return null; });
    define(window.Window?.prototype, function closestFromWindow() { return null; });
}
installClosestFallback();
document.documentElement.dataset.appModule = 'loaded';

let connections = [], activities = [], proxies = [], jumpHosts = [], sshKeys = [], settings = {};
let zephyrSharedClipboard = { type: '', text: '', files: [], sourceTabId: '', sourcePage: '', updatedAt: 0 };
let aiSettingsState = null;
let aiProviderShareTargetsState = [];
let aiProviderSelectedUserIds = new Set();
let aiChatSessions = [];
let aiCurrentSessionId = null;
let aiPanelLayoutMenu = null;
let aiPanelLayoutMenuButton = null;
let aiPanelSuppressLayoutClick = false;
let aiBrowserPreviewTimer = 0;
let aiAutoTitleTimer = 0;
let aiSidebarCollapsedBySize = false;
let aiPendingConfirmations = new Map();
const aiBrowserPreviewStates = new Map();
const aiSessionRuns = new Map();
let aiStoppedControllers = new WeakSet();
let aiPanelState = 'closed';
let aiPanelCloseTimer = 0;
let aiPanelWatchdogTimer = 0;
let aiPanelMorphOriginButton = null;
let aiRemoteDesktopActionSeq = 0;
const aiRemoteDesktopActionWaiters = new Map();
let aiCodeBlockSeq = 0;
const aiCodeBlockStore = new Map();
let aiCodePreviewObjectUrl = '';
let aiMessageMenuState = { index: -1, text: '', element: null, touchTimer: 0 };
let aiEditingMessageIndex = -1;
let aiEditingSessionId = '';
let aiPendingInputAttachments = [];
const AI_CHAT_STORAGE_KEY = 'zephyr-ai-chat-sessions';
let editingId = null;
let editingSecretLoaded = false;
let editingConnectionSecretState = { hasPassword: false, hasPrivateKey: false, sshKeyId: '' };
let connectionModalMode = 'create'; // create | edit | transient
let connectionModalSource = 'dashboard';
let transientToken = '';
let transientHasCredential = false;
let connectionModalTrigger = null;
let connectionModalOriginRect = null;
let notesController = null;
let workspaceClientId = '';
let workspaceRevision = null;
let workspaceRestoring = false;
let workspaceReady = false;
let workspaceSaveTimer = null;
let currentAppView = 'dashboard';
let terminalTabs = [], activeTerminalTab = null;
let openOrderStack = [], visualLayout = [], recentUseStack = [];
let terminalSmartbarOpen = false;
let terminalSmartbarSide = 'center';
let terminalSmartbarPickerOpen = false;
let terminalSmartbarTimer = 0;
let terminalSmartbarClosing = false;
let terminalSmartbarLastInnerPointerAt = 0;
let smartbarDragState = null;
let smartbarPressState = null;
let suppressSmartbarClick = false;
let smartbarHoverWindowId = null;
let smartbarTrashHover = false;
let dockSwapAnimatingWindows = new Set();
let dockLaunchAnimatingWindows = new Set();
let terminalDragState = null;
let terminalControlLongPress = false;
let mobileDockTogglePressState = null;
let mobileDockToggleLastToggleAt = 0;
const terminalReconnectFallbackTimers = new Map();
let fullscreenLoadingTimer = 0;
let appKeyboardBaseline = 0;
let appKeyboardOpen = false;
let appKeyboardSettleTimer = 0;
let appKeyboardLastSignature = '';
let appKeyboardPendingMetrics = null;
let appKeyboardFreezeReleaseTimer = 0;
let closingTerminalTabs = new Set();
let minimizingTerminalTabs = new Set();
let securityStatus = { user: {}, passkeys: [] }, ipBans = [], loginEvents = [];

const SMARTBAR_AUTO_HIDE_MS = 30000;
const SMARTBAR_TOUCH_DRAG_HOLD_MS = 2000;
const SMARTBAR_TOUCH_TAP_MAX_MS = 1999;
const TERMINAL_EDGE_SNAP_PX = 56;
const DEFAULT_BRAND_NAME = 'Zephyr';
const DEFAULT_BRAND_ICON = '🌬️';
let pendingBrandIcon = DEFAULT_BRAND_ICON;
const SMARTBAR_TEXT_IMAGE_CACHE = new Map();

function apiErrorFromResponse(res, data = {}) {
    const raw = data.error || data.message;
    const message = typeof raw === 'string' ? raw : (raw?.message || raw?.code || `请求失败（HTTP ${res.status}）`);
    const err = new Error(message);
    err.status = res.status;
    err.code = data.code || raw?.code || '';
    err.retryable = !!data.retryable;
    err.transient = !!data.transient || res.status === 502 || res.status === 503 || res.status === 504;
    err.payload = data;
    return err;
}
function api(path, options = {}) {
    return fetch(path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options })
        .then(async (res) => { const data = await res.json().catch(() => ({})); if (!res.ok) throw apiErrorFromResponse(res, data); return data; });
}
function apiMaybeForm(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (!(options.body instanceof FormData) && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    return fetch(path, { credentials: 'same-origin', headers, ...options })
        .then(async (res) => { const data = await res.json().catch(() => ({})); if (!res.ok) throw apiErrorFromResponse(res, data); return data; });
}
function toast(message) { const el = $('#toast'); if (!el) { console.warn('[toast]', message); return; } el.textContent = message; el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 2600); }
window.addEventListener('error', (event) => {
    console.error('[app-runtime]', event.error || event.message);
    if (document.readyState === 'complete') toast(`前端错误：${event.message || '未知错误'}`);
});
window.addEventListener('unhandledrejection', (event) => {
    console.error('[app-runtime]', event.reason);
    if (document.readyState === 'complete') toast(`前端异步错误：${event.reason?.message || event.reason || '未知错误'}`);
});
function terminalFrameById(tabId = '') {
    const id = String(tabId || '').trim();
    return id ? document.querySelector(`#terminalWorkspace iframe.terminal-frame[data-frame="${CSS.escape(id)}"]`) : null;
}
function terminalPageForTab(tabId = '') {
    return String(terminalTabs.find((t) => t.id === tabId)?.page || 'terminal').toLowerCase();
}
function isRemoteDesktopPage(page = '') { return page === 'rdp' || page === 'novnc'; }
function postToTerminalTab(tabId = '', message = {}) {
    const frame = terminalFrameById(tabId);
    if (!frame?.contentWindow) return false;
    frame.contentWindow.postMessage({ source: 'zephyr-app', ...message }, '*');
    return true;
}
function normalizeSharedClipboardFiles(files = []) {
    return Array.from(files || []).map((file) => {
        const name = String(file.name || (file.path ? String(file.path).split(/[\\/]/).pop() : '') || 'clipboard-file').slice(0, 255);
        const path = String(file.path || file.remotePath || name || '');
        return {
            id: String(file.id || ''),
            name,
            size: Number(file.size) || 0,
            type: file.type === 'd' ? 'd' : '-',
            path,
            mime: String(file.mime || ''),
            dataUrl: String(file.dataUrl || ''),
            transitUrl: String(file.transitUrl || ''),
            remotePath: String(file.remotePath || ''),
            source: String(file.source || ''),
        };
    }).filter((file) => file.name || file.path || file.dataUrl || file.transitUrl || file.remotePath);
}
function updateZephyrSharedClipboard(next = {}) {
    zephyrSharedClipboard = {
        type: String(next.type || ''),
        text: String(next.text || ''),
        files: normalizeSharedClipboardFiles(next.files || []),
        sourceTabId: String(next.sourceTabId || ''),
        sourcePage: String(next.sourcePage || terminalPageForTab(String(next.sourceTabId || '')) || ''),
        updatedAt: Date.now(),
    };
}
function fileClipboardNames(files = []) {
    return normalizeSharedClipboardFiles(files).map((f) => f.name || f.path.split('/').pop() || 'file').join('、');
}
function offerSharedClipboardToSshTargets(sourceTabId = '', files = []) {
    const names = fileClipboardNames(files);
    const targets = terminalTabs.filter((t) => !closingTerminalTabs.has(t.id) && t.id !== sourceTabId && t.page !== 'rdp' && t.page !== 'novnc' && t.iframe);
    if (!targets.length) {
        toast(names ? `已复制远程文件：${names}；打开 SSH 文件管理器后可粘贴` : '已复制远程文件');
        return;
    }
    targets.forEach((target) => postToTerminalTab(target.id, { type: 'shared-file-clipboard-available', files, sourceTabId, sourcePage: terminalPageForTab(sourceTabId) || 'rdp' }));
    toast(names ? `已复制 RDP 文件：${names}，可到 SSH 文件管理器粘贴` : '已复制 RDP 文件，可到 SSH 文件管理器粘贴');
}
function offerSharedClipboardToRdpTargets(sourceTabId = '', files = [], sourcePage = '') {
    const names = fileClipboardNames(files);
    const page = sourcePage || terminalPageForTab(sourceTabId) || 'rdp';
    const targets = terminalTabs.filter((t) => !closingTerminalTabs.has(t.id) && t.id !== sourceTabId && (t.page === 'rdp' || t.page === 'novnc') && t.iframe);
    if (!targets.length) {
        toast(names ? `已复制文件：${names}；打开 RDP 后可粘贴` : '已复制文件');
        return;
    }
    targets.forEach((target) => postToTerminalTab(target.id, {
        type: 'shared-file-clipboard-available',
        files,
        sourceTabId,
        sourcePage: page,
    }));
    toast(names ? `已复制文件：${names}，可到 RDP 远程桌面粘贴` : '已复制文件，可到 RDP 粘贴');
}
function handleSharedClipboardMessage(data = {}) {
    const sourceTabId = String(data.tabId || '');
    // ── Text clipboard ──
    if (data.type === 'shared-clipboard-text') {
        const text = String(data.text || '');
        if (!text) return true;
        updateZephyrSharedClipboard({ type: 'text', text, sourceTabId, sourcePage: terminalPageForTab(sourceTabId) });
        terminalTabs.filter((t) => t.id !== sourceTabId && t.iframe).forEach((target) => {
            const page = terminalPageForTab(target.id);
            if (isRemoteDesktopPage(page)) postToTerminalTab(target.id, { type: 'shared-clipboard-text', text, sourceTabId });
        });
        return true;
    }
    // ── File clipboard from RDP (local paste/drop files → forward to SSH) ──
    if (data.type === 'shared-file-clipboard') {
        const files = normalizeSharedClipboardFiles(data.files || []);
        if (!files.length) return true;
        updateZephyrSharedClipboard({ type: 'files', files, sourceTabId, sourcePage: terminalPageForTab(sourceTabId) });
        const page = terminalPageForTab(sourceTabId);
        if (isRemoteDesktopPage(page)) {
            // RDP source: offer to SSH tabs and other RDP tabs.
            offerSharedClipboardToSshTargets(sourceTabId, files);
            offerSharedClipboardToRdpTargets(sourceTabId, files, page);
        } else {
            // SSH / terminal source: offer to RDP tabs.
            offerSharedClipboardToRdpTargets(sourceTabId, files, page || 'terminal');
        }
        return true;
    }
    // ── Request clipboard from parent (SSH/RDP startup) ──
    if (data.type === 'request-shared-file-clipboard') {
        if (zephyrSharedClipboard.type === 'files' && zephyrSharedClipboard.files.length) {
            postToTerminalTab(sourceTabId, {
                type: 'shared-file-clipboard-available',
                files: zephyrSharedClipboard.files,
                sourceTabId: zephyrSharedClipboard.sourceTabId,
                sourcePage: zephyrSharedClipboard.sourcePage || '',
            });
            return true;
        }
        return true;
    }
    // ── Target consumes clipboard (SSH↔RDP / RDP↔RDP) ──
    if (data.type === 'shared-file-clipboard-consume') {
        const files = normalizeSharedClipboardFiles(data.files || zephyrSharedClipboard.files || []);
        if (!files.length) return true;
        const sourceTabIdForFiles = String(data.sourceTabId || zephyrSharedClipboard.sourceTabId || '');
        // Consumer is the tab that asked to paste (message origin).
        const consumerFrame = terminalFrameById(sourceTabId);
        // Already-hydrated bytes: forward immediately.
        if (files.every((f) => f.transitUrl || f.dataUrl || f.remotePath) && consumerFrame?.contentWindow) {
            consumerFrame.contentWindow.postMessage({
                source: 'zephyr-app',
                type: 'shared-file-clipboard-data',
                requestId: '',
                files,
                sourceTabId: sourceTabIdForFiles,
            }, '*');
            return true;
        }
        // Ask source tab to materialize bytes, then relay to consumer.
        // RDP source → cliprdr download + transit upload.
        // SSH source → sftp clipboard upload.
        const sourceFrame = terminalFrameById(sourceTabIdForFiles);
        if (sourceFrame?.contentWindow && consumerFrame?.contentWindow) {
            const requestId = `shared-file-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
            const relay = (event) => {
                if (event.source !== sourceFrame.contentWindow || event.data?.source !== 'zephyr-terminal' || event.data?.type !== 'shared-file-clipboard-data' || event.data?.requestId !== requestId) return;
                window.removeEventListener('message', relay, true);
                consumerFrame.contentWindow.postMessage({
                    source: 'zephyr-app',
                    type: 'shared-file-clipboard-data',
                    requestId,
                    files: event.data.files || [],
                    error: event.data.error || '',
                    sourceTabId: sourceTabIdForFiles,
                }, '*');
            };
            window.addEventListener('message', relay, true);
            sourceFrame.contentWindow.postMessage({
                source: 'zephyr-app',
                type: 'shared-file-clipboard-read',
                requestId,
                files,
                sourceTabId: sourceTabIdForFiles,
            }, '*');
            window.setTimeout(() => window.removeEventListener('message', relay, true), 60000);
        }
        return true;
    }
    // ── SSH notifies file copy to parent (metadata only, actual data on server) ──
    if (data.type === 'shared-file-clipboard-remote') {
        const files = normalizeSharedClipboardFiles(data.files || []);
        if (!files.length) return true;
        updateZephyrSharedClipboard({ type: 'files', files, sourceTabId, sourcePage: 'terminal' });
        offerSharedClipboardToRdpTargets(sourceTabId, files, 'terminal');
        return true;
    }
    return false;
}
const systemThemeQuery = matchMedia('(prefers-color-scheme: dark)');
function getSystemTheme() { return systemThemeQuery.matches ? 'dark' : 'light'; }
function getAppearance() { return settings?.appearance || {}; }
function isAutoThemeEnabled() { return getAppearance().autoThemeEnabled !== false; }
function getPreferredTheme() {
    const appearance = getAppearance();
    if (isAutoThemeEnabled() || appearance.theme === 'auto') return getSystemTheme();
    if (appearance.theme === 'light' || appearance.theme === 'dark') return appearance.theme;
    const saved = localStorage.getItem('zephyr-theme');
    return saved === 'light' || saved === 'dark' ? saved : getSystemTheme();
}
function postTerminalKeyboardFreeze(frozen, reason = 'keyboard-freeze', { settleMs = 900, tabId = activeTerminalTab } = {}) {
    const frames = tabId
        ? $$(`#terminalWorkspace iframe.terminal-frame[data-frame="${CSS.escape(tabId)}"]`)
        : $$('#terminalWorkspace iframe.terminal-frame');
    frames.forEach((frame) => frame.contentWindow?.postMessage({
        source: 'zephyr-app',
        type: 'keyboard-freeze',
        frozen: !!frozen,
        reason,
        settleMs,
    }, '*'));
}
function postTerminalLayoutStabilize(reason = 'layout-stabilize', { focus = false, tabId = activeTerminalTab } = {}) {
    const workspace = $('#terminalWorkspace');
    const frames = tabId
        ? $$(`#terminalWorkspace iframe.terminal-frame[data-frame="${CSS.escape(tabId)}"]`)
        : $$('#terminalWorkspace iframe.terminal-frame');
    const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
    const workspaceRect = workspace?.getBoundingClientRect?.();
    console.info('[TerminalLayoutDiagnostics]', {
        event: 'parent:layout-stabilize',
        reason,
        focus,
        tabId,
        frames: frames.length,
        workspace: workspaceRect ? {
            width: Math.round(workspaceRect.width),
            height: Math.round(workspaceRect.height),
            top: Math.round(workspaceRect.top),
            left: Math.round(workspaceRect.left),
        } : null,
        fullscreen: !!fullscreenElement,
        customFullscreen: !!workspace?.classList.contains('custom-fullscreen'),
        keyboardOpen: !!workspace?.classList.contains('keyboard-open'),
        appKeyboardOpen,
        appKeyboardBaseline,
        visualViewport: window.visualViewport ? {
            width: Math.round(window.visualViewport.width || 0),
            height: Math.round(window.visualViewport.height || 0),
            offsetTop: Math.round(window.visualViewport.offsetTop || 0),
            offsetLeft: Math.round(window.visualViewport.offsetLeft || 0),
        } : null,
    });
    const keyboardInset = parseInt(document.documentElement.style.getPropertyValue('--app-keyboard-inset') || '0', 10);
    frames.forEach((frame) => frame.contentWindow?.postMessage({
        source: 'zephyr-app',
        type: 'layout-stabilize',
        reason,
        focus,
        keyboardOpen: !!workspace?.classList.contains('keyboard-open') || appKeyboardOpen,
        keyboardInset: Math.round(keyboardInset || 0),
    }, '*'));
}
function maybeApplyCompactKeyboardFromViewport(reason = 'compact-keyboard-viewport') {
    const workspace = $('#terminalWorkspace');
    if (!workspace || !isCompactTerminalWorkspace() || !document.body.classList.contains('terminal-mode') || !window.visualViewport) return false;
    const baseline = Math.max(appKeyboardBaseline || 0, window.innerHeight || 0, document.documentElement.clientHeight || 0);
    const viewportHeight = Math.round(window.visualViewport.height || 0);
    const offsetTop = Math.round(window.visualViewport.offsetTop || 0);
    const inset = Math.max(0, Math.round(baseline - viewportHeight - offsetTop));
    if (inset < 80 && !workspace.classList.contains('keyboard-open')) return false;
    applyTerminalWorkspaceKeyboard({ keyboardOpen: inset >= 80 || appKeyboardOpen, keyboardInset: inset, viewportHeight, layoutHeight: baseline, offsetTop, stableInput: true, reason });
    return true;
}
function scheduleCompactKeyboardViewportCheck(reason = 'compact-keyboard-check') {
    [0, 60, 140, 260, 420, 700].forEach((delay) => {
        window.setTimeout(() => maybeApplyCompactKeyboardFromViewport(`${reason}:phase-${delay}`), delay);
    });
}
function rememberCompactTerminalKeyboardBaseline(reason = 'compact-keyboard-baseline') {
    const workspace = $('#terminalWorkspace');
    if (!workspace || !isCompactTerminalWorkspace() || appKeyboardOpen || workspace.classList.contains('keyboard-open')) return;
    const viewport = window.visualViewport;
    const candidates = [
        window.innerHeight || 0,
        document.documentElement.clientHeight || 0,
        viewport ? (viewport.height || 0) + (viewport.offsetTop || 0) : 0,
        document.querySelector('.terminal-view.active')?.getBoundingClientRect?.().bottom || 0,
    ].map((value) => Math.round(Number(value) || 0)).filter((value) => value > 0);
    if (!candidates.length) return;
    const nextBaseline = Math.max(...candidates);
    if (nextBaseline > appKeyboardBaseline) appKeyboardBaseline = nextBaseline;
    console.info('[TerminalLayoutDiagnostics]', { event: 'parent:compact-keyboard-baseline', reason, appKeyboardBaseline });
}
function forceCompactTerminalWorkspaceFill(reason = 'compact-terminal-fill') {
    const workspace = $('#terminalWorkspace');
    if (!workspace || !isCompactTerminalWorkspace()) return;
    const view = document.querySelector('.terminal-view.active');
    if (!view) return;
    rememberCompactTerminalKeyboardBaseline(reason);
    const viewRect = view.getBoundingClientRect?.();
    const viewHeight = Math.round(viewRect?.height || 0);
    if (!appKeyboardOpen && viewHeight > 0) {
        workspace.style.flex = '1 1 auto';
        workspace.style.height = 'auto';
        workspace.style.maxHeight = 'none';
        workspace.style.minHeight = '0px';
        workspace.style.marginBottom = '0px';
        document.body.classList.remove('terminal-keyboard-lift');
        document.documentElement.style.setProperty('--app-keyboard-shift', '0px');
        document.documentElement.style.setProperty('--app-visual-vh', '100vh');
        document.documentElement.style.setProperty('--app-keyboard-top', '100vh');
    }
    workspace.querySelectorAll('.terminal-window:not(.minimized-keepalive)').forEach((win) => {
        win.style.minHeight = '0px';
        win.style.height = '';
        win.style.maxHeight = '100%';
        const body = win.querySelector('.terminal-window-body');
        if (body) {
            body.style.minHeight = '0px';
            body.style.height = '';
            body.style.maxHeight = '100%';
        }
        win.querySelectorAll('.terminal-frame, .terminal-placeholder').forEach((frame) => {
            frame.style.height = '100%';
            frame.style.maxHeight = '100%';
            frame.style.minHeight = '0px';
        });
    });
    console.info('[TerminalLayoutDiagnostics]', { event: 'parent:compact-fill', reason, viewHeight, appKeyboardOpen });
}
function scheduleTerminalLayoutStabilize(reason = 'layout-stabilize', options = {}) {
    window.clearTimeout(scheduleTerminalLayoutStabilize._timer);
    scheduleTerminalLayoutStabilize._timer = window.setTimeout(() => {
        [0, 80, 220, 520].forEach((delay, index) => {
            window.setTimeout(() => {
                forceCompactTerminalWorkspaceFill(`${reason}:phase-${index}`);
                if (appKeyboardOpen || $('#terminalWorkspace')?.classList.contains('keyboard-open')) maybeApplyCompactKeyboardFromViewport(`${reason}:phase-${index}`);
                postTerminalLayoutStabilize(`${reason}:phase-${index}`, options);
            }, delay);
        });
    }, 24);
}
function broadcastThemeToTerminals(theme) {
    const appearance = getAppearance();
    $$('#terminalWorkspace iframe.terminal-frame').forEach((frame) => frame.contentWindow?.postMessage({ source: 'zephyr-app', type: 'theme-change', theme, appearance }, '*'));
    broadcastNotesEnabled();
    scheduleTerminalLayoutStabilize('theme-change', { focus: false, tabId: null });
}
function applyTheme(theme, { persist = false } = {}) {
    const root = document.documentElement;
    const previousTheme = root.getAttribute('data-theme') || getSystemTheme();
    const changed = previousTheme !== theme;
    root.classList.remove('theme-transitioning');
    void root.offsetWidth;
    root.classList.add('theme-transitioning');
    document.body?.classList.toggle('theme-ripple-active', changed);
    window.clearTimeout(applyTheme._timer);
    applyTheme._timer = window.setTimeout(() => {
        root.classList.remove('theme-transitioning');
        document.body?.classList.remove('theme-ripple-active');
    }, 460);
    root.setAttribute('data-theme', theme);
    applyZephyrColorScheme(getAppearance(), { theme, page: 'app' });
    setFavicon(pendingBrandIcon || DEFAULT_BRAND_ICON);
    SMARTBAR_TEXT_IMAGE_CACHE.clear();
    if (terminalTabs.length) renderTerminalSmartbar();
    if (persist || getAppearance().autoThemeEnabled === false) localStorage.setItem('zephyr-theme', theme);
    $('#appThemeToggle').textContent = theme === 'dark' ? '☀️' : '🌙';
    $('#settingsThemeToggle').textContent = theme === 'dark' ? '☀️' : '🌙';
    syncAppearanceSchemeControls();
    console.debug('[appearance-client]', 'theme transition applied', { previousTheme, theme, changed });
    broadcastThemeToTerminals(theme);
}
async function toggleTheme() {
    const nextTheme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    localStorage.setItem('zephyr-theme', nextTheme);
    const appearance = { ...getAppearance(), colorScheme: 'frost', theme: nextTheme, autoThemeEnabled: false };
    settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ appearance }) }).catch((err) => { toast(err.message); return settings; });
    $('#autoThemeEnabled').checked = false;
    applyTheme(nextTheme, { persist: true });
    console.debug('[appearance-client]', 'manual theme selected', { theme: nextTheme, autoThemeEnabled: false });
}
function escapeHtml(str) { return String(str || '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m])); }
function iconHtml(icon = DEFAULT_BRAND_ICON) { return zephyrBrandIconHtml(icon); }
function faviconHref(icon = DEFAULT_BRAND_ICON) { return zephyrFaviconHref(icon); }
function setFavicon(icon = DEFAULT_BRAND_ICON) {
    let link = document.querySelector('link[rel="icon"]');
    if (!link) {
        link = document.createElement('link');
        link.rel = 'icon';
        document.head.appendChild(link);
    }
    link.href = faviconHref(icon);
}
function applyAppearance(appearance = getAppearance()) {
    const brandName = String(appearance.brandName || DEFAULT_BRAND_NAME).trim() || DEFAULT_BRAND_NAME;
    const brandIcon = String(appearance.brandIcon || DEFAULT_BRAND_ICON).trim() || DEFAULT_BRAND_ICON;
    pendingBrandIcon = brandIcon;
    $('#brandName').textContent = brandName;
    $('#brandIcon').innerHTML = iconHtml(brandIcon);
    $('#brandNameInput').value = brandName;
    $('#brandIconPreview').innerHTML = iconHtml(brandIcon);
    $('#autoThemeEnabled').checked = appearance.autoThemeEnabled !== false;
    syncAppearanceSchemeControls(appearance);
    document.title = brandName;
    setFavicon(brandIcon);
    console.debug('[appearance-client]', 'appearance applied', { brandName, customIcon: brandIcon !== DEFAULT_BRAND_ICON, autoThemeEnabled: appearance.autoThemeEnabled !== false, theme: appearance.theme || 'auto' });
}
function readImageAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        if (!file) return resolve('');
        if (!/^image\/(png|jpeg|gif|webp|svg\+xml)$/i.test(file.type)) return reject(new Error('仅支持 PNG/JPEG/GIF/WebP/SVG 图标'));
        if (file.size > 512 * 1024) return reject(new Error('图标文件不能超过 512KB'));
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('读取图标失败'));
        reader.readAsDataURL(file);
    });
}
function invertHexColorClient(value, fallback = '#1d1d1f') {
    const hex = normalizeHexInputClient(value, '');
    if (!hex) return fallback;
    const rgb = hexToRgbClient(hex);
    return rgbToHexClient({ r: 255 - rgb.r, g: 255 - rgb.g, b: 255 - rgb.b });
}
function normalizeTerminalFontColors(appearance = {}) {
    const colors = appearance.terminalFontColors || {};
    const legacy = appearance.terminalFontColor || '';
    const dark = normalizeHexInputClient(colors.dark || legacy || '', '');
    const lightRaw = normalizeHexInputClient(colors.light || '', '');
    return { dark, light: lightRaw || (dark ? invertHexColorClient(dark) : '') };
}
function setColorPickerEnabled(input, enabled) {
    if (!input) return;
    input.disabled = !enabled;
    input.closest('[data-color-picker]')?.classList.toggle('disabled', !enabled);
}
function normalizeRdpDefaultQuality(value) {
    const mode = String(value || '').toLowerCase();
    return ['balanced', 'performance', 'quality'].includes(mode) ? mode : 'balanced';
}
async function saveAppearance(e) {
    e.preventDefault();
    const previous = getAppearance();
    const colorScheme = $('#colorSchemeSelect')?.value || previous.colorScheme || 'frost';
    const autoThemeEnabled = $('#autoThemeEnabled').checked;
    const explicitMode = $('#themeModeSelect')?.value || previous.theme || 'auto';
    const theme = autoThemeEnabled || explicitMode === 'auto' ? 'auto' : (explicitMode === 'light' || explicitMode === 'dark' ? explicitMode : (document.documentElement.getAttribute('data-theme') || getSystemTheme()));
    const terminalBgSource = $('#terminalBgSource')?.value || 'none';
    const terminalFontEnabled = !!$('#terminalFontColorEnabled')?.checked;
    const terminalFontDark = terminalFontEnabled ? normalizeHexInputClient($('#terminalFontColor')?.value || '', '') : '';
    const terminalFontLightRaw = terminalFontEnabled ? normalizeHexInputClient($('#terminalFontColorLight')?.value || '', '') : '';
    const terminalFontColors = terminalFontEnabled && terminalFontDark ? { dark: terminalFontDark, light: terminalFontLightRaw || invertHexColorClient(terminalFontDark) } : { dark: '', light: '' };
    const appearance = {
        ...previous,
        brandName: $('#brandNameInput').value.trim() || DEFAULT_BRAND_NAME,
        brandIcon: pendingBrandIcon || DEFAULT_BRAND_ICON,
        colorScheme,
        autoThemeEnabled,
        theme,
        customThemeMode: $('#customThemeMode')?.value || previous.customThemeMode || 'dark',
        customColors: readCustomThemeColors(),
        customCss: $('#customCssInput')?.value || '',
        customJs: $('#customJsInput')?.value || '',
        terminalBackground: {
            type: terminalBgSource,
            url: terminalBgSource === 'upload' ? ($('#terminalBgDataUrl')?.value || previous.terminalBackground?.url || '') : terminalBgSource === 'url' ? ($('#terminalBgUrl')?.value.trim() || '') : '',
            fit: $('#terminalBgFit')?.value || 'cover',
            opacity: Number($('#terminalBgOpacity')?.value || 0.35),
            blur: Number($('#terminalBgBlur')?.value || 0),
        },
        terminalFontColor: terminalFontColors.dark,
        terminalFontColors,
        rdp: {
            ...(previous.rdp || {}),
            defaultResolution: $('#rdpDefaultResolution')?.value || previous.rdp?.defaultResolution || '1920x1080',
            defaultQuality: normalizeRdpDefaultQuality($('#rdpDefaultQuality')?.value || previous.rdp?.defaultQuality || 'balanced'),
            defaultFps: Number($('#rdpDefaultFps')?.value || previous.rdp?.defaultFps || 30),
        },
    };
    settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ appearance }) });
    localStorage.removeItem('zephyr-theme');
    if (!autoThemeEnabled) localStorage.setItem('zephyr-theme', theme);
    applyAppearance(settings.appearance || appearance);
    applyTheme(getPreferredTheme());
    console.info('[appearance-client]', 'appearance saved', { brandName: appearance.brandName, customIcon: appearance.brandIcon !== DEFAULT_BRAND_ICON, autoThemeEnabled, theme });
    toast('个性化设置已保存');
}
async function resetAppearance() {
    const appearance = { ...getAppearance(), brandName: DEFAULT_BRAND_NAME, brandIcon: DEFAULT_BRAND_ICON, colorScheme: 'frost', customCss: '', customJs: '', terminalBackground: { type: 'none', url: '', fit: 'cover', opacity: 0.35, blur: 0 }, terminalFontColor: '', terminalFontColors: { dark: '', light: '' }, rdp: { defaultResolution: '1920x1080', defaultQuality: 'balanced', defaultFps: 60 } };
    settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ appearance }) });
    $('#brandIconFile').value = '';
    applyAppearance(settings.appearance || appearance);
    applyTheme(getPreferredTheme());
    console.info('[appearance-client]', 'brand reset to defaults');
    toast('名称和图标已重置');
}

function syncAppearanceSchemeControls(appearance = getAppearance()) {
    const scheme = appearance.colorScheme || 'frost';
    const colorSelect = $('#colorSchemeSelect');
    if (colorSelect) colorSelect.value = scheme;
    const customPanel = $('#customThemePanel');
    if (customPanel) customPanel.classList.toggle('force-hidden', scheme !== 'custom');
    // Appearance hint text was removed from the settings form.
    if ($('#themeModeSelect')) $('#themeModeSelect').value = appearance.autoThemeEnabled !== false || appearance.theme === 'auto' ? 'auto' : (appearance.theme === 'light' ? 'light' : 'dark');
    if ($('#customThemeMode')) $('#customThemeMode').value = appearance.customThemeMode || 'dark';
    const colors = normalizeCustomThemeColors(appearance.customColors || {});
    Object.keys(DEFAULT_CUSTOM_THEME_COLORS).forEach((key) => {
        const input = document.querySelector(`[data-custom-color="${key}"]`);
        if (input) setColorPickerValue(input, colors[key]);
    });
    if ($('#customCssInput')) $('#customCssInput').value = appearance.customCss || '';
    if ($('#customJsInput')) $('#customJsInput').value = appearance.customJs || '';
    const bg = appearance.terminalBackground || {};
    const bgType = bg.type || 'none';
    if ($('#terminalBgSource')) $('#terminalBgSource').value = bgType;
    if ($('#terminalBgUrl')) {
        $('#terminalBgUrl').value = bgType === 'url' ? (bg.url || '') : '';
        $('#terminalBgUrl').disabled = bgType !== 'url';
    }
    if ($('#terminalBgFile')) $('#terminalBgFile').disabled = bgType !== 'upload';
    if ($('#terminalBgDataUrl')) $('#terminalBgDataUrl').value = bgType === 'upload' ? (bg.url || '') : '';
    if ($('#terminalBgFit')) $('#terminalBgFit').value = bg.fit || 'cover';
    if ($('#terminalBgOpacity')) $('#terminalBgOpacity').value = String(bg.opacity ?? 0.35);
    if ($('#terminalBgOpacityValue')) $('#terminalBgOpacityValue').textContent = `${Math.round(Number(bg.opacity ?? 0.35) * 100)}%`;
    if ($('#terminalBgBlur')) $('#terminalBgBlur').value = String(bg.blur ?? 0);
    if ($('#terminalBgBlurValue')) $('#terminalBgBlurValue').textContent = `${Math.round(Number(bg.blur ?? 0))}px`;
    const terminalColors = normalizeTerminalFontColors(appearance);
    const terminalFontEnabled = !!terminalColors.dark;
    if ($('#terminalFontColorEnabled')) $('#terminalFontColorEnabled').checked = terminalFontEnabled;
    if ($('#terminalFontColor')) {
        setColorPickerValue($('#terminalFontColor'), terminalColors.dark || '#f4f4f6');
        setColorPickerEnabled($('#terminalFontColor'), terminalFontEnabled);
    }
    if ($('#terminalFontColorLight')) {
        const lightRaw = appearance.terminalFontColors?.light || '';
        setColorPickerValue($('#terminalFontColorLight'), lightRaw || (terminalColors.dark ? invertHexColorClient(terminalColors.dark) : '#1d1d1f'));
        if (!lightRaw) $('#terminalFontColorLight').value = '';
        setColorPickerEnabled($('#terminalFontColorLight'), terminalFontEnabled);
    }
    const rdp = appearance.rdp || {};
    if ($('#rdpDefaultResolution')) $('#rdpDefaultResolution').value = rdp.defaultResolution || '1920x1080';
    if ($('#rdpDefaultQuality')) $('#rdpDefaultQuality').value = normalizeRdpDefaultQuality(rdp.defaultQuality || 'balanced');
    if ($('#rdpDefaultFps')) $('#rdpDefaultFps').value = String(rdp.defaultFps || 60);
    if ($('#terminalBgPreview')) {
        const url = bg.type === 'url' ? ($('#terminalBgUrl')?.value.trim() || bg.url || '') : (bg.url || '');
        const hasBg = (bg.type === 'upload' || bg.type === 'url') && url;
        $('#terminalBgPreview').style.backgroundImage = hasBg ? `linear-gradient(rgba(0,0,0,.16), rgba(0,0,0,.16)), url("${String(url).replace(/"/g, '%22')}")` : '';
        $('#terminalBgPreview').textContent = hasBg ? '已选择背景' : '未设置背景';
    }
}
function readCustomThemeColors() {
    const out = {};
    Object.keys(DEFAULT_CUSTOM_THEME_COLORS).forEach((key) => { out[key] = document.querySelector(`[data-custom-color="${key}"]`)?.value || DEFAULT_CUSTOM_THEME_COLORS[key]; });
    return normalizeCustomThemeColors(out);
}

const COLOR_PICKER_PRESETS = ['#f5f5f7', '#ffffff', '#dedee3', '#1d1d1f', '#6e6e73', '#101114', '#1b1c20', '#303237', '#f7f3ef', '#e1d8cf', '#3f8f82', '#448e96', '#007aff', '#0a84ff', '#bf5a1f', '#ff453a', '#32d74b', '#ffd60a'];
let activeColorPickerInput = null;
let activeColorPickerHsv = { h: 210, s: 1, v: 1 };
function clampColorUnit(value) { return Math.max(0, Math.min(1, Number(value) || 0)); }
function normalizeHexInputClient(value, fallback = '#000000') {
    const text = String(value || '').trim();
    if (/^#[0-9a-f]{6}$/i.test(text)) return text.toLowerCase();
    if (/^[0-9a-f]{6}$/i.test(text)) return `#${text.toLowerCase()}`;
    return fallback;
}
function hexToRgbClient(hex) {
    const safe = normalizeHexInputClient(hex, '#000000').slice(1);
    return { r: parseInt(safe.slice(0, 2), 16), g: parseInt(safe.slice(2, 4), 16), b: parseInt(safe.slice(4, 6), 16) };
}
function rgbToHexClient({ r, g, b }) {
    const part = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
    return `#${part(r)}${part(g)}${part(b)}`;
}
function rgbToHsvClient(rgb) {
    const r = (Number(rgb.r) || 0) / 255;
    const g = (Number(rgb.g) || 0) / 255;
    const b = (Number(rgb.b) || 0) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    let h = 0;
    if (delta) {
        if (max === r) h = 60 * (((g - b) / delta) % 6);
        else if (max === g) h = 60 * (((b - r) / delta) + 2);
        else h = 60 * (((r - g) / delta) + 4);
    }
    if (h < 0) h += 360;
    return { h, s: max ? delta / max : 0, v: max };
}
function hexToHsvClient(hex) { return rgbToHsvClient(hexToRgbClient(hex)); }
function hsvToRgbClient(h, s, v) {
    const hue = (((Number(h) || 0) % 360) + 360) % 360;
    const sat = clampColorUnit(s);
    const val = clampColorUnit(v);
    const c = val * sat;
    const x = c * (1 - Math.abs((hue / 60) % 2 - 1));
    const m = val - c;
    let r = 0, g = 0, b = 0;
    if (hue < 60) [r, g, b] = [c, x, 0];
    else if (hue < 120) [r, g, b] = [x, c, 0];
    else if (hue < 180) [r, g, b] = [0, c, x];
    else if (hue < 240) [r, g, b] = [0, x, c];
    else if (hue < 300) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];
    return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}
function setColorPickerValue(input, value, { dispatch = false } = {}) {
    if (!input) return;
    const normalized = normalizeHexInputClient(value, input.value || '#000000');
    input.value = normalized;
    const picker = input.closest('[data-color-picker]');
    picker?.style.setProperty('--picker-color', normalized);
    picker?.querySelector('[data-color-swatch]')?.style.setProperty('--picker-color', normalized);
    if (dispatch) input.dispatchEvent(new Event('input', { bubbles: true }));
}
function syncColorPickerPanel(color) {
    const panel = document.getElementById('zephyrColorPickerPanel');
    if (!panel) return;
    const normalized = normalizeHexInputClient(color || activeColorPickerInput?.value, '#0a84ff');
    const next = hexToHsvClient(normalized);
    if (next.s === 0 && activeColorPickerHsv?.s > 0) next.h = activeColorPickerHsv.h;
    activeColorPickerHsv = next;
    panel.style.setProperty('--panel-hue', String(Math.round(next.h)));
    panel.style.setProperty('--panel-color', normalized);
    panel.style.setProperty('--panel-sv-x', `${Math.round(next.s * 1000) / 10}%`);
    panel.style.setProperty('--panel-sv-y', `${Math.round((1 - next.v) * 1000) / 10}%`);
    const hueInput = panel.querySelector('[data-color-hue]');
    if (hueInput && document.activeElement !== hueInput) hueInput.value = String(Math.round(next.h));
    const valueLabel = panel.querySelector('[data-color-value]');
    if (valueLabel) valueLabel.textContent = normalized;
}
function commitActiveColorPickerHsv() {
    if (!activeColorPickerInput) return;
    const hex = rgbToHexClient(hsvToRgbClient(activeColorPickerHsv.h, activeColorPickerHsv.s, activeColorPickerHsv.v));
    setColorPickerValue(activeColorPickerInput, hex, { dispatch: true });
    syncColorPickerPanel(hex);
}
function updateActiveColorFromSvPointer(event, surface) {
    if (!surface) return;
    const rect = surface.getBoundingClientRect();
    const s = clampColorUnit((event.clientX - rect.left) / Math.max(1, rect.width));
    const v = clampColorUnit(1 - ((event.clientY - rect.top) / Math.max(1, rect.height)));
    activeColorPickerHsv = { ...activeColorPickerHsv, s, v };
    commitActiveColorPickerHsv();
}
function ensureColorPickerPanel() {
    let panel = document.getElementById('zephyrColorPickerPanel');
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = 'zephyrColorPickerPanel';
    panel.className = 'zephyr-color-panel hidden';
    panel.innerHTML = `
        <div class="color-panel-current">
            <span class="color-panel-current-swatch" data-color-current aria-hidden="true"></span>
            <span class="color-panel-current-value" data-color-value>#0a84ff</span>
        </div>
        <div class="color-palette-sv" data-color-sv aria-label="拖动选择饱和度和明度" role="slider"><span class="color-palette-cursor" aria-hidden="true"></span></div>
        <label class="color-hue-row"><span>色相</span><input type="range" min="0" max="360" step="1" value="210" data-color-hue aria-label="色相"></label>
        <div class="color-panel-hint">拖动色盘/色相，或继续直接输入色号。</div>
        <div class="color-panel-grid" aria-label="常用颜色">${COLOR_PICKER_PRESETS.map((color) => `<button type="button" data-color-preset="${color}" style="--preset-color:${color}" aria-label="选择 ${color}"></button>`).join('')}</div>
        <div class="color-panel-actions"><button type="button" data-color-close>关闭</button></div>`;
    document.body.appendChild(panel);
    panel.addEventListener('click', (event) => {
        const preset = event.target.closest?.('[data-color-preset]')?.dataset.colorPreset;
        if (preset && activeColorPickerInput) {
            setColorPickerValue(activeColorPickerInput, preset, { dispatch: true });
            syncColorPickerPanel(preset);
            return;
        }
        if (event.target.closest?.('[data-color-close]')) closeColorPickerPanel();
    });
    panel.addEventListener('input', (event) => {
        const hue = event.target.closest?.('[data-color-hue]');
        if (!hue || !activeColorPickerInput) return;
        activeColorPickerHsv = { ...activeColorPickerHsv, h: Math.max(0, Math.min(360, Number(hue.value) || 0)) };
        commitActiveColorPickerHsv();
    });
    panel.addEventListener('pointerdown', (event) => {
        const surface = event.target.closest?.('[data-color-sv]');
        if (!surface || !activeColorPickerInput) return;
        event.preventDefault();
        updateActiveColorFromSvPointer(event, surface);
        surface.setPointerCapture?.(event.pointerId);
        const onMove = (ev) => { ev.preventDefault(); updateActiveColorFromSvPointer(ev, surface); };
        const onUp = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);
        };
        window.addEventListener('pointermove', onMove, { passive: false });
        window.addEventListener('pointerup', onUp, { once: true });
        window.addEventListener('pointercancel', onUp, { once: true });
    });
    return panel;
}
function closeColorPickerPanel() {
    document.getElementById('zephyrColorPickerPanel')?.classList.add('hidden');
    activeColorPickerInput = null;
}
function openColorPickerPanel(input, anchor) {
    if (!input || input.disabled) return;
    activeColorPickerInput = input;
    const panel = ensureColorPickerPanel();
    panel.classList.remove('hidden');
    syncColorPickerPanel(input.value || '#000000');
    const rect = anchor.getBoundingClientRect();
    const margin = 10;
    const width = panel.offsetWidth || 288;
    const height = panel.offsetHeight || 340;
    const left = Math.min(window.innerWidth - width - margin, Math.max(margin, rect.left));
    const top = Math.min(window.innerHeight - height - margin, Math.max(margin, rect.bottom + 8));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
}
function setupColorPickers() {
    if (setupColorPickers._bound) return;
    setupColorPickers._bound = true;
    $$('[data-color-picker] .color-hex-input').forEach((input) => {
        setColorPickerValue(input, input.value || '#000000');
        input.addEventListener('input', () => {
            const text = String(input.value || '').trim();
            if (/^#?[0-9a-f]{6}$/i.test(text)) {
                setColorPickerValue(input, text);
                if (activeColorPickerInput === input) syncColorPickerPanel(input.value);
            }
        });
        input.addEventListener('blur', () => {
            setColorPickerValue(input, input.value || '#000000');
            if (activeColorPickerInput === input) syncColorPickerPanel(input.value);
        });
    });
    document.addEventListener('click', (event) => {
        const swatch = event.target.closest?.('[data-color-swatch]');
        if (swatch) {
            const input = swatch.closest('[data-color-picker]')?.querySelector('.color-hex-input');
            openColorPickerPanel(input, swatch);
            return;
        }
        if (activeColorPickerInput && event.target.closest?.('[data-color-picker]')?.querySelector('.color-hex-input') === activeColorPickerInput) return;
        if (!event.target.closest?.('#zephyrColorPickerPanel')) closeColorPickerPanel();
    });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeColorPickerPanel(); });
}
function readTerminalBackgroundAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        if (!file) return resolve('');
        if (!/^image\/(png|jpeg|jpg|gif|webp|svg\+xml|avif)$/i.test(file.type)) return reject(new Error('终端背景仅支持 PNG/JPEG/GIF/WebP/AVIF/SVG'));
        if (file.size > 12 * 1024 * 1024) return reject(new Error('终端背景图片不能超过 12MB'));
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('读取终端背景失败'));
        reader.readAsDataURL(file);
    });
}
function setupAppearanceControls() {
    setupColorPickers();
    $('#colorSchemeSelect')?.addEventListener('change', () => {
        const appearance = { ...getAppearance(), colorScheme: $('#colorSchemeSelect').value, customThemeMode: $('#customThemeMode')?.value || 'dark', customColors: readCustomThemeColors(), customCss: $('#customCssInput')?.value || '', customJs: $('#customJsInput')?.value || '' };
        settings.appearance = appearance;
        applyTheme(getPreferredTheme());
        syncAppearanceSchemeControls(appearance);
    });
    $('#themeModeSelect')?.addEventListener('change', () => { const mode = $('#themeModeSelect').value; settings.appearance = { ...getAppearance(), theme: mode, autoThemeEnabled: mode === 'auto' }; if ($('#autoThemeEnabled')) $('#autoThemeEnabled').checked = mode === 'auto'; applyTheme(getPreferredTheme()); });
    $('#autoThemeEnabled')?.addEventListener('change', () => { const auto = $('#autoThemeEnabled').checked; const mode = auto ? 'auto' : ($('#themeModeSelect')?.value === 'light' ? 'light' : 'dark'); settings.appearance = { ...getAppearance(), theme: mode, autoThemeEnabled: auto }; if ($('#themeModeSelect')) $('#themeModeSelect').value = mode; applyTheme(getPreferredTheme()); });
    $('#customThemeMode')?.addEventListener('change', () => { settings.appearance = { ...getAppearance(), customThemeMode: $('#customThemeMode').value }; applyTheme(getPreferredTheme()); });
    $$('.custom-color-grid [data-custom-color]').forEach((input) => input.addEventListener('input', () => {
        settings.appearance = { ...getAppearance(), colorScheme: 'custom', customColors: readCustomThemeColors() };
        applyZephyrColorScheme(settings.appearance, { theme: getPreferredTheme(), page: 'app', executeCustomJs: false });
        setFavicon(pendingBrandIcon || DEFAULT_BRAND_ICON);
    }));
    $('#terminalBgSource')?.addEventListener('change', () => syncAppearanceSchemeControls({ ...getAppearance(), terminalBackground: { ...(getAppearance().terminalBackground || {}), type: $('#terminalBgSource').value } }));
    $('#terminalBgUrl')?.addEventListener('input', () => syncAppearanceSchemeControls({ ...getAppearance(), terminalBackground: { type: 'url', url: $('#terminalBgUrl').value.trim(), fit: $('#terminalBgFit')?.value || 'cover', opacity: Number($('#terminalBgOpacity')?.value || 0.35), blur: Number($('#terminalBgBlur')?.value || 0) } }));
    $('#terminalFontColorEnabled')?.addEventListener('change', () => {
        const enabled = $('#terminalFontColorEnabled').checked;
        setColorPickerEnabled($('#terminalFontColor'), enabled);
        setColorPickerEnabled($('#terminalFontColorLight'), enabled);
    });
    $('#terminalBgOpacity')?.addEventListener('input', () => { if ($('#terminalBgOpacityValue')) $('#terminalBgOpacityValue').textContent = `${Math.round(Number($('#terminalBgOpacity').value || 0.35) * 100)}%`; });
    $('#terminalBgBlur')?.addEventListener('input', () => { if ($('#terminalBgBlurValue')) $('#terminalBgBlurValue').textContent = `${Math.round(Number($('#terminalBgBlur').value || 0))}px`; });
    $('#terminalBgFile')?.addEventListener('change', async (e) => { try { const dataUrl = await readTerminalBackgroundAsDataUrl(e.target.files?.[0]); if (!dataUrl) return; $('#terminalBgDataUrl').value = dataUrl; $('#terminalBgSource').value = 'upload'; syncAppearanceSchemeControls({ ...getAppearance(), terminalBackground: { type: 'upload', url: dataUrl, fit: $('#terminalBgFit')?.value || 'cover', opacity: Number($('#terminalBgOpacity')?.value || 0.35), blur: Number($('#terminalBgBlur')?.value || 0) } }); toast('终端背景已载入，保存外观后生效'); } catch (err) { e.target.value = ''; toast(err.message); } });
}
function safeJsonParseClient(value, fallback = null) { try { return JSON.parse(String(value || '').trim()); } catch (_) { return fallback; } }
function escapeAttr(str) { return escapeHtml(str).replace(/'/g, '&#39;'); }
function safeHref(url = '') {
    const value = String(url || '').trim();
    if (/^(https?:|\/|#|blob:)/i.test(value) || /^data:image\//i.test(value)) return value;
    return '#';
}
function codeLangExt(lang = '') {
    const key = String(lang || '').toLowerCase().replace(/^language-/, '');
    const map = { js:'js', javascript:'js', ts:'ts', typescript:'ts', json:'json', yaml:'yaml', yml:'yaml', html:'html', htm:'html', xml:'xml', css:'css', sh:'sh', shell:'sh', bash:'sh', python:'py', py:'py', markdown:'md', md:'md', sql:'sql', text:'txt', plaintext:'txt' };
    return map[key] || (key ? key.replace(/[^a-z0-9_.-]/g, '').slice(0, 16) : 'txt');
}
function parseCodeFenceInfo(info = '') {
    const raw = String(info || '').trim();
    const parts = raw.split(/\s+/).filter(Boolean);
    let lang = '', filename = '';
    for (const part of parts) {
        const fm = /^(?:file(?:name)?|path)=['"]?(.+?)['"]?$/i.exec(part);
        if (fm) { filename = fm[1].split(/[\\/]/).pop(); continue; }
        if (!lang && /^[A-Za-z0-9_+.#-]+$/.test(part) && !part.includes('.')) { lang = part; continue; }
        if (!filename && /\.[A-Za-z0-9]{1,8}$/.test(part)) filename = part.split(/[\\/]/).pop();
    }
    if (!lang && filename && filename.includes('.')) lang = filename.split('.').pop();
    lang = String(lang || 'text').toLowerCase().replace(/^language-/, '');
    if (!filename) filename = `snippet.${codeLangExt(lang) || 'txt'}`;
    return { lang, filename };
}
function codeMimeType(filename = '', lang = '') {
    const ext = String(filename || '').split('.').pop().toLowerCase() || codeLangExt(lang);
    if (ext === 'html' || ext === 'htm') return 'text/html;charset=utf-8';
    if (ext === 'json') return 'application/json;charset=utf-8';
    if (ext === 'yaml' || ext === 'yml') return 'application/yaml;charset=utf-8';
    if (ext === 'css') return 'text/css;charset=utf-8';
    if (ext === 'js' || ext === 'mjs') return 'text/javascript;charset=utf-8';
    if (ext === 'md') return 'text/markdown;charset=utf-8';
    return 'text/plain;charset=utf-8';
}
function renderInlineMarkdown(text = '') {
    let s = String(text || '');
    s = s.replace(/!\[([^\]]*)\]\(([^\s)]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_, alt, url) => `<img class="ai-md-image" src="${escapeAttr(safeHref(url))}" alt="${escapeAttr(alt)}">`);
    s = s.replace(/\[([^\]]+)\]\(([^\s)]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_, label, url) => `<a href="${escapeAttr(safeHref(url))}" target="_blank" rel="noopener">${label}</a>`);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>');
    return s;
}
function renderCodeBlockHtml(code = '', info = '', enhanced = false) {
    const meta = parseCodeFenceInfo(info);
    const cleanCode = String(code || '').replace(/\n$/, '');
    const escapedCode = escapeHtml(cleanCode);
    if (!enhanced) return `<pre><code class="language-${escapeAttr(meta.lang)}">${escapedCode}</code></pre>`;
    const id = `ai-code-${++aiCodeBlockSeq}`;
    aiCodeBlockStore.set(id, { code: cleanCode, lang: meta.lang, filename: meta.filename });
    const isHtml = meta.lang === 'html' || /\.html?$/i.test(meta.filename);
    return `<div class="ai-code-block" data-ai-code-id="${escapeAttr(id)}"><div class="ai-code-toolbar"><span class="ai-code-name"><i>⌘</i>${escapeHtml(meta.filename || meta.lang || 'code')}</span><div class="ai-code-actions">${isHtml ? `<button type="button" data-ai-code-preview="${escapeAttr(id)}">▶ 预览</button>` : ''}<button type="button" data-ai-code-copy="${escapeAttr(id)}">⧉ 复制</button><button type="button" data-ai-code-download="${escapeAttr(id)}">⇩ 下载</button></div></div><pre><code class="language-${escapeAttr(meta.lang)}">${escapedCode}</code></pre></div>`;
}
function renderMarkdownBlocks(text = '', codeBlocks = []) {
    const lines = String(text || '').split('\n'), out = [];
    const token = (line) => /^§§CODE(\d+)§§$/.exec(String(line || '').trim());
    const tableSep = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line || '');
    const splitTable = (line) => String(line || '').trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((x) => x.trim());
    const special = (i) => { const line = lines[i] || ''; return !line.trim() || token(line) || /^#{1,6}\s+/.test(line) || /^\s*>\s?/.test(line) || /^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line) || /^\s*---+\s*$/.test(line) || (line.includes('|') && tableSep(lines[i + 1] || '')); };
    for (let i = 0; i < lines.length;) {
        const line = lines[i] || '', tk = token(line);
        if (tk) { out.push(codeBlocks[Number(tk[1])] || ''); i++; continue; }
        if (!line.trim()) { i++; continue; }
        const h = /^(#{1,6})\s+(.+)$/.exec(line);
        if (h) { const n = Math.min(6, h[1].length); out.push(`<h${n}>${renderInlineMarkdown(h[2].trim())}</h${n}>`); i++; continue; }
        if (/^\s*---+\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
        if (line.includes('|') && tableSep(lines[i + 1] || '')) {
            const heads = splitTable(line); i += 2; const rows = [];
            while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { rows.push(splitTable(lines[i])); i++; }
            out.push(`<div class="ai-md-table-wrap"><table><thead><tr>${heads.map((x) => `<th>${renderInlineMarkdown(x)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${heads.map((_, idx) => `<td>${renderInlineMarkdown(r[idx] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`); continue;
        }
        if (/^\s*>\s?/.test(line)) { const q=[]; while (i < lines.length && /^\s*>\s?/.test(lines[i] || '')) q.push((lines[i++] || '').replace(/^\s*>\s?/, '')); out.push(`<blockquote>${q.map(renderInlineMarkdown).join('<br>')}</blockquote>`); continue; }
        if (/^\s*[-*+]\s+/.test(line)) { const a=[]; while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i] || '')) a.push((lines[i++] || '').replace(/^\s*[-*+]\s+/, '')); out.push(`<ul>${a.map((x)=>`<li>${renderInlineMarkdown(x)}</li>`).join('')}</ul>`); continue; }
        if (/^\s*\d+[.)]\s+/.test(line)) { const a=[]; while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i] || '')) a.push((lines[i++] || '').replace(/^\s*\d+[.)]\s+/, '')); out.push(`<ol>${a.map((x)=>`<li>${renderInlineMarkdown(x)}</li>`).join('')}</ol>`); continue; }
        const para=[]; while (i < lines.length && !special(i)) para.push(lines[i++]); if (para.length) out.push(`<p>${para.map(renderInlineMarkdown).join('<br>')}</p>`);
    }
    return out.join('\n');
}
function renderMarkdown(md, options = {}) {
    const enhanced = !!options.enhancedCode;
    const codeBlocks = [];
    let source = String(md || '').replace(/\r\n?/g, '\n');
    source = source.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (_, info, code) => { const idx = codeBlocks.length; codeBlocks.push(renderCodeBlockHtml(code, info, enhanced)); return `\n§§CODE${idx}§§\n`; });
    return renderMarkdownBlocks(escapeHtml(source), codeBlocks);
}
function splitCsv(value) { return String(value || '').split(/[\n,，]+/).map((x) => x.trim()).filter(Boolean); }
function fmtTime(ts) { return ts ? new Date(ts).toLocaleString() : '从未连接'; }
function requestSensitiveSecret(actionText = '查看已保存敏感信息') {
    const usingTotp = !!securityStatus.user?.totpEnabled;
    const message = usingTotp
        ? `${actionText}\n请输入 6 位 TOTP 动态验证码：`
        : `${actionText}\n请输入当前登录密码：`;
    const secret = prompt(message);
    if (secret === null) throw new Error('已取消验证');
    if (!String(secret).trim()) throw new Error(usingTotp ? '请输入动态验证码' : '请输入当前登录密码');
    console.debug('[secret-open]', 'sensitive reveal requested', { actionText, authType: usingTotp ? 'totp' : 'password' });
    return secret;
}
function syncTerminalSmartbarTop() {
    const nav = $('.main-nav');
    const smartbar = $('#sessionTabs');
    if (!nav || !smartbar) return;
    const smartbarTop = `${Math.round(nav.getBoundingClientRect().bottom)}px`;
    smartbar.style.setProperty('--smartbar-top', smartbarTop);
    document.documentElement.style.setProperty('--smartbar-top', smartbarTop);
}
function syncTerminalShelfLineState() {
    const nav = $('.main-nav');
    const smartbar = $('#sessionTabs');
    if (!nav || !smartbar) return;
    const dockInteractive = terminalSmartbarOpen || terminalSmartbarClosing;
    const terminalActive = document.body.classList.contains('terminal-mode');
    const shelfSettled = terminalActive;
    nav.classList.toggle('terminal-shelf-settled', shelfSettled);
    nav.classList.toggle('terminal-shelf-dock-open', terminalActive && dockInteractive);
    smartbar.classList.toggle('shelf-line-active', shelfSettled);
    smartbar.classList.toggle('dock-open', dockInteractive);
}
function scheduleTerminalSmartbarTopSync(reason = 'smartbar-top') {
    if (Array.isArray(scheduleTerminalSmartbarTopSync._timers)) scheduleTerminalSmartbarTopSync._timers.forEach((timer) => window.clearTimeout(timer));
    const run = () => requestAnimationFrame(() => { syncTerminalSmartbarTop(); syncTerminalShelfLineState(); });
    scheduleTerminalSmartbarTopSync._timers = [0, 32, 80, 140, 220, 340, 500, 680].map((delay) => window.setTimeout(run, delay));
    console.debug('[terminal-smartbar]', 'scheduled top sync', { reason });
}
function closeTerminalSmartbarForViewLeave() {
    window.clearTimeout(terminalSmartbarTimer);
    window.clearTimeout(setTerminalSmartbarOpen._closeTimer);
    terminalSmartbarOpen = false;
    terminalSmartbarClosing = false;
    terminalSmartbarPickerOpen = false;
    document.querySelectorAll('#terminalWorkspace .terminal-frame').forEach((frame) => frame.style.pointerEvents = '');
    const pickerLayer = document.getElementById('smartbarPickerLayer');
    if (pickerLayer) pickerLayer.innerHTML = '';
    const root = $('#sessionTabs');
    root?.classList.remove('open', 'closing', 'shelf-line-active', 'dock-open');
    $('.main-nav')?.classList.remove('terminal-shelf-settled', 'terminal-shelf-dock-open');
}
function switchView(name) {
    const target = name === 'ai' ? 'dashboard' : name;
    currentAppView = target;
    rememberLastAppView(target);
    if (target !== 'notes' && notesController?.state?.dirty) {
        notesController.flushSave().catch(() => {});
    }
    $$('.nav-tab').forEach((b) => b.classList.toggle('active', b.dataset.view === target));
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${target}`));
    const wasTerminal = document.body.classList.contains('terminal-mode');
    const enteringTerminal = target === 'terminal' && !wasTerminal;
    const leavingTerminal = target !== 'terminal' && wasTerminal;
    if (leavingTerminal) closeTerminalSmartbarForViewLeave();
    document.body.classList.toggle('terminal-mode', target === 'terminal');
    document.body.classList.toggle('terminal-mode-entering', enteringTerminal);
    window.clearTimeout(switchView._navTimer);
    if (target === 'terminal') {
        renderTerminalSmartbar();
        scheduleTerminalSmartbarTopSync(enteringTerminal ? 'switch-enter-terminal' : 'switch-terminal');
        switchView._navTimer = window.setTimeout(() => {
            document.body.classList.remove('terminal-mode-entering');
            syncTerminalSmartbarTop();
            syncTerminalShelfLineState();
        }, 680);
        rememberCompactTerminalKeyboardBaseline('switch-view-terminal');
        scheduleTerminalLayoutStabilize('switch-view-terminal', { focus: true });
    } else {
        document.body.classList.remove('terminal-mode-entering');
        if (leavingTerminal) scheduleTerminalSmartbarTopSync('switch-leave-terminal');
    }
    if (target === 'notes') {
        notesController?.activate?.().catch((err) => toast(err.message || '加载笔记失败'));
    }
    scheduleWorkspaceSave('view-change');
}
function parseTags(v) { return String(v || '').split(',').map((x) => x.trim()).filter(Boolean); }
function base64urlToBuffer(value) { const s = String(value).replace(/-/g, '+').replace(/_/g, '/'); return Uint8Array.from(atob(s + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0)); }
function bufferToBase64url(buffer) { return btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }

function allTags() { return [...new Set(connections.flatMap((c) => c.tags || []))].sort(); }
const CONNECTION_FILTER_KEY = 'zephyr.connection.filters.v1';
function readConnectionFilters() {
    try { return JSON.parse(localStorage.getItem(CONNECTION_FILTER_KEY) || '{}') || {}; } catch { return {}; }
}
function saveConnectionFilters() {
    const data = {
        q: $('#searchInput')?.value || '',
        protocol: $('#protocolFilter')?.value || 'all',
        tag: $('#tagFilter')?.value || 'all',
        sort: $('#sortSelect')?.value || 'createdAt',
    };
    try { localStorage.setItem(CONNECTION_FILTER_KEY, JSON.stringify(data)); } catch {}
}
function restoreConnectionFilters() {
    const data = readConnectionFilters();
    if ($('#searchInput')) $('#searchInput').value = data.q || '';
    if ($('#protocolFilter')) $('#protocolFilter').value = data.protocol || 'all';
    if ($('#sortSelect')) $('#sortSelect').value = data.sort || 'createdAt';
    if ($('#tagFilter')) $('#tagFilter').dataset.savedValue = data.tag || 'all';
}
function refreshTagFilter() {
    const select = $('#tagFilter');
    const old = select.dataset.savedValue || select.value || 'all';
    select.innerHTML = '<option value="all">全部标签</option>' + allTags().map((t) => `<option ${old === t ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('');
    if (old === 'all' || allTags().includes(old)) select.value = old;
    else select.value = 'all';
    delete select.dataset.savedValue;
}
function filteredConnections() {
    const q = $('#searchInput').value.trim().toLowerCase(), proto = $('#protocolFilter').value, tag = $('#tagFilter').value, sort = $('#sortSelect').value;
    const list = connections.filter((c) => [c.name, c.host, c.remark, c.username, (c.tags || []).join(' ')].join(' ').toLowerCase().includes(q) && (proto === 'all' || c.protocol === proto) && (tag === 'all' || (c.tags || []).includes(tag)));
    return list.sort((a, b) => sort === 'name' ? String(a.name).localeCompare(String(b.name), 'zh-CN') : sort === 'protocol' ? String(a.protocol).localeCompare(String(b.protocol)) : (b[sort] || 0) - (a[sort] || 0));
}
function renderConnections() {
    refreshTagFilter();
    $('#connectionTitle').textContent = `连接列表 (${connections.length})`;
    const list = filteredConnections();
    $('#connectionGrid').innerHTML = list.length ? list.map((c) => {
        const caps = Array.isArray(c.capabilities) ? c.capabilities : [];
        const canEdit = !caps.length || caps.includes('edit');
        const canDelete = !caps.length || caps.includes('delete');
        const canUse = !caps.length || caps.includes('use') || caps.includes('control');
        const sourceBadge = c.owner === 'shared'
            ? '<span class="connection-source-badge shared">共享</span>'
            : (c.owner === 'own' ? '<span class="connection-source-badge">我的</span>' : '');
        return `<article class="connection-card"><div class="card-top"><span class="protocol-badge">${escapeHtml(c.protocol)}</span><div class="card-top-meta">${sourceBadge}<span class="last-time">${fmtTime(c.lastConnectedAt)}</span></div></div>
        <h2>${escapeHtml(c.name)}</h2><p class="host-line">${escapeHtml(c.host)}:${escapeHtml(c.port)} · ${c.connectionMode === 'proxy' ? '代理' : c.connectionMode === 'jump' ? '跳板机' : '直连'}</p>
        <div class="tag-row">${(c.tags || []).map((t) => `<span>${escapeHtml(t)}</span>`).join('')}</div><div class="remark-md">${renderMarkdown(c.remark || '暂无备注')}</div>
        <div class="card-actions">${canEdit ? `<button class="tool-btn" data-edit="${c.id}">编辑</button>` : ''}${canDelete ? `<button class="tool-btn danger" data-delete="${c.id}">删除</button>` : ''}${canUse ? `<button class="btn btn-primary" data-connect="${c.id}">连接</button>` : '<button class="btn btn-primary" disabled title="仅观察">只读</button>'}</div></article>`;
    }).join('') : '<div class="empty-card">暂无连接，点击右上角添加新连接。</div>';
    $('#activityList').innerHTML = activities.length ? activities.map((a) => `<div class="activity-item"><span>${fmtTime(a.time)}</span><b>${escapeHtml(a.message)}</b></div>`).join('') : '<div class="muted">暂无活动</div>';
    renderRemoteServers(); renderJumpOptions();
}
async function loadConnections() { const data = await api('/api/connections'); connections = data.connections || []; activities = data.activities || []; renderConnections(); }
function waitForConnectionCardExit(card, connectionId) {
    if (!card) return Promise.resolve();
    card.querySelectorAll('button').forEach((btn) => { btn.disabled = true; });
    card.classList.add('deleting');
    console.debug('[connection-card]', 'delete exit animation start', { connectionId });
    return new Promise((resolve) => {
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            card.removeEventListener('animationend', finish);
            console.debug('[connection-card]', 'delete exit animation end', { connectionId });
            resolve();
        };
        card.addEventListener('animationend', finish, { once: true });
        window.setTimeout(finish, 380);
    });
}

function normalizeSelectedRouteIds(selected = '') {
    return Array.isArray(selected) ? selected.map(String).filter(Boolean) : String(selected || '').split(',').map((v) => v.trim()).filter(Boolean);
}
function normalizeRouteRowIds(selected = '') {
    const list = Array.isArray(selected) ? selected.map((v) => String(v || '')) : normalizeSelectedRouteIds(selected);
    return list.length ? list : [''];
}
function jumpConnectionOptions(selected = '') {
    const selectedId = String(selected || '');
    const currentEditingId = String(editingId || '');
    const list = connections.filter((c) => String(c.protocol || 'SSH').toUpperCase() === 'SSH' && String(c.id) !== currentEditingId);
    return '<option value="">请选择跳板机</option>' + list.map((c) => `<option value="${c.id}" ${selectedId === String(c.id) ? 'selected' : ''}>${escapeHtml(c.name)} (${escapeHtml(c.host)}:${escapeHtml(c.port)})</option>`).join('');
}
function renderJumpRouteRows(selectedIds = []) {
    const list = normalizeRouteRowIds(selectedIds);
    $('#jumpRouteList').innerHTML = list.map((id, index) => `
        <div class="jump-route-row" data-jump-route-row>
            <label>跳板机 ${index + 1}:</label>
            <select data-jump-route-select>${jumpConnectionOptions(id)}</select>
            <button type="button" class="jump-route-remove" data-remove-jump-route title="移除跳板机">×</button>
        </div>`).join('');
    console.debug('[route-ui]', 'render jump rows', { selectedIds: list, availableSshConnections: connections.filter((c) => String(c.protocol || 'SSH').toUpperCase() === 'SSH' && String(c.id) !== String(editingId || '')).length });
}
function setRouteMode(mode = 'direct', selected = '') {
    const nextMode = ['direct', 'proxy', 'jump'].includes(mode) ? mode : 'direct';
    $('#connMode').value = nextMode;
    $$('.route-type-tab').forEach((btn) => {
        const active = btn.dataset.routeMode === nextMode;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    $('#proxyRouteConfig')?.classList.toggle('force-hidden', nextMode !== 'proxy');
    $('#jumpRouteConfig')?.classList.toggle('force-hidden', nextMode !== 'jump');
    updateRouteOptions(nextMode, selected);
}
function renderSshKeyOptions(selected = '') {
    const select = $('#connSshKey');
    if (!select) return;
    const selectedId = String(selected || '');
    select.innerHTML = '<option value="">不使用密钥库</option>' + sshKeys.map((k) => `<option value="${k.id}" ${selectedId === String(k.id) ? 'selected' : ''}>${escapeHtml(k.name)}${k.hasPassphrase ? '（有口令）' : ''}</option>`).join('');
    select.value = selectedId;
    console.debug('[ssh-key-ui]', 'render connection key options', { selectedId, keyCount: sshKeys.length });
}

function updateRouteOptions(mode = $('#connMode').value, selected = '') {
    const selectedIds = normalizeSelectedRouteIds(selected);
    const route = $('#connRoute');
    if (route) {
        route.innerHTML = '<option value="">请选择代理服务器</option>' + proxies.map((p) => `<option value="${p.id}" ${selectedIds.includes(String(p.id)) ? 'selected' : ''}>${escapeHtml(p.name)} (${escapeHtml(p.host)}:${escapeHtml(p.port)})</option>`).join('');
        route.value = mode === 'proxy' ? (selectedIds[0] || '') : '';
    }
    if (mode === 'jump') renderJumpRouteRows(selectedIds);
    console.debug('[route-ui]', 'update route options', { mode, selectedIds, proxyCount: proxies.length, connectionCount: connections.length });
}
function addJumpRouteRow() {
    const ids = $$('#jumpRouteList [data-jump-route-select]').map((el) => el.value);
    ids.push('');
    console.debug('[route-ui]', 'add jump row', { before: ids.slice(0, -1), after: ids });
    renderJumpRouteRows(ids);
}
function updateConnectionSecretRevealChrome(protocol = $('#connProtocol')?.value || 'SSH') {
    const revealGroup = $('#connSecretRevealGroup');
    const revealBtn = $('#revealConnSecrets');
    const hint = $('#connSecretRevealHint');
    const isSsh = String(protocol || 'SSH').toUpperCase() === 'SSH';
    const hasSavedSecret = !!editingId && (
        !!editingConnectionSecretState.hasPassword
        || (isSsh && (!!editingConnectionSecretState.hasPrivateKey || !!editingConnectionSecretState.sshKeyId))
    );
    revealGroup?.classList.toggle('force-hidden', !hasSavedSecret);
    if (revealBtn) revealBtn.textContent = isSsh ? '查看已保存密码/私钥' : '查看已保存密码';
    if (hint) hint.textContent = isSsh
        ? '编辑时默认隐藏敏感信息；留空或保持星号不会覆盖已保存凭据。'
        : '编辑时默认隐藏已保存密码；留空或保持星号不会覆盖已保存密码。';
}
function updateProtocolFields({ preservePort = true } = {}) {
    const protocol = String($('#connProtocol')?.value || 'SSH').toUpperCase();
    const portInput = $('#connPort');
    const usernameInput = $('#connUsername');
    const defaultPort = protocol === 'RDP' ? 3389 : protocol === 'VNC' ? 5900 : protocol === 'TELNET' ? 23 : 22;
    if (portInput && (!preservePort || !Number(portInput.value))) portInput.value = defaultPort;
    if (usernameInput) {
        usernameInput.required = protocol === 'SSH';
        usernameInput.placeholder = protocol === 'TELNET'
            ? '用户名（可选，终端内认证）'
            : protocol === 'VNC'
                ? '用户名（可选，取决于 VNC 服务）'
                : '用户名';
    }
    $('#connSshKey')?.closest('.form-group')?.classList.toggle('force-hidden', protocol !== 'SSH');
    $('#connPrivateKey')?.closest('.form-group')?.classList.toggle('force-hidden', protocol !== 'SSH');
    // Telnet is cleartext and has no SSH jump/proxy chain support yet.
    $('#connPassword')?.closest('.form-group')?.classList.toggle('force-hidden', protocol === 'TELNET');
    $('#telnetPlaintextBanner')?.classList.toggle('force-hidden', protocol !== 'TELNET');
    $('#telnetUsernameHint')?.classList.toggle('force-hidden', protocol !== 'TELNET');
    $('#rdpSettingsPanel')?.classList.toggle('force-hidden', protocol !== 'RDP');
    $('#rdpDomainGroup')?.classList.toggle('force-hidden', protocol !== 'RDP');
    $('.advanced-route-panel')?.classList.toggle('force-hidden', protocol === 'TELNET');
    if (protocol === 'TELNET') setRouteMode?.('direct');
    // Telnet auth is in-band; never surface stored-secret chrome.
    if (protocol === 'TELNET') $('#connSecretRevealGroup')?.classList.add('force-hidden');
    else updateConnectionSecretRevealChrome(protocol);
    console.debug('[conn-protocol]', 'protocol fields updated', { protocol, defaultPort, usernameRequired: protocol === 'SSH' });
}
function setConnectionTestLatency(text = '', state = '') {
    const el = $('#connectionTestLatency');
    if (!el) return;
    el.textContent = text;
    el.dataset.state = state;
}
function viewportMetrics() {
    const vv = window.visualViewport;
    return {
        width: Math.round(vv?.width || window.innerWidth || document.documentElement.clientWidth || 1),
        height: Math.round(vv?.height || window.innerHeight || document.documentElement.clientHeight || 1),
        left: Math.round(vv?.offsetLeft || 0),
        top: Math.round(vv?.offsetTop || 0)
    };
}
function connectionTransitionTargetRect(trigger = connectionModalTrigger) {
    const source = trigger?.isConnected ? trigger : $('#addConnectionBtn');
    const rect = source?.getBoundingClientRect?.();
    if (rect?.width && rect?.height) return { left: rect.left, top: rect.top, width: rect.width, height: rect.height, source };
    const viewport = viewportMetrics();
    return { left: viewport.width - 86, top: 82, width: 74, height: 74, source: null };
}
function nextAnimationFrame(fn) {
    requestAnimationFrame(() => requestAnimationFrame(fn));
}
function getConnectionTransitionShadowLayer() {
    let shadow = $('#connectionTransitionShadow');
    if (!shadow) {
        shadow = document.createElement('div');
        shadow.id = 'connectionTransitionShadow';
        shadow.className = 'connection-transition-shadow';
        shadow.style.position = 'fixed';
        shadow.style.inset = 'auto';
        shadow.style.background = 'transparent';
        shadow.style.border = '0';
        shadow.style.boxSizing = 'border-box';
        shadow.style.pointerEvents = 'none';
        shadow.style.contain = 'layout paint style';
        shadow.style.willChange = 'left, top, width, height, border-radius, box-shadow, opacity';
        document.body.appendChild(shadow);
    }
    return shadow;
}
function resetConnectionTransitionShadow(shadow = $('#connectionTransitionShadow')) {
    if (!shadow) return;
    shadow.style.visibility = 'hidden';
    shadow.style.transition = 'none';
    shadow.style.opacity = '0';
    shadow.style.left = '';
    shadow.style.top = '';
    shadow.style.width = '';
    shadow.style.height = '';
    shadow.style.borderRadius = '';
    shadow.style.transform = '';
}
function setConnectionLayerRect(layer, rect) {
    layer.style.left = `${rect.left}px`;
    layer.style.top = `${rect.top}px`;
    layer.style.width = `${rect.width}px`;
    layer.style.height = `${rect.height}px`;
}
function syncConnectionLayerVisual(layer, source) {
    if (!layer || !source?.isConnected) {
        layer.innerHTML = '';
        layer.removeAttribute('data-has-source-visual');
        return;
    }
    const style = getComputedStyle(source);
    const shellBackground = `
        radial-gradient(circle at 18% 0%, color-mix(in srgb, var(--accent) 8%, transparent), transparent 30%),
        radial-gradient(circle at 82% 8%, color-mix(in srgb, var(--success) 6%, transparent), transparent 28%),
        var(--surface)
    `;
    layer.innerHTML = `<span class="connection-transition-source-visual">${source.innerHTML}</span>`;
    layer.dataset.hasSourceVisual = 'true';
    layer.style.background = shellBackground;
    layer.style.border = '1px solid color-mix(in srgb, var(--border) 50%, transparent)';
    layer.style.color = style.color;
    layer.style.font = style.font;
    layer.style.letterSpacing = style.letterSpacing;
    layer.style.textAlign = style.textAlign;
    layer.style.padding = '0';
    layer.style.display = 'inline-flex';
    layer.style.alignItems = 'center';
    layer.style.justifyContent = 'center';
    layer.style.gap = style.gap;
    layer.style.whiteSpace = 'nowrap';

    const visual = layer.querySelector('.connection-transition-source-visual');
    if (visual) {
        visual.style.background = style.background;
        visual.style.border = style.border;
        visual.style.borderRadius = style.borderRadius;
        visual.style.color = style.color;
        visual.style.font = style.font;
        visual.style.letterSpacing = style.letterSpacing;
        visual.style.padding = style.padding;
        visual.style.gap = style.gap;
    }
    console.debug('[connection-transition]', 'source visual synced', {
        sourceRole: source.id === 'addConnectionBtn' ? 'add' : source.matches('[data-edit]') ? 'edit' : 'other',
        sourceBackground: style.background,
        shellBackground: 'neutral-surface'
    });
}
function applyConnectionLayerSourceChrome(layer, source, { revealVisual = false } = {}) {
    if (!layer || !source?.isConnected) return;

    const style = getComputedStyle(source);
    const background = style.background && style.background !== 'none'
        ? style.background
        : style.backgroundColor;

    layer.style.background = background || style.backgroundColor || 'var(--surface)';
    layer.style.border = style.border || '1px solid color-mix(in srgb, var(--border) 50%, transparent)';
    layer.style.color = style.color;
    layer.style.font = style.font;
    layer.style.letterSpacing = style.letterSpacing;
    layer.style.textAlign = style.textAlign;
    layer.style.padding = '0';
    layer.style.display = 'inline-flex';
    layer.style.alignItems = 'center';
    layer.style.justifyContent = 'center';
    layer.style.gap = style.gap;
    layer.style.whiteSpace = 'nowrap';

    const visual = layer.querySelector('.connection-transition-source-visual');
    if (visual) {
        visual.style.background = style.background;
        visual.style.border = style.border;
        visual.style.borderRadius = style.borderRadius;
        visual.style.color = style.color;
        visual.style.font = style.font;
        visual.style.letterSpacing = style.letterSpacing;
        visual.style.padding = style.padding;
        visual.style.gap = style.gap;
        visual.style.width = '100%';
        visual.style.height = '100%';
        visual.style.maxWidth = '100%';
        visual.style.boxSizing = 'border-box';
        visual.style.display = style.display === 'inline-flex' || style.display === 'flex' ? 'inline-flex' : 'flex';
        visual.style.alignItems = style.alignItems || 'center';
        visual.style.justifyContent = style.justifyContent || 'center';
        visual.style.whiteSpace = 'nowrap';
        visual.style.opacity = revealVisual ? '1' : '';
        visual.style.transform = revealVisual ? 'scale(1)' : '';
        visual.style.transition = revealVisual ? 'opacity 0.12s ease 0.06s, transform 0.18s cubic-bezier(.16,1,.3,1) 0.04s' : '';
    }

    console.debug('[connection-transition]', 'source chrome applied', {
        sourceRole: source.id === 'addConnectionBtn' ? 'add' : source.matches('[data-edit]') ? 'edit' : 'other',
        background,
        revealVisual
    });
}
function resetConnectionTransitionLayer(layer) {
    if (!layer) return;
    layer.style.visibility = 'hidden';
    layer.style.pointerEvents = 'none';
    layer.style.transition = 'none';
    layer.style.transform = '';
    layer.style.opacity = '';
    layer.style.borderRadius = '';
    layer.style.boxShadow = '';
    layer.style.width = '';
    layer.style.height = '';
    layer.style.left = '';
    layer.style.top = '';
    layer.style.background = '';
    layer.style.border = '';
    layer.style.color = '';
    layer.style.font = '';
    layer.style.letterSpacing = '';
    layer.style.textAlign = '';
    layer.style.padding = '';
    layer.style.display = '';
    layer.style.alignItems = '';
    layer.style.justifyContent = '';
    layer.style.gap = '';
    layer.style.whiteSpace = '';
    layer.innerHTML = '';
    layer.removeAttribute('data-has-source-visual');
    layer.classList.remove('source-visual-hidden');
}
function setConnectionModalMode(mode = 'create', { source = 'dashboard', draft = null, token = '' } = {}) {
    connectionModalMode = mode === 'transient' ? 'transient' : (mode === 'edit' || draft?.id ? 'edit' : 'create');
    connectionModalSource = source || 'dashboard';
    transientToken = connectionModalMode === 'transient' ? String(token || '') : '';
    transientHasCredential = connectionModalMode === 'transient' && !!(draft?.hasTransientCredential);
    const form = $('#connectionForm');
    form?.classList.toggle('transient-mode', connectionModalMode === 'transient');
    form?.setAttribute('data-mode', connectionModalMode);
    $('#transientToken') && ($('#transientToken').value = transientToken);
    $('#transientConnectionBanner')?.classList.toggle('force-hidden', connectionModalMode !== 'transient');
    const cred = $('#transientCredentialState');
    if (cred) {
        cred.classList.toggle('force-hidden', !(connectionModalMode === 'transient' && transientHasCredential));
        cred.textContent = transientHasCredential ? '已载入一次性凭据' : '';
    }
    const connectBtn = $('#connectTransientBtn');
    if (connectBtn) {
        connectBtn.disabled = false;
        connectBtn.title = '';
        connectBtn.textContent = '连接';
    }
}

function prepareConnectionModalForm(conn = null, options = {}) {
    const mode = options.mode || (conn?.id ? 'edit' : 'create');
    setConnectionModalMode(mode, { source: options.source || 'dashboard', draft: conn, token: options.transientToken || '' });
    editingId = mode === 'transient' ? null : (conn?.id || null);
    editingSecretLoaded = false;
    editingConnectionSecretState = {
        hasPassword: !!conn?.hasPassword || !!(mode === 'transient' && conn?.hasTransientCredential),
        hasPrivateKey: !!conn?.hasPrivateKey,
        sshKeyId: conn?.sshKeyId || '',
    };
    $('#modalTitle').textContent = mode === 'transient' ? '临时连接' : (editingId ? '编辑服务器' : '添加服务器');
    $('#connectionId').value = editingId || '';
    setConnectionTestLatency();
    $('#connName').value = conn?.name || ''; $('#connProtocol').value = conn?.protocol || 'SSH'; $('#connHost').value = conn?.host || ''; $('#connPort').value = conn?.port || ($('#connProtocol').value === 'RDP' ? 3389 : $('#connProtocol').value === 'VNC' ? 5900 : $('#connProtocol').value === 'TELNET' ? 23 : 22); $('#connUsername').value = conn?.username || '';
    renderSshKeyOptions(conn?.sshKeyId || '');
    $('#connTags').value = (conn?.tags || []).join(', '); setRouteMode(conn?.connectionMode || 'direct', conn?.connectionMode === 'jump' ? (conn?.jumpHostIds || (conn?.jumpHostId ? [conn.jumpHostId] : [])) : (conn?.proxyId || ''));
    $('#connPassword').type = 'password'; $('#toggleConnPassword').textContent = '👁️';
    // Transient credentials must never be written as a readable DOM value.
    if (mode === 'transient' && conn?.hasTransientCredential) {
        $('#connPassword').value = '';
        $('#connPassword').placeholder = '已载入一次性凭据（可覆盖）';
    } else {
        $('#connPassword').placeholder = '';
        $('#connPassword').value = conn?.hasPassword ? '******' : '';
    }
    $('#connPrivateKey').value = conn?.hasPrivateKey ? '******' : '';
    $('#connRemark').value = conn?.remark || '';
    // Sharing flags (non-transient only)
    if ($('#connShareUsers')) $('#connShareUsers').checked = !!conn?.shareWithUsers;
    if ($('#connShareAdmins')) $('#connShareAdmins').checked = !!conn?.shareWithAdmins;
    /* RDP settings */
    if ($('#rdpSoundMode')) $('#rdpSoundMode').value = conn?.rdpSoundMode || 'local';
    if ($('#rdpClipboard')) $('#rdpClipboard').checked = conn?.rdpClipboard !== false;
    if ($('#rdpMicrophone')) $('#rdpMicrophone').checked = !!conn?.rdpMicrophone;
    if ($('#rdpLocation')) $('#rdpLocation').checked = !!conn?.rdpLocation;
    if ($('#rdpStorage')) $('#rdpStorage').checked = !!conn?.rdpStorage;
    if ($('#rdpCamera')) $('#rdpCamera').checked = !!conn?.rdpCamera;
    if ($('#rdpResolution')) $('#rdpResolution').value = conn?.rdpResolution || '1080p';
    if ($('#rdpQuality')) $('#rdpQuality').value = conn?.rdpQuality || 'balanced';
    if ($('#rdpFps')) $('#rdpFps').value = String(conn?.rdpFps || 30);
    if ($('#rdpTouchMode')) $('#rdpTouchMode').value = conn?.rdpTouchMode === 'relative' ? 'relative' : 'direct';
    if ($('#rdpTouchSensitivity')) $('#rdpTouchSensitivity').value = String(Math.max(0.5, Math.min(3, Number(conn?.rdpTouchSensitivity) || 1.5)));
    updateRdpTouchSettingsUi();
    if ($('#rdpDomain')) $('#rdpDomain').value = conn?.rdpDomain || '';
    updateProtocolFields({ preservePort: !!conn });
}
function openModal(conn = null, trigger = null, options = {}) {
    const modal = $('#connectionModal');
    const layer = $('#connectionTransitionLayer');
    if (!modal || !layer || modal.classList.contains('show')) return;
    prepareConnectionModalForm(conn, options);
    connectionModalTrigger = trigger || connectionTransitionTargetRect().source;
    window.clearTimeout(openModal._finishTimer);
    window.clearTimeout(closeModal._timer);
    window.clearTimeout(closeModal._restoreIconTimer);
    window.clearTimeout(closeModal._shadowTimer);
    resetConnectionTransitionShadow();
    resetConnectionTransitionLayer(layer);
    modal.classList.remove('closing', 'app-visible');
    modal.classList.add('show');
    document.body.classList.add('disable-interaction', 'connection-transition-opening');

    const viewport = viewportMetrics();
    const sourceRect = connectionTransitionTargetRect(connectionModalTrigger);
    connectionModalOriginRect = { left: sourceRect.left, top: sourceRect.top, width: sourceRect.width, height: sourceRect.height };
    syncConnectionLayerVisual(layer, sourceRect.source);
    setConnectionLayerRect(layer, connectionModalOriginRect);
    layer.style.transition = 'none';
    layer.style.borderRadius = getComputedStyle(sourceRect.source || connectionModalTrigger || layer).borderRadius || '18px';
    layer.style.boxShadow = 'none';
    layer.style.visibility = 'visible';
    layer.style.pointerEvents = 'auto';
    connectionModalTrigger?.style?.setProperty('opacity', '0');

    void layer.offsetHeight;

    console.debug('[connection-transition]', 'open:init', { mode: editingId ? 'edit' : 'create', connectionId: editingId || '', sourceRect, originRect: connectionModalOriginRect, viewport });

    requestAnimationFrame(() => {
        document.body.classList.add('connection-home-blur');
        modal.classList.add('app-visible');
        layer.classList.add('source-visual-hidden');
        layer.style.transition = `
            top var(--connection-app-duration) var(--connection-ios-spring),
            left var(--connection-app-duration) var(--connection-ios-spring),
            width var(--connection-app-duration) var(--connection-ios-spring),
            height var(--connection-app-duration) var(--connection-ios-spring),
            border-radius var(--connection-app-duration) var(--connection-ios-spring)
        `;
        layer.style.left = `${viewport.left}px`;
        layer.style.top = `${viewport.top}px`;
        layer.style.width = `${viewport.width}px`;
        layer.style.height = `${viewport.height}px`;
        layer.style.borderRadius = '0px';
        layer.style.boxShadow = 'none';
        console.debug('[connection-transition]', 'open:morph-start', { durationMs: 500 });
    });

    openModal._finishTimer = window.setTimeout(() => {
        document.body.classList.remove('disable-interaction', 'connection-transition-opening');
        modal.classList.add('app-visible');
        console.debug('[connection-transition]', 'open:complete', { durationMs: 500 });
    }, 520);
}
function closeModal() {
    const modal = $('#connectionModal');
    const layer = $('#connectionTransitionLayer');
    if (!modal?.classList.contains('show') || modal.classList.contains('closing')) return;

    const viewport = viewportMetrics();
    const currentRect = connectionTransitionTargetRect(connectionModalTrigger);
    const sourceRect = connectionModalOriginRect || {
        left: currentRect.left,
        top: currentRect.top,
        width: currentRect.width,
        height: currentRect.height
    };

    window.clearTimeout(openModal._finishTimer);
    window.clearTimeout(closeModal._restoreIconTimer);
    window.clearTimeout(closeModal._timer);
    window.clearTimeout(closeModal._shadowTimer);

    modal.classList.add('closing');
    modal.classList.remove('app-visible');

    // Wipe transient credential handles on close (FREEZE plan §5.3.5).
    transientToken = '';
    transientHasCredential = false;
    connectionModalMode = 'create';
    $('#transientToken') && ($('#transientToken').value = '');
    $('#connectionForm')?.classList.remove('transient-mode');
    $('#connPassword') && ($('#connPassword').placeholder = '');

    setConnectionTestLatency();

    document.body.classList.add('disable-interaction', 'connection-transition-closing');
    document.body.classList.remove('connection-transition-opening', 'connection-home-blur');

    const sourceEl = currentRect.source || connectionModalTrigger;
    const sourceStyle = sourceEl?.isConnected ? getComputedStyle(sourceEl) : null;
    const sourceBorderRadius = sourceStyle?.borderRadius || getComputedStyle(connectionModalTrigger || layer).borderRadius || '18px';
    const shadowLayer = getConnectionTransitionShadowLayer();

    applyConnectionLayerSourceChrome(layer, sourceEl, { revealVisual: true });

    layer.style.visibility = 'visible';
    layer.style.pointerEvents = 'auto';
    layer.style.transition = 'none';
    layer.style.left = `${viewport.left}px`;
    layer.style.top = `${viewport.top}px`;
    layer.style.width = `${viewport.width}px`;
    layer.style.height = `${viewport.height}px`;
    layer.style.borderRadius = '0px';
    layer.style.boxShadow = 'none';
    layer.classList.remove('source-visual-hidden');

    shadowLayer.style.visibility = 'visible';
    shadowLayer.style.pointerEvents = 'none';
    shadowLayer.style.transition = 'none';
    shadowLayer.style.left = `${viewport.left}px`;
    shadowLayer.style.top = `${viewport.top}px`;
    shadowLayer.style.width = `${viewport.width}px`;
    shadowLayer.style.height = `${viewport.height}px`;
    shadowLayer.style.borderRadius = '0px';
    shadowLayer.style.boxShadow = 'var(--connection-shadow-active)';
    shadowLayer.style.opacity = '1';
    shadowLayer.style.zIndex = '99';

    void layer.offsetHeight;
    void shadowLayer.offsetHeight;

    console.debug('[connection-transition]', 'close:init', {
        connectionId: editingId || '',
        viewport,
        sourceRect,
        currentRect
    });

    requestAnimationFrame(() => {
        layer.style.transition = `
            top var(--connection-app-duration) var(--connection-ios-spring),
            left var(--connection-app-duration) var(--connection-ios-spring),
            width var(--connection-app-duration) var(--connection-ios-spring),
            height var(--connection-app-duration) var(--connection-ios-spring),
            border-radius var(--connection-app-duration) var(--connection-ios-spring)
        `;

        setConnectionLayerRect(layer, sourceRect);
        layer.style.borderRadius = sourceBorderRadius;

        shadowLayer.style.transition = `
            left var(--connection-app-duration) var(--connection-ios-spring),
            top var(--connection-app-duration) var(--connection-ios-spring),
            width var(--connection-app-duration) var(--connection-ios-spring),
            height var(--connection-app-duration) var(--connection-ios-spring),
            border-radius var(--connection-app-duration) var(--connection-ios-spring),
            opacity 0.72s cubic-bezier(.16, 1, .3, 1),
            box-shadow 0.72s cubic-bezier(.16, 1, .3, 1)
        `;
        setConnectionLayerRect(shadowLayer, sourceRect);
        shadowLayer.style.borderRadius = sourceBorderRadius;
        shadowLayer.style.boxShadow = '0 6px 18px rgba(0,0,0,0.10)';
        shadowLayer.style.opacity = '0';

        console.debug('[connection-transition]', 'close:morph-start', { durationMs: 500 });
    });

    let done = false;

    const restoreTriggerWithoutTransition = () => {
        const trigger = connectionModalTrigger;
        if (!trigger?.style) return;

        const oldTransition = trigger.style.transition;
        trigger.style.transition = 'none';
        trigger.style.removeProperty('opacity');

        void trigger.offsetHeight;

        requestAnimationFrame(() => {
            if (oldTransition) {
                trigger.style.transition = oldTransition;
            } else {
                trigger.style.removeProperty('transition');
            }
        });
    };

    const finish = () => {
        if (done) return;
        done = true;

        layer.removeEventListener('transitionend', onEnd);
        modal.classList.remove('show', 'closing', 'app-visible');
        resetConnectionTransitionLayer(layer);

        restoreTriggerWithoutTransition();
        closeModal._shadowTimer = window.setTimeout(() => resetConnectionTransitionShadow(shadowLayer), 180);

        window.setTimeout(() => {
            document.body.classList.remove(
                'disable-interaction',
                'connection-transition-closing',
                'connection-home-blur'
            );
        }, 80);
        connectionModalOriginRect = null;

        console.debug('[connection-transition]', 'close:complete', { durationMs: 500 });
    };

    const onEnd = (ev) => {
        if (ev.propertyName === 'top') finish();
    };

    layer.addEventListener('transitionend', onEnd);
    closeModal._timer = window.setTimeout(finish, 560);
}
function updateRdpTouchSettingsUi() {
    const mode = $('#rdpTouchMode')?.value === 'relative' ? 'relative' : 'direct';
    const sensitivity = Math.max(0.5, Math.min(3, Number($('#rdpTouchSensitivity')?.value) || 1.5));
    const group = $('#rdpTouchSensitivityGroup');
    const input = $('#rdpTouchSensitivity');
    const output = $('#rdpTouchSensitivityValue');
    if (group) group.classList.toggle('rdp-range-disabled', mode !== 'relative');
    if (input) input.disabled = mode !== 'relative';
    if (output) output.textContent = `${sensitivity.toFixed(1)}×`;
}

function connectionPayload({ forTest = false } = {}) {
    const protocol = String($('#connProtocol').value || 'SSH').toUpperCase();
    // Telnet has no jump/proxy chain yet — force direct.
    const mode = protocol === 'TELNET' ? 'direct' : ($('#connMode').value || 'direct');
    const proxyId = mode === 'proxy' ? ($('#connRoute')?.value || '') : '';
    const jumpHostIds = mode === 'jump' ? [...new Set($$('#jumpRouteList [data-jump-route-select]').map((el) => el.value).filter(Boolean))] : [];
    const defaultPort = protocol === 'RDP' ? 3389 : protocol === 'VNC' ? 5900 : protocol === 'TELNET' ? 23 : 22;
    const payload = { name: $('#connName').value.trim(), protocol, host: $('#connHost').value.trim(), port: Number($('#connPort').value) || defaultPort, username: $('#connUsername').value.trim(), sshKeyId: protocol === 'SSH' ? ($('#connSshKey')?.value || '') : '', password: protocol === 'TELNET' ? '' : $('#connPassword').value, privateKey: protocol === 'SSH' ? $('#connPrivateKey').value : '', remark: $('#connRemark').value, tags: parseTags($('#connTags').value), connectionMode: mode, proxyId: mode === 'proxy' ? proxyId : '', jumpHostId: mode === 'jump' ? (jumpHostIds[0] || '') : '', jumpHostIds, shareWithUsers: !!$('#connShareUsers')?.checked, shareWithAdmins: !!$('#connShareAdmins')?.checked };
    if (protocol === 'RDP') {
        payload.rdpSoundMode = $('#rdpSoundMode')?.value || 'local';
        payload.rdpClipboard = $('#rdpClipboard')?.checked !== false;
        payload.rdpMicrophone = !!$('#rdpMicrophone')?.checked;
        payload.rdpLocation = !!$('#rdpLocation')?.checked;
        payload.rdpStorage = !!$('#rdpStorage')?.checked;
        payload.rdpCamera = !!$('#rdpCamera')?.checked;
        payload.rdpResolution = $('#rdpResolution')?.value || '1080p';
        payload.rdpQuality = $('#rdpQuality')?.value || 'balanced';
        payload.rdpFps = Number($('#rdpFps')?.value) || 30;
        payload.rdpPipeline = 'worker-gpu-v2';
        payload.rdpTouchMode = $('#rdpTouchMode')?.value === 'relative' ? 'relative' : 'direct';
        payload.rdpTouchSensitivity = Math.max(0.5, Math.min(3, Number($('#rdpTouchSensitivity')?.value) || 1.5));
        payload.rdpDomain = ($('#rdpDomain')?.value || '').trim();
    }
    console.debug('[route-ui]', 'connection payload route', { mode, proxyId: payload.proxyId, jumpHostIds, sshKeyId: payload.sshKeyId });
    if (!forTest && editingId) { if (payload.password === '******') delete payload.password; if (payload.privateKey === '******') delete payload.privateKey; }
    return payload;
}
async function saveConnection(e) {
    e.preventDefault();
    // Hard guard: transient mode must never hit POST /api/connections.
    if (connectionModalMode === 'transient') {
        toast('临时连接不会保存到主机库');
        return;
    }
    const payload = connectionPayload();
    if (editingId) await api(`/api/connections/${editingId}`, { method: 'PUT', body: JSON.stringify(payload) });
    else await api('/api/connections', { method: 'POST', body: JSON.stringify(payload) });
    closeModal();
    toast('连接已保存');
    await loadConnections();
}
async function testConnection() {
    const btn = $('#testConnectionBtn');
    const connectBtn = $('#connectTransientBtn');
    const oldText = btn.textContent;
    btn.disabled = true;
    if (connectBtn) connectBtn.disabled = true;
    btn.textContent = '测试中...';
    setConnectionTestLatency('测试中...', 'pending');
    try {
        const payload = connectionPayload({ forTest: true });
        let result;
        if (connectionModalMode === 'transient') {
            if (!transientToken) throw new Error('临时凭据已失效，请重新打开链接');
            const overrides = {
                name: payload.name, host: payload.host, port: payload.port,
                username: payload.username, protocol: payload.protocol,
            };
            const credentialOverride = {};
            if (payload.password && payload.password !== '******') credentialOverride.password = payload.password;
            if (payload.privateKey && payload.privateKey !== '******') credentialOverride.privateKey = payload.privateKey;
            result = await api(`/api/deeplinks/${encodeURIComponent(transientToken)}/test`, {
                method: 'POST',
                body: JSON.stringify({ overrides, credentialOverride, timeoutSeconds: 10 }),
            });
        } else {
            result = await api('/api/connections/test', { method: 'POST', body: JSON.stringify({ ...payload, connectionId: editingId || '', timeoutSeconds: 10 }) });
        }
        setConnectionTestLatency(`连接延迟：${result.durationMs}ms`, 'success');
        toast(result.message || '连接测试成功');
    } catch (err) {
        setConnectionTestLatency('测试失败', 'error');
        toast(err.message);
    } finally {
        btn.disabled = false;
        btn.textContent = oldText;
        if (connectBtn && connectionModalMode === 'transient') {
            connectBtn.disabled = false;
        }
    }
}

async function connectTransient() {
    if (connectionModalMode !== 'transient') return;
    if (!transientToken) {
        toast('临时凭据已失效，请重新打开链接');
        return;
    }
    const btn = $('#connectTransientBtn');
    const testBtn = $('#testConnectionBtn');
    if (btn) { btn.disabled = true; btn.textContent = '正在连接…'; }
    if (testBtn) testBtn.disabled = true;
    try {
        const payload = connectionPayload({ forTest: true });
        const token = transientToken;
        const overrides = {
            name: payload.name, host: payload.host, port: payload.port,
            username: payload.username, protocol: payload.protocol,
        };
        // Open a terminal tab that consumes the one-time token server-side.
        const tabId = `tab_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        const title = payload.name || `${payload.username || 'user'}@${payload.host}`;
        const sshParams = {
            transientToken: token,
            transientOverrides: overrides,
            host: payload.host,
            port: payload.port,
            username: payload.username,
            protocol: payload.protocol || 'SSH',
            // password/privateKey only if the user overrode the one-time credential
            password: (payload.password && payload.password !== '******') ? payload.password : '',
            privateKey: (payload.privateKey && payload.privateKey !== '******') ? payload.privateKey : '',
            init: '',
            tabId,
            embedded: !isCompactTerminalWorkspace(),
            timestamp: Date.now(),
            snippets: settings?.snippets || [],
            transient: true,
        };
        sessionStorage.setItem(`zephyr_ssh_params_${tabId}`, JSON.stringify(sshParams));
        terminalTabs.push({
            id: tabId,
            name: `${title} · 临时`,
            protocol: payload.protocol || 'SSH',
            status: 'connecting',
            iframe: true,
            page: 'terminal',
            connectionId: '',
            transient: true,
            createdAt: Date.now(),
            lastUsedAt: Date.now(),
            minimized: false,
        });
        openOrderStack.push(tabId);
        activeTerminalTab = tabId;
        touchTerminalSession?.(tabId);
        enforceTerminalWorkspaceLimit?.(tabId);
        // Consume path: clear local token handle before navigation so a double
        // click cannot reuse it even if the server race loses.
        transientToken = '';
        $('#transientToken') && ($('#transientToken').value = '');
        closeModal();
        renderTerminalTabs();
        switchView('terminal');
        renderTerminalTabs({ rebuildWorkspace: true });
        toast('正在建立临时连接…');
    } catch (err) {
        toast(err.message || '连接失败');
        if (btn) { btn.disabled = false; btn.textContent = '连接'; }
        if (testBtn) testBtn.disabled = false;
    }
}

async function openTransientFromUri(uri) {
    try {
        const prepared = await api('/api/deeplinks/prepare', { method: 'POST', body: JSON.stringify({ uri }) });
        openConnectionModal({
            mode: 'transient',
            source: 'note',
            draft: prepared.draft,
            transientToken: prepared.token,
        });
    } catch (err) {
        toast(err.message || '无法打开临时连接');
    }
}

function openConnectionModal({ mode = 'create', source = 'dashboard', draft = null, transientToken: token = '', trigger = null } = {}) {
    openModal(draft, trigger, { mode, source, transientToken: token });
}

async function openTransientFromToken(token) {
    try {
        const peeked = await api(`/api/deeplinks/${encodeURIComponent(token)}`);
        openConnectionModal({
            mode: 'transient',
            source: 'deeplink',
            draft: peeked.draft,
            transientToken: token,
        });
    } catch (err) {
        toast(err.message || '临时凭据无效或已过期');
    }
}

async function revealConnectionSecrets() {
    if (!editingId || editingSecretLoaded) return;
    const protocol = String($('#connProtocol')?.value || 'SSH').toUpperCase();
    const isSsh = protocol === 'SSH';
    const actionText = isSsh ? '查看已保存连接密码/私钥' : '查看已保存连接密码';
    const secret = requestSensitiveSecret(actionText);
    const data = await api(`/api/connections/${editingId}/open`, { method: 'POST', body: JSON.stringify({ purpose: 'reveal', secret }) });
    $('#connPassword').value = data.connection?.password || '';
    if (isSsh) $('#connPrivateKey').value = data.connection?.privateKey || '';
    editingSecretLoaded = true;
    console.debug('[secret-open]', 'connection secrets loaded', { connectionId: editingId, protocol, hasPassword: !!data.connection?.password, hasPrivateKey: !!data.connection?.privateKey });
    toast(isSsh ? '已载入保存的密码/私钥' : '已载入保存的密码');
}

function stableTerminalSessionId(connectionId, protocol = 'SSH') {
    const client = String(workspaceClientId || ensureWorkspaceClientId() || 'default').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'default';
    const conn = String(connectionId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) || 'unknown';
    const proto = String(protocol || 'SSH').toUpperCase().replace(/[^A-Z0-9]/g, '') || 'SSH';
    // Stable across refresh so the server can re-attach the live PTY + output buffer.
    return `sess_${proto}_${client}_${conn}`;
}

function rememberLastAppView(view = currentAppView) {
    try { localStorage.setItem('zephyr.lastView', String(view || 'dashboard')); } catch {}
}

async function openConnection(id, options = {}) {
    const data = await api(`/api/connections/${id}/open`, { method: 'POST' }); const c = data.connection;
    const protocol = String(c.protocol || 'SSH').toUpperCase();
    // Restore path supplies a stable sessionId so refresh reattaches the live PTY.
    // Normal "连接" still opens a fresh tab unless the same session is already open.
    const preferredId = String(options.sessionId || options.tabId || '').trim();
    const tabId = preferredId || `tab_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const existing = terminalTabs.find((t) => t.id === tabId)
        || (preferredId ? terminalTabs.find((t) => t.sessionId === preferredId) : null)
        || (options.reuseOpenTab
            ? terminalTabs.find((t) => t.connectionId === c.id && !t.transient && String(t.protocol || '').toUpperCase() === protocol)
            : null);
    if (existing && !options.forceNew) {
        existing.minimized = false;
        if (preferredId) existing.sessionId = preferredId;
        activeTerminalTab = existing.id;
        touchTerminalSession(existing.id);
        renderTerminalTabs({ rebuildWorkspace: true });
        if (!options.skipViewSwitch) switchView('terminal');
        scheduleWorkspaceSave('reopen-existing-tab', { immediate: true });
        return existing.id;
    }
    if (protocol === 'RDP' || protocol === 'VNC') {
        sessionStorage.setItem(`zephyr_remote_desktop_params_${tabId}`, JSON.stringify({ connectionId: c.id, name: c.name, host: c.host, port: c.port, username: c.username, protocol, tabId, sessionId: tabId, embedded: true, timestamp: Date.now(), rdpResolution: c.rdpResolution || '1080p', quality: c.rdpQuality || 'balanced', rdpFps: Number(c.rdpFps || 30), rdpPipeline: 'worker-gpu-v2', rdpTouchMode: c.rdpTouchMode === 'relative' ? 'relative' : 'direct', rdpTouchSensitivity: Math.max(0.5, Math.min(3, Number(c.rdpTouchSensitivity) || 1.5)), rdpSoundMode: c.rdpSoundMode || 'local', rdpClipboard: c.rdpClipboard !== false, rdpDomain: c.rdpDomain || '', rdpMicrophone: !!c.rdpMicrophone, rdpLocation: !!c.rdpLocation, rdpStorage: !!c.rdpStorage, rdpCamera: !!c.rdpCamera }));
        terminalTabs.push({ id: tabId, name: c.name, protocol, status: 'connecting', iframe: true, page: protocol === 'VNC' ? 'novnc' : 'rdp', connectionId: c.id, sessionId: tabId, createdAt: Date.now(), lastUsedAt: Date.now(), minimized: false });
        console.debug(protocol === 'VNC' ? '[novnc-client]' : '[rdp-client]', 'open remote desktop tab', { protocol, tabId, connectionId: c.id, host: c.host, port: c.port });
    } else {
        // SSH and TELNET share the terminal page; protocol is carried on the tab
        // and in session params so the server can pick the right transport.
        const sshParams = {
            connectionId: c.id,
            host: c.host,
            port: c.port,
            username: c.username,
            protocol,
            init: '',
            tabId,
            sessionId: tabId,
            embedded: !isCompactTerminalWorkspace(),
            timestamp: Date.now(),
            snippets: settings?.snippets || [],
        };
        sessionStorage.setItem(`zephyr_ssh_params_${tabId}`, JSON.stringify(sshParams));
        terminalTabs.push({ id: tabId, name: c.name, protocol, status: 'connecting', iframe: true, page: 'terminal', connectionId: c.id, sessionId: tabId, createdAt: Date.now(), lastUsedAt: Date.now(), minimized: false });
    }
    if (!openOrderStack.includes(tabId)) openOrderStack.push(tabId);
    activeTerminalTab = tabId;
    touchTerminalSession(tabId);
    enforceTerminalWorkspaceLimit(tabId);
    renderTerminalTabs();
    if (!options.skipViewSwitch) switchView('terminal');
    renderTerminalTabs({ rebuildWorkspace: true });
    if (isCompactTerminalWorkspace() && document.body.classList.contains('terminal-custom-fullscreen-open')) {
        window.setTimeout(() => renderTerminalTabs({ rebuildWorkspace: true }), 80);
    }
    await loadConnections();
    scheduleWorkspaceSave('open-connection', { immediate: true });
    return tabId;
}
function openPlaceholderTab(c) {
    const tabId = `tab_${Date.now()}`;
    terminalTabs.push({ id: tabId, name: c.name, protocol: c.protocol, status: '占位', iframe: false, createdAt: Date.now(), lastUsedAt: Date.now(), minimized: false });
    openOrderStack.push(tabId);
    activeTerminalTab = tabId;
    touchTerminalSession(tabId);
    enforceTerminalWorkspaceLimit(tabId);
    renderTerminalTabs();
    switchView('terminal');
}

function detectInteractionEnvironment() {
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
function isPhoneLikeEnvironment() {
    const env = detectInteractionEnvironment();
    const explicitPhoneUA = /android.*mobile|iphone|ipod|blackberry|iemobile|opera mini/i.test(env.ua);
    const desktopClassInput = env.hover && !env.coarse;
    if (desktopClassInput) return false;
    return explicitPhoneUA && env.coarse && Math.min(env.width, env.height) <= 700;
}

function isCompactTerminalWorkspace() { return isPhoneLikeEnvironment(); }
function getConfiguredTerminalMaxWindows() {
    const value = Number(settings?.terminal?.maxWindows || localStorage.getItem('zephyr-terminal-max-windows') || 3);
    return Math.min(3, Math.max(1, Number.isFinite(value) ? value : 3));
}
function getConfiguredMinimizedKeepAlive() {
    const raw = settings?.terminal?.minimizedKeepAlive ?? localStorage.getItem('zephyr-terminal-minimized-keepalive') ?? 0;
    const value = Number(raw);
    if (!Number.isFinite(value)) return 0;
    if (value === -1) return -1;
    return Math.max(0, Math.floor(value));
}
function getTerminalSmartbarOrder() {
    const value = settings?.terminal?.smartbarOrder || localStorage.getItem('zephyr-terminal-smartbar-order') || 'old-first';
    if (value === 'new-left' || value === 'new-first') return 'new-first';
    return 'old-first';
}

function getTerminalShortcutPlatform() {
    const value = settings?.terminal?.shortcutPlatform || localStorage.getItem('zephyr-shortcut-platform') || 'auto';
    return ['auto', 'windows', 'mac'].includes(value) ? value : 'auto';
}
function getEffectiveTerminalMaxWindows() { return isCompactTerminalWorkspace() ? 1 : getConfiguredTerminalMaxWindows(); }
function getTerminalSession(id) { return terminalTabs.find((t) => t.id === id); }
function visibleTerminalTabs() { return terminalTabs.filter((t) => !t.minimized && !closingTerminalTabs.has(t.id)); }
function terminalShortName(name = '') { const s = String(name || 'Terminal'); return s.length > 6 ? `${s.slice(0, 6)}…` : s; }
function terminalInitials(name = '') {
    const parts = String(name || 'T').trim().split(/[\s._-]+/).filter(Boolean);
    const raw = parts.length > 1 ? parts.slice(0, 2).map((x) => x[0]).join('') : (parts[0] || 'T').slice(0, 2);
    return raw.toUpperCase();
}
function escapeSvgText(str) { return String(str || '').replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m])); }
// SMARTBAR_TEXT_IMAGE_CACHE is initialized near the top of the module because applyTheme() runs during init.
function smartbarTextThemeColor(kind = 'label') {
    if (kind === 'plus') return '#0969da';
    const theme = document.documentElement.getAttribute('data-theme') || getPreferredTheme();
    if (kind === 'initials') return theme === 'dark' ? '#f0f6fc' : '#1f2328';
    return theme === 'dark' ? '#f0f6fc' : '#24292f';
}
function smartbarTextMeasureContext(font) {
    const canvas = smartbarTextMeasureContext.canvas || (smartbarTextMeasureContext.canvas = document.createElement('canvas'));
    const ctx = canvas.getContext('2d');
    ctx.font = font;
    return ctx;
}
function measureSmartbarText(text, font) {
    return smartbarTextMeasureContext(font).measureText(String(text || '')).width;
}
function fitSmartbarTextToWidth(text, maxWidth, font) {
    const raw = String(text || '').replace(/\s+/g, ' ').trim() || 'Terminal';
    if (measureSmartbarText(raw, font) <= maxWidth) return raw;
    const chars = Array.from(raw);
    let lo = 0, hi = chars.length;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (measureSmartbarText(`${chars.slice(0, mid).join('')}…`, font) <= maxWidth) lo = mid;
        else hi = mid - 1;
    }
    return `${chars.slice(0, Math.max(1, lo)).join('')}…`;
}
function smartbarSvgDataUrl(svg) {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
function smartbarTextImage(text, { kind = 'label', maxWidth = 82, width = null, height = null, fontSize = 11, fontWeight = 700, letterSpacing = 0 } = {}) {
    const fontFamily = '-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif';
    const canvasFont = `${fontWeight} ${fontSize}px ${fontFamily}`;
    const rawText = String(text || (kind === 'initials' ? 'T' : 'Terminal')).trim() || (kind === 'initials' ? 'T' : 'Terminal');
    const fittedText = kind === 'label' ? fitSmartbarTextToWidth(rawText, maxWidth, canvasFont) : rawText;
    const measuredWidth = Math.ceil(measureSmartbarText(fittedText, canvasFont));
    const cssWidth = width || Math.min(maxWidth, Math.max(kind === 'initials' ? 42 : 8, measuredWidth + (kind === 'label' ? 2 : 0)));
    const cssHeight = height || (kind === 'initials' ? 30 : 14);
    const color = smartbarTextThemeColor(kind);
    const cacheKey = [kind, fittedText, cssWidth, cssHeight, fontSize, fontWeight, letterSpacing, color].join('|');
    const cached = SMARTBAR_TEXT_IMAGE_CACHE.get(cacheKey);
    if (cached) return cached;
    const scale = Math.min(3, Math.max(2, Math.ceil(window.devicePixelRatio || 1)));
    const viewWidth = Math.ceil(cssWidth * scale);
    const viewHeight = Math.ceil(cssHeight * scale);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${viewWidth}" height="${viewHeight}" viewBox="0 0 ${viewWidth} ${viewHeight}"><text x="50%" y="52%" text-anchor="middle" dominant-baseline="central" font-family="${fontFamily}" font-size="${fontSize * scale}" font-weight="${fontWeight}" letter-spacing="${letterSpacing * scale}" fill="${color}">${escapeSvgText(fittedText)}</text></svg>`;
    const image = { src: smartbarSvgDataUrl(svg), width: cssWidth, height: cssHeight, text: fittedText };
    SMARTBAR_TEXT_IMAGE_CACHE.set(cacheKey, image);
    return image;
}
function smartbarPlusImage() {
    const color = smartbarTextThemeColor('plus');
    const cacheKey = `plus|${color}`;
    const cached = SMARTBAR_TEXT_IMAGE_CACHE.get(cacheKey);
    if (cached) return cached;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60" viewBox="0 0 60 60"><path d="M30 12v36M12 30h36" stroke="${color}" stroke-width="7" stroke-linecap="round"/></svg>`;
    const image = { src: smartbarSvgDataUrl(svg), width: 30, height: 30, text: '+' };
    SMARTBAR_TEXT_IMAGE_CACHE.set(cacheKey, image);
    return image;
}
function smartbarImageHtml(image, className) {
    return `<span class="${className} smartbar-rendered-image" style="width:${image.width}px;height:${image.height}px;background-image:url(&quot;${escapeHtml(image.src)}&quot;)" aria-hidden="true"></span>`;
}
function smartbarSessionInitialsHtml(name) { return smartbarImageHtml(smartbarTextImage(terminalInitials(name), { kind: 'initials', maxWidth: 46, width: 46, height: 30, fontSize: 20, fontWeight: 900, letterSpacing: .2 }), 'smartbar-session-initials-img'); }
function smartbarSessionLabelHtml(name) { return smartbarImageHtml(smartbarTextImage(name || 'Terminal', { kind: 'label', maxWidth: 82, height: 14, fontSize: 11, fontWeight: 700 }), 'smartbar-session-label-img'); }
function smartbarPlusHtml() { return `<span class="smartbar-add-icon">${smartbarImageHtml(smartbarPlusImage(), 'smartbar-plus-img')}</span>`; }
function touchTerminalSession(id) { const t = getTerminalSession(id); if (t) t.lastUsedAt = Date.now(); recentUseStack = [id, ...recentUseStack.filter((x) => x !== id)].filter((x) => getTerminalSession(x)); }
function orderedVisibleIds() { return openOrderStack.filter((id) => visibleTerminalTabs().some((t) => t.id === id)); }
function computeDefaultVisualLayout() {
    const ids = orderedVisibleIds();
    if (ids.length <= 2) return ids;
    return [ids[ids.length - 1], ids[1], ids[0]].filter(Boolean);
}
function syncVisualLayout({ preserve = true } = {}) {
    const visibleIds = orderedVisibleIds();
    if (!preserve || !visualLayout.length) visualLayout = computeDefaultVisualLayout();
    else visualLayout = [...visualLayout.filter((id) => visibleIds.includes(id)), ...visibleIds.filter((id) => !visualLayout.includes(id))];
    if (visibleIds.length === 3 && (!preserve || visualLayout.length !== 3)) visualLayout = computeDefaultVisualLayout();
    if (!activeTerminalTab || !getTerminalSession(activeTerminalTab) || getTerminalSession(activeTerminalTab)?.minimized) activeTerminalTab = visualLayout[0] || visibleIds[0] || terminalTabs[0]?.id || null;
}
function minimizeTerminalSession(id, { activateNext = true, animated = true } = {}) {
    const t = getTerminalSession(id); if (!t) return;
    resetTerminalWorkspaceKeyboard({ force: true });
    if (animated && !t.minimized && !minimizingTerminalTabs.has(id)) {
        minimizingTerminalTabs.add(id);
        renderTerminalTabs({ rebuildWorkspace: false });
        window.setTimeout(() => {
            minimizingTerminalTabs.delete(id);
            minimizeTerminalSession(id, { activateNext, animated: false });
            renderTerminalTabs();
        }, 260);
        return;
    }
    t.minimized = true;
    visualLayout = visualLayout.filter((x) => x !== id);
    if (activeTerminalTab === id && activateNext) activeTerminalTab = visualLayout[0] || orderedVisibleIds()[0] || terminalTabs.find((x) => !x.minimized)?.id || terminalTabs[0]?.id || null;
    syncVisualLayout({ preserve: false });
}
function restoreTerminalSession(id) {
    const t = getTerminalSession(id); if (!t) return;
    t.minimized = false;
    activeTerminalTab = id;
    touchTerminalSession(id);
    enforceTerminalWorkspaceLimit(id);
}
function showTerminalSessionInWorkspace(id) {
    const t = getTerminalSession(id); if (!t) return;
    resetTerminalWorkspaceKeyboard({ force: true });
    t.minimized = false;
    activeTerminalTab = id;
    touchTerminalSession(id);
    const maxWindows = getEffectiveTerminalMaxWindows();
    if (maxWindows <= 1) {
        terminalTabs.forEach((item) => { if (item.id !== id) item.minimized = true; });
        visualLayout = [id];
    } else {
        const visibleIds = orderedVisibleIds();
        if (!visualLayout.includes(id)) visualLayout.push(id);
        while (visibleTerminalTabs().length > maxWindows) {
            const victimId = visualLayout.find((itemId) => itemId !== id);
            if (!victimId) break;
            const victim = getTerminalSession(victimId);
            if (victim) victim.minimized = true;
            visualLayout = visualLayout.filter((itemId) => itemId !== victimId);
        }
        const stillVisibleIds = orderedVisibleIds();
        visualLayout = [...visualLayout.filter((itemId) => stillVisibleIds.includes(itemId)), ...visibleIds.filter((itemId) => !visualLayout.includes(itemId) && stillVisibleIds.includes(itemId))];
        if (!visualLayout.includes(id)) visualLayout.push(id);
        visualLayout = visualLayout.slice(-maxWindows);
    }
    if (!visualLayout.includes(id)) visualLayout = [id, ...visualLayout].slice(0, maxWindows);
    syncVisualLayout({ preserve: true });
}
function enforceTerminalWorkspaceLimit(newId) {
    const maxWindows = getEffectiveTerminalMaxWindows();
    if (maxWindows <= 1) {
        terminalTabs.forEach((t) => { if (t.id !== newId) t.minimized = true; });
    } else {
        while (visibleTerminalTabs().length > maxWindows) {
            const oldestVisible = openOrderStack.find((id) => id !== newId && getTerminalSession(id) && !getTerminalSession(id).minimized);
            if (!oldestVisible) break;
            minimizeTerminalSession(oldestVisible, { activateNext: false, animated: false });
        }
    }
    syncVisualLayout({ preserve: false });
}
function terminalProtocolClass(protocol) { return String(protocol || 'SSH').toLowerCase(); }
function positionSmartbarPicker() {
    const smartbar = $('#sessionTabs');
    const picker = document.querySelector('#smartbarPickerLayer .smartbar-picker');
    const addButton = smartbar?.querySelector('[data-smartbar-add]');
    if (!smartbar || !picker || !addButton) return;
    const viewport = window.visualViewport;
    const vvLeft = viewport?.offsetLeft || 0;
    const vvTop = viewport?.offsetTop || 0;
    const vvWidth = viewport?.width || window.innerWidth;
    const vvHeight = viewport?.height || window.innerHeight;
    const margin = 14;
    const addRect = addButton.getBoundingClientRect();
    const mobileFullscreen = isCompactTerminalWorkspace() && document.body.classList.contains('terminal-custom-fullscreen-open');
    const targetWidth = mobileFullscreen
        ? Math.min(340, Math.max(240, vvWidth - margin * 2))
        : Math.min(360, Math.max(300, vvWidth - margin * 2));
    const anchorX = addRect.left + addRect.width / 2;
    const desiredLeft = mobileFullscreen ? addRect.right + 12 : anchorX - targetWidth / 2;
    const left = Math.min(Math.max(desiredLeft, vvLeft + margin), vvLeft + vvWidth - targetWidth - margin);
    const preferredTop = mobileFullscreen ? Math.round(addRect.top) : Math.round(addRect.bottom + 14);
    const maxTop = vvTop + Math.max(margin, vvHeight - 280 - margin);
    const top = Math.min(Math.max(preferredTop, vvTop + margin), maxTop);
    const arrowLeft = Math.min(targetWidth - 20, Math.max(20, anchorX - left));
    picker.style.width = `${targetWidth}px`;
    picker.style.setProperty('--smartbar-picker-left', `${left}px`);
    picker.style.setProperty('--smartbar-picker-top', `${top}px`);
    picker.style.setProperty('--smartbar-picker-arrow-left', `${arrowLeft}px`);
    picker.style.setProperty('--smartbar-picker-origin-x', `${arrowLeft}px`);
}
function renderTerminalSmartbar() {
    const order = getTerminalSmartbarOrder();
    const orderedIds = order === 'new-first' ? [...openOrderStack].reverse() : [...openOrderStack];
    const seen = new Set();
    const sessions = orderedIds.map(getTerminalSession).filter(Boolean).filter((t) => {
        if (seen.has(t.id)) return false;
        seen.add(t.id);
        return true;
    });
    const icon = (t, index) => `<button class="smartbar-session ${t.id === activeTerminalTab ? 'active' : ''} ${t.minimized ? 'minimized' : ''}" style="--dock-index:${index}" data-smartbar-tab="${t.id}" title="${escapeHtml(t.protocol)} · ${escapeHtml(t.name)} · ${escapeHtml(t.status)}" aria-label="${escapeHtml(t.name || 'Terminal')}"><span class="smartbar-session-icon"><span class="proto-dot ${terminalProtocolClass(t.protocol)}"></span>${smartbarSessionInitialsHtml(t.name)}</span><span class="smartbar-session-label" aria-hidden="true">${smartbarSessionLabelHtml(t.name || 'Terminal')}</span></button>`;
    const launchableConnections = connections.filter((c) => ['SSH', 'RDP', 'VNC'].includes(String(c.protocol || 'SSH').toUpperCase()));
    const picker = terminalSmartbarPickerOpen ? `
        <div class="smartbar-picker" role="dialog" aria-label="选择服务器连接">
            <div class="smartbar-picker-head"><strong>选择服务器</strong><button data-smartbar-picker-close title="关闭">×</button></div>
            <div class="smartbar-picker-list">
                ${launchableConnections.length ? launchableConnections.map((c) => `<button data-smartbar-connect="${c.id}"><span class="proto-dot ${terminalProtocolClass(c.protocol)}"></span><strong>${escapeHtml(c.name)}</strong><em>${escapeHtml(c.protocol)} · ${escapeHtml(c.host)}:${escapeHtml(c.port)}</em></button>`).join('') : '<div class="smartbar-empty">暂无 SSH/RDP/VNC 服务器</div>'}
            </div>
        </div>` : '';
    const pickerMount = document.getElementById('smartbarPickerLayer') || (() => {
        const el = document.createElement('div');
        el.id = 'smartbarPickerLayer';
        document.body.appendChild(el);
        return el;
    })();
    pickerMount.innerHTML = picker;
    const smartbarRoot = $('#sessionTabs');
    if (!smartbarRoot) return;
    syncTerminalSmartbarTop();
    smartbarRoot.className = `terminal-smartbar ${terminalSmartbarOpen ? 'open' : ''} ${terminalSmartbarClosing ? 'closing' : ''}`;
    syncTerminalShelfLineState();
    smartbarRoot.innerHTML = `
        <button class="smartbar-handle" data-smartbar-toggle title="展开/收回 Dock"><span></span></button>
        <div class="smartbar-panel">
            <div class="smartbar-dock" aria-label="终端 Dock">
                ${sessions.map(icon).join('') || '<span class="smartbar-empty">暂无会话</span>'}
                <button class="smartbar-add" style="--dock-index:${sessions.length}" data-smartbar-add title="选择服务器连接" aria-label="选择服务器连接">${smartbarPlusHtml()}</button>
            </div>
        </div>`;
    requestAnimationFrame(() => {
        const nav = $('.main-nav');
        const smartbar = $('#sessionTabs');
        const panel = smartbar?.querySelector('.smartbar-panel');
        if (!nav || !smartbar || !panel) return;
        syncTerminalSmartbarTop();
        syncTerminalShelfLineState();
        positionSmartbarPicker();
    });
}
function terminalWindowMenu(t) {
    const maxWindows = getEffectiveTerminalMaxWindows();
    const visibleCount = visibleTerminalTabs().length;
    const compact = isCompactTerminalWorkspace();
    const workspace = $('#terminalWorkspace');
    const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
    const winFullscreen = fullscreenElement?.classList?.contains('terminal-window') || fullscreenElement === workspace;
    const customFullscreen = workspace?.classList.contains('custom-fullscreen');
    const fullscreenItem = (customFullscreen || winFullscreen) ? ['exit-fullscreen', '退出全屏'] : ['fullscreen', '全屏'];
    let items;
    if (maxWindows <= 1 || visibleCount <= 1) {
        items = compact ? [fullscreenItem, ['reconnect-mobile', '重连'], ['minimize', '最小化'], ['close', '关闭']] : [['minimize', '最小化'], ['close', '关闭']];
    } else if (maxWindows === 2 || visibleCount === 2) {
        items = [fullscreenItem, ['left-half', '左半屏'], ['right-half', '右半屏'], ['minimize', '最小化'], ['close', '关闭']];
    } else {
        items = [fullscreenItem, ['left-half', '左半屏'], ['right-half', '右半屏'], ['right-top', '右侧 1/3 上半部'], ['right-bottom', '右侧 1/3 下半部'], ['left-two-thirds', '左侧 2/3'], ['right-two-thirds', '右侧 2/3'], ['minimize', '最小化'], ['close', '关闭']];
    }
    return `<div class="terminal-window-menu" role="menu" style="--island-action-count:${items.length}">${items.map(([action, label]) => `<button data-window-action="${action}" data-window="${t.id}" title="${label}" aria-label="${label}">${label}</button>`).join('')}</div>`;
}
function terminalWindowTitlebarHtml(t) {
    return `<button class="terminal-grip terminal-window-center-dots" data-window-control="${t.id}" title="短按打开窗口操作，长按拖动交换位置" aria-label="窗口操作与拖动"><span></span></button><button class="mobile-fullscreen-dock-toggle" data-mobile-dock-toggle data-smartbar-toggle title="展开/收回移动端 Dock" aria-label="展开/收回移动端 Dock"><span></span></button><span class="proto-dot ${terminalProtocolClass(t.protocol)}"></span><strong>${escapeHtml(terminalShortName(t.name))}</strong>${terminalWindowMenu(t)}`;
}
function positionTerminalWindowMenu(titlebar, { collapsed = false, force = false } = {}) {
    if (!force && !titlebar?.classList.contains('menu-open')) return;
    const button = titlebar.querySelector('[data-window-control]');
    const menu = titlebar.querySelector('.terminal-window-menu');
    if (!button || !menu) return;
    const titleRect = titlebar.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();

    // 竖向“岛内列表”：保持原来的上下排列，但仍从三个点的几何中心连续膨胀出来，避免横向超出窗口。
    const islandCenterX = buttonRect.left + buttonRect.width / 2;
    const islandCenterY = buttonRect.top + buttonRect.height / 2;
    const itemCount = Number.parseInt(menu.style.getPropertyValue('--island-action-count'), 10) || menu.children.length || 3;
    const windowRect = titlebar.closest('.terminal-window')?.getBoundingClientRect() || titleRect;
    const menuWidth = Math.min(260, Math.max(220, titleRect.width - 16));
    const naturalHeight = 26 + itemCount * 45;
    const targetHeight = Math.min(naturalHeight, Math.max(120, windowRect.height - 12));
    const finalLeft = Math.min(Math.max(islandCenterX - titleRect.left - menuWidth / 2, 8), Math.max(8, titleRect.width - menuWidth - 8));
    const finalTop = Math.round(islandCenterY - titleRect.top - buttonRect.height / 2);
    const startWidth = Math.round(buttonRect.width);
    const startHeight = Math.round(buttonRect.height);
    const startLeft = Math.round(islandCenterX - titleRect.left - startWidth / 2);
    const startTop = Math.round(buttonRect.top - titleRect.top);
    const openDown = true;
    const clampedLeft = collapsed ? startLeft : finalLeft;
    const top = collapsed ? startTop : finalTop;
    const currentWidth = collapsed ? startWidth : menuWidth;
    const currentHeight = collapsed ? startHeight : targetHeight;
    menu.style.top = `${top}px`;
    menu.style.setProperty('--terminal-window-menu-left', `${clampedLeft}px`);
    menu.style.setProperty('--terminal-island-menu-width', `${currentWidth}px`);
    menu.style.setProperty('--terminal-island-menu-height', `${currentHeight}px`);

    const originX = collapsed ? currentWidth / 2 : Math.min(menuWidth - 18, Math.max(18, islandCenterX - titleRect.left - finalLeft));
    const originY = collapsed ? currentHeight / 2 : Math.max(0, Math.min(currentHeight, islandCenterY - titleRect.top - finalTop));
    const finalOriginX = Math.min(menuWidth - 18, Math.max(18, islandCenterX - titleRect.left - finalLeft));
    const finalOriginY = Math.max(0, Math.min(targetHeight, islandCenterY - titleRect.top - finalTop));
    menu.style.setProperty('--island-origin-x', `${originX}px`);
    menu.style.setProperty('--island-origin-y', `${originY}px`);
    menu.style.setProperty('--island-dots-x', `${collapsed ? currentWidth / 2 : finalOriginX}px`);
    menu.style.setProperty('--island-dots-y', `${collapsed ? currentHeight / 2 : finalOriginY}px`);
    const collapsedRadius = Math.round(startHeight / 2);
    const finalRadius = 22;
    menu.style.setProperty('--terminal-island-radius', `${collapsed ? collapsedRadius : finalRadius}px`);
    menu.style.setProperty('--terminal-island-collapsed-radius', `${collapsedRadius}px`);
    menu.style.setProperty('--terminal-island-final-radius', `${finalRadius}px`);
    menu.style.setProperty('--terminal-island-final-left', `${finalLeft}px`);
    menu.style.setProperty('--terminal-island-final-top', `${finalTop}px`);
    menu.style.setProperty('--terminal-island-final-width', `${menuWidth}px`);
    menu.style.setProperty('--terminal-island-final-height', `${targetHeight}px`);
    console.info('[DynamicIslandDiagnostics]', {
        event: 'terminal-window-menu-align',
        tabId: button?.dataset.windowControl || '',
        mode: 'vertical-island',
        titlebarOpen: titlebar.classList.contains('menu-open'),
        buttonRect: {
            left: Number(buttonRect.left.toFixed(2)),
            top: Number(buttonRect.top.toFixed(2)),
            width: Number(buttonRect.width.toFixed(2)),
            height: Number(buttonRect.height.toFixed(2)),
            centerX: Number(islandCenterX.toFixed(2)),
            centerY: Number(islandCenterY.toFixed(2)),
        },
        islandRect: {
            left: Number((titleRect.left + clampedLeft).toFixed(2)),
            top: Number((titleRect.top + top).toFixed(2)),
            width: Number(menuWidth.toFixed(2)),
            height: Number(targetHeight.toFixed(2)),
            originX: Number(originX.toFixed(2)),
            originY: Number(originY.toFixed(2)),
            openDown,
        },
        startTransform: {
            left: Number(clampedLeft.toFixed(2)),
            top: Number(top.toFixed(2)),
            width: Number(currentWidth.toFixed(2)),
            height: Number(currentHeight.toFixed(2)),
            collapsed,
        },
        menuAnimation: getComputedStyle(menu).animationName,
    });
}
function openTerminalWindowMenu(titlebar) {
    if (!titlebar) return;
    titlebar.classList.remove('menu-closing', 'menu-animating');
    positionTerminalWindowMenu(titlebar, { collapsed: true, force: true });
    const menu = titlebar.querySelector('.terminal-window-menu');
    const button = titlebar.querySelector('[data-window-control]');
    menu?.style.setProperty('opacity', '1');
    button?.style.setProperty('opacity', '0');
    titlebar.classList.add('menu-open', 'menu-animating');
    requestAnimationFrame(() => {
        positionTerminalWindowMenu(titlebar, { collapsed: false, force: true });
        window.setTimeout(() => {
            titlebar.classList.remove('menu-animating');
            menu?.style.removeProperty('opacity');
        }, 540);
    });
}
function closeTerminalWindowMenu(titlebar) {
    if (!titlebar) return;
    window.clearTimeout(titlebar._terminalMenuCloseTimer);
    const menu = titlebar.querySelector('.terminal-window-menu');
    const button = titlebar.querySelector('[data-window-control]');
    positionTerminalWindowMenu(titlebar, { collapsed: false, force: true });
    menu?.style.setProperty('opacity', '1');
    button?.style.setProperty('opacity', '0');
    titlebar.classList.add('menu-closing', 'menu-animating');
    titlebar.classList.remove('menu-open');
    requestAnimationFrame(() => positionTerminalWindowMenu(titlebar, { collapsed: true, force: true }));
    titlebar._terminalMenuCloseTimer = window.setTimeout(() => {
        titlebar.classList.remove('menu-closing', 'menu-animating');
        menu?.style.removeProperty('opacity');
        button?.style.removeProperty('opacity');
    }, 460);
}
function closeOtherTerminalWindowMenus(currentButton = null) {
    $$('.terminal-window-titlebar.menu-open').forEach((el) => {
        if (!currentButton || !el.contains(currentButton)) closeTerminalWindowMenu(el);
    });
}
function runTerminalWindowActionButton(action) {
    if (!action) return;
    const tabId = action.dataset.window;
    const windowAction = action.dataset.windowAction;
    applyTerminalWindowPreset(tabId, windowAction);
    closeTerminalWindowMenu(action.closest('.terminal-window-titlebar'));
}
function reconnectTerminalSession(tabId) {
    const t = getTerminalSession(tabId);
    if (!t) return false;
    restoreTerminalSession(tabId);
    t.status = '重连中';
    renderTerminalTabs({ rebuildWorkspace: false });
    let frame = document.querySelector(`#terminalWorkspace .terminal-frame[data-frame="${CSS.escape(tabId)}"]`);
    if (!frame?.contentWindow) {
        renderTerminalTabs({ rebuildWorkspace: true });
        frame = document.querySelector(`#terminalWorkspace .terminal-frame[data-frame="${CSS.escape(tabId)}"]`);
    }
    if (frame?.contentWindow) {
        frame.contentWindow.postMessage({ source: 'zephyr-app', type: 'reconnect-terminal', tabId }, '*');
    } else {
        t.status = 'connecting';
        renderTerminalTabs({ rebuildWorkspace: true });
    }
    const oldTimer = terminalReconnectFallbackTimers.get(tabId);
    if (oldTimer) window.clearTimeout(oldTimer);
    const timer = window.setTimeout(() => {
        terminalReconnectFallbackTimers.delete(tabId);
        const session = getTerminalSession(tabId);
        if (!session || !session.iframe || session.status !== '重连中') return;
        session.status = 'connecting';
        const liveFrame = document.querySelector(`#terminalWorkspace .terminal-frame[data-frame="${CSS.escape(tabId)}"]`);
        if (liveFrame?.src) {
            const src = liveFrame.src;
            liveFrame.src = 'about:blank';
            window.setTimeout(() => { liveFrame.src = src; }, 30);
            renderTerminalTabs({ rebuildWorkspace: false });
            return;
        }
        renderTerminalTabs({ rebuildWorkspace: true });
    }, 2400);
    terminalReconnectFallbackTimers.set(tabId, timer);
    toast(`${t.protocol || '终端'} 正在重连...`);
    return true;
}
function getMinimizedKeepAliveSessions() {
    const limit = getConfiguredMinimizedKeepAlive();
    const minimized = terminalTabs
        .filter((t) => t.minimized && !closingTerminalTabs.has(t.id) && t.iframe)
        .sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0));
    if (limit === -1) return minimized;
    if (limit <= 0) return minimized;
    return minimized.slice(0, limit);
}
function createTerminalWindowElement(t) {
    const article = document.createElement('article');
    article.className = 'terminal-window';
    article.dataset.window = t.id;
    article.draggable = false;
    const titlebar = document.createElement('div');
    titlebar.className = 'terminal-window-titlebar';
    titlebar.innerHTML = terminalWindowTitlebarHtml(t);
    const body = document.createElement('div');
    body.className = 'terminal-window-body';
    if (t.iframe) {
        const frame = document.createElement('iframe');
        frame.className = 'terminal-frame';
        frame.dataset.frame = t.id;
        frame.src = t.page === 'rdp'
            ? `/rdp.html?embed=1&tabId=${encodeURIComponent(t.id)}&connectionId=${encodeURIComponent(t.connectionId || '')}`
            : t.page === 'novnc'
                ? `/novnc.html?embed=1&tabId=${encodeURIComponent(t.id)}&connectionId=${encodeURIComponent(t.connectionId || '')}`
                : `/terminal.html?embed=1&tabId=${encodeURIComponent(t.id)}`;
        frame.allow = 'fullscreen; virtual-keyboard; clipboard-read; clipboard-write';
        frame.addEventListener('load', () => {
            try {
                frame.contentWindow?.postMessage({
                    source: 'zephyr-app',
                    type: 'notes-enabled',
                    enabled: isNotesEnabled(),
                }, '*');
            } catch (_) {}
        }, { once: true });
        body.appendChild(frame);
    } else {
        const placeholder = document.createElement('div');
        placeholder.className = 'terminal-placeholder active';
        placeholder.dataset.frame = t.id;
        placeholder.textContent = `${t.protocol} 协议将在后续版本接入。`;
        body.appendChild(placeholder);
    }
    article.append(titlebar, body);
    return article;
}
function mountMobileDockToggle(workspace) {
    // 小圆点现在直接由 terminalWindowTitlebarHtml 渲染进每个标题栏，避免 titlebar.innerHTML 重绘后丢失。
    workspace?.querySelectorAll('.terminal-window-titlebar > .mobile-fullscreen-dock-toggle').forEach((toggle) => {
        toggle.style.display = isCompactTerminalWorkspace() && workspace?.classList.contains('custom-fullscreen') ? 'grid' : '';
    });
}
function renderTerminalWorkspace() {
    const visibleSessions = terminalTabs.filter((t) => !t.minimized && !closingTerminalTabs.has(t.id));
    const visible = [
        ...visualLayout.map(getTerminalSession).filter(Boolean).filter((t) => visibleSessions.some((item) => item.id === t.id)),
        ...visibleSessions.filter((t) => !visualLayout.includes(t.id)),
    ];
    const keepAliveMinimized = getMinimizedKeepAliveSessions();
    const count = visible.length;
    const workspace = $('#terminalWorkspace');
    const preservedWorkspaceClasses = ['custom-fullscreen', 'keyboard-open', 'fullscreen-transitioning', 'fullscreen-loading']
        .filter((className) => workspace.classList.contains(className));
    workspace.className = `terminal-workspace terminal-workspace-grid layout-${Math.min(count, 3)} ${isCompactTerminalWorkspace() ? 'compact' : ''} ${preservedWorkspaceClasses.join(' ')}`;
    const visibleIds = new Set(visible.map((t) => t.id));
    const keepAliveIds = new Set([...visible.map((t) => t.id), ...keepAliveMinimized.map((t) => t.id)]);
    console.info('[terminal-keepalive]', 'workspace render decision', {
        visibleIds: [...visibleIds],
        minimizedKeepAliveLimit: getConfiguredMinimizedKeepAlive(),
        keptMinimizedIds: keepAliveMinimized.map((t) => t.id),
        existingWindowIds: Array.from(workspace.querySelectorAll(':scope > .terminal-window')).map((el) => el.dataset.window),
    });
    if (!count) {
        workspace.querySelectorAll(':scope > .workspace-splitter').forEach((el) => el.remove());
        workspace.querySelectorAll(':scope > .terminal-window').forEach((el) => {
            if (!keepAliveIds.has(el.dataset.window)) {
                console.info('[terminal-keepalive]', 'unload terminal iframe', { tabId: el.dataset.window, reason: 'no-visible-and-not-kept' });
                el.remove();
            }
        });
        if (!workspace.querySelector(':scope > .terminal-placeholder')) {
            workspace.insertAdjacentHTML('afterbegin', '<div class="terminal-placeholder active">暂无可见会话。最小化会话可从终端栏恢复。</div>');
        }
        keepAliveMinimized.forEach((t) => {
            let win = workspace.querySelector(`:scope > .terminal-window[data-window="${CSS.escape(t.id)}"]`);
            if (!win) {
                win = createTerminalWindowElement(t);
                workspace.appendChild(win);
                console.info('[terminal-keepalive]', 'create minimized keepalive iframe', { tabId: t.id, reason: 'no-visible' });
            }
            win.className = `terminal-window minimized-keepalive ${closingTerminalTabs.has(t.id) ? 'closing' : ''}`;
            win.querySelectorAll('.terminal-frame, .terminal-placeholder').forEach((frame) => frame.classList.remove('active'));
        });
        mountMobileDockToggle(workspace);
        return;
    }
    mountMobileDockToggle(workspace);
    workspace.querySelectorAll(':scope > .terminal-placeholder, :scope > .workspace-splitter').forEach((el) => el.remove());
    workspace.querySelectorAll(':scope > .terminal-window').forEach((el) => {
        if (!keepAliveIds.has(el.dataset.window)) {
            console.info('[terminal-keepalive]', 'unload terminal iframe', { tabId: el.dataset.window, reason: 'outside-visible-and-minimized-keepalive' });
            el.remove();
        }
    });
    visible.forEach((t, index) => {
        let win = workspace.querySelector(`:scope > .terminal-window[data-window="${CSS.escape(t.id)}"]`);
        if (!win) {
            win = createTerminalWindowElement(t);
            workspace.appendChild(win);
            console.info('[terminal-keepalive]', 'create visible iframe', { tabId: t.id, slot: index + 1 });
        }
        const titlebar = win.querySelector('.terminal-window-titlebar');
        if (titlebar) {
            titlebar.innerHTML = terminalWindowTitlebarHtml(t);
        }
        const isActiveWindow = t.id === activeTerminalTab;
        win.className = `terminal-window slot-${index + 1} ${isActiveWindow ? 'active' : 'background'} ${closingTerminalTabs.has(t.id) ? 'closing' : ''} ${minimizingTerminalTabs.has(t.id) ? 'minimizing' : ''} ${dockSwapAnimatingWindows.has(t.id) ? 'dock-swapping' : ''} ${dockLaunchAnimatingWindows.has(t.id) ? 'dock-launching' : ''}`;
        win.querySelectorAll('.terminal-frame, .terminal-placeholder').forEach((frame) => frame.classList.toggle('active', isActiveWindow));
    });
    mountMobileDockToggle(workspace);
    keepAliveMinimized.forEach((t) => {
        let win = workspace.querySelector(`:scope > .terminal-window[data-window="${CSS.escape(t.id)}"]`);
        if (!win) {
            win = createTerminalWindowElement(t);
            workspace.appendChild(win);
            console.info('[terminal-keepalive]', 'create minimized keepalive iframe', { tabId: t.id, reason: 'hidden-minimized' });
        }
        win.className = `terminal-window minimized-keepalive ${closingTerminalTabs.has(t.id) ? 'closing' : ''}`;
        win.querySelectorAll('.terminal-frame, .terminal-placeholder').forEach((frame) => frame.classList.remove('active'));
    });
    if (count === 2 || count === 3) {
        const splitterX = document.createElement('div');
        splitterX.className = 'workspace-splitter vertical';
        splitterX.dataset.splitter = 'x';
        workspace.appendChild(splitterX);
    }
    if (count === 3) {
        const splitterY = document.createElement('div');
        splitterY.className = 'workspace-splitter horizontal';
        splitterY.dataset.splitter = 'y';
        workspace.appendChild(splitterY);
    }
    rememberCompactTerminalKeyboardBaseline('render-terminal-workspace');
    scheduleTerminalLayoutStabilize('render-terminal-workspace', { focus: true });
}
function renderTerminalTabs({ rebuildWorkspace = true } = {}) {
    syncVisualLayout({ preserve: true });
    renderTerminalSmartbar();
    if (rebuildWorkspace) renderTerminalWorkspace();
    else {
        $$('#terminalWorkspace [data-window]').forEach((el) => {
            const active = el.dataset.window === activeTerminalTab;
            el.classList.toggle('active', active);
            el.classList.toggle('background', !active);
            el.classList.toggle('closing', closingTerminalTabs.has(el.dataset.window));
            el.classList.toggle('minimizing', minimizingTerminalTabs.has(el.dataset.window));
        });
        $$('#terminalWorkspace .terminal-window').forEach((win) => {
            const active = win.dataset.window === activeTerminalTab && !win.classList.contains('minimized-keepalive');
            win.querySelectorAll('.terminal-frame, .terminal-placeholder').forEach((frame) => frame.classList.toggle('active', active));
        });
        terminalTabs.forEach((t) => { $$(`[data-window-status="${t.id}"]`).forEach((el) => { el.textContent = t.status || ''; }); });
    }
    requestAnimationFrame(() => broadcastThemeToTerminals(document.documentElement.getAttribute('data-theme') || getPreferredTheme()));
    scheduleWorkspaceSave('terminal-tabs');
}

function exitTerminalFullscreen() {
    const workspace = $('#terminalWorkspace');
    const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
    if (workspace?.classList.contains('custom-fullscreen')) {
        resetTerminalWorkspaceKeyboard({ force: true });
        workspace.classList.remove('custom-fullscreen');
        document.body.classList.remove('terminal-custom-fullscreen-open');
        renderTerminalTabs();
    }
    if (fullscreenElement) {
        if (document.exitFullscreen) document.exitFullscreen().catch?.(() => {});
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    }
}

function closeTerminalTab(tabId, { reason = 'manual' } = {}) {
    if (!terminalTabs.some((t) => t.id === tabId) || closingTerminalTabs.has(tabId)) return;
    const willBeLastTab = terminalTabs.length <= 1;
    console.info('[terminal-layout]', 'close terminal tab requested', {
        tabId,
        reason,
        willBeLastTab,
        activeTerminalTab,
        customFullscreen: $('#terminalWorkspace')?.classList.contains('custom-fullscreen'),
    });
    if (activeTerminalTab === tabId || willBeLastTab) exitTerminalFullscreen();
    closingTerminalTabs.add(tabId);
    renderTerminalTabs({ rebuildWorkspace: false });
    window.setTimeout(() => {
        terminalTabs = terminalTabs.filter((t) => t.id !== tabId);
        openOrderStack = openOrderStack.filter((id) => id !== tabId);
        visualLayout = visualLayout.filter((id) => id !== tabId);
        recentUseStack = recentUseStack.filter((id) => id !== tabId);
        closingTerminalTabs.delete(tabId);
        const reconnectTimer = terminalReconnectFallbackTimers.get(tabId);
        if (reconnectTimer) {
            window.clearTimeout(reconnectTimer);
            terminalReconnectFallbackTimers.delete(tabId);
        }
        sessionStorage.removeItem(`zephyr_ssh_params_${tabId}`);
        sessionStorage.removeItem(`zephyr_remote_desktop_params_${tabId}`);
        if (activeTerminalTab === tabId) activeTerminalTab = visualLayout[0] || terminalTabs.find((t) => !t.minimized)?.id || terminalTabs[0]?.id || null;
        if (!terminalTabs.length) {
            activeTerminalTab = null;
            visualLayout = [];
            openOrderStack = [];
            recentUseStack = [];
            setTerminalSmartbarOpen(false);
            exitTerminalFullscreen();
            resetTerminalWorkspaceKeyboard();
            // 最后一个终端关闭后保留在终端页，显示空会话占位，不再自动回到首页。
            switchView('terminal');
        }
        renderTerminalTabs();
        scheduleWorkspaceSave('close-terminal-tab', { immediate: true });
    }, 260);
}

function applyTerminalWindowPreset(tabId, action) {
    const t = getTerminalSession(tabId); if (!t) return;
    console.debug('[terminal-layout]', 'window action', {
        tabId,
        action,
        compact: isCompactTerminalWorkspace(),
        visibleCount: visibleTerminalTabs().length,
        maxWindows: getEffectiveTerminalMaxWindows()
    });
    if (action === 'minimize') {
        exitTerminalFullscreen();
        minimizeTerminalSession(tabId);
        renderTerminalTabs();
        return;
    }
    if (action === 'close') { closeTerminalTab(tabId); return; }
    if (action === 'exit-fullscreen') { exitTerminalFullscreen(); return; }
    if (action === 'reconnect-mobile') {
        reconnectTerminalSession(tabId);
        return;
    }
    if (action === 'fullscreen') { fullscreenTerminalTab(tabId).catch((err) => toast(err.message)); return; }
    restoreTerminalSession(tabId);
    const beforeRects = captureTerminalWindowRects();
    const workspace = $('#terminalWorkspace');
    const others = visualLayout.filter((id) => id !== tabId);
    if (action === 'left-half' || action === 'left-two-thirds') visualLayout = [tabId, ...others].slice(0, 3);
    else if (action === 'right-half' || action === 'right-two-thirds') visualLayout = [...others, tabId].slice(-3);
    else if (action === 'right-top') visualLayout = [others[0] || tabId, tabId, ...others.filter((_, i) => i > 0)].slice(0, 3);
    else if (action === 'right-bottom') visualLayout = [others[0] || tabId, ...others.filter((_, i) => i > 0), tabId].slice(0, 3);
    if (workspace) {
        if (action === 'left-half' || action === 'right-half') workspace.style.setProperty('--workspace-split-x', '50%');
        if (action === 'left-two-thirds' || action === 'right-top' || action === 'right-bottom') workspace.style.setProperty('--workspace-split-x', '66.666%');
        if (action === 'right-two-thirds') workspace.style.setProperty('--workspace-split-x', '33.333%');
        if (action === 'right-top') workspace.style.setProperty('--workspace-split-y', '50%');
        if (action === 'right-bottom') workspace.style.setProperty('--workspace-split-y', '50%');
    }
    activeTerminalTab = tabId; touchTerminalSession(tabId); renderTerminalTabs();
    animateTerminalWindowLayoutFrom(beforeRects, { reason: action });
}

function captureTerminalWindowRects() {
    const workspace = $('#terminalWorkspace');
    if (!workspace) return new Map();
    return new Map(Array.from(workspace.querySelectorAll(':scope > .terminal-window:not(.minimized-keepalive)')).map((el) => [el.dataset.window, el.getBoundingClientRect()]));
}
function animateTerminalWindowLayoutFrom(beforeRects, { reason = 'layout-change' } = {}) {
    const workspace = $('#terminalWorkspace');
    if (!workspace || !beforeRects?.size) return;
    window.cancelAnimationFrame(animateTerminalWindowLayoutFrom._raf);
    animateTerminalWindowLayoutFrom._raf = window.requestAnimationFrame(() => {
        const animations = [];
        workspace.classList.add('terminal-layout-morphing');
        workspace.querySelectorAll(':scope > .terminal-window:not(.minimized-keepalive)').forEach((el) => {
            const before = beforeRects.get(el.dataset.window);
            const after = el.getBoundingClientRect();
            if (!before || after.width <= 1 || after.height <= 1) return;
            const dx = before.left - after.left;
            const dy = before.top - after.top;
            const sx = before.width / after.width;
            const sy = before.height / after.height;
            const moved = Math.abs(dx) + Math.abs(dy) > 1;
            const resized = Math.abs(1 - sx) + Math.abs(1 - sy) > 0.01;
            if (!moved && !resized) return;
            el.classList.add('layout-morphing');
            const anim = el.animate([
                {
                    transform: `translate3d(${dx}px, ${dy}px, 0) scale3d(${sx}, ${sy}, 1)`,
                    filter: 'blur(.6px) saturate(.98)',
                    boxShadow: '0 18px 52px rgba(0,0,0,.30), inset 0 0 0 1px rgba(255,255,255,.03)'
                },
                {
                    transform: 'translate3d(0, 0, 0) scale3d(1, 1, 1)',
                    filter: 'blur(0) saturate(1)',
                    boxShadow: el.classList.contains('active')
                        ? '0 24px 70px rgba(0,0,0,.38), 0 0 0 3px rgba(10,132,255,.08)'
                        : '0 18px 52px rgba(0,0,0,.32), inset 0 0 0 1px rgba(255,255,255,.03)'
                }
            ], {
                duration: 560,
                easing: 'cubic-bezier(.16, 1, .3, 1)',
                fill: 'both'
            });
            animations.push(anim.finished.catch(() => {}).finally(() => el.classList.remove('layout-morphing')));
        });
        window.clearTimeout(animateTerminalWindowLayoutFrom._timer);
        Promise.all(animations).finally(() => {
            workspace.classList.remove('terminal-layout-morphing');
            scheduleTerminalLayoutStabilize(`terminal-window-morph:${reason}`, { focus: true });
        });
        animateTerminalWindowLayoutFrom._timer = window.setTimeout(() => {
            workspace.classList.remove('terminal-layout-morphing');
            workspace.querySelectorAll('.terminal-window.layout-morphing').forEach((el) => el.classList.remove('layout-morphing'));
        }, 720);
    });
}

function resetTerminalWorkspaceKeyboard({ force = false } = {}) {
    const workspace = $('#terminalWorkspace');
    if (!workspace || (!force && !appKeyboardOpen && !workspace.classList.contains('keyboard-open') && !workspace.classList.contains('keyboard-settling'))) return;
    const wasOpen = appKeyboardOpen;
    appKeyboardOpen = false;
    appKeyboardBaseline = 0;
    appKeyboardPendingMetrics = null;
    appKeyboardLastSignature = '';
    window.clearTimeout(appKeyboardSettleTimer);
    workspace.classList.remove('keyboard-open', 'keyboard-settling');
    document.documentElement.style.setProperty('--app-keyboard-inset', '0px');
    document.body.classList.remove('terminal-keyboard-lift');
    document.documentElement.style.setProperty('--app-keyboard-shift', '0px');
    document.documentElement.style.setProperty('--app-visual-vh', '100vh');
    document.documentElement.style.setProperty('--app-visual-offset-top', '0px');
    document.documentElement.style.setProperty('--app-keyboard-top', '100vh');
    workspace.style.flex = '';
    workspace.style.height = '';
    workspace.style.maxHeight = '';
    workspace.style.minHeight = '';
    workspace.style.marginBottom = '';
    const clearFrameKeyboardState = (reason = 'parent-workspace-reset') => {
        workspace.querySelectorAll('.terminal-frame').forEach((frame) => {
            frame.style.height = '';
            frame.style.maxHeight = '';
            frame.style.minHeight = '';
            try { frame.contentWindow?.postMessage({ source: 'zephyr-app', type: 'reset-mobile-keyboard', reason }, '*'); } catch (_) {}
        });
    };
    clearFrameKeyboardState('parent-workspace-reset');
    if (force) {
        [80, 220, 520, 900].forEach((delay) => window.setTimeout(() => {
            appKeyboardOpen = false;
            appKeyboardBaseline = 0;
            appKeyboardPendingMetrics = null;
            appKeyboardLastSignature = '';
            workspace.classList.remove('keyboard-open', 'keyboard-settling');
            document.documentElement.style.setProperty('--app-keyboard-inset', '0px');
            document.body.classList.remove('terminal-keyboard-lift');
            document.documentElement.style.setProperty('--app-keyboard-shift', '0px');
            document.documentElement.style.setProperty('--app-visual-vh', '100vh');
            document.documentElement.style.setProperty('--app-visual-offset-top', '0px');
            document.documentElement.style.setProperty('--app-keyboard-top', '100vh');
            workspace.style.flex = '';
            workspace.style.height = '';
            workspace.style.maxHeight = '';
            workspace.style.minHeight = '';
            workspace.style.marginBottom = '';
            clearFrameKeyboardState(`parent-workspace-reset:${delay}`);
        }, delay));
    }
    postTerminalKeyboardFreeze(true, 'parent-keyboard-reset-start', { settleMs: 900 });
    window.clearTimeout(appKeyboardFreezeReleaseTimer);
    appKeyboardFreezeReleaseTimer = window.setTimeout(() => postTerminalKeyboardFreeze(false, 'parent-keyboard-reset-settled'), 900);
    console.info('[TerminalLayoutDiagnostics]', { event: 'parent:keyboard-reset', wasOpen });
    scheduleTerminalLayoutStabilize('parent-keyboard-reset', { focus: false });
}

function commitTerminalWorkspaceKeyboard(metrics = {}) {
    const workspace = $('#terminalWorkspace');
    if (!workspace) return;
    const inset = Math.round(Number(metrics.keyboardInset) || 0);
    const viewportHeight = Math.round(Number(metrics.viewportHeight) || window.visualViewport?.height || window.innerHeight || 0);
    const offsetTop = Math.round(Number(metrics.offsetTop) || window.visualViewport?.offsetTop || 0);
    const height = Math.max(240, viewportHeight);
    appKeyboardOpen = true;
    workspace.classList.add('keyboard-open');
    workspace.classList.remove('keyboard-settling');
    postTerminalKeyboardFreeze(true, 'parent-keyboard-commit-lock', { settleMs: 900 });
    document.documentElement.style.setProperty('--app-keyboard-inset', `${inset}px`);
    document.documentElement.style.setProperty('--app-visual-vh', `${height}px`);
    document.documentElement.style.setProperty('--app-visual-offset-top', `${offsetTop}px`);
    workspace.style.height = `${height}px`;
    workspace.style.maxHeight = `${height}px`;
    const frame = workspace.querySelector(`.terminal-frame[data-frame="${CSS.escape(activeTerminalTab || '')}"]`) || workspace.querySelector('.terminal-frame.active');
    if (frame) {
        frame.style.height = '100%';
        frame.style.maxHeight = '100%';
    }
    console.info('[TerminalLayoutDiagnostics]', {
        event: 'parent:keyboard-commit',
        inset,
        viewportHeight,
        offsetTop,
        activeTerminalTab,
    });
    scheduleTerminalLayoutStabilize('parent-keyboard-commit', { focus: false });
}

function applyTerminalWorkspaceKeyboard(metrics = {}) {
    const workspace = $('#terminalWorkspace');
    if (!workspace) return;
    const activeSession = getTerminalSession(activeTerminalTab);
    const isCompact = isCompactTerminalWorkspace();
    const isTouchDevice = window.matchMedia?.('(hover: none) and (pointer: coarse)')?.matches;
    const isStableInput = !!(metrics.stableInput || (activeSession?.protocol === 'SSH' && isCompact && isTouchDevice));
    const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
    const fullscreenWindow = activeTerminalTab ? workspace.querySelector(`.terminal-window[data-window="${CSS.escape(activeTerminalTab)}"]`) : null;
    const isFullscreenTerminalSurface = fullscreenElement === workspace || fullscreenElement === fullscreenWindow || workspace.classList.contains('custom-fullscreen');
    const inset = Math.round(Number(metrics.keyboardInset) || 0);
    // Parent / iframe 在 Android WebView 键盘模式下可能分别处于 resizes-content / overlays-content，
    // 单独相信任意一侧都会出错：parent visualViewport 有时偏小，iframe visualViewport
    // 又可能保持全高。这里综合多个“键盘顶部”候选值，取一个合理的最大可见底边。
    const parentViewport = window.visualViewport;
    const parentInnerHeight = Math.round(window.innerHeight || 0);
    const parentClientHeight = Math.round(document.documentElement.clientHeight || 0);
    const parentVvHeight = Math.round(parentViewport?.height || parentInnerHeight || parentClientHeight || 0);
    const parentOffsetTop = Math.round(parentViewport?.offsetTop || 0);
    const parentKeyboardTop = Math.max(0, parentOffsetTop + parentVvHeight);
    const parentLayoutHeight = Math.max(parentInnerHeight, parentClientHeight, appKeyboardBaseline || 0, parentKeyboardTop);
    const metricsViewportHeight = Math.round(Number(metrics.viewportHeight) || 0);
    const metricsLayoutHeight = Math.round(Number(metrics.layoutHeight) || 0);
    const metricsOffsetTop = Math.round(Number(metrics.offsetTop) || 0);
    const parentInset = parentViewport ? Math.max(0, parentLayoutHeight - parentKeyboardTop) : 0;
    const effectiveInset = Math.max(inset, parentInset);
    const layoutHeight = Math.max(parentLayoutHeight, metricsLayoutHeight, parentKeyboardTop, metricsViewportHeight);
    const metricsKeyboardTop = metricsViewportHeight > 0 ? Math.max(0, metricsOffsetTop + metricsViewportHeight) : 0;
    const insetKeyboardTop = effectiveInset > 0 && layoutHeight > effectiveInset
        ? Math.max(0, layoutHeight - effectiveInset)
        : 0;
    const keyboardTopCandidates = [];
    // Only trust a visualViewport bottom as a keyboard boundary when that same side
    // actually detected an inset. In Android overlays-content/fullscreen, parent
    // visualViewport can stay at the no-keyboard height; including that full-height
    // value makes the terminal keep using the old (keyboard-closed) bottom limit.
    if (parentInset >= 80 && parentKeyboardTop > 0) keyboardTopCandidates.push(parentKeyboardTop);
    if ((metrics.keyboardOpen || inset >= 80) && metricsKeyboardTop > 0) keyboardTopCandidates.push(metricsKeyboardTop);
    if (effectiveInset >= 80 && insetKeyboardTop > 0) keyboardTopCandidates.push(insetKeyboardTop);
    const validKeyboardTopCandidates = keyboardTopCandidates.filter((value) => Number.isFinite(value) && value > 0 && value <= layoutHeight + 2);
    const keyboardTop = validKeyboardTopCandidates.length
        ? Math.max(...validKeyboardTopCandidates)
        : (parentKeyboardTop || metricsKeyboardTop || layoutHeight);
    const keyboardOpen = (!!metrics.keyboardOpen || parentInset >= 100 || inset >= 100) && effectiveInset >= 80;

    // mobile-stable-input：键盘纯覆盖，父页绝不缩高 iframe。
    // 旧路径用 keyboardTop 裁剪 workspace 高度，Android WebView 瞬态 vv 会把底栏“起飞”
    // 并抢走焦点，导致无法输入/键盘呼出失败。iframe 内靠 padding-bottom 把光标顶出键盘。
    if (isStableInput && isCompact) {
        const viewRect = document.querySelector('.terminal-view.active')?.getBoundingClientRect?.();
        const fullHeight = Math.max(
            isFullscreenTerminalSurface ? (window.innerHeight || 0) : 0,
            isFullscreenTerminalSurface ? (document.documentElement.clientHeight || 0) : 0,
            appKeyboardBaseline || 0,
            layoutHeight || 0,
            parentLayoutHeight || 0,
            Math.round(viewRect?.height || 0),
            parentVvHeight || 0,
        );
        appKeyboardPendingMetrics = keyboardOpen
            ? {
                ...metrics,
                stableInput: true,
                keyboardOpen: true,
                keyboardInset: effectiveInset,
                viewportHeight: metricsViewportHeight || parentVvHeight || Math.max(1, layoutHeight - effectiveInset),
                layoutHeight: Math.max(layoutHeight, fullHeight),
                offsetTop: parentOffsetTop,
            }
            : null;
        workspace.classList.toggle('keyboard-open', keyboardOpen);
        appKeyboardOpen = keyboardOpen;
        document.body.classList.remove('terminal-keyboard-lift');
        workspace.style.flex = isFullscreenTerminalSurface ? '0 0 auto' : '';
        if (isFullscreenTerminalSurface && fullHeight > 0) {
            workspace.style.height = `${fullHeight}px`;
            workspace.style.maxHeight = `${fullHeight}px`;
        } else {
            workspace.style.height = '';
            workspace.style.maxHeight = '';
        }
        workspace.style.minHeight = '0px';
        workspace.style.marginBottom = '0px';
        workspace.querySelectorAll('.terminal-frame').forEach((frame) => {
            frame.style.height = '100%';
            frame.style.maxHeight = '100%';
            frame.style.minHeight = '0px';
        });
        document.documentElement.style.setProperty('--app-keyboard-inset', `${keyboardOpen ? effectiveInset : 0}px`);
        document.documentElement.style.setProperty('--app-keyboard-shift', '0px');
        document.documentElement.style.setProperty('--app-visual-vh', `${isFullscreenTerminalSurface && fullHeight > 0 ? fullHeight : Math.max(fullHeight, parentKeyboardTop || 0)}px`);
        document.documentElement.style.setProperty('--app-visual-offset-top', `${parentOffsetTop}px`);
        // Keep keyboard-top as a CSS hint only; layout height stays full.
        document.documentElement.style.setProperty('--app-keyboard-top', keyboardOpen ? `${Math.max(0, Math.round((isFullscreenTerminalSurface ? fullHeight : (viewRect?.bottom || fullHeight)) - effectiveInset))}px` : '100vh');
        scheduleTerminalLayoutStabilize(keyboardOpen ? 'parent-keyboard-stable-overlay-open' : 'parent-keyboard-stable-overlay-close', { focus: false });
        return;
    }
    if (!keyboardOpen || !isFullscreenTerminalSurface) {
        if (!keyboardOpen) resetTerminalWorkspaceKeyboard();
        return;
    }

    const signature = `${Math.round(inset / 24) * 24}:${Math.round((metricsViewportHeight || parentVvHeight) / 24) * 24}:${Math.round(parentOffsetTop / 8) * 8}`;
    appKeyboardPendingMetrics = { ...metrics, keyboardInset: inset, viewportHeight: metricsViewportHeight || parentVvHeight, offsetTop: parentOffsetTop, keyboardOpen: true };
    workspace.classList.add('keyboard-settling');
    postTerminalKeyboardFreeze(true, 'parent-keyboard-opening', { settleMs: 1200 });
    window.clearTimeout(appKeyboardFreezeReleaseTimer);
    // Android visualViewport 在键盘动画期间会连续抖动多次。不要每一帧改 workspace height/通知 iframe，
    // 等 90ms 无新指标后一次性提交，视觉上像 ServerBox 一样跟随系统键盘而不是网页自己跳动。
    if (signature === appKeyboardLastSignature && appKeyboardOpen) return;
    appKeyboardLastSignature = signature;
    window.clearTimeout(appKeyboardSettleTimer);
    appKeyboardSettleTimer = window.setTimeout(() => {
        commitTerminalWorkspaceKeyboard(appKeyboardPendingMetrics || metrics);
        appKeyboardFreezeReleaseTimer = window.setTimeout(() => postTerminalKeyboardFreeze(false, 'parent-keyboard-open-settled'), 1100);
    }, appKeyboardOpen ? 70 : 110);
}

function updateFullscreenKeyboardFromViewport() {
    const workspace = $('#terminalWorkspace');
    const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
    const isCompact = isCompactTerminalWorkspace();
    const isKeyboardRelevant = workspace?.classList.contains('custom-fullscreen')
        || fullscreenElement === workspace
        || fullscreenElement?.classList?.contains('terminal-window')
        || (isCompact && document.body.classList.contains('terminal-mode'));
    if (!workspace || !isKeyboardRelevant || !window.visualViewport) return;
    const layoutHeight = Math.round(window.innerHeight || document.documentElement.clientHeight || 0);
    const vvHeight = Math.round(window.visualViewport.height || layoutHeight);
    // 键盘关闭时重置基线，避免下次打开时基值偏高
    if (!appKeyboardOpen) {
        const currentInset = layoutHeight - vvHeight - Math.round(window.visualViewport.offsetTop || 0);
        if (currentInset < 100) {
            // 键盘已关闭：用当前值直接更新基线，确保下次用正确布局高度
            appKeyboardBaseline = Math.max(appKeyboardBaseline || 0, layoutHeight, vvHeight);
        } else {
            // 键盘可能正在打开但 appKeyboardOpen 尚未设置——尽量用布局高度做基线
            appKeyboardBaseline = Math.max(appKeyboardBaseline || 0, layoutHeight, vvHeight);
        }
    }
    const baseline = Math.max(appKeyboardBaseline || 0, layoutHeight);
    const viewportHeight = vvHeight;
    const offsetTop = Math.round(window.visualViewport.offsetTop || 0);
    const inset = Math.max(0, baseline - viewportHeight - offsetTop);
    if (inset >= 100 || workspace.classList.contains('keyboard-open')) {
        applyTerminalWorkspaceKeyboard({ keyboardOpen: inset >= 16 || appKeyboardOpen, keyboardInset: inset, viewportHeight, layoutHeight: baseline, offsetTop });
    }
}

function scheduleTerminalKeyboardReflow(reason = 'terminal-keyboard-reflow') {
    appKeyboardLastSignature = '';
    [0, 80, 180, 360, 720].forEach((delay, index) => {
        window.setTimeout(() => {
            appKeyboardLastSignature = '';
            updateFullscreenKeyboardFromViewport();
            scheduleTerminalLayoutStabilize(`${reason}:phase-${index}`, { focus: false });
        }, delay);
    });
}

function ensureFullscreenLoader() {
    const workspace = $('#terminalWorkspace');
    if (!workspace) return null;
    let loader = workspace.querySelector('.terminal-fullscreen-loader');
    if (!loader) {
        loader = document.createElement('div');
        loader.className = 'terminal-fullscreen-loader';
        loader.setAttribute('aria-live', 'polite');
        loader.innerHTML = '<div class="terminal-fullscreen-spinner"></div><span>正在切换全屏...</span>';
        workspace.appendChild(loader);
    }
    return loader;
}

function showFullscreenLoading(text = '正在切换全屏...') {
    const workspace = $('#terminalWorkspace');
    const loader = ensureFullscreenLoader();
    if (!workspace || !loader) return;
    loader.querySelector('span').textContent = text;
    workspace.classList.add('fullscreen-transitioning');
    workspace.classList.add('fullscreen-loading');
    window.clearTimeout(fullscreenLoadingTimer);
    fullscreenLoadingTimer = window.setTimeout(() => hideFullscreenLoading(), 2400);
}

function hideFullscreenLoading({ delay = 520 } = {}) {
    window.clearTimeout(fullscreenLoadingTimer);
    fullscreenLoadingTimer = window.setTimeout(() => {
        const workspace = $('#terminalWorkspace');
        workspace?.classList.remove('fullscreen-loading');
        window.setTimeout(() => workspace?.classList.remove('fullscreen-transitioning'), 520);
    }, delay);
}

async function fullscreenTerminalTab(tabId) {
    const compact = isCompactTerminalWorkspace();
    const visibleBefore = visibleTerminalTabs().map((t) => t.id);
    console.debug('[terminal-layout]', 'fullscreen requested', {
        tabId,
        compact,
        visibleCount: visibleBefore.length,
        maxWindows: getEffectiveTerminalMaxWindows()
    });

    restoreTerminalSession(tabId);
    activeTerminalTab = tabId;
    touchTerminalSession(tabId);
    renderTerminalTabs();
    const workspace = $('#terminalWorkspace');
    const win = workspace?.querySelector(`.terminal-window[data-window="${CSS.escape(tabId)}"]`);
    if (!workspace || !win) return;
    showFullscreenLoading(compact ? '正在进入移动端全屏...' : '正在切换为单窗口...');
    try {
        if (compact) {
            resetTerminalWorkspaceKeyboard({ force: true });
            workspace.classList.toggle('custom-fullscreen');
            document.body.classList.toggle('terminal-custom-fullscreen-open', workspace.classList.contains('custom-fullscreen'));
            appKeyboardLastSignature = '';
            scheduleTerminalKeyboardReflow(workspace.classList.contains('custom-fullscreen') ? 'mobile-fullscreen-enter' : 'mobile-fullscreen-exit');
            renderTerminalTabs();
            hideFullscreenLoading({ delay: 360 });
            window.setTimeout(() => {
                scheduleTerminalKeyboardReflow('mobile-fullscreen-after-focus');
                win.querySelector('.terminal-frame')?.contentWindow?.postMessage({ source: 'zephyr-app', type: 'focus-terminal' }, '*');
            }, 120);
        } else {
            const minimizedIds = visibleBefore.filter((id) => id !== tabId);
            minimizedIds.forEach((id) => {
                const session = getTerminalSession(id);
                if (session) session.minimized = true;
            });
            visualLayout = [tabId];
            activeTerminalTab = tabId;
            syncVisualLayout({ preserve: false });
            console.debug('[terminal-layout]', 'desktop fullscreen uses single-window layout', {
                tabId,
                minimizedIds,
                visualLayout: [...visualLayout]
            });
            renderTerminalTabs();
            hideFullscreenLoading({ delay: 220 });
            window.setTimeout(() => {
                workspace.querySelector(`.terminal-frame[data-frame="${CSS.escape(tabId)}"]`)?.contentWindow?.postMessage({ source: 'zephyr-app', type: 'focus-terminal' }, '*');
            }, 120);
        }
    } catch (err) {
        hideFullscreenLoading({ delay: 0 });
        throw err;
    }
}

function scheduleTerminalSmartbarAutoClose(delay = 5000) {
    window.clearTimeout(terminalSmartbarTimer);
    terminalSmartbarTimer = window.setTimeout(() => {
        if (!terminalSmartbarOpen) return;
        if (Date.now() - terminalSmartbarLastInnerPointerAt < delay) {
            scheduleTerminalSmartbarAutoClose(delay);
            return;
        }
        setTerminalSmartbarOpen(false);
    }, delay);
}

function setTerminalSmartbarOpen(open) {
    window.clearTimeout(terminalSmartbarTimer);
    window.clearTimeout(setTerminalSmartbarOpen._closeTimer);
    if (!open) {
        document.querySelectorAll('#terminalWorkspace .terminal-frame').forEach((frame) => frame.style.pointerEvents = '');
        if (!terminalSmartbarOpen) return;
        terminalSmartbarOpen = false;
        terminalSmartbarPickerOpen = false;
        terminalSmartbarClosing = true;
        renderTerminalSmartbar();
        syncTerminalShelfLineState();
        scheduleTerminalKeyboardReflow('smartbar-close');
        setTerminalSmartbarOpen._closeTimer = window.setTimeout(() => {
            terminalSmartbarClosing = false;
            renderTerminalSmartbar();
            syncTerminalShelfLineState();
            scheduleTerminalKeyboardReflow('smartbar-close-settled');
        }, 760);
        return;
    }
    terminalSmartbarLastInnerPointerAt = Date.now();
    $('.main-nav')?.classList.remove('terminal-shelf-settled', 'terminal-shelf-dock-open');
    terminalSmartbarClosing = false;
    terminalSmartbarOpen = true;
    renderTerminalSmartbar();
    syncTerminalShelfLineState();
    scheduleTerminalKeyboardReflow('smartbar-open');
    scheduleTerminalSmartbarAutoClose();
}
function noteTerminalWorkspaceActivity() {}
function swapTerminalWindows(a, b) {
    if (!a || !b || a === b) return;
    const ia = visualLayout.indexOf(a), ib = visualLayout.indexOf(b);
    if (ia < 0 || ib < 0) return;
    [visualLayout[ia], visualLayout[ib]] = [visualLayout[ib], visualLayout[ia]];
    renderTerminalTabs();
}
function snapTerminalWindowToEdge(tabId, clientX, clientY) {
    const workspace = $('#terminalWorkspace');
    if (!workspace || isCompactTerminalWorkspace()) return false;
    const rect = workspace.getBoundingClientRect();
    const nearLeft = clientX - rect.left <= TERMINAL_EDGE_SNAP_PX;
    const nearRight = rect.right - clientX <= TERMINAL_EDGE_SNAP_PX;
    const nearTop = clientY - rect.top <= TERMINAL_EDGE_SNAP_PX;
    const nearBottom = rect.bottom - clientY <= TERMINAL_EDGE_SNAP_PX;
    if (!nearLeft && !nearRight && !nearTop && !nearBottom) return false;
    if (nearLeft) applyTerminalWindowPreset(tabId, 'left-half');
    else if (nearRight && nearTop) applyTerminalWindowPreset(tabId, 'right-top');
    else if (nearRight && nearBottom) applyTerminalWindowPreset(tabId, 'right-bottom');
    else if (nearRight) applyTerminalWindowPreset(tabId, 'right-half');
    else if (nearTop) applyTerminalWindowPreset(tabId, 'left-two-thirds');
    else applyTerminalWindowPreset(tabId, 'right-two-thirds');
    return true;
}
function reorderTerminalOrder(dragId, targetId) {
    if (!dragId || !targetId || dragId === targetId) return;
    const order = getTerminalSmartbarOrder();
    const stack = order === 'new-first' ? [...openOrderStack].reverse() : [...openOrderStack];
    const from = stack.indexOf(dragId);
    const to = stack.indexOf(targetId);
    if (from < 0 || to < 0) return;
    const [id] = stack.splice(from, 1);
    stack.splice(to, 0, id);
    openOrderStack = order === 'new-first' ? stack.reverse() : stack;
}
function resetDockMagnification(dock = document.querySelector('.smartbar-dock')) {
    dock?.querySelectorAll('.smartbar-session, .smartbar-add').forEach((item) => {
        item.style.removeProperty('--dock-scale');
        item.style.removeProperty('--dock-lift');
        item.style.removeProperty('--dock-shift');
        item.style.removeProperty('--dock-blur');
        item.style.removeProperty('--dock-rotate');
    });
}
function updateDockMagnification(clientX, dock = document.querySelector('.smartbar-dock'), clientY = null) {
    if (!dock) return;
    const verticalDock = isCompactTerminalWorkspace() && document.body.classList.contains('terminal-custom-fullscreen-open');
    const influence = verticalDock ? 118 : 142;
    const pointerCoord = verticalDock ? (clientY ?? smartbarDragState?.currentY ?? 0) : clientX;
    dock.querySelectorAll('.smartbar-session, .smartbar-add').forEach((item) => {
        const rect = item.getBoundingClientRect();
        const center = verticalDock ? rect.top + rect.height / 2 : rect.left + rect.width / 2;
        const d = Math.abs(pointerCoord - center);
        const t = Math.max(0, 1 - d / influence);
        const eased = 1 - Math.pow(1 - t, 3);
        const direction = Math.sign(center - pointerCoord);
        item.style.setProperty('--dock-scale', (1 + eased * 0.26).toFixed(3));
        item.style.setProperty('--dock-lift', `${(-eased * (verticalDock ? 6 : 15)).toFixed(2)}px`);
        item.style.setProperty('--dock-shift', `${(direction * eased * (verticalDock ? 9 : 8)).toFixed(2)}px`);
        item.style.setProperty('--dock-blur', `${((1 - eased) * 0.14).toFixed(2)}px`);
        item.style.setProperty('--dock-rotate', `${(direction * eased * (verticalDock ? -1.1 : -0.7)).toFixed(2)}deg`);
    });
}
function animateWindowFromDock(tabId, sourceRect, { swap = false } = {}) {
    if (!tabId || !sourceRect) return;
    requestAnimationFrame(() => {
        const win = document.querySelector(`#terminalWorkspace .terminal-window[data-window="${CSS.escape(tabId)}"]`);
        if (!win) return;
        const rect = win.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const sx = Math.max(0.08, sourceRect.width / rect.width);
        const sy = Math.max(0.06, sourceRect.height / rect.height);
        const dx = (sourceRect.left + sourceRect.width / 2) - (rect.left + rect.width / 2);
        const dy = (sourceRect.top + sourceRect.height / 2) - (rect.top + rect.height / 2);
        win.animate([
            { transform: `translate3d(${dx}px, ${dy}px, 0) scale3d(${sx}, ${sy}, 1)`, opacity: 0.28, filter: 'blur(18px) saturate(.82)', borderRadius: '30px' },
            { transform: `translate3d(${dx * 0.16}px, ${dy * 0.16 - 8}px, 0) scale3d(1.025, 1.018, 1)`, opacity: 1, filter: 'blur(0) saturate(1.08)', borderRadius: '12px', offset: 0.72 },
            { transform: 'translate3d(0, 0, 0) scale3d(1, 1, 1)', opacity: 1, filter: 'blur(0) saturate(1)', borderRadius: '0px' }
        ], { duration: swap ? 620 : 560, easing: 'cubic-bezier(.16,1,.3,1)' });
    });
}
function activateTerminalFromDock(tabId, sourceEl = null) {
    const sourceRect = sourceEl?.getBoundingClientRect?.();
    const t = getTerminalSession(tabId);
    if (!t) return;
    const mobileSwitch = isCompactTerminalWorkspace();
    if (mobileSwitch) resetTerminalWorkspaceKeyboard({ force: true });
    dockLaunchAnimatingWindows.add(tabId);
    const mobileFullscreen = mobileSwitch && document.body.classList.contains('terminal-custom-fullscreen-open');
    if (!mobileFullscreen && t && !t.minimized && activeTerminalTab === tabId) minimizeTerminalSession(tabId);
    else showTerminalSessionInWorkspace(tabId);
    if (!mobileFullscreen) scheduleTerminalSmartbarAutoClose();
    renderTerminalTabs();
    if (mobileSwitch) {
        forceCompactTerminalWorkspaceFill('dock-activate');
        scheduleTerminalLayoutStabilize('dock-activate-mobile', { focus: true, tabId });
        window.setTimeout(() => scheduleTerminalLayoutStabilize('dock-activate-mobile-settled', { focus: true, tabId }), 180);
    }
    animateWindowFromDock(tabId, sourceRect, { swap: false });
    window.setTimeout(() => {
        dockLaunchAnimatingWindows.delete(tabId);
        renderTerminalTabs({ rebuildWorkspace: false });
        if (mobileSwitch) scheduleTerminalLayoutStabilize('dock-activate-animation-settled', { focus: true, tabId });
    }, 620);
}
function replaceWindowWithDockTab(targetWindowId, draggedTabId) {
    if (!targetWindowId || !draggedTabId || targetWindowId === draggedTabId) return false;
    const target = getTerminalSession(targetWindowId);
    const dragged = getTerminalSession(draggedTabId);
    if (!target || !dragged) return false;
    dockSwapAnimatingWindows.add(targetWindowId);
    dockSwapAnimatingWindows.add(draggedTabId);
    target.minimized = true;
    dragged.minimized = false;
    const idx = visualLayout.indexOf(targetWindowId);
    if (idx >= 0) visualLayout[idx] = draggedTabId;
    else visualLayout.unshift(draggedTabId);
    activeTerminalTab = draggedTabId;
    touchTerminalSession(draggedTabId);
    syncVisualLayout({ preserve: true });
    renderTerminalTabs();
    window.setTimeout(() => {
        dockSwapAnimatingWindows.delete(targetWindowId);
        dockSwapAnimatingWindows.delete(draggedTabId);
        renderTerminalTabs({ rebuildWorkspace: false });
    }, 560);
    return true;
}
function ensureSmartbarTrashTarget() {
    let trash = document.querySelector('.smartbar-trash-target');
    if (!trash) {
        trash = document.createElement('div');
        trash.className = 'smartbar-trash-target';
        trash.innerHTML = '<span>×</span>';
        document.body.appendChild(trash);
    }
    return trash;
}
function removeSmartbarTrashTarget() {
    document.querySelector('.smartbar-trash-target')?.remove();
    document.body.classList.remove('smartbar-trash-hover');
    smartbarTrashHover = false;
}
function isPointInRect(x, y, rect, pad = 0) {
    return x >= rect.left - pad && x <= rect.right + pad && y >= rect.top - pad && y <= rect.bottom + pad;
}
function startSmartbarIconDrag(e, tabId) {
    const btn = e.target.closest?.('[data-smartbar-tab]');
    if (!btn || e.button === 2) return;
    e.preventDefault();
    suppressSmartbarClick = false;
    const ghost = btn.cloneNode(true);
    ghost.classList.add('smartbar-drag-ghost');
    document.body.appendChild(ghost);
    const trash = ensureSmartbarTrashTarget();
    document.body.classList.add('smartbar-dragging-dock');
    document.querySelectorAll('#terminalWorkspace .terminal-frame').forEach((frame) => frame.style.pointerEvents = 'none');
    const sourceRect = btn.getBoundingClientRect();
    const dock = btn.closest('.smartbar-dock');
    const fullscreenDock = isCompactTerminalWorkspace() && document.body.classList.contains('terminal-custom-fullscreen-open');
    smartbarDragState = {
        tabId,
        startX: e.clientX,
        startY: e.clientY,
        currentX: e.clientX,
        currentY: e.clientY,
        moved: false,
        ghost,
        sourceRect,
        dock,
        originCenterX: sourceRect.left + sourceRect.width / 2,
        originCenterY: sourceRect.top + sourceRect.height / 2,
        raf: 0,
    };
    btn.classList.add('dragging');
    const paintGhost = () => {
        const state = smartbarDragState;
        if (!state) return;
        state.raf = 0;
        const dx = state.currentX - state.startX;
        const dy = state.currentY - state.startY;
        ghost.style.left = `${state.currentX}px`;
        ghost.style.top = `${state.currentY}px`;
        ghost.style.transform = `translate(-50%, -50%) scale(${state.moved ? 1.11 : 1.035}) rotate(${Math.max(-6, Math.min(6, dx * 0.018))}deg)`;
        ghost.style.setProperty('--ghost-dx', `${dx}px`);
        ghost.style.setProperty('--ghost-dy', `${dy}px`);
        if (state.dock) updateDockMagnification(state.currentX, state.dock, state.currentY);
    };
    const schedulePaint = () => {
        if (smartbarDragState?.raf) return;
        smartbarDragState.raf = requestAnimationFrame(paintGhost);
    };
    paintGhost();
    const onMove = (ev) => {
        if (!smartbarDragState) return;
        smartbarDragState.currentX = ev.clientX;
        smartbarDragState.currentY = ev.clientY;
        const dx = ev.clientX - smartbarDragState.startX;
        const dy = ev.clientY - smartbarDragState.startY;
        if (Math.hypot(dx, dy) > 5) smartbarDragState.moved = true;
        ev.preventDefault?.();
        window.getSelection?.()?.removeAllRanges?.();
        schedulePaint();
        ghost.style.pointerEvents = 'none';
        const trashRect = trash.getBoundingClientRect();
        smartbarTrashHover = isPointInRect(ev.clientX, ev.clientY, trashRect, 18);
        document.body.classList.toggle('smartbar-trash-hover', smartbarTrashHover);
        trash.classList.toggle('hover', smartbarTrashHover);
        const hoverWin = smartbarTrashHover ? null : document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('.terminal-window[data-window]')?.dataset.window || null;
        if (hoverWin !== smartbarHoverWindowId) {
            smartbarHoverWindowId = hoverWin;
            document.querySelectorAll('.terminal-window').forEach((el) => el.classList.toggle('dock-drop-target', !!hoverWin && el.dataset.window === hoverWin && hoverWin !== tabId));
        }
        const targetDock = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('[data-smartbar-tab]')?.dataset.smartbarTab;
        document.querySelectorAll('[data-smartbar-tab]').forEach((el) => {
            el.classList.toggle('dock-reorder-target', !!targetDock && el.dataset.smartbarTab === targetDock && targetDock !== tabId);
        });
    };
    const cleanup = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        if (smartbarDragState?.raf) cancelAnimationFrame(smartbarDragState.raf);
        resetDockMagnification(dock);
        btn.classList.remove('dragging', 'dock-press-armed');
        document.body.classList.remove('smartbar-dragging-dock');
        document.querySelectorAll('#terminalWorkspace .terminal-frame').forEach((frame) => frame.style.pointerEvents = '');
        document.querySelectorAll('.terminal-window.dock-drop-target').forEach((el) => el.classList.remove('dock-drop-target'));
        document.querySelectorAll('[data-smartbar-tab].dock-reorder-target').forEach((el) => el.classList.remove('dock-reorder-target'));
        smartbarHoverWindowId = null;
        window.setTimeout(removeSmartbarTrashTarget, 180);
        smartbarDragState = null;
    };
    const onCancel = () => {
        cleanup();
        ghost.remove();
    };
    const onUp = (ev) => {
        const moved = smartbarDragState?.moved;
        const source = smartbarDragState?.sourceRect || ghost.getBoundingClientRect();
        const targetWin = smartbarHoverWindowId || document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('.terminal-window[data-window]')?.dataset.window;
        const targetDock = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('[data-smartbar-tab]')?.dataset.smartbarTab;
        const dropToTrash = smartbarTrashHover;
        cleanup();
        if (moved || fullscreenDock) {
            suppressSmartbarClick = true;
            if (dropToTrash) {
                ghost.classList.add('smartbar-drag-ghost-closing');
                window.setTimeout(() => ghost.remove(), 220);
                closeTerminalTab(tabId, { reason: 'dock-trash' });
                return;
            }
            if (targetWin && targetWin !== tabId) {
                replaceWindowWithDockTab(targetWin, tabId);
                animateWindowFromDock(tabId, source, { swap: true });
                ghost.remove();
                return;
            }
            if (targetDock && targetDock !== tabId) {
                reorderTerminalOrder(tabId, targetDock);
                renderTerminalSmartbar();
                ghost.remove();
                return;
            }
            if (!fullscreenDock && !targetWin && !targetDock) {
                showTerminalSessionInWorkspace(tabId);
                renderTerminalTabs();
                animateWindowFromDock(tabId, source, { swap: true });
                ghost.remove();
                return;
            }
        }
        ghost.animate([
            { transform: ghost.style.transform || 'translate(-50%, -50%) scale(1.1)', opacity: 1 },
            { transform: 'translate(-50%, -50%) scale(.78)', opacity: 0 }
        ], { duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)' }).onfinish = () => ghost.remove();
    };
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp, { once: true });
    window.addEventListener('pointercancel', onCancel, { once: true });
}

function startSmartbarPress(e, tabBtn) {
    if (!tabBtn || e.button === 2) return;
    e.preventDefault?.();
    window.getSelection?.()?.removeAllRanges?.();
    const tabId = tabBtn.dataset.smartbarTab;
    if (!tabId) return;
    const isDesktopLike = window.matchMedia?.('(hover: hover) and (pointer: fine)')?.matches;
    const holdMs = isDesktopLike && e.pointerType !== 'touch' ? 260 : 420;
    window.clearTimeout(smartbarPressState?.timer);
    smartbarPressState = {
        tabId,
        tabBtn,
        startX: e.clientX,
        startY: e.clientY,
        pointerId: e.pointerId,
        startedAt: performance.now(),
        dragStarted: false,
        cancelled: false,
        originalEvent: e,
        timer: 0,
    };
    tabBtn.classList.add('dock-press-armed');
    const cleanup = ({ keepClick = false } = {}) => {
        if (!smartbarPressState) return;
        window.clearTimeout(smartbarPressState.timer);
        smartbarPressState.tabBtn?.classList.remove('dock-press-armed');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        if (!keepClick) smartbarPressState = null;
    };
    const beginDrag = (ev = e) => {
        if (!smartbarPressState || smartbarPressState.dragStarted || smartbarPressState.cancelled) return;
        smartbarPressState.dragStarted = true;
        if (navigator.vibrate) navigator.vibrate(12);
        smartbarPressState.tabBtn?.setPointerCapture?.(smartbarPressState.pointerId);
        const dragEvent = {
            ...smartbarPressState.originalEvent,
            target: smartbarPressState.tabBtn,
            currentTarget: smartbarPressState.tabBtn,
            clientX: ev.clientX,
            clientY: ev.clientY,
            button: smartbarPressState.originalEvent.button,
            pointerType: smartbarPressState.originalEvent.pointerType,
            preventDefault: () => {},
        };
        startSmartbarIconDrag(dragEvent, smartbarPressState.tabId);
    };
    smartbarPressState.timer = window.setTimeout(() => beginDrag(), holdMs);
    const onMove = (ev) => {
        if (!smartbarPressState || ev.pointerId !== smartbarPressState.pointerId) return;
        const dx = ev.clientX - smartbarPressState.startX;
        const dy = ev.clientY - smartbarPressState.startY;
        ev.preventDefault?.();
        window.getSelection?.()?.removeAllRanges?.();
        if (!smartbarPressState.dragStarted && Math.hypot(dx, dy) > 24) {
            beginDrag(ev);
            return;
        }
    };
    const onUp = () => {
        if (!smartbarPressState) return;
        const state = smartbarPressState;
        const elapsed = performance.now() - state.startedAt;
        const wasDragging = state.dragStarted;
        state.cancelled = true;
        cleanup();
        if (wasDragging) return;
        if (elapsed <= SMARTBAR_TOUCH_TAP_MAX_MS || holdMs < SMARTBAR_TOUCH_DRAG_HOLD_MS) {
            suppressSmartbarClick = true;
            if (navigator.vibrate) navigator.vibrate(6);
            activateTerminalFromDock(state.tabId, state.tabBtn);
        }
    };
    const onCancel = () => {
        if (smartbarPressState) smartbarPressState.cancelled = true;
        smartbarPressState?.tabBtn?.classList.remove('dock-press-armed');
        cleanup();
    };
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp, { once: true });
    window.addEventListener('pointercancel', onCancel, { once: true });
}

function startTerminalWindowDrag(e, tabId) {
    if (isCompactTerminalWorkspace() || (e.target.closest?.('button') && !e.target.closest?.('.terminal-grip'))) return;
    const win = e.target.closest?.('.terminal-window');
    if (!win) return;
    e.preventDefault();
    activeTerminalTab = tabId;
    touchTerminalSession(tabId);
    terminalDragState = { id: tabId, startX: e.clientX, startY: e.clientY, moved: false };
    win.classList.add('dragging');
    document.body.classList.add('terminal-window-dragging');
    const onMove = (ev) => {
        const dx = ev.clientX - terminalDragState.startX, dy = ev.clientY - terminalDragState.startY;
        if (Math.abs(dx) + Math.abs(dy) > 6) terminalDragState.moved = true;
        win.style.setProperty('--drag-x', `${dx}px`);
        win.style.setProperty('--drag-y', `${dy}px`);
    };
    const onUp = (ev) => {
        win.style.pointerEvents = 'none';
        const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('.terminal-window')?.dataset.window;
        win.style.pointerEvents = '';
        win.classList.remove('dragging');
        win.style.removeProperty('--drag-x');
        win.style.removeProperty('--drag-y');
        document.body.classList.remove('terminal-window-dragging');
        window.removeEventListener('pointermove', onMove);
        if (target && target !== tabId) swapTerminalWindows(tabId, target);
        else if (!snapTerminalWindowToEdge(tabId, ev.clientX, ev.clientY)) renderTerminalTabs({ rebuildWorkspace: false });
        terminalDragState = null;
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerup', onUp, { once: true });
}
function startWorkspaceSplitterDrag(e, axis) {
    const workspace = $('#terminalWorkspace');
    if (!workspace) return;
    e.preventDefault();
    const splitter = e.target.closest?.('[data-splitter]');
    const rect = workspace.getBoundingClientRect();

    const splitterGapHalf = 6;

    const applyPosition = (clientX, clientY) => {
        if (axis === 'x') {
            const pct = Math.min(82, Math.max(24, ((clientX - rect.left - splitterGapHalf) / rect.width) * 100));
            workspace.style.setProperty('--workspace-split-x', `${pct.toFixed(2)}%`);
        } else {
            const pct = Math.min(78, Math.max(22, ((clientY - rect.top - splitterGapHalf) / rect.height) * 100));
            workspace.style.setProperty('--workspace-split-y', `${pct.toFixed(2)}%`);
        }
    };

    const onMove = (ev) => {
        ev.preventDefault?.();
        applyPosition(ev.clientX, ev.clientY);
    };

    const cleanup = () => {
        splitter?.releasePointerCapture?.(e.pointerId);
        splitter?.classList.remove('arming', 'dragging');
        workspace.classList.remove('splitting');
        document.body.classList.remove('terminal-workspace-splitting');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', cleanup);
        window.removeEventListener('pointercancel', cleanup);
    };

    splitter?.setPointerCapture?.(e.pointerId);
    splitter?.classList.add('dragging');
    workspace.classList.add('splitting');
    document.body.classList.add('terminal-workspace-splitting');
    applyPosition(e.clientX, e.clientY);
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', cleanup, { once: true });
    window.addEventListener('pointercancel', cleanup, { once: true });
}


const DEFAULT_AI_GUIDANCE_TEXT = `Zephyr 默认内置提示词已启用：优先使用当前连接上下文、连接标签/备注、Memory、计划器、浏览器截图预览和远程文件/命令工具；先查事实再操作，危险操作走确认。`;
function defaultAiSettings() {
    return {
        enabled: false,
        assistantName: 'Zephyr AI',
        defaultProviderId: '',
        defaultModel: '',
        systemPrompt: '',
        defaultSystemPrompt: DEFAULT_AI_GUIDANCE_TEXT,
        guidanceVersion: 1,
        codeCompletionEnabled: true,
        context: { windowTokens: 64000, maxInputChars: 90000, keepMessages: 18, toolResultChars: 30000, memoryItems: 16, maxToolRounds: 0 },
        sensitive: { requireConfirmation: true, autoConfirm: false, autoConfirmDelayMs: 2500 },
        permissions: { webSearch: true, webFetch: true, browser: true, remoteExecute: true, fileRead: true, fileWrite: true, codeEdit: true, memory: true, env: true },
        planner: { enabled: true, requirePlanBeforeTools: false },
        memory: { enabled: true, maxItems: 500 },
        providers: [],
        skills: [],
        envVars: [],
        memories: [],
        plans: [],
    };
}
function normalizeAiSettings(ai = {}) {
    const base = defaultAiSettings();
    return {
        ...base,
        ...ai,
        sensitive: { ...base.sensitive, ...(ai.sensitive || {}) },
        permissions: { ...base.permissions, ...(ai.permissions || {}) },
        planner: { ...base.planner, ...(ai.planner || {}) },
        memory: { ...base.memory, ...(ai.memory || {}) },
        context: { ...base.context, ...(ai.context || {}) },
        providers: Array.isArray(ai.providers) ? ai.providers : [],
        skills: Array.isArray(ai.skills) ? ai.skills : [],
        envVars: Array.isArray(ai.envVars) ? ai.envVars : [],
        memories: Array.isArray(ai.memories) ? ai.memories : [],
        plans: Array.isArray(ai.plans) ? ai.plans : [],
    };
}
function aiModelNames(provider = {}) {
    return String(provider.models || '').split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
}
function aiProviderKind(provider = {}) {
    const type = String(provider?.type || '').toLowerCase();
    const base = String(provider?.baseUrl || '').toLowerCase();
    if (type === 'anthropic' || type === 'claude' || base.includes('anthropic.com')) return 'anthropic';
    if (type === 'gemini' || type === 'google' || base.includes('generativelanguage.googleapis.com')) return 'gemini';
    return 'openai';
}
function aiThinkingOptionsForProvider(provider = {}, model = '') {
    const kind = aiProviderKind(provider);
    const m = String(model || provider.defaultModel || '').toLowerCase();
    if (kind === 'gemini') {
        if (/gemini-2\.5/i.test(m)) return [
            ['', '默认'], ['0', '关闭思考'], ['-1', '动态思考'], ['1024', '浅度思考'], ['8192', '深度思考'],
        ];
        return [['', '默认'], ['minimal', 'minimal'], ['low', 'low'], ['medium', 'medium'], ['high', 'high']];
    }
    if (kind === 'anthropic') return [['', '默认'], ['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['xhigh', 'xhigh']];
    return [['', '默认'], ['none', 'none'], ['minimal', 'minimal'], ['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['xhigh', 'xhigh']];
}
function aiCurrentSession() {
    if (!aiChatSessions.length) createAiChat({ silent: true });
    return aiChatSessions.find((s) => s.id === aiCurrentSessionId) || aiChatSessions[0];
}
function applyAiVisibility() {
    const ai = normalizeAiSettings(settings.ai || aiSettingsState || {});
    const enabled = !!ai.enabled;
    $('#aiNavTab')?.classList.add('force-hidden');
    $('#aiFloatingBtn')?.classList.toggle('force-hidden', !enabled);
    if (enabled) $('#aiFloatingBtn')?.classList.toggle('active', $('#aiAgentPanel')?.getAttribute('aria-hidden') === 'false');
    if (document.querySelector('#view-ai')?.classList.contains('active')) switchView('dashboard');
    renderAiHeaderSelectors();
}
function renderAiProviderOptions() {
    const ai = normalizeAiSettings(settings.ai || aiSettingsState || {});
    const providers = ai.providers || [];
    const hidden = $('#aiDefaultProvider');
    const btn = $('#aiDefaultProviderBtn');
    if (hidden) hidden.value = ai.defaultProviderId || '';
    if (btn) {
        const p = providers.find((x) => x.id === (ai.defaultProviderId || ''));
        btn.textContent = p ? (p.name || p.type || '供应商') : '自动选择第一个可用供应商';
    }
}

const AI_FIELD_PICKER_CHOICES = {
    defaultProvider: () => {
        const ai = normalizeAiSettings(settings.ai || aiSettingsState || {});
        return [
            { value: '', label: '自动选择第一个可用供应商' },
            ...(ai.providers || []).map((p) => ({ value: p.id, label: p.name || p.type || '供应商' })),
        ];
    },
    providerType: () => [
        { value: 'openai-compatible', label: 'OpenAI 兼容' },
        { value: 'anthropic', label: 'Anthropic Claude' },
        { value: 'gemini', label: 'Google Gemini' },
    ],
    providerApiMode: () => [
        { value: 'auto', label: '自动识别' },
        { value: 'chat', label: 'OpenAI Chat Completions' },
        { value: 'responses', label: 'OpenAI Responses API' },
    ],
    providerReasoning: () => [
        { value: '', label: '默认 / 不发送' },
        { value: 'none', label: 'none / 关闭（仅部分模型）' },
        { value: 'minimal', label: 'minimal' },
        { value: 'low', label: 'low' },
        { value: 'medium', label: 'medium' },
        { value: 'high', label: 'high' },
        { value: 'xhigh', label: 'xhigh（仅部分模型）' },
    ],
};

function aiFieldPickerTargets(kind = '') {
    if (kind === 'defaultProvider') return { input: $('#aiDefaultProvider'), button: $('#aiDefaultProviderBtn') };
    if (kind === 'providerType') return { input: $('#aiProviderType'), button: $('#aiProviderTypeBtn') };
    if (kind === 'providerApiMode') return { input: $('#aiProviderApiMode'), button: $('#aiProviderApiModeBtn') };
    if (kind === 'providerReasoning') return { input: $('#aiProviderReasoningEffort'), button: $('#aiProviderReasoningEffortBtn') };
    return { input: null, button: null };
}

function setAiFieldPickerValue(kind, value) {
    const { input, button } = aiFieldPickerTargets(kind);
    const choices = (AI_FIELD_PICKER_CHOICES[kind]?.() || []);
    const match = choices.find((c) => c.value === value) || choices[0];
    const resolved = match ? match.value : value;
    if (input) input.value = resolved ?? '';
    if (button) button.textContent = match?.label || String(resolved || '选择');
    if (kind === 'providerType' || kind === 'providerApiMode') updateAiProviderModalHints?.();
}

function openAiFieldPicker(kind = '', anchor = null) {
    closeAiPickerPopover();
    const choices = AI_FIELD_PICKER_CHOICES[kind]?.() || [];
    if (!choices.length || !anchor) return;
    const { input } = aiFieldPickerTargets(kind);
    const current = input?.value ?? '';
    const pop = document.createElement('div');
    pop.className = 'ai-picker-popover';
    pop.innerHTML = choices.map((item) => `<button type="button" class="ai-picker-option${item.value === current ? ' active' : ''}" data-field-kind="${escapeHtml(kind)}" data-value="${escapeHtml(item.value)}"><span>${escapeHtml(item.label)}</span>${item.value === current ? '<b>✓</b>' : ''}</button>`).join('');
    document.body.appendChild(pop);
    const rect = anchor.getBoundingClientRect();
    const pr = pop.getBoundingClientRect();
    pop.style.transformOrigin = 'top left';
    pop.style.left = `${Math.max(8, Math.min(window.innerWidth - pr.width - 8, rect.left))}px`;
    pop.style.top = `${Math.max(8, Math.min(window.innerHeight - pr.height - 8, rect.bottom + 8))}px`;
    requestAnimationFrame(() => pop.classList.add('open'));
}
function renderAiHeaderSelectors() {
    const ai = normalizeAiSettings(settings.ai || aiSettingsState || {});
    const providerSelect = $('#aiProviderSelect');
    const modelSelect = $('#aiModelSelect');
    if (!providerSelect || !modelSelect) return;
    const providers = (ai.providers || []).filter((p) => p.enabled !== false);
    const previousProviderId = providerSelect.value;
    providerSelect.value = providers.some((p) => p.id === previousProviderId) ? previousProviderId : (ai.defaultProviderId || providers[0]?.id || '');
    const p = providers.find((x) => x.id === providerSelect.value) || providers[0];
    const models = aiModelNames(p);
    const chosen = ((p?.id === ai.defaultProviderId ? ai.defaultModel : '') || p?.defaultModel || models[0] || ai.defaultModel || '').trim();
    modelSelect.value = chosen;
    $('#aiProviderPickerBtn') && ($('#aiProviderPickerBtn').textContent = p ? (p.name || p.type || '供应商') : '未配置模型');
    $('#aiModelPickerBtn') && ($('#aiModelPickerBtn').textContent = chosen || '自动选择模型');
    renderAiThinkingSelector(p, modelSelect.value || chosen);
    renderAiCapabilityStrip();
}
function renderAiThinkingSelector(provider = null, model = '') {
    const select = $('#aiThinkIntensity');
    if (!select) return;
    const previous = select.value;
    const options = aiThinkingOptionsForProvider(provider || {}, model);
    select.value = options.some(([value]) => value === previous) ? previous : '';
    const label = options.find(([value]) => value === select.value)?.[1] || '默认';
    $('#aiThinkPickerBtn') && ($('#aiThinkPickerBtn').textContent = `推理：${label}`);
}
function aiHeaderChoices(kind = '') {
    const ai = normalizeAiSettings(settings.ai || aiSettingsState || {});
    const providers = (ai.providers || []).filter((p) => p.enabled !== false);
    const provider = providers.find((p) => p.id === $('#aiProviderSelect')?.value) || providers[0] || {};
    if (kind === 'provider') return providers.map((p) => ({ value: p.id, label: p.name || p.type || '供应商' }));
    if (kind === 'model') return (aiModelNames(provider).length ? aiModelNames(provider) : [$('#aiModelSelect')?.value || provider.defaultModel || ai.defaultModel || '']).filter(Boolean).map((m) => ({ value: m, label: m }));
    if (kind === 'thinking') return aiThinkingOptionsForProvider(provider, $('#aiModelSelect')?.value || provider.defaultModel || '').map(([value, label]) => ({ value, label }));
    return [];
}
/** Custom segmented control (no native <select>). Value lives on data-value. */
function getAiSegmentValue(id, fallback = '') {
    const el = typeof id === 'string' ? document.getElementById(id) : id;
    if (!el) return fallback;
    return String(el.dataset.value || fallback);
}
function setAiSegmentValue(id, value, { silent = false } = {}) {
    const el = typeof id === 'string' ? document.getElementById(id) : id;
    if (!el) return;
    const next = String(value ?? '');
    const buttons = [...el.querySelectorAll('.ai-segment-btn')];
    const match = buttons.find((b) => b.dataset.value === next) || buttons[0];
    const resolved = match?.dataset.value || next;
    const idx = Math.max(0, buttons.findIndex((b) => b.dataset.value === resolved));
    el.dataset.value = resolved;
    el.dataset.index = String(idx);
    if (buttons.length) el.dataset.cols = String(buttons.length);
    buttons.forEach((btn) => {
        const on = btn.dataset.value === resolved;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    if (!silent) {
        if (el.id === 'aiMcpType') toggleAiMcpTypeFields();
        if (el.id === 'aiPermRuleMode') updateAiPermModeHint();
        if (el.id === 'aiCollabMode') {
            const s = aiCurrentSession();
            if (s) { s.collabMode = resolved; saveAiChats(); }
        }
    }
}
function updateAiPermModeHint() {
    const hint = $('#aiPermModeHint');
    if (!hint) return;
    const mode = getAiSegmentValue('aiPermRuleMode', 'ask');
    hint.textContent = mode === 'auto'
        ? 'Auto：只读工具自动通过，写操作仍询问'
        : mode === 'yolo'
            ? 'Yolo：除 Deny 规则外全部自动执行（高风险）'
            : 'Ask：写操作默认询问';
}
function bindAiSegmentControls(root = document) {
    root.querySelectorAll?.('.ai-segment').forEach((seg) => {
        if (!seg.dataset.cols) {
            const n = seg.querySelectorAll('.ai-segment-btn').length || 3;
            seg.dataset.cols = String(n);
        }
        setAiSegmentValue(seg, seg.dataset.value || seg.querySelector('.ai-segment-btn.active')?.dataset.value || '', { silent: true });
    });
}
function closeAiPickerPopover() { document.querySelector('.ai-picker-popover')?.remove(); }
/** In-app confirm sheet — never window.confirm. */
function openAiInlineConfirm({ title = '确认', body = '', confirmLabel = '确认', cancelLabel = '取消', danger = false, onConfirm } = {}) {
    document.querySelector('.ai-inline-confirm')?.remove();
    const mask = document.createElement('div');
    mask.className = 'ai-inline-confirm';
    mask.innerHTML = `
      <div class="ai-inline-confirm-card" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
        <div class="ai-inline-confirm-title">${escapeHtml(title)}</div>
        <div class="ai-inline-confirm-body">${escapeHtml(body)}</div>
        <div class="ai-inline-confirm-actions">
          <button type="button" class="ui-btn" data-ai-inline-cancel>${escapeHtml(cancelLabel)}</button>
          <button type="button" class="ui-btn ${danger ? 'danger' : 'btn-primary'}" data-ai-inline-ok>${escapeHtml(confirmLabel)}</button>
        </div>
      </div>`;
    const close = () => {
        mask.classList.add('closing');
        const done = () => mask.remove();
        mask.addEventListener('animationend', done, { once: true });
        setTimeout(done, 220);
    };
    mask.addEventListener('click', (e) => {
        if (e.target === mask || e.target.closest?.('[data-ai-inline-cancel]')) close();
        if (e.target.closest?.('[data-ai-inline-ok]')) {
            close();
            try { onConfirm?.(); } catch (err) { toast(err.message || String(err)); }
        }
    });
    document.body.appendChild(mask);
    requestAnimationFrame(() => mask.classList.add('open'));
    mask.querySelector('[data-ai-inline-ok]')?.focus?.();
}
function openAiPicker(kind = '', anchor = null) {
    closeAiPickerPopover();
    const choices = aiHeaderChoices(kind);
    if (!choices.length || !anchor) return;
    const current = kind === 'provider' ? $('#aiProviderSelect')?.value : kind === 'model' ? $('#aiModelSelect')?.value : $('#aiThinkIntensity')?.value;
    const pop = document.createElement('div');
    pop.className = 'ai-picker-popover';
    pop.innerHTML = choices.map((item) => `<button type="button" class="ai-picker-option${item.value === current ? ' active' : ''}" data-kind="${escapeHtml(kind)}" data-value="${escapeHtml(item.value)}"><span>${escapeHtml(item.label)}</span>${item.value === current ? '<b>✓</b>' : ''}</button>`).join('');
    document.body.appendChild(pop);
    const rect = anchor.getBoundingClientRect();
    const pr = pop.getBoundingClientRect();
    // origin near trigger (popover, not modal)
    pop.style.transformOrigin = 'top left';
    pop.style.left = `${Math.max(8, Math.min(window.innerWidth - pr.width - 8, rect.left))}px`;
    pop.style.top = `${Math.max(8, Math.min(window.innerHeight - pr.height - 8, rect.bottom + 8))}px`;
    requestAnimationFrame(() => pop.classList.add('open'));
}
function applyAiPickerChoice(kind = '', value = '') {
    if (kind === 'provider') { $('#aiProviderSelect').value = value; renderAiHeaderSelectors(); }
    if (kind === 'model') { $('#aiModelSelect').value = value; const ai = normalizeAiSettings(settings.ai || aiSettingsState || {}); const p = (ai.providers || []).find((x) => x.id === $('#aiProviderSelect')?.value) || {}; $('#aiModelPickerBtn').textContent = value || '自动选择模型'; renderAiThinkingSelector(p, value); }
    if (kind === 'thinking') { $('#aiThinkIntensity').value = value; const ai = normalizeAiSettings(settings.ai || aiSettingsState || {}); const p = (ai.providers || []).find((x) => x.id === $('#aiProviderSelect')?.value) || {}; renderAiThinkingSelector(p, $('#aiModelSelect')?.value || ''); }
    closeAiPickerPopover();
}
function formatTokenValue(n) {
    const v = Number(n) || 0;
    if (v >= 1000000) return `${(v / 1000000).toFixed(1)}M`;
    if (v >= 1000) return `${(v / 1000).toFixed(1)}K`;
    return String(Math.round(v));
}
async function openAiUsageSheet(messageMetrics = null, anchor = null) {
    document.querySelector('.ai-usage-popover')?.remove();
    let metrics = {};
    try { metrics = (await api('/api/ai/metrics')).metrics || {}; } catch (_) {}
    const ai = normalizeAiSettings(settings.ai || aiSettingsState || {});
    const provider = (ai.providers || []).find((p) => p.id === $('#aiProviderSelect')?.value) || {};
    const model = $('#aiModelSelect')?.value || provider.defaultModel || '';
    const context = ai.context || {};
    const opts = provider.options || {};
    const thinking = $('#aiThinkIntensity')?.value || '';
    const samples = metrics.samples || [];
    const msg = messageMetrics && typeof messageMetrics === 'object' ? messageMetrics : {};
    const totals = samples.reduce((acc, s) => { acc.inputChars += Number(s.inputCharsBeforeCompact || 0); acc.rounds += Number(s.providerCalls || 0); return acc; }, { inputChars: 0, rounds: 0 });
    const pop = document.createElement('div');
    pop.className = 'ai-usage-popover';
    pop.innerHTML = `<div class="ai-usage-head"><h2>会话 Token 用量</h2><button class="ai-usage-close" type="button" aria-label="关闭">×</button></div>
        <div class="ai-usage-body">
            <div class="ai-usage-section">上下文</div>
            <div class="ai-usage-row"><span>已用上下文</span><b>${formatTokenValue(Math.round((samples[0]?.inputCharsBeforeCompact || totals.inputChars || 0) / 2.4))}</b></div>
            <div class="ai-usage-row"><span>上下文窗口</span><b>${formatTokenValue(opts.context?.windowTokens || context.windowTokens || 0)}</b></div>
            <div class="ai-usage-row"><span>最大输出</span><b>${formatTokenValue(opts.max_output_tokens || opts.max_tokens || 0)}</b></div>
            <div class="ai-usage-row"><span>本轮耗时</span><b>${msg.durationMs ? (Number(msg.durationMs) / 1000).toFixed(1) + 's' : '—'}</b></div>
            <div class="ai-usage-section">思考</div>
            <div class="ai-usage-row"><span>思考</span><b>${thinking ? '开' : '默认'}</b></div>
            <div class="ai-usage-row"><span>级别</span><b>${escapeHtml(thinking || '默认')}</b></div>
            <div class="ai-usage-row"><span>已支持</span><b>${escapeHtml(aiProviderKind(provider) === 'openai' ? '视模型而定' : '是')}</b></div>
            <div class="ai-usage-section">TOKEN（近期总计）</div>
            <div class="ai-usage-row"><span>输入（估算）</span><b>${formatTokenValue(Math.round(totals.inputChars / 2.4))}</b></div>
            <div class="ai-usage-row"><span>输出</span><b>—</b></div>
            <div class="ai-usage-section">AGENT 循环</div>
            <div class="ai-usage-row"><span>本轮循环次数</span><b>${formatTokenValue(msg.providerCalls || 0)}</b></div>
            <div class="ai-usage-row"><span>总循环次数</span><b>${formatTokenValue(totals.rounds)}</b></div>
            <div class="ai-usage-row"><span>近期请求数</span><b>${formatTokenValue(metrics.count || samples.length || 0)}</b></div>
        </div>`;
    document.body.appendChild(pop);
    const rect = anchor?.getBoundingClientRect?.() || document.querySelector('#aiUsageBtn')?.getBoundingClientRect?.() || null;
    const pr = pop.getBoundingClientRect();
    if (rect) {
        pop.style.left = `${Math.max(8, Math.min(window.innerWidth - pr.width - 8, rect.right - pr.width))}px`;
        pop.style.top = `${Math.max(8, Math.min(window.innerHeight - pr.height - 8, rect.bottom + 8))}px`;
    }
    pop.querySelector('.ai-usage-close')?.addEventListener('click', () => pop.remove());
}
function renderAiCapabilityStrip() {
    const strip = $('#aiCapabilityStrip');
    if (strip) strip.innerHTML = '';
}
function renderAiSettingsForm() {
    const ai = normalizeAiSettings(settings.ai || {});
    aiSettingsState = ai;
    $('#aiEnabled').checked = !!ai.enabled;
    $('#aiAssistantName').value = ai.assistantName || 'Zephyr AI';
    $('#aiDefaultModel').value = ai.defaultModel || '';
    $('#aiSystemPrompt').value = ai.systemPrompt || '';
    $('#aiCodeCompletionEnabled').checked = ai.codeCompletionEnabled !== false;
    if ($('#aiContextWindowTokens')) $('#aiContextWindowTokens').value = ai.context?.windowTokens ?? 64000;
    if ($('#aiContextMaxInputChars')) $('#aiContextMaxInputChars').value = ai.context?.maxInputChars ?? 90000;
    if ($('#aiContextKeepMessages')) $('#aiContextKeepMessages').value = ai.context?.keepMessages ?? 18;
    if ($('#aiContextToolResultChars')) $('#aiContextToolResultChars').value = ai.context?.toolResultChars ?? 30000;
    if ($('#aiContextMaxToolRounds')) $('#aiContextMaxToolRounds').value = ai.context?.maxToolRounds ?? 0;
    $('#aiRequireConfirmation').checked = ai.sensitive?.requireConfirmation !== false;
    $('#aiAutoConfirm').checked = !!ai.sensitive?.autoConfirm;
    $('#aiAutoConfirmDelayMs').value = ai.sensitive?.autoConfirmDelayMs ?? 2500;
    const p = ai.permissions || {};
    $('#aiPermWebSearch').checked = p.webSearch !== false;
    $('#aiPermWebFetch').checked = p.webFetch !== false;
    $('#aiPermBrowser').checked = p.browser !== false;
    $('#aiPermRemoteExecute').checked = p.remoteExecute !== false;
    $('#aiPermFileRead').checked = p.fileRead !== false;
    $('#aiPermFileWrite').checked = p.fileWrite !== false;
    $('#aiPermCodeEdit').checked = p.codeEdit !== false;
    $('#aiPermMemory').checked = p.memory !== false;
    $('#aiPermNotesRead').checked = p.notesRead !== false;
    $('#aiPermNotesWrite').checked = p.notesWrite !== false;
    $('#aiPermEnv').checked = p.env !== false;
    $('#aiMemoryEnabled').checked = ai.memory?.enabled !== false;
    $('#aiMemoryMaxItems').value = ai.memory?.maxItems ?? 500;
    $('#aiPlannerEnabled').checked = ai.planner?.enabled !== false;
    $('#aiRequirePlanBeforeTools').checked = !!ai.planner?.requirePlanBeforeTools;
    setAiSegmentValue('aiPermRuleMode', ai.permissions?.mode || 'ask', { silent: true });
    updateAiPermModeHint();
    if ($('#aiPermDeny')) $('#aiPermDeny').value = (ai.permissions?.deny || []).join('\n');
    if ($('#aiPermAllow')) $('#aiPermAllow').value = (ai.permissions?.allow || []).join('\n');
    if ($('#aiPermAsk')) $('#aiPermAsk').value = (ai.permissions?.ask || []).join('\n');
    renderAiProviderOptions();
    renderAiProviderList();
    renderAiEnvList();
    renderAiMemoryList();
    renderAiPlanList();
    renderAiSkillList();
    renderAiMcpList();
    applyAiVisibility();
}
function parseEnvLines(text = '') {
    const env = {};
    String(text || '').split('\n').forEach((line) => {
        const s = line.trim();
        if (!s || s.startsWith('#')) return;
        const i = s.indexOf('=');
        if (i <= 0) return;
        env[s.slice(0, i).trim()] = s.slice(i + 1).trim();
    });
    return env;
}
function parseHeaderLines(text = '') {
    const headers = {};
    String(text || '').split('\n').forEach((line) => {
        const s = line.trim();
        if (!s) return;
        const i = s.indexOf(':');
        if (i <= 0) return;
        headers[s.slice(0, i).trim()] = s.slice(i + 1).trim();
    });
    return headers;
}
function renderAiMcpList() {
    const list = $('#aiMcpList');
    if (!list) return;
    const servers = Array.isArray(aiSettingsState?.mcpServers) ? aiSettingsState.mcpServers : (settings.ai?.mcpServers || []);
    if (!servers.length) {
        list.innerHTML = '<p class="empty-state">暂无 MCP 服务器。配置后由 Go AI Runtime 在每次 run 时连接。</p>';
        return;
    }
    list.innerHTML = servers.map((s) => {
        const detail = s.type === 'http' ? escapeHtml(s.url || '') : escapeHtml([s.command, ...(s.args || [])].filter(Boolean).join(' '));
        return `<div class="ai-list-row" data-ai-mcp-id="${escapeHtml(s.id)}">
            <div class="ai-list-main"><strong>${escapeHtml(s.name)}</strong>
            <span class="muted">${escapeHtml(s.type)} · ${s.enabled === false ? '停用' : '启用'}</span>
            <div class="muted mono">${detail}</div></div>
            <div class="ai-list-actions">
                <button type="button" class="tool-btn" data-ai-mcp-edit="${escapeHtml(s.id)}">编辑</button>
                <button type="button" class="tool-btn danger" data-ai-mcp-del="${escapeHtml(s.id)}">删除</button>
            </div></div>`;
    }).join('');
}
function resetAiMcpForm() {
    $('#aiMcpId').value = '';
    $('#aiMcpName').value = '';
    setAiSegmentValue('aiMcpType', 'stdio', { silent: true });
    $('#aiMcpCommand').value = '';
    $('#aiMcpArgs').value = '';
    $('#aiMcpEnv').value = '';
    $('#aiMcpUrl').value = '';
    $('#aiMcpHeaders').value = '';
    $('#aiMcpTrustedReadOnly').value = '';
    $('#aiMcpTimeout').value = '300';
    $('#aiMcpEnabled').checked = true;
    toggleAiMcpTypeFields();
}
function toggleAiMcpTypeFields() {
    const http = getAiSegmentValue('aiMcpType', 'stdio') === 'http';
    $('#aiMcpStdioFields')?.classList.toggle('force-hidden', http);
    $('#aiMcpHttpFields')?.classList.toggle('force-hidden', !http);
}
function fillAiMcpForm(s) {
    if (!s) return resetAiMcpForm();
    $('#aiMcpId').value = s.id || '';
    $('#aiMcpName').value = s.name || '';
    setAiSegmentValue('aiMcpType', s.type === 'http' ? 'http' : 'stdio', { silent: true });
    $('#aiMcpCommand').value = s.command || '';
    $('#aiMcpArgs').value = Array.isArray(s.args) ? s.args.join(' ') : '';
    $('#aiMcpEnv').value = s.env ? Object.entries(s.env).map(([k, v]) => `${k}=${v}`).join('\n') : '';
    $('#aiMcpUrl').value = s.url || '';
    $('#aiMcpHeaders').value = s.headers ? Object.entries(s.headers).map(([k, v]) => `${k}: ${v}`).join('\n') : '';
    $('#aiMcpTrustedReadOnly').value = Array.isArray(s.trustedReadOnlyTools) ? s.trustedReadOnlyTools.join(', ') : '';
    $('#aiMcpTimeout').value = s.callTimeoutSeconds || 300;
    $('#aiMcpEnabled').checked = s.enabled !== false;
    toggleAiMcpTypeFields();
}
async function saveAiMcpFromForm(e) {
    e?.preventDefault?.();
    const ai = normalizeAiSettings(settings.ai || {});
    const id = $('#aiMcpId').value || (crypto.randomUUID?.() || `mcp_${Date.now()}`);
    const type = getAiSegmentValue('aiMcpType', 'stdio') === 'http' ? 'http' : 'stdio';
    const next = {
        id,
        name: $('#aiMcpName').value.trim(),
        type,
        command: $('#aiMcpCommand').value.trim(),
        args: $('#aiMcpArgs').value.trim().split(/\s+/).filter(Boolean),
        env: parseEnvLines($('#aiMcpEnv').value),
        url: $('#aiMcpUrl').value.trim(),
        headers: parseHeaderLines($('#aiMcpHeaders').value),
        trustedReadOnlyTools: $('#aiMcpTrustedReadOnly').value.split(/[\n,]/).map((x) => x.trim()).filter(Boolean),
        callTimeoutSeconds: Number($('#aiMcpTimeout').value) || 300,
        enabled: $('#aiMcpEnabled').checked,
        updatedAt: Date.now(),
    };
    if (!next.name) return toast('MCP 名称不能为空');
    if (type === 'http' && !next.url) return toast('HTTP MCP 需要 URL');
    if (type === 'stdio' && !next.command) return toast('stdio MCP 需要命令');
    const list = Array.isArray(ai.mcpServers) ? ai.mcpServers.slice() : [];
    const idx = list.findIndex((x) => x.id === id);
    if (idx >= 0) list[idx] = next; else list.push(next);
    settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ ai: { ...ai, mcpServers: list } }) });
    aiSettingsState = normalizeAiSettings(settings.ai || {});
    renderAiMcpList();
    resetAiMcpForm();
    toast('MCP 已保存');
}
async function deleteAiMcp(id) {
    const ai = normalizeAiSettings(settings.ai || {});
    const list = (ai.mcpServers || []).filter((s) => s.id !== id);
    settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ ai: { ...ai, mcpServers: list } }) });
    aiSettingsState = normalizeAiSettings(settings.ai || {});
    renderAiMcpList();
    toast('已删除');
}
function collectAiSettingsForm() {
    const old = normalizeAiSettings(settings.ai || aiSettingsState || {});
    return {
        ...old,
        enabled: $('#aiEnabled').checked,
        assistantName: $('#aiAssistantName').value.trim() || 'Zephyr AI',
        defaultProviderId: $('#aiDefaultProvider').value,
        defaultModel: $('#aiDefaultModel').value.trim(),
        systemPrompt: $('#aiSystemPrompt').value,
        codeCompletionEnabled: $('#aiCodeCompletionEnabled').checked,
        context: {
            windowTokens: Number($('#aiContextWindowTokens')?.value) || 64000,
            maxInputChars: Number($('#aiContextMaxInputChars')?.value) || 90000,
            keepMessages: Number($('#aiContextKeepMessages')?.value) || 18,
            toolResultChars: Number($('#aiContextToolResultChars')?.value) || 30000,
            memoryItems: old.context?.memoryItems ?? 16,
            maxToolRounds: Math.max(0, Number($('#aiContextMaxToolRounds')?.value) || 0),
        },
        sensitive: { requireConfirmation: $('#aiRequireConfirmation').checked, autoConfirm: $('#aiAutoConfirm').checked, autoConfirmDelayMs: Number($('#aiAutoConfirmDelayMs').value) || 0 },
        permissions: {
            webSearch: $('#aiPermWebSearch').checked,
            webFetch: $('#aiPermWebFetch').checked,
            browser: $('#aiPermBrowser').checked,
            remoteExecute: $('#aiPermRemoteExecute').checked,
            fileRead: $('#aiPermFileRead').checked,
            fileWrite: $('#aiPermFileWrite').checked,
            codeEdit: $('#aiPermCodeEdit').checked,
            memory: $('#aiPermMemory').checked,
            notesRead: $('#aiPermNotesRead').checked,
            notesWrite: $('#aiPermNotesWrite').checked,
            env: $('#aiPermEnv').checked,
            mode: getAiSegmentValue('aiPermRuleMode', 'ask'),
            deny: String($('#aiPermDeny')?.value || '').split('\n').map((x) => x.trim()).filter(Boolean),
            allow: String($('#aiPermAllow')?.value || '').split('\n').map((x) => x.trim()).filter(Boolean),
            ask: String($('#aiPermAsk')?.value || '').split('\n').map((x) => x.trim()).filter(Boolean),
        },
        planner: { enabled: $('#aiPlannerEnabled').checked, requirePlanBeforeTools: $('#aiRequirePlanBeforeTools').checked },
        memory: { enabled: $('#aiMemoryEnabled').checked, maxItems: Number($('#aiMemoryMaxItems').value) || 500 },
    };
}
async function saveAiSettings(e) {
    e?.preventDefault?.();
    const ai = collectAiSettingsForm();
    settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ ai }) });
    settings.ai = normalizeAiSettings(settings.ai || ai);
    renderAiSettingsForm();
    toast('AI 助理设置已保存');
}
async function openAiProviderModal(provider = null) {
    if (provider && provider.owned === false) { toast('共享 Provider 只能调用，不能编辑'); return; }
    const modal = $('#aiProviderModal');
    $('#aiProviderModalTitle').textContent = provider ? '编辑模型供应商' : '添加模型供应商';
    $('#aiProviderId').value = provider?.id || '';
    $('#aiProviderName').value = provider?.name || '';
    setAiFieldPickerValue('providerType', provider?.type || 'openai-compatible');
    $('#aiProviderBaseUrl').value = provider?.baseUrl || '';
    $('#aiProviderApiKey').value = provider?.hasApiKey ? '******' : '';
    setAiFieldPickerValue('providerApiMode', provider?.apiMode || provider?.options?.apiMode || 'auto');
    $('#aiProviderModels').value = Array.isArray(provider?.models) ? provider.models.join('\n') : (provider?.models || '');
    $('#aiProviderDefaultModel').value = provider?.defaultModel || '';
    if ($('#aiProviderModelUserAgents')) $('#aiProviderModelUserAgents').value = provider?.modelUserAgents || '';
    $('#aiProviderOrganization').value = provider?.organization || provider?.options?.organization || '';
    $('#aiProviderExtraHeaders').value = provider?.extraHeaders || '';
    $('#aiProviderTemperature').value = provider?.options?.temperature ?? -1;
    $('#aiProviderTopP').value = provider?.options?.top_p ?? -1;
    $('#aiProviderMaxTokens').value = provider?.options?.max_tokens ?? provider?.options?.max_output_tokens ?? 4096;
    if ($('#aiProviderContextWindow')) $('#aiProviderContextWindow').value = provider?.options?.context?.windowTokens ?? '';
    if ($('#aiProviderUsePreviousResponse')) $('#aiProviderUsePreviousResponse').checked = !!provider?.options?.use_previous_response_id;
    setAiFieldPickerValue('providerReasoning', provider?.options?.reasoning_effort || '');
    $('#aiProviderPresencePenalty').value = provider?.options?.presence_penalty ?? 0;
    $('#aiProviderFrequencyPenalty').value = provider?.options?.frequency_penalty ?? 0;
    $('#aiProviderExtraJson').value = provider?.options?.extraJson || '';
    updateAiProviderModalHints();
    $('#aiProviderEnabled').checked = provider?.enabled !== false;
    $('#aiProviderShareUsers').checked = !!provider?.shareWithUsers;
    $('#aiProviderShareAdmins').checked = !!provider?.shareWithAdmins;
    aiProviderSelectedUserIds = new Set(provider?.sharedUserIds || []);
    aiProviderShareTargetsState = (await api('/api/ai/share-targets').catch(() => ({ users: [] }))).users || [];
    renderAiProviderShareTargets();
    $('#aiProviderShareSearch').oninput = renderAiProviderShareTargets;
    modal.classList.add('show', 'app-visible');
    modal.setAttribute('aria-hidden', 'false');
}
function renderAiProviderShareTargets() {
    const root = $('#aiProviderShareTargets');
    if (!root) return;
    const q = String($('#aiProviderShareSearch')?.value || '').trim().toLowerCase();
    const users = aiProviderShareTargetsState.filter((u) => !q || String(u.username || '').toLowerCase().includes(q));
    root.innerHTML = users.length ? users.map((u) => `<label class="check-line ai-provider-share-user"><input type="checkbox" data-ai-share-user="${escapeHtml(u.userId)}" ${aiProviderSelectedUserIds.has(u.userId) ? 'checked' : ''}><span>${escapeHtml(u.username)}</span><small>${u.role === 'admin' ? '管理员' : '普通用户'}</small></label>`).join('') : '<span class="muted">没有匹配用户</span>';
    root.querySelectorAll('[data-ai-share-user]').forEach((input) => input.addEventListener('change', () => {
        if (input.checked) aiProviderSelectedUserIds.add(input.dataset.aiShareUser);
        else aiProviderSelectedUserIds.delete(input.dataset.aiShareUser);
    }));
}
function closeAiProviderModal() {
    const modal = $('#aiProviderModal');
    modal.classList.remove('show', 'app-visible');
    modal.setAttribute('aria-hidden', 'true');
}
async function saveAiProvider(e) {
    e.preventDefault();
    const existingId = $('#aiProviderId').value || '';
    const providerTypeValue = $('#aiProviderType').value;
    const apiKeyValue = $('#aiProviderApiKey').value;
    const payload = {
        name: $('#aiProviderName').value.trim() || '未命名供应商',
        type: providerTypeValue,
        enabled: $('#aiProviderEnabled').checked,
        baseUrl: $('#aiProviderBaseUrl').value.trim(),
        apiMode: ['openai-compatible', 'openai'].includes(providerTypeValue) ? ($('#aiProviderApiMode').value || 'auto') : 'native',
        models: $('#aiProviderModels').value,
        defaultModel: $('#aiProviderDefaultModel').value.trim(),
        modelUserAgents: $('#aiProviderModelUserAgents')?.value.trim() || '',
        organization: $('#aiProviderOrganization').value.trim(),
        extraHeaders: $('#aiProviderExtraHeaders').value.trim(),
        options: {
            temperature: Number($('#aiProviderTemperature').value),
            top_p: Number($('#aiProviderTopP').value),
            max_tokens: Number($('#aiProviderMaxTokens').value) || 4096,
            max_output_tokens: Number($('#aiProviderMaxTokens').value) || 4096,
            reasoning_effort: $('#aiProviderReasoningEffort').value,
            use_previous_response_id: !!$('#aiProviderUsePreviousResponse')?.checked,
            context: { windowTokens: Number($('#aiProviderContextWindow')?.value) || undefined },
            presence_penalty: Number($('#aiProviderPresencePenalty').value) || 0,
            frequency_penalty: Number($('#aiProviderFrequencyPenalty').value) || 0,
            extraJson: $('#aiProviderExtraJson').value.trim(),
        },
        shareWithUsers: !!$('#aiProviderShareUsers').checked,
        shareWithAdmins: !!$('#aiProviderShareAdmins').checked,
        sharedUserIds: Array.from(aiProviderSelectedUserIds),
    };
    if (apiKeyValue && apiKeyValue !== '******') payload.apiKey = apiKeyValue;
    const result = existingId
        ? await api(`/api/ai/providers/${encodeURIComponent(existingId)}`, { method: 'PATCH', body: JSON.stringify(payload) })
        : await api('/api/ai/providers', { method: 'POST', body: JSON.stringify(payload) });
    const savedId = result.provider.id;
    const visible = await api('/api/ai/providers');
    settings.ai = { ...(settings.ai || {}), providers: visible.providers || [] };
    aiSettingsState = normalizeAiSettings(settings.ai);
    closeAiProviderModal();
    renderAiSettingsForm();
    const shouldAutoFetchModels = !aiModelNames(result.provider).length && result.provider.enabled !== false && (result.provider.hasApiKey || !!payload.apiKey);
    if (shouldAutoFetchModels) {
        toast('模型供应商已保存，正在获取模型...');
        await fetchAiModelsForProvider(savedId);
    } else toast('模型供应商已保存');
    // Provider persistence is handled by the per-user API above.
}
function renderAiProviderList() {
    const list = $('#aiProviderList');
    if (!list) return;
    const ai = normalizeAiSettings(settings.ai || aiSettingsState || {});
    list.innerHTML = ai.providers.length ? ai.providers.map((p) => {
        const models = aiModelNames(p);
        const modelText = p.defaultModel || models[0] || (p.modelsPending ? '可点击获取模型' : '未获取模型');
        const owned = p.owned !== false;
        const sharedLabels = [];
        if (p.shareWithUsers) sharedLabels.push('所有用户');
        if (p.shareWithAdmins) sharedLabels.push('所有管理员');
        if (Array.isArray(p.sharedUserIds) && p.sharedUserIds.length) sharedLabels.push(`指定用户 ${p.sharedUserIds.length}`);
        const source = owned ? '我的 Provider' : `由 ${p.ownerUsername || '其他用户'} 共享`;
        return `<div class="ai-provider-item" data-provider-id="${escapeHtml(p.id)}"><div><strong>${escapeHtml(p.name || '未命名供应商')}</strong><span>${escapeHtml(p.type || 'openai-compatible')} · ${p.enabled === false ? '已停用' : '已启用'} · ${escapeHtml(modelText)} · ${escapeHtml(source)}${sharedLabels.length ? ` · 共享：${escapeHtml(sharedLabels.join('、'))}` : ''}</span><code>${escapeHtml(p.baseUrl || '默认 API 地址')}</code></div><button class="tool-btn" data-ai-fetch-provider-models="${escapeHtml(p.id)}">获取模型</button>${owned ? `<button class="tool-btn" data-ai-reveal-provider-key="${escapeHtml(p.id)}">查看 Key</button><button class="tool-btn" data-ai-edit-provider="${escapeHtml(p.id)}">编辑</button><button class="tool-btn danger" data-ai-delete-provider="${escapeHtml(p.id)}">删除</button>` : '<span class="muted">仅可调用</span>'}</div>`;
    }).join('') : '<p class="empty-state">暂无可用模型供应商。创建自己的 Provider，或让其他用户共享给你。</p>';
}
async function fetchAiModelsForProvider(id = '') {
    const ai = normalizeAiSettings(settings.ai || aiSettingsState || {});
    const provider = id
        ? ai.providers.find((p) => p.id === id)
        : {
            id: $('#aiProviderId').value || 'modal',
            name: $('#aiProviderName').value.trim() || '临时供应商',
            type: $('#aiProviderType').value,
            baseUrl: $('#aiProviderBaseUrl').value.trim(),
            apiMode: $('#aiProviderApiMode').value || 'auto',
            apiKey: $('#aiProviderApiKey').value,
            organization: $('#aiProviderOrganization').value.trim(),
            extraHeaders: $('#aiProviderExtraHeaders').value.trim(),
            modelUserAgents: $('#aiProviderModelUserAgents')?.value.trim() || '',
        };
    if (!provider) return toast('供应商不存在');
    if (!id && (!provider.apiKey || provider.apiKey === '******')) return toast('请先填写 API Key，或保存后再获取模型');
    try {
        const data = await api('/api/ai/models', { method: 'POST', body: JSON.stringify(id ? { providerId: id } : { provider }) });
        const names = (data.models || []).map((m) => m.id || m.name).filter(Boolean);
        const uniqueNames = Array.from(new Set(names));
        if (!uniqueNames.length) return toast('没有获取到模型');
        if (id) {
            if (provider.owned === false) return toast(`已获取 ${uniqueNames.length} 个模型（共享 Provider 不能修改）`);
            await api(`/api/ai/providers/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ models: uniqueNames, defaultModel: provider.defaultModel || uniqueNames[0] }) });
            const visible = await api('/api/ai/providers');
            settings.ai = { ...(settings.ai || {}), providers: visible.providers || [] };
            aiSettingsState = normalizeAiSettings(settings.ai);
            renderAiSettingsForm();
        } else {
            $('#aiProviderModels').value = uniqueNames.join('\n');
            if (!$('#aiProviderDefaultModel').value) $('#aiProviderDefaultModel').value = uniqueNames[0] || '';
        }
        toast(`已获取 ${uniqueNames.length} 个模型`);
    } catch (err) { toast(err.message || '获取模型失败'); }
}

async function deleteAiProvider(id) {
    openAiInlineConfirm({
        title: '删除模型供应商',
        body: '删除后需重新配置 API Key 与模型列表。',
        confirmLabel: '删除',
        danger: true,
        onConfirm: async () => {
            await api(`/api/ai/providers/${encodeURIComponent(id)}`, { method: 'DELETE' });
            const visible = await api('/api/ai/providers');
            settings.ai = { ...(settings.ai || {}), providers: visible.providers || [] };
            aiSettingsState = normalizeAiSettings(settings.ai);
            renderAiSettingsForm();
            toast('模型供应商已删除');
        },
    });
}

function resetAiEnvForm() {
    $('#aiEnvId').value = '';
    $('#aiEnvName').value = '';
    $('#aiEnvDescription').value = '';
    $('#aiEnvValue').value = '';
    $('#aiEnvValue').type = 'password';
    $('#toggleAiEnvValue').textContent = '👁️';
    $('#aiEnvEnabled').checked = true;
    $('#aiEnvVisibleToAi').checked = false;
    $('#aiEnvValueVisibleToAi').checked = false;
}
function renderAiEnvList() {
    const list = $('#aiEnvList');
    if (!list) return;
    const ai = normalizeAiSettings(settings.ai || aiSettingsState || {});
    list.innerHTML = ai.envVars.length ? ai.envVars.map((item) => `<div class="ai-env-item" data-env-id="${escapeHtml(item.id)}"><div><strong>${escapeHtml(item.name || 'UNNAMED')}</strong><span>${item.enabled === false ? '已停用' : '已启用'} · ${item.hasValue || item.value ? '已保存值' : '无值'} · ${item.visibleToAi ? 'AI可见' : 'AI屏蔽'}${item.valueVisibleToAi ? '/值可见' : ''} · ${escapeHtml(item.description || '')}</span></div><button class="tool-btn" data-ai-edit-env="${escapeHtml(item.id)}">编辑</button><button class="tool-btn danger" data-ai-delete-env="${escapeHtml(item.id)}">删除</button></div>`).join('') : '<p class="empty-state">暂无 AI 环境变量。变量值会加密保存，AI 读取时需要敏感确认。</p>';
}
async function saveAiEnv(e) {
    e.preventDefault();
    const ai = normalizeAiSettings(settings.ai || aiSettingsState || {});
    const id = $('#aiEnvId').value || `env-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const idx = ai.envVars.findIndex((x) => x.id === id);
    const oldItem = idx >= 0 ? ai.envVars[idx] : {};
    const rawValue = $('#aiEnvValue').value;
    const item = {
        id,
        name: $('#aiEnvName').value.trim(),
        description: $('#aiEnvDescription').value.trim(),
        value: rawValue === '******' ? (oldItem.value || '') : rawValue,
        enabled: $('#aiEnvEnabled').checked,
        visibleToAi: $('#aiEnvVisibleToAi').checked,
        valueVisibleToAi: $('#aiEnvValueVisibleToAi').checked,
        updatedAt: Date.now(),
    };
    if (!item.name) return toast('请填写变量名');
    if (idx >= 0) ai.envVars[idx] = item; else ai.envVars.unshift(item);
    settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ ai }) });
    resetAiEnvForm(); renderAiSettingsForm(); toast('AI 环境变量已保存');
}
async function deleteAiEnv(id) {
    openAiInlineConfirm({
        title: '删除环境变量',
        body: '删除后 AI 将无法再通过此变量名读取对应密钥。',
        confirmLabel: '删除',
        danger: true,
        onConfirm: async () => {
            const ai = normalizeAiSettings(settings.ai || aiSettingsState || {});
            ai.envVars = ai.envVars.filter((x) => x.id !== id);
            settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ ai }) });
            renderAiSettingsForm(); toast('AI 环境变量已删除');
        },
    });
}
function resetAiMemoryForm() {
    $('#aiMemoryId').value = '';
    $('#aiMemoryTitle').value = '';
    $('#aiMemoryScope').value = '';
    $('#aiMemoryConnectionIds').value = '';
    $('#aiMemoryTags').value = '';
    $('#aiMemoryContent').value = '';
    $('#aiMemoryItemEnabled').checked = true;
}
function renderAiMemoryList() {
    const list = $('#aiMemoryList');
    if (!list) return;
    const ai = normalizeAiSettings(settings.ai || aiSettingsState || {});
    list.innerHTML = ai.memories.length ? ai.memories.slice(0, 80).map((m) => {
        const tags = Array.isArray(m.tags) ? m.tags : splitCsv(m.tags);
        const connIds = Array.isArray(m.connectionIds) ? m.connectionIds : splitCsv(m.connectionIds);
        const meta = [m.enabled === false ? '已停用' : '已启用', m.scope || 'global', m.project || '', tags.length ? `标签:${tags.join(',')}` : '', connIds.length ? `连接:${connIds.length}` : ''].filter(Boolean).join(' · ');
        return `<div class="ai-memory-item" data-memory-id="${escapeHtml(m.id)}"><div><strong>${escapeHtml(m.title || 'Memory')}</strong><span>${escapeHtml(meta)}</span><code>${escapeHtml((m.content || '').slice(0, 300))}</code></div><button class="tool-btn" data-ai-edit-memory="${escapeHtml(m.id)}">编辑</button><button class="tool-btn danger" data-ai-delete-memory="${escapeHtml(m.id)}">删除</button></div>`;
    }).join('') : '<p class="empty-state">暂无长期 Memory。AI 也可通过 memory_save 工具主动记录项目记忆，并按连接、项目、标签自动关联。</p>';
}
async function saveAiMemory(e) {
    e.preventDefault();
    const ai = normalizeAiSettings(settings.ai || aiSettingsState || {});
    const id = $('#aiMemoryId').value || `memory-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const scope = $('#aiMemoryScope').value.trim() || 'global';
    const item = {
        id,
        title: $('#aiMemoryTitle').value.trim() || 'Memory',
        scope,
        project: scope,
        projects: scope && scope !== 'global' ? [scope] : [],
        tags: splitCsv($('#aiMemoryTags').value),
        connectionIds: splitCsv($('#aiMemoryConnectionIds').value),
        content: $('#aiMemoryContent').value,
        enabled: $('#aiMemoryItemEnabled').checked,
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
    if (!item.content.trim()) return toast('请填写 Memory 内容');
    const old = ai.memories.find((x) => x.id === id);
    if (old) item.createdAt = old.createdAt || item.createdAt;
    const idx = ai.memories.findIndex((x) => x.id === id);
    if (idx >= 0) ai.memories[idx] = item; else ai.memories.unshift(item);
    settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ ai }) });
    resetAiMemoryForm(); renderAiSettingsForm(); toast('Memory 已保存');
}
async function deleteAiMemory(id) {
    openAiInlineConfirm({
        title: '删除 Memory',
        body: '删除后无法恢复该条长期记忆。',
        confirmLabel: '删除',
        danger: true,
        onConfirm: async () => {
            await deleteAiMemoryConfirmed(id);
        },
    });
}
async function deleteAiMemoryConfirmed(id) {
    const ai = normalizeAiSettings(settings.ai || aiSettingsState || {});
    ai.memories = ai.memories.filter((x) => x.id !== id);
    settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ ai }) });
    renderAiSettingsForm(); toast('Memory 已删除');
}
function renderAiPlanList() {
    const list = $('#aiPlanList');
    if (!list) return;
    const ai = normalizeAiSettings(settings.ai || aiSettingsState || {});
    list.innerHTML = ai.plans.length ? ai.plans.slice(0, 30).map((plan) => {
        const steps = Array.isArray(plan.steps) ? plan.steps : [];
        const actions = `<div class="ai-plan-actions"><button class="tool-btn" data-ai-plan-pause="${escapeHtml(plan.id)}">暂停</button><button class="tool-btn" data-ai-plan-resume="${escapeHtml(plan.id)}">继续</button><button class="tool-btn" data-ai-plan-retry="${escapeHtml(plan.id)}">重试失败</button><button class="tool-btn danger" data-ai-plan-delete="${escapeHtml(plan.id)}">删除</button></div>`;
        return `<div class="ai-plan-item" data-plan-id="${escapeHtml(plan.id)}"><div><strong>${escapeHtml(plan.title || '任务计划')}</strong><span><b class="ai-status ai-status-${escapeHtml(plan.status || 'planned')}">${escapeHtml(plan.status || 'planned')}</b> · ${fmtTime(plan.updatedAt || plan.createdAt)}</span>${plan.risk ? `<p>${escapeHtml(plan.risk)}</p>` : ''}<ol>${steps.map((s, index) => `<li><em class="ai-status ai-status-${escapeHtml(s.status || 'pending')}">${escapeHtml(s.status || 'pending')}</em> ${escapeHtml(s.text || '')}${s.note ? `<small>${escapeHtml(s.note)}</small>` : ''}${s.error ? `<small class="error-text">${escapeHtml(s.error)}</small>` : ''}<div class="ai-step-actions"><button data-ai-plan-step="${escapeHtml(plan.id)}" data-step-index="${index + 1}" data-step-status="running">执行中</button><button data-ai-plan-step="${escapeHtml(plan.id)}" data-step-index="${index + 1}" data-step-status="completed">完成</button><button data-ai-plan-step="${escapeHtml(plan.id)}" data-step-index="${index + 1}" data-step-status="failed">失败</button></div></li>`).join('')}</ol>${actions}</div></div>`;
    }).join('') : '<p class="empty-state">暂无任务计划。AI 可通过 plan_task 工具为复杂任务创建计划，并持续更新步骤状态。</p>';
}

function resetAiSkillForm() {
    $('#aiSkillId').value = '';
    $('#aiSkillName').value = '';
    $('#aiSkillDescription').value = '';
    $('#aiSkillPrompt').value = '';
    $('#aiSkillEnabled').checked = true;
}
function renderAiSkillList() {
    const list = $('#aiSkillList');
    if (!list) return;
    const ai = normalizeAiSettings(settings.ai || aiSettingsState || {});
    list.innerHTML = ai.skills.length ? ai.skills.map((s) => `<div class="ai-skill-item" data-skill-id="${escapeHtml(s.id)}"><div><strong>${escapeHtml(s.name || '未命名 Skill')}</strong><span>${s.enabled === false ? '已停用' : '已启用'} · ${escapeHtml(s.description || '')}</span><code>${escapeHtml((s.prompt || '').slice(0, 260))}</code></div><button class="tool-btn" data-ai-edit-skill="${escapeHtml(s.id)}">编辑</button><button class="tool-btn danger" data-ai-delete-skill="${escapeHtml(s.id)}">删除</button></div>`).join('') : '<p class="empty-state">暂无 Skill。可以把工作流、工具使用规则、专用提示词保存成能力包。</p>';
}
async function saveAiSkill(e) {
    e.preventDefault();
    const ai = normalizeAiSettings(settings.ai || aiSettingsState || {});
    const id = $('#aiSkillId').value || `skill-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const skill = { id, name: $('#aiSkillName').value.trim(), description: $('#aiSkillDescription').value.trim(), prompt: $('#aiSkillPrompt').value, enabled: $('#aiSkillEnabled').checked, updatedAt: Date.now() };
    if (!skill.name && !skill.prompt.trim()) return toast('请填写 Skill 名称或指令内容');
    const idx = ai.skills.findIndex((s) => s.id === id);
    if (idx >= 0) ai.skills[idx] = skill; else ai.skills.unshift(skill);
    settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ ai }) });
    resetAiSkillForm();
    renderAiSettingsForm();
    toast('Skill 已保存');
}
async function deleteAiSkill(id) {
    openAiInlineConfirm({
        title: '删除 Skill',
        body: '删除后该能力包不会再注入 AI 系统提示。',
        confirmLabel: '删除',
        danger: true,
        onConfirm: async () => {
            const ai = normalizeAiSettings(settings.ai || aiSettingsState || {});
            ai.skills = ai.skills.filter((s) => s.id !== id);
            settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ ai }) });
            renderAiSettingsForm();
            toast('Skill 已删除');
        },
    });
}
function saveAiChats() {
    try { localStorage.setItem(AI_CHAT_STORAGE_KEY, JSON.stringify({ current: aiCurrentSessionId, sessions: aiChatSessions.slice(0, 20) })); } catch (_) {}
}
function loadAiChats() {
    try {
        const data = JSON.parse(localStorage.getItem(AI_CHAT_STORAGE_KEY) || '{}');
        aiChatSessions = Array.isArray(data.sessions)
            ? data.sessions.slice(0, 20).filter((s) => s?.id && Array.isArray(s.messages)).map((s) => ({
                ...s,
                title: s.title === '新沙箱' ? '新对话' : s.title,
                messages: s.messages.filter((m) => !(/^.*已就绪。可搜索网页、调用工具、读写远程文件、辅助代码编辑。$/.test(String(m.content || '')))),
            }))
            : [];
        aiCurrentSessionId = aiChatSessions.some((s) => s.id === data.current) ? data.current : aiChatSessions[0]?.id || null;
    } catch (_) { aiChatSessions = []; aiCurrentSessionId = null; }
}
function createAiChat({ silent = false } = {}) {
    const id = `chat-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    aiChatSessions.unshift({ id, title: '新对话', messages: [] });
    aiCurrentSessionId = id;
    aiEditingMessageIndex = -1;
    aiEditingSessionId = '';
    saveAiChats();
    if (!silent) renderAiChat();
}
function renderAiChatList() {
    const list = $('#aiChatList');
    if (!list) return;
    list.innerHTML = aiChatSessions.map((s) => {
        const running = aiIsSessionRunning(s.id);
        return `<div class="ai-chat-row ${s.id === aiCurrentSessionId ? 'active' : ''} ${running ? 'running' : ''}" data-ai-chat-row="${escapeHtml(s.id)}"><button class="ai-chat-item" data-ai-chat="${escapeHtml(s.id)}"><span class="ai-chat-title-text">${escapeHtml(s.title || '新对话')}</span>${running ? '<span class="ai-chat-running-dot" title="AI 正在回复"></span>' : ''}</button><button class="ai-chat-delete" type="button" data-ai-delete-chat="${escapeHtml(s.id)}" title="删除对话" aria-label="删除对话">×</button></div>`;
    }).join('');
}
function renderAiChat() {
    if (!aiChatSessions.length) createAiChat({ silent: true });
    const session = aiCurrentSession();
    $('#aiCurrentChatTitle').textContent = session.title || '新对话';
    setAiSegmentValue('aiCollabMode', session.collabMode || 'standard', { silent: true });
    renderAiBrowserPreview();
    const area = $('#aiChatArea');
    const typing = $('#aiTypingIndicator');
    area.querySelectorAll('.ai-message').forEach((el) => el.remove());
    session.messages.forEach((m, index) => {
        if (m.role === 'confirmation') {
            const pending = aiPendingConfirmations.get(m.confirmationId);
            if (pending?.confirmation) insertAiConfirmationCard(pending.confirmation, index);
            else appendAiMessage(m.content, 'assistant', { store: false, messageIndex: index, sessionId: session.id });
            return;
        }
        appendAiMessage(m.content, m.role, { store: false, rawHtml: m.role === 'trace', messageIndex: index, sessionId: session.id, metrics: m.metrics || null });
    });
    area.appendChild(typing);
    updateAiRunUiForCurrentSession();
    renderAiChatList();
    scrollAiChat();
}
function summarizeAiUserMessageForDisplay(text = '') {
    return String(text || '')
        .replace(/附件图片：([^\n]+)\n\s*data:image\/[^;\s]+(?:;[^,\s]+)*;base64,[A-Za-z0-9+/=\r\n]+/g, '附件图片：$1\n[图片已发送]')
        .replace(/data:image\/[A-Za-z0-9.+-]+(?:;[^,\s]+)*;base64,[A-Za-z0-9+/=\r\n]+/g, '[图片已发送]');
}
function renderAiMessageContent(text = '', role = 'assistant', rawHtml = false) {
    if (rawHtml) return String(text || '');
    const source = role === 'user' ? summarizeAiUserMessageForDisplay(text) : String(text || '');
    return renderMarkdown(source, { enhancedCode: role !== 'trace' });
}
function appendAiMessage(text, role = 'assistant', { store = true, meta = '', rawHtml = false, messageIndex = -1, sessionId = '', metrics = null } = {}) {
    const targetSessionId = String(sessionId || aiCurrentSessionId || '');
    const session = targetSessionId
        ? aiChatSessions.find((s) => s.id === targetSessionId)
        : aiCurrentSession();
    if (!session) return;
    const normalizedRole = rawHtml ? 'trace' : (role === 'ai' ? 'assistant' : role);
    let storedIndex = messageIndex;
    if (store) {
        const record = { role: normalizedRole, content: String(text || '') };
        if (metrics && typeof metrics === 'object') record.metrics = metrics;
        session.messages.push(record);
        storedIndex = session.messages.length - 1;
        if (role === 'user' && (!session.title || session.title === '新对话' || session.title === '新沙箱')) {
            session.title = String(text || '').slice(0, 14) + (String(text || '').length > 14 ? '...' : '');
            if (session.id === aiCurrentSessionId) $('#aiCurrentChatTitle').textContent = session.title;
        }
        saveAiChats();
        renderAiChatList();
    }
    if (session.id !== aiCurrentSessionId) return;
    const area = $('#aiChatArea');
    const typing = $('#aiTypingIndicator');
    if (!area || !typing) return;
    const div = document.createElement('div');
    div.className = `ai-message ${role === 'user' ? 'user' : (role === 'system' || role === 'trace') ? 'system' : 'ai'}`;
    div.dataset.aiMessageRole = normalizedRole;
    if (storedIndex >= 0) div.dataset.aiMessageIndex = String(storedIndex);
    div.dataset.aiMessageText = String(text || '');
    if (metrics && typeof metrics === 'object') div.dataset.aiMetrics = JSON.stringify(metrics).slice(0, 6000);
    div.innerHTML = `${meta ? `<small>${escapeHtml(meta)}</small>` : ''}${renderAiMessageContent(text, role, rawHtml)}`;
    area.insertBefore(div, typing);
    if ((role === 'system' || role === 'trace') && div.querySelector('.ai-tool-trace')) {
        div.classList.add('ai-trace-message');
    }
    scrollAiChat();
}
function scrollAiChat() { requestAnimationFrame(() => { const a = $('#aiChatArea'); if (a) a.scrollTo({ top: a.scrollHeight, behavior: 'smooth' }); }); }
function aiIsSessionRunning(sessionId = '') { return aiSessionRuns.has(String(sessionId || '')); }
function aiRunForSession(sessionId = '') { return aiSessionRuns.get(String(sessionId || '')) || null; }
function registerAiSessionRun(sessionId, controller) {
    const id = String(sessionId || '');
    if (!id || !controller) return;
    aiSessionRuns.set(id, controller);
    updateAiRunUiForCurrentSession();
    renderAiChatList();
}
function clearAiSessionRun(sessionId, controller = null) {
    const id = String(sessionId || '');
    if (!id) return;
    if (!controller || aiSessionRuns.get(id) === controller) aiSessionRuns.delete(id);
    updateAiRunUiForCurrentSession();
    renderAiChatList();
}
function updateAiRunUiForCurrentSession() { setAiTyping(aiIsSessionRunning(aiCurrentSessionId)); }
function aiCodeItem(id = '') { return aiCodeBlockStore.get(String(id || '')) || null; }
async function copyTextToClipboard(text = '', successMessage = '已复制') {
    const value = String(text || '');
    let copied = false;
    if (navigator.clipboard?.writeText && window.isSecureContext) {
        try {
            await navigator.clipboard.writeText(value);
            copied = true;
        } catch (_) {}
    }
    if (!copied) {
        const ta = document.createElement('textarea');
        ta.value = value;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        ta.style.top = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        ta.setSelectionRange(0, ta.value.length);
        try { copied = document.execCommand('copy'); } catch (_) { copied = false; }
        ta.remove();
    }
    if (!copied) throw new Error('浏览器拒绝剪贴板写入，请手动长按复制');
    toast(successMessage);
}

async function aiCopyText(text = '') {
    await copyTextToClipboard(text, '已复制');
}
function aiDownloadTextFile(item) {
    if (!item) return;
    const blob = new Blob([item.code || ''], { type: codeMimeType(item.filename, item.lang) });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = item.filename || `snippet.${codeLangExt(item.lang)}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1200);
    toast(`已下载 ${a.download}`);
}
function aiPreviewCode(item) {
    if (!item) return;
    if (aiCodePreviewObjectUrl) URL.revokeObjectURL(aiCodePreviewObjectUrl);
    aiCodePreviewObjectUrl = URL.createObjectURL(new Blob([item.code || ''], { type: codeMimeType(item.filename, item.lang) }));
    const state = aiBrowserPreviewStateForSession(aiCurrentSessionId);
    state.visible = true;
    $('#aiBrowserPreview')?.classList.remove('force-hidden');
    const title = $('#aiBrowserPreviewTitle'), body = $('#aiBrowserPreviewBody'), toggle = $('#aiBrowserPreviewToggleBtn');
    if (toggle) toggle.textContent = '隐藏预览';
    if (title) title.textContent = `代码调试沙箱 · ${item.filename || 'snippet'}`;
    if (body) body.innerHTML = `<iframe class="ai-code-preview-frame" sandbox="allow-scripts allow-forms allow-modals allow-pointer-lock" src="${escapeAttr(aiCodePreviewObjectUrl)}"></iframe><small>${escapeHtml(item.filename || '')} · 本地 Blob 沙箱预览</small>`;
    toast('已打开代码预览');
}
function renderAiAttachmentChips() {
    if (!aiPendingInputAttachments.length) return '';
    return `<div class="ai-attachment-strip">${aiPendingInputAttachments.map((a, idx) => `<span class="ai-attachment-chip" title="${escapeAttr(a.name || '')}"><span class="ai-attachment-icon fm-button-icon" data-glyph="file" aria-hidden="true"></span><span class="ai-attachment-name">${escapeHtml(a.name || '附件')}</span><button type="button" data-ai-remove-attachment="${idx}" aria-label="移除附件">×</button></span>`).join('')}</div>`;
}
function updateAiInputPreview() {
    const preview = $('#aiInputPreview');
    if (!preview) return;
    if (!aiPendingInputAttachments.length) { preview.hidden = true; preview.innerHTML = ''; return; }
    preview.hidden = false;
    preview.innerHTML = renderAiAttachmentChips();
}
function updateAiAttachmentDraftUi() {
    updateAiInputPreview();
}
function toggleAiMarkdownPreview() {
    const preview = $('#aiInputPreview'), btn = $('#aiMarkdownPreviewBtn');
    if (!preview) return;
    preview.hidden = !preview.hidden;
    btn?.classList.toggle('active', !preview.hidden);
    if (!preview.hidden) updateAiInputPreview();
}
function ensureAiMessageMenu() {
    let menu = $('#aiMessageContextMenu');
    if (menu) return menu;
    menu = document.createElement('div');
    menu.id = 'aiMessageContextMenu';
    menu.className = 'ai-message-menu hidden';
    menu.innerHTML = `<button type="button" data-ai-msg-action="copy"><span>⧉</span>复制文本</button><button type="button" data-ai-msg-action="edit"><span>✎</span>编辑消息</button><button type="button" data-ai-msg-action="regen"><span>↻</span>重新回答</button><button type="button" data-ai-msg-action="select"><span>T</span>选择文本</button><button type="button" data-ai-msg-action="usage"><span>◷</span>查看用量</button>`;
    document.body.appendChild(menu);
    return menu;
}
function hideAiMessageMenu() {
    const menu = $('#aiMessageContextMenu');
    if (!menu) return;
    menu.classList.add('closing');
    window.setTimeout(() => { menu.classList.add('hidden'); menu.classList.remove('open', 'closing'); }, 120);
}
function showAiMessageMenu(messageEl, x, y) {
    if (!messageEl) return;
    const menu = ensureAiMessageMenu();
    const role = messageEl.dataset.aiMessageRole || '';
    const selection = window.getSelection?.();
    const selectedText = selection && !selection.isCollapsed && messageEl.contains(selection.anchorNode) && messageEl.contains(selection.focusNode)
        ? selection.toString()
        : '';
    aiMessageMenuState.index = Number(messageEl.dataset.aiMessageIndex || -1);
    aiMessageMenuState.sessionId = aiCurrentSessionId;
    aiMessageMenuState.text = messageEl.dataset.aiMessageText || '';
    aiMessageMenuState.selectedText = selectedText;
    aiMessageMenuState.element = messageEl;
    aiMessageMenuState.metrics = safeJsonParseClient(messageEl.dataset.aiMetrics || '{}', {});
    menu.querySelectorAll('[data-ai-msg-action="edit"],[data-ai-msg-action="regen"]').forEach((btn) => { btn.hidden = role !== 'user'; });
    menu.classList.remove('hidden', 'closing');
    const vw = window.innerWidth || document.documentElement.clientWidth || 360;
    const vh = window.innerHeight || document.documentElement.clientHeight || 640;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(vw - (rect.width || 180) - 8, x))}px`;
    menu.style.top = `${Math.max(8, Math.min(vh - (rect.height || 180) - 8, y))}px`;
    requestAnimationFrame(() => menu.classList.add('open'));
}
function selectAiMessageText(el) {
    if (!el) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
}
function editAiMessageFromMenu() {
    const input = $('#aiUserInput');
    if (!input) return;
    aiEditingMessageIndex = aiMessageMenuState.index;
    aiEditingSessionId = aiMessageMenuState.sessionId || aiCurrentSessionId;
    input.value = aiMessageMenuState.text || '';
    autoResizeAiInput(input);
    updateAiInputPreview();
    input.focus?.();
    toast('已载入原消息，修改后发送会从此处重新回答');
}
function regenerateAiMessageFromMenu() {
    if (aiIsSessionRunning(aiCurrentSessionId)) return toast('请先停止当前对话的 AI 回复');
    const input = $('#aiUserInput');
    if (!input) return;
    aiEditingMessageIndex = aiMessageMenuState.index;
    aiEditingSessionId = aiMessageMenuState.sessionId || aiCurrentSessionId;
    input.value = aiMessageMenuState.text || '';
    autoResizeAiInput(input);
    sendAiMessage();
}
function handleAiMessageMenuAction(action = '') {
    const a = String(action || '');
    if (a === 'copy') {
        const selection = window.getSelection?.();
        const selectedText = selection && !selection.isCollapsed && aiMessageMenuState.element?.contains(selection.anchorNode) && aiMessageMenuState.element?.contains(selection.focusNode)
            ? selection.toString()
            : (aiMessageMenuState.selectedText || '');
        aiCopyText(selectedText || aiMessageMenuState.text || '');
    }
    if (a === 'edit') editAiMessageFromMenu();
    if (a === 'regen') regenerateAiMessageFromMenu();
    if (a === 'select') selectAiMessageText(aiMessageMenuState.element);
    if (a === 'usage') openAiUsageSheet(aiMessageMenuState.metrics || {});
    hideAiMessageMenu();
}
function aiMessageFromEvent(event) { return event.target?.closest?.('.ai-message'); }
function handleAiMessageContextMenu(event) {
    const msg = aiMessageFromEvent(event);
    if (!msg || msg.classList.contains('ai-trace-message')) return;
    event.preventDefault();
    showAiMessageMenu(msg, event.clientX || 24, event.clientY || 24);
}
function handleAiMessageTouchStart(event) {
    const msg = aiMessageFromEvent(event);
    if (!msg || msg.classList.contains('ai-trace-message')) return;
    window.clearTimeout(aiMessageMenuState.touchTimer);
    aiMessageMenuState.touchTimer = window.setTimeout(() => {
        const t = event.touches?.[0];
        showAiMessageMenu(msg, t?.clientX || 24, t?.clientY || 24);
    }, 560);
}
function clearAiMessageTouchTimer() { window.clearTimeout(aiMessageMenuState.touchTimer); aiMessageMenuState.touchTimer = 0; }
function handleAiCodeActionClick(event) {
    const copy = event.target.closest?.('[data-ai-code-copy]');
    const download = event.target.closest?.('[data-ai-code-download]');
    const preview = event.target.closest?.('[data-ai-code-preview]');
    const id = copy?.dataset.aiCodeCopy || download?.dataset.aiCodeDownload || preview?.dataset.aiCodePreview || '';
    if (!id) return false;
    event.preventDefault(); event.stopPropagation();
    const item = aiCodeItem(id);
    if (copy) aiCopyText(item?.code || '');
    if (download) aiDownloadTextFile(item);
    if (preview) aiPreviewCode(item);
    return true;
}
function handleAiChatAreaClick(event) {
    if (handleAiCodeActionClick(event)) return;
    const approve = event.target.dataset.aiConfirmApprove, deny = event.target.dataset.aiConfirmDeny;
    if (approve) resolveAiConfirmation(approve, true);
    if (deny) resolveAiConfirmation(deny, false);
}
function closeAiBrowserForSession(id) {
    const sessionId = String(id || '').trim();
    if (!sessionId) return;
    const state = aiBrowserPreviewStates.get(sessionId) || aiBrowserPreviewStateForSession(sessionId);
    const session = state?.session || `chat-${sessionId.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 80)}`;
    api('/api/ai/tools/run', { method: 'POST', body: JSON.stringify({ tool: 'browser_close', args: { session }, context: collectAiContext({ sessionId }) }) }).catch(() => {});
    aiBrowserPreviewStates.delete(sessionId);
    if (sessionId === aiCurrentSessionId) renderAiBrowserPreview();
}
function deleteAiChat(id) {
    if (!id) return;
    openAiInlineConfirm({
        title: '删除对话',
        body: '将删除此会话的本地消息记录（服务端会话若已创建不会自动清档）。',
        confirmLabel: '删除',
        danger: true,
        onConfirm: () => deleteAiChatConfirmed(id),
    });
}
function deleteAiChatConfirmed(id) {
    const controller = aiRunForSession(id);
    if (controller) {
        aiStoppedControllers.add(controller);
        controller.abort();
        clearAiSessionRun(id, controller);
    }
    aiPendingConfirmations.forEach((pending, confirmationId) => { if (pending?.sessionId === id) aiPendingConfirmations.delete(confirmationId); });
    closeAiBrowserForSession(id);
    aiChatSessions = aiChatSessions.filter((s) => s.id !== id);
    aiCurrentSessionId = aiChatSessions[0]?.id || null;
    if (!aiChatSessions.length) createAiChat({ silent: true });
    saveAiChats();
    renderAiChat();
}
function updateAiPanelResponsiveState() {
    const panel = $('#aiAgentPanel');
    if (!panel) return;
    const rect = panel.getBoundingClientRect?.();
    const width = Math.max(220, rect?.width || panel.offsetWidth || 0);
    const isMobile = window.innerWidth <= 760;
    const compact = isMobile || width < 680;
    const narrow = !isMobile && width < 560;
    panel.classList.toggle('ai-compact', compact);
    panel.classList.toggle('ai-narrow', narrow);
    if (isMobile) { aiSidebarCollapsedBySize = false; panel.classList.remove('sidebar-collapsed'); return; }
    if (narrow && !aiSidebarCollapsedBySize) { aiSidebarCollapsedBySize = true; panel.classList.add('sidebar-collapsed'); }
    if (!narrow && aiSidebarCollapsedBySize) { aiSidebarCollapsedBySize = false; panel.classList.remove('sidebar-collapsed'); }
}
function setAiTyping(show) {
    $('#aiTypingIndicator')?.classList.toggle('show', !!show);
    const send = $('#aiSendBtn');
    if (send) {
        send.classList.toggle('ai-stop-mode', !!show);
        send.innerHTML = show
            ? '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2"></rect></svg>'
            : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline></svg>';
        send.title = show ? '停止 AI 回复' : '发送';
        send.setAttribute('aria-label', show ? '停止 AI 回复' : '发送');
    }
    scrollAiChat();
}
function stopAiResponse(sessionId = aiCurrentSessionId) {
    const id = String(sessionId || aiCurrentSessionId || '');
    const controller = aiRunForSession(id);
    if (!controller) return false;
    aiStoppedControllers.add(controller);
    controller.abort();
    clearAiSessionRun(id, controller);
    const sess = aiChatSessions.find((s) => s.id === id);
    if (sess?.runtimeRunId) {
        api(`/api/ai/runtime/runs/${encodeURIComponent(sess.runtimeRunId)}/abort`, { method: 'POST', body: '{}' }).catch(() => {});
    }
    appendAiMessage('已停止 AI 回复/操作。', 'system', { sessionId: id });
    return true;
}

function aiIntensityOptions() {
    const value = $('#aiThinkIntensity')?.value || '';
    if (!value) return {};
    const ai = normalizeAiSettings(settings.ai || aiSettingsState || {});
    const provider = (ai.providers || []).find((p) => p.id === $('#aiProviderSelect')?.value) || {};
    const model = $('#aiModelSelect')?.value || provider.defaultModel || '';
    const kind = aiProviderKind(provider);
    if (kind === 'gemini') {
        if (/^-?\d+$/.test(value)) return { thinkingConfig: { thinkingBudget: Number(value) } };
        return { thinkingConfig: { thinkingLevel: value } };
    }
    if (kind === 'anthropic') return { effort: value };
    return { reasoning_effort: value };
}
function uniq(list = []) { return Array.from(new Set(list.map((x) => String(x || '').trim()).filter(Boolean))); }
function collectAiContext(options = {}) {
    const contextSession = options.sessionId ? aiChatSessions.find((s) => s.id === options.sessionId) : aiCurrentSession();
    const active = terminalTabs.find((t) => t.id === activeTerminalTab);
    const ordered = [active, ...terminalTabs.filter((t) => t && t.id !== activeTerminalTab)].filter(Boolean);
    const activeConnectionIds = uniq(ordered.map((t) => t.connectionId));
    const contextConnections = activeConnectionIds.map((id) => connections.find((c) => String(c.id) === String(id))).filter(Boolean).map((c) => ({ id: c.id, name: c.name, protocol: c.protocol, host: c.host, port: c.port, username: c.username, tags: Array.isArray(c.tags) ? c.tags : splitCsv(c.tags), remark: c.remark || '' }));
    const tags = uniq(contextConnections.flatMap((c) => c.tags || []));
    const view = document.querySelector('.nav-tab.active')?.dataset.view || '';
    const terminalOutputs = collectAiTerminalOutputs();
    const remoteDesktopSnapshots = collectAiRemoteDesktopSnapshots({ includeImage: !!options.includeRemoteDesktopImages });
    return { view, aiChatSessionId: contextSession?.id || '', activeChatTitle: contextSession?.title || '', activeTerminalTab, activeConnectionIds, connections: contextConnections, tags, terminalOutputs, remoteDesktopSnapshots };
}
function aiBrowserPreviewStateForSession(sessionId = aiCurrentSessionId) {
    const key = String(sessionId || 'default');
    const safe = key.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 80);
    if (!aiBrowserPreviewStates.has(key)) aiBrowserPreviewStates.set(key, { session: safe && safe !== 'default' ? `chat-${safe}` : 'default', preview: null, visible: false });
    return aiBrowserPreviewStates.get(key);
}
function browserShotFromResult(result = {}) {
    if (!result || typeof result !== 'object') return null;
    if (result.preview?.url) return result.preview;
    if (result.url && /\/api\/ai\/browser\/screenshots\//.test(result.url)) return result;
    return null;
}
function updateAiBrowserPreviewFromToolResult(item = {}, { sessionId = aiCurrentSessionId } = {}) {
    if (!String(item.tool || '').startsWith('browser_')) return;
    const shot = browserShotFromResult(item.result || {});
    if (shot) {
        const state = aiBrowserPreviewStateForSession(sessionId);
        state.preview = { ...shot, tool: item.tool, updatedAt: Date.now(), pageUrl: item.result?.url || item.result?.pageUrl || '' };
        state.session = item.result?.session || item.args?.session || state.session || (sessionId ? `chat-${sessionId}` : 'default');
        state.visible = true;
        if (sessionId === aiCurrentSessionId) renderAiBrowserPreview();
    }
}
function renderAiBrowserPreview() {
    const box = $('#aiBrowserPreview'), body = $('#aiBrowserPreviewBody'), title = $('#aiBrowserPreviewTitle'), toggle = $('#aiBrowserPreviewToggleBtn');
    if (!box || !body) return;
    const state = aiBrowserPreviewStateForSession(aiCurrentSessionId);
    box.classList.toggle('force-hidden', !state.visible);
    if (toggle) toggle.textContent = state.visible ? '隐藏预览' : '浏览器预览';
    const shot = state.preview;
    if (!shot?.url) {
        title && (title.textContent = 'AI 代操作页面');
        body.innerHTML = '<span>AI 打开网页后，会在这里持续显示它正在代操作的页面。</span>';
        return;
    }
    title && (title.textContent = `AI 代操作页面 · ${shot.tool || 'browser'} · ${state.session || 'default'} · ${new Date(shot.updatedAt || Date.now()).toLocaleTimeString()}`);
    body.innerHTML = `<a href="${escapeHtml(shot.url)}" target="_blank" rel="noopener"><img src="${escapeHtml(shot.url)}" alt="浏览器截图"></a>${shot.pageUrl ? `<small>${escapeHtml(shot.pageUrl)}</small>` : ''}`;
}
async function refreshAiBrowserPreview() {
    if (aiBrowserPreviewTimer) return;
    aiBrowserPreviewTimer = window.setTimeout(() => { aiBrowserPreviewTimer = 0; }, 800);
    try {
        const state = aiBrowserPreviewStateForSession(aiCurrentSessionId);
        const data = await api('/api/ai/tools/run', { method: 'POST', body: JSON.stringify({ tool: 'browser_screenshot', args: { session: state.session || 'default' }, context: collectAiContext({ sessionId: aiCurrentSessionId }) }) });
        state.preview = { ...(data.result || {}), tool: 'browser_screenshot', updatedAt: Date.now() };
        state.visible = true;
        renderAiBrowserPreview();
    } catch (err) { toast(err.message || '刷新浏览器截图失败'); }
}
function mergeAiPlan(plan) {
    if (!plan?.id) return;
    const ai = normalizeAiSettings(settings.ai || aiSettingsState || {});
    const idx = ai.plans.findIndex((p) => p.id === plan.id);
    if (idx >= 0) ai.plans[idx] = plan; else ai.plans.unshift(plan);
    settings.ai = ai; aiSettingsState = ai; renderAiPlanList();
}
function mergeAiMemory(memory) {
    if (!memory?.id) return;
    const ai = normalizeAiSettings(settings.ai || aiSettingsState || {});
    const idx = ai.memories.findIndex((m) => m.id === memory.id);
    if (idx >= 0) ai.memories[idx] = memory; else ai.memories.unshift(memory);
    settings.ai = ai; aiSettingsState = ai; renderAiMemoryList();
}
function currentOrRequestedTerminalTab(tabId = '') {
    const requested = String(tabId || '').trim();
    if (requested && terminalTabs.some((t) => t.id === requested)) return requested;
    if (activeTerminalTab && terminalTabs.some((t) => t.id === activeTerminalTab)) return activeTerminalTab;
    return terminalTabs.find((t) => !t.minimized)?.id || terminalTabs[0]?.id || '';
}
function terminalFrameByIdForAi(tabId = '') {
    const id = String(tabId || '').trim();
    return id ? document.querySelector(`#terminalWorkspace .terminal-frame[data-frame="${CSS.escape(id)}"]`) : null;
}
function terminalFrameForAi(tabId = '') {
    const id = currentOrRequestedTerminalTab(tabId);
    return terminalFrameByIdForAi(id);
}
function clipAiTerminalText(text = '', maxChars = 24000) {
    const max = Math.max(1000, Math.min(60000, Number(maxChars) || 24000));
    const value = String(text || '').replace(/[\s\n]+$/g, '');
    return value.length > max ? `[前面已截断 ${value.length - max} 字符]\n${value.slice(-max)}` : value;
}
function readTerminalOutputForAi(tabId = '', maxChars = 24000) {
    const id = currentOrRequestedTerminalTab(tabId);
    const tab = terminalTabs.find((t) => t.id === id) || null;
    const conn = tab?.connectionId ? connections.find((c) => String(c.id) === String(tab.connectionId)) : null;
    const frame = terminalFrameByIdForAi(id);
    let snapshot = null;
    try { snapshot = frame?.contentWindow?.__zephyrGetTerminalOutput?.({ maxChars }); } catch (err) { snapshot = { error: err.message || String(err) }; }
    const protocol = String(tab?.protocol || conn?.protocol || '').toUpperCase();
    return {
        tabId: id,
        name: tab?.name || conn?.name || '',
        protocol,
        connectionId: tab?.connectionId || conn?.id || '',
        host: snapshot?.host || conn?.host || '',
        port: snapshot?.port || conn?.port || '',
        username: snapshot?.username || conn?.username || '',
        status: snapshot?.status || tab?.status || '',
        available: Boolean(snapshot && !snapshot.error && (snapshot.text || snapshot.currentInput || protocol === 'SSH')),
        error: snapshot?.error || (!frame ? '终端 iframe 未加载或已被最小化释放' : ''),
        text: clipAiTerminalText(snapshot?.text || '', maxChars),
        currentInput: snapshot?.currentInput || '',
        lineCount: snapshot?.lineCount || 0,
        originalLength: snapshot?.originalLength || 0,
        truncated: !!snapshot?.truncated,
        cols: snapshot?.cols || 0,
        rows: snapshot?.rows || 0,
        scrollbackCount: snapshot?.scrollbackCount || 0,
        at: snapshot?.at || Date.now(),
    };
}
function collectAiTerminalOutputs() {
    const ids = uniq([activeTerminalTab, ...visualLayout, ...terminalTabs.filter((t) => !t.minimized).map((t) => t.id), ...terminalTabs.map((t) => t.id)]).slice(0, 4);
    return ids.map((id, index) => readTerminalOutputForAi(id, index === 0 ? 60000 : 16000))
        .filter((item) => item.protocol === 'SSH' && (item.available || item.text || item.currentInput))
        .slice(0, 3);
}
function readRemoteDesktopSnapshotForAi(tabId = '', maxWidth = 960) {
    const id = currentOrRequestedTerminalTab(tabId);
    const tab = terminalTabs.find((t) => t.id === id) || null;
    const protocol = String(tab?.protocol || '').toUpperCase();
    if (!['RDP', 'VNC'].includes(protocol)) return null;
    const conn = tab?.connectionId ? connections.find((c) => String(c.id) === String(tab.connectionId)) : null;
    const frame = terminalFrameByIdForAi(id);
    let shot = null;
    try { shot = frame?.contentWindow?.__zephyrGetRemoteDesktopSnapshot?.({ maxWidth }); } catch (err) { shot = { error: err.message || String(err) }; }
    if (shot?.dataUrl && shot.dataUrl.length > 1800000 && Number(maxWidth) > 520) {
        try {
            const smallerWidth = Math.max(420, Math.round(Number(maxWidth) * 0.62));
            const smaller = frame?.contentWindow?.__zephyrGetRemoteDesktopSnapshot?.({ maxWidth: smallerWidth, quality: 0.58 });
            if (smaller?.dataUrl && smaller.dataUrl.length < shot.dataUrl.length) shot = smaller;
        } catch (_) {}
    }
    return {
        tabId: id,
        name: tab?.name || conn?.name || '',
        protocol,
        connectionId: tab?.connectionId || conn?.id || '',
        host: shot?.host || conn?.host || '',
        port: shot?.port || conn?.port || '',
        status: shot?.status || tab?.status || '',
        title: shot?.title || tab?.name || conn?.name || '',
        connected: !!shot?.connected,
        dataUrl: shot?.dataUrl || '',
        width: shot?.width || 0,
        height: shot?.height || 0,
        originalWidth: shot?.originalWidth || 0,
        originalHeight: shot?.originalHeight || 0,
        error: shot?.error || (!frame ? '远程桌面 iframe 未加载或已被最小化释放' : ''),
        at: shot?.at || Date.now(),
    };
}
function collectAiRemoteDesktopSnapshots({ includeImage = false } = {}) {
    const ids = uniq([activeTerminalTab, ...visualLayout, ...terminalTabs.filter((t) => !t.minimized).map((t) => t.id), ...terminalTabs.map((t) => t.id)]).slice(0, includeImage ? 3 : 5);
    const list = ids.map((id, index) => includeImage ? readRemoteDesktopSnapshotForAi(id, index === 0 ? 640 : 520) : readRemoteDesktopSnapshotForAi(id, 360))
        .filter((item) => item && ['RDP', 'VNC'].includes(item.protocol) && (item.dataUrl || item.error || item.connected))
        .slice(0, includeImage ? 1 : 2);
    if (includeImage) return list;
    return list.map(({ dataUrl, ...item }) => ({ ...item, hasScreenshot: !!dataUrl, dataUrlLength: dataUrl ? dataUrl.length : 0 }));
}
function currentOrRequestedRemoteDesktopTab(tabId = '') {
    const requested = String(tabId || '').trim();
    const isRemote = (t) => ['RDP', 'VNC'].includes(String(t?.protocol || '').toUpperCase());
    if (requested && terminalTabs.some((t) => t.id === requested && isRemote(t))) return requested;
    const active = terminalTabs.find((t) => t.id === activeTerminalTab && isRemote(t));
    if (active) return active.id;
    return terminalTabs.find((t) => !t.minimized && isRemote(t))?.id || terminalTabs.find(isRemote)?.id || '';
}
function publicAiRemoteDesktopAction(action = {}) {
    return {
        source: 'zephyr-app',
        type: 'ai-remote-desktop-action',
        actionId: action.actionId || '',
        control: action.desktopControl || action.control || '',
        qualityMode: action.qualityMode || '',
        fitMode: action.fitMode || '',
        zoomPercent: action.zoomPercent,
        sequence: action.sequence || '',
        text: action.text || '',
        paste: action.paste !== false,
        x: action.x,
        y: action.y,
        button: action.button || 1,
        coordinateSpace: action.coordinateSpace || '',
        screenshotX: action.screenshotX,
        screenshotY: action.screenshotY,
        screenshotWidth: action.screenshotWidth,
        screenshotHeight: action.screenshotHeight,
    };
}
function normalizeAiRemoteDesktopMouseAction(action = {}, tabId = '') {
    if (String(action.action || '') !== 'remote_desktop_mouse') return action;
    const x = Number(action.x);
    const y = Number(action.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return action;
    const shot = readRemoteDesktopSnapshotForAi(tabId, action.maxWidth || 960);
    const screenshotWidth = Number(shot?.width || 0);
    const screenshotHeight = Number(shot?.height || 0);
    const remoteWidth = Number(shot?.originalWidth || screenshotWidth || 0);
    const remoteHeight = Number(shot?.originalHeight || screenshotHeight || 0);
    const coordinateSpace = String(action.coordinateSpace || action.coords || 'screenshot').toLowerCase();
    const shouldScale = coordinateSpace !== 'remote'
        && screenshotWidth > 0 && screenshotHeight > 0 && remoteWidth > 0 && remoteHeight > 0
        && (Math.abs(remoteWidth - screenshotWidth) > 1 || Math.abs(remoteHeight - screenshotHeight) > 1)
        && x >= 0 && y >= 0 && x <= screenshotWidth + 2 && y <= screenshotHeight + 2;
    if (!shouldScale) return { ...action, coordinateSpace: coordinateSpace || 'remote' };
    return {
        ...action,
        x: Math.round(x * remoteWidth / screenshotWidth),
        y: Math.round(y * remoteHeight / screenshotHeight),
        screenshotX: x,
        screenshotY: y,
        screenshotWidth,
        screenshotHeight,
        coordinateSpace: 'screenshot_scaled_to_remote',
    };
}
function delayMs(ms = 0) { return new Promise((resolve) => window.setTimeout(resolve, Math.max(0, Number(ms) || 0))); }
async function waitForFreshRemoteDesktopSnapshot(tabId = '', { maxWidth = 640, afterFrameAt = 0, timeoutMs = 1800 } = {}) {
    const deadline = Date.now() + Math.max(300, Number(timeoutMs) || 1800);
    let shot = null;
    while (Date.now() < deadline) {
        shot = readRemoteDesktopSnapshotForAi(tabId, maxWidth);
        const frameAt = Number(shot?.frameAt || shot?.at || 0);
        if (shot?.dataUrl && (!afterFrameAt || frameAt > afterFrameAt)) return shot;
        await delayMs(180);
    }
    return shot || readRemoteDesktopSnapshotForAi(tabId, maxWidth);
}
function waitForAiRemoteDesktopActionAck(actionId, timeoutMs = 3200) {
    if (!actionId) return Promise.resolve(null);
    return new Promise((resolve) => {
        const timer = window.setTimeout(() => {
            aiRemoteDesktopActionWaiters.delete(actionId);
            resolve({ ok: false, timeout: true, error: '远程桌面没有返回操作结果，可能 iframe 未收到操作或脚本未更新' });
        }, Math.max(800, Number(timeoutMs) || 3200));
        aiRemoteDesktopActionWaiters.set(actionId, (payload = {}) => {
            window.clearTimeout(timer);
            aiRemoteDesktopActionWaiters.delete(actionId);
            resolve(payload);
        });
    });
}
async function readTerminalOutputAfterAiAction(action = {}) {
    const waitMs = action.run === false ? 120 : 1200;
    await delayMs(waitMs);
    return readTerminalOutputForAi(action.tabId || '', 30000);
}
function clickSettingsSection(section = '') {
    const key = String(section || '').toLowerCase();
    if (!key) return;
    if (['security', 'data'].includes(key)) throw new Error('AI 不允许代操作安全/数据管理设置页');
    const btn = document.querySelector(`.settings-tab[data-settings="${CSS.escape(key)}"]`);
    if (btn) btn.click();
}
function waitForTerminalFrameReady(frame, timeoutMs = 1800) {
    if (!frame) return Promise.reject(new Error('当前终端页面还没准备好'));
    try {
        const doc = frame.contentDocument;
        if (doc && doc.readyState !== 'loading') return Promise.resolve(frame);
    } catch (_) {}
    return new Promise((resolve) => {
        let done = false;
        const finish = () => { if (done) return; done = true; frame.removeEventListener('load', finish); resolve(frame); };
        frame.addEventListener('load', finish, { once: true });
        window.setTimeout(finish, timeoutMs);
    });
}
async function performAiUiAction(action = {}) {
    const a = String(action.action || '');
    if (!a) return;
    if (a === 'switch_view') {
        const view = ['dashboard', 'terminal', 'remote', 'settings'].includes(action.view) ? action.view : 'dashboard';
        switchView(view);
        if (view === 'settings') clickSettingsSection(action.settingsSection || 'ai');
        toast(`AI 已切换到${view}`);
        return;
    }
    if (a === 'open_add_connection') { switchView('dashboard'); openModal(null, $('#addConnectionBtn')); return; }
    if (a === 'open_edit_connection') {
        switchView('dashboard');
        const conn = connections.find((c) => c.id === String(action.connectionId || ''));
        if (!conn) throw new Error('连接不存在或尚未刷新');
        openModal(conn, document.querySelector(`[data-edit="${CSS.escape(conn.id)}"]`) || $('#addConnectionBtn'));
        return;
    }
    if (a === 'terminal_fullscreen') { const id = currentOrRequestedTerminalTab(action.tabId); if (!id) throw new Error('暂无终端会话'); fullscreenTerminalTab(id).catch((err) => toast(err.message)); return; }
    if (a === 'terminal_exit_fullscreen') { exitTerminalFullscreen(); return; }
    if (a === 'terminal_window_action') { const id = currentOrRequestedTerminalTab(action.tabId); if (!id) throw new Error('暂无终端会话'); applyTerminalWindowPreset(id, action.windowAction || 'fullscreen'); return; }
    if (a === 'terminal_toolbar') {
        switchView('terminal');
        const frame = await waitForTerminalFrameReady(terminalFrameForAi(action.tabId));
        if (!frame?.contentWindow) throw new Error('当前终端页面还没准备好');
        frame.contentWindow.postMessage({ source: 'zephyr-app', type: 'ai-terminal-toolbar', control: action.control || '' }, '*');
        return;
    }
    if (a === 'terminal_send_input') {
        switchView('terminal');
        const id = currentOrRequestedTerminalTab(action.tabId);
        const frame = await waitForTerminalFrameReady(terminalFrameByIdForAi(id));
        if (!frame?.contentWindow) throw new Error('当前终端页面还没准备好');
        frame.contentWindow.postMessage({ source: 'zephyr-app', type: 'ai-terminal-send-input', text: action.text || '', run: action.run !== false }, '*');
        return { terminalOutput: await readTerminalOutputAfterAiAction({ ...action, tabId: id }) };
    }
    if (a === 'terminal_read_output') {
        switchView('terminal');
        const id = currentOrRequestedTerminalTab(action.tabId);
        await waitForTerminalFrameReady(terminalFrameByIdForAi(id));
        return { terminalOutput: readTerminalOutputForAi(id, action.maxChars || 30000) };
    }
    if (a === 'remote_desktop_toolbar' || a === 'remote_desktop_send_text' || a === 'remote_desktop_mouse') {
        switchView('terminal');
        const id = currentOrRequestedRemoteDesktopTab(action.tabId);
        if (!id) throw new Error('暂无 RDP/VNC 远程桌面会话');
        const frame = await waitForTerminalFrameReady(terminalFrameByIdForAi(id));
        if (!frame?.contentWindow) throw new Error('当前远程桌面页面还没准备好');
        const actionId = `rdp-${Date.now().toString(36)}-${++aiRemoteDesktopActionSeq}`;
        const actionForMessage = normalizeAiRemoteDesktopMouseAction(action, id);
        const msg = publicAiRemoteDesktopAction({
            ...actionForMessage,
            actionId,
            desktopControl: actionForMessage.desktopControl || actionForMessage.control || (a === 'remote_desktop_send_text' ? 'text' : a === 'remote_desktop_mouse' ? 'mouse_click' : ''),
        });
        const beforeShot = readRemoteDesktopSnapshotForAi(id, action.maxWidth || 640);
        const beforeFrameAt = Number(beforeShot?.frameAt || beforeShot?.at || 0);
        const ackPromise = waitForAiRemoteDesktopActionAck(actionId, action.ackTimeoutMs || 5200);
        frame.contentWindow.postMessage(msg, '*');
        const ack = await ackPromise;
        await delayMs(action.waitMs ?? 2000);
        const result = { remoteDesktopAction: ack || { ok: false, timeout: true }, remoteDesktopScreenshot: await waitForFreshRemoteDesktopSnapshot(id, { maxWidth: action.maxWidth || 640, afterFrameAt: beforeFrameAt, timeoutMs: action.freshTimeoutMs || 2600 }) };
        if (ack && ack.ok === false) result.clientError = ack.error || 'AI 远程桌面操作失败';
        return result;
    }
    if (a === 'toast') { toast(action.text || 'AI 已执行操作'); return; }
    throw new Error(`未知 UI 动作：${a}`);
}
async function handleAiClientCapture(data = {}, { providerId = '', model = '', options = {}, signal = null, original = '', depth = 0, sessionId = '' } = {}) {
    const targetSessionId = sessionId || aiCurrentSessionId;
    if (!data?.clientCaptureRequired || !data.clientCapture) return false;
    if (depth > 0) await delayMs(2000);
    const capture = data.clientCapture || {};
    const targetTabId = String(capture.tabId || capture.targets?.[0]?.tabId || '').trim();
    const maxWidth = Number(capture.maxWidth || 640) || 640;
    const shot = await waitForFreshRemoteDesktopSnapshot(targetTabId, { maxWidth, timeoutMs: 2200 });
    const result = { screenshots: shot ? [shot] : [], message: shot?.dataUrl ? '已实时截取最新远程桌面画面' : (shot?.error || '实时截图不可用'), clientCaptured: true, capturedAt: Date.now() };
    const trace = { tool: 'remote_desktop_screenshot', args: capture.args || { tabId: targetTabId, maxWidth }, result, status: shot?.dataUrl ? 'success' : 'error' };
    appendAiMessage(formatAiToolResult(trace), 'trace', { rawHtml: true, sessionId: targetSessionId });
    const imagePart = shot?.dataUrl ? `\n\n最新远程桌面截图（实时截取）：\n${shot.dataUrl}` : '';
    const followup = `原问题：${original || '继续处理远程桌面操作'}\n\n你刚才请求实时读取远程桌面画面。前端已在此刻重新截取最新画面，截图结果摘要如下：\n${JSON.stringify(maskAiSensitive(result), null, 2).slice(0, 7000)}${imagePart}\n\n请根据这个最新画面继续判断是否完成，或给出下一步操作。不要说你看到的是旧截图；如果截图不可用，直接说明原因。`;
    const next = await api('/api/ai/chat', { method: 'POST', signal, body: JSON.stringify({ messages: [{ role: 'user', content: followup }], providerId, model, options: { ...(options || {}), max_tokens: 900, max_output_tokens: 900 }, context: collectAiContext({ includeRemoteDesktopImages: false, sessionId: targetSessionId }) }) });
    if (next.toolResults?.length) { await syncAiToolSideEffects(next.toolResults, { sessionId: targetSessionId }); appendAiMessage(next.toolResults.map(formatAiToolResult).join(''), 'trace', { rawHtml: true, sessionId: targetSessionId }); }
    if (next.clientCaptureRequired) return handleAiClientCapture(next, { providerId, model, options, signal, original, depth: depth + 1, sessionId: targetSessionId });
    if (next.confirmationRequired) appendAiConfirmation(next.confirmation, { messages: [{ role: 'user', content: followup }], providerId, model, options, context: collectAiContext({ sessionId: targetSessionId }), sessionId: targetSessionId });
    else appendAiMessage(next.message?.content || '执行完成。', 'assistant', { meta: [next.provider?.name, next.model].filter(Boolean).join(' / '), sessionId: targetSessionId, metrics: { ...(next.metrics || {}), provider: next.provider, model: next.model } });
    return true;
}
async function syncAiToolSideEffects(toolResults = [], { sessionId = '' } = {}) {
    for (const r of toolResults) {
        updateAiBrowserPreviewFromToolResult(r, { sessionId });
        if (r.result?.uiAction === 'open_connection' && r.result?.connectionId) {
            try {
                const openedTabId = await openConnection(r.result.connectionId);
                if (openedTabId) r.result.openedTabId = openedTabId;
                const protocol = String(r.result?.connection?.protocol || '').toUpperCase();
                if (['RDP', 'VNC'].includes(protocol)) r.result.remoteDesktopScreenshot = await waitForFreshRemoteDesktopSnapshot(openedTabId, { maxWidth: 640, timeoutMs: 5200 });
            } catch (err) { toast(err.message || 'AI 打开连接失败'); }
        }
        if (r.result?.uiAction === 'ui_action' && r.result?.action) {
            try {
                const clientResult = await performAiUiAction(r.result.action);
                if (clientResult && typeof clientResult === 'object') Object.assign(r.result, clientResult);
            } catch (err) { toast(err.message || 'AI UI 操作失败'); r.result.clientError = err.message || 'AI UI 操作失败'; }
        }
        if (r.tool === 'plan_task' || r.tool === 'plan_update') mergeAiPlan(r.result?.plan);
        if (r.tool === 'memory_save') mergeAiMemory(r.result?.memory);
        if (/^(connection_|proxy_|ssh_key_|jump_host_)/.test(String(r.tool || ''))) {
            await Promise.all([loadConnections().catch(() => {}), loadNetwork().catch(() => {})]);
        }
        if (/^snippet_/.test(String(r.tool || ''))) {
            const snippets = r.result?.resources?.snippets;
            if (Array.isArray(snippets)) { settings.snippets = normalizeSnippets(snippets); renderSnippetSettings(); }
            else await loadSettings().then(() => renderSnippetSettings()).catch(() => {});
        }
    }
}
async function waitForRemoteDesktopSnapshotForAi(tabId = '', maxWidth = 960, timeoutMs = 3600) {
    const deadline = Date.now() + Math.max(800, Number(timeoutMs) || 3600);
    let last = null;
    while (Date.now() < deadline) {
        last = readRemoteDesktopSnapshotForAi(tabId, maxWidth);
        if (last?.dataUrl || (last?.connected && (last.width || last.originalWidth))) return last;
        await delayMs(650);
    }
    return last || readRemoteDesktopSnapshotForAi(tabId, maxWidth);
}
function needsRemoteDesktopClientFollowup(toolResults = []) {
    return (Array.isArray(toolResults) ? toolResults : []).some((r) => {
        const protocol = String(r.result?.connection?.protocol || r.result?.remoteDesktopScreenshot?.protocol || '').toUpperCase();
        const action = String(r.result?.action?.action || '');
        return ['RDP', 'VNC'].includes(protocol) || action.startsWith('remote_desktop');
    });
}
async function continueAiAfterRemoteDesktopClientActions({ original = '', providerId = '', model = '', options = {}, signal = null, toolResults = [], sessionId = '' } = {}) {
    const targetSessionId = sessionId || aiCurrentSessionId;
    const sideEffectSummary = JSON.stringify(maskAiSensitive((Array.isArray(toolResults) ? toolResults : []).map((r) => ({ tool: r.tool, args: r.args, result: r.result }))), null, 2).slice(0, 7000);
    const followup = `原问题：${original}\n\n前端已经尝试执行 RDP/VNC 打开或远程桌面操作。工具/前端执行结果摘要如下：\n${sideEffectSummary || '（无工具结果）'}\n\n现在请基于最新 Zephyr 上下文继续回答；如果结果里有 clientError 或 remoteDesktopAction.ok=false，必须直接告诉用户该操作失败和失败原因，不要声称已经完成；如果工具结果已经包含 remoteDesktopScreenshot/截图摘要，可直接依据它回答，不要重复截图；只有缺少截图且原问题确实询问当前画面时，才调用 remote_desktop_screenshot。不要重复打开同一连接或重复点击刚才的按钮。`;
    const nextOptions = { ...(options || {}), max_tokens: Math.min(Number(options?.max_tokens || 900), 900), max_output_tokens: Math.min(Number(options?.max_output_tokens || 900), 900) };
    const next = await api('/api/ai/chat', { method: 'POST', signal, body: JSON.stringify({ messages: [{ role: 'user', content: followup }], providerId, model, options: nextOptions, context: collectAiContext({ includeRemoteDesktopImages: false, sessionId: targetSessionId }) }) });
    if (next.toolResults?.length) {
        await syncAiToolSideEffects(next.toolResults, { sessionId: targetSessionId });
        appendAiMessage(next.toolResults.map(formatAiToolResult).join(''), 'trace', { rawHtml: true, sessionId: targetSessionId });
    }
    if (next.clientCaptureRequired) return handleAiClientCapture(next, { providerId, model, options, signal, original, sessionId: targetSessionId });
    if (next.confirmationRequired) appendAiConfirmation(next.confirmation, { messages: [{ role: 'user', content: followup }], providerId, model, options, context: collectAiContext({ sessionId: targetSessionId }), sessionId: targetSessionId });
    else appendAiMessage(next.message?.content || '执行完成。', 'assistant', { meta: [next.provider?.name, next.model].filter(Boolean).join(' / '), sessionId: targetSessionId, metrics: { ...(next.metrics || {}), provider: next.provider, model: next.model } });
    return true;
}
function maskAiSensitive(value, tool = '') {
    const sensitiveKeys = /api[_-]?key|password|passwd|private[_-]?key|passphrase|secret|token|authorization|cookie/i;
    const walk = (item, key = '') => {
        if (item === null || item === undefined) return item;
        if (typeof item !== 'object') {
            if (sensitiveKeys.test(key) || (tool === 'get_env_var' && key === 'value')) return item ? '******' : item;
            return item;
        }
        if (Array.isArray(item)) return item.map((x) => walk(x, key));
        return Object.fromEntries(Object.entries(item).map(([k, v]) => {
            if (/^(dataUrl|imageDataUrl)$/i.test(k) && typeof v === 'string') return [k, v ? `[image data omitted ${v.length} chars]` : ''];
            return [k, sensitiveKeys.test(k) || (tool === 'get_env_var' && k === 'value') ? (v ? '******' : v) : walk(v, k)];
        }));
    };
    return walk(value);
}
function summarizeAiToolResult(tool, result = {}) {
    if (tool === 'list_connections') {
        const list = result.connections || [];
        const byProto = list.reduce((acc, c) => { acc[c.protocol || 'SSH'] = (acc[c.protocol || 'SSH'] || 0) + 1; return acc; }, {});
        return `发现 ${list.length} 个连接：${Object.entries(byProto).map(([k, v]) => `${k} ${v}`).join('、') || '无'}`;
    }
    if (tool === 'remote_execute') return `远程命令完成，目标 ${(result.results || []).length} 台`;
    if (tool === 'remote_read_file') return `读取 ${result.path || '文件'}，${result.size || 0} bytes`;
    if (tool === 'remote_write_file') return `写入 ${result.path || '文件'}，${result.bytes || 0} bytes`;
    if (tool === 'web_search') return `搜索返回 ${(result.results || []).length} 条结果`;
    if (tool === 'fetch_url') return `读取网页 ${result.url || ''}`;
    if (tool === 'memory_search') return `Memory 命中 ${(result.memories || []).length} 条`;
    if (tool === 'memory_save') return `已保存 Memory：${result.memory?.title || ''}`;
    if (tool === 'plan_task' || tool === 'plan_update') return `计划 ${result.plan?.title || result.plan?.id || ''}：${result.plan?.status || 'planned'}`;
    if (tool === 'plan_delete') return `已删除计划 ${result.planId || ''}`;
    if (tool === 'open_connection') return result.message || `打开连接 ${result.connection?.name || result.connectionId || ''}`;
    if (tool === 'terminal_read_output') return `读取 ${(result.terminalOutputs || []).length || (result.terminalOutput ? 1 : 0)} 个终端输出快照`;
    if (tool === 'remote_desktop_screenshot') {
        if (result.clientCaptureRequired) return '请求前端实时截取最新远程桌面画面';
        const count = (result.screenshots || []).length || (result.remoteDesktopScreenshots || []).length || (result.screenshot ? 1 : 0);
        return count ? `读取 ${count} 个远程桌面画面快照，已交给 AI 继续分析` : (result.message || '没有可读取的远程桌面画面快照');
    }
    if (tool === 'ui_action' && result.clientError) return `操作失败：${result.clientError}`;
    if (tool === 'ui_action' && result.remoteDesktopScreenshot) return `远程桌面操作完成：${result.remoteDesktopScreenshot.protocol || ''} ${result.remoteDesktopScreenshot.status || ''}`;
    if (tool === 'ui_action' && result.terminalOutput) return `终端输出 ${result.terminalOutput.lineCount || 0} 行${result.terminalOutput.truncated ? '（已截断）' : ''}`;
    if (tool === 'browser_inspect') return `发现 ${(result.elements || []).length} 个可操作元素：${(result.elements || []).slice(0, 5).map((e) => e.text || e.selector).filter(Boolean).join('、')}`;
    if (String(tool || '').startsWith('browser_')) return `AI 正在页面代操作：${result.title || result.url || '浏览器操作完成'}`;
    return '执行完成';
}
function formatAiToolResult(r = {}) {
    const result = r.result || {};
    const detail = JSON.stringify(maskAiSensitive({ args: r.args || {}, result }, r.tool), null, 2);
    const shot = browserShotFromResult(result);
    const titleMap = {
        list_connections: '列出连接', web_search: '网页搜索', fetch_url: '网页读取', browser_navigate: '浏览器打开', browser_inspect: '检查页面元素', browser_screenshot: '浏览器截图', browser_click: '浏览器点击', browser_type: '浏览器输入', browser_scroll: '浏览器滚动', browser_text: '读取浏览器文本', browser_key: '浏览器按键', browser_wait: '等待页面', open_connection: '打开连接', terminal_read_output: '读取终端输出', remote_desktop_screenshot: '读取远程桌面画面', ui_action: '页面/终端代操作', memory_search: '搜索 Memory', memory_save: '保存 Memory', plan_task: '创建计划', plan_update: '更新计划', plan_delete: '删除计划', remote_execute: '远程执行', remote_read_file: '读取远程文件', remote_write_file: '写入远程文件', confirmed: '敏感操作结果'
    };
    const title = titleMap[r.tool] || `工具 ${r.tool || 'unknown'}`;
    const duration = Number.isFinite(Number(r.durationMs)) ? `${(Number(r.durationMs) / 1000).toFixed(1)}s` : '';
    return `<div class="ai-tool-trace" data-tool="${escapeHtml(r.tool || '')}">
        <div class="ai-tool-trace-head"><span class="ai-tool-icon">${String(r.tool || '').startsWith('remote_') ? '▣' : String(r.tool || '').startsWith('browser_') ? '◉' : '◇'}</span><strong>${escapeHtml(title)}</strong>${duration ? `<em>${escapeHtml(duration)}</em>` : ''}</div>
        <div class="ai-tool-summary">${escapeHtml(summarizeAiToolResult(r.tool, result))}</div>
        ${shot?.url ? `<a href="${escapeHtml(shot.url)}" target="_blank" rel="noopener"><img class="ai-inline-shot" src="${escapeHtml(shot.url)}" alt="浏览器截图"></a>` : ''}
        <details class="ai-tool-details"><summary>查看完整参数和结果</summary><pre><code>${escapeHtml(detail)}</code></pre></details>
    </div>`;
}
async function deleteAiPlan(planId) {
    if (!planId) return;
    openAiInlineConfirm({
        title: '删除任务计划',
        body: '删除后计划步骤与日志不可恢复。',
        confirmLabel: '删除',
        danger: true,
        onConfirm: () => deleteAiPlanConfirmed(planId),
    });
}
async function deleteAiPlanConfirmed(planId) {
    try {
        const data = await api('/api/ai/tools/run', { method: 'POST', body: JSON.stringify({ tool: 'plan_delete', args: { planId }, context: collectAiContext() }) });
        const ai = normalizeAiSettings(settings.ai || aiSettingsState || {});
        ai.plans = (ai.plans || []).filter((p) => p.id !== planId);
        settings.ai = ai; aiSettingsState = ai; renderAiPlanList();
        toast(data.result?.deleted ? '计划已删除' : '计划删除完成');
    } catch (err) { toast(err.message || '计划删除失败'); }
}
async function revealAiProviderKey(id) {
    const secret = requestSensitiveSecret('查看已保存 AI API Key');
    const data = await api(`/api/ai/providers/${encodeURIComponent(id)}/open`, { method: 'POST', body: JSON.stringify({ secret }) });
    const provider = normalizeAiSettings(settings.ai || aiSettingsState || {}).providers.find((p) => p.id === id);
    if (provider) openAiProviderModal(provider);
    $('#aiProviderApiKey').value = data.apiKey || '';
    $('#aiProviderApiKey').type = 'text';
    toast(data.hasApiKey ? '已载入保存的 API Key' : '当前未保存 API Key');
}
async function updateAiPlan(planId, action = {}) {
    try {
        const data = await api('/api/ai/tools/run', { method: 'POST', body: JSON.stringify({ tool: 'plan_update', args: { planId, ...action }, context: collectAiContext() }) });
        mergeAiPlan(data.result?.plan);
        toast('计划已更新');
    } catch (err) { toast(err.message || '计划更新失败'); }
}
function formatAiRequestFailure(err) {
    const message = String(err?.message || '请求失败');
    const transient = !!err?.transient || /网络请求失败|网络连接中断|请求超时|fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|502|503|504/i.test(message);
    if (transient) {
        return `请求失败：${message}\n\n我已在服务端对上游 AI fetch failed / 断连 / 超时做自动重试；如果仍出现，多半是当前供应商线路或模型临时不稳。你可以直接重试，或切换模型/供应商。`;
    }
    return `请求失败：${message}\n\n建议：如果这是长对话或 RDP 操作后失败，点“压缩摘要”后重试；我已减少默认上下文和截图大小以降低这类失败。`;
}
let aiRuntimeEnabledCache = null;
async function aiRuntimeIsEnabled() {
    if (aiRuntimeEnabledCache != null) return aiRuntimeEnabledCache;
    try {
        const st = await api('/api/ai/runtime/status');
        aiRuntimeEnabledCache = !!st?.enabled;
    } catch {
        aiRuntimeEnabledCache = false;
    }
    return aiRuntimeEnabledCache;
}

/** Consume SSE from Node proxy. Supports fetch streaming (cookie auth). */
async function consumeAiRuntimeSse(path, { signal, onEvent } = {}) {
    const res = await fetch(path, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { Accept: 'text/event-stream' },
        signal,
    });
    if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw Object.assign(new Error(errBody.error || res.statusText || 'SSE failed'), { status: res.status, body: errBody });
    }
    const reader = res.body?.getReader?.();
    if (!reader) throw new Error('SSE stream unsupported');
    const dec = new TextDecoder();
    let buf = '';
    let eventName = 'message';
    let dataLines = [];
    const flush = () => {
        if (!dataLines.length) return;
        const raw = dataLines.join('\n');
        dataLines = [];
        let payload = raw;
        try { payload = JSON.parse(raw); } catch {}
        const type = payload?.type || eventName;
        onEvent?.({ type, data: payload, raw });
        eventName = 'message';
    };
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
            let line = buf.slice(0, idx);
            buf = buf.slice(idx + 1);
            if (line.endsWith('\r')) line = line.slice(0, -1);
            if (line === '') { flush(); continue; }
            if (line.startsWith(':')) continue;
            if (line.startsWith('event:')) { eventName = line.slice(6).trim(); continue; }
            if (line.startsWith('data:')) { dataLines.push(line.slice(5).trimStart()); continue; }
        }
    }
    flush();
}

async function sendAiMessageViaRuntime({ session, sessionId, text, providerId, model, options, context, abortController }) {
    // Bind browser chat id → server session id (stored on session object).
    let serverSessionId = session.runtimeSessionId || '';
    if (!serverSessionId) {
        const created = await api('/api/ai/runtime/sessions', {
            method: 'POST',
            body: JSON.stringify({ title: session.title || '新对话', metadata: { clientSessionId: sessionId } }),
        });
        serverSessionId = created.session?.id || created.sessionId;
        session.runtimeSessionId = serverSessionId;
        saveAiChats();
    }
    const aiCfg = normalizeAiSettings(settings.ai || {});
    const collabMode = getAiSegmentValue('aiCollabMode', session.collabMode || 'standard');
    session.collabMode = collabMode;
    setAiSegmentValue('aiCollabMode', collabMode, { silent: true });
    const perm = aiCfg.permissions || {};
    const permissionMode = perm.mode || (aiCfg.sensitive?.autoConfirm ? 'auto' : 'ask');
    const start = await api('/api/ai/runtime/runs', {
        method: 'POST',
        signal: abortController.signal,
        body: JSON.stringify({
            sessionId: serverSessionId,
            message: text,
            providerId,
            model,
            options,
            context,
            mode: collabMode,
            permissionMode,
            permission: {
                mode: permissionMode,
                deny: perm.deny || [],
                allow: perm.allow || [],
                ask: perm.ask || [],
            },
        }),
    });
    session.runtimeRunId = start.runId;
    session.runtimeTicket = start.ticket || session.runtimeTicket || '';
    saveAiChats();

    let assistantText = '';
    const toolTrace = [];
    let assistantEl = null;
    let assistantMsgIndex = -1;
    const ensureAssistantBubble = () => {
        if (assistantEl && document.contains(assistantEl)) return assistantEl;
        appendAiMessage(assistantText || '', 'assistant', {
            sessionId,
            meta: [model].filter(Boolean).join(' / '),
            store: true,
        });
        const area = $('#aiChatArea');
        const nodes = area?.querySelectorAll?.('.ai-message.ai, .ai-message.assistant');
        assistantEl = nodes?.[nodes.length - 1] || null;
        if (assistantEl?.dataset?.aiMessageIndex != null) {
            assistantMsgIndex = Number(assistantEl.dataset.aiMessageIndex);
        }
        return assistantEl;
    };
    const patchAssistant = () => {
        ensureAssistantBubble();
        if (!assistantEl) return;
        const metaHtml = assistantEl.querySelector('small')
            ? `<small>${assistantEl.querySelector('small').innerHTML}</small>`
            : (model ? `<small>${escapeHtml(model)}</small>` : '');
        assistantEl.innerHTML = `${metaHtml}${renderAiMessageContent(assistantText, 'assistant', false)}`;
        assistantEl.dataset.aiMessageText = assistantText;
        const s = aiChatSessions.find((x) => x.id === sessionId);
        if (s?.messages?.length) {
            if (assistantMsgIndex >= 0 && s.messages[assistantMsgIndex]?.role === 'assistant') {
                s.messages[assistantMsgIndex].content = assistantText;
            } else {
                const last = s.messages[s.messages.length - 1];
                if (last?.role === 'assistant') last.content = assistantText;
            }
            saveAiChats();
        }
        scrollAiChat();
    };

    const ssePath = start.sseProxyPath || start.ssePath || `/api/ai/runtime/runs/${encodeURIComponent(start.runId)}/events?ticket=${encodeURIComponent(start.ticket || '')}`;
    await consumeAiRuntimeSse(ssePath, {
        signal: abortController.signal,
        onEvent: async ({ type, data }) => {
            const evType = data?.type || type;
            const payload = data?.data != null && typeof data.data === 'object' && !Array.isArray(data.data)
                ? data.data
                : (typeof data?.data === 'string' ? (() => { try { return JSON.parse(data.data); } catch { return { text: data.data }; } })() : data);
            // When full event envelope: data is Event, payload in data.data (already parsed object or string)
            let body = payload;
            if (data?.data && data.type) {
                body = typeof data.data === 'string' ? (() => { try { return JSON.parse(data.data); } catch { return {}; } })() : data.data;
            }
            switch (evType) {
                case 'text.delta': {
                    const t = body?.text || payload?.text || '';
                    if (t) { assistantText += t; patchAssistant(); }
                    break;
                }
                case 'tool.start':
                case 'tool.pending':
                    toolTrace.push({ phase: evType, name: body?.name || '', callId: body?.callId || '' });
                    break;
                case 'tool.result':
                case 'tool.error': {
                    const item = {
                        tool: body?.name || 'tool',
                        args: body?.args || {},
                        result: body?.result,
                        status: body?.status || (evType === 'tool.error' ? 'error' : 'success'),
                    };
                    toolTrace.push(item);
                    try { await syncAiToolSideEffects([item], { sessionId }); } catch {}
                    appendAiMessage(formatAiToolResult(item), 'trace', { rawHtml: true, sessionId });
                    break;
                }
                case 'permission.ask': {
                    const conf = {
                        id: body?.askId || body?.callId || `ask_${Date.now()}`,
                        tool: body?.name || '',
                        summary: body?.summary || `允许执行 ${body?.name || '操作'}？`,
                        args: body?.args || {},
                    };
                    appendAiConfirmation(conf, {
                        runtime: true,
                        runId: start.runId,
                        serverSessionId,
                        providerId,
                        model,
                        options,
                        context,
                        sessionId,
                    });
                    break;
                }
                case 'client.capture': {
                    // Reuse legacy capture path shape
                    await handleAiClientCapture({
                        clientCaptureRequired: true,
                        clientCapture: body,
                        provider: { name: 'runtime' },
                        model,
                    }, { providerId, model, options, signal: abortController.signal, original: text, sessionId, runtime: true, runId: start.runId });
                    break;
                }
                case 'message.completed': {
                    if (body?.content && !assistantText) {
                        assistantText = body.content;
                        patchAssistant();
                    }
                    break;
                }
                case 'run.completed': {
                    if (!assistantText) {
                        appendAiMessage('执行完成。', 'assistant', { sessionId, metrics: body?.metrics || null });
                    } else {
                        // finalize metrics on last message
                        const s = aiChatSessions.find((x) => x.id === sessionId);
                        const last = s?.messages?.[s.messages.length - 1];
                        if (last?.role === 'assistant') last.metrics = body?.metrics || null;
                        saveAiChats();
                    }
                    break;
                }
                case 'run.failed':
                    appendAiMessage(body?.error || 'AI 运行失败', 'system', { sessionId });
                    break;
                case 'run.aborted':
                    appendAiMessage('AI 回复已中断。', 'system', { sessionId });
                    break;
                default:
                    break;
            }
        },
    });
}

async function sendAiMessage() {
    const session = aiCurrentSession();
    const sessionId = session?.id || '';
    if (!sessionId) return;
    if (aiIsSessionRunning(sessionId)) { stopAiResponse(sessionId); return; }
    const input = $('#aiUserInput');
    const typedText = input.value.trim();
    const attachmentText = aiPendingInputAttachments.map((a) => a.content || '').filter(Boolean).join('\n\n');
    const text = [typedText, attachmentText].filter(Boolean).join('\n\n');
    if (!text) return;
    const editingIndex = aiEditingSessionId && aiEditingSessionId !== sessionId ? -1 : aiEditingMessageIndex;
    aiEditingMessageIndex = -1;
    aiEditingSessionId = '';
    if (editingIndex >= 0) {
        session.messages = session.messages.slice(0, Math.max(0, editingIndex));
        renderAiChat();
    }
    input.value = '';
    aiPendingInputAttachments = [];
    autoResizeAiInput(input);
    updateAiInputPreview();
    input.focus?.();
    appendAiMessage(text, 'user', { sessionId });
    const abortController = new AbortController();
    registerAiSessionRun(sessionId, abortController);
    try {
        const context = collectAiContext({ sessionId });
        const providerId = $('#aiProviderSelect').value;
        const model = $('#aiModelSelect').value;
        const options = aiIntensityOptions();
        const useRuntime = await aiRuntimeIsEnabled();
        if (useRuntime) {
            await sendAiMessageViaRuntime({ session, sessionId, text, providerId, model, options, context, abortController });
            return;
        }
        const requestMessages = aiMessagesForRequest(session, text);
        const data = await api('/api/ai/chat', { method: 'POST', signal: abortController.signal, body: JSON.stringify({ messages: requestMessages, providerId, model, options, context }) });
        if (data.toolResults?.length) {
            await syncAiToolSideEffects(data.toolResults, { sessionId });
            appendAiMessage(data.toolResults.map(formatAiToolResult).join(''), 'trace', { rawHtml: true, sessionId });
        }
        if (data.clientCaptureRequired) {
            await handleAiClientCapture(data, { providerId, model, options, signal: abortController.signal, original: text, sessionId });
        } else if (data.confirmationRequired) {
            appendAiConfirmation(data.confirmation, { messages: requestMessages.slice(), providerId, model, options, context, sessionId });
        } else if (needsRemoteDesktopClientFollowup(data.toolResults || [])) {
            await continueAiAfterRemoteDesktopClientActions({ original: text, providerId, model, options, signal: abortController.signal, toolResults: data.toolResults || [], sessionId });
        } else {
            appendAiMessage(data.message?.content || '执行完成。', 'assistant', { meta: [data.provider?.name, data.model].filter(Boolean).join(' / '), sessionId, metrics: { ...(data.metrics || {}), provider: data.provider, model: data.model } });
        }
    } catch (err) {
        if (err.name === 'AbortError' || /aborted|abort|已停止/i.test(String(err.message || ''))) {
            if (!aiStoppedControllers.has(abortController)) appendAiMessage('AI 回复已中断。', 'system', { sessionId });
        } else appendAiMessage(formatAiRequestFailure(err), 'system', { sessionId });
    } finally {
        clearAiSessionRun(sessionId, abortController);
        aiStoppedControllers.delete(abortController);
    }
}
function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
        reader.readAsDataURL(file);
    });
}
async function appendAiFiles(files = []) {
    const next = [];
    for (const file of files.slice(0, Math.max(0, 6 - aiPendingInputAttachments.length))) {
        if (file.size > 8 * 1024 * 1024) { next.push({ kind: 'skipped', name: file.name, content: `[附件过大已跳过] ${file.name} (${file.size} bytes)` }); continue; }
        const isText = /^text\//i.test(file.type) || /\.(txt|md|json|yaml|yml|csv|log|conf|ini|js|ts|jsx|tsx|py|sh|css|html|xml)$/i.test(file.name);
        if (isText) {
            const text = await file.text();
            next.push({ kind: 'text', name: file.name, content: `附件：${file.name}\n\`\`\`\n${text.slice(0, 24000)}${text.length > 24000 ? '\n...[已截断]' : ''}\n\`\`\`` });
        } else if (/^image\//i.test(file.type)) {
            const dataUrl = await readFileAsDataUrl(file);
            next.push({ kind: 'image', name: file.name, content: `附件图片：${file.name}\n${dataUrl}` });
        } else {
            next.push({ kind: 'file', name: file.name, content: `附件：${file.name} (${file.type || 'unknown'}, ${file.size} bytes)；当前仅文本和图片会发送给 AI。` });
        }
    }
    if (!next.length) return;
    aiPendingInputAttachments = aiPendingInputAttachments.concat(next).slice(0, 6);
    updateAiAttachmentDraftUi();
    $('#aiUserInput')?.focus?.();
    toast(`已添加 ${next.length} 个附件，可继续输入文字后发送`);
}
async function continueAiAfterConfirmation(id, approve, data) {
    const pending = aiPendingConfirmations.get(id);
    aiPendingConfirmations.delete(id);
    if (!approve || !pending) return;
    const sessionId = pending.sessionId || aiCurrentSessionId;
    if (aiIsSessionRunning(sessionId)) { stopAiResponse(sessionId); return; }
    const original = (pending.messages || []).slice().reverse().find((m) => m.role === 'user')?.content || '';
    const session = aiChatSessions.find((s) => s.id === sessionId);
    if (session) {
        session.messages = session.messages.filter((m) => m.confirmationId !== id);
        saveAiChats();
        if (sessionId === aiCurrentSessionId) renderAiChat();
    }
    const followup = `原问题：${original}\n\n敏感操作已确认并执行，结果如下：\n${JSON.stringify(data.result || {}, null, 2).slice(0, 30000)}\n请基于这个结果继续回答原问题，直接给出结论，不要只复述 JSON。`;
    const abortController = new AbortController();
    registerAiSessionRun(sessionId, abortController);
    try {
        const next = await api('/api/ai/chat', { method: 'POST', signal: abortController.signal, body: JSON.stringify({ messages: [{ role: 'user', content: followup }], providerId: pending.providerId, model: pending.model, options: pending.options || aiIntensityOptions(), context: collectAiContext({ includeRemoteDesktopImages: false, sessionId }) }) });
        if (next.toolResults?.length) { await syncAiToolSideEffects(next.toolResults, { sessionId }); appendAiMessage(next.toolResults.map(formatAiToolResult).join(''), 'trace', { rawHtml: true, sessionId }); }
        if (next.clientCaptureRequired) await handleAiClientCapture(next, { providerId: pending.providerId, model: pending.model, options: pending.options || aiIntensityOptions(), signal: abortController.signal, original, sessionId });
        else if (next.confirmationRequired) appendAiConfirmation(next.confirmation, { messages: [{ role: 'user', content: followup }], providerId: pending.providerId, model: pending.model, options: pending.options, context: pending.context, sessionId });
        else appendAiMessage(next.message?.content || '执行完成。', 'assistant', { meta: [next.provider?.name, next.model].filter(Boolean).join(' / '), sessionId, metrics: { ...(next.metrics || {}), provider: next.provider, model: next.model } });
    } catch (err) {
        if (err.name === 'AbortError' || /aborted|abort|已停止/i.test(String(err.message || ''))) {
            if (!aiStoppedControllers.has(abortController)) appendAiMessage('AI 后续处理已中断。', 'system', { sessionId });
        } else appendAiMessage(formatAiRequestFailure(err).replace(/^请求失败/, '继续处理失败'), 'system', { sessionId });
    } finally {
        clearAiSessionRun(sessionId, abortController);
        aiStoppedControllers.delete(abortController);
    }
}
function insertAiConfirmationCard(confirmation, messageIndex = -1) {
    const area = $('#aiChatArea');
    const typing = $('#aiTypingIndicator');
    if (!area || !typing) return;
    const div = document.createElement('div');
    div.className = 'ai-message system ai-confirm-card';
    div.dataset.aiMessageRole = 'confirmation';
    if (messageIndex >= 0) div.dataset.aiMessageIndex = String(messageIndex);
    div.dataset.aiMessageText = `需要确认敏感操作：${confirmation?.summary || ''}`;
    div.innerHTML = `<strong>需要确认敏感操作</strong><p>${escapeHtml(confirmation?.summary || '')}</p><pre>${escapeHtml(JSON.stringify(confirmation?.args || {}, null, 2))}</pre><div class="form-actions"><button class="btn btn-primary" data-ai-confirm-approve="${escapeHtml(confirmation?.id || '')}">确认执行</button><button class="btn danger" data-ai-confirm-deny="${escapeHtml(confirmation?.id || '')}">拒绝</button></div>`;
    div.title = '';
    area.insertBefore(div, typing);
}
function appendAiConfirmation(confirmation, pending = {}) {
    const sessionId = pending.sessionId || aiCurrentSessionId;
    const text = `需要确认敏感操作：${confirmation.summary || ''}`;
    if (confirmation?.id) aiPendingConfirmations.set(confirmation.id, { ...pending, sessionId, confirmation });
    const session = aiChatSessions.find((s) => s.id === sessionId) || aiCurrentSession();
    if (!session) return;
    session.messages.push({ role: 'confirmation', content: text, confirmationId: confirmation?.id || '', summary: confirmation?.summary || '' });
    const messageIndex = session.messages.length - 1;
    saveAiChats();
    renderAiChatList();
    if (session.id === aiCurrentSessionId) {
        insertAiConfirmationCard(confirmation, messageIndex);
        scrollAiChat();
    }
}
async function resolveAiConfirmation(id, approve) {
    const pending = aiPendingConfirmations.get(id);
    const sessionId = pending?.sessionId || aiCurrentSessionId;
    if (aiIsSessionRunning(sessionId)) { stopAiResponse(sessionId); return; }
    const abortController = new AbortController();
    registerAiSessionRun(sessionId, abortController);
    try {
        // Go runtime permission path (grant + optional follow-up).
        if (pending?.runtime && pending.runId) {
            await api(`/api/ai/runtime/runs/${encodeURIComponent(pending.runId)}/permission`, {
                method: 'POST',
                signal: abortController.signal,
                body: JSON.stringify({
                    approve: !!approve,
                    sessionId: pending.serverSessionId || '',
                    callId: id,
                    tool: pending.confirmation?.tool || '',
                    scope: approve ? (pending.scope || 'session') : 'once',
                    providerId: pending.providerId || $('#aiProviderSelect')?.value || '',
                    model: pending.model || $('#aiModelSelect')?.value || '',
                }),
            });
            aiPendingConfirmations.delete(id);
            const session = aiChatSessions.find((s) => s.id === sessionId);
            if (session) session.messages = session.messages.filter((m) => m.confirmationId !== id);
            if (!approve) {
                appendAiMessage('已拒绝执行敏感操作。', 'system', { sessionId });
                if (sessionId === aiCurrentSessionId) renderAiChat();
                return;
            }
            appendAiMessage(approve ? '已授权，正在继续…' : '已拒绝。', 'system', { sessionId });
            clearAiSessionRun(sessionId, abortController);
            // True mid-run resume: Go continues same run; keep listening on same SSE ticket if still open.
            // Permission endpoint launches resume; client re-subscribes SSE for the same runId.
            if (approve && pending.runId) {
                const contController = new AbortController();
                registerAiSessionRun(sessionId, contController);
                try {
                    const ticket = session?.runtimeTicket || '';
                    const ssePath = `/api/ai/runtime/runs/${encodeURIComponent(pending.runId)}/events?ticket=${encodeURIComponent(ticket)}`;
                    // If ticket missing, status poll only — user still sees tool traces on next message.
                    if (ticket) {
                        await consumeAiRuntimeSse(ssePath, {
                            signal: contController.signal,
                            onEvent: ({ type, data }) => {
                                const evType = data?.type || type;
                                if (evType === 'text.delta') {
                                    const body = typeof data?.data === 'string' ? (() => { try { return JSON.parse(data.data); } catch { return {}; } })() : (data?.data || data);
                                    if (body?.text) appendAiMessage(body.text, 'assistant', { sessionId, store: true });
                                }
                                if (evType === 'tool.result' || evType === 'tool.error') {
                                    const body = typeof data?.data === 'string' ? (() => { try { return JSON.parse(data.data); } catch { return {}; } })() : (data?.data || data);
                                    const item = { tool: body?.name || 'tool', args: body?.args || {}, result: body?.result, status: body?.status || 'success' };
                                    appendAiMessage(formatAiToolResult(item), 'trace', { rawHtml: true, sessionId });
                                }
                                if (evType === 'run.completed' && data?.data) {
                                    const body = typeof data.data === 'string' ? (() => { try { return JSON.parse(data.data); } catch { return {}; } })() : data.data;
                                    if (body?.metrics) { /* optional */ }
                                }
                            },
                        });
                    }
                } finally {
                    clearAiSessionRun(sessionId, contController);
                }
            }
            return;
        }

        const data = await api(`/api/ai/confirm/${encodeURIComponent(id)}`, { method: 'POST', signal: abortController.signal, body: JSON.stringify({ approve }) });
        if (approve && data.result) {
            await syncAiToolSideEffects([{ tool: data.toolName || (data.result?.plan ? 'plan_update' : ''), args: data.args || {}, result: data.result }], { sessionId });
            appendAiMessage(formatAiToolResult({ tool: 'confirmed', result: data.result, args: data.args || {}, durationMs: data.durationMs }), 'trace', { rawHtml: true, sessionId });
            clearAiSessionRun(sessionId, abortController);
            await continueAiAfterConfirmation(id, true, data);
        } else {
            aiPendingConfirmations.delete(id);
            const session = aiChatSessions.find((s) => s.id === sessionId);
            if (session) session.messages = session.messages.filter((m) => m.confirmationId !== id);
            appendAiMessage('已拒绝执行敏感操作。', 'system', { sessionId });
            if (sessionId === aiCurrentSessionId) renderAiChat();
        }
    } catch (err) {
        if (err.name === 'AbortError' || /aborted|abort|已停止/i.test(String(err.message || ''))) {
            if (!aiStoppedControllers.has(abortController)) appendAiMessage('AI 确认操作已中断。', 'system', { sessionId });
        } else appendAiMessage(`确认处理失败：${err.message}`, 'system', { sessionId });
    } finally {
        clearAiSessionRun(sessionId, abortController);
        aiStoppedControllers.delete(abortController);
    }
}
function autoResizeAiInput(textarea) { textarea.style.height = 'auto'; textarea.style.height = `${Math.min(140, textarea.scrollHeight)}px`; }
function estimateAiMessageChars(message) {
    const text = String(message?.content || '');
    return text.length + (text.includes('data:image/') ? 1200 : 0);
}
function compressAiMessagesForRequest(messages = [], latest = '') {
    const clean = (Array.isArray(messages) ? messages : [])
        .filter((m) => ['user', 'assistant', 'confirmation'].includes(String(m.role || '')) && !/^请求失败[:：]/.test(String(m.content || '')))
        .map((m) => ({ role: m.role === 'confirmation' ? 'assistant' : m.role, content: String(m.content || '') }));
    const last = clean[clean.length - 1];
    if (latest && (!last || last.role !== 'user' || String(last.content || '') !== latest)) clean.push({ role: 'user', content: latest });
    const total = clean.reduce((sum, m) => sum + estimateAiMessageChars(m), 0);
    if (clean.length <= 18 && total <= 72000) return clean;
    const recent = [];
    let recentChars = 0;
    for (let i = clean.length - 1; i >= 0; i -= 1) {
        const len = estimateAiMessageChars(clean[i]);
        if (recent.length >= 12 && recentChars + len > 42000) break;
        recent.unshift(clean[i]);
        recentChars += len;
    }
    const older = clean.slice(0, Math.max(0, clean.length - recent.length));
    if (!older.length) return recent;
    let summary = `高轮次对话压缩摘要（前端自动生成；不是限制轮次，最近 ${recent.length} 条仍保留原文）：\n`;
    for (const m of older) {
        if (summary.length > 18000) break;
        const role = m.role === 'assistant' ? 'AI' : '用户';
        const text = m.content.replace(/data:image\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/=\r\n]+/g, '[图片]').replace(/\s+/g, ' ').trim().slice(0, 700);
        if (text) summary += `- ${role}: ${text}\n`;
    }
    return [{ role: 'user', content: summary.slice(0, 20000) }, ...recent];
}
function aiMessagesForRequest(session, latestText = '') {
    const messages = Array.isArray(session?.messages) ? session.messages : [];
    const latest = String(latestText || messages[messages.length - 1]?.content || '');
    return compressAiMessagesForRequest(messages, latest);
}
function startAiPanelWatchdog() {
    window.clearInterval(aiPanelWatchdogTimer);
    aiPanelWatchdogTimer = window.setInterval(() => {
        const p = $('#aiAgentPanel');
        if (!p || aiPanelState !== 'open') return;
        const rect = p.getBoundingClientRect();
        const bad = p.style.display === 'none' || p.getAttribute('aria-hidden') === 'true' || rect.width < 120 || rect.height < 160 || getComputedStyle(p).opacity === '0';
        if (bad) {
            p.style.display = 'flex';
            p.style.opacity = '1';
            p.style.transform = 'none';
            p.style.filter = 'none';
            p.classList.remove('panel-opening', 'panel-closing');
            p.setAttribute('aria-hidden', 'false');
            clampAiPanel(p);
        }
    }, 1200);
}
function stopAiPanelWatchdog() { window.clearInterval(aiPanelWatchdogTimer); aiPanelWatchdogTimer = 0; }
function openAiAssistantPanel(trigger = null) {
    const ai = normalizeAiSettings(settings.ai || {});
    if (!ai.enabled) { toast('请先在设置中启用 AI 助理'); return; }
    const panel = $('#aiAgentPanel');
    if (!panel) return;
    const wasClosing = aiPanelState === 'closing';
    const wasHidden = panel.style.display === 'none' || panel.getAttribute('aria-hidden') === 'true' || aiPanelState === 'closed' || wasClosing;
    const sourceButton = trigger || aiPanelMorphOriginButton || $('#aiFloatingBtn') || $('#openAiAssistantBtn') || $('#openAiAssistantBtn2') || $('#aiNavTab');
    aiPanelMorphOriginButton = sourceButton || aiPanelMorphOriginButton;
    window.clearTimeout(aiPanelCloseTimer);
    window.clearTimeout(panel._aiPanelMotionTimer);
    aiPanelState = 'opening';
    panel.style.display = 'flex';
    panel.style.visibility = 'visible';
    panel.style.pointerEvents = 'auto';
    panel.style.opacity = '1';
    panel.style.transform = 'none';
    panel.style.filter = 'none';
    panel.classList.remove('panel-closing', 'ai-morph-closing', 'ai-morph-settled');
    panel.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');
    $('#aiFloatingBtn')?.classList.add('active');
    if (wasHidden && panel._aiMorphFinalStyle) Object.assign(panel.style, panel._aiMorphFinalStyle);
    if (!panel.dataset.positioned) {
        const compact = window.innerWidth <= 760;
        const vvWidth = window.visualViewport?.width || window.innerWidth;
        const vvHeight = window.visualViewport?.height || window.innerHeight;
        const width = compact ? Math.max(300, Math.min(vvWidth - 40, Math.round(vvWidth * 0.88))) : Math.min(980, window.innerWidth - 40);
        const height = compact ? Math.max(360, Math.min(vvHeight - 96, Math.round(vvHeight * 0.78))) : Math.min(780, window.innerHeight - 80);
        panel.style.left = compact ? `${Math.max(16, Math.round((vvWidth - width) / 2))}px` : `${Math.max(16, (window.innerWidth - width) / 2)}px`;
        panel.style.top = compact ? `${Math.max(18, Math.round((vvHeight - height) * 0.16))}px` : '52px';
        panel.style.width = `${width}px`;
        panel.style.height = `${height}px`;
        panel.dataset.positioned = '1';
    }
    bringAiPanelToFront();
    updateAiPanelResponsiveState();
    if (!aiChatSessions.length) { loadAiChats(); if (!aiChatSessions.length) createAiChat({ silent: true }); }
    renderAiHeaderSelectors(); renderAiBrowserPreview(); renderAiChat();
    if (wasHidden) {
        requestAnimationFrame(() => animateAiPanelFromButton(panel, sourceButton, true, () => {
            if (aiPanelState === 'opening') aiPanelState = 'open';
        }));
    } else {
        aiPanelState = 'open';
    }
    startAiPanelWatchdog();
    if (window.innerWidth > 760) setTimeout(() => $('#aiUserInput')?.focus?.(), 80);
}
function toggleAiAssistantPanel(trigger = null) {
    const panel = $('#aiAgentPanel');
    const visible = panel && panel.style.display !== 'none' && aiPanelState !== 'closed';
    if (visible) {
        aiPanelMorphOriginButton = trigger || aiPanelMorphOriginButton || $('#aiFloatingBtn');
        closeAiAssistantPanel();
        return;
    }
    openAiAssistantPanel(trigger);
}
function closeAiAssistantPanel() {
    const p = $('#aiAgentPanel');
    if (!p || p.style.display === 'none') return;
    closeAiPanelLayoutMenu({ instant: true });
    window.clearTimeout(aiPanelCloseTimer);
    window.clearTimeout(p._aiPanelMotionTimer);
    aiPanelState = 'closing';
    p.classList.remove('panel-opening', 'ai-morph-open', 'ai-morph-settled');
    p.setAttribute('aria-hidden', 'true');
    closeAiBrowserForSession(aiCurrentSessionId);
    $('#aiFloatingBtn')?.classList.remove('active');
    const finishClose = () => {
        if (aiPanelState !== 'closing') return;
        p.style.display = 'none';
        p.style.visibility = '';
        p.style.pointerEvents = '';
        p.style.opacity = '';
        p.style.transform = '';
        p.style.filter = '';
        p.style.transition = '';
        p.style.boxShadow = '';
        p.style.borderRadius = '';
        p.style.background = '';
        p.style.borderColor = '';
        p.style.color = '';
        p.classList.remove('panel-opening', 'panel-closing', 'ai-morphing', 'ai-morph-open', 'ai-morph-closing');
        restoreAiMorphButton(aiPanelMorphOriginButton);
        restoreAiMorphButton($('#aiFloatingBtn'));
        restoreAiMorphButton($('#aiNavTab'));
        aiPanelState = 'closed';
        stopAiPanelWatchdog();
    };
    const didAnimate = animateAiPanelFromButton(p, aiPanelMorphOriginButton || $('#aiFloatingBtn') || $('#aiNavTab'), false, finishClose);
    if (!didAnimate) aiPanelCloseTimer = window.setTimeout(finishClose, 20);
}
function bringAiPanelToFront() { const p = $('#aiAgentPanel'); if (!p) return; p.style.zIndex = String(10080 + Math.floor(Date.now() % 40)); p.style.setProperty('--panel-z', p.style.zIndex); }
function applyAiPanelLayout(layout) {
    const p = $('#aiAgentPanel');
    if (!p) return;
    const parentRect = aiPanelParentRect(p);
    const compact = window.innerWidth <= 760;
    const margin = compact ? 6 : 12;
    const topbar = compact ? 38 : 52;
    let left = margin, top = topbar, width = parentRect.width - margin * 2, height = parentRect.height - topbar - margin;
    if (layout === 'full') { left = margin; top = margin; width = parentRect.width - margin * 2; height = parentRect.height - margin * 2; }
    else if (layout === 'half') { width = parentRect.width; height = Math.max(compact ? 260 : 360, parentRect.height / 2); left = 0; top = parentRect.height - height; }
    else if (layout === 'left-quarter') { width = Math.max(compact ? 260 : 340, parentRect.width / 4); height = parentRect.height - topbar; left = 0; top = topbar; }
    else if (layout === 'right-quarter') { width = Math.max(compact ? 260 : 340, parentRect.width / 4); height = parentRect.height - topbar; left = parentRect.width - width; top = topbar; }
    p.classList.add('layout-animating');
    window.clearTimeout(p._layoutAnimationTimer);
    Object.assign(p.style, { left: `${left}px`, top: `${top}px`, right: 'auto', bottom: 'auto', width: `${width}px`, height: `${height}px` });
    bringAiPanelToFront();
    p._layoutAnimationTimer = window.setTimeout(() => { p.classList.remove('layout-animating'); clampAiPanel(p); updateAiPanelResponsiveState(); }, 480);
}
function aiMorphCssTimeToMs(value, fallback = 0) {
    const text = String(value || '').trim();
    if (!text) return fallback;
    const first = text.split(',')[0].trim();
    const n = parseFloat(first);
    if (!Number.isFinite(n)) return fallback;
    return first.endsWith('ms') ? n : n * 1000;
}
function captureAiMorphButton(button) {
    if (!button?.getBoundingClientRect) return null;
    const rect = button.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) return null;
    const style = getComputedStyle(button);
    return {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        radius: style.borderRadius || `${Math.round(rect.height / 2)}px`,
        background: style.backgroundColor || style.background || 'var(--accent)',
        borderColor: style.borderColor || 'transparent',
        color: style.color || '#fff',
    };
}
function ghostAiMorphButton(button) {
    if (!button) return;
    if (button.dataset.aiMorphOpacity == null) button.dataset.aiMorphOpacity = button.style.opacity || '';
    button.setAttribute('data-ai-morph-source', '1');
}
function restoreAiMorphButton(button = null) {
    const target = button || aiPanelMorphOriginButton || $('#aiFloatingBtn');
    if (!target) return;
    if (target.dataset.aiMorphOpacity != null) {
        target.style.opacity = target.dataset.aiMorphOpacity;
        delete target.dataset.aiMorphOpacity;
    } else {
        target.style.removeProperty('opacity');
    }
    target.removeAttribute('data-ai-morph-source');
}
function animateAiPanelFromButton(panel, button, opening = true, onDone = null) {
    if (!panel) return false;
    const rootStyle = getComputedStyle(document.documentElement);
    const openDur = rootStyle.getPropertyValue('--ai-morph-dur-open') || '0.52s';
    const closeDur = rootStyle.getPropertyValue('--ai-morph-dur-close') || '0.42s';
    const openSpring = rootStyle.getPropertyValue('--ai-morph-spring-open') || 'cubic-bezier(0.32, 0.72, 0, 1)';
    const closeSpring = rootStyle.getPropertyValue('--ai-morph-spring-close') || 'cubic-bezier(0.4, 0, 0.6, 1)';
    const liveSource = captureAiMorphButton(button);
    const source = liveSource || panel._aiMorphSourceRect;
    const currentRect = panel.getBoundingClientRect?.();
    if (!source || !currentRect || currentRect.width <= 1 || currentRect.height <= 1) {
        // Floating AI panel must not transform or blur the background.
        restoreAiMorphButton(button);
        if (onDone) onDone();
        return false;
    }
    const sourceRadius = source.radius || `${Math.round(source.height / 2)}px`;
    const measuredStyle = {
        left: panel.style.left || `${currentRect.left}px`,
        top: panel.style.top || `${currentRect.top}px`,
        width: panel.style.width || `${currentRect.width}px`,
        height: panel.style.height || `${currentRect.height}px`,
        right: panel.style.right || 'auto',
        bottom: panel.style.bottom || 'auto',
    };
    if (!opening) {
        panel._aiMorphFinalStyle = { ...measuredStyle };
        panel._aiMorphFinalRect = { left: currentRect.left, top: currentRect.top, width: currentRect.width, height: currentRect.height };
    }
    const finalStyle = opening ? (panel._aiMorphFinalStyle || measuredStyle) : measuredStyle;
    const finalRect = opening ? currentRect : (panel._aiMorphFinalRect || currentRect);
    const finalRadius = opening ? (getComputedStyle(panel).borderRadius || '18px') : (panel._aiMorphFinalRadius || getComputedStyle(panel).borderRadius || '18px');
    const finalLeft = opening ? (finalStyle.left || `${finalRect.left}px`) : `${source.left}px`;
    const finalTop = opening ? (finalStyle.top || `${finalRect.top}px`) : `${source.top}px`;
    const finalWidth = opening ? (finalStyle.width || `${finalRect.width}px`) : `${source.width}px`;
    const finalHeight = opening ? (finalStyle.height || `${finalRect.height}px`) : `${source.height}px`;
    const startLeft = opening ? `${source.left}px` : `${currentRect.left}px`;
    const startTop = opening ? `${source.top}px` : `${currentRect.top}px`;
    const startWidth = opening ? `${source.width}px` : `${currentRect.width}px`;
    const startHeight = opening ? `${source.height}px` : `${currentRect.height}px`;
    const startRadius = opening ? sourceRadius : finalRadius;
    const endRadius = opening ? finalRadius : sourceRadius;
    const dur = opening ? openDur.trim() : closeDur.trim();
    const spring = opening ? openSpring.trim() : closeSpring.trim();
    const fallbackMs = aiMorphCssTimeToMs(dur, opening ? 520 : 420) + 110;
    if (opening) {
        panel._aiMorphSourceRect = { ...source };
        panel._aiMorphFinalRect = { left: finalRect.left, top: finalRect.top, width: finalRect.width, height: finalRect.height };
        panel._aiMorphFinalStyle = { ...finalStyle };
        panel._aiMorphFinalRadius = finalRadius;
    }
    const originX = ((source.left + source.width / 2 - (opening ? finalRect.left : currentRect.left)) / (opening ? finalRect.width : currentRect.width)) * 100;
    const originY = ((source.top + source.height / 2 - (opening ? finalRect.top : currentRect.top)) / (opening ? finalRect.height : currentRect.height)) * 100;
    panel.style.setProperty('--panel-origin-x', `${Math.max(4, Math.min(96, originX))}%`);
    panel.style.setProperty('--panel-origin-y', `${Math.max(4, Math.min(96, originY))}%`);
    panel.classList.remove('panel-opening', 'panel-closing', 'ai-morph-open', 'ai-morph-closing');
    if (panel._aiMorphTransitionEnd) {
        panel.removeEventListener('transitionend', panel._aiMorphTransitionEnd);
        panel._aiMorphTransitionEnd = null;
    }
    const motionId = (panel._aiMorphMotionId || 0) + 1;
    panel._aiMorphMotionId = motionId;
    panel.classList.add('ai-morphing');
    if (opening) panel.classList.remove('ai-morph-open'); else panel.classList.add('ai-morph-open');
    panel.style.transition = 'none';
    Object.assign(panel.style, {
        left: startLeft,
        top: startTop,
        right: 'auto',
        bottom: 'auto',
        width: startWidth,
        height: startHeight,
        borderRadius: startRadius,
        boxShadow: opening ? 'var(--ai-morph-shadow-idle)' : 'var(--ai-morph-shadow-active)',
        background: opening ? source.background : '',
        borderColor: opening ? source.borderColor : '',
        color: opening ? source.color : '',
        visibility: 'visible',
        pointerEvents: 'auto',
        opacity: '1',
        transform: 'translateZ(0)',
        filter: 'none',
    });
    if (opening) ghostAiMorphButton(button);
    void panel.offsetHeight;
    const finish = () => {
        if (panel._aiMorphMotionId !== motionId) return;
        window.clearTimeout(panel._aiPanelMotionTimer);
        panel.removeEventListener('transitionend', onEnd);
        panel._aiMorphTransitionEnd = null;
        if (opening) {
            Object.assign(panel.style, finalStyle);
            panel.style.transition = '';
            panel.style.boxShadow = '';
            panel.style.borderRadius = '';
            panel.style.background = '';
            panel.style.borderColor = '';
            panel.style.color = '';
            panel.style.transform = '';
            panel.style.filter = '';
            panel.classList.remove('ai-morphing', 'ai-morph-open', 'ai-morph-closing');
        } else {
            panel.style.transition = '';
            panel.style.boxShadow = '';
            panel.style.borderRadius = '';
            panel.style.background = '';
            panel.style.borderColor = '';
            panel.style.color = '';
            panel.style.transform = '';
            panel.style.filter = '';
            panel.classList.remove('ai-morphing', 'ai-morph-open', 'ai-morph-closing');
            restoreAiMorphButton(button);
        }
        if (onDone) onDone();
    };
    const onEnd = (ev) => {
        if (ev.target !== panel || ev.propertyName !== 'width') return;
        finish();
    };
    panel._aiMorphTransitionEnd = onEnd;
    panel.addEventListener('transitionend', onEnd);
    requestAnimationFrame(() => {
        if (panel._aiMorphMotionId !== motionId) return;
        panel.classList.toggle('ai-morph-open', opening);
        panel.classList.toggle('ai-morph-closing', !opening);
        panel.style.transition = `
            top ${dur} ${spring},
            left ${dur} ${spring},
            width ${dur} ${spring},
            height ${dur} ${spring},
            border-radius ${dur} ${spring},
            box-shadow ${opening ? '0.35s ease-out' : '0.18s ease-in'}
        `;
        Object.assign(panel.style, {
            left: finalLeft,
            top: finalTop,
            width: finalWidth,
            height: finalHeight,
            borderRadius: endRadius,
            boxShadow: opening ? 'var(--ai-morph-shadow-active)' : 'var(--ai-morph-shadow-idle)',
            background: opening ? '' : source.background,
            borderColor: opening ? '' : source.borderColor,
            color: opening ? '' : source.color,
        });
    });
    panel._aiPanelMotionTimer = window.setTimeout(finish, fallbackMs);
    return true;
}
function aiPanelParentRect(panel) {
    const viewport = window.visualViewport;
    const fallback = panel?.parentElement?.getBoundingClientRect?.() || { width: window.innerWidth, height: window.innerHeight };
    return {
        left: viewport?.offsetLeft || 0,
        top: viewport?.offsetTop || 0,
        width: viewport?.width || window.innerWidth || document.documentElement.clientWidth || fallback.width,
        height: viewport?.height || window.innerHeight || document.documentElement.clientHeight || fallback.height,
    };
}
function clampAiPanel(panel) {
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const parentRect = aiPanelParentRect(panel);
    const minVisible = window.innerWidth <= 760 ? 160 : 90;
    const left = Math.min(Math.max(rect.left - parentRect.left, -rect.width + minVisible), parentRect.width - minVisible);
    const top = Math.min(Math.max(rect.top - parentRect.top, 8), parentRect.height - minVisible);
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
}
function positionAiPanelLayoutMenu(menu, button, { collapsed = false } = {}) {
    if (!menu || !button) return;
    const rect = button.getBoundingClientRect();
    const viewport = window.visualViewport;
    const vvWidth = viewport?.width || window.innerWidth;
    const anchorX = rect.left + rect.width / 2;
    const finalWidth = Math.min(284, Math.max(160, vvWidth - 16));
    const finalHeight = 50;
    const finalLeft = anchorX - finalWidth / 2;
    menu.style.left = `${collapsed ? rect.left : finalLeft}px`;
    menu.style.top = `${rect.top}px`;
    menu.style.setProperty('--panel-island-menu-width', `${collapsed ? rect.width : finalWidth}px`);
    menu.style.setProperty('--panel-island-menu-height', `${collapsed ? rect.height : finalHeight}px`);
    menu.style.setProperty('--panel-island-radius', `${Math.round((collapsed ? rect.height : 36) / 2)}px`);
    menu.dataset.placement = 'inline';
}
function closeAiPanelLayoutMenu({ instant = false } = {}) {
    const menu = aiPanelLayoutMenu;
    const button = aiPanelLayoutMenuButton;
    if (!menu) { button?.classList.remove('active-layout'); aiPanelLayoutMenuButton = null; return; }
    window.clearTimeout(menu._closeTimer);
    if (instant || !button?.isConnected) {
        button?.classList.remove('active-layout');
        button?.style.removeProperty('opacity');
        menu.remove(); aiPanelLayoutMenu = null; aiPanelLayoutMenuButton = null; return;
    }
    menu.style.transition = 'none';
    positionAiPanelLayoutMenu(menu, button, { collapsed: false });
    menu.style.opacity = '1';
    void menu.offsetWidth;
    menu.classList.remove('island-open');
    menu.classList.add('island-closing', 'island-animating');
    button.classList.remove('active-layout');
    button.style.opacity = '0';
    requestAnimationFrame(() => { menu.style.removeProperty('transition'); positionAiPanelLayoutMenu(menu, button, { collapsed: true }); });
    menu._closeTimer = window.setTimeout(() => {
        button.classList.remove('active-layout');
        button.style.opacity = '1';
        requestAnimationFrame(() => button.style.removeProperty('opacity'));
        menu.remove(); if (aiPanelLayoutMenu === menu) aiPanelLayoutMenu = null; if (aiPanelLayoutMenuButton === button) aiPanelLayoutMenuButton = null;
    }, 460);
}
function openAiPanelLayoutMenu(button, panel) {
    closeAiPanelLayoutMenu({ instant: true });
    aiPanelLayoutMenuButton = button;
    button?.classList.remove('active-layout');
    const menu = document.createElement('div');
    menu.className = 'panel-layout-menu ai-layout-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'AI 浮窗布局');
    menu.innerHTML = `
        <button data-layout="full" title="全屏" aria-label="全屏"><span class="panel-layout-icon full"></span></button>
        <button data-layout="half" title="半屏" aria-label="半屏"><span class="panel-layout-icon half"></span></button>
        <button data-layout="left-quarter" title="左侧四分之一" aria-label="左侧四分之一"><span class="panel-layout-icon left"></span></button>
        <button data-layout="right-quarter" title="右侧四分之一" aria-label="右侧四分之一"><span class="panel-layout-icon right"></span></button>
        <button data-layout="close" class="panel-layout-close" title="关闭窗口" aria-label="关闭窗口"><span class="panel-layout-icon close"></span></button>
    `;
    menu.style.transition = 'none';
    document.body.appendChild(menu);
    const baseZ = Number(panel?.style?.zIndex || getComputedStyle(panel || document.body).zIndex || 10080) || 10080;
    menu.style.zIndex = String(baseZ + 200);
    aiPanelLayoutMenu = menu;
    positionAiPanelLayoutMenu(menu, button, { collapsed: true });
    button.style.opacity = '0';
    menu.style.opacity = '1';
    menu.classList.add('island-animating');
    void menu.offsetWidth;
    requestAnimationFrame(() => {
        menu.style.removeProperty('transition');
        menu.classList.add('island-open');
        positionAiPanelLayoutMenu(menu, button, { collapsed: false });
        window.setTimeout(() => { menu.classList.remove('island-animating'); menu.style.removeProperty('opacity'); }, 540);
    });
    menu.addEventListener('click', (ev) => {
        const item = ev.target.closest?.('[data-layout]');
        if (!item) return;
        if (item.dataset.layout === 'close') { closeAiAssistantPanel(); closeAiPanelLayoutMenu({ instant: true }); return; }
        applyAiPanelLayout(item.dataset.layout);
        closeAiPanelLayoutMenu();
    });
}
function aiProviderFieldWrap(id, labelText) {
    const el = document.getElementById(id);
    if (!el || el.closest('.form-group')) return;
    const label = Array.from($('#aiProviderForm')?.querySelectorAll(':scope > label') || []).find((x) => x.getAttribute('for') === id || x.nextElementSibling === el || x.textContent.trim() === labelText);
    const group = document.createElement('div');
    group.className = 'form-group';
    if (label) { label.remove(); group.appendChild(label); } else { const l = document.createElement('label'); l.textContent = labelText; group.appendChild(l); }
    el.parentNode.insertBefore(group, el);
    group.appendChild(el);
}
function normalizeAiProviderModalLayout() {
    const labels = {
        aiProviderBaseUrl: 'API Base URL',
        aiProviderApiKey: 'API Key',
        aiProviderApiMode: '接口模式',
        aiProviderModels: '模型列表',
        aiProviderDefaultModel: '默认模型',
        aiProviderModelUserAgents: '模型请求 User-Agent（可选，逐模型）',
        aiProviderOrganization: 'Organization / Project（可选）',
        aiProviderExtraHeaders: '额外请求头 JSON（可选）',
        aiProviderExtraJson: 'response_format / 其他参数 JSON',
    };
    Object.entries(labels).forEach(([id, label]) => aiProviderFieldWrap(id, label));
}
function setupAiPanelChrome() {
    const panel = $('#aiAgentPanel');
    const layoutBtn = panel?.querySelector('[data-ai-agent-layout]');
    panel?.addEventListener('pointerdown', bringAiPanelToFront);
    layoutBtn?.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        layoutBtn.classList.add('pressing');
        startAiPanelDrag(e, { allowButtons: true, suppressLayoutClick: true });
        const up = () => { layoutBtn.classList.remove('pressing'); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); };
        window.addEventListener('pointerup', up, { once: true });
        window.addEventListener('pointercancel', up, { once: true });
    });
    const startAiPanelDrag = (e, { allowButtons = false, suppressLayoutClick = false } = {}) => {
        if (e.button !== undefined && e.button !== 0) return;
        const interactive = e.target.closest?.('input,select,textarea,label,a');
        if (interactive) return;
        if (!allowButtons && e.target.closest?.('button')) return;
        bringAiPanelToFront();
        const startedOnTopGrip = !!e.target.closest?.('.panel-drag-handle');
        const dragThreshold = startedOnTopGrip ? 4 : (window.innerWidth <= 760 ? 12 : 6);
        const sx = e.clientX, sy = e.clientY, sl = panel.offsetLeft, st = panel.offsetTop;
        let dragging = false, raf = 0, lastX = sx, lastY = sy;
        const commit = () => {
            raf = 0;
            panel.style.left = `${sl + lastX - sx}px`;
            panel.style.top = `${st + lastY - sy}px`;
            panel.style.right = 'auto'; panel.style.bottom = 'auto';
            clampAiPanel(panel);
        };
        const move = (ev) => {
            lastX = ev.clientX; lastY = ev.clientY;
            const dist = Math.hypot(lastX - sx, lastY - sy);
            if (!dragging && dist > dragThreshold) {
                dragging = true;
                panel.classList.add('dragging');
                panel._suppressHeaderClick = true;
                if (suppressLayoutClick) { aiPanelSuppressLayoutClick = true; closeAiPanelLayoutMenu({ instant: true }); }
            }
            if (!dragging) return;
            ev.preventDefault();
            if (!raf) raf = requestAnimationFrame(commit);
        };
        const up = () => {
            const wasDragging = dragging;
            if (raf) cancelAnimationFrame(raf);
            if (dragging) commit();
            if (suppressLayoutClick && wasDragging) window.setTimeout(() => { aiPanelSuppressLayoutClick = false; }, 700);
            panel.classList.remove('dragging'); updateAiPanelResponsiveState();
            window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
        };
        window.addEventListener('pointermove', move, { passive: false });
        window.addEventListener('pointerup', up, { once: true });
        window.addEventListener('pointercancel', up, { once: true });
    };
    panel?.querySelector('.panel-drag-handle')?.addEventListener('pointerdown', (e) => startAiPanelDrag(e, { allowButtons: true }));
    panel?.querySelector('.panel-titlebar')?.addEventListener('pointerdown', (e) => startAiPanelDrag(e, { allowButtons: true }));
    panel?.querySelector('.panel-titlebar')?.addEventListener('click', (e) => {
        if (!panel._suppressHeaderClick) return;
        e.preventDefault();
        e.stopPropagation();
        panel._suppressHeaderClick = false;
        console.debug('[ai-panel]', 'header click suppressed after drag');
    }, true);
    panel?.querySelectorAll('[data-ai-agent-resize]').forEach((h) => h.addEventListener('pointerdown', (e) => {
        e.preventDefault(); bringAiPanelToFront(); panel.classList.add('resizing'); h.setPointerCapture?.(e.pointerId);
        const sx = e.clientX, sy = e.clientY, sw = panel.offsetWidth, sh = panel.offsetHeight, sl = panel.offsetLeft, edge = h.dataset.aiAgentResize;
        const parentRect = aiPanelParentRect(panel);
        const compact = window.innerWidth <= 760;
        const minWidth = compact ? 220 : 420, minHeight = compact ? 300 : 420;
        const move = (ev) => { ev.preventDefault(); let nw = sw + ev.clientX - sx, nl = sl; if (edge === 'left') { nw = sw - (ev.clientX - sx); nl = sl + (ev.clientX - sx); if (nw < minWidth) { nl -= minWidth - nw; nw = minWidth; } if (nl < 8) { nw += nl - 8; nl = 8; } panel.style.left = `${nl}px`; } const maxWidth = edge === 'left' ? sl + sw - 8 : parentRect.width - panel.offsetLeft - 12; const maxHeight = parentRect.height - panel.offsetTop - 12; panel.style.width = `${Math.min(Math.max(minWidth, nw), maxWidth)}px`; panel.style.height = `${Math.min(Math.max(minHeight, sh + ev.clientY - sy), maxHeight)}px`; updateAiPanelResponsiveState(); };
        const up = () => { panel.classList.remove('resizing'); updateAiPanelResponsiveState(); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
        window.addEventListener('pointermove', move, { passive: false }); window.addEventListener('pointerup', up, { once: true });
    }));
    if (panel) panel._layoutAnimationTimer = null;
    layoutBtn?.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (aiPanelSuppressLayoutClick) { aiPanelSuppressLayoutClick = false; return; }
        bringAiPanelToFront();
        if (navigator.vibrate) navigator.vibrate(8);
        if (aiPanelLayoutMenu && aiPanelLayoutMenuButton === layoutBtn) closeAiPanelLayoutMenu(); else openAiPanelLayoutMenu(layoutBtn, panel);
    });
    document.addEventListener('pointerdown', (e) => {
        if (aiPanelLayoutMenu && !e.target.closest?.('.panel-layout-menu') && !e.target.closest?.('[data-ai-agent-layout]')) closeAiPanelLayoutMenu();
    });
    window.addEventListener('resize', () => closeAiPanelLayoutMenu({ instant: true }));
}
function updateAiProviderModalHints() {
    const type = $('#aiProviderType')?.value || 'openai-compatible';
    const modeInput = $('#aiProviderApiMode');
    const modeBtn = $('#aiProviderApiModeBtn');
    let mode = modeInput?.value || 'auto';
    const isOpenAiLike = type === 'openai-compatible' || type === 'openai';
    if (modeBtn) {
        modeBtn.disabled = !isOpenAiLike;
        modeBtn.classList.toggle('is-disabled', !isOpenAiLike);
        modeBtn.setAttribute('aria-disabled', isOpenAiLike ? 'false' : 'true');
    }
    if (!isOpenAiLike && modeInput) {
        setAiFieldPickerValue('providerApiMode', 'auto');
        mode = 'auto';
    }
    const base = $('#aiProviderBaseUrl');
    const extra = $('#aiProviderExtraJson');
    if (base) {
        base.placeholder = mode === 'responses'
            ? 'https://api.openai.com/v1/responses'
            : type === 'gemini'
                ? 'https://generativelanguage.googleapis.com/v1beta'
                : type === 'anthropic'
                    ? 'https://api.anthropic.com/v1'
                    : 'https://api.openai.com/v1 / https://api.deepseek.com/v1';
    }
    if (extra) {
        extra.placeholder = type === 'anthropic'
            ? '{"thinking":{"type":"adaptive","display":"omitted"},"output_config":{"effort":"medium"}}'
            : type === 'gemini'
                ? '{"thinkingConfig":{"thinkingLevel":"low"}} 或 {"thinkingConfig":{"thinkingBudget":1024}}'
                : mode === 'responses'
                    ? '{"text":{"format":{"type":"json_object"}},"reasoning":{"effort":"medium"}}'
                    : '{"response_format":{"type":"json_object"}}';
    }
}
function setupAiAssistant() {
    normalizeAiProviderModalLayout();
    setupAiPanelChrome();
    $('#aiSettingsForm')?.addEventListener('submit', saveAiSettings);
    $('#aiAddProviderBtn')?.addEventListener('click', () => openAiProviderModal());
    $('#aiProviderForm')?.addEventListener('submit', saveAiProvider);
    $('#aiFetchModelsBtn')?.addEventListener('click', () => fetchAiModelsForProvider());
    document.addEventListener('click', (e) => {
        const fieldBtn = e.target.closest?.('[data-ai-field-picker]');
        if (!fieldBtn || fieldBtn.disabled || fieldBtn.getAttribute('aria-disabled') === 'true') return;
        e.preventDefault();
        e.stopPropagation();
        openAiFieldPicker(fieldBtn.dataset.aiFieldPicker, fieldBtn);
    });
    $('#aiProviderCloseBtn')?.addEventListener('click', closeAiProviderModal);
    $('#aiProviderCancelBtn')?.addEventListener('click', closeAiProviderModal);
    $('#aiProviderList')?.addEventListener('click', (e) => { const edit = e.target.dataset.aiEditProvider, del = e.target.dataset.aiDeleteProvider, fetchModels = e.target.dataset.aiFetchProviderModels, reveal = e.target.dataset.aiRevealProviderKey; const ai = normalizeAiSettings(settings.ai || {}); if (fetchModels) fetchAiModelsForProvider(fetchModels); if (reveal) revealAiProviderKey(reveal).catch((err) => toast(err.message || '读取 API Key 失败')); if (edit) openAiProviderModal(ai.providers.find((p) => p.id === edit)); if (del) deleteAiProvider(del); });
    $('#aiEnvForm')?.addEventListener('submit', saveAiEnv);
    $('#aiEnvResetBtn')?.addEventListener('click', resetAiEnvForm);
    $('#toggleAiEnvValue')?.addEventListener('click', () => { const el = $('#aiEnvValue'); el.type = el.type === 'password' ? 'text' : 'password'; $('#toggleAiEnvValue').textContent = el.type === 'password' ? '👁️' : '🙈'; });
    $('#aiEnvList')?.addEventListener('click', (e) => { const edit = e.target.dataset.aiEditEnv, del = e.target.dataset.aiDeleteEnv; const ai = normalizeAiSettings(settings.ai || {}); if (edit) { const item = ai.envVars.find((x) => x.id === edit); if (!item) return; $('#aiEnvId').value = item.id; $('#aiEnvName').value = item.name || ''; $('#aiEnvDescription').value = item.description || ''; $('#aiEnvValue').value = item.hasValue || item.value ? '******' : ''; $('#aiEnvEnabled').checked = item.enabled !== false; $('#aiEnvVisibleToAi').checked = item.visibleToAi === true; $('#aiEnvValueVisibleToAi').checked = item.valueVisibleToAi === true; } if (del) deleteAiEnv(del); });
    $('#aiMemoryForm')?.addEventListener('submit', saveAiMemory);
    $('#aiMemoryResetBtn')?.addEventListener('click', resetAiMemoryForm);
    $('#aiMemoryList')?.addEventListener('click', (e) => { const edit = e.target.dataset.aiEditMemory, del = e.target.dataset.aiDeleteMemory; const ai = normalizeAiSettings(settings.ai || {}); if (edit) { const item = ai.memories.find((x) => x.id === edit); if (!item) return; $('#aiMemoryId').value = item.id; $('#aiMemoryTitle').value = item.title || ''; $('#aiMemoryScope').value = item.scope || item.project || ''; $('#aiMemoryConnectionIds').value = (Array.isArray(item.connectionIds) ? item.connectionIds : splitCsv(item.connectionIds)).join(', '); $('#aiMemoryTags').value = (Array.isArray(item.tags) ? item.tags : splitCsv(item.tags)).join(', '); $('#aiMemoryContent').value = item.content || ''; $('#aiMemoryItemEnabled').checked = item.enabled !== false; } if (del) deleteAiMemory(del); });
    $('#aiPlanList')?.addEventListener('click', (e) => {
        const pause = e.target.dataset.aiPlanPause, resume = e.target.dataset.aiPlanResume, retry = e.target.dataset.aiPlanRetry, delPlan = e.target.dataset.aiPlanDelete, stepPlan = e.target.dataset.aiPlanStep;
        if (pause) updateAiPlan(pause, { pause: true, note: '用户在设置页暂停计划' });
        if (resume) updateAiPlan(resume, { resume: true, note: '用户在设置页继续计划' });
        if (retry) updateAiPlan(retry, { retryFailed: true, note: '用户在设置页重试失败步骤' });
        if (delPlan) deleteAiPlan(delPlan);
        if (stepPlan) updateAiPlan(stepPlan, { steps: [{ index: Number(e.target.dataset.stepIndex), status: e.target.dataset.stepStatus }] });
    });
    $('#aiSkillForm')?.addEventListener('submit', saveAiSkill);
    $('#aiMcpForm')?.addEventListener('submit', saveAiMcpFromForm);
    $('#aiMcpResetBtn')?.addEventListener('click', resetAiMcpForm);
    bindAiSegmentControls(document);
    document.addEventListener('click', (e) => {
        const segBtn = e.target.closest?.('.ai-segment-btn');
        if (!segBtn) return;
        const root = segBtn.closest?.('.ai-segment');
        if (!root) return;
        e.preventDefault();
        setAiSegmentValue(root, segBtn.dataset.value);
    });
    $('#aiMcpList')?.addEventListener('click', (e) => {
        const edit = e.target.closest?.('[data-ai-mcp-edit]')?.dataset.aiMcpEdit;
        const del = e.target.closest?.('[data-ai-mcp-del]')?.dataset.aiMcpDel;
        const ai = normalizeAiSettings(settings.ai || {});
        if (edit) fillAiMcpForm((ai.mcpServers || []).find((x) => x.id === edit));
        if (del) {
            // craft confirm card instead of window.confirm
            openAiInlineConfirm({
                title: '删除 MCP 服务器',
                body: '删除后需重新配置才能连接该 MCP。',
                confirmLabel: '删除',
                danger: true,
                onConfirm: () => deleteAiMcp(del).catch((err) => toast(err.message)),
            });
        }
    });
    $('#aiSkillResetBtn')?.addEventListener('click', resetAiSkillForm);
    $('#aiSkillList')?.addEventListener('click', (e) => { const edit = e.target.dataset.aiEditSkill, del = e.target.dataset.aiDeleteSkill; const ai = normalizeAiSettings(settings.ai || {}); if (edit) { const s = ai.skills.find((x) => x.id === edit); if (!s) return; $('#aiSkillId').value = s.id; $('#aiSkillName').value = s.name || ''; $('#aiSkillDescription').value = s.description || ''; $('#aiSkillPrompt').value = s.prompt || ''; $('#aiSkillEnabled').checked = s.enabled !== false; } if (del) deleteAiSkill(del); });
    $('#openAiAssistantBtn')?.addEventListener('click', (e) => openAiAssistantPanel(e.currentTarget)); $('#openAiAssistantBtn2')?.addEventListener('click', (e) => openAiAssistantPanel(e.currentTarget));
    $('#aiNavTab')?.addEventListener('click', (e) => { e.preventDefault(); openAiAssistantPanel(e.currentTarget); });
    $('#aiFloatingBtn')?.addEventListener('click', (e) => toggleAiAssistantPanel(e.currentTarget));
    $('#aiJumpSettingsBtn')?.addEventListener('click', () => { switchView('settings'); document.querySelector('.settings-tab[data-settings="ai"]')?.click(); });
    $('#aiClosePanelBtn')?.addEventListener('click', closeAiAssistantPanel); $('#aiNewChatBtn')?.addEventListener('click', () => createAiChat());
    $('#aiChatList')?.addEventListener('click', (e) => { const del = e.target.closest?.('[data-ai-delete-chat]')?.dataset.aiDeleteChat; if (del) { e.preventDefault(); e.stopPropagation(); deleteAiChat(del); return; } const id = e.target.closest?.('[data-ai-chat]')?.dataset.aiChat || e.target.closest?.('[data-ai-chat-row]')?.dataset.aiChatRow; if (id) { aiCurrentSessionId = id; aiEditingMessageIndex = -1; aiEditingSessionId = ''; saveAiChats(); renderAiChat(); } });
    $('#aiSendBtn')?.addEventListener('click', () => { if (aiIsSessionRunning(aiCurrentSessionId)) stopAiResponse(aiCurrentSessionId); else sendAiMessage(); });
    $('#aiUserInput')?.addEventListener('input', (e) => { autoResizeAiInput(e.target); updateAiInputPreview(); });
    $('#aiUserInput')?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendAiMessage(); } });
    // Markdown preview toggle removed; messages are rendered as Markdown directly.
    $('#aiClearChatBtn')?.addEventListener('click', () => { const s = aiCurrentSession(); if (aiIsSessionRunning(s?.id)) return toast('请先停止当前对话的 AI 回复'); s.messages = []; renderAiChat(); });
    $('#aiCompressChatBtn')?.addEventListener('click', () => { const s = aiCurrentSession(); if (aiIsSessionRunning(s?.id)) return toast('请先停止当前对话的 AI 回复'); if (s.messages.length > 2) s.messages = [{ role: 'system', content: `历史已压缩：此前共有 ${s.messages.length} 条消息。` }, s.messages[s.messages.length - 1]]; renderAiChat(); });
    $('#aiProviderPickerBtn')?.addEventListener('click', (e) => openAiPicker('provider', e.currentTarget));
    $('#aiModelPickerBtn')?.addEventListener('click', (e) => openAiPicker('model', e.currentTarget));
    $('#aiThinkPickerBtn')?.addEventListener('click', (e) => openAiPicker('thinking', e.currentTarget));
    $('#aiUsageBtn')?.addEventListener('click', (e) => { e.stopPropagation(); openAiUsageSheet(null, e.currentTarget); });
    document.addEventListener('click', (e) => {
        const option = e.target.closest?.('.ai-picker-option');
        if (option) {
            if (option.dataset.fieldKind) {
                setAiFieldPickerValue(option.dataset.fieldKind, option.dataset.value || '');
                closeAiPickerPopover();
            } else {
                applyAiPickerChoice(option.dataset.kind, option.dataset.value || '');
            }
            return;
        }
        if (!e.target.closest?.('.ai-picker-popover,.ai-picker-btn,[data-ai-field-picker]')) closeAiPickerPopover();
        if (!e.target.closest?.('.ai-usage-popover,#aiUsageBtn')) document.querySelector('.ai-usage-popover')?.remove();
    }, true);
    $('#aiBrowserPreviewToggleBtn')?.addEventListener('click', () => { const state = aiBrowserPreviewStateForSession(aiCurrentSessionId); state.visible = !state.visible; renderAiBrowserPreview(); });
    $('#aiBrowserPreviewRefreshBtn')?.addEventListener('click', refreshAiBrowserPreview);
    $('#aiRefreshStatusBtn')?.addEventListener('click', async () => { const r = await api('/api/ai/status'); settings.ai = normalizeAiSettings(r.ai || {}); renderAiSettingsForm(); toast('AI 配置已刷新'); });
    $('#aiChatArea')?.addEventListener('click', handleAiChatAreaClick);
    $('#aiChatArea')?.addEventListener('contextmenu', handleAiMessageContextMenu);
    $('#aiChatArea')?.addEventListener('touchstart', handleAiMessageTouchStart, { passive: true });
    $('#aiChatArea')?.addEventListener('touchend', clearAiMessageTouchTimer);
    $('#aiChatArea')?.addEventListener('touchcancel', clearAiMessageTouchTimer);
    const handleAiMessageMenuClick = (e) => {
        const menu = $('#aiMessageContextMenu');
        if (!menu || menu.classList.contains('hidden')) return;
        const action = e.target.closest?.('[data-ai-msg-action]')?.dataset.aiMsgAction;
        if (action) { handleAiMessageMenuAction(action); return; }
        if (!menu.contains(e.target)) hideAiMessageMenu();
    };
    const handleAiMessageMenuPointerDown = (e) => {
        const menu = $('#aiMessageContextMenu');
        if (!menu || menu.classList.contains('hidden')) return;
        if (!menu.contains(e.target)) hideAiMessageMenu();
    };
    document.addEventListener('pointerdown', handleAiMessageMenuPointerDown, { capture: true });
    document.addEventListener('click', handleAiMessageMenuClick, { capture: true });
    document.addEventListener('contextmenu', (e) => {
        const menu = $('#aiMessageContextMenu');
        if (!menu || menu.classList.contains('hidden')) return;
        if (!menu.contains(e.target) && !e.target.closest?.('.ai-message')) hideAiMessageMenu();
    }, { capture: true });
    $('#aiUploadBtn')?.addEventListener('click', () => $('#aiFileUpload').click());
    $('#aiFileUpload')?.addEventListener('change', (e) => { const files = Array.from(e.target.files || []); if (!files.length) return; appendAiFiles(files).catch((err) => toast(err.message || '附件读取失败')).finally(() => { e.target.value = ''; }); });
    $('#aiInputPreview')?.addEventListener('click', (e) => { const btn = e.target.closest?.('[data-ai-remove-attachment]'); if (!btn) return; aiPendingInputAttachments.splice(Number(btn.dataset.aiRemoveAttachment || -1), 1); updateAiAttachmentDraftUi(); });
    window.addEventListener('resize', () => { updateAiPanelResponsiveState(); if (aiPanelState === 'open') startAiPanelWatchdog(); });
    window.visualViewport?.addEventListener('resize', () => { updateAiPanelResponsiveState(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && aiPanelState === 'open') startAiPanelWatchdog(); });
}

function renderRemoteServers() { const ssh = connections.filter((c) => c.protocol === 'SSH'); $('#remoteServerList').innerHTML = ssh.length ? ssh.map((c) => `<label class="server-check"><input type="checkbox" value="${c.id}"> <span>${escapeHtml(c.name)}</span><em>${escapeHtml(c.host)}</em></label>`).join('') : '<div class="empty-card">暂无 SSH 连接</div>'; }
async function remoteExecute(e) { e.preventDefault(); const ids = $$('#remoteServerList input:checked').map((i) => i.value); try { $('#remoteResults').innerHTML = '<div class="empty-card">执行中...</div>'; const data = await api('/api/remote-execute', { method: 'POST', body: JSON.stringify({ connectionIds: ids, command: $('#remoteCommand').value, timeoutSeconds: Number($('#remoteTimeout').value) || 30 }) }); $('#remoteResults').innerHTML = data.results.map((r) => `<article class="result-card ${r.success ? 'ok' : 'fail'}"><h3>${escapeHtml(r.name)} <span>${escapeHtml(r.status)} · ${r.durationMs}ms</span></h3>${r.error ? `<p class="error-text">${escapeHtml(r.error)}</p>` : ''}<pre>${escapeHtml(r.stdout || '')}</pre>${r.stderr ? `<pre class="stderr">${escapeHtml(r.stderr)}</pre>` : ''}</article>`).join(''); await loadConnections(); } catch (err) { toast(err.message); } }

async function loadSettings() {
    settings = await api('/api/settings').catch(() => ({}));
    const personal = await api('/api/me/settings').catch(() => null);
    if (personal?.settings?.notes) settings.notes = { ...(settings.notes || {}), ...personal.settings.notes };
    const aiProvidersData = await api('/api/ai/providers').catch(() => null);
    if (aiProvidersData?.providers) {
        settings.ai = { ...(settings.ai || {}), providers: aiProvidersData.providers };
    }
    const sec = settings.security || {}, cap = settings.captcha || {}, mail = settings.mail || {}, beian = settings.beian || {};
    $('#versionText').textContent = settings.version || '--'; $('#icpInput').value = beian.icp ?? settings.icp ?? ''; $('#icpUrlInput').value = beian.icpUrl ?? settings.icpUrl ?? ''; $('#policeInput').value = beian.policeBeian ?? settings.policeBeian ?? ''; $('#policeUrlInput').value = beian.policeBeianUrl ?? settings.policeBeianUrl ?? ''; $('#showBeianInput').checked = (beian.show ?? settings.showBeian) !== false;
    $('#ipWhitelistEnabled').checked = !!sec.ipWhitelistEnabled; $('#ipWhitelist').value = sec.ipWhitelist || ''; $('#bruteForceEnabled').checked = sec.bruteForceEnabled !== false; $('#bruteForceMaxFailures').value = sec.bruteForceMaxFailures || 5; $('#bruteForceBanMinutes').value = sec.bruteForceBanMinutes || 15;
    $('#captchaEnabled').checked = !!cap.enabled; $('#captchaProvider').value = cap.provider || 'turnstile'; $('#captchaSiteKey').value = cap.siteKey || cap.tencentCaptchaAppId || cap.aliyunCaptchaId || cap.aliyunSceneId || ''; $('#captchaSecretKey').value = cap.secretKey || cap.tencentAppSecretKey || cap.aliyunAccessKeySecret || '';
    $('#mailEnabled').checked = !!mail.enabled; $('#mailHost').value = mail.host || ''; $('#mailPort').value = mail.port || 465; $('#mailSecure').checked = mail.secure !== false; $('#mailUser').value = mail.user || ''; $('#mailPass').value = mail.pass || ''; $('#mailFrom').value = mail.from || ''; $('#mailAdminEmail').value = mail.adminEmail || ''; $('#notifyLoginSuccess').checked = mail.notifyLoginSuccess !== false; $('#notifyLoginFailure').checked = mail.notifyLoginFailure !== false; $('#geoLookupEnabled').checked = mail.geoLookupEnabled !== false;
    $('#terminalMaxWindows').value = String(getConfiguredTerminalMaxWindows());
    $('#terminalMinimizedKeepAlive').value = String(getConfiguredMinimizedKeepAlive());
    $('#terminalSmartbarOrder').value = getTerminalSmartbarOrder();
    $('#terminalShortcutPlatform').value = getTerminalShortcutPlatform();
    settings.appearance = { brandName: DEFAULT_BRAND_NAME, brandIcon: DEFAULT_BRAND_ICON, theme: 'auto', autoThemeEnabled: true, colorScheme: 'frost', customThemeMode: 'dark', customColors: normalizeCustomThemeColors(), customCss: '', customJs: '', terminalBackground: { type: 'none', url: '', fit: 'cover', opacity: 0.35, blur: 0 }, terminalFontColor: '', terminalFontColors: { dark: '', light: '' }, ...(settings.appearance || {}) };
    settings.ai = normalizeAiSettings(settings.ai || {});
    applyAppearance(settings.appearance);
    applyTheme(getPreferredTheme());
    renderAiSettingsForm();
    renderNotesToggle();
    await loadSecurityStatus(); await loadSecurityLists();
}

function isNotesEnabled() {
    return !!(settings.notes && settings.notes.enabled);
}

function broadcastNotesEnabled(enabled = isNotesEnabled()) {
    $$('#terminalWorkspace iframe.terminal-frame').forEach((frame) => {
        try {
            frame.contentWindow?.postMessage({
                source: 'zephyr-app',
                type: 'notes-enabled',
                enabled: !!enabled,
            }, '*');
        } catch (_) {}
    });
}

function renderNotesToggle() {
    // Notes is opt-in (FREEZE plan §6.1): the nav tab only appears when an
    // admin (or the user override) enables it. Default off.
    const notesEnabled = isNotesEnabled();
    const navTab = document.getElementById('notesNavTab');
    if (navTab) navTab.classList.toggle('force-hidden', !notesEnabled);
    const settingsCheckbox = document.getElementById('notesEnabledInput');
    if (settingsCheckbox) settingsCheckbox.checked = notesEnabled;
    if (!notesEnabled && document.querySelector('.nav-tab.active')?.dataset.view === 'notes') {
        switchView('dashboard');
    }
    broadcastNotesEnabled(notesEnabled);
}

async function saveNotesSettings(e) {
    e.preventDefault();
    const enabled = document.getElementById('notesEnabledInput')?.checked || false;
    const result = await api('/api/me/settings', { method: 'PUT', body: JSON.stringify({ 'notes.enabled': enabled }) });
    settings.notes = { ...(settings.notes || {}), enabled: !!result?.settings?.notes?.enabled };
    renderNotesToggle();
    toast(enabled ? '已为当前用户开启笔记功能' : '已为当前用户关闭笔记功能');
}
async function saveBeian(e) { e.preventDefault(); settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ beian: { icp: $('#icpInput').value, icpUrl: $('#icpUrlInput').value, policeBeian: $('#policeInput').value, policeBeianUrl: $('#policeUrlInput').value, show: $('#showBeianInput').checked } }) }); toast('备案信息已保存'); }
async function loadSecurityStatus() { securityStatus = await api('/api/security/status').catch(() => ({ user: {}, passkeys: [] })); $('#profileUsername').value = securityStatus.user.username || ''; $('#profileEmail').value = securityStatus.user.email || ''; renderTotp(); renderPasskeys(); }
async function loadSecurityLists() { ipBans = (await api('/api/security/ip-bans').catch(() => ({ bans: [] }))).bans || []; loginEvents = (await api('/api/security/login-events').catch(() => ({ events: [] }))).events || []; renderSecurityLists(); }
function renderTotp() { $('#totpBox').innerHTML = `<div class="mini-item"><b>TOTP 状态</b><span>${securityStatus.user.totpEnabled ? '已开启' : '未开启'}</span><button id="setupTotpBtn">${securityStatus.user.totpEnabled ? '重新绑定' : '开启 TOTP'}</button></div>`; $('#totpDisableForm').classList.toggle('force-hidden', !securityStatus.user.totpEnabled); }
function renderPasskeys() { $('#passkeyList').innerHTML = (securityStatus.passkeys || []).map((p) => `<div class="mini-item"><b>Passkey</b><span>${fmtTime(p.createdAt)}</span><button data-del-passkey="${p.id}">删除</button></div>`).join('') || '<p class="muted">暂无 Passkey</p>'; }
function renderSecurityLists() { $('#ipBanList').innerHTML = ipBans.map((b) => `<div class="mini-item"><b>${escapeHtml(b.ip)}</b><span>失败 ${b.failedCount} · 解封 ${fmtTime(b.bannedUntil)}</span><button data-unban="${escapeHtml(b.ip)}">解除</button></div>`).join('') || '<p class="muted">暂无封禁 IP</p>'; $('#loginEventList').innerHTML = loginEvents.slice(0, 20).map((e) => `<div class="mini-item"><b>${e.success ? '成功' : '失败'} · ${escapeHtml(e.username || '-')}</b><span>${escapeHtml(e.ip || '')} · ${escapeHtml(e.reason || '')} · ${fmtTime(e.time)}</span></div>`).join('') || '<p class="muted">暂无登录事件</p>'; }
async function saveSecurityPolicy(e) { e.preventDefault(); settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ security: { ipWhitelistEnabled: $('#ipWhitelistEnabled').checked, ipWhitelist: $('#ipWhitelist').value, bruteForceEnabled: $('#bruteForceEnabled').checked, bruteForceMaxFailures: Number($('#bruteForceMaxFailures').value) || 5, bruteForceBanMinutes: Number($('#bruteForceBanMinutes').value) || 15 } }) }); toast('安全策略已保存'); }
async function saveCaptcha(e) {
    e.preventDefault();
    const provider = $('#captchaProvider').value;
    const siteKey = $('#captchaSiteKey').value.trim();
    const secretKey = $('#captchaSecretKey').value.trim();
    const captcha = {
        enabled: $('#captchaEnabled').checked,
        provider,
        siteKey,
        secretKey,
        tencentCaptchaAppId: provider === 'tencent' ? siteKey : '',
        tencentAppSecretKey: provider === 'tencent' ? secretKey : '',
        aliyunCaptchaId: provider === 'aliyun' ? siteKey : '',
        aliyunSceneId: provider === 'aliyun' ? siteKey : '',
        aliyunAccessKeySecret: provider === 'aliyun' ? secretKey : ''
    };
    console.debug('[captcha-client]', 'save captcha settings', { provider, enabled: captcha.enabled, hasSiteKey: !!siteKey, hasSecretKey: !!secretKey });
    settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ captcha }) });
    toast('CAPTCHA 已保存');
}
async function revealCaptchaSecret() {
    const secret = requestSensitiveSecret('查看已保存 CAPTCHA 密钥');
    const data = await api('/api/settings/captcha/open', { method: 'POST', body: JSON.stringify({ secret }) });
    $('#captchaSecretKey').value = data.secretKey || '';
    $('#captchaSecretKey').type = 'text';
    $('#toggleCaptchaSecret').textContent = '🙈';
    console.debug('[captcha-client]', 'captcha secret loaded', { provider: data.provider, hasSecretKey: !!data.hasSecretKey });
    toast(data.hasSecretKey ? '已载入保存的 CAPTCHA 密钥' : '当前未保存 CAPTCHA 密钥');
}
async function saveMail(e) {
    e.preventDefault();
    try {
        settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ mail: { enabled: $('#mailEnabled').checked, host: $('#mailHost').value.trim(), port: Number($('#mailPort').value) || 465, secure: $('#mailSecure').checked, user: $('#mailUser').value.trim(), pass: $('#mailPass').value, from: $('#mailFrom').value.trim(), adminEmail: $('#mailAdminEmail').value.trim(), notifyLoginSuccess: $('#notifyLoginSuccess').checked, notifyLoginFailure: $('#notifyLoginFailure').checked, geoLookupEnabled: $('#geoLookupEnabled').checked } }) });
        $('#mailPass').type = 'password';
        $('#toggleMailPassword').textContent = '👁️';
        toast('邮件设置已保存');
    } catch (err) {
        toast(err.message || '邮件设置保存失败');
    }
}
async function revealMailPass() {
    const secret = requestSensitiveSecret('查看已保存 SMTP 密码');
    const data = await api('/api/settings/mail/open', { method: 'POST', body: JSON.stringify({ secret }) });
    $('#mailPass').value = data.pass || '';
    $('#mailPass').type = 'text';
    $('#toggleMailPassword').textContent = '🙈';
    console.debug('[secret-open]', 'mail password loaded', { hasPass: !!data.hasPass });
    toast(data.hasPass ? '已载入保存的 SMTP 密码' : '当前未保存 SMTP 密码');
}
async function testMail() {
    const btn = $('#testMailBtn');
    const oldText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '发送中...';
    try {
        const result = await api('/api/settings/test-mail', { method: 'POST', body: JSON.stringify({ to: $('#mailAdminEmail').value.trim() }) });
        toast(result.message || '测试邮件已发送');
    } catch (err) {
        toast(err.message || '测试邮件发送失败');
    } finally {
        btn.disabled = false;
        btn.textContent = oldText;
    }
}
async function saveTerminalLayout(e) {
    e.preventDefault();
    const maxWindows = Math.min(3, Math.max(1, Number($('#terminalMaxWindows').value) || 3));
    const rawKeepAlive = Number($('#terminalMinimizedKeepAlive').value);
    const minimizedKeepAlive = rawKeepAlive === -1 ? -1 : Math.max(0, Math.floor(Number.isFinite(rawKeepAlive) ? rawKeepAlive : 0));
    const smartbarOrder = $('#terminalSmartbarOrder').value === 'new-first' ? 'new-first' : 'old-first';
    const shortcutPlatformRaw = $('#terminalShortcutPlatform').value;
    const shortcutPlatform = ['auto', 'windows', 'mac'].includes(shortcutPlatformRaw) ? shortcutPlatformRaw : 'auto';
    localStorage.setItem('zephyr-terminal-max-windows', String(maxWindows));
    localStorage.setItem('zephyr-terminal-minimized-keepalive', String(minimizedKeepAlive));
    localStorage.setItem('zephyr-terminal-smartbar-order', smartbarOrder);
    localStorage.setItem('zephyr-shortcut-platform', shortcutPlatform);
    settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ terminal: { ...(settings.terminal || {}), maxWindows, minimizedKeepAlive, smartbarOrder, shortcutPlatform } }) });
    enforceTerminalWorkspaceLimit(activeTerminalTab);
    renderTerminalTabs();
    const keepAliveText = minimizedKeepAlive === -1 ? '最小化无限保活' : `最小化保活 ${minimizedKeepAlive} 个`;
    toast(`终端布局已保存：最多 ${maxWindows} 窗，${keepAliveText}`);
}

const SNIPPET_STORAGE_KEY = 'zephyr-ssh-snippets';
function normalizeSnippets(list) {
    return Array.isArray(list) ? list.filter((item) => item && item.command).map((item) => ({
        id: String(item.id || `snippet-${Date.now()}-${Math.random().toString(16).slice(2)}`),
        name: String(item.name || '').slice(0, 60),
        command: String(item.command || ''),
        group: String(item.group || '').slice(0, 40),
        autoRun: !!item.autoRun,
        updatedAt: Number(item.updatedAt || Date.now()),
    })) : [];
}
function getSnippets() {
    return normalizeSnippets(settings?.snippets || []);
}
async function persistSnippets(list) {
    const snippets = normalizeSnippets(list);
    settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ snippets }) });
    settings.snippets = normalizeSnippets(settings.snippets || snippets);
    return settings.snippets;
}
async function migrateLocalSnippetsToServer() {
    if (getSnippets().length) return;
    try {
        const local = normalizeSnippets(JSON.parse(localStorage.getItem(SNIPPET_STORAGE_KEY) || '[]'));
        if (!local.length) return;
        await persistSnippets(local);
        localStorage.removeItem(SNIPPET_STORAGE_KEY);
        toast('已将本地代码片段迁移到服务端');
    } catch (_) {}
}
function resetSnippetForm() {
    $('#snippetId').value = '';
    $('#snippetName').value = '';
    $('#snippetCommand').value = '';
    $('#snippetGroup').value = '';
    $('#snippetAutoRun').checked = false;
}
function renderSnippetSettings() {
    const list = $('#snippetSettingsList');
    if (!list) return;
    const snippets = getSnippets();
    list.innerHTML = snippets.length ? snippets.map((item) => `<div class="snippet-settings-item" data-id="${escapeHtml(item.id)}"><div><strong>${escapeHtml(item.name || '未命名片段')}</strong><em>${escapeHtml(item.group || '未分组')} · ${item.autoRun ? '直接执行' : '填入输入框'}</em><code>${escapeHtml(item.command || '')}</code></div><button class="tool-btn" data-edit-snippet="${escapeHtml(item.id)}">编辑</button><button class="tool-btn danger" data-delete-snippet="${escapeHtml(item.id)}">删除</button></div>`).join('') : '<p class="empty-state">暂无代码片段。</p>';
}
async function saveSnippet(e) {
    e.preventDefault();
    const name = $('#snippetName').value.trim();
    const command = $('#snippetCommand').value;
    if (!name || !command.trim()) return toast('请填写片段名称和命令');
    const id = $('#snippetId').value || `snippet-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const item = { id, name, command, group: $('#snippetGroup').value.trim(), autoRun: $('#snippetAutoRun').checked, updatedAt: Date.now() };
    const snippets = getSnippets();
    const idx = snippets.findIndex((x) => x.id === id);
    if (idx >= 0) snippets[idx] = item; else snippets.unshift(item);
    await persistSnippets(snippets);
    resetSnippetForm();
    renderSnippetSettings();
    toast('代码片段已保存到服务端');
}
function setupSnippetSettings() {
    $('#snippetForm')?.addEventListener('submit', saveSnippet);
    $('#cancelSnippetEditBtn')?.addEventListener('click', resetSnippetForm);
    $('#snippetSettingsList')?.addEventListener('click', (e) => {
        const editId = e.target.closest?.('[data-edit-snippet]')?.dataset.editSnippet;
        const deleteId = e.target.closest?.('[data-delete-snippet]')?.dataset.deleteSnippet;
        const snippets = getSnippets();
        if (editId) {
            const item = snippets.find((x) => x.id === editId); if (!item) return;
            $('#snippetId').value = item.id; $('#snippetName').value = item.name || ''; $('#snippetCommand').value = item.command || ''; $('#snippetGroup').value = item.group || ''; $('#snippetAutoRun').checked = !!item.autoRun;
        }
        if (deleteId) {
            persistSnippets(snippets.filter((x) => x.id !== deleteId)).then(() => {
                renderSnippetSettings();
                toast('代码片段已从服务端删除');
            }).catch((err) => toast(err.message || '删除失败'));
        }
    });
    renderSnippetSettings();
}
async function setupTotp() { const r = await api('/api/security/totp/setup', { method: 'POST', body: '{}' }); $('#totpEnableForm').classList.remove('force-hidden'); $('#totpQrBox').innerHTML = `<img class="qr-img" src="${r.qr}"><p class="muted">密钥：${escapeHtml(r.secret)}</p>`; }
async function registerPasskey() { try { if (!window.PublicKeyCredential) return toast('当前浏览器不支持 Passkey'); const options = await api('/api/passkeys/register/options', { method: 'POST', body: '{}' }); options.challenge = base64urlToBuffer(options.challenge); options.user.id = base64urlToBuffer(options.user.id); (options.excludeCredentials || []).forEach((c) => { c.id = base64urlToBuffer(c.id); }); const cred = await navigator.credentials.create({ publicKey: options }); if (!cred) return toast('Passkey 创建被取消'); const payload = { id: cred.id, rawId: bufferToBase64url(cred.rawId), type: cred.type, response: { clientDataJSON: bufferToBase64url(cred.response.clientDataJSON), attestationObject: bufferToBase64url(cred.response.attestationObject), transports: cred.response.getTransports ? cred.response.getTransports() : [] } }; await api('/api/passkeys/register/verify', { method: 'POST', body: JSON.stringify(payload) }); toast('Passkey 已绑定'); await loadSecurityStatus(); } catch (err) { toast('Passkey 注册失败：' + err.message); } }
async function loadNetwork() {
    const [proxyData, keyData] = await Promise.all([
        api('/api/proxies'),
        api('/api/ssh-keys').catch(() => ({ sshKeys: [] }))
    ]);
    proxies = proxyData.proxies || [];
    sshKeys = keyData.sshKeys || [];
    renderNetwork();
    updateRouteOptions();
    renderSshKeyOptions($('#connSshKey')?.value || '');
}
function renderNetwork() {
    $('#proxyList').innerHTML = proxies.map((p) => `<div class="mini-item"><b>${escapeHtml(p.name)}</b><span>${escapeHtml((p.type || 'socks5').toUpperCase())} · ${escapeHtml(p.host)}:${p.port}</span><button data-edit-proxy="${p.id}">编辑</button><button data-open-proxy="${p.id}">查看</button><button data-del-proxy="${p.id}">删除</button></div>`).join('') || '<p class="muted">暂无代理</p>';
    $('#sshKeyList').innerHTML = sshKeys.map((k) => `<div class="mini-item"><b>${escapeHtml(k.name)}</b><span>${k.hasPrivateKey ? '已保存私钥' : '无私钥'}${k.hasPassphrase ? ' · 有口令' : ''}${k.remark ? ` · ${escapeHtml(k.remark)}` : ''}</span><button data-edit-ssh-key="${k.id}">编辑</button><button data-open-ssh-key="${k.id}">查看</button><button data-del-ssh-key="${k.id}">删除</button></div>`).join('') || '<p class="muted">暂无 SSH 密钥</p>';
}
function renderJumpOptions() { if ($('#jumpRouteConfig') && $('#connMode')?.value === 'jump') updateRouteOptions('jump', $$('#jumpRouteList [data-jump-route-select]').map((el) => el.value).filter(Boolean)); }
async function saveProxy(e) { e.preventDefault(); const id = $('#proxyId').value, payload = { name: $('#proxyName').value, type: $('#proxyType').value, host: $('#proxyHost').value, port: Number($('#proxyPort').value), username: $('#proxyUsername').value, password: $('#proxyPassword').value }; console.debug('[route-ui]', 'save proxy payload', { id, ...payload, password: payload.password ? '******' : '' }); await api(id ? `/api/proxies/${id}` : '/api/proxies', { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) }); e.target.reset(); $('#proxyId').value = ''; $('#proxyType').value = 'socks5'; await loadNetwork(); toast('代理已保存'); }
async function openProxySecret(id) {
    const secret = requestSensitiveSecret('查看已保存代理密码');
    const data = await api(`/api/proxies/${id}/open`, { method: 'POST', body: JSON.stringify({ secret }) });
    const p = data.proxy || {};
    $('#proxyId').value = p.id || '';
    $('#proxyName').value = p.name || '';
    $('#proxyType').value = p.type || 'socks5';
    $('#proxyHost').value = p.host || '';
    $('#proxyPort').value = p.port || '';
    $('#proxyUsername').value = p.username || '';
    $('#proxyPassword').value = p.password || '';
    console.debug('[proxy-ui]', 'proxy secret loaded', { id, hasPassword: !!p.password });
    toast('已载入代理密码');
}
function resetSshKeyForm() { $('#sshKeyForm').reset(); $('#sshKeyId').value = ''; $('#sshKeyPrivateKey').value = ''; $('#sshKeyPassphrase').value = ''; }
async function saveSshKey(e) {
    e.preventDefault();
    const id = $('#sshKeyId').value;
    const payload = { name: $('#sshKeyName').value.trim(), privateKey: $('#sshKeyPrivateKey').value, passphrase: $('#sshKeyPassphrase').value, remark: $('#sshKeyRemark').value.trim() };
    console.debug('[ssh-key-ui]', 'save ssh key payload', { id, name: payload.name, hasPrivateKey: !!payload.privateKey && payload.privateKey !== '******', hasPassphrase: !!payload.passphrase && payload.passphrase !== '******' });
    await api(id ? `/api/ssh-keys/${id}` : '/api/ssh-keys', { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
    resetSshKeyForm();
    await loadNetwork();
    toast('SSH 密钥已保存');
}
async function openSshKeySecret(id) {
    const secret = requestSensitiveSecret('查看已保存 SSH 密钥');
    const data = await api(`/api/ssh-keys/${id}/open`, { method: 'POST', body: JSON.stringify({ secret }) });
    const k = data.sshKey || {};
    $('#sshKeyId').value = k.id || '';
    $('#sshKeyName').value = k.name || '';
    $('#sshKeyPrivateKey').value = k.privateKey || '';
    $('#sshKeyPassphrase').value = k.passphrase || '';
    $('#sshKeyRemark').value = k.remark || '';
    console.debug('[ssh-key-ui]', 'ssh key secret loaded', { id, hasPrivateKey: !!k.privateKey, hasPassphrase: !!k.passphrase });
    toast('已载入 SSH 密钥内容');
}

function bindConnectionPressFeedback(root = document) {
    const pressableSelector = '#addConnectionBtn, [data-edit]';
    const clearPress = (el) => el?.classList?.remove('connection-pressing');
    root.addEventListener('pointerdown', (e) => {
        const target = e.target.closest?.(pressableSelector);
        if (!target || target.disabled) return;
        target.classList.add('connection-pressing');
    }, { passive: true });
    root.addEventListener('pointerup', (e) => clearPress(e.target.closest?.(pressableSelector)), { passive: true });
    root.addEventListener('pointercancel', (e) => clearPress(e.target.closest?.(pressableSelector)), { passive: true });
    root.addEventListener('pointerleave', (e) => clearPress(e.target.closest?.(pressableSelector)), { passive: true });
    root.addEventListener('click', (e) => {
        const target = e.target.closest?.(pressableSelector);
        if (!target) return;
        window.setTimeout(() => clearPress(target), 120);
    }, true);
}

function bindEvents() {
    document.documentElement.dataset.appBindEvents = 'start';
    bindConnectionPressFeedback();
    $$('.nav-tab').forEach((btn) => btn.addEventListener('click', () => switchView(btn.dataset.view)));
    $$('.settings-tab').forEach((btn) => btn.addEventListener('click', () => { $$('.settings-tab').forEach((b) => b.classList.remove('active')); btn.classList.add('active'); $$('.settings-panel').forEach((p) => p.classList.remove('active')); $(`#settings-${btn.dataset.settings}`).classList.add('active'); }));
    $('#appThemeToggle').addEventListener('click', () => toggleTheme().catch((err) => toast(err.message))); $('#settingsThemeToggle').addEventListener('click', () => toggleTheme().catch((err) => toast(err.message))); $('#logoutBtn').addEventListener('click', async () => { await api('/api/auth/logout', { method: 'POST' }); location.href = '/'; });
    $('#notesSettingsForm')?.addEventListener('submit', saveNotesSettings);
    $('#adminAddUserBtn')?.addEventListener('click', openAdminAddUserDialog);
    document.getElementById('adminUserList')?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-admin-action]');
        if (!btn) return;
        handleAdminAction(btn.dataset.adminAction, btn.dataset.userId);
    });
    $('#addConnectionBtn').addEventListener('click', (e) => openModal(null, e.currentTarget, { mode: 'create', source: 'dashboard' })); $('#closeModalBtn').addEventListener('click', closeModal); $('#cancelModalBtn').addEventListener('click', closeModal); $('#toggleConnPassword').addEventListener('click', () => { const el = $('#connPassword'); el.type = el.type === 'password' ? 'text' : 'password'; $('#toggleConnPassword').textContent = el.type === 'password' ? '👁️' : '🙈'; }); $('#revealConnSecrets').addEventListener('click', () => revealConnectionSecrets().catch((err) => toast(err.message))); $$('.route-type-tab').forEach((btn) => btn.addEventListener('click', () => setRouteMode($('#connMode').value === btn.dataset.routeMode ? 'direct' : btn.dataset.routeMode))); $('#addJumpRouteBtn').addEventListener('click', addJumpRouteRow); $('#jumpRouteList').addEventListener('click', (e) => { if (!e.target.closest?.('[data-remove-jump-route]')) return; const ids = $$('#jumpRouteList [data-jump-route-select]').filter((el) => !el.closest('[data-jump-route-row]').contains(e.target)).map((el) => el.value).filter(Boolean); renderJumpRouteRows(ids); }); $('#testConnectionBtn').addEventListener('click', testConnection); $('#connectTransientBtn')?.addEventListener('click', () => connectTransient().catch((err) => toast(err.message)));
    $('#connProtocol').addEventListener('change', () => updateProtocolFields({ preservePort: false }));
    $('#rdpTouchMode')?.addEventListener('change', updateRdpTouchSettingsUi);
    $('#rdpTouchSensitivity')?.addEventListener('input', updateRdpTouchSettingsUi);
    $('#connectionForm').addEventListener('submit', saveConnection); restoreConnectionFilters(); ['searchInput', 'protocolFilter', 'tagFilter', 'sortSelect'].forEach((id) => { const el = $(`#${id}`); const handler = () => { saveConnectionFilters(); renderConnections(); }; el.addEventListener('input', handler); el.addEventListener('change', handler); });
    $('#connectionGrid').addEventListener('click', async (e) => {
        const edit = e.target.closest?.('[data-edit]')?.dataset.edit, del = e.target.closest?.('[data-delete]')?.dataset.delete, connect = e.target.closest?.('[data-connect]')?.dataset.connect;
        if (edit) openModal(connections.find((c) => c.id === edit), e.target.closest?.('[data-edit]'));
        if (del && confirm('确定删除该连接？')) {
            const card = e.target.closest?.('.connection-card');
            try {
                await waitForConnectionCardExit(card, del);
                await api(`/api/connections/${del}`, { method: 'DELETE' });
                await loadConnections();
                toast('连接已删除');
            } catch (err) {
                card?.classList.remove('deleting');
                card?.querySelectorAll('button').forEach((btn) => { btn.disabled = false; });
                console.debug('[connection-card]', 'delete failed, animation reverted', { connectionId: del, message: err.message });
                toast(err.message);
            }
        }
        if (connect) openConnection(connect).catch((err) => toast(err.message));
    });
    $('#sessionTabs').addEventListener('click', (e) => {
        if (suppressSmartbarClick) { suppressSmartbarClick = false; return; }
        const toggle = e.target.closest?.('[data-smartbar-toggle]');
        if (toggle) { setTerminalSmartbarOpen(!terminalSmartbarOpen); return; }
        if (e.target.closest?.('[data-mobile-exit-fullscreen]')) { exitTerminalFullscreen(); setTerminalSmartbarOpen(false); return; }
        if (e.target.closest?.('[data-smartbar-add]')) {
            terminalSmartbarPickerOpen = !terminalSmartbarPickerOpen;
            setTerminalSmartbarOpen(true);
            requestAnimationFrame(positionSmartbarPicker);
            return;
        }
        const tabButton = e.target.closest?.('[data-smartbar-tab]');
        const tab = tabButton?.dataset.smartbarTab;
        if (tab) activateTerminalFromDock(tab, tabButton);
    });
    document.addEventListener('pointerdown', (e) => {
        const toggle = e.target.closest?.('.mobile-fullscreen-dock-toggle');
        if (!toggle) return;
        e.preventDefault();
        e.stopPropagation();
        mobileDockTogglePressState = {
            pointerId: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            moved: false,
            toggle,
        };
        toggle.classList.add('is-pressing');
        try { toggle.setPointerCapture?.(e.pointerId); } catch (_) {}
        document.querySelectorAll('#terminalWorkspace .terminal-frame').forEach((frame) => frame.style.pointerEvents = 'none');
    }, true);
    document.addEventListener('pointermove', (e) => {
        const state = mobileDockTogglePressState;
        if (!state || e.pointerId !== state.pointerId) return;
        if (Math.hypot(e.clientX - state.startX, e.clientY - state.startY) > 10) state.moved = true;
        e.preventDefault();
        e.stopPropagation();
    }, true);
    document.addEventListener('pointerup', (e) => {
        const state = mobileDockTogglePressState;
        if (!state || e.pointerId !== state.pointerId) return;
        e.preventDefault();
        e.stopPropagation();
        mobileDockTogglePressState = null;
        state.toggle?.classList.remove('is-pressing');
        try { state.toggle?.releasePointerCapture?.(e.pointerId); } catch (_) {}
        if (!state.moved) {
            mobileDockToggleLastToggleAt = Date.now();
            setTerminalSmartbarOpen(!terminalSmartbarOpen);
        } else if (!terminalSmartbarOpen) {
            document.querySelectorAll('#terminalWorkspace .terminal-frame').forEach((frame) => frame.style.pointerEvents = '');
        }
    }, true);
    document.addEventListener('pointercancel', (e) => {
        const state = mobileDockTogglePressState;
        if (!state || e.pointerId !== state.pointerId) return;
        mobileDockTogglePressState = null;
        state.toggle?.classList.remove('is-pressing');
        if (!terminalSmartbarOpen) document.querySelectorAll('#terminalWorkspace .terminal-frame').forEach((frame) => frame.style.pointerEvents = '');
    }, true);
    document.addEventListener('click', (e) => {
        if (e.target.closest?.('.smartbar-handle')) {
            e.preventDefault();
            e.stopPropagation();
            if (Date.now() - mobileDockToggleLastToggleAt > 180) {
                mobileDockToggleLastToggleAt = Date.now();
                setTerminalSmartbarOpen(!terminalSmartbarOpen);
            }
            return;
        }
        if (e.target.closest?.('.mobile-fullscreen-dock-toggle')) {
            e.preventDefault();
            e.stopPropagation();
            if (Date.now() - mobileDockToggleLastToggleAt > 450) {
                mobileDockToggleLastToggleAt = Date.now();
                setTerminalSmartbarOpen(!terminalSmartbarOpen);
            }
            return;
        }
        if (e.target.closest?.('[data-smartbar-picker-close]')) { terminalSmartbarPickerOpen = false; renderTerminalSmartbar(); return; }
        const connect = e.target.closest?.('[data-smartbar-connect]')?.dataset.smartbarConnect;
        if (connect) { terminalSmartbarPickerOpen = false; setTerminalSmartbarOpen(false); openConnection(connect).catch((err) => toast(err.message)); }
    }, true);
    $('#sessionTabs').addEventListener('pointerdown', (e) => {
        const tabBtn = e.target.closest?.('[data-smartbar-tab]');
        if (!tabBtn) return;
        startSmartbarPress(e, tabBtn);
    });
    $('#sessionTabs').addEventListener('pointermove', (e) => {
        const dock = e.target.closest?.('.smartbar-dock');
        if (dock) {
            if (e.target.closest?.('[data-smartbar-tab]')) e.preventDefault?.();
            updateDockMagnification(e.clientX, dock, e.clientY);
        }
    }, { passive: false });
    $('#sessionTabs').addEventListener('pointerleave', (e) => {
        resetDockMagnification(e.currentTarget.querySelector('.smartbar-dock'));
    });
    document.addEventListener('pointerdown', (e) => {
        if (!terminalSmartbarOpen) return;
        if (e.target.closest?.('[data-smartbar-toggle], .mobile-fullscreen-dock-toggle')) return;
        if (e.target.closest?.('.smartbar-picker')) { terminalSmartbarLastInnerPointerAt = Date.now(); scheduleTerminalSmartbarAutoClose(); return; }
        if (e.target.closest?.('.terminal-smartbar .smartbar-panel, .terminal-smartbar .smartbar-dock, .terminal-smartbar .smartbar-session, .terminal-smartbar .smartbar-add')) {
            terminalSmartbarLastInnerPointerAt = Date.now();
            scheduleTerminalSmartbarAutoClose();
            return;
        }
        setTerminalSmartbarOpen(false);
        document.querySelectorAll('#terminalWorkspace .terminal-frame').forEach((frame) => frame.style.pointerEvents = '');
    }, true);
    $('#terminalWorkspace').addEventListener('click', (e) => {
        const action = e.target.closest?.('[data-window-action]');
        if (!action) return;
        noteTerminalWorkspaceActivity();
        e.preventDefault();
        e.stopPropagation();
        action.dataset.windowActionHandled = '1';
        runTerminalWindowActionButton(action);
    }, true);
    $('#terminalWorkspace').addEventListener('click', (e) => {
        noteTerminalWorkspaceActivity();
        const menuBtn = e.target.closest?.('[data-window-control]');
        closeOtherTerminalWindowMenus(menuBtn);
        if (menuBtn) {
            e.stopPropagation();
            if (terminalControlLongPress) {
                terminalControlLongPress = false;
                return;
            }
            const titlebar = menuBtn.closest('.terminal-window-titlebar');
            if (titlebar?.classList.contains('menu-open')) {
                closeTerminalWindowMenu(titlebar);
            } else {
                openTerminalWindowMenu(titlebar);
            }
            console.info('[DynamicIslandDiagnostics]', {
                event: 'terminal-window-menu-toggle',
                tabId: menuBtn.dataset.windowControl || '',
                open: titlebar?.classList.contains('menu-open') || false,
                longPressSuppressed: false,
            });
            return;
        }
        const action = e.target.closest?.('[data-window-action]');
        if (action) {
            e.preventDefault();
            e.stopPropagation();
            if (!action.dataset.windowActionHandled) runTerminalWindowActionButton(action);
            delete action.dataset.windowActionHandled;
            return;
        }
        const win = e.target.closest?.('[data-window]');
        if (win) { activeTerminalTab = win.dataset.window; touchTerminalSession(activeTerminalTab); renderTerminalTabs({ rebuildWorkspace: false }); }
    });
    $('#terminalWorkspace').addEventListener('pointerdown', (e) => {
        if (e.target.closest?.('[data-window-action]')) {
            e.stopPropagation();
            return;
        }
        const splitter = e.target.closest?.('[data-splitter]');
        if (splitter) { startWorkspaceSplitterDrag(e, splitter.dataset.splitter); return; }
        const control = e.target.closest?.('[data-window-control]');
        if (control) {
            const tabId = control.dataset.windowControl;
            terminalControlLongPress = false;
            control.classList.add('island-pressing');
            const releaseIslandPress = () => control.classList.remove('island-pressing');
            const timer = window.setTimeout(() => {
                terminalControlLongPress = true;
                control.closest('.terminal-window-titlebar')?.classList.remove('menu-open');
                releaseIslandPress();
                startTerminalWindowDrag(e, tabId);
            }, 360);
            const cleanup = () => {
                window.clearTimeout(timer);
                releaseIslandPress();
                window.removeEventListener('pointerup', cleanup);
                window.removeEventListener('pointercancel', cleanup);
            };
            window.addEventListener('pointerup', cleanup, { once: true });
            window.addEventListener('pointercancel', cleanup, { once: true });
        }
    });
    document.addEventListener('pointerdown', (e) => {
        if (e.target.closest?.('[data-window-control], .terminal-window-menu')) return;
        closeOtherTerminalWindowMenus();
    }, true);
    ['keydown', 'pointerdown'].forEach((eventName) => document.addEventListener(eventName, (e) => { if (e.target.closest?.('#terminalWorkspace')) noteTerminalWorkspaceActivity(); }, true));
    ['fullscreenchange', 'webkitfullscreenchange'].forEach((eventName) => document.addEventListener(eventName, () => {
        const workspace = $('#terminalWorkspace');
        const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
        const isTerminalFullscreen = fullscreenElement === workspace || fullscreenElement?.classList?.contains('terminal-window');
        if (isTerminalFullscreen) {
            appKeyboardBaseline = Math.max(window.innerHeight || 0, document.documentElement.clientHeight || 0, window.visualViewport?.height || 0);
            scheduleTerminalKeyboardReflow('native-fullscreen-change');
            hideFullscreenLoading({ delay: 620 });
        } else {
            resetTerminalWorkspaceKeyboard();
            workspace?.classList.remove('custom-fullscreen');
            document.body.classList.remove('terminal-custom-fullscreen-open');
            showFullscreenLoading('正在退出全屏...'), hideFullscreenLoading({ delay: 680 });
        }
    }));
    systemThemeQuery.addEventListener('change', () => {
        if (isAutoThemeEnabled()) {
            const theme = getSystemTheme();
            console.debug('[appearance-client]', 'system theme changed', { theme });
            applyTheme(theme);
        }
    });
    window.addEventListener('message', (e) => {
        if (e.data?.source !== 'zephyr-terminal') return;
        if (handleSharedClipboardMessage(e.data)) return;
        if (e.data.type === 'rdp-file-open-share' || e.data.type === 'rdp-sftp-clipboard-paste-ack') {
            const targetFrame = terminalFrameById(String(e.data.tabId || ''));
            if (targetFrame?.contentWindow) {
                targetFrame.contentWindow.postMessage({ source: 'zephyr-app', type: e.data.type, ...e.data }, '*');
            }
            return;
        }
        if (e.data.type === 'ai-remote-desktop-action-result') {
            const actionId = String(e.data.actionId || '');
            const resolve = aiRemoteDesktopActionWaiters.get(actionId);
            if (resolve) resolve(e.data);
            return;
        }
        if (e.data.type === 'keyboard-metrics') {
            const tabId = String(e.data.tabId || '');
            if (tabId && tabId !== activeTerminalTab) return;
            if (e.data.fallback && e.data.stableInput) return;
            if (e.data.keyboardOpen || Number(e.data.keyboardInset) >= 80) applyTerminalWorkspaceKeyboard(e.data);
            else scheduleCompactKeyboardViewportCheck('iframe-keyboard-metrics-closed');
            return;
        }
        if (e.data.type === 'activity') {
            noteTerminalWorkspaceActivity();
            return;
        }
        if (e.data.type === 'close-request') {
            console.info('[terminal-layout]', 'close request from terminal iframe', {
                tabId: e.data.tabId,
                reason: e.data.reason,
                tabCount: terminalTabs.length,
                compact: isCompactTerminalWorkspace(),
            });
            closeTerminalTab(e.data.tabId, { reason: e.data.reason || 'iframe-close-request' });
            return;
        }
        if (e.data.type === 'download-url') {
            let downloadUrl;
            try {
                downloadUrl = new URL(e.data.url || '', location.href);
                if (downloadUrl.origin !== location.origin) throw new Error('cross-origin download blocked');
            } catch (err) {
                console.warn('[terminal-download]', 'ignored invalid download url', { message: err.message });
                return;
            }
            const a = document.createElement('a');
            a.href = downloadUrl.href;
            a.download = String(e.data.name || 'download');
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            window.setTimeout(() => { try { a.remove(); } catch {} }, 1000);
            return;
        }
        const t = terminalTabs.find((x) => x.id === e.data.tabId);
        if (t) {
            const reconnectTimer = terminalReconnectFallbackTimers.get(t.id);
            if (reconnectTimer && e.data.status) {
                window.clearTimeout(reconnectTimer);
                terminalReconnectFallbackTimers.delete(t.id);
            }
            t.status = e.data.status || t.status;
            renderTerminalTabs({ rebuildWorkspace: false });
        }
    });
    window.visualViewport?.addEventListener('resize', () => { updateFullscreenKeyboardFromViewport(); scheduleCompactKeyboardViewportCheck('visualViewport-resize'); }, { passive: true });
    window.addEventListener('resize', () => {
        document.querySelectorAll('.terminal-window-titlebar.menu-open').forEach(positionTerminalWindowMenu);
    }, { passive: true });
    window.addEventListener('resize', () => { updateFullscreenKeyboardFromViewport(); scheduleCompactKeyboardViewportCheck('window-resize'); }, { passive: true });
    window.visualViewport?.addEventListener('scroll', () => { updateFullscreenKeyboardFromViewport(); scheduleCompactKeyboardViewportCheck('visualViewport-scroll'); }, { passive: true });
    window.addEventListener('resize', () => {
        if (!terminalTabs.length) return;
        if (isCompactTerminalWorkspace()) {
            renderTerminalSmartbar();
            renderTerminalTabs({ rebuildWorkspace: false });
            return;
        }
        enforceTerminalWorkspaceLimit(activeTerminalTab);
        renderTerminalTabs();
    });
    $('#remoteExecForm').addEventListener('submit', remoteExecute); $('#beianForm').addEventListener('submit', saveBeian); $('#proxyForm').addEventListener('submit', saveProxy); $('#sshKeyForm').addEventListener('submit', saveSshKey); $('#resetSshKeyForm').addEventListener('click', resetSshKeyForm);
    setupAiAssistant();
    $('#brandIconFile').addEventListener('change', async (e) => { try { const dataUrl = await readImageAsDataUrl(e.target.files?.[0]); if (!dataUrl) return; pendingBrandIcon = dataUrl; $('#brandIconPreview').innerHTML = iconHtml(dataUrl); console.debug('[appearance-client]', 'brand icon file loaded', { size: e.target.files?.[0]?.size || 0, type: e.target.files?.[0]?.type || '' }); } catch (err) { e.target.value = ''; toast(err.message); } });
    setupAppearanceControls();
    $('#resetAppearanceBtn').addEventListener('click', () => resetAppearance().catch((err) => toast(err.message)));
    $('#proxyList').addEventListener('click', async (e) => { const id = e.target.dataset.editProxy || e.target.dataset.openProxy || e.target.dataset.delProxy; if (!id) return; const p = proxies.find((x) => x.id === id); if (e.target.dataset.editProxy) { $('#proxyId').value = p.id; $('#proxyName').value = p.name; $('#proxyType').value = p.type || 'socks5'; $('#proxyHost').value = p.host; $('#proxyPort').value = p.port; $('#proxyUsername').value = p.username || ''; $('#proxyPassword').value = p.hasPassword ? '******' : ''; } else if (e.target.dataset.openProxy) { await openProxySecret(id); } else if (confirm('删除代理？')) { await api(`/api/proxies/${id}`, { method: 'DELETE' }); await loadNetwork(); } });
    $('#sshKeyList').addEventListener('click', async (e) => { const editId = e.target.dataset.editSshKey, openId = e.target.dataset.openSshKey, delId = e.target.dataset.delSshKey; if (editId) { const k = sshKeys.find((x) => x.id === editId); if (!k) return; $('#sshKeyId').value = k.id; $('#sshKeyName').value = k.name || ''; $('#sshKeyPrivateKey').value = k.hasPrivateKey ? '******' : ''; $('#sshKeyPassphrase').value = k.hasPassphrase ? '******' : ''; $('#sshKeyRemark').value = k.remark || ''; return; } if (openId) { await openSshKeySecret(openId); return; } if (delId && confirm('删除该 SSH 密钥？已选择它的连接将无法再使用该密钥。')) { await api(`/api/ssh-keys/${delId}`, { method: 'DELETE' }); await loadNetwork(); toast('SSH 密钥已删除'); } });
    $('#passwordForm').addEventListener('submit', async (e) => { e.preventDefault(); const currentPassword = $('#settingsCurrentPassword').value, newPassword = $('#settingsNewPassword').value, confirmPassword = $('#settingsConfirmPassword').value; if (newPassword !== confirmPassword) return toast('两次输入的新密码不一致'); await api('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }); e.target.reset(); toast('密码已更新'); });
    $('#profileForm').addEventListener('submit', async (e) => { e.preventDefault(); await api('/api/security/profile', { method: 'PUT', body: JSON.stringify({ username: $('#profileUsername').value.trim(), email: $('#profileEmail').value }) }); toast('资料已保存'); await loadSecurityStatus(); });
    $('#securityPolicyForm').addEventListener('submit', saveSecurityPolicy); $('#captchaForm').addEventListener('submit', saveCaptcha); $('#mailForm').addEventListener('submit', saveMail); $('#appearanceForm').addEventListener('submit', saveAppearance); $('#terminalLayoutForm').addEventListener('submit', saveTerminalLayout); setupSnippetSettings(); setupAgentTokenSettings();
    $('#totpBox').addEventListener('click', (e) => { if (e.target.id === 'setupTotpBtn') setupTotp().catch((err) => toast(err.message)); });
    $('#totpEnableForm').addEventListener('submit', async (e) => { e.preventDefault(); await api('/api/security/totp/enable', { method: 'POST', body: JSON.stringify({ code: $('#totpEnableCode').value }) }); toast('TOTP 已开启'); $('#totpEnableForm').classList.add('force-hidden'); await loadSecurityStatus(); });
    $('#totpDisableForm').addEventListener('submit', async (e) => { e.preventDefault(); if (!confirm('确定关闭 TOTP？')) return; await api('/api/security/totp/disable', { method: 'POST', body: JSON.stringify({ currentPassword: $('#totpDisablePassword').value, code: $('#totpDisableCode').value }) }); e.target.reset(); toast('TOTP 已关闭'); await loadSecurityStatus(); });
    $('#addPasskeyBtn').addEventListener('click', () => registerPasskey().catch((err) => toast(err.message)));
    $('#passkeyList').addEventListener('click', async (e) => { const id = e.target.dataset.delPasskey; if (id && confirm('删除该 Passkey？')) { await api(`/api/passkeys/${id}`, { method: 'DELETE' }); await loadSecurityStatus(); } });
    $('#ipBanList').addEventListener('click', async (e) => { const ip = e.target.dataset.unban; if (ip) { await api(`/api/security/ip-bans/${encodeURIComponent(ip)}`, { method: 'DELETE' }); await loadSecurityLists(); toast('已解除封禁'); } });
    $('#toggleCaptchaSecret').addEventListener('click', () => { const el = $('#captchaSecretKey'); el.type = el.type === 'password' ? 'text' : 'password'; $('#toggleCaptchaSecret').textContent = el.type === 'password' ? '👁️' : '🙈'; });
    $('#revealCaptchaSecret').addEventListener('click', () => revealCaptchaSecret().catch((err) => toast(err.message || '读取 CAPTCHA 密钥失败')));
    $('#toggleMailPassword').addEventListener('click', () => { const el = $('#mailPass'); el.type = el.type === 'password' ? 'text' : 'password'; $('#toggleMailPassword').textContent = el.type === 'password' ? '👁️' : '🙈'; });
    $('#revealMailPass').addEventListener('click', () => revealMailPass().catch((err) => toast(err.message || '读取 SMTP 密码失败')));
    $('#testMailBtn').addEventListener('click', () => testMail());
    $('#exportDataBtn').addEventListener('click', () => { location.href = '/api/data/export'; });
    $('#clearActivityBtn').addEventListener('click', async () => { if (!confirm('确定清理最近活动日志？')) return; await api('/api/activities', { method: 'DELETE' }); await loadConnections(); toast('活动日志已清理'); });
    $('#clearLoginEventsBtn').addEventListener('click', async () => { if (!confirm('确定清理登录事件日志？')) return; await api('/api/security/login-events', { method: 'DELETE' }); await loadSecurityLists(); toast('登录事件已清理'); });
    $('#importDataForm').addEventListener('submit', async (e) => { e.preventDefault(); if (!confirm('导入会覆盖当前数据库，系统会先生成本地备份。继续？')) return; const fd = new FormData(); fd.append('backup', $('#backupFile').files[0]); fd.append('loginPassword', $('#importLoginPassword').value); fd.append('backupPassword', $('#backupPassword').value); const res = await fetch('/api/data/import', { method: 'POST', body: fd, credentials: 'same-origin' }); const data = await res.json().catch(() => ({})); if (!res.ok) throw new Error(data.error || '导入失败'); toast(data.message || '导入完成'); });
}
function automaticWorkspaceId() {
    return `auto-${String(workspaceClientId || 'default').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80)}`;
}

function collectWorkspaceState() {
    const tabs = terminalTabs
        .filter((t) => t.connectionId && !t.transient)
        .map((t, index) => ({
            connectionId: t.connectionId,
            protocol: t.protocol || 'SSH',
            sessionId: t.sessionId || t.id || '',
            tabId: t.id,
            minimized: !!t.minimized,
            order: index,
            active: t.id === activeTerminalTab,
        }));
    return {
        version: 1,
        tabs,
        ui: { activeView: currentAppView },
        activeConnectionId: terminalTabs.find((t) => t.id === activeTerminalTab)?.connectionId || '',
        activeSessionId: terminalTabs.find((t) => t.id === activeTerminalTab)?.sessionId
            || terminalTabs.find((t) => t.id === activeTerminalTab)?.id
            || '',
    };
}

function scheduleWorkspaceSave(reason = '', { immediate = false } = {}) {
    if (!workspaceReady || workspaceRestoring || !workspaceClientId) return;
    clearTimeout(workspaceSaveTimer);
    if (immediate) {
        workspaceSaveTimer = null;
        saveWorkspaceNow({ reason }).catch((err) => console.warn('[workspace-save]', err));
        return;
    }
    workspaceSaveTimer = setTimeout(() => saveWorkspaceNow({ reason }).catch((err) => console.warn('[workspace-save]', err)), 700);
}

async function saveWorkspaceNow({ keepalive = false, reason = '' } = {}) {
    if (!workspaceReady || workspaceRestoring || !workspaceClientId) return;
    clearTimeout(workspaceSaveTimer);
    workspaceSaveTimer = null;
    const body = {
        clientId: workspaceClientId,
        name: '默认工作区',
        state: collectWorkspaceState(),
        expectedRevision: workspaceRevision,
    };
    try {
        const data = await api(`/api/me/workspaces/${encodeURIComponent(automaticWorkspaceId())}`, {
            method: 'PUT',
            body: JSON.stringify(body),
            keepalive,
        });
        workspaceRevision = data.workspace?.revision ?? workspaceRevision;
        if (reason) console.debug('[workspace-save]', reason, { revision: workspaceRevision, tabs: body.state?.tabs?.length || 0, view: body.state?.ui?.activeView });
    } catch (err) {
        if (err.status === 409) {
            const latest = await api(`/api/me/workspaces/${encodeURIComponent(automaticWorkspaceId())}`);
            workspaceRevision = latest.workspace?.revision ?? null;
            body.expectedRevision = workspaceRevision;
            const data = await api(`/api/me/workspaces/${encodeURIComponent(automaticWorkspaceId())}`, {
                method: 'PUT',
                body: JSON.stringify(body),
                keepalive,
            });
            workspaceRevision = data.workspace?.revision ?? workspaceRevision;
            return;
        }
        throw err;
    }
}

async function restoreLastWorkspace() {
    if (!workspaceClientId) return;
    workspaceRestoring = true;
    try {
        // Backend only exposes POST /restore (GET falls through to Express 404 and was
        // previously swallowed, so refresh always dropped back to the dashboard).
        const restored = await api(`/api/me/workspaces/${encodeURIComponent(automaticWorkspaceId())}/restore`, {
            method: 'POST',
            body: '{}',
        });
        const workspace = restored.workspace;
        workspaceRevision = workspace?.revision ?? null;
        const state = workspace?.state || {};
        const savedTabs = Array.isArray(state.tabs)
            ? [...state.tabs]
                .filter((t) => t && t.connectionId && t.accessible !== false)
                .sort((a, b) => Number(a.order || 0) - Number(b.order || 0))
            : [];
        const view = String(state.ui?.activeView || 'dashboard');
        const allowedView = ['dashboard', 'terminal', 'remote', 'notes', 'settings'].includes(view) ? view : 'dashboard';
        // Switch view first so the user lands on the terminal shell immediately,
        // then re-attach sessions underneath (with history replay).
        if (savedTabs.length && (allowedView === 'terminal' || savedTabs.some((t) => t.active))) {
            switchView('terminal');
        }
        const opened = new Map();
        for (const saved of savedTabs) {
            const conn = connections.find((c) => c.id === saved.connectionId);
            if (!conn) continue;
            try {
                const sessionId = String(saved.sessionId || saved.tabId || '').trim()
                    || stableTerminalSessionId(conn.id, saved.protocol || conn.protocol || 'SSH');
                const tabId = await openConnection(conn.id, {
                    sessionId,
                    tabId: sessionId,
                    skipViewSwitch: true,
                });
                const tab = terminalTabs.find((t) => t.id === tabId && !opened.has(t.id));
                if (tab) {
                    tab.minimized = !!saved.minimized;
                    tab.sessionId = sessionId;
                    opened.set(tab.id, saved);
                }
            } catch (err) {
                console.warn('[workspace-restore] skip connection', conn.id, err);
            }
        }
        const activeConnectionId = state.activeConnectionId || savedTabs.find((t) => t.active)?.connectionId || '';
        const activeSessionId = state.activeSessionId || savedTabs.find((t) => t.active)?.sessionId || savedTabs.find((t) => t.active)?.tabId || '';
        const active = terminalTabs.find((t) => activeSessionId && (t.sessionId === activeSessionId || t.id === activeSessionId))
            || terminalTabs.find((t) => t.connectionId === activeConnectionId)
            || terminalTabs.find((t) => !t.minimized)
            || terminalTabs[0];
        if (active) {
            active.minimized = false;
            activeTerminalTab = active.id;
        }
        renderTerminalTabs({ rebuildWorkspace: true });
        // If any session was restored, prefer terminal so refresh matches the last live session.
        const preferTerminal = terminalTabs.length > 0 && (allowedView === 'terminal' || !!activeConnectionId || savedTabs.some((t) => t.active));
        switchView(preferTerminal ? 'terminal' : (terminalTabs.length && allowedView === 'terminal' ? 'terminal' : allowedView));
    } catch (err) {
        if (err.status !== 404) console.warn('[workspace-restore]', err);
    } finally {
        workspaceRestoring = false;
        workspaceReady = true;
        // Persist the filtered restore result so the next load stays consistent.
        scheduleWorkspaceSave('restore-complete', { immediate: true });
    }
}

function ensureWorkspaceClientId() {
    const key = 'zephyr.workspace.clientId';
    try {
        let id = localStorage.getItem(key);
        if (!id) {
            id = (crypto.randomUUID?.() || `c_${Date.now().toString(16)}_${Math.random().toString(16).slice(2)}`);
            localStorage.setItem(key, id);
        }
        workspaceClientId = id;
        return id;
    } catch {
        workspaceClientId = `mem_${Date.now()}`;
        return workspaceClientId;
    }
}

function handleTransientHash() {
    const hash = String(location.hash || '').replace(/^#/, '');
    if (!hash.startsWith('transient=')) return false;
    const token = decodeURIComponent(hash.slice('transient='.length));
    history.replaceState(null, '', location.pathname + location.search);
    if (token) openTransientFromToken(token).catch((err) => toast(err.message || '临时凭据无效'));
    return true;
}

function bindDeepLinkChannel() {
    if (!('BroadcastChannel' in window)) return;
    try {
        const channel = new BroadcastChannel('zephyr-deeplink');
        channel.addEventListener('message', (event) => {
            const data = event.data || {};
            if (data.type !== 'zephyr-transient-connect' || !data.token) return;
            openConnectionModal({
                mode: 'transient',
                source: 'deeplink',
                draft: data.draft || null,
                transientToken: data.token,
            });
        });
    } catch {}
    window.addEventListener('message', (event) => {
        if (event.origin !== location.origin) return;
        const data = event.data || {};
        if (data.type !== 'zephyr-transient-connect' || !data.token) return;
        openConnectionModal({
            mode: 'transient',
            source: 'deeplink',
            draft: data.draft || null,
            transientToken: data.token,
        });
    });
    // Terminal -> app: open notes filtered by current connection
    window.addEventListener('message', (event) => {
        if (event.origin !== location.origin) return;
        const data = event.data || {};
        if (data.source !== 'zephyr-terminal' || data.type !== 'open-notes-for-connection') return;
        if (!isNotesEnabled()) {
            toast('笔记功能未开启，请在设置中启用');
            return;
        }
        switchView('notes');
        notesController?.filterByConnection?.(data.connectionId);
        toast(data.connectionId ? '已按当前连接过滤笔记' : '已打开笔记');
    });
}

// ─── Multi-user management UI (FREEZE plan §19.3) ───────────────────────────
// Apple-style line SVG icons (no emoji). 24x24, currentColor, rounded.
function adminIcon(name, size = 16) {
    const icons = {
        user: '<svg width="{s}" height="{s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"/></svg>',
        plus: '<svg width="{s}" height="{s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
        shield: '<svg width="{s}" height="{s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l8 3v7c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V5l8-3z"/></svg>',
        crown: '<svg width="{s}" height="{s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7l4 5 5-7 5 7 4-5v11H3V7z"/></svg>',
        pause: '<svg width="{s}" height="{s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
        play: '<svg width="{s}" height="{s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 5l12 7-12 7V5z"/></svg>',
        key: '<svg width="{s}" height="{s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="16" r="4"/><path d="M11 13l9-9M16 8l2 2"/></svg>',
        logout: '<svg width="{s}" height="{s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4M16 17l5-5-5-5M21 12H9"/></svg>',
        trash: '<svg width="{s}" height="{s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14"/></svg>',
        transfer: '<svg width="{s}" height="{s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3l4 4-4 4M20 7H8M8 21l-4-4 4-4M4 17h12"/></svg>',
        promote: '<svg width="{s}" height="{s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
    };
    return (icons[name] || icons.user).replace(/\{s\}/g, String(size));
}

let myIdentity = { userId: '', role: 'user', isSuperAdmin: false };

async function loadAdminUsers() {
    const panel = document.getElementById('settings-admin');
    if (!panel) return;
    try {
        const me = await api('/api/auth/me');
        myIdentity = { userId: me.user?.userId || '', role: me.user?.role || 'user', isSuperAdmin: !!me.user?.isSuperAdmin };
    } catch { myIdentity = { userId: '', role: 'user', isSuperAdmin: false }; }
    const adminTab = document.getElementById('adminSettingsTab');
    if (myIdentity.role !== 'admin') { panel.classList.add('force-hidden'); adminTab?.classList.add('force-hidden'); return; }
    panel.classList.remove('force-hidden');
    adminTab?.classList.remove('force-hidden');
    // Inject SVG icons into title and add button
    const title = document.getElementById('adminPanelTitle');
    if (title && !title.dataset.iconInjected) { title.innerHTML = adminIcon('shield', 18) + ' 多用户管理'; title.dataset.iconInjected = '1'; }
    const addBtn = document.getElementById('adminAddUserBtn');
    if (addBtn && !addBtn.dataset.iconInjected) { const span = addBtn.querySelector('.admin-icon-inline'); if (span) span.innerHTML = adminIcon('plus', 15); addBtn.dataset.iconInjected = '1'; }
    try {
        const data = await api('/api/admin/users');
        renderAdminUsers(data.users || []);
    } catch (err) {
        panel.classList.add('force-hidden');
    }
}

function renderAdminUsers(users) {
    const list = document.getElementById('adminUserList');
    if (!list) return;
    if (!users.length) {
        list.innerHTML = '<p class="muted">暂无用户</p>';
        return;
    }
    const activeAdmins = users.filter((u) => u.role === 'admin' && u.status === 'active');
    list.innerHTML = users.map((u) => {
        const isSelf = u.userId === myIdentity.userId;
        const isLastActiveAdmin = u.role === 'admin' && u.status === 'active' && activeAdmins.length <= 1;
        const roleBadge = u.isSuperAdmin
            ? `<span class="admin-badge super">${adminIcon('crown', 12)} 超级管理员</span>`
            : u.role === 'admin'
                ? `<span class="admin-badge admin">${adminIcon('shield', 12)} 管理员</span>`
                : `<span class="admin-badge user">${adminIcon('user', 12)} 普通用户</span>`;
        const statusBadge = u.status === 'active' ? '<span class="admin-badge ok">正常</span>'
            : u.status === 'suspended' ? '<span class="admin-badge warn">已停用</span>'
            : u.status === 'invited' ? '<span class="admin-badge warn">已邀请</span>'
            : `<span class="admin-badge">${escapeHtml(u.status || '未知')}</span>`;
        let actions = '';
        // Suspend / reactivate
        if (u.status === 'active' && !u.isSuperAdmin && !isLastActiveAdmin) {
            actions += `<button class="admin-action-btn" data-admin-action="suspend" data-user-id="${escapeHtml(u.userId)}" title="停用">${adminIcon('pause', 14)} 停用</button>`;
        }
        if (u.status === 'suspended') {
            actions += `<button class="admin-action-btn" data-admin-action="reactivate" data-user-id="${escapeHtml(u.userId)}" title="启用">${adminIcon('play', 14)} 启用</button>`;
        }
        // Reset password (not for super admin unless self)
        if (!u.isSuperAdmin || isSelf) {
            actions += `<button class="admin-action-btn" data-admin-action="reset-pw" data-user-id="${escapeHtml(u.userId)}" title="重置密码">${adminIcon('key', 14)} 重置密码</button>`;
        }
        // Revoke sessions (not for self)
        if (!isSelf && !u.isSuperAdmin) {
            actions += `<button class="admin-action-btn" data-admin-action="revoke-sessions" data-user-id="${escapeHtml(u.userId)}" title="强制下线">${adminIcon('logout', 14)} 踢下线</button>`;
        }
        // Promote to admin (only super admin can, target must be non-admin)
        if (myIdentity.isSuperAdmin && u.role !== 'admin' && !isSelf) {
            actions += `<button class="admin-action-btn" data-admin-action="promote" data-user-id="${escapeHtml(u.userId)}" title="授予管理员">${adminIcon('promote', 14)} 授权管理员</button>`;
        }
        // Demote admin (only super admin, not self, not super admin target)
        if (myIdentity.isSuperAdmin && u.role === 'admin' && !u.isSuperAdmin && !isSelf && !isLastActiveAdmin) {
            actions += `<button class="admin-action-btn" data-admin-action="demote" data-user-id="${escapeHtml(u.userId)}" title="撤销管理员">${adminIcon('promote', 14)} 撤销管理员</button>`;
        }
        // Transfer super admin (only current super admin, target is admin and not self)
        if (myIdentity.isSuperAdmin && u.role === 'admin' && !isSelf) {
            actions += `<button class="admin-action-btn" data-admin-action="transfer-super" data-user-id="${escapeHtml(u.userId)}" title="转移超级管理员">${adminIcon('transfer', 14)} 转移超管</button>`;
        }
        // Delete (not for self, not for super admin, not last admin)
        if (!isSelf && !u.isSuperAdmin && !isLastActiveAdmin) {
            actions += `<button class="admin-action-btn danger" data-admin-action="delete" data-user-id="${escapeHtml(u.userId)}" title="删除">${adminIcon('trash', 14)} 删除</button>`;
        }
        return `<div class="admin-user-row" data-user-id="${escapeHtml(u.userId)}">
            <div class="admin-user-info">
                <span class="admin-user-name">${adminIcon(u.isSuperAdmin ? 'crown' : (u.role === 'admin' ? 'shield' : 'user'), 18)}</span>
                <b>${escapeHtml(u.username)}</b>${isSelf ? ' <span class="muted">(你)</span>' : ''}
                <span class="muted">${escapeHtml(u.email || '无邮箱')}</span>
                ${roleBadge}${statusBadge}
                <span class="muted">${u.lastLoginAt ? '最后登录 ' + fmtTime(u.lastLoginAt) : '从未登录'}</span>
            </div>
            <div class="admin-user-actions">${actions}</div>
        </div>`;
    }).join('');
}

function openAdminAddUserDialog() {
    const name = prompt('新用户用户名：');
    if (!name) return;
    const password = prompt(`为 ${name} 设置初始密码：`);
    if (!password) return;
    let role = 'user';
    if (myIdentity.isSuperAdmin) {
        role = confirm(`${name} 设为管理员吗？\n确定 = 管理员，取消 = 普通用户`) ? 'admin' : 'user';
    }
    api('/api/admin/users', { method: 'POST', body: JSON.stringify({ username: name, password, role }) })
        .then(() => { toast('用户已创建'); loadAdminUsers(); })
        .catch((err) => toast(err.message || '创建失败'));
}

async function handleAdminAction(action, userId) {
    try {
        if (action === 'suspend') {
            if (!confirm('确定停用此用户？停用后该用户无法登录。')) return;
            await api(`/api/admin/users/${userId}/suspend`, { method: 'POST' });
        } else if (action === 'reactivate') {
            await api(`/api/admin/users/${userId}/reactivate`, { method: 'POST' });
        } else if (action === 'reset-pw') {
            const pw = prompt('输入新密码：');
            if (!pw) return;
            await api(`/api/admin/users/${userId}/force-password-reset`, { method: 'POST', body: JSON.stringify({ newPassword: pw }) });
        } else if (action === 'revoke-sessions') {
            await api(`/api/admin/users/${userId}/revoke-sessions`, { method: 'POST' });
            toast('已强制下线');
        } else if (action === 'promote') {
            if (!confirm('确定授予此用户管理员角色？')) return;
            await api(`/api/admin/users/${userId}`, { method: 'PATCH', body: JSON.stringify({ role: 'admin' }) });
        } else if (action === 'demote') {
            if (!confirm('确定撤销此用户的管理员角色？')) return;
            await api(`/api/admin/users/${userId}`, { method: 'PATCH', body: JSON.stringify({ role: 'user' }) });
        } else if (action === 'transfer-super') {
            if (!confirm('确定将超级管理员转移给此用户？\n转移后你将变为普通管理员。此操作不可撤销。')) return;
            await api(`/api/admin/users/${userId}/transfer-super-admin`, { method: 'POST' });
            toast('超级管理员已转移，请重新登录');
            setTimeout(() => location.href = '/', 1500);
            return;
        } else if (action === 'delete') {
            if (!confirm('确定删除此用户？其资源将转移给管理员。此操作不可撤销。')) return;
            await api(`/api/admin/users/${userId}`, { method: 'DELETE', body: JSON.stringify({ resourcePolicy: 'transfer-to-admin' }) });
        }
        toast('操作成功');
        await loadAdminUsers();
    } catch (err) {
        toast(err.message || '操作失败');
    }
}

async function init() {
    document.documentElement.dataset.appInit = 'start';
    try {
        applyTheme(getPreferredTheme());
        document.documentElement.dataset.appInitTheme = 'ok';
        const me = await api('/api/auth/me');
        document.documentElement.dataset.appInitAuth = 'ok';
        if (me.mustChangePassword) { location.href = '/'; return; }
        ensureWorkspaceClientId();
        // Early shell switch: if last view was terminal, paint that shell before
        // network restore so refresh does not flash the dashboard first.
        try {
            const lastView = localStorage.getItem('zephyr.lastView') || '';
            if (['terminal', 'remote', 'notes', 'settings', 'dashboard'].includes(lastView) && lastView !== 'dashboard') {
                currentAppView = lastView;
                $$('.nav-tab').forEach((b) => b.classList.toggle('active', b.dataset.view === lastView));
                $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${lastView}`));
                document.body.classList.toggle('terminal-mode', lastView === 'terminal');
            }
        } catch {}
        notesController = createNotesController({
            api,
            toast,
            openTransientFromUri,
            $,
            $$,
        });
        bindEvents();
        bindDeepLinkChannel();
        document.documentElement.dataset.appBindEvents = 'done';
        await loadSettings();
        document.documentElement.dataset.appLoadSettings = 'ok';
        await migrateLocalSnippetsToServer();
        renderSnippetSettings();
        await loadConnections();
        document.documentElement.dataset.appLoadConnections = 'ok';
        await restoreLastWorkspace();
        await loadNetwork();
        await loadAdminUsers();
        // Deep Link hand-off from /open (token only — never the raw URI).
        handleTransientHash();
        document.documentElement.dataset.appReady = '1';
        window.__zephyrAppReady = true;
        window.__zephyrMyUserId = (await api("/api/auth/me"))?.user?.userId || "";
        window.openConnectionModal = openConnectionModal;
        window.openTransientFromUri = openTransientFromUri;
        const flushWorkspace = () => { saveWorkspaceNow({ keepalive: true, reason: 'page-exit' }).catch(() => {}); };
        window.addEventListener('pagehide', flushWorkspace);
        window.addEventListener('beforeunload', flushWorkspace);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') flushWorkspace();
        });
    } catch (err) {
        console.error('[app-init]', err);
        document.documentElement.dataset.appInitError = err?.message || String(err || 'unknown');
        toast(`初始化失败：${err?.message || err || '未知错误'}`);
    }
}
init();

// ─── Zephyr Agent Token Settings ─────────────────────────────────
function formatAgentTokenTime(ms) {
    if (!ms) return '从未';
    try { return new Date(Number(ms)).toLocaleString(); } catch { return '未知'; }
}

const agentRevealedTokens = new Map();

async function loadAgentTokens() {
    const list = $('#agentTokenList');
    if (!list) return;
    list.innerHTML = '<p class="empty-state">正在加载...</p>';
    try {
        const data = await api('/api/rdp/file-agent-tokens');
        renderAgentTokens(data.tokens || [], agentRevealedTokens);
    } catch (err) {
        list.innerHTML = `<p class="empty-state">加载失败：${escapeHtml(err.message || 'unknown')}</p>`;
    }
}

function renderAgentTokens(tokens, revealedTokens = new Map()) {
    const list = $('#agentTokenList');
    if (!list) return;
    if (!tokens.length) {
        list.innerHTML = '<p class="empty-state">暂无 Token。点击“新增 Token”为设备创建连接凭据。</p>';
        return;
    }
    const revealMap = revealedTokens instanceof Map ? revealedTokens : new Map(Object.entries(revealedTokens || {}));
    list.innerHTML = tokens.map((t) => {
        const revealed = t.token || revealMap.get(t.id) || '';
        return `
        <div class="agent-token-item" data-token-id="${escapeHtml(t.id)}">
            <div class="agent-token-main">
                <div class="agent-token-title"><strong>${escapeHtml(t.name || '未命名 Token')}</strong><span>${escapeHtml(t.id || '')}</span></div>
                <div class="agent-token-value"><code>${revealed ? escapeHtml(revealed) : '••••••••••••••••••••••••••••••••'}</code></div>
                <div class="agent-token-meta">创建：${escapeHtml(formatAgentTokenTime(t.createdAt))} · 更新：${escapeHtml(formatAgentTokenTime(t.updatedAt))} · 最后使用：${escapeHtml(formatAgentTokenTime(t.lastUsedAt))}</div>
            </div>
            <div class="agent-token-buttons">
                <button class="tool-btn" type="button" data-agent-reveal-token="${escapeHtml(t.id)}">查看</button>
                <button class="tool-btn" type="button" data-agent-copy-token="${escapeHtml(t.id)}">复制</button>
                <button class="tool-btn" type="button" data-agent-rename-token="${escapeHtml(t.id)}">重命名</button>
                <button class="tool-btn" type="button" data-agent-regen-token="${escapeHtml(t.id)}">重新生成</button>
                <button class="tool-btn danger" type="button" data-agent-delete-token="${escapeHtml(t.id)}">删除</button>
            </div>
        </div>`;
    }).join('');
}

function currentAgentServerUrl() {
    return window.location.origin;
}

function updateAgentServerInfo() {
    const el = $('#agentServerUrlText');
    if (el) el.textContent = currentAgentServerUrl();
}

function currentAgentTokenLength() {
    const n = Number($('#agentTokenLengthInput')?.value || 50);
    return Math.max(16, Math.min(256, Number.isFinite(n) ? n : 50));
}

async function refreshAgentTokensKeeping(tokenRecord) {
    if (tokenRecord?.id && tokenRecord?.token) {
        agentRevealedTokens.set(tokenRecord.id, tokenRecord.token);
        renderAgentTokens([tokenRecord], agentRevealedTokens);
    }
    try {
        const data = await api('/api/rdp/file-agent-tokens');
        const list = Array.isArray(data.tokens) ? data.tokens : [];
        if (tokenRecord?.id && !list.some((t) => t.id === tokenRecord.id)) list.unshift(tokenRecord);
        renderAgentTokens(list, agentRevealedTokens);
    } catch (err) {
        if (!tokenRecord?.id) throw err;
        toast(`列表刷新失败，已显示新 Token：${err.message || 'unknown'}`);
    }
}

async function createAgentToken() {
    const name = prompt('Token 名称，例如：我的手机 / 办公室 Windows / Pad', 'Zephyr Agent Token');
    if (name === null) return;
    const data = await api('/api/rdp/file-agent-tokens', { method: 'POST', body: JSON.stringify({ name, length: currentAgentTokenLength() }) });
    const tokenRecord = data.token;
    if (!tokenRecord?.token) throw new Error('服务端未返回新 Token');
    await refreshAgentTokensKeeping(tokenRecord);
    toast('Token 已创建并显示');
}

async function renameAgentToken(id) {
    const item = document.querySelector(`[data-token-id="${CSS.escape(id)}"] .agent-token-title strong`);
    const name = prompt('新的 Token 名称', item?.textContent || 'Zephyr Agent Token');
    if (name === null) return;
    await api(`/api/rdp/file-agent-tokens/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ name }) });
    await loadAgentTokens();
    toast('Token 已重命名');
}

async function regenerateAgentToken(id) {
    if (!confirm('重新生成后，使用旧 Token 的 Agent 会断开，需要在 Agent App 中填写新 Token。继续？')) return;
    const data = await api(`/api/rdp/file-agent-tokens/${encodeURIComponent(id)}/regenerate`, { method: 'POST', body: JSON.stringify({ length: currentAgentTokenLength() }) });
    const tokenRecord = data.token;
    if (!tokenRecord?.token) throw new Error('服务端未返回新 Token');
    await refreshAgentTokensKeeping(tokenRecord);
    toast('Token 已重新生成并显示');
}

async function deleteAgentToken(id) {
    if (!confirm('删除后，使用此 Token 的 Agent 会断开。继续删除？')) return;
    await api(`/api/rdp/file-agent-tokens/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await loadAgentTokens();
    toast('Token 已删除');
}

async function revealAgentToken(id, { copy = false } = {}) {
    let token = agentRevealedTokens.get(id) || '';
    if (!token) {
        const secret = requestSensitiveSecret(copy ? '复制 Zephyr Agent Token' : '查看 Zephyr Agent Token');
        const data = await api(`/api/rdp/file-agent-tokens/${encodeURIComponent(id)}/open`, {
            method: 'POST',
            body: JSON.stringify({ secret }),
        });
        token = data.token?.token || '';
        if (!token) throw new Error('Token 为空');
        agentRevealedTokens.set(id, token);
    }
    const code = document.querySelector(`[data-token-id="${CSS.escape(id)}"] .agent-token-value code`);
    if (code) code.textContent = token;
    if (copy) {
        await copyTextToClipboard(token, 'Token 已复制');
    } else {
        toast('Token 已显示');
    }
}

async function copyAgentToken(id) {
    await revealAgentToken(id, { copy: true });
}

async function resetAllAgentTokens() {
    if (!confirm('这会删除当前账号所有 Zephyr Agent Token，并断开所有已连接 Agent。继续？')) return;
    const secret = requestSensitiveSecret('重置全部 Zephyr Agent Token');
    const name = prompt('新 Token 名称', '默认 Token');
    if (name === null) return;
    const data = await api('/api/rdp/file-agent-tokens/reset-all', {
        method: 'POST',
        body: JSON.stringify({ secret, name, length: currentAgentTokenLength() }),
    });
    const tokenRecord = data.token;
    if (!tokenRecord?.token) throw new Error('服务端未返回新 Token');
    await refreshAgentTokensKeeping(tokenRecord);
    toast('全部 Token 已重置，新 Token 已显示');
}

function setupAgentTokenSettings() {
    $('#agentCreateTokenBtn')?.addEventListener('click', () => createAgentToken().catch((err) => toast(err.message || '创建失败')));
    $('#agentRefreshTokenBtn')?.addEventListener('click', () => loadAgentTokens());
    $('#agentResetAllTokenBtn')?.addEventListener('click', () => resetAllAgentTokens().catch((err) => toast(err.message || '重置失败')));
    $('#agentCopyServerUrlBtn')?.addEventListener('click', async () => {
        try {
            await copyTextToClipboard(currentAgentServerUrl(), '主端地址已复制');
        } catch (err) {
            toast(err.message || '复制失败');
        }
    });
    $('#agentTokenList')?.addEventListener('click', (e) => {
        const reveal = e.target.dataset.agentRevealToken;
        const copy = e.target.dataset.agentCopyToken;
        const rename = e.target.dataset.agentRenameToken;
        const regen = e.target.dataset.agentRegenToken;
        const del = e.target.dataset.agentDeleteToken;
        if (reveal) revealAgentToken(reveal).catch((err) => toast(err.message || '查看失败'));
        if (copy) copyAgentToken(copy).catch((err) => toast(err.message || '复制失败'));
        if (rename) renameAgentToken(rename).catch((err) => toast(err.message || '重命名失败'));
        if (regen) regenerateAgentToken(regen).catch((err) => toast(err.message || '重新生成失败'));
        if (del) deleteAgentToken(del).catch((err) => toast(err.message || '删除失败'));
    });
    updateAgentServerInfo();
    loadAgentTokens().catch(() => {});
}
