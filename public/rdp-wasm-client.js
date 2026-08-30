/**
 * rdp-wasm-client.js — Zephyr RDP Client powered by grdp WASM
 *
 * Architecture:
 *   Browser (Go WASM grdp) ── WebSocket ──► Node.js proxy ── TCP ──► RDP Server
 *
 * The Go WASM module handles the entire RDP protocol (bitmap decode, H.264,
 * cursor, keyboard, clipboard, audio).  The server is a dumb WS→TCP proxy.
 * Rendering uses the unified RDPGFX/classic-bitmap semantic GPU compositor
 * through Worker OffscreenCanvas by default, with page-thread GPU v2 fallback.
 */

import { applyZephyrColorScheme } from './theme-runtime.js?v=20260630-rdp-engine';
import { t, initI18n } from './i18n/runtime.js?v=20260729-ai-rdp-cert1';
import { createRdpDiagnostics } from './rdp-diagnostics.js?v=20260720-zft2';
import { computeSafeRdpSize } from './rdp-resolution-policy.js?v=20260801-rdp-motion9';
import { RdpWorkerBridge } from './rdp-worker-bridge.js?v=20260802-rdp-input-render20';
import { RdpTouchController, rdpHaptic } from './rdp-touch.js?v=20260730-rdp-ordered-surface4';
import { RdpAudioScheduler } from './rdp-audio-scheduler.js?v=20260730-rdp-ordered-surface4';
import { RdpMobileKeyboard } from './rdp-mobile-keyboard.js?v=20260802-rdp-input-render16';
import {
    setupPanelInteractions,
    toggleFloatingPanel,
    closeFloatingPanel,
    openFloatingPanel,
    bringPanelToFront,
    applyPanelLayout,
    closePanelLayoutMenu,
} from './floating-panel.js?v=20260731-panel-drag-physics4';
import { attachDesktopPanelPin } from './panel-pin.js?v=20260830-desktop-panel-pin2';
import {
    subscribeAgentEvents,
    unsubscribeAgentEvents,
    syncAgentDrives,
    detachAllDrives,
    resetAttachedDriveState,
} from './rdp-fs-provider.js?v=20260720-zft2';

const $ = (sel) => document.querySelector(sel);
const urlParams = new URLSearchParams(location.search);
const embeddedMode = urlParams.get('embed') === '1';
const tabId = urlParams.get('tabId') || '';
const boolSetting = (value) => value === true || value === 'true' || value === 1 || value === '1';
const notFalseSetting = (value) => value !== false && value !== 'false' && value !== 0 && value !== '0';

/* Notes side panel: same gating/postMessage contract as SSH/Telnet terminal.
 * Parent app.js owns notesController + mobile fullscreen exit animation. */
let notesFeatureEnabled = false;
function showNotesToast(message, type = 'info') {
    const text = String(message ?? '');
    if (!text) return;
    let host = document.getElementById('remoteNotesToastHost');
    if (!host) {
        host = document.createElement('div');
        host.id = 'remoteNotesToastHost';
        host.className = 'toast-container';
        host.setAttribute('aria-live', 'polite');
        host.style.cssText = 'position:fixed;left:50%;bottom:max(16px,env(safe-area-inset-bottom,0px));transform:translateX(-50%);z-index:12000;display:flex;flex-direction:column;gap:8px;pointer-events:none;';
        document.body.appendChild(host);
    }
    const node = document.createElement('div');
    node.className = `toast ${type === 'error' ? 'error' : type === 'success' ? 'success' : 'info'}`;
    node.textContent = text;
    host.appendChild(node);
    window.setTimeout(() => {
        try { node.remove(); } catch {}
    }, 2800);
}
function applyNotesFeatureEnabled(enabled) {
    notesFeatureEnabled = !!enabled;
    const notesBtn = document.getElementById('notesBtn');
    notesBtn?.classList.toggle('force-hidden', !notesFeatureEnabled);
    if (notesBtn) notesBtn.hidden = !notesFeatureEnabled;
}
async function loadRemoteNotesSettings() {
    try {
        const res = await fetch('/api/me/settings', { credentials: 'same-origin', cache: 'no-store' });
        if (!res.ok) return;
        const payload = await res.json();
        applyNotesFeatureEnabled(!!payload?.settings?.notes?.enabled);
    } catch (_) {
        applyNotesFeatureEnabled(false);
    }
}
applyNotesFeatureEnabled(false);


/* ─── DOM refs ─────────────────────────────────────────────────────────── */
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
const mobileKeyboardInput = $('#mobileKeyboardInput');

const filesPanel = $('#filesPanel');
const filesHint = $('#filesHint');
const rdpFileInput = $('#rdpFileInput');
const rdpFileSelectBtn = $('#rdpFileSelectBtn');

/* ─── State ────────────────────────────────────────────────────────────── */
let connected = false;
let params = loadParams();
let wasmReady = false;
let rdpManualDisconnect = false;
let rdpReconnectTimer = null;
let rdpReconnectAttempts = 0;
let rdpReconnecting = false;
/** AI-visible RDP shell phase (HTML cert dialog is not remote framebuffer). */
let rdpConnectionPhase = 'idle';
let rdpCertPhase = 'none';
let rdpCertDialogInfo = null;
let rdpCertDialogResolver = null;
let rdpCertDialogConnectionId = '';
let lastRemoteClipboard = '';
let lastSyncedLocalClipboardText = '';
let clipboardSyncTimer = null;
let statusSequence = 0;
let rdpInputSuppressed = false;
let rdpInputSuppressedUntil = 0;
let lastUserInputAt = 0;
let rdpClipboardEnabled = true;
let rdpTouchController = null;
let rdpLocationWatchId = null;
let rdpAgentDriveEventsActive = false;
let rdpAgentStorageEnabled = false;

/* Canvas & scaling — rendering and Go WASM live exclusively in the Worker. */
let rdpCanvas = null;
let rdpWorkerBridge = null;
let rdpWidth = 0;
let rdpHeight = 0;
let rdpStageResizeObserver = null;
let rdpResizeTimer = 0;
let rdpResizeInFlight = false;
let rdpResizeQueued = false;
let rdpResizeRetryCount = 0;
let rdpResizeAwaitingReset = false;
let rdpResizeRequestedSize = null;
let rdpResizeAckTimer = 0;
let rdpResizeResetTimeouts = 0;
let rdpLastResizeRequestAt = 0;
let rdpResizeCleanReconnectTimer = 0;
let rdpResizeCleanReconnectGeneration = 0;
let rdpResizeCleanReconnectPending = false;
let rdpTransitionFrame = null;
let rdpTransitionPollTimer = 0;
let rdpTransitionExpiryTimer = 0;
let rdpTransitionReadyForResize = false;
let rdpInternalRestarting = false;
let rdpInternalRestartReady = null;
let rdpInternalRestartFailure = null;
let rdpWorkerRestartPromise = null;
let rdpWorkerProbeCapabilities = null;
let rdpInputAbortController = null;
const RDP_MIN_RESIZE_INTERVAL_MS = 600;
const RDP_RESIZE_RECONNECT_SETTLE_MS = 650;
const RDP_TRANSITION_FRAME_MAX_AGE_MS = 60000;
const RDP_TRANSITION_FRAME_KEY = `zephyr_rdp_resize_transition_${tabId || 'default'}`;
const RDP_WORKER_URL = './rdp-worker.js?v=20260802-rdp-input-render20';
const RDP_WORKER_PROBE_URL = './rdp-worker-probe.js?v=20260802-rdp-input-render20';

/* fit/zoom */
const fitModes = ['adapt', 'original', 'fill'];
let fitModeIdx = 0;
let rdpScaleZoom = 1;
let zoomPanX = 0;
let zoomPanY = 0;

/* Fill mode viewport panning (0-100%) */
let fillPanX = 50; /* center */
let fillPanY = 50;

let connectWatchdogTimer = null;
let lastConnectStage = 'idle';
let lastConnectError = '';
let connectionFailureReported = false;
let activeConnectionId = '';
const CONNECT_TIMEOUT_MS = 12000;

/* Quality/FPS — kept for UI compat; WASM grdp doesn't need these */
const qualityModes = ['balanced', 'performance', 'quality'];
let qualityMode = 'balanced';
const fpsModes = [30, 45, 60, 120, 144];
let fpsValue = 30;

/* Apply connection-level quality/fps from params (set by connection editor). */
if (params.quality && qualityModes.includes(params.quality)) qualityMode = params.quality;
if (params.rdpFps && fpsModes.includes(Number(params.rdpFps))) fpsValue = Number(params.rdpFps);

/* Audio */
let audioCtx = null;
const audioScheduler = new RdpAudioScheduler();
/* Live-stream audio scheduling. Video is decoded and presented with no fixed
 * playout buffer, so the scheduler keeps a small cushion and actively drops
 * queued WebAudio nodes after a burst or media seek instead of letting stale
 * sources continue in parallel. */

function resetAudioSchedule(options = {}) {
    if (audioScheduler.context !== audioCtx) audioScheduler.setContext(audioCtx);
    else audioScheduler.reset(options);
}

/* Pointer cache */
const pointerCache = new Map();

/* ─── Diagnostics (kept for ABR compat, no HUD) ──────────────────────── */
const selectedPipeline = 'worker-gpu-v2';
const { state: rdpDiag, snapshot: snapshotRdpDiagnostics } = createRdpDiagnostics({
    pipeline: selectedPipeline,
    renderer: 'worker-gpu-v2-pending',
});
window._rdpRenderDiag = () => JSON.stringify(snapshotRdpDiagnostics());
let lastWorkerTelemetrySample = null;

/* Go WASM is instantiated only inside rdp-worker.js. */

/* ═══════════════════════════════════════════════════════════════════════
 * WASM → JS CALLBACKS (called by Go code)
 * ═══════════════════════════════════════════════════════════════════════ */

async function reportWorkerTelemetry(elapsedMs, { reason = 'scheduled' } = {}) {
    if (!rdpWorkerBridge) return null;
    const diag = await rdpWorkerBridge.call('rdpGetWorkerDiagnostics', []);
    const sampledAt = performance.now();
    const schedulerCallbacks = Number(diag.frameScheduler?.rafCallbacks || 0)
        + Number(diag.frameScheduler?.timerCallbacks || 0);
    const decodedOutputs = Number(diag.avc420Events || 0) + Number(diag.avc444Events || 0);
    const previous = lastWorkerTelemetrySample;
    const seconds = previous ? Math.max(0.001, (sampledAt - previous.sampledAt) / 1000) : 0;
    const rate = (current, prior) => seconds ? Math.max(0, (Number(current) - Number(prior || 0)) / seconds) : 0;
    const enriched = {
        ...diag,
        telemetryReason: reason,
        resolutionMode: String(params.rdpResolution || '1080p'),
        qualityMode,
        fpsValue,
        desktopWidth: rdpWidth,
        desktopHeight: rdpHeight,
        requestedWidth: rdpResizeRequestedSize?.width || 0,
        requestedHeight: rdpResizeRequestedSize?.height || 0,
        resizeAwaitingReset: rdpResizeAwaitingReset,
        schedulerTargetFps: Number(diag.frameScheduler?.targetFps || 0),
        schedulerMode: String(diag.frameScheduler?.mode || ''),
        schedulerEffectiveFps: Number(diag.frameScheduler?.effectiveFps || 0),
        schedulerIntervalMs: Number(diag.frameScheduler?.intervalMs || 0),
        schedulerCallbacks,
        schedulerCallbacksPerSecond: previous ? rate(schedulerCallbacks, previous.schedulerCallbacks) : 0,
        presentsPerSecond: previous ? rate(diag.presents, previous.presents) : 0,
        presentedFramesPerSecond: previous ? rate(diag.presentedFrames, previous.presentedFrames) : 0,
        decodedOutputsPerSecond: previous ? rate(decodedOutputs, previous.decodedOutputs) : 0,
    };
    lastWorkerTelemetrySample = {
        sampledAt,
        schedulerCallbacks,
        presents: Number(diag.presents || 0),
        presentedFrames: Number(diag.presentedFrames || 0),
        decodedOutputs,
    };
    console.info('[rdp-render-telemetry]', JSON.stringify(enriched));
    fetch('/api/rdp/telemetry', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId: activeConnectionId, elapsedMs, ...enriched }),
        keepalive: true,
    }).catch(() => {});
    return enriched;
}

/* Called by Go when RDP session is ready */
window.rdpOnReady = function () {
    /* A live RDPEDISP resize can make the server send DeactivateAll and run
     * the normal activation sequence again. Go consequently emits OnReady a
     * second time for the same transport. That is a protocol reactivation,
     * not a new login: clearing the resize state here would drop the ordered
     * ResetGraphics barrier and allow another MonitorLayout request while the
     * server is still rebuilding its desktop. */
    const isReactivation = connected;
    clearConnectWatchdog();
    connectionFailureReported = false;
    setStatus('connected', t('RDP 已连接'));
    connected = true;
    rdpConnectionPhase = 'connected';
    waitForFreshRdpFrameAfterReconnect();
    if (rdpInternalRestarting && rdpInternalRestartReady) {
        const resolveRestart = rdpInternalRestartReady;
        rdpInternalRestartReady = null;
        rdpInternalRestartFailure = null;
        resolveRestart();
    }

    if (isReactivation) {
        reportRdpEvent('reactivation-ready', {
            value: 'preserved-resize-barrier',
            resizeInFlight: rdpResizeInFlight,
            resizeQueued: rdpResizeQueued,
        });
        reportWorkerTelemetry(0, { reason: 'reactivation-ready' }).catch(() => {});
        return;
    }

    resetLiveRdpResizeState();
    scheduleLiveRdpResize({ delay: 80, resetRetry: true });
    if (rdpCertPhase === 'probing' || rdpCertPhase === 'pending') rdpCertPhase = 'none';
    rdpHaptic('connect');
    rdpReconnectAttempts = 0;
    rdpReconnecting = false;
    notifyParentStatus('connected');
    if (rdpCanvas) rdpCanvas.focus();
    if (rdpAgentStorageEnabled) syncAgentDrives({ enabled: true });
    for (const elapsedMs of [1000, 3000, 8000, 15000, 30000, 60000]) {
        setTimeout(() => reportWorkerTelemetry(elapsedMs).catch(() => {}), elapsedMs);
    }

    setTimeout(async () => {
        if (!connected || !rdpWorkerBridge) return;
        try {
            const diag = await rdpWorkerBridge.call('rdpGetWorkerDiagnostics', []);
            Object.assign(rdpDiag, {
                bitmapCalls: Number(diag.bitmapEvents || 0) + Number(diag.classicBitmaps || 0),
                h264Calls: Number(diag.avc420Events || 0) + Number(diag.avc444Events || 0),
                frames: Number(diag.presentedFrames || 0),
                presents: Number(diag.presents || 0),
                drawFails: Number(diag.drawFails || 0),
                lastDrawError: diag.lastError || '',
                worker: { ...(rdpDiag.worker || {}), ...diag },
            });
            const events = Number(diag.semanticEvents || 0);
            const protocolEntries = Object.entries(diag.protocol || {}).sort(([a], [b]) => a.localeCompare(b));
            const protocolSummary = protocolEntries.length
                ? protocolEntries.map(([name, count]) => `${name}=${count}`).join(' · ')
                : 'no-protocol-milestones';
            if (events === 0) {
                setStatus('connected', `RDP 黑屏诊断 · ${protocolSummary} · gl=${diag.glRenderer}`, { holdOverlayMs: 12000 });
            } else if (Number(diag.presents || 0) === 0) {
                setStatus('connected', `RDP 已收到 ${events} 个图形命令但 GPU 未呈现 · lastKind=${diag.lastKind} AVC=${diag.avc420Events}/${diag.avc444Events} fail=${diag.drawFails} ${diag.lastError || ''}`, { holdOverlayMs: 4500 });
            }
            console.info('[rdp-render] Worker GPU diagnostics', JSON.stringify(diag));
        } catch (error) {
            console.warn('[rdp-render] Worker diagnostics unavailable', error);
        }
    }, 3000);
};

/* The display update request is complete only when the server answers with
 * RDPGFX ResetGraphics. Keeping this acknowledgement on the semantic render
 * queue also guarantees that old-size video commands have been retired first. */
window.rdpOnGraphicsReset = function (width, height) {
    const actualWidth = Math.max(0, Math.trunc(Number(width) || 0));
    const actualHeight = Math.max(0, Math.trunc(Number(height) || 0));
    if (!actualWidth || !actualHeight) return;

    const requested = rdpResizeRequestedSize;
    window.clearTimeout(rdpResizeAckTimer);
    rdpResizeAckTimer = 0;
    rdpResizeAwaitingReset = false;
    rdpResizeRequestedSize = null;
    rdpResizeResetTimeouts = 0;
    rdpResizeRetryCount = 0;
    rdpWidth = actualWidth;
    rdpHeight = actualHeight;
    applyFitMode();
    reportRdpEvent('graphics-reset', {
        width: actualWidth,
        height: actualHeight,
        previousWidth: requested?.width || 0,
        previousHeight: requested?.height || 0,
    });
    reportWorkerTelemetry(0, { reason: 'graphics-reset' }).catch(() => {});

    const desired = computeRdpSize();
    const latestChanged = desired.width !== actualWidth || desired.height !== actualHeight;
    const serverClampedRequest = requested
        && requested.width === desired.width && requested.height === desired.height
        && (requested.width !== actualWidth || requested.height !== actualHeight);
    const shouldSendLatest = rdpResizeQueued && latestChanged && !serverClampedRequest;
    rdpResizeQueued = false;
    if (shouldSendLatest) {
        scheduleLiveRdpResize({ delay: 350 });
    } else if (requested) {
        // Windows deletes the old RDPGFX surface before ResetGraphics and, on
        // ClearCodec sessions, can resume with only sparse dirty regions even
        // after a standards-compliant SuppressOutput/RefreshRect cycle. A
        // short clean reconnect at the already-acknowledged size is the only
        // deterministic way to eliminate permanent old-layout residue. The
        // parent terminal workspace and sibling SSH sessions stay alive; only
        // this embedded RDP transport is recreated.
        reportRdpEvent('resize-clean-reconnect', { width: actualWidth, height: actualHeight });
        setStatus('connecting', t('正在应用新的远程桌面尺寸...'));
        scheduleResizeCleanReconnect(actualWidth, actualHeight);
    }
};

function reportRdpEvent(kind, detail = {}) {
    const desired = computeRdpSize();
    fetch('/api/rdp/telemetry', {
        method: 'POST', credentials: 'same-origin', keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            connectionId: activeConnectionId,
            kind,
            stage: lastConnectStage,
            resolutionMode: String(params.rdpResolution || '1080p'),
            qualityMode,
            fpsValue,
            desktopWidth: rdpWidth,
            desktopHeight: rdpHeight,
            desiredWidth: desired.width,
            desiredHeight: desired.height,
            requestedWidth: rdpResizeRequestedSize?.width || 0,
            requestedHeight: rdpResizeRequestedSize?.height || 0,
            resizeAwaitingReset: rdpResizeAwaitingReset,
            ...detail,
        }),
    }).catch(() => {});
}

/* Called by Go while establishing the RDP transport and protocol session. */
window.rdpOnStage = function (stage) {
    lastConnectStage = String(stage || 'unknown');
    console.info('[rdp-stage]', lastConnectStage);
    reportRdpEvent('stage', { value: lastConnectStage });
};

window.rdpOnProtocolMilestone = function (event) {
    console.info('[rdp-protocol]', event);
    reportRdpEvent('protocol', { value: String(event || '') });
};

/* Called by Go on error */
window.rdpOnError = function (msg) {
    const wasConnected = connected;
    connectionFailureReported = true;
    const internalRestart = rdpInternalRestarting;
    lastConnectError = String(msg || 'unknown error');
    console.warn('[rdp-wasm] error:', lastConnectError);
    reportRdpEvent('error', { value: lastConnectError });
    reportWorkerTelemetry(0, { reason: 'transport-error' }).catch(() => {});
    rdpHaptic('error');
    clearConnectWatchdog();
    resetLiveRdpResizeState();
    stopAgentDriveBridge();
    connected = false;
    rdpConnectionPhase = 'error';
    if (internalRestart) {
        const rejectRestart = rdpInternalRestartFailure;
        rdpInternalRestartReady = null;
        rdpInternalRestartFailure = null;
        cleanupAudio();
        rejectRestart?.(new Error(lastConnectError));
        return;
    }
    if (wasConnected) {
        // Keep the concrete error visible briefly, then fall into the same
        // auto-reconnect path as an unexpected close. Manual disconnect still
        // suppresses reconnect via rdpManualDisconnect.
        setStatus('error', `RDP 错误 [${lastConnectStage}]: ${lastConnectError}`);
        notifyParentStatus('error');
        cleanupAudio();
        maybeAutoReconnect({ reason: lastConnectError });
    } else {
        setStatus('error', `RDP 连接失败 [${lastConnectStage}]: ${lastConnectError}`);
        cleanupAudio();
        maybeAutoReconnect({ reason: lastConnectError });
    }
};

/* Called by Go on connection close */
window.rdpOnClose = function () {
    const internalRestart = rdpInternalRestarting;
    console.info('[rdp-wasm] connection closed', { stage: lastConnectStage, failureReported: connectionFailureReported });
    reportRdpEvent('close', { failureReported: connectionFailureReported });
    reportWorkerTelemetry(0, { reason: 'transport-close' }).catch(() => {});
    clearConnectWatchdog();
    resetLiveRdpResizeState();
    stopAgentDriveBridge();
    const wasConnected = connected;
    connected = false;
    if (rdpConnectionPhase !== 'error' && rdpCertPhase !== 'rejected') rdpConnectionPhase = 'disconnected';
    if (internalRestart) {
        cleanupAudio();
        return;
    }
    if (connectionFailureReported) {
        // rdpOnError already scheduled reconnect if appropriate.
        cleanupAudio();
        return;
    }
    if (wasConnected) {
        setStatus('disconnected', t('连接已断开'));
        notifyParentStatus('closed');
        cleanupAudio();
        maybeAutoReconnect({ reason: t('连接已断开') });
    } else if (!rdpManualDisconnect && !rdpReconnecting) {
        cleanupAudio();
        maybeAutoReconnect({ reason: t('连接中断') });
    }
};

/* Called by Go with clipboard text from remote */
window.rdpOnClipboard = function (text) {
    if (!rdpClipboardEnabled) return;
    lastRemoteClipboard = text || '';
    if (remoteClipboardText) remoteClipboardText.value = text || '';
    if (clipboardHint) {
        clipboardHint.textContent = t('已收到远程剪贴板');
        clipboardHint.dataset.level = 'success';
    }
    notifyParentSharedClipboardText(text);
    // Auto-write to system clipboard
    if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).catch(() => {});
    }
};

/* Called by Go with raw PCM audio data */
window.rdpAudioReset = function () {
    resetAudioSchedule();
};

window.rdpAudioPlay = function (sampleRate, channels, bitsPerSample, uint8Data) {
    if (!audioCtx || audioCtx.state === 'closed') return;
    const bytesPerSample = bitsPerSample >> 3;
    const numSamples = uint8Data.byteLength / (channels * bytesPerSample);
    if (numSamples === 0) return;
    const audioBuf = audioCtx.createBuffer(channels, numSamples, sampleRate);
    if (bitsPerSample === 16) {
        const int16 = new Int16Array(uint8Data.buffer, uint8Data.byteOffset, uint8Data.byteLength >> 1);
        for (let ch = 0; ch < channels; ch++) {
            const out = audioBuf.getChannelData(ch);
            for (let i = 0; i < numSamples; i++) {
                out[i] = int16[i * channels + ch] / 32768.0;
            }
        }
    } else if (bitsPerSample === 8) {
        for (let ch = 0; ch < channels; ch++) {
            const out = audioBuf.getChannelData(ch);
            for (let i = 0; i < numSamples; i++) {
                out[i] = (uint8Data[i * channels + ch] - 128) / 128.0;
            }
        }
    }
    audioScheduler.setContext(audioCtx);
    audioScheduler.schedule(audioBuf);
};

/* Called by Go with raw H.264 NAL data — each call may be a different tile */
let h264CallCount = 0;
let h264ErrorLog = [];
let h264InfoLog = [];

/* ─── Pointer callbacks/* ─── Pointer callbacks ──────────────────────────────────────────────── */
window.rdpOnPointerHide = function () {
    if (rdpCanvas) rdpCanvas.style.cursor = 'none';
};

window.rdpOnPointerCached = function (idx) {
    const css = pointerCache.get(idx);
    if (css && rdpCanvas) rdpCanvas.style.cursor = css;
};

window.rdpOnPointerUpdate = function (idx, xorBpp, hotX, hotY, w, h, andMask, xorData) {
    const css = buildCursorCss(xorBpp, hotX, hotY, w, h, andMask, xorData);
    if (!css) return;
    pointerCache.set(idx, css);
    if (rdpCanvas) rdpCanvas.style.cursor = css;
};

/* ═══════════════════════════════════════════════════════════════════════
 * CURSOR RASTERISER (from grdpwasm)
 * ═══════════════════════════════════════════════════════════════════════ */
function buildCursorCss(xorBpp, hotX, hotY, w, h, andMask, xorData) {
    if (w <= 0 || h <= 0) return null;
    const off = ('OffscreenCanvas' in window)
        ? new OffscreenCanvas(w, h)
        : Object.assign(document.createElement('canvas'), { width: w, height: h });
    const octx = off.getContext('2d');
    const img = octx.createImageData(w, h);
    const px = img.data;
    const andStride = (((w + 15) >> 4) << 1);
    const andBit = (x, y) => {
        const o = y * andStride + (x >> 3);
        if (o >= andMask.length) return 1;
        return (andMask[o] >> (7 - (x & 7))) & 1;
    };
    if (xorBpp === 1) {
        const xorStride = andStride;
        for (let y2 = 0; y2 < h; y2++) {
            for (let x2 = 0; x2 < w; x2++) {
                const a = andBit(x2, y2);
                const xo = xorStride * y2 + (x2 >> 3);
                const xb = xo < xorData.length ? (xorData[xo] >> (7 - (x2 & 7))) & 1 : 0;
                const o = (y2 * w + x2) << 2;
                if (a === 0 && xb === 0) { px[o]=0; px[o+1]=0; px[o+2]=0; px[o+3]=255; }
                else if (a === 0 && xb === 1) { px[o]=255; px[o+1]=255; px[o+2]=255; px[o+3]=255; }
                else if (a === 1 && xb === 0) { px[o]=0; px[o+1]=0; px[o+2]=0; px[o+3]=0; }
                else { px[o]=0; px[o+1]=0; px[o+2]=0; px[o+3]=255; }
            }
        }
    } else if (xorBpp === 32) {
        const stride = w * 4;
        for (let y2 = 0; y2 < h; y2++) {
            for (let x2 = 0; x2 < w; x2++) {
                const s = y2 * stride + x2 * 4;
                const o = (y2 * w + x2) << 2;
                if (s + 3 >= xorData.length) { px[o]=0; px[o+1]=0; px[o+2]=0; px[o+3]=0; continue; }
                const b = xorData[s], g = xorData[s+1], r = xorData[s+2], alpha = xorData[s+3];
                if (alpha !== 0) { px[o]=r; px[o+1]=g; px[o+2]=b; px[o+3]=alpha; }
                else if (andBit(x2, y2) === 0) { px[o]=r; px[o+1]=g; px[o+2]=b; px[o+3]=255; }
                else { px[o]=0; px[o+1]=0; px[o+2]=0; px[o+3]=0; }
            }
        }
    } else if (xorBpp === 24) {
        const stride = ((w * 3 + 1) >> 1) << 1;
        for (let y2 = 0; y2 < h; y2++) {
            for (let x2 = 0; x2 < w; x2++) {
                const s = y2 * stride + x2 * 3;
                const o = (y2 * w + x2) << 2;
                if (s + 2 >= xorData.length) { px[o]=0; px[o+1]=0; px[o+2]=0; px[o+3]=0; continue; }
                if (andBit(x2, y2) === 0) { px[o]=xorData[s+2]; px[o+1]=xorData[s+1]; px[o+2]=xorData[s]; px[o+3]=255; }
                else { px[o]=0; px[o+1]=0; px[o+2]=0; px[o+3]=0; }
            }
        }
    }
    octx.putImageData(img, 0, 0);
    let dataUrl;
    if (off instanceof HTMLCanvasElement) {
        dataUrl = off.toDataURL('image/png');
    } else {
        const tmp = document.createElement('canvas');
        tmp.width = w; tmp.height = h;
        tmp.getContext('2d').drawImage(off, 0, 0);
        dataUrl = tmp.toDataURL('image/png');
    }
    const hx = Math.max(0, Math.min(w - 1, hotX | 0));
    const hy = Math.max(0, Math.min(h - 1, hotY | 0));
    return `url("${dataUrl}") ${hx} ${hy}, default`;
}

function cleanupAudio() {
    audioScheduler.close();
    if (audioCtx) { try { audioCtx.close(); } catch {} audioCtx = null; }
}

async function getRemoteDesktopSnapshotForAi(options = {}) {
    if (!rdpWorkerBridge) return { protocol: 'RDP', tabId: params?.tabId || tabId, connected, error: t('RDP Worker 尚未就绪'), at: Date.now(), frameAt: 0 };
    try {
        const frame = await rdpWorkerBridge.call('rdpCaptureFrame', []);
        const sourceWidth = Number(frame?.width || 0);
        const sourceHeight = Number(frame?.height || 0);
        const pixels = frame?.pixels instanceof Uint8Array ? frame.pixels : new Uint8Array(frame?.pixels || []);
        if (!sourceWidth || !sourceHeight || pixels.length !== sourceWidth * sourceHeight * 4) throw new Error(t('RDP 截图像素无效'));
        const source = document.createElement('canvas');
        source.width = sourceWidth;
        source.height = sourceHeight;
        source.getContext('2d', { alpha: false }).putImageData(new ImageData(new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength), sourceWidth, sourceHeight), 0, 0);
        const maxWidth = Math.max(320, Math.min(1600, Number(options.maxWidth) || 960));
        const scale = Math.min(1, maxWidth / Math.max(1, sourceWidth));
        const width = Math.max(1, Math.round(sourceWidth * scale));
        const height = Math.max(1, Math.round(sourceHeight * scale));
        const out = document.createElement('canvas');
        out.width = width;
        out.height = height;
        const ctx = out.getContext('2d', { alpha: false });
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(source, 0, 0, width, height);
        const frameAt = Number(frame?.frameAt || Date.now());
        const captureId = [params?.tabId || tabId || 'rdp', frameAt, width, height].map((part) => String(part || 0).replace(/[^A-Za-z0-9_.-]/g, '_')).join(':');
        return {
            protocol: 'RDP',
            tabId: params?.tabId || tabId,
            connectionId: activeConnectionId || params?.connectionId || '',
            host: params?.host || '',
            port: params?.port || 3389,
            status: statusText?.textContent || '',
            title: connInfo?.textContent || '',
            connected,
            connectionPhase: rdpConnectionPhase || (connected ? 'connected' : 'idle'),
            certPhase: rdpCertPhase || 'none',
            certDialog: getRdpCertDialogStateForAi(),
            dataUrl: out.toDataURL('image/jpeg', Math.max(0.28, Math.min(0.86, Number(options.quality) || 0.55))),
            width,
            height,
            originalWidth: sourceWidth,
            originalHeight: sourceHeight,
            frameAt,
            captureId,
            at: Date.now(),
        };
    } catch (err) {
        return {
            protocol: 'RDP',
            tabId: params?.tabId || tabId,
            connectionId: activeConnectionId || params?.connectionId || '',
            connected,
            connectionPhase: rdpConnectionPhase || (connected ? 'connected' : 'error'),
            certPhase: rdpCertPhase || 'none',
            certDialog: getRdpCertDialogStateForAi(),
            error: err.message || String(err),
            at: Date.now(),
            frameAt: 0,
        };
    }
}
window.__zephyrGetRemoteDesktopSnapshot = getRemoteDesktopSnapshotForAi;
window.__zephyrGetRemoteDesktopCertState = getRdpCertDialogStateForAi;

/* ═══════════════════════════════════════════════════════════════════════
 * MICROPHONE INPUT (AUDIN) — browser getUserMedia → Go WASM → RDP server
 * ═══════════════════════════════════════════════════════════════════════ */
let audinStream = null;
let audinProcessor = null;
let audinContext = null;
let audinWorkletReady = false;

/* AudioWorklet processor code - runs on a dedicated audio thread.
 * Converts Float32 samples to Int16 PCM and posts them to the main thread. */
const AUDIN_WORKLET_CODE = `
class AudinProcessor extends AudioWorkletProcessor {
    process(inputs) {
        const input = inputs[0];
        if (!input || !input[0] || input[0].length === 0) return true;
        const ch0 = input[0];
        const pcm = new Int16Array(ch0.length);
        for (let i = 0; i < ch0.length; i++) {
            const s = Math.max(-1, Math.min(1, ch0[i]));
            pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        this.port.postMessage(pcm);
        return true;
    }
}
registerProcessor('audin-processor', AudinProcessor);
`;

/* Called from Go WASM when the server requests microphone capture */
window.rdpAudinStart = function (sampleRate, channels, bitsPerSample, framesPerPacket) {
    console.info('[rdp-audin] start', { sampleRate, channels, bitsPerSample, framesPerPacket });
    rdpAudinStopInternal();
    const bufferSize = Math.max(256, Math.min(16384, framesPerPacket || 4096));
    navigator.mediaDevices.getUserMedia({ audio: { sampleRate, channelCount: channels, echoCancellation: true, noiseSuppression: true } })
        .then(async (stream) => {
            audinStream = stream;
            audinContext = new AudioContext({ sampleRate, latencyHint: 'interactive' });
            const source = audinContext.createMediaStreamSource(stream);

            let useWorklet = false;
            if (audinContext.audioWorklet && !audinWorkletReady) {
                try {
                    const blob = new Blob([AUDIN_WORKLET_CODE], { type: 'application/javascript' });
                    const url = URL.createObjectURL(blob);
                    await audinContext.audioWorklet.addModule(url);
                    URL.revokeObjectURL(url);
                    audinWorkletReady = true;
                    useWorklet = true;
                } catch (err) {
                    console.warn('[rdp-audin] AudioWorklet init failed, falling back to ScriptProcessor:', err.message);
                }
            } else if (audinWorkletReady) {
                useWorklet = true;
            }

            if (useWorklet) {
                audinProcessor = new AudioWorkletNode(audinContext, 'audin-processor', {
                    numberOfInputs: 1,
                    numberOfOutputs: 1,
                    outputChannelCount: [channels],
                });
                audinProcessor.port.onmessage = (e) => {
                    if (typeof rdpAudinData === 'undefined') return;
                    const pcm = e.data;
                    const uint8 = new Uint8Array(pcm.buffer);
                    rdpAudinData(uint8);
                };
                source.connect(audinProcessor);
                audinProcessor.connect(audinContext.destination);
                console.info('[rdp-audin] AudioWorklet capture started', { sampleRate: audinContext.sampleRate });
            } else {
                audinProcessor = audinContext.createScriptProcessor(bufferSize, channels, channels);
                audinProcessor.onaudioprocess = (e) => {
                    if (typeof rdpAudinData === 'undefined') return;
                    const ch0 = e.inputBuffer.getChannelData(0);
                    const pcm = new Int16Array(ch0.length);
                    for (let i = 0; i < ch0.length; i++) {
                        const s = Math.max(-1, Math.min(1, ch0[i]));
                        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                    }
                    const uint8 = new Uint8Array(pcm.buffer);
                    rdpAudinData(uint8);
                };
                source.connect(audinProcessor);
                audinProcessor.connect(audinContext.destination);
                console.info('[rdp-audin] ScriptProcessor fallback capture started', { sampleRate: audinContext.sampleRate, bufferSize });
            }
        })
        .catch((err) => {
            console.warn('[rdp-audin] getUserMedia failed:', err.message);
        });
};

/* Called from Go WASM when microphone should stop */
window.rdpAudinStop = function () {
    rdpAudinStopInternal();
};

function rdpAudinStopInternal() {
    if (audinProcessor) { try { audinProcessor.disconnect(); } catch {} audinProcessor = null; }
    if (audinContext) { try { audinContext.close(); } catch {} audinContext = null; }
    if (audinStream) { audinStream.getTracks().forEach((t) => t.stop()); audinStream = null; }
}

/* ═══════════════════════════════════════════════════════════════════════
 * LOCATION REDIRECTION (RDPEL) — browser Geolocation → Go WASM → RDP server
 * ═══════════════════════════════════════════════════════════════════════ */

/* Called from Go WASM when the server requests location data */
window.rdpLocationStart = function () {
    console.info('[rdp-location] start');
    rdpLocationStopInternal();
    if (!navigator.geolocation) {
        console.warn('[rdp-location] Geolocation API not available');
        return;
    }
    rdpLocationWatchId = navigator.geolocation.watchPosition(
        (pos) => {
            if (typeof rdpLocationData === 'undefined') return;
            const c = pos.coords;
            rdpLocationData(
                c.latitude, c.longitude,
                c.altitude != null ? c.altitude : null,
                c.accuracy || 0,
                c.speed != null ? c.speed : null,
                c.heading != null ? c.heading : null,
            );
        },
        (err) => { console.warn('[rdp-location] error:', err.message); },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 },
    );
};

window.rdpLocationStop = function () { rdpLocationStopInternal(); };

function rdpLocationStopInternal() {
    if (rdpLocationWatchId != null) {
        navigator.geolocation?.clearWatch(rdpLocationWatchId);
        rdpLocationWatchId = null;
    }
}

/* ═══════════════════════════════════════════════════════════════════════
 * STORAGE REDIRECTION (RDPEFS) — browser File System Access → RDP drive
 * ═══════════════════════════════════════════════════════════════════════ */
let rdpStorageFiles = []; // { name, size, isDir, handle }

/* Called from Go WASM to get the list of shared files */
window.rdpStorageGetFiles = function () {
    return rdpStorageFiles.map((f) => ({ name: f.name, size: f.size, isDir: f.isDir }));
};

/* Called from Go WASM to read a file's contents by name */
window.rdpStorageReadFile = function (name) {
    const entry = rdpStorageFiles.find((f) => f.name === name);
    if (!entry || !entry.data) return null;
    return new Uint8Array(entry.data);
};

/*
 * Zephyr One only: load the folder mapped in RDP settings.
 *
 * Browser Zephyr cannot do this. showDirectoryPicker() hands back an opaque
 * handle, never a path, so there is nothing to mount and the endpoint below is
 * not mounted either — a 404 here simply means "not running inside One" and is
 * not an error worth showing.
 *
 * The engine's redirection path (rdpStorageGetFiles / rdpStorageReadFile, fed
 * through bridge.setLocalFiles) takes a flat list of files held in memory, so
 * this reads the mapped folder's top level and nothing deeper. Sub-directories
 * are reported by the core with isDir and are deliberately not descended: a
 * live directory tree needs the in-process native engine, which is not built.
 *
 * Called from connect() before the session negotiates, so the list is already
 * in the Worker when Windows first asks for it. Advertising is left to the
 * normal connect handshake — notify=true here would announce a drive to a
 * session that does not exist yet.
 *
 * @param {string} connectionId
 * @returns {Promise<{count:number, truncated:boolean, deviceName:string}|null>}
 *   null when there is no mapping, or when not running inside One.
 */
async function loadOneMappedFolder(connectionId) {
    if (!connectionId) return null;
    let listing;
    try {
        const resp = await fetch(
            '/api/one/rdp/storage-files/' + encodeURIComponent(connectionId),
            { credentials: 'same-origin' },
        );
        if (!resp.ok) return null;
        listing = await resp.json();
    } catch {
        return null;
    }
    if (!listing || !listing.ok || listing.configured !== true) return null;

    const shareable = (listing.files || []).filter((f) => f && !f.isDir);
    const loaded = [];
    for (const entry of shareable) {
        try {
            const resp = await fetch(
                '/api/one/rdp/storage-file/' + encodeURIComponent(connectionId)
                + '?name=' + encodeURIComponent(entry.name),
                { credentials: 'same-origin' },
            );
            if (!resp.ok) continue;
            const data = new Uint8Array(await resp.arrayBuffer());
            loaded.push({ name: entry.name, size: data.byteLength, isDir: false, data });
        } catch {
            /* One unreadable file must not cost the whole share. */
        }
    }

    /* Replace rather than append: this runs once per connect, and appending
     * would duplicate every file across an in-place worker restart. */
    rdpStorageFiles = loaded;
    if (rdpWorkerBridge) {
        try {
            await rdpWorkerBridge.setLocalFiles(rdpStorageFiles, { notify: false });
        } catch (err) {
            console.warn('[one-rdp] setLocalFiles failed', err);
        }
    }
    console.info('[one-rdp] mapped folder shared:', listing.folderLabel || 'Selected folder',
        loaded.length + '/' + shareable.length, 'files',
        listing.truncated ? '(truncated)' : '');
    return {
        count: loaded.length,
        truncated: !!listing.truncated,
        deviceName: String(listing.deviceName || ''),
    };
}
/* Allow user to pick files to share with the remote desktop */
async function rdpStoragePickFiles() {
    try {
        if (window.showOpenFilePicker) {
            const handles = await window.showOpenFilePicker({ multiple: true });
            for (const handle of handles) {
                const file = await handle.getFile();
                const data = new Uint8Array(await file.arrayBuffer());
                rdpStorageFiles.push({ name: file.name, size: file.size, isDir: false, data, handle });
            }
        } else {
            /* Fallback: use <input type="file"> */
            const input = document.createElement('input');
            input.type = 'file';
            input.multiple = true;
            input.style.display = 'none';
            document.body.appendChild(input);
            await new Promise((resolve) => {
                input.onchange = async () => {
                    for (const file of input.files) {
                        const data = new Uint8Array(await file.arrayBuffer());
                        rdpStorageFiles.push({ name: file.name, size: file.size, isDir: false, data });
                    }
                    resolve();
                };
                input.click();
            });
            input.remove();
        }
        if (rdpWorkerBridge) {
            await rdpWorkerBridge.setLocalFiles(rdpStorageFiles, { notify: connected });
        }
        console.info('[rdp-storage] files shared:', rdpStorageFiles.length);
    } catch (err) {
        console.warn('[rdp-storage] file pick cancelled or failed:', err.message);
    }
}

/* ═══════════════════════════════════════════════════════════════════════
 * CAMERA REDIRECTION (MS-RDPECAM) — browser getUserMedia → H.264 → RDP
 * ═══════════════════════════════════════════════════════════════════════ */
let camStream = null;
let camEncoder = null;
let camFrameReader = null;
let camAnimFrame = null;
let camVideo = null;
let camCanvas = null;
let camCanvasCtx = null;

/* Called from Go WASM when the server requests camera streaming */
window.rdpCameraStart = function (width, height, fps) {
    console.info('[rdp-camera] start', { width, height, fps });
    rdpCameraStopInternal();

    navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: fps } }
    }).then((stream) => {
        camStream = stream;
        const track = stream.getVideoTracks()[0];
        const settings = track.getSettings();
        const w = settings.width || width;
        const h = settings.height || height;

        /* Check WebCodecs VideoEncoder availability */
        if (typeof VideoEncoder !== 'undefined') {
            /* Use WebCodecs H.264 encoder */
            let frameCount = 0;
            camEncoder = new VideoEncoder({
                output(chunk, metadata) {
                    const buf = new Uint8Array(chunk.byteLength);
                    chunk.copyTo(buf);
                    const isKey = chunk.type === 'key';
                    if (typeof rdpCameraFrame !== 'undefined') {
                        rdpCameraFrame(buf, isKey);
                    }
                },
                error(e) { console.warn('[rdp-camera] encoder error:', e); },
            });
            camEncoder.configure({
                codec: 'avc1.42E01E', // H.264 Baseline
                width: w,
                height: h,
                bitrate: 2_000_000,
                framerate: fps || 30,
                latencyMode: 'realtime',
                avc: { format: 'annexb' },
            });

            /* Create hidden video element + canvas for frame extraction */
            camVideo = document.createElement('video');
            camVideo.srcObject = stream;
            camVideo.muted = true;
            camVideo.playsInline = true;
            camVideo.play();

            camCanvas = new OffscreenCanvas(w, h);
            camCanvasCtx = camCanvas.getContext('2d');

            const interval = 1000 / (fps || 30);
            let lastFrameTime = 0;
            const captureFrame = (now) => {
                if (!camStream || !camEncoder || camEncoder.state === 'closed') return;
                camAnimFrame = requestAnimationFrame(captureFrame);
                if (now - lastFrameTime < interval * 0.9) return;
                lastFrameTime = now;

                camCanvasCtx.drawImage(camVideo, 0, 0, w, h);
                const frame = new VideoFrame(camCanvas, { timestamp: frameCount * interval * 1000 });
                frameCount++;
                const keyFrame = frameCount % (fps * 2 || 60) === 1; // keyframe every 2 seconds
                try {
                    camEncoder.encode(frame, { keyFrame });
                } catch (e) {
                    console.warn('[rdp-camera] encode error:', e);
                }
                frame.close();
            };
            camAnimFrame = requestAnimationFrame(captureFrame);
            console.info('[rdp-camera] WebCodecs H.264 encoding started', { w, h, fps });
        } else {
            console.warn('[rdp-camera] WebCodecs VideoEncoder not available');
        }
    }).catch((err) => {
        console.warn('[rdp-camera] getUserMedia failed:', err.message);
    });
};

/* Called from Go WASM when camera should stop */
window.rdpCameraStop = function () { rdpCameraStopInternal(); };

function rdpCameraStopInternal() {
    if (camAnimFrame) { cancelAnimationFrame(camAnimFrame); camAnimFrame = null; }
    if (camEncoder) { try { camEncoder.close(); } catch {} camEncoder = null; }
    if (camVideo) { camVideo.pause(); camVideo.srcObject = null; camVideo = null; }
    if (camStream) { camStream.getTracks().forEach((t) => t.stop()); camStream = null; }
    camCanvas = null;
    camCanvasCtx = null;
}

/* ═══════════════════════════════════════════════════════════════════════
 * CERTIFICATE VERIFICATION DIALOG
 * ═══════════════════════════════════════════════════════════════════════ */

function isCertTrusted(connectionId) {
    try {
        const trusted = JSON.parse(localStorage.getItem('zephyr-rdp-trusted-certs') || '{}');
        return !!trusted[connectionId];
    } catch { return false; }
}

function trustCert(connectionId) {
    try {
        const trusted = JSON.parse(localStorage.getItem('zephyr-rdp-trusted-certs') || '{}');
        trusted[connectionId] = Date.now();
        localStorage.setItem('zephyr-rdp-trusted-certs', JSON.stringify(trusted));
    } catch {}
}

function getRdpCertDialogStateForAi() {
    const info = rdpCertDialogInfo || {};
    return {
        protocol: 'RDP',
        tabId: params?.tabId || tabId || '',
        connectionId: rdpCertDialogConnectionId || activeConnectionId || params?.connectionId || '',
        connectionPhase: rdpConnectionPhase || (connected ? 'connected' : 'idle'),
        certPhase: rdpCertPhase || 'none',
        pending: rdpCertPhase === 'pending',
        trusted: rdpCertPhase === 'trusted' || rdpCertPhase === 'accepted' || (!!rdpCertDialogConnectionId && isCertTrusted(rdpCertDialogConnectionId)),
        connected: !!connected,
        status: statusText?.textContent || '',
        host: info.host || params?.host || '',
        port: Number(info.port || params?.port || 3389) || 3389,
        subject: info.subject || '',
        issuer: info.issuer || '',
        fingerprint: info.fingerprint || '',
        validFrom: info.validFrom || '',
        validTo: info.validTo || '',
        authorized: info.authorized === true,
        reasons: Array.isArray(info.reasons) ? info.reasons.slice(0, 12) : [],
        at: Date.now(),
    };
}

function settleCertDialog(accepted, { remember = false, source = 'ui' } = {}) {
    const dialog = document.getElementById('rdpCertDialog');
    const rememberEl = document.getElementById('certRemember');
    if (rememberEl && source === 'ai' && remember) rememberEl.checked = true;
    if (accepted && (remember || rememberEl?.checked) && rdpCertDialogConnectionId) {
        trustCert(rdpCertDialogConnectionId);
        rdpCertPhase = 'trusted';
    } else if (accepted) {
        rdpCertPhase = 'accepted';
    } else {
        rdpCertPhase = 'rejected';
    }
    rdpConnectionPhase = accepted ? 'connecting' : 'disconnected';
    dialog?.classList.remove('visible');
    const resolver = rdpCertDialogResolver;
    rdpCertDialogResolver = null;
    if (typeof resolver === 'function') resolver(!!accepted);
    return getRdpCertDialogStateForAi();
}

function decideCertDialogFromAi(args = {}) {
    if (rdpCertPhase !== 'pending' || typeof rdpCertDialogResolver !== 'function') {
        const error = new Error(t('当前没有待决策的 RDP 证书对话框'));
        error.code = 'cert_dialog_not_pending';
        throw error;
    }
    const expected = String(args.expectedFingerprint || '').trim();
    if (expected && rdpCertDialogInfo?.fingerprint && expected !== String(rdpCertDialogInfo.fingerprint)) {
        const error = new Error(t('证书 fingerprint 与 expectedFingerprint 不一致'));
        error.code = 'cert_fingerprint_mismatch';
        throw error;
    }
    const decision = String(args.decision || '') === 'reject' ? 'reject' : 'accept';
    return settleCertDialog(decision === 'accept', { remember: args.remember === true, source: 'ai' });
}

function showCertDialog(certInfo, connectionId) {
    return new Promise((resolve) => {
        const dialog = document.getElementById('rdpCertDialog');
        if (!dialog) {
            rdpCertPhase = 'none';
            rdpConnectionPhase = 'connecting';
            resolve(true);
            return;
        }

        rdpCertDialogInfo = {
            host: certInfo.host || params?.host || '',
            port: certInfo.port || params?.port || 3389,
            subject: certInfo.subject || certInfo.host || '',
            issuer: certInfo.issuer || '',
            fingerprint: certInfo.fingerprint || '',
            validFrom: certInfo.validFrom || '',
            validTo: certInfo.validTo || '',
            authorized: certInfo.authorized === true,
            hasCert: certInfo.hasCert !== false,
            reasons: Array.isArray(certInfo.reasons) && certInfo.reasons.length
                ? certInfo.reasons
                : [t('不是来自受信任的认证机构')],
        };
        rdpCertDialogConnectionId = String(connectionId || params?.connectionId || '');
        rdpCertPhase = 'pending';
        rdpConnectionPhase = 'cert_pending';
        rdpCertDialogResolver = resolve;

        const hostEl = document.getElementById('certHost');
        const subjectEl = document.getElementById('certSubject');
        const reasonsEl = document.getElementById('certReasons');
        const rememberEl = document.getElementById('certRemember');

        if (hostEl) hostEl.textContent = (rdpCertDialogInfo.host || '') + ':' + (rdpCertDialogInfo.port || 3389);
        if (subjectEl) subjectEl.textContent = rdpCertDialogInfo.subject || rdpCertDialogInfo.host || t('(未知)');
        if (reasonsEl) {
            reasonsEl.innerHTML = rdpCertDialogInfo.reasons.map((r) => '<li>' + escapeHtml(r) + '</li>').join('');
        }
        if (rememberEl) rememberEl.checked = false;

        dialog.classList.add('visible');

        const actionsDiv = dialog.querySelector('.rdp-cert-actions');
        if (!actionsDiv) {
            rdpCertPhase = 'none';
            rdpConnectionPhase = 'connecting';
            rdpCertDialogResolver = null;
            resolve(true);
            return;
        }
        actionsDiv.innerHTML = `<button class="rdp-cert-btn rdp-cert-btn-cancel" id="certCancelBtn">${t('取消')}</button><button class="rdp-cert-btn rdp-cert-btn-connect" id="certConnectBtn">${t('连接')}</button>`;
        const cancelBtn = document.getElementById('certCancelBtn');
        const connectBtn = document.getElementById('certConnectBtn');

        cancelBtn.onclick = () => {
            if (rdpCertPhase !== 'pending') return;
            settleCertDialog(false, { source: 'ui' });
        };
        connectBtn.onclick = () => {
            if (rdpCertPhase !== 'pending') return;
            settleCertDialog(true, { remember: !!rememberEl?.checked, source: 'ui' });
        };
    });
}

/* ═══════════════════════════════════════════════════════════════════════
 * CONNECT / DISCONNECT
 * ═══════════════════════════════════════════════════════════════════════ */
function proxyWsUrl() {
    return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
}

function clearConnectWatchdog() {
    if (connectWatchdogTimer) {
        clearTimeout(connectWatchdogTimer);
        connectWatchdogTimer = null;
    }
}

function startConnectWatchdog() {
    clearConnectWatchdog();
    connectWatchdogTimer = setTimeout(() => {
        connectWatchdogTimer = null;
        if (connected || rdpManualDisconnect) return;
        console.warn('[rdp-wasm] connect watchdog timeout', { stage: lastConnectStage, error: lastConnectError });
        setStatus('error', `RDP 连接超时 [${lastConnectStage}]${lastConnectError ? `: ${lastConnectError}` : ''}`);
        try { rdpDisconnect(); } catch {}
        cleanupAudio();
    }, CONNECT_TIMEOUT_MS);
}

function startAgentDriveBridge() {
    if (rdpAgentDriveEventsActive) {
        syncAgentDrives({ enabled: true });
        return;
    }
    rdpAgentDriveEventsActive = true;
    subscribeAgentEvents((agents) => {
        console.info('[rdp-fs] online agents:', Array.isArray(agents) ? agents.length : 0);
        syncAgentDrives({ enabled: rdpAgentStorageEnabled });
    });
    syncAgentDrives({ enabled: true });
}

function stopAgentDriveBridge() {
    if (rdpAgentDriveEventsActive) {
        unsubscribeAgentEvents();
        rdpAgentDriveEventsActive = false;
    }
    try { detachAllDrives(); } catch {}
    resetAttachedDriveState();
}

function persistSessionParams(patch = {}) {
    params = { ...params, ...patch };
    const key = tabId ? `zephyr_remote_desktop_params_${tabId}` : 'zephyr_remote_desktop_params';
    try {
        const prev = JSON.parse(sessionStorage.getItem(key) || '{}') || {};
        sessionStorage.setItem(key, JSON.stringify({ ...prev, ...params, timestamp: Date.now() }));
    } catch {}
    // Best-effort: also update the saved connection on the server so the next
    // open (not just this tab reload) keeps the chosen density/quality/fps.
    const connectionId = params.connectionId || urlParams.get('connectionId') || '';
    if (!connectionId) return;
    const body = {};
    if (params.rdpResolution) body.rdpResolution = params.rdpResolution;
    if (params.quality) body.rdpQuality = params.quality;
    if (params.rdpFps) body.rdpFps = Number(params.rdpFps);
    if (!Object.keys(body).length) return;
    fetch(`/api/connections/${encodeURIComponent(connectionId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
    }).catch((err) => console.warn('[rdp] persist settings failed', err));
}

function dismissRdpTransitionFrame({ immediate = false, keepStored = false } = {}) {
    window.clearTimeout(rdpTransitionPollTimer);
    window.clearTimeout(rdpTransitionExpiryTimer);
    rdpTransitionPollTimer = 0;
    rdpTransitionExpiryTimer = 0;
    const frame = rdpTransitionFrame;
    if (!frame) return;
    rdpTransitionFrame = null;
    rdpTransitionReadyForResize = false;
    if (!keepStored) {
        try { sessionStorage.removeItem(RDP_TRANSITION_FRAME_KEY); } catch {}
    }
    if (immediate) {
        frame.remove();
        return;
    }
    frame.classList.add('is-dismissing');
    window.setTimeout(() => frame.remove(), 180);
}

function restoreRdpResizeTransitionFrame() {
    let saved = null;
    try {
        saved = JSON.parse(sessionStorage.getItem(RDP_TRANSITION_FRAME_KEY) || 'null');
    } catch {
        try { sessionStorage.removeItem(RDP_TRANSITION_FRAME_KEY); } catch {}
    }
    const age = Date.now() - Number(saved?.createdAt || 0);
    const dataUrl = String(saved?.dataUrl || '');
    if (!displayShell || age < 0 || age > RDP_TRANSITION_FRAME_MAX_AGE_MS || !dataUrl.startsWith('data:image/')) return;
    const frame = document.createElement('img');
    frame.className = 'rdp-resize-transition-frame';
    frame.alt = '';
    frame.setAttribute('aria-hidden', 'true');
    frame.decoding = 'async';
    frame.src = dataUrl;
    frame.addEventListener('error', () => dismissRdpTransitionFrame({ immediate: true }), { once: true });
    displayShell.appendChild(frame);
    rdpTransitionFrame = frame;
    rdpTransitionReadyForResize = false;
    rdpTransitionExpiryTimer = window.setTimeout(
        () => dismissRdpTransitionFrame(),
        Math.max(1000, RDP_TRANSITION_FRAME_MAX_AGE_MS - age),
    );
}

async function showRdpResizeTransitionFrame() {
    if (rdpTransitionFrame) return true;
    if (!rdpWorkerBridge || !connected) return false;
    try {
        // Capture before MonitorLayout mutates the remote surface. Capturing
        // after ResetGraphics can already contain ClearCodec's sparse/old-size
        // residue, which is exactly the broken frame this overlay must hide.
        const snapshot = await getRemoteDesktopSnapshotForAi({ maxWidth: 1280, quality: 0.76 });
        const dataUrl = String(snapshot?.dataUrl || '');
        if (!dataUrl.startsWith('data:image/')) return false;

        const frame = document.createElement('img');
        frame.className = 'rdp-resize-transition-frame';
        frame.alt = '';
        frame.setAttribute('aria-hidden', 'true');
        frame.decoding = 'async';
        frame.src = dataUrl;
        try { await frame.decode(); } catch {
            if (!frame.complete || !frame.naturalWidth) return false;
        }
        if (rdpTransitionFrame) return true;
        displayShell?.appendChild(frame);
        rdpTransitionFrame = frame;
        rdpTransitionReadyForResize = true;
        window.clearTimeout(rdpTransitionExpiryTimer);
        rdpTransitionExpiryTimer = window.setTimeout(
            () => dismissRdpTransitionFrame(),
            RDP_TRANSITION_FRAME_MAX_AGE_MS,
        );
        try { sessionStorage.removeItem(RDP_TRANSITION_FRAME_KEY); } catch {}
        // Ensure the complete old frame is composited before the server is
        // allowed to begin deleting/replacing its old-size graphics surface.
        await new Promise((resolve) => requestAnimationFrame(() => resolve()));
        return true;
    } catch (error) {
        console.warn('[rdp-resize] could not preserve transition frame', error?.message || error);
        return false;
    }
}

function waitForFreshRdpFrameAfterReconnect() {
    if (!rdpTransitionFrame) return;
    window.clearTimeout(rdpTransitionPollTimer);
    const poll = async () => {
        if (!rdpTransitionFrame) return;
        if (!connected || !rdpWorkerBridge) {
            rdpTransitionPollTimer = window.setTimeout(poll, 180);
            return;
        }
        try {
            const diag = await rdpWorkerBridge.call('rdpGetWorkerDiagnostics', []);
            const meaningfulUpdates = Number(diag.classicBitmaps || 0)
                + Number(diag.bitmapEvents || 0)
                + Number(diag.avc420Events || 0)
                + Number(diag.avc444Events || 0);
            if (Number(diag.presents || 0) >= 6 && meaningfulUpdates >= 100) {
                rdpTransitionReadyForResize = true;
                const desired = computeRdpSize();
                const geometryChanged = desired.width !== rdpWidth || desired.height !== rdpHeight;
                if (geometryChanged && !rdpResizeAwaitingReset && !rdpResizeCleanReconnectPending) {
                    rdpResizeQueued = false;
                    scheduleLiveRdpResize({ delay: 0 });
                    rdpTransitionPollTimer = window.setTimeout(poll, 180);
                    return;
                }
                if (!geometryChanged && !rdpResizeAwaitingReset && !rdpResizeCleanReconnectPending) {
                    dismissRdpTransitionFrame();
                    return;
                }
            }
            if (rdpTransitionReadyForResize && rdpResizeCleanReconnectPending) {
                // Keep the original good frame visible through the entire
                // chained resize/reload sequence. It must not be replaced by
                // a sparse or black ResetGraphics transition surface.
                rdpTransitionPollTimer = window.setTimeout(poll, 180);
                return;
            }
        } catch {}
        rdpTransitionPollTimer = window.setTimeout(poll, 180);
    };
    poll();
}

function assertWorkerGpuAvailable() {
    const missing = [];
    if (!globalThis.isSecureContext) missing.push('INSECURE_CONTEXT');
    if (typeof Worker === 'undefined') missing.push('MODULE_WORKER_UNAVAILABLE');
    if (typeof rdpCanvas?.transferControlToOffscreen !== 'function') missing.push('OFFSCREEN_CANVAS_TRANSFER_UNAVAILABLE');
    if (missing.length) throw new Error(`WORKER_GPU_REQUIRED:${missing.join('+')}`);
}

async function ensureRdpWorkerProbe() {
    if (!rdpWorkerProbeCapabilities) {
        rdpWorkerProbeCapabilities = await RdpWorkerBridge.probe({ url: RDP_WORKER_PROBE_URL });
    }
    rdpDiag.workerProbe = rdpWorkerProbeCapabilities;
    if (!rdpWorkerProbeCapabilities.supported) {
        throw new Error(`WORKER_GPU_PROBE_FAILED:${rdpWorkerProbeCapabilities.reason || 'unknown'}:${rdpWorkerProbeCapabilities.stage || 'unknown'}:${rdpWorkerProbeCapabilities.error || ''}`);
    }
    return rdpWorkerProbeCapabilities;
}

async function initializeRdpWorker() {
    assertWorkerGpuAvailable();
    await ensureRdpWorkerProbe();
    const bridge = new RdpWorkerBridge(new Worker(RDP_WORKER_URL, { type: 'module' }));
    rdpWorkerBridge = bridge;
    bridge.installGlobals(window);
    try {
        await bridge.setLocalFiles(rdpStorageFiles, { notify: false });
        const capabilities = await bridge.init(rdpCanvas, { width: rdpWidth, height: rdpHeight });
        wasmReady = true;
        rdpDiag.renderer = 'worker-gpu-v2';
        rdpDiag.worker = capabilities;
        return capabilities;
    } catch (error) {
        const failedStage = bridge.bootStage || 'pre-worker';
        try { bridge.close(); } catch {}
        if (rdpWorkerBridge === bridge) rdpWorkerBridge = null;
        wasmReady = false;
        error.rdpBootStage = failedStage;
        throw error;
    }
}

async function restartRdpWorkerInPlace(width, height, { reason = 'reconnect' } = {}) {
    if (rdpWorkerRestartPromise) return rdpWorkerRestartPromise;
    const targetWidth = Math.max(64, Math.trunc(Number(width) || rdpWidth || 1920));
    const targetHeight = Math.max(64, Math.trunc(Number(height) || rdpHeight || 1080));
    rdpWorkerRestartPromise = (async () => {
        const oldBridge = rdpWorkerBridge;
        rdpInternalRestarting = true;
        rdpTransitionReadyForResize = false;
        clearConnectWatchdog();
        if (rdpReconnectTimer) { clearTimeout(rdpReconnectTimer); rdpReconnectTimer = null; }
        rdpReconnecting = false;
        rdpManualDisconnect = false;
        oldBridge?.input?.releaseAll();
        try { oldBridge?.notify('rdpDisconnect', []); } catch {}
        stopAgentDriveBridge();
        connected = false;
        rdpConnectionPhase = 'connecting';
        setStatus('connecting', t('正在应用新的远程桌面尺寸...'));

        // Let the old Go/WebSocket loop observe disconnect before terminating
        // it. This prevents the replacement transport racing a still-open proxy
        // session, while the retained frame stays visible in this same document.
        await new Promise((resolve) => window.setTimeout(resolve, 120));
        try { oldBridge?.close(); } catch {}
        if (rdpWorkerBridge === oldBridge) rdpWorkerBridge = null;
        wasmReady = false;

        destroyRdpCanvas();
        ensureCanvas(targetWidth, targetHeight);
        await initializeRdpWorker();

        let readyTimer = 0;
        const ready = new Promise((resolve, reject) => {
            rdpInternalRestartReady = resolve;
            rdpInternalRestartFailure = reject;
            readyTimer = window.setTimeout(() => reject(new Error('RDP replacement transport timed out')), CONNECT_TIMEOUT_MS + 1500);
        });
        try {
            reportRdpEvent('worker-restart', { value: reason, width: targetWidth, height: targetHeight });
            await connect();
            await ready;
        } finally {
            window.clearTimeout(readyTimer);
            rdpInternalRestartReady = null;
            rdpInternalRestartFailure = null;
        }
    })().catch((error) => {
        const failedStage = error?.rdpBootStage || rdpWorkerBridge?.bootStage || 'worker-restart';
        rdpDiag.worker = { error: error?.message || String(error), bootStage: failedStage };
        console.error('[rdp-worker] in-place restart failed:', error);
        setStatus('error', `RDP Worker GPU 重建失败 [${failedStage}]: ${error.message || error}`);
        throw error;
    }).finally(() => {
        rdpInternalRestarting = false;
        rdpWorkerRestartPromise = null;
        const desired = computeRdpSize();
        if (connected && (desired.width !== rdpWidth || desired.height !== rdpHeight)) {
            scheduleLiveRdpResize({ delay: 120, resetRetry: true });
        }
    });
    return rdpWorkerRestartPromise;
}

async function reconnectWithSettings({ reason = 'settings', preserveFrame = true, targetSize = null } = {}) {
    if (rdpReconnectTimer) { clearTimeout(rdpReconnectTimer); rdpReconnectTimer = null; }
    clearConnectWatchdog();
    rdpManualDisconnect = false;
    rdpReconnecting = false;
    rdpReconnectAttempts = 0;
    // Persist before rebuilding so the replacement transport applies the
    // clicked resolution / quality / fps instead of re-reading old params.
    persistSessionParams({
        rdpResolution: params.rdpResolution || '1080p',
        quality: qualityMode,
        rdpFps: fpsValue,
    });
    if (preserveFrame && connected) await showRdpResizeTransitionFrame();
    const size = targetSize || computeRdpSize();
    return restartRdpWorkerInPlace(size.width, size.height, { reason });
}

async function applyLiveRenderPreferences(reason = 'preferences') {
	if (!connected || !rdpWorkerBridge || typeof window.rdpSetRenderPreferences !== 'function') return false;
	reportRdpEvent('preferences-request', { value: reason });
	reportWorkerTelemetry(0, { reason: `${reason}-before` }).catch(() => {});
	const accepted = await Promise.resolve(window.rdpSetRenderPreferences(qualityMode, fpsValue));
	if (!accepted) throw new Error('RDP renderer is not ready for live preferences');
	if (reason === 'quality') {
		// The login-time ClientInfo flags cannot change in place. Ask for a fresh
		// RDPGFX update after changing Frame Acknowledge feedback so the encoder
		// can converge on the new live quality policy promptly.
		window.setTimeout(() => window.rdpRequestFullRefresh?.(), 80);
	}
	reportRdpEvent('preferences-applied', { value: reason });
	window.setTimeout(() => reportWorkerTelemetry(0, { reason: `${reason}-after` }).catch(() => {}), 1000);
	setStatus('connected', `${qualityMode === 'performance' ? t('性能') : qualityMode === 'quality' ? t('画质') : t('平衡')} · ${fpsValue}FPS`);
	return true;
}

async function connect() {
    if (!wasmReady || !rdpWorkerBridge) throw new Error('Worker GPU WASM engine is not ready');

    /* Clean up any lingering state (safe to call even if already clean). */
    lastWorkerTelemetrySample = null;
    try { rdpDisconnect(); } catch {}
    stopAgentDriveBridge();
    rdpManualDisconnect = false;
    rdpAudinStopInternal();
    rdpLocationStopInternal();
    rdpCameraStopInternal();
    pointerCache.clear();
    connected = false;

    const width = rdpWidth || 1920;
    const height = rdpHeight || 1080;

    if (!rdpCanvas) ensureCanvas(width, height);

    /* Reuse AudioContext if still open; create fresh only when needed.
     * Browsers limit the number of AudioContexts — creating one every
     * reconnect eventually hits the cap and silently fails. */
    if (!audioCtx || audioCtx.state === 'closed') {
        try { audioCtx = new AudioContext({ latencyHint: 'interactive' }); } catch {}
    } else if (audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
    }
    resetAudioSchedule();

    rdpDiag.codec = 'semantic-webcodecs';

    setStatus('connecting', t('正在获取 RDP 凭据...'));

    /* Fetch credentials from server (password never stored on client) */
    const connectionId = params.connectionId || urlParams.get('connectionId') || '';
    activeConnectionId = connectionId;
    let host, port, domain, user, password;
    let rdpSoundMode = 'local';
    rdpClipboardEnabled = true;
    let storageEnabled = boolSetting(params.rdpStorage);

    if (connectionId) {
        try {
            const resp = await fetch('/api/rdp/credentials', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ connectionId }),
            });
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                throw new Error(err.error || `HTTP ${resp.status}`);
            }
            const cred = await resp.json();
            host = cred.host || params.host || 'localhost';
            port = String(cred.port || params.port || 3389);
            domain = cred.domain || params.domain || '';
            user = cred.username || params.username || 'Administrator';
            password = cred.password || '';
            /* Apply RDP settings from server */
            rdpSoundMode = cred.rdpSoundMode || params.rdpSoundMode || 'local';
            rdpClipboardEnabled = notFalseSetting(cred.rdpClipboard) && notFalseSetting(params.rdpClipboard);
            storageEnabled = boolSetting(cred.rdpStorage) || boolSetting(params.rdpStorage);
            params.rdpTouchMode = cred.rdpTouchMode || params.rdpTouchMode || 'direct';
            params.rdpTouchSensitivity = Number(cred.rdpTouchSensitivity || params.rdpTouchSensitivity || 1.5);
            // Prefer the values already chosen in this tab (sessionStorage /
            // toolbar clicks). Fall back to the saved connection profile.
            if (!params.rdpResolution && cred.rdpResolution) params.rdpResolution = cred.rdpResolution;
            if (!params.quality && cred.rdpQuality) {
                params.quality = cred.rdpQuality;
                if (qualityModes.includes(cred.rdpQuality)) qualityMode = cred.rdpQuality;
            }
            if (!params.rdpFps && cred.rdpFps) {
                const n = Number(cred.rdpFps);
                if (fpsModes.includes(n)) {
                    params.rdpFps = n;
                    fpsValue = n;
                }
            }
            rdpTouchController?.setRelativeMode(params.rdpTouchMode === 'relative');
            rdpTouchController?.setRelativeSensitivity(params.rdpTouchSensitivity);
        } catch (err) {
            setStatus('error', `获取 RDP 凭据失败: ${err.message}`);
            return;
        }
    } else {
        host = params.host || 'localhost';
        port = String(params.port || 3389);
        domain = params.domain || '';
        user = params.username || 'Administrator';
        password = params.password || '';
        rdpSoundMode = params.rdpSoundMode || 'local';
        rdpClipboardEnabled = notFalseSetting(params.rdpClipboard);
        storageEnabled = boolSetting(params.rdpStorage);
    }

    /* Apply sound mode setting */
    if (rdpSoundMode === 'off') {
        cleanupAudio();
        audioCtx = null;
    }

    rdpAgentStorageEnabled = !!storageEnabled;

    /* Zephyr One: pull in the folder chosen in RDP settings. No-ops in browser
     * Zephyr, where the endpoint does not exist.
     *
     * The loader reports truncation itself rather than calling setFilesHint
     * here: that helper is declared inside initFilePanel(), so naming it from
     * connect() is a ReferenceError — and `?.()` would not save it, because
     * optional-call guards a null *value*, never an undeclared binding. */
    if (storageEnabled) {
        await loadOneMappedFolder(connectionId);
    }

    /* ── Certificate verification dialog ── */
    if (connectionId && isCertTrusted(connectionId)) {
        rdpCertPhase = 'trusted';
        rdpCertDialogConnectionId = connectionId;
    }
    if (connectionId && !isCertTrusted(connectionId)) {
        rdpConnectionPhase = 'probing_cert';
        rdpCertPhase = 'probing';
        setStatus('connecting', t('正在验证远程证书...'));
        try {
            const certResp = await fetch('/api/rdp/probe-cert', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ connectionId }),
            });
            const certInfo = await certResp.json().catch(() => ({}));
            if (certInfo.hasCert && !certInfo.authorized) {
                const accepted = await showCertDialog(certInfo, connectionId);
                if (!accepted) {
                    rdpConnectionPhase = 'disconnected';
                    rdpCertPhase = 'rejected';
                    setStatus('disconnected', t('已取消连接'));
                    stopAgentDriveBridge();
                    cleanupAudio();
                    notifyParentCloseRequest('cert-rejected');
                    return;
                }
            } else {
                rdpCertPhase = certInfo.authorized ? 'none' : rdpCertPhase;
            }
        } catch (err) {
            rdpCertPhase = 'error';
            console.warn('[rdp-wasm] cert probe failed, continuing anyway:', err.message);
        }
    }

    lastConnectStage = 'page-connect-started';
    reportRdpEvent('connect-start', { host, port });
    lastConnectError = '';
    connectionFailureReported = false;
    rdpConnectionPhase = 'connecting';
    setStatus('connecting', t('正在连接 RDP...'));

    /* rdpConnect is exposed by Go WASM.
     * qualityMode → ClientInfo PERF flags; fps → RDPGFX queueDepth hint. */
    const quality = qualityModes.includes(qualityMode) ? qualityMode : 'balanced';
    const fps = fpsModes.includes(Number(fpsValue)) ? Number(fpsValue) : 30;
    startConnectWatchdog();
    if (rdpAgentStorageEnabled) startAgentDriveBridge();
    else stopAgentDriveBridge();
    await Promise.resolve(rdpConnect(
        proxyWsUrl(), host, port, domain, user, password,
        width, height, false,
        !!params.rdpMicrophone, !!params.rdpLocation, storageEnabled, !!params.rdpCamera,
        quality, fps, connectionId,
    ));
}

function disconnect() {
    rdpManualDisconnect = true;
    rdpWorkerBridge?.input?.releaseAll();
    clearConnectWatchdog();
    resetLiveRdpResizeState();
    rdpReconnecting = false;
    if (rdpReconnectTimer) { clearTimeout(rdpReconnectTimer); rdpReconnectTimer = null; }
    connected = false;
    rdpConnectionPhase = 'disconnected';
    try { rdpDisconnect(); } catch {}
    stopAgentDriveBridge();
    cleanupAudio();
    try { rdpWorkerBridge?.close(); } catch {}
    rdpWorkerBridge = null;
    rdpAudinStopInternal();
    rdpLocationStopInternal();
    rdpCameraStopInternal();
    setStatus('disconnected', t('已断开 RDP 连接'));
    notifyParentStatus('closed');
}

function maybeAutoReconnect({ reason = t('连接已断开') } = {}) {
    if (rdpManualDisconnect) return;
    if (rdpReconnecting) return;
    if (rdpReconnectAttempts >= 5) {
        setStatus('error', '自动重连失败，请手动点击“重连”');
        return;
    }
    /* Clear any existing timer to prevent parallel reconnect chains. */
    if (rdpReconnectTimer) { clearTimeout(rdpReconnectTimer); rdpReconnectTimer = null; }
    // Match SSH: fixed 2s spacing between attempts, max 5 tries, suppress on
    // manual disconnect, and keep the first concrete error in the countdown.
    const delay = 2000;
    rdpReconnectAttempts++;
    rdpReconnecting = true;
    const label = `正在重连 (${rdpReconnectAttempts}/5)...`;
    setStatus('connecting', reason ? `${reason}，${label}` : label);
    rdpReconnectTimer = setTimeout(() => {
        rdpReconnectTimer = null;
        rdpReconnecting = false;
        if (rdpManualDisconnect || connected) return;
        if (!rdpWorkerBridge) {
            reconnectWithSettings({ reason: 'auto-reconnect', preserveFrame: false }).catch((e) => {
                console.warn('[rdp-wasm] Worker rebuild reconnect failed:', e);
                if (!rdpManualDisconnect && !connected) maybeAutoReconnect({ reason: e?.message || t('重连失败') });
            });
            return;
        }
        connect().catch((e) => {
            console.warn('[rdp-wasm] reconnect failed:', e);
            rdpReconnecting = false;
            if (!rdpManualDisconnect && !connected) maybeAutoReconnect({ reason: e?.message || t('重连失败') });
        });
    }, delay);
}

/* ═══════════════════════════════════════════════════════════════════════
 * CANVAS MANAGEMENT
 * ═══════════════════════════════════════════════════════════════════════ */
function destroyRdpCanvas() {
    try { rdpTouchController?.destroy?.(); } catch {}
    rdpTouchController = null;
    try { rdpInputAbortController?.abort?.(); } catch {}
    rdpInputAbortController = null;
    inputAttached = false;
    try { rdpCanvas?.remove(); } catch {}
    rdpCanvas = null;
    if (displayRoot) displayRoot.innerHTML = '';
}

function ensureCanvas(w, h) {
    rdpWidth = w;
    rdpHeight = h;
    if (!rdpCanvas) {
        rdpCanvas = document.createElement('canvas');
        rdpCanvas.id = 'rdpCanvas';
        rdpCanvas.tabIndex = 0;
        rdpCanvas.style.display = 'block';
        rdpCanvas.style.outline = 'none';
        rdpCanvas.style.touchAction = 'none';
        rdpCanvas.style.userSelect = 'none';
        rdpCanvas.style.webkitUserSelect = 'none';
        rdpCanvas.style.webkitTouchCallout = 'none';
        rdpCanvas.style.background = '#000';
        rdpCanvas.style.cursor = 'default';
        if (displayRoot) { displayRoot.innerHTML = ''; displayRoot.appendChild(rdpCanvas); }
    }
    rdpCanvas.width = w;
    rdpCanvas.height = h;
    rdpDiag.renderer = 'worker-gpu-v2-pending';
    applyFitMode();
    attachInputEvents();
}

function clampZoomPan() {
    if (!rdpCanvas || rdpScaleZoom <= 1) {
        zoomPanX = 0;
        zoomPanY = 0;
        return;
    }
    /* The canvas is rendered at its CSS layout size then scaled by
     * rdpScaleZoom from center. The visible viewport is shellRect; the
     * scaled canvas is shellRect * rdpScaleZoom. The max translate that
     * keeps at least the viewport covered is half the overflow on each axis.
     * Because our transform is translate(...) scale(...), the translate
     * values are in pre-scale (CSS) pixels. */
    const r = rdpCanvas.getBoundingClientRect();
    const cssW = r.width / rdpScaleZoom;
    const cssH = r.height / rdpScaleZoom;
    const maxX = Math.max(0, cssW * (rdpScaleZoom - 1) / 2);
    const maxY = Math.max(0, cssH * (rdpScaleZoom - 1) / 2);
    zoomPanX = Math.max(-maxX, Math.min(maxX, zoomPanX));
    zoomPanY = Math.max(-maxY, Math.min(maxY, zoomPanY));
}

function applyViewTransform() {
    if (!rdpCanvas) return;
    clampZoomPan();
    rdpCanvas.style.transformOrigin = 'center center';
    rdpCanvas.style.transform = `translate(${zoomPanX}px, ${zoomPanY}px) scale(${rdpScaleZoom})`;
}

function applyFitMode() {
    if (!rdpCanvas) return;
    const mode = fitModes[fitModeIdx];

    /* Reset all positioning styles */
    rdpCanvas.style.transform = '';
    rdpCanvas.style.transformOrigin = '';
    rdpCanvas.style.position = '';
    rdpCanvas.style.left = '';
    rdpCanvas.style.top = '';
    rdpCanvas.style.objectPosition = '';

    if (mode === 'original') {
        /* Original: pixel-perfect, no CSS scaling, centered */
        rdpCanvas.style.width = rdpWidth + 'px';
        rdpCanvas.style.height = rdpHeight + 'px';
        rdpCanvas.style.objectFit = 'none';
        rdpCanvas.style.maxWidth = 'none';
        rdpCanvas.style.maxHeight = 'none';
    } else if (mode === 'adapt') {
        /* Adapt: scale to fit container, keep aspect ratio, no black bars.
         * Uses object-fit:contain which is correct because computeRdpSize
         * already expanded the RDP resolution to match the screen aspect. */
        rdpCanvas.style.width = '100%';
        rdpCanvas.style.height = '100%';
        rdpCanvas.style.objectFit = 'contain';
        rdpCanvas.style.maxWidth = '100%';
        rdpCanvas.style.maxHeight = '100%';
    } else if (mode === 'fill') {
        /* Fill: scale up to cover entire display, crop excess.
         * Joystick pans the visible region via object-position. */
        rdpCanvas.style.width = '100%';
        rdpCanvas.style.height = '100%';
        rdpCanvas.style.objectFit = 'cover';
        rdpCanvas.style.objectPosition = fillPanX + '% ' + fillPanY + '%';
        rdpCanvas.style.maxWidth = '100%';
        rdpCanvas.style.maxHeight = '100%';
    }

    applyViewTransform();

    if (displayShell) {
        displayShell.style.overflow = 'hidden';
    }
}

/* ═══════════════════════════════════════════════════════════════════════
 * INPUT EVENTS (mouse/keyboard/touch → Go WASM)
 * ═══════════════════════════════════════════════════════════════════════ */
let inputAttached = false;
let clipboardSyncPromise = Promise.resolve();

function canvasCoords(e) {
    const r = rdpCanvas.getBoundingClientRect();
    const canvasAspect = rdpWidth / rdpHeight;
    const rectAspect = r.width / r.height;
    let renderW, renderH, offsetX, offsetY;

    const mode = fitModes[fitModeIdx];
    if (mode === 'original') {
        /* Original: canvas CSS size = pixel size, direct mapping */
        const scaleX = rdpWidth / r.width;
        const scaleY = rdpHeight / r.height;
        return {
            x: Math.max(0, Math.min(rdpWidth - 1, Math.floor((e.clientX - r.left) * scaleX))),
            y: Math.max(0, Math.min(rdpHeight - 1, Math.floor((e.clientY - r.top) * scaleY))),
        };
    } else if (mode === 'fill') {
        /* Fill mode: object-fit cover with pannable viewport.
         * Must account for objectPosition offset from joystick panning. */
        if (rectAspect > canvasAspect) {
            renderW = r.width;
            renderH = r.width / canvasAspect;
            offsetX = 0;
            /* objectPosition Y controls vertical shift */
            offsetY = -(renderH - r.height) * (fillPanY / 100);
        } else {
            renderH = r.height;
            renderW = r.height * canvasAspect;
            /* objectPosition X controls horizontal shift */
            offsetX = -(renderW - r.width) * (fillPanX / 100);
            offsetY = 0;
        }
    } else {
        /* object-fit: contain — image letterboxed/pillarboxed */
        if (rectAspect > canvasAspect) {
            renderH = r.height;
            renderW = r.height * canvasAspect;
            offsetX = (r.width - renderW) / 2;
            offsetY = 0;
        } else {
            renderW = r.width;
            renderH = r.width / canvasAspect;
            offsetX = 0;
            offsetY = (r.height - renderH) / 2;
        }
    }
    const x = Math.floor(((e.clientX - r.left - offsetX) / renderW) * rdpWidth);
    const y = Math.floor(((e.clientY - r.top - offsetY) / renderH) * rdpHeight);
    return {
        x: Math.max(0, Math.min(rdpWidth - 1, x)),
        y: Math.max(0, Math.min(rdpHeight - 1, y)),
    };
}

function attachInputEvents() {
    if (inputAttached || !rdpCanvas) return;
    inputAttached = true;
    rdpInputAbortController = new AbortController();
    const signal = rdpInputAbortController.signal;

    rdpCanvas.addEventListener('mousemove', (e) => {
        if (!connected) return;
        const { x, y } = canvasCoords(e);
        if (selectedPipeline === 'worker-gpu-v2') rdpWorkerBridge.input.push('mouse-move', { x, y });
        else rdpMouseMove(x, y);
    }, { signal });

    rdpCanvas.addEventListener('mousedown', (e) => {
        if (!connected) return;
        e.preventDefault();
        rdpCanvas.focus();
        const { x, y } = canvasCoords(e);
        if (selectedPipeline === 'worker-gpu-v2') rdpWorkerBridge.input.push('mouse-down', { button: e.button, x, y });
        else rdpMouseDown(e.button, x, y);
    }, { signal });

    rdpCanvas.addEventListener('mouseup', (e) => {
        if (!connected) return;
        e.preventDefault();
        const { x, y } = canvasCoords(e);
        if (selectedPipeline === 'worker-gpu-v2') rdpWorkerBridge.input.push('mouse-up', { button: e.button, x, y });
        else rdpMouseUp(e.button, x, y);
    }, { signal });

    rdpCanvas.addEventListener('wheel', (e) => {
        if (!connected) return;
        e.preventDefault();
        let delta;
        if (e.deltaMode === 1) delta = -e.deltaY / 3;
        else if (e.deltaMode === 2) delta = -e.deltaY;
        else delta = -e.deltaY / 100;
        if (selectedPipeline === 'worker-gpu-v2') rdpWorkerBridge.input.push('wheel', { delta });
        else rdpMouseWheel(delta);
    }, { passive: false, signal });

    rdpCanvas.addEventListener('contextmenu', (e) => e.preventDefault(), { signal });

    /* Clipboard sync on pointer down */
    function syncClipboard() {
        if (!connected || !navigator.clipboard?.readText) return;
        clipboardSyncPromise = navigator.clipboard.readText()
            .then((text) => {
                if (text && text !== lastSyncedLocalClipboardText) {
                    lastSyncedLocalClipboardText = text;
                    rdpClipboardChanged(text);
                }
            })
            .catch(() => {});
    }
    rdpCanvas.addEventListener('pointerdown', syncClipboard, { signal });

    /* Proactive clipboard sync: also sync when the window regains focus or
     * becomes visible, so Ctrl+V doesn't paste stale content. */
    window.addEventListener('focus', syncClipboard, { signal });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') syncClipboard();
    }, { signal });

    document.addEventListener('paste', (e) => {
        if (!connected) return;
        const text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
        if (text) rdpClipboardChanged(text);
    }, { signal });

    rdpCanvas.addEventListener('keydown', async (e) => {
        if (!connected) return;
        e.preventDefault();
        /* If this is a paste operation (Ctrl+V / Cmd+V), ensure the local
         * clipboard is synced to the remote BEFORE sending the key, otherwise
         * the remote will paste whatever was previously in its clipboard. */
        if (e.code === 'KeyV' && (e.ctrlKey || e.metaKey)) {
            syncClipboard();
        }
        await clipboardSyncPromise;
        if (selectedPipeline === 'worker-gpu-v2') rdpWorkerBridge.input.push('key-down', { code: e.code });
        else rdpKeyDown(e.code);
    }, { signal });

    rdpCanvas.addEventListener('keyup', (e) => {
        if (!connected) return;
        e.preventDefault();
        if (selectedPipeline === 'worker-gpu-v2') rdpWorkerBridge.input.push('key-up', { code: e.code });
        else rdpKeyUp(e.code);
    }, { signal });

    /* ─── Touch input — uses RdpTouchController module ──── */
    if (!rdpTouchController) {
        const relativeMode = String(params.rdpTouchMode || 'direct') === 'relative';
        const relativeSensitivity = Math.max(0.5, Math.min(3, Number(params.rdpTouchSensitivity) || 1.5));
        rdpTouchController = new RdpTouchController({
            canvas: rdpCanvas,
            getConnected: () => connected,
            canvasCoords,
            sendMouseMove: (x, y) => selectedPipeline === 'worker-gpu-v2' ? rdpWorkerBridge.input.push('mouse-move', { x, y }) : rdpMouseMove(x, y),
            sendMouseDown: (btn, x, y) => selectedPipeline === 'worker-gpu-v2' ? rdpWorkerBridge.input.push('mouse-down', { button: btn, x, y }) : rdpMouseDown(btn, x, y),
            sendMouseUp: (btn, x, y) => selectedPipeline === 'worker-gpu-v2' ? rdpWorkerBridge.input.push('mouse-up', { button: btn, x, y }) : rdpMouseUp(btn, x, y),
            sendMouseWheel: (delta) => selectedPipeline === 'worker-gpu-v2' ? rdpWorkerBridge.input.push('wheel', { delta }) : rdpMouseWheel(delta),
            sendMouseHWheel: (delta) => selectedPipeline === 'worker-gpu-v2' ? rdpWorkerBridge.input.push('hwheel', { delta }) : rdpMouseHScroll(delta),
            sendKeyCombo: (gesture) => {
                const combos = {
                    '3up': ['MetaLeft', 'Tab'],
                    '3down': ['MetaLeft', 'KeyD'],
                    '3left': ['ControlLeft', 'MetaLeft', 'ArrowLeft'],
                    '3right': ['ControlLeft', 'MetaLeft', 'ArrowRight'],
                };
                const keys = combos[gesture];
                if (!keys) return;
                const sendDown = (code) => selectedPipeline === 'worker-gpu-v2' ? rdpWorkerBridge.input.push('key-down', { code }) : rdpKeyDown(code);
                const sendUp = (code) => selectedPipeline === 'worker-gpu-v2' ? rdpWorkerBridge.input.push('key-up', { code }) : rdpKeyUp(code);
                for (const code of keys) sendDown(code);
                setTimeout(() => { for (const code of keys.slice().reverse()) sendUp(code); }, 50);
            },
            relativeMode,
            relativeSensitivity,
        });
    }

    /* ─── Mobile keyboard input (textarea IME host) ──── */
    // Bound later in initToolbar once keyboardBtn is available.
}

/* Send non-ASCII text to the remote desktop via clipboard paste.
 * This is the standard workaround for CJK/emoji input in web RDP clients —
 * direct Unicode scancode input requires protocol-level support that is
 * complex to wire through WASM. Callers must serialize through the mobile
 * keyboard controller so rapid commits cannot interleave Ctrl+V. */
async function sendTextViaClipboard(text) {
    if (!connected || !text) return;
    /* Try the synchronous wait path first (WASM exposes rdpClipboardChangedSync). */
    if (typeof rdpClipboardChangedSync === 'function') {
        try {
            const ready = await rdpClipboardChangedSync(text);
            if (!ready) {
                /* Timeout - fall back to a longer delay before sending Ctrl+V. */
                await new Promise(r => setTimeout(r, 250));
            }
        } catch {
            /* Promise rejected - fall back to old delay path. */
            rdpClipboardChanged(text);
            await new Promise(r => setTimeout(r, 250));
        }
    } else {
        /* Older WASM without rdpClipboardChangedSync: use conservative delay. */
        rdpClipboardChanged(text);
        await new Promise(r => setTimeout(r, 250));
    }
    rdpKeyDown('ControlLeft');
    rdpKeyDown('KeyV');
    await new Promise((r) => setTimeout(r, 50));
    rdpKeyUp('KeyV');
    rdpKeyUp('ControlLeft');
    // Give the remote a beat before the next paste in the queue.
    await new Promise((r) => setTimeout(r, 40));
}

/* ═══════════════════════════════════════════════════════════════════════
 * UI CONTROLS
 * ═══════════════════════════════════════════════════════════════════════ */

function loadParams() {
    const key = tabId ? `zephyr_remote_desktop_params_${tabId}` : 'zephyr_remote_desktop_params';
    let stored = {};
    try { stored = JSON.parse(sessionStorage.getItem(key) || '{}') || {}; } catch { stored = {}; }
    const query = Object.fromEntries(urlParams);
    return { ...stored, ...Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && String(v) !== '')) };
}

function setStatus(state, text, options = {}) {
    const seq = ++statusSequence;
    statusDot?.classList.remove('connected', 'connecting', 'error', 'disconnected');
    if (state) statusDot?.classList.add(state);
    if (statusText) statusText.textContent = text || '';
    if (overlayMsg) overlayMsg.textContent = text || '';
    const holdMs = Number(options.holdOverlayMs) || 0;
    if (overlay) {
        const keepTransitionVisible = !!rdpTransitionFrame && state !== 'error';
        if (keepTransitionVisible) {
            overlay.classList.add('hidden');
        } else if (state === 'connected' && holdMs > 0) {
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
    if (connInfo) connInfo.textContent = `${name} · ${params.host || ''}:${port}`;
}

function escapeHtml(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

/* ─── Parent frame communication ──────────────────────────────────── */
function notifyParentStatus(status) {
    if (embeddedMode && window.parent && window.parent !== window) {
        window.parent.postMessage({ source: 'zephyr-terminal', tabId: params?.tabId || tabId, status }, '*');
    }
}
function notifyParentCloseRequest(reason = 'remote-desktop-closed') {
    if (embeddedMode && window.parent && window.parent !== window) {
        window.parent.postMessage({ source: 'zephyr-terminal', type: 'close-request', tabId: params?.tabId || tabId, reason }, '*');
    }
}
function notifyParentSharedClipboardText(text = '') {
    if (embeddedMode && window.parent && window.parent !== window && text) {
        window.parent.postMessage({ source: 'zephyr-terminal', type: 'shared-clipboard-text', tabId: params?.tabId || tabId, text }, '*');
    }
}
function notifyParentAiActionResult(actionId, payload = {}) {
    if (!embeddedMode || !window.parent || window.parent === window || !actionId) return;
    window.parent.postMessage({ source: 'zephyr-terminal', type: 'ai-remote-desktop-action-result', tabId: params?.tabId || tabId, actionId, ...payload }, '*');
}

/* ─── Theme ────────────────────────────────────────────────────────── */
function initialTheme() {
    const saved = localStorage.getItem('zephyr-theme');
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ? 'dark' : 'light';
}
function applyFrameTheme(theme = initialTheme(), appearance = {}) {
    const normalized = theme === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', normalized);
    applyZephyrColorScheme(appearance || {}, { theme: normalized, page: 'rdp' });
}
applyFrameTheme();
window.addEventListener('storage', (e) => {
    if (e.key === 'zephyr-theme') applyFrameTheme(initialTheme());
});

/* ─── Resolution computation ──────────────────────────────────────── */
function isPortraitTouch() {
    const coarse = window.matchMedia?.('(pointer: coarse)')?.matches || navigator.maxTouchPoints > 0;
    return !!coarse && (window.innerHeight || 0) >= (window.innerWidth || 0);
}
function computeRdpSize() {
    /* Match the display region's aspect, but keep every named density tier
     * inside its conventional pixel envelope. In particular, a shallow stage
     * must not turn "2K" into a 6176x1440 monitor-layout request. */
    const stage = document.getElementById('rdpStage');
    let cw = 0, ch = 0;
    if (stage) {
        const r = stage.getBoundingClientRect();
        cw = r.width; ch = r.height;
    }
    if (!cw || !ch) { cw = window.innerWidth; ch = window.innerHeight || 1; }
    return computeSafeRdpSize({
        resolution: params.rdpResolution || '1080p',
        viewportWidth: cw,
        viewportHeight: ch,
        devicePixelRatio: window.devicePixelRatio || 1,
    });
}

async function applyLiveRdpResize() {
    rdpResizeTimer = 0;
    if (!connected || !wasmReady || !rdpWorkerBridge || typeof window.rdpSetResolution !== 'function') return false;
    let size = computeRdpSize();
    if (rdpTransitionFrame && !rdpTransitionReadyForResize) {
        if (size.width !== rdpWidth || size.height !== rdpHeight) rdpResizeQueued = true;
        return false;
    }
    if (rdpResizeAwaitingReset) {
        if (!rdpResizeRequestedSize
            || size.width !== rdpResizeRequestedSize.width
            || size.height !== rdpResizeRequestedSize.height) rdpResizeQueued = true;
        return false;
    }
    if (size.width === rdpWidth && size.height === rdpHeight) {
        rdpResizeRetryCount = 0;
        return true;
    }
    if (rdpResizeInFlight) {
        rdpResizeQueued = true;
        return false;
    }
    const sinceLastRequest = performance.now() - rdpLastResizeRequestAt;
    if (rdpLastResizeRequestAt > 0 && sinceLastRequest < RDP_MIN_RESIZE_INTERVAL_MS) {
        rdpResizeQueued = true;
        scheduleLiveRdpResize({ delay: RDP_MIN_RESIZE_INTERVAL_MS - sinceLastRequest });
        return false;
    }
    rdpResizeInFlight = true;
    try {
        const transitionReady = await showRdpResizeTransitionFrame();
        if (!transitionReady) {
            rdpResizeRetryCount++;
            if (rdpResizeRetryCount <= 6) scheduleLiveRdpResize({ delay: 350 });
            return false;
        }
        size = computeRdpSize();
        if (size.width === rdpWidth && size.height === rdpHeight) {
            dismissRdpTransitionFrame();
            return true;
        }
        reportRdpEvent('resize-request', {
            width: size.width,
            height: size.height,
            previousWidth: rdpWidth,
            previousHeight: rdpHeight,
        });
        reportWorkerTelemetry(0, { reason: 'resize-request' }).catch(() => {});
        const accepted = await Promise.resolve(window.rdpSetResolution(size.width, size.height));
        if (!accepted) {
            // rdpOnReady can precede the dynamic display channel by a short
            // interval. Retry a bounded number of times; unsupported servers
            // must not create an endless resize loop.
            rdpResizeRetryCount++;
            if (rdpResizeRetryCount <= 12) scheduleLiveRdpResize({ delay: 400 });
            return false;
        }
        rdpResizeRetryCount = 0;
        rdpLastResizeRequestAt = performance.now();
        rdpResizeAwaitingReset = true;
        rdpResizeRequestedSize = { ...size };
        reportRdpEvent('resize-accepted', { width: size.width, height: size.height });
        window.clearTimeout(rdpResizeAckTimer);
        rdpResizeAckTimer = window.setTimeout(() => {
            if (!rdpResizeAwaitingReset) return;
            const timedOut = rdpResizeRequestedSize;
            rdpResizeAwaitingReset = false;
            rdpResizeRequestedSize = null;
            rdpResizeResetTimeouts++;
            reportRdpEvent('resize-reset-timeout', {
                width: timedOut?.width || 0,
                height: timedOut?.height || 0,
                value: `timeout-${rdpResizeResetTimeouts}`,
            });
            reportWorkerTelemetry(0, { reason: 'resize-reset-timeout' }).catch(() => {});
            // A lost ResetGraphics must not create an unbounded MonitorLayout
            // storm. Retry at most twice, retaining only the latest geometry.
            if (connected && rdpResizeResetTimeouts <= 2) scheduleLiveRdpResize({ delay: 250 });
        }, 12000);
        return true;
    } catch (error) {
        console.warn('[rdp-resize] live resolution request failed:', error?.message || error);
        return false;
    } finally {
        rdpResizeInFlight = false;
        if (rdpResizeQueued && !rdpResizeAwaitingReset) {
            rdpResizeQueued = false;
            scheduleLiveRdpResize({ delay: 0 });
        }
    }
}

function scheduleLiveRdpResize({ delay = 180, resetRetry = false } = {}) {
    if (rdpResizeCleanReconnectTimer) {
        const desired = computeRdpSize();
        if (desired.width !== rdpWidth || desired.height !== rdpHeight) {
            window.clearTimeout(rdpResizeCleanReconnectTimer);
            rdpResizeCleanReconnectTimer = 0;
            rdpResizeCleanReconnectGeneration++;
            rdpResizeCleanReconnectPending = false;
        }
    }
    if (resetRetry) {
        rdpResizeRetryCount = 0;
        rdpResizeResetTimeouts = 0;
    }
    window.clearTimeout(rdpResizeTimer);
    rdpResizeTimer = window.setTimeout(() => { applyLiveRdpResize().catch(() => {}); }, Math.max(0, Number(delay) || 0));
}

function resetLiveRdpResizeState() {
    window.clearTimeout(rdpResizeTimer);
    window.clearTimeout(rdpResizeAckTimer);
    rdpResizeTimer = 0;
    rdpResizeAckTimer = 0;
    rdpResizeInFlight = false;
    rdpResizeQueued = false;
    rdpResizeAwaitingReset = false;
    rdpResizeRequestedSize = null;
    rdpResizeRetryCount = 0;
    rdpResizeResetTimeouts = 0;
    rdpLastResizeRequestAt = 0;
    window.clearTimeout(rdpResizeCleanReconnectTimer);
    rdpResizeCleanReconnectTimer = 0;
    rdpResizeCleanReconnectGeneration++;
    rdpResizeCleanReconnectPending = false;
}

function scheduleResizeCleanReconnect(width, height) {
    window.clearTimeout(rdpResizeCleanReconnectTimer);
    const generation = ++rdpResizeCleanReconnectGeneration;
    rdpResizeCleanReconnectPending = true;
    rdpResizeCleanReconnectTimer = window.setTimeout(async () => {
        rdpResizeCleanReconnectTimer = 0;
        if (generation !== rdpResizeCleanReconnectGeneration || !connected || rdpResizeAwaitingReset || rdpResizeQueued) {
            rdpResizeCleanReconnectPending = false;
            return;
        }
        const desired = computeRdpSize();
        if (desired.width !== width || desired.height !== height) {
            rdpResizeCleanReconnectPending = false;
            scheduleLiveRdpResize({ delay: 0 });
            return;
        }
        if (!rdpTransitionFrame) await showRdpResizeTransitionFrame();
        if (generation !== rdpResizeCleanReconnectGeneration || !connected || rdpResizeAwaitingReset || rdpResizeQueued) {
            rdpResizeCleanReconnectPending = false;
            return;
        }
        const latest = computeRdpSize();
        if (latest.width !== width || latest.height !== height) {
            rdpResizeCleanReconnectPending = false;
            scheduleLiveRdpResize({ delay: 0 });
            return;
        }
        rdpTransitionReadyForResize = false;
        try {
            await reconnectWithSettings({
                reason: 'resize-clean-reconnect',
                preserveFrame: false,
                targetSize: { width, height },
            });
        } catch (error) {
            console.warn('[rdp-resize] clean Worker restart failed:', error?.message || error);
        }
    }, RDP_RESIZE_RECONNECT_SETTLE_MS);
}

function initLiveRdpResize() {
    const stage = document.getElementById('rdpStage');
    if (stage && typeof ResizeObserver === 'function') {
        rdpStageResizeObserver = new ResizeObserver(() => scheduleLiveRdpResize());
        rdpStageResizeObserver.observe(stage);
    }
    const scheduleSettledResize = () => scheduleLiveRdpResize({ delay: 220, resetRetry: true });
    window.addEventListener('resize', scheduleSettledResize, { passive: true });
    window.addEventListener('orientationchange', scheduleSettledResize, { passive: true });
    document.addEventListener('fullscreenchange', scheduleSettledResize);
    window.visualViewport?.addEventListener?.('resize', scheduleSettledResize, { passive: true });
    screen.orientation?.addEventListener?.('change', scheduleSettledResize);
}

/* ─── Shortcut key handler ────────────────────────────────────────── */
const KEY_SEQ_MAP = {
    'esc': ['Escape'],
    'tab': ['Tab'],
    'enter': ['Enter'],
    'backspace': ['Backspace'],
    'win': ['MetaLeft'],
    'alt-tab': ['AltLeft', 'Tab'],
    'up': ['ArrowUp'], 'down': ['ArrowDown'], 'left': ['ArrowLeft'], 'right': ['ArrowRight'],
    'home': ['Home'], 'end': ['End'], 'pageup': ['PageUp'], 'pagedown': ['PageDown'],
};
for (let i = 1; i <= 12; i++) KEY_SEQ_MAP['f' + i] = ['F' + i];
for (let c = 'a'.charCodeAt(0); c <= 'z'.charCodeAt(0); c++) {
    const ch = String.fromCharCode(c);
    KEY_SEQ_MAP['ctrl-' + ch] = ['ControlLeft', 'Key' + ch.toUpperCase()];
}

function sendKeySequence(seq) {
    if (!connected) return;
    const codes = KEY_SEQ_MAP[seq];
    if (!codes) return;
    for (const code of codes) rdpKeyDown(code);
    setTimeout(() => { for (const code of codes.slice().reverse()) rdpKeyUp(code); }, 40);
}

async function performAiRemoteDesktopAction(data = {}) {
    // The Node tool host already validates captureId against the latest
    // user+run+tab capture ledger before dispatch. Do not compare it with a
    // newly rendered frame here: clocks, cursor blink and animations advance
    // frameAt continuously and would reject every legitimate action.
    const control = String(data.control || '').toLowerCase().replace(/-/g, '_');
    if (control === 'quality') { $('#qualityBtn')?.click?.(); return { ok: true, control, qualityMode }; }
    if (control === 'fit') { $('#fitBtn')?.click?.(); return { ok: true, control, fitMode: fitModes[fitModeIdx] }; }
    if (control === 'zoom') {
        const slider = $('#zoomSlider');
        if (slider && Number.isFinite(Number(data.zoomPercent))) { slider.value = String(Math.max(50, Math.min(250, Number(data.zoomPercent)))); slider.dispatchEvent(new Event('input', { bubbles: true })); }
        return { ok: true, control, zoomPercent: Math.round(rdpScaleZoom * 100) };
    }
    if (control === 'clipboard') { $('#clipboardBtn')?.click?.(); return { ok: true, control }; }
    if (control === 'keyboard') { $('#keyboardBtn')?.click?.(); return { ok: true, control }; }
    if (control === 'shortcuts') { $('#shortcutsBtn')?.click?.(); return { ok: true, control }; }
    if (control === 'joystick' || control === 'drag') { $('#joystickBtn')?.click?.(); return { ok: true, control }; }
    if (control === 'ctrl_alt_del') { $('#ctrlAltDelBtn')?.click?.(); return { ok: true, control }; }
    if (control === 'reconnect') { $('#reconnectBtn')?.click?.(); return { ok: true, control }; }
    if (control === 'disconnect') { $('#disconnectBtn')?.click?.(); return { ok: true, control }; }
    if (control === 'shortcut') {
        const sequence = String(data.sequence || '');
        if (!KEY_SEQ_MAP[sequence]) throw new Error(t('未知 RDP 快捷键：{sequence}', { sequence }));
        sendKeySequence(sequence);
        return { ok: true, control, sequence };
    }
    if (control === 'text' || control === 'clipboard_send') {
        const text = String(data.text || '');
        if (!text) throw new Error(t('AI 远程桌面输入为空'));
        await sendTextViaClipboard(text);
        return { ok: true, control, length: text.length };
    }
    if (control === 'mouse_click') {
        const x = Math.round(Number(data.x));
        const y = Math.round(Number(data.y));
        const button = Math.max(0, Math.min(2, (Number(data.button) || 1) - 1));
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(t('AI 远程桌面点击缺少 x/y'));
        if (selectedPipeline === 'worker-gpu-v2') {
            rdpWorkerBridge.input.push('mouse-move', { x, y });
            rdpWorkerBridge.input.push('mouse-down', { button, x, y });
            await new Promise((resolve) => setTimeout(resolve, 45));
            rdpWorkerBridge.input.push('mouse-up', { button, x, y });
        } else {
            rdpMouseMove(x, y); rdpMouseDown(button, x, y); await new Promise((resolve) => setTimeout(resolve, 45)); rdpMouseUp(button, x, y);
        }
        return { ok: true, control, x, y, button: button + 1 };
    }
    throw new Error(t('未知 RDP AI 动作：{control}', { control }));
}

/* ═══════════════════════════════════════════════════════════════════════
 * TOOLBAR BUTTONS
 * ═══════════════════════════════════════════════════════════════════════ */
/** SSH/Telnet topbar-actions 同源：横向滑动时短暂显示滚动条。 */
function setupHorizontalScrollbarVisibility(...elements) {
    elements.filter(Boolean).forEach((el) => {
        let timer = 0;
        const show = () => {
            el.classList.add('scroll-active');
            window.clearTimeout(timer);
            timer = window.setTimeout(() => el.classList.remove('scroll-active'), 1100);
        };
        el.addEventListener('pointerdown', show, { passive: true });
        el.addEventListener('touchstart', show, { passive: true });
        el.addEventListener('wheel', show, { passive: true });
        el.addEventListener('scroll', show, { passive: true });
        el.addEventListener('mouseenter', show, { passive: true });
        el.addEventListener('mouseleave', () => {
            window.clearTimeout(timer);
            timer = window.setTimeout(() => el.classList.remove('scroll-active'), 260);
        }, { passive: true });
    });
}

function initToolbar() {
    const qualityBtn = $('#qualityBtn');
    const resolutionBtn = $('#resolutionBtn');
    const fpsBtn = $('#fpsBtn');
    const fitBtn = $('#fitBtn');
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
    const shortcutsPanel = $('#shortcutsPanel');
    const joystickPanel = $('#joystickPanel');
    // 与 SSH/Telnet 相同：横向溢出时 hover/滑动显示细滚动条
    const topbarActions = document.getElementById('topbarActions');
    setupHorizontalScrollbarVisibility(topbarActions);

    if (qualityBtn) {
        qualityBtn.textContent = qualityMode === 'performance' ? t('性能') : qualityMode === 'quality' ? t('画质') : t('平衡');
        qualityBtn.addEventListener('click', () => {
            const idx = qualityModes.indexOf(qualityMode);
            qualityMode = qualityModes[(idx + 1) % qualityModes.length];
            qualityBtn.textContent = qualityMode === 'performance' ? t('性能') : qualityMode === 'quality' ? t('画质') : t('平衡');
            persistSessionParams({ quality: qualityMode });
            if (connected) {
				applyLiveRenderPreferences('quality').catch((error) => {
					console.warn('[rdp] live quality preference failed', error);
					setStatus('connected', t('画质设置已保存'));
				});
            }
        });
    }

    if (fpsBtn) {
        fpsBtn.textContent = fpsValue + 'FPS';
        fpsBtn.addEventListener('click', () => {
            const idx = fpsModes.indexOf(fpsValue);
            fpsValue = fpsModes[(idx + 1) % fpsModes.length];
            fpsBtn.textContent = fpsValue + 'FPS';
            persistSessionParams({ rdpFps: fpsValue });
            if (connected) {
				applyLiveRenderPreferences('fps').catch((error) => {
					console.warn('[rdp] live FPS preference failed', error);
					setStatus('connected', t('帧率设置已保存'));
				});
            }
        });
    }

    if (fitBtn) {
        fitBtn.addEventListener('click', () => {
            fitModeIdx = (fitModeIdx + 1) % fitModes.length;
            const newMode = fitModes[fitModeIdx];
            fitBtn.textContent = newMode === 'original' ? t('原始') : newMode === 'adapt' ? t('适应') : t('填充');
            applyFitMode();
        });
    }

    if (zoomSlider) {
        zoomSlider.addEventListener('input', () => {
            rdpScaleZoom = Number(zoomSlider.value) / 100;
            if (zoomValue) zoomValue.textContent = Math.round(rdpScaleZoom * 100) + '%';
            applyViewTransform();
        });
    }

    if (clipboardBtn && clipboardPanel) {
        clipboardBtn.addEventListener('click', () => {
            toggleFloatingPanel(clipboardPanel, clipboardBtn, {
                kind: 'clipboard',
                refresh: () => {
                    try { renderRemoteClipboard?.(); } catch {}
                },
            });
        });
    }

    if (rdpFilesBtn && filesPanel) {
        rdpFilesBtn.addEventListener('click', () => {
            toggleFloatingPanel(filesPanel, rdpFilesBtn, {
                kind: 'files',
                defaults: { width: 360, height: 480, right: 16, top: 56 },
                refresh: () => {
                    try { updatePendingFileList?.(); } catch {}
                    try {
                        if (typeof window.rdpOnRemoteFiles === 'function' && Array.isArray(window.__rdpRemoteFilesCache)) {
                            window.rdpOnRemoteFiles(window.__rdpRemoteFilesCache);
                        }
                    } catch {}
                },
            });
        });
    }

    if (keyboardBtn && mobileKeyboardInput) {
        // Destroy previous controller if toolbar is re-inited.
        try { window.__rdpMobileKeyboard?.destroy?.(); } catch {}
        window.__rdpMobileKeyboard = new RdpMobileKeyboard({
            host: mobileKeyboardInput,
            button: keyboardBtn,
            isConnected: () => connected,
            sendKeyDown: (code) => rdpKeyDown(code),
            sendKeyUp: (code) => rdpKeyUp(code),
            sendUnicodeText: (text) => rdpUnicodeText(text),
            sendClipboardText: (text) => sendTextViaClipboard(text),
        });
    }

    if (shortcutsBtn && shortcutsPanel) {
        shortcutsBtn.addEventListener('click', () => {
            toggleFloatingPanel(shortcutsPanel, shortcutsBtn, {
                kind: 'shortcuts',
                defaults: { width: 320, height: 360, right: 16, top: 56 },
            });
        });
    }

    if (joystickBtn && joystickPanel) {
        joystickBtn.addEventListener('click', () => {
            toggleFloatingPanel(joystickPanel, joystickBtn, {
                kind: 'joystick',
                defaults: { width: 280, height: 280, right: 16, bottom: 16 },
            });
        });
    }

    // Shared SSH-parity interactions: titlebar drag, traffic-light drag/menu,
    // edge resize, front-most z-index, island layout menu.
    const closeRdpPanel = (panel) => {
        const map = [
            [clipboardPanel, clipboardBtn],
            [filesPanel, rdpFilesBtn],
            [shortcutsPanel, shortcutsBtn],
            [joystickPanel, joystickBtn],
        ];
        const hit = map.find(([p]) => p === panel);
        closeFloatingPanel(panel, hit?.[1] || null);
    };
    setupPanelInteractions(document, {
        panelSelector: '.rdp-floating-panel',
        onClosePanel: closeRdpPanel,
    });
    // RDP's second-level panels use the same desktop-only `.tgl` side pins.
    const desktopPinPage = document.querySelector('.rdp-page');
    [clipboardPanel, filesPanel, shortcutsPanel, joystickPanel].filter(Boolean).forEach((panel) => {
        attachDesktopPanelPin(desktopPinPage, panel, { onClose: closeRdpPanel });
    });

    /* Joystick knob — controls viewport pan in fill mode */
    const joystickKnob = document.getElementById('joystickKnob');
    const joystickContainer = document.getElementById('joystickContainer');

    /* Shared: apply viewport pan to the canvas. In zoom>1 mode, directly
     * manipulates the pixel-level transform translate. In fill mode (zoom=1),
     * uses object-position for CSS cover panning. */
    const applyFillPan = () => {
        if (rdpScaleZoom > 1 && rdpCanvas) {
            /* Direct pixel pan — no percentage indirection. clampZoomPan
             * already bounds zoomPanX/Y to the visible overflow area. */
            clampZoomPan();
            applyViewTransform();
        } else if (fitModes[fitModeIdx] === 'fill' && rdpCanvas) {
            fillPanX = Math.max(0, Math.min(100, fillPanX));
            fillPanY = Math.max(0, Math.min(100, fillPanY));
            rdpCanvas.style.objectPosition = fillPanX + '% ' + fillPanY + '%';
        }
    };

    if (joystickKnob && joystickContainer) {
        let joyDrag = null;
        let joyAnimFrame = null;
        const joyRadius = 50;
        let joyVX = 0, joyVY = 0;

        const joyTick = () => {
            if (!joyDrag) { joyAnimFrame = null; return; }
            if (rdpScaleZoom > 1) {
                /* Direct pixel panning — speed scales with zoom level so
                 * full-deflection traverses the entire canvas in ~1 second. */
                const speed = Math.max(8, rdpScaleZoom * 12);
                zoomPanX -= joyVX * speed;
                zoomPanY -= joyVY * speed;
                applyFillPan();
            } else if (fitModes[fitModeIdx] === 'fill') {
                fillPanX += joyVX * 3;
                fillPanY += joyVY * 3;
                applyFillPan();
            }
            joyAnimFrame = requestAnimationFrame(joyTick);
        };

        joystickKnob.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            const rect = joystickContainer.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            joyDrag = { cx, cy };
            joyVX = 0; joyVY = 0;
            try { joystickKnob.setPointerCapture(e.pointerId); } catch {}
            if (!joyAnimFrame) joyAnimFrame = requestAnimationFrame(joyTick);
        });
        joystickKnob.addEventListener('pointermove', (e) => {
            if (!joyDrag) return;
            const dx = Math.max(-joyRadius, Math.min(joyRadius, e.clientX - joyDrag.cx));
            const dy = Math.max(-joyRadius, Math.min(joyRadius, e.clientY - joyDrag.cy));
            joystickKnob.style.transform = `translate(${dx}px, ${dy}px)`;
            joyVX = dx / joyRadius;
            joyVY = dy / joyRadius;
        });
        const joyEnd = () => {
            if (!joyDrag) return;
            joyDrag = null;
            joyVX = 0; joyVY = 0;
            if (joyAnimFrame) { cancelAnimationFrame(joyAnimFrame); joyAnimFrame = null; }
            joystickKnob.classList.add('smooth-back');
            joystickKnob.style.transform = '';
            setTimeout(() => joystickKnob.classList.remove('smooth-back'), 300);
        };
        joystickKnob.addEventListener('pointerup', joyEnd);
        joystickKnob.addEventListener('pointercancel', joyEnd);
    }

    /* Joystick direction arrows — nudge the viewport; press-and-hold to repeat. */
    const PAN_PX_STEP = 30;
    const joyDirDelta = {
        up:    { x: 0, y: 1 },
        down:  { x: 0, y: -1 },
        left:  { x: 1, y: 0 },
        right: { x: -1, y: 0 },
    };
    document.querySelectorAll('[data-joydir]').forEach((arrow) => {
        const dir = arrow.dataset.joydir;
        const delta = joyDirDelta[dir];
        if (!delta) return;
        let holdTimer = null;
        let repeatTimer = null;
        const nudge = () => {
            if (rdpScaleZoom > 1) {
                zoomPanX += delta.x * PAN_PX_STEP * rdpScaleZoom;
                zoomPanY += delta.y * PAN_PX_STEP * rdpScaleZoom;
                applyFillPan();
            } else if (fitModes[fitModeIdx] === 'fill') {
                fillPanX -= delta.x * 4;
                fillPanY -= delta.y * 4;
                applyFillPan();
            }
        };
        const start = (e) => {
            e.preventDefault();
            e.stopPropagation();
            arrow.classList.add('active');
            nudge();
            /* Hold ~350ms then repeat every 90ms. */
            holdTimer = setTimeout(() => {
                repeatTimer = setInterval(nudge, 90);
            }, 350);
        };
        const stop = () => {
            arrow.classList.remove('active');
            if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
            if (repeatTimer) { clearInterval(repeatTimer); repeatTimer = null; }
        };
        arrow.addEventListener('pointerdown', start);
        arrow.addEventListener('pointerup', stop);
        arrow.addEventListener('pointercancel', stop);
        arrow.addEventListener('pointerleave', stop);
        arrow.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); nudge(); }
        });
    });

    if (ctrlAltDelBtn) {
        ctrlAltDelBtn.addEventListener('click', () => {
            if (!connected) return;
            rdpKeyDown('ControlLeft'); rdpKeyDown('AltLeft'); rdpKeyDown('Delete');
            setTimeout(() => { rdpKeyUp('Delete'); rdpKeyUp('AltLeft'); rdpKeyUp('ControlLeft'); }, 80);
        });
    }

    if (reconnectBtn) {
        reconnectBtn.addEventListener('click', () => {
            rdpReconnectAttempts = 0;
            reconnectWithSettings({ reason: 'manual-reconnect' }).catch((error) => {
                console.warn('[rdp-wasm] manual reconnect failed:', error);
            });
        });
    }

    if (disconnectBtn) {
        disconnectBtn.addEventListener('click', () => {
            disconnect();
            notifyParentCloseRequest('user-disconnect');
        });
    }

    /* Notes button: postMessage to parent (app.js) to open notes filtered
     * by the current connection. Same contract as SSH/Telnet — parent runs
     * exitTerminalFullscreenThenSwitchView before notes when fullscreen. */
    const notesBtn = document.getElementById('notesBtn');
    notesBtn?.addEventListener('click', () => {
        if (!notesFeatureEnabled) {
            showNotesToast('笔记功能未开启，请在设置中启用', 'error');
            return;
        }
        if (embeddedMode && window.parent && window.parent !== window) {
            window.parent.postMessage({
                source: 'zephyr-terminal',
                type: 'open-notes-for-connection',
                tabId: params?.tabId || tabId,
                connectionId: params?.connectionId || urlParams.get('connectionId') || '',
            }, '*');
        } else {
            showNotesToast('笔记面板需要在应用主界面打开');
        }
    });


    /* Shortcut grid buttons */
    const shortcutGrid = $('#shortcutGrid');
    if (shortcutGrid) {
        shortcutGrid.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-keyseq]');
            if (btn) sendKeySequence(btn.dataset.keyseq);
        });
    }

    /* Clipboard panel buttons */
    const clipSendBtn = $('#clipboardSendBtn');
    const clipReadBtn = $('#clipboardReadLocalBtn');
    const clipCopyBtn = $('#clipboardCopyRemoteBtn');
    if (clipSendBtn) {
        clipSendBtn.addEventListener('click', () => {
            const text = clipboardText?.value || '';
            if (text && connected) {
                rdpClipboardChanged(text);
                setClipboardHint('已发送到远程', 'success');
            }
        });
    }
    if (clipReadBtn) {
        clipReadBtn.addEventListener('click', async () => {
            try {
                const text = await navigator.clipboard.readText();
                if (clipboardText) clipboardText.value = text || '';
                setClipboardHint('已读取本机剪贴板', 'success');
            } catch { setClipboardHint('读取剪贴板失败', 'warning'); }
        });
    }
    if (clipCopyBtn) {
        clipCopyBtn.addEventListener('click', async () => {
            const text = remoteClipboardText?.value || '';
            if (!text) return;
            try {
                await navigator.clipboard.writeText(text);
                setClipboardHint('已复制到本机', 'success');
            } catch { setClipboardHint('复制失败', 'warning'); }
        });
    }

    /* Resolution button — density tiers (aspect always follows the screen). */
    const resolutions = ['auto', '1080p', '2K', '4K'];
    const resLabels = { 'auto': t('自动'), '1080p': '1080p', '2K': '2K', '4K': '4K' };
    /* Map legacy WxH values from old saved sessions to new tier names. */
    const legacyMap = { '1920x1080': '1080p', '2560x1440': '2K', '3840x2160': '4K', '7680x4320': '8K' };
    const currentRes = params.rdpResolution === '8K'
        ? '4K'
        : legacyMap[params.rdpResolution] || params.rdpResolution || '1080p';
    let resIdx = resolutions.indexOf(currentRes);
    if (resIdx < 0) resIdx = 1; /* default 1080p */
    if (resolutionBtn) {
        resolutionBtn.textContent = resLabels[resolutions[resIdx]] || t('自动');
        resolutionBtn.addEventListener('click', () => {
            resIdx = (resIdx + 1) % resolutions.length;
            resolutionBtn.textContent = resLabels[resolutions[resIdx]] || resolutions[resIdx];
            params.rdpResolution = resolutions[resIdx];
            persistSessionParams({ rdpResolution: params.rdpResolution });
            /* Apply the new density tier through MS-RDPEDISP without dropping
             * the active session. The same coordinator also handles fullscreen
             * and orientation/container changes. */
            if (connected) {
                scheduleLiveRdpResize({ delay: 0, resetRetry: true });
            }
        });
    }
} // end initToolbar

/* ═══════════════════════════════════════════════════════════════════════
 * RDP FILE PANEL — Upload / Download / Cross-tab clipboard
 * ═══════════════════════════════════════════════════════════════════════ */

function initFilePanel() {
    const filesPanel = document.getElementById('filesPanel');
    const rdpFileSelectBtn = document.getElementById('rdpFileSelectBtn');
    const rdpFileInput = document.getElementById('rdpFileInput');
    const rdpPendingPasteBtn = document.getElementById('rdpPendingPasteBtn');
    const rdpFilePasteToRemoteBtn = document.getElementById('rdpFilePasteToRemoteBtn');
    const rdpFileDownloadAllBtn = document.getElementById('rdpFileDownloadAllBtn');
    const rdpPendingFileList = document.getElementById('rdpPendingFileList');
    const rdpRemoteFileList = document.getElementById('rdpRemoteFileList');
    const filesHint = document.getElementById('filesHint');

    /* Pending cross-tab clipboard (metadata only until user pastes). */
    let pendingCrossTabFiles = [];
    let pendingCrossTabSource = '';

    /* ── Upload files button ── */
    if (rdpFileSelectBtn) {
        rdpFileSelectBtn.addEventListener('click', () => {
            if (rdpFileInput) rdpFileInput.click();
            else rdpStoragePickFiles().then(updatePendingFileList);
        });
    }
    if (rdpFileInput) {
        rdpFileInput.addEventListener('change', async () => {
            const added = [];
            for (const file of rdpFileInput.files) {
                const data = new Uint8Array(await file.arrayBuffer());
                rdpStorageFiles.push({ name: file.name, size: file.size, isDir: false, data });
                added.push({ name: file.name, size: file.size, data });
            }
            rdpFileInput.value = '';
            updatePendingFileList();
            try {
                // Wait until Worker has the bytes, then advertise cliprdr formats.
                await syncLocalFilesToRemote({ advertise: connected });
                setFilesHint(
                    connected
                        ? `已添加 ${added.length} 个文件；在 Windows 里 Ctrl+V / 右键粘贴`
                        : `已添加 ${added.length} 个文件到待粘贴列表`,
                    'success',
                );
            } catch (err) {
                setFilesHint('同步文件失败: ' + (err?.message || err), 'warning');
            }
            broadcastFileMetaToParent(added);
        });
    }

    /* ── Paste pending files to remote (advertise via CLIPRDR FileGroupDescriptorW) ── */
    if (rdpPendingPasteBtn) {
        rdpPendingPasteBtn.addEventListener('click', async () => {
            if (!rdpStorageFiles.length) {
                setFilesHint('请先上传文件', 'warning');
                return;
            }
            try {
                await syncLocalFilesToRemote({ advertise: true });
                setFilesHint('已通知远程桌面，在 Windows 中右键 → 粘贴即可', 'success');
            } catch (err) {
                setFilesHint('同步文件失败: ' + (err?.message || err), 'warning');
            }
        });
    }

    /* ── "粘贴到远程" for remote-clipboard files — consume cross-tab on demand ── */
    if (rdpFilePasteToRemoteBtn) {
        rdpFilePasteToRemoteBtn.addEventListener('click', async () => {
            if (pendingCrossTabFiles.length || pendingCrossTabSource) {
                await consumePendingCrossTabFiles();
                return;
            }
            if (rdpStorageFiles.length) {
                try {
                    await syncLocalFilesToRemote({ advertise: true });
                    setFilesHint('已通知远程桌面有文件可粘贴', 'success');
                } catch (err) {
                    setFilesHint('同步文件失败: ' + (err?.message || err), 'warning');
                }
                return;
            }
            window.parent?.postMessage?.({
                source: 'zephyr-terminal',
                type: 'shared-file-clipboard-consume',
                tabId: params.tabId || '',
                sourceTabId: '',
                sourcePage: '',
                files: [],
            }, '*');
            setFilesHint('正在获取跨标签文件...', 'info');
        });
    }

    /* ── Download all remote clipboard files ── */
    if (rdpFileDownloadAllBtn) {
        rdpFileDownloadAllBtn.addEventListener('click', async () => {
            const files = selectedPipeline === 'worker-gpu-v2'
                ? await rdpWorkerBridge.call('rdpGetServerFiles', []).catch(() => null)
                : (typeof rdpGetServerFiles === 'function' ? rdpGetServerFiles() : null);
            if (!files || !files.length) {
                setFilesHint('远程剪贴板暂无文件', 'warning');
                return;
            }
            setFilesHint('正在下载 ' + files.length + ' 个文件...', 'info');
            for (let i = 0; i < files.length; i++) {
                await downloadServerFileAsync(i, files[i].name || ('file_' + i));
            }
            setFilesHint('下载完成', 'success');
        });
    }

        async function syncLocalFilesToRemote({ advertise = false } = {}) {
        if (!rdpWorkerBridge) throw new Error(t('RDP Worker 未就绪'));
        await rdpWorkerBridge.setLocalFiles(rdpStorageFiles, {
            notify: !!advertise && connected,
        });
    }

    function updatePendingFileList() {
        if (!rdpPendingFileList) return;
        if (!rdpStorageFiles.length) {
            rdpPendingFileList.innerHTML = `<div class="rdp-file-empty">${t('暂无待粘贴文件')}</div>`;
            return;
        }
        rdpPendingFileList.innerHTML = rdpStorageFiles.map((f, i) =>
            '<div class="rdp-file-item">' +
            '<span class="rdp-file-name">' + escapeHtml(f.name) + '</span>' +
            '<span class="rdp-file-size">' + formatBytes(f.size) + '</span>' +
            '<button class="rdp-file-remove" data-idx="' + i + '" title="' + t('移除') + '">×</button>' +
            '</div>'
        ).join('');
        rdpPendingFileList.querySelectorAll('.rdp-file-remove').forEach((btn) => {
            btn.addEventListener('click', async () => {
                rdpStorageFiles.splice(Number(btn.dataset.idx), 1);
                try {
                    await syncLocalFilesToRemote({ advertise: connected && rdpStorageFiles.length > 0 });
                } catch (err) {
                    console.warn('[rdp] resync after remove failed', err);
                }
                updatePendingFileList();
            });
        });
    }

    function setFilesHint(msg, level) {
        if (!filesHint) return;
        filesHint.textContent = msg;
        filesHint.dataset.level = level || '';
    }

    function escapeHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
    function formatBytes(b) {
        if (b < 1024) return b + ' B';
        if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
        return (b / 1048576).toFixed(1) + ' MB';
    }

    /* Async wrapper for rdpDownloadServerFile (Go callback-based). */
    function downloadServerFileBytes(index) {
        return new Promise((resolve, reject) => {
            if (typeof rdpDownloadServerFile !== 'function') {
                reject(new Error(t('WASM 未就绪')));
                return;
            }
            let settled = false;
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                reject(new Error('download timeout'));
            }, 30000);
            rdpDownloadServerFile(index, (data) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (data && data.byteLength > 0) {
                    resolve(data instanceof Uint8Array ? data : new Uint8Array(data));
                } else {
                    reject(new Error('empty response'));
                }
            });
        });
    }

    function downloadServerFileAsync(index, fileName) {
        return downloadServerFileBytes(index).then((bytes) => {
            const blob = new Blob([bytes]);
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = fileName || ('file_' + index);
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
            setFilesHint('已下载: ' + (fileName || index), 'success');
            return bytes;
        }).catch((err) => {
            setFilesHint('下载文件 ' + (fileName || index) + ' 失败: ' + (err?.message || err), 'warning');
            throw err;
        });
    }

    /* Notify parent (app.js) that we have files available — metadata only,
     * no actual file data. Real data is sent on-demand when another tab
     * consumes (pastes) via shared-file-clipboard-consume → read → data. */
    function broadcastFileMetaToParent(fileList) {
        if (!fileList.length) return;
        const meta = fileList.map(f => ({ name: f.name, size: f.size || 0, path: f.name }));
        window.parent?.postMessage?.({
            source: 'zephyr-terminal',
            type: 'shared-file-clipboard',
            tabId: params.tabId || '',
            files: meta,
        }, '*');
    }

    /* Send file data to parent via server-side transit (streaming, supports
     * any file size). Each file is uploaded to /api/clipboard/upload, and the
     * download URL is sent in the message instead of a base64 dataUrl. */
    async function broadcastFileDataToParent(fileList, requestId) {
        const results = [];
        for (const f of fileList || []) {
            // 1) Local pending files already in this RDP tab.
            const entry = rdpStorageFiles.find((s) => s.name === f.name && s.data);
            if (entry?.data) {
                try {
                    const info = await fetch('/api/clipboard/upload?name=' + encodeURIComponent(f.name), {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/octet-stream' },
                        body: entry.data,
                    }).then((r) => r.json());
                    results.push({ name: f.name, size: entry.size || 0, path: f.name, transitUrl: info.url });
                    continue;
                } catch {
                    results.push({ name: f.name || 'file', size: f.size || 0, error: 'upload failed' });
                    continue;
                }
            }
            // 2) Remote Windows clipboard files: download via cliprdr then transit.
            const remoteList = Array.isArray(window.__rdpRemoteFilesCache) ? window.__rdpRemoteFilesCache : [];
            const remoteIdx = remoteList.findIndex((r) => r.name === f.name);
            if (remoteIdx >= 0) {
                try {
                    const bytes = await downloadServerFileBytes(remoteIdx);
                    const info = await fetch('/api/clipboard/upload?name=' + encodeURIComponent(f.name || remoteList[remoteIdx].name || 'file'), {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/octet-stream' },
                        body: bytes,
                    }).then((r) => r.json());
                    results.push({
                        name: f.name || remoteList[remoteIdx].name || 'file',
                        size: bytes.byteLength,
                        path: f.name || remoteList[remoteIdx].name || 'file',
                        transitUrl: info.url,
                    });
                    continue;
                } catch (err) {
                    results.push({ name: f.name || 'file', size: f.size || 0, error: err?.message || 'download failed' });
                    continue;
                }
            }
            results.push({ name: f.name || 'file', size: f.size || 0, error: 'data not available in this tab' });
        }
        window.parent?.postMessage?.({
            source: 'zephyr-terminal',
            type: 'shared-file-clipboard-data',
            tabId: params.tabId || '',
            requestId: requestId || '',
            files: results,
        }, '*');
    }

    /* ── Cross-tab clipboard: listen for files from SSH/other RDP tabs ── */
    window.addEventListener('message', (e) => {
        if (!e.data || e.data.source !== 'zephyr-app') return;
        if (e.data.type === 'shared-file-clipboard-data' && Array.isArray(e.data.files)) {
            ingestCrossTabFiles(e.data.files, { sourceTabId: e.data.sourceTabId || '' });
        } else if (e.data.type === 'shared-file-clipboard-available') {
            if (Array.isArray(e.data.files) && e.data.files.length) {
                pendingCrossTabFiles = e.data.files.slice();
                pendingCrossTabSource = e.data.sourceTabId || '';
                setFilesHint(
                    `其他标签复制了 ${e.data.files.length} 个文件，点击「粘贴到远程」获取`,
                    'info',
                );
                if (filesPanel && !filesPanel.classList.contains('open') && rdpFilesBtn) {
                    try {
                        openFloatingPanel(filesPanel, rdpFilesBtn, {
                            kind: 'files',
                            defaults: { width: 360, height: 480, right: 16, top: 56 },
                            refresh: () => updatePendingFileList(),
                        });
                    } catch {}
                }
            }
        } else if (e.data.type === 'shared-file-clipboard-read') {
            broadcastFileDataToParent(e.data.files || [], e.data.requestId || '');
        }
    });

    async function ingestCrossTabFiles(fileList, { sourceTabId = '' } = {}) {
        if (!Array.isArray(fileList) || !fileList.length) return 0;
        let accepted = 0;
        for (const f of fileList) {
            try {
                let bytes = null;
                if (f.transitUrl || f.dataUrl) {
                    const resp = await fetch(f.transitUrl || f.dataUrl);
                    if (!resp.ok) throw new Error('HTTP ' + resp.status);
                    bytes = new Uint8Array(await resp.arrayBuffer());
                } else if (f.remotePath) {
                    const resp = await fetch('/api/clipboard-file?' + new URLSearchParams({
                        path: f.remotePath,
                        name: f.name || '',
                    }));
                    if (!resp.ok) throw new Error('HTTP ' + resp.status);
                    bytes = new Uint8Array(await resp.arrayBuffer());
                } else {
                    pendingCrossTabFiles.push(f);
                    pendingCrossTabSource = sourceTabId || pendingCrossTabSource;
                    continue;
                }
                rdpStorageFiles = rdpStorageFiles.filter((x) => x.name !== (f.name || 'file'));
                rdpStorageFiles.push({
                    name: f.name || 'file',
                    size: bytes.byteLength,
                    isDir: false,
                    data: bytes,
                });
                accepted += 1;
            } catch (err) {
                setFilesHint('接收文件失败: ' + (f.name || '') + ' ' + (err?.message || err), 'warning');
            }
        }
        updatePendingFileList();
        if (accepted > 0) {
            try {
                if (rdpWorkerBridge) {
                    await rdpWorkerBridge.setLocalFiles(rdpStorageFiles, { notify: connected });
                }
            } catch (err) {
                console.warn('[rdp] cross-tab file sync failed', err);
            }
            setFilesHint(
                connected
                    ? `已接收 ${accepted} 个文件，可在 Windows 里 Ctrl+V 粘贴`
                    : `已接收 ${accepted} 个文件到待粘贴列表`,
                'success',
            );
        }
        return accepted;
    }

    async function consumePendingCrossTabFiles() {
        const files = pendingCrossTabFiles.length ? pendingCrossTabFiles.slice() : [];
        const sourceTabId = pendingCrossTabSource || '';
        setFilesHint('正在获取跨标签文件...', 'info');
        window.parent?.postMessage?.({
            source: 'zephyr-terminal',
            type: 'shared-file-clipboard-consume',
            tabId: params.tabId || '',
            sourceTabId,
            sourcePage: '',
            files,
        }, '*');
        pendingCrossTabFiles = [];
        pendingCrossTabSource = '';
    }

    /* Request any existing shared clipboard on startup */
    window.parent?.postMessage?.({ source: 'zephyr-terminal', type: 'request-shared-file-clipboard', tabId: params.tabId || '' }, '*');

    /* Go WASM calls this when server advertises files on clipboard */
    window.rdpOnRemoteFiles = function (filesArr) {
        if (!rdpRemoteFileList) return;
        window.__rdpRemoteFilesCache = Array.isArray(filesArr) ? filesArr : [];
        if (!filesArr || !filesArr.length) {
            rdpRemoteFileList.innerHTML = `<div class="rdp-file-empty">${t('远程剪贴板暂无文件')}</div>`;
            return;
        }
        rdpRemoteFileList.innerHTML = '';
        for (let i = 0; i < filesArr.length; i++) {
            const f = filesArr[i];
            const div = document.createElement('div');
            div.className = 'rdp-file-item';
            div.innerHTML = '<span class="rdp-file-name">' + escapeHtml(f.name || '') + '</span>' +
                '<span class="rdp-file-size">' + formatBytes(Number(f.size) || 0) + '</span>' +
                '<button class="rdp-file-download-btn" data-idx="' + i + '" title="' + t('下载') + '">⬇</button>';
            rdpRemoteFileList.appendChild(div);
        }
        rdpRemoteFileList.querySelectorAll('.rdp-file-download-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                const idx = Number(btn.dataset.idx);
                downloadServerFileAsync(idx, filesArr[idx]?.name || 'file');
            });
        });
        setFilesHint('远程剪贴板有 ' + filesArr.length + ' 个文件', 'success');
        // Tell sibling SSH/RDP tabs a Windows clipboard file list is available.
        try {
            broadcastFileMetaToParent(filesArr.map((f) => ({
                name: f.name || 'file',
                size: Number(f.size) || 0,
                path: f.name || 'file',
                source: 'rdp-remote',
            })));
        } catch (err) {
            console.warn('[rdp] broadcast remote files failed', err);
        }
    };

    /* When RDP clipboard receives text from remote, broadcast to other tabs.
     * Mark with origin:'remote' so the parent can suppress re-broadcast to
     * avoid feedback loops (Tab A remote -> parent -> Tab B -> remote -> parent -> ...). */
    const origOnClipboard = window.rdpOnClipboard;
    window.rdpOnClipboard = function (text) {
        if (origOnClipboard) origOnClipboard(text);
        /* Forward to parent (app.js) for cross-tab sync */
        window.parent?.postMessage?.({ source: 'zephyr-terminal', type: 'shared-clipboard-text', text, tabId: params.tabId || '', origin: 'remote' }, '*');
    };
}


/* ═══════════════════════════════════════════════════════════════════════
 * PARENT MESSAGE HANDLER (embedded mode)
 * ═══════════════════════════════════════════════════════════════════════ */
window.addEventListener('message', (e) => {
    if (!e.data || e.data.source !== 'zephyr-app') return;
    const msg = e.data;
    if (msg.type === 'ai-remote-desktop-cert-status') {
        const actionId = String(msg.actionId || '');
        try {
            const cert = getRdpCertDialogStateForAi();
            notifyParentAiActionResult(actionId, { ok: true, control: 'cert_status', result: { cert }, cert });
        } catch (err) {
            notifyParentAiActionResult(actionId, { ok: false, control: 'cert_status', error: err.message || String(err), code: err.code || '' });
        }
        return;
    }
    if (msg.type === 'ai-remote-desktop-cert-decide') {
        const actionId = String(msg.actionId || '');
        try {
            const cert = decideCertDialogFromAi(msg);
            notifyParentAiActionResult(actionId, {
                ok: true,
                control: 'cert_decide',
                result: { cert, decision: String(msg.decision || '') === 'reject' ? 'reject' : 'accept', remember: msg.remember === true },
                cert,
            });
        } catch (err) {
            console.warn('[rdp-client]', 'AI cert decide failed', { error: err.message });
            notifyParentAiActionResult(actionId, { ok: false, control: 'cert_decide', error: err.message || t('AI 证书决策失败'), code: err.code || '' });
        }
        return;
    }
    if (msg.type === 'ai-remote-desktop-action') {
        const actionId = String(msg.actionId || '');
        performAiRemoteDesktopAction(msg).then((result = {}) => {
            notifyParentAiActionResult(actionId, { ok: true, control: msg.control || '', result });
        }).catch((err) => {
            console.warn('[rdp-client]', 'AI remote desktop action failed', { error: err.message, control: msg.control });
            setClipboardHint(err.message || t('AI 远程桌面操作失败'), 'error');
            notifyParentAiActionResult(actionId, { ok: false, control: msg.control || '', error: err.message || t('AI 远程桌面操作失败'), code: err.code || '' });
        });
        return;
    }
    if (msg.type === 'theme-change') {
        applyFrameTheme(msg.theme, msg.appearance);
    } else if (msg.type === 'shared-clipboard-text' && msg.text && connected) {
        /* Text arrived from another tab's remote clipboard.  Sync it to our
         * remote without re-broadcasting (the Go-side suppress counter will
         * absorb the local change notification that this triggers). */
        rdpClipboardChanged(msg.text);
    } else if (msg.type === 'params-update') {
        params = { ...params, ...msg.params };
    } else if (msg.type === 'notes-enabled') {
        applyNotesFeatureEnabled(!!msg.enabled);
    }
});


/* ═══════════════════════════════════════════════════════════════════════
 * BOOT
 * ═══════════════════════════════════════════════════════════════════════ */
(async function boot() {
    updateInfo();
    initToolbar();
    initFilePanel();
    loadRemoteNotesSettings();
    // render20 no longer navigates the iframe for resize reconnects. Discard
    // any transition snapshot left by the legacy reload path.
    try { sessionStorage.removeItem(RDP_TRANSITION_FRAME_KEY); } catch {}

    /* Compute initial resolution */
    const size = computeRdpSize();
    rdpWidth = size.width;
    rdpHeight = size.height;
    ensureCanvas(rdpWidth, rdpHeight);
    initLiveRdpResize();

    /* Worker GPU is mandatory: no page-thread WASM, Canvas2D, or page GPU fallback. */
    try {
        await initializeRdpWorker();
        await connect();
    } catch (err) {
        const failedStage = err?.rdpBootStage || rdpWorkerBridge?.bootStage || 'pre-worker';
        try { rdpWorkerBridge?.close(); } catch {}
        rdpWorkerBridge = null;
        wasmReady = false;
        rdpDiag.worker = { error: err?.message || String(err), bootStage: failedStage };
        console.error('[rdp-worker] mandatory GPU boot failed:', err);
        setStatus('error', `RDP Worker GPU 启动失败 [${failedStage}]: ${err.message || err}`);
    }
})();
