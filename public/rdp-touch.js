/**
 * rdp-touch.js — Windows RD App-level touch controller for RDP WASM client
 *
 * Gesture recognition:
 *   1-finger tap           → left click
 *   1-finger double-tap    → double left click
 *   1-finger long-press    → right click (with haptic feedback dot)
 *   1-finger drag          → mouse move + left button drag
 *   2-finger drag          → scroll (vertical + horizontal)
 *   2-finger pinch         → zoom viewport (local, not sent to RDP)
 *   3-finger tap           → middle click
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
const PINCH_THRESHOLD = 15;
const MOVE_THROTTLE_MS = 4;

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

        // Gesture state
        this._state = null;
        this._lastTapTime = 0;
        this._lastTapX = 0;
        this._lastTapY = 0;
        this._longPressTimer = null;
        this._lastMoveAt = 0;
        this._cursorX = 0;
        this._cursorY = 0;

        // Relative (touchpad) mode
        this.relativeMode = false;
        this._relSensitivity = 1.5;

        // Pinch zoom
        this._pinchStartDist = 0;
        this._pinchStartZoom = 1;
        this._currentZoom = 1;

        this._bind();
    }

    _bind() {
        const c = this.canvas;
        c.addEventListener('touchstart', (e) => this._onTouchStart(e), { passive: false });
        c.addEventListener('touchmove', (e) => this._onTouchMove(e), { passive: false });
        c.addEventListener('touchend', (e) => this._onTouchEnd(e), { passive: false });
        c.addEventListener('touchcancel', (e) => this._onTouchEnd(e), { passive: false });
    }

    setRelativeMode(on) {
        this.relativeMode = !!on;
    }

    _coords(touch) {
        return this.canvasCoords(touch);
    }

    _dist2(t1, t2) {
        const dx = t1.clientX - t2.clientX;
        const dy = t1.clientY - t2.clientY;
        return Math.sqrt(dx * dx + dy * dy);
    }

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

    _showCursor(x, y) {
        this._cursorX = x;
        this._cursorY = y;
        if (this.pointerOverlay) {
            this.pointerOverlay.hidden = false;
            // Convert remote coords to screen position
            const r = this.canvas.getBoundingClientRect();
            const sx = r.left + (x / this.canvas.width) * r.width;
            const sy = r.top + (y / this.canvas.height) * r.height;
            this.pointerOverlay.style.left = sx + 'px';
            this.pointerOverlay.style.top = sy + 'px';
        }
    }

    _hideCursor() {
        if (this.pointerOverlay) this.pointerOverlay.hidden = true;
    }

    _onTouchStart(e) {
        if (!this.getConnected()) return;
        e.preventDefault();

        const fingers = e.touches.length;
        const t0 = e.touches[0];
        const { x, y } = this._coords(t0);
        const now = performance.now();

        this._clearLongPress();

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

            // Move cursor to touch position
            if (!this.relativeMode) {
                this.sendMouseMove(x, y);
                this._showCursor(x, y);
            }

            // Start long-press timer
            this._longPressTimer = setTimeout(() => {
                if (!this._state || this._state.moved || this._state.type !== 'pending') return;
                this._state.type = 'longpress';
                // Right click
                const sx = this._state.startX, sy = this._state.startY;
                this.sendMouseDown(2, sx, sy);
                setTimeout(() => this.sendMouseUp(2, sx, sy), 60);
                // Haptic feedback (vibrate if available)
                try { navigator.vibrate?.(30); } catch {}
            }, LONG_PRESS_MS);

        } else if (fingers === 2) {
            this._clearLongPress();
            // Cancel any pending 1-finger action
            if (this._state?.dragging) {
                this.sendMouseUp(0, this._state.startX, this._state.startY);
            }
            const d = this._dist2(e.touches[0], e.touches[1]);
            const center = this._centerCoords(e.touches);
            const scx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
            const scy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
            this._state = {
                type: '2finger',
                fingers: 2,
                startDist: d,
                lastDist: d,
                startCenterX: center.x, startCenterY: center.y,
                lastCenterX: center.x, lastCenterY: center.y,
                lastScreenCX: scx, lastScreenCY: scy,
                lastClientX: e.touches[0].clientX, lastClientY: e.touches[0].clientY,
                moved: false,
                gesture: null,
                startTime: performance.now(),
            };
            this._pinchStartDist = d;
            this._pinchStartZoom = this._currentZoom;

        } else if (fingers === 3) {
            this._clearLongPress();
            if (this._state?.dragging) {
                this.sendMouseUp(0, this._cursorX, this._cursorY);
            }
            this._state = {
                type: '3finger',
                fingers: 3,
                startX: x, startY: y,
                startTime: now,
                moved: false,
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
                    const rdx = (t.clientX - (this._state.lastClientX || this._state.startClientX)) * this._relSensitivity;
                    const rdy = (t.clientY - (this._state.lastClientY || this._state.startClientY)) * this._relSensitivity;
                    this._state.lastClientX = t.clientX;
                    this._state.lastClientY = t.clientY;
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
            const d = this._dist2(e.touches[0], e.touches[1]);
            /* Use screen-pixel deltas for scroll detection (immune to remote
             * coordinate scaling that could shrink/expand the deltas). */
            const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
            const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
            const screenDx = cx - this._state.lastScreenCX;
            const screenDy = cy - this._state.lastScreenCY;
            const distDelta = Math.abs(d - this._state.startDist);

            // Classify gesture if not yet decided
            if (!this._state.gesture) {
                if (distDelta > PINCH_THRESHOLD) {
                    this._state.gesture = 'pinch';
                } else if (Math.abs(screenDy) > SCROLL_THRESHOLD || Math.abs(screenDx) > SCROLL_THRESHOLD) {
                    this._state.gesture = 'scroll';
                }
            }

            if (this._state.gesture === 'scroll') {
                // Vertical scroll — RDP expects positive=up, negative=down
                if (Math.abs(screenDy) > 1) {
                    this.sendMouseWheel(-screenDy / 30);
                }
                // Horizontal scroll — send via rdpMouseHScroll if available,
                // otherwise fallback to Left/Right arrow key taps for compat.
                if (Math.abs(screenDx) > 8 && typeof window.rdpMouseHScroll === 'function') {
                    window.rdpMouseHScroll(screenDx / 30);
                }
                this._state.lastScreenCX = cx;
                this._state.lastScreenCY = cy;
                this._state.moved = true;

            } else if (this._state.gesture === 'pinch') {
                // Local viewport zoom
                const scale = d / this._pinchStartDist;
                this._currentZoom = Math.max(0.5, Math.min(5, this._pinchStartZoom * scale));
                if (this.onZoomChange) this.onZoomChange(this._currentZoom);
                this._state.moved = true;
            }

            this._state.lastDist = d;

        } else if (this._state.type === '3finger') {
            const { x, y } = this._coords(e.touches[0]);
            if (Math.abs(x - this._state.startX) > DRAG_THRESHOLD || Math.abs(y - this._state.startY) > DRAG_THRESHOLD) {
                this._state.moved = true;
            }
        }
    }

    _onTouchEnd(e) {
        if (!this.getConnected() || !this._state) return;
        e.preventDefault();

        this._clearLongPress();
        const now = performance.now();

        if (this._state.type === 'pending' && !this._state.moved) {
            // It was a tap (no drag, no long press)
            const x = this._state.startX;
            const y = this._state.startY;
            const dt = now - this._state.startTime;

            if (dt < LONG_PRESS_MS) {
                // Check for double-tap
                const tapDt = now - this._lastTapTime;
                const tapDist = Math.abs(x - this._lastTapX) + Math.abs(y - this._lastTapY);

                if (tapDt < DOUBLE_TAP_MS && tapDist < DOUBLE_TAP_DIST) {
                    // Double tap → double click
                    this.sendMouseDown(0, x, y);
                    this.sendMouseUp(0, x, y);
                    this.sendMouseDown(0, x, y);
                    this.sendMouseUp(0, x, y);
                    this._lastTapTime = 0;
                } else {
                    // Single tap → left click (with small delay to check for double-tap)
                    this.sendMouseDown(0, x, y);
                    setTimeout(() => this.sendMouseUp(0, x, y), 40);
                    this._lastTapTime = now;
                    this._lastTapX = x;
                    this._lastTapY = y;
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
            const x = this._state.startX;
            const y = this._state.startY;
            this.sendMouseDown(1, x, y);
            setTimeout(() => this.sendMouseUp(1, x, y), 40);

        } else if (this._state.type === '2finger') {
            // Pinch/scroll ended — nothing special to do
        }

        // Only clear state when all fingers are lifted
        if (e.touches.length === 0) {
            this._state = null;
        }
    }

    destroy() {
        this._clearLongPress();
        this._state = null;
    }
}
