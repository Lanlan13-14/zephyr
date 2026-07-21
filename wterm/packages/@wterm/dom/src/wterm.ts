import { WasmBridge, type TerminalCore } from "@wterm/core";
import { Renderer, resolveQueryColor } from "./renderer.js";
import { CanvasRenderer } from "./canvas-renderer.js";
import { InputHandler } from "./input.js";
import { DebugAdapter } from "./debug.js";

type TermRenderer = {
  setup(cols: number, rows: number): void;
  render(core: any): void;
  invalidateAll(): void;
  setCellMetrics?(charWidth: number, rowHeight: number): void;
  getCellMetrics?(): { charWidth: number; rowHeight: number };
};

/** Single source of truth for cell geometry (px). */
export interface CellMetrics {
  charWidth: number;
  rowHeight: number;
  measuredAt: number;
}

export function parseOscColor(value: string): string | null {
  const input = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(input)) return input.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(input)) return '#' + [...input.slice(1)].map((c) => c + c).join('').toLowerCase();
  const match = input.match(/^rgb:([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})$/);
  if (!match) return null;
  const component = (part: string) => Math.round(parseInt(part, 16) * 255 / (Math.pow(16, part.length) - 1)).toString(16).padStart(2, '0');
  return `#${component(match[1])}${component(match[2])}${component(match[3])}`;
}

export function applyColorChange(element: HTMLElement, change: { kind: number; index: number; value: string }): boolean {
  if (change.kind === 104) { if (change.index === 65535) for (let i = 0; i < 256; i++) element.style.removeProperty(`--term-color-${i}`); else if (change.index >= 0 && change.index < 256) element.style.removeProperty(`--term-color-${change.index}`); return true; }
  if (change.kind === 110) { element.style.removeProperty('--term-fg'); return true; }
  if (change.kind === 111) { element.style.removeProperty('--term-bg'); return true; }
  if (change.kind === 112) { element.style.removeProperty('--term-cursor'); return true; }
  const color = parseOscColor(change.value); if (!color) return false;
  if (change.kind === 4 && change.index >= 0 && change.index < 256) element.style.setProperty(`--term-color-${change.index}`, color);
  else if (change.kind === 10) element.style.setProperty('--term-fg', color);
  else if (change.kind === 11) element.style.setProperty('--term-bg', color);
  else if (change.kind === 12) element.style.setProperty('--term-cursor', color);
  else return false;
  return true;
}

export interface WTermOptions {
  cols?: number;
  rows?: number;
  /**
   * A pre-constructed terminal core. When provided, `wasmUrl` is ignored and
   * this core is used directly instead of loading the built-in Zig WASM binary.
   */
  core?: TerminalCore;
  wasmUrl?: string;
  autoResize?: boolean;
  cursorBlink?: boolean;
  /**
   * Enable font ligatures within same-style text runs.
   * Default false: monospaced terminals usually keep 1:1 cell mapping.
   */
  allowLigatures?: boolean;
  /**
   * Rendering backend.
   * - "dom" (default): full selection/history/hyperlink support
   * - "canvas": higher throughput for dense output; limited selection UX
   */
  /**
   * Native: WTerm owns hidden textarea focus and input scroll.
   * External: host owns IME proxy / focus / scroll; WTerm is render+VT only.
   */
  inputMode?: "native" | "external";
  /** Called from a real terminal gesture in external input mode. */
  onExternalInputRequest?: () => void;
  debug?: boolean;
  onData?: (data: string) => void;
  onTitle?: (title: string) => void;
  onResize?: (cols: number, rows: number) => void;
  onBell?: () => void;
  onClipboard?: (request: { selection: string; base64: string; query: boolean }) => void;
}

/** Viewport snapshot returned by {@link WTerm.getViewportState}. */
export interface ViewportState {
  atBottom: boolean;
  scrollTop: number;
  maxScroll: number;
  rowHeight: number;
  /** Measured monospaced cell advance in CSS px (same as getCellMetrics). */
  charWidth: number;
  rows: number;
  cols: number;
  followEnabled: boolean;
}

/**
 * Public viewport facade. Exposed as `term.viewport` so downstream controllers
 * can read and drive the viewport without touching private methods.
 * `atBottom` is a semantic truth (maxScroll - scrollTop), never inferred from
 * pixel positions after reflow.
 */
export interface ViewportFacade {
  readonly atBottom: boolean;
  readonly maxScroll: number;
  readonly scrollTop: number;
  readonly rowHeight: number;
  readonly charWidth: number;
  readonly rows: number;
  readonly cols: number;
  follow(): void;
  lock(): void;
  scrollToBottom(): void;
  scrollToLine(line: number): void;
  state(): ViewportState;
}

export class WTerm {
  element: HTMLElement;
  cols: number;
  rows: number;
  bridge: TerminalCore | null = null;
  autoResize: boolean;
  debug: DebugAdapter | null = null;
  /** Public viewport facade (Zephyr fork). */
  viewport: ViewportFacade;

  private _coreOption: TerminalCore | undefined;
  private wasmUrl: string | undefined;
  private _debugEnabled: boolean;
  private renderer: TermRenderer | null = null;
  private _rendererMode: "dom" | "canvas" = "dom";
  private _inputMode: "native" | "external" = "native";
  private _onExternalInputRequest: (() => void) | null = null;
  private input: InputHandler | null = null;
  private rafId: number | null = null;
  private _renderTimer: ReturnType<typeof setTimeout> | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private _destroyed = false;
  private _shouldScrollToBottom = false;
  private _rowHeight = 0;
  private _charWidth = 0;
  private _metricsMeasuredAt = 0;
  /** After first paint, remeasure from a live cell once (probe may drift). */
  private _liveMetricsSynced = false;
  private _onClickFocus: () => void;
  /** Render-complete callback set (Zephyr fork §3.8.2). */
  private _renderCallbacks: Set<(state: ViewportState) => void> = new Set();
  /** Viewport-change callback set (Zephyr fork §3.8.2). */
  private _viewportCallbacks: Set<(state: ViewportState) => void> = new Set();
  private _viewportListenerBound = false;

  onData: ((data: string) => void) | null;
  onTitle: ((title: string) => void) | null;
  onResize: ((cols: number, rows: number) => void) | null;
  onBell: (() => void) | null = null;
  onClipboard: ((request: { selection: string; base64: string; query: boolean }) => void) | null = null;

  private _container: HTMLDivElement;

  constructor(element: HTMLElement, options: WTermOptions = {}) {
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
    this.setLigatures(options.allowLigatures === true);
    this._rendererMode = options.renderer === "canvas" ? "canvas" : "dom";
    this._inputMode = options.inputMode === "external" ? "external" : "native";
    this._onExternalInputRequest = options.onExternalInputRequest || null;
    this.element.classList.toggle("renderer-canvas", this._rendererMode === "canvas");
    this.element.classList.toggle("external-input", this._inputMode === "external");

    this._onClickFocus = () => {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;
      // External mode is Zephyr mobile's one true IME path. Do NOT focus
      // WTerm's hidden textarea or call _scrollToBottom behind the host.
      if (this._inputMode === "external") {
        this._onExternalInputRequest?.();
        return;
      }
      this.input?.focus();
    };
    this.element.addEventListener("click", this._onClickFocus);

    // Mount the public viewport facade as a plain writable property (NOT a
    // getter) so downstream code can replace it without tripping "has only a
    // getter". Built once; reads live DOM on every access.
    this.viewport = this._buildViewportFacade();
  }

  async init(): Promise<this> {
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
        (globalThis as Record<string, unknown>).__wterm = this;
      }

      // Measure once before renderer setup so the cursor overlay and grid
      // share the same cell geometry from the first paint.
      this.refreshCellMetrics();

      this.renderer = this._rendererMode === "canvas"
        ? new CanvasRenderer(this._container)
        : new Renderer(this._container);
      this.renderer.setup(this.cols, this.rows);
      this._pushMetricsToRenderer();

      this.input = new InputHandler(
        this.element,
        (data) => {
          // Native desktop WTerm owns input scroll. In external/mobile mode
          // Zephyr TerminalSurface owns IME and the single scroll writer.
          if (this._inputMode === "native") this._scrollToBottom();
          if (this.onData) {
            this.onData(data);
          } else {
            this.write(data);
          }
        },
        () => this.bridge,
      );

      if (this.autoResize) {
        this._setupResizeObserver();
      } else {
        this._lockHeight();
      }

      // External/mobile mode has a dedicated IME proxy. Native focus here
      // would steal it and make keyboard opening intermittent.
      if (this._inputMode === "native") this.input.focus();
      this._initialRender();
    } catch (err) {
      this.destroy();
      throw new Error(
        `wterm: failed to initialize: ${err instanceof Error ? err.message : err}`,
      );
    }

    return this;
  }

  private _isScrolledToBottom(): boolean {
    const el = this.element;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 5;
  }

  private _scrollToBottom(): void {
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
  isAtBottom(): boolean {
    return this._isScrolledToBottom();
  }

  /** Scroll to the bottom, row-height aligned. Public alias. */
  scrollToBottom(): void {
    this._scrollToBottom();
  }

  /** Enable follow mode: subsequent renders auto-scroll to bottom. */
  followBottom(): void {
    this._shouldScrollToBottom = true;
  }

  /** Disable follow mode: renders will not auto-scroll. */
  lockBottom(): void {
    this._shouldScrollToBottom = false;
  }

  /** Register a callback fired after each render completes. Returns an
   *  unsubscribe function. Use this to drive scroll-follow decisions that
   *  must read the post-render DOM (e.g. cursor visibility after IME). */
  onRenderComplete(cb: (state: ViewportState) => void): () => void {
    if (typeof cb !== "function") return () => {};
    this._renderCallbacks.add(cb);
    return () => {
      this._renderCallbacks.delete(cb);
    };
  }

  /** Register a callback fired when the viewport scrolls. Returns unsubscribe. */
  onViewportChange(cb: (state: ViewportState) => void): () => void {
    if (typeof cb !== "function") return () => {};
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
              /* swallow */
            }
          });
        },
        { passive: true },
      );
    }
    return () => {
      this._viewportCallbacks.delete(cb);
    };
  }

  /** Return a serializable snapshot of the current viewport state. */
  getViewportState(): ViewportState {
    const el = this.element;
    return {
      atBottom: this._isScrolledToBottom(),
      scrollTop: el ? el.scrollTop : 0,
      maxScroll: el
        ? Math.max(0, el.scrollHeight - el.clientHeight)
        : 0,
      rowHeight: this._rowHeight || 17,
      charWidth: this._charWidth || 8,
      rows: this.rows || 0,
      cols: this.cols || 0,
      followEnabled: !!this._shouldScrollToBottom,
    };
  }

  /**
   * Single source of truth for cell geometry.
   * Prefer this over reading CSS vars or probing the DOM from the host.
   */
  getCellMetrics(): CellMetrics {
    return {
      charWidth: this._charWidth || 8,
      rowHeight: this._rowHeight || 17,
      measuredAt: this._metricsMeasuredAt || 0,
    };
  }

  /**
   * Re-measure cell size from the live font and write CSS vars + renderer.
   * Call after font-size / font-family / DPR / theme changes.
   * Returns the new metrics (or last known if measure failed).
   */
  refreshCellMetrics(): CellMetrics {
    const measured = this._measureCharSize();
    if (measured) {
      // Keep sub-pixel precision. Ceil caused rowHeight to grow past the real
      // line box, which then inflated getMeasuredTerminalSize().rows downward
      // and left a black void under the prompt.
      const changed =
        Math.abs((this._charWidth || 0) - measured.charWidth) > 0.25 ||
        Math.abs((this._rowHeight || 0) - measured.rowHeight) > 0.25 ||
        this._charWidth === 0 ||
        this._rowHeight === 0;
      this._charWidth = measured.charWidth;
      this._rowHeight = measured.rowHeight;
      this._metricsMeasuredAt = performance.now();
      // Significant change → allow next paint to re-sync from a live cell.
      // Tiny noise must not thrash the one-shot flag (avoids render loops).
      if (changed && this._liveMetricsSynced) {
        this._liveMetricsSynced = false;
      }
      this.element.style.setProperty(
        "--term-row-height",
        `${measured.rowHeight}px`,
      );
      this.element.style.setProperty(
        "--term-cell-width",
        `${measured.charWidth}px`,
      );
      this._pushMetricsToRenderer();
    }
    return this.getCellMetrics();
  }

  /** @deprecated Use refreshCellMetrics(). Kept for hosts that still call it. */
  _setRowHeight(): void {
    this.refreshCellMetrics();
  }

  private _pushMetricsToRenderer(): void {
    if (!this.renderer) return;
    const cw = this._charWidth;
    const rh = this._rowHeight;
    if (cw > 0 && rh > 0 && typeof this.renderer.setCellMetrics === "function") {
      this.renderer.setCellMetrics(cw, rh);
    }
  }

  /** Scroll to a specific line (0-indexed). Best-effort, clamped, row-aligned. */
  scrollToLine(line: number): void {
    const el = this.element;
    if (!el) return;
    const rh = this._rowHeight || 17;
    const target = Math.max(0, Math.floor(Number(line) || 0) * rh);
    el.scrollTop = Math.min(
      target,
      Math.max(0, el.scrollHeight - el.clientHeight),
    );
  }

  /** Recalculate dimensions after the container resizes (manual trigger). */
  fitToContainer(): void {
    if (typeof this._setupResizeObserver === "function") {
      this._setupResizeObserver();
    }
  }

  /** Return a snapshot of the visible buffer text (rows currently in DOM). */
  getBufferSnapshot(): string[] {
    const rows = this.element?.querySelectorAll?.("[data-line]") ?? [];
    return Array.from(rows).map((r) => (r as HTMLElement).textContent || "");
  }

  /** Fire render-complete callbacks (called internally after _doRender). */
  private _fireRenderComplete(): void {
    if (this._renderCallbacks.size === 0) return;
    const st = this.getViewportState();
    this._renderCallbacks.forEach((fn) => {
      try {
        fn(st);
      } catch {
        /* swallow */
      }
    });
  }

  private _buildViewportFacade(): ViewportFacade {
    const self = this;
    return {
      get atBottom() {
        return self._isScrolledToBottom();
      },
      get maxScroll() {
        const el = self.element;
        return el
          ? Math.max(0, el.scrollHeight - el.clientHeight)
          : 0;
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
      scrollToLine(line: number) {
        self.scrollToLine(line);
      },
      state() {
        return self.getViewportState();
      },
    };
  }

  write(data: string | Uint8Array): void {
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

  resize(cols: number, rows: number): void {
    if (!this.bridge) return;
    this._shouldScrollToBottom = this._isScrolledToBottom();
    this.cols = cols;
    this.rows = rows;
    this.bridge.resize(cols, rows);
    this.renderer?.setup(cols, rows);
    // setup() rebuilds the DOM; re-push host metrics so the new cursor overlay
    // does not fall back to 1ch until the next font change.
    this._pushMetricsToRenderer();
    this._scheduleRender();
    if (this.onResize) this.onResize(cols, rows);
  }

  focus(): void {
    if (this.input) {
      this.input.focus();
    } else {
      this.element.focus();
    }
  }

  private _scheduleRender(): void {
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

  private _initialRender(): void {
    this._doRender();
  }

  private _doRender(): void {
    if (!this.bridge || !this.renderer) return;

    // DECSET 2026 synchronized output: the core continues parsing and keeps
    // every dirty row marked, but DOM publication is deferred until the
    // application sends the matching reset (ESC[?2026l). This prevents a
    // stream of intermediate frames from flashing during large redraws.
    if (this.bridge.syncOutput()) return;

    let dirtyCount = 0;
    const t0 = this.debug ? performance.now() : 0;
    if (this.debug) {
      for (let r = 0; r < this.rows; r++) {
        if (this.bridge.isDirtyRow(r)) dirtyCount++;
      }
    }

    this.renderer.render(this.bridge);

    // First paint: remeasure from a real cell so cursor px matches glyphs
    // even if the pre-paint space-probe drifted (missing mono face, etc.).
    if (!this._liveMetricsSynced) {
      const before = this._charWidth;
      const m = this.refreshCellMetrics();
      this._liveMetricsSynced = true;
      if (
        m.charWidth > 0 &&
        before > 0 &&
        Math.abs(m.charWidth - before) > 0.25
      ) {
        // Metrics moved — re-render once so the cursor overlay snaps.
        this.renderer.render(this.bridge);
      }
    }

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
        const [r,g,b] = resolveQueryColor(this.element, query.kind, query.index);
        const hex = (value: number) => (value * 257).toString(16).padStart(4, "0");
        const selector = query.kind === 4 ? `4;${query.index}` : String(query.kind);
        this.onData(`\x1b]${selector};rgb:${hex(r)}/${hex(g)}/${hex(b)}\x1b\\`);
      }
    }

    const clipboard = this.bridge.takeClipboardRequest();
    if (clipboard && this.onClipboard) this.onClipboard(clipboard);

    // Fire render-complete callbacks (Zephyr fork §3.8.2). This lets
    // downstream scroll-follow logic read the post-render DOM instead of
    // racing against the next animation frame.
    this._fireRenderComplete();
  }

  private _lockHeight(): void {
    const rh = this._rowHeight || 17;
    const gridHeight = this.rows * rh;
    const cs = getComputedStyle(this.element);
    let extra =
      (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    if (cs.boxSizing === "border-box") {
      extra +=
        (parseFloat(cs.borderTopWidth) || 0) +
        (parseFloat(cs.borderBottomWidth) || 0);
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
  private _measureCharSize(): {
    charWidth: number;
    rowHeight: number;
  } | null {
    // 1) Live painted cell — best signal.
    try {
      const liveRow = this._container.querySelector(
        ".term-row > span, .term-row",
      ) as HTMLElement | null;
      if (liveRow) {
        const rowEl = liveRow.classList?.contains("term-row")
          ? liveRow
          : (liveRow.parentElement as HTMLElement | null);
        const span =
          liveRow.tagName === "SPAN"
            ? liveRow
            : (liveRow.querySelector("span") as HTMLElement | null);
        const text = span?.firstChild;
        if (
          text &&
          text.nodeType === Node.TEXT_NODE &&
          (text.textContent || "").length > 0
        ) {
          const range = document.createRange();
          // Skip wide/emoji lead if possible: take first BMP glyph.
          range.setStart(text, 0);
          range.setEnd(text, 1);
          const cellRect = range.getBoundingClientRect();
          const rowRect = (rowEl || liveRow).getBoundingClientRect();
          if (cellRect.width > 0 && rowRect.height > 0) {
            return { charWidth: cellRect.width, rowHeight: rowRect.height };
          }
        }
        if (rowEl) {
          const rowRect = rowEl.getBoundingClientRect();
          // Fall through if we only got height.
          if (rowRect.height > 0 && this._charWidth > 0) {
            return { charWidth: this._charWidth, rowHeight: rowRect.height };
          }
        }
      }
    } catch {
      /* fall through to probe */
    }

    // 2) Probe with spaces (mono-stable advance; no ligatures).
    // Force a monospaced stack so a missing first face does not collapse the
    // probe onto a proportional fallback and inflate charWidth.
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
    probe.style.fontFamily = hostFont.includes("monospace")
      ? hostFont
      : `${hostFont}, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
    probe.style.fontSize = getComputedStyle(this.element).fontSize;
    row.appendChild(probe);

    this._container.appendChild(row);
    const spanRect = probe.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    row.remove();

    const charWidth = spanRect.width > 0 ? spanRect.width / 64 : 0;
    // Prefer the fixed row box height (CSS --term-row-height / .term-row height)
    // over the span content box, which can be taller than the line box on some
    // fonts and would inflate metrics.
    const rowHeight = rowRect.height > 0 ? rowRect.height : spanRect.height;
    if (charWidth === 0 || rowHeight === 0) return null;
    return { charWidth, rowHeight };
  }

  private _setupResizeObserver(): void {
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
  getSelectionText(): string {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return "";
    const range = sel.getRangeAt(0);
    if (!this.element.contains(range.commonAncestorContainer)) return "";
    return sel.toString();
  }

  /** Select all currently rendered terminal text (DOM path). */
  selectAll(): void {
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.selectNodeContents(this._container || this.element);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  clearSelection(): void {
    const sel = window.getSelection();
    sel?.removeAllRanges();
  }

  /**
   * Search rendered text and optionally highlight the active match.
   * Returns match offsets in flattened rendered text coordinates.
   */
  findMatches(query: string, { caseSensitive = false }: { caseSensitive?: boolean } = {}): Array<{ start: number; end: number; text: string }> {
    if (!query) return [];
    const hay = this._container?.innerText || this.element.innerText || "";
    const src = caseSensitive ? hay : hay.toLowerCase();
    const needle = caseSensitive ? query : query.toLowerCase();
    const out: Array<{ start: number; end: number; text: string }> = [];
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
  selectMatch(query: string, index = 0, opts: { caseSensitive?: boolean } = {}): boolean {
    const matches = this.findMatches(query, opts);
    if (!matches.length) return false;
    const match = matches[((index % matches.length) + matches.length) % matches.length];
    const root = this._container || this.element;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let pos = 0;
    let startNode: Text | null = null;
    let endNode: Text | null = null;
    let startOffset = 0;
    let endOffset = 0;
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const text = node.textContent || "";
      const next = pos + text.length;
      if (!startNode && match.start >= pos && match.start <= next) {
        startNode = node as Text;
        startOffset = match.start - pos;
      }
      if (match.end >= pos && match.end <= next) {
        endNode = node as Text;
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
    // ensure visible
    try { (startNode.parentElement as HTMLElement | null)?.scrollIntoView?.({ block: "nearest" }); } catch {}
    return true;
  }

  /** Enable/disable font ligatures for same-style runs. */
  setLigatures(enabled: boolean): void {
    this.element.classList.toggle("allow-ligatures", !!enabled);
  }

  getLigatures(): boolean {
    return this.element.classList.contains("allow-ligatures");
  }

  destroy(): void {
    this._destroyed = true;
    if (this._renderTimer != null) clearTimeout(this._renderTimer);
    if (this.rafId != null) cancelAnimationFrame(this.rafId);
    if (this.resizeObserver) this.resizeObserver.disconnect();
    if (this.input) this.input.destroy();
    this.element.removeEventListener("click", this._onClickFocus);
    this.element.innerHTML = "";
    this._renderCallbacks.clear();
    this._viewportCallbacks.clear();
    if (
      this.debug &&
      (globalThis as Record<string, unknown>).__wterm === this
    ) {
      delete (globalThis as Record<string, unknown>).__wterm;
    }
    this.debug = null;
  }
}
