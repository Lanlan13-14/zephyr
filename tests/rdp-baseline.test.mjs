import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

async function importBrowserModule(path) {
    const source = await fs.readFile(new URL(path, import.meta.url), 'utf8');
    return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

const { createRdpDiagnostics, normalizeRdpPipeline } = await importBrowserModule('../public/rdp-diagnostics.js');
const { RdpTraceRecorder, sanitizeRdpTraceEvent } = await importBrowserModule('../public/rdp-trace.js');

test('pipeline selection defaults to Worker GPU v2 and excludes legacy', () => {
    assert.equal(normalizeRdpPipeline('gpu-v2-page'), 'gpu-v2-page');
    assert.equal(normalizeRdpPipeline('worker-gpu-v2'), 'worker-gpu-v2');
    assert.equal(normalizeRdpPipeline('legacy'), 'worker-gpu-v2');
    assert.equal(normalizeRdpPipeline('unknown'), 'worker-gpu-v2');
});

test('legacy renderer entry points are absent from production client', async () => {
    const client = await fs.readFile(new URL('../public/rdp-wasm-client.js', import.meta.url), 'utf8');
    for (const forbidden of ['rdpDrawBitmapBGRA', 'rdpOnH264', 'putImageData and WebCodecs', 'shouldUseWebGLRenderer', "selectedPipeline = 'legacy'"]) {
        assert.equal(client.includes(forbidden), false, `${forbidden} must be removed`);
    }
});

test('Worker probe fallback occurs before real canvas transfer', async () => {
    const client = await fs.readFile(new URL('../public/rdp-wasm-client.js', import.meta.url), 'utf8');
    const probeAt = client.indexOf('await RdpWorkerBridge.probe');
    const transferAt = client.indexOf('await rdpWorkerBridge.init');
    const fallbackAt = client.indexOf("selectedPipeline = 'gpu-v2-page'", probeAt);
    assert.ok(probeAt >= 0 && fallbackAt > probeAt && transferAt > fallbackAt);
});

test('pipeline configuration has no legacy option and defaults to Worker', async () => {
    const appHtml = await fs.readFile(new URL('../public/app.html', import.meta.url), 'utf8');
    const storage = await fs.readFile(new URL('../storage.js', import.meta.url), 'utf8');
    assert.equal(appHtml.includes('value="legacy"'), false);
    assert.ok(appHtml.includes('value="worker-gpu-v2"'));
    assert.ok(storage.includes("TEXT DEFAULT 'worker-gpu-v2'"));
});

test('diagnostics snapshot is detached and counts presents', () => {
    const diag = createRdpDiagnostics({ renderer: 'canvas2d' });
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
