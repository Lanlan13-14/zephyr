/**
 * rdp-wasm-client.js — Zephyr RDP Client powered by grdp WASM
 *
 * Architecture:
 *   Browser (Go WASM grdp) ── WebSocket ──► Node.js proxy ── TCP ──► RDP Server
 *
 * The Go WASM module handles the entire RDP protocol (bitmap decode, H.264,
 * cursor, keyboard, clipboard, audio).  The server is a dumb WS→TCP proxy.
 * All rendering happens client-side via Canvas 2D putImageData and WebCodecs.
 */

import { applyZephyrColorScheme } from './theme-runtime.js?v=20260630-rdp-engine';
import { RdpTouchController } from './rdp-touch.js?v=20260704';

const $ = (sel) => document.querySelector(sel);
const urlParams = new URLSearchParams(location.search);
const embeddedMode = urlParams.get('embed') === '1';
const tabId = urlParams.get('tabId') || '';

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

/* Canvas & scaling */
let rdpCanvas = null;
let rdpCtx2d = null;
let rdpWidth = 0;
let rdpHeight = 0;

/* fit/zoom */
const fitModes = ['adapt', 'original', 'fill'];
let fitModeIdx = 0;
let rdpScaleZoom = 1;

/* Fill mode viewport panning (0-100%) */
let fillPanX = 50; /* center */
let fillPanY = 50;

/* Quality/FPS — kept for UI compat; WASM grdp doesn't need these */
const qualityModes = ['balanced', 'performance', 'quality'];
let qualityMode = 'balanced';
const fpsModes = [30, 45, 60, 120, 144];
let fpsValue = 60;

/* Audio */
let audioCtx = null;
let audioNextAt = 0;
/* Live-stream audio scheduling. Video is drawn immediately on H.264 decode
 * (zero buffer), so audio latency directly determines lip-sync offset. Keep a
 * small jitter buffer to avoid underruns on LAN, and a tight ceiling so audio
 * can never drift more than a few hundred ms behind the picture. */
const AUDIO_MIN_LATENCY = 0.08; /* target buffer ahead of playhead (80ms) */
const AUDIO_MAX_QUEUE = 0.30;   /* hard resync ceiling — bounds A/V desync */

/* H.264 WebCodecs */
let h264Dec = null;
let h264Timestamp = 0;
const h264FramePos = new Map();

/* Pointer cache */
const pointerCache = new Map();

/* ─── Diagnostics (kept for ABR compat, no HUD) ──────────────────────── */
const rdpDiag = { renderer: 'wasm-canvas2d', codec: 'bitmap', fps: 0, frames: 0, lastFrameAt: 0 };
function notePresentedFrame() {
    const now = performance.now();
    const dt = rdpDiag.lastFrameAt ? now - rdpDiag.lastFrameAt : 0;
    const inst = dt > 0 ? 1000 / dt : 0;
    rdpDiag.fps = rdpDiag.fps ? rdpDiag.fps * 0.85 + inst * 0.15 : inst;
    rdpDiag.frames++;
    rdpDiag.lastFrameAt = now;
}

/* ═══════════════════════════════════════════════════════════════════════
 * WASM BOOTSTRAP
 * ═══════════════════════════════════════════════════════════════════════ */

async function loadWasm() {
    setStatus('connecting', '加载 RDP WASM 引擎...');
    const go = new Go();
    const result = await WebAssembly.instantiateStreaming(
        fetch('vendor/rdp-wasm/main.wasm?v=' + Date.now()),
        go.importObject,
    );
    go.run(result.instance);
    wasmReady = true;
    console.info('[rdp-wasm] WASM engine loaded');
}

/* ═══════════════════════════════════════════════════════════════════════
 * WASM → JS CALLBACKS (called by Go code)
 * ═══════════════════════════════════════════════════════════════════════ */

/* Called by Go when RDP session is ready */
window.rdpOnReady = function () {
    setStatus('connected', 'RDP 已连接');
    connected = true;
    rdpReconnectAttempts = 0;
    notifyParentStatus('connected');
    if (rdpCanvas) rdpCanvas.focus();
};

/* Called by Go on error */
window.rdpOnError = function (msg) {
    console.warn('[rdp-wasm] error:', msg);
    if (connected) {
        setStatus('error', `RDP 错误: ${msg}`);
        connected = false;
        notifyParentStatus('error');
        maybeAutoReconnect();
    } else {
        setStatus('error', `RDP 连接失败: ${msg}`);
    }
};

/* Called by Go on connection close */
window.rdpOnClose = function () {
    console.info('[rdp-wasm] connection closed');
    if (connected) {
        connected = false;
        setStatus('disconnected', '连接已断开');
        notifyParentStatus('closed');
        cleanupAudio();
        cleanupH264();
        maybeAutoReconnect();
    }
};

/* Called by Go with clipboard text from remote */
window.rdpOnClipboard = function (text) {
    if (!rdpClipboardEnabled) return;
    lastRemoteClipboard = text || '';
    if (remoteClipboardText) remoteClipboardText.value = text || '';
    if (clipboardHint) {
        clipboardHint.textContent = '已收到远程剪贴板';
        clipboardHint.dataset.level = 'success';
    }
    notifyParentSharedClipboardText(text);
    // Auto-write to system clipboard
    if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).catch(() => {});
    }
};

/* Called by Go with raw PCM audio data */
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
    const src = audioCtx.createBufferSource();
    src.buffer = audioBuf;
    src.connect(audioCtx.destination);
    const now = audioCtx.currentTime;
    /* If we've fallen behind (underrun) or drifted too far ahead of the video,
     * resync to a small fixed latency. This bounds lip-sync error to at most
     * AUDIO_MAX_QUEUE seconds regardless of how the server bursts audio. */
    if (audioNextAt < now + AUDIO_MIN_LATENCY || audioNextAt > now + AUDIO_MAX_QUEUE) {
        audioNextAt = now + AUDIO_MIN_LATENCY;
    }
    src.start(audioNextAt);
    audioNextAt += audioBuf.duration;
};

/* Called by Go with raw H.264 NAL data — each call may be a different tile */
let h264CallCount = 0;
let h264ErrorLog = [];
let h264InfoLog = [];
window.rdpOnH264 = function (destX, destY, w, h, isKey, uint8Data) {
    if (!h264Dec || h264Dec.state === 'closed') return;
    h264CallCount++;
    if (h264CallCount <= 10) {
        const firstBytes = Array.from(uint8Data.slice(0, 12)).map(b => b.toString(16).padStart(2,'0')).join(' ');
        h264InfoLog.push('onH264 #' + h264CallCount + ' dest=(' + destX + ',' + destY + ') size=' + w + 'x' + h + ' isKey=' + isKey + ' len=' + uint8Data.length + ' first12=' + firstBytes + ' state=' + h264Dec.state);
    }

    h264Timestamp += 1000;
    h264FramePos.set(h264Timestamp, { x: destX, y: destY });
    try {
        h264Dec.decode(new EncodedVideoChunk({
            type: isKey ? 'key' : 'delta',
            timestamp: h264Timestamp,
            data: uint8Data,
        }));
    } catch (e) {
        console.warn('[rdp-wasm] H.264 decode error:', e);
    }
};

/* ─── Pointer callbacks ──────────────────────────────────────────────── */
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

/* ═══════════════════════════════════════════════════════════════════════
 * H.264 WEBCODECS
 * ═══════════════════════════════════════════════════════════════════════ */
/* ═══════════════════════════════════════════════════════════════════════
 * H.264 WEBCODECS — per-tile decoder that handles varying dimensions
 * ═══════════════════════════════════════════════════════════════════════ */
function h264Supported() {
    return typeof VideoDecoder !== 'undefined' && typeof EncodedVideoChunk !== 'undefined';
}

/* RDP AVC420 sends H.264 tiles. Configure the decoder WITHOUT fixed
 * codedWidth/codedHeight so it reads dimensions from the H.264 SPS NAL
 * in each bitstream. This handles tiles of any size without reconfiguring. */

function createH264Decoder() {
    if (!h264Supported()) return null;
    let frameCount = 0;
    let errorCount = 0;
    h264InfoLog = [];
    h264ErrorLog = [];
    h264CallCount = 0;
    const decoder = new VideoDecoder({
        output(frame) {
            frameCount++;
            const pos = h264FramePos.get(frame.timestamp);
            h264FramePos.delete(frame.timestamp);
            const x = pos ? pos.x : 0;
            const y = pos ? pos.y : 0;
            if (rdpCtx2d) rdpCtx2d.drawImage(frame, x, y);
            if (frameCount <= 5) h264InfoLog.push('decoded #' + frameCount + ' pos=(' + x + ',' + y + ') coded=' + frame.codedWidth + 'x' + frame.codedHeight + ' display=' + frame.displayWidth + 'x' + frame.displayHeight);
            frame.close();
            notePresentedFrame();
        },
        error(e) {
            errorCount++;
            if (errorCount <= 20) h264ErrorLog.push('ERROR #' + errorCount + ': ' + (e.message || e));
        },
    });
    decoder.configure({
        codec: 'avc1.42E01E',
        optimizeForLatency: true,
    });
    h264InfoLog.push('decoder created, state=' + decoder.state);
    /* Expose logs for remote retrieval */
    window._h264Logs = () => JSON.stringify({ info: h264InfoLog, errors: h264ErrorLog, calls: h264CallCount, frames: frameCount });
    return decoder;
}

function cleanupH264() {
    if (h264Dec) { try { h264Dec.close(); } catch {} h264Dec = null; }
    h264FramePos.clear();
    h264Timestamp = 0;
}

function cleanupAudio() {
    if (audioCtx) { try { audioCtx.close(); } catch {} audioCtx = null; audioNextAt = 0; }
}

/* ═══════════════════════════════════════════════════════════════════════
 * MICROPHONE INPUT (AUDIN) — browser getUserMedia → Go WASM → RDP server
 * ═══════════════════════════════════════════════════════════════════════ */
let audinStream = null;
let audinProcessor = null;
let audinContext = null;

/* Called from Go WASM when the server requests microphone capture */
window.rdpAudinStart = function (sampleRate, channels, bitsPerSample, framesPerPacket) {
    console.info('[rdp-audin] start', { sampleRate, channels, bitsPerSample, framesPerPacket });
    rdpAudinStopInternal();
    const bufferSize = Math.max(256, Math.min(16384, framesPerPacket || 4096));
    navigator.mediaDevices.getUserMedia({ audio: { sampleRate, channelCount: channels, echoCancellation: true, noiseSuppression: true } })
        .then((stream) => {
            audinStream = stream;
            audinContext = new AudioContext({ sampleRate });
            const source = audinContext.createMediaStreamSource(stream);
            audinProcessor = audinContext.createScriptProcessor(bufferSize, channels, channels);
            audinProcessor.onaudioprocess = (e) => {
                if (typeof rdpAudinData === 'undefined') return;
                /* Convert Float32 → Int16 PCM */
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
            console.info('[rdp-audin] capture started', { sampleRate: audinContext.sampleRate, bufferSize });
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

function showCertDialog(certInfo, connectionId) {
    return new Promise((resolve) => {
        const dialog = document.getElementById('rdpCertDialog');
        if (!dialog) { resolve(true); return; }

        /* Populate content */
        const hostEl = document.getElementById('certHost');
        const subjectEl = document.getElementById('certSubject');
        const reasonsEl = document.getElementById('certReasons');
        const rememberEl = document.getElementById('certRemember');

        if (hostEl) hostEl.textContent = (certInfo.host || '') + ':' + (certInfo.port || 3389);
        if (subjectEl) subjectEl.textContent = certInfo.subject || certInfo.host || '(未知)';
        if (reasonsEl) {
            const reasons = (certInfo.reasons && certInfo.reasons.length) ? certInfo.reasons : ['不是来自受信任的认证机构'];
            reasonsEl.innerHTML = reasons.map((r) => '<li>' + escapeHtml(r) + '</li>').join('');
        }
        if (rememberEl) rememberEl.checked = false;

        /* Show dialog */
        dialog.classList.add('visible');

        /* Create fresh buttons to guarantee no stale listeners */
        const actionsDiv = dialog.querySelector('.rdp-cert-actions');
        if (!actionsDiv) { resolve(true); return; }
        actionsDiv.innerHTML = '<button class="rdp-cert-btn rdp-cert-btn-cancel" id="certCancelBtn">取消</button><button class="rdp-cert-btn rdp-cert-btn-connect" id="certConnectBtn">连接</button>';
        const cancelBtn = document.getElementById('certCancelBtn');
        const connectBtn = document.getElementById('certConnectBtn');

        let settled = false;
        cancelBtn.onclick = () => {
            if (settled) return; settled = true;
            dialog.classList.remove('visible');
            resolve(false);
        };
        connectBtn.onclick = () => {
            if (settled) return; settled = true;
            if (rememberEl?.checked) trustCert(connectionId);
            dialog.classList.remove('visible');
            resolve(true);
        };
    });
}

/* ═══════════════════════════════════════════════════════════════════════
 * CONNECT / DISCONNECT
 * ═══════════════════════════════════════════════════════════════════════ */
function proxyWsUrl() {
    return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
}

async function connect() {
    if (!wasmReady) await loadWasm();

    /* Clean up any existing connection first */
    try { rdpDisconnect(); } catch {}
    rdpManualDisconnect = false;
    cleanupH264();
    cleanupAudio();
    rdpAudinStopInternal();
    rdpLocationStopInternal();
    rdpCameraStopInternal();
    pointerCache.clear();
    connected = false;

    const width = rdpWidth || 1920;
    const height = rdpHeight || 1080;

    /* Create canvas */
    ensureCanvas(width, height);

    /* Init audio in user-gesture context */
    audioCtx = new AudioContext({ latencyHint: 'playback' });
    audioNextAt = 0;

    /* Init H.264 */
    if (h264Supported()) h264Dec = createH264Decoder();

    setStatus('connecting', '正在获取 RDP 凭据...');

    /* Fetch credentials from server (password never stored on client) */
    const connectionId = params.connectionId || urlParams.get('connectionId') || '';
    let host, port, domain, user, password;
    let rdpSoundMode = 'local';
    let rdpClipboardEnabled = true;

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
            rdpClipboardEnabled = cred.rdpClipboard !== false && params.rdpClipboard !== false;
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
        rdpClipboardEnabled = params.rdpClipboard !== false;
    }

    /* Apply sound mode setting */
    if (rdpSoundMode === 'off') {
        cleanupAudio();
        audioCtx = null;
    }

    /* ── Certificate verification dialog ── */
    if (connectionId && !isCertTrusted(connectionId)) {
        setStatus('connecting', '正在验证远程证书...');
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
                    setStatus('disconnected', '已取消连接');
                    cleanupAudio();
                    cleanupH264();
                    notifyParentCloseRequest('cert-rejected');
                    return;
                }
            }
        } catch (err) {
            console.warn('[rdp-wasm] cert probe failed, continuing anyway:', err.message);
        }
    }

    setStatus('connecting', '正在连接 RDP...');

    /* rdpConnect is exposed by Go WASM */
    const hasWebCodecs = h264Supported();
    /* Wallpaper follows quality mode: only "quality" streams the desktop
     * background; balanced/performance keep it off to save bandwidth. */
    const wallpaperOn = qualityMode === 'quality';
    rdpConnect(proxyWsUrl(), host, port, domain, user, password, width, height, false, !!params.rdpMicrophone, !!params.rdpLocation, !!params.rdpStorage, !!params.rdpCamera, hasWebCodecs, wallpaperOn);
}

function disconnect() {
    rdpManualDisconnect = true;
    if (rdpReconnectTimer) { clearTimeout(rdpReconnectTimer); rdpReconnectTimer = null; }
    connected = false;
    try { rdpDisconnect(); } catch {}
    cleanupH264();
    cleanupAudio();
    rdpAudinStopInternal();
    rdpLocationStopInternal();
    rdpCameraStopInternal();
    setStatus('disconnected', '已断开 RDP 连接');
    notifyParentStatus('closed');
}

function maybeAutoReconnect() {
    if (rdpManualDisconnect) return;
    if (rdpReconnectAttempts >= 5) {
        setStatus('error', '重连次数已达上限');
        return;
    }
    const delay = Math.min(2000 * Math.pow(1.5, rdpReconnectAttempts), 15000);
    rdpReconnectAttempts++;
    setStatus('connecting', `${Math.round(delay / 1000)}秒后自动重连 (${rdpReconnectAttempts}/5)...`);
    rdpReconnectTimer = setTimeout(() => {
        rdpReconnectTimer = null;
        connect().catch((e) => console.warn('[rdp-wasm] reconnect failed:', e));
    }, delay);
}

/* ═══════════════════════════════════════════════════════════════════════
 * CANVAS MANAGEMENT
 * ═══════════════════════════════════════════════════════════════════════ */
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
        if (displayRoot) {
            displayRoot.innerHTML = '';
            displayRoot.appendChild(rdpCanvas);
        }
    }
    rdpCanvas.width = w;
    rdpCanvas.height = h;
    rdpCtx2d = rdpCanvas.getContext('2d');
    applyFitMode();
    attachInputEvents();
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

    rdpCanvas.addEventListener('mousemove', (e) => {
        if (!connected) return;
        const { x, y } = canvasCoords(e);
        rdpMouseMove(x, y);
    });

    rdpCanvas.addEventListener('mousedown', (e) => {
        if (!connected) return;
        e.preventDefault();
        rdpCanvas.focus();
        const { x, y } = canvasCoords(e);
        rdpMouseDown(e.button, x, y);
    });

    rdpCanvas.addEventListener('mouseup', (e) => {
        if (!connected) return;
        e.preventDefault();
        const { x, y } = canvasCoords(e);
        rdpMouseUp(e.button, x, y);
    });

    rdpCanvas.addEventListener('wheel', (e) => {
        if (!connected) return;
        e.preventDefault();
        let delta;
        if (e.deltaMode === 1) delta = -e.deltaY / 3;
        else if (e.deltaMode === 2) delta = -e.deltaY;
        else delta = -e.deltaY / 100;
        rdpMouseWheel(delta);
    }, { passive: false });

    rdpCanvas.addEventListener('contextmenu', (e) => e.preventDefault());

    /* Clipboard sync on pointer down */
    function syncClipboard() {
        if (!connected || !navigator.clipboard?.readText) return;
        clipboardSyncPromise = navigator.clipboard.readText()
            .then((text) => { if (text) rdpClipboardChanged(text); })
            .catch(() => {});
    }
    rdpCanvas.addEventListener('pointerdown', syncClipboard);

    document.addEventListener('paste', (e) => {
        if (!connected) return;
        const text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
        if (text) rdpClipboardChanged(text);
    });

    rdpCanvas.addEventListener('keydown', async (e) => {
        if (!connected) return;
        e.preventDefault();
        await clipboardSyncPromise;
        rdpKeyDown(e.code);
    });

    rdpCanvas.addEventListener('keyup', (e) => {
        if (!connected) return;
        e.preventDefault();
        rdpKeyUp(e.code);
    });

    /* ─── Touch input — uses RdpTouchController module ──── */
    if (!rdpTouchController) {
        rdpTouchController = new RdpTouchController({
            canvas: rdpCanvas,
            getConnected: () => connected,
            canvasCoords,
            sendMouseMove: (x, y) => rdpMouseMove(x, y),
            sendMouseDown: (btn, x, y) => rdpMouseDown(btn, x, y),
            sendMouseUp: (btn, x, y) => rdpMouseUp(btn, x, y),
            sendMouseWheel: (delta) => rdpMouseWheel(delta),
            onZoomChange: (zoom) => {
                rdpScaleZoom = zoom;
                if (rdpCanvas) rdpCanvas.style.transform = `scale(${zoom})`;
                const zs = document.getElementById('zoomSlider');
                const zv = document.getElementById('zoomValue');
                if (zs) zs.value = Math.round(zoom * 100);
                if (zv) zv.textContent = Math.round(zoom * 100) + '%';
            },
        });
    }

    /* ─── Mobile keyboard input (textarea mirror) ──── */
    if (mobileKeyboardInput) {
        mobileKeyboardInput.addEventListener('input', (e) => {
            if (!connected) return;
            const data = e.data;
            if (data) {
                for (const char of data) {
                    const code = keyCharToCode(char);
                    if (code) {
                        rdpKeyDown(code);
                        setTimeout(() => rdpKeyUp(code), 30);
                    }
                }
            }
        });
    }
}

/* Map single characters to JS key codes for mobile input */
function keyCharToCode(char) {
    const upper = char.toUpperCase();
    if (upper >= 'A' && upper <= 'Z') return 'Key' + upper;
    if (char >= '0' && char <= '9') return 'Digit' + char;
    const map = {
        ' ': 'Space', '\n': 'Enter', '\t': 'Tab',
        '-': 'Minus', '=': 'Equal', '[': 'BracketLeft', ']': 'BracketRight',
        '\\': 'Backslash', ';': 'Semicolon', "'": 'Quote', '`': 'Backquote',
        ',': 'Comma', '.': 'Period', '/': 'Slash',
    };
    return map[char] || null;
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
    if (connInfo) connInfo.textContent = `${name} · WASM/grdp · ${params.host || ''}:${port}`;
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
    const res = params.rdpResolution || 'auto';
    const m = res.match(/^(\d+)x(\d+)$/);

    /* Explicit resolution (e.g. 1920x1080): honour it verbatim. The user
     * picked a fixed aspect on purpose; any letterboxing is their choice. */
    if (m && res !== 'auto') {
        let w = Number(m[1]);
        let h = Number(m[2]);
        w = Math.max(800, Math.min(7680, Math.floor(w / 2) * 2));
        h = Math.max(600, Math.min(4320, Math.floor(h / 2) * 2));
        return { width: w, height: h };
    }

    /* Auto: match the display container's real aspect ratio so that
     * object-fit:contain in "adapt" mode leaves NO black bars. We do NOT
     * force landscape — a portrait phone gets a portrait remote desktop. */
    const dpr = window.devicePixelRatio || 1;
    const stage = document.getElementById('rdpStage');
    let cw = 0, ch = 0;
    if (stage) {
        const r = stage.getBoundingClientRect();
        cw = r.width; ch = r.height;
    }
    if (!cw || !ch) { cw = window.innerWidth; ch = window.innerHeight; }

    /* Target physical pixels for crispness, capped so we never exceed 4K
     * along the longer edge (bandwidth + server limits). */
    let w = Math.round(cw * dpr);
    let h = Math.round(ch * dpr);
    const longEdge = Math.max(w, h);
    const CAP = 3840;
    if (longEdge > CAP) {
        const s = CAP / longEdge;
        w = Math.round(w * s);
        h = Math.round(h * s);
    }

    /* RDP requires even dimensions and sane minimums. */
    w = Math.max(640, Math.min(7680, Math.floor(w / 2) * 2));
    h = Math.max(480, Math.min(4320, Math.floor(h / 2) * 2));
    return { width: w, height: h };
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

/* ═══════════════════════════════════════════════════════════════════════
 * TOOLBAR BUTTONS
 * ═══════════════════════════════════════════════════════════════════════ */
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

    if (qualityBtn) {
        qualityBtn.textContent = qualityMode === 'performance' ? '性能' : qualityMode === 'quality' ? '画质' : '平衡';
        qualityBtn.addEventListener('click', () => {
            const idx = qualityModes.indexOf(qualityMode);
            const prevWallpaper = qualityMode === 'quality';
            qualityMode = qualityModes[(idx + 1) % qualityModes.length];
            qualityBtn.textContent = qualityMode === 'performance' ? '性能' : qualityMode === 'quality' ? '画质' : '平衡';
            /* Wallpaper on/off is negotiated at login, so reconnect when the
             * quality change crosses the wallpaper threshold. */
            const nextWallpaper = qualityMode === 'quality';
            if (connected && prevWallpaper !== nextWallpaper) {
                setStatus('connecting', '正在应用画质设置...');
                connect().catch(() => {});
            }
        });
    }

    if (fpsBtn) {
        fpsBtn.textContent = fpsValue + 'FPS';
        fpsBtn.addEventListener('click', () => {
            const idx = fpsModes.indexOf(fpsValue);
            fpsValue = fpsModes[(idx + 1) % fpsModes.length];
            fpsBtn.textContent = fpsValue + 'FPS';
        });
    }

    if (fitBtn) {
        fitBtn.addEventListener('click', () => {
            fitModeIdx = (fitModeIdx + 1) % fitModes.length;
            const newMode = fitModes[fitModeIdx];
            fitBtn.textContent = newMode === 'original' ? '原始' : newMode === 'adapt' ? '适应' : '填充';
            applyFitMode();
        });
    }

    if (zoomSlider) {
        zoomSlider.addEventListener('input', () => {
            rdpScaleZoom = Number(zoomSlider.value) / 100;
            if (zoomValue) zoomValue.textContent = Math.round(rdpScaleZoom * 100) + '%';
            if (rdpCanvas) rdpCanvas.style.transform = `scale(${rdpScaleZoom})`;
        });
    }

    if (clipboardBtn) {
        clipboardBtn.addEventListener('click', () => {
            if (clipboardPanel) clipboardPanel.classList.toggle('open');
        });
    }

    if (rdpFilesBtn && filesPanel) {
        rdpFilesBtn.addEventListener('click', () => { filesPanel.classList.toggle('open'); });
    }

    if (keyboardBtn && mobileKeyboardInput) {
        keyboardBtn.addEventListener('click', () => {
            mobileKeyboardInput.focus();
            mobileKeyboardInput.click();
        });
    }

    if (shortcutsBtn && shortcutsPanel) {
        shortcutsBtn.addEventListener('click', () => { shortcutsPanel.classList.toggle('open'); });
    }

    if (joystickBtn && joystickPanel) {
        joystickBtn.addEventListener('click', () => { joystickPanel.classList.toggle('open'); });
    }

    /* Joystick knob — controls viewport pan in fill mode */
    const joystickKnob = document.getElementById('joystickKnob');
    const joystickContainer = document.getElementById('joystickContainer');

    /* Shared: push current fillPanX/Y to the canvas (only meaningful in fill mode). */
    const applyFillPan = () => {
        fillPanX = Math.max(0, Math.min(100, fillPanX));
        fillPanY = Math.max(0, Math.min(100, fillPanY));
        if (fitModes[fitModeIdx] === 'fill' && rdpCanvas) {
            rdpCanvas.style.objectPosition = fillPanX + '% ' + fillPanY + '%';
        }
    };

    if (joystickKnob && joystickContainer) {
        let joyDrag = null;
        const joyRadius = 50; /* max drag distance in px */
        joystickKnob.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            const rect = joystickContainer.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            joyDrag = { cx, cy };
            try { joystickKnob.setPointerCapture(e.pointerId); } catch {}
        });
        joystickKnob.addEventListener('pointermove', (e) => {
            if (!joyDrag) return;
            const dx = Math.max(-joyRadius, Math.min(joyRadius, e.clientX - joyDrag.cx));
            const dy = Math.max(-joyRadius, Math.min(joyRadius, e.clientY - joyDrag.cy));
            joystickKnob.style.transform = `translate(${dx}px, ${dy}px)`;
            /* Map knob position to viewport pan (0-100%) */
            fillPanX = 50 + (dx / joyRadius) * 50;
            fillPanY = 50 + (dy / joyRadius) * 50;
            applyFillPan();
        });
        const joyEnd = () => {
            if (!joyDrag) return;
            joyDrag = null;
            joystickKnob.style.transform = '';
        };
        joystickKnob.addEventListener('pointerup', joyEnd);
        joystickKnob.addEventListener('pointercancel', joyEnd);
    }

    /* Joystick direction arrows — nudge the viewport; press-and-hold to repeat.
     * Each tap shifts the pan by PAN_STEP percent in fill mode. */
    const PAN_STEP = 6;
    const joyDirDelta = {
        up:    { x: 0, y: -PAN_STEP },
        down:  { x: 0, y:  PAN_STEP },
        left:  { x: -PAN_STEP, y: 0 },
        right: { x:  PAN_STEP, y: 0 },
    };
    document.querySelectorAll('[data-joydir]').forEach((arrow) => {
        const dir = arrow.dataset.joydir;
        const delta = joyDirDelta[dir];
        if (!delta) return;
        let holdTimer = null;
        let repeatTimer = null;
        const nudge = () => {
            fillPanX += delta.x;
            fillPanY += delta.y;
            applyFillPan();
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
            connect().catch((e) => console.warn('[rdp-wasm] reconnect failed:', e));
        });
    }

    if (disconnectBtn) {
        disconnectBtn.addEventListener('click', () => {
            disconnect();
            notifyParentCloseRequest('user-disconnect');
        });
    }

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

    /* Resolution button */
    const resolutions = ['auto', '1920x1080', '2560x1440', '3840x2160'];
    let resIdx = resolutions.indexOf(params.rdpResolution);
    if (resIdx < 0) resIdx = 0;
    if (resolutionBtn) {
        const labels = { '1920x1080': '1080p', '2560x1440': '2K', '3840x2160': '4K', 'auto': '自动' };
        resolutionBtn.textContent = labels[resolutions[resIdx]] || '自动';
        resolutionBtn.addEventListener('click', () => {
            resIdx = (resIdx + 1) % resolutions.length;
            resolutionBtn.textContent = labels[resolutions[resIdx]] || resolutions[resIdx];
            params.rdpResolution = resolutions[resIdx];
            /* Reconnect with new resolution */
            if (connected) {
                const size = computeRdpSize();
                rdpWidth = size.width;
                rdpHeight = size.height;
                connect().catch(() => {});
            }
        });
    }

    /* Panel drag handles */
    document.querySelectorAll('[data-drag-panel]').forEach((handle) => {
        let dragState = null;
        handle.addEventListener('pointerdown', (e) => {
            /* Ignore drags that start on the traffic/layout button so it stays clickable. */
            if (e.target.closest('[data-layout-panel]')) return;
            const panelId = handle.dataset.dragPanel;
            const panel = document.getElementById(panelId);
            if (!panel) return;
            e.preventDefault();
            const rect = panel.getBoundingClientRect();
            const stage = document.getElementById('rdpStage');
            const bounds = stage ? stage.getBoundingClientRect() : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
            dragState = { panel, rect, bounds, startX: e.clientX - rect.left, startY: e.clientY - rect.top, moved: false };
            panel.classList.add('dragging');
            try { handle.setPointerCapture(e.pointerId); } catch {}
        });
        handle.addEventListener('pointermove', (e) => {
            if (!dragState) return;
            dragState.moved = true;
            const { bounds, rect } = dragState;
            /* Clamp so the panel can't be dragged fully off-screen. */
            let nx = e.clientX - dragState.startX;
            let ny = e.clientY - dragState.startY;
            nx = Math.max(bounds.left - rect.width + 48, Math.min(bounds.right - 48, nx));
            ny = Math.max(bounds.top, Math.min(bounds.bottom - 40, ny));
            dragState.panel.style.left = nx + 'px';
            dragState.panel.style.top = ny + 'px';
            dragState.panel.style.right = 'auto';
            dragState.panel.style.bottom = 'auto';
        });
        const endDrag = (e) => {
            if (dragState) {
                dragState.panel.classList.remove('dragging');
                try { handle.releasePointerCapture(e.pointerId); } catch {}
            }
            dragState = null;
        };
        handle.addEventListener('pointerup', endDrag);
        handle.addEventListener('pointercancel', endDrag);
    });

    /* ─── Panel layout cycling — the traffic (three-dot) button ──────────
     * Taps cycle each floating panel through docked positions:
     *   center → left-half → right-half → restore(center).
     * Self-contained; no dependency on the main app's layout-menu system. */
    const PANEL_LAYOUTS = ['center', 'left', 'right'];
    const panelLayoutState = new WeakMap();
    document.querySelectorAll('[data-layout-panel]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const panel = document.getElementById(btn.dataset.layoutPanel);
            if (!panel) return;
            const stage = document.getElementById('rdpStage');
            const bounds = stage ? stage.getBoundingClientRect() : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
            const cur = panelLayoutState.get(panel) || 0;
            const next = (cur + 1) % PANEL_LAYOUTS.length;
            panelLayoutState.set(panel, next);
            const layout = PANEL_LAYOUTS[next];
            applyPanelLayout(panel, layout, bounds);
            btn.classList.toggle('active-layout', layout !== 'center');
        });
    });

    /* ─── Panel resize handles — the two edge bars at the bottom ────────── */
    document.querySelectorAll('[data-resize-panel]').forEach((handle) => {
        let resizeState = null;
        handle.addEventListener('pointerdown', (e) => {
            const panel = document.getElementById(handle.dataset.resizePanel);
            if (!panel) return;
            e.preventDefault();
            e.stopPropagation();
            const rect = panel.getBoundingClientRect();
            resizeState = {
                panel,
                edge: handle.dataset.resizeEdge || 'right',
                startX: e.clientX,
                startW: rect.width,
                startH: rect.height,
                startLeft: rect.left,
            };
            panel.classList.add('resizing');
            try { handle.setPointerCapture(e.pointerId); } catch {}
        });
        handle.addEventListener('pointermove', (e) => {
            if (!resizeState) return;
            const dx = e.clientX - resizeState.startX;
            const minW = 240, maxW = Math.min(window.innerWidth - 16, 900);
            if (resizeState.edge === 'right') {
                const w = Math.max(minW, Math.min(maxW, resizeState.startW + dx));
                resizeState.panel.style.width = w + 'px';
            } else {
                /* left edge: adjust width and keep right edge anchored */
                let w = Math.max(minW, Math.min(maxW, resizeState.startW - dx));
                const newLeft = resizeState.startLeft + (resizeState.startW - w);
                resizeState.panel.style.width = w + 'px';
                resizeState.panel.style.left = newLeft + 'px';
                resizeState.panel.style.right = 'auto';
            }
        });
        const endResize = (e) => {
            if (resizeState) {
                resizeState.panel.classList.remove('resizing');
                try { handle.releasePointerCapture(e.pointerId); } catch {}
            }
            resizeState = null;
        };
        handle.addEventListener('pointerup', endResize);
        handle.addEventListener('pointercancel', endResize);
    });
}

/* Dock a floating panel to a preset position within the stage bounds. */
function applyPanelLayout(panel, layout, bounds) {
    panel.style.bottom = 'auto';
    if (layout === 'left') {
        /* Dock to the left half. Width is half the stage but never below the
         * panel's CSS min-width, and never wider than the stage. */
        const minW = parseInt(getComputedStyle(panel).minWidth) || 240;
        const w = Math.max(minW, Math.min(bounds.width - 16, Math.round(bounds.width * 0.5) - 12));
        panel.style.right = 'auto';
        panel.style.width = w + 'px';
        panel.style.left = (bounds.left + 8) + 'px';
        panel.style.top = (bounds.top + 8) + 'px';
    } else if (layout === 'right') {
        /* Dock to the right half. Anchor via the right edge so the position is
         * correct even when min-width forces the panel wider than half. */
        const minW = parseInt(getComputedStyle(panel).minWidth) || 240;
        const w = Math.max(minW, Math.min(bounds.width - 16, Math.round(bounds.width * 0.5) - 12));
        panel.style.left = 'auto';
        panel.style.right = (window.innerWidth - bounds.right + 8) + 'px';
        panel.style.width = w + 'px';
        panel.style.top = (bounds.top + 8) + 'px';
    } else {
        /* center / restore: clear inline positioning, fall back to CSS defaults */
        panel.style.width = '';
        panel.style.left = '';
        panel.style.right = '';
        panel.style.top = '';
    }
}

/* ═══════════════════════════════════════════════════════════════════════
 * PARENT MESSAGE HANDLER (embedded mode)
 * ═══════════════════════════════════════════════════════════════════════ */
window.addEventListener('message', (e) => {
    if (!e.data || e.data.source !== 'zephyr-app') return;
    const msg = e.data;
    if (msg.type === 'theme-change') {
        applyFrameTheme(msg.theme, msg.appearance);
    } else if (msg.type === 'shared-clipboard-text' && msg.text && connected) {
        rdpClipboardChanged(msg.text);
    } else if (msg.type === 'params-update') {
        params = { ...params, ...msg.params };
    }
});

/* ═══════════════════════════════════════════════════════════════════════
 * BOOT
 * ═══════════════════════════════════════════════════════════════════════ */
(async function boot() {
    updateInfo();
    initToolbar();

    /* Compute initial resolution */
    const size = computeRdpSize();
    rdpWidth = size.width;
    rdpHeight = size.height;

    /* Load WASM then connect */
    try {
        /* Load wasm_exec.js runtime first */
        await new Promise((resolve, reject) => {
            if (typeof Go !== 'undefined') { resolve(); return; }
            const script = document.createElement('script');
            script.src = 'vendor/rdp-wasm/wasm_exec.js';
            script.onload = resolve;
            script.onerror = () => reject(new Error('Failed to load wasm_exec.js'));
            document.head.appendChild(script);
        });
        await loadWasm();
        await connect();
    } catch (err) {
        console.error('[rdp-wasm] boot failed:', err);
        setStatus('error', `RDP WASM 引擎加载失败: ${err.message}`);
    }
})();
