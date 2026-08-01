/**
 * XtermBridge — TerminalCore adapter over @xterm/headless.
 *
 * Replaces WasmBridge as the VT/buffer engine while keeping the wterm DOM
 * renderer (and all Zephyr host code that talks to TerminalCore) unchanged.
 *
 * Cell / flag encoding matches WasmBridge + wterm/packages/@wterm/dom renderer:
 *   DEFAULT_COLOR = 256
 *   FLAG_BOLD=0x01 DIM=0x02 ITALIC=0x04 UNDERLINE=0x08 REVERSE=0x20
 *   INVISIBLE=0x40 STRIKETHROUGH=0x80
 *   wide: 0=narrow, 1=wide lead, 2=continuation
 */
import type {
  CellData,
  CursorState,
  UnhandledSequence,
  TerminalCore,
} from "./terminal-core.js";

// Lazy / injectable Terminal ctor so browser builds can ship a vendored bundle
// without relying on bare npm resolvers at runtime.
export type XtermTerminalCtor = new (options?: Record<string, unknown>) => XtermTerminalLike;

export interface XtermTerminalLike {
  cols: number;
  rows: number;
  buffer: {
    active: XtermBufferLike;
    normal: XtermBufferLike;
    alternate: XtermBufferLike;
  };
  modes: {
    applicationCursorKeysMode: boolean;
    applicationKeypadMode: boolean;
    bracketedPasteMode: boolean;
    insertMode: boolean;
    mouseTrackingMode: "none" | "x10" | "vt200" | "drag" | "any";
    originMode: boolean;
    reverseWraparoundMode: boolean;
    sendFocusMode: boolean;
    showCursor: boolean;
    synchronizedOutputMode: boolean;
    win32InputMode: boolean;
    wraparoundMode: boolean;
  };
  options: Record<string, unknown>;
  write(data: string | Uint8Array, callback?: () => void): void;
  resize(cols: number, rows: number): void;
  reset(): void;
  clear(): void;
  dispose(): void;
  onBell(listener: () => void): { dispose(): void };
  onTitleChange(listener: (title: string) => void): { dispose(): void };
  onData(listener: (data: string) => void): { dispose(): void };
  onWriteParsed(listener: () => void): { dispose(): void };
  onScroll?(listener: (ydisp: number) => void): { dispose(): void };
  onRender?(listener: (e: { start: number; end: number }) => void): { dispose(): void };
  scrollLines?(amount: number): void;
  scrollPages?(pageCount: number): void;
  scrollToTop?(): void;
  scrollToBottom?(): void;
  scrollToLine?(line: number): void; 
  /** Internal core — used for writeSync + osc links when available. */
  _core?: {
    _writeBuffer?: {
      writeSync?(data: string | Uint8Array): void;
      write?(data: string | Uint8Array, cb?: () => void): void;
    };
    _oscLinkService?: {
      getLinkData?(id: number): { uri?: string; id?: string } | undefined;
    };
    coreService?: {
      isCursorHidden?: boolean;
      decPrivateModes?: Record<string, unknown>;
    };
    optionsService?: { options?: Record<string, unknown> };
    mouseStateService?: {
      activeProtocol?: string;
      activeEncoding?: string;
    };
    bufferService?: {
      buffer?: {
        ybase: number;
        ydisp: number;
        y: number;
        x: number;
        lines: { length: number; get(y: number): unknown };
      };
    };
  };
}

export interface XtermBufferLike {
  type: "normal" | "alternate";
  cursorX: number;
  cursorY: number;
  viewportY: number;
  baseY: number;
  length: number;
  getLine(y: number): XtermBufferLineLike | undefined;
  getNullCell(): XtermBufferCellLike;
}

export interface XtermBufferLineLike {
  length: number;
  isWrapped: boolean;
  getCell(x: number, cell?: XtermBufferCellLike): XtermBufferCellLike | undefined;
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
}

export interface XtermBufferCellLike {
  getWidth(): number;
  getChars(): string;
  getCode(): number;
  getFgColorMode(): number;
  getBgColorMode(): number;
  getFgColor(): number;
  getBgColor(): number;
  isBold(): number;
  isItalic(): number;
  isDim(): number;
  isUnderline(): number;
  isBlink(): number;
  isInverse(): number;
  isInvisible(): number;
  isStrikethrough(): number;
  isOverline(): number;
  isFgRGB(): boolean;
  isBgRGB(): boolean;
  isFgPalette(): boolean;
  isBgPalette(): boolean;
  isFgDefault(): boolean;
  isBgDefault(): boolean;
  getUnderlineStyle?(): number;
  /** Extended attrs may expose url id via internal fields when proposed API on. */
  extended?: { urlId?: number };
}

/** WTerm DOM DEFAULT_COLOR sentinel (palette index meaning "use CSS default"). */
const WTERM_DEFAULT_COLOR = 256;

const FLAG_BOLD = 0x01;
const FLAG_DIM = 0x02;
const FLAG_ITALIC = 0x04;
const FLAG_UNDERLINE = 0x08;
const FLAG_REVERSE = 0x20;
const FLAG_INVISIBLE = 0x40;
const FLAG_STRIKETHROUGH = 0x80;

/** xterm Attributes.CM_* (from AttributeData / Constants). */
const CM_DEFAULT = 0;
const CM_P16 = 0x1000000;
const CM_P256 = 0x2000000;
const CM_RGB = 0x3000000;
const CM_MASK = 0x3000000;

export interface XtermBridgeOptions {
  /** Prebuilt Terminal instance. When set, cols/rows/scrollback are ignored. */
  terminal?: XtermTerminalLike;
  /** Terminal constructor (browser bundle or @xterm/headless). */
  Terminal?: XtermTerminalCtor;
  cols?: number;
  rows?: number;
  scrollback?: number;
  convertEol?: boolean;
  allowProposedApi?: boolean;
}

let _defaultTerminalCtor: XtermTerminalCtor | null = null;

/** Register the default Terminal class used when options.Terminal is omitted. */
export function setDefaultXtermTerminalCtor(ctor: XtermTerminalCtor): void {
  _defaultTerminalCtor = ctor;
}

export function getDefaultXtermTerminalCtor(): XtermTerminalCtor | null {
  return _defaultTerminalCtor;
}

function resolveTerminalCtor(options: XtermBridgeOptions): XtermTerminalCtor {
  if (options.Terminal) return options.Terminal;
  if (_defaultTerminalCtor) return _defaultTerminalCtor;
  throw new Error(
    "XtermBridge: no Terminal constructor. Pass options.Terminal or call setDefaultXtermTerminalCtor().",
  );
}

function createTerminal(options: XtermBridgeOptions): XtermTerminalLike {
  if (options.terminal) return options.terminal;
  const Ctor = resolveTerminalCtor(options);
  return new Ctor({
    cols: options.cols ?? 80,
    rows: options.rows ?? 24,
    scrollback: options.scrollback ?? 5000,
    convertEol: options.convertEol ?? false,
    allowProposedApi: options.allowProposedApi !== false,
    // Headless: no DOM; cursor blink is purely a mode flag for our overlay.
    cursorBlink: false,
    logLevel: "off",
  });
}

function mapColorMode(mode: number): "default" | "palette" | "rgb" {
  const m = mode & CM_MASK;
  if (m === CM_RGB) return "rgb";
  if (m === CM_P16 || m === CM_P256) return "palette";
  return "default";
}

/**
 * Convert an xterm cell into the WTerm CellData shape expected by the DOM renderer.
 * Reuses `out` when provided to avoid alloc churn in hot render loops.
 */
export function cellFromXterm(
  cell: XtermBufferCellLike | undefined | null,
  out?: CellData,
): CellData {
  const result: CellData = out ?? {
    char: 0,
    fg: WTERM_DEFAULT_COLOR,
    bg: WTERM_DEFAULT_COLOR,
    flags: 0,
  };

  if (!cell) {
    result.char = 0;
    result.fg = WTERM_DEFAULT_COLOR;
    result.bg = WTERM_DEFAULT_COLOR;
    result.flags = 0;
    result.fgRgb = undefined;
    result.bgRgb = undefined;
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
    // Combined / emoji / grapheme cluster — store first codepoint and let
    // getGrapheme() reconstruct the full string via a side table keyed by
    // a high-bit id (same convention as WasmBridge).
    const cp = chars.codePointAt(0) ?? 0;
    // Prefer packing small BMP; for multi-codepoint stash under grapheme table.
    if ([...chars].length > 1 || chars.length > 2) {
      // Will be assigned by caller via registerGrapheme when needed.
      result.char = cp;
      (result as CellData & { _grapheme?: string })._grapheme = chars;
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

  // Foreground
  result.fgRgb = undefined;
  if (cell.isFgDefault()) {
    result.fg = WTERM_DEFAULT_COLOR;
  } else if (cell.isFgRGB()) {
    result.fg = WTERM_DEFAULT_COLOR;
    result.fgRgb = cell.getFgColor() & 0xffffff;
  } else {
    // Palette 0–255
    result.fg = cell.getFgColor() & 0xff;
  }

  // Background
  result.bgRgb = undefined;
  if (cell.isBgDefault()) {
    result.bg = WTERM_DEFAULT_COLOR;
  } else if (cell.isBgRGB()) {
    result.bg = WTERM_DEFAULT_COLOR;
    result.bgRgb = cell.getBgColor() & 0xffffff;
  } else {
    result.bg = cell.getBgColor() & 0xff;
  }

  const width = cell.getWidth();
  // WTerm: 0 narrow, 1 wide lead, 2 continuation
  if (width === 2) result.wide = 1;
  else if (width === 0) result.wide = 2;
  else result.wide = 0;

  // OSC 8 link id — xterm stores on extended.urlId when available
  const urlId =
    (cell as XtermBufferCellLike & { getChars?: unknown }).extended?.urlId ??
    // Some builds expose via private attr; best-effort.
    0;
  result.linkId = urlId || 0;

  return result;
}

export class XtermBridge implements TerminalCore {
  readonly kind = "xterm" as const;
  /** Signal to the DOM renderer: paint viewport only; do not expand scrollback rows. */
  readonly virtualViewport = true as const;
 
  private _term: XtermTerminalLike;
  private _cols = 80;
  private _rows = 24;
  private _dirty: Uint8Array = new Uint8Array(256);
  private _allDirty = true;
  /** Net ydisp delta since last paint; renderer recycles only incoming rows. */
  private _pendingScrollDelta = 0;
  /** Suppress generic onScroll dirtying for bridge-owned scroll methods. */
  private _scrollSuppressDirty = false;
  private _bellPending = false;
  private _title: string | null = null;
  private _titleChanged = false;
  private _responseQueue: string[] = [];
  private _disposables: Array<{ dispose(): void }> = [];
  private _cellScratch: CellData = { char: 0, fg: 256, bg: 256, flags: 0 };
  private _nullCell: XtermBufferCellLike | null = null;
  private _graphemeTable = new Map<number, string>();
  private _graphemeNextId = 1;
  private _cursorStyle = 0; // DECSCUSR; xterm headless does not expose full style — default block
  private _ownsTerminal: boolean;

  constructor(options: XtermBridgeOptions = {}) {
    this._ownsTerminal = !options.terminal;
    this._term = createTerminal(options);
    this._cols = this._term.cols;
    this._rows = this._term.rows;
    this._bindEvents();
    this.markAllDirty();
  }

  /** Underlying xterm Terminal (for advanced host use / debugging). */
  get terminal(): XtermTerminalLike {
    return this._term;
  }

  static async load(options: XtermBridgeOptions = {}): Promise<XtermBridge> {
    // If no ctor yet, try dynamic import of @xterm/headless (Node / bundler).
    if (!options.Terminal && !options.terminal && !_defaultTerminalCtor) {
      try {
        const mod: any = await import("@xterm/headless");
        const Ctor = mod.Terminal || mod.default?.Terminal || mod.default;
        if (typeof Ctor === "function") setDefaultXtermTerminalCtor(Ctor);
      } catch {
        // Browser path must call setDefaultXtermTerminalCtor from the vendored bundle.
      }
    }
    return new XtermBridge(options);
  }

  private _bindEvents(): void {
    this._disposables.push(
      this._term.onBell(() => {
        this._bellPending = true;
      }),
    );
    this._disposables.push(
      this._term.onTitleChange((title) => {
        this._title = title;
        this._titleChanged = true;
      }),
    );
    // CSI responses / focus / DA etc. arrive as onData from the core.
    this._disposables.push(
      this._term.onData((data) => {
        if (data) this._responseQueue.push(data);
      }),
    );
    this._disposables.push(
      this._term.onWriteParsed(() => {
        // Any parse that mutates the buffer invalidates the viewport.
        // Stick-to-bottom is entirely xterm's (ydisp tracks ybase when at bottom).
        this.markAllDirty();
      }),
    );
    if (typeof this._term.onScroll === "function") {
      this._disposables.push(
        this._term.onScroll(() => {
          // scrollLines/scrollTo* record a recycle delta themselves. Unknown
          // external scroll sources still fall back to a full dirty viewport.
          if (this._scrollSuppressDirty) return;
          this.markAllDirty();
        }),
      );
    }
    if (typeof this._term.onRender === "function") {
      this._disposables.push(
        this._term.onRender(({ start, end }) => {
          const lo = Math.max(0, start | 0);
          const hi = Math.min(this._rows - 1, end | 0);
          for (let r = lo; r <= hi; r++) this._dirty[r] = 1;
        }),
      );
    }
  }
 
  // -- Lifecycle -----------------------------------------------------------

  init(cols: number, rows: number): void {
    this.resize(cols, rows);
    this.markAllDirty();
  }

  resize(cols: number, rows: number): void {
    const c = Math.max(1, Math.floor(cols) || 1);
    const r = Math.max(1, Math.floor(rows) || 1);
    if (c === this._cols && r === this._rows && c === this._term.cols && r === this._term.rows) {
      return;
    }
    // Drain pending writes so reflow sees a consistent buffer (xterm WriteBuffer).
    this._flushWriteBuffer();
    this._term.resize(c, r);
    this._cols = this._term.cols;
    this._rows = this._term.rows;
    if (this._dirty.length < this._rows) {
      this._dirty = new Uint8Array(Math.max(256, this._rows));
    }
    this.markAllDirty();
  }

  dispose(): void {
    for (const d of this._disposables) {
      try {
        d.dispose();
      } catch {
        /* ignore */
      }
    }
    this._disposables = [];
    if (this._ownsTerminal) {
      try {
        this._term.dispose();
      } catch {
        /* ignore */
      }
    }
  }

  // -- I/O -----------------------------------------------------------------

  writeString(str: string): void {
    if (!str) return;
    this._write(str);
  }

  writeRaw(data: Uint8Array): void {
    if (!data || data.length === 0) return;
    this._write(data);
  }

  private _write(data: string | Uint8Array): void {
    const wb = this._term._core?._writeBuffer;
    if (wb && typeof wb.writeSync === "function") {
      try {
        wb.writeSync(data);
        this.markAllDirty();
        return;
      } catch {
        // fall through to async write
      }
    }
    this._term.write(data);
    this.markAllDirty();
  }

  private _flushWriteBuffer(): void {
    const wb = this._term._core?._writeBuffer;
    // Older builds expose writeSync only; calling writeSync('') is a no-op drain
    // if the buffer is empty. Prefer walking pending via writeSync of empty?
    // writeSync with empty still processes queue in some versions — skip if none.
    if (!wb) return;
    // No public flushSync in published 6.0.0; writeSync processes immediately
    // when called. Pending async chunks from prior write() need a tick — host
    // should prefer writeString which uses writeSync.
  }

  // -- Grid ----------------------------------------------------------------

  private _active(): XtermBufferLike {
    return this._term.buffer.active;
  }

  private _ensureNullCell(): XtermBufferCellLike {
    if (!this._nullCell) this._nullCell = this._active().getNullCell();
    return this._nullCell;
  }

  /**
   * Absolute buffer line for a *viewport-relative* row.
   * xterm owns ydisp: row 0 is always buffer.viewportY (ydisp), not baseY.
   * Scrolling history = change ydisp; DOM only paints the current viewport.
   */
  private _viewportLineIndex(row: number): number {
    const buf = this._active();
    return (buf.viewportY | 0) + (row | 0);
  }

  /** ydisp === ybase (xterm stick-bottom truth). */
  isAtBottom(): boolean {
    const buf = this._active();
    return (buf.viewportY | 0) >= (buf.baseY | 0);
  }

  getViewportY(): number {
    return this._active().viewportY | 0;
  }

  getBaseY(): number {
    return this._active().baseY | 0;
  }

  /** Record ydisp movement for row-recycle paint. */
  private _noteViewportScroll(delta: number): void {
    const d = Math.trunc(Number(delta) || 0);
    if (!d) return;
    // onScroll/onRender can synchronously mark the viewport dirty before a
    // bridge-owned scroll method regains control. This method is the final
    // authority: clear that stale full-dirty state and mark only incoming rows.
    this._dirty.fill(0);
    this._allDirty = false;
    const rows = this._rows | 0;
    this._pendingScrollDelta = (this._pendingScrollDelta | 0) + d;
    if (Math.abs(this._pendingScrollDelta) >= Math.max(1, rows)) {
      this.markAllDirty();
      return;
    }
    this._allDirty = false;
    if (d > 0) {
      const start = Math.max(0, rows - Math.abs(this._pendingScrollDelta));
      for (let r = start; r < rows; r++) this._dirty[r] = 1;
    } else {
      const end = Math.min(rows, Math.abs(this._pendingScrollDelta));
      for (let r = 0; r < end; r++) this._dirty[r] = 1;
    }
  }

  consumeViewportScrollDelta(): number {
    const d = this._pendingScrollDelta | 0;
    this._pendingScrollDelta = 0;
    return d;
  }

  /** Drive xterm buffer scroll. amount is in rows (negative = up into history). */
  scrollLines(amount: number): void {
    const n = Math.trunc(Number(amount) || 0);
    if (!n) return;
    const before = this.getViewportY();
    this._scrollSuppressDirty = true;
    try {
      if (typeof this._term.scrollLines === "function") this._term.scrollLines(n);
    } finally {
      this._scrollSuppressDirty = false;
    }
    const after = this.getViewportY();
    if (after !== before) {
      // Drop stale write dirty flags before declaring only the recycled edge.
      // Otherwise one old full-dirty frame rebuilds rows after DOM recycle and
      // can make scrollToBottom appear not to restore the live viewport.
      this._dirty.fill(0);
      this._allDirty = false;
      this._noteViewportScroll(after - before);
    }
  }

  scrollToBottom(): void {
    if (this.isAtBottom()) return;
    const before = this.getViewportY();
    this._scrollSuppressDirty = true;
    try {
      if (typeof this._term.scrollToBottom === "function") {
        this._term.scrollToBottom();
      } else {
        const buf = this._active();
        const delta = (buf.baseY | 0) - (buf.viewportY | 0);
        if (delta && typeof this._term.scrollLines === "function") this._term.scrollLines(delta);
      }
    } finally {
      this._scrollSuppressDirty = false;
    }
    const after = this.getViewportY();
    if (after !== before) {
      if (Math.abs(after - before) >= (this._rows | 0)) this.markAllDirty();
      else {
        this._dirty.fill(0);
        this._allDirty = false;
        this._noteViewportScroll(after - before);
      }
    }
  }

  scrollToTop(): void {
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
      else {
        this._dirty.fill(0);
        this._allDirty = false;
        this._noteViewportScroll(after - before);
      }
    }
  }

  /** Absolute buffer line index → ydisp. */
  scrollToLine(line: number): void {
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
      else {
        this._dirty.fill(0);
        this._allDirty = false;
        this._noteViewportScroll(after - before);
      }
    }
  }
 
  getCell(row: number, col: number): CellData {
    const buf = this._active();
    const lineIdx = this._viewportLineIndex(row);
    const line = buf.getLine(lineIdx);
    const scratch = this._ensureNullCell();
    const cell = line?.getCell(col, scratch) ?? null;
    const out = cellFromXterm(cell, this._cellScratch);
    // Multi-codepoint grapheme registration
    const g = (out as CellData & { _grapheme?: string })._grapheme;
    if (g) {
      out.char = this._registerGrapheme(g);
      delete (out as CellData & { _grapheme?: string })._grapheme;
    }
    // Pull url id from xterm extended attrs when present on the real cell.
    // getCell may return the same scratch; read from line again if needed.
    if (line) {
      try {
        const raw: any = line.getCell(col);
        const urlId = raw?.extended?.urlId | 0;
        if (urlId) out.linkId = urlId;
      } catch {
        /* ignore */
      }
    }
    return { ...out };
  }

  getHyperlink(id: number): string | null {
    if (!id) return null;
    try {
      const data = this._term._core?._oscLinkService?.getLinkData?.(id);
      return data?.uri || null;
    } catch {
      return null;
    }
  }

  getGrapheme(char: number): string | null {
    if ((char & 0x80000000) === 0) return null;
    const id = (char & 0x7fffffff) >>> 0;
    return this._graphemeTable.get(id) ?? null;
  }

  private _registerGrapheme(text: string): number {
    // Linear scan is fine for the tiny table of live clusters.
    for (const [id, v] of this._graphemeTable) {
      if (v === text) return (0x80000000 | id) >>> 0;
    }
    const id = this._graphemeNextId++;
    if (this._graphemeNextId > 0x7ffffff0) {
      this._graphemeTable.clear();
      this._graphemeNextId = 1;
    }
    this._graphemeTable.set(id, text);
    return (0x80000000 | id) >>> 0;
  }

  isDirtyRow(row: number): boolean {
    if (this._allDirty) return true;
    if (row < 0 || row >= this._rows) return false;
    return this._dirty[row] !== 0;
  }

  clearDirty(): void {
    this._dirty.fill(0);
    this._allDirty = false;
    this._pendingScrollDelta = 0;
  }

  markAllDirty(): void {
    this._allDirty = true;
    this._dirty.fill(1);
    this._pendingScrollDelta = 0;
  }

  getCols(): number {
    return this._term.cols || this._cols;
  }

  getRows(): number {
    return this._term.rows || this._rows;
  }

  // -- Cursor --------------------------------------------------------------

  getCursor(): CursorState {
    const buf = this._active();
    const hidden = !!this._term._core?.coreService?.isCursorHidden;
    const show = this._term.modes?.showCursor !== false;
    // buffer.cursorY is relative to the live base (ybase), not the currently
    // viewed history window (ydisp). When ydisp < ybase the real cursor is
    // below the viewport and must not be painted over an unrelated old row.
    const viewportRow = (buf.baseY | 0) + (buf.cursorY | 0) - (buf.viewportY | 0);
    return {
      row: viewportRow,
      col: buf.cursorX,
      visible: show && !hidden && viewportRow >= 0 && viewportRow < this._rows,
      style: this._cursorStyle,
    };
  }

  cursorStyle(): number {
    return this._cursorStyle;
  }

  // -- Modes ---------------------------------------------------------------

  cursorKeysApp(): boolean {
    return !!this._term.modes?.applicationCursorKeysMode;
  }

  bracketedPaste(): boolean {
    return !!this._term.modes?.bracketedPasteMode;
  }

  mouseMode(): number {
    // WTerm convention: 0=off, 1=x10/9, 2=vt200/1000, 3=button-event/1002, 4=any/1003
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

  mouseSGR(): boolean {
    // xterm mouseStateService.activeEncoding === 'SGR'
    try {
      return this._term._core?.mouseStateService?.activeEncoding === "SGR";
    } catch {
      return false;
    }
  }

  mouseAltScroll(): boolean {
    // Not directly exposed on public modes; read decPrivate modes best-effort.
    try {
      return !!(this._term._core?.coreService?.decPrivateModes as any)?.mouseWheelToArrowKeys;
    } catch {
      return false;
    }
  }

  reverseWrap(): boolean {
    return !!this._term.modes?.reverseWraparoundMode;
  }

  column132(): boolean {
    // DECCOLM — not always on public modes; treat cols>=132 as weak signal only.
    return false;
  }

  bellPending(): boolean {
    return this._bellPending;
  }

  clearBell(): void {
    this._bellPending = false;
  }

  syncOutput(): boolean {
    return !!this._term.modes?.synchronizedOutputMode;
  }

  focusReporting(): boolean {
    return !!this._term.modes?.sendFocusMode;
  }

  reverseScreen(): boolean {
    try {
      return !!(this._term._core?.coreService?.decPrivateModes as any)?.reverseVideo;
    } catch {
      return false;
    }
  }

  kittyKeyboardFlags(): number {
    // Full Kitty keyboard lives in xterm's KittyKeyboard service; not on modes.
    // Return 0 until we wire a deeper probe — InputHandler falls back to classic.
    try {
      const kk = (this._term._core as any)?.coreService?.kittyKeyboardService
        ?? (this._term._core as any)?._kittyKeyboardService;
      if (kk && typeof kk.flags === "number") return kk.flags;
      if (kk && typeof kk.getFlags === "function") return kk.getFlags() | 0;
    } catch {
      /* ignore */
    }
    return 0;
  }

  keypadApp(): boolean {
    return !!this._term.modes?.applicationKeypadMode;
  }

  insertMode(): boolean {
    return !!this._term.modes?.insertMode;
  }

  usingAltScreen(): boolean {
    return this._active().type === "alternate";
  }

  // -- Side outputs --------------------------------------------------------

  getTitle(): string | null {
    if (!this._titleChanged) return null;
    this._titleChanged = false;
    return this._title;
  }

  getResponse(): string | null {
    if (!this._responseQueue.length) return null;
    // Concatenate burst of responses into one onData tick (matches WasmBridge single pull).
    return this._responseQueue.splice(0, this._responseQueue.length).join("");
  }

  // -- Scrollback ----------------------------------------------------------
  //
  // With xterm-owned viewport, the DOM paints ONLY the current ydisp window
  // (getCell rows). Scrollback rows are NOT expanded into the DOM — that was
  // the old WTerm/WASM model. getScrollback* stay available for host tools
  // (AI snapshot, history export) but the renderer must not call them for paint.

  getScrollbackCount(): number {
    const buf = this._active();
    if (buf.type === "alternate") return 0;
    return Math.max(0, buf.baseY | 0);
  }

  getScrollbackCell(offset: number, col: number): CellData {
    const buf = this._active();
    const count = Math.max(0, buf.baseY | 0);
    // offset 0 → line baseY-1 (newest above bottom page); offset count-1 → line 0
    const lineIdx = count - 1 - (offset | 0);
    if (lineIdx < 0 || lineIdx >= buf.length) {
      return { char: 0, fg: WTERM_DEFAULT_COLOR, bg: WTERM_DEFAULT_COLOR, flags: 0, wide: 0, linkId: 0 };
    }
    const line = buf.getLine(lineIdx);
    const scratch = this._ensureNullCell();
    const cell = line?.getCell(col, scratch) ?? null;
    const out = cellFromXterm(cell, this._cellScratch);
    const g = (out as CellData & { _grapheme?: string })._grapheme;
    if (g) {
      out.char = this._registerGrapheme(g);
      delete (out as CellData & { _grapheme?: string })._grapheme;
    }
    return { ...out };
  }

  getScrollbackLineLen(offset: number): number {
    return this.getCols();
  }
 
  // -- Optional extras (renderer / host) -----------------------------------

  getImages(): Array<unknown> {
    // xterm image protocol is an addon; empty until ImageAddon is wired.
    return [];
  }

  takeClipboardRequest(): { selection: string; base64: string; query: boolean } | null {
    // OSC 52 is handled inside xterm when clipboard addon is loaded; without
    // it we have nothing to surface. Return null so WTerm onClipboard stays quiet.
    return null;
  }

  takeColorChanges(): Array<{ kind: number; index: number; value: string }> {
    return [];
  }

  takeColorQueries(): Array<{ kind: number; index: number }> {
    return [];
  }

  // -- Debug ---------------------------------------------------------------

  getUnhandledSequences(): UnhandledSequence[] {
    return [];
  }

  /** Host helper: force full redraw after theme / font changes. */
  invalidate(): void {
    this.markAllDirty();
  }
}
