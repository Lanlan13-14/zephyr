import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

let source = await fs.readFile(new URL('../public/rdp-worker-probe.js', import.meta.url), 'utf8');
source = source
    .replace(/^import \{ RdpGpuSurfaceCompositor \} from '.\/rdp-renderer\.js\?v=[^']+';$/m, 'const RdpGpuSurfaceCompositor = class { constructor(canvas, options) { return new globalThis.__ProbeCompositor(canvas, options); } };')
    .replace(/^import \{ loadGoRuntime \} from '.\/rdp-wasm-runtime\.js\?v=[^']+';$/m, 'const loadGoRuntime = async () => class Go {};')
    .replace(/^import \{ createWorkerFrameScheduler \} from '.\/rdp-worker-frame-scheduler\.js\?v=[^']+';$/m, 'const createWorkerFrameScheduler = (...args) => globalThis.__CreateProbeScheduler(...args);')
    .replace("if (typeof postMessage === 'function' && typeof document === 'undefined')", 'if (false)');
const { runWorkerCapabilityProbe } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

function installProbe({ pixel = [255, 0, 0, 255] } = {}) {
    const previous = {
        canvas: globalThis.OffscreenCanvas,
        compositor: globalThis.__ProbeCompositor,
        scheduler: globalThis.__CreateProbeScheduler,
    };
    const calls = [];
    globalThis.OffscreenCanvas = class { constructor(width, height) { this.width = width; this.height = height; } };
    globalThis.__CreateProbeScheduler = () => ({
        request(callback) { setTimeout(() => callback(performance.now()), 0); return 1; },
        cancel() {},
        stats: { mode: 'test', rafCallbacks: 0, timerCallbacks: 1, rafErrors: 0 },
    });
    globalThis.__ProbeCompositor = class {
        constructor(canvas, options) {
            this.canvas = canvas; this.options = options; this.dirty = false;
            this.gl = {
                RENDERER: 1, FRAMEBUFFER: 2, RGBA: 3, UNSIGNED_BYTE: 4,
                getParameter: () => 'mock-webgl2', bindFramebuffer() {},
                readPixels(x, y, w, h, format, type, out) { out.set(pixel); },
            };
        }
        reset(width, height) { calls.push(['reset', width, height]); }
        ensureDesktopSurface(width, height) { calls.push(['surface', width, height]); }
        uploadClassicBitmap(rect, bytes, stride) { calls.push(['upload', rect, bytes.byteLength, stride]); this.dirty = true; this.options.requestFrame(() => { this.dirty = false; }); }
        capturePixels() {
            calls.push(['capture']);
            const pixels = new Uint8Array(4 * 4 * 4);
            for (let i = 0; i < pixels.length; i += 4) pixels.set(pixel, i);
            return { width: 4, height: 4, pixels };
        }
        destroy() { calls.push(['destroy']); }
    };
    return {
        calls,
        restore() {
            if (previous.canvas) globalThis.OffscreenCanvas = previous.canvas; else delete globalThis.OffscreenCanvas;
            if (previous.compositor) globalThis.__ProbeCompositor = previous.compositor; else delete globalThis.__ProbeCompositor;
            if (previous.scheduler) globalThis.__CreateProbeScheduler = previous.scheduler; else delete globalThis.__CreateProbeScheduler;
        },
    };
}

test('Worker probe reports unavailable OffscreenCanvas explicitly', async () => {
    const previous = globalThis.OffscreenCanvas;
    delete globalThis.OffscreenCanvas;
    try {
        assert.deepEqual(await runWorkerCapabilityProbe(), { ok: false, stage: 'offscreen-canvas', error: 'OffscreenCanvas is unavailable' });
    } finally {
        if (previous) globalThis.OffscreenCanvas = previous;
    }
});

test('Worker probe imports Go ESM runtime before GPU work', async () => {
    const fixture = installProbe();
    try {
        assert.deepEqual(await runWorkerCapabilityProbe({ runtimeLoader: async () => { throw new Error('runtime 404'); } }), {
            ok: false, stage: 'go-runtime-import', error: 'runtime 404',
        });
        assert.equal(fixture.calls.length, 0);
    } finally { fixture.restore(); }
});

test('Worker probe executes upload, scheduled present and pixel readback', async () => {
    const fixture = installProbe();
    try {
        const result = await runWorkerCapabilityProbe();
        assert.equal(result.ok, true);
        assert.equal(result.renderer, 'mock-webgl2');
        assert.deepEqual(result.gpuPixel, [255, 0, 0, 255]);
        assert.deepEqual(fixture.calls.slice(0, 3).map((entry) => entry[0]), ['reset', 'surface', 'upload']);
        assert.equal(fixture.calls.at(-1)[0], 'destroy');
    } finally { fixture.restore(); }
});

test('Worker probe fails closed on incorrect GPU pixel', async () => {
    const fixture = installProbe({ pixel: [0, 0, 0, 255] });
    try {
        const result = await runWorkerCapabilityProbe();
        assert.equal(result.ok, false);
        assert.equal(result.stage, 'webgl2-present-pixel');
        assert.match(result.error, /GPU pixel mismatch/);
    } finally { fixture.restore(); }
});

test('Worker probe source never stubs frame scheduling', () => {
    assert.doesNotMatch(source, /requestFrame:\s*\(\)\s*=>\s*1/);
    assert.match(source, /compositor\.capturePixels\(\)/);
    assert.match(source, /WebGL2 present callback timed out/);
});
