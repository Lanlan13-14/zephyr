import { RdpGpuSurfaceCompositor } from './rdp-renderer.js';
import { RdpAvc420Decoder, RdpAvc444Decoder } from './rdp-video-decoder.js';
import { createSynchronousBitmapUploader } from './rdp-wasm-memory.js';

let compositor = null;
let avc420 = null;
let avc444 = null;
let syncControl = null;
let syncData = null;
let initialized = false;
let wasmReady = false;
let localFiles = [];
function bootStage(stage, detail = '') { postMessage({ type: 'boot-stage', stage, detail }); }
const callbacksToPage = new Set([
    'rdpOnReady', 'rdpOnError', 'rdpOnClose', 'rdpOnClipboard', 'rdpOnRemoteFiles',
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
    // wasm_exec.js is a side-effect script. Dynamic import works in a module
    // Worker, whereas importScripts is forbidden by the module-worker spec.
    await import('./vendor/rdp-wasm/wasm_exec.js');
    bootStage('wasm-exec-loaded');
    const GoRuntime = globalThis.Go;
    if (typeof GoRuntime !== 'function') throw new Error('Go WASM runtime did not register globalThis.Go');
    const go = new GoRuntime();
    bootStage('wasm-fetching');
    const response = await fetch('./vendor/rdp-wasm/main.wasm');
    bootStage('wasm-instantiating');
    const result = WebAssembly.instantiateStreaming
        ? await WebAssembly.instantiateStreaming(response, go.importObject)
        : await WebAssembly.instantiate(await response.arrayBuffer(), go.importObject);
    if (result.instance.exports.mem) {
        bootStage('wasm-memory-binding');
        const upload = createSynchronousBitmapUploader({
            memoryProvider: () => result.instance.exports.mem,
            upload(event) {
                if (Number(event.kind) === 16) compositor.uploadClassicBitmap(event.rect, event.data, event.stride);
                else compositor.uploadBitmap(event.surfaceId, event.rect, event.data, event.stride);
                if (!Number(event.frameId)) compositor.schedulePresent();
            },
        });
        globalThis.rdpOnWasmBitmap = (event) => upload(event);
    }
    bootStage('go-runtime-starting');
    go.run(result.instance);
    wasmReady = true;
    bootStage('go-runtime-ready');
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
    bootStage('webgl2-compositor-starting');
    compositor = new RdpGpuSurfaceCompositor(canvas, {
        onFramesPresented(frameIds) { for (const frameId of frameIds) globalThis.rdpGfxCompleteFrame(frameId, decoderBacklog()); },
        onContextRestoreNeeded() { globalThis.rdpRequestFullRefresh(); },
    });
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

function handleRenderEvent(event) {
    const kind = Number(event.kind);
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
    try { globalThis.rdpDisconnect?.(); } catch {}
    postMessage({ type: 'callback', name: 'rdpOnError', args: [`${code}: ${error?.message || error}`] });
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
        if (message.type === 'request') postMessage({ type: 'response', id: message.id, ok: false, error: error.message });
        else failClosed('WORKER_MESSAGE_FAILED', error);
    }
};
