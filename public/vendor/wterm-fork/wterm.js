import { WasmBridge } from "./core/index.js";
import { Renderer } from "./renderer.js";
import { InputHandler } from "./input.js";
import { DebugAdapter } from "./debug.js";
export class WTerm {
    constructor(element, options = {}) {
        this.bridge = null;
        this.debug = null;
        this.renderer = null;
        this.input = null;
        this.rafId = null;
        this.resizeObserver = null;
        this._destroyed = false;
        this._shouldScrollToBottom = false;
        this._rowHeight = 0;
        this.element = element;
        this.wasmUrl = options.wasmUrl;
        this.cols = options.cols || 80;
        this.rows = options.rows || 24;
        this.autoResize = options.autoResize !== false;
        this._debugEnabled = options.debug ?? false;
        this.onData = options.onData || null;
        this.onTitle = options.onTitle || null;
        this.onResize = options.onResize || null;
        this._container = document.createElement("div");
        this._container.className = "term-grid";
        this.element.appendChild(this._container);
        this.element.classList.add("wterm");
        if (options.cursorBlink)
            this.element.classList.add("cursor-blink");
        this._onClickFocus = () => {
            const sel = window.getSelection();
            if (!sel || sel.isCollapsed)
                this.input?.focus();
        };
        this.element.addEventListener("click", this._onClickFocus);
    }
    async init() {
        try {
            this.bridge = await WasmBridge.load(this.wasmUrl);
            if (this._destroyed)
                return this;
            this.bridge.init(this.cols, this.rows);
            if (this._debugEnabled) {
                this.debug = new DebugAdapter();
                this.debug.setBridge(this.bridge);
                globalThis.__wterm = this;
            }
            this._setRowHeight();
            this.renderer = new Renderer(this._container);
            this.renderer.setup(this.cols, this.rows);
            this.input = new InputHandler(this.element, (data) => {
                this._scrollToBottom();
                if (this.onData) {
                    this.onData(data);
                }
                else {
                    this.write(data);
                }
            }, () => this.bridge);
            if (this.autoResize) {
                this._setupResizeObserver();
            }
            else {
                this._lockHeight();
            }
            this.input.focus();
            this._initialRender();
            // Mount the public viewport facade as a plain writable property
            // (NOT a getter) so downstream code (terminal.js patchWTermScroll
            // Behavior) can replace it without tripping "has only a getter".
            this.viewport = this._buildViewportFacade();
        }
        catch (err) {
            this.destroy();
            throw new Error(`wterm: failed to initialize: ${err instanceof Error ? err.message : err}`);
        }
        return this;
    }
    _buildViewportFacade() {
        const self = this;
        return {
            get atBottom() { return self._isScrolledToBottom(); },
            get maxScroll() { return Math.max(0, self.element.scrollHeight - self.element.clientHeight); },
            get scrollTop() { return self.element.scrollTop; },
            get rowHeight() { return self._rowHeight || 17; },
            get rows() { return self.rows; },
            get cols() { return self.cols; },
            scrollToBottom() { self._scrollToBottom(); },
            follow() { self._shouldScrollToBottom = true; },
            lock() { self._shouldScrollToBottom = false; },
        };
    }
    _isScrolledToBottom() {
        const el = this.element;
        return el.scrollHeight - el.scrollTop - el.clientHeight < 5;
    }
    _scrollToBottom() {
        const el = this.element;
        const maxScroll = el.scrollHeight - el.clientHeight;
        if (maxScroll <= 0) {
            el.scrollTop = 0;
            return;
        }
        const rh = this._rowHeight || 17;
        el.scrollTop = Math.floor(maxScroll / rh) * rh;
    }

    /* ── Public viewport API (Zephyr fork, FREEZE plan §3.8) ──────────────
     * The stock @wterm/dom keeps these private; the Zephyr fork exposes them
     * so the terminal controller can read and drive the viewport without
     * monkey-patching. `atBottom` is a semantic truth (maxScroll - scrollTop),
     * never inferred from pixel positions after reflow. */
    // Public aliases so external code never touches underscore privates
    isAtBottom() { return this._isScrolledToBottom(); }
    scrollToBottom() { this._scrollToBottom(); }
    followBottom() { this._shouldScrollToBottom = true; }
    lockBottom() { this._shouldScrollToBottom = false; }

    /* ── Extended public API (Zephyr fork, FREEZE plan §3.8.2) ───────────── */
    /** Return a serializable snapshot of the current viewport state. */
    getViewportState() {
        const el = this.element;
        return {
            atBottom: this._isScrolledToBottom(),
            scrollTop: el ? el.scrollTop : 0,
            maxScroll: el ? Math.max(0, el.scrollHeight - el.clientHeight) : 0,
            rowHeight: this._rowHeight || 17,
            rows: this.rows || 0,
            cols: this.cols || 0,
            followEnabled: !!this._shouldScrollToBottom,
        };
    }
    /** Register a callback fired after each render. Returns an unsubscribe fn. */
    onRenderComplete(cb) {
        if (typeof cb !== 'function') return () => {};
        this._renderCallbacks = this._renderCallbacks || new Set();
        this._renderCallbacks.add(cb);
        return () => { this._renderCallbacks?.delete(cb); };
    }
    /** Register a callback fired when the viewport scrolls. Returns unsubscribe. */
    onViewportChange(cb) {
        if (typeof cb !== 'function') return () => {};
        this._viewportCallbacks = this._viewportCallbacks || new Set();
        this._viewportCallbacks.add(cb);
        if (!this._viewportListenerBound) {
            this._viewportListenerBound = true;
            this.element?.addEventListener?.('scroll', () => {
                const st = this.getViewportState();
                this._viewportCallbacks?.forEach((fn) => { try { fn(st); } catch {} });
            }, { passive: true });
        }
        return () => { this._viewportCallbacks?.delete(cb); };
    }
    /** Scroll to a specific line (0-indexed). Best-effort, clamped. */
    scrollToLine(line) {
        const el = this.element;
        if (!el) return;
        const rh = this._rowHeight || 17;
        const target = Math.max(0, Math.floor(Number(line) || 0) * rh);
        el.scrollTop = Math.min(target, Math.max(0, el.scrollHeight - el.clientHeight));
    }
    /** Recalculate dimensions after the container resizes. */
    fitToContainer() {
        if (typeof this._setupResizeObserver === 'function') {
            // Trigger a manual resize measurement
            this._setupResizeObserver();
        }
    }
    /** Return a snapshot of the visible buffer text (rows currently in DOM). */
    getBufferSnapshot() {
        const rows = this.element?.querySelectorAll?.('[data-line]') || [];
        return Array.from(rows).map((r) => r.textContent || '');
    }
    /** Fire render-complete callbacks (called internally after _doRender). */
    _fireRenderComplete() {
        if (!this._renderCallbacks) return;
        const st = this.getViewportState();
        this._renderCallbacks.forEach((fn) => { try { fn(st); } catch {} });
    }
    write(data) {
        if (!this.bridge)
            return;
        if (this.debug)
            this.debug.traceWrite(data);
        this._shouldScrollToBottom = this._isScrolledToBottom();
        if (typeof data === "string") {
            this.bridge.writeString(data);
        }
        else {
            this.bridge.writeRaw(data);
        }
        this._scheduleRender();
    }
    resize(cols, rows) {
        if (!this.bridge)
            return;
        this._shouldScrollToBottom = this._isScrolledToBottom();
        this.cols = cols;
        this.rows = rows;
        this.bridge.resize(cols, rows);
        this.renderer?.setup(cols, rows);
        this._scheduleRender();
        if (this.onResize)
            this.onResize(cols, rows);
    }
    focus() {
        if (this.input) {
            this.input.focus();
        }
        else {
            this.element.focus();
        }
    }
    _scheduleRender() {
        if (this.rafId == null) {
            this.rafId = requestAnimationFrame(() => {
                this.rafId = null;
                this._doRender();
            });
        }
    }
    _initialRender() {
        this._doRender();
    }
    _doRender() {
        if (!this.bridge || !this.renderer)
            return;
        let dirtyCount = 0;
        const t0 = this.debug ? performance.now() : 0;
        if (this.debug) {
            for (let r = 0; r < this.rows; r++) {
                if (this.bridge.isDirtyRow(r))
                    dirtyCount++;
            }
        }
        this.renderer.render(this.bridge);
        if (this.debug) {
            this.debug.recordRender(performance.now() - t0, dirtyCount);
        }
        const hasScrollback = this.bridge.getScrollbackCount() > 0;
        this.element.classList.toggle("has-scrollback", hasScrollback);
        if (this._shouldScrollToBottom) {
            this._scrollToBottom();
        }
        else if (!hasScrollback && this.element.scrollTop !== 0) {
            this.element.scrollTop = 0;
        }
        const title = this.bridge.getTitle();
        if (title !== null && this.onTitle) {
            this.onTitle(title);
        }
        const response = this.bridge.getResponse();
        if (response !== null && this.onData) {
            this.onData(response);
        }
        // Fire render-complete callbacks (Zephyr fork §3.8.2)
        this._fireRenderComplete();
    }
    _lockHeight() {
        const rh = this._rowHeight || 17;
        const gridHeight = this.rows * rh;
        const cs = getComputedStyle(this.element);
        let extra = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
        if (cs.boxSizing === "border-box") {
            extra +=
                (parseFloat(cs.borderTopWidth) || 0) +
                    (parseFloat(cs.borderBottomWidth) || 0);
        }
        this.element.style.height = `${gridHeight + extra}px`;
    }
    _setRowHeight() {
        const probe = document.createElement("div");
        probe.className = "term-row";
        probe.style.visibility = "hidden";
        probe.style.position = "absolute";
        probe.textContent = "W";
        this._container.appendChild(probe);
        const h = probe.getBoundingClientRect().height;
        probe.remove();
        if (h > 0) {
            const rh = Math.ceil(h);
            this._rowHeight = rh;
            this.element.style.setProperty("--term-row-height", `${rh}px`);
        }
    }
    _measureCharSize() {
        const row = document.createElement("div");
        row.className = "term-row";
        row.style.visibility = "hidden";
        row.style.position = "absolute";
        const probe = document.createElement("span");
        probe.textContent = "W";
        row.appendChild(probe);
        this._container.appendChild(row);
        const charWidth = probe.getBoundingClientRect().width;
        const rowHeight = row.getBoundingClientRect().height;
        row.remove();
        if (charWidth === 0 || rowHeight === 0)
            return null;
        this._rowHeight = rowHeight;
        return { charWidth, rowHeight };
    }
    _setupResizeObserver() {
        const initial = this._measureCharSize();
        if (!initial)
            return;
        let { charWidth, rowHeight } = initial;
        this.resizeObserver = new ResizeObserver((entries) => {
            const measured = this._measureCharSize();
            if (measured) {
                charWidth = measured.charWidth;
                rowHeight = measured.rowHeight;
            }
            for (const entry of entries) {
                const { width, height } = entry.contentRect;
                const newCols = Math.max(1, Math.floor(width / charWidth));
                const newRows = Math.max(1, Math.floor(height / rowHeight));
                if (newCols !== this.cols || newRows !== this.rows) {
                    this.resize(newCols, newRows);
                }
            }
        });
        this.resizeObserver.observe(this.element);
    }
    destroy() {
        this._destroyed = true;
        if (this.rafId != null)
            cancelAnimationFrame(this.rafId);
        if (this.resizeObserver)
            this.resizeObserver.disconnect();
        if (this.input)
            this.input.destroy();
        this.element.removeEventListener("click", this._onClickFocus);
        this.element.innerHTML = "";
        if (this.debug &&
            globalThis.__wterm === this) {
            delete globalThis.__wterm;
        }
        this.debug = null;
    }
}
//# sourceMappingURL=wterm.js.map