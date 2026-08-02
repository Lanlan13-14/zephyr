export function createWorkerFrameScheduler(scope = globalThis, { fallbackMs = 16, targetFps = 0 } = {}) {
    const pending = new Map();
    let nextId = 1;
    let paceToTarget = Number(targetFps) > 0;
    let intervalMs = paceToTarget ? 1000 / Number(targetFps) : Math.max(1, Number(fallbackMs) || 16);
    let lastCallbackAt = 0;
    const stats = {
        mode: typeof scope.requestAnimationFrame === 'function' ? 'raf-watchdog' : 'timer',
        targetFps: paceToTarget ? Number(targetFps) : Math.round(1000 / intervalMs),
        intervalMs,
        rafCallbacks: 0,
        rafEarlyCallbacks: 0,
        timerCallbacks: 0,
        rafErrors: 0,
        callbacks: 0,
        effectiveFps: 0,
        lastCallbackDelayMs: 0,
    };
    const now = () => scope.performance?.now?.() ?? Date.now();

    function setTargetFps(value) {
        const fps = Number(value);
        if (!Number.isFinite(fps) || fps <= 0) return stats.targetFps;
        const effective = Math.max(1, Math.min(240, fps));
        paceToTarget = true;
        intervalMs = 1000 / effective;
        stats.targetFps = effective;
        stats.intervalMs = intervalMs;
        return effective;
    }

    function cancel(id) {
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        if (entry.rafId !== null && typeof scope.cancelAnimationFrame === 'function') {
            try { scope.cancelAnimationFrame(entry.rafId); } catch {}
        }
        if (entry.timerId !== null) scope.clearTimeout(entry.timerId);
    }

    function request(callback) {
        const id = nextId++;
        const requestedAt = now();
        // Pace from the last actual callback, not from this request. Rendering
        // and command-queue work between callbacks must consume part of the
        // frame budget instead of being added on top of it. This avoids timer
        // drift at 120/144 FPS and also presents immediately after a long idle.
        const notBefore = paceToTarget && lastCallbackAt > 0
            ? Math.max(requestedAt, lastCallbackAt + intervalMs)
            : requestedAt;
        const entry = { rafId: null, timerId: null, done: false, notBefore };
        pending.set(id, entry);
        const finish = (timestamp, source) => {
            if (entry.done || !pending.has(id)) return;
            entry.done = true;
            if (source === 'raf') stats.rafCallbacks++; else stats.timerCallbacks++;
            cancel(id);
            const firedAt = now();
            if (lastCallbackAt > 0) {
                const delta = Math.max(0.01, firedAt - lastCallbackAt);
                const instantaneousFps = Math.min(1000, 1000 / delta);
                stats.lastCallbackDelayMs = delta;
                stats.effectiveFps = stats.effectiveFps > 0
                    ? stats.effectiveFps * 0.8 + instantaneousFps * 0.2
                    : instantaneousFps;
            }
            stats.callbacks++;
            lastCallbackAt = firedAt;
            callback(Number(timestamp) || now());
        };
        if (typeof scope.requestAnimationFrame === 'function') {
            try {
                entry.rafId = scope.requestAnimationFrame((timestamp) => {
                    entry.rafId = null;
                    // Worker rAF is commonly locked to a 60 Hz display. The
                    // watchdog must be allowed to win at 120/144 FPS, while
                    // early rAF callbacks must not defeat 30/45 FPS pacing.
                    if (paceToTarget && now() + 0.25 < entry.notBefore) {
                        stats.rafEarlyCallbacks++;
                        return;
                    }
                    finish(timestamp, 'raf');
                });
            }
            catch { stats.rafErrors++; }
        }
        const delay = Math.max(0, entry.notBefore - now());
        entry.timerId = scope.setTimeout(() => finish(now(), 'timer'), delay);
        return id;
    }

    return { request, cancel, setTargetFps, stats };
}
