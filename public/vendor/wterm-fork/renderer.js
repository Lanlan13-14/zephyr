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
const URL_CONT_RE = /^[A-Za-z0-9/._~%&=+\-?#]+/;
const URL_START_RE = /https?:\/\/[^\s<>"']*[^\s<>"'.,;:!?)}\]]?/g;
const URL_LOOKS_COMPLETE_RE = /(?:\/|[.](?:html?|php|aspx?|jsp|json|xml|pdf|png|jpe?g|gif|webp|svg|css|js|mjs|ts|md|txt|zip|tar|gz|tgz|bz2|xz|7z|rar|mp[34]|wav|avi|mov|webm|ico|woff2?|ttf|eot|csv|tsv|yaml|yml|toml|ini|cfg|log|sh|py|go|rs|java|c|cpp|h|rb|pl|lua))(?:[?#][^\s]*)?$/i;
function unwrapAutoLinks(row) {
  if (!row) return;
  row.querySelectorAll("a.term-auto-link").forEach((a) => {
    const parent = a.parentNode;
    if (!parent) return;
    while (a.firstChild) parent.insertBefore(a.firstChild, a);
    parent.removeChild(a);
    parent.normalize?.();
  });
}
function wrapTextRangeInRow(row, start, end, href) {
  if (!row || end <= start || !href) return false;
  const walker0 = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  let node0, off0 = 0;
  while (node0 = walker0.nextNode()) {
    const len = node0.textContent?.length || 0;
    const nStart = off0;
    const nEnd = off0 + len;
    if (nEnd > start && nStart < end) {
      if (node0.parentElement?.closest?.("a.term-hyperlink")) return false;
    }
    off0 += len;
  }
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
  if (!startNode || !endNode) return false;
  try {
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
    return true;
  } catch {
    return false;
  }
}
function trimUrlTrailingPunct(url) {
  return String(url || "").replace(/[.,;:!?)}\]]+$/g, "");
}
function isShellPromptLine(text = "") {
  const s = String(text || "").trimStart();
  if (!s) return false;
  if (/^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+:/.test(s)) return true;
  if (/^[#$%❯➜]\s?/.test(s)) return true;
  if (/^~?[\/\w.-]*[%#]\s*$/.test(s)) return true;
  return false;
}
function isUrlSoftWrapContinuation(urlSoFar, nextLine) {
  const next = String(nextLine || "");
  if (!next) return false;
  if (/^https?:\/\//i.test(next.trimStart())) return false;
  if (isShellPromptLine(next)) return false;
  if (/^\s/.test(next)) return false;
  if (!URL_CONT_RE.test(next)) return false;
  if (URL_LOOKS_COMPLETE_RE.test(urlSoFar)) {
    return /^[/?#&]/.test(next);
  }
  if (/^[A-Za-z0-9_.-]+@/.test(next)) return false;
  return true;
}
function resolveWrappedUrl(texts, startRow, startIdx, matchLen) {
  const n = texts.length;
  let url = String(texts[startRow] || "").slice(startIdx, startIdx + matchLen);
  const segments = [{ row: startRow, start: startIdx, end: startIdx + matchLen }];
  let r = startRow;
  let end = startIdx + matchLen;
  const line = () => String(texts[r] || "");
  while (r < n) {
    const t = line();
    const trailing = t.slice(end);
    if (trailing && /\S/.test(trailing)) break;
    if (r + 1 >= n) break;
    const next = String(texts[r + 1] || "");
    if (!isUrlSoftWrapContinuation(url, next)) break;
    const m = next.match(URL_CONT_RE);
    if (!m) break;
    let piece = m[0];
    const trimmed = trimUrlTrailingPunct(piece);
    if (!trimmed) break;
    piece = trimmed;
    url += piece;
    r += 1;
    end = piece.length;
    segments.push({ row: r, start: 0, end: piece.length });
    if (next.length > piece.length && /\S/.test(next.slice(piece.length))) break;
  }
  url = trimUrlTrailingPunct(url);
  return { url, segments };
}
function linkifyViewport(rowEls) {
  if (!rowEls?.length) return;
  const texts = rowEls.map((el) => el?.textContent || "");
  for (const el of rowEls) unwrapAutoLinks(el);
  const jobs = [];
  for (let r = 0; r < texts.length; r++) {
    const text = texts[r];
    if (!text) continue;
    URL_START_RE.lastIndex = 0;
    let m;
    while (m = URL_START_RE.exec(text)) {
      const matchLen = m[0].length;
      if (!matchLen) {
        URL_START_RE.lastIndex = m.index + 1;
        continue;
      }
      const resolved = resolveWrappedUrl(texts, r, m.index, matchLen);
      const href = safeHyperlink(resolved.url);
      if (!href) continue;
      for (const seg of resolved.segments) {
        jobs.push({ row: seg.row, start: seg.start, end: seg.end, href });
      }
      URL_START_RE.lastIndex = m.index + matchLen;
    }
  }
  jobs.sort((a, b) => b.row - a.row || b.start - a.start);
  for (const job of jobs) {
    const el = rowEls[job.row];
    if (!el) continue;
    wrapTextRangeInRow(el, job.start, job.end, job.href);
  }
}
function linkifyRow(row) {
  if (!row) return;
  linkifyViewport([row]);
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
    this.container = container;
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
  /**
   * Recycle viewport row DOM when ydisp shifts by a small delta.
   * delta>0: scrolled toward bottom (newer) → drop top rows, append at bottom.
   * delta<0: scrolled into history → drop bottom rows, prepend at top.
   * Only the incoming edge must be rebuilt; shared rows keep their HTML.
   */
  _recycleRowsForScroll(delta) {
    const d = Math.trunc(Number(delta) || 0);
    if (!d || !this.rows || Math.abs(d) >= this.rows) {
      this.rowSignatures = this.rowSignatures.map(() => null);
      return Math.abs(d) >= this.rows;
    }
    const cursorEl = this.cursorEl;
    if (d > 0) {
      const movedEls = this.rowEls.splice(0, d);
      this.rowSignatures.splice(0, d);
      for (let i = 0; i < d; i++) this.rowSignatures.push(null);
      this.rowEls.push(...movedEls);
      for (const el of movedEls) {
        if (cursorEl && cursorEl.parentNode === this.container) {
          this.container.insertBefore(el, cursorEl);
        } else {
          this.container.appendChild(el);
        }
      }
      if (this.prevRowBg.length === this.rows) {
        const movedBg = this.prevRowBg.splice(0, d);
        this.prevRowBg.push(...movedBg.map(() => ""));
      }
    } else {
      const n = -d;
      const movedEls = this.rowEls.splice(this.rows - n, n);
      this.rowSignatures.splice(this.rows - n, n);
      for (let i = 0; i < n; i++) this.rowSignatures.unshift(null);
      this.rowEls.unshift(...movedEls);
      const ref = this.rowEls[n] || cursorEl || this.container.firstChild;
      for (let i = 0; i < n; i++) this.container.insertBefore(this.rowEls[i], ref);
      if (this.prevRowBg.length === this.rows) {
        const movedBg = this.prevRowBg.splice(this.rows - n, n);
        this.prevRowBg.unshift(...movedBg.map(() => ""));
      }
    }
    return false;
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
    if (!resized && !screenReverseChanged && xtermViewport && typeof core.consumeViewportScrollDelta === "function") {
      const scrollDelta = core.consumeViewportScrollDelta() | 0;
      if (scrollDelta) {
        const full = this._recycleRowsForScroll(scrollDelta);
        if (full) this.rowSignatures = this.rowSignatures.map(() => null);
      }
    } else if (typeof core.consumeViewportScrollDelta === "function") {
      core.consumeViewportScrollDelta();
    }
    const cursor = core.getCursor();
    const paintCursor = cursor;
    const cursorMoved = paintCursor.row !== this.prevCursorRow || paintCursor.col !== this.prevCursorCol;
    const cursorNeedsPaint = cursorMoved || resized || paintCursor.visible !== this.cursorVisible || core.kind === "xterm";
    const cellAt = (r, col) => core.getCell(r, col);
    for (let r = 0; r < this.rows; r++) {
      const isDirty = resized || screenReverseChanged || this.rowSignatures[r] === null || core.isDirtyRow(r);
      if (!isDirty) continue;
      const oldSigs = this.rowSignatures[r];
      let allMatch = oldSigs !== null && oldSigs.length === this.cols;
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
    if (cursorNeedsPaint) {
      this._updateCursorOverlay(core, paintCursor);
    }
    this.prevCursorRow = paintCursor.row;
    this.prevCursorCol = paintCursor.col;
    this.cursorVisible = !!paintCursor.visible;
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
    try {
      linkifyViewport(this.rowEls);
    } catch {
    }
    core.clearDirty();
  }
}
export {
  Renderer,
  buildCellStyle,
  linkifyRow,
  linkifyViewport,
  resolveQueryColor,
  resolveWrappedUrl
};
