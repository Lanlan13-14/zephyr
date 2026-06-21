import { RDPClient } from './vendor/freerdp-web/rdp-client.js';
import { parseMessage, buildFrameAck } from './vendor/freerdp-web/wire-format.js';
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
const pendingFileList = $('#rdpPendingFileList');
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
let directAudio = null;
let lastRemotePointer = null;
let pendingFilePasteTarget = null;
let pendingRdpClipboardFiles = [];
let rdpManualDisconnect = false;
let rdpReconnectTimer = null;
let rdpReconnectAttempts = 0;
let rdpReplacingConnection = false;
let desiredRdpSize = null;
let lastSyncedLocalClipboardText = '';
let clipboardSyncTimer = null;
let rdpInputSuppressed = false;
let rdpInputSuppressedUntil = 0;
const fileDownloads = new Map();
const resolutions = [
    { label: '自动', width: 0, height: 0 },
    { label: '1080p', width: 1920, height: 1080 },
    { label: '2K', width: 2560, height: 1440 },
    { label: '4K', width: 3840, height: 2160 },
    { label: '8K', width: 7680, height: 4320 },
];
let statusSequence = 0;
const qualityModes = ['balanced', 'performance', 'quality'];
const fpsModes = [30, 45, 60, 120, 144];
let qualityMode = qualityModes.includes(String(params.quality || '').toLowerCase()) ? String(params.quality).toLowerCase() : (localStorage.getItem('zephyr-rdp-gfx-quality') || 'balanced');
if (!qualityModes.includes(qualityMode)) qualityMode = 'balanced';
let fpsValue = Math.max(15, Math.min(144, Number(params.rdpFps || localStorage.getItem('zephyr-rdp-gfx-fps') || 60) || 60));
if (!fpsModes.includes(fpsValue)) fpsValue = 60;
function qualityLabel(mode = qualityMode) {
    if (mode === 'performance') return '性能';
    if (mode === 'quality') return '画质';
    return '平衡';
}
function updateQualityFpsButtons() {
    const q = $('#qualityBtn');
    if (q) {
        q.textContent = qualityLabel();
        q.title = `当前：${qualityLabel()}模式，点击切换性能/画质模式`;
        q.classList.toggle('active', qualityMode !== 'balanced');
    }
    const f = $('#fpsBtn');
    if (f) {
        f.textContent = `${fpsValue}FPS`;
        f.title = `当前：${fpsValue} FPS，点击切换 30 / 45 / 60 / 120 / 144 FPS`;
        f.classList.toggle('active', fpsValue !== 30);
    }
}

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
window.addEventListener('storage', (event) => {
    if (event.key === 'zephyr-theme') applyFrameTheme(initialTheme());
});
function refreshFrameThemeFromStorage() { applyFrameTheme(initialTheme()); }


function loadParams() {
    const key = tabId ? `zephyr_remote_desktop_params_${tabId}` : 'zephyr_remote_desktop_params';
    let stored = {};
    try { stored = JSON.parse(sessionStorage.getItem(key) || '{}') || {}; } catch { stored = {}; }
    const query = Object.fromEntries(new URLSearchParams(location.search));
    /* Direct links/reloads only have URL parameters. The embedded app stores a
     * richer object in sessionStorage, but URL values must override/fill it so
     * /rdp.html?connectionId=... never becomes a false "missing connectionId". */
    return { ...stored, ...Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && String(v) !== '')) };
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
    const query = new URLSearchParams({ connectionId: params.connectionId || '', tabId: params.tabId || tabId, quality: qualityMode, fps: String(fpsValue) });
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
    // Keep view/joystick controls visible in direct-canvas mode.
}
function availableSize() {
    const rect = displayRoot?.getBoundingClientRect?.();
    const w = Math.max(640, Math.floor((rect?.width || window.innerWidth || 1280) / 2) * 2);
    const h = Math.max(480, Math.floor((rect?.height || window.innerHeight || 720) / 2) * 2);
    return { width: Math.min(w, 7680), height: Math.min(h, 4320) };
}
function adaptPresetResolutionToViewport(res = {}) {
    const width = Math.max(640, Math.floor((Number(res.width) || 0) / 2) * 2);
    const height = Math.max(480, Math.floor((Number(res.height) || 0) / 2) * 2);
    return { width: Math.min(width, 7680), height: Math.min(height, 4320) };
}
function resolutionFromParams() {
    const value = String(params.rdpResolution || '').toLowerCase();
    const idx = resolutions.findIndex((r) => r.width && r.height && value === `${r.width}x${r.height}`);
    if (idx >= 0) {
        currentResolutionIdx = idx;
        return adaptPresetResolutionToViewport(resolutions[idx]);
    }
    if (value === 'auto') {
        currentResolutionIdx = 0;
        return null;
    }
    return null;
}
function applyInitialResolutionChoice() {
    desiredRdpSize = resolutionFromParams();
    const btn = $('#resolutionBtn');
    if (btn) btn.textContent = resolutions[currentResolutionIdx]?.label || '自动';
}
function requestRuntimeConfig(reconnect = true) {
    if (!client || !connected) return false;
    try {
        client._sendMessage({ type: reconnect ? 'reconnect' : 'settings', quality: qualityMode, fps: fpsValue });
        return true;
    } catch (err) {
        setStatus('error', `更新 RDP 参数失败：${err.message || err}`);
        return false;
    }
}
function cycleQuality() {
    const next = qualityModes[(qualityModes.indexOf(qualityMode) + 1) % qualityModes.length];
    qualityMode = next;
    localStorage.setItem('zephyr-rdp-gfx-quality', qualityMode);
    updateQualityFpsButtons();
    setStatus(connected ? 'connected' : 'connecting', `RDP ${qualityLabel()}模式 / ${fpsValue}FPS`, { holdOverlayMs: 900 });
    requestRuntimeConfig(false);
    return qualityMode;
}
function cycleFps() {
    const next = fpsModes[(fpsModes.indexOf(fpsValue) + 1) % fpsModes.length];
    fpsValue = next;
    localStorage.setItem('zephyr-rdp-gfx-fps', String(fpsValue));
    updateQualityFpsButtons();
    setStatus(connected ? 'connected' : 'connecting', `RDP ${qualityLabel()}模式 / ${fpsValue}FPS`, { holdOverlayMs: 900 });
    requestRuntimeConfig(false);
    return fpsValue;
}
function requestResolution(res) {
    const size = res?.width && res?.height ? adaptPresetResolutionToViewport(res) : availableSize();
    desiredRdpSize = size;
    displayScaleMode = 'fit';
    displayZoom = 100;
    applyDisplayScale();
    setStatus('connecting', `正在以 ${size.width}×${size.height} 重新连接 RDP...`);
    try {
        // FreeRDP dynamic desktop resize is unreliable with the current native
        // RDPEGFX bridge on some Windows servers. Reconnect with the requested
        // DesktopWidth/DesktopHeight so the resolution actually changes.
        connect().catch(() => {});
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

function renderPendingFiles() {
    if (!pendingFileList) return;
    if (!pendingRdpClipboardFiles.length) {
        pendingFileList.innerHTML = '<div class="rdp-file-empty">暂无待粘贴文件</div>';
        return;
    }
    pendingFileList.innerHTML = pendingRdpClipboardFiles.map((f, i) => {
        const name = escapeHtml(f.name || 'clipboard-file');
        const size = formatFileSize(f.size || 0);
        return `<div class="rdp-file-item"><span class="rdp-file-name" title="${name}">${name}</span><span class="rdp-file-size">${size}</span><button class="btn-sm rdp-file-remove-btn" data-remove-pending-file="${i}" title="移除">❌</button></div>`;
    }).join('');
    pendingFileList.querySelectorAll('[data-remove-pending-file]').forEach((btn) => btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.removePendingFile);
        if (Number.isFinite(idx)) pendingRdpClipboardFiles.splice(idx, 1);
        renderPendingFiles();
        setFilesHint(pendingRdpClipboardFiles.length ? `待粘贴 ${pendingRdpClipboardFiles.length} 个文件` : '已清空待粘贴文件', pendingRdpClipboardFiles.length ? 'info' : 'success');
    }));
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
async function sendClipboardFiles(files, paste = true, target = null) {
    const list = Array.from(files || []).filter(Boolean);
    if (!client || !connected || !list.length) return false;
    if (target) pendingFilePasteTarget = target;
    const nativeFiles = list.filter((f) => typeof File !== 'undefined' && f instanceof File);
    const otherFiles = list.filter((f) => !(typeof File !== 'undefined' && f instanceof File));
    const payload = [];
    if (nativeFiles.length) {
        setFilesHint(`正在通过浏览器原生上传通道上传 ${nativeFiles.length} 个文件...`, 'info');
        const form = new FormData();
        for (const file of nativeFiles) form.append('files', file, file.name || 'file');
        const resp = await fetch('/api/rdp-gfx/upload-clipboard-files', { method: 'POST', body: form });
        if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            setFilesHint(`文件上传失败：${text || resp.status}`, 'warning');
            return false;
        }
        const data = await resp.json();
        payload.push(...(data.files || []));
    }
    if (otherFiles.length) {
        setFilesHint(`正在准备 ${otherFiles.length} 个跨会话文件...`, 'info');
        for (const file of otherFiles) payload.push(await fileToPayload(file));
    }
    if (!payload.length) return false;
    setFilesHint(`正在发布 ${payload.length} 个文件到 RDP 原生文件剪贴板...`, 'info');
    client._sendMessage({ type: 'clipboard-set-files', files: payload, paste: !!paste });
    return true;
}
function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
        reader.readAsDataURL(blob);
    });
}
function downloadRemoteFileAsDataUrl(index) {
    return new Promise((resolve, reject) => {
        if (!client || !connected || !remoteFiles[index]) return reject(new Error('RDP 远程文件不可用'));
        const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        const file = remoteFiles[index] || {};
        fileDownloads.set(requestId, { chunks: [], index, name: file.name || 'remote-file', size: file.size || 0, resolve, reject, asDataUrl: true });
        client._sendMessage({ type: 'clipboard-download-file', requestId, index });
    });
}
function requestRemoteFileDownload(index) {
    if (!client || !connected || !remoteFiles[index]) return;
    const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    fileDownloads.set(requestId, { chunks: [], index, name: remoteFiles[index].name || 'remote-file', size: remoteFiles[index].size || 0 });
    client._sendMessage({ type: 'clipboard-download-file', requestId, index });
    setFilesHint(`正在通过 CLIPRDR FileContents 下载 ${remoteFiles[index].name}...`, 'info');
}
async function finishRemoteFileDownload(requestId) {
    const item = fileDownloads.get(requestId);
    if (!item) return;
    fileDownloads.delete(requestId);
    const blob = new Blob(item.chunks, { type: 'application/octet-stream' });
    if (item.asDataUrl) {
        try {
            item.resolve?.({ name: item.name || 'remote-file', size: item.size || blob.size || 0, mime: 'application/octet-stream', dataUrl: await blobToDataUrl(blob) });
        } catch (err) {
            item.reject?.(err);
        }
        return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = item.name || 'remote-file';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 2000);
    setFilesHint(`已下载 ${item.name}`, 'success');
}
function setRdpInputSuppressed(value, holdMs = 180) {
    rdpInputSuppressed = !!value;
    rdpInputSuppressedUntil = value ? Number.POSITIVE_INFINITY : Date.now() + Math.max(0, Number(holdMs) || 0);
    $('#rdpStage')?.classList.toggle('joystick-active', !!value);
}
function isRdpInputSuppressed() {
    return rdpInputSuppressed || Date.now() < rdpInputSuppressedUntil;
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
        if (msg.ok && msg.paste) setTimeout(() => completeNativePasteAtRemoteTarget(pendingFilePasteTarget), 120);
        pendingFilePasteTarget = null;
    } else if (msg.type === 'clipboard-file-start') {
        const item = fileDownloads.get(msg.requestId);
        if (item) item.chunks = [];
    } else if (msg.type === 'clipboard-file-chunk') {
        const item = fileDownloads.get(msg.requestId);
        if (item) item.chunks.push(base64ToUint8(msg.data));
    } else if (msg.type === 'clipboard-file-end') {
        finishRemoteFileDownload(msg.requestId);
    } else if (msg.type === 'clipboard-file-error') {
        const item = fileDownloads.get(msg.requestId);
        if (item?.reject) { fileDownloads.delete(msg.requestId); item.reject(new Error(msg.message || '远程文件下载失败')); }
        setFilesHint(msg.message || '远程文件下载失败', 'warning');
    }
}


function ensureDirectAudio() {
    if (directAudio) return directAudio;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    const ctx = new AudioCtx();
    const gain = ctx.createGain();
    gain.gain.value = 1;
    gain.connect(ctx.destination);
    directAudio = { ctx, gain, nextTime: 0, opusDecoder: null, opusRate: 0, opusChannels: 0 };
    return directAudio;
}
async function handleDirectOpus(bytes) {
    if (typeof AudioDecoder === 'undefined') return;
    const audio = ensureDirectAudio();
    if (!audio) return;
    if (audio.ctx.state === 'suspended') await audio.ctx.resume().catch(() => {});
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const sampleRate = view.getUint32(4, true);
    const channels = view.getUint16(8, true);
    const frameSize = view.getUint16(10, true);
    if (!frameSize || bytes.byteLength < 12 + frameSize) return;
    if (!audio.opusDecoder || audio.opusRate !== sampleRate || audio.opusChannels !== channels) {
        try { audio.opusDecoder?.close?.(); } catch {}
        audio.opusRate = sampleRate;
        audio.opusChannels = channels;
        audio.opusDecoder = new AudioDecoder({
            output: (audioData) => playDirectAudioData(audioData),
            error: () => {},
        });
        await audio.opusDecoder.configure({ codec: 'opus', sampleRate, numberOfChannels: channels }).catch(() => { audio.opusDecoder = null; });
    }
    if (!audio.opusDecoder) return;
    const opus = bytes.slice(12, 12 + frameSize);
    audio.opusDecoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: performance.now() * 1000, data: opus }));
}
function playDirectAudioData(audioData) {
    const audio = ensureDirectAudio();
    if (!audio) { audioData.close(); return; }
    try {
        const frames = audioData.numberOfFrames;
        const channels = audioData.numberOfChannels;
        const rate = audioData.sampleRate || audio.ctx.sampleRate;
        const buffer = audio.ctx.createBuffer(channels, frames, rate);
        if (String(audioData.format || '').includes('planar')) {
            for (let ch = 0; ch < channels; ch++) {
                const dst = buffer.getChannelData(ch);
                audioData.copyTo(dst, { planeIndex: ch });
            }
        } else {
            const interleaved = new Float32Array(frames * channels);
            audioData.copyTo(interleaved, { planeIndex: 0 });
            for (let ch = 0; ch < channels; ch++) {
                const dst = buffer.getChannelData(ch);
                for (let i = 0; i < frames; i++) dst[i] = interleaved[i * channels + ch] || 0;
            }
        }
        const src = audio.ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(audio.gain);
        const now = audio.ctx.currentTime;
        audio.nextTime = Math.max(now + 0.02, audio.nextTime || 0);
        src.start(audio.nextTime);
        audio.nextTime += buffer.duration;
    } catch {} finally { audioData.close(); }
}
function handleDirectPcm(bytes) {
    const audio = ensureDirectAudio();
    if (!audio) return;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const sampleRate = view.getUint32(4, true);
    const channels = view.getUint16(8, true);
    const bits = view.getUint16(10, true);
    if (bits !== 16 || bytes.byteLength <= 12) return;
    const pcm = new DataView(bytes.buffer, bytes.byteOffset + 12, bytes.byteLength - 12);
    const frames = Math.floor(pcm.byteLength / (channels * 2));
    const buffer = audio.ctx.createBuffer(channels, frames, sampleRate);
    for (let i = 0; i < frames; i++) {
        for (let ch = 0; ch < channels; ch++) buffer.getChannelData(ch)[i] = pcm.getInt16((i * channels + ch) * 2, true) / 32768;
    }
    const src = audio.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(audio.gain);
    const now = audio.ctx.currentTime;
    audio.nextTime = Math.max(now + 0.02, audio.nextTime || 0);
    src.start(audio.nextTime);
    audio.nextTime += buffer.duration;
}

async function connectDirectCanvasRdp() {
    if (!displayRoot) throw new Error('RDP display root missing');
    const size = desiredRdpSize || availableSize();
    const canvas = document.createElement('canvas');
    canvas.className = 'rdp-direct-canvas';
    canvas.width = size.width;
    canvas.height = size.height;
    canvas.style.cssText = 'display:block;width:100%;height:100%;background:#000;object-fit:fill;';
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    displayRoot.innerHTML = '';
    displayRoot.style.cssText += ';display:block;width:100%;height:100%;background:#000;';
    displayRoot.appendChild(canvas);
    const unlockAudio = () => { const audio = ensureDirectAudio(); audio?.ctx?.resume?.().catch?.(() => {}); };
    canvas.addEventListener('pointerdown', unlockAudio, { passive: true });
    document.addEventListener('click', unlockAudio, { passive: true, once: true });

    const surfaces = new Map();
    const mapped = new Map();
    let primarySurfaceId = null;
    let totalFrames = 0;
    const ensureSurfaceSize = (surface, minWidth, minHeight) => {
        const width = Math.max(1, Math.ceil(minWidth));
        const height = Math.max(1, Math.ceil(minHeight));
        if (!surface || (surface.canvas.width >= width && surface.canvas.height >= height)) return surface;
        const oldCanvas = surface.canvas;
        const next = document.createElement('canvas');
        next.width = Math.max(width, oldCanvas.width);
        next.height = Math.max(height, oldCanvas.height);
        const nextCtx = next.getContext('2d', { alpha: false });
        nextCtx.drawImage(oldCanvas, 0, 0);
        surface.canvas = next;
        surface.ctx = nextCtx;
        surface.width = next.width;
        surface.height = next.height;
        return surface;
    };
    const resetSurfacesForResize = () => {
        surfaces.clear();
        mapped.clear();
        primarySurfaceId = null;
    };
    rdpManualDisconnect = false;
    if (rdpReconnectTimer) { clearTimeout(rdpReconnectTimer); rdpReconnectTimer = null; }
    const ws = new WebSocket(wsUrl());
    ws.binaryType = 'arraybuffer';
    client = {
        _ws: ws,
        _sendMessage(msg) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); },
        async disconnect() { rdpManualDisconnect = true; try { ws.close(1000, 'client disconnect'); } catch {} },
        destroy() { try { ws.close(1000, 'client destroy'); } catch {}; return Promise.resolve(); },
        sendKeyCombo(combo) { this._sendMessage({ type: 'keycombo', combo }); },
        sendCtrlAltDel() { this._sendMessage({ type: 'keycombo', combo: 'Ctrl+Alt+Delete' }); },
        sendKeys(keys) {
            const text = Array.isArray(keys) ? keys.join('') : String(keys || '');
            for (const key of Array.from(text)) {
                const code = key === '\n' || key === '\r' ? 'Enter' : key === '\t' ? 'Tab' : key === ' ' ? 'Space' : '';
                const label = code === 'Enter' ? 'Enter' : code === 'Tab' ? 'Tab' : code === 'Space' ? ' ' : key;
                const keyCode = code === 'Enter' ? 13 : code === 'Tab' ? 9 : code === 'Space' ? 32 : 0;
                this._sendMessage({ type: 'key', action: 'down', key: label, code, keyCode });
                this._sendMessage({ type: 'key', action: 'up', key: label, code, keyCode });
            }
            return Promise.resolve();
        },
        sendBackspace(count = 1) {
            for (let i = 0; i < count; i += 1) {
                this._sendMessage({ type: 'key', action: 'down', key: 'Backspace', code: 'Backspace', keyCode: 8 });
                this._sendMessage({ type: 'key', action: 'up', key: 'Backspace', code: 'Backspace', keyCode: 8 });
            }
        },
    };
    ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'connect', host: 'zephyr-rdp-gfx-proxy', port: 3389, user: 'zephyr', pass: 'server-side-secret', width: size.width, height: size.height }));
    };
    ws.onmessage = async (event) => {
        if (typeof event.data === 'string') {
            let msg = null;
            try { msg = JSON.parse(event.data); } catch { return; }
            if (msg.type === 'connected') {
                connected = true;
                rdpReconnectAttempts = 0;
                resetSurfacesForResize();
                canvas.width = msg.width || canvas.width;
                canvas.height = msg.height || canvas.height;
                setStatus('connected', `RDP 已连接 [RDPEGFX/WebP] ${canvas.width}×${canvas.height}`);
                notifyParentStatus('connected');
                startClipboardSyncLoop();
                syncLocalClipboardTextToRdp('连接');
                applyDisplayScale();
            } else if (msg.type === 'resize') {
                resetSurfacesForResize();
                canvas.width = msg.width || canvas.width;
                canvas.height = msg.height || canvas.height;
                setStatus('connected', `RDP 已连接 [RDPEGFX/WebP] ${canvas.width}×${canvas.height}`, { holdOverlayMs: 700 });
                applyDisplayScale();
            } else if (msg.type === 'disconnected') {
                connected = false;
                stopClipboardSyncLoop();
                setStatus('disconnected', msg.reason || 'RDP 已断开');
                notifyParentStatus('disconnected');
            } else if (msg.type === 'error') {
                connected = false;
                stopClipboardSyncLoop();
                setStatus('error', msg.message || 'RDP 错误');
                notifyParentStatus('disconnected');
            } else {
                handleClientMessage(msg);
            }
            return;
        }
        const bytes = new Uint8Array(event.data);
        const magic = String.fromCharCode(bytes[0] || 0, bytes[1] || 0, bytes[2] || 0, bytes[3] || 0);
        if (magic === 'OPUS') { handleDirectOpus(bytes); return; }
        if (magic === 'AUDI') { handleDirectPcm(bytes); return; }
        const msg = parseMessage(bytes);
        if (!msg) return;
        if (msg.type === 'createSurface') {
            const s = document.createElement('canvas');
            s.width = Math.max(1, msg.width);
            s.height = Math.max(1, msg.height);
            surfaces.set(msg.surfaceId, { canvas: s, ctx: s.getContext('2d', { alpha: false }), width: s.width, height: s.height });
            if (primarySurfaceId === null) primarySurfaceId = msg.surfaceId;
        } else if (msg.type === 'deleteSurface') {
            surfaces.delete(msg.surfaceId);
            mapped.delete(msg.surfaceId);
        } else if (msg.type === 'mapSurface') {
            primarySurfaceId = msg.surfaceId;
            mapped.set(msg.surfaceId, { x: msg.outputX || 0, y: msg.outputY || 0 });
        } else if (msg.type === 'resetGraphics') {
            resetSurfacesForResize();
            if (msg.width && msg.height) {
                canvas.width = msg.width;
                canvas.height = msg.height;
                setStatus('connected', `RDP 已连接 [RDPEGFX/WebP] ${canvas.width}×${canvas.height}`, { holdOverlayMs: 700 });
                applyDisplayScale();
            }
        } else if (msg.type === 'tile' && msg.codec === 'webp') {
            let surface = surfaces.get(msg.surfaceId);
            if (!surface) {
                const s = document.createElement('canvas');
                s.width = Math.max(canvas.width, msg.x + msg.w);
                s.height = Math.max(canvas.height, msg.y + msg.h);
                surface = { canvas: s, ctx: s.getContext('2d', { alpha: false }), width: s.width, height: s.height };
                surfaces.set(msg.surfaceId, surface);
                if (primarySurfaceId === null) primarySurfaceId = msg.surfaceId;
            } else {
                ensureSurfaceSize(surface, Math.max(canvas.width, msg.x + msg.w), Math.max(canvas.height, msg.y + msg.h));
            }
            const bitmap = await createImageBitmap(new Blob([msg.payload], { type: 'image/webp' }));
            surface.ctx.drawImage(bitmap, msg.x, msg.y, msg.w, msg.h);
            bitmap.close();
            const m = mapped.get(msg.surfaceId) || { x: 0, y: 0 };
            ctx.drawImage(surface.canvas, m.x, m.y);
            applyDisplayScale();
        } else if (msg.type === 'solidFill') {
            const surface = surfaces.get(msg.surfaceId);
            if (surface) {
                surface.ctx.fillStyle = `rgba(${msg.color & 255},${(msg.color >> 8) & 255},${(msg.color >> 16) & 255},1)`;
                surface.ctx.fillRect(msg.x, msg.y, msg.w, msg.h);
                const m = mapped.get(msg.surfaceId) || { x: 0, y: 0 };
                ctx.drawImage(surface.canvas, m.x, m.y);
            }
        } else if (msg.type === 'endFrame') {
            totalFrames += 1;
            if (primarySurfaceId !== null && surfaces.has(primarySurfaceId)) {
                const m = mapped.get(primarySurfaceId) || { x: 0, y: 0 };
                ctx.drawImage(surfaces.get(primarySurfaceId).canvas, m.x, m.y);
            }
            if (ws.readyState === WebSocket.OPEN) ws.send(buildFrameAck(msg.frameId, totalFrames, 0));
        }
    };
    const canvasPoint = (clientX, clientY) => {
        const rect = canvas.getBoundingClientRect();
        const style = getComputedStyle(canvas);
        const objectFit = style.objectFit || 'fill';
        let contentLeft = rect.left;
        let contentTop = rect.top;
        let contentWidth = Math.max(1, rect.width);
        let contentHeight = Math.max(1, rect.height);
        if (objectFit === 'contain' || displayScaleMode === 'fit') {
            const scale = Math.min(rect.width / Math.max(1, canvas.width), rect.height / Math.max(1, canvas.height));
            contentWidth = Math.max(1, canvas.width * scale);
            contentHeight = Math.max(1, canvas.height * scale);
            contentLeft = rect.left + (rect.width - contentWidth) / 2;
            contentTop = rect.top + (rect.height - contentHeight) / 2;
        }
        const nx = (clientX - contentLeft) / contentWidth;
        const ny = (clientY - contentTop) / contentHeight;
        const pt = {
            clientX, clientY,
            x: Math.max(0, Math.min(canvas.width - 1, Math.round(nx * canvas.width))),
            y: Math.max(0, Math.min(canvas.height - 1, Math.round(ny * canvas.height)))
        };
        lastRemotePointer = pt;
        return pt;
    };
    const sendMouseAt = (action, clientX, clientY, extra = {}) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ type: 'mouse', action, ...canvasPoint(clientX, clientY), ...extra }));
    };
    const sendMouse = (action, event, extra = {}) => sendMouseAt(action, event.clientX, event.clientY, extra);
    const sendLeftClick = (x, y) => { sendMouseAt('down', x, y, { button: 0 }); setTimeout(() => sendMouseAt('up', x, y, { button: 0 }), 24); };
    const sendRightClick = (x, y) => { sendMouseAt('down', x, y, { button: 2 }); setTimeout(() => sendMouseAt('up', x, y, { button: 2 }), 35); };
    canvas.tabIndex = 0;
    canvas.style.touchAction = 'none';
    canvas.style.webkitUserSelect = 'none';
    canvas.style.userSelect = 'none';
    canvas.addEventListener('contextmenu', (event) => event.preventDefault());

    const activePointers = new Map();
    let touchDrag = null;
    let longPressTimer = null;
    let lastTapAt = 0;
    let lastTap = null;
    let pinchScroll = null;
    const clearLongPress = () => { if (longPressTimer) clearTimeout(longPressTimer); longPressTimer = null; };
    const dist = (a, b) => Math.hypot((a?.x || 0) - (b?.x || 0), (a?.y || 0) - (b?.y || 0));

    canvas.addEventListener('pointerdown', (event) => {
        if (isRdpInputSuppressed()) { event.preventDefault(); event.stopPropagation(); return; }
        canvas.focus({ preventScroll: true });
        canvas.setPointerCapture?.(event.pointerId);
        const p = { id: event.pointerId, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, time: Date.now(), type: event.pointerType || 'mouse' };
        activePointers.set(event.pointerId, p);
        if (p.type === 'touch') {
            event.preventDefault();
            if (activePointers.size === 1) {
                touchDrag = { active: false, pointerId: event.pointerId, startX: p.x, startY: p.y };
                clearLongPress();
                longPressTimer = setTimeout(() => {
                    const cur = activePointers.get(event.pointerId);
                    if (cur && touchDrag && !touchDrag.active && dist({ x: cur.x, y: cur.y }, { x: p.startX, y: p.startY }) < 12) {
                        touchDrag.cancelTap = true;
                        sendRightClick(cur.x, cur.y);
                    }
                }, 560);
            } else if (activePointers.size === 2) {
                clearLongPress();
                const pts = [...activePointers.values()];
                pinchScroll = { lastY: (pts[0].y + pts[1].y) / 2 };
            }
            return;
        }
        sendMouse('down', event, { button: event.button || 0 });
        event.preventDefault();
    });
    canvas.addEventListener('pointermove', (event) => {
        if (isRdpInputSuppressed()) { event.preventDefault(); event.stopPropagation(); return; }
        const p = activePointers.get(event.pointerId);
        if (p) { p.x = event.clientX; p.y = event.clientY; }
        if ((event.pointerType || 'mouse') === 'touch') {
            event.preventDefault();
            if (activePointers.size >= 2 && pinchScroll) {
                const pts = [...activePointers.values()].slice(0, 2);
                const midY = (pts[0].y + pts[1].y) / 2;
                const deltaY = pinchScroll.lastY - midY;
                if (Math.abs(deltaY) > 2) {
                    sendMouseAt('wheel', (pts[0].x + pts[1].x) / 2, midY, { deltaY, deltaX: 0 });
                    pinchScroll.lastY = midY;
                }
                return;
            }
            if (touchDrag && touchDrag.pointerId === event.pointerId) {
                const moved = Math.hypot(event.clientX - touchDrag.startX, event.clientY - touchDrag.startY);
                if (!touchDrag.active && moved > 10) {
                    clearLongPress();
                    touchDrag.active = true;
                    sendMouseAt('down', touchDrag.startX, touchDrag.startY, { button: 0 });
                }
                if (touchDrag.active) sendMouse('move', event);
            }
            return;
        }
        sendMouse('move', event);
    });
    canvas.addEventListener('pointerup', (event) => {
        if (isRdpInputSuppressed()) { event.preventDefault(); event.stopPropagation(); activePointers.delete(event.pointerId); return; }
        const p = activePointers.get(event.pointerId) || { startX: event.clientX, startY: event.clientY, time: Date.now(), type: event.pointerType || 'mouse' };
        activePointers.delete(event.pointerId);
        if ((event.pointerType || 'mouse') === 'touch') {
            event.preventDefault();
            clearLongPress();
            if (touchDrag?.active) {
                sendMouse('up', event, { button: 0 });
            } else if (!touchDrag?.cancelTap) {
                const now = Date.now();
                const isDouble = lastTap && now - lastTapAt < 330 && dist(lastTap, { x: event.clientX, y: event.clientY }) < 28;
                sendLeftClick(event.clientX, event.clientY);
                if (isDouble) setTimeout(() => sendLeftClick(event.clientX, event.clientY), 55);
                lastTapAt = now;
                lastTap = { x: event.clientX, y: event.clientY };
            }
            if (!activePointers.size) { touchDrag = null; pinchScroll = null; }
            return;
        }
        sendMouse('up', event, { button: event.button || 0 });
        event.preventDefault();
    });
    canvas.addEventListener('pointercancel', (event) => {
        if (isRdpInputSuppressed()) { event.preventDefault(); event.stopPropagation(); activePointers.delete(event.pointerId); return; }
        clearLongPress();
        if (touchDrag?.active) sendMouse('up', event, { button: 0 });
        activePointers.delete(event.pointerId);
        touchDrag = null;
        pinchScroll = null;
    });
    canvas.addEventListener('wheel', (event) => { if (isRdpInputSuppressed()) { event.preventDefault(); event.stopPropagation(); return; } sendMouse('wheel', event, { deltaY: event.deltaY || 0, deltaX: event.deltaX || 0 }); event.preventDefault(); }, { passive: false });
    canvas.addEventListener('keydown', (event) => {
        if ((event.ctrlKey || event.metaKey) && String(event.key || '').toLowerCase() === 'v' && pendingRdpClipboardFiles.length) {
            event.preventDefault();
            pasteFilesAtRemoteTarget(lastRemotePointer);
            return;
        }
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'key', action: 'down', key: event.key, code: event.code, keyCode: event.keyCode || event.which || 0, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey, altKey: event.altKey, metaKey: event.metaKey }));
        event.preventDefault();
    });
    canvas.addEventListener('keyup', (event) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'key', action: 'up', key: event.key, code: event.code, keyCode: event.keyCode || event.which || 0, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey, altKey: event.altKey, metaKey: event.metaKey })); event.preventDefault(); });
    ws.onerror = () => { connected = false; setStatus('error', 'RDP WebSocket 错误'); notifyParentStatus('disconnected'); };
    ws.onclose = () => {
        const wasConnected = connected;
        connected = false;
        stopClipboardSyncLoop();
        if (rdpManualDisconnect || rdpReplacingConnection) {
            if (rdpManualDisconnect && wasConnected) { setStatus('disconnected', 'RDP 已断开'); notifyParentStatus('disconnected'); }
            return;
        }
        const delay = Math.min(10000, 800 * Math.pow(1.7, rdpReconnectAttempts++));
        setStatus('connecting', `RDP 已断开，${Math.round(delay / 1000)} 秒后自动重连...`);
        notifyParentStatus('connecting');
        rdpReconnectTimer = setTimeout(() => connect().catch(() => {}), delay);
    };
}

async function connect() {
    params = loadParams();
    if (!params.connectionId) { setStatus('error', '缺少 RDP connectionId'); notifyParentStatus('disconnected'); return; }
    updateQualityFpsButtons();
    updateInfo(); hideLegacyControls(); renderRemoteFiles();
    setStatus('connecting', '正在启动 RDPEGFX/FreeRDP3 bridge...'); notifyParentStatus('connecting');
    try {
        if (client) {
            rdpReplacingConnection = true;
            await client.destroy?.().catch?.(() => {});
            setTimeout(() => { rdpReplacingConnection = false; }, 250);
        }
        client = null;
        await connectDirectCanvasRdp();
        return;
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

function remotePointFromClient(clientX, clientY) {
    const canvas = displayRoot?.querySelector?.('canvas.rdp-direct-canvas');
    if (!canvas) return lastRemotePointer;
    const rect = canvas.getBoundingClientRect();
    const style = getComputedStyle(canvas);
    const objectFit = style.objectFit || 'fill';
    let contentLeft = rect.left;
    let contentTop = rect.top;
    let contentWidth = Math.max(1, rect.width);
    let contentHeight = Math.max(1, rect.height);
    if (objectFit === 'contain' || displayScaleMode === 'fit') {
        const scale = Math.min(rect.width / Math.max(1, canvas.width), rect.height / Math.max(1, canvas.height));
        contentWidth = Math.max(1, canvas.width * scale);
        contentHeight = Math.max(1, canvas.height * scale);
        contentLeft = rect.left + (rect.width - contentWidth) / 2;
        contentTop = rect.top + (rect.height - contentHeight) / 2;
    }
    return {
        clientX, clientY,
        x: Math.max(0, Math.min(canvas.width - 1, Math.round(((clientX - contentLeft) / contentWidth) * canvas.width))),
        y: Math.max(0, Math.min(canvas.height - 1, Math.round(((clientY - contentTop) / contentHeight) * canvas.height))),
    };
}
function clickRemotePoint(point) {
    if (!point || !client?._sendMessage) return;
    client._sendMessage({ type: 'mouse', action: 'move', x: point.x, y: point.y });
    client._sendMessage({ type: 'mouse', action: 'down', x: point.x, y: point.y, button: 0 });
    setTimeout(() => client?._sendMessage?.({ type: 'mouse', action: 'up', x: point.x, y: point.y, button: 0 }), 30);
}
function stageRdpClipboardFiles(files, source = '本地') {
    pendingRdpClipboardFiles = Array.from(files || []).filter(Boolean);
    if (pendingRdpClipboardFiles.length) {
        setFilesHint(`${source}已复制 ${pendingRdpClipboardFiles.length} 个文件；真正粘贴到 RDP 时才会上传`, 'info');
    }
    renderPendingFiles();
    return pendingRdpClipboardFiles.length > 0;
}
function completeNativePasteAtRemoteTarget(target = null) {
    const point = target || lastRemotePointer;
    if (point) clickRemotePoint(point);
    setTimeout(() => client?.sendKeyCombo?.('Ctrl+V'), point ? 110 : 0);
}
async function pasteFilesAtRemoteTarget(target = null) {
    if (pendingRdpClipboardFiles.length) {
        const files = pendingRdpClipboardFiles;
        pendingRdpClipboardFiles = [];
        renderPendingFiles();
        return sendClipboardFiles(files, true, target || lastRemotePointer);
    }
    completeNativePasteAtRemoteTarget(target || lastRemotePointer);
    return true;
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


let displayScaleMode = 'fit';
let displayZoom = 100;
function applyDisplayScale() {
    const canvas = displayRoot?.querySelector?.('canvas.rdp-direct-canvas');
    if (!canvas) return;
    if (displayScaleMode === 'fill') {
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.objectFit = 'fill';
        displayRoot.style.overflow = 'hidden';
    } else if (displayScaleMode === 'actual') {
        canvas.style.width = `${Math.max(1, canvas.width * displayZoom / 100)}px`;
        canvas.style.height = `${Math.max(1, canvas.height * displayZoom / 100)}px`;
        canvas.style.objectFit = 'contain';
        displayRoot.style.overflow = 'auto';
    } else {
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.objectFit = 'contain';
        displayRoot.style.overflow = 'hidden';
    }
    const fitBtn = $('#fitBtn');
    if (fitBtn) fitBtn.textContent = displayScaleMode === 'fill' ? '填充' : displayScaleMode === 'actual' ? '原始' : '适应';
    const zoomValue = $('#zoomValue');
    if (zoomValue) zoomValue.textContent = `${displayZoom}%`;
}


function updateJoystickPanelScale(panel = $('#joystickPanel')) {
    const container = $('#joystickContainer');
    if (!panel || !container) return;
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
function placePanel(panel, anchor = null) {
    if (!panel) return;
    const stageRect = $('#rdpStage')?.getBoundingClientRect?.() || { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight, width: window.innerWidth, height: window.innerHeight };
    const isJoystick = panel.id === 'joystickPanel';
    const defaultW = isJoystick ? 248 : 320;
    const defaultH = isJoystick ? 220 : 260;
    const minW = isJoystick ? 150 : 260;
    const minH = isJoystick ? 140 : 220;
    const width = Math.min(Math.max(panel.offsetWidth || defaultW, minW), Math.max(minW, stageRect.width - 16));
    const height = Math.min(Math.max(panel.offsetHeight || defaultH, minH), Math.max(minH, stageRect.height - 16));
    const anchorRect = anchor?.getBoundingClientRect?.();
    const preferredLeft = anchorRect ? anchorRect.left + anchorRect.width / 2 - width / 2 : stageRect.left + 12;
    const preferredTop = anchorRect ? anchorRect.bottom + 10 : stageRect.top + 12;
    const left = Math.max(stageRect.left + 8, Math.min(stageRect.right - width - 8, preferredLeft));
    const top = Math.max(stageRect.top + 8, Math.min(stageRect.bottom - height - 8, preferredTop));
    panel.style.left = `${Math.round(left - stageRect.left)}px`;
    panel.style.top = `${Math.round(top - stageRect.top)}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    if (isJoystick) {
        sizeJoystickPanel(panel, width, height);
        panel.style.left = `${Math.round(left - stageRect.left)}px`;
        panel.style.top = `${Math.round(top - stageRect.top)}px`;
    }
}
function showPanel(panel, anchor = null) {
    if (!panel) return;
    const opening = panel.hidden || !panel.classList.contains('open');
    panel.hidden = false;
    panel.classList.add('open', 'front');
    if (opening) placePanel(panel, anchor);
}
function hidePanel(panel) {
    if (!panel) return;
    panel.classList.remove('open', 'front');
    panel.hidden = true;
}
function togglePanel(panel, anchor = null) {
    if (!panel) return;
    const isOpen = !panel.hidden && panel.classList.contains('open');
    if (isOpen) hidePanel(panel);
    else showPanel(panel, anchor);
}
function clampPanel(panel) {
    if (!panel) return;
    const parentRect = panel.parentElement?.getBoundingClientRect?.() || $('#rdpStage')?.getBoundingClientRect?.() || { width: window.innerWidth, height: window.innerHeight };
    const rect = panel.getBoundingClientRect();
    const minVisible = window.innerWidth <= 700 ? 140 : 80;
    const left = Math.min(Math.max(rect.left - parentRect.left, -rect.width + minVisible), parentRect.width - minVisible);
    const top = Math.min(Math.max(rect.top - parentRect.top, 8), parentRect.height - minVisible);
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
}
function frontPanel(panel) {
    if (!panel) return;
    document.querySelectorAll('.rdp-floating-panel').forEach((item) => item.classList.toggle('front', item === panel));
    panel.classList.add('front');
}
function applyPanelLayout(panel, layout) {
    if (!panel) return;
    const parentRect = panel.parentElement?.getBoundingClientRect?.() || $('#rdpStage')?.getBoundingClientRect?.() || { width: window.innerWidth, height: window.innerHeight };
    const compact = window.innerWidth <= 700;
    const margin = compact ? 6 : 12;
    const topbar = compact ? 38 : 52;
    let left = margin;
    let top = topbar;
    let width = parentRect.width - margin * 2;
    let height = parentRect.height - topbar - margin;
    if (layout === 'half') {
        width = parentRect.width;
        height = Math.max(panel.id === 'joystickPanel' ? 140 : 260, parentRect.height / 2);
        left = 0;
        top = parentRect.height - height;
    } else if (layout === 'left-quarter') {
        width = Math.max(panel.id === 'joystickPanel' ? 150 : 260, parentRect.width / 4);
        height = parentRect.height - topbar;
        left = 0;
        top = topbar;
    } else if (layout === 'right-quarter') {
        width = Math.max(panel.id === 'joystickPanel' ? 150 : 260, parentRect.width / 4);
        height = parentRect.height - topbar;
        left = parentRect.width - width;
        top = topbar;
    }
    panel.classList.add('layout-animating');
    window.clearTimeout(panel._layoutAnimationTimer);
    Object.assign(panel.style, { left: `${left}px`, top: `${top}px`, right: 'auto', bottom: 'auto', width: `${width}px`, height: `${height}px` });
    if (panel.id === 'joystickPanel') updateJoystickPanelScale(panel);
    frontPanel(panel);
    panel._layoutAnimationTimer = window.setTimeout(() => { panel.classList.remove('layout-animating'); clampPanel(panel); }, 480);
}
let panelLayoutMenu = null;
let panelLayoutButton = null;
let suppressNextLayoutClick = false;
function positionPanelLayoutMenu(menu, button, { collapsed = false } = {}) {
    if (!menu || !button) return;
    const rect = button.getBoundingClientRect();
    const viewport = window.visualViewport;
    const vvLeft = viewport?.offsetLeft || 0;
    const vvTop = viewport?.offsetTop || 0;
    const vvWidth = viewport?.width || window.innerWidth;
    const anchorX = rect.left + rect.width / 2;
    const finalWidth = Math.min(284, Math.max(160, vvWidth - 16));
    const finalHeight = 50;
    const finalLeft = Math.max(vvLeft + 8, Math.min(vvLeft + vvWidth - finalWidth - 8, anchorX - finalWidth / 2));
    const finalTop = Math.max(vvTop + 8, rect.top);
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
        window.setTimeout(() => { menu.classList.remove('island-animating'); menu.style.removeProperty('opacity'); }, 540);
    });
    menu.addEventListener('click', (event) => {
        const item = event.target.closest?.('[data-layout]');
        if (!item) return;
        event.preventDefault();
        event.stopPropagation();
        if (item.dataset.layout === 'close') { hidePanel(panel); closePanelLayoutMenu({ instant: true }); return; }
        applyPanelLayout(panel, item.dataset.layout);
        closePanelLayoutMenu();
    });
}
function setupFloatingPanels() {
    document.querySelectorAll('.rdp-floating-panel').forEach((panel) => {
        if (!panel.hidden) panel.classList.add('open');
        else panel.classList.remove('open', 'front');
    });
    document.querySelectorAll('[data-drag-panel]').forEach((handle) => {
        if (handle.dataset.boundDrag) return;
        handle.dataset.boundDrag = '1';
        handle.addEventListener('pointerdown', (event) => {
            const panel = document.getElementById(handle.dataset.dragPanel || '');
            if (!panel) return;
            showPanel(panel);
            event.preventDefault();
            handle.setPointerCapture?.(event.pointerId);
            const start = { x: event.clientX, y: event.clientY };
            const rect = panel.getBoundingClientRect();
            const move = (ev) => {
                const nx = Math.max(4, Math.min(window.innerWidth - 40, rect.left + ev.clientX - start.x));
                const ny = Math.max(4, Math.min(window.innerHeight - 40, rect.top + ev.clientY - start.y));
                panel.style.left = `${nx}px`; panel.style.top = `${ny}px`; panel.style.right = 'auto'; panel.style.bottom = 'auto';
            };
            const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', up, { once: true });
        });
    });

    document.querySelectorAll('[data-resize-panel]').forEach((handle) => {
        if (handle.dataset.boundResize) return;
        handle.dataset.boundResize = '1';
        handle.addEventListener('pointerdown', (event) => {
            const panel = document.getElementById(handle.dataset.resizePanel || '');
            if (!panel) return;
            showPanel(panel);
            event.preventDefault();
            handle.setPointerCapture?.(event.pointerId);
            const edge = handle.dataset.resizeEdge || 'right';
            const start = { x: event.clientX, y: event.clientY };
            const rect = panel.getBoundingClientRect();
            const move = (ev) => {
                if (panel.id === 'joystickPanel') {
                    const dx = ev.clientX - start.x;
                    const dy = ev.clientY - start.y;
                    const edgeSign = edge.includes('left') ? -1 : 1;
                    const delta = Math.abs(dx) > Math.abs(dy) ? dx * edgeSign : dy;
                    const targetW = rect.width + delta;
                    const anchorLeft = edge.includes('left') ? rect.right - Math.max(150, targetW) : rect.left;
                    sizeJoystickPanel(panel, targetW, null, anchorLeft);
                    return;
                }
                let w = rect.width;
                let h = rect.height;
                let left = rect.left;
                if (edge.includes('right')) w = rect.width + ev.clientX - start.x;
                if (edge.includes('left')) { w = rect.width - (ev.clientX - start.x); left = rect.left + (ev.clientX - start.x); }
                if (edge.includes('bottom')) h = rect.height + ev.clientY - start.y;
                w = Math.max(220, Math.min(window.innerWidth - 12, w));
                h = Math.max(180, Math.min(window.innerHeight - 12, h));
                panel.style.width = `${w}px`;
                panel.style.height = `${h}px`;
                if (edge.includes('left')) { panel.style.left = `${Math.max(4, left)}px`; panel.style.right = 'auto'; }
            };
            const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', up, { once: true });
        });
    });

    document.querySelectorAll('[data-layout-panel]').forEach((btn) => {
        if (btn.dataset.boundLayout) return;
        btn.dataset.boundLayout = '1';
        const panel = document.getElementById(btn.dataset.layoutPanel || '');
        if (!panel) return;
        btn.addEventListener('pointerdown', (event) => {
            event.preventDefault();
            event.stopPropagation();
            showPanel(panel);
            frontPanel(panel);
            btn.classList.add('pressing');
            try { btn.setPointerCapture?.(event.pointerId); } catch {}
            const startX = event.clientX;
            const startY = event.clientY;
            const startLeft = panel.offsetLeft;
            const startTop = panel.offsetTop;
            let moved = false;
            const onMove = (ev) => {
                ev.preventDefault();
                const dx = ev.clientX - startX;
                const dy = ev.clientY - startY;
                if (!moved && Math.hypot(dx, dy) > 7) { moved = true; closePanelLayoutMenu({ instant: true }); panel.classList.add('dragging'); }
                if (!moved) return;
                panel.style.left = `${startLeft + dx}px`;
                panel.style.top = `${startTop + dy}px`;
                panel.style.right = 'auto';
                panel.style.bottom = 'auto';
                clampPanel(panel);
            };
            const onUp = () => {
                panel.classList.remove('dragging');
                btn.classList.remove('pressing');
                suppressNextLayoutClick = moved;
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
                window.removeEventListener('pointercancel', onUp);
            };
            window.addEventListener('pointermove', onMove, { passive: false });
            window.addEventListener('pointerup', onUp, { once: true });
            window.addEventListener('pointercancel', onUp, { once: true });
        });
        btn.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (suppressNextLayoutClick) { suppressNextLayoutClick = false; return; }
            showPanel(panel);
            frontPanel(panel);
            if (navigator.vibrate) navigator.vibrate(8);
            if (panelLayoutMenu && panelLayoutButton === btn) closePanelLayoutMenu();
            else openPanelLayoutMenu(btn, panel);
        });
    });
    document.addEventListener('pointerdown', (event) => {
        if (panelLayoutMenu && !event.target.closest?.('.panel-layout-menu') && !event.target.closest?.('[data-layout-panel]')) closePanelLayoutMenu();
    });
    window.addEventListener('resize', () => closePanelLayoutMenu({ instant: true }));
}
function setupJoystickPanel() {
    const panel = $('#joystickPanel');
    const knob = $('#joystickKnob');
    const container = $('#joystickContainer');
    if (!panel || !knob || !container || container.dataset.boundJoystick) return;
    container.dataset.boundJoystick = '1';
    let timer = null;
    let vector = { x: 0, y: 0 };
    const stop = () => { if (timer) clearInterval(timer); timer = null; vector = { x: 0, y: 0 }; setRdpInputSuppressed(false, 220); knob.classList.add('smooth-back'); knob.style.transform = 'translate(0,0)'; setTimeout(() => knob.classList.remove('smooth-back'), 220); };
    const tick = () => {
        const canvas = displayRoot?.querySelector?.('canvas.rdp-direct-canvas');
        if (!canvas || !client?._sendMessage) return;
        if (displayRoot && (displayRoot.scrollWidth > displayRoot.clientWidth || displayRoot.scrollHeight > displayRoot.clientHeight)) {
            displayRoot.scrollLeft += vector.x * 18;
            displayRoot.scrollTop += vector.y * 18;
        } else {
            client._sendMessage({ type: 'mouse', action: 'wheel', x: Math.floor(canvas.width / 2), y: Math.floor(canvas.height / 2), deltaX: vector.x * 20, deltaY: vector.y * 20 });
        }
    };
    container.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        setRdpInputSuppressed(true);
        showPanel(panel);
        try { container.setPointerCapture?.(event.pointerId); } catch {}
        const rect = container.getBoundingClientRect();
        const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        const move = (ev) => {
            const dx = ev.clientX - center.x;
            const dy = ev.clientY - center.y;
            const len = Math.max(1, Math.hypot(dx, dy));
            const max = Math.max(24, rect.width * 0.23);
            const k = Math.min(max, len) / len;
            knob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
            vector = { x: Math.max(-1, Math.min(1, dx / max)), y: Math.max(-1, Math.min(1, dy / max)) };
            if (!timer) timer = setInterval(tick, 35);
        };
        const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            window.removeEventListener('pointercancel', up);
            stop();
        };
        move(event);
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up, { once: true });
        window.addEventListener('pointercancel', up, { once: true });
        container.addEventListener('pointerup', up, { once: true });
    });
    container.addEventListener('pointercancel', () => stop());
}

function bindControls() {
    updateQualityFpsButtons();
    applyInitialResolutionChoice();
    renderPendingFiles();
    $('#qualityBtn')?.addEventListener('click', () => cycleQuality());
    $('#fpsBtn')?.addEventListener('click', () => cycleFps());
    $('#resolutionBtn')?.addEventListener('click', () => { currentResolutionIdx = (currentResolutionIdx + 1) % resolutions.length; const res = resolutions[currentResolutionIdx]; $('#resolutionBtn').textContent = res.label; requestResolution(res); });
    $('#fitBtn')?.addEventListener('click', () => { displayScaleMode = displayScaleMode === 'fit' ? 'fill' : displayScaleMode === 'fill' ? 'actual' : 'fit'; applyDisplayScale(); });
    $('#zoomSlider')?.addEventListener('input', (event) => { displayScaleMode = 'actual'; displayZoom = Number(event.target.value) || 100; applyDisplayScale(); });
    $('#keyboardBtn')?.addEventListener('click', () => toggleMobileKeyboard());
    $('#ctrlAltDelBtn')?.addEventListener('click', () => { try { client?.sendCtrlAltDel?.(); } catch (err) { setStatus('error', err.message || String(err)); } });
    $('#reconnectBtn')?.addEventListener('click', () => connect().catch(() => {}));
    $('#disconnectBtn')?.addEventListener('click', () => disconnect(true));
    $('#clipboardBtn')?.addEventListener('click', (event) => togglePanel(clipboardPanel, event.currentTarget));
    if ($('#clipboardBtn')) $('#clipboardBtn').dataset.boundDirectToggle = '1';
    $('#rdpFilesBtn')?.addEventListener('click', (event) => togglePanel(filesPanel, event.currentTarget));
    if ($('#rdpFilesBtn')) $('#rdpFilesBtn').dataset.boundDirectToggle = '1';
    $('#clipboardReadLocalBtn')?.addEventListener('click', async () => { const text = await navigator.clipboard?.readText?.().catch(() => ''); if (clipboardText) clipboardText.value = text || ''; });
    $('#clipboardSendBtn')?.addEventListener('click', () => sendClipboardText(clipboardText?.value || '', false));
    $('#clipboardCopyRemoteBtn')?.addEventListener('click', () => navigator.clipboard?.writeText?.(remoteClipboardText?.value || '').catch(() => {}));
    $('#rdpFileSelectBtn')?.addEventListener('click', () => rdpFileInput?.click());
    rdpFileInput?.addEventListener('change', async () => {
        const files = Array.from(rdpFileInput.files || []);
        if (files.length) {
            rdpFileInput.value = '';
            stageRdpClipboardFiles(files, '本地文件');
        }
    });
    $('#rdpFileDownloadAllBtn')?.addEventListener('click', () => remoteFiles.forEach((_, i) => requestRemoteFileDownload(i)));
    $('#rdpFilePasteToRemoteBtn')?.addEventListener('click', () => pasteFilesAtRemoteTarget(lastRemotePointer));
    $('#shortcutsBtn')?.addEventListener('click', (event) => togglePanel($('#shortcutsPanel'), event.currentTarget));
    if ($('#shortcutsBtn')) $('#shortcutsBtn').dataset.boundDirectToggle = '1';
    $('#joystickBtn')?.addEventListener('click', (event) => togglePanel($('#joystickPanel'), event.currentTarget));
    if ($('#joystickBtn')) $('#joystickBtn').dataset.boundDirectToggle = '1';
    $('#shortcutsPanel')?.addEventListener('click', (event) => { const btn = event.target.closest('[data-keyseq]'); if (!btn) return; const combo = comboForKeyseq(btn.dataset.keyseq || ''); if (combo) { try { client?.sendKeyCombo?.(combo); } catch (err) { setStatus('error', err.message || String(err)); } } });
    document.addEventListener('paste', async (event) => {
        if (!connected) return;
        const files = Array.from(event.clipboardData?.files || []);
        const text = event.clipboardData?.getData?.('text/plain') || '';
        if (files.length) { event.preventDefault(); await sendClipboardFiles(files, true, lastRemotePointer); }
        else if (text && !/^(INPUT|TEXTAREA)$/i.test(event.target?.tagName || '')) { event.preventDefault(); if (clipboardText) clipboardText.value = text; sendClipboardText(text, true); }
    });
    document.addEventListener('dragover', (event) => { if (event.dataTransfer?.types?.includes?.('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } }, { passive: false });
    document.addEventListener('drop', async (event) => { const files = Array.from(event.dataTransfer?.files || []); if (files.length) { event.preventDefault(); const target = remotePointFromClient(event.clientX, event.clientY); await sendClipboardFiles(files, true, target); } }, { passive: false });
}



function startClipboardSyncLoop() {
    if (clipboardSyncTimer) return;
    clipboardSyncTimer = setInterval(() => {
        if (connected && !document.hidden) syncLocalClipboardTextToRdp('轮询');
    }, 1800);
}
function stopClipboardSyncLoop() {
    if (clipboardSyncTimer) clearInterval(clipboardSyncTimer);
    clipboardSyncTimer = null;
}
async function syncLocalClipboardTextToRdp(reason = 'auto') {
    if (!connected || !client || !navigator.clipboard?.readText) return false;
    try {
        const text = await navigator.clipboard.readText();
        if (!text || text === lastSyncedLocalClipboardText) return false;
        lastSyncedLocalClipboardText = text;
        if (clipboardText) clipboardText.value = text;
        sendClipboardText(text, false);
        setClipboardHint(`本机剪贴板已同步到 RDP（${reason}）`, 'success');
        return true;
    } catch {
        return false;
    }
}

function handleRdpToolbarDelegatedClick(event) {
    const btn = event.target?.closest?.('#clipboardBtn,#rdpFilesBtn,#shortcutsBtn,#joystickBtn');
    if (!btn || btn.dataset.boundDirectToggle === '1') return;
    const map = { clipboardBtn: clipboardPanel, rdpFilesBtn: filesPanel, shortcutsBtn: $('#shortcutsPanel'), joystickBtn: $('#joystickPanel') };
    const panel = map[btn.id];
    if (panel) {
        event.preventDefault();
        event.stopPropagation();
        togglePanel(panel, btn);
    }
}
document.addEventListener('click', handleRdpToolbarDelegatedClick, true);

function consumeIncomingSshFiles(files) {
    // SSH terminal sends files via parent postMessage; forward to RDP as native clipboard files
    return stageRdpClipboardFiles(files, 'SSH 文件');
}

async function consumeSharedFileClipboardAvailable(files = [], sourceTabId = '') {
    const list = Array.from(files || []);
    if (!list.length) return false;
    if (list.some((f) => f.dataUrl || f.data)) return consumeIncomingSshFiles(list);
    window.parent?.postMessage?.({ source: 'zephyr-terminal', type: 'shared-file-clipboard-consume', tabId: params?.tabId || tabId, files: list, sourceTabId }, '*');
    return true;
}

async function provideSharedFileClipboardData(requestId = '', files = []) {
    try {
        const out = [];
        for (const file of Array.from(files || [])) {
            if (file.dataUrl) { out.push(file); continue; }
            const index = Number.isFinite(Number(file.index)) ? Number(file.index) : -1;
            if (index >= 0) out.push(await downloadRemoteFileAsDataUrl(index));
        }
        window.parent?.postMessage?.({ source: 'zephyr-terminal', type: 'shared-file-clipboard-data', tabId: params?.tabId || tabId, requestId, files: out, error: '' }, '*');
    } catch (err) {
        window.parent?.postMessage?.({ source: 'zephyr-terminal', type: 'shared-file-clipboard-data', tabId: params?.tabId || tabId, requestId, files: [], error: err?.message || String(err || '读取 RDP 文件失败') }, '*');
    }
}

window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    const data = event.data || {};
    if (data.type === 'shared-clipboard-text' && data.text) {
        lastSyncedLocalClipboardText = String(data.text || '');
        if (clipboardText) clipboardText.value = lastSyncedLocalClipboardText;
        sendClipboardText(lastSyncedLocalClipboardText, false);
        setClipboardHint('共享剪贴板文本已同步到 RDP', 'success');
        return;
    }
    if (data.source === 'zephyr-app' && data.type === 'shared-file-clipboard-data') {
        if (data.error) { setFilesHint(data.error, 'warning'); return; }
        if (Array.isArray(data.files) && data.files.length) consumeIncomingSshFiles(data.files);
        return;
    }
    if (data.source === 'zephyr-app' && data.type === 'shared-file-clipboard-read') {
        provideSharedFileClipboardData(data.requestId || '', data.files || []);
        return;
    }
    if (data.source === 'zephyr-app' && data.type === 'shared-file-clipboard-available' && Array.isArray(data.files) && data.files.length) {
        const sameRemoteSource = data.sourceTabId && data.sourceTabId !== tabId ? '其它远程桌面' : '共享剪贴板';
        setFilesHint(`${sameRemoteSource}已复制 ${data.files.length} 个文件，正在转发到 RDP...`, 'info');
        consumeSharedFileClipboardAvailable(data.files, data.sourceTabId || '');
        return;
    }
    if (data.type === 'theme-change') applyFrameTheme(data.theme, data.appearance || {});
});

document.addEventListener('visibilitychange', () => { if (!document.hidden) { refreshFrameThemeFromStorage(); syncLocalClipboardTextToRdp('页面激活'); } });
window.addEventListener('focus', () => { refreshFrameThemeFromStorage(); syncLocalClipboardTextToRdp('窗口聚焦'); });
document.addEventListener('copy', () => setTimeout(() => syncLocalClipboardTextToRdp('复制'), 80));
document.addEventListener('pointerdown', () => syncLocalClipboardTextToRdp('点击'), { passive: true });
window.addEventListener('beforeunload', () => { try { client?.disconnect?.(); } catch {} });
let rdpBooted = false;
function bootRdpPage() {
    if (rdpBooted) return;
    rdpBooted = true;
    bindControls();
    setupFloatingPanels();
    setupJoystickPanel();
    setupMobileKeyboard();
    connect().catch((err) => setStatus('error', err?.message || String(err || 'RDP 启动失败')));
    requestParentSharedFileClipboard();
}
if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', bootRdpPage, { once: true });
else bootRdpPage();
