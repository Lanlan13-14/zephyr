import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const client = readFileSync(new URL('../public/rdp-wasm-client.js', import.meta.url), 'utf8');
const worker = readFileSync(new URL('../public/rdp-worker.js', import.meta.url), 'utf8');
const bridge = readFileSync(new URL('../public/rdp-worker-bridge.js', import.meta.url), 'utf8');
const wasmMain = readFileSync(new URL('../rdp-wasm/main.go', import.meta.url), 'utf8');

test('quality and FPS controls update the live session without reconnecting', () => {
    const qualityHandler = client.slice(client.indexOf('if (qualityBtn)'), client.indexOf('if (fpsBtn)'));
    const fpsHandler = client.slice(client.indexOf('if (fpsBtn)'), client.indexOf('if (fitBtn)'));
    assert.match(qualityHandler, /applyLiveRenderPreferences\('quality'\)/);
    assert.match(fpsHandler, /applyLiveRenderPreferences\('fps'\)/);
    assert.doesNotMatch(qualityHandler, /reconnectWithSettings\(\)/);
    assert.doesNotMatch(fpsHandler, /reconnectWithSettings\(\)/);
});

test('live render preferences cross page, Worker, and Go WASM', () => {
    assert.match(wasmMain, /Set\("rdpSetRenderPreferences", js\.FuncOf\(jsSetRenderPreferences\)\)/);
    assert.match(worker, /requiredExports[^\n]+rdpSetRenderPreferences/);
    assert.match(worker, /frameScheduler\.setTargetFps\(args\?\.\[1\]\)/);
    assert.match(bridge, /target\.rdpSetRenderPreferences = \(\.\.\.args\) => this\.call\('rdpSetRenderPreferences', args\)/);
    assert.match(client, /window\.rdpSetRenderPreferences\(qualityMode, fpsValue\)/);
    assert.match(wasmMain, /queueDepthForPreferences\(qualityMode, fps\)/);
    assert.match(client, /window\.rdpRequestFullRefresh\?\.\(\)/);
    assert.match(client, /reportWorkerTelemetry\(0, \{ reason: `\$\{reason\}-after` \}\)/);
});

test('hot-path protocol events remain aggregated instead of crossing the Worker per PDU', () => {
    assert.match(wasmMain, /if !isProtocolMilestone\(event\) \{\s*return\s*\}/);
    assert.match(wasmMain, /strings\.HasPrefix\(event, "rdpgfx\.clearcodec\.drop:"\)/);
    assert.match(wasmMain, /addProtocolCounter\(protocolCounterKey\(event\), 1\)/);
    assert.match(wasmMain, /return "rdpgfx\.wts1:" \+ rest\[:end\]/);
});

test('ClearCodec forensic capture is callable through the Worker bridge', () => {
    assert.match(worker, /requiredExports[^\n]+rdpGetClearCapture/);
    assert.match(bridge, /target\.rdpGetClearCapture = \(\) => this\.call\('rdpGetClearCapture', \[\]\)/);
});
