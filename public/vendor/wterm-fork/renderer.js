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
function rgbToCSS(packed) {
  const r = packed >> 16 & 255;
  const g = packed >> 8 & 255;
  const b = packed & 255;
  return `rgb(${r},${g},${b})`;
}
const ANSI_16 = ["#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5", "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff"];
function colorToCSS(index) {
  if (index === DEFAULT_COLOR) return null;
  if (index < 16) return `var(--term-color-${index})`;
  if (index < 232) {
    const n = index - 16;
    const r = Math.floor(n / 36) * 51;
    const g = Math.floor(n / 6) % 6 * 51;
    const b = n % 6 * 51;
    return `rgb(${r},${g},${b})`;
  }
  const level = (index - 232) * 10 + 8;
  return `rgb(${level},${level},${level})`;
}
function resolveQueryColor(element, kind, index) {
  let value = kind === 10 ? "var(--term-fg)" : kind === 11 ? "var(--term-bg)" : kind === 12 ? "var(--term-cursor)" : colorToCSS(index);
  if (kind === 4 && index < 16) {
    const configured = getComputedStyle(element).getPropertyValue(`--term-color-${index}`).trim();
    if (!configured) value = ANSI_16[index] || "#000000";
  }
  if (!value) value = kind === 11 ? "#000000" : "#ffffff";
  const probe = document.createElement("span");
  probe.style.color = value;
  probe.style.display = "none";
  element.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  const match = resolved.match(/rgba?\(\s*(\d+)\D+(\d+)\D+(\d+)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [255, 255, 255];
}
function cellFgCSS(fg, fgRgb) {
  if (fgRgb !== void 0) return rgbToCSS(fgRgb);
  return colorToCSS(fg);
}
function cellBgCSS(bg, bgRgb) {
  if (bgRgb !== void 0) return rgbToCSS(bgRgb);
  return colorToCSS(bg);
}
function buildCellStyle(fg, bg, flags, fgRgb, bgRgb, screenReverse = false) {
  let fgIdx = fg, bgIdx = bg, fgR = fgRgb, bgR = bgRgb;
  if ((flags & FLAG_REVERSE) !== (screenReverse ? FLAG_REVERSE : 0)) {
    const tmpIdx = fgIdx;
    fgIdx = bgIdx;
    bgIdx = tmpIdx;
    const tmpR = fgR;
    fgR = bgR;
    bgR = tmpR;
    if (fgR === void 0 && fgIdx === DEFAULT_COLOR) fgIdx = 0;
    if (bgR === void 0 && bgIdx === DEFAULT_COLOR) bgIdx = 7;
  }
  const fgCSS = cellFgCSS(fgIdx, fgR);
  const bgCSS = cellBgCSS(bgIdx, bgR);
  let style = "";
  if (fgCSS) style += `color:${fgCSS};`;
  if (bgCSS) style += `background:${bgCSS};`;
  if (flags & FLAG_BOLD) style += "font-weight:bold;";
  if (flags & FLAG_DIM) style += "opacity:0.5;";
  if (flags & FLAG_ITALIC) style += "font-style:italic;";
  const decorations = [];
  if (flags & FLAG_UNDERLINE) decorations.push("underline");
  if (flags & FLAG_STRIKETHROUGH) decorations.push("line-through");
  if (decorations.length) style += `text-decoration:${decorations.join(" ")};`;
  if (flags & FLAG_INVISIBLE) style += "visibility:hidden;";
  return style;
}
function appendRun(parent, text, style) {
  const span = document.createElement("span");
  if (style) span.style.cssText = style;
  span.textContent = text;
  parent.appendChild(span);
}
function escapeHTML(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttr(text) {
  return escapeHTML(text).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function safeHyperlink(uri) {
  if (!uri) return null;
  try {
    const url = new URL(uri, window.location.href);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
function linkifyRow(row) {
  if (row.querySelector("a.term-hyperlink")) return;
  const text = row.textContent || "";
  const matches = [...text.matchAll(/https?:\/\/[^\s<>"']*[^\s<>"'.,;:!?)}\]]/g)];
  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i], start = match.index || 0, end = start + match[0].length;
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    let node, offset = 0, startNode = null, endNode = null, startOffset = 0, endOffset = 0;
    while (node = walker.nextNode()) {
      const len = node.textContent?.length || 0;
      if (!startNode && start >= offset && start <= offset + len) {
        startNode = node;
        startOffset = start - offset;
      }
      if (end >= offset && end <= offset + len) {
        endNode = node;
        endOffset = end - offset;
        break;
      }
      offset += len;
    }
    if (!startNode || !endNode) continue;
    const href = safeHyperlink(match[0]);
    if (!href) continue;
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    const anchor = document.createElement("a");
    anchor.className = "term-hyperlink term-auto-link";
    anchor.href = href;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.appendChild(range.extractContents());
    range.insertNode(anchor);
  }
}
function resolveColors(fg, bg, flags, fgRgb, bgRgb, screenReverse = false) {
  let fgIdx = fg, bgIdx = bg, fgR = fgRgb, bgR = bgRgb;
  if ((flags & FLAG_REVERSE) !== (screenReverse ? FLAG_REVERSE : 0)) {
    [fgIdx, bgIdx] = [bgIdx, fgIdx];
    [fgR, bgR] = [bgR, fgR];
    if (fgR === void 0 && fgIdx === DEFAULT_COLOR) fgIdx = 0;
    if (bgR === void 0 && bgIdx === DEFAULT_COLOR) bgIdx = 7;
  }
  return {
    fg: cellFgCSS(fgIdx, fgR) || "var(--term-fg)",
    bg: cellBgCSS(bgIdx, bgR) || "var(--term-bg)"
  };
}
function getBlockBackground(cp, fg, bg) {
  switch (cp) {
    case 9600:
      return `linear-gradient(${fg} 50%,${bg} 50%)`;
    case 9601:
      return `linear-gradient(${bg} 87.5%,${fg} 87.5%)`;
    case 9602:
      return `linear-gradient(${bg} 75%,${fg} 75%)`;
    case 9603:
      return `linear-gradient(${bg} 62.5%,${fg} 62.5%)`;
    case 9604:
      return `linear-gradient(${bg} 50%,${fg} 50%)`;
    case 9605:
      return `linear-gradient(${bg} 37.5%,${fg} 37.5%)`;
    case 9606:
      return `linear-gradient(${bg} 25%,${fg} 25%)`;
    case 9607:
      return `linear-gradient(${bg} 12.5%,${fg} 12.5%)`;
    case 9608:
      return fg;
    case 9609:
      return `linear-gradient(to right,${fg} 87.5%,${bg} 87.5%)`;
    case 9610:
      return `linear-gradient(to right,${fg} 75%,${bg} 75%)`;
    case 9611:
      return `linear-gradient(to right,${fg} 62.5%,${bg} 62.5%)`;
    case 9612:
      return `linear-gradient(to right,${fg} 50%,${bg} 50%)`;
    case 9613:
      return `linear-gradient(to right,${fg} 37.5%,${bg} 37.5%)`;
    case 9614:
      return `linear-gradient(to right,${fg} 25%,${bg} 25%)`;
    case 9615:
      return `linear-gradient(to right,${fg} 12.5%,${bg} 12.5%)`;
    case 9616:
      return `linear-gradient(to right,${bg} 50%,${fg} 50%)`;
    case 9617:
      return `color-mix(in srgb,${fg} 25%,${bg})`;
    case 9618:
      return `color-mix(in srgb,${fg} 50%,${bg})`;
    case 9619:
      return `color-mix(in srgb,${fg} 75%,${bg})`;
    case 9620:
      return `linear-gradient(${fg} 12.5%,${bg} 12.5%)`;
    case 9621:
      return `linear-gradient(to right,${bg} 87.5%,${fg} 87.5%)`;
    default: {
      const QUADRANTS = {
        9622: [false, false, true, false],
        9623: [false, false, false, true],
        9624: [true, false, false, false],
        9625: [true, false, true, true],
        9626: [true, false, false, true],
        9627: [true, true, true, false],
        9628: [true, true, false, true],
        9629: [false, true, false, false],
        9630: [false, true, true, false],
        9631: [false, true, true, true]
      };
      const q = QUADRANTS[cp];
      if (!q) return fg;
      const [tl, tr, bl, br] = q;
      if (tl && tr && bl && br) return fg;
      const layers = [];
      const POS = ["0 0", "100% 0", "0 100%", "100% 100%"];
      q.forEach((filled, i) => {
        if (filled)
          layers.push(
            `linear-gradient(${fg},${fg}) ${POS[i]}/50% 50% no-repeat`
          );
      });
      layers.push(bg);
      return layers.join(",");
    }
  }
}
function cellSignature(char, fg, bg, flags, fgRgb, bgRgb, wide, linkId) {
  if (fgRgb !== void 0 || bgRgb !== void 0) {
    return `${char},${fg},${bg},${flags},${fgRgb ?? -1},${bgRgb ?? -1},${wide ?? 0},${linkId ?? 0}`;
  }
  return `${char},${fg},${bg},${flags},${wide ?? 0},${linkId ?? 0}`;
}
class Renderer {
  constructor(container) {
    __publicField(this, "container");
    __publicField(this, "rows", 0);
    __publicField(this, "cols", 0);
    __publicField(this, "rowEls", []);
    /** Per-row signature cache for cell-level diffing (P1-2). Each entry is an
     *  array of cell signatures, or null when the row needs full rebuild. */
    __publicField(this, "rowSignatures", []);
    __publicField(this, "prevCursorRow", -1);
    __publicField(this, "prevCursorCol", -1);
    __publicField(this, "prevContainerBg", "");
    __publicField(this, "prevRowBg", []);
    /** Decoupled cursor overlay element (P1-2). The cursor is rendered as an
     *  absolutely-positioned element layered above the row content, so moving
     *  the cursor never forces a row rebuild. */
    __publicField(this, "cursorEl", null);
    __publicField(this, "cursorVisible", false);
    __publicField(this, "screenReverse", false);
    __publicField(this, "_graphicsLayer", null);
    __publicField(this, "_graphicsIds", /* @__PURE__ */ new Set());
    __publicField(this, "_charWidth", 8);
    __publicField(this, "_cellHeight", 16);
    /** Optional host-provided metrics. When set, cursor overlay uses these
     *  instead of re-measuring from the first span (avoids 1ch drift). */
    __publicField(this, "_hostCellWidth", 0);
    __publicField(this, "_hostCellHeight", 0);
    __publicField(this, "_scrollbackRowEls", []);
    __publicField(this, "_renderedScrollbackCount", 0);
    /**
     * Local pre-commit draft (mobile/desktop line editor). Painted IN the grid
     * starting at the live cursor — not a separate chrome bar. Supports soft
     * wrap at cols and hard newlines. Long drafts show the tail so the caret
     * stays on-screen.
     */
    __publicField(this, "_localDraft", "");
    /** Previous draft footprint rows that must be invalidated on change. */
    __publicField(this, "_draftDirtyRows", /* @__PURE__ */ new Set());
    this.container = container;
  }
  /**
   * Set the in-grid local draft text (pre-Enter). Empty clears.
   * Returns rows that changed for host diagnostics.
   */
  setLocalDraft(text) {
    const next = String(text || "");
    if (next === this._localDraft) return;
    this.invalidateAll();
    this._localDraft = next;
    this._draftDirtyRows.clear();
  }
  getLocalDraft() {
    return this._localDraft;
  }
  /**
   * Build overlay cells for draft starting at cursor, wrapped to cols.
   * Map key = `${row},${col}` → CellData-like for paint.
   */
  _buildDraftOverlay(cursor, cols, rows) {
    const cells = /* @__PURE__ */ new Map();
    const draft = this._localDraft;
    if (!draft || cols < 1 || rows < 1) {
      return {
        cells,
        caretRow: cursor.row,
        caretCol: cursor.col
      };
    }
    const logical = [];
    let line = {
      startCol: Math.max(0, Math.min(cols - 1, cursor.col | 0)),
      chars: []
    };
    const flushLine = () => {
      logical.push(line);
      line = { startCol: 0, chars: [] };
    };
    const room = () => cols - line.startCol - line.chars.length;
    for (const ch of draft) {
      if (ch === "\r") continue;
      if (ch === "\n") {
        flushLine();
        continue;
      }
      const cp = ch.codePointAt(0) || 32;
      if (room() <= 0) flushLine();
      line.chars.push(cp);
    }
    logical.push(line);
    const baseRow = Math.max(0, Math.min(rows - 1, cursor.row | 0));
    const avail = Math.max(1, rows - baseRow);
    const visible = logical.length > avail ? logical.slice(logical.length - avail) : logical;
    const row0 = baseRow;
    let caretRow = row0;
    let caretCol = cursor.col | 0;
    for (let i = 0; i < visible.length; i++) {
      const dl = visible[i];
      const r = row0 + i;
      if (r >= rows) break;
      let c = dl.startCol;
      for (const cp of dl.chars) {
        if (c >= cols) break;
        cells.set(`${r},${c}`, {
          char: cp,
          fg: 14,
          // cyan-ish draft (palette)
          bg: 256,
          flags: 4,
          // italic — distinguish draft from committed
          wide: 0
        });
        c += 1;
      }
      caretRow = r;
      caretCol = Math.min(cols, c);
    }
    return { cells, caretRow, caretCol };
  }
  /** Push authoritative cell metrics from WTerm.refreshCellMetrics(). */
  setCellMetrics(charWidth, rowHeight) {
    if (Number.isFinite(charWidth) && charWidth > 0) {
      this._charWidth = charWidth;
      this._hostCellWidth = charWidth;
    }
    if (Number.isFinite(rowHeight) && rowHeight > 0) {
      this._cellHeight = rowHeight;
      this._hostCellHeight = rowHeight;
    }
  }
  getCellMetrics() {
    return {
      charWidth: this._hostCellWidth || this._charWidth,
      rowHeight: this._hostCellHeight || this._cellHeight
    };
  }
  invalidateAll() {
    this.rowSignatures = this.rowSignatures.map(() => null);
    this.prevRowBg.fill("");
    for (const el of this._scrollbackRowEls) el.remove();
    this._scrollbackRowEls = [];
    this._renderedScrollbackCount = 0;
  }
  setup(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    const remoteHistory = this.container.querySelector(":scope > .term-remote-history");
    if (remoteHistory) remoteHistory.remove();
    this.container.innerHTML = "";
    if (remoteHistory) this.container.appendChild(remoteHistory);
    this.rowEls = [];
    this.rowSignatures = [];
    this.prevRowBg = [];
    this._scrollbackRowEls = [];
    this._renderedScrollbackCount = 0;
    this._graphicsLayer = null;
    this._graphicsIds.clear();
    this._ensureGraphicsLayer();
    const fragment = document.createDocumentFragment();
    for (let r = 0; r < rows; r++) {
      const rowEl = document.createElement("div");
      rowEl.className = "term-row";
      fragment.appendChild(rowEl);
      this.rowEls.push(rowEl);
      this.rowSignatures.push(null);
    }
    this.cursorEl = document.createElement("div");
    this.cursorEl.className = "term-cursor-overlay";
    this.cursorEl.style.display = "none";
    fragment.appendChild(this.cursorEl);
    this.container.appendChild(fragment);
    this.prevCursorRow = -1;
    this.prevCursorCol = -1;
  }
  _buildRowContent(rowEl, getCell, lineLen, rowIndex, getHyperlink, getGrapheme, screenReverse) {
    let html = "";
    let runStyle = "";
    let runText = "";
    let runStart = 0;
    let runLink = null;
    const flushRun = (endCol) => {
      if (!runText) return;
      const escaped = escapeHTML(runText);
      const isWide = runStyle.includes(" term-wide");
      const pureStyle = isWide ? runStyle.replace(" term-wide", "") : runStyle;
      const cls = isWide ? ' class="term-wide"' : "";
      const content = pureStyle ? `<span${cls} style="${pureStyle}">${escaped}</span>` : isWide ? `<span${cls}>${escaped}</span>` : `<span>${escaped}</span>`;
      html += runLink ? `<a class="term-hyperlink" href="${escapeAttr(runLink)}" target="_blank" rel="noopener noreferrer">${content}</a>` : content;
    };
    for (let col = 0; col < this.cols; col++) {
      const cell = getCell(col);
      const inBounds = col < lineLen;
      const cp = inBounds ? cell.char : 0;
      if (inBounds && cp >= 9600 && cp <= 9631) {
        flushRun(col);
        const colors = resolveColors(
          cell.fg,
          cell.bg,
          cell.flags,
          cell.fgRgb,
          cell.bgRgb,
          screenReverse
        );
        const bg = getBlockBackground(cp, colors.fg, colors.bg);
        const dim = cell.flags & FLAG_DIM ? "opacity:0.5;" : "";
        html += `<span class="term-block" style="background:${bg};${dim}"></span>`;
        runStyle = "";
        runText = "";
        runLink = null;
        runStart = col + 1;
      } else {
        if (inBounds && cell.wide === 2) {
          flushRun(col);
          runStyle = "";
          runText = "";
          runLink = null;
          runStart = col + 1;
          continue;
        }
        const ch = inBounds && cp >= 32 ? getGrapheme(cp) || String.fromCodePoint(cp) : " ";
        const style = inBounds ? buildCellStyle(cell.fg, cell.bg, cell.flags, cell.fgRgb, cell.bgRgb, screenReverse) : "";
        const wideAttr = inBounds && cell.wide === 1 ? " term-wide" : "";
        const link = inBounds ? safeHyperlink(getHyperlink(cell.linkId || 0)) : null;
        if (style + wideAttr !== runStyle || link !== runLink) {
          flushRun(col);
          runStyle = style + wideAttr;
          runLink = link;
          runText = ch;
          runStart = col;
        } else {
          runText += ch;
        }
      }
    }
    flushRun(this.cols);
    rowEl.innerHTML = html;
    linkifyRow(rowEl);
    let bgCss = "";
    if (lineLen >= this.cols && this.cols > 0) {
      const lastCell = getCell(this.cols - 1);
      let bgIdx = lastCell.bg;
      let bgR = lastCell.bgRgb;
      if (lastCell.flags & FLAG_REVERSE) {
        bgIdx = lastCell.fg;
        bgR = lastCell.fgRgb;
        if (bgR === void 0 && bgIdx === DEFAULT_COLOR) bgIdx = 7;
      }
      bgCss = cellBgCSS(bgIdx, bgR) || "";
    }
    const boxShadow = bgCss ? `0 1px 0 ${bgCss}` : "";
    if (rowIndex >= 0) {
      if (bgCss !== (this.prevRowBg[rowIndex] ?? "")) {
        rowEl.style.background = bgCss;
        rowEl.style.boxShadow = boxShadow;
        this.prevRowBg[rowIndex] = bgCss;
      }
    } else {
      rowEl.style.background = bgCss;
      rowEl.style.boxShadow = boxShadow;
    }
  }
  _buildScrollbackRowEl(core, sbOffset) {
    const rowEl = document.createElement("div");
    rowEl.className = "term-row term-scrollback-row";
    const lineLen = core.getScrollbackLineLen(sbOffset);
    this._buildRowContent(rowEl, (col) => core.getScrollbackCell(sbOffset, col), lineLen, -1, (id) => core.getHyperlink(id), (char) => core.getGrapheme(char), this.screenReverse);
    return rowEl;
  }
  syncScrollback(core) {
    const scrollbackCount = core.getScrollbackCount();
    if (scrollbackCount === this._renderedScrollbackCount) return;
    if (scrollbackCount > this._renderedScrollbackCount) {
      const newCount = scrollbackCount - this._renderedScrollbackCount;
      const firstGridRow = this.rowEls[0] ?? null;
      const fragment = document.createDocumentFragment();
      for (let i = newCount - 1; i >= 0; i--) {
        const rowEl = this._buildScrollbackRowEl(core, i);
        fragment.appendChild(rowEl);
        this._scrollbackRowEls.push(rowEl);
      }
      this.container.insertBefore(fragment, firstGridRow);
    } else {
      const removeCount = this._renderedScrollbackCount - scrollbackCount;
      for (let i = 0; i < removeCount; i++) {
        const el = this._scrollbackRowEls.shift();
        if (el) el.remove();
      }
    }
    this._renderedScrollbackCount = scrollbackCount;
  }
  /** Update the decoupled cursor overlay position and visibility (P1-2).
   *
   *  Geometry: prefer host-measured cell metrics (setCellMetrics) written as
   *  absolute px top/left. Falling back to CSS vars alone caused:
   *    - 1ch ≠ real monospaced advance (measured ~9% wider → right drift)
   *    - offsetParent = .wterm (padding) when .term-grid was static
   *  Both are fixed by pixel placement inside position:relative .term-grid. */
  _updateCursorOverlay(core, cursor) {
    if (!this.cursorEl) return;
    if (!cursor.visible || cursor.row >= this.rows || cursor.col >= this.cols) {
      this.cursorEl.style.display = "none";
      this.cursorVisible = false;
      return;
    }
    const cell = core.getCell(cursor.row, cursor.col);
    const style = buildCellStyle(
      cell.fg,
      cell.bg,
      cell.flags,
      cell.fgRgb,
      cell.bgRgb,
      this.screenReverse
    );
    const ch = core.getGrapheme(cell.char) || (cell.char >= 32 && cell.char <= 1114111 ? String.fromCodePoint(cell.char) : " ");
    this.cursorEl.textContent = ch;
    const styleClass = `term-cursor-style-${cursor.style || 0}`;
    this.cursorEl.className = `term-cursor-overlay ${styleClass}`;
    const scrollbackOffset = this._renderedScrollbackCount * (this._hostCellHeight || this._cellHeight || 0);
    const cellW = this._hostCellWidth || this._charWidth || 8;
    const cellH = this._hostCellHeight || this._cellHeight || 17;
    const wide = cell.wide === 1 ? 2 : 1;
    const top = scrollbackOffset + cursor.row * cellH;
    const left = cursor.col * cellW;
    const width = cellW * wide;
    this.cursorEl.style.cssText = `display:block;position:absolute;top:${top}px;left:${left}px;width:${width}px;height:${cellH}px;box-sizing:border-box;${style}`;
    this.cursorEl.style.setProperty("--cursor-row", String(cursor.row));
    this.cursorEl.style.setProperty("--cursor-col", String(cursor.col));
    this.cursorVisible = true;
  }
  _ensureGraphicsLayer() {
    if (this._graphicsLayer && this._graphicsLayer.isConnected) return;
    const layer = document.createElement("div");
    layer.className = "term-graphics-layer";
    layer.style.cssText = "position:absolute;left:0;top:0;right:0;bottom:0;pointer-events:none;overflow:hidden;z-index:2;";
    this.container.appendChild(layer);
    this._graphicsLayer = layer;
  }
  _measureCellMetrics() {
    if (this._hostCellWidth > 0 && this._hostCellHeight > 0) {
      this._charWidth = this._hostCellWidth;
      this._cellHeight = this._hostCellHeight;
      return;
    }
    const row = this.rowEls[0];
    if (!row) return;
    const span = row.querySelector("span");
    if (span) {
      const text = span.firstChild;
      if (text && text.nodeType === Node.TEXT_NODE && (text.textContent || "").length > 0) {
        const range = document.createRange();
        range.setStart(text, 0);
        range.setEnd(text, 1);
        const rect2 = range.getBoundingClientRect();
        if (rect2.width > 0) this._charWidth = rect2.width;
        if (rect2.height > 0) this._cellHeight = rect2.height;
        return;
      }
      const rect = span.getBoundingClientRect();
      if (rect.width > 0) this._charWidth = rect.width;
      if (rect.height > 0) this._cellHeight = rect.height;
    } else {
      const rect = row.getBoundingClientRect();
      if (rect.height > 0) this._cellHeight = rect.height;
    }
  }
  _syncGraphics(core) {
    if (typeof core.getImages !== "function") return;
    this._ensureGraphicsLayer();
    this._measureCellMetrics();
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
        if (ctx && img.width > 0 && img.height > 0) {
          const data = new ImageData(img.pixels, img.width, img.height);
          ctx.putImageData(data, 0, 0);
        }
      }
      const left = img.x * this._charWidth;
      const top = img.y * this._cellHeight;
      canvas.style.left = `${left}px`;
      canvas.style.top = `${top}px`;
      canvas.style.width = `${img.width}px`;
      canvas.style.height = `${img.height}px`;
    }
    for (const old of Array.from(this._graphicsLayer.querySelectorAll("canvas[data-img-id]"))) {
      const id = Number(old.dataset.imgId || 0);
      if (!seen.has(id)) old.remove();
    }
    this._graphicsIds = seen;
  }
  render(core) {
    const rows = core.getRows();
    const cols = core.getCols();
    let resized = false;
    if (rows !== this.rows || cols !== this.cols) {
      this.setup(cols, rows);
      resized = true;
    }
    const reverseNow = core.reverseScreen();
    const screenReverseChanged = reverseNow !== this.screenReverse;
    if (screenReverseChanged) {
      this.screenReverse = reverseNow;
      for (const el of this._scrollbackRowEls) el.remove();
      this._scrollbackRowEls = [];
      this._renderedScrollbackCount = 0;
      this.rowSignatures = this.rowSignatures.map(() => null);
      this.prevRowBg.fill("");
    }
    const xtermViewport = core.kind === "xterm" || core.virtualViewport === true;
    if (!xtermViewport) {
      this.syncScrollback(core);
    } else if (this._renderedScrollbackCount > 0) {
      for (const el of this._scrollbackRowEls) el.remove();
      this._scrollbackRowEls = [];
      this._renderedScrollbackCount = 0;
    }
    const cursor = core.getCursor();
    const draftOverlay = this._buildDraftOverlay(cursor, this.cols, this.rows);
    const hasDraft = !!this._localDraft;
    const paintCursor = hasDraft ? {
      row: draftOverlay.caretRow,
      col: draftOverlay.caretCol,
      visible: cursor.visible,
      style: cursor.style
    } : cursor;
    const cursorMoved = paintCursor.row !== this.prevCursorRow || paintCursor.col !== this.prevCursorCol;
    const cellAt = (r, col) => {
      const key = `${r},${col}`;
      const over = draftOverlay.cells.get(key);
      if (over) return over;
      return core.getCell(r, col);
    };
    for (let r = 0; r < this.rows; r++) {
      const draftTouchesRow = hasDraft && [...draftOverlay.cells.keys()].some((k) => k.startsWith(`${r},`));
      const isDirty = resized || screenReverseChanged || core.isDirtyRow(r) || draftTouchesRow || hasDraft && r >= cursor.row;
      if (!isDirty) continue;
      const oldSigs = this.rowSignatures[r];
      let allMatch = oldSigs !== null && oldSigs.length === this.cols && !draftTouchesRow;
      if (allMatch) {
        for (let col = 0; col < this.cols; col++) {
          const cell = cellAt(r, col);
          const sig = cellSignature(
            cell.char,
            cell.fg,
            cell.bg,
            cell.flags,
            cell.fgRgb,
            cell.bgRgb,
            cell.wide,
            cell.linkId
          );
          if (sig !== oldSigs[col]) {
            allMatch = false;
            break;
          }
        }
      }
      if (allMatch) {
        continue;
      }
      this._buildRowContent(
        this.rowEls[r],
        (col) => cellAt(r, col),
        this.cols,
        r,
        (id) => core.getHyperlink(id),
        (char) => core.getGrapheme(char),
        this.screenReverse
      );
      const newSigs = [];
      for (let col = 0; col < this.cols; col++) {
        const cell = cellAt(r, col);
        newSigs.push(
          cellSignature(
            cell.char,
            cell.fg,
            cell.bg,
            cell.flags,
            cell.fgRgb,
            cell.bgRgb,
            cell.wide,
            cell.linkId
          )
        );
      }
      this.rowSignatures[r] = newSigs;
    }
    if (cursorMoved || resized || paintCursor.visible !== this.cursorVisible || hasDraft) {
      this._updateCursorOverlay(core, paintCursor);
    }
    this.prevCursorRow = paintCursor.row;
    this.prevCursorCol = paintCursor.col;
    const lastRowDirty = resized || core.isDirtyRow(this.rows - 1);
    if (lastRowDirty) {
      const bottomRight = core.getCell(this.rows - 1, this.cols - 1);
      let gridBgIdx = bottomRight.bg;
      let gridBgRgb = bottomRight.bgRgb;
      if (bottomRight.flags & FLAG_REVERSE) {
        gridBgIdx = bottomRight.fg;
        gridBgRgb = bottomRight.fgRgb;
        if (gridBgRgb === void 0 && gridBgIdx === DEFAULT_COLOR)
          gridBgIdx = 7;
      }
      const containerBg = cellBgCSS(gridBgIdx, gridBgRgb) || "";
      if (containerBg !== this.prevContainerBg) {
        this.container.style.background = containerBg;
        this.prevContainerBg = containerBg;
      }
    }
    this._syncGraphics(core);
    core.clearDirty();
  }
}
export {
  Renderer,
  buildCellStyle,
  linkifyRow,
  resolveQueryColor
};
