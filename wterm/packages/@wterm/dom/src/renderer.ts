import type { TerminalCore } from "@wterm/core";

const DEFAULT_COLOR = 256;
const FLAG_BOLD = 0x01;
const FLAG_DIM = 0x02;
const FLAG_ITALIC = 0x04;
const FLAG_UNDERLINE = 0x08;
const FLAG_REVERSE = 0x20;
const FLAG_INVISIBLE = 0x40;
const FLAG_STRIKETHROUGH = 0x80;

function rgbToCSS(packed: number): string {
  const r = (packed >> 16) & 0xff;
  const g = (packed >> 8) & 0xff;
  const b = packed & 0xff;
  return `rgb(${r},${g},${b})`;
}

function colorToCSS(index: number): string | null {
  if (index === DEFAULT_COLOR) return null;
  if (index < 16) return `var(--term-color-${index})`;
  if (index < 232) {
    const n = index - 16;
    const r = Math.floor(n / 36) * 51;
    const g = (Math.floor(n / 6) % 6) * 51;
    const b = (n % 6) * 51;
    return `rgb(${r},${g},${b})`;
  }
  const level = (index - 232) * 10 + 8;
  return `rgb(${level},${level},${level})`;
}

function cellFgCSS(fg: number, fgRgb: number | undefined): string | null {
  if (fgRgb !== undefined) return rgbToCSS(fgRgb);
  return colorToCSS(fg);
}

function cellBgCSS(bg: number, bgRgb: number | undefined): string | null {
  if (bgRgb !== undefined) return rgbToCSS(bgRgb);
  return colorToCSS(bg);
}

function buildCellStyle(
  fg: number,
  bg: number,
  flags: number,
  fgRgb?: number,
  bgRgb?: number,
  screenReverse = false,
): string {
  let fgIdx = fg,
    bgIdx = bg,
    fgR = fgRgb,
    bgR = bgRgb;

  if ((flags & FLAG_REVERSE) !== (screenReverse ? FLAG_REVERSE : 0)) {
    const tmpIdx = fgIdx;
    fgIdx = bgIdx;
    bgIdx = tmpIdx;
    const tmpR = fgR;
    fgR = bgR;
    bgR = tmpR;
    if (fgR === undefined && fgIdx === DEFAULT_COLOR) fgIdx = 0;
    if (bgR === undefined && bgIdx === DEFAULT_COLOR) bgIdx = 7;
  }

  const fgCSS = cellFgCSS(fgIdx, fgR);
  const bgCSS = cellBgCSS(bgIdx, bgR);

  let style = "";
  if (fgCSS) style += `color:${fgCSS};`;
  if (bgCSS) style += `background:${bgCSS};`;
  if (flags & FLAG_BOLD) style += "font-weight:bold;";
  if (flags & FLAG_DIM) style += "opacity:0.5;";
  if (flags & FLAG_ITALIC) style += "font-style:italic;";

  const decorations: string[] = [];
  if (flags & FLAG_UNDERLINE) decorations.push("underline");
  if (flags & FLAG_STRIKETHROUGH) decorations.push("line-through");
  if (decorations.length) style += `text-decoration:${decorations.join(" ")};`;

  if (flags & FLAG_INVISIBLE) style += "visibility:hidden;";
  return style;
}

function appendRun(parent: HTMLElement, text: string, style: string): void {
  const span = document.createElement("span");
  if (style) span.style.cssText = style;
  span.textContent = text;
  parent.appendChild(span);
}

function escapeHTML(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(text: string): string {
  return escapeHTML(text).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function safeHyperlink(uri: string | null): string | null {
  if (!uri) return null;
  try {
    const url = new URL(uri, window.location.href);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

function resolveColors(
  fg: number,
  bg: number,
  flags: number,
  fgRgb?: number,
  bgRgb?: number,
  screenReverse = false,
): { fg: string; bg: string } {
  let fgIdx = fg,
    bgIdx = bg,
    fgR = fgRgb,
    bgR = bgRgb;

  if ((flags & FLAG_REVERSE) !== (screenReverse ? FLAG_REVERSE : 0)) {
    [fgIdx, bgIdx] = [bgIdx, fgIdx];
    [fgR, bgR] = [bgR, fgR];
    if (fgR === undefined && fgIdx === DEFAULT_COLOR) fgIdx = 0;
    if (bgR === undefined && bgIdx === DEFAULT_COLOR) bgIdx = 7;
  }
  return {
    fg: cellFgCSS(fgIdx, fgR) || "var(--term-fg)",
    bg: cellBgCSS(bgIdx, bgR) || "var(--term-bg)",
  };
}

function getBlockBackground(cp: number, fg: string, bg: string): string {
  switch (cp) {
    case 0x2580:
      return `linear-gradient(${fg} 50%,${bg} 50%)`;
    case 0x2581:
      return `linear-gradient(${bg} 87.5%,${fg} 87.5%)`;
    case 0x2582:
      return `linear-gradient(${bg} 75%,${fg} 75%)`;
    case 0x2583:
      return `linear-gradient(${bg} 62.5%,${fg} 62.5%)`;
    case 0x2584:
      return `linear-gradient(${bg} 50%,${fg} 50%)`;
    case 0x2585:
      return `linear-gradient(${bg} 37.5%,${fg} 37.5%)`;
    case 0x2586:
      return `linear-gradient(${bg} 25%,${fg} 25%)`;
    case 0x2587:
      return `linear-gradient(${bg} 12.5%,${fg} 12.5%)`;
    case 0x2588:
      return fg;
    case 0x2589:
      return `linear-gradient(to right,${fg} 87.5%,${bg} 87.5%)`;
    case 0x258a:
      return `linear-gradient(to right,${fg} 75%,${bg} 75%)`;
    case 0x258b:
      return `linear-gradient(to right,${fg} 62.5%,${bg} 62.5%)`;
    case 0x258c:
      return `linear-gradient(to right,${fg} 50%,${bg} 50%)`;
    case 0x258d:
      return `linear-gradient(to right,${fg} 37.5%,${bg} 37.5%)`;
    case 0x258e:
      return `linear-gradient(to right,${fg} 25%,${bg} 25%)`;
    case 0x258f:
      return `linear-gradient(to right,${fg} 12.5%,${bg} 12.5%)`;
    case 0x2590:
      return `linear-gradient(to right,${bg} 50%,${fg} 50%)`;
    case 0x2591:
      return `color-mix(in srgb,${fg} 25%,${bg})`;
    case 0x2592:
      return `color-mix(in srgb,${fg} 50%,${bg})`;
    case 0x2593:
      return `color-mix(in srgb,${fg} 75%,${bg})`;
    case 0x2594:
      return `linear-gradient(${fg} 12.5%,${bg} 12.5%)`;
    case 0x2595:
      return `linear-gradient(to right,${bg} 87.5%,${fg} 87.5%)`;
    default: {
      const QUADRANTS: Record<number, [boolean, boolean, boolean, boolean]> = {
        0x2596: [false, false, true, false],
        0x2597: [false, false, false, true],
        0x2598: [true, false, false, false],
        0x2599: [true, false, true, true],
        0x259a: [true, false, false, true],
        0x259b: [true, true, true, false],
        0x259c: [true, true, false, true],
        0x259d: [false, true, false, false],
        0x259e: [false, true, true, false],
        0x259f: [false, true, true, true],
      };
      const q = QUADRANTS[cp];
      if (!q) return fg;
      const [tl, tr, bl, br] = q;
      if (tl && tr && bl && br) return fg;
      const layers: string[] = [];
      const POS = ["0 0", "100% 0", "0 100%", "100% 100%"];
      q.forEach((filled, i) => {
        if (filled)
          layers.push(
            `linear-gradient(${fg},${fg}) ${POS[i]}/50% 50% no-repeat`,
          );
      });
      layers.push(bg);
      return layers.join(",");
    }
  }
}

/** A compact signature of a cell for diffing. Two cells with the same
 *  signature produce identical visual output, so the renderer can skip them. */
function cellSignature(
  char: number,
  fg: number,
  bg: number,
  flags: number,
  fgRgb?: number,
  bgRgb?: number,
  wide?: number,
  linkId?: number,
): string {
  // Pack into a string. Using | 0 on flags to keep it short.
  // When fgRgb/bgRgb are present, include them; otherwise the 16-bit index suffices.
  if (fgRgb !== undefined || bgRgb !== undefined) {
    return `${char},${fg},${bg},${flags},${fgRgb ?? -1},${bgRgb ?? -1},${wide ?? 0},${linkId ?? 0}`;
  }
  return `${char},${fg},${bg},${flags},${wide ?? 0},${linkId ?? 0}`;
}

export class Renderer {
  private container: HTMLElement;
  private rows = 0;
  private cols = 0;

  private rowEls: HTMLDivElement[] = [];
  /** Per-row signature cache for cell-level diffing (P1-2). Each entry is an
   *  array of cell signatures, or null when the row needs full rebuild. */
  private rowSignatures: (string[] | null)[] = [];
  private prevCursorRow = -1;
  private prevCursorCol = -1;
  private prevContainerBg = "";
  private prevRowBg: string[] = [];

  /** Decoupled cursor overlay element (P1-2). The cursor is rendered as an
   *  absolutely-positioned element layered above the row content, so moving
   *  the cursor never forces a row rebuild. */
  private cursorEl: HTMLDivElement | null = null;
  private cursorVisible = false;
  private screenReverse = false;

  private _scrollbackRowEls: HTMLDivElement[] = [];
  private _renderedScrollbackCount = 0;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  setup(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    // Preserve server-backed history pages across renderer resize/setup.
    // WTerm owns grid/cursor nodes; .term-remote-history is owned by the
    // pagination controller and must remain in the same scroll container.
    const remoteHistory = this.container.querySelector<HTMLElement>(":scope > .term-remote-history");
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

    // Create the cursor overlay (P1-2: decoupled cursor)
    this.cursorEl = document.createElement("div");
    this.cursorEl.className = "term-cursor-overlay";
    this.cursorEl.style.display = "none";
    fragment.appendChild(this.cursorEl);

    this.container.appendChild(fragment);
    this.prevCursorRow = -1;
    this.prevCursorCol = -1;
  }

  private _buildRowContent(
    rowEl: HTMLDivElement,
    getCell: (col: number) => {
      char: number;
      fg: number;
      bg: number;
      flags: number;
      fgRgb?: number;
      bgRgb?: number;
      linkId?: number;
    },
    lineLen: number,
    rowIndex: number,
    getHyperlink: (id: number) => string | null,
    getGrapheme: (char: number) => string | null,
    screenReverse: boolean,
  ): void {
    let html = "";
    let runStyle = "";
    let runText = "";
    let runStart = 0;
    let runLink: string | null = null;

    const flushRun = (endCol: number) => {
      if (!runText) return;
      const escaped = escapeHTML(runText);
      // P2-1: runStyle may include " term-wide" suffix for wide chars
      const isWide = runStyle.includes(" term-wide");
      const pureStyle = isWide ? runStyle.replace(" term-wide", "") : runStyle;
      const cls = isWide ? ' class="term-wide"' : "";
      const content = pureStyle
        ? `<span${cls} style="${pureStyle}">${escaped}</span>`
        : (isWide ? `<span${cls}>${escaped}</span>` : `<span>${escaped}</span>`);
      html += runLink ? `<a class="term-hyperlink" href="${escapeAttr(runLink)}" target="_blank" rel="noopener noreferrer">${content}</a>` : content;
    };

    for (let col = 0; col < this.cols; col++) {
      const cell = getCell(col);
      const inBounds = col < lineLen;
      const cp = inBounds ? cell.char : 0;

      if (inBounds && cp >= 0x2580 && cp <= 0x259f) {
        flushRun(col);

        const colors = resolveColors(
          cell.fg,
          cell.bg,
          cell.flags,
          cell.fgRgb,
          cell.bgRgb,
          screenReverse,
        );
        const bg = getBlockBackground(cp, colors.fg, colors.bg);
        const dim = cell.flags & FLAG_DIM ? "opacity:0.5;" : "";
        html += `<span class="term-block" style="background:${bg};${dim}"></span>`;

        runStyle = "";
        runText = "";
        runLink = null;
        runStart = col + 1;
      } else {
        // P2-1: Skip wide continuation cells (they are placeholders for the
        // second cell of a wide character). The lead cell already renders
        // at double width via a style override.
        if (inBounds && cell.wide === 2) {
          flushRun(col);
          runStyle = "";
          runText = "";
          runLink = null;
          runStart = col + 1;
          continue;
        }
        const ch = inBounds && cp >= 32 ? (getGrapheme(cp) || String.fromCodePoint(cp)) : " ";
        const style = inBounds
          ? buildCellStyle(cell.fg, cell.bg, cell.flags, cell.fgRgb, cell.bgRgb, screenReverse)
          : "";
        // P2-1: Wide lead cell gets a width override via a data attribute.
        // The CSS .term-wide rule sets width: 2ch for these spans.
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
        if (bgR === undefined && bgIdx === DEFAULT_COLOR) bgIdx = 7;
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

  private _buildScrollbackRowEl(
    core: TerminalCore,
    sbOffset: number,
  ): HTMLDivElement {
    const rowEl = document.createElement("div");
    rowEl.className = "term-row term-scrollback-row";
    const lineLen = core.getScrollbackLineLen(sbOffset);

    this._buildRowContent(rowEl, (col) => core.getScrollbackCell(sbOffset, col), lineLen, -1, (id) => core.getHyperlink(id), (char) => core.getGrapheme(char), this.screenReverse);
    return rowEl;
  }

  private syncScrollback(core: TerminalCore): void {
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
  private _updateCursorOverlay(
    core: TerminalCore,
    cursor: { row: number; col: number; visible: boolean },
  ): void {
    if (!this.cursorEl) return;

    if (!cursor.visible || cursor.row >= this.rows || cursor.col >= this.cols) {
      this.cursorEl.style.display = "none";
      this.cursorVisible = false;
      return;
    }

    // Read the cell under the cursor to inherit its colors
    const cell = core.getCell(cursor.row, cursor.col);
    const style = buildCellStyle(
      cell.fg,
      cell.bg,
      cell.flags,
      cell.fgRgb,
      cell.bgRgb,
      this.screenReverse,
    );

    const ch = core.getGrapheme(cell.char) || (cell.char >= 32 && cell.char <= 0x10ffff ? String.fromCodePoint(cell.char) : " ");
    this.cursorEl.textContent = ch;
    // DECSCUSR: apply cursor style class (0-6)
    const styleClass = `term-cursor-style-${cursor.style || 0}`;
    this.cursorEl.className = `term-cursor-overlay ${styleClass}`;
    this.cursorEl.style.cssText = `display:block;${style}`;
    // Position using CSS custom properties; the CSS rules use these to
    // translate the overlay to the correct cell.
    this.cursorEl.style.setProperty("--cursor-row", String(cursor.row));
    this.cursorEl.style.setProperty("--cursor-col", String(cursor.col));

    this.cursorVisible = true;
  }

  render(core: TerminalCore): void {
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
    const cursorMoved =
      cursor.row !== this.prevCursorRow || cursor.col !== this.prevCursorCol;

    // P1-2: cell-level diff. For each dirty row, compare cell signatures
    // against the cached version. If all cells match, skip the rebuild.
    // Only rebuild rows where actual content changed.
    for (let r = 0; r < this.rows; r++) {
      const isDirty = resized || screenReverseChanged || core.isDirtyRow(r);

      if (!isDirty) continue;

      // Build the new signature array and compare
      const oldSigs = this.rowSignatures[r];
      let allMatch = oldSigs !== null && oldSigs.length === this.cols;

      if (allMatch) {
        // Quick check: compare signatures cell by cell
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
            cell.linkId,
          );
          if (sig !== oldSigs[col]) {
            allMatch = false;
            break;
          }
        }
      }

      if (allMatch) {
        // No visual change; skip the DOM rebuild entirely
        continue;
      }

      // Rebuild the row and cache signatures
      this._buildRowContent(
        this.rowEls[r],
        (col) => core.getCell(r, col),
        this.cols,
        r,
        (id) => core.getHyperlink(id),
        (char) => core.getGrapheme(char),
        this.screenReverse,
      );

      // Cache signatures for next frame's diff
      const newSigs: string[] = [];
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
            cell.linkId,
          ),
        );
      }
      this.rowSignatures[r] = newSigs;
    }

    // P1-2: update cursor overlay independently. Cursor movement no longer
    // forces row rebuilds.
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
        if (gridBgRgb === undefined && gridBgIdx === DEFAULT_COLOR)
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
