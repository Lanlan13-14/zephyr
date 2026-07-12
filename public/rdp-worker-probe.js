import { RdpGpuSurfaceCompositor } from './rdp-renderer.js';
import { loadGoRuntime } from './rdp-wasm-runtime.js?v=20260711-go-esm2';

export async function runWorkerCapabilityProbe({ runtimeLoader = loadGoRuntime } = {}) {
    if (typeof OffscreenCanvas === 'undefined') return { ok: false, stage: 'offscreen-canvas', error: 'OffscreenCanvas is unavailable' };

    try {
        await runtimeLoader({ pipeline: 'worker-probe' });
    } catch (error) {
        return { ok: false, stage: 'go-runtime-import', error: error?.message || String(error) };
    }

    const canvas = new OffscreenCanvas(64, 64);
    let compositor;
    try {
        compositor = new RdpGpuSurfaceCompositor(canvas, { requestFrame: () => 1, cancelFrame: () => {} });
        const renderer = compositor.gl.getParameter(compositor.gl.RENDERER) || 'webgl2';
        compositor.destroy();
        return { ok: true, renderer, goRuntime: true };
    } catch (error) {
        try { compositor?.destroy(); } catch {}
        return { ok: false, stage: 'webgl2-compositor', error: error?.message || String(error) };
    }
}

if (typeof postMessage === 'function' && typeof document === 'undefined') {
    runWorkerCapabilityProbe().then((result) => postMessage(result)).catch((error) => {
        postMessage({ ok: false, stage: 'probe', error: error?.message || String(error) });
    });
}
