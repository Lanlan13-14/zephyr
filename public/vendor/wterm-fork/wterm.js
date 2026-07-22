var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
import {
  WasmBridge,
  XtermBridge
} from "./core/index.js";
import { Renderer, resolveQueryColor } from "./renderer.js";
import { CanvasRenderer } from "./canvas-renderer.js";
import { InputHandler } from "./input.js";
import { DebugAdapter } from "./debug.js";
function parseOscColor(value) {
  const input = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(input)) return input.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(input)) return "#" + [...input.slice(1)].map((c) => c + c).join("").toLowerCase();
  const match = input.match(/^rgb:([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})$/);
  if (!match) return null;
  const component = (part) => Math.round(parseInt(part, 16) * 255 / (Math.pow(16, part.length) - 1)).toString(16).padStart(2, "0");
  return `#${component(match[1])}${component(match[2])}${component(match[3])}`;
}
function applyColorChange(element, change) {
  if (change.kind === 104) {
    if (change.index === 65535) for (let i = 0; i < 256; i++) element.style.removeProperty(`--term-color-${i}`);
    else if (change.index >= 0 && change.index < 256) element.style.removeProperty(`--term-color-${change.index}`);
    return true;
  }
  if (change.kind === 110) {
    element.style.removeProperty("--term-fg");
    return true;
  }
  if (change.kind === 111) {
    element.style.removeProperty("--term-bg");
    return true;
  }
  if (change.kind === 112) {
    element.style.removeProperty("--term-cursor");
    return true;
  }
  const color = parseOscColor(change.value);
  if (!color) return false;
  if (change.kind === 4 && change.index >= 0 && change.index < 256) element.style.setProperty(`--term-color-${change.index}`, color);
  else if (change.kind === 10) element.style.setProperty("--term-fg", color);
  else if (change.kind === 11) element.style.setProperty("--term-bg", color);
  else if (change.kind === 12) element.style.setProperty("--term-cursor", color);
  else return false;
  return true;
}
class WTerm {
  constructor(element, options = {}) {
    __publicField(this, "element");
    __publicField(this, "cols");
    __publicField(this, "rows");
    __publicField(this, "bridge", null);
    __publicField(this, "autoResize");
    __publicField(this, "debug", null);
    /** Public viewport facade (Zephyr fork). */
    __publicField(this, "viewport");
    __publicField(this, "_coreOption");
    __publicField(this, "wasmUrl");
    __publicField(this, "_engine", "xterm");
    __publicField(this, "_scrollback", 5e3);
    __publicField(this, "_debugEnabled");
    __publicField(this, "renderer", null);
    __publicField(this, "_rendererMode", "dom");
    __publicField(this, "_inputMode", "native");
    __publicField(this, "_onExternalInputRequest", null);
    __publicField(this, "input", null);
    __publicField(this, "rafId", null);
    __publicField(this, "_renderTimer", null);
    __publicField(this, "resizeObserver", null);
    __publicField(this, "_destroyed", false);
    __publicField(this, "_shouldScrollToBottom", false);
    __publicField(this, "_rowHeight", 0);
    __publicField(this, "_charWidth", 0);
    __publicField(this, "_metricsMeasuredAt", 0);
    /** After first paint, remeasure from a live cell once (probe may drift). */
    __publicField(this, "_liveMetricsSynced", false);
    __publicField(this, "_onClickFocus");
    /** Render-complete callback set (Zephyr fork §3.8.2). */
    __publicField(this, "_renderCallbacks", /* @__PURE__ */ new Set());
    /** Viewport-change callback set (Zephyr fork §3.8.2). */
    __publicField(this, "_viewportCallbacks", /* @__PURE__ */ new Set());
    __publicField(this, "_viewportListenerBound", false);
    __publicField(this, "onData");
    __publicField(this, "onTitle");
    __publicField(this, "onResize");
    __publicField(this, "onBell", null);
    __publicField(this, "onClipboard", null);
    __publicField(this, "_container");
    /** Wheel/touch → xterm scrollLines (negative = into history). */
    __publicField(this, "_wheelAccum", 0);
    __publicField(this, "_onVirtualWheel", (e) => {
      if (!this._isXtermEngine() || !this.bridge) return;
      if (this.bridge.mouseMode?.() > 0 && !e.shiftKey) return;
      e.preventDefault();
      e.stopPropagation();
      const rh = Math.max(1, this._rowHeight || 17);
      let deltaLines = 0;
      if (e.deltaMode === 1) {
        deltaLines = e.deltaY;
      } else if (e.deltaMode === 2) {
        deltaLines = e.deltaY * Math.max(1, (this.rows || 24) - 1);
      } else {
        this._wheelAccum += e.deltaY;
        if (Math.abs(this._wheelAccum) < rh) return;
        deltaLines = Math.trunc(this._wheelAccum / rh);
        this._wheelAccum -= deltaLines * rh;
      }
      if (!deltaLines) return;
      const core = this.bridge;
      core.scrollLines?.(deltaLines);
      this._shouldScrollToBottom = this._isScrolledToBottom();
      this._scheduleRender();
    });
    this.element = element;
    this._coreOption = options.core;
    this.wasmUrl = options.wasmUrl;
    this._engine = options.engine === "wasm" ? "wasm" : "xterm";
    this._scrollback = Math.max(0, Number(options.scrollback) || 5e3);
    this.cols = options.cols || 80;
    this.rows = options.rows || 24;
    this.autoResize = options.autoResize !== false;
    this._debugEnabled = options.debug ?? false;
    this.onData = options.onData || null;
    this.onTitle = options.onTitle || null;
    this.onResize = options.onResize || null;
    this.onBell = options.onBell || null;
    this.onClipboard = options.onClipboard || null;
    this._container = document.createElement("div");
    this._container.className = "term-grid";
    this.element.appendChild(this._container);
    this.element.classList.add("wterm");
    if (options.cursorBlink) this.element.classList.add("cursor-blink");
    this.setLigatures(options.allowLigatures === true);
    this._rendererMode = options.renderer === "canvas" ? "canvas" : "dom";
    this._inputMode = options.inputMode === "external" ? "external" : "native";
    this._onExternalInputRequest = options.onExternalInputRequest || null;
    this.element.classList.toggle("renderer-canvas", this._rendererMode === "canvas");
    this.element.classList.toggle("external-input", this._inputMode === "external");
    this._onClickFocus = () => {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;
      if (this._inputMode === "external") {
        this._onExternalInputRequest?.();
        return;
      }
      this.input?.focus();
    };
    this.element.addEventListener("click", this._onClickFocus);
    this.viewport = this._buildViewportFacade();
  }
  async init() {
    try {
      if (this._coreOption) {
        this.bridge = this._coreOption;
      } else if (this._engine === "wasm") {
        this.bridge = await WasmBridge.load(this.wasmUrl);
      } else {
        this.bridge = await XtermBridge.load({
          cols: this.cols,
          rows: this.rows,
          scrollback: this._scrollback
        });
      }
      if (this._destroyed) return this;
      this.bridge.init(this.cols, this.rows);
      this.element.classList.toggle("engine-xterm", this._engine === "xterm" || !!this.bridge.kind);
      this.element.classList.toggle("engine-wasm", this._engine === "wasm" && !this.bridge.kind);
      if (this._debugEnabled) {
        this.debug = new DebugAdapter();
        this.debug.setBridge(this.bridge);
        globalThis.__wterm = this;
      }
      this.refreshCellMetrics();
      this.renderer = this._rendererMode === "canvas" ? new CanvasRenderer(this._container) : new Renderer(this._container);
      this.renderer.setup(this.cols, this.rows);
      this._pushMetricsToRenderer();
      this.input = new InputHandler(
        this.element,
        (data) => {
          if (this._inputMode === "native") this._scrollToBottom();
          if (this.onData) {
            this.onData(data);
          } else {
            this.write(data);
          }
        },
        () => this.bridge
      );
      if (this.autoResize) {
        this._setupResizeObserver();
      } else {
        this._lockHeight();
      }
      if (this._inputMode === "native") this.input.focus();
      if (this._isXtermEngine()) {
        this.element.classList.add("xterm-viewport");
        this.element.addEventListener("wheel", this._onVirtualWheel, {
          passive: false
        });
      }
      this._initialRender();
    } catch (err) {
      this.destroy();
      throw new Error(
        `wterm: failed to initialize: ${err instanceof Error ? err.message : err}`
      );
    }
    return this;
  }
  /** True when the VT core is at bottom (xterm: ydisp===ybase). DOM scroll is not authority. */
  _isScrolledToBottom() {
    const core = this.bridge;
    if (core && typeof core.isAtBottom === "function") {
      return !!core.isAtBottom();
    }
    const el = this.element;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 5;
  }
  _isXtermEngine() {
    const core = this.bridge;
    return this._engine === "xterm" || core?.kind === "xterm" || core?.virtualViewport === true;
  }
  /**
   * Scroll to bottom. xterm path drives ydisp via bridge; legacy path uses DOM scrollTop.
   */
  _scrollToBottom() {
    const core = this.bridge;
    if (this._isXtermEngine() && core && typeof core.scrollToBottom === "function") {
      core.scrollToBottom();
      this._shouldScrollToBottom = true;
      this._scheduleRender();
      return;
    }
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
  /** Public alias so external code never touches underscore privates. */
  isAtBottom() {
    return this._isScrolledToBottom();
  }
  /** Scroll to the bottom, row-height aligned. Public alias. */
  scrollToBottom() {
    this._scrollToBottom();
  }
  /** Enable follow mode: subsequent renders auto-scroll to bottom. */
  followBottom() {
    this._shouldScrollToBottom = true;
  }
  /** Disable follow mode: renders will not auto-scroll. */
  lockBottom() {
    this._shouldScrollToBottom = false;
  }
  /** Register a callback fired after each render completes. Returns an
   *  unsubscribe function. Use this to drive scroll-follow decisions that
   *  must read the post-render DOM (e.g. cursor visibility after IME). */
  onRenderComplete(cb) {
    if (typeof cb !== "function") return () => {
    };
    this._renderCallbacks.add(cb);
    return () => {
      this._renderCallbacks.delete(cb);
    };
  }
  /** Register a callback fired when the viewport scrolls. Returns unsubscribe. */
  onViewportChange(cb) {
    if (typeof cb !== "function") return () => {
    };
    this._viewportCallbacks.add(cb);
    if (!this._viewportListenerBound) {
      this._viewportListenerBound = true;
      this.element.addEventListener(
        "scroll",
        () => {
          const st = this.getViewportState();
          this._viewportCallbacks.forEach((fn) => {
            try {
              fn(st);
            } catch {
            }
          });
        },
        { passive: true }
      );
    }
    return () => {
      this._viewportCallbacks.delete(cb);
    };
  }
  /** Return a serializable snapshot of the current viewport state. */
  getViewportState() {
    const el = this.element;
    const rh = this._rowHeight || 17;
    const core = this.bridge;
    if (this._isXtermEngine() && core && typeof core.getViewportY === "function") {
      const ydisp = core.getViewportY() | 0;
      const ybase = typeof core.getBaseY === "function" ? core.getBaseY() | 0 : ydisp;
      return {
        atBottom: typeof core.isAtBottom === "function" ? !!core.isAtBottom() : ydisp >= ybase,
        // Expose ydisp in row units as "scrollTop" so host policy can reason without DOM overflow.
        scrollTop: ydisp * rh,
        maxScroll: Math.max(0, ybase) * rh,
        rowHeight: rh,
        charWidth: this._charWidth || 8,
        rows: this.rows || 0,
        cols: this.cols || 0,
        followEnabled: !!this._shouldScrollToBottom
      };
    }
    return {
      atBottom: this._isScrolledToBottom(),
      scrollTop: el ? el.scrollTop : 0,
      maxScroll: el ? Math.max(0, el.scrollHeight - el.clientHeight) : 0,
      rowHeight: rh,
      charWidth: this._charWidth || 8,
      rows: this.rows || 0,
      cols: this.cols || 0,
      followEnabled: !!this._shouldScrollToBottom
    };
  }
  /**
   * Single source of truth for cell geometry.
   * Prefer this over reading CSS vars or probing the DOM from the host.
   */
  getCellMetrics() {
    return {
      charWidth: this._charWidth || 8,
      rowHeight: this._rowHeight || 17,
      measuredAt: this._metricsMeasuredAt || 0
    };
  }
  /**
   * Re-measure cell size from the live font and write CSS vars + renderer.
   * Call after font-size / font-family / DPR / theme changes.
   * Returns the new metrics (or last known if measure failed).
   */
  refreshCellMetrics() {
    const measured = this._measureCharSize();
    if (measured) {
      const changed = Math.abs((this._charWidth || 0) - measured.charWidth) > 0.25 || Math.abs((this._rowHeight || 0) - measured.rowHeight) > 0.25 || this._charWidth === 0 || this._rowHeight === 0;
      this._charWidth = measured.charWidth;
      this._rowHeight = measured.rowHeight;
      this._metricsMeasuredAt = performance.now();
      if (changed && this._liveMetricsSynced) {
        this._liveMetricsSynced = false;
      }
      this.element.style.setProperty(
        "--term-row-height",
        `${measured.rowHeight}px`
      );
      this.element.style.setProperty(
        "--term-cell-width",
        `${measured.charWidth}px`
      );
      this._pushMetricsToRenderer();
    }
    return this.getCellMetrics();
  }
  /** @deprecated Use refreshCellMetrics(). Kept for hosts that still call it. */
  _setRowHeight() {
    this.refreshCellMetrics();
  }
  _pushMetricsToRenderer() {
    if (!this.renderer) return;
    const cw = this._charWidth;
    const rh = this._rowHeight;
    if (cw > 0 && rh > 0 && typeof this.renderer.setCellMetrics === "function") {
      this.renderer.setCellMetrics(cw, rh);
    }
  }
  /** Scroll to a specific absolute buffer line (xterm ydisp) or DOM offset (legacy). */
  scrollToLine(line) {
    const core = this.bridge;
    if (this._isXtermEngine() && core && typeof core.scrollToLine === "function") {
      core.scrollToLine(Math.max(0, Math.floor(Number(line) || 0)));
      this._shouldScrollToBottom = this._isScrolledToBottom();
      this._scheduleRender();
      return;
    }
    const el = this.element;
    if (!el) return;
    const rh = this._rowHeight || 17;
    const target = Math.max(0, Math.floor(Number(line) || 0) * rh);
    el.scrollTop = Math.min(
      target,
      Math.max(0, el.scrollHeight - el.clientHeight)
    );
  }
  /** Recalculate dimensions after the container resizes (manual trigger). */
  fitToContainer() {
    if (typeof this._setupResizeObserver === "function") {
      this._setupResizeObserver();
    }
  }
  /** Return a snapshot of the visible buffer text (rows currently in DOM). */
  getBufferSnapshot() {
    const rows = this.element?.querySelectorAll?.("[data-line]") ?? [];
    return Array.from(rows).map((r) => r.textContent || "");
  }
  /** Fire render-complete callbacks (called internally after _doRender). */
  _fireRenderComplete() {
    if (this._renderCallbacks.size === 0) return;
    const st = this.getViewportState();
    this._renderCallbacks.forEach((fn) => {
      try {
        fn(st);
      } catch {
      }
    });
  }
  _buildViewportFacade() {
    const self = this;
    return {
      get atBottom() {
        return self._isScrolledToBottom();
      },
      get maxScroll() {
        const el = self.element;
        return el ? Math.max(0, el.scrollHeight - el.clientHeight) : 0;
      },
      get scrollTop() {
        const el = self.element;
        return el ? el.scrollTop : 0;
      },
      get rowHeight() {
        return self._rowHeight || 17;
      },
      get charWidth() {
        return self._charWidth || 8;
      },
      get rows() {
        return self.rows;
      },
      get cols() {
        return self.cols;
      },
      follow() {
        self.followBottom();
      },
      lock() {
        self.lockBottom();
      },
      scrollToBottom() {
        self._scrollToBottom();
      },
      scrollToLine(line) {
        self.scrollToLine(line);
      },
      state() {
        return self.getViewportState();
      }
    };
  }
  write(data) {
    if (!this.bridge) return;
    if (this.debug) this.debug.traceWrite(data);
    if (!this._isXtermEngine()) {
      this._shouldScrollToBottom = this._isScrolledToBottom();
    }
    if (typeof data === "string") {
      this.bridge.writeString(data);
    } else {
      this.bridge.writeRaw(data);
    }
    if (this._isXtermEngine()) {
      this._shouldScrollToBottom = this._isScrolledToBottom();
    }
    this._scheduleRender();
  }
  resize(cols, rows) {
    if (!this.bridge) return;
    if (!this._isXtermEngine()) {
      this._shouldScrollToBottom = this._isScrolledToBottom();
    }
    this.cols = cols;
    this.rows = rows;
    this.bridge.resize(cols, rows);
    this.renderer?.setup(cols, rows);
    this._pushMetricsToRenderer();
    if (this._isXtermEngine()) {
      this._shouldScrollToBottom = this._isScrolledToBottom();
    }
    this._scheduleRender();
    if (this.onResize) this.onResize(cols, rows);
  }
  focus() {
    if (this.input) {
      this.input.focus();
    } else {
      this.element.focus();
    }
  }
  _scheduleRender() {
    if (this._renderTimer != null) return;
    this._renderTimer = setTimeout(() => {
      this._renderTimer = null;
      if (this.rafId == null) {
        this.rafId = requestAnimationFrame(() => {
          this.rafId = null;
          this._doRender();
        });
      }
    }, 0);
  }
  _initialRender() {
    this._doRender();
  }
  _doRender() {
    if (!this.bridge || !this.renderer) return;
    if (this.bridge.syncOutput()) return;
    let dirtyCount = 0;
    const t0 = this.debug ? performance.now() : 0;
    if (this.debug) {
      for (let r = 0; r < this.rows; r++) {
        if (this.bridge.isDirtyRow(r)) dirtyCount++;
      }
    }
    this.renderer.render(this.bridge);
    if (!this._liveMetricsSynced) {
      const before = this._charWidth;
      const m = this.refreshCellMetrics();
      this._liveMetricsSynced = true;
      if (m.charWidth > 0 && before > 0 && Math.abs(m.charWidth - before) > 0.25) {
        this.renderer.render(this.bridge);
      }
    }
    if (this.debug) {
      this.debug.recordRender(performance.now() - t0, dirtyCount);
    }
    const hasScrollback = this.bridge.getScrollbackCount() > 0;
    this.element.classList.toggle("has-scrollback", hasScrollback);
    this.element.classList.toggle("xterm-viewport", this._isXtermEngine());
    if (this._isXtermEngine()) {
      this._shouldScrollToBottom = this._isScrolledToBottom();
      if (this.element.scrollTop !== 0) this.element.scrollTop = 0;
    } else if (this._shouldScrollToBottom) {
      this._scrollToBottom();
    } else if (!hasScrollback && this.element.scrollTop !== 0) {
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
    if (this.bridge.bellPending()) {
      this.bridge.clearBell();
      if (this.onBell) this.onBell();
    }
    const colorChanges = this.bridge.takeColorChanges();
    if (colorChanges.some((change) => applyColorChange(this.element, change))) {
      this.renderer.invalidateAll();
      requestAnimationFrame(() => this.renderer.render(this.bridge));
    }
    const colorQueries = this.bridge.takeColorQueries();
    if (colorQueries.length && this.onData) {
      for (const query of colorQueries) {
        const [r, g, b] = resolveQueryColor(this.element, query.kind, query.index);
        const hex = (value) => (value * 257).toString(16).padStart(4, "0");
        const selector = query.kind === 4 ? `4;${query.index}` : String(query.kind);
        this.onData(`\x1B]${selector};rgb:${hex(r)}/${hex(g)}/${hex(b)}\x1B\\`);
      }
    }
    const clipboard = this.bridge.takeClipboardRequest();
    if (clipboard && this.onClipboard) this.onClipboard(clipboard);
    this._fireRenderComplete();
  }
  _lockHeight() {
    const rh = this._rowHeight || 17;
    const gridHeight = this.rows * rh;
    const cs = getComputedStyle(this.element);
    let extra = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    if (cs.boxSizing === "border-box") {
      extra += (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
    }
    this.element.style.height = `${gridHeight + extra}px`;
  }
  /**
   * Measure one monospaced cell using a real .term-row > span probe inside the
   * live grid, so font-family/size/line-height match painted rows.
   * Does NOT write CSS vars — callers (refreshCellMetrics) own that.
   *
   * Prefer measuring a painted grid cell (Range over one glyph) when rows
   * already exist — that is the ground truth the cursor must match. Fall back
   * to a 64× space probe (spaces never form ligatures and match mono advance
   * even when the first font in the stack is missing and a proportional face
   * is briefly used for letter glyphs like "W").
   */
  _measureCharSize() {
    try {
      const liveRow = this._container.querySelector(
        ".term-row > span, .term-row"
      );
      if (liveRow) {
        const rowEl = liveRow.classList?.contains("term-row") ? liveRow : liveRow.parentElement;
        const span = liveRow.tagName === "SPAN" ? liveRow : liveRow.querySelector("span");
        const text = span?.firstChild;
        if (text && text.nodeType === Node.TEXT_NODE && (text.textContent || "").length > 0) {
          const range = document.createRange();
          range.setStart(text, 0);
          range.setEnd(text, 1);
          const cellRect = range.getBoundingClientRect();
          const rowRect2 = (rowEl || liveRow).getBoundingClientRect();
          if (cellRect.width > 0 && rowRect2.height > 0) {
            return { charWidth: cellRect.width, rowHeight: rowRect2.height };
          }
        }
        if (rowEl) {
          const rowRect2 = rowEl.getBoundingClientRect();
          if (rowRect2.height > 0 && this._charWidth > 0) {
            return { charWidth: this._charWidth, rowHeight: rowRect2.height };
          }
        }
      }
    } catch {
    }
    const row = document.createElement("div");
    row.className = "term-row";
    row.style.visibility = "hidden";
    row.style.position = "absolute";
    row.style.pointerEvents = "none";
    row.style.left = "0";
    row.style.top = "0";
    const probe = document.createElement("span");
    probe.textContent = " ".repeat(64);
    probe.style.whiteSpace = "pre";
    probe.style.fontVariantLigatures = "none";
    const hostFont = getComputedStyle(this.element).fontFamily || "monospace";
    probe.style.fontFamily = hostFont.includes("monospace") ? hostFont : `${hostFont}, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
    probe.style.fontSize = getComputedStyle(this.element).fontSize;
    row.appendChild(probe);
    this._container.appendChild(row);
    const spanRect = probe.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    row.remove();
    const charWidth = spanRect.width > 0 ? spanRect.width / 64 : 0;
    const rowHeight = rowRect.height > 0 ? rowRect.height : spanRect.height;
    if (charWidth === 0 || rowHeight === 0) return null;
    return { charWidth, rowHeight };
  }
  _setupResizeObserver() {
    const initial = this.refreshCellMetrics();
    if (!initial.charWidth || !initial.rowHeight) return;
    let charWidth = initial.charWidth;
    let rowHeight = initial.rowHeight;
    this.resizeObserver = new ResizeObserver((entries) => {
      const measured = this.refreshCellMetrics();
      if (measured.charWidth > 0) charWidth = measured.charWidth;
      if (measured.rowHeight > 0) rowHeight = measured.rowHeight;
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
  /** Return current DOM selection text inside the terminal, if any. */
  getSelectionText() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return "";
    const range = sel.getRangeAt(0);
    if (!this.element.contains(range.commonAncestorContainer)) return "";
    return sel.toString();
  }
  /** Select all currently rendered terminal text (DOM path). */
  selectAll() {
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.selectNodeContents(this._container || this.element);
    sel.removeAllRanges();
    sel.addRange(range);
  }
  clearSelection() {
    const sel = window.getSelection();
    sel?.removeAllRanges();
  }
  /**
   * Search rendered text and optionally highlight the active match.
   * Returns match offsets in flattened rendered text coordinates.
   */
  findMatches(query, { caseSensitive = false } = {}) {
    if (!query) return [];
    const hay = this._container?.innerText || this.element.innerText || "";
    const src = caseSensitive ? hay : hay.toLowerCase();
    const needle = caseSensitive ? query : query.toLowerCase();
    const out = [];
    let from = 0;
    while (from < src.length) {
      const idx = src.indexOf(needle, from);
      if (idx < 0) break;
      out.push({ start: idx, end: idx + needle.length, text: hay.slice(idx, idx + needle.length) });
      from = idx + Math.max(1, needle.length);
    }
    return out;
  }
  /** Highlight the Nth match from findMatches by selecting it in the DOM. */
  selectMatch(query, index = 0, opts = {}) {
    const matches = this.findMatches(query, opts);
    if (!matches.length) return false;
    const match = matches[(index % matches.length + matches.length) % matches.length];
    const root = this._container || this.element;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let pos = 0;
    let startNode = null;
    let endNode = null;
    let startOffset = 0;
    let endOffset = 0;
    let node;
    while (node = walker.nextNode()) {
      const text = node.textContent || "";
      const next = pos + text.length;
      if (!startNode && match.start >= pos && match.start <= next) {
        startNode = node;
        startOffset = match.start - pos;
      }
      if (match.end >= pos && match.end <= next) {
        endNode = node;
        endOffset = match.end - pos;
        break;
      }
      pos = next;
    }
    if (!startNode || !endNode) return false;
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    const sel = window.getSelection();
    if (!sel) return false;
    sel.removeAllRanges();
    sel.addRange(range);
    try {
      startNode.parentElement?.scrollIntoView?.({ block: "nearest" });
    } catch {
    }
    return true;
  }
  /** Enable/disable font ligatures for same-style runs. */
  setLigatures(enabled) {
    this.element.classList.toggle("allow-ligatures", !!enabled);
  }
  getLigatures() {
    return this.element.classList.contains("allow-ligatures");
  }
  destroy() {
    this._destroyed = true;
    if (this._renderTimer != null) clearTimeout(this._renderTimer);
    if (this.rafId != null) cancelAnimationFrame(this.rafId);
    if (this.resizeObserver) this.resizeObserver.disconnect();
    if (this.input) this.input.destroy();
    this.element.removeEventListener("click", this._onClickFocus);
    this.element.removeEventListener("wheel", this._onVirtualWheel);
    try {
      this.bridge?.dispose?.();
    } catch {
    }
    this.bridge = null;
    this.element.innerHTML = "";
    this._renderCallbacks.clear();
    this._viewportCallbacks.clear();
    if (this.debug && globalThis.__wterm === this) {
      delete globalThis.__wterm;
    }
    this.debug = null;
  }
}
export {
  WTerm,
  applyColorChange,
  parseOscColor
};
