import { applyZephyrColorScheme } from './theme-runtime.js?v=20260615-visual-color-picker';

const $ = (sel) => document.querySelector(sel);
const RDP_CLIENT_VERSION = '2026-06-20-native-rdp-cliprdr';
console.info('[rdp-client]', 'script loaded', { version: RDP_CLIENT_VERSION });

const statusDot = $('#statusDot');
const statusText = $('#statusText');
const connInfo = $('#connInfo');
const overlay = $('#rdpOverlay');
const overlayMsg = $('#overlayMsg');
const stage = $('#rdpStage');
const displayRoot = $('#display');
const displayShell = $('#displayShell');
const fitBtn = $('#fitBtn');
const resolutionBtn = $('#resolutionBtn');
const fpsBtn = $('#fpsBtn');
const zoomBtn = $('#zoomBtn');
const zoomSlider = $('#zoomSlider');
const zoomValue = $('#zoomValue');
const clipboardBtn = $('#clipboardBtn');
const rdpFilesBtn = $('#rdpFilesBtn');
const keyboardBtn = $('#keyboardBtn');
const shortcutsBtn = $('#shortcutsBtn');
const joystickBtn = $('#joystickBtn');
const ctrlAltDelBtn = $('#ctrlAltDelBtn');
const reconnectBtn = $('#reconnectBtn');
const disconnectBtn = $('#disconnectBtn');
const mobileKeyboardInput = $('#mobileKeyboardInput');
const rdpTouchHud = $('#rdpTouchHud');
const rdpPointer = $('#rdpPointer');
const clipboardPanel = $('#clipboardPanel');
const clipboardText = $('#clipboardText');
const clipboardReadLocalBtn = $('#clipboardReadLocalBtn');
const clipboardSendBtn = $('#clipboardSendBtn');
const remoteClipboardText = $('#remoteClipboardText');
const clipboardCopyRemoteBtn = $('#clipboardCopyRemoteBtn');
const clipboardHint = $('#clipboardHint');
const shortcutsPanel = $('#shortcutsPanel');
const joystickPanel = $('#joystickPanel');
const joystickContainer = $('#joystickContainer');
const joystickKnob = $('#joystickKnob');
const shortcutGrid = $('#shortcutGrid');

const urlParams = new URLSearchParams(location.search);
const tabId = urlParams.get('tabId') || '';
const embeddedMode = urlParams.get('embed') === '1';

let params = loadParams();
const qualityModes = ['balanced', 'performance', 'quality'];
let qualityIdx = qualityModes.indexOf(params.quality || 'balanced');
if (qualityIdx < 0) qualityIdx = 0;
let rdpSocket = null;
let rdpInputSender = null;
let rdpAudioSocket = null;
let rdpAudioMediaSource = null;
let rdpAudioSourceBuffer = null;
let rdpAudioElement = null;
let rdpAudioQueue = [];
let rdpAudioUnlocked = false;
let rdpAutoDisconnectedHidden = false;
let canvasTouchAbort = null;
let keyboard = null;
let mouse = null;
let connected = false;
let fitModes = ['fit', '1:1', '16:9', '4:3'];
let fitModeIdx = 0;
function parseRdpResolutionPreset(value = '') {
    const m = String(value || '').match(/^(\d{3,5})x(\d{3,5})$/i);
    if (!m) return null;
    return { width: Number(m[1]), height: Number(m[2]) };
}
let displayWidth = 0;
let displayHeight = 0;
let resizeTimer = 0;
let requestedRdpWidth = 0;
let requestedRdpHeight = 0;
let rdpScaleZoom = 1;
let rdpViewportOffsetX = 0;
let rdpViewportOffsetY = 0;
let rdpJoystickState = null;
let rdpInputSuppressed = false;
let rdpInputSuppressedUntil = 0;
let rdpReconnectTimer = 0;
let rdpReconnectPending = false;
let rdpReconnectSeq = 0;
let rdpLastReconnectAt = 0;
let mobileInputMirror = '';
let lastRemoteClipboard = '';
let clipboardAutoWriteOk = false;
let clipboardAutoWriteFailed = false;
let panelLayoutMenu = null;
let suppressNextLayoutClick = false;
let lastLocalClipboardText = '';
let lastLocalClipboardSentAt = 0;
let pasteShortcutInProgress = false;
let rdpLastFrameAt = 0;
let clipboardAutoSyncTimer = 0;
let lastClipboardReadAttemptAt = 0;
let rdpFileClipboardSeq = 0;
const rdpFileClipboardFiles = new Map();

const RDP_FILE_CLIPBOARD_MIMETYPE = 'application/vnd.zephyr.rdp.file-clipboard';
const RDP_SHARED_FILE_MAX_BYTES = 32 * 1024 * 1024;
let rdpRemoteFileClipboard = [];
let rdpIncomingFileClipboard = [];

const KEY = {
    BACKSPACE: 0xff08,
    TAB: 0xff09,
    ENTER: 0xff0d,
    ESC: 0xff1b,
    HOME: 0xff50,
    LEFT: 0xff51,
    UP: 0xff52,
    RIGHT: 0xff53,
    DOWN: 0xff54,
    PAGE_UP: 0xff55,
    PAGE_DOWN: 0xff56,
    END: 0xff57,
    DELETE: 0xffff,
    CTRL: 0xffe3,
    SHIFT: 0xffe1,
    ALT: 0xffe9,
    SUPER: 0xffeb,
    F1: 0xffbe,
    F2: 0xffbf,
    F3: 0xffc0,
    F4: 0xffc1,
    F5: 0xffc2,
    F6: 0xffc3,
    F7: 0xffc4,
    F8: 0xffc5,
    F9: 0xffc6,
    F10: 0xffc7,
    F11: 0xffc8,
    F12: 0xffc9,
};

function loadParams() {
    const key = tabId ? `zephyr_remote_desktop_params_${tabId}` : 'zephyr_remote_desktop_params';
    try {
        return JSON.parse(sessionStorage.getItem(key) || '{}');
    } catch {
        return {};
    }
}

function protocolLabel() {
    return String(params?.protocol || 'VNC').toUpperCase() === 'RDP' ? 'RDP' : 'VNC';
}

function protocolDefaultPort() {
    return protocolLabel() === 'RDP' ? 3389 : 5900;
}

function notifyParentStatus(status) {
    if (embeddedMode && window.parent && window.parent !== window) {
        if (status === 'connecting' && connected) return;
        window.parent.postMessage({ source: 'zephyr-terminal', tabId: params?.tabId || tabId, status }, '*');
    }
}

function notifyParentActivity() {
    if (embeddedMode && window.parent && window.parent !== window) {
        window.parent.postMessage({ source: 'zephyr-terminal', type: 'activity', tabId: params?.tabId || tabId }, '*');
    }
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

function notifyParentCloseRequest(reason = 'remote-desktop-closed') {
    if (embeddedMode && window.parent && window.parent !== window) {
        console.info('[rdp-client]', 'request parent to close tab', {
            tabId: params?.tabId || tabId,
            reason,
            connected,
            hasRdpSocket: !!rdpSocket,
            hasRdpInput: !!rdpInputSender,
        });
        window.parent.postMessage({ source: 'zephyr-terminal', type: 'close-request', tabId: params?.tabId || tabId, reason }, '*');
    }
}
function notifyParentSharedClipboardText(text = '') {
    if (embeddedMode && window.parent && window.parent !== window && text) {
        window.parent.postMessage({ source: 'zephyr-terminal', type: 'shared-clipboard-text', tabId: params?.tabId || tabId, text: String(text) }, '*');
    }
}
function notifyParentSharedFileClipboard(files = []) {
    if (embeddedMode && window.parent && window.parent !== window && files?.length) {
        window.parent.postMessage({ source: 'zephyr-terminal', type: 'shared-file-clipboard', tabId: params?.tabId || tabId, files }, '*');
    }
}
function requestParentSharedFileClipboard() {
    if (embeddedMode && window.parent && window.parent !== window) {
        window.parent.postMessage({ source: 'zephyr-terminal', type: 'request-shared-file-clipboard', tabId: params?.tabId || tabId }, '*');
    }
}
async function downloadRemoteFilesToLocal(files = []) {
    const list = Array.from(files || []).filter((f) => f?.remotePath);
    if (!list.length) return;
    setClipboardHint(`正在下载 ${list.length} 个文件到本机...`, 'info');
    let ok = 0;
    for (const file of list) {
        try {
            const qs = new URLSearchParams({ path: file.remotePath, name: file.name || '' });
            const res = await fetch('/api/rdp/clipboard-file?' + qs.toString());
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = file.name || 'remote-file';
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            window.setTimeout(() => { try { a.remove(); URL.revokeObjectURL(url); } catch {} }, 2000);
            ok++;
        } catch (err) {
            console.warn('[rdp-client]', 'download remote file to local failed', { name: file.name, error: err.message });
        }
    }
    setClipboardHint(ok ? `已下载 ${ok}/${list.length} 个文件到本机` : '下载失败', ok ? 'success' : 'warning');
}
function formatFileSize(bytes) {
    if (!bytes) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}
function renderRemoteFileList() {
    const container = document.getElementById('rdpRemoteFileList');
    if (!container) return;
    if (!rdpRemoteFileClipboard.length) {
        container.innerHTML = '<div class="rdp-file-empty">远程剪贴板暂无文件</div>';
        return;
    }
    container.innerHTML = rdpRemoteFileClipboard.map((file, i) => {
        return `<div class="rdp-file-item" data-file-idx="${i}">
            <span class="rdp-file-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
            <span class="rdp-file-size">${formatFileSize(file.size)}</span>
            <button class="btn-sm rdp-file-download-btn" data-download-idx="${i}">下载</button>
        </div>`;
    }).join('');
    container.querySelectorAll('[data-download-idx]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = Number(e.target.dataset.downloadIdx);
            const file = rdpRemoteFileClipboard[idx];
            if (file) downloadRemoteFilesToLocal([file]);
        });
    });
}
function escapeHtml(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function renderIncomingFileList() {
    const container = document.getElementById('rdpRemoteFileList');
    if (!container) return;
    if (!rdpIncomingFileClipboard.length) {
        if (rdpRemoteFileClipboard.length) renderRemoteFileList();
        else container.innerHTML = '<div class="rdp-file-empty">远程剪贴板暂无文件</div>';
        return;
    }
    container.innerHTML = '<div class="rdp-file-section-label">待粘贴到远程</div>' + rdpIncomingFileClipboard.map((file, i) => {
        return `<div class="rdp-file-item" data-incoming-idx="${i}">
            <span class="rdp-file-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
            <span class="rdp-file-size">${formatFileSize(file.size)}</span>
        </div>`;
    }).join('') + (rdpRemoteFileClipboard.length ? '<div class="rdp-file-section-label">远程复制文件</div>' + rdpRemoteFileClipboard.map((file, i) => {
        return `<div class="rdp-file-item" data-file-idx="${i}">
            <span class="rdp-file-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
            <span class="rdp-file-size">${formatFileSize(file.size)}</span>
            <button class="btn-sm rdp-file-download-btn" data-download-idx="${i}">下载</button>
        </div>`;
    }).join('') : '');
    container.querySelectorAll('[data-download-idx]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = Number(e.target.dataset.downloadIdx);
            const file = rdpRemoteFileClipboard[idx];
            if (file) downloadRemoteFilesToLocal([file]);
        });
    });
}
function consumeIncomingFileClipboard() {
    if (!connected || !rdpSocket || rdpSocket.readyState !== WebSocket.OPEN) return false;
    // Always send paste request to server — server knows the clipboard source
    rdpSocket.send(JSON.stringify({ type: 'rdp-sftp-clipboard-paste' }));
    setClipboardHint('正在通过 RDP 原生文件剪贴板粘贴到远端当前目录...', 'info');
    return true;
}
function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
        reader.readAsDataURL(file);
    });
}
async function readRdpClipboardFilesForSharing(files = []) {
    const list = Array.from(files || []).filter(Boolean);
    const total = list.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
    if (total > RDP_SHARED_FILE_MAX_BYTES) throw new Error(`跨窗口文件剪贴板暂限 ${Math.round(RDP_SHARED_FILE_MAX_BYTES / 1024 / 1024)}MB，本次 ${Math.round(total / 1024 / 1024)}MB`);
    const result = [];
    for (const file of list) {
        result.push({
            id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
            name: file.name || 'clipboard-file',
            size: Number(file.size) || 0,
            mime: file.type || 'application/octet-stream',
            dataUrl: await fileToDataUrl(file),
        });
    }
    return result;
}

function setStatus(state, message = '') {
    const label = protocolLabel();
    notifyParentStatus(state === 'connected' ? 'connected' : state === 'error' ? 'error' : state === 'disconnected' ? 'closed' : 'connecting');
    statusDot.className = 'status-dot';
    if (state === 'connected') {
        connected = true;
        statusDot.classList.add('connected');
        statusText.textContent = message || `${label} 已连接`;
        overlay.classList.add('hidden');
    } else if (state === 'error') {
        connected = false;
        statusDot.classList.add('disconnected');
        statusText.textContent = '错误';
        overlayMsg.textContent = message || `${label} 连接失败`;
        overlay.classList.remove('hidden');
    } else if (state === 'disconnected') {
        connected = false;
        statusDot.classList.add('disconnected');
        statusText.textContent = message || '已断开';
        overlayMsg.textContent = message || `${label} 连接已断开`;
        overlay.classList.remove('hidden');
    } else {
        connected = false;
        statusText.textContent = message || '连接中...';
        overlayMsg.textContent = message || `正在建立 ${label} 连接...`;
        overlay.classList.remove('hidden');
    }
}

function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const target = computeRdpTargetSize(fitModes[fitModeIdx]);
    const query = new URLSearchParams({
        connectionId: params.connectionId || urlParams.get('connectionId') || '',
        tabId: params.tabId || tabId,
        width: String(target.width),
        height: String(target.height),
        mode: target.mode,
        quality: qualityModes[qualityIdx],
        fps: String(params.rdpFps || 60),
    });
    return `${proto}//${location.host}/rdp-h264?${query.toString()}`;
}

function updateInfo() {
    const parts = [
        protocolLabel(),
        params.host ? `${params.host}:${params.port || protocolDefaultPort()}` : '',
        params.username || '',
    ].filter(Boolean);
    connInfo.textContent = parts.join(' · ');
}

function computeRdpTargetSize(mode = fitModes[fitModeIdx]) {
    const preset = parseRdpResolutionPreset(params.rdpResolution || '');
    const bounds = stage?.getBoundingClientRect?.() || { width: innerWidth || 1280, height: innerHeight || 720 };
    const effDpr = Math.min(window.devicePixelRatio || 1, 2);
    const minW = 800;
    const minH = 600;
    const even = (v) => Math.max(2, Math.round(Number(v || 0) / 2) * 2);
    const clampEven = (v, min, max) => even(Math.max(min, Math.min(max, Number(v) || min)));
    const boundW = Math.max(1, bounds.width || innerWidth || 1280);
    const boundH = Math.max(1, bounds.height || innerHeight || 720);

    if (preset && mode === 'fit') {
        // “适应”=远端分辨率匹配当前显示区域比例，避免横屏桌面被编码进上下黑边。
        // 像素预算保持所选档位（1080p/2K/4K），但宽高比跟随容器。
        const aspect = Math.max(0.2, Math.min(5, boundW / boundH));
        const pixelBudget = Math.max(minW * minH, preset.width * preset.height);
        const maxSide = Math.max(preset.width, preset.height);
        let width = even(Math.sqrt(pixelBudget * aspect));
        let height = even(width / aspect);
        const longSide = Math.max(width, height);
        if (longSide > maxSide) {
            const scale = maxSide / longSide;
            width = even(width * scale);
            height = even(height * scale);
        }
        width = clampEven(width, minW, maxSide);
        height = clampEven(height, minH, maxSide);
        return { width, height, mode: params.rdpResolution };
    }

    const maxW = preset ? Math.max(preset.width, 7680) : 7680;
    const maxH = preset ? Math.max(preset.height, 4320) : 4320;
    const fitBounds = () => {
        const w = clampEven(boundW * effDpr, minW, maxW);
        const h = clampEven(boundH * effDpr, minH, maxH);
        return { width: w, height: h, mode };
    };
    const byAspect = (num, den) => {
        const longCss = Math.max(boundW, boundH);
        let w = clampEven(longCss * effDpr, minW, maxW);
        let h = even(w * den / num);
        if (h < minH) { h = clampEven(minH, minH, maxH); w = even(h * num / den); }
        if (w > maxW) { w = clampEven(maxW, minW, maxW); h = even(w * den / num); }
        if (h > maxH) { h = clampEven(maxH, minH, maxH); w = even(h * num / den); }
        let unit = Math.max(1, Math.min(Math.floor(w / num), Math.floor(h / den)));
        let width = num * unit;
        let height = den * unit;
        if (height % 2) height += 1;
        if (width <= height) { width = even(Math.max(minW, height * num / den)); height = even(width * den / num); }
        return { width, height, mode };
    };
    if (mode === '16:9') return byAspect(16, 9);
    if (mode === '4:3') return byAspect(4, 3);
    return fitBounds();
}

function requestRdpCanvasSize(mode = fitModes[fitModeIdx], force = false) {
    if (!rdpInputSender || !connected) return false;
    const target = computeRdpTargetSize(mode);
    const changed = Math.abs((requestedRdpWidth || 0) - target.width) >= 2 || Math.abs((requestedRdpHeight || 0) - target.height) >= 2;
    if (!force && !changed) return false;
    requestedRdpWidth = target.width;
    requestedRdpHeight = target.height;
    rdpInputSender({ type: 'resize', width: target.width, height: target.height, mode: target.mode, quality: qualityModes[qualityIdx], fps: rdpFpsValue() });
    console.info('[rdp-client]', 'rdp canvas remote resize requested', target);
    return true;
}

function setRdpScaleZoom(nextZoom, { preserveViewport = true } = {}) {
    const zoom = Math.max(0.5, Math.min(2.5, Number(nextZoom) || 1));
    if (preserveViewport && displayShell) {
        const maxX = Math.max(0, displayShell.scrollWidth - displayShell.clientWidth);
        const maxY = Math.max(0, displayShell.scrollHeight - displayShell.clientHeight);
        rdpViewportOffsetX = displayShell.scrollLeft - maxX / 2;
        rdpViewportOffsetY = displayShell.scrollTop - maxY / 2;
    }
    rdpScaleZoom = zoom;
    const pct = Math.round(rdpScaleZoom * 100);
    if (zoomSlider && Number(zoomSlider.value) !== pct) zoomSlider.value = String(pct);
    if (zoomValue) zoomValue.textContent = `${pct}%`;
    else if (zoomBtn) zoomBtn.textContent = `${pct}%`;
    applyDisplayScale();
}

function captureCanvasSnapshotForAi(source, options = {}) {
    if (!source || !source.width || !source.height) return { error: '当前远程桌面画面还没有可读取的 canvas' };
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
    let source = null;
    try {
        source = displayRoot?.querySelector?.('#rdp-canvas') || displayRoot?.querySelector?.('canvas') || null;
    } catch (_) {}
    const shot = captureCanvasSnapshotForAi(source, options);
    return {
        protocol: protocolLabel(),
        tabId: params?.tabId || tabId,
        connectionId: params?.connectionId || '',
        host: params?.host || '',
        port: params?.port || protocolDefaultPort(),
        status: statusText?.textContent || '',
        title: connInfo?.textContent || '',
        connected,
        at: Date.now(),
        frameAt: rdpLastFrameAt || 0,
        ...shot,
    };
}
window.__zephyrGetRemoteDesktopSnapshot = getRemoteDesktopSnapshotForAi;

function applyDisplayScale() {
    if (!displayShell) return;
    const rdpCanvas = displayRoot?.querySelector?.('#rdp-canvas');
    const rdpDisplay = displayRoot?.querySelector?.('#rdp-video') || rdpCanvas;
    if (!rdpDisplay) return;
    const mode = fitModes[fitModeIdx];
    const shellRect = displayShell.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    const bounds = {
        width: shellRect.width || stageRect.width || innerWidth || 1280,
        height: shellRect.height || stageRect.height || innerHeight || 720,
    };
    const curW = displayWidth || rdpCanvas?.width || rdpDisplay.videoWidth || 1280;
    const curH = displayHeight || rdpCanvas?.height || rdpDisplay.videoHeight || 720;
    if (!curW || !curH || !bounds.width || !bounds.height) return;

    const centerOversizedDisplay = () => {
        requestAnimationFrame(() => {
            if (!displayShell) return;
            const maxX = Math.max(0, displayShell.scrollWidth - displayShell.clientWidth);
            const maxY = Math.max(0, displayShell.scrollHeight - displayShell.clientHeight);
            displayShell.scrollLeft = Math.max(0, Math.min(maxX, maxX / 2 + rdpViewportOffsetX));
            displayShell.scrollTop = Math.max(0, Math.min(maxY, maxY / 2 + rdpViewportOffsetY));
            updateJoystickHint();
        });
    };

    const setDisplayCss = (cssW, cssH, objectFit) => {
        const finalW = Math.max(1, Math.ceil(cssW * rdpScaleZoom));
        const finalH = Math.max(1, Math.ceil(cssH * rdpScaleZoom));
        displayRoot.style.width = finalW + 'px';
        displayRoot.style.height = finalH + 'px';
        rdpDisplay.style.width = finalW + 'px';
        rdpDisplay.style.height = finalH + 'px';
        rdpDisplay.style.objectFit = objectFit;
        rdpDisplay.style.display = 'block';
        rdpDisplay.style.maxWidth = 'none';
        rdpDisplay.style.maxHeight = 'none';
        displayShell.style.position = 'absolute';
        displayShell.style.inset = '0';
        displayShell.style.overflow = rdpScaleZoom > 1.01 ? 'auto' : 'hidden';
        stage.style.overflow = 'hidden';
        centerOversizedDisplay();
    };

    if (mode === 'fit') {
        // 适应=充满整个显示区域；缩放滑块继续按 rdpScaleZoom 放大/缩小。
        setDisplayCss(bounds.width, bounds.height, 'fill');
        return;
    }
    if (mode === '1:1') {
        setDisplayCss(curW, curH, 'contain');
        return;
    }
    if (mode === '16:9' || mode === '4:3') {
        const targetAspect = mode === '16:9' ? 16 / 9 : 4 / 3;
        let cssW = bounds.width;
        let cssH = cssW / targetAspect;
        if (cssH > bounds.height) { cssH = bounds.height; cssW = cssH * targetAspect; }
        setDisplayCss(cssW, cssH, 'contain');
        return;
    }
    const scale = Math.min(bounds.width / curW, bounds.height / curH);
    setDisplayCss(curW * scale, curH * scale, 'contain');
}

function switchFitMode(mode) {
    if (!connected) return;
    setRdpScaleZoom(1, { preserveViewport: false });
    rdpViewportOffsetX = 0;
    rdpViewportOffsetY = 0;
    requestRdpCanvasSize(mode, true);
    applyDisplayScale();
}

function sendDisplaySize() {
    if (!connected) return;
    requestRdpCanvasSize(fitModes[fitModeIdx], false);
    applyDisplayScale();
}

function scheduleResize() {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
        applyDisplayScale();
        sendDisplaySize();
    }, 180);
}

function getRemotePointerPosition(event) {
    const rdpCanvas = displayRoot?.querySelector?.('#rdp-canvas');
    const displayEl = (rdpInputSender && rdpCanvas) ? rdpCanvas : (displayRoot?.querySelector?.('.rdp-display-element') || displayRoot?.firstElementChild || displayRoot);
    const rect = displayEl?.getBoundingClientRect?.();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    const rawX = event.clientX - rect.left;
    const rawY = event.clientY - rect.top;
    if (rawX < -2 || rawY < -2 || rawX > rect.width + 2 || rawY > rect.height + 2) return null;
    const remoteWidth = displayWidth || rdpCanvas?.width || rect.width;
    const remoteHeight = displayHeight || rdpCanvas?.height || rect.height;
    const x = Math.max(0, Math.min(remoteWidth - 1, Math.round(rawX * remoteWidth / rect.width)));
    const y = Math.max(0, Math.min(remoteHeight - 1, Math.round(rawY * remoteHeight / rect.height)));
    return { x, y, rawX, rawY, rectWidth: rect.width, rectHeight: rect.height, remoteWidth, remoteHeight };
}

function createMouseState(x, y, left = false) {
    return { x, y, left, middle: false, right: false, up: false, down: false };
}

function sendRdpPointer(message) {
    if (!rdpInputSender || !connected) return false;
    rdpInputSender(message);
    notifyParentActivity();
    return true;
}

function remotePointerMetrics() {
    const rdpCanvas = displayRoot?.querySelector?.('#rdp-canvas');
    const displayEl = (rdpInputSender && rdpCanvas) ? rdpCanvas : (displayRoot?.querySelector?.('.rdp-display-element') || displayRoot?.firstElementChild || displayRoot);
    const rect = displayEl?.getBoundingClientRect?.();
    const remoteWidth = displayWidth || rdpCanvas?.width || rect?.width || 0;
    const remoteHeight = displayHeight || rdpCanvas?.height || rect?.height || 0;
    return { rect, remoteWidth, remoteHeight };
}

function enrichRemotePosition(position = {}) {
    const x = Math.round(Number(position.x));
    const y = Math.round(Number(position.y));
    const { rect, remoteWidth, remoteHeight } = remotePointerMetrics();
    const safeRemoteWidth = Number(position.remoteWidth || remoteWidth || 0);
    const safeRemoteHeight = Number(position.remoteHeight || remoteHeight || 0);
    const rectWidth = Number(position.rectWidth || rect?.width || 0);
    const rectHeight = Number(position.rectHeight || rect?.height || 0);
    return {
        ...position,
        x,
        y,
        rawX: Number.isFinite(Number(position.rawX)) ? Number(position.rawX) : (rectWidth && safeRemoteWidth ? x * rectWidth / safeRemoteWidth : undefined),
        rawY: Number.isFinite(Number(position.rawY)) ? Number(position.rawY) : (rectHeight && safeRemoteHeight ? y * rectHeight / safeRemoteHeight : undefined),
        rectWidth: rectWidth || undefined,
        rectHeight: rectHeight || undefined,
        remoteWidth: safeRemoteWidth || undefined,
        remoteHeight: safeRemoteHeight || undefined,
    };
}

function sendRemoteMouseClick(position, source = 'touch', button = 1) {
    if (!connected || !position) return false;
    position = enrichRemotePosition(position);
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) return false;
    console.info('[rdp-client]', 'remote mouse click mapped', {
        source,
        button,
        x: position.x,
        y: position.y,
        rawX: fixedOrNull(position.rawX),
        rawY: fixedOrNull(position.rawY),
        rectWidth: fixedOrNull(position.rectWidth),
        rectHeight: fixedOrNull(position.rectHeight),
        remoteWidth: position.remoteWidth,
        remoteHeight: position.remoteHeight,
    });
    if (rdpInputSender) {
        rdpInputSender({ type: 'mouse', x: position.x, y: position.y });
        window.setTimeout(() => rdpInputSender?.({ type: 'click', button }), 15);
        notifyParentActivity();
        return true;
    }
    return false;
}

// 自有 RDP 管线保留长按右键；双指缩放已移到顶部缩放按钮，避免和双指滚动冲突。
let rdpTouches = new Map();   // pointerId → {sx, sy, pos, moved}
let rdpLongPress = null;
let rdpInputMode = localStorage.getItem('zephyr-rdp-input-mode') || 'touch';
let rdpHudTimer = 0;

function showRdpHud(text, timeout = 900) {
    if (!rdpTouchHud) return;
    rdpTouchHud.textContent = text;
    rdpTouchHud.hidden = false;
    clearTimeout(rdpHudTimer);
    rdpHudTimer = setTimeout(() => { rdpTouchHud.hidden = true; }, timeout);
}

function updateRdpPointer(clientX, clientY, visible = true) {
    if (!rdpPointer) return;
    const rect = stage.getBoundingClientRect();
    rdpPointer.hidden = !visible || rdpInputMode !== 'mouse';
    if (!rdpPointer.hidden) rdpPointer.style.transform = `translate3d(${clientX - rect.left}px, ${clientY - rect.top}px, 0)`;
}

function setupMobilePointerMouse() {
    if (!stage) return;
    stage.style.touchAction = 'none';
    stage.style.webkitTouchCallout = 'none';
    stage.style.userSelect = 'none';
    stage.addEventListener('contextmenu', (e) => { if (rdpTouches.size > 0 || rdpInputSender) e.preventDefault(); });
    const isUI = (el) => el?.closest?.('.rdp-floating-panel, .rdp-mobile-keyboard-input, button, textarea, input, select');
    let lastTapAt = 0;
    let lastTapPos = null;
    let twoFingerState = null;
    let lastPointerTouchAt = 0;
    const isTouchLikePointer = (event) => {
        const pt = event.pointerType || '';
        if (pt === 'touch' || pt === 'pen') return true;
        if (pt === 'mouse') return false;
        return !!(rdpInputSender && ((navigator.maxTouchPoints || 0) > 0 || window.matchMedia?.('(pointer: coarse)')?.matches || isCompactScreen()));
    };
    function cancelLP() { if (rdpLongPress) { clearTimeout(rdpLongPress); rdpLongPress = null; } }
    let touchMovePending = null;
    let touchMoveRaf = false;
    function sendMove(pos) {
        if (!pos || !connected) return false;
        // Throttle touch moves to one per animation frame
        touchMovePending = pos;
        if (!touchMoveRaf) {
            touchMoveRaf = true;
            requestAnimationFrame(() => {
                touchMoveRaf = false;
                if (touchMovePending) {
                    sendRdpPointer({ type: 'mouse', x: touchMovePending.x, y: touchMovePending.y });
                    touchMovePending = null;
                }
            });
        }
        return true;
    }
    function sendButton(pos, button, down) {
        if (!pos || !connected) return false;
        return sendRdpPointer({ type: down ? 'mousedown' : 'mouseup', button });
    }
    function doRightClick(pos) { if (pos && connected) sendRemoteMouseClick(pos, 'long-press', 3); }
    function scrollBy(deltaY, deltaX = 0) {
        if (!connected) return;
        rdpInputSender?.({ type: 'scroll', deltaY, deltaX });
        notifyParentActivity();
    }
    stage.addEventListener('pointerdown', (event) => {
        if (isRdpInputSuppressed()) { event.preventDefault(); event.stopPropagation(); return; }
        if (!isTouchLikePointer(event)) return;
        lastPointerTouchAt = Date.now();
        if (isUI(event.target)) return;
        const pos = getRemotePointerPosition(event);
        if (!pos) return;
        event.preventDefault();
        stage.focus({ preventScroll: true });
        stage.setPointerCapture?.(event.pointerId);
        const t = { id: event.pointerId, sx: event.clientX, sy: event.clientY, cx: event.clientX, cy: event.clientY, pos, lastPos: pos, moved: false, downSent: false };
        rdpTouches.set(event.pointerId, t);
        updateRdpPointer(event.clientX, event.clientY, true);
        if (rdpTouches.size === 1) {
            cancelLP();
            rdpLongPress = setTimeout(() => { if (rdpTouches.size === 1 && !t.moved) { doRightClick(t.lastPos || pos); t.rightClicked = true; } rdpLongPress = null; }, 620);
        } else if (rdpTouches.size === 2) {
            cancelLP();
            const touches = Array.from(rdpTouches.values());
            twoFingerState = { x: (touches[0].cx + touches[1].cx) / 2, y: (touches[0].cy + touches[1].cy) / 2 };
        } else cancelLP();
    }, { passive: false });
    stage.addEventListener('pointermove', (event) => {
        if (isRdpInputSuppressed()) { event.preventDefault(); event.stopPropagation(); return; }
        if (!isTouchLikePointer(event)) return;
        lastPointerTouchAt = Date.now();
        const t = rdpTouches.get(event.pointerId);
        if (!t) return;
        event.preventDefault();
        const pos = getRemotePointerPosition(event);
        t.cx = event.clientX; t.cy = event.clientY;
        if (pos) t.lastPos = pos;
        updateRdpPointer(event.clientX, event.clientY, true);
        const dist = Math.hypot(t.cx - t.sx, t.cy - t.sy);
        if (!t.moved && dist > 12) { t.moved = true; cancelLP(); }
        if (rdpTouches.size === 2) {
            const touches = Array.from(rdpTouches.values());
            const cx = (touches[0].cx + touches[1].cx) / 2;
            const cy = (touches[0].cy + touches[1].cy) / 2;
            if (twoFingerState) {
                const dy = cy - twoFingerState.y;
                const dx = cx - twoFingerState.x;
                if (Math.abs(dy) > 14 || Math.abs(dx) > 20) { scrollBy(-dy, -dx); twoFingerState = { x: cx, y: cy }; }
            }
            return;
        }
        if (rdpTouches.size !== 1 || !pos || t.rightClicked) return;
        if (t.moved && !t.downSent) { sendMove(pos); sendButton(pos, 1, true); t.downSent = true; }
        else if (t.downSent) sendMove(pos);
    }, { passive: false });
    stage.addEventListener('pointerup', (event) => {
        if (isRdpInputSuppressed()) { event.preventDefault(); event.stopPropagation(); rdpTouches.delete(event.pointerId); return; }
        if (!isTouchLikePointer(event)) return;
        lastPointerTouchAt = Date.now();
        const t = rdpTouches.get(event.pointerId);
        if (!t) return;
        event.preventDefault();
        const pos = getRemotePointerPosition(event) || t.lastPos || t.pos;
        rdpTouches.delete(event.pointerId);
        if (rdpTouches.size < 2) twoFingerState = null;
        if (rdpTouches.size === 0) cancelLP();
        if (t.rightClicked) { updateRdpPointer(event.clientX, event.clientY, false); return; }
        if (t.downSent) sendButton(pos, 1, false);
        else if (!t.moved) {
            const now = Date.now();
            const isDouble = lastTapPos && now - lastTapAt < 360 && Math.hypot(pos.x - lastTapPos.x, pos.y - lastTapPos.y) < 36;
            sendRemoteMouseClick(pos, isDouble ? 'double-tap-1' : 'tap', 1);
            if (isDouble) window.setTimeout(() => sendRemoteMouseClick(pos, 'double-tap-2', 1), 70);
            lastTapAt = now; lastTapPos = pos;
        }
        updateRdpPointer(event.clientX, event.clientY, false);
    }, { passive: false });
    stage.addEventListener('pointercancel', (event) => {
        if (isRdpInputSuppressed()) { event.preventDefault(); event.stopPropagation(); rdpTouches.delete(event.pointerId); return; }
        const t = rdpTouches.get(event.pointerId);
        if (t?.downSent) sendButton(t.lastPos || t.pos, 1, false);
        rdpTouches.delete(event.pointerId);
        if (rdpTouches.size === 0) { cancelLP(); twoFingerState = null; }
        updateRdpPointer(event.clientX || 0, event.clientY || 0, false);
    }, { passive: true });

    const touchId = (touch) => `t${touch.identifier}`;
    const eventFromTouch = (touch) => ({ clientX: touch.clientX, clientY: touch.clientY, target: touch.target || stage });
    stage.addEventListener('touchstart', (event) => {
        if (isRdpInputSuppressed()) { event.preventDefault(); event.stopPropagation(); return; }
        if (Date.now() - lastPointerTouchAt < 450) return;
        if (isUI(event.target)) return;
        const touches = Array.from(event.changedTouches || []);
        if (!touches.length) return;
        event.preventDefault();
        stage.focus({ preventScroll: true });
        for (const touch of touches) {
            const ev = eventFromTouch(touch);
            const pos = getRemotePointerPosition(ev);
            if (!pos) continue;
            const id = touchId(touch);
            const t = { id, sx: touch.clientX, sy: touch.clientY, cx: touch.clientX, cy: touch.clientY, pos, lastPos: pos, moved: false, downSent: false, touchFallback: true };
            rdpTouches.set(id, t);
            updateRdpPointer(touch.clientX, touch.clientY, true);
        }
        if (rdpTouches.size === 1) {
            const t = Array.from(rdpTouches.values())[0];
            cancelLP();
            rdpLongPress = setTimeout(() => { if (rdpTouches.size === 1 && !t.moved) { doRightClick(t.lastPos || t.pos); t.rightClicked = true; } rdpLongPress = null; }, 620);
        } else if (rdpTouches.size === 2) {
            cancelLP();
            const arr = Array.from(rdpTouches.values());
            twoFingerState = { x: (arr[0].cx + arr[1].cx) / 2, y: (arr[0].cy + arr[1].cy) / 2 };
        } else cancelLP();
    }, { passive: false });
    stage.addEventListener('touchmove', (event) => {
        if (isRdpInputSuppressed()) { event.preventDefault(); event.stopPropagation(); return; }
        if (Date.now() - lastPointerTouchAt < 450) return;
        const touches = Array.from(event.changedTouches || []);
        if (!touches.length) return;
        event.preventDefault();
        for (const touch of touches) {
            const id = touchId(touch);
            const t = rdpTouches.get(id);
            if (!t) continue;
            const pos = getRemotePointerPosition(eventFromTouch(touch));
            t.cx = touch.clientX; t.cy = touch.clientY;
            if (pos) t.lastPos = pos;
            updateRdpPointer(touch.clientX, touch.clientY, true);
            const dist = Math.hypot(t.cx - t.sx, t.cy - t.sy);
            if (!t.moved && dist > 12) { t.moved = true; cancelLP(); }
        }
        if (rdpTouches.size === 2) {
            const arr = Array.from(rdpTouches.values());
            const cx = (arr[0].cx + arr[1].cx) / 2;
            const cy = (arr[0].cy + arr[1].cy) / 2;
            if (twoFingerState) {
                const dy = cy - twoFingerState.y;
                const dx = cx - twoFingerState.x;
                if (Math.abs(dy) > 14 || Math.abs(dx) > 20) { scrollBy(-dy, -dx); twoFingerState = { x: cx, y: cy }; }
            }
            return;
        }
        const t = Array.from(rdpTouches.values()).find((x) => x.touchFallback);
        const pos = t?.lastPos;
        if (!t || !pos || t.rightClicked) return;
        if (t.moved && !t.downSent) { sendMove(pos); sendButton(pos, 1, true); t.downSent = true; }
        else if (t.downSent) sendMove(pos);
    }, { passive: false });
    stage.addEventListener('touchend', (event) => {
        if (isRdpInputSuppressed()) { event.preventDefault(); event.stopPropagation(); return; }
        if (Date.now() - lastPointerTouchAt < 450) return;
        const touches = Array.from(event.changedTouches || []);
        if (!touches.length) return;
        event.preventDefault();
        for (const touch of touches) {
            const id = touchId(touch);
            const t = rdpTouches.get(id);
            if (!t) continue;
            const pos = getRemotePointerPosition(eventFromTouch(touch)) || t.lastPos || t.pos;
            rdpTouches.delete(id);
            if (t.rightClicked) continue;
            if (t.downSent) sendButton(pos, 1, false);
            else if (!t.moved) {
                const now = Date.now();
                const isDouble = lastTapPos && now - lastTapAt < 360 && Math.hypot(pos.x - lastTapPos.x, pos.y - lastTapPos.y) < 36;
                sendRemoteMouseClick(pos, isDouble ? 'double-tap-1' : 'tap', 1);
                if (isDouble) window.setTimeout(() => sendRemoteMouseClick(pos, 'double-tap-2', 1), 70);
                lastTapAt = now; lastTapPos = pos;
            }
            updateRdpPointer(touch.clientX, touch.clientY, false);
        }
        if (rdpTouches.size < 2) twoFingerState = null;
        if (rdpTouches.size === 0) cancelLP();
    }, { passive: false });
    stage.addEventListener('touchcancel', (event) => {
        if (isRdpInputSuppressed()) { event.preventDefault(); event.stopPropagation(); return; }
        if (Date.now() - lastPointerTouchAt < 450) return;
        for (const touch of Array.from(event.changedTouches || [])) {
            const id = touchId(touch);
            const t = rdpTouches.get(id);
            if (t?.downSent) sendButton(t.lastPos || t.pos, 1, false);
            rdpTouches.delete(id);
        }
        if (rdpTouches.size === 0) { cancelLP(); twoFingerState = null; }
    }, { passive: true });
    stage.addEventListener('wheel', (event) => {
        if (isRdpInputSuppressed()) { event.preventDefault(); event.stopPropagation(); return; }
        if (isUI(event.target)) return;
        const pos = getRemotePointerPosition(event);
        if (!pos || !connected) return;
        event.preventDefault();
        if (rdpInputSender) { rdpInputSender({ type: 'mouse', x: pos.x, y: pos.y }); rdpInputSender({ type: 'scroll', deltaY: event.deltaY, deltaX: event.deltaX }); notifyParentActivity(); return; }
        scrollBy(event.deltaY, event.deltaX);
    }, { passive: false });
}





function bindCanvasTouch(canvas) {
    try { canvasTouchAbort?.abort(); } catch {}
    canvasTouchAbort = new AbortController();
    const sig = canvasTouchAbort.signal;
    const map = new Map();
    let lastTap = null, lastTapAt = 0, longT = 0, tf = null;
    const cr = () => canvas.getBoundingClientRect();
    const p = (x, y) => {
        const r = cr(); if (!r.width||!r.height) { console.warn('[rdp-touch] zero canvas rect r',r); return null; }
        const rw = displayWidth||canvas.width||1280, rh = displayHeight||canvas.height||720;
        return { x: Math.max(0,Math.min(rw-1,Math.round((x-r.left)*rw/r.width))), y: Math.max(0,Math.min(rh-1,Math.round((y-r.top)*rh/r.height))) };
    };
    const snd = (m) => { if (rdpInputSender && connected) { rdpInputSender(m); notifyParentActivity(); return true; } console.warn('[rdp-touch] snd blocked', { input: !!rdpInputSender, conn: connected }); return false; };
    const click = (pt, b=1) => { const ok = snd({type:'mouse',x:pt.x,y:pt.y}); if(ok) setTimeout(()=>snd({type:'click',button:b}),10); };
    const down = (b=1) => snd({type:'mousedown',button:b});
    const up = (b=1) => snd({type:'mouseup',button:b});
    let pointerTouchTs = 0;
    let pendingMouseMove = null;
    let mouseRafPending = false;
    const isDesktopMousePointer = (e) => (e.pointerType || 'mouse') === 'mouse';
    const mouseButton = (e) => e.button === 2 ? 3 : e.button === 1 ? 2 : 1;
    const desktopMouseMove = (e) => {
        if (!isDesktopMousePointer(e)) return false;
        const pt = p(e.clientX, e.clientY);
        if (!pt) return false;
        // Throttle mouse moves to one per animation frame (~60fps max)
        pendingMouseMove = pt;
        if (!mouseRafPending) {
            mouseRafPending = true;
            requestAnimationFrame(() => {
                mouseRafPending = false;
                if (pendingMouseMove) {
                    snd({ type: 'mouse', x: pendingMouseMove.x, y: pendingMouseMove.y });
                    pendingMouseMove = null;
                }
            });
        }
        return true;
    };
    canvas.addEventListener('pointermove', (e) => {
        if (!isDesktopMousePointer(e)) return;
        desktopMouseMove(e);
    }, { passive: true, signal: sig });
    canvas.addEventListener('pointerdown', (e) => {
        if (!isDesktopMousePointer(e)) return;
        const pt = p(e.clientX, e.clientY);
        if (!pt) return;
        e.preventDefault();
        canvas.focus({ preventScroll: true });
        snd({ type: 'mouse', x: pt.x, y: pt.y });
        snd({ type: 'mousedown', button: mouseButton(e) });
        canvas.setPointerCapture?.(e.pointerId);
    }, { passive: false, signal: sig });
    canvas.addEventListener('pointerup', (e) => {
        if (!isDesktopMousePointer(e)) return;
        const pt = p(e.clientX, e.clientY);
        if (pt) snd({ type: 'mouse', x: pt.x, y: pt.y });
        snd({ type: 'mouseup', button: mouseButton(e) });
    }, { passive: true, signal: sig });
    canvas.addEventListener('pointercancel', (e) => {
        if (!isDesktopMousePointer(e)) return;
        snd({ type: 'mouseup', button: mouseButton(e) });
    }, { passive: true, signal: sig });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault(), { passive: false, signal: sig });
    setTransientStatus('\u89e6\u63a7\u76d1\u542c\u5df2\u5c31\u4f4d');
    canvas.addEventListener('pointerdown', (e) => {
        if (isDesktopMousePointer(e)) return;
        console.info('[rdp-touch] pointerdown', {x:e.clientX,y:e.clientY,pt:e.pointerType,conn:connected,mapSz:map.size});
        pointerTouchTs = Date.now();
        const pt = p(e.clientX, e.clientY); if (!pt) { setTransientStatus('\u5750\u6807\u89e3\u6790\u5931\u8d25'); return; }
        e.preventDefault();
        const id = e.pointerId||'p0';
        map.set(id,{sx:e.clientX, sy:e.clientY, cx:e.clientX, cy:e.clientY, pos:pt, last:pt, moved:false, down:false, right:false});
        const ok = snd({type:'mouse',x:pt.x,y:pt.y});
        setTransientStatus(ok ? `\u70b9\u51fb (${pt.x},${pt.y})` : '\u672a\u8fde\u63a5');
        clearTimeout(longT);
        if (map.size===1) longT=setTimeout(()=>{const t=map.get(id); if(t&&!t.moved&&t.last){click(t.last,3);t.right=true;} longT=0;},620);
        else if (map.size===2){clearTimeout(longT);const a=Array.from(map.values());tf={x:(a[0].cx+a[1].cx)/2,y:(a[0].cy+a[1].cy)/2};}
    },{passive:false,signal:sig});
    canvas.addEventListener('pointermove', (e) => {
        if (isDesktopMousePointer(e)) return;
        const t=map.get(e.pointerId||'p0'); if(!t)return; e.preventDefault();
        const pt=p(e.clientX, e.clientY); t.cx=e.clientX; t.cy=e.clientY; if(pt) t.last=pt;
        if(!t.moved&&Math.hypot(e.clientX-t.sx,e.clientY-t.sy)>10){t.moved=true;clearTimeout(longT);}
        if(map.size===2){const a=Array.from(map.values());const cx=(a[0].cx+a[1].cx)/2,cy=(a[0].cy+a[1].cy)/2;if(tf){const dy=cy-tf.y,dx=cx-tf.x;if(Math.abs(dy)>12||Math.abs(dx)>18){snd({type:'scroll',deltaY:-dy,deltaX:-dx});tf={x:cx,y:cy};}}return;}
        if(!pt||t.right)return;
        if(t.moved&&!t.down){snd({type:'mouse',x:pt.x,y:pt.y});down(1);t.down=true;}
        else if(t.down) snd({type:'mouse',x:pt.x,y:pt.y});
    },{passive:false,signal:sig});
    canvas.addEventListener('pointerup', (e) => {
        if (isDesktopMousePointer(e)) return;
        const t=map.get(e.pointerId||'p0'); if(!t)return; e.preventDefault();
        const pt=p(e.clientX,e.clientY)||t.last||t.pos;
        map.delete(e.pointerId||'p0');
        if(t.down) up(1);
        else if(!t.moved&&!t.right&&pt){
            const now=Date.now(); const dbl=lastTap&&now-lastTapAt<360&&Math.hypot(pt.x-lastTap.x,pt.y-lastTap.y)<36;
            click(pt,1); if(dbl) setTimeout(()=>click(pt,1),70); lastTapAt=now; lastTap=pt;
        }
        if(map.size<2)tf=null; if(!map.size)clearTimeout(longT);
    },{passive:false,signal:sig});
    canvas.addEventListener('pointercancel', (e) => {
        if (isDesktopMousePointer(e)) return;
        const t=map.get(e.pointerId||'p0'); if(t?.down)up(1); map.delete(e.pointerId||'p0');
        if(!map.size)clearTimeout(longT);
    },{passive:true,signal:sig});
    const tId = (t) => '_t'+t.identifier;
    canvas.addEventListener('touchstart', (e) => {
        console.info('[rdp-touch] touchstart', {msg:'native touch fallback',touches:e.touches?.length});
        if(Date.now()-pointerTouchTs<450) { console.info('[rdp-touch] touchstart skipped, pointer just fired'); return; }
        for(const t of Array.from(e.changedTouches)){const pt=p(t.clientX,t.clientY); if(!pt)continue;
            map.set(tId(t),{sx:t.clientX,sy:t.clientY,cx:t.clientX,cy:t.clientY,pos:pt,last:pt,moved:false,down:false,right:false});
            snd({type:'mouse',x:pt.x,y:pt.y});}
        if(map.size===1){clearTimeout(longT); const first=Array.from(map.values())[0];
            longT=setTimeout(()=>{if(map.size===1&&first&&!first.moved&&first.last){click(first.last,3);first.right=true;}longT=0;},620);}
        else if(map.size===2){clearTimeout(longT);const a=Array.from(map.values());tf={x:(a[0].cx+a[1].cx)/2,y:(a[0].cy+a[1].cy)/2};}
        e.preventDefault();
    },{passive:false,signal:sig});
    canvas.addEventListener('touchmove', (e) => {
        if(Date.now()-pointerTouchTs<450)return;
        for(const t of Array.from(e.changedTouches)){
            const id=tId(t),st=map.get(id); if(!st)continue;
            const pt=p(t.clientX,t.clientY); st.cx=t.clientX;st.cy=t.clientY; if(pt)st.last=pt;
            if(!st.moved&&Math.hypot(t.clientX-st.sx,t.clientY-st.sy)>10){st.moved=true;clearTimeout(longT);}
            if(map.size===2){const a=Array.from(map.values());const cx=(a[0].cx+a[1].cx)/2,cy=(a[0].cy+a[1].cy)/2;if(tf){const dy=cy-tf.y,dx=cx-tf.x;if(Math.abs(dy)>12||Math.abs(dx)>18){snd({type:'scroll',deltaY:-dy,deltaX:-dx});tf={x:cx,y:cy};}}}
            else if(pt&&!st.right){
                if(st.moved&&!st.down){snd({type:'mouse',x:pt.x,y:pt.y});down(1);st.down=true;}
                else if(st.down)snd({type:'mouse',x:pt.x,y:pt.y});}
        }
        e.preventDefault();
    },{passive:false,signal:sig});
    canvas.addEventListener('touchend', (e) => {
        if(Date.now()-pointerTouchTs<450)return;
        for(const t of Array.from(e.changedTouches)){const id=tId(t),st=map.get(id); if(!st)continue;
            const pt=p(t.clientX,t.clientY)||st.last||st.pos; map.delete(id);
            if(st.down) up(1);
            else if(!st.moved&&!st.right&&pt){const now=Date.now();const dbl=lastTap&&now-lastTapAt<360&&Math.hypot(pt.x-lastTap.x,pt.y-lastTap.y)<36;
                click(pt,1); if(dbl)setTimeout(()=>click(pt,1),70); lastTapAt=now; lastTap=pt;}}
        if(map.size<2)tf=null; if(!map.size)clearTimeout(longT);
        e.preventDefault();
    },{passive:false,signal:sig});
    canvas.addEventListener('touchcancel', () => {if(!map.size)clearTimeout(longT); map.clear();tf=null;},{passive:true,signal:sig});
    canvas.addEventListener('wheel', (e) => {
        const pt=p(e.clientX,e.clientY); if(!pt)return;
            if (!isDesktopMousePointer(e) && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                const factor = Math.exp(-e.deltaY / 700);
                setRdpScaleZoom(rdpScaleZoom * factor);
                return;
            }
            e.preventDefault(); snd({type:'mouse',x:pt.x,y:pt.y}); snd({type:'scroll',deltaY:e.deltaY,deltaX:e.deltaX});
    },{passive:false,signal:sig});
    // Document-level fallback - if canvas misses events, forward them
    document.addEventListener('pointerdown', (e) => {
        const cv = document.getElementById('rdp-canvas');
        if (!cv) return;
        const rect = cv.getBoundingClientRect();
        if (e.clientX < rect.left-4 || e.clientX > rect.right+4 || e.clientY < rect.top-4 || e.clientY > rect.bottom+4) return;
        if (e.target === cv || cv.contains(e.target)) return; // already handled by canvas listener
        console.warn('[rdp-touch] pointerdown MISSED canvas, forwarding', {targetTag:e.target?.tagName, targetId:e.target?.id, x:e.clientX, y:e.clientY, connected});
        if (!connected || !rdpInputSender) return;
        const x = Math.round((e.clientX-rect.left)*(displayWidth||cv.width||1280)/rect.width);
        const y = Math.round((e.clientY-rect.top)*(displayHeight||cv.height||720)/rect.height);
        rdpInputSender({type:'mouse',x,y}); rdpInputSender({type:'click',button:1});
        notifyParentActivity();
        setTransientStatus(`\u8865\u83b7\u70b9\u51fb (${x},${y})`);
    }, {capture:true,passive:false,signal:sig});
    console.info('[rdp-client]', 'canvas touch bound+fallback', {w:canvas.width,h:canvas.height, conn:connected, sender:!!rdpInputSender});
}

class WebCodecsH264Display {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    }
    setSize(w, h) {
        if (this.canvas.width !== w || this.canvas.height !== h) {
            this.canvas.width = w; this.canvas.height = h;
            displayWidth = w; displayHeight = h;
            applyDisplayScale();
        }
    }
    draw(frame) {
        this.setSize(frame.displayWidth || frame.codedWidth || this.canvas.width || 1280,
                     frame.displayHeight || frame.codedHeight || this.canvas.height || 720);
        this.ctx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
        rdpLastFrameAt = Date.now();
    }
}

class H264BitReader {
    constructor(bytes) { this.bytes = bytes; this.bit = 0; }
    readBit() {
        const byte = this.bytes[this.bit >> 3];
        const val = (byte >> (7 - (this.bit & 7))) & 1;
        this.bit += 1;
        return val;
    }
    readBits(n) { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | this.readBit(); return v >>> 0; }
    readUE() {
        let zeros = 0;
        while (this.bit < this.bytes.length * 8 && this.readBit() === 0) zeros++;
        if (zeros === 0) return 0;
        return ((1 << zeros) - 1 + this.readBits(zeros)) >>> 0;
    }
}

function h264Rbsp(nal) {
    const out = [];
    for (let i = 1; i < nal.length; i++) {
        if (i + 2 < nal.length && nal[i] === 0 && nal[i + 1] === 0 && nal[i + 2] === 3) {
            out.push(0, 0);
            i += 2;
        } else {
            out.push(nal[i]);
        }
    }
    return new Uint8Array(out);
}

function h264FirstMbInSlice(nal) {
    try {
        const type = nal[0] & 0x1f;
        if (type !== 1 && type !== 5) return null;
        return new H264BitReader(h264Rbsp(nal)).readUE();
    } catch {
        return null;
    }
}

class AnnexBH264AccessUnitParser {
    constructor(onConfig, onFrame) {
        this.buffer = new Uint8Array(0);
        this.pending = [];
        this.sps = null;
        this.pps = null;
        this.configured = false;
        this.hasVcl = false;
        this.onConfig = onConfig;
        this.onFrame = onFrame;
    }
    push(chunk) {
        const incoming = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk || 0);
        const b = new Uint8Array(this.buffer.length + incoming.length);
        b.set(this.buffer, 0);
        b.set(incoming, this.buffer.length);
        this.buffer = b;
        for (const nal of this.extractNalUnits(false)) this.acceptNal(nal);
    }
    flush() {
        for (const nal of this.extractNalUnits(true)) this.acceptNal(nal);
        this.emitPending(true);
    }
    acceptNal(nal) {
        if (!nal || nal.length < 1) return;
        const type = nal[0] & 0x1f;
        if (type === 7) this.sps = nal;
        if (type === 8) this.pps = nal;
        if (!this.configured && this.sps && this.pps) {
            this.configured = true;
            this.onConfig(this.buildAvcc(this.sps, this.pps));
        }

        const isVcl = type === 1 || type === 5;
        if (type === 9 && this.pending.length > 0) this.emitPending(false);
        const firstMb = isVcl ? h264FirstMbInSlice(nal) : null;
        if (isVcl && this.hasVcl && firstMb === 0) this.emitPending(false);

        this.pending.push(nal);
        if (isVcl) this.hasVcl = true;
    }
    emitPending(force) {
        const hasSlice = this.pending.some((n) => { const t = n[0] & 0x1f; return t === 1 || t === 5; });
        if (!hasSlice && !force) return;
        if (!this.configured) return;
        const key = this.pending.some((n) => (n[0] & 0x1f) === 5);
        const size = this.pending.reduce((n, nal) => n + 4 + nal.length, 0);
        const out = new Uint8Array(size);
        let o = 0;
        for (const nal of this.pending) {
            out[o++] = (nal.length >>> 24) & 255;
            out[o++] = (nal.length >>> 16) & 255;
            out[o++] = (nal.length >>> 8) & 255;
            out[o++] = nal.length & 255;
            out.set(nal, o);
            o += nal.length;
        }
        this.pending = [];
        this.hasVcl = false;
        if (out.byteLength && hasSlice) this.onFrame(out, key);
    }
    extractNalUnits(flush) {
        const starts = [];
        for (let i = 0; i < this.buffer.length - 3; i++) {
            if (this.buffer[i] === 0 && this.buffer[i + 1] === 0 && this.buffer[i + 2] === 1) starts.push({ pos: i, len: 3 });
            else if (i < this.buffer.length - 4 && this.buffer[i] === 0 && this.buffer[i + 1] === 0 && this.buffer[i + 2] === 0 && this.buffer[i + 3] === 1) starts.push({ pos: i, len: 4 });
        }
        if (starts.length === 0) {
            if (this.buffer.length > 4 * 1024 * 1024) this.buffer = new Uint8Array(0);
            return [];
        }
        const completeCount = flush ? starts.length : Math.max(0, starts.length - 1);
        const out = [];
        for (let i = 0; i < completeCount; i++) {
            const s = starts[i].pos + starts[i].len;
            const e = (i + 1 < starts.length) ? starts[i + 1].pos : this.buffer.length;
            if (e > s) out.push(this.buffer.slice(s, e));
        }
        this.buffer = this.buffer.slice(flush ? this.buffer.length : starts[starts.length - 1].pos);
        return out;
    }
    buildAvcc(sps, pps) {
        const avcc = new Uint8Array(11 + sps.length + pps.length);
        avcc[0] = 1;
        avcc[1] = sps[1] || 0x42;
        avcc[2] = sps[2] || 0x00;
        avcc[3] = sps[3] || 0x1f;
        avcc[4] = 0xff;
        avcc[5] = 0xe1;
        avcc[6] = (sps.length >> 8) & 255;
        avcc[7] = sps.length & 255;
        avcc.set(sps, 8);
        const aoff = 8 + sps.length;
        avcc[aoff] = 1;
        avcc[aoff + 1] = (pps.length >> 8) & 255;
        avcc[aoff + 2] = pps.length & 255;
        avcc.set(pps, aoff + 3);
        return avcc;
    }
}
async function connect() {
    params = loadParams();
    const label = protocolLabel();
    if (!params.connectionId) {
        setStatus('error', `缺少 ${label} 连接参数`);
        return;
    }

    disconnect(false);
    updateInfo();
    setStatus('connecting', `正在连接 ${label} H.264...`);

    try {
        displayRoot.innerHTML = '';
        const canvas = document.createElement('canvas');
        canvas.id = 'rdp-canvas';
        canvas.tabIndex = 0;
        canvas.style.cssText = 'display:block;width:100%;height:auto;image-rendering:auto;cursor:default;touch-action:none;-webkit-user-select:none;user-select:none;outline:none';
        displayRoot.appendChild(canvas);
        const display = new WebCodecsH264Display(canvas);
        const wsBase = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/rdp-h264`;
        setRdpScaleZoom(1, { preserveViewport: false });
        rdpViewportOffsetX = 0;
        rdpViewportOffsetY = 0;
        setRdpScaleZoom(1, { preserveViewport: false });
        const initialTarget = computeRdpTargetSize(fitModes[fitModeIdx]);
        requestedRdpWidth = initialTarget.width;
        requestedRdpHeight = initialTarget.height;
        const requestedStreamMode = (urlParams.get('stream') || '').toLowerCase() === 'h264' || params.rdpNativeH264 === true ? 'h264' : 'av';
        const wsQuery = new URLSearchParams({ connectionId: params.connectionId, tabId: params.tabId || tabId, width: String(initialTarget.width), height: String(initialTarget.height), mode: initialTarget.mode, quality: qualityModes[qualityIdx], fps: String(params.rdpFps || 60), stream: requestedStreamMode });
        const connectionSeq = rdpReconnectSeq;
        rdpSocket = new WebSocket(`${wsBase}?${wsQuery.toString()}`);
        rdpSocket.binaryType = 'arraybuffer';

        let decoder = null;
        let timestamp = 0;
        let frameDuration = Math.round(1000000 / 30);
        let configured = false;
        let pendingFrames = [];
        let firstFrameDrawn = false;
        let firstFrameWatchdog = 0;
        let avMode = false;
        let avVideo = null;
        let avMediaSource = null;
        let avSourceBuffer = null;
        const avQueue = [];
        let avStaging = new Uint8Array(0);
        const mp4BoxSize = (buf, off) => {
            if (off + 8 > buf.length) return 0;
            const size = ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
            return size >= 8 ? size : 0;
        };
        const mp4BoxType = (buf, off) => String.fromCharCode(buf[off + 4] || 0, buf[off + 5] || 0, buf[off + 6] || 0, buf[off + 7] || 0);
        const pumpAvQueue = () => {
            if (!avSourceBuffer || avSourceBuffer.updating || !avQueue.length) return;
            try { avSourceBuffer.appendBuffer(avQueue.shift()); } catch (err) { console.warn('[rdp-av]', 'append failed', err); avQueue.length = 0; }
        };
        const feedAvMp4 = (buf) => {
            const incoming = new Uint8Array(buf);
            const joined = new Uint8Array(avStaging.length + incoming.length); joined.set(avStaging); joined.set(incoming, avStaging.length); avStaging = joined;
            let off = 0, segStart = 0, inFrag = false;
            while (off + 8 <= avStaging.length) {
                const size = mp4BoxSize(avStaging, off);
                if (!size || off + size > avStaging.length) break;
                const type = mp4BoxType(avStaging, off);
                if (type === 'ftyp') segStart = off;
                if (type === 'moof') { segStart = off; inFrag = true; }
                off += size;
                if (type === 'moov' || (type === 'mdat' && inFrag)) {
                    const seg = avStaging.slice(segStart, off);
                    avQueue.push(seg.buffer.slice(seg.byteOffset, seg.byteOffset + seg.byteLength));
                    inFrag = false; segStart = off; pumpAvQueue();
                }
            }
            avStaging = avStaging.slice(segStart);
            if (avStaging.length > 16 * 1024 * 1024) avStaging = new Uint8Array(0);
        };
        const startAvPlayback = (mime) => {
            avMode = true;
            canvas.style.display = 'none';
            avVideo = document.createElement('video');
            avVideo.id = 'rdp-video';
            avVideo.autoplay = true; avVideo.playsInline = true; avVideo.controls = false; avVideo.tabIndex = 0;
            avVideo.style.cssText = 'display:block;width:100%;height:100%;object-fit:fill;background:#000;touch-action:none;outline:none;max-width:none;max-height:none;min-width:100%;min-height:100%';
            displayRoot.appendChild(avVideo);
            bindCanvasTouch(avVideo);
            avMediaSource = new MediaSource();
            avVideo.src = URL.createObjectURL(avMediaSource);
            avMediaSource.addEventListener('sourceopen', () => {
                try { avSourceBuffer = avMediaSource.addSourceBuffer(mime || 'video/mp4; codecs="avc1.4d401f,mp4a.40.2"'); avSourceBuffer.mode = 'segments'; avSourceBuffer.addEventListener('updateend', pumpAvQueue); pumpAvQueue(); avVideo.play().catch(()=>{}); }
                catch (err) { setStatus('error', `RDP A/V 初始化失败：${err.message || err}`); }
            }, { once: true });
            avVideo.addEventListener('loadedmetadata', () => { displayWidth = avVideo.videoWidth || requestedRdpWidth || 1280; displayHeight = avVideo.videoHeight || requestedRdpHeight || 720; applyDisplayScale(); });
            avVideo.addEventListener('loadeddata', () => {
                if (!firstFrameDrawn) { firstFrameDrawn = true; if (firstFrameWatchdog) { clearTimeout(firstFrameWatchdog); firstFrameWatchdog = 0; } setStatus('connected', `${label} 已连接 [H.264/AAC]`); connected = true; startClipboardAutoSync(); requestRdpCanvasSize(fitModes[fitModeIdx], true); notifyParentStatus('connected'); }
            });
            avVideo.addEventListener('error', () => { const err = avVideo.error; setStatus('error', `RDP A/V 播放失败：code=${err?.code || 'unknown'} ${err?.message || ''}`); });
            avMediaSource.addEventListener('sourceended', () => console.warn('[rdp-av]', 'media source ended'));
            avMediaSource.addEventListener('sourceclose', () => console.warn('[rdp-av]', 'media source closed'));
        };
        const wsInput = (message) => {
            if (!rdpSocket || rdpSocket.readyState !== WebSocket.OPEN) return false;
            try { rdpSocket.send(JSON.stringify(message)); return true; } catch { return false; }
        };
        rdpInputSender = wsInput;
        rdpTouches.clear();
        displayRoot.style.pointerEvents = 'auto';
        displayShell && (displayShell.style.pointerEvents = 'auto');
        canvas.style.pointerEvents = 'auto';
        bindCanvasTouch(canvas);

        const parser = new AnnexBH264AccessUnitParser(async (description) => {
            if (!window.VideoDecoder || !window.EncodedVideoChunk) {
                setStatus('error', '此浏览器不支持 WebCodecs H.264 解码，请使用 Chrome/Edge/Safari 16.4+');
                return;
            }
            const codec = `avc1.${[description[1], description[2], description[3]].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
            const config = { codec, description, hardwareAcceleration: 'prefer-hardware', optimizeForLatency: true };
            const support = await VideoDecoder.isConfigSupported(config).catch(() => ({ supported: false }));
            if (!support.supported) {
                setStatus('error', `当前浏览器不支持编解码 ${codec}`);
                return;
            }
            decoder = new VideoDecoder({
                output: (frame) => {
                    try {
                        display.draw(frame);
                        if (!firstFrameDrawn) {
                            firstFrameDrawn = true;
                            if (firstFrameWatchdog) { clearTimeout(firstFrameWatchdog); firstFrameWatchdog = 0; }
                            setStatus('connected', `${label} 已连接 [WebCodecs H.264]`);
                            connected = true;
                            startClipboardAutoSync();
                            // audio is muxed into the main H.264/AAC video stream
                            requestRdpCanvasSize(fitModes[fitModeIdx], true);
                            notifyParentStatus('connected');
                        }
                    } finally { frame.close(); }
                },
                error: (err) => {
                    console.warn('[rdp] decoder error', err);
                    setStatus('error', `H.264 解码失败：${err.message || err}`);
                },
            });
            decoder.configure(config);
            configured = true;
            for (const item of pendingFrames.splice(0)) decodeFrame(item.data, item.key);
        }, (data, key) => {
            if (!configured) pendingFrames.push({ data, key });
            else decodeFrame(data, key);
        });

        function decodeFrame(data, key) {
            if (!decoder || decoder.state !== 'configured') return;
            if (decoder.decodeQueueSize > 2 && !key) return;
            timestamp += frameDuration;
            try {
                decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp, duration: frameDuration, data }));
            } catch (err) {
                console.warn('[rdp] decode rejected', err);
            }
        }

        rdpSocket.onopen = () => {
            setStatus('connecting', `${label} 视频通道已建立，等待首帧...`);
            connected = true;
            canvas.focus({ preventScroll: true });
            notifyParentStatus('connecting');
            if (requestedStreamMode === 'h264') {
                firstFrameWatchdog = window.setTimeout(() => {
                    if (firstFrameDrawn || !rdpSocket || rdpSocket.readyState !== WebSocket.OPEN) return;
                    console.warn('[rdp-client]', 'native H.264 first frame timeout, falling back to A/V stream');
                    params.rdpNativeH264 = false;
                    try { rdpSocket.close(1012, '原生 H.264 首帧超时，切换兼容 A/V 模式...'); } catch {}
                }, 7000);
            }
        };
        rdpSocket.onclose = (event) => {
            if (firstFrameWatchdog) { clearTimeout(firstFrameWatchdog); firstFrameWatchdog = 0; }
            if (!avMode) parser.flush();
            if (connectionSeq !== rdpReconnectSeq) return;
            connected = false;
            notifyParentStatus('disconnected');
            if (decoder) { try { decoder.close(); } catch {} decoder = null; }
            if (avVideo) { try { avVideo.pause(); URL.revokeObjectURL(avVideo.src); avVideo.remove(); } catch {} avVideo = null; }
            if (event.code === 1012) {
                rdpTouches.clear();
                updateRdpPointer(0, 0, false);
                stopClipboardAutoSync();
                stopRdpAudio();
                setStatus('connecting', event.reason || '正在切换 RDP 分辨率...');
                rdpReconnectPending = false;
                const seq = ++rdpReconnectSeq;
                window.setTimeout(() => { if (seq === rdpReconnectSeq) connect(); }, 650);
                return;
            }
            setStatus('disconnected', event.reason || `${label} 已断开`);
            stopRdpAudio();
            stopClipboardAutoSync();
        };
        rdpSocket.onerror = () => { if (connectionSeq === rdpReconnectSeq) setStatus('error', `${label} WebSocket 连接失败`); };
        rdpSocket.onmessage = async (ev) => {
            if (typeof ev.data === 'string') {
                try {
                    const msg = JSON.parse(ev.data);
                    if (msg.type === 'hello') {
                        if (msg.codec === 'fmp4-av' && !avMediaSource) { configured = true; startAvPlayback(msg.mime); }
                        if (msg.width && msg.height) {
                            display.setSize(Number(msg.width), Number(msg.height));
                            requestedRdpWidth = Number(msg.width) || requestedRdpWidth;
                            requestedRdpHeight = Number(msg.height) || requestedRdpHeight;
                            if (msg.fps) frameDuration = Math.round(1000000 / Number(msg.fps));
                            window.setTimeout(() => requestRdpCanvasSize(fitModes[fitModeIdx], true), 300);
                        }
                    } else if (msg.type === 'clipboard' && typeof msg.text === 'string') {
                        lastRemoteClipboard = msg.text;
                        if (remoteClipboardText) remoteClipboardText.value = msg.text;
                        notifyParentSharedClipboardText(msg.text);
                        setClipboardHint(`收到远程剪贴板 ${msg.text.length} 字符，正在同步到本机...`, 'info');
                        writeHostClipboard(msg.text).then((ok) => {
                            clipboardAutoWriteOk = ok;
                            clipboardAutoWriteFailed = !ok;
                            setClipboardHint(ok ? '远程剪贴板已自动同步到本机' : '已收到远程剪贴板；浏览器阻止自动写入，请点“复制到本机”', ok ? 'success' : 'warning');
                        });
                    } else if (msg.type === 'rdp-file-clipboard-ready') {
                        setClipboardHint(`RDP 原生文件剪贴板已就绪：${msg.count || 0} 个文件，可在远端任意目录 Ctrl+V 粘贴`, 'success');
                        setTransientStatus(`文件剪贴板已就绪（原生 CLIPRDR）`);
                    } else if (msg.type === 'rdp-sftp-clipboard-paste-ack') {
                        if (msg.ok) {
                            setClipboardHint(`已从 SSH 发布 ${msg.count || 0} 个文件到 RDP 原生文件剪贴板，并已发送 Ctrl+V`, 'success');
                            setTransientStatus('文件将粘贴到远端当前目录（Windows RDP CLIPRDR）');
                        } else {
                            setClipboardHint(msg.error || 'SSH 文件粘贴失败', 'warning');
                        }
                    } else if (msg.type === 'rdp-remote-files' && Array.isArray(msg.files)) {
                        // Remote Windows files were copied → xfreerdp downloaded them to server temp dir
                        // Only store metadata, don't transfer until user acts
                        rdpRemoteFileClipboard = msg.files.map((f) => ({
                            id: f.path,
                            name: f.name,
                            size: f.size,
                            remotePath: f.path,
                        }));
                        renderRemoteFileList();
                        setClipboardHint(`远程 Windows 复制了 ${msg.files.length} 个文件，点"文件"按钮查看和下载`, 'success');
                        setTransientStatus(`远程剪贴板有 ${msg.files.length} 个文件`);
                        // Notify parent with metadata only (no dataUrl, no auto-transfer)
                        notifyParentSharedFileClipboard(rdpRemoteFileClipboard.map((f) => ({
                            id: f.id, name: f.name, size: f.size, remotePath: f.remotePath,
                        })));
                    }
                } catch {}
                return;
            }
            const buf = ev.data instanceof ArrayBuffer ? ev.data : ev.data instanceof Blob ? await ev.data.arrayBuffer() : null;
            if (!buf || buf.byteLength < 5) return;
            if (avMode) feedAvMp4(buf);
            else parser.push(new Uint8Array(buf));
        };
        const sendKeyboardEventToRdp = (e) => {
            if (!rdpInputSender || !connected) return false;
            const key = e.key || '';
            const code = e.code || '';
            if (e.isComposing || key === 'Process' || key === 'Dead') return false;
            if (e.ctrlKey || e.metaKey || e.altKey) {
                const combo = [];
                if (e.ctrlKey) combo.push('ctrl');
                if (e.altKey) combo.push('alt');
                if (e.metaKey) combo.push('Super_L');
                if (e.shiftKey) combo.push('shift');
                const base = key.length === 1 ? key.toLowerCase() : keysymToXdotool(keyEventToKeysym(e));
                if (!base || base === '0') return false;
                e.preventDefault();
                wsInput({ type: 'key', key: [...combo, base].join('+') });
                notifyParentActivity();
                return true;
            }
            if (key.length === 1) {
                e.preventDefault();
                wsInput({ type: 'text', text: key });
                notifyParentActivity();
                return true;
            }
            const keysym = keyEventToKeysym(e);
            const xKey = keysym ? keysymToXdotool(keysym) : (code ? code.replace(/^Key/, '').replace(/^Digit/, '') : '');
            if (!xKey || xKey === '0') return false;
            e.preventDefault();
            wsInput({ type: 'key', key: xKey });
            notifyParentActivity();
            return true;
        };
        // Use a single capture-phase listener on document to avoid double-firing
        // (canvas keydown + document capture both fired for the same event before).
        // The capture listener fires first; we stopPropagation after handling.
        document.addEventListener('keydown', (e) => {
            if (!connected || !rdpInputSender) return;
            if (isTextInputTarget(e.target)) return;
            if (sendKeyboardEventToRdp(e)) {
                e.stopPropagation();
            }
        }, true);
    } catch (err) {
        console.error('[rdp-client]', 'connect failed', err);
        setStatus('error', err.message || `${label} 连接失败`);
    }
}

function disconnect(userInitiated = true) {
    if (rdpSocket && rdpSocket.readyState !== WebSocket.CLOSED) {
        try { rdpSocket.close(); } catch {}
    }
    rdpSocket = null;
    rdpInputSender = null;
    try { canvasTouchAbort?.abort(); } catch {}
    canvasTouchAbort = null;
    rdpTouches.clear();
    updateRdpPointer(0, 0, false);
    connected = false;
    if (userInitiated) {
        stopClipboardAutoSync();
        stopRdpAudio();
        setStatus('disconnected', `${protocolLabel()} 已断开`);
        try {
            sessionStorage.removeItem(params?.tabId ? `zephyr_remote_desktop_params_${params.tabId}` : 'zephyr_remote_desktop_params');
        } catch {}
    }
}

function reconnect() {
    const label = protocolLabel();
    window.clearTimeout(rdpReconnectTimer);
    rdpReconnectPending = false;
    rdpReconnectSeq += 1;
    rdpLastReconnectAt = Date.now();
    setStatus('connecting', `正在重连 ${label}...`);
    stopClipboardAutoSync();
    stopRdpAudio();
    disconnect(false);
    window.setTimeout(() => connect(), 260);
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
function isCompactScreen() {
    return isPhoneLikeEnvironment();
}

function floatingPanels() {
    return [clipboardPanel, shortcutsPanel, joystickPanel].filter(Boolean);
}

function getDefaultPanelOptions(panel) {
    const parentRect = panel?.parentElement?.getBoundingClientRect?.() || { width: window.innerWidth, height: window.innerHeight };
    if (panel === joystickPanel) {
        return { left: 10, top: Math.max(48, parentRect.height - 228), width: Math.min(248, parentRect.width - 20), height: 220 };
    }
    if (isCompactScreen()) {
        if (panel === joystickPanel) {
            return { left: 10, top: Math.max(48, parentRect.height - 274), width: Math.min(300, parentRect.width - 20), height: 248 };
        }
        return {
            left: 8,
            top: 44,
            width: Math.max(280, parentRect.width - 16),
            height: Math.max(260, Math.min(parentRect.height - 58, panel === shortcutsPanel ? 360 : 430)),
        };
    }
    if (panel === shortcutsPanel) {
        return { width: Math.min(460, parentRect.width - 24), height: Math.min(360, parentRect.height - 80), left: 18, top: 54 };
    }
    if (panel === joystickPanel) {
        return { width: 286, height: 244, left: 18, top: Math.max(60, parentRect.height - 270) };
    }
    return { width: Math.min(440, parentRect.width - 24), height: Math.min(500, parentRect.height - 80), left: Math.max(18, parentRect.width - 460), top: 54 };
}

function ensureFloatingPanel(panel, defaults = {}) {
    if (!panel || panel.dataset.floatingReady === '1') return;
    const parentRect = panel.parentElement.getBoundingClientRect();
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
    if (panel === joystickPanel) sizeJoystickPanel(panel, width, height, left);
    panel.dataset.floatingReady = '1';
    console.info('[rdp-client]', 'floating panel initialized', { id: panel.id, left, top, width, height });
}

function clampPanel(panel) {
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const parentRect = panel.parentElement.getBoundingClientRect();
    const minVisible = isCompactScreen() ? 140 : 80;
    const left = Math.min(Math.max(rect.left - parentRect.left, -rect.width + minVisible), parentRect.width - minVisible);
    const top = Math.min(Math.max(rect.top - parentRect.top, 8), parentRect.height - minVisible);
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
    console.debug('[rdp-client]', 'floating panel front', { id: panel.id });
}

function applyPanelLayout(panel, layout) {
    if (!panel) return;
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
    console.info('[rdp-client]', 'floating panel layout applied', { id: panel.id, layout, left, top, width, height });
}

let panelLayoutButton = null;
function positionPanelLayoutMenu(menu, button, { collapsed = false } = {}) {
    if (!menu || !button) return;
    const rect = button.getBoundingClientRect();
    const viewport = window.visualViewport;
    const vvLeft = viewport?.offsetLeft || 0;
    const vvTop = viewport?.offsetTop || 0;
    const vvWidth = viewport?.width || window.innerWidth;
    const vvHeight = viewport?.height || window.innerHeight;
    const anchorX = rect.left + rect.width / 2;
    const finalWidth = Math.min(284, Math.max(160, vvWidth - 16));
    const finalHeight = 50;
    const finalLeft = anchorX - finalWidth / 2;
    const finalTop = rect.top;
    menu.style.left = `${collapsed ? rect.left : finalLeft}px`;
    menu.style.top = `${finalTop}px`;
    menu.style.setProperty('--panel-island-menu-width', `${collapsed ? rect.width : finalWidth}px`);
    menu.style.setProperty('--panel-island-menu-height', `${collapsed ? rect.height : finalHeight}px`);
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
    requestAnimationFrame(() => {
        menu.style.removeProperty('transition');
        positionPanelLayoutMenu(menu, button, { collapsed: true });
    });
    menu._closeTimer = window.setTimeout(() => {
        button.classList.remove('active-layout'); button.style.opacity = '1'; requestAnimationFrame(() => button.style.removeProperty('opacity')); menu.remove();
        if (panelLayoutMenu === menu) panelLayoutMenu = null;
        if (panelLayoutButton === button) panelLayoutButton = null;
    }, 460);
}

function openPanelLayoutMenu(button, panel) {
    closePanelLayoutMenu({ instant: true });
    panelLayoutButton = button;
    button?.classList.remove('active-layout');
    const menu = document.createElement('div');
    menu.className = 'panel-layout-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', '窗口布局');
    menu.innerHTML = `
        <button data-layout="full" title="全屏" aria-label="全屏"><span class="panel-layout-icon full"></span></button>
        <button data-layout="half" title="半屏" aria-label="半屏"><span class="panel-layout-icon half"></span></button>
        <button data-layout="left-quarter" title="左侧四分之一" aria-label="左侧四分之一"><span class="panel-layout-icon left"></span></button>
        <button data-layout="right-quarter" title="右侧四分之一" aria-label="右侧四分之一"><span class="panel-layout-icon right"></span></button>
        <button data-layout="close" class="panel-layout-close" title="关闭窗口" aria-label="关闭窗口"><span class="panel-layout-icon close"></span></button>
    `;
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
        window.setTimeout(() => {
            menu.classList.remove('island-animating');
            menu.style.removeProperty('opacity');
        }, 540);
    });
    menu.addEventListener('click', (event) => {
        const item = event.target.closest('[data-layout]');
        if (!item) return;
        if (item.dataset.layout === 'close') {
            togglePanel(panel, false);
            return;
        }
        applyPanelLayout(panel, item.dataset.layout);
        closePanelLayoutMenu();
    });
    if (panelLayoutMenu !== menu) panelLayoutMenu = menu;
}

function setupPanelLayoutMenu() {
    document.querySelectorAll('[data-layout-panel]').forEach((button) => {
        const panel = document.getElementById(button.dataset.layoutPanel);
        if (!panel) return;
        button.addEventListener('pointerdown', (event) => {
            event.preventDefault();
            event.stopPropagation();
            bringPanelToFront(panel);
            button.classList.add('pressing');
            button.setPointerCapture?.(event.pointerId);

            const startX = event.clientX;
            const startY = event.clientY;
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
                if (moved) console.info('[rdp-client]', 'floating panel moved by traffic handle', { id: panel.id, left: panel.offsetLeft, top: panel.offsetTop });
            };

            window.addEventListener('pointermove', onMove, { passive: false });
            window.addEventListener('pointerup', onUp, { once: true });
            window.addEventListener('pointercancel', onUp, { once: true });
        });
        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (suppressNextLayoutClick) {
                suppressNextLayoutClick = false;
                return;
            }
            bringPanelToFront(panel);
            const willOpen = !panelLayoutMenu;
            console.info('[DynamicIslandDiagnostics]', {
                event: 'rdp-layout-menu-toggle',
                panelId: panel?.id || '',
                buttonId: button?.id || '',
                open: willOpen,
                suppressNextLayoutClick: false,
            });
            if (navigator.vibrate) navigator.vibrate(8);
            if (panelLayoutMenu && panelLayoutButton === button) closePanelLayoutMenu();
            else openPanelLayoutMenu(button, panel);
        });
    });
    document.addEventListener('pointerdown', (event) => {
        if (panelLayoutMenu && !event.target.closest('.panel-layout-menu') && !event.target.closest('[data-layout-panel]')) closePanelLayoutMenu();
    });
    window.addEventListener('resize', closePanelLayoutMenu);
}

function setupPanelDrag() {
    const handles = [
        ...document.querySelectorAll('[data-drag-panel]'),
        ...document.querySelectorAll('.rdp-floating-panel .panel-titlebar'),
    ];
    handles.forEach((handle) => {
        const panel = handle.dataset.dragPanel
            ? document.getElementById(handle.dataset.dragPanel)
            : handle.closest('.rdp-floating-panel');
        if (!panel) return;
        handle.addEventListener('pointerdown', (event) => {
            if (event.target.closest('button,input,select,textarea,label')) return;
            event.preventDefault();
            bringPanelToFront(panel);
            panel.classList.add('dragging');
            handle.setPointerCapture?.(event.pointerId);
            const startX = event.clientX;
            const startY = event.clientY;
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
                console.info('[rdp-client]', 'floating panel dragged', { id: panel.id, left: panel.offsetLeft, top: panel.offsetTop });
            };
            window.addEventListener('pointermove', onMove, { passive: false });
            window.addEventListener('pointerup', onUp, { once: true });
        });
    });
}

function setupPanelResize() {
    document.querySelectorAll('[data-resize-panel]').forEach((handle) => {
        const panel = document.getElementById(handle.dataset.resizePanel);
        if (!panel) return;
        handle.addEventListener('pointerdown', (event) => {
            event.preventDefault();
            event.stopPropagation();
            bringPanelToFront(panel);
            panel.classList.add('resizing');
            handle.setPointerCapture?.(event.pointerId);
            const startX = event.clientX;
            const startY = event.clientY;
            const startWidth = panel.offsetWidth;
            const startHeight = panel.offsetHeight;
            const startLeft = panel.offsetLeft;
            const edge = handle.dataset.resizeEdge || 'right';
            const parentRect = panel.parentElement.getBoundingClientRect();
            const compact = isCompactScreen();
            const minWidth = compact ? 260 : 320;
            const minHeight = compact ? 220 : 260;

            const onMove = (ev) => {
                ev.preventDefault();
                if (panel === joystickPanel) {
                    const dx = ev.clientX - startX;
                    const dy = ev.clientY - startY;
                    const edgeSign = edge === 'left' ? -1 : 1;
                    const delta = Math.abs(dx) > Math.abs(dy) ? dx * edgeSign : dy;
                    const targetW = startWidth + delta;
                    const anchorLeft = edge === 'left' ? startLeft + startWidth - Math.max(150, targetW) : startLeft;
                    sizeJoystickPanel(panel, targetW, null, anchorLeft);
                    return;
                }
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
                const maxWidth = edge === 'left' ? startLeft + startWidth - 8 : parentRect.width - panel.offsetLeft - 12;
                const maxHeight = parentRect.height - panel.offsetTop - 12;
                const width = Math.min(Math.max(minWidth, nextWidth), maxWidth);
                const height = Math.min(Math.max(minHeight, startHeight + ev.clientY - startY), maxHeight);
                panel.style.width = `${width}px`;
                panel.style.height = `${height}px`;
            };
            const onUp = () => {
                panel.classList.remove('resizing');
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
                console.info('[rdp-client]', 'floating panel resized', { id: panel.id, width: panel.offsetWidth, height: panel.offsetHeight });
            };
            window.addEventListener('pointermove', onMove, { passive: false });
            window.addEventListener('pointerup', onUp, { once: true });
        });
    });
}

function updateJoystickHint() {
    // 摇杆浮窗不显示文字提示；保留空函数给滚动/缩放流程调用。
}

function setupViewportJoystick() {
    if (!joystickContainer || !joystickKnob || joystickContainer.dataset.ready === '1') return;
    joystickContainer.dataset.ready = '1';
    const icons = joystickContainer.querySelectorAll('.rdp-joystick-icon');
    const deadzone = 4;
    const maxTilt = 14;
    let active = false;
    let startX = 0;
    let startY = 0;
    let raf = 0;
    let resetTimer = 0;

    const clearHighlights = () => icons.forEach((icon) => icon.classList.remove('active'));
    const applyVisual = (x, y) => {
        const maxRadius = Math.max(24, joystickContainer.getBoundingClientRect().width * 0.23);
        const clampedX = Math.min(Math.max(x, -maxRadius), maxRadius);
        const clampedY = Math.min(Math.max(y, -maxRadius), maxRadius);
        const distance = Math.hypot(clampedX, clampedY);
        const normX = distance > 0.01 ? clampedX / maxRadius : 0;
        const normY = distance > 0.01 ? clampedY / maxRadius : 0;
        const rotY = normX * maxTilt;
        const rotX = normY * -maxTilt;
        joystickKnob.style.transform = `translate(${clampedX}px, ${clampedY}px) rotateX(${rotX}deg) rotateY(${rotY}deg)`;
        if (distance < deadzone) { clearHighlights(); return { x: 0, y: 0, intensity: 0 }; }
        const angleDeg = (Math.atan2(normY, normX) * 180 / Math.PI + 360) % 360;
        let activeIndex = angleDeg >= 45 && angleDeg < 135 ? 2 : angleDeg >= 135 && angleDeg < 225 ? 3 : angleDeg >= 225 && angleDeg < 315 ? 0 : 1;
        clearHighlights();
        icons[activeIndex]?.classList.add('active');
        return { x: normX, y: normY, intensity: Math.min(distance / maxRadius, 1) };
    };
    const reset = (smooth = true) => {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        setRdpInputSuppressed(false, 220);
        if (smooth) joystickKnob.classList.add('smooth-back');
        joystickKnob.style.transform = 'translate(0px, 0px) rotateX(0deg) rotateY(0deg)';
        clearHighlights();
        window.clearTimeout(resetTimer);
        resetTimer = window.setTimeout(() => joystickKnob.classList.remove('smooth-back'), 220);
        rdpJoystickState = null;
        updateJoystickHint();
    };
    const pumpScroll = () => {
        if (!active || !rdpJoystickState || !displayShell) { raf = 0; return; }
        const maxX = Math.max(0, displayShell.scrollWidth - displayShell.clientWidth);
        const maxY = Math.max(0, displayShell.scrollHeight - displayShell.clientHeight);
        const speed = 4 + 24 * rdpJoystickState.intensity;
        displayShell.scrollLeft = Math.max(0, Math.min(maxX, displayShell.scrollLeft + rdpJoystickState.x * speed));
        displayShell.scrollTop = Math.max(0, Math.min(maxY, displayShell.scrollTop + rdpJoystickState.y * speed));
        rdpViewportOffsetX = displayShell.scrollLeft - maxX / 2;
        rdpViewportOffsetY = displayShell.scrollTop - maxY / 2;
        updateJoystickHint();
        raf = requestAnimationFrame(pumpScroll);
    };
    const onMove = (event) => {
        if (!active) return;
        event.preventDefault();
        const dx = event.clientX - startX;
        const dy = event.clientY - startY;
        const dist = Math.hypot(dx, dy);
        const limitedX = dist > maxRadius ? dx / dist * maxRadius : dx;
        const limitedY = dist > maxRadius ? dy / dist * maxRadius : dy;
        rdpJoystickState = applyVisual(limitedX, limitedY);
        if (!raf) raf = requestAnimationFrame(pumpScroll);
    };
    const onEnd = () => {
        if (!active) return;
        active = false;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onEnd);
        window.removeEventListener('pointercancel', onEnd);
        reset(true);
    };
    joystickKnob.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        setRdpInputSuppressed(true);
        bringPanelToFront(joystickPanel);
        active = true;
        startX = event.clientX;
        startY = event.clientY;
        window.clearTimeout(resetTimer);
        joystickKnob.classList.remove('smooth-back');
        rdpJoystickState = applyVisual(0, 0);
        window.addEventListener('pointermove', onMove, { passive: false });
        window.addEventListener('pointerup', onEnd, { once: true });
        window.addEventListener('pointercancel', onEnd, { once: true });
        joystickKnob.setPointerCapture?.(event.pointerId);
    });
    joystickContainer.addEventListener('dragstart', (event) => event.preventDefault());
    displayShell?.addEventListener('scroll', () => {
        const maxX = Math.max(0, displayShell.scrollWidth - displayShell.clientWidth);
        const maxY = Math.max(0, displayShell.scrollHeight - displayShell.clientHeight);
        rdpViewportOffsetX = displayShell.scrollLeft - maxX / 2;
        rdpViewportOffsetY = displayShell.scrollTop - maxY / 2;
        updateJoystickHint();
    }, { passive: true });
    window.addEventListener('blur', () => { if (active) { active = false; reset(true); } });
    reset(false);
}

function setupFloatingPanels() {
    setupViewportJoystick();
    floatingPanels().forEach((panel) => {
        ensureFloatingPanel(panel, getDefaultPanelOptions(panel));
        panel.addEventListener('pointerdown', () => bringPanelToFront(panel));
    });
    setupPanelLayoutMenu();
    setupPanelDrag();
    setupPanelResize();
}

function animateRdpPanelFromButton(panel, button, opening = true) {
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
function clearRdpPanelMotion(panel) {
    panel?.classList.remove('panel-opening', 'panel-closing');
}

function togglePanel(panel, force, sourceButton = null) {
    if (!panel) return;
    ensureFloatingPanel(panel, getDefaultPanelOptions(panel));
    const shouldShow = force ?? panel.hidden;
    panel.hidden = !shouldShow;
    panel.classList.toggle('open', shouldShow);
    if (panel === clipboardPanel) {
        clipboardBtn?.classList.toggle('active', shouldShow);
        rdpFilesBtn?.classList.toggle('active', shouldShow);
    }
    if (panel === shortcutsPanel) shortcutsBtn?.classList.toggle('active', shouldShow);
    if (panel === joystickPanel) joystickBtn?.classList.toggle('active', shouldShow);
    const button = sourceButton || (panel === clipboardPanel ? (rdpFilesBtn || clipboardBtn) : panel === shortcutsPanel ? shortcutsBtn : panel === joystickPanel ? joystickBtn : null);
    requestAnimationFrame(() => animateRdpPanelFromButton(panel, button, shouldShow));
    if (shouldShow) bringPanelToFront(panel);
    else {
        closePanelLayoutMenu({ instant: true });
        window.setTimeout(() => clearRdpPanelMotion(panel), 320);
    }
    console.info('[rdp-client]', 'floating panel toggled', { id: panel.id, open: shouldShow });
}

function updateJoystickPanelScale(panel = joystickPanel) {
    if (!panel || !joystickContainer) return;
    const rect = panel.getBoundingClientRect?.() || { width: 248, height: 220 };
    const contentW = Math.max(1, rect.width - 34);
    const contentH = Math.max(1, rect.height - 58);
    const size = Math.max(112, Math.min(260, Math.floor(Math.min(contentW, contentH))));
    panel.style.setProperty('--rdp-joystick-size', `${size}px`);
}
function sizeJoystickPanel(panel, targetWidth, targetHeight = null, anchorLeft = null) {
    if (!panel) return;
    const aspect = 248 / 220;
    let w = Math.max(150, Math.min(window.innerWidth - 12, Number(targetWidth) || 248));
    let h = targetHeight == null ? Math.round(w / aspect) : Number(targetHeight);
    h = Math.max(140, Math.min(window.innerHeight - 12, h || 220));
    w = Math.max(150, Math.min(window.innerWidth - 12, Math.round(h * aspect)));
    panel.style.width = `${w}px`;
    panel.style.height = `${h}px`;
    if (anchorLeft !== null && Number.isFinite(anchorLeft)) panel.style.left = `${Math.max(4, Math.min(window.innerWidth - w - 4, anchorLeft))}px`;
    updateJoystickPanelScale(panel);
}
function setRdpInputSuppressed(value, holdMs = 180) {
    rdpInputSuppressed = !!value;
    rdpInputSuppressedUntil = value ? Number.POSITIVE_INFINITY : Date.now() + Math.max(0, Number(holdMs) || 0);
    stage?.classList.toggle('joystick-active', !!value);
}
function isRdpInputSuppressed() {
    return rdpInputSuppressed || Date.now() < rdpInputSuppressedUntil;
}

function setClipboardHint(message, level = 'info') {
    if (!clipboardHint) return;
    clipboardHint.textContent = message;
    clipboardHint.dataset.level = level;
}

function setTransientStatus(message, timeout = 1800) {
    const old = statusText?.textContent || '';
    if (statusText) statusText.textContent = message;
    window.setTimeout(() => {
        if (connected && statusText && statusText.textContent === message) {
            statusText.textContent = `${protocolLabel()} 已连接`;
        } else if (!connected && statusText && statusText.textContent === message) {
            statusText.textContent = old;
        }
    }, timeout);
}

function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function stopRdpAudio() {
    try { rdpAudioSocket?.close(); } catch {}
    rdpAudioSocket = null;
    try { rdpAudioElement?.pause(); } catch {}
    if (rdpAudioElement) {
        try { URL.revokeObjectURL(rdpAudioElement.src); } catch {}
        rdpAudioElement.remove();
    }
    try { if (rdpAudioElement) rdpAudioElement.playbackRate = 1; } catch {}
    rdpAudioElement = null;
    rdpAudioUnlocked = false;
    rdpAudioMediaSource = null;
    rdpAudioSourceBuffer = null;
    rdpAudioQueue = [];
}
function ensureRdpAudioUnlocked() {
    if (rdpAudioUnlocked || !rdpAudioElement) return;
    const tryPlay = () => {
        if (!rdpAudioElement) return;
        rdpAudioElement.muted = false;
        rdpAudioElement.volume = 1;
        rdpAudioElement.play().then(() => { rdpAudioUnlocked = true; }).catch((err) => console.debug('[rdp-audio]', 'play still blocked', { error: err.message }));
    };
    document.addEventListener('pointerdown', tryPlay, { once: true, passive: true });
    document.addEventListener('keydown', tryPlay, { once: true, passive: true });
}


function trimRdpAudioLatency() {
    if (!rdpAudioElement || !rdpAudioElement.buffered || !rdpAudioElement.buffered.length) return;
    try {
        const end = rdpAudioElement.buffered.end(rdpAudioElement.buffered.length - 1);
        const lag = end - rdpAudioElement.currentTime;
        if (lag > 2.0) {
            // Large backlog: jump once, but keep a small buffer to avoid underrun.
            rdpAudioElement.currentTime = Math.max(0, end - 0.25);
            rdpAudioElement.playbackRate = 1;
        } else if (lag > 0.75) {
            // Small drift: gently catch up; hard-seeking here causes pops.
            rdpAudioElement.playbackRate = 1.06;
        } else if (lag < 0.18) {
            rdpAudioElement.playbackRate = 0.98;
        } else {
            rdpAudioElement.playbackRate = 1;
        }
    } catch {}
}

function pumpRdpAudioQueue() {
    if (!rdpAudioSourceBuffer || rdpAudioSourceBuffer.updating || !rdpAudioQueue.length) return;
    if (rdpAudioQueue.length > 8) rdpAudioQueue.splice(0, rdpAudioQueue.length - 8);
    const chunk = rdpAudioQueue.shift();
    try {
        trimRdpAudioLatency();
        rdpAudioSourceBuffer.appendBuffer(chunk);
    }
    catch (err) { console.warn('[rdp-audio]', 'append failed', { error: err.message }); rdpAudioQueue.length = 0; try { rdpAudioElement.playbackRate = 1; } catch {} }
}

function startRdpAudio() {
    if (rdpAudioSocket || !params?.connectionId || !window.MediaSource || !MediaSource.isTypeSupported('audio/webm; codecs="opus"')) return;
    stopRdpAudio();
    rdpAudioElement = document.createElement('audio');
    rdpAudioElement.autoplay = true;
    rdpAudioElement.playsInline = true;
    rdpAudioElement.controls = false;
    rdpAudioElement.style.display = 'none';
    document.body.appendChild(rdpAudioElement);
    rdpAudioMediaSource = new MediaSource();
    rdpAudioElement.src = URL.createObjectURL(rdpAudioMediaSource);
    rdpAudioElement.play().then(() => { rdpAudioUnlocked = true; }).catch((err) => console.debug('[rdp-audio]', 'autoplay deferred', { error: err.message }));
    ensureRdpAudioUnlocked();
    rdpAudioMediaSource.addEventListener('sourceopen', () => {
        try {
            rdpAudioSourceBuffer = rdpAudioMediaSource.addSourceBuffer('audio/webm; codecs="opus"');
            rdpAudioSourceBuffer.mode = 'sequence';
            
            rdpAudioSourceBuffer.addEventListener('updateend', pumpRdpAudioQueue);
            pumpRdpAudioQueue();
        } catch (err) { console.warn('[rdp-audio]', 'sourcebuffer failed', { error: err.message }); }
    }, { once: true });
    const wsBase = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/rdp-audio`;
    rdpAudioSocket = new WebSocket(`${wsBase}?connectionId=${encodeURIComponent(params.connectionId)}`);
    rdpAudioSocket.binaryType = 'arraybuffer';
    rdpAudioSocket.onmessage = async (ev) => {
        if (typeof ev.data === 'string') return;
        const buf = ev.data instanceof ArrayBuffer ? ev.data : ev.data instanceof Blob ? await ev.data.arrayBuffer() : null;
        if (!buf || !buf.byteLength) return;
        if (rdpAudioElement?.paused) rdpAudioElement.play().then(() => { rdpAudioUnlocked = true; }).catch(() => {});
        rdpAudioQueue.push(buf);
        if (rdpAudioQueue.length > 8) rdpAudioQueue.splice(0, rdpAudioQueue.length - 8);
        pumpRdpAudioQueue();
    };
    rdpAudioSocket.onclose = () => { rdpAudioSocket = null; };
    rdpAudioSocket.onerror = (err) => console.warn('[rdp-audio]', 'socket error', err);
}

function ensureRemoteReady(action = '操作') {
    if (!rdpInputSender || !connected) {
        const msg = `${protocolLabel()} 尚未连接，无法${action}`;
        console.warn('[rdp-client]', msg, { hasRdpInput: !!rdpInputSender, connected });
        setTransientStatus(msg);
        return false;
    }
    return true;
}

async function writeHostClipboard(text) {
    if (!text) return false;

    try {
        const permission = await navigator.permissions?.query?.({ name: 'clipboard-write' });
        console.debug('[rdp-client]', 'clipboard-write permission', { state: permission?.state || 'unknown' });
    } catch (err) {
        console.debug('[rdp-client]', 'clipboard-write permission query unavailable', { error: err.message });
    }

    try {
        await navigator.clipboard.writeText(text);
        console.info('[rdp-client]', 'host clipboard written via Clipboard API', { length: text.length });
        return true;
    } catch (err) {
        console.warn('[rdp-client]', 'Clipboard API write failed, trying execCommand fallback', { error: err.message });
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    let ok = false;
    try {
        ok = document.execCommand('copy');
        console.info('[rdp-client]', 'host clipboard fallback result', { ok, length: text.length });
    } catch (err) {
        console.warn('[rdp-client]', 'host clipboard fallback failed', { error: err.message });
    } finally {
        textarea.remove();
        stage?.focus?.({ preventScroll: true });
    }
    return ok;
}

function isTextInputTarget(target = document.activeElement) {
    if (!target) return false;
    if (target.closest?.('.rdp-floating-panel')) return true;
    const tag = target.tagName?.toLowerCase();
    return tag === 'textarea' || tag === 'input' || target.isContentEditable;
}

function startClipboardAutoSync() {
    if (!rdpInputSender) return;
    if (clipboardAutoSyncTimer) return;
    const tick = () => {
        if (!connected || !rdpInputSender) return;
        const now = Date.now();
        if (document.visibilityState !== 'visible') return;
        if (isTextInputTarget(document.activeElement) && document.activeElement !== mobileKeyboardInput) return;
        if (now - lastClipboardReadAttemptAt < 1400) return;
        lastClipboardReadAttemptAt = now;
        syncLocalClipboardToRemote({ paste: false, source: 'auto-poll', force: false, silent: true }).catch(() => {});
    };
    clipboardAutoSyncTimer = window.setInterval(tick, 1500);
    window.setTimeout(tick, 250);
}

function stopClipboardAutoSync() {
    if (clipboardAutoSyncTimer) window.clearInterval(clipboardAutoSyncTimer);
    clipboardAutoSyncTimer = 0;
}

async function syncLocalClipboardToRemote({ paste = false, source = 'local-clipboard-sync', force = false, silent = false } = {}) {
    if (!ensureRemoteReady('同步本机剪贴板')) return false;
    let text = '';
    try {
        text = await navigator.clipboard.readText();
    } catch (err) {
        console.warn('[rdp-client]', 'local clipboard sync read failed', { source, error: err.message });
        if (!silent) setClipboardHint('浏览器拒绝读取本机剪贴板，请打开剪贴板面板手动发送', 'warning');
        return false;
    }
    if (!text) return false;
    const now = Date.now();
    const duplicate = text === lastLocalClipboardText && now - lastLocalClipboardSentAt < 1500;
    if (!force && duplicate && !paste) return true;
    if (!force && duplicate && paste && pasteShortcutInProgress) return true;
    lastLocalClipboardText = text;
    lastLocalClipboardSentAt = now;
    if (clipboardText) clipboardText.value = text;
    const ok = sendRemoteClipboardText(text);
    if (!ok) return false;
    if (!silent) {
        setClipboardHint(`本机剪贴板已同步到远程 ${text.length} 字符${paste ? '，并发送粘贴' : ''}`, 'success');
        setTransientStatus(paste ? '已同步本机剪贴板并发送粘贴' : '已同步本机剪贴板到远程');
    }
    if (paste) {
        pasteShortcutInProgress = true;
        await sleep(80);
        await sendRdpClipboardPaste(text, { paste: true });
        window.setTimeout(() => { pasteShortcutInProgress = false; }, 300);
    }
    return true;
}

function installLocalClipboardBridge() {
    if (installLocalClipboardBridge._installed) return;
    installLocalClipboardBridge._installed = true;
    document.addEventListener('paste', async (event) => {
        if (!connected || isTextInputTarget(event.target)) return;
        const files = clipboardEventFiles(event);
        if (files.length && protocolLabel() === 'RDP') {
            event.preventDefault();
            await sendRdpFilesClipboard(files, { paste: true, source: 'paste-event' });
            return;
        }
        const text = event.clipboardData?.getData('text/plain') || '';
        if (!text) return;
        event.preventDefault();
        lastLocalClipboardText = text;
        lastLocalClipboardSentAt = Date.now();
        if (clipboardText) clipboardText.value = text;
        await sendRdpClipboardPaste(text, { paste: true });
        setClipboardHint(`已捕获本机粘贴并发送到远程 ${text.length} 字符`, 'success');
    }, true);
    document.addEventListener('keydown', async (event) => {
        if (!connected || isTextInputTarget(event.target)) return;
        const key = String(event.key || '').toLowerCase();
        const pasteShortcut = key === 'v' && (event.ctrlKey || event.metaKey);
        if (!pasteShortcut) return;
        event.preventDefault();
        const files = [];
        if (protocolLabel() === 'RDP') {
            // First check if there are incoming shared files (from SSH) waiting to be pasted
            if (consumeIncomingFileClipboard()) return;
            try {
                const items = await navigator.clipboard?.read?.();
                for (const item of items || []) {
                    for (const type of item.types || []) {
                        if (type.startsWith('text/')) continue;
                        const blob = await item.getType(type);
                        files.push(new File([blob], blob.name || `clipboard-file-${files.length + 1}`, { type: blob.type || type }));
                    }
                }
            } catch (err) {
                console.debug('[rdp-client]', 'clipboard file read unavailable', { error: err.message });
            }
            if (files.length) {
                const ok = await sendRdpFilesClipboard(files, { paste: true, source: 'keyboard-paste-shortcut' });
                if (ok) return;
            }
        }
        await syncLocalClipboardToRemote({ paste: true, source: 'keyboard-paste-shortcut', force: true });
    }, true);
    document.addEventListener('drop', async (event) => {
        if (!connected || isTextInputTarget(event.target) || protocolLabel() !== 'RDP') return;
        const files = clipboardEventFiles(event);
        if (!files.length) return;
        event.preventDefault();
        await sendRdpFilesClipboard(files, { paste: false, source: 'drop-event' });
    }, true);
    document.addEventListener('dragover', (event) => {
        if (!connected || protocolLabel() !== 'RDP') return;
        const files = clipboardEventFiles(event);
        if (!files.length) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
    }, true);
    document.addEventListener('pointerdown', () => {
        if (rdpAudioElement) rdpAudioElement.play().catch(() => {});
    }, { passive: true });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden' && connected) {
            rdpAutoDisconnectedHidden = true;
            disconnect(false);
            stopClipboardAutoSync();
            stopRdpAudio();
            setStatus('disconnected', `${protocolLabel()} 已暂停（页面不可见，已停止视频/音频以降低 CPU）`);
            return;
        }
        if (document.visibilityState === 'visible') {
            if (rdpAutoDisconnectedHidden) {
                rdpAutoDisconnectedHidden = false;
                reconnect();
                return;
            }
            if (connected) {
                startClipboardAutoSync();
                syncLocalClipboardToRemote({ paste: false, source: 'visibility-visible', silent: true }).catch(() => {});
            }
        }
    });
    window.addEventListener('focus', () => {
        if (connected) {
            startClipboardAutoSync();
            syncLocalClipboardToRemote({ paste: false, source: 'window-focus', silent: true }).catch(() => {});
        }
    });
}

function encodeRdpFileClipboardMimetype(file, reset = false, extra = {}) {
    const safeId = encodeURIComponent(extra.id || file?.__rdpFileClipboardId || 'file').replace(/%/g, '%25').replace(/;/g, '%3B');
    const safeName = encodeURIComponent(file?.name || extra.name || 'clipboard-file').replace(/%/g, '%25').replace(/;/g, '%3B');
    const size = Math.max(0, Number(file?.size ?? extra.size) || 0);
    const parts = [`${RDP_FILE_CLIPBOARD_MIMETYPE}`, `id=${safeId}`, `name=${safeName}`, `size=${size}`, `reset=${reset ? 1 : 0}`];
    if (extra.response) parts.push(`response=${extra.response}`);
    if (extra.request) parts.push(`request=${extra.request}`);
    return parts.join(';');
}

function sendRdpFileClipboardMetadata() { return false; }
async function handleRdpFileRangeRequest() {}
async function handleZephyrRdpInstruction() {}
async function sendRdpFilesClipboard(files, { paste = true, source = 'file-clipboard' } = {}) {
    const list = Array.from(files || []).filter(Boolean);
    if (!list.length || protocolLabel() !== 'RDP') return false;
    try {
        const urlParams = new URLSearchParams(window.location.search);
        const connId = urlParams.get('connectionId') || '';
        if (!connId) throw new Error('无法确定 RDP 连接 ID');

        const batch = `browser-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        let uploaded = 0;
        for (const file of list) {
            const safeName = encodeURIComponent(file.name || `file-${uploaded + 1}`);
            const qs = new URLSearchParams({ name: file.name || `file-${uploaded + 1}`, batch, reset: uploaded === 0 ? '1' : '0' });
            const resp = await fetch(`/api/rdp/upload-share/${encodeURIComponent(connId)}?${qs.toString()}`, {
                method: 'POST',
                body: file,
            });
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({ error: resp.statusText }));
                throw new Error(`上传失败: ${err.error || resp.statusText}`);
            }
            uploaded++;
        }

        if (uploaded) {
            setClipboardHint(`已发布 ${uploaded} 个文件到 RDP 原生文件剪贴板${paste ? '，正在远端当前目录粘贴...' : '，可在远端任意目录 Ctrl+V'}`, 'success');
            if (paste) {
                await fetch(`/api/rdp/paste-file-clipboard/${encodeURIComponent(connId)}`, { method: 'POST' }).catch(() => {});
                setTransientStatus('已按 Windows RDP 文件剪贴板逻辑发送 Ctrl+V');
            } else {
                setTransientStatus('文件已进入 RDP 原生剪贴板，可在远端任意目录 Ctrl+V');
            }
        }

        notifyParentSharedFileClipboard(list.map((f) => ({
            id: `rdp-upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: f.name, size: f.size, mime: f.type || 'application/octet-stream',
        })));
        return true;
    } catch (err) {
        setClipboardHint(err.message || '文件剪贴板读取失败', 'warning');
        setTransientStatus(err.message || '文件剪贴板读取失败');
        return false;
    }
}

function clipboardEventFiles(event) {
    const dt = event?.clipboardData || event?.dataTransfer;
    return Array.from(dt?.files || []).filter((file) => file && file.size >= 0);
}

async function sendRdpClipboardPaste(text, { paste = true } = {}) {
    if (!text || !rdpInputSender || !connected) return false;
    rdpInputSender({ type: paste ? 'paste' : 'clipboard', text });
    notifyParentActivity();
    return true;
}

function sendRemoteClipboardText(text) {
    const label = protocolLabel();
    if (!connected || !rdpInputSender) {
        setTransientStatus(`${label} 尚未连接`);
        return false;
    }
    if (!text) return false;
    rdpInputSender({ type: 'clipboard', text });
    notifyParentActivity();
    console.info('[rdp-client]', 'rdp clipboard text sent', { length: text.length, paste: false });
    return true;
}

async function sendTextByClipboardForAi(text, { paste = true, label = 'AI 文本' } = {}) {
    const value = String(text || '');
    if (!value) {
        setTransientStatus(`${label} 为空，未发送`);
        return false;
    }
    if (paste === false) {
        if (!ensureRemoteReady(`发送${label}`)) return false;
        sendTextToRemote(value);
        setTransientStatus(`已发送 ${label} ${value.length} 字符`);
        return true;
    }
    if (!sendRemoteClipboardText(value)) return false;
    await sleep(90);
    rdpInputSender?.({ type: 'paste', text: value });
    notifyParentActivity();
    setTransientStatus(`已粘贴 ${label} ${value.length} 字符`);
    return true;
}

function fixedOrNull(value, digits = 1) {
    const n = Number(value);
    return Number.isFinite(n) ? Number(n.toFixed(digits)) : null;
}

async function readLocalClipboardIntoPanel() {
    try {
        const text = await navigator.clipboard.readText();
        clipboardText.value = text;
        console.info('[rdp-client]', 'local clipboard read', { length: text.length });
        setClipboardHint('已读取本机剪贴板', 'success');
    } catch (err) {
        console.warn('[rdp-client]', 'local clipboard read failed', { error: err.message });
        setClipboardHint('浏览器拒绝读取，请手动粘贴', 'warning');
        clipboardText?.focus?.();
    }
}

async function copyRemoteClipboardToLocal() {
    if (!lastRemoteClipboard) {
        setClipboardHint('还没有收到远程剪贴板', 'warning');
        return;
    }

    const ok = await writeHostClipboard(lastRemoteClipboard);
    clipboardAutoWriteOk = ok;
    clipboardAutoWriteFailed = !ok;
    if (ok) {
        setClipboardHint('远程剪贴板已复制到本机', 'success');
        setTransientStatus('远程剪贴板已同步到本机');
    } else {
        setClipboardHint('浏览器阻止写入系统剪贴板，请在文本框中手动全选复制', 'warning');
        remoteClipboardText?.focus?.();
        remoteClipboardText?.select?.();
    }
}

function receiveRemoteClipboard() {}

async function sendKeyDownUp(keysym, label = '快捷键') {
    if (!ensureRemoteReady(`发送${label}`)) return false;
    try {
        console.info('[rdp-client]', 'shortcut key send', { label, keysym });
        rdpInputSender?.({ type: 'key', key: keysymToXdotool(keysym) });
        notifyParentActivity();
        setTransientStatus(`已发送 ${label}`);
        return true;
    } catch (err) {
        console.error('[rdp-client]', 'shortcut key send failed', { label, keysym, error: err.message });
        setTransientStatus(`${label} 发送失败`);
        return false;
    }
}

async function sendKeyCombo(keysyms, label = '组合键') {
    if (!ensureRemoteReady(`发送${label}`)) return false;
    try {
        console.info('[rdp-client]', 'shortcut combo send', { label, keysyms });
        rdpInputSender?.({ type: 'key', key: keysyms.map(keysymToXdotool).join('+') });
        notifyParentActivity();
        setTransientStatus(`已发送 ${label}`);
        return true;
    } catch (err) {
        console.error('[rdp-client]', 'shortcut combo send failed', { label, keysyms, error: err.message });
        setTransientStatus(`${label} 发送失败`);
        return false;
    }
}

function keyEventToKeysym(event = {}) {
    const key = event.key || '';
    const code = event.code || '';
    const named = {
        Backspace: KEY.BACKSPACE, Tab: KEY.TAB, Enter: KEY.ENTER, Escape: KEY.ESC,
        Home: KEY.HOME, ArrowLeft: KEY.LEFT, ArrowUp: KEY.UP, ArrowRight: KEY.RIGHT, ArrowDown: KEY.DOWN,
        PageUp: KEY.PAGE_UP, PageDown: KEY.PAGE_DOWN, End: KEY.END, Delete: KEY.DELETE,
        Shift: KEY.SHIFT, Control: KEY.CTRL, Alt: KEY.ALT, Meta: KEY.SUPER,
        Insert: 0xff63,
    };
    if (named[key]) return named[key];
    const fn = /^F(\d{1,2})$/.exec(key || code);
    if (fn) {
        const n = Number(fn[1]);
        if (n >= 1 && n <= 12) return KEY.F1 + n - 1;
    }
    if (key && key.length === 1) return asciiKeysym(key);
    return 0;
}

function keysymToXdotool(keysym) {
    const map = {
        [KEY.BACKSPACE]: 'BackSpace', [KEY.TAB]: 'Tab', [KEY.ENTER]: 'Return', [KEY.ESC]: 'Escape',
        [KEY.HOME]: 'Home', [KEY.LEFT]: 'Left', [KEY.UP]: 'Up', [KEY.RIGHT]: 'Right', [KEY.DOWN]: 'Down',
        [KEY.PAGE_UP]: 'Page_Up', [KEY.PAGE_DOWN]: 'Page_Down', [KEY.END]: 'End', [KEY.DELETE]: 'Delete',
        [0xff63]: 'Insert',
        [KEY.CTRL]: 'ctrl', [KEY.SHIFT]: 'shift', [KEY.ALT]: 'alt', [KEY.SUPER]: 'Super_L',
        [KEY.F1]: 'F1', [KEY.F2]: 'F2', [KEY.F3]: 'F3', [KEY.F4]: 'F4', [KEY.F5]: 'F5', [KEY.F6]: 'F6',
        [KEY.F7]: 'F7', [KEY.F8]: 'F8', [KEY.F9]: 'F9', [KEY.F10]: 'F10', [KEY.F11]: 'F11', [KEY.F12]: 'F12',
    };
    if (map[keysym]) return map[keysym];
    if (keysym >= 0x01000000) return `U${(keysym - 0x01000000).toString(16).padStart(4, '0')}`;
    if (keysym >= 0x20 && keysym <= 0x7e) return `U${keysym.toString(16).padStart(4, '0')}`;
    return String(keysym);
}

function asciiKeysym(char) {
    if (!char) return 0;
    if (char === '\n' || char === '\r') return KEY.ENTER;
    if (char === '\t') return KEY.TAB;
    const code = char.codePointAt(0);
    if (code <= 0xff) return code;
    return code <= 0x10ffff ? (0x01000000 | code) : 0;
}

function sendTextToRemote(text) {
    if (!text || !rdpInputSender || !connected) return;
    if (mobileKeyboardInput) mobileKeyboardInput.value = '';
    mobileInputMirror = '';
    rdpInputSender({ type: 'text', text });
    notifyParentActivity();
    console.info('[rdp-client]', 'rdp mobile keyboard text sent', { length: text.length });
}

function focusMobileKeyboard() {
    if (!mobileKeyboardInput) return;
    mobileKeyboardInput.value = mobileInputMirror = '';
    mobileKeyboardInput.style.pointerEvents = 'auto';
    mobileKeyboardInput.focus({ preventScroll: true });
    stage?.classList.add('keyboard-open');
    keyboardBtn?.classList.add('active');
    setTimeout(() => { try { mobileKeyboardInput.focus({ preventScroll: true }); } catch {} }, 80);
    console.info('[rdp-client]', 'mobile keyboard focused');
}

function blurMobileKeyboard() {
    if (!mobileKeyboardInput) return;
    mobileKeyboardInput.blur();
    mobileKeyboardInput.style.pointerEvents = 'none';
    stage?.classList.remove('keyboard-open');
    keyboardBtn?.classList.remove('active');
    console.info('[rdp-client]', 'mobile keyboard blurred');
}

function toggleMobileKeyboard() {
    const keyboardOpen = document.activeElement === mobileKeyboardInput || keyboardBtn?.classList.contains('active');
    if (keyboardOpen) blurMobileKeyboard();
    else focusMobileKeyboard();
}

function setupMobileKeyboard() {
    if (!mobileKeyboardInput) return;
    let composing = false;
    let suppressInputUntil = 0;
    let lastSentText = '';
    let lastSentAt = 0;
    const sendMobileTextOnce = (text) => {
        if (!text) return false;
        const now = Date.now();
        if (text === lastSentText && now - lastSentAt < 250) return false;
        lastSentText = text;
        lastSentAt = now;
        suppressInputUntil = now + 250;
        sendTextToRemote(text);
        return true;
    };
    const resetMobileInput = () => {
        mobileKeyboardInput.value = '';
        mobileInputMirror = '';
    };
    const sendBackspaceToRemote = () => {
        if (rdpInputSender && connected) {
            rdpInputSender({ type: 'key', key: keysymToXdotool(KEY.BACKSPACE) });
            notifyParentActivity();
            return true;
        }
        return sendKeyDownUp(KEY.BACKSPACE, 'Backspace');
    };
    const sendEnterToRemote = () => {
        if (rdpInputSender && connected) {
            rdpInputSender({ type: 'key', key: keysymToXdotool(KEY.ENTER) });
            notifyParentActivity();
            return true;
        }
        return sendKeyDownUp(KEY.ENTER, 'Enter');
    };

    mobileKeyboardInput.addEventListener('compositionstart', () => { composing = true; });
    mobileKeyboardInput.addEventListener('compositionend', (event) => {
        composing = false;
        const text = event.data || mobileKeyboardInput.value || '';
        if (text) sendMobileTextOnce(text);
        resetMobileInput();
    });

    mobileKeyboardInput.addEventListener('beforeinput', (event) => {
        if (!rdpInputSender || !connected) return;
        const inputType = event.inputType || '';
        if (inputType === 'insertCompositionText' || composing) return;
        event.preventDefault();

        if (inputType.startsWith('deleteContent') || inputType === 'deleteByCut') {
            sendBackspaceToRemote();
            resetMobileInput();
            return;
        }
        if (inputType === 'insertLineBreak' || inputType === 'insertParagraph') {
            sendEnterToRemote();
            resetMobileInput();
            return;
        }
        if (inputType.startsWith('insert')) {
            const text = event.data || mobileKeyboardInput.value || '';
            if (text) sendMobileTextOnce(text);
            resetMobileInput();
        }
    });

    mobileKeyboardInput.addEventListener('input', () => {
        if (composing) return;
        if (Date.now() < suppressInputUntil) { resetMobileInput(); return; }
        const text = mobileKeyboardInput.value || '';
        if (text) sendMobileTextOnce(text);
        resetMobileInput();
    });

    mobileKeyboardInput.addEventListener('keydown', (event) => {
        if (!rdpInputSender || !connected) return;
        if (event.key === 'Backspace') {
            event.preventDefault();
            sendBackspaceToRemote();
            resetMobileInput();
        } else if (event.key === 'Enter') {
            event.preventDefault();
            sendEnterToRemote();
            resetMobileInput();
        }
    });

    mobileKeyboardInput.addEventListener('paste', (event) => {
        const text = event.clipboardData?.getData('text/plain') || '';
        if (!text) return;
        event.preventDefault();
        sendMobileTextOnce(text);
        resetMobileInput();
    });
}

async function runShortcut(name) {
    const lower = String(name || '').toLowerCase();
    const ctrlChar = (char) => char.toLowerCase().codePointAt(0);
    console.info('[rdp-client]', 'shortcut button activated', { name: lower, connected, hasClient: false });

    const actions = {
        esc: () => sendKeyDownUp(KEY.ESC, 'Esc'),
        tab: () => sendKeyDownUp(KEY.TAB, 'Tab'),
        enter: () => sendKeyDownUp(KEY.ENTER, 'Enter'),
        backspace: () => sendKeyDownUp(KEY.BACKSPACE, 'Backspace'),
        win: () => sendKeyDownUp(KEY.SUPER, 'Win'),
        'alt-tab': () => sendKeyCombo([KEY.ALT, KEY.TAB], 'Alt+Tab'),
        'ctrl-l': () => sendKeyCombo([KEY.CTRL, ctrlChar('l')], 'Ctrl+L'),
        'ctrl-r': () => sendKeyCombo([KEY.CTRL, ctrlChar('r')], 'Ctrl+R'),
        'ctrl-v': () => sendKeyCombo([KEY.CTRL, ctrlChar('v')], 'Ctrl+V'),
        'win-r': () => sendKeyCombo([KEY.SUPER, ctrlChar('r')], 'Win+R'),
        up: () => sendKeyDownUp(KEY.UP, '↑'),
        down: () => sendKeyDownUp(KEY.DOWN, '↓'),
        left: () => sendKeyDownUp(KEY.LEFT, '←'),
        right: () => sendKeyDownUp(KEY.RIGHT, '→'),
        home: () => sendKeyDownUp(KEY.HOME, 'Home'),
        end: () => sendKeyDownUp(KEY.END, 'End'),
        pageup: () => sendKeyDownUp(KEY.PAGE_UP, 'PageUp'),
        pagedown: () => sendKeyDownUp(KEY.PAGE_DOWN, 'PageDown'),
    };

    if (/^ctrl-[a-z]$/.test(lower)) {
        const char = lower.slice(-1);
        return sendKeyCombo([KEY.CTRL, ctrlChar(char)], `Ctrl+${char.toUpperCase()}`);
    }
    if (/^f(?:[1-9]|1[0-2])$/.test(lower)) {
        const label = lower.toUpperCase();
        return sendKeyDownUp(KEY[label], label);
    }

    const action = actions[lower];
    if (!action) {
        console.warn('[rdp-client]', 'unknown shortcut', { name: lower });
        setTransientStatus(`未知快捷键：${lower}`);
        return false;
    }
    return action();
}

async function sendClipboard() {
    const label = protocolLabel();
    if (!connected || !rdpInputSender) return setStatus('error', `${label} 尚未连接`);
    let text = '';
    try {
        text = await navigator.clipboard.readText();
    } catch {
        text = prompt(`请输入要发送到远程 ${label} 的剪贴板文本：`) || '';
    }
    if (!text) return;
    sendRemoteClipboardText(text);
}

function sendCtrlAltDel() {
    if (!ensureRemoteReady('发送 Ctrl+Alt+Del')) return;
    rdpInputSender?.({ type: 'key', key: 'ctrl+alt+Delete' });
    notifyParentActivity();
}

function rdpQualityText(mode = qualityModes[qualityIdx]) {
    return mode === 'balanced' ? '平衡' : mode === 'performance' ? '性能' : '画质';
}

function rememberRdpQuality(mode) {
    params.quality = mode;
    const key = tabId ? `zephyr_remote_desktop_params_${tabId}` : 'zephyr_remote_desktop_params';
    try { sessionStorage.setItem(key, JSON.stringify(params)); } catch {}
}
function rdpFpsValue() { return Math.max(15, Math.min(144, Number(params.rdpFps || 60))); }
function rdpResolutionText(value = params.rdpResolution || '1920x1080') {
    return value === 'auto' ? '自动' : value === '2560x1440' ? '2K' : value === '3840x2160' ? '4K' : value === '7680x4320' ? '8K' : '1080p';
}
function activateRdpResolutionMode(value = '') {
    const modes = ['1920x1080', '2560x1440', '3840x2160', '7680x4320', 'auto'];
    const current = modes.includes(params.rdpResolution) ? params.rdpResolution : '1920x1080';
    const next = modes.includes(String(value || '')) ? String(value) : modes[(modes.indexOf(current) + 1) % modes.length];
    params.rdpResolution = next;
    const key = tabId ? `zephyr_remote_desktop_params_${tabId}` : 'zephyr_remote_desktop_params';
    try { sessionStorage.setItem(key, JSON.stringify(params)); } catch {}
    if (resolutionBtn) resolutionBtn.textContent = rdpResolutionText(next);
    if (rdpInputSender && connected) {
        const target = computeRdpTargetSize('fit');
        rdpReconnectPending = true;
        rdpLastReconnectAt = Date.now();
        rdpInputSender({ type: 'reconnect', width: target.width, height: target.height, mode: target.mode, quality: qualityModes[qualityIdx], fps: rdpFpsValue() });
        setTransientStatus(`正在切换到 ${rdpResolutionText(next)} ${target.width}×${target.height}`);
    }
    return next;
}
function activateRdpFpsMode(value = '') {
    const modes = [30, 45, 60, 120, 144];
    const current = modes.includes(Number(params.rdpFps)) ? Number(params.rdpFps) : 60;
    const next = modes.includes(Number(value)) ? Number(value) : modes[(modes.indexOf(current) + 1) % modes.length];
    params.rdpFps = next;
    const key = tabId ? `zephyr_remote_desktop_params_${tabId}` : 'zephyr_remote_desktop_params';
    try { sessionStorage.setItem(key, JSON.stringify(params)); } catch {}
    if (fpsBtn) fpsBtn.textContent = `${next}FPS`;
    if (rdpInputSender && connected) {
        const target = computeRdpTargetSize(fitModes[fitModeIdx]);
        rdpReconnectPending = true;
        rdpLastReconnectAt = Date.now();
        rdpInputSender({ type: 'reconnect', width: target.width, height: target.height, mode: target.mode, quality: qualityModes[qualityIdx], fps: next });
        setTransientStatus(`正在切换到 ${next} FPS`);
    }
    return next;
}

function activateRdpFitMode(mode = '') {
    const normalized = String(mode || '').toLowerCase() === 'original' ? '1:1' : String(mode || '');
    const nextMode = fitModes.includes(normalized) ? normalized : fitModes[(fitModeIdx + 1) % fitModes.length];
    fitModeIdx = fitModes.indexOf(nextMode);
    const m = fitModes[fitModeIdx];
    fitBtn.classList.toggle('active', m !== '1:1');
    fitBtn.textContent = m === 'fit' ? '适应' : m === '1:1' ? '1:1 原始' : m;
    if (rdpInputSender) {
        setRdpScaleZoom(1, { preserveViewport: false });
        const target = computeRdpTargetSize(m);
        applyDisplayScale();
        requestedRdpWidth = target.width;
        requestedRdpHeight = target.height;
        window.clearTimeout(rdpReconnectTimer);
        rdpReconnectTimer = window.setTimeout(() => {
            const now = Date.now();
            if (!rdpInputSender || !connected || rdpReconnectPending) return;
            if (now - rdpLastReconnectAt < 1200) return;
            rdpReconnectPending = true;
            rdpLastReconnectAt = now;
            rdpInputSender({ type: 'reconnect', width: target.width, height: target.height, mode: target.mode, quality: qualityModes[qualityIdx], fps: rdpFpsValue() });
            setTransientStatus(`正在切换 ${target.width}×${target.height}`);
        }, 360);
    } else {
        switchFitMode(m);
        applyDisplayScale();
    }
    return m;
}

function activateRdpQualityMode(mode = '') {
    const nextMode = qualityModes.includes(String(mode || '')) ? String(mode) : qualityModes[(qualityIdx + 1) % qualityModes.length];
    qualityIdx = qualityModes.indexOf(nextMode);
    qualityBtn && (qualityBtn.textContent = rdpQualityText(nextMode));
    rememberRdpQuality(nextMode);
    if (rdpInputSender && connected) {
        const target = computeRdpTargetSize(fitModes[fitModeIdx]);
        rdpReconnectPending = true;
        rdpLastReconnectAt = Date.now();
        rdpInputSender({ type: 'reconnect', width: target.width, height: target.height, mode: target.mode, quality: nextMode, fps: rdpFpsValue() });
        setTransientStatus(`正在切换到${rdpQualityText(nextMode)}模式`);
        return nextMode;
    }
    disconnect(false);
    setTimeout(() => connect(), 300);
    return nextMode;
}

async function performAiRemoteDesktopAction(data = {}) {
    const control = String(data.control || '').toLowerCase().replace(/-/g, '_');
    const text = String(data.text || '');
    if (control === 'quality') return { ok: true, control, mode: activateRdpQualityMode(data.qualityMode || '') };
    if (control === 'fit') return { ok: true, control, mode: activateRdpFitMode(data.fitMode || '') };
    if (control === 'zoom') { setRdpScaleZoom((Number(data.zoomPercent) || 100) / 100); setTransientStatus(`缩放 ${Math.round(rdpScaleZoom * 100)}%`); return { ok: true, control, zoomPercent: Math.round(rdpScaleZoom * 100) }; }
    if (control === 'clipboard') { togglePanel(clipboardPanel, true); clipboardText?.focus?.(); return { ok: true, control, panel: 'clipboard' }; }
    if (control === 'keyboard') { toggleMobileKeyboard(); return { ok: true, control, keyboardOpen: document.activeElement === mobileKeyboardInput || keyboardBtn?.classList.contains('active') }; }
    if (control === 'shortcuts') { togglePanel(shortcutsPanel, true); return { ok: true, control, panel: 'shortcuts' }; }
    if (control === 'joystick' || control === 'drag') { togglePanel(joystickPanel, true); updateJoystickHint(); return { ok: true, control, panel: 'joystick' }; }
    if (control === 'ctrl_alt_del' || control === 'cad') { sendCtrlAltDel(); return { ok: true, control: 'ctrl_alt_del' }; }
    if (control === 'reconnect') { reconnect(); return { ok: true, control }; }
    if (control === 'disconnect') { disconnect(true); notifyParentCloseRequest('ai-disconnect'); return { ok: true, control }; }
    if (control === 'clipboard_read_local') { await readLocalClipboardIntoPanel(); return { ok: true, control }; }
    if (control === 'clipboard_copy_remote') { await copyRemoteClipboardToLocal(); return { ok: true, control }; }
    if (control === 'clipboard_send') {
        if (clipboardText && text) clipboardText.value = text;
        const value = text || clipboardText?.value || '';
        if (!sendRemoteClipboardText(value)) throw new Error('RDP 剪贴板发送失败：远程未连接或文本为空');
        if (data.paste !== false) {
            await sleep(90);
            rdpInputSender?.({ type: 'paste', text: value });
            notifyParentActivity();
            setTransientStatus(`已粘贴剪贴板文本 ${value.length} 字符`);
        }
        return { ok: true, control, length: value.length, paste: data.paste !== false };
    }
    if (control === 'shortcut') {
        const ok = await runShortcut(data.sequence || text);
        if (!ok) throw new Error(`RDP 快捷键发送失败：${data.sequence || text || ''}`);
        return { ok: true, control, sequence: data.sequence || text || '' };
    }
    if (control === 'text') {
        const ok = await sendTextByClipboardForAi(text, { paste: data.paste !== false, label: 'AI 文本' });
        if (!ok) throw new Error('RDP 文本输入失败：远程未连接或文本为空');
        return { ok: true, control, length: text.length, paste: data.paste !== false };
    }
    if (control === 'mouse_click') {
        const x = Math.round(Number(data.x));
        const y = Math.round(Number(data.y));
        const button = Number(data.button) || 1;
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('AI 远程桌面点击缺少 x/y');
        const ok = sendRemoteMouseClick({ x, y }, 'ai', button);
        if (!ok) throw new Error('RDP 点击未发送：远程未连接或坐标无效');
        setTransientStatus(`AI 已点击 ${x}, ${y}`);
        return { ok: true, control, x, y, button };
    }
    throw new Error(`未知远程桌面 UI 动作：${control}`);
}

fitBtn.addEventListener('click', () => activateRdpFitMode());

zoomSlider?.addEventListener('pointerdown', (event) => event.stopPropagation());
zoomSlider?.addEventListener('click', (event) => event.stopPropagation());
zoomSlider?.addEventListener('input', () => {
    setRdpScaleZoom((Number(zoomSlider.value) || 100) / 100);
});
zoomBtn?.addEventListener('click', (event) => {
    if (event.target === zoomSlider) return;
    event.preventDefault();
    zoomSlider?.focus?.({ preventScroll: true });
});

clipboardBtn.addEventListener('click', () => {
    togglePanel(clipboardPanel);
    if (!clipboardPanel.hidden) clipboardText?.focus?.();
});
rdpFilesBtn?.addEventListener('click', () => {
    togglePanel(clipboardPanel, true, rdpFilesBtn);
    renderIncomingFileList();
    document.getElementById('rdpRemoteFileList')?.scrollIntoView?.({ block: 'nearest' });
});
clipboardReadLocalBtn?.addEventListener('click', () => readLocalClipboardIntoPanel());
clipboardSendBtn?.addEventListener('click', async () => {
    const text = clipboardText?.value || '';
    if (sendRemoteClipboardText(text)) {
        setClipboardHint(`已发送 ${text.length} 字符到远程剪贴板，可在远程 Ctrl+V 粘贴`, 'success');
        if (rdpInputSender) {
            await sleep(80);
            setTransientStatus('远程剪贴板已设置，正在粘贴');
            rdpInputSender({ type: 'paste', text });
        }
    }
});
clipboardCopyRemoteBtn?.addEventListener('click', () => copyRemoteClipboardToLocal());
document.getElementById('rdpFileDownloadAllBtn')?.addEventListener('click', () => {
    if (rdpRemoteFileClipboard.length) downloadRemoteFilesToLocal(rdpRemoteFileClipboard);
});
document.getElementById('rdpFilePasteToRemoteBtn')?.addEventListener('click', () => {
    if (consumeIncomingFileClipboard()) return;
    setClipboardHint('没有待粘贴的文件', 'info');
});
stage?.addEventListener('focus', () => {
    if (connected && (rdpInputSender)) syncLocalClipboardToRemote({ paste: false, source: 'stage-focus', silent: true }).catch(() => {});
});
stage?.addEventListener('pointerdown', () => {
    ensureRdpAudioUnlocked();
    if (connected) syncLocalClipboardToRemote({ paste: false, source: 'stage-pointerdown', silent: true }).catch(() => {});
}, { passive: true });

keyboardBtn?.addEventListener('click', toggleMobileKeyboard);
setupMobileKeyboard();
mobileKeyboardInput?.addEventListener('blur', () => { keyboardBtn?.classList.remove('active'); stage?.classList.remove('keyboard-open'); });
mobileKeyboardInput?.addEventListener('keydown', (event) => {
    if (event.key !== 'Backspace' || mobileKeyboardInput.value) return;
    event.preventDefault();
    if (rdpInputSender) {
        rdpInputSender({ type: 'key', key: keysymToXdotool(KEY.BACKSPACE) });
        notifyParentActivity();
        return;
    }
    sendKeyDownUp(KEY.BACKSPACE);
});

shortcutsBtn?.addEventListener('click', () => {
    togglePanel(shortcutsPanel);
});
joystickBtn?.addEventListener('click', () => {
    togglePanel(joystickPanel);
    updateJoystickHint();
});
shortcutGrid?.addEventListener('pointerdown', (event) => {
    const btn = event.target.closest('[data-keyseq]');
    if (!btn) return;
    event.preventDefault();
    event.stopPropagation();
    btn.classList.add('active');
    window.setTimeout(() => btn.classList.remove('active'), 140);
    runShortcut(btn.dataset.keyseq).catch((err) => {
        console.error('[rdp-client]', 'shortcut action failed', { keyseq: btn.dataset.keyseq, error: err.message });
    });
}, { capture: true });

shortcutGrid?.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-keyseq]');
    if (!btn) return;
    event.preventDefault();
    event.stopPropagation();
}, { capture: true });

stage?.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'touch' || event.pointerType === 'pen' || (!event.pointerType && ((navigator.maxTouchPoints || 0) > 0 || window.matchMedia?.('(pointer: coarse)')?.matches))) return;
    if (event.target.closest('.rdp-floating-panel, .rdp-mobile-keyboard-input, button, textarea, input')) return;
    stage.focus({ preventScroll: true });
    notifyParentActivity();
});
ctrlAltDelBtn.addEventListener('click', sendCtrlAltDel);
const qualityBtn = document.getElementById('qualityBtn');
if (qualityBtn) {
    qualityBtn.textContent = rdpQualityText();
    qualityBtn.addEventListener('click', () => activateRdpQualityMode());
}
if (resolutionBtn) {
    resolutionBtn.textContent = rdpResolutionText();
    resolutionBtn.addEventListener('click', () => activateRdpResolutionMode());
}
if (fpsBtn) {
    fpsBtn.textContent = `${rdpFpsValue()}FPS`;
    fpsBtn.addEventListener('click', () => activateRdpFpsMode());
}
reconnectBtn.addEventListener('click', reconnect);
disconnectBtn.addEventListener('click', () => {
    disconnect(true);
    if (embeddedMode) {
        notifyParentCloseRequest('user-disconnect-button');
        document.body.innerHTML = '<div class="terminal-placeholder" style="padding:24px;color:#9a9ca3">远程桌面已断开，正在关闭此窗口...</div>';
    } else {
        window.location.href = '/';
    }
});
window.addEventListener('resize', scheduleResize, { passive: true });
window.addEventListener('beforeunload', () => disconnect(false));
window.addEventListener('message', (event) => {
    if (event.data?.source !== 'zephyr-app') return;
    if (event.data.type === 'theme-change') { document.documentElement.setAttribute('data-theme', event.data.theme); applyZephyrColorScheme(event.data.appearance || {}, { theme: event.data.theme, page: 'rdp' }); }
    if (event.data.type === 'focus-terminal') {
        stage?.focus?.({ preventScroll: true });
        focusMobileKeyboard();
    }
    if (event.data.type === 'reconnect-terminal') reconnect();
    if (event.data.type === 'shared-clipboard-text') {
        const text = String(event.data.text || '');
        if (text && connected && rdpInputSender) {
            lastLocalClipboardText = text;
            lastLocalClipboardSentAt = Date.now();
            if (clipboardText) clipboardText.value = text;
            sendRdpClipboardPaste(text, { paste: false });
            setClipboardHint(`已同步 SSH 文本到远程剪贴板 ${text.length} 字符`, 'success');
        }
        return;
    }
    if (event.data.type === 'shared-file-clipboard-read') {
        // SSH→RDP: use server-side SFTP clipboard relay
        const requestId = String(event.data.requestId || '');
        if (rdpSocket && rdpSocket.readyState === WebSocket.OPEN) {
            rdpSocket.send(JSON.stringify({ type: 'rdp-sftp-clipboard-paste', requestId }));
            setClipboardHint('正在通过 RDP 原生文件剪贴板从 SSH 粘贴到远端当前目录...', 'info');
        }
        window.parent?.postMessage?.({ source: 'zephyr-terminal', type: 'shared-file-clipboard-data', tabId: params?.tabId || tabId, requestId, files: [], error: '' }, '*');
        return;
    }
    if (event.data.type === 'rdp-sftp-clipboard-paste-ack') {
        if (event.data.ok) {
            setClipboardHint(`已从 SSH 发布 ${event.data.count || 0} 个文件到 RDP 原生文件剪贴板，并已发送 Ctrl+V`, 'success');
            setTransientStatus('文件将粘贴到远端当前目录（Windows RDP CLIPRDR）');
        } else {
            setClipboardHint(event.data.error || 'SSH 文件粘贴失败', 'warning');
        }
        return;
    }
    if (event.data.type === 'shared-file-clipboard-available') {
        // Just show a hint — actual paste goes through server
        const files = Array.from(event.data.files || []);
        if (files.length) {
            setClipboardHint(`剪贴板有 ${files.length} 个文件，Ctrl+V 粘贴到远程`, 'info');
        }
        return;
    }
    if (event.data.type === 'ai-remote-desktop-action') {
        const actionId = String(event.data.actionId || '');
        performAiRemoteDesktopAction(event.data).then((result = {}) => {
            notifyParentAiActionResult(actionId, { ok: true, control: event.data?.control || '', result });
        }).catch((err) => {
            console.warn('[rdp-client]', 'AI remote desktop action failed', { error: err.message, control: event.data?.control });
            setTransientStatus(err.message || 'AI 远程桌面操作失败');
            notifyParentAiActionResult(actionId, { ok: false, control: event.data?.control || '', error: err.message || 'AI 远程桌面操作失败' });
        });
    }
});

setupFloatingPanels();
setupMobilePointerMouse();
installLocalClipboardBridge();
fitBtn.classList.add('active');
setStatus('connecting');
connect();
requestParentSharedFileClipboard();
