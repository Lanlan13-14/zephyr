var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
import { WasmBridge } from "./core/index.js";
import { Renderer, resolveQueryColor } from "./renderer.js";
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
  const color = parseOscColor(change.value);
  if (!color) return false;
  if (change.kind === 4 && change.index >= 0 && change.index < 256) element.style.setProperty(`--term-color-${change.index}`, color);
  else if (change.kind === 10) element.style.setProperty("--term-fg", color);
  else if (change.kind === 11) element.style.setProperty("--term-bg", color);
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
    __publicField(this, "_debugEnabled");
    __publicField(this, "renderer", null);
    __publicField(this, "input", null);
    __publicField(this, "rafId", null);
    __publicField(this, "_renderTimer", null);
    __publicField(this, "resizeObserver", null);
    __publicField(this, "_destroyed", false);
    __publicField(this, "_shouldScrollToBottom", false);
    __publicField(this, "_rowHeight", 0);
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
    this.element = element;
    this._coreOption = options.core;
    this.wasmUrl = options.wasmUrl;
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
    this._onClickFocus = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) this.input?.focus();
    };
    this.element.addEventListener("click", this._onClickFocus);
    this.viewport = this._buildViewportFacade();
  }
  async init() {
    try {
      if (this._coreOption) {
        this.bridge = this._coreOption;
      } else {
        this.bridge = await WasmBridge.load(this.wasmUrl);
      }
      if (this._destroyed) return this;
      this.bridge.init(this.cols, this.rows);
      if (this._debugEnabled) {
        this.debug = new DebugAdapter();
        this.debug.setBridge(this.bridge);
        globalThis.__wterm = this;
      }
      this._setRowHeight();
      this.renderer = new Renderer(this._container);
      this.renderer.setup(this.cols, this.rows);
      this.input = new InputHandler(
        this.element,
        (data) => {
          this._scrollToBottom();
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
      this.input.focus();
      this._initialRender();
    } catch (err) {
      this.destroy();
      throw new Error(
        `wterm: failed to initialize: ${err instanceof Error ? err.message : err}`
      );
    }
    return this;
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
    return {
      atBottom: this._isScrolledToBottom(),
      scrollTop: el ? el.scrollTop : 0,
      maxScroll: el ? Math.max(0, el.scrollHeight - el.clientHeight) : 0,
      rowHeight: this._rowHeight || 17,
      rows: this.rows || 0,
      cols: this.cols || 0,
      followEnabled: !!this._shouldScrollToBottom
    };
  }
  /** Scroll to a specific line (0-indexed). Best-effort, clamped, row-aligned. */
  scrollToLine(line) {
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
    this._shouldScrollToBottom = this._isScrolledToBottom();
    if (typeof data === "string") {
      this.bridge.writeString(data);
    } else {
      this.bridge.writeRaw(data);
    }
    this._scheduleRender();
  }
  resize(cols, rows) {
    if (!this.bridge) return;
    this._shouldScrollToBottom = this._isScrolledToBottom();
    this.cols = cols;
    this.rows = rows;
    this.bridge.resize(cols, rows);
    this.renderer?.setup(cols, rows);
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
    if (this.debug) {
      this.debug.recordRender(performance.now() - t0, dirtyCount);
    }
    const hasScrollback = this.bridge.getScrollbackCount() > 0;
    this.element.classList.toggle("has-scrollback", hasScrollback);
    if (this._shouldScrollToBottom) {
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
    if (charWidth === 0 || rowHeight === 0) return null;
    this._rowHeight = rowHeight;
    return { charWidth, rowHeight };
  }
  _setupResizeObserver() {
    const initial = this._measureCharSize();
    if (!initial) return;
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
    if (this._renderTimer != null) clearTimeout(this._renderTimer);
    if (this.rafId != null) cancelAnimationFrame(this.rafId);
    if (this.resizeObserver) this.resizeObserver.disconnect();
    if (this.input) this.input.destroy();
    this.element.removeEventListener("click", this._onClickFocus);
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
