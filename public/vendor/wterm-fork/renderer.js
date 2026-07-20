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
    __publicField(this, "_scrollbackRowEls", []);
    __publicField(this, "_renderedScrollbackCount", 0);
    this.container = container;
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
  /** Update the decoupled cursor overlay position and visibility (P1-2). */
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
    this.cursorEl.style.cssText = `display:block;${style}`;
    this.cursorEl.style.setProperty("--cursor-row", String(cursor.row));
    this.cursorEl.style.setProperty("--cursor-col", String(cursor.col));
    this.cursorVisible = true;
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
    this.syncScrollback(core);
    const cursor = core.getCursor();
    const cursorMoved = cursor.row !== this.prevCursorRow || cursor.col !== this.prevCursorCol;
    for (let r = 0; r < this.rows; r++) {
      const isDirty = resized || screenReverseChanged || core.isDirtyRow(r);
      if (!isDirty) continue;
      const oldSigs = this.rowSignatures[r];
      let allMatch = oldSigs !== null && oldSigs.length === this.cols;
      if (allMatch) {
        for (let col = 0; col < this.cols; col++) {
          const cell = core.getCell(r, col);
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
        (col) => core.getCell(r, col),
        this.cols,
        r,
        (id) => core.getHyperlink(id),
        (char) => core.getGrapheme(char),
        this.screenReverse
      );
      const newSigs = [];
      for (let col = 0; col < this.cols; col++) {
        const cell = core.getCell(r, col);
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
    if (cursorMoved || resized || cursor.visible !== this.cursorVisible) {
      this._updateCursorOverlay(core, cursor);
    }
    this.prevCursorRow = cursor.row;
    this.prevCursorCol = cursor.col;
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
    core.clearDirty();
  }
}
export {
  Renderer,
  linkifyRow
};
