import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

let source = await fs.readFile(new URL('../public/rdp-worker-probe.js', import.meta.url), 'utf8');
source = source
    .replace("import { RdpGpuSurfaceCompositor } from './rdp-renderer.js';", 'const RdpGpuSurfaceCompositor = class { constructor(canvas, options) { return new globalThis.__ProbeCompositor(canvas, options); } };')
    .replace("import { loadGoRuntime } from './rdp-wasm-runtime.js?v=20260711-go-esm2';", 'const loadGoRuntime = async () => class Go {};')
    .replace("if (typeof postMessage === 'function' && typeof document === 'undefined')", 'if (false)');
const { runWorkerCapabilityProbe } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('Worker probe reports unavailable OffscreenCanvas explicitly', async () => {
    const previous = globalThis.OffscreenCanvas;
    delete globalThis.OffscreenCanvas;
    try {
        assert.deepEqual(await runWorkerCapabilityProbe(), { ok: false, stage: 'offscreen-canvas', error: 'OffscreenCanvas is unavailable' });
    } finally {
        if (previous) globalThis.OffscreenCanvas = previous;
    }
});

test('Worker probe imports the Go ESM runtime before canvas transfer', async () => {
    const previousCanvas = globalThis.OffscreenCanvas;
    globalThis.OffscreenCanvas = class {};
    try {
        assert.deepEqual(await runWorkerCapabilityProbe({ runtimeLoader: async () => { throw new Error('runtime 404'); } }), {
            ok: false,
            stage: 'go-runtime-import',
            error: 'runtime 404',
        });
    } finally {
        if (previousCanvas) globalThis.OffscreenCanvas = previousCanvas; else delete globalThis.OffscreenCanvas;
    }
});

test('Worker probe validates runtime and full compositor construction', async () => {
    const previousCanvas = globalThis.OffscreenCanvas;
    const previousCompositor = globalThis.__ProbeCompositor;
    let destroyed = false;
    globalThis.OffscreenCanvas = class {};
    globalThis.__ProbeCompositor = class {
        constructor() { this.gl = { RENDERER: 1, getParameter: () => 'mock-webgl2' }; }
        destroy() { destroyed = true; }
    };
    try {
        assert.deepEqual(await runWorkerCapabilityProbe(), { ok: true, renderer: 'mock-webgl2', goRuntime: true });
        assert.equal(destroyed, true);
    } finally {
        if (previousCanvas) globalThis.OffscreenCanvas = previousCanvas; else delete globalThis.OffscreenCanvas;
        if (previousCompositor) globalThis.__ProbeCompositor = previousCompositor; else delete globalThis.__ProbeCompositor;
    }
});
