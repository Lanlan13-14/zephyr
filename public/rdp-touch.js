const LONG_PRESS_MS = 450;
const DOUBLE_TAP_MS = 180;
const DOUBLE_TAP_DIST = 24;
const DRAG_THRESHOLD = 6;
const SCROLL_THRESHOLD = 4;
const PINCH_THRESHOLD = 15;
const MOVE_THROTTLE_MS = 4;
const FLING_FRICTION = 0.92;
const FLING_MIN_VEL = 0.05;
const FLING_START_VEL = 0.30;

function haptic(type) {
    if (!navigator.vibrate) return;
    try {
        if (type === 'tap') navigator.vibrate(8);
        else if (type === 'double_tap') navigator.vibrate([8, 30, 8]);
        else if (type === 'long_press') navigator.vibrate(30);
        else if (type === 'error') navigator.vibrate([50, 30, 50]);
        else if (type === 'connect') navigator.vibrate([20, 30, 20]);
    } catch {}
}

function applyPointerAcceleration(rawDelta, sensitivity = 1.5) {
    const abs = Math.abs(rawDelta);
    const mult = abs < 3 ? 0.6 * sensitivity : abs < 10 ? 1.2 * sensitivity : 2.0 * sensitivity;
    return rawDelta * mult;
}

export class RdpTouchController {
    constructor({ canvas, getConnected, canvasCoords, sendMouseMove, sendMouseDown, sendMouseUp, sendMouseWheel, onZoomChange, pointerOverlay }) {
        this.canvas = canvas;
        this.getConnected = getConnected;
        this.canvasCoords = canvasCoords;
        this.sendMouseMove = sendMouseMove;
        this.sendMouseDown = sendMouseDown;
        this.sendMouseUp = sendMouseUp;
        this.sendMouseWheel = sendMouseWheel;
        this.onZoomChange = onZoomChange;
        this.pointerOverlay = pointerOverlay;
        this._state = null;
        this._activePointers = new Map();
        this._lastTapTime = 0;
        this._lastTapX = 0;
        this._lastTapY = 0;
        this._singleTapTimer = null;
        this._longPressTimer = null;
        this._cursorHideTimer = null;
        this._flingRAF = null;
        this._lastMoveAt = 0;
        this._cursorX = 0;
        this._cursorY = 0;
        this._penButton = null;
        this.relativeMode = false;
        this._relSensitivity = 1.5;
        this._pinchStartDist = 0;
        this._pinchStartZoom = 1;
        this._currentZoom = 1;
        this._bound = [];
        this._bind();
    }

    setRelativeMode(on) { this.relativeMode = !!on; }
    setRelativeSensitivity(value) { this._relSensitivity = Math.max(0.5, Math.min(3, Number(value) || 1.5)); }

    _bind() {
        const c = this.canvas;
        c.style.touchAction = 'none';
        c.style.userSelect = 'none';
        c.style.webkitUserSelect = 'none';
        const opts = { passive: false };
        this._listen(c, 'pointerdown', (e) => this._onPointerDown(e), opts);
        this._listen(c, 'pointermove', (e) => this._onPointerMove(e), opts);
        this._listen(c, 'pointerup', (e) => this._onPointerUp(e), opts);
        this._listen(c, 'pointercancel', (e) => this._onPointerUp(e), opts);
        this._listen(c, 'lostpointercapture', (e) => this._onPointerUp(e), opts);
    }

    _listen(el, type, fn, opts) { el.addEventListener(type, fn, opts); this._bound.push([el, type, fn, opts]); }
    _coords(e) { return this.canvasCoords(e); }
    _dist2(a, b) { const dx = a.clientX - b.clientX; const dy = a.clientY - b.clientY; return Math.hypot(dx, dy); }
    _center(points) { let sx = 0, sy = 0; for (const p of points) { sx += p.clientX; sy += p.clientY; } return { clientX: sx / points.length, clientY: sy / points.length }; }
    _clearLongPress() { if (this._longPressTimer) { clearTimeout(this._longPressTimer); this._longPressTimer = null; } }
    _clearSingleTap() { if (this._singleTapTimer) { clearTimeout(this._singleTapTimer); this._singleTapTimer = null; } }
    _stopFling() { if (this._flingRAF) { cancelAnimationFrame(this._flingRAF); this._flingRAF = null; } }

    _showCursor(x, y) {
        this._cursorX = x; this._cursorY = y;
        if (!this.pointerOverlay) return;
        this.pointerOverlay.hidden = false;
        this.pointerOverlay.classList.remove('fading');
        const r = this.canvas.getBoundingClientRect();
        this.pointerOverlay.style.left = (r.left + (x / this.canvas.width) * r.width) + 'px';
        this.pointerOverlay.style.top = (r.top + (y / this.canvas.height) * r.height) + 'px';
        clearTimeout(this._cursorHideTimer);
        this._cursorHideTimer = setTimeout(() => this.pointerOverlay?.classList.add('fading'), 2000);
    }

    _onPointerDown(e) {
        if (!this.getConnected()) return;
        e.preventDefault();
        this._stopFling();
        try { this.canvas.setPointerCapture(e.pointerId); } catch {}
        this._activePointers.set(e.pointerId, e);
        if (e.pointerType === 'pen') return this._handlePenDown(e);
        this._handleTouchDown(e);
    }

    _handlePenDown(e) {
        this._clearLongPress();
        const { x, y } = this._coords(e);
        const button = e.button === 2 || (e.buttons & 32) ? 2 : 0;
        this._penButton = button;
        this.sendMouseMove(x, y);
        this.sendMouseDown(button, x, y);
        this._showCursor(x, y);
    }

    _handleTouchDown(e) {
        const pts = [...this._activePointers.values()].filter(p => p.pointerType !== 'mouse');
        const count = pts.length;
        const now = performance.now();
        this._clearLongPress();
        if (count === 1) {
            const p = pts[0];
            const { x, y } = this._coords(p);
            this._state = { type: 'pending', startX: x, startY: y, startClientX: p.clientX, startClientY: p.clientY, lastClientX: p.clientX, lastClientY: p.clientY, startTime: now, moved: false, dragging: false };
            if (!this.relativeMode) { this.sendMouseMove(x, y); this._showCursor(x, y); }
            this._longPressTimer = setTimeout(() => {
                if (!this._state || this._state.moved || this._state.type !== 'pending') return;
                this._clearSingleTap();
                this._state.type = 'longpress';
                this.sendMouseDown(2, this._state.startX, this._state.startY);
                setTimeout(() => this.sendMouseUp(2, this._state.startX, this._state.startY), 60);
                haptic('long_press');
            }, LONG_PRESS_MS);
        } else if (count === 2) {
            if (this._state?.dragging) this.sendMouseUp(0, this._cursorX, this._cursorY);
            const [a, b] = pts;
            const d = this._dist2(a, b);
            const c = this._center(pts);
            const cc = this._coords(c);
            this._state = { type: '2finger', startDist: d, lastDist: d, startCenterX: cc.x, startCenterY: cc.y, lastScreenCX: c.clientX, lastScreenCY: c.clientY, gesture: null, moved: false, velX: 0, velY: 0, lastMoveTime: performance.now() };
            this._pinchStartDist = d;
            this._pinchStartZoom = this._currentZoom;
        } else if (count === 3) {
            const c = this._center(pts); const cc = this._coords(c);
            if (this._state?.dragging) this.sendMouseUp(0, this._cursorX, this._cursorY);
            this._state = { type: '3finger', startX: cc.x, startY: cc.y, startClientX: c.clientX, startClientY: c.clientY, moved: false, gesture: null };
        }
    }

    _onPointerMove(e) {
        if (!this.getConnected()) return;
        e.preventDefault();
        this._activePointers.set(e.pointerId, e);
        if (e.pointerType === 'pen') {
            const { x, y } = this._coords(e);
            this.sendMouseMove(x, y);
            this._showCursor(x, y);
            return;
        }
        if (!this._state) return;
        const now = performance.now();
        if (now - this._lastMoveAt < MOVE_THROTTLE_MS) return;
        this._lastMoveAt = now;
        const pts = [...this._activePointers.values()].filter(p => p.pointerType !== 'mouse');
        if (this._state.type === 'pending' && pts.length === 1) this._moveOneFinger(pts[0]);
        else if (this._state.type === '2finger' && pts.length >= 2) this._moveTwoFinger(pts[0], pts[1]);
        else if (this._state.type === '3finger' && pts.length >= 3) this._moveThreeFinger(pts);
    }

    _moveOneFinger(p) {
        const { x, y } = this._coords(p);
        const dx = x - this._state.startX;
        const dy = y - this._state.startY;
        if (!this._state.moved && (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)) {
            this._state.moved = true; this._state.type = 'drag'; this._clearLongPress(); this._clearSingleTap();
            if (this.relativeMode) this.sendMouseDown(0, Math.round(this._cursorX), Math.round(this._cursorY));
            else this.sendMouseDown(0, this._state.startX, this._state.startY);
            this._state.dragging = true;
        }
        if (this._state.dragging) {
            if (this.relativeMode) {
                const rdx = applyPointerAcceleration(p.clientX - this._state.lastClientX, this._relSensitivity);
                const rdy = applyPointerAcceleration(p.clientY - this._state.lastClientY, this._relSensitivity);
                this._state.lastClientX = p.clientX; this._state.lastClientY = p.clientY;
                this._cursorX = Math.max(0, Math.min(this.canvas.width, this._cursorX + rdx));
                this._cursorY = Math.max(0, Math.min(this.canvas.height, this._cursorY + rdy));
                this.sendMouseMove(Math.round(this._cursorX), Math.round(this._cursorY));
                this._showCursor(this._cursorX, this._cursorY);
            } else { this.sendMouseMove(x, y); this._showCursor(x, y); }
        }
    }

    _moveTwoFinger(a, b) {
        const d = this._dist2(a, b);
        const c = this._center([a, b]);
        const screenDx = c.clientX - this._state.lastScreenCX;
        const screenDy = c.clientY - this._state.lastScreenCY;
        const distDelta = Math.abs(d - this._state.startDist);
        if (!this._state.gesture) {
            if (distDelta > PINCH_THRESHOLD) this._state.gesture = 'pinch';
            else if (Math.abs(screenDy) > SCROLL_THRESHOLD || Math.abs(screenDx) > SCROLL_THRESHOLD) this._state.gesture = 'scroll';
        }
        if (this._state.gesture === 'scroll') {
            const now = performance.now(); const dt = Math.max(1, now - (this._state.lastMoveTime || now));
            this._state.velY = this._state.velY ? this._state.velY * 0.7 + (screenDy / dt) * 0.3 : screenDy / dt;
            this._state.velX = this._state.velX ? this._state.velX * 0.7 + (screenDx / dt) * 0.3 : screenDx / dt;
            this._state.lastMoveTime = now;
            if (Math.abs(screenDy) > 1) this.sendMouseWheel(-screenDy / 30);
            if (Math.abs(screenDx) > 4) window.rdpMouseHScroll?.(-screenDx / 30, Math.round(this._cursorX), Math.round(this._cursorY));
            this._state.lastScreenCX = c.clientX; this._state.lastScreenCY = c.clientY; this._state.moved = true;
        } else if (this._state.gesture === 'pinch') {
            const scale = d / this._pinchStartDist;
            this._currentZoom = Math.max(0.5, Math.min(5, this._pinchStartZoom * scale));
            this.onZoomChange?.(this._currentZoom);
            this._state.moved = true;
        }
        this._state.lastDist = d;
    }

    _moveThreeFinger(pts) {
        const c = this._center(pts);
        const dx = c.clientX - this._state.startClientX;
        const dy = c.clientY - this._state.startClientY;
        if (!this._state.gesture) {
            if (Math.abs(dy) > 20) this._state.gesture = dy < 0 ? '3up' : '3down';
            else if (Math.abs(dx) > 20) this._state.gesture = dx < 0 ? '3left' : '3right';
        }
        if (this._state.gesture) this._state.moved = true;
    }

    _onPointerUp(e) {
        if (!this.getConnected()) return;
        e.preventDefault();
        if (e.pointerType === 'pen') {
            const { x, y } = this._coords(e);
            this.sendMouseUp(this._penButton ?? 0, x, y);
            this._penButton = null;
            this._activePointers.delete(e.pointerId);
            return;
        }
        this._activePointers.delete(e.pointerId);
        this._handleTouchEnd(e);
    }

    _handleTouchEnd(e) {
        if (!this._state) return;
        this._clearLongPress();
        const now = performance.now();
        if (this._state.type === 'pending' && !this._state.moved) {
            const x = this._state.startX, y = this._state.startY;
            const tapDt = now - this._lastTapTime;
            const tapDist = Math.hypot(x - this._lastTapX, y - this._lastTapY);
            if (tapDt < DOUBLE_TAP_MS && tapDist < DOUBLE_TAP_DIST) {
                this._clearSingleTap();
                this.sendMouseDown(0, x, y); this.sendMouseUp(0, x, y);
                this.sendMouseDown(0, x, y); this.sendMouseUp(0, x, y);
                this._lastTapTime = 0; haptic('double_tap');
            } else {
                this._lastTapTime = now; this._lastTapX = x; this._lastTapY = y;
                this._clearSingleTap();
                this._singleTapTimer = setTimeout(() => {
                    this._singleTapTimer = null;
                    this.sendMouseDown(0, x, y);
                    setTimeout(() => this.sendMouseUp(0, x, y), 30);
                    haptic('tap');
                }, DOUBLE_TAP_MS);
            }
        } else if (this._state.type === 'drag' && this._state.dragging) {
            this.sendMouseUp(0, this.relativeMode ? Math.round(this._cursorX) : this._state.startX, this.relativeMode ? Math.round(this._cursorY) : this._state.startY);
        } else if (this._state.type === '2finger') {
            if (this._state.gesture === 'scroll') this._startFling(this._state.velY || 0, this._state.velX || 0);
            if (this._state.gesture === 'pinch') this._finishPinchResize();
        } else if (this._state.type === '3finger') {
            this._finishThreeFinger();
        }
        if (this._activePointers.size === 0) this._state = null;
    }

    _startFling(vy, vx) {
        if (Math.abs(vy) < FLING_START_VEL && Math.abs(vx) < FLING_START_VEL) return;
        let velY = vy, velX = vx, last = performance.now();
        const tick = () => {
            const now = performance.now(); const dt = now - last; last = now;
            velY *= Math.pow(FLING_FRICTION, dt / 16); velX *= Math.pow(FLING_FRICTION, dt / 16);
            if (Math.abs(velY) < FLING_MIN_VEL && Math.abs(velX) < FLING_MIN_VEL) { this._flingRAF = null; return; }
            if (Math.abs(velY) >= FLING_MIN_VEL) this.sendMouseWheel(-(velY * dt) / 30);
            if (Math.abs(velX) >= FLING_MIN_VEL) window.rdpMouseHScroll?.(-(velX * dt) / 30, Math.round(this._cursorX), Math.round(this._cursorY));
            this._flingRAF = requestAnimationFrame(tick);
        };
        this._flingRAF = requestAnimationFrame(tick);
    }

    _finishPinchResize() {
        const zoom = this._currentZoom;
        if (Math.abs(zoom - 1) > 0.2 && typeof window.rdpResizeDisplay === 'function') {
            const newW = Math.max(640, Math.round((this.canvas.width / zoom) / 8) * 8);
            const newH = Math.max(480, Math.round((this.canvas.height / zoom) / 8) * 8);
            window.rdpResizeDisplay(newW, newH);
        }
        this.onZoomChange?.(1);
        this._currentZoom = 1;
    }

    _finishThreeFinger() {
        const g = this._state.gesture;
        if (g === '3up') window.rdpWorkerPost?.({ type: 'key_combo', combo: 'win_tab' });
        else if (g === '3down') window.rdpWorkerPost?.({ type: 'key_combo', combo: 'win_d' });
        else if (g === '3left') window.rdpWorkerPost?.({ type: 'key_combo', combo: 'alt_left' });
        else if (g === '3right') window.rdpWorkerPost?.({ type: 'key_combo', combo: 'alt_right' });
        else if (!this._state.moved) {
            const x = this._state.startX, y = this._state.startY;
            this.sendMouseDown(1, x, y); setTimeout(() => this.sendMouseUp(1, x, y), 40);
        }
    }

    destroy() {
        this._clearLongPress(); this._clearSingleTap(); this._stopFling();
        clearTimeout(this._cursorHideTimer);
        for (const [el, type, fn, opts] of this._bound) el.removeEventListener(type, fn, opts);
        this._bound = [];
        this._activePointers.clear();
        this._state = null;
    }
}
