import { RDPClient } from './vendor/freerdp-web/rdp-client.js';
import { applyZephyrColorScheme } from './theme-runtime.js?v=20260615-visual-color-picker';

const $ = (sel) => document.querySelector(sel);
const urlParams = new URLSearchParams(location.search);
const embeddedMode = urlParams.get('embed') === '1';
const tabId = urlParams.get('tabId') || '';
const statusDot = $('#statusDot');
const statusText = $('#statusText');
const connInfo = $('#connInfo');
const displayRoot = $('#display');
const displayShell = $('#displayShell');
const overlay = $('#rdpOverlay');
const overlayMsg = $('#overlayMsg');
const clipboardPanel = $('#clipboardPanel');
const clipboardText = $('#clipboardText');
const remoteClipboardText = $('#remoteClipboardText');
const clipboardHint = $('#clipboardHint');
const remoteFileList = $('#rdpRemoteFileList');
const mobileKeyboardInput = $('#mobileKeyboardInput');

const filesPanel = $('#filesPanel');
const filesHint = $('#filesHint');
const rdpFileInput = $('#rdpFileInput');
const rdpFileSelectBtn = $('#rdpFileSelectBtn');

function setFilesHint(text, level = 'info') {
    if (!filesHint) return;
    filesHint.textContent = text || '';
    filesHint.dataset.level = level;
}

let client = null;
let clientHost = null;
let connected = false;
let params = loadParams();
let currentResolutionIdx = 0;
let textInputQueue = Promise.resolve();
let remoteFiles = [];
const fileDownloads = new Map();
const resolutions = [
    { label: '自动', width: 0, height: 0 },
    { label: '1080p', width: 1920, height: 1080 },
    { label: '2K', width: 2560, height: 1440 },
    { label: '4K', width: 3840, height: 2160 },
];
let statusSequence = 0;

function initialTheme() {
    const saved = localStorage.getItem('zephyr-theme');
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ? 'dark' : 'light';
}
function applyFrameTheme(theme = initialTheme(), appearance = {}) {
    const normalized = theme === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', normalized);
    applyZephyrColorScheme(appearance || {}, { theme: normalized, page: 'rdp' });
    try { client?.setTheme?.(buildEmbeddedRdpTheme()); } catch {}
}
function cssVar(name, fallback = '') {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
}
function buildEmbeddedRdpTheme() {
    const rootTheme = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    return {
        preset: rootTheme,
        colors: {
            background: 'transparent',
            surface: cssVar('--surface', rootTheme === 'light' ? '#ffffff' : '#1b1c20'),
            border: cssVar('--border', rootTheme === 'light' ? '#dedee3' : '#303237'),
            text: cssVar('--text', rootTheme === 'light' ? '#1d1d1f' : '#f4f4f6'),
            textMuted: cssVar('--text-secondary', rootTheme === 'light' ? '#6e6e73' : '#9a9ca3'),
            accent: cssVar('--accent', rootTheme === 'light' ? '#007aff' : '#0a84ff'),
            accentText: rootTheme === 'light' ? '#ffffff' : '#000000',
            error: cssVar('--danger', rootTheme === 'light' ? '#d70015' : '#ff453a'),
            success: cssVar('--success', rootTheme === 'light' ? '#248a3d' : '#32d74b'),
            buttonBg: 'transparent',
            buttonHover: 'rgba(10,132,255,.12)',
            buttonText: cssVar('--text', rootTheme === 'light' ? '#1d1d1f' : '#f4f4f6'),
            buttonActiveBg: 'rgba(10,132,255,.18)',
            buttonActiveText: cssVar('--accent', rootTheme === 'light' ? '#007aff' : '#0a84ff'),
            inputBg: cssVar('--bg', rootTheme === 'light' ? '#f5f5f7' : '#101114'),
            inputBorder: cssVar('--border', rootTheme === 'light' ? '#dedee3' : '#303237'),
            inputFocusBorder: cssVar('--accent', rootTheme === 'light' ? '#007aff' : '#0a84ff'),
        },
        shape: { borderRadius: '0px', borderRadiusLarge: '0px' },
    };
}
applyFrameTheme();

function loadParams() {
    const key = tabId ? `zephyr_remote_desktop_params_${tabId}` : 'zephyr_remote_desktop_params';
    try { return JSON.parse(sessionStorage.getItem(key) || '{}'); } catch { return {}; }
}
function notifyParentStatus(status) {
    if (embeddedMode && window.parent && window.parent !== window) window.parent.postMessage({ source: 'zephyr-terminal', tabId: params?.tabId || tabId, status }, '*');
}
function notifyParentCloseRequest(reason = 'remote-desktop-closed') {
    if (embeddedMode && window.parent && window.parent !== window) window.parent.postMessage({ source: 'zephyr-terminal', type: 'close-request', tabId: params?.tabId || tabId, reason }, '*');
}
function notifyParentSharedClipboardText(text = '') {
    if (embeddedMode && window.parent && window.parent !== window && text) {
        window.parent.postMessage({ source: 'zephyr-terminal', type: 'shared-clipboard-text', tabId: params?.tabId || tabId, text }, '*');
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
function setStatus(state, text, options = {}) {
    const seq = ++statusSequence;
    statusDot?.classList.remove('connected', 'connecting', 'error', 'disconnected');
    if (state) statusDot?.classList.add(state);
    if (statusText) statusText.textContent = text || '';
    if (overlayMsg) overlayMsg.textContent = text || '';
    const holdMs = Number(options.holdOverlayMs) || 0;
    if (overlay) {
        if (state === 'connected' && holdMs > 0) {
            overlay.classList.remove('hidden');
            setTimeout(() => { if (statusSequence === seq) overlay.classList.add('hidden'); }, holdMs);
        } else {
            overlay.classList.toggle('hidden', state === 'connected');
        }
    }
}
function setClipboardHint(text, level = 'info') {
    if (!clipboardHint) return;
    clipboardHint.textContent = text || '';
    clipboardHint.dataset.level = level;
}
function updateInfo() {
    const name = params.name || params.host || 'RDP';
    const port = params.port || 3389;
    if (connInfo) connInfo.textContent = `${name} · RDPEGFX/FreeRDP3 · ${params.host || ''}:${port}`;
}
function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const query = new URLSearchParams({ connectionId: params.connectionId || '', tabId: params.tabId || tabId });
    return `${proto}//${location.host}/rdp-gfx?${query.toString()}`;
}
function requireModernRdpBrowser() {
    const missing = [];
    if (!window.isSecureContext) missing.push('安全上下文 HTTPS/localhost');
    if (typeof OffscreenCanvas === 'undefined') missing.push('OffscreenCanvas');
    if (typeof VideoDecoder === 'undefined' || typeof EncodedVideoChunk === 'undefined') missing.push('WebCodecs VideoDecoder');
    if (typeof Worker === 'undefined') missing.push('Web Worker');
    if (typeof AudioWorkletNode === 'undefined') missing.push('AudioWorklet');
    if (missing.length) throw new Error(`当前浏览器不满足 RDPEGFX 客户端要求：${missing.join('、')}`);
}
function hideLegacyControls() {
    for (const id of ['qualityBtn', 'fpsBtn', 'fitBtn', 'zoomBtn', 'joystickBtn']) {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    }
}
function availableSize() {
    const rect = displayRoot?.getBoundingClientRect?.();
    const w = Math.max(640, Math.floor((rect?.width || window.innerWidth || 1280) / 2) * 2);
    const h = Math.max(480, Math.floor((rect?.height || window.innerHeight || 720) / 2) * 2);
    return { width: Math.min(w, 4096), height: Math.min(h, 2304) };
}
function requestResolution(res) {
    if (!client || !connected) return false;
    const size = res?.width && res?.height ? res : availableSize();
    setStatus('connecting', `正在切换 RDPEGFX 分辨率 ${size.width}×${size.height}...`);
    try {
        client._lastRequestedWidth = size.width;
        client._lastRequestedHeight = size.height;
        client._sendMessage({ type: 'resize', width: size.width, height: size.height });
    } catch (err) {
        setStatus('error', `切换分辨率失败：${err.message || err}`);
        return false;
    }
    return true;
}
function escapeHtml(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function formatFileSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
function renderRemoteFiles() {
    if (!remoteFileList) return;
    if (!remoteFiles.length) {
        remoteFileList.innerHTML = '<div class="rdp-file-empty">远程剪贴板暂无文件</div>';
        return;
    }
    remoteFileList.innerHTML = remoteFiles.map((f, i) => `<div class="rdp-file-item"><span class="rdp-file-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span><span class="rdp-file-size">${formatFileSize(f.size)}</span><button class="btn-sm rdp-file-download-btn" data-download-idx="${i}">下载</button></div>`).join('');
    remoteFileList.querySelectorAll('[data-download-idx]').forEach((btn) => btn.addEventListener('click', () => requestRemoteFileDownload(Number(btn.dataset.downloadIdx))));
}
function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
}
function base64ToUint8(b64) {
    const bin = atob(String(b64 || ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}
async function fileToPayload(file) {
    // Handle both File objects (from paste/drop) and plain objects with dataUrl (from SSH)
    if (file instanceof File) {
        return { name: file.name || 'clipboard-file', size: file.size || 0, mime: file.type || 'application/octet-stream', data: arrayBufferToBase64(await file.arrayBuffer()) };
    }
    // Plain object with dataUrl (SSH source): extract base64 from dataUrl
    if (file.dataUrl) {
        const b64 = String(file.dataUrl).includes(',') ? String(file.dataUrl).split(',', 2)[1] : String(file.dataUrl);
        return { name: file.name || 'clipboard-file', size: file.size || 0, mime: file.mime || 'application/octet-stream', data: b64 };
    }
    // Plain object with base64 data directly
    return { name: file.name || 'clipboard-file', size: file.size || 0, mime: file.mime || 'application/octet-stream', data: String(file.data || '') };
}
function sendClipboardText(text, paste = false) {
    if (!client || !connected) return false;
    client._sendMessage({ type: 'clipboard-set-text', text: String(text || ''), paste: !!paste });
    setClipboardHint(paste ? '已发布文本到 RDP 原生剪贴板，等待远端粘贴...' : '已发布文本到 RDP 原生剪贴板', 'info');
    return true;
}
async function sendClipboardFiles(files, paste = true) {
    const list = Array.from(files || []).filter(Boolean);
    if (!client || !connected || !list.length) return false;
    setFilesHint(`正在读取 ${list.length} 个文件并发布到 RDP 原生文件剪贴板...`, 'info');
    const payload = [];
    for (const file of list) payload.push(await fileToPayload(file));
    client._sendMessage({ type: 'clipboard-set-files', files: payload, paste: !!paste });
    return true;
}
function requestRemoteFileDownload(index) {
    if (!client || !connected || !remoteFiles[index]) return;
    const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    fileDownloads.set(requestId, { chunks: [], index, name: remoteFiles[index].name || 'remote-file', size: remoteFiles[index].size || 0 });
    client._sendMessage({ type: 'clipboard-download-file', requestId, index });
    setFilesHint(`正在通过 CLIPRDR FileContents 下载 ${remoteFiles[index].name}...`, 'info');
}
function finishRemoteFileDownload(requestId) {
    const item = fileDownloads.get(requestId);
    if (!item) return;
    fileDownloads.delete(requestId);
    const blob = new Blob(item.chunks, { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = item.name || 'remote-file';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 2000);
    setFilesHint(`已下载 ${item.name}`, 'success');
}
function handleClientMessage(msg) {
    if (msg.type === 'clipboard-text') {
        const text = String(msg.text || '');
        if (remoteClipboardText) remoteClipboardText.value = text;
        notifyParentSharedClipboardText(text);
        navigator.clipboard?.writeText?.(text).catch(() => {});
        setClipboardHint(`已收到远程文本剪贴板 ${text.length} 字符`, 'success');
    } else if (msg.type === 'clipboard-files') {
        remoteFiles = Array.isArray(msg.files) ? msg.files : [];
        renderRemoteFiles();
        setFilesHint(`已收到远程文件剪贴板 ${remoteFiles.length} 个文件`, 'success');
        // Notify parent (app.js) so SSH terminals can see/paste these files
        if (remoteFiles.length) {
            notifyParentSharedFileClipboard(remoteFiles.map((f) => ({ name: f.name, size: f.size, source: 'rdp-remote', index: f.index })));
        }
    } else if (msg.type === 'clipboard-set-text-result') {
        setClipboardHint(msg.ok ? '文本已进入 RDP 原生剪贴板' : '文本剪贴板发布失败', msg.ok ? 'success' : 'warning');
        if (msg.ok && msg.paste) setTimeout(() => client?.sendKeyCombo?.('Ctrl+V'), 80);
    } else if (msg.type === 'clipboard-set-files-result') {
        setFilesHint(msg.ok ? `文件已进入 RDP 原生文件剪贴板（${msg.count || 0} 个）` : '文件剪贴板发布失败', msg.ok ? 'success' : 'warning');
        if (msg.ok && msg.paste) setTimeout(() => client?.sendKeyCombo?.('Ctrl+V'), 120);
    } else if (msg.type === 'clipboard-file-start') {
        const item = fileDownloads.get(msg.requestId);
        if (item) item.chunks = [];
    } else if (msg.type === 'clipboard-file-chunk') {
        const item = fileDownloads.get(msg.requestId);
        if (item) item.chunks.push(base64ToUint8(msg.data));
    } else if (msg.type === 'clipboard-file-end') {
        finishRemoteFileDownload(msg.requestId);
    } else if (msg.type === 'clipboard-file-error') {
        setFilesHint(msg.message || '远程文件下载失败', 'warning');
    }
}
async function connect() {
    params = loadParams();
    if (!params.connectionId) { setStatus('error', '缺少 RDP connectionId'); notifyParentStatus('disconnected'); return; }
    updateInfo(); hideLegacyControls(); renderRemoteFiles();
    setStatus('connecting', '正在启动 RDPEGFX/FreeRDP3 bridge...'); notifyParentStatus('connecting');
    try {
        requireModernRdpBrowser();
        if (client) await client.destroy().catch(() => {});
        client = null;
        try { clientHost?.remove?.(); } catch {}
        clientHost = document.createElement('div');
        clientHost.className = 'rdp-gfx-client-host';
        clientHost.style.cssText = 'display:block;width:100%;height:100%;min-width:0;min-height:0;';
        displayShell && (displayShell.style.placeItems = 'stretch');
        if (displayRoot) { displayRoot.innerHTML = ''; Object.assign(displayRoot.style, { width: '100%', height: '100%', display: 'block' }); displayRoot.appendChild(clientHost); }
        client = new RDPClient(clientHost, {
            wsUrl: wsUrl(), showTopBar: false, showBottomBar: false,
            keepConnectionModalOpen: false, loadingSpinnerOpensModal: false, resizeDebounceMs: 800,
            visibleTopBarButtons: { connect: false, disconnect: false, keyboard: false, mute: false, screenshot: false, fullscreen: false },
            theme: buildEmbeddedRdpTheme(),
        });
        client.on('connected', ({ width, height } = {}) => { connected = true; setStatus('connected', `RDP 已连接 [RDPEGFX/WebCodecs]${width && height ? ` ${width}×${height}` : ''}`); notifyParentStatus('connected'); });
        client.on('resize', ({ width, height } = {}) => { if (connected) setStatus('connected', `RDP 已连接 [RDPEGFX/WebCodecs] ${width}×${height}`, { holdOverlayMs: 700 }); });
        client.on('error', ({ message } = {}) => { connected = false; setStatus('error', message || 'RDPEGFX 客户端错误'); notifyParentStatus('disconnected'); });
        client.on('disconnected', () => { connected = false; setStatus('disconnected', 'RDP 已断开'); notifyParentStatus('disconnected'); });
        client.on('message', handleClientMessage);
        await client.connect({ host: 'zephyr-rdp-gfx-proxy', port: 3389, user: 'zephyr', pass: 'server-side-secret' });
    } catch (err) { connected = false; setStatus('error', err.message || String(err)); notifyParentStatus('disconnected'); throw err; }
}
async function disconnect(closeParent = false) {
    try { await client?.disconnect?.(); } catch {}
    connected = false; setStatus('disconnected', 'RDP 已断开'); notifyParentStatus('disconnected');
    if (closeParent) notifyParentCloseRequest('rdp-disconnect');
}
function comboForKeyseq(seq) {
    const map = { esc: 'Escape', tab: 'Tab', enter: 'Enter', backspace: 'Backspace', win: 'Win', 'alt-tab': 'Alt+Tab', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown' };
    if (map[seq]) return map[seq];
    const ctrl = String(seq || '').match(/^ctrl-([a-z])$/); if (ctrl) return `Ctrl+${ctrl[1].toUpperCase()}`;
    const f = String(seq || '').match(/^f(\d{1,2})$/); if (f) return `F${f[1]}`;
    return '';
}
function sendTextToRemote(text) {
    if (!text || !client || !connected) return false;
    const parts = Array.from(String(text));
    textInputQueue = textInputQueue.then(async () => {
        for (const ch of parts) {
            if (!connected || !client) break;
            if (ch === '\n' || ch === '\r') client.sendKeyCombo?.('Enter');
            else if (ch === '\t') client.sendKeyCombo?.('Tab');
            else await client.sendKeys?.([ch], { delay: 0, releaseDelay: 12 }).catch(() => {});
            await new Promise((resolve) => setTimeout(resolve, 4));
        }
    }).catch(() => {});
    return true;
}
function focusMobileKeyboard() {
    if (!mobileKeyboardInput) return;
    mobileKeyboardInput.value = '';
    mobileKeyboardInput.style.pointerEvents = 'auto';
    try { mobileKeyboardInput.focus({ preventScroll: true }); } catch { mobileKeyboardInput.focus(); }
    $('#rdpStage')?.classList.add('keyboard-open');
    $('#keyboardBtn')?.classList.add('active');
    setTimeout(() => { try { mobileKeyboardInput.focus({ preventScroll: true }); } catch {} }, 80);
}
function blurMobileKeyboard() {
    if (!mobileKeyboardInput) return;
    mobileKeyboardInput.blur();
    mobileKeyboardInput.value = '';
    mobileKeyboardInput.style.pointerEvents = 'none';
    $('#rdpStage')?.classList.remove('keyboard-open');
    $('#keyboardBtn')?.classList.remove('active');
}
function toggleMobileKeyboard() {
    const keyboardOpen = document.activeElement === mobileKeyboardInput || $('#keyboardBtn')?.classList.contains('active');
    if (keyboardOpen) blurMobileKeyboard();
    else focusMobileKeyboard();
}
function setupMobileKeyboard() {
    if (!mobileKeyboardInput) return;
    let composing = false;
    let suppressInputUntil = 0;
    let lastSentText = '';
    let lastSentAt = 0;
    const reset = () => { mobileKeyboardInput.value = ''; };
    const sendOnce = (text) => {
        if (!text) return false;
        const now = Date.now();
        if (text === lastSentText && now - lastSentAt < 250) return false;
        lastSentText = text;
        lastSentAt = now;
        suppressInputUntil = now + 250;
        sendTextToRemote(text);
        reset();
        return true;
    };
    const sendBackspace = () => { try { client?.sendBackspace?.(1); } catch {} };
    const sendEnter = () => { try { client?.sendKeyCombo?.('Enter'); } catch {} };
    mobileKeyboardInput.addEventListener('compositionstart', () => { composing = true; });
    mobileKeyboardInput.addEventListener('compositionend', (event) => {
        composing = false;
        sendOnce(event.data || mobileKeyboardInput.value || '');
        reset();
    });
    mobileKeyboardInput.addEventListener('beforeinput', (event) => {
        if (!connected) return;
        const inputType = event.inputType || '';
        if (inputType === 'insertCompositionText' || composing) return;
        event.preventDefault();
        if (inputType.startsWith('deleteContent') || inputType === 'deleteByCut') { sendBackspace(); reset(); return; }
        if (inputType === 'insertLineBreak' || inputType === 'insertParagraph') { sendEnter(); reset(); return; }
        if (inputType.startsWith('insert')) sendOnce(event.data || mobileKeyboardInput.value || '');
    });
    mobileKeyboardInput.addEventListener('input', () => {
        if (composing) return;
        if (Date.now() < suppressInputUntil) { reset(); return; }
        sendOnce(mobileKeyboardInput.value || '');
    });
    mobileKeyboardInput.addEventListener('keydown', (event) => {
        if (!connected) return;
        if (event.key === 'Backspace') { event.preventDefault(); sendBackspace(); reset(); }
        else if (event.key === 'Enter') { event.preventDefault(); sendEnter(); reset(); }
    });
    mobileKeyboardInput.addEventListener('paste', (event) => {
        const text = event.clipboardData?.getData('text/plain') || '';
        if (!text) return;
        event.preventDefault();
        sendOnce(text);
    });
    mobileKeyboardInput.addEventListener('blur', () => {
        $('#keyboardBtn')?.classList.remove('active');
        $('#rdpStage')?.classList.remove('keyboard-open');
        mobileKeyboardInput.style.pointerEvents = 'none';
    });
}

function bindControls() {
    $('#resolutionBtn')?.addEventListener('click', () => { currentResolutionIdx = (currentResolutionIdx + 1) % resolutions.length; const res = resolutions[currentResolutionIdx]; $('#resolutionBtn').textContent = res.label; requestResolution(res); });
    $('#keyboardBtn')?.addEventListener('click', () => toggleMobileKeyboard());
    $('#ctrlAltDelBtn')?.addEventListener('click', () => { try { client?.sendCtrlAltDel?.(); } catch (err) { setStatus('error', err.message || String(err)); } });
    $('#reconnectBtn')?.addEventListener('click', () => connect().catch(() => {}));
    $('#disconnectBtn')?.addEventListener('click', () => disconnect(true));
    $('#clipboardBtn')?.addEventListener('click', () => { if (clipboardPanel) clipboardPanel.hidden = !clipboardPanel.hidden; });
    $('#rdpFilesBtn')?.addEventListener('click', () => { if (filesPanel) filesPanel.hidden = !filesPanel.hidden; });
    $('#clipboardReadLocalBtn')?.addEventListener('click', async () => { const text = await navigator.clipboard?.readText?.().catch(() => ''); if (clipboardText) clipboardText.value = text || ''; });
    $('#clipboardSendBtn')?.addEventListener('click', () => sendClipboardText(clipboardText?.value || '', false));
    $('#clipboardCopyRemoteBtn')?.addEventListener('click', () => navigator.clipboard?.writeText?.(remoteClipboardText?.value || '').catch(() => {}));
    $('#rdpFileSelectBtn')?.addEventListener('click', () => rdpFileInput?.click());
    rdpFileInput?.addEventListener('change', async () => {
        const files = Array.from(rdpFileInput.files || []);
        if (files.length) {
            rdpFileInput.value = '';
            await sendClipboardFiles(files, true);
        }
    });
    $('#rdpFileDownloadAllBtn')?.addEventListener('click', () => remoteFiles.forEach((_, i) => requestRemoteFileDownload(i)));
    $('#rdpFilePasteToRemoteBtn')?.addEventListener('click', () => client?.sendKeyCombo?.('Ctrl+V'));
    $('#shortcutsBtn')?.addEventListener('click', () => { const panel = $('#shortcutsPanel'); if (panel) panel.hidden = !panel.hidden; });
    $('#shortcutsPanel')?.addEventListener('click', (event) => { const btn = event.target.closest('[data-keyseq]'); if (!btn) return; const combo = comboForKeyseq(btn.dataset.keyseq || ''); if (combo) { try { client?.sendKeyCombo?.(combo); } catch (err) { setStatus('error', err.message || String(err)); } } });
    document.addEventListener('paste', async (event) => {
        if (!connected) return;
        const files = Array.from(event.clipboardData?.files || []);
        const text = event.clipboardData?.getData?.('text/plain') || '';
        if (files.length) { event.preventDefault(); await sendClipboardFiles(files, true); }
        else if (text && !/^(INPUT|TEXTAREA)$/i.test(event.target?.tagName || '')) { event.preventDefault(); if (clipboardText) clipboardText.value = text; sendClipboardText(text, true); }
    });
    document.addEventListener('dragover', (event) => { if (event.dataTransfer?.types?.includes?.('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } }, { passive: false });
    document.addEventListener('drop', async (event) => { const files = Array.from(event.dataTransfer?.files || []); if (files.length) { event.preventDefault(); await sendClipboardFiles(files, false); } }, { passive: false });
}
function consumeIncomingSshFiles(files) {
    // SSH terminal sends files via parent postMessage; forward to RDP as native clipboard files
    return sendClipboardFiles(files, true);
}

window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    const data = event.data || {};
    if (data.source === 'zephyr-app' && data.type === 'shared-file-clipboard-available' && Array.isArray(data.files) && data.files.length) {
        setFilesHint(`SSH 终端已复制 ${data.files.length} 个文件，正在转发到 RDP...`, 'info');
        consumeIncomingSshFiles(data.files);
        return;
    }
    if (data.type === 'theme-change') applyFrameTheme(data.theme, data.appearance || {});
});

window.addEventListener('beforeunload', () => { try { client?.disconnect?.(); } catch {} });
window.addEventListener('DOMContentLoaded', () => {
    bindControls();
    setupMobileKeyboard();
    connect().catch(() => {});
    requestParentSharedFileClipboard();
});
