import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';

const inputSource = await fs.readFile(new URL('../public/rdp-input-channel.js', import.meta.url), 'utf8');
const bridgeSource = (await fs.readFile(new URL('../public/rdp-worker-bridge.js', import.meta.url), 'utf8'))
    .replace(/import \{ OrderedRdpInputChannel \} from '\.\/rdp-input-channel\.js[^']*';/, `const { OrderedRdpInputChannel } = await import('data:text/javascript;base64,${Buffer.from(inputSource).toString('base64')}');`);
const { RdpWorkerBridge } = await import(`data:text/javascript;base64,${Buffer.from(bridgeSource).toString('base64')}`);

class MockWorker extends EventEmitter {
    constructor() { super(); this.sent = []; this.terminated = false; }
    addEventListener(type, fn) { this.on(type, fn); }
    postMessage(message, transfer = []) { this.sent.push({ message, transfer }); }
    terminate() { this.terminated = true; }
    message(data) { this.emit('message', { data }); }
}

test('Worker bridge transfers OffscreenCanvas and resolves readiness', async () => {
    const worker = new MockWorker();
    const bridge = new RdpWorkerBridge(worker, { syncBytes: 1024 });
    const offscreen = { tag: 'offscreen' };
    const canvas = { transferControlToOffscreen: () => offscreen };
    const ready = bridge.init(canvas, { width: 10 });
    assert.equal(worker.sent[0].message.canvas, offscreen);
    assert.deepEqual(worker.sent[0].transfer, [offscreen]);
    worker.message({ type: 'ready', capabilities: { worker: true } });
    assert.deepEqual(await ready, { worker: true });
});

test('Worker bridge request/response is explicit and timed', async () => {
    const worker = new MockWorker();
    const bridge = new RdpWorkerBridge(worker, { syncBytes: 1024 });
    const promise = bridge.call('method', [1]);
    const id = worker.sent.at(-1).message.id;
    worker.message({ type: 'response', id, ok: true, value: 7 });
    assert.equal(await promise, 7);
});

test('Worker bridge promotes connection startup to acknowledged RPC', async () => {
    const worker = new MockWorker();
    const bridge = new RdpWorkerBridge(worker, { syncBytes: 1024 });
    const target = {};
    bridge.installGlobals(target);
    const promise = target.rdpConnect('wss://example.test', 'rdp', '3389');
    const sent = worker.sent.at(-1).message;
    assert.equal(sent.type, 'request');
    assert.equal(sent.method, 'rdpConnect');
    worker.message({ type: 'response', id: sent.id, ok: true, value: null });
    assert.equal(await promise, null);
});

test('Worker bridge close is idempotent and rejects boot plus later calls', async () => {
    const worker = new MockWorker();
    const bridge = new RdpWorkerBridge(worker, { syncBytes: 1024 });
    bridge.close();
    bridge.close();
    assert.equal(worker.terminated, true);
    await assert.rejects(bridge.ready, /closed during boot/);
    await assert.rejects(() => bridge.call('method'), /closed/);
    assert.throws(() => bridge.notify('method'), /closed/);
});

test('Worker input uses ordered envelopes', () => {
    const worker = new MockWorker();
    const bridge = new RdpWorkerBridge(worker, { syncBytes: 1024 });
    bridge.input.push('mouse-move', { x: 1 });
    bridge.input.push('mouse-move', { x: 2 });
    bridge.input.push('mouse-down', { button: 0 });
    const inputs = worker.sent.filter(({ message }) => message.type === 'input').map(({ message }) => message.envelope);
    assert.deepEqual(inputs.map((event) => event.type), ['mouse-move', 'mouse-down']);
    assert.equal(inputs[0].payload.x, 2);
});

test('Worker bridge sends Unicode text through the ordered input channel', () => {
    const worker = new MockWorker();
    const bridge = new RdpWorkerBridge(worker, { syncBytes: 1024 });
    const target = {};
    bridge.installGlobals(target);
    target.rdpUnicodeText('中文😀');
    const envelope = worker.sent.at(-1).message.envelope;
    assert.equal(envelope.type, 'unicode-text');
    assert.equal(envelope.payload.text, '中文😀');
});


test('Worker bridge rejects init immediately with exact GPU boot stage', async () => {
    const worker = new MockWorker();
    const bridge = new RdpWorkerBridge(worker, { syncBytes: 1024, timeoutMs: 1000 });
    const ready = bridge.init({ transferControlToOffscreen: () => ({}) });
    worker.message({ type: 'boot-stage', stage: 'webgl2-compositor-starting' });
    worker.message({ type: 'boot-error', code: 'WORKER_GPU_INIT_FAILED', stage: 'webgl2-compositor-starting', error: 'WebGL2 unavailable' });
    await assert.rejects(ready, /WORKER_GPU_INIT_FAILED at webgl2-compositor-starting: WebGL2 unavailable/);
});


test('Worker bridge exposes acknowledged GPU diagnostics RPC', async () => {
    const worker = new MockWorker();
    const bridge = new RdpWorkerBridge(worker, { syncBytes: 1024 });
    const target = {};
    bridge.installGlobals(target);
    const promise = target.rdpGetWorkerDiagnostics();
    const sent = worker.sent.at(-1).message;
    assert.equal(sent.type, 'request');
    assert.equal(sent.method, 'rdpGetWorkerDiagnostics');
    worker.message({ type: 'response', id: sent.id, ok: true, value: { semanticEvents: 2, presents: 1 } });
    assert.deepEqual(await promise, { semanticEvents: 2, presents: 1 });
});
