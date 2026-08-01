export const TERMINAL_HISTORY_GESTURE_DEFAULTS = Object.freeze({
    startThresholdPx: 5,
    dragGain: 1.08,
    maxLinesPerMove: 18,
    velocitySmoothing: 0.72,
    flingStartPxPerMs: 0.22,
    flingStopPxPerMs: 0.035,
    flingFrictionPer16Ms: 0.94,
    maxFlingLinesPerFrame: 12,
});

export function createTerminalHistoryGesture({
    scrollLines,
    getRowHeight = () => 17,
    requestFrame = (fn) => requestAnimationFrame(fn),
    cancelFrame = (id) => cancelAnimationFrame(id),
    now = () => performance.now(),
    onGestureStart = () => {},
    onGestureEnd = () => {},
    options = {},
} = {}) {
    if (typeof scrollLines !== 'function') throw new TypeError('scrollLines is required');
    const cfg = { ...TERMINAL_HISTORY_GESTURE_DEFAULTS, ...options };
    let active = false;
    let moved = false;
    let lastY = 0;
    let lastAt = 0;
    let accumPx = 0;
    let velocityPxPerMs = 0;
    let flingRaf = 0;

    const rowHeight = () => Math.max(1, Number(getRowHeight()) || 17);
    const stopFling = () => {
        if (flingRaf) cancelFrame(flingRaf);
        flingRaf = 0;
    };
    const consumePixels = (pixels, reason, cap) => {
        accumPx += Number(pixels) || 0;
        const rh = rowHeight();
        let lines = Math.trunc(accumPx / rh);
        if (!lines) return 0;
        const limit = Math.max(1, Number(cap) || cfg.maxLinesPerMove);
        lines = Math.max(-limit, Math.min(limit, lines));
        const changed = Number(scrollLines(lines, reason));
        if (!Number.isFinite(changed) || changed === 0) {
            accumPx = 0;
            return 0;
        }
        accumPx -= changed * rh;
        // Reaching a boundary must discard pressure instead of storing a huge
        // remainder that makes the next direction feel stuck.
        if (changed !== lines) accumPx = 0;
        return changed;
    };
    const startFling = () => {
        stopFling();
        if (Math.abs(velocityPxPerMs) < cfg.flingStartPxPerMs) return;
        let velocity = velocityPxPerMs;
        let previous = now();
        const tick = () => {
            const at = now();
            const dt = Math.min(32, Math.max(1, at - previous));
            previous = at;
            velocity *= Math.pow(cfg.flingFrictionPer16Ms, dt / 16);
            if (Math.abs(velocity) < cfg.flingStopPxPerMs) {
                flingRaf = 0;
                onGestureEnd('fling-settled');
                return;
            }
            const changed = consumePixels(
                -velocity * dt * cfg.dragGain,
                'touch-fling',
                cfg.maxFlingLinesPerFrame,
            );
            if (!changed) {
                flingRaf = 0;
                onGestureEnd('fling-boundary');
                return;
            }
            flingRaf = requestFrame(tick);
        };
        flingRaf = requestFrame(tick);
    };

    return {
        start(y, at = now()) {
            stopFling();
            active = true;
            moved = false;
            lastY = Number(y) || 0;
            lastAt = Number(at) || now();
            accumPx = 0;
            velocityPxPerMs = 0;
        },
        move(y, at = now()) {
            if (!active) return { moved: false, lines: 0 };
            const nextY = Number(y) || 0;
            const nextAt = Number(at) || now();
            const dy = nextY - lastY;
            const dt = Math.max(1, Math.min(80, nextAt - lastAt));
            lastY = nextY;
            lastAt = nextAt;
            if (!moved && Math.abs(dy) < cfg.startThresholdPx) return { moved: false, lines: 0 };
            if (!moved) {
                moved = true;
                onGestureStart('touch-drag');
            }
            const instantVelocity = dy / dt;
            velocityPxPerMs = velocityPxPerMs * cfg.velocitySmoothing
                + instantVelocity * (1 - cfg.velocitySmoothing);
            // Native touch physics: viewport movement is opposite finger movement.
            // Finger up (negative dy) advances toward newer lines (positive
            // xterm scrollLines), so the content itself follows the finger up.
            const lines = consumePixels(-dy * cfg.dragGain, 'touch-pan', cfg.maxLinesPerMove);
            return { moved: true, lines };
        },
        end({ cancel = false } = {}) {
            if (!active) return;
            active = false;
            if (cancel || !moved) {
                stopFling();
                onGestureEnd(cancel ? 'touch-cancel' : 'touch-tap');
                return;
            }
            startFling();
            if (!flingRaf) onGestureEnd('touch-end');
        },
        cancel() {
            active = false;
            moved = false;
            accumPx = 0;
            velocityPxPerMs = 0;
            stopFling();
            onGestureEnd('cancel');
        },
        get state() {
            return { active, moved, velocityPxPerMs, flingActive: !!flingRaf, accumPx };
        },
    };
}
