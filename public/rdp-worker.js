import { RdpGpuSurfaceCompositor } from './rdp-renderer.js?v=20260802-rdp-input-render16';
import { RdpAvc420Decoder, RdpAvc444Decoder } from './rdp-video-decoder.js?v=20260802-rdp-input-render16';
import { createSynchronousBitmapUploader } from './rdp-wasm-memory.js?v=20260730-rdp-ordered-surface4';
import { createWorkerFrameScheduler } from './rdp-worker-frame-scheduler.js?v=20260801-rdp-motion9';
import { OrderedRenderCommandQueue } from './rdp-render-command-queue.js?v=20260730-rdp-ordered-surface4';
import { loadGoRuntime, instantiateGoWasm } from './rdp-wasm-runtime.js?v=20260730-rdp-ordered-surface4';

let compositor = null;
let avc420 = null;
let avc444 = null;
let initialized = false;
let wasmReady = false;
let localFiles = [];
const frameScheduler = createWorkerFrameScheduler(globalThis, { targetFps: 60 });
let lastPresentedAt = 0;
let lastVideoRefreshAt = Number.NEGATIVE_INFINITY;
const renderQueue = new OrderedRenderCommandQueue({
    onError(error, entry) { failClosed(`RENDER_COMMAND_FAILED:${entry?.label || entry?.sequence || ''}`, error); },
});

const workerDiag = {
    semanticEvents: 0,
    classicBitmaps: 0,
    bitmapEvents: 0,
    avc420Events: 0,
    avc420RegionEvents: 0,
    avc420RegionRects: 0,
    avc420RegionPixels: 0,
    avc420FramePixels: 0,
    avc420LastRegionPixels: 0,
    avc420LastFramePixels: 0,
    avc420FullUploads: 0,
    avc420DroppedOutputs: 0,
    avc420OutputTimeouts: 0,
    avc444Events: 0,
    avc444RejectedRegions: 0,
    presents: 0,
    presentedFrames: 0,
    drawFails: 0,
    lastError: '',
    lastKind: 0,
    lastEventAt: 0,
    glRenderer: '',
    // Field diagnostics: first bytes + nonzero counts of the first bitmap
    // uploads, so a black screen can be attributed to "source bytes are
    // zero" vs "bytes fine, compositing lost them" from server telemetry.
    bitmapSamples: [],
};
let currentBootStage = 'created';
function bootStage(stage, detail = '') {
    currentBootStage = String(stage || 'unknown');
    postMessage({ type: 'boot-stage', stage: currentBootStage, detail });
}
const callbacksToPage = new Set([
    'rdpOnReady', 'rdpOnError', 'rdpOnClose', 'rdpOnStage', 'rdpOnProtocolMilestone', 'rdpOnGraphicsReset', 'rdpOnClipboard', 'rdpOnRemoteFiles',
    'rdpOnPointerHide', 'rdpOnPointerCached', 'rdpOnPointerUpdate',
    'rdpAudioPlay', 'rdpAudioReset', 'rdpAudinStart', 'rdpAudinStop', 'rdpCameraStart',
    'rdpCameraStop', 'rdpLocationStart', 'rdpLocationStop',
]);
for (const name of callbacksToPage) globalThis[name] = (...args) => postMessage({ type: 'callback', name, args }, transferables(args));
globalThis.rdpStorageGetFiles = () => localFiles.map(({ name, size, isDir }) => ({ name, size, isDir }));
globalThis.rdpStorageReadFile = (name) => localFiles.find((file) => file.name === name)?.data || null;

function transferables(values) {
    const list = [];
    for (const value of values || []) {
        if (value instanceof ArrayBuffer) list.push(value);
        else if (ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer) list.push(value.buffer);
    }
    return list;
}

async function loadGoWasm() {
    bootStage('wasm-exec-loading');
    const GoRuntime = await loadGoRuntime({ pipeline: 'worker-gpu-v2' });
    bootStage('wasm-exec-loaded');
    bootStage('wasm-fetching');
    bootStage('wasm-instantiating');
    const { go, result } = await instantiateGoWasm(GoRuntime, {
        wasmUrl: './vendor/rdp-wasm/main.wasm?v=20260802-rdp-input-render16',
        pipeline: 'worker-gpu-v2',
    });
    if (result.instance.exports.mem) {
        bootStage('wasm-memory-binding');
        const upload = createSynchronousBitmapUploader({
            memoryProvider: () => result.instance.exports.mem,
            upload(event) {
                workerDiag.semanticEvents++;
                workerDiag.classicBitmaps += Number(event.kind) === 16 ? 1 : 0;
                workerDiag.bitmapEvents += Number(event.kind) === 8 ? 1 : 0;
                workerDiag.lastKind = Number(event.kind) || 0;
                workerDiag.lastEventAt = Date.now();
                if (workerDiag.bitmapSamples.length < 6 && event.data) {
                    let nonzero = 0;
                    const n = Math.min(event.data.length, 8192);
                    for (let i = 0; i < n; i++) if (event.data[i]) nonzero++;
                    workerDiag.bitmapSamples.push({
                        kind: Number(event.kind) || 0,
                        len: event.data.length,
                        stride: Number(event.stride) || 0,
                        lt: (Number(event.rect?.left) || 0) * 10000 + (Number(event.rect?.top) || 0),
                        rb: (Number(event.rect?.right) || 0) * 10000 + (Number(event.rect?.bottom) || 0),
                        nonzero,
                        b: [event.data[0] || 0, event.data[1] || 0, event.data[2] || 0, event.data[3] || 0],
                    });
                }
                // The WASM view can be consumed without copying when no
                // earlier asynchronous video command blocks the queue. Only
                // retain a private copy when this bitmap must wait.
                const pixels = renderQueue.depth ? new Uint8Array(event.data) : event.data;
                renderQueue.enqueue(() => {
                    if (Number(event.kind) === 16) compositor.uploadClassicBitmap(event.rect, pixels, event.stride);
                    else compositor.uploadBitmap(event.surfaceId, event.rect, pixels, event.stride);
                    // Outside FrameMarker only. Framed bitmaps present on EndFrame.
                    if (!Number(event.frameId) && compositor.activeFrame === null) compositor.schedulePresent();
                }, Number(event.kind) === 16 ? 'classic-bitmap' : 'bitmap');
            },
        });
        globalThis.rdpOnWasmBitmap = (event) => upload(event);
    }
    bootStage('go-runtime-starting');
    const exportsReady = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Go WASM exports registration timed out')), 10000);
        globalThis.zephyrRdpWasmReady = () => {
            clearTimeout(timeout);
            resolve();
        };
    });
    const runPromise = go.run(result.instance);
    runPromise?.catch?.((error) => {
        wasmReady = false;
        failClosed('GO_RUNTIME_EXITED', error);
    });
    try {
        await exportsReady;
    } finally {
        delete globalThis.zephyrRdpWasmReady;
    }
    const requiredExports = ['rdpConnect', 'rdpDisconnect', 'rdpConfigureRenderer', 'rdpGetProtocolDiagnostics', 'rdpGetClearCapture', 'rdpGfxCompleteFrame', 'rdpRequestFullRefresh', 'rdpSetResolution', 'rdpSetRenderPreferences'];
    const missingExports = requiredExports.filter((name) => typeof globalThis[name] !== 'function');
    if (missingExports.length) throw new Error(`Go WASM exports unavailable: ${missingExports.join(', ')}`);
    if (typeof globalThis.rdpOnWasmBitmap !== 'function') throw new Error('Worker WASM bitmap callback is unavailable');
    const configureError = globalThis.rdpConfigureRenderer(handleRenderEvent, globalThis.rdpOnWasmBitmap, true);
    if (configureError) throw new Error(String(configureError));
    wasmReady = true;
    bootStage('go-exports-ready');
}

function createAvc420Decoder() {
    return new RdpAvc420Decoder({
        onFrame(frame, event) {
            const ticket = event.__renderTicket;
            if (!ticket) { frame.close?.(); failClosed('AVC420_RENDER_TICKET_MISSING', new Error('missing render ticket')); return; }
            ticket.resolve(() => {
                // AVC420 output is a full decoder reference surface, but
                // pixels outside the RDPGFX dirty regions can contain the VOR
                // green key. Commit only the protocol-declared regions so a
                // sparse moving frame cannot erase the existing desktop.
                compositor.uploadVideoFrame(event.surfaceId, event.rect, frame, event.stream1?.regions, { trustRegions: true });
                compositor.completeFramePending(event.frameId);
            }, () => frame.close?.());
        },
        onError(error, event) {
            event?.__renderTicket?.skip();
            const message = String(error?.message || error || '');
            if (error?.code === 'AVC420_OUTPUT_DROPPED' || error?.code === 'AVC420_OUTPUT_TIMEOUT') {
                workerDiag.avc420DroppedOutputs++;
                if (error.code === 'AVC420_OUTPUT_TIMEOUT') workerDiag.avc420OutputTimeouts++;
                compositor.completeFramePending(event?.frameId, { dirty: false });
                return;
            }
            if (message === 'decoder reset' || message === 'decoder closed') {
                compositor.completeFramePending(event?.frameId, { dirty: false });
                return;
            }
            recoverAvc420Frame(error, event);
        },
    });
}

function createAvc444Decoder() {
    return new RdpAvc444Decoder({
        onMainFrame(frame, event) {
            event.__preparedRender = {
                apply() { compositor.uploadVideoFrame(event.surfaceId, event.rect, frame, event.stream1?.regions, { trustRegions: true }); },
                dispose() { frame.close?.(); },
            };
        },
        onCombinedBitmap(bytes, event, regions, rejected = 0) {
            const width = Number(event.rect.right) - Number(event.rect.left);
            event.__preparedRender = {
                apply() {
                    if (regions) compositor.uploadBitmapRegions(event.surfaceId, event.rect, bytes, width * 4, regions, false);
                    else compositor.uploadBitmap(event.surfaceId, event.rect, bytes, width * 4, false);
                    if (rejected > 0) {
                        workerDiag.avc444RejectedRegions = (workerDiag.avc444RejectedRegions || 0) + rejected;
                        workerDiag.lastError = `AVC444_REGIONS_REJECTED:${rejected}`;
                    }
                },
            };
        },
    });
}

function requestVideoRefresh() {
    const now = globalThis.performance?.now?.() ?? Date.now();
    if (now - lastVideoRefreshAt < 250) return false;
    lastVideoRefreshAt = now;
    try { globalThis.rdpRequestFullRefresh?.(); return true; } catch { return false; }
}

function recoverAvc420Frame(error, event, { resetDecoder = false } = {}) {
    workerDiag.drawFails++;
    workerDiag.lastError = `AVC420_FRAME_RECOVERY: ${error?.message || error}`;
    if (resetDecoder) avc420?.recoverSurface?.(event?.surfaceId);
    event?.__renderTicket?.skip();
    compositor.completeFramePending(event?.frameId, { dirty: false });
    requestVideoRefresh();
}

function recoverAvc444Frame(error, event) {
    workerDiag.drawFails++;
    workerDiag.lastError = `AVC444_FRAME_SKIPPED: ${error?.message || error}`;
    // A single stale/corrupt chroma upgrade must not destroy the RDP session.
    // Preserve the last complete surface, retire this async token, and ask the
    // server for a fresh reference frame. The frame ACK carries backlog so the
    // server can reduce pressure while WebCodecs catches up.
    compositor.completeFramePending(event.frameId, { dirty: false });
    requestVideoRefresh();
}

function setupRenderer(canvas) {
    globalThis.rdpExternalVideoDecode = true;
    bootStage('webgl2-compositor-starting');
    compositor = new RdpGpuSurfaceCompositor(canvas, {
        requestFrame: frameScheduler.request,
        cancelFrame: frameScheduler.cancel,
        diagnostics: workerDiag,
        onFramesPresented(frameIds) {
            lastPresentedAt = Date.now();
            workerDiag.presentedFrames += frameIds.length;
            for (const frameId of frameIds) globalThis.rdpGfxCompleteFrame(frameId, decoderBacklog());
        },
        onContextRestoreNeeded() { globalThis.rdpRequestFullRefresh(); },
    });
    workerDiag.glRenderer = String(compositor.gl.getParameter(compositor.gl.RENDERER) || 'webgl2');
    bootStage('webgl2-compositor-ready');
    avc420 = createAvc420Decoder();
    bootStage('avc420-decoder-ready');
    avc444 = createAvc444Decoder();
    bootStage('avc444-decoder-ready');
    globalThis.rdpOnRenderEvent = handleRenderEvent;
}

function decoderBacklog() {
    let backlog = 0;
    for (const state of avc420?.decoders?.values?.() || []) backlog += Number(state.decoder.decodeQueueSize) || 0;
    for (const state of avc444?.states?.values?.() || []) backlog += Number(state.decoder.decodeQueueSize) || 0;
    return backlog;
}

// (Field-debug surface/cache PNG dumping used during the 2026-07-18 mosaic
// hunt was removed after the ClearCodec root-cause fix; lightweight counters
// remain in rdpGetWorkerDiagnostics.)

function handleRenderEvent(event) {
    const kind = Number(event.kind);
    workerDiag.semanticEvents++;
    workerDiag.lastKind = kind || 0;
    workerDiag.lastEventAt = Date.now();
    if (kind === 8) workerDiag.bitmapEvents++;
    if (kind === 9) workerDiag.avc420Events++;
    if (kind === 10) workerDiag.avc444Events++;
    if (kind === 5) {
        avc420?.resetSurface(event.surfaceId);
        avc444?.resetSurface(event.surfaceId);
        renderQueue.enqueue(() => compositor.handleEvent(event), `delete-surface:${event.surfaceId}`);
        return;
    }
    if (kind === 1) {
        renderQueue.clear();
        avc420?.close();
        avc444?.close();
        avc420 = createAvc420Decoder();
        avc444 = createAvc444Decoder();
        renderQueue.enqueue(() => {
            compositor.handleEvent(event);
            globalThis.rdpOnGraphicsReset?.(Number(event.width) || 0, Number(event.height) || 0);
            // The resized surface starts from the compositor's transition
            // base; ask the server for fresh desktop pixels so the carry is
            // retired by current-size updates as quickly as possible.
            globalThis.setTimeout?.(() => requestVideoRefresh(), 120);
        }, 'reset-graphics');
        return;
    }
    if (kind === 9) {
        const regions = event.stream1?.regions || [];
        const frameWidth = Math.max(0, Number(event.rect?.right) - Number(event.rect?.left));
        const frameHeight = Math.max(0, Number(event.rect?.bottom) - Number(event.rect?.top));
        const framePixels = frameWidth * frameHeight;
        const regionPixels = regions.reduce((sum, region) => sum
            + Math.max(0, Number(region?.right) - Number(region?.left))
            * Math.max(0, Number(region?.bottom) - Number(region?.top)), 0);
        workerDiag.avc420LastFramePixels = framePixels;
        workerDiag.avc420LastRegionPixels = regionPixels;
        workerDiag.avc420FramePixels += framePixels;
        workerDiag.avc420WireLeft = Math.trunc(Number(event.rect?.left) || 0);
        workerDiag.avc420WireTop = Math.trunc(Number(event.rect?.top) || 0);
        workerDiag.avc420WireRight = Math.trunc(Number(event.rect?.right) || 0);
        workerDiag.avc420WireBottom = Math.trunc(Number(event.rect?.bottom) || 0);
        const firstRegion = regions[0];
        workerDiag.avc420RegionLeft = Math.trunc(Number(firstRegion?.left) || 0);
        workerDiag.avc420RegionTop = Math.trunc(Number(firstRegion?.top) || 0);
        workerDiag.avc420RegionRight = Math.trunc(Number(firstRegion?.right) || 0);
        workerDiag.avc420RegionBottom = Math.trunc(Number(firstRegion?.bottom) || 0);
        if (regions.length) {
            workerDiag.avc420RegionEvents++;
            workerDiag.avc420RegionRects += regions.length;
            workerDiag.avc420RegionPixels += regionPixels;
        } else {
            workerDiag.avc420FullUploads++;
        }
        compositor.addFramePending(event.frameId);
        try {
            event.__renderTicket = renderQueue.reserve(`avc420:${event.surfaceId}:${event.frameId}`);
            avc420.decode(event);
        } catch (error) {
            recoverAvc420Frame(error, event, { resetDecoder: true });
        }
        return;
    }
    if (kind === 10) {
        compositor.addFramePending(event.frameId);
        try { event.__renderTicket = renderQueue.reserve(`avc444:${event.surfaceId}:${event.frameId}`); }
        catch (error) { failClosed('AVC444_QUEUE_FAILED', error); return; }
        avc444.decode(event)
            .then((applied) => {
                const prepared = event.__preparedRender;
                if (applied === false || !prepared) {
                    event.__renderTicket.skip(prepared?.dispose);
                    compositor.completeFramePending(event.frameId, { dirty: false });
                    workerDiag.drawFails++;
                    const rejected = Number(event.__avc444RejectedRegions) || 0;
                    if (rejected > 0) {
                        workerDiag.avc444RejectedRegions = (workerDiag.avc444RejectedRegions || 0) + rejected;
                        workerDiag.lastError = `AVC444_FRAME_SKIPPED: rejected ${rejected} corrupt region tiles`;
                    } else {
                        workerDiag.lastError = 'AVC444_FRAME_SKIPPED: stale or corrupt chroma';
                    }
                    requestVideoRefresh();
                    return;
                }
                event.__renderTicket.resolve(() => {
                    prepared.apply();
                    compositor.completeFramePending(event.frameId);
                }, prepared.dispose);
            })
            .catch((error) => {
                event.__renderTicket.skip(event.__preparedRender?.dispose);
                recoverAvc444Frame(error, event);
            });
        return;
    }
    renderQueue.enqueue(() => compositor.handleEvent(event), `event:${kind}:${event.surfaceId || 0}:${event.frameId || 0}`);
}

function failClosed(code, error) {
    workerDiag.drawFails++;
    workerDiag.lastError = `${code}: ${error?.message || error}`;
    try { globalThis.rdpDisconnect?.(); } catch {}
    postMessage({ type: 'callback', name: 'rdpOnError', args: [workerDiag.lastError] });
}

function dispatchInput(envelope) {
    const p = envelope.payload || {};
    switch (envelope.type) {
    case 'mouse-move': return globalThis.rdpMouseMove(p.x, p.y);
    case 'mouse-down': return globalThis.rdpMouseDown(p.button, p.x, p.y);
    case 'mouse-up': return globalThis.rdpMouseUp(p.button, p.x, p.y);
    case 'wheel': return globalThis.rdpMouseWheel(p.delta);
    case 'hwheel': return globalThis.rdpMouseHScroll(p.delta);
    case 'key-down': return globalThis.rdpKeyDown(p.code);
    case 'key-up': return globalThis.rdpKeyUp(p.code);
    case 'unicode-text': return globalThis.rdpUnicodeText(p.text);
    default: throw new Error(`unknown input type ${envelope.type}`);
    }
}

async function invokeMethod(method, args) {
	if (method === 'rdpConnect') frameScheduler.setTargetFps(args?.[14]);
	if (method === 'rdpSetRenderPreferences') frameScheduler.setTargetFps(args?.[1]);
    if (method === 'rdpCaptureFrame') {
        if (!compositor?.gl || !compositor.width || !compositor.height) throw new Error('RDP renderer is not ready');
        const { width, height, pixels } = compositor.capturePixels();
        const flipped = new Uint8Array(pixels.length);
        const row = width * 4;
        for (let y = 0; y < height; y++) flipped.set(pixels.subarray((height - 1 - y) * row, (height - y) * row), y * row);
        return { width, height, frameAt: lastPresentedAt || Date.now(), pixels: flipped };
    }
    if (method === 'rdpGetWorkerDiagnostics') {
        const protocol = typeof globalThis.rdpGetProtocolDiagnostics === 'function'
            ? globalThis.rdpGetProtocolDiagnostics()
            : {};
        // (The forensic ClearCodec capture remains available on demand via
        // the rdpGetClearCapture WASM export; auto-dumping was removed after
        // the 2026-07-18 root-cause fix.)
        // Flatten field diagnostics into protocol keys (telemetry whitelist
        // only forwards the numeric protocol map + a few scalar fields).
        workerDiag.bitmapSamples.forEach((s, i) => {
            protocol[`dbg.bm${i}.kind`] = s.kind;
            protocol[`dbg.bm${i}.len`] = s.len;
            protocol[`dbg.bm${i}.nz`] = s.nonzero;
            protocol[`dbg.bm${i}.lt`] = s.lt;
            protocol[`dbg.bm${i}.rb`] = s.rb;
            protocol[`dbg.bm${i}.b`] = s.b[0] * 16777216 + s.b[1] * 65536 + s.b[2] * 256 + s.b[3];
        });
        protocol['dbg.avc420.outputDropped'] = workerDiag.avc420DroppedOutputs;
        protocol['dbg.avc420.outputTimeouts'] = workerDiag.avc420OutputTimeouts;
        return {
            ...workerDiag,
            bitmapSamples: undefined,
            protocol,
            frameScheduler: { ...frameScheduler.stats },
            renderQueue: { ...renderQueue.stats, depth: renderQueue.depth, blocked: renderQueue.blocked },
            renderQueueDepth: renderQueue.depth,
            renderQueueBlocked: renderQueue.blocked,
            renderQueueMaxDepth: renderQueue.stats.maxDepth,
            renderQueueApplied: renderQueue.stats.applied,
            renderQueueSkipped: renderQueue.stats.skipped,
            decoderBacklog: decoderBacklog(),
            wasmReady,
            bootStage: currentBootStage,
        };
    }
    const fn = globalThis[method];
    if (typeof fn !== 'function') throw new Error(`unknown Worker method ${method}`);
    if (method === 'rdpDownloadServerFile') {
        return new Promise((resolve) => fn(args[0], (data) => resolve(data || null)));
    }
    return await fn(...args);
}

onmessage = async ({ data: message }) => {
    try {
        if (message.type === 'init') {
            if (initialized) throw new Error('RDP Worker already initialized');
            initialized = true;
            bootStage('renderer-starting');
            setupRenderer(message.canvas);
            bootStage('renderer-ready');
            await loadGoWasm();
            postMessage({ type: 'ready', capabilities: { worker: true, webgl2: true, webcodecs: typeof VideoDecoder !== 'undefined' } });
            return;
        }
        if (message.type === 'local-files') {
            localFiles = (message.entries || []).map((entry) => ({ ...entry, data: entry.data ? new Uint8Array(entry.data) : null }));
            // Advertise only after the Worker list is updated — the page used
            // to fire rdpNotifyFilesChanged immediately and race this path.
            if (message.notify && typeof globalThis.rdpNotifyFilesChanged === 'function') {
                try { globalThis.rdpNotifyFilesChanged(); }
                catch (err) { console.warn('[rdp-worker] rdpNotifyFilesChanged failed', err); }
            }
            if (message.id != null) {
                postMessage({ type: 'response', id: message.id, ok: true, value: { count: localFiles.length } });
            }
            return;
        }
        if (!wasmReady) throw new Error('RDP WASM is not ready');
        if (message.type === 'input') { dispatchInput(message.envelope); return; }
        if (message.type === 'call' || message.type === 'request') {
            const value = await invokeMethod(message.method, message.args || []);
            if (message.type === 'request') {
                const transfer = message.method === 'rdpCaptureFrame' && value?.pixels?.buffer ? [value.pixels.buffer] : [];
                postMessage({ type: 'response', id: message.id, ok: true, value }, transfer);
            }
        }
    } catch (error) {
        if (message.type === 'request') {
            postMessage({ type: 'response', id: message.id, ok: false, error: error.message });
        } else if (message.type === 'init') {
            postMessage({ type: 'boot-error', code: 'WORKER_GPU_INIT_FAILED', stage: currentBootStage, error: error?.message || String(error) });
        } else {
            failClosed('WORKER_MESSAGE_FAILED', error);
        }
    }
};
