import { RdpGpuSurfaceCompositor } from './rdp-renderer.js?v=20260718-orientation-contract1';
import { loadGoRuntime } from './rdp-wasm-runtime.js?v=20260718-orientation-contract1';
import { createWorkerFrameScheduler } from './rdp-worker-frame-scheduler.js?v=20260718-orientation-contract1';

export async function runWorkerCapabilityProbe({ runtimeLoader = loadGoRuntime } = {}) {
    if (typeof OffscreenCanvas === 'undefined') return { ok: false, stage: 'offscreen-canvas', error: 'OffscreenCanvas is unavailable' };
    try { await runtimeLoader({ pipeline: 'worker-probe' }); }
    catch (error) { return { ok: false, stage: 'go-runtime-import', error: error?.message || String(error) }; }

    const canvas = new OffscreenCanvas(4, 4);
    const scheduler = createWorkerFrameScheduler(globalThis, { fallbackMs: 34 });
    let compositor;
    try {
        compositor = new RdpGpuSurfaceCompositor(canvas, { requestFrame: scheduler.request, cancelFrame: scheduler.cancel });
        compositor.reset(4, 4);
        compositor.ensureDesktopSurface(4, 4);
        const pixels = new Uint8Array(4 * 4 * 4);
        for (let i = 0; i < pixels.length; i += 4) { pixels[i] = 0; pixels[i + 1] = 0; pixels[i + 2] = 255; pixels[i + 3] = 255; }
        compositor.uploadClassicBitmap({ left: 0, top: 0, right: 4, bottom: 4 }, pixels, 16);
        await new Promise((resolve, reject) => {
            const started = Date.now();
            const poll = () => {
                if ((compositor.diagnostics?.presents || 0) > 0 || compositor.dirty === false) return resolve();
                if (Date.now() - started > 500) return reject(new Error('WebGL2 present callback timed out'));
                setTimeout(poll, 5);
            };
            poll();
        });
        const gl = compositor.gl;
        const out = new Uint8Array(4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.readPixels(2, 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
        if (out[0] < 200 || out[1] > 40 || out[2] > 40 || out[3] < 200) throw new Error(`GPU pixel mismatch: ${[...out].join(',')}`);
        const renderer = gl.getParameter(gl.RENDERER) || 'webgl2';
        compositor.destroy();
        return { ok: true, renderer, goRuntime: true, gpuPixel: [...out], frameScheduler: { ...scheduler.stats } };
    } catch (error) {
        try { compositor?.destroy(); } catch {}
        return { ok: false, stage: 'webgl2-present-pixel', error: error?.message || String(error), frameScheduler: { ...scheduler.stats } };
    }
}

if (typeof postMessage === 'function' && typeof document === 'undefined') {
    runWorkerCapabilityProbe().then((result) => postMessage(result)).catch((error) => {
        postMessage({ ok: false, stage: 'probe', error: error?.message || String(error) });
    });
}
