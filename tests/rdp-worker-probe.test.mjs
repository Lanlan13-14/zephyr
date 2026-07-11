import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

let source = await fs.readFile(new URL('../public/rdp-worker-probe.js', import.meta.url), 'utf8');
source = source
    .replace("import { RdpGpuSurfaceCompositor } from './rdp-renderer.js';", 'const RdpGpuSurfaceCompositor = class { constructor(canvas, options) { return new globalThis.__ProbeCompositor(canvas, options); } };')
    .replace("if (typeof postMessage === 'function' && typeof document === 'undefined')", 'if (false)');
const { runWorkerWebglProbe } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('Worker WebGL probe reports unavailable API explicitly', () => {
    const previous = globalThis.OffscreenCanvas;
    delete globalThis.OffscreenCanvas;
    try { assert.deepEqual(runWorkerWebglProbe(), { ok: false, error: 'OffscreenCanvas is unavailable' }); }
    finally { if (previous) globalThis.OffscreenCanvas = previous; }
});

test('Worker WebGL probe validates full compositor construction', () => {
    const previousCanvas = globalThis.OffscreenCanvas;
    const previousCompositor = globalThis.__ProbeCompositor;
    let destroyed = false;
    globalThis.OffscreenCanvas = class {};
    globalThis.__ProbeCompositor = class {
        constructor() { this.gl = { RENDERER: 1, getParameter: () => 'mock-webgl2' }; }
        destroy() { destroyed = true; }
    };
    try {
        assert.deepEqual(runWorkerWebglProbe(), { ok: true, renderer: 'mock-webgl2' });
        assert.equal(destroyed, true);
    } finally {
        if (previousCanvas) globalThis.OffscreenCanvas = previousCanvas; else delete globalThis.OffscreenCanvas;
        if (previousCompositor) globalThis.__ProbeCompositor = previousCompositor; else delete globalThis.__ProbeCompositor;
    }
});
