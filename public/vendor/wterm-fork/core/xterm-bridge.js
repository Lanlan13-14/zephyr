var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
const WTERM_DEFAULT_COLOR = 256;
const FLAG_BOLD = 1;
const FLAG_DIM = 2;
const FLAG_ITALIC = 4;
const FLAG_UNDERLINE = 8;
const FLAG_REVERSE = 32;
const FLAG_INVISIBLE = 64;
const FLAG_STRIKETHROUGH = 128;
const CM_DEFAULT = 0;
const CM_P16 = 16777216;
const CM_P256 = 33554432;
const CM_RGB = 50331648;
const CM_MASK = 50331648;
let _defaultTerminalCtor = null;
function setDefaultXtermTerminalCtor(ctor) {
  _defaultTerminalCtor = ctor;
}
function getDefaultXtermTerminalCtor() {
  return _defaultTerminalCtor;
}
function resolveTerminalCtor(options) {
  if (options.Terminal) return options.Terminal;
  if (_defaultTerminalCtor) return _defaultTerminalCtor;
  throw new Error(
    "XtermBridge: no Terminal constructor. Pass options.Terminal or call setDefaultXtermTerminalCtor()."
  );
}
function createTerminal(options) {
  if (options.terminal) return options.terminal;
  const Ctor = resolveTerminalCtor(options);
  return new Ctor({
    cols: options.cols ?? 80,
    rows: options.rows ?? 24,
    scrollback: options.scrollback ?? 5e3,
    convertEol: options.convertEol ?? false,
    allowProposedApi: options.allowProposedApi !== false,
    // Headless: no DOM; cursor blink is purely a mode flag for our overlay.
    cursorBlink: false,
    logLevel: "off"
  });
}
function mapColorMode(mode) {
  const m = mode & CM_MASK;
  if (m === CM_RGB) return "rgb";
  if (m === CM_P16 || m === CM_P256) return "palette";
  return "default";
}
function cellFromXterm(cell, out) {
  const result = out ?? {
    char: 0,
    fg: WTERM_DEFAULT_COLOR,
    bg: WTERM_DEFAULT_COLOR,
    flags: 0
  };
  if (!cell) {
    result.char = 0;
    result.fg = WTERM_DEFAULT_COLOR;
    result.bg = WTERM_DEFAULT_COLOR;
    result.flags = 0;
    result.fgRgb = void 0;
    result.bgRgb = void 0;
    result.wide = 0;
    result.linkId = 0;
    return result;
  }
  const chars = cell.getChars();
  if (!chars) {
    result.char = 0;
  } else if (chars.length === 1) {
    result.char = chars.codePointAt(0) ?? cell.getCode() ?? 0;
  } else {
    const cp = chars.codePointAt(0) ?? 0;
    if ([...chars].length > 1 || chars.length > 2) {
      result.char = cp;
      result._grapheme = chars;
    } else {
      result.char = cp;
    }
  }
  let flags = 0;
  if (cell.isBold()) flags |= FLAG_BOLD;
  if (cell.isDim()) flags |= FLAG_DIM;
  if (cell.isItalic()) flags |= FLAG_ITALIC;
  if (cell.isUnderline()) flags |= FLAG_UNDERLINE;
  if (cell.isInverse()) flags |= FLAG_REVERSE;
  if (cell.isInvisible()) flags |= FLAG_INVISIBLE;
  if (cell.isStrikethrough()) flags |= FLAG_STRIKETHROUGH;
  result.flags = flags;
  result.fgRgb = void 0;
  if (cell.isFgDefault()) {
    result.fg = WTERM_DEFAULT_COLOR;
  } else if (cell.isFgRGB()) {
    result.fg = WTERM_DEFAULT_COLOR;
    result.fgRgb = cell.getFgColor() & 16777215;
  } else {
    result.fg = cell.getFgColor() & 255;
  }
  result.bgRgb = void 0;
  if (cell.isBgDefault()) {
    result.bg = WTERM_DEFAULT_COLOR;
  } else if (cell.isBgRGB()) {
    result.bg = WTERM_DEFAULT_COLOR;
    result.bgRgb = cell.getBgColor() & 16777215;
  } else {
    result.bg = cell.getBgColor() & 255;
  }
  const width = cell.getWidth();
  if (width === 2) result.wide = 1;
  else if (width === 0) result.wide = 2;
  else result.wide = 0;
  const urlId = cell.extended?.urlId ?? // Some builds expose via private attr; best-effort.
  0;
  result.linkId = urlId || 0;
  return result;
}
class XtermBridge {
  constructor(options = {}) {
    __publicField(this, "kind", "xterm");
    /** Signal to the DOM renderer: paint viewport only; do not expand scrollback rows. */
    __publicField(this, "virtualViewport", true);
    __publicField(this, "_term");
    __publicField(this, "_cols", 80);
    __publicField(this, "_rows", 24);
    __publicField(this, "_dirty", new Uint8Array(256));
    __publicField(this, "_allDirty", true);
    /**
     * Net ydisp delta since last paint (positive = toward bottom / newer).
     * Renderer recycles row DOM by this and only rebuilds the incoming edge.
     * Avoids full-viewport markAllDirty on every history scroll line (mobile jank).
     */
    __publicField(this, "_pendingScrollDelta", 0);
    __publicField(this, "_scrollSuppressDirty", false);
    __publicField(this, "_bellPending", false);
    __publicField(this, "_title", null);
    __publicField(this, "_titleChanged", false);
    __publicField(this, "_responseQueue", []);
    __publicField(this, "_disposables", []);
    __publicField(this, "_cellScratch", { char: 0, fg: 256, bg: 256, flags: 0 });
    __publicField(this, "_nullCell", null);
    __publicField(this, "_graphemeTable", /* @__PURE__ */ new Map());
    __publicField(this, "_graphemeNextId", 1);
    __publicField(this, "_cursorStyle", 0);
    // DECSCUSR; xterm headless does not expose full style — default block
    __publicField(this, "_ownsTerminal");
    this._ownsTerminal = !options.terminal;
    this._term = createTerminal(options);
    this._cols = this._term.cols;
    this._rows = this._term.rows;
    this._bindEvents();
    this.markAllDirty();
  }
  /** Underlying xterm Terminal (for advanced host use / debugging). */
  get terminal() {
    return this._term;
  }
  static async load(options = {}) {
    if (!options.Terminal && !options.terminal && !_defaultTerminalCtor) {
      try {
        const mod = await Promise.resolve({ Terminal: null });
        const Ctor = mod.Terminal || mod.default?.Terminal || mod.default;
        if (typeof Ctor === "function") setDefaultXtermTerminalCtor(Ctor);
      } catch {
      }
    }
    return new XtermBridge(options);
  }
  _bindEvents() {
    this._disposables.push(
      this._term.onBell(() => {
        this._bellPending = true;
      })
    );
    this._disposables.push(
      this._term.onTitleChange((title) => {
        this._title = title;
        this._titleChanged = true;
      })
    );
    this._disposables.push(
      this._term.onData((data) => {
        if (data) this._responseQueue.push(data);
      })
    );
    this._disposables.push(
      this._term.onWriteParsed(() => {
        // Write may change any cell; full rebuild. Scroll alone must NOT go through here.
        this.markAllDirty();
      })
    );
    if (typeof this._term.onScroll === "function") {
      this._disposables.push(
        this._term.onScroll(() => {
          // scrollLines / scrollTo* already track _pendingScrollDelta.
          // A full markAllDirty here forced 40-row DOM rebuild every finger move.
          if (this._scrollSuppressDirty) return;
          // External/unknown scroll source: fall back to full dirty.
          this.markAllDirty();
        })
      );
    }
    if (typeof this._term.onRender === "function") {
      this._disposables.push(
        this._term.onRender(({ start, end }) => {
          const lo = Math.max(0, start | 0);
          const hi = Math.min(this._rows - 1, end | 0);
          for (let r = lo; r <= hi; r++) this._dirty[r] = 1;
        })
      );
    }
  }
  // -- Lifecycle -----------------------------------------------------------
  init(cols, rows) {
    this.resize(cols, rows);
    this.markAllDirty();
  }
  resize(cols, rows) {
    const c = Math.max(1, Math.floor(cols) || 1);
    const r = Math.max(1, Math.floor(rows) || 1);
    if (c === this._cols && r === this._rows && c === this._term.cols && r === this._term.rows) {
      return;
    }
    this._flushWriteBuffer();
    this._term.resize(c, r);
    this._cols = this._term.cols;
    this._rows = this._term.rows;
    if (this._dirty.length < this._rows) {
      this._dirty = new Uint8Array(Math.max(256, this._rows));
    }
    this.markAllDirty();
  }
  dispose() {
    for (const d of this._disposables) {
      try {
        d.dispose();
      } catch {
      }
    }
    this._disposables = [];
    if (this._ownsTerminal) {
      try {
        this._term.dispose();
      } catch {
      }
    }
  }
  // -- I/O -----------------------------------------------------------------
  writeString(str) {
    if (!str) return;
    this._write(str);
  }
  writeRaw(data) {
    if (!data || data.length === 0) return;
    this._write(data);
  }
  _write(data) {
    const wb = this._term._core?._writeBuffer;
    if (wb && typeof wb.writeSync === "function") {
      try {
        wb.writeSync(data);
        this.markAllDirty();
        return;
      } catch {
      }
    }
    this._term.write(data);
    this.markAllDirty();
  }
  _flushWriteBuffer() {
    const wb = this._term._core?._writeBuffer;
    if (!wb) return;
  }
  // -- Grid ----------------------------------------------------------------
  _active() {
    return this._term.buffer.active;
  }
  _ensureNullCell() {
    if (!this._nullCell) this._nullCell = this._active().getNullCell();
    return this._nullCell;
  }
  /**
   * Absolute buffer line for a *viewport-relative* row.
   * xterm owns ydisp: row 0 is always buffer.viewportY (ydisp), not baseY.
   * Scrolling history = change ydisp; DOM only paints the current viewport.
   */
  _viewportLineIndex(row) {
    const buf = this._active();
    return (buf.viewportY | 0) + (row | 0);
  }
  /** ydisp === ybase (xterm stick-bottom truth). */
  isAtBottom() {
    const buf = this._active();
    return (buf.viewportY | 0) >= (buf.baseY | 0);
  }
  getViewportY() {
    return this._active().viewportY | 0;
  }
  getBaseY() {
    return this._active().baseY | 0;
  }
  /**
   * Record ydisp movement for row-recycle paint. Large jumps → full dirty.
   * amount = after - before (positive toward bottom).
   */
  _noteViewportScroll(delta) {
    const d = Math.trunc(Number(delta) || 0);
    if (!d) return;
    const rows = this._rows | 0;
    this._pendingScrollDelta = (this._pendingScrollDelta | 0) + d;
    if (Math.abs(this._pendingScrollDelta) >= Math.max(1, rows)) {
      this.markAllDirty();
      return;
    }
    // Edge rows that will enter the viewport after recycle.
    this._allDirty = false;
    if (d > 0) {
      const start = Math.max(0, rows - Math.abs(this._pendingScrollDelta));
      for (let r = start; r < rows; r++) this._dirty[r] = 1;
    } else {
      const end = Math.min(rows, Math.abs(this._pendingScrollDelta));
      for (let r = 0; r < end; r++) this._dirty[r] = 1;
    }
  }
  /** Renderer consumes net scroll since last paint (then recycles DOM rows). */
  consumeViewportScrollDelta() {
    const d = this._pendingScrollDelta | 0;
    this._pendingScrollDelta = 0;
    return d;
  }
  /** Drive xterm buffer scroll. amount is in rows (negative = up into history). */
  scrollLines(amount) {
    const n = Math.trunc(Number(amount) || 0);
    if (!n) return;
    const before = this.getViewportY();
    this._scrollSuppressDirty = true;
    try {
      if (typeof this._term.scrollLines === "function") {
        this._term.scrollLines(n);
      }
    } finally {
      this._scrollSuppressDirty = false;
    }
    const after = this.getViewportY();
    if (after !== before) this._noteViewportScroll(after - before);
  }
  scrollToBottom() {
    if (this.isAtBottom()) return;
    const before = this.getViewportY();
    this._scrollSuppressDirty = true;
    try {
      if (typeof this._term.scrollToBottom === "function") {
        this._term.scrollToBottom();
      } else {
        const buf = this._active();
        const delta = (buf.baseY | 0) - (buf.viewportY | 0);
        if (delta && typeof this._term.scrollLines === "function") {
          this._term.scrollLines(delta);
        }
      }
    } finally {
      this._scrollSuppressDirty = false;
    }
    const after = this.getViewportY();
    if (after !== before) {
      if (Math.abs(after - before) >= (this._rows | 0)) this.markAllDirty();
      else this._noteViewportScroll(after - before);
    }
  }
  scrollToTop() {
    if (this.getViewportY() === 0) return;
    const before = this.getViewportY();
    this._scrollSuppressDirty = true;
    try {
      if (typeof this._term.scrollToTop === "function") {
        this._term.scrollToTop();
      } else if (typeof this._term.scrollLines === "function") {
        this._term.scrollLines(-(this._active().viewportY | 0));
      }
    } finally {
      this._scrollSuppressDirty = false;
    }
    const after = this.getViewportY();
    if (after !== before) {
      if (Math.abs(after - before) >= (this._rows | 0)) this.markAllDirty();
      else this._noteViewportScroll(after - before);
    }
  }
  /** Absolute buffer line index → ydisp. */
  scrollToLine(line) {
    const target = Math.max(0, Math.floor(Number(line) || 0));
    if (target === this.getViewportY()) return;
    const before = this.getViewportY();
    this._scrollSuppressDirty = true;
    try {
      if (typeof this._term.scrollToLine === "function") {
        this._term.scrollToLine(target);
      } else if (typeof this._term.scrollLines === "function") {
        const delta = target - (this._active().viewportY | 0);
        if (delta) this._term.scrollLines(delta);
      }
    } finally {
      this._scrollSuppressDirty = false;
    }
    const after = this.getViewportY();
    if (after !== before) {
      if (Math.abs(after - before) >= (this._rows | 0)) this.markAllDirty();
      else this._noteViewportScroll(after - before);
    }
  }
  getCell(row, col) {
    const buf = this._active();
    const lineIdx = this._viewportLineIndex(row);
    const line = buf.getLine(lineIdx);
    const scratch = this._ensureNullCell();
    const cell = line?.getCell(col, scratch) ?? null;
    const out = cellFromXterm(cell, this._cellScratch);
    const g = out._grapheme;
    if (g) {
      out.char = this._registerGrapheme(g);
      delete out._grapheme;
    }
    // Zero-copy: single-threaded paint reads fields immediately. Cloning every
    // cell (cols×rows×dirty) was a major GC cost during history scroll.
    return out;
  }
  getHyperlink(id) {
    if (!id) return null;
    try {
      const data = this._term._core?._oscLinkService?.getLinkData?.(id);
      return data?.uri || null;
    } catch {
      return null;
    }
  }
  getGrapheme(char) {
    if ((char & 2147483648) === 0) return null;
    const id = (char & 2147483647) >>> 0;
    return this._graphemeTable.get(id) ?? null;
  }
  _registerGrapheme(text) {
    for (const [id2, v] of this._graphemeTable) {
      if (v === text) return (2147483648 | id2) >>> 0;
    }
    const id = this._graphemeNextId++;
    if (this._graphemeNextId > 2147483632) {
      this._graphemeTable.clear();
      this._graphemeNextId = 1;
    }
    this._graphemeTable.set(id, text);
    return (2147483648 | id) >>> 0;
  }
  isDirtyRow(row) {
    if (this._allDirty) return true;
    if (row < 0 || row >= this._rows) return false;
    return this._dirty[row] !== 0;
  }
  clearDirty() {
    this._dirty.fill(0);
    this._allDirty = false;
    this._pendingScrollDelta = 0;
  }
  markAllDirty() {
    this._allDirty = true;
    this._dirty.fill(1);
    // Full rebuild supersedes row-recycle scroll delta.
    this._pendingScrollDelta = 0;
  }
  getCols() {
    return this._term.cols || this._cols;
  }
  getRows() {
    return this._term.rows || this._rows;
  }
  // -- Cursor --------------------------------------------------------------
  getCursor() {
    const buf = this._active();
    const hidden = !!this._term._core?.coreService?.isCursorHidden;
    const show = this._term.modes?.showCursor !== false;
    return {
      row: buf.cursorY,
      col: buf.cursorX,
      visible: show && !hidden,
      style: this._cursorStyle
    };
  }
  cursorStyle() {
    return this._cursorStyle;
  }
  // -- Modes ---------------------------------------------------------------
  cursorKeysApp() {
    return !!this._term.modes?.applicationCursorKeysMode;
  }
  bracketedPaste() {
    return !!this._term.modes?.bracketedPasteMode;
  }
  mouseMode() {
    switch (this._term.modes?.mouseTrackingMode) {
      case "x10":
        return 1;
      case "vt200":
        return 2;
      case "drag":
        return 3;
      case "any":
        return 4;
      default:
        return 0;
    }
  }
  mouseSGR() {
    try {
      return this._term._core?.mouseStateService?.activeEncoding === "SGR";
    } catch {
      return false;
    }
  }
  mouseAltScroll() {
    try {
      return !!this._term._core?.coreService?.decPrivateModes?.mouseWheelToArrowKeys;
    } catch {
      return false;
    }
  }
  reverseWrap() {
    return !!this._term.modes?.reverseWraparoundMode;
  }
  column132() {
    return false;
  }
  bellPending() {
    return this._bellPending;
  }
  clearBell() {
    this._bellPending = false;
  }
  syncOutput() {
    return !!this._term.modes?.synchronizedOutputMode;
  }
  focusReporting() {
    return !!this._term.modes?.sendFocusMode;
  }
  reverseScreen() {
    try {
      return !!this._term._core?.coreService?.decPrivateModes?.reverseVideo;
    } catch {
      return false;
    }
  }
  kittyKeyboardFlags() {
    try {
      const kk = this._term._core?.coreService?.kittyKeyboardService ?? this._term._core?._kittyKeyboardService;
      if (kk && typeof kk.flags === "number") return kk.flags;
      if (kk && typeof kk.getFlags === "function") return kk.getFlags() | 0;
    } catch {
    }
    return 0;
  }
  keypadApp() {
    return !!this._term.modes?.applicationKeypadMode;
  }
  insertMode() {
    return !!this._term.modes?.insertMode;
  }
  usingAltScreen() {
    return this._active().type === "alternate";
  }
  // -- Side outputs --------------------------------------------------------
  getTitle() {
    if (!this._titleChanged) return null;
    this._titleChanged = false;
    return this._title;
  }
  getResponse() {
    if (!this._responseQueue.length) return null;
    return this._responseQueue.splice(0, this._responseQueue.length).join("");
  }
  // -- Scrollback ----------------------------------------------------------
  //
  // With xterm-owned viewport, the DOM paints ONLY the current ydisp window
  // (getCell rows). Scrollback rows are NOT expanded into the DOM — that was
  // the old WTerm/WASM model. getScrollback* stay available for host tools
  // (AI snapshot, history export) but the renderer must not call them for paint.
  getScrollbackCount() {
    const buf = this._active();
    if (buf.type === "alternate") return 0;
    return Math.max(0, buf.baseY | 0);
  }
  getScrollbackCell(offset, col) {
    const buf = this._active();
    const count = Math.max(0, buf.baseY | 0);
    const lineIdx = count - 1 - (offset | 0);
    if (lineIdx < 0 || lineIdx >= buf.length) {
      return { char: 0, fg: WTERM_DEFAULT_COLOR, bg: WTERM_DEFAULT_COLOR, flags: 0, wide: 0, linkId: 0 };
    }
    const line = buf.getLine(lineIdx);
    const scratch = this._ensureNullCell();
    const cell = line?.getCell(col, scratch) ?? null;
    const out = cellFromXterm(cell, this._cellScratch);
    const g = out._grapheme;
    if (g) {
      out.char = this._registerGrapheme(g);
      delete out._grapheme;
    }
    return { ...out };
  }
  getScrollbackLineLen(offset) {
    return this.getCols();
  }
  // -- Optional extras (renderer / host) -----------------------------------
  getImages() {
    return [];
  }
  takeClipboardRequest() {
    return null;
  }
  takeColorChanges() {
    return [];
  }
  takeColorQueries() {
    return [];
  }
  // -- Debug ---------------------------------------------------------------
  getUnhandledSequences() {
    return [];
  }
  /** Host helper: force full redraw after theme / font changes. */
  invalidate() {
    this.markAllDirty();
  }
}
export {
  XtermBridge,
  cellFromXterm,
  getDefaultXtermTerminalCtor,
  setDefaultXtermTerminalCtor
};
