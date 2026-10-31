var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
const WTERM_DEFAULT_COLOR = 256;
const FLAG_BOLD = 1;
const FLAG_DIM = 2;
const FLAG_ITALIC = 4;
const FLAG_UNDERLINE = 8;
const FLAG_BLINK = 16;
const FLAG_REVERSE = 32;
const FLAG_INVISIBLE = 64;
const FLAG_STRIKETHROUGH = 128;
const FLAG_OVERLINE = 256;
const FLAG_UNDERLINE_DOUBLE = 512;
const FLAG_UNDERLINE_CURLY = 1024;
const FLAG_UNDERLINE_DOTTED = 2048;
const FLAG_UNDERLINE_DASHED = 4096;
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
  if (cell.isBlink?.()) flags |= FLAG_BLINK;
  if (cell.isOverline?.()) flags |= FLAG_OVERLINE;
  if (cell.isUnderline()) {
    flags |= FLAG_UNDERLINE;
    const ulStyle = typeof cell.getUnderlineStyle === "function" ? cell.getUnderlineStyle() : 1;
    if (ulStyle === 2) flags |= FLAG_UNDERLINE_DOUBLE;
    else if (ulStyle === 3) flags |= FLAG_UNDERLINE_CURLY;
    else if (ulStyle === 4) flags |= FLAG_UNDERLINE_DOTTED;
    else if (ulStyle === 5) flags |= FLAG_UNDERLINE_DASHED;
  }
  if (cell.isInverse()) flags |= FLAG_REVERSE;
  if (cell.isInvisible()) flags |= FLAG_INVISIBLE;
  if (cell.isStrikethrough()) flags |= FLAG_STRIKETHROUGH;
  result.flags = flags;
  result.ul = WTERM_DEFAULT_COLOR;
  result.ulRgb = void 0;
  if ((flags & FLAG_UNDERLINE) && typeof cell.isUnderlineColorDefault === "function" && !cell.isUnderlineColorDefault()) {
    if (cell.isUnderlineColorRGB?.()) {
      result.ulRgb = cell.getUnderlineColor() & 16777215;
    } else if (cell.isUnderlineColorPalette?.()) {
      result.ul = cell.getUnderlineColor() & 255;
    }
  }
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

function _parseSixelToImageData(raw) {
  const qIdx = raw.indexOf("q");
  if (qIdx < 0) return null;
  const body = raw.slice(qIdx + 1);
  const palette = new Map([
    [0, [0, 0, 0, 255]],
    [1, [51, 102, 179, 255]],
    [2, [204, 51, 51, 255]],
    [3, [51, 179, 51, 255]],
    [4, [179, 51, 179, 255]],
    [5, [51, 179, 179, 255]],
    [6, [179, 179, 51, 255]],
    [7, [179, 179, 179, 255]]
  ]);
  let currentColor = 1;
  let x = 0, y = 0, maxW = 0, maxH = 0;
  const ops = [];
  let i = 0;
  const n = body.length;
  while (i < n) {
    const ch = body[i];
    if (ch === '"') {
      i++;
      const nums = [];
      let cur = "";
      while (i < n && /[0-9;]/.test(body[i])) {
        if (body[i] === ";") { nums.push(Number(cur) || 0); cur = ""; }
        else cur += body[i];
        i++;
      }
      if (cur) nums.push(Number(cur) || 0);
      if (nums.length >= 4) {
        maxW = Math.max(maxW, nums[2] | 0);
        maxH = Math.max(maxH, nums[3] | 0);
      }
      continue;
    }
    if (ch === "#") {
      i++;
      const nums = [];
      let cur = "";
      while (i < n && /[0-9;]/.test(body[i])) {
        if (body[i] === ";") { nums.push(Number(cur) || 0); cur = ""; }
        else cur += body[i];
        i++;
      }
      if (cur) nums.push(Number(cur) || 0);
      const pc = nums[0] ?? 0;
      if (nums.length >= 5 && nums[1] === 2) {
        const r = Math.round(Math.min(100, Math.max(0, nums[2])) * 2.55);
        const g = Math.round(Math.min(100, Math.max(0, nums[3])) * 2.55);
        const b = Math.round(Math.min(100, Math.max(0, nums[4])) * 2.55);
        palette.set(pc, [r, g, b, 255]);
      }
      currentColor = pc;
      continue;
    }
    if (ch === "!") {
      i++;
      let countStr = "";
      while (i < n && /[0-9]/.test(body[i])) { countStr += body[i]; i++; }
      const repeat = Math.max(1, Math.min(4096, Number(countStr) || 1));
      if (i < n) {
        const code = body.charCodeAt(i) - 63;
        if (code >= 0 && code <= 63) {
          ops.push({ x, y, repeat, bits: code, color: currentColor });
          x += repeat;
          if (x > maxW) maxW = x;
          if (y + 6 > maxH) maxH = y + 6;
        }
        i++;
      }
      continue;
    }
    if (ch === "$") { x = 0; i++; continue; }
    if (ch === "-") { x = 0; y += 6; i++; continue; }
    const code = body.charCodeAt(i) - 63;
    if (code >= 0 && code <= 63) {
      ops.push({ x, y, repeat: 1, bits: code, color: currentColor });
      x += 1;
      if (x > maxW) maxW = x;
      if (y + 6 > maxH) maxH = y + 6;
    }
    i++;
  }
  const width = Math.min(2048, Math.max(1, maxW));
  const height = Math.min(2048, Math.max(1, maxH));
  if (!ops.length) return null;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (const op of ops) {
    const rgba = palette.get(op.color) || [255, 255, 255, 255];
    for (let bit = 0; bit < 6; bit++) {
      if ((op.bits & (1 << bit)) === 0) continue;
      const py = op.y + bit;
      if (py >= height) continue;
      for (let rx = 0; rx < op.repeat; rx++) {
        const px = op.x + rx;
        if (px >= width) break;
        const off = (py * width + px) * 4;
        pixels[off] = rgba[0];
        pixels[off + 1] = rgba[1];
        pixels[off + 2] = rgba[2];
        pixels[off + 3] = rgba[3];
      }
    }
  }
  return { width, height, pixels };
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
    /** Net ydisp delta since last paint; renderer recycles only incoming rows. */
    __publicField(this, "_pendingScrollDelta", 0);
    /** Suppress generic onScroll dirtying for bridge-owned scroll methods. */
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
        this._images = [];
    this._nextImageId = 1;
    this._kittyChunks = new Map();
    this._clipboardQueue = [];
    this._colorChangeQueue = [];
    this._colorQueryQueue = [];
    this._cwd = "";
    this._semanticBlocks = [];
    this._syncOutputActive = false;
    this._syncOutputTimer = null;
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
    
    const parser = this._term.parser;
    if (parser && typeof parser.registerOscHandler === "function") {
      // OSC 52: Write-Only Clipboard Lock (drop '?' queries, cap at 1MB)
      this._disposables.push(parser.registerOscHandler(52, (data) => {
        const semi = data.indexOf(";");
        if (semi < 0) return true;
        const b64 = data.slice(semi + 1).trim();
        if (!b64 || b64 === "?") return true; // Hard block remote clipboard read
        if (b64.length > 1400000) return true;
        try {
          const bin = atob(b64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
          this._clipboardQueue.push(text);
        } catch {}
        return true;
      }));
      // OSC 7: Working directory tracking (file://host/path)
      this._disposables.push(parser.registerOscHandler(7, (data) => {
        let p = String(data || "").trim();
        if (p.startsWith("file://")) {
          const slashIdx = p.indexOf("/", 7);
          p = slashIdx >= 0 ? p.slice(slashIdx) : "/";
        }
        try { p = decodeURIComponent(p); } catch {}
        if (p.startsWith("/")) {
          this._cwd = p;
          if (typeof this.onCwdChange === "function") {
            try { this.onCwdChange(p); } catch {}
          }
        }
        return true;
      }));
      // OSC 133: FinalTerm / Shell Integration semantic prompt marks (A/B/C/D;exitCode)
      this._disposables.push(parser.registerOscHandler(133, (data) => {
        const parts = String(data || "").split(";");
        const mark = (parts[0] || "").trim().toUpperCase();
        if (!["A", "B", "C", "D"].includes(mark)) return true;
        const buf = this._active();
        const absRow = (buf.baseY | 0) + (buf.cursorY | 0);
        const exitCode = mark === "D" ? (Number(parts[1]) || 0) : 0;
        this._semanticBlocks.push({ mark, absRow, exitCode, ts: Date.now() });
        if (this._semanticBlocks.length > 200) this._semanticBlocks.shift();
        if (typeof this.onSemanticMark === "function") {
          try { this.onSemanticMark({ mark, absRow, exitCode }); } catch {}
        }
        return true;
      }));
      // OSC 4 / 10 / 11 / 12 / 104 / 110 / 111 / 112: Dynamic palette & queries
      for (const oscCode of [4, 10, 11, 12, 104, 110, 111, 112]) {
        this._disposables.push(parser.registerOscHandler(oscCode, (data) => {
          const raw = String(data || "").trim();
          if (oscCode === 4 || oscCode === 104) {
            const parts = raw.split(";");
            const idx = parts[0] !== undefined && parts[0] !== "" ? Number(parts[0]) : 65535;
            const val = parts[1] || "";
            if (val === "?") this._colorQueryQueue.push({ kind: 4, index: idx });
            else if (oscCode === 104) this._colorChangeQueue.push({ kind: 104, index: idx, value: "" });
            else if (val) this._colorChangeQueue.push({ kind: 4, index: idx, value: val });
          } else {
            if (raw === "?") this._colorQueryQueue.push({ kind: oscCode, index: 0 });
            else this._colorChangeQueue.push({ kind: oscCode, index: 0, value: raw });
          }
          return true;
        }));
      }
      // OSC 1337: iTerm2 Inline Images (File=[args]:base64)
      this._disposables.push(parser.registerOscHandler(1337, (data) => {
        const str = String(data || "");
        if (!str.startsWith("File=")) return false;
        const colonIdx = str.indexOf(":");
        if (colonIdx < 0) return true;
        const metaStr = str.slice(5, colonIdx);
        const b64 = str.slice(colonIdx + 1).replace(/\s+/g, "");
        if (!b64) return true;
        const meta = {};
        for (const kv of metaStr.split(";")) {
          const eq = kv.indexOf("=");
          if (eq > 0) meta[kv.slice(0, eq).trim()] = kv.slice(eq + 1).trim();
        }
        if (meta.inline === "0") return true;
        this._addEncodedImage("data:image/png;base64," + b64, meta);
        return true;
      }));
    }
    if (parser && typeof parser.registerDcsHandler === "function") {
      // DCS q: Sixel Graphics
      this._disposables.push(parser.registerDcsHandler({ final: "q" }, (data, params) => {
        const decoded = _parseSixelToImageData("q" + String(data || ""));
        if (decoded) {
          const buf = this._active();
          this._images.push({
            id: this._nextImageId++,
            x: buf.cursorX | 0,
            absRow: (buf.baseY | 0) + (buf.cursorY | 0),
            width: decoded.width,
            height: decoded.height,
            pixels: decoded.pixels
          });
          this.markAllDirty();
        }
        return true;
      }));
    }
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
        this.markAllDirty();
      })
    );
    if (typeof this._term.onScroll === "function") {
      this._disposables.push(
        this._term.onScroll(() => {
          if (this._scrollSuppressDirty) return;
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
  _addEncodedImage(dataUrl, meta = {}) {
    const buf = this._active();
    const id = Number(meta.id) || this._nextImageId++;
    const entry = {
      id,
      x: buf.cursorX | 0,
      absRow: (buf.baseY | 0) + (buf.cursorY | 0),
      width: Number(meta.width) || 160,
      height: Number(meta.height) || 90,
      pixels: null,
      dataUrl
    };
    this._images.push(entry);
    if (typeof Image !== "undefined" && typeof document !== "undefined") {
      const img = new Image();
      img.onload = () => {
        const w = Math.min(2048, Math.max(1, img.naturalWidth || entry.width));
        const h = Math.min(2048, Math.max(1, img.naturalHeight || entry.height));
        entry.width = w;
        entry.height = h;
        try {
          const c = document.createElement("canvas");
          c.width = w;
          c.height = h;
          const ctx = c.getContext("2d");
          ctx.drawImage(img, 0, 0, w, h);
          entry.pixels = ctx.getImageData(0, 0, w, h).data;
        } catch {}
        this.markAllDirty();
      };
      img.src = dataUrl;
    }
    this.markAllDirty();
    return entry;
  }
  _handleKittyApc(body) {
    const semi = body.indexOf(";");
    const ctrlStr = semi >= 0 ? body.slice(0, semi) : body;
    const payload = semi >= 0 ? body.slice(semi + 1).replace(/\s+/g, "") : "";
    const ctrl = {};
    for (const part of ctrlStr.split(",")) {
      const eq = part.indexOf("=");
      if (eq > 0) ctrl[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
    const action = ctrl.a || "T";
    if (action === "d") {
      this._images = [];
      this.markAllDirty();
      return;
    }
    const id = Number(ctrl.i) || this._nextImageId++;
    const more = ctrl.m === "1";
    const prev = this._kittyChunks.get(id) || { ctrl, chunks: [] };
    if (Object.keys(ctrl).length > 1) prev.ctrl = { ...prev.ctrl, ...ctrl };
    if (payload) prev.chunks.push(payload);
    if (more) {
      this._kittyChunks.set(id, prev);
      return;
    }
    this._kittyChunks.delete(id);
    const fullB64 = prev.chunks.join("");
    if (!fullB64) return;
    const fmt = Number(prev.ctrl.f) || 32;
    const w = Number(prev.ctrl.s) || 100;
    const h = Number(prev.ctrl.v) || 100;
    if (fmt === 100) {
      this._addEncodedImage("data:image/png;base64," + fullB64, { id, width: w, height: h });
    } else {
      try {
        const bin = atob(fullB64);
        const pixels = new Uint8ClampedArray(w * h * 4);
        if (fmt === 24) {
          for (let p = 0, j = 0; p < w * h && j + 2 < bin.length; p++, j += 3) {
            pixels[p * 4] = bin.charCodeAt(j);
            pixels[p * 4 + 1] = bin.charCodeAt(j + 1);
            pixels[p * 4 + 2] = bin.charCodeAt(j + 2);
            pixels[p * 4 + 3] = 255;
          }
        } else {
          for (let k = 0; k < Math.min(pixels.length, bin.length); k++) {
            pixels[k] = bin.charCodeAt(k);
          }
        }
        const buf = this._active();
        this._images.push({
          id,
          x: buf.cursorX | 0,
          absRow: (buf.baseY | 0) + (buf.cursorY | 0),
          width: w,
          height: h,
          pixels
        });
        this.markAllDirty();
      } catch {}
    }
    if (prev.ctrl.q !== "2" && prev.ctrl.i) {
      this._responseQueue.push(`\x1b_Gi=${prev.ctrl.i};OK\x1b\\`);
    }
  }
  _preprocessStream(data) {
    let str = typeof data === "string" ? data : (data instanceof Uint8Array ? new TextDecoder("utf-8", { fatal: false }).decode(data) : String(data));
    // DECSET 2026 Synchronized Output
    if (str.includes("\x1b[?2026h")) {
      this._syncOutputActive = true;
      if (this._syncOutputTimer) clearTimeout(this._syncOutputTimer);
      this._syncOutputTimer = setTimeout(() => {
        this._syncOutputActive = false;
        this.markAllDirty();
      }, 100);
    }
    if (str.includes("\x1b[?2026l")) {
      this._syncOutputActive = false;
      if (this._syncOutputTimer) { clearTimeout(this._syncOutputTimer); this._syncOutputTimer = null; }
    }
    // Sniff Kitty Graphics APC G (_G ... \ or )
    if (str.includes("\x1b_G")) {
      str = str.replace(/\x1b_G([\s\S]*?)(?:\x1b\\|\x07)/g, (_m, body) => {
        this._handleKittyApc(body);
        return "";
      });
    }
    // Sniff Sixel DCS (P...q...\) if xterm headless parser didn't consume it
    if (str.includes("\x1bP") && /\x1bP[0-9;]*q/.test(str)) {
      str = str.replace(/\x1bP([0-9;]*q[\s\S]*?)(?:\x1b\\|\x9c)/g, (_m, body) => {
        const decoded = _parseSixelToImageData(body);
        if (decoded) {
          const buf = this._active();
          this._images.push({
            id: this._nextImageId++,
            x: buf.cursorX | 0,
            absRow: (buf.baseY | 0) + (buf.cursorY | 0),
            width: decoded.width,
            height: decoded.height,
            pixels: decoded.pixels
          });
          this.markAllDirty();
        }
        return "";
      });
    }
    return typeof data === "string" ? str : data;
  }
  _write(rawData) {
    const data = this._preprocessStream(rawData);
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
  writeConsumed(data) {
    return new Promise((resolve) => {
      const payload = this._preprocessStream(data);
      this._term.write(payload, () => {
        this.markAllDirty();
        resolve();
      });
    });
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
  /** Record ydisp movement for row-recycle paint. */
  _noteViewportScroll(delta) {
    const d = Math.trunc(Number(delta) || 0);
    if (!d) return;
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
      if (typeof this._term.scrollLines === "function") this._term.scrollLines(n);
    } finally {
      this._scrollSuppressDirty = false;
    }
    const after = this.getViewportY();
    if (after !== before) {
      this._dirty.fill(0);
      this._allDirty = false;
      this._noteViewportScroll(after - before);
    }
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
      else {
        this._dirty.fill(0);
        this._allDirty = false;
        this._noteViewportScroll(after - before);
      }
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
      else {
        this._dirty.fill(0);
        this._allDirty = false;
        this._noteViewportScroll(after - before);
      }
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
    if (line) {
      try {
        const raw = line.getCell(col);
        const urlId = raw?.extended?.urlId | 0;
        if (urlId) out.linkId = urlId;
      } catch {
      }
    }
    return { ...out };
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
    const viewportRow = (buf.baseY | 0) + (buf.cursorY | 0) - (buf.viewportY | 0);
    return {
      row: viewportRow,
      col: buf.cursorX,
      visible: show && !hidden && viewportRow >= 0 && viewportRow < this._rows,
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
    if (!this._images.length) return [];
    const vy = this.getViewportY();
    return this._images.map((img) => ({
      id: img.id,
      x: img.x,
      y: img.absRow - vy,
      width: img.width,
      height: img.height,
      pixels: img.pixels,
      dataUrl: img.dataUrl
    })).filter((img) => img.y >= -20 && img.y <= this._rows + 20);
  }
  getCwd() {
    return this._cwd || "";
  }
  getSemanticBlocks() {
    return this._semanticBlocks;
  }
  isSyncOutputActive() {
    return !!this._syncOutputActive;
  }
  takeClipboardRequest() {
    if (!this._clipboardQueue.length) return null;
    return this._clipboardQueue.shift() || null;
  }
  takeColorChanges() {
    if (!this._colorChangeQueue.length) return [];
    return this._colorChangeQueue.splice(0, this._colorChangeQueue.length);
  }
  takeColorQueries() {
    if (!this._colorQueryQueue.length) return [];
    return this._colorQueryQueue.splice(0, this._colorQueryQueue.length);
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
