export const RDP_PIPELINES = Object.freeze(['worker-gpu-v2']);

export function normalizeRdpPipeline() {
    return 'worker-gpu-v2';
}

export function createRdpDiagnostics(initial = {}) {
    const state = {
        pipeline: 'worker-gpu-v2',
        renderer: 'unknown',
        codec: 'bitmap',
        fallbackReason: '',
        fps: 0,
        frames: 0,
        presents: 0,
        lastFrameAt: 0,
        bitmapCalls: 0,
        bitmapBytes: 0,
        bitmapLast: null,
        h264Calls: 0,
        h264Frames: 0,
        drawFails: 0,
        lastDrawError: '',
        glError: 0,
        transport: {
            rxBytes: 0,
            txBytes: 0,
            queuedBytes: 0,
            queuedChunks: 0,
            protocolDrops: 0,
            pauses: 0,
            resumes: 0,
        },
        gfx: {
            framesStarted: 0,
            framesEnded: 0,
            framesAcked: 0,
            frameBacklog: 0,
        },
        ...initial,
    };

    function notePresentedFrame(now = performance.now()) {
        const dt = state.lastFrameAt ? now - state.lastFrameAt : 0;
        const instant = dt > 0 ? 1000 / dt : 0;
        state.fps = state.fps ? state.fps * 0.85 + instant * 0.15 : instant;
        state.frames++;
        state.presents++;
        state.lastFrameAt = now;
    }

    function snapshot() {
        return JSON.parse(JSON.stringify(state));
    }

    return { state, notePresentedFrame, snapshot };
}
