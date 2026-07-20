var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
const DEFAULT_COLOR = 256;
const FLAG_BOLD = 1;
const FLAG_DIM = 2;
const FLAG_ITALIC = 4;
const FLAG_UNDERLINE = 8;
const FLAG_REVERSE = 32;
const FLAG_INVISIBLE = 64;
const FLAG_STRIKETHROUGH = 128;
const ANSI_16 = [
  "#000000",
  "#cd3131",
  "#0dbc79",
  "#e5e510",
  "#2472c8",
  "#bc3fbc",
  "#11a8cd",
  "#e5e5e5",
  "#666666",
  "#f14c4c",
  "#23d18b",
  "#f5f543",
  "#3b8eea",
  "#d670d6",
  "#29b8db",
  "#ffffff"
];
function toCssRgb(packed) {
  if (packed == null) return null;
  const r = packed >> 16 & 255;
  const g = packed >> 8 & 255;
  const b = packed & 255;
  return `rgb(${r},${g},${b})`;
}
function paletteCss(index) {
  if (index < 16) return ANSI_16[index] || "#ffffff";
  if (index < 232) {
    const n = index - 16;
    const r = Math.floor(n / 36);
    const g = Math.floor(n % 36 / 6);
    const b = n % 6;
    const v = [0, 95, 135, 175, 215, 255];
    return `rgb(${v[r]},${v[g]},${v[b]})`;
  }
  const gray = 8 + (index - 232) * 10;
  return `rgb(${gray},${gray},${gray})`;
}
function resolveFgBg(cell, reverseScreen) {
  let fgIdx = cell.fg;
  let bgIdx = cell.bg;
  let fgRgb = cell.fgRgb;
  let bgRgb = cell.bgRgb;
  let flags = cell.flags || 0;
  if (reverseScreen) flags ^= FLAG_REVERSE;
  if (flags & FLAG_REVERSE) {
    [fgIdx, bgIdx] = [bgIdx, fgIdx];
    [fgRgb, bgRgb] = [bgRgb, fgRgb];
    if (fgRgb == null && fgIdx === DEFAULT_COLOR) fgIdx = 7;
    if (bgRgb == null && bgIdx === DEFAULT_COLOR) bgIdx = 0;
  }
  if (flags & FLAG_INVISIBLE) {
    return { fg: "transparent", bg: bgRgb != null ? toCssRgb(bgRgb) : bgIdx === DEFAULT_COLOR ? null : paletteCss(bgIdx) };
  }
  const fg = fgRgb != null ? toCssRgb(fgRgb) : fgIdx === DEFAULT_COLOR ? "var(--term-fg)" : paletteCss(fgIdx);
  const bg = bgRgb != null ? toCssRgb(bgRgb) : bgIdx === DEFAULT_COLOR ? null : paletteCss(bgIdx);
  return { fg: fg || "#d4d4d4", bg };
}
class CanvasRenderer {
  constructor(container) {
    __publicField(this, "container");
    __publicField(this, "canvas");
    __publicField(this, "ctx");
    __publicField(this, "rows", 0);
    __publicField(this, "cols", 0);
    __publicField(this, "charW", 8);
    __publicField(this, "charH", 16);
    __publicField(this, "dpr", 1);
    __publicField(this, "screenReverse", false);
    __publicField(this, "_graphicsLayer", null);
    this.container = container;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "term-canvas";
    this.canvas.style.display = "block";
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
    const ctx = this.canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("2d canvas unavailable");
    this.ctx = ctx;
  }
  invalidateAll() {
  }
  setup(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    const remoteHistory = this.container.querySelector(":scope > .term-remote-history");
    if (remoteHistory) remoteHistory.remove();
    this.container.innerHTML = "";
    if (remoteHistory) this.container.appendChild(remoteHistory);
    this.container.appendChild(this.canvas);
    this._graphicsLayer = null;
    this._ensureGraphicsLayer();
    this._measure();
    this._resizeCanvas();
  }
  _measure() {
    const probe = document.createElement("span");
    probe.textContent = "W";
    probe.style.cssText = "position:absolute;visibility:hidden;font:inherit;line-height:inherit;white-space:pre;";
    this.container.appendChild(probe);
    const cs = getComputedStyle(this.container);
    probe.style.fontFamily = cs.fontFamily;
    probe.style.fontSize = cs.fontSize;
    probe.style.lineHeight = cs.lineHeight;
    const rect = probe.getBoundingClientRect();
    if (rect.width > 0) this.charW = rect.width;
    if (rect.height > 0) this.charH = rect.height;
    probe.remove();
  }
  _resizeCanvas() {
    this.dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
    const cssW = Math.max(1, Math.ceil(this.cols * this.charW));
    const cssH = Math.max(1, Math.ceil(this.rows * this.charH));
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.canvas.width = cssW * this.dpr;
    this.canvas.height = cssH * this.dpr;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }
  _ensureGraphicsLayer() {
    if (this._graphicsLayer?.isConnected) return;
    const layer = document.createElement("div");
    layer.className = "term-graphics-layer";
    layer.style.cssText = "position:absolute;left:0;top:0;right:0;bottom:0;pointer-events:none;overflow:hidden;z-index:2;";
    this.container.appendChild(layer);
    this._graphicsLayer = layer;
  }
  _syncGraphics(core) {
    if (typeof core.getImages !== "function") return;
    this._ensureGraphicsLayer();
    const images = core.getImages();
    const seen = /* @__PURE__ */ new Set();
    for (const img of images) {
      seen.add(img.id);
      let canvas = this._graphicsLayer.querySelector(`canvas[data-img-id="${img.id}"]`);
      if (!canvas) {
        canvas = document.createElement("canvas");
        canvas.dataset.imgId = String(img.id);
        canvas.style.position = "absolute";
        canvas.style.imageRendering = "pixelated";
        this._graphicsLayer.appendChild(canvas);
      }
      if (canvas.width !== img.width || canvas.height !== img.height) {
        canvas.width = Math.max(1, img.width);
        canvas.height = Math.max(1, img.height);
        const ctx = canvas.getContext("2d");
        if (ctx && img.width > 0 && img.height > 0) ctx.putImageData(new ImageData(img.pixels, img.width, img.height), 0, 0);
      }
      canvas.style.left = `${img.x * this.charW}px`;
      canvas.style.top = `${img.y * this.charH}px`;
      canvas.style.width = `${img.width}px`;
      canvas.style.height = `${img.height}px`;
    }
    for (const old of Array.from(this._graphicsLayer.querySelectorAll("canvas[data-img-id]"))) {
      const id = Number(old.dataset.imgId || 0);
      if (!seen.has(id)) old.remove();
    }
  }
  _drawCell(cell, x, y) {
    const { fg, bg } = resolveFgBg(cell, this.screenReverse);
    if (bg) {
      this.ctx.fillStyle = bg;
      this.ctx.fillRect(x, y, this.charW * (cell.wide === 1 ? 2 : 1), this.charH);
    }
    if ((cell.flags || 0) & FLAG_INVISIBLE) return;
    const ch = cell.char >= 32 && cell.char <= 1114111 ? String.fromCodePoint(cell.char) : " ";
    if (ch === " ") return;
    const bold = (cell.flags || 0) & FLAG_BOLD;
    const italic = (cell.flags || 0) & FLAG_ITALIC;
    this.ctx.fillStyle = fg;
    this.ctx.font = `${italic ? "italic " : ""}${bold ? "bold " : ""}${getComputedStyle(this.container).fontSize} ${getComputedStyle(this.container).fontFamily}`;
    this.ctx.textBaseline = "top";
    this.ctx.globalAlpha = (cell.flags || 0) & FLAG_DIM ? 0.6 : 1;
    this.ctx.fillText(ch, x, y + 1);
    this.ctx.globalAlpha = 1;
    if ((cell.flags || 0) & FLAG_UNDERLINE) {
      this.ctx.fillRect(x, y + this.charH - 2, this.charW * (cell.wide === 1 ? 2 : 1), 1);
    }
    if ((cell.flags || 0) & FLAG_STRIKETHROUGH) {
      this.ctx.fillRect(x, y + Math.floor(this.charH / 2), this.charW * (cell.wide === 1 ? 2 : 1), 1);
    }
  }
  render(core) {
    const rows = core.getRows();
    const cols = core.getCols();
    if (rows !== this.rows || cols !== this.cols || !this.canvas.isConnected) {
      this.setup(cols, rows);
    }
    this.screenReverse = !!core.reverseScreen?.();
    const cs = getComputedStyle(this.container);
    this.ctx.fillStyle = cs.backgroundColor || "#1e1e1e";
    this.ctx.fillRect(0, 0, this.cols * this.charW, this.rows * this.charH);
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; ) {
        const cell = core.getCell(r, c);
        if (cell.wide === 2) {
          c += 1;
          continue;
        }
        const g = core.getGrapheme?.(cell.char);
        if (g) cell.char = g.codePointAt(0) || cell.char;
        this._drawCell(cell, c * this.charW, r * this.charH);
        c += cell.wide === 1 ? 2 : 1;
      }
    }
    const cursor = core.getCursor();
    if (cursor.visible && cursor.row < this.rows && cursor.col < this.cols) {
      const x = cursor.col * this.charW;
      const y = cursor.row * this.charH;
      this.ctx.fillStyle = cs.getPropertyValue("--term-cursor") || "#aeafad";
      const style = cursor.style || 0;
      if (style === 3 || style === 4) this.ctx.fillRect(x, y + this.charH - 2, this.charW, 2);
      else if (style === 5 || style === 6) this.ctx.fillRect(x, y, 2, this.charH);
      else this.ctx.fillRect(x, y, this.charW, this.charH);
    }
    this._syncGraphics(core);
    core.clearDirty();
  }
}
export {
  CanvasRenderer
};
