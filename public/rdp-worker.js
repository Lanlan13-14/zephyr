import { RdpGpuSurfaceCompositor } from './rdp-renderer.js?v=20260718-samefbo-copy-fix1';
import { RdpAvc420Decoder, RdpAvc444Decoder } from './rdp-video-decoder.js?v=20260718-samefbo-copy-fix1';
import { createSynchronousBitmapUploader } from './rdp-wasm-memory.js?v=20260718-samefbo-copy-fix1';
import { createWorkerFrameScheduler } from './rdp-worker-frame-scheduler.js?v=20260718-samefbo-copy-fix1';
import { loadGoRuntime, instantiateGoWasm } from './rdp-wasm-runtime.js?v=20260718-samefbo-copy-fix1';

let compositor = null;
let avc420 = null;
let avc444 = null;
let syncControl = null;
let syncData = null;
let initialized = false;
let wasmReady = false;
let localFiles = [];
const frameScheduler = createWorkerFrameScheduler(globalThis, { fallbackMs: 34 });
const workerDiag = {
    semanticEvents: 0,
    classicBitmaps: 0,
    bitmapEvents: 0,
    avc420Events: 0,
    avc444Events: 0,
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
    'rdpOnReady', 'rdpOnError', 'rdpOnClose', 'rdpOnStage', 'rdpOnProtocolMilestone', 'rdpOnClipboard', 'rdpOnRemoteFiles',
    'rdpOnPointerHide', 'rdpOnPointerCached', 'rdpOnPointerUpdate',
    'rdpAudioPlay', 'rdpAudinStart', 'rdpAudinStop', 'rdpCameraStart',
    'rdpCameraStop', 'rdpLocationStart', 'rdpLocationStop',
]);
const syncPageMethods = new Set([
    'zephyrRdpFsList', 'zephyrRdpFsStat',
    'zephyrRdpFsOpen', 'zephyrRdpFsRead', 'zephyrRdpFsWrite', 'zephyrRdpFsClose',
    'zephyrRdpFsMkdir', 'zephyrRdpFsDelete', 'zephyrRdpFsRename', 'zephyrRdpFsTruncate',
]);

for (const name of callbacksToPage) globalThis[name] = (...args) => postMessage({ type: 'callback', name, args }, transferables(args));
for (const name of syncPageMethods) globalThis[name] = (...args) => syncPageRpc(name, args);
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

function syncPageRpc(name, args) {
    if (!syncControl || !syncData) throw new Error('Worker sync RPC is unavailable');
    const control = new Int32Array(syncControl);
    Atomics.store(control, 0, 0);
    Atomics.store(control, 1, 0);
    Atomics.store(control, 2, 0);
    Atomics.store(control, 3, 0);
    postMessage({ type: 'sync-rpc', name, args });
    const wait = Atomics.wait(control, 0, 0, 30000);
    if (wait === 'timed-out') throw new Error(`page RPC ${name} timed out`);
    const length = Atomics.load(control, 2);
    const bytes = new Uint8Array(syncData, 0, length).slice();
    if (Atomics.load(control, 3)) throw new Error(new TextDecoder().decode(bytes));
    if (Atomics.load(control, 1) === 1) return bytes;
    return JSON.parse(new TextDecoder().decode(bytes) || 'null');
}

async function loadGoWasm() {
    bootStage('wasm-exec-loading');
    const GoRuntime = await loadGoRuntime({ pipeline: 'worker-gpu-v2' });
    bootStage('wasm-exec-loaded');
    bootStage('wasm-fetching');
    bootStage('wasm-instantiating');
    const { go, result } = await instantiateGoWasm(GoRuntime, {
        wasmUrl: './vendor/rdp-wasm/main.wasm?v=20260718-samefbo-copy-fix1',
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
                let crc = 0;
                if (event.data && event.data.length) {
                    for (let i = 0; i < event.data.length; i++) crc = (crc * 31 + event.data[i]) >>> 0;
                }
                traceEvent(event, { ln: event.data ? event.data.length : 0, crc });
                // Stash the first large band bitmap's bytes for offline
                // inspection (is Go emitting torn content, or does the
                // upload path scramble it?).
                if (!globalThis.__dbgBandDump && event.data && event.data.length > 100000 && event.data.length < 400000) {
                    const copy = new Uint8Array(event.data.length);
                    copy.set(event.data);
                    globalThis.__dbgBandDump = {
                        rect: event.rect, stride: Number(event.stride) || 0,
                        base64: (() => { let s = ''; for (let i = 0; i < copy.length; i += 8192) s += String.fromCharCode(...copy.subarray(i, i + 8192)); return btoa(s); })(),
                    };
                }
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
                if (Number(event.kind) === 16) compositor.uploadClassicBitmap(event.rect, event.data, event.stride);
                else compositor.uploadBitmap(event.surfaceId, event.rect, event.data, event.stride);
                if (!Number(event.frameId)) compositor.schedulePresent();
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
    const requiredExports = ['rdpConnect', 'rdpDisconnect', 'rdpConfigureRenderer', 'rdpGetProtocolDiagnostics', 'rdpGfxCompleteFrame', 'rdpRequestFullRefresh'];
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
            try { compositor.uploadVideoFrame(event.surfaceId, event.rect, frame); }
            finally { compositor.completeFramePending(event.frameId); frame.close(); }
        },
        onError(error) {
            // Keep the frame pending; failClosed destroys the protocol session
            // so an undecoded frame cannot be acknowledged.
            failClosed('AVC420_WORKER_FAILED', error);
        },
    });
}

function createAvc444Decoder() {
    return new RdpAvc444Decoder({
        onMainFrame(frame, event) { compositor.uploadVideoFrame(event.surfaceId, event.rect, frame); },
        onCombinedBitmap(bytes, event) {
            const width = Number(event.rect.right) - Number(event.rect.left);
            compositor.uploadBitmap(event.surfaceId, event.rect, bytes, width * 4, false);
        },
    });
}

function setupRenderer(canvas) {
    globalThis.rdpExternalVideoDecode = true;
    globalThis.__DBG_DISABLE_CACHE_PASTE = true;
    bootStage('webgl2-compositor-starting');
    compositor = new RdpGpuSurfaceCompositor(canvas, {
        requestFrame: frameScheduler.request,
        cancelFrame: frameScheduler.cancel,
        diagnostics: workerDiag,
        onFramesPresented(frameIds) {
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

// Field diagnostics: upload a PNG of the current surface to the server so a
// black/garbled screen can be attributed from the server side without any
// client console access. Posted once per session on the first diagnostics
// call; fetched via GET /api/rdp/h264-debug.
async function postSurfaceShot(compositorInstance, seq) {
    try {
        const gl = compositorInstance.gl;
        const surface = compositorInstance.surfaces.get(0) || [...compositorInstance.surfaces.values()][0];
        if (!surface) return;
        const w = surface.width, h = surface.height;
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, surface.framebuffer);
        const raw = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
        // readPixels is bottom-up; ImageData is top-down — flip rows.
        const img = new ImageData(w, h);
        const rowBytes = w * 4;
        for (let y = 0; y < h; y++) img.data.set(raw.subarray((h - 1 - y) * rowBytes, (h - y) * rowBytes), y * rowBytes);
        const shot = new OffscreenCanvas(w, h);
        shot.getContext('2d').putImageData(img, 0, 0);
        const blob = await shot.convertToBlob({ type: 'image/png' });
        const buf = new Uint8Array(await blob.arrayBuffer());
        let bin = '';
        for (let i = 0; i < buf.length; i += 8192) bin += String.fromCharCode(...buf.subarray(i, i + 8192));
        // Also dump the most-pasted cache entries (what is actually being
        // stamped across the screen) as raw RGBA base64.
        const cacheDumps = {};
        for (const [slot, entry] of compositorInstance.cacheEntries) {
            if (Object.keys(cacheDumps).length >= 10) break;
            try {
                gl.bindFramebuffer(gl.READ_FRAMEBUFFER, entry.framebuffer);
                const eb = new Uint8Array(entry.width * entry.height * 4);
                gl.readPixels(0, 0, entry.width, entry.height, gl.RGBA, gl.UNSIGNED_BYTE, eb);
                let ebin = '';
                for (let i = 0; i < eb.length; i += 8192) ebin += String.fromCharCode(...eb.subarray(i, i + 8192));
                cacheDumps[slot] = { w: entry.width, h: entry.height, rgbaBase64: btoa(ebin) };
            } catch {}
        }
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
        await fetch('/api/rdp/h264-debug', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ surfaceShotPngBase64: btoa(bin), width: w, height: h, seq, at: Date.now(), trace: eventTrace, cacheDumps, bandDump: globalThis.__dbgBandDump || null }),
        });
    } catch (error) {
        workerDiag.lastError = `surface-shot: ${error?.message || error}`;
    }
}

// Field diagnostics: record the full render-event stream (metadata + CRC,
// no payload) so a garbled frame can be reconstructed and attributed
// offline. Ring buffer, ~3000 events.
const eventTrace = [];
function traceEvent(event, extra = {}) {
    if (eventTrace.length >= 3000) eventTrace.shift();
    const r = event.rect || {};
    eventTrace.push({
        k: Number(event.kind) || 0,
        f: Number(event.frameId) || 0,
        s: Number(event.surfaceId) || 0,
        s2: Number(event.surfaceId2) || 0,
        x: Number(event.outputX) || 0,
        y: Number(event.outputY) || 0,
        w: Number(event.width) || 0,
        h: Number(event.height) || 0,
        rl: Number(r.left) || 0,
        rt: Number(r.top) || 0,
        rr: Number(r.right) || 0,
        rb: Number(r.bottom) || 0,
        st: Number(event.stride) || 0,
        c: Number(event.colorBGRA) || 0,
        ...extra,
    });
}

function handleRenderEvent(event) {
    const kind = Number(event.kind);
    workerDiag.semanticEvents++;
    workerDiag.lastKind = kind || 0;
    workerDiag.lastEventAt = Date.now();
    traceEvent(event);
    if (kind === 8) workerDiag.bitmapEvents++;
    if (kind === 9) workerDiag.avc420Events++;
    if (kind === 10) workerDiag.avc444Events++;
    if (kind === 5) {
        avc420?.resetSurface(event.surfaceId);
        avc444?.resetSurface(event.surfaceId);
        compositor.handleEvent(event);
        return;
    }
    if (kind === 1) {
        avc420?.close();
        avc444?.close();
        avc420 = createAvc420Decoder();
        avc444 = createAvc444Decoder();
        compositor.handleEvent(event);
        return;
    }
    if (kind === 9) {
        compositor.addFramePending(event.frameId);
        try { avc420.decode(event); } catch (error) { failClosed('AVC420_QUEUE_FAILED', error); }
        return;
    }
    if (kind === 10) {
        compositor.addFramePending(event.frameId);
        avc444.decode(event).then(() => compositor.completeFramePending(event.frameId)).catch((error) => failClosed('AVC444_WORKER_FAILED', error));
        return;
    }
    compositor.handleEvent(event);
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
    default: throw new Error(`unknown input type ${envelope.type}`);
    }
}

async function invokeMethod(method, args) {
    if (method === 'rdpGetWorkerDiagnostics') {
        const protocol = typeof globalThis.rdpGetProtocolDiagnostics === 'function'
            ? globalThis.rdpGetProtocolDiagnostics()
            : {};
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
        if (compositor) {
            try {
                const gl = compositor.gl;
                let idx = 0;
                for (const [id, s] of compositor.surfaces) {
                    if (idx >= 3) break;
                    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, s.framebuffer);
                    const buf = new Uint8Array(s.width * s.height * 4);
                    gl.readPixels(0, 0, s.width, s.height, gl.RGBA, gl.UNSIGNED_BYTE, buf);
                    let nonzero = 0;
                    for (let i = 0; i < buf.length; i += 4) { if (buf[i] || buf[i + 1] || buf[i + 2]) nonzero++; }
                    const mid = ((s.height >> 1) * s.width + (s.width >> 1)) * 4;
                    protocol[`dbg.s${idx}.id`] = Number(id);
                    protocol[`dbg.s${idx}.wh`] = s.width * 100000 + s.height;
                    protocol[`dbg.s${idx}.nz`] = nonzero;
                    protocol[`dbg.s${idx}.map`] = s.mapped ? 1 : 0;
                    protocol[`dbg.s${idx}.mid`] = buf[mid] * 16777216 + buf[mid + 1] * 65536 + buf[mid + 2] * 256 + buf[mid + 3];
                    idx++;
                }
                gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
                // Probe the canvas default framebuffer right after a forced
                // present: distinguishes "present draws black" from
                // "canvas never composites to the page".
                try {
                    compositor.dirty = true;
                    compositor.present();
                    const cw = compositor.width, ch = compositor.height;
                    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
                    const cbuf = new Uint8Array(cw * ch * 4);
                    gl.readPixels(0, 0, cw, ch, gl.RGBA, gl.UNSIGNED_BYTE, cbuf);
                    let cnz = 0;
                    for (let i = 0; i < cbuf.length; i += 4) { if (cbuf[i] || cbuf[i + 1] || cbuf[i + 2]) cnz++; }
                    const cmid = ((ch >> 1) * cw + (cw >> 1)) * 4;
                    protocol['dbg.cvs.wh'] = cw * 100000 + ch;
                    protocol['dbg.cvs.nz'] = cnz;
                    protocol['dbg.cvs.mid'] = cbuf[cmid] * 16777216 + cbuf[cmid + 1] * 65536 + cbuf[cmid + 2] * 256 + cbuf[cmid + 3];
                    protocol['dbg.cvs.ctxlost'] = gl.isContextLost() ? 1 : 0;
                    protocol['dbg.cvs.err'] = gl.getError();
                } catch (e2) {
                    protocol['dbg.cvs.error'] = 1;
                    workerDiag.lastError = `canvas-dump: ${e2?.message || e2}`;
                }
            } catch (error) {
                protocol['dbg.surface.error'] = 1;
                workerDiag.lastError = `surface-dump: ${error?.message || error}`;
            }
        }
        if (compositor) {
            globalThis.__dbgShotSeq = (globalThis.__dbgShotSeq || 0) + 1;
            postSurfaceShot(compositor, globalThis.__dbgShotSeq);
        }
        return { ...workerDiag, bitmapSamples: undefined, protocol, frameScheduler: { ...frameScheduler.stats }, decoderBacklog: decoderBacklog(), wasmReady, bootStage: currentBootStage };
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
            syncControl = message.syncControl;
            syncData = message.syncData;
            bootStage('renderer-starting');
            setupRenderer(message.canvas);
            bootStage('renderer-ready');
            await loadGoWasm();
            postMessage({ type: 'ready', capabilities: { worker: true, webgl2: true, webcodecs: typeof VideoDecoder !== 'undefined' } });
            return;
        }
        if (message.type === 'local-files') {
            localFiles = (message.entries || []).map((entry) => ({ ...entry, data: entry.data ? new Uint8Array(entry.data) : null }));
            return;
        }
        if (!wasmReady) throw new Error('RDP WASM is not ready');
        if (message.type === 'input') { dispatchInput(message.envelope); return; }
        if (message.type === 'call' || message.type === 'request') {
            const value = await invokeMethod(message.method, message.args || []);
            if (message.type === 'request') postMessage({ type: 'response', id: message.id, ok: true, value });
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
