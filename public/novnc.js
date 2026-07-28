import RFB from '/vendor/novnc/core/rfb.js';
import { t, initI18n } from './i18n/runtime.js?v=20260728-ai-handle-only-drag1';
import KeyTable from '/vendor/novnc/core/input/keysym.js';
import { applyZephyrColorScheme } from './theme-runtime.js?v=20260615-visual-color-picker';

const $ = (sel) => document.querySelector(sel);
const NOVNC_CLIENT_VERSION = '2026-06-14-theme-palettes';
console.info('[novnc-client]', 'script loaded', { version: NOVNC_CLIENT_VERSION });

const statusDot = $('#statusDot');
const statusText = $('#statusText');
const statusCard = $('#statusCard') || document.querySelector('.novnc-topbar');
const connInfo = $('#connInfo');
const connTitle = $('#connTitle');
const overlay = $('#novncOverlay');
const overlayTitle = $('#overlayTitle');
const overlayMsg = $('#overlayMsg');
const stage = $('#novncStage');
const screenShell = $('#screenShell');
const screen = $('#screen');
const qualityBtn = $('#qualityBtn');
const qualityLabel = $('#qualityLabel');
const fitBtn = $('#fitBtn');
const fitLabel = $('#fitLabel');
const dragBtn = $('#dragBtn');
const clipboardBtn = $('#clipboardBtn');
const keyboardBtn = $('#keyboardBtn');
const shortcutsBtn = $('#shortcutsBtn');
const cadBtn = $('#cadBtn');
const reconnectBtn = $('#reconnectBtn');
const disconnectBtn = $('#disconnectBtn');
const mobileKeyboardInput = $('#mobileKeyboardInput');
const clipboardPanel = $('#clipboardPanel');
const clipboardText = $('#clipboardText');
const clipboardReadLocalBtn = $('#clipboardReadLocalBtn');
const clipboardSendBtn = $('#clipboardSendBtn');
const remoteClipboardText = $('#remoteClipboardText');
const clipboardCopyRemoteBtn = $('#clipboardCopyRemoteBtn');
const clipboardHint = $('#clipboardHint');
const shortcutsPanel = $('#shortcutsPanel');
const shortcutGrid = $('#shortcutGrid');
const joystickPanel = $('#joystickPanel');
const joystickContainer = $('#joystickContainer');
const joystickKnob = $('#joystickKnob');

const urlParams = new URLSearchParams(location.search);
const tabId = urlParams.get('tabId') || '';
const embeddedMode = urlParams.get('embed') === '1';

let params = loadParams();
let rfb = null;
let connected = false;
let manualClose = false;
let reconnecting = false;
let mobileComposing = false;
let lastRemoteClipboard = '';
let vncLastFrameAt = 0;
let panelLayoutMenu = null;
let panelLayoutButton = null;
let suppressNextLayoutClick = false;
let joystickState = null;
let joystickPreviousFitMode = null;
let qualityMode = localStorage.getItem('zephyr-novnc-quality') || 'balanced';
let fitMode = localStorage.getItem('zephyr-novnc-fit') || 'fit';

function initialTheme() {
    const saved = localStorage.getItem('zephyr-theme');
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ? 'dark' : 'light';
}
function applyFrameTheme(theme = initialTheme(), appearance = {}) {
    const normalized = theme === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', normalized);
    applyZephyrColorScheme(appearance || {}, { theme: normalized, page: 'novnc' });
}
applyFrameTheme();

const qualityModes = ['balanced', 'performance', 'quality'];
const fitModes = ['fit', 'original', 'drag'];

function loadParams() {
    const key = tabId ? `zephyr_remote_desktop_params_${tabId}` : 'zephyr_remote_desktop_params';
    try { return JSON.parse(sessionStorage.getItem(key) || '{}'); } catch { return {}; }
}

function notifyParentStatus(status) {
    if (!embeddedMode || !window.parent || window.parent === window) return;
    window.parent.postMessage({ source: 'zephyr-terminal', tabId: params?.tabId || tabId, status }, '*');
}

function notifyParentActivity() {
    if (!embeddedMode || !window.parent || window.parent === window) return;
    window.parent.postMessage({ source: 'zephyr-terminal', type: 'activity', tabId: params?.tabId || tabId }, '*');
}

function notifyParentAiActionResult(actionId, payload = {}) {
    if (!embeddedMode || !window.parent || window.parent === window || !actionId) return;
    window.parent.postMessage({
        source: 'zephyr-terminal',
        type: 'ai-remote-desktop-action-result',
        tabId: params?.tabId || tabId,
        actionId,
        ...payload,
    }, '*');
}

function notifyParentCloseRequest(reason = 'novnc-disconnected') {
    if (!embeddedMode || !window.parent || window.parent === window) return;
    window.parent.postMessage({ source: 'zephyr-terminal', type: 'close-request', tabId: params?.tabId || tabId, reason }, '*');
}

function connectionLabel() {
    const host = params.host || 'VNC';
    const port = params.port || 5900;
    return `${host}:${port}`;
}

function setStatus(state, message = '') {
    const stateForParent = state === 'connected' ? 'connected' : state === 'error' ? 'error' : state === 'disconnected' ? 'closed' : 'connecting';
    notifyParentStatus(stateForParent);
    statusDot.className = 'status-dot';
    statusCard?.classList.remove('connected', 'error', 'connecting');
    if (state === 'connected') {
        connected = true;
        statusDot.classList.add('connected');
        statusCard?.classList.add('connected');
        statusText.textContent = message || t('VNC 已连接');
        overlay.classList.add('hidden');
    } else if (state === 'error') {
        connected = false;
        statusDot.classList.add('disconnected');
        statusCard?.classList.add('error');
        statusText.textContent = t('连接失败');
        overlayTitle.textContent = t('noVNC 连接失败');
        overlayMsg.textContent = message || t('无法建立 VNC 连接');
        overlay.classList.remove('hidden');
    } else if (state === 'disconnected') {
        connected = false;
        statusDot.classList.add('disconnected');
        statusText.textContent = message || t('已断开');
        overlayTitle.textContent = t('连接已断开');
        overlayMsg.textContent = message || t('VNC 连接已断开');
        overlay.classList.remove('hidden');
    } else {
        connected = false;
        statusCard?.classList.add('connecting');
        statusText.textContent = message || t('连接中...');
        overlayTitle.textContent = t('正在建立 noVNC 连接');
        overlayMsg.textContent = message || t('通过 Zephyr 安全代理连接 VNC，密码不会发送到浏览器。');
        overlay.classList.remove('hidden');
    }
}

function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const q = new URLSearchParams({ connectionId: params.connectionId || urlParams.get('connectionId') || '', tabId: params.tabId || tabId });
    return `${proto}//${location.host}/novnc?${q.toString()}`;
}

function qualityConfig(mode = qualityMode) {
    if (mode === 'performance') return { label: t('性能'), quality: 4, compression: 1 };
    if (mode === 'quality') return { label: t('画质'), quality: 9, compression: 6 };
    return { label: t('平衡'), quality: 6, compression: 2 };
}

function fitLabelText(mode = fitMode) {
    if (mode === 'original') return t('原始');
    if (mode === 'drag') return t('拖拽');
    return t('适应');
}

function refreshDisplaySize() {
    if (!rfb) return;
    try {
        rfb.scaleViewport = fitMode === 'fit';
        rfb.clipViewport = fitMode === 'drag';
    } catch {}
}

function applyDisplayOptions() {
    const q = qualityConfig();
    qualityLabel.textContent = q.label;
    fitLabel.textContent = fitLabelText();
    qualityBtn.title = t('当前：{mode}模式，点击切换性能/画质模式', { mode: q.label });
    qualityBtn.dataset.qualityMode = qualityMode;
    qualityBtn.classList.toggle('active', qualityMode !== 'balanced');
    dragBtn.classList.toggle('active', joystickPanel && !joystickPanel.hidden);
    screenShell.classList.toggle('fit-mode', fitMode === 'fit');
    screenShell.classList.toggle('original-mode', fitMode === 'original');
    screenShell.classList.toggle('drag-mode', fitMode === 'drag');
    if (!rfb) return;
    rfb.qualityLevel = q.quality;
    rfb.compressionLevel = q.compression;
    rfb.scaleViewport = fitMode === 'fit';
    rfb.clipViewport = fitMode === 'drag';
    rfb.dragViewport = fitMode === 'drag';
    rfb.resizeSession = false;
    window.requestAnimationFrame(refreshDisplaySize);
}

function clearScreen() {
    try { screen.innerHTML = ''; } catch {}
}

function captureCanvasSnapshotForAi(source, options = {}) {
    if (!source || !source.width || !source.height) return { error: t('当前远程桌面画面还没有可读取的 canvas') };
    const maxWidth = Math.max(320, Math.min(1600, Number(options.maxWidth) || 960));
    const quality = Math.max(0.28, Math.min(0.86, Number(options.quality) || 0.55));
    const scale = Math.min(1, maxWidth / Math.max(1, source.width));
    const width = Math.max(1, Math.round(source.width * scale));
    const height = Math.max(1, Math.round(source.height * scale));
    try {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d', { alpha: false });
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(source, 0, 0, width, height);
        return { dataUrl: canvas.toDataURL('image/jpeg', quality), width, height, originalWidth: source.width, originalHeight: source.height };
    } catch (err) {
        return { error: err.message || String(err) };
    }
}
function getRemoteDesktopSnapshotForAi(options = {}) {
    const source = screen?.querySelector?.('canvas');
    const frameAt = source ? Date.now() : 0;
    if (source) vncLastFrameAt = frameAt;
    const shot = captureCanvasSnapshotForAi(source, options);
    const captureId = [params?.tabId || tabId || 'vnc', frameAt, shot.width || 0, shot.height || 0].map((part) => String(part || 0).replace(/[^A-Za-z0-9_.-]/g, '_')).join(':');
    return {
        protocol: 'VNC',
        tabId: params?.tabId || tabId,
        connectionId: params?.connectionId || '',
        host: params?.host || '',
        port: params?.port || 5900,
        status: statusText?.textContent || '',
        title: connTitle?.textContent || connInfo?.textContent || '',
        connected,
        at: Date.now(),
        frameAt,
        captureId,
        ...shot,
    };
}
window.__zephyrGetRemoteDesktopSnapshot = getRemoteDesktopSnapshotForAi;

async function connect() {
    manualClose = false;
    reconnecting = false;
    params = loadParams();
    if (params.host) connTitle.textContent = `${params.name || t('VNC 远程桌面')} · ${connectionLabel()}`;
    setStatus('connecting', `正在连接 ${connectionLabel()}...`);
    clearScreen();
    try {
        if (rfb) { try { rfb.disconnect(); } catch {} rfb = null; }
        if (!params.connectionId && !urlParams.get('connectionId')) throw new Error(t('缺少 VNC 连接 ID，请从连接列表重新打开'));
        screen.style.width = '100%';
        screen.style.height = '100%';
        rfb = new RFB(screen, wsUrl(), { shared: true, credentials: { password: '' } });
        window.requestAnimationFrame(installDirectTouchFallback);
        rfb.background = 'transparent';
        rfb.focusOnClick = true;
        applyDisplayOptions();
        rfb.addEventListener('connect', () => {
            setStatus('connected', t('VNC 已连接'));
            notifyParentActivity();
            window.setTimeout(() => { refreshDisplaySize(); installDirectTouchFallback(); rfb?.focus?.(); }, 80);
            window.setTimeout(() => { refreshDisplaySize(); installDirectTouchFallback(); }, 320);
        });
        rfb.addEventListener('disconnect', (event) => {
            const clean = event?.detail?.clean;
            const detail = event?.detail?.reason || event?.detail?.message || '';
            const message = clean ? t('VNC 已断开') : (detail ? `VNC 异常断开：${detail}` : t('VNC 异常断开'));
            if (manualClose) {
                setStatus('disconnected', t('VNC 已断开'));
                notifyParentCloseRequest('novnc-disconnect-button');
                return;
            }
            setStatus(clean ? 'disconnected' : 'error', message);
        });
        rfb.addEventListener('securityfailure', (event) => {
            const reason = event?.detail?.reason || t('VNC 安全协商失败');
            setStatus('error', reason);
        });
        rfb.addEventListener('error', (event) => {
            const reason = event?.detail?.message || event?.message || t('noVNC 客户端错误');
            setStatus('error', reason);
        });
        rfb.addEventListener('credentialsrequired', () => {
            console.warn('[novnc-client]', 'unexpected credentials request; proxy should authenticate server-side');
            rfb?.sendCredentials?.({ password: '' });
        });
        rfb.addEventListener('clipboard', (event) => {
            const text = event?.detail?.text || '';
            lastRemoteClipboard = text;
            remoteClipboardText.value = text;
            clipboardHint.textContent = text ? `收到 ${text.length} 字符` : t('收到空剪贴板');
            navigator.clipboard?.writeText?.(text).catch(() => {});
        });
        rfb.addEventListener('desktopname', (event) => {
            const name = event?.detail?.name || '';
            if (name) connTitle.textContent = `${name} · ${connectionLabel()}`;
        });
        rfb.addEventListener('bell', () => {
            stage.classList.add('bell');
            window.setTimeout(() => stage.classList.remove('bell'), 280);
        });
    } catch (err) {
        setStatus('error', err.message || t('noVNC 初始化失败'));
    }
}

function disconnect({ closeTab = false } = {}) {
    manualClose = closeTab;
    try { rfb?.disconnect?.(); } catch {}
    if (closeTab) {
        setStatus('disconnected', t('VNC 已断开'));
        notifyParentCloseRequest('novnc-disconnect-button');
    }
}

function reconnect() {
    reconnecting = true;
    manualClose = false;
    setStatus('connecting', `正在重连 ${connectionLabel()}...`);
    try { rfb?.disconnect?.(); } catch {}
    window.setTimeout(connect, 260);
}

function cycleQuality(mode = '') {
    const next = qualityModes.includes(String(mode || '')) ? String(mode) : qualityModes[(qualityModes.indexOf(qualityMode) + 1) % qualityModes.length];
    qualityMode = next;
    localStorage.setItem('zephyr-novnc-quality', qualityMode);
    applyDisplayOptions();
    qualityBtn.classList.add('active', 'pressing');
    window.clearTimeout(qualityBtn._qualityPressTimer);
    qualityBtn._qualityPressTimer = window.setTimeout(() => qualityBtn.classList.remove('pressing'), 180);
    if (connected) setStatus('connected', `VNC ${qualityConfig().label}模式`);
}

function cycleFit(mode = '') {
    let next = String(mode || '').toLowerCase();
    if (next === '1:1') next = 'original';
    fitMode = fitModes.includes(next) ? next : fitModes[(fitModes.indexOf(fitMode) + 1) % fitModes.length];
    localStorage.setItem('zephyr-novnc-fit', fitMode);
    applyDisplayOptions();
}

function toggleDragMode() {
    fitMode = fitMode === 'drag' ? 'fit' : 'drag';
    localStorage.setItem('zephyr-novnc-fit', fitMode);
    applyDisplayOptions();
}

function floatingPanels() {
    return [clipboardPanel, shortcutsPanel, joystickPanel].filter(Boolean);
}
function isCompactScreen() {
    return Math.min(window.innerWidth, window.innerHeight) <= 700;
}
function panelDefaults(panel) {
    const parent = stage?.getBoundingClientRect?.() || { width: window.innerWidth, height: window.innerHeight };
    if (isCompactScreen()) {
        if (panel === joystickPanel) return { left: 10, top: Math.max(48, parent.height - 274), width: Math.min(300, parent.width - 20), height: 248 };
        return { left: 8, top: 44, width: Math.max(280, parent.width - 16), height: Math.max(260, Math.min(parent.height - 58, panel === shortcutsPanel ? 360 : 430)) };
    }
    if (panel === shortcutsPanel) return { width: Math.min(460, parent.width - 24), height: Math.min(360, parent.height - 80), left: 18, top: 54 };
    if (panel === joystickPanel) return { width: 286, height: 244, left: 18, top: Math.max(60, parent.height - 270) };
    return { width: Math.min(440, parent.width - 24), height: Math.min(500, parent.height - 80), left: Math.max(18, parent.width - 460), top: 54 };
}
function ensurePanelPosition(panel) {
    if (!panel || panel.dataset.floatingReady === '1') return;
    const d = panelDefaults(panel);
    Object.assign(panel.style, { left: `${d.left}px`, top: `${d.top}px`, right: 'auto', bottom: 'auto', width: `${d.width}px`, height: `${d.height}px` });
    panel.dataset.floatingReady = '1';
}
function clampPanel(panel) {
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const parent = stage.getBoundingClientRect();
    const minVisible = isCompactScreen() ? 140 : 80;
    const left = Math.min(Math.max(rect.left - parent.left, -rect.width + minVisible), parent.width - minVisible);
    const top = Math.min(Math.max(rect.top - parent.top, 8), parent.height - minVisible);
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
}
function bringPanelToFront(panel) {
    if (!panel) return;
    const wasFront = panel.classList.contains('front');
    floatingPanels().forEach((item) => {
        item.classList.remove('front');
        if (item !== panel) item.classList.remove('front-switching');
    });
    panel.classList.add('front');
    if (!wasFront) {
        panel.classList.remove('front-switching');
        void panel.offsetWidth;
        panel.classList.add('front-switching');
        window.clearTimeout(panel._frontSwitchTimer);
        panel._frontSwitchTimer = window.setTimeout(() => panel.classList.remove('front-switching'), 360);
    }
}
function animatePanelFromButton(panel, button, opening = true) {
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
function clearPanelMotion(panel) { panel?.classList.remove('panel-opening', 'panel-closing'); }
function panelButton(panel) {
    if (panel === clipboardPanel) return clipboardBtn;
    if (panel === shortcutsPanel) return shortcutsBtn;
    if (panel === joystickPanel) return dragBtn;
    return null;
}
function syncPanelButtons() {
    clipboardBtn?.classList.toggle('active', clipboardPanel && !clipboardPanel.hidden);
    shortcutsBtn?.classList.toggle('active', shortcutsPanel && !shortcutsPanel.hidden);
    dragBtn?.classList.toggle('active', joystickPanel && !joystickPanel.hidden);
}
function togglePanel(panel, force, sourceButton = null) {
    if (!panel) return;
    ensurePanelPosition(panel);
    const shouldShow = force ?? panel.hidden;
    if (panel === joystickPanel) {
        if (shouldShow && fitMode !== 'drag') {
            joystickPreviousFitMode = fitMode;
            fitMode = 'drag';
            localStorage.setItem('zephyr-novnc-fit', fitMode);
            applyDisplayOptions();
        } else if (!shouldShow && joystickPreviousFitMode && fitMode === 'drag') {
            fitMode = joystickPreviousFitMode;
            joystickPreviousFitMode = null;
            localStorage.setItem('zephyr-novnc-fit', fitMode);
            applyDisplayOptions();
        }
    }
    panel.hidden = !shouldShow;
    panel.classList.toggle('open', shouldShow);
    syncPanelButtons();
    applyDisplayOptions();
    const button = sourceButton || panelButton(panel);
    requestAnimationFrame(() => animatePanelFromButton(panel, button, shouldShow));
    if (shouldShow) bringPanelToFront(panel);
    else {
        closePanelLayoutMenu({ instant: true });
        window.setTimeout(() => clearPanelMotion(panel), 320);
    }
}
function openPanel(panel) { togglePanel(panel, undefined, panelButton(panel)); }
function closePanel(id) {
    const panel = document.getElementById(id);
    if (panel) togglePanel(panel, false, panelButton(panel));
}
function applyPanelLayout(panel, layout) {
    if (!panel) return;
    const parent = stage.getBoundingClientRect();
    const margin = isCompactScreen() ? 6 : 12;
    const topbar = isCompactScreen() ? 38 : 52;
    let left = margin, top = topbar, width = parent.width - margin * 2, height = parent.height - topbar - margin;
    if (layout === 'half') { width = parent.width; height = Math.max(260, parent.height / 2); left = 0; top = parent.height - height; }
    else if (layout === 'left-quarter') { width = Math.max(260, parent.width / 4); height = parent.height - topbar; left = 0; top = topbar; }
    else if (layout === 'right-quarter') { width = Math.max(260, parent.width / 4); height = parent.height - topbar; left = parent.width - width; top = topbar; }
    panel.classList.add('layout-animating');
    window.clearTimeout(panel._layoutAnimationTimer);
    Object.assign(panel.style, { left: `${left}px`, top: `${top}px`, right: 'auto', bottom: 'auto', width: `${width}px`, height: `${height}px` });
    bringPanelToFront(panel);
    panel._layoutAnimationTimer = window.setTimeout(() => { panel.classList.remove('layout-animating'); clampPanel(panel); }, 480);
}
function positionPanelLayoutMenu(menu, button, { collapsed = false } = {}) {
    if (!menu || !button) return;
    const rect = button.getBoundingClientRect();
    const viewport = window.visualViewport;
    const vvWidth = viewport?.width || window.innerWidth;
    const anchorX = rect.left + rect.width / 2;
    const finalWidth = Math.min(284, Math.max(160, vvWidth - 16));
    const finalLeft = anchorX - finalWidth / 2;
    menu.style.left = `${collapsed ? rect.left : finalLeft}px`;
    menu.style.top = `${rect.top}px`;
    menu.style.setProperty('--panel-island-menu-width', `${collapsed ? rect.width : finalWidth}px`);
    menu.style.setProperty('--panel-island-menu-height', `${collapsed ? rect.height : 50}px`);
    menu.style.setProperty('--panel-island-radius', `${Math.round((collapsed ? rect.height : 36) / 2)}px`);
    menu.dataset.placement = 'inline';
}
function closePanelLayoutMenu({ instant = false } = {}) {
    const menu = panelLayoutMenu;
    const button = panelLayoutButton;
    if (!menu) { button?.classList.remove('active-layout'); panelLayoutButton = null; return; }
    window.clearTimeout(menu._closeTimer);
    if (instant || !button?.isConnected) {
        button?.classList.remove('active-layout'); button?.style.removeProperty('opacity'); menu.remove(); panelLayoutMenu = null; panelLayoutButton = null; return;
    }
    menu.style.transition = 'none';
    positionPanelLayoutMenu(menu, button, { collapsed: false });
    menu.style.opacity = '1';
    void menu.offsetWidth;
    menu.classList.remove('island-open');
    menu.classList.add('island-closing', 'island-animating');
    button.classList.remove('active-layout');
    button.style.opacity = '0';
    requestAnimationFrame(() => { menu.style.removeProperty('transition'); positionPanelLayoutMenu(menu, button, { collapsed: true }); });
    menu._closeTimer = window.setTimeout(() => {
        button.classList.remove('active-layout'); button.style.opacity = '1'; requestAnimationFrame(() => button.style.removeProperty('opacity')); menu.remove();
        if (panelLayoutMenu === menu) panelLayoutMenu = null;
        if (panelLayoutButton === button) panelLayoutButton = null;
    }, 460);
}
function openPanelLayoutMenu(button, panel) {
    closePanelLayoutMenu({ instant: true });
    panelLayoutButton = button;
    const menu = document.createElement('div');
    menu.className = 'panel-layout-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', t('窗口布局'));
    menu.innerHTML = `<button data-layout="full" title="${t('全屏')}" aria-label="${t('全屏')}"><span class="panel-layout-icon full"></span></button><button data-layout="half" title="${t('半屏')}" aria-label="${t('半屏')}"><span class="panel-layout-icon half"></span></button><button data-layout="left-quarter" title="${t('左侧四分之一')}" aria-label="${t('左侧四分之一')}"><span class="panel-layout-icon left"></span></button><button data-layout="right-quarter" title="${t('右侧四分之一')}" aria-label="${t('右侧四分之一')}"><span class="panel-layout-icon right"></span></button><button data-layout="close" class="panel-layout-close" title="${t('关闭窗口')}" aria-label="${t('关闭窗口')}"><span class="panel-layout-icon close"></span></button>`;
    menu.style.transition = 'none';
    document.body.appendChild(menu);
    panelLayoutMenu = menu;
    positionPanelLayoutMenu(menu, button, { collapsed: true });
    button.style.opacity = '0';
    menu.style.opacity = '1';
    menu.classList.add('island-animating');
    void menu.offsetWidth;
    requestAnimationFrame(() => {
        menu.style.removeProperty('transition');
        menu.classList.add('island-open');
        positionPanelLayoutMenu(menu, button, { collapsed: false });
        window.setTimeout(() => { menu.classList.remove('island-animating'); menu.style.removeProperty('opacity'); }, 540);
    });
    menu.addEventListener('click', (event) => {
        const item = event.target.closest('[data-layout]');
        if (!item) return;
        if (item.dataset.layout === 'close') togglePanel(panel, false);
        else { applyPanelLayout(panel, item.dataset.layout); closePanelLayoutMenu(); }
    });
}
function setupPanelLayoutMenu() {
    document.querySelectorAll('[data-layout-panel]').forEach((button) => {
        const panel = document.getElementById(button.dataset.layoutPanel);
        if (!panel || button.dataset.novncLayoutReady === '1') return;
        button.dataset.novncLayoutReady = '1';
        button.addEventListener('pointerdown', (event) => {
            event.preventDefault(); event.stopPropagation(); bringPanelToFront(panel); button.classList.add('pressing'); button.setPointerCapture?.(event.pointerId);
            const start = { x: event.clientX, y: event.clientY, left: panel.offsetLeft, top: panel.offsetTop };
            let moved = false;
            const move = (ev) => {
                ev.preventDefault();
                const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
                if (!moved && Math.hypot(dx, dy) > 7) { moved = true; closePanelLayoutMenu({ instant: true }); panel.classList.add('dragging'); }
                if (!moved) return;
                panel.style.left = `${start.left + dx}px`; panel.style.top = `${start.top + dy}px`; panel.style.right = 'auto'; panel.style.bottom = 'auto'; clampPanel(panel);
            };
            const up = () => { panel.classList.remove('dragging'); button.classList.remove('pressing'); suppressNextLayoutClick = moved; window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); };
            window.addEventListener('pointermove', move, { passive: false });
            window.addEventListener('pointerup', up, { once: true });
            window.addEventListener('pointercancel', up, { once: true });
        });
        button.addEventListener('click', (event) => {
            event.preventDefault(); event.stopPropagation();
            if (suppressNextLayoutClick) { suppressNextLayoutClick = false; return; }
            bringPanelToFront(panel);
            if (navigator.vibrate) navigator.vibrate(8);
            if (panelLayoutMenu && panelLayoutButton === button) closePanelLayoutMenu(); else openPanelLayoutMenu(button, panel);
        });
    });
    document.addEventListener('pointerdown', (event) => {
        if (panelLayoutMenu && !event.target.closest('.panel-layout-menu') && !event.target.closest('[data-layout-panel]')) closePanelLayoutMenu();
    });
}
function setupPanelDrag() {
    const handles = [...document.querySelectorAll('[data-drag-panel]'), ...document.querySelectorAll('.novnc-panel .panel-titlebar')];
    handles.forEach((handle) => {
        const panel = handle.dataset.dragPanel ? document.getElementById(handle.dataset.dragPanel) : handle.closest('.novnc-panel');
        if (!panel || handle.dataset.novncDragReady === '1') return;
        handle.dataset.novncDragReady = '1';
        handle.addEventListener('pointerdown', (event) => {
            if (event.target.closest('button,input,select,textarea,label')) return;
            event.preventDefault(); bringPanelToFront(panel); panel.classList.add('dragging'); handle.setPointerCapture?.(event.pointerId);
            const start = { x: event.clientX, y: event.clientY, left: panel.offsetLeft, top: panel.offsetTop };
            const move = (ev) => { ev.preventDefault(); panel.style.left = `${start.left + ev.clientX - start.x}px`; panel.style.top = `${start.top + ev.clientY - start.y}px`; panel.style.right = 'auto'; panel.style.bottom = 'auto'; clampPanel(panel); };
            const up = () => { panel.classList.remove('dragging'); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
            window.addEventListener('pointermove', move, { passive: false });
            window.addEventListener('pointerup', up, { once: true });
        });
    });
}
function setupPanelResize() {
    document.querySelectorAll('[data-resize-panel]').forEach((handle) => {
        const panel = document.getElementById(handle.dataset.resizePanel);
        if (!panel || handle.dataset.novncResizeReady === '1') return;
        handle.dataset.novncResizeReady = '1';
        handle.addEventListener('pointerdown', (event) => {
            event.preventDefault(); event.stopPropagation(); bringPanelToFront(panel); panel.classList.add('resizing'); handle.setPointerCapture?.(event.pointerId);
            const start = { x: event.clientX, y: event.clientY, width: panel.offsetWidth, height: panel.offsetHeight, left: panel.offsetLeft };
            const edge = handle.dataset.resizeEdge || 'right';
            const parent = stage.getBoundingClientRect();
            const minWidth = isCompactScreen() ? 260 : 320;
            const minHeight = isCompactScreen() ? 220 : 260;
            const move = (ev) => {
                ev.preventDefault();
                let width = start.width + ev.clientX - start.x;
                let left = start.left;
                if (edge === 'left') { width = start.width - (ev.clientX - start.x); left = start.left + (ev.clientX - start.x); if (width < minWidth) { left -= minWidth - width; width = minWidth; } panel.style.left = `${Math.max(8, left)}px`; }
                panel.style.width = `${Math.min(Math.max(minWidth, width), parent.width - panel.offsetLeft - 12)}px`;
                panel.style.height = `${Math.min(Math.max(minHeight, start.height + ev.clientY - start.y), parent.height - panel.offsetTop - 12)}px`;
            };
            const up = () => { panel.classList.remove('resizing'); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
            window.addEventListener('pointermove', move, { passive: false });
            window.addEventListener('pointerup', up, { once: true });
        });
    });
}
function setupViewportJoystick() {
    if (!joystickContainer || !joystickKnob || joystickContainer.dataset.ready === '1') return;
    joystickContainer.dataset.ready = '1';
    const icons = joystickContainer.querySelectorAll('.rdp-joystick-icon');
    const maxRadius = 24;
    const deadzone = 4;
    const maxTilt = 14;
    let active = false, startX = 0, startY = 0, raf = 0, resetTimer = 0;
    const clearHighlights = () => icons.forEach((icon) => icon.classList.remove('active'));
    const applyVisual = (x, y) => {
        const clampedX = Math.min(Math.max(x, -maxRadius), maxRadius);
        const clampedY = Math.min(Math.max(y, -maxRadius), maxRadius);
        const distance = Math.hypot(clampedX, clampedY);
        const normX = distance > .01 ? clampedX / maxRadius : 0;
        const normY = distance > .01 ? clampedY / maxRadius : 0;
        joystickKnob.style.transform = `translate(${clampedX}px, ${clampedY}px) rotateX(${normY * -maxTilt}deg) rotateY(${normX * maxTilt}deg)`;
        if (distance < deadzone) { clearHighlights(); return { x: 0, y: 0, intensity: 0 }; }
        const angleDeg = (Math.atan2(normY, normX) * 180 / Math.PI + 360) % 360;
        const activeIndex = angleDeg >= 45 && angleDeg < 135 ? 2 : angleDeg >= 135 && angleDeg < 225 ? 3 : angleDeg >= 225 && angleDeg < 315 ? 0 : 1;
        clearHighlights(); icons[activeIndex]?.classList.add('active');
        return { x: normX, y: normY, intensity: Math.min(distance / maxRadius, 1) };
    };
    const reset = (smooth = true) => {
        if (raf) cancelAnimationFrame(raf); raf = 0;
        if (smooth) joystickKnob.classList.add('smooth-back');
        joystickKnob.style.transform = 'translate(0px, 0px) rotateX(0deg) rotateY(0deg)';
        clearHighlights(); window.clearTimeout(resetTimer); resetTimer = window.setTimeout(() => joystickKnob.classList.remove('smooth-back'), 220); joystickState = null;
    };
    const pump = () => {
        if (!active || !joystickState || !screenShell) { raf = 0; return; }
        const speed = 4 + 24 * joystickState.intensity;
        if (rfb?._display?.viewportChangePos) {
            rfb._display.viewportChangePos(joystickState.x * speed, joystickState.y * speed);
        } else {
            const maxX = Math.max(0, screenShell.scrollWidth - screenShell.clientWidth);
            const maxY = Math.max(0, screenShell.scrollHeight - screenShell.clientHeight);
            screenShell.scrollLeft = Math.max(0, Math.min(maxX, screenShell.scrollLeft + joystickState.x * speed));
            screenShell.scrollTop = Math.max(0, Math.min(maxY, screenShell.scrollTop + joystickState.y * speed));
        }
        raf = requestAnimationFrame(pump);
    };
    const move = (event) => {
        if (!active) return;
        event.preventDefault();
        const dx = event.clientX - startX, dy = event.clientY - startY, dist = Math.hypot(dx, dy);
        joystickState = applyVisual(dist > maxRadius ? dx / dist * maxRadius : dx, dist > maxRadius ? dy / dist * maxRadius : dy);
        if (!raf) raf = requestAnimationFrame(pump);
    };
    const end = () => { if (!active) return; active = false; window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end); reset(true); };
    joystickKnob.addEventListener('pointerdown', (event) => {
        event.preventDefault(); event.stopPropagation(); bringPanelToFront(joystickPanel); active = true; startX = event.clientX; startY = event.clientY; window.clearTimeout(resetTimer); joystickKnob.classList.remove('smooth-back'); joystickState = applyVisual(0, 0);
        window.addEventListener('pointermove', move, { passive: false }); window.addEventListener('pointerup', end, { once: true }); window.addEventListener('pointercancel', end, { once: true }); joystickKnob.setPointerCapture?.(event.pointerId);
    });
    joystickContainer.addEventListener('dragstart', (event) => event.preventDefault());
    window.addEventListener('blur', () => { if (active) { active = false; reset(true); } });
    reset(false);
}
function setupFloatingPanels() {
    setupViewportJoystick();
    floatingPanels().forEach((panel) => { ensurePanelPosition(panel); panel.addEventListener('pointerdown', () => bringPanelToFront(panel)); });
    setupPanelLayoutMenu();
    setupPanelDrag();
    setupPanelResize();
}

function sendKey(keysym, code = '', down = undefined) {
    if (!rfb || !connected) return;
    rfb.sendKey(keysym, code, down);
    notifyParentActivity();
}
function tapKey(keysym, code = '') { sendKey(keysym, code); }
function down(keysym, code = '') { sendKey(keysym, code, true); }
function up(keysym, code = '') { sendKey(keysym, code, false); }
function currentCanvas() { return screen?.querySelector?.('canvas') || null; }
function touchToCanvasPoint(touch, canvas = currentCanvas()) {
    const rect = canvas?.getBoundingClientRect?.();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    return { x: Math.max(0, Math.min(rect.width - 1, Number(touch.clientX) - rect.left)), y: Math.max(0, Math.min(rect.height - 1, Number(touch.clientY) - rect.top)), rect };
}
function dispatchCanvasMouse(canvas, type, point, button = 0, buttons = 0) {
    if (!canvas || !point) return;
    canvas.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: point.rect.left + point.x, clientY: point.rect.top + point.y, button, buttons }));
}
function installDirectTouchFallback() {
    const canvas = currentCanvas();
    if (!canvas || canvas.dataset.zephyrTouchFallback === '1') return;
    canvas.dataset.zephyrTouchFallback = '1';
    let state = null;
    canvas.addEventListener('touchstart', (event) => {
        if (event.defaultPrevented || !connected || fitMode === 'drag' || event.touches.length !== 1) return;
        const point = touchToCanvasPoint(event.touches[0], canvas);
        if (!point) return;
        state = { id: event.touches[0].identifier, start: point, last: point, moved: false, at: Date.now() };
    }, { passive: true });
    canvas.addEventListener('touchmove', (event) => {
        if (!state || fitMode === 'drag') return;
        const touch = Array.from(event.changedTouches || []).find((item) => item.identifier === state.id);
        if (!touch) return;
        const point = touchToCanvasPoint(touch, canvas);
        if (!point) return;
        if (Math.hypot(point.x - state.start.x, point.y - state.start.y) > 8) state.moved = true;
        state.last = point;
    }, { passive: true });
    canvas.addEventListener('touchend', (event) => {
        if (!state || fitMode === 'drag') { state = null; return; }
        const touch = Array.from(event.changedTouches || []).find((item) => item.identifier === state.id);
        if (!touch) return;
        const point = touchToCanvasPoint(touch, canvas) || state.last;
        const isTap = !state.moved && Date.now() - state.at < 700;
        state = null;
        if (!isTap || !point) return;
        dispatchCanvasMouse(canvas, 'mousemove', point, 0, 0);
        dispatchCanvasMouse(canvas, 'mousedown', point, 0, 1);
        window.setTimeout(() => { dispatchCanvasMouse(canvas, 'mouseup', point, 0, 0); dispatchCanvasMouse(canvas, 'click', point, 0, 0); }, 18);
        notifyParentActivity();
    }, { passive: true });
    canvas.addEventListener('touchcancel', () => { state = null; }, { passive: true });
}
function charKeysym(ch) {
    if (!ch) return 0;
    const code = ch.codePointAt(0);
    if (code >= 0x20 && code <= 0xff) return code;
    return 0;
}
function sendText(text) {
    if (!text || !rfb || !connected) return;
    const value = String(text);
    if (/[^\u0008\u0009\u000a\u000d\u0020-\u00ff]/.test(value) || value.length > 24) {
        rfb.clipboardPasteFrom(value);
        clipboardHint.textContent = t('已发送 {count} 字符到远程剪贴板，请在远程粘贴', { count: value.length });
        return;
    }
    for (const ch of value) {
        if (ch === '\n' || ch === '\r') tapKey(KeyTable.XK_Return, 'Enter');
        else if (ch === '\t') tapKey(KeyTable.XK_Tab, 'Tab');
        else if (ch === '\b') tapKey(KeyTable.XK_BackSpace, 'Backspace');
        else {
            const ks = charKeysym(ch);
            if (ks) tapKey(ks, '');
            else rfb.clipboardPasteFrom(ch);
        }
    }
}
function sendSequence(seq) {
    const s = String(seq || '').toLowerCase();
    const special = {
        esc: [KeyTable.XK_Escape, 'Escape'], tab: [KeyTable.XK_Tab, 'Tab'], enter: [KeyTable.XK_Return, 'Enter'], backspace: [KeyTable.XK_BackSpace, 'Backspace'], delete: [KeyTable.XK_Delete, 'Delete'],
        up: [KeyTable.XK_Up, 'ArrowUp'], down: [KeyTable.XK_Down, 'ArrowDown'], left: [KeyTable.XK_Left, 'ArrowLeft'], right: [KeyTable.XK_Right, 'ArrowRight'],
        home: [KeyTable.XK_Home, 'Home'], end: [KeyTable.XK_End, 'End'], pageup: [KeyTable.XK_Page_Up, 'PageUp'], pagedown: [KeyTable.XK_Page_Down, 'PageDown'],
        super: [KeyTable.XK_Super_L, 'MetaLeft'], win: [KeyTable.XK_Super_L, 'MetaLeft'],
    };
    if (s === 'ctrl-alt-del') { rfb?.sendCtrlAltDel?.(); return; }
    if (s === 'alt-tab') { down(KeyTable.XK_Alt_L, 'AltLeft'); tapKey(KeyTable.XK_Tab, 'Tab'); up(KeyTable.XK_Alt_L, 'AltLeft'); return; }
    if (s === 'win-r') { down(KeyTable.XK_Super_L, 'MetaLeft'); tapKey('r'.charCodeAt(0), 'KeyR'); up(KeyTable.XK_Super_L, 'MetaLeft'); return; }
    const fn = s.match(/^f(\d{1,2})$/);
    if (fn) { const n = Number(fn[1]); if (n >= 1 && n <= 12) tapKey(KeyTable[`XK_F${n}`], `F${n}`); return; }
    const ctrl = s.match(/^ctrl-([a-z])$/);
    if (ctrl) { const letter = ctrl[1]; down(KeyTable.XK_Control_L, 'ControlLeft'); tapKey(letter.charCodeAt(0), `Key${letter.toUpperCase()}`); up(KeyTable.XK_Control_L, 'ControlLeft'); return; }
    if (special[s]) tapKey(special[s][0], special[s][1]);
}
function focusMobileKeyboard() {
    mobileKeyboardInput.value = '';
    mobileKeyboardInput.focus({ preventScroll: true });
}
function setupMobileInput() {
    mobileKeyboardInput.addEventListener('compositionstart', () => { mobileComposing = true; });
    mobileKeyboardInput.addEventListener('compositionend', (event) => { mobileComposing = false; sendText(event.data || mobileKeyboardInput.value || ''); mobileKeyboardInput.value = ''; });
    mobileKeyboardInput.addEventListener('beforeinput', (event) => { if (event.inputType?.startsWith('delete')) { event.preventDefault(); tapKey(KeyTable.XK_BackSpace, 'Backspace'); } });
    mobileKeyboardInput.addEventListener('input', () => { if (mobileComposing) return; const value = mobileKeyboardInput.value; if (value) sendText(value); mobileKeyboardInput.value = ''; });
}
function setupClipboard() {
    clipboardSendBtn.addEventListener('click', () => { if (!rfb || !connected) return; const text = clipboardText.value || ''; rfb.clipboardPasteFrom(text); clipboardHint.textContent = t('已发送 {count} 字符到远程剪贴板', { count: text.length }); });
    clipboardReadLocalBtn.addEventListener('click', async () => { try { clipboardText.value = await navigator.clipboard.readText(); } catch (err) { clipboardHint.textContent = err.message || t('读取本机剪贴板失败'); } });
    clipboardCopyRemoteBtn.addEventListener('click', async () => { try { await navigator.clipboard.writeText(remoteClipboardText.value || lastRemoteClipboard || ''); clipboardHint.textContent = t('已复制到本机剪贴板'); } catch (err) { clipboardHint.textContent = err.message || t('复制失败'); } });
    window.addEventListener('paste', (event) => { if (!connected || document.activeElement === clipboardText || document.activeElement === remoteClipboardText) return; const text = event.clipboardData?.getData('text/plain') || ''; if (text) { event.preventDefault(); sendText(text); } });
}

function sleep(ms = 0) { return new Promise((resolve) => window.setTimeout(resolve, Math.max(0, Number(ms) || 0))); }

async function clickRemotePoint(x, y, button = 1) {
    const canvas = screen?.querySelector?.('canvas');
    const target = canvas || screen;
    const rect = target?.getBoundingClientRect?.();
    if (!target || !rect || rect.width <= 0 || rect.height <= 0) return false;
    const remoteWidth = canvas?.width || rect.width;
    const remoteHeight = canvas?.height || rect.height;
    const clientX = rect.left + Math.max(0, Math.min(remoteWidth - 1, Number(x) || 0)) * rect.width / Math.max(1, remoteWidth);
    const clientY = rect.top + Math.max(0, Math.min(remoteHeight - 1, Number(y) || 0)) * rect.height / Math.max(1, remoteHeight);
    const btn = Math.max(0, Math.min(2, Number(button || 1) - 1));
    ['mousemove', 'mousedown', 'mouseup', 'click'].forEach((type) => {
        target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX, clientY, button: btn, buttons: type === 'mousedown' ? (1 << btn) : 0 }));
    });
    notifyParentActivity();
    return true;
}

async function performAiRemoteDesktopAction(data = {}) {
    const control = String(data.control || '').toLowerCase().replace(/-/g, '_');
    const text = String(data.text || '');
    if (data.captureId) {
        const current = getRemoteDesktopSnapshotForAi({ maxWidth: Number(data.screenshotWidth) || 960, quality: 0.42 });
        if (String(data.captureId) !== String(current.captureId || '')) throw Object.assign(new Error(t('VNC 画面已变化，请重新截图后再操作')), { code: 'stale_capture' });
    }
    if (control === 'quality') { cycleQuality(data.qualityMode || ''); return { ok: true, control, qualityMode }; }
    if (control === 'fit') { cycleFit(data.fitMode || ''); return { ok: true, control, fitMode }; }
    if (control === 'joystick' || control === 'drag') { togglePanel(joystickPanel, true, dragBtn); return { ok: true, control, panel: 'joystick' }; }
    if (control === 'clipboard') { togglePanel(clipboardPanel, true, clipboardBtn); clipboardText?.focus?.(); return { ok: true, control, panel: 'clipboard' }; }
    if (control === 'keyboard') { focusMobileKeyboard(); return { ok: true, control }; }
    if (control === 'shortcuts') { togglePanel(shortcutsPanel, true, shortcutsBtn); return { ok: true, control, panel: 'shortcuts' }; }
    if (control === 'ctrl_alt_del' || control === 'cad') { rfb?.sendCtrlAltDel?.(); notifyParentActivity(); return { ok: true, control: 'ctrl_alt_del' }; }
    if (control === 'reconnect') { reconnect(); return { ok: true, control }; }
    if (control === 'disconnect') { disconnect({ closeTab: true }); return { ok: true, control }; }
    if (control === 'clipboard_read_local') {
        try { clipboardText.value = await navigator.clipboard.readText(); clipboardHint.textContent = t('已读取本机剪贴板'); return { ok: true, control, length: clipboardText.value.length }; }
        catch (err) { clipboardHint.textContent = err.message || t('读取本机剪贴板失败'); throw err; }
    }
    if (control === 'clipboard_copy_remote') {
        try { const value = remoteClipboardText.value || lastRemoteClipboard || ''; await navigator.clipboard.writeText(value); clipboardHint.textContent = t('已复制到本机剪贴板'); return { ok: true, control, length: value.length }; }
        catch (err) { clipboardHint.textContent = err.message || t('复制失败'); throw err; }
    }
    if (control === 'clipboard_send') {
        if (!rfb || !connected) throw new Error(t('VNC 尚未连接，无法发送剪贴板'));
        if (clipboardText && text) clipboardText.value = text;
        const value = text || clipboardText?.value || '';
        if (!value) throw new Error(t('VNC 剪贴板文本为空'));
        rfb.clipboardPasteFrom(value);
        clipboardHint.textContent = t('已发送 {count} 字符到远程剪贴板', { count: value.length });
        if (data.paste !== false) { await sleep(80); sendSequence('ctrl-v'); }
        return { ok: true, control, length: value.length, paste: data.paste !== false };
    }
    if (control === 'shortcut') {
        if (!rfb || !connected) throw new Error(t('VNC 尚未连接，无法发送快捷键'));
        sendSequence(data.sequence || text);
        return { ok: true, control, sequence: data.sequence || text || '' };
    }
    if (control === 'text') {
        if (!rfb || !connected) throw new Error(t('VNC 尚未连接，无法输入文本'));
        if (!text) throw new Error(t('VNC 输入文本为空'));
        if (data.paste !== false) {
            rfb?.clipboardPasteFrom?.(text);
            clipboardHint.textContent = t('已发送 {count} 字符到远程剪贴板', { count: text.length });
            await sleep(80);
            sendSequence('ctrl-v');
        } else sendText(text);
        return { ok: true, control, length: text.length, paste: data.paste !== false };
    }
    if (control === 'mouse_click') {
        const x = Math.round(Number(data.x));
        const y = Math.round(Number(data.y));
        const button = Number(data.button) || 1;
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(t('AI 远程桌面点击缺少 x/y'));
        const ok = await clickRemotePoint(x, y, button);
        if (!ok) throw new Error(t('远程画面尚未准备好，无法点击坐标'));
        clipboardHint.textContent = t('AI 已点击 {x}, {y}', { x, y });
        return { ok: true, control, x, y, button };
    }
    throw new Error(t('未知远程桌面 UI 动作：{action}', { action: control }));
}

function bindEvents() {
    qualityBtn.addEventListener('click', () => cycleQuality());
    fitBtn.addEventListener('click', () => cycleFit());
    dragBtn.addEventListener('click', () => togglePanel(joystickPanel, undefined, dragBtn));
    clipboardBtn.addEventListener('click', () => togglePanel(clipboardPanel, undefined, clipboardBtn));
    shortcutsBtn.addEventListener('click', () => togglePanel(shortcutsPanel, undefined, shortcutsBtn));
    keyboardBtn.addEventListener('click', focusMobileKeyboard);
    cadBtn.addEventListener('click', () => rfb?.sendCtrlAltDel?.());
    reconnectBtn.addEventListener('click', reconnect);
    disconnectBtn.addEventListener('click', () => disconnect({ closeTab: true }));
    /* Notes button: postMessage to parent (app.js) to open notes filtered
     * by the current connection, same as SSH terminal. */
    const notesBtn = $('#notesBtn');
    notesBtn?.addEventListener('click', () => {
        if (embeddedMode && window.parent && window.parent !== window) {
            window.parent.postMessage({
                source: 'zephyr-terminal',
                type: 'open-notes-for-connection',
                tabId: params?.tabId || tabId,
                connectionId: params?.connectionId || urlParams.get('connectionId') || '',
            }, '*');
        }
    });
    shortcutGrid.addEventListener('click', (event) => {
        const btn = event.target.closest('[data-keyseq]');
        if (btn) sendSequence(btn.dataset.keyseq);
    });
    document.addEventListener('click', (event) => {
        const close = event.target.closest('[data-close-panel]');
        if (close) closePanel(close.dataset.closePanel);
    });
    document.addEventListener('pointerdown', (event) => {
        if (panelLayoutMenu && !event.target.closest('.panel-layout-menu') && !event.target.closest('[data-layout-panel]')) closePanelLayoutMenu();
    });
    window.addEventListener('resize', () => { closePanelLayoutMenu({ instant: true }); refreshDisplaySize(); });
    screenShell.addEventListener('pointerdown', () => { rfb?.focus?.(); notifyParentActivity(); }, { passive: true });
    stage.addEventListener('keydown', (event) => {
        if (event.ctrlKey && event.altKey && event.key === 'Delete') { event.preventDefault(); rfb?.sendCtrlAltDel?.(); }
    });
    window.addEventListener('message', (event) => {
        if (event.data?.source !== 'zephyr-app') return;
        if (event.data.type === 'theme-change') applyFrameTheme(event.data.theme, event.data.appearance || {});
        if (event.data.type === 'reconnect-terminal') reconnect();
        if (event.data.type === 'focus-terminal') rfb?.focus?.();
        if (event.data.type === 'notes-enabled') {
            const notesBtn = $('#notesBtn');
            if (notesBtn) {
                notesBtn.classList.toggle('force-hidden', !event.data.enabled);
                notesBtn.hidden = !event.data.enabled;
            }
        }
        if (event.data.type === 'ai-remote-desktop-action') {
            const actionId = String(event.data.actionId || '');
            performAiRemoteDesktopAction(event.data).then((result = {}) => {
                notifyParentAiActionResult(actionId, { ok: true, control: event.data?.control || '', result });
            }).catch((err) => {
                console.warn('[novnc-client]', 'AI remote desktop action failed', { error: err.message, control: event.data?.control });
                clipboardHint.textContent = err.message || t('AI 远程桌面操作失败');
                notifyParentAiActionResult(actionId, { ok: false, control: event.data?.control || '', error: err.message || t('AI 远程桌面操作失败') });
            });
        }
    });
    window.addEventListener('beforeunload', () => { try { rfb?.disconnect?.(); } catch {} });
    setupMobileInput();
    setupClipboard();
    setupFloatingPanels();
}

applyDisplayOptions();
bindEvents();
connect();
