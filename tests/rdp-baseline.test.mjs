import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

async function importBrowserModule(path) {
    const source = await fs.readFile(new URL(path, import.meta.url), 'utf8');
    return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

const { RDP_PIPELINES, createRdpDiagnostics, normalizeRdpPipeline } = await importBrowserModule('../public/rdp-diagnostics.js');
const { RdpTraceRecorder, sanitizeRdpTraceEvent } = await importBrowserModule('../public/rdp-trace.js');

test('Worker GPU v2 is the only accepted production pipeline', () => {
    assert.deepEqual(RDP_PIPELINES, ['worker-gpu-v2']);
    for (const value of ['gpu-v2-page', 'legacy', 'unknown', '', null]) assert.equal(normalizeRdpPipeline(value), 'worker-gpu-v2');
});

test('RDP telemetry uses module-scoped active connection id', async () => {
    const client = await fs.readFile(new URL('../public/rdp-wasm-client.js', import.meta.url), 'utf8');
    assert.ok(client.includes("let activeConnectionId = '';"));
    assert.ok(client.includes('connectionId: activeConnectionId'));
    assert.equal(/JSON\.stringify\(\{ connectionId,/.test(client), false);
});

test('client fails closed when mandatory Worker GPU capabilities are absent', async () => {
    const client = await fs.readFile(new URL('../public/rdp-wasm-client.js', import.meta.url), 'utf8');
    for (const reason of ['INSECURE_CONTEXT', 'MODULE_WORKER_UNAVAILABLE', 'OFFSCREEN_CANVAS_TRANSFER_UNAVAILABLE']) {
        assert.ok(client.includes(reason), `${reason} must be explicit`);
    }
    for (const optional of ['CROSS_ORIGIN_ISOLATION_UNAVAILABLE', 'SHARED_ARRAY_BUFFER_UNAVAILABLE']) {
        assert.equal(client.includes(optional), false, `${optional} must not block Worker GPU rendering`);
    }
    assert.match(client, /WORKER_GPU_REQUIRED/);
    assert.match(client, /WORKER_GPU_PROBE_FAILED/);
});

test('client contains no page-thread WASM or GPU fallback', async () => {
    const client = await fs.readFile(new URL('../public/rdp-wasm-client.js', import.meta.url), 'utf8');
    for (const forbidden of ['gpu-v2-page', 'initPageGpuPipeline', 'loadPageWasm', 'async function loadWasm', 'RdpGpuSurfaceCompositor', 'RdpAvc420Decoder', 'RdpAvc444Decoder', 'createSynchronousBitmapUploader', 'Page GPU callbacks']) {
        assert.equal(client.includes(forbidden), false, `${forbidden} must be absent from page client`);
    }
    assert.match(client, /if \(!wasmReady \|\| !rdpWorkerBridge\) throw new Error\('Worker GPU WASM engine is not ready'\)/);
    assert.match(client, /wasmReady = true;\s*rdpDiag\.renderer = 'worker-gpu-v2';/);
});

test('Worker owns OffscreenCanvas WebGL2 and Go WASM', async () => {
    const worker = await fs.readFile(new URL('../public/rdp-worker.js', import.meta.url), 'utf8');
    const renderer = await fs.readFile(new URL('../public/rdp-renderer.js', import.meta.url), 'utf8');
    assert.match(worker, /new RdpGpuSurfaceCompositor\(canvas/);
    assert.match(worker, /instantiateGoWasm/);
    assert.match(worker, /rdpConfigureRenderer\(handleRenderEvent, globalThis\.rdpOnWasmBitmap, true\)/);
    assert.match(renderer, /getContext\('webgl2'/);
});

test('Worker boot failures propagate immediately with exact stage', async () => {
    const worker = await fs.readFile(new URL('../public/rdp-worker.js', import.meta.url), 'utf8');
    const bridge = await fs.readFile(new URL('../public/rdp-worker-bridge.js', import.meta.url), 'utf8');
    assert.match(worker, /type: 'boot-error'.*stage: currentBootStage/s);
    assert.match(bridge, /message\?\.type === 'boot-error'/);
});

test('Worker ready diagnostics come from Worker RPC, never page counters', async () => {
    const client = await fs.readFile(new URL('../public/rdp-wasm-client.js', import.meta.url), 'utf8');
    assert.match(client, /rdpWorkerBridge\.call\('rdpGetWorkerDiagnostics'/);
    assert.match(client, /RDP 黑屏诊断/);
    assert.match(client, /GPU 未呈现/);
    assert.doesNotMatch(client, /3 秒内未收到画面帧/);
});

test('pipeline configuration exposes Worker GPU only', async () => {
    const appHtml = await fs.readFile(new URL('../public/app.html', import.meta.url), 'utf8');
    const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
    const server = await fs.readFile(new URL('../server.js', import.meta.url), 'utf8');
    const storage = await fs.readFile(new URL('../storage.js', import.meta.url), 'utf8');
    assert.equal(appHtml.includes('value="gpu-v2-page"'), false);
    assert.match(appHtml, /value="worker-gpu-v2" selected/);
    for (const source of [app, server, storage]) assert.equal(source.includes("['gpu-v2-page', 'worker-gpu-v2']"), false);
});

test('legacy renderer entry points are absent from production client', async () => {
    const client = await fs.readFile(new URL('../public/rdp-wasm-client.js', import.meta.url), 'utf8');
    for (const forbidden of ['rdpDrawBitmapBGRA', 'rdpOnH264', 'putImageData and WebCodecs', 'shouldUseWebGLRenderer', "selectedPipeline = 'legacy'"]) {
        assert.equal(client.includes(forbidden), false, `${forbidden} must be removed`);
    }
});

test('diagnostics snapshot is detached and counts presents', () => {
    const diag = createRdpDiagnostics({ renderer: 'worker-gpu-v2' });
    diag.notePresentedFrame(100);
    diag.notePresentedFrame(116);
    const snapshot = diag.snapshot();
    assert.equal(snapshot.frames, 2);
    assert.equal(snapshot.presents, 2);
    snapshot.transport.queuedBytes = 99;
    assert.equal(diag.state.transport.queuedBytes, 0);
});

test('trace recorder strips payloads and preserves deterministic metadata', () => {
    const recorder = new RdpTraceRecorder({ maxEvents: 2 });
    recorder.record({ type: 'begin-frame', frameId: 7, password: 'must-not-leak' });
    recorder.record({ type: 'bitmap', frameId: 7, surfaceId: 2, rect: { x: 1, y: 2, width: 3, height: 4 }, payloadLength: 48, pixels: new Uint8Array([1, 2]) });
    recorder.record({ type: 'end-frame', frameId: 7 });
    const trace = recorder.export();
    assert.equal(trace.events.length, 2);
    assert.equal(trace.droppedEvents, 1);
    assert.equal(JSON.stringify(trace).includes('must-not-leak'), false);
    assert.equal(JSON.stringify(trace).includes('pixels'), false);
    assert.deepEqual(trace.events.map((event) => event.sequence), [1, 2]);
});

test('trace sanitizer rejects unknown commands', () => {
    assert.throws(() => sanitizeRdpTraceEvent({ type: 'clipboard', text: 'secret' }), /unsupported/);
});
