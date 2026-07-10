/**
 * rdp-touch.js — Windows RD App-level touch controller for RDP WASM client
 *
 * Gesture recognition:
 *   1-finger tap           → left click
 *   1-finger double-tap    → double left click
 *   1-finger long-press    → right click (with haptic feedback dot)
 *   1-finger drag          → mouse move + left button drag
 *   2-finger drag          → inertial scroll (vertical + horizontal)
 *   2-finger pinch         → no zoom; only centroid movement can scroll
 *   3-finger tap           → middle click
 *   3-finger swipe         → configurable remote shortcut
 *   pen/stylus             → precise mouse input
 *
 * Zoom is intentionally not implemented here. The toolbar range control is
 * the only code path allowed to change the RDP viewport scale.
 *
 * Pointer mode:
 *   Direct touch mode (default) — touch position maps directly to remote coords
 *   Relative touchpad mode      — touch delta moves a local cursor (like a trackpad)
 *
 * Local cursor overlay:
 *   Shows a software cursor dot at the current remote pointer position,
 *   so the user knows where clicks will land even when the server cursor
 *   is hidden or the touch is in relative mode.
 */

const LONG_PRESS_MS = 450;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_DIST = 20;
const DRAG_THRESHOLD = 6;
const SCROLL_THRESHOLD = 4;
const THREE_FINGER_SWIPE_THRESHOLD = 40;
const MOVE_THROTTLE_MS = 4;
const FLING_MIN_VELOCITY = 0.05;
const FLING_START_VELOCITY = 0.3;
const FLING_FRICTION = 0.92;

export function applyPointerAcceleration(rawDelta, deltaTimeMs = 16, sensitivity = 1.5) {
    const delta = Number(rawDelta) || 0;
    const dt = Math.max(1, Number(deltaTimeMs) || 16);
    const speed = Math.abs(delta) / dt;
    let multiplier = 0.6;
    if (speed >= 1.2) multiplier = 2.0;
    else if (speed >= 0.25) multiplier = 1.2;
    return delta * multiplier * Math.max(0.5, Math.min(3, Number(sensitivity) || 1.5));
}

export function rdpHaptic(type) {
    if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
    const patterns = {
        tap: 8,
        double_tap: [8, 30, 8],
        long_press: 30,
        error: [50, 30, 50],
        connect: [20, 30, 20],
    };
    const pattern = patterns[type];
    if (pattern === undefined) return;
    try { navigator.vibrate(pattern); } catch {}
}

export class RdpTouchController {
    constructor({ canvas, getConnected, canvasCoords, sendMouseMove, sendMouseDown, sendMouseUp, sendMouseWheel, sendMouseHWheel, sendKeyCombo, pointerOverlay, relativeMode = false, relativeSensitivity = 1.5 }) {
        this.canvas = canvas;
        this.getConnected = getConnected;
        this.canvasCoords = canvasCoords;
        this.sendMouseMove = sendMouseMove;
        this.sendMouseDown = sendMouseDown;
        this.sendMouseUp = sendMouseUp;
        this.sendMouseWheel = sendMouseWheel;
        this.sendMouseHWheel = sendMouseHWheel;
        this.sendKeyCombo = sendKeyCombo;
        this.pointerOverlay = pointerOverlay;

        // Gesture state
        this._state = null;
        this._lastTapTime = 0;
        this._lastTapX = 0;
        this._lastTapY = 0;
        this._longPressTimer = null;
        this._cursorHideTimer = null;
        this._flingRAF = null;
        this._lastMoveAt = 0;
        this._cursorX = Math.max(0, Number(canvas.width) / 2 || 0);
        this._cursorY = Math.max(0, Number(canvas.height) / 2 || 0);
        this._penButton = null;
        this._penPointerId = null;
        this._destroyed = false;

        // Relative (touchpad) mode
        this.relativeMode = !!relativeMode;
        this._relSensitivity = Math.max(0.5, Math.min(3, Number(relativeSensitivity) || 1.5));

        this._handlers = {
            touchstart: (e) => this._onTouchStart(e),
            touchmove: (e) => this._onTouchMove(e),
            touchend: (e) => this._onTouchEnd(e),
            touchcancel: (e) => this._onTouchCancel(e),
            pointerdown: (e) => this._onPenDown(e),
            pointermove: (e) => this._onPenMove(e),
            pointerup: (e) => this._onPenUp(e),
            pointercancel: (e) => this._onPenUp(e),
        };
        this._bind();
    }

    _bind() {
        const c = this.canvas;
        c.style.touchAction = 'none';
        c.addEventListener('touchstart', this._handlers.touchstart, { passive: false });
        c.addEventListener('touchmove', this._handlers.touchmove, { passive: false });
        c.addEventListener('touchend', this._handlers.touchend, { passive: false });
        c.addEventListener('touchcancel', this._handlers.touchcancel, { passive: false });
        // TouchEvent remains the multi-touch recognizer. Pointer Events are
        // added only for pen devices, avoiding duplicate touch/mouse input.
        c.addEventListener('pointerdown', this._handlers.pointerdown);
        c.addEventListener('pointermove', this._handlers.pointermove);
        c.addEventListener('pointerup', this._handlers.pointerup);
        c.addEventListener('pointercancel', this._handlers.pointercancel);
    }

    setRelativeMode(on) {
        this.relativeMode = !!on;
    }

    setRelativeSensitivity(value) {
        this._relSensitivity = Math.max(0.5, Math.min(3, Number(value) || 1.5));
    }

    _onPenDown(e) {
        if (e.pointerType !== 'pen' || !this.getConnected()) return;
        e.preventDefault();
        this._cancelFling();
        try { this.canvas.setPointerCapture(e.pointerId); } catch {}
        const { x, y } = this._coords(e);
        const button = e.button === 2 || (e.buttons & 32) ? 2 : 0;
        this._penButton = button;
        this._penPointerId = e.pointerId;
        this.sendMouseMove(x, y);
        this.sendMouseDown(button, x, y);
        this._showCursor(x, y);
    }

    _onPenMove(e) {
        if (e.pointerType !== 'pen' || e.pointerId !== this._penPointerId || !this.getConnected()) return;
        e.preventDefault();
        const { x, y } = this._coords(e);
        this.sendMouseMove(x, y);
        this._showCursor(x, y);
    }

    _onPenUp(e) {
        if (e.pointerType !== 'pen' || e.pointerId !== this._penPointerId) return;
        e.preventDefault();
        const { x, y } = this._coords(e);
        if (this._penButton !== null) this.sendMouseUp(this._penButton, x, y);
        try { this.canvas.releasePointerCapture(e.pointerId); } catch {}
        this._penButton = null;
        this._penPointerId = null;
    }

    _coords(touch) {
        return this.canvasCoords(touch);
    }

    // Multi-touch gestures use centroid movement only; finger distance is
    // deliberately ignored so pinch cannot become another zoom input.

    _centerCoords(touches) {
        let sx = 0, sy = 0;
        for (let i = 0; i < touches.length; i++) {
            sx += touches[i].clientX;
            sy += touches[i].clientY;
        }
        return this.canvasCoords({ clientX: sx / touches.length, clientY: sy / touches.length });
    }

    _clearLongPress() {
        if (this._longPressTimer) { clearTimeout(this._longPressTimer); this._longPressTimer = null; }
    }

    _cancelFling() {
        if (this._flingRAF !== null) {
            cancelAnimationFrame(this._flingRAF);
            this._flingRAF = null;
        }
    }

    _startFling(velX, velY) {
        this._cancelFling();
        let vx = Number(velX) || 0;
        let vy = Number(velY) || 0;
        if (Math.abs(vx) < FLING_START_VELOCITY) vx = 0;
        if (Math.abs(vy) < FLING_START_VELOCITY) vy = 0;
        if (!vx && !vy) return;
        let lastTime = performance.now();
        const tick = () => {
            if (this._destroyed || !this.getConnected()) { this._flingRAF = null; return; }
            const now = performance.now();
            const dt = Math.min(32, Math.max(1, now - lastTime));
            lastTime = now;
            const decay = Math.pow(FLING_FRICTION, dt / 16);
            vx *= decay;
            vy *= decay;
            if (Math.abs(vy) >= FLING_MIN_VELOCITY) this.sendMouseWheel(-(vy * dt) / 30);
            if (Math.abs(vx) >= FLING_MIN_VELOCITY && this.sendMouseHWheel) this.sendMouseHWheel((vx * dt) / 30);
            if (Math.abs(vx) < FLING_MIN_VELOCITY && Math.abs(vy) < FLING_MIN_VELOCITY) {
                this._flingRAF = null;
                return;
            }
            this._flingRAF = requestAnimationFrame(tick);
        };
        this._flingRAF = requestAnimationFrame(tick);
    }

    _showCursor(x, y) {
        this._cursorX = x;
        this._cursorY = y;
        if (this.pointerOverlay) {
            clearTimeout(this._cursorHideTimer);
            this.pointerOverlay.hidden = false;
            this.pointerOverlay.classList.remove('fading');
            // Convert remote coords to screen position
            const r = this.canvas.getBoundingClientRect();
            const sx = r.left + (x / this.canvas.width) * r.width;
            const sy = r.top + (y / this.canvas.height) * r.height;
            this.pointerOverlay.style.left = sx + 'px';
            this.pointerOverlay.style.top = sy + 'px';
            this._cursorHideTimer = setTimeout(() => {
                if (this.pointerOverlay) this.pointerOverlay.classList.add('fading');
            }, 2000);
        }
    }

    _hideCursor() {
        clearTimeout(this._cursorHideTimer);
        this._cursorHideTimer = null;
        if (this.pointerOverlay) {
            this.pointerOverlay.classList.add('fading');
            this._cursorHideTimer = setTimeout(() => {
                if (this.pointerOverlay?.classList.contains('fading')) this.pointerOverlay.hidden = true;
                this._cursorHideTimer = null;
            }, 300);
        }
    }

    _onTouchStart(e) {
        if (!this.getConnected()) return;
        e.preventDefault();

        const fingers = e.touches.length;
        const t0 = e.touches[0];
        const { x, y } = this._coords(t0);
        const now = performance.now();

        this._clearLongPress();
        this._cancelFling();

        if (fingers === 1) {
            this._state = {
                type: 'pending',  // pending → tap / drag / longpress
                fingers: 1,
                startX: x, startY: y,
                startClientX: t0.clientX, startClientY: t0.clientY,
                startTime: now,
                moved: false,
                dragging: false,
            };

            // Move cursor to touch position, or reveal the existing virtual
            // cursor in relative touchpad mode.
            if (!this.relativeMode) {
                this.sendMouseMove(x, y);
                this._showCursor(x, y);
            } else {
                this._showCursor(this._cursorX, this._cursorY);
            }

            // Start long-press timer
            this._longPressTimer = setTimeout(() => {
                if (!this._state || this._state.moved || this._state.type !== 'pending') return;
                this._state.type = 'longpress';
                // Right click at the virtual cursor in relative mode.
                const sx = this.relativeMode ? Math.round(this._cursorX) : this._state.startX;
                const sy = this.relativeMode ? Math.round(this._cursorY) : this._state.startY;
                this.sendMouseDown(2, sx, sy);
                setTimeout(() => this.sendMouseUp(2, sx, sy), 60);
                // Haptic feedback
                rdpHaptic('long_press');
            }, LONG_PRESS_MS);

        } else if (fingers === 2) {
            this._clearLongPress();
            // Cancel any pending 1-finger action
            if (this._state?.dragging) {
                this.sendMouseUp(0, this._state.startX, this._state.startY);
            }
            const center = this._centerCoords(e.touches);
            const scx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
            const scy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
            this._state = {
                type: '2finger',
                fingers: 2,
                startCenterX: center.x, startCenterY: center.y,
                lastScreenCX: scx, lastScreenCY: scy,
                lastClientX: e.touches[0].clientX, lastClientY: e.touches[0].clientY,
                lastMoveTime: performance.now(),
                velX: 0, velY: 0,
                moved: false,
                gesture: null,
                startTime: performance.now(),
            };

        } else if (fingers === 3) {
            this._clearLongPress();
            if (this._state?.dragging) {
                this.sendMouseUp(0, this._cursorX, this._cursorY);
            }
            const scx = Array.from(e.touches).reduce((sum, t) => sum + t.clientX, 0) / 3;
            const scy = Array.from(e.touches).reduce((sum, t) => sum + t.clientY, 0) / 3;
            this._state = {
                type: '3finger',
                fingers: 3,
                startX: x, startY: y,
                startScreenX: scx, startScreenY: scy,
                lastScreenX: scx, lastScreenY: scy,
                startTime: now,
                moved: false,
                gesture: null,
            };
        }
    }

    _onTouchMove(e) {
        if (!this.getConnected() || !this._state) return;
        e.preventDefault();

        const now = performance.now();
        if (now - this._lastMoveAt < MOVE_THROTTLE_MS) return;
        this._lastMoveAt = now;

        const fingers = e.touches.length;

        if (this._state.type === 'pending' && fingers === 1) {
            const t = e.touches[0];
            const { x, y } = this._coords(t);
            const dx = x - this._state.startX;
            const dy = y - this._state.startY;

            if (!this._state.moved && (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)) {
                this._state.moved = true;
                this._state.type = 'drag';
                this._clearLongPress();
                this._state.lastClientX = this._state.startClientX;
                this._state.lastClientY = this._state.startClientY;
                this._state.lastMoveTime = this._state.startTime;

                if (this.relativeMode) {
                    // In relative mode, the cursor is already at _cursorX/_cursorY
                    this.sendMouseDown(0, this._cursorX, this._cursorY);
                } else {
                    this.sendMouseDown(0, this._state.startX, this._state.startY);
                }
                this._state.dragging = true;
            }

            if (this._state.dragging) {
                if (this.relativeMode) {
                    const lastX = this._state.lastClientX ?? this._state.startClientX;
                    const lastY = this._state.lastClientY ?? this._state.startClientY;
                    const dt = now - (this._state.lastMoveTime || now);
                    const rdx = applyPointerAcceleration(t.clientX - lastX, dt, this._relSensitivity);
                    const rdy = applyPointerAcceleration(t.clientY - lastY, dt, this._relSensitivity);
                    this._state.lastClientX = t.clientX;
                    this._state.lastClientY = t.clientY;
                    this._state.lastMoveTime = now;
                    this._cursorX = Math.max(0, Math.min(this.canvas.width, this._cursorX + rdx));
                    this._cursorY = Math.max(0, Math.min(this.canvas.height, this._cursorY + rdy));
                    this.sendMouseMove(Math.round(this._cursorX), Math.round(this._cursorY));
                    this._showCursor(this._cursorX, this._cursorY);
                } else {
                    this.sendMouseMove(x, y);
                    this._showCursor(x, y);
                }
            }

        } else if (this._state.type === '2finger' && fingers >= 2) {
            /* Two fingers are scroll-only. A distance-only pinch has no side
             * effect; centroid movement is the sole classifier. This keeps
             * the toolbar range as the only zoom entry point. */
            const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
            const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
            const screenDx = cx - this._state.lastScreenCX;
            const screenDy = cy - this._state.lastScreenCY;
            if (!this._state.gesture && (Math.abs(screenDy) > SCROLL_THRESHOLD || Math.abs(screenDx) > SCROLL_THRESHOLD)) {
                this._state.gesture = 'scroll';
            }

            if (this._state.gesture === 'scroll') {
                const dt = Math.max(1, now - (this._state.lastMoveTime || now));
                const instantX = screenDx / dt;
                const instantY = screenDy / dt;
                this._state.velX = this._state.velX ? this._state.velX * 0.7 + instantX * 0.3 : instantX;
                this._state.velY = this._state.velY ? this._state.velY * 0.7 + instantY * 0.3 : instantY;
                this._state.lastMoveTime = now;
                if (Math.abs(screenDy) > 1) this.sendMouseWheel(-screenDy / 30);
                if (Math.abs(screenDx) > 1 && this.sendMouseHWheel) this.sendMouseHWheel(screenDx / 30);
                this._state.lastScreenCX = cx;
                this._state.lastScreenCY = cy;
                this._state.moved = true;
            }

        } else if (this._state.type === '3finger' && fingers >= 3) {
            const cx = Array.from(e.touches).slice(0, 3).reduce((sum, t) => sum + t.clientX, 0) / 3;
            const cy = Array.from(e.touches).slice(0, 3).reduce((sum, t) => sum + t.clientY, 0) / 3;
            const dx = cx - this._state.startScreenX;
            const dy = cy - this._state.startScreenY;
            if (!this._state.gesture && Math.max(Math.abs(dx), Math.abs(dy)) >= THREE_FINGER_SWIPE_THRESHOLD) {
                this._state.gesture = Math.abs(dy) >= Math.abs(dx)
                    ? (dy < 0 ? '3up' : '3down')
                    : (dx < 0 ? '3left' : '3right');
                this._state.moved = true;
            }
            this._state.lastScreenX = cx;
            this._state.lastScreenY = cy;
        }
    }

    _onTouchCancel(e) {
        if (!this._state) return;
        e.preventDefault();
        this._clearLongPress();
        this._cancelFling();
        if (this._state.dragging) {
            const x = this.relativeMode ? Math.round(this._cursorX) : this._state.startX;
            const y = this.relativeMode ? Math.round(this._cursorY) : this._state.startY;
            this.sendMouseUp(0, x, y);
        }
        this._state = null;
    }

    _onTouchEnd(e) {
        if (!this.getConnected() || !this._state) return;
        e.preventDefault();

        this._clearLongPress();
        const now = performance.now();

        // Multi-finger gestures finish only after the last finger is lifted;
        // otherwise one gesture would fire again for every departing finger.
        if ((this._state.type === '2finger' || this._state.type === '3finger') && e.touches.length > 0) return;

        if (this._state.type === 'pending' && !this._state.moved) {
            // It was a tap (no drag, no long press)
            const x = this.relativeMode ? Math.round(this._cursorX) : this._state.startX;
            const y = this.relativeMode ? Math.round(this._cursorY) : this._state.startY;
            const dt = now - this._state.startTime;

            if (dt < LONG_PRESS_MS) {
                // Check for double-tap
                const tapDt = now - this._lastTapTime;
                const tapDist = Math.abs(x - this._lastTapX) + Math.abs(y - this._lastTapY);

                if (tapDt < DOUBLE_TAP_MS && tapDist < DOUBLE_TAP_DIST) {
                    // The first tap was already sent immediately. Send exactly
                    // one more click so the pair is a double-click, not a triple.
                    this.sendMouseDown(0, x, y);
                    setTimeout(() => this.sendMouseUp(0, x, y), 40);
                    this._lastTapTime = 0;
                    rdpHaptic('double_tap');
                } else {
                    // Immediate single click; never wait for the double-tap window.
                    this.sendMouseDown(0, x, y);
                    setTimeout(() => this.sendMouseUp(0, x, y), 40);
                    this._lastTapTime = now;
                    this._lastTapX = x;
                    this._lastTapY = y;
                    rdpHaptic('tap');
                }
            }

        } else if (this._state.type === 'longpress') {
            // Already handled in timer
        } else if (this._state.type === 'drag' && this._state.dragging) {
            const t = e.changedTouches?.[0];
            if (t) {
                const { x, y } = this._coords(t);
                if (!this.relativeMode) {
                    this.sendMouseUp(0, x, y);
                } else {
                    this.sendMouseUp(0, Math.round(this._cursorX), Math.round(this._cursorY));
                }
            } else {
                this.sendMouseUp(0, this._state.startX, this._state.startY);
            }

        } else if (this._state.type === '3finger' && !this._state.moved) {
            // 3-finger tap → middle click
            const x = this.relativeMode ? Math.round(this._cursorX) : this._state.startX;
            const y = this.relativeMode ? Math.round(this._cursorY) : this._state.startY;
            this.sendMouseDown(1, x, y);
            setTimeout(() => this.sendMouseUp(1, x, y), 40);
            rdpHaptic('tap');

        } else if (this._state.type === '3finger' && this._state.gesture) {
            this.sendKeyCombo?.(this._state.gesture);
            rdpHaptic('tap');

        } else if (this._state.type === '2finger' && this._state.gesture === 'scroll') {
            this._startFling(this._state.velX, this._state.velY);
        }

        // Only clear state when all fingers are lifted
        if (e.touches.length === 0) {
            this._state = null;
        }
    }

    destroy() {
        this._destroyed = true;
        this._clearLongPress();
        this._cancelFling();
        this._hideCursor();
        if (this._penButton !== null) {
            this.sendMouseUp(this._penButton, Math.round(this._cursorX), Math.round(this._cursorY));
        }
        const c = this.canvas;
        c.removeEventListener('touchstart', this._handlers.touchstart);
        c.removeEventListener('touchmove', this._handlers.touchmove);
        c.removeEventListener('touchend', this._handlers.touchend);
        c.removeEventListener('touchcancel', this._handlers.touchcancel);
        c.removeEventListener('pointerdown', this._handlers.pointerdown);
        c.removeEventListener('pointermove', this._handlers.pointermove);
        c.removeEventListener('pointerup', this._handlers.pointerup);
        c.removeEventListener('pointercancel', this._handlers.pointercancel);
        this._penButton = null;
        this._penPointerId = null;
        this._state = null;
    }
}
