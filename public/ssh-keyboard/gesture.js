/**
 * SSH keyboard gesture classifier — pure state machine, no DOM/timers.
 *
 * States: idle → touching → {tap|pan|pinch|longpress|fling} → idle
 * Only a clean `tap` may open the soft keyboard.
 */

export const GestureKind = Object.freeze({
    IDLE: 'idle',
    TOUCHING: 'touching',
    TAP: 'tap',
    PAN: 'pan',
    PINCH: 'pinch',
    LONGPRESS: 'longpress',
    FLING: 'fling',
    CANCELLED: 'cancelled',
});

export const DEFAULT_GESTURE_THRESHOLDS = Object.freeze({
    movePx: 10,
    tapMaxMs: 300,
    longPressMs: 500,
    flingVelocityPxPerMs: 0.5,
    flingSuppressMs: 300,
});

/**
 * @param {Partial<typeof DEFAULT_GESTURE_THRESHOLDS>} [thresholds]
 */
export function createGestureClassifier(thresholds = {}) {
    const t = { ...DEFAULT_GESTURE_THRESHOLDS, ...thresholds };

    /** @type {{ kind: string, startX: number, startY: number, startTime: number, lastX: number, lastY: number, lastTime: number, pointerCount: number, maxPointerCount: number, moved: boolean, samples: Array<{x:number,y:number,t:number}> }} */
    let track = null;
    let flingUntil = 0;
    let lastResult = { kind: GestureKind.IDLE, at: 0 };

    function nowMs(explicit) {
        return Number.isFinite(explicit) ? explicit : Date.now();
    }

    function resetTrack() {
        track = null;
    }

    function snapshot() {
        return {
            kind: track?.kind || GestureKind.IDLE,
            moved: !!track?.moved,
            pointerCount: track?.pointerCount || 0,
            flingActive: Date.now() < flingUntil,
            lastResult: { ...lastResult },
        };
    }

    /**
     * @param {{ x: number, y: number, time?: number, pointerCount?: number }} e
     */
    function pointerDown(e) {
        const time = nowMs(e.time);
        const pointerCount = Math.max(1, Math.round(Number(e.pointerCount) || 1));
        if (pointerCount > 1) {
            track = {
                kind: GestureKind.PINCH,
                startX: e.x,
                startY: e.y,
                startTime: time,
                lastX: e.x,
                lastY: e.y,
                lastTime: time,
                pointerCount,
                maxPointerCount: pointerCount,
                moved: true,
                samples: [{ x: e.x, y: e.y, t: time }],
            };
            return snapshot();
        }
        track = {
            kind: GestureKind.TOUCHING,
            startX: e.x,
            startY: e.y,
            startTime: time,
            lastX: e.x,
            lastY: e.y,
            lastTime: time,
            pointerCount: 1,
            maxPointerCount: 1,
            moved: false,
            samples: [{ x: e.x, y: e.y, t: time }],
        };
        return snapshot();
    }

    /**
     * @param {{ x: number, y: number, time?: number, pointerCount?: number }} e
     */
    function pointerMove(e) {
        if (!track) return snapshot();
        const time = nowMs(e.time);
        const pointerCount = Math.max(track.pointerCount, Math.round(Number(e.pointerCount) || track.pointerCount || 1));
        track.pointerCount = pointerCount;
        track.maxPointerCount = Math.max(track.maxPointerCount, pointerCount);
        track.lastX = e.x;
        track.lastY = e.y;
        track.lastTime = time;
        track.samples.push({ x: e.x, y: e.y, t: time });
        if (track.samples.length > 12) track.samples.shift();

        if (pointerCount > 1) {
            track.kind = GestureKind.PINCH;
            track.moved = true;
            return snapshot();
        }
        if (track.kind === GestureKind.PINCH) return snapshot();

        const dx = e.x - track.startX;
        const dy = e.y - track.startY;
        const dist = Math.hypot(dx, dy);
        if (dist > t.movePx) {
            track.moved = true;
            if (track.kind !== GestureKind.LONGPRESS) track.kind = GestureKind.PAN;
        } else if (time - track.startTime >= t.longPressMs && !track.moved) {
            track.kind = GestureKind.LONGPRESS;
        }
        return snapshot();
    }

    /**
     * Finalize on pointerup. Returns the classified gesture.
     * @param {{ x?: number, y?: number, time?: number, pointerCount?: number }} [e]
     */
    function pointerUp(e = {}) {
        if (!track) {
            lastResult = { kind: GestureKind.IDLE, at: nowMs(e.time) };
            return { ...lastResult, suppressOpen: Date.now() < flingUntil };
        }
        const time = nowMs(e.time);
        if (Number.isFinite(e.x) && Number.isFinite(e.y)) {
            pointerMove({ x: e.x, y: e.y, time, pointerCount: e.pointerCount });
        }

        let kind = track.kind;
        const duration = Math.max(0, time - track.startTime);
        const dist = Math.hypot((e.x ?? track.lastX) - track.startX, (e.y ?? track.lastY) - track.startY);

        if (track.maxPointerCount > 1 || kind === GestureKind.PINCH) {
            kind = GestureKind.PINCH;
        } else if (kind === GestureKind.LONGPRESS) {
            kind = GestureKind.LONGPRESS;
        } else if (track.moved || dist > t.movePx) {
            // velocity from last samples
            const samples = track.samples;
            let velocity = 0;
            if (samples.length >= 2) {
                const a = samples[0];
                const b = samples[samples.length - 1];
                const dt = Math.max(1, b.t - a.t);
                velocity = Math.hypot(b.x - a.x, b.y - a.y) / dt;
            }
            if (velocity >= t.flingVelocityPxPerMs) {
                kind = GestureKind.FLING;
                flingUntil = time + t.flingSuppressMs;
            } else {
                kind = GestureKind.PAN;
                // short pan still suppresses immediate open briefly
                flingUntil = Math.max(flingUntil, time + 80);
            }
        } else if (duration <= t.tapMaxMs) {
            kind = GestureKind.TAP;
        } else if (duration >= t.longPressMs) {
            kind = GestureKind.LONGPRESS;
        } else {
            // held still but not long enough → treat as cancelled (no open)
            kind = GestureKind.CANCELLED;
        }

        lastResult = {
            kind,
            at: time,
            duration,
            distance: dist,
            startX: track.startX,
            startY: track.startY,
            endX: e.x ?? track.lastX,
            endY: e.y ?? track.lastY,
        };
        resetTrack();
        const suppressOpen = kind !== GestureKind.TAP || Date.now() < flingUntil;
        return { ...lastResult, suppressOpen: kind === GestureKind.TAP ? Date.now() < flingUntil : true };
    }

    function pointerCancel(e = {}) {
        lastResult = { kind: GestureKind.CANCELLED, at: nowMs(e.time) };
        resetTrack();
        return { ...lastResult, suppressOpen: true };
    }

    function isFlingActive(at = Date.now()) {
        return at < flingUntil;
    }

    /** True only when a completed clean tap may open the keyboard. */
    function mayOpenFromLastResult(opts = {}) {
        if (opts.hasSelection) return false;
        if (isFlingActive(opts.at)) return false;
        return lastResult.kind === GestureKind.TAP;
    }

    function forceIdle() {
        resetTrack();
        flingUntil = 0;
        lastResult = { kind: GestureKind.IDLE, at: Date.now() };
    }

    return {
        pointerDown,
        pointerMove,
        pointerUp,
        pointerCancel,
        snapshot,
        isFlingActive,
        mayOpenFromLastResult,
        forceIdle,
        thresholds: t,
        GestureKind,
    };
}

export default createGestureClassifier;
