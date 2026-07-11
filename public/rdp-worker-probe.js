import { RdpGpuSurfaceCompositor } from './rdp-renderer.js';

export function runWorkerWebglProbe() {
    if (typeof OffscreenCanvas === 'undefined') return { ok: false, error: 'OffscreenCanvas is unavailable' };
    const canvas = new OffscreenCanvas(64, 64);
    let compositor;
    try {
        compositor = new RdpGpuSurfaceCompositor(canvas, { requestFrame: () => 1, cancelFrame: () => {} });
        const renderer = compositor.gl.getParameter(compositor.gl.RENDERER) || 'webgl2';
        compositor.destroy();
        return { ok: true, renderer };
    } catch (error) {
        try { compositor?.destroy(); } catch {}
        return { ok: false, error: error.message || String(error) };
    }
}

if (typeof postMessage === 'function' && typeof document === 'undefined') {
    try { postMessage(runWorkerWebglProbe()); }
    catch (error) { postMessage({ ok: false, error: error.message || String(error) }); }
}
