export function createWorkerFrameScheduler(scope = globalThis, { fallbackMs = 34 } = {}) {
    const pending = new Map();
    let nextId = 1;
    const stats = { mode: typeof scope.requestAnimationFrame === 'function' ? 'raf-watchdog' : 'timer', rafCallbacks: 0, timerCallbacks: 0, rafErrors: 0 };
    const now = () => scope.performance?.now?.() ?? Date.now();

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
        const entry = { rafId: null, timerId: null, done: false };
        pending.set(id, entry);
        const finish = (timestamp, source) => {
            if (entry.done || !pending.has(id)) return;
            entry.done = true;
            if (source === 'raf') stats.rafCallbacks++; else stats.timerCallbacks++;
            cancel(id);
            callback(Number(timestamp) || now());
        };
        if (typeof scope.requestAnimationFrame === 'function') {
            try { entry.rafId = scope.requestAnimationFrame((timestamp) => finish(timestamp, 'raf')); }
            catch { stats.rafErrors++; }
        }
        const delay = entry.rafId === null ? 0 : Math.max(1, Number(fallbackMs) || 34);
        entry.timerId = scope.setTimeout(() => finish(now(), 'timer'), delay);
        return id;
    }

    return { request, cancel, stats };
}
