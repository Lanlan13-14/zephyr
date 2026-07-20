import type {
  CellData,
  CursorState,
  UnhandledSequence,
  TerminalCore,
} from "./terminal-core.js";

interface WasmExports {
  memory: WebAssembly.Memory;
  init(cols: number, rows: number): void;
  resizeTerminal(cols: number, rows: number): void;
  getWriteBuffer(): number;
  writeBytes(len: number): void;
  getGridPtr(): number;
  getDirtyPtr(): number;
  clearDirty(): void;
  getCursorRow(): number;
  getCursorCol(): number;
  getCursorVisible(): number;
  getCursorStyle(): number;
  getCols(): number;
  getRows(): number;
  getCursorKeysApp(): number;
  getBracketedPaste(): number;
  getMouseMode(): number;
  getMouseSGR(): number;
  getMouseAltScroll(): number;
  getReverseWrap(): number;
  getColumn132(): number;
  getBellPending(): number;
  clearBell(): void;
  getSyncOutput(): number;
  getFocusReporting(): number;
  getReverseScreen(): number;
  getKittyKeyboardFlags(): number;
  getKeypadApp(): number;
  getInsertMode(): number;
  getImageCount(): number;
  getImageId(index: number): number;
  getImageX(index: number): number;
  getImageY(index: number): number;
  getImageWidth(index: number): number;
  getImageHeight(index: number): number;
  getImageCols(index: number): number;
  getImageRows(index: number): number;
  getImagePtr(index: number): number;
  getImageStride(): number;
  getUsingAltScreen(): number;
  getTitlePtr(): number;
  getTitleLen(): number;
  getHyperlinkPtr(id: number): number;
  getHyperlinkLen(id: number): number;
  getClipboardPending(): number;
  getClipboardQuery(): number;
  getClipboardSelection(): number;
  getClipboardPtr(): number;
  getClipboardLen(): number;
  clearClipboard(): void;
  getGraphemePtr(id: number): number;
  getGraphemeLen(id: number): number;
  getColorQueryCount(): number;
  getColorQueryKind(): number;
  getColorQueryIndex(): number;
  shiftColorQuery(): void;
  getColorChangeCount(): number;
  getColorChangeKind(): number;
  getColorChangeIndex(): number;
  getColorChangePtr(): number;
  getColorChangeLen(): number;
  shiftColorChange(): void;
  getTitleChanged(): number;
  getScrollbackCount(): number;
  getScrollbackLine(offset: number): number;
  getScrollbackLineLen(offset: number): number;
  setCaptureEvicted(enabled: number): void;
  getEvictedCount(): number;
  getEvictedLine(): number;
  getEvictedLineLen(): number;
  getEvictedLineWrapped(): number;
  popEvictedLine(): void;
  getResponsePtr(): number;
  getResponseLen(): number;
  clearResponse(): void;
  getCellSize(): number;
  getMaxCols(): number;
  getDebugLogPtr(): number;
  getDebugLogCount(): number;
  getDebugLogEntrySize(): number;
  getDebugLogMax(): number;
}

import { WASM_BASE64 } from "./wasm-inline.js";

function decodeBase64(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export class WasmBridge implements TerminalCore {
  private exports: WasmExports;
  private memory: WebAssembly.Memory;
  private gridPtr = 0;
  private dirtyPtr = 0;
  private writeBufferPtr = 0;
  private cellSize = 12;
  private maxCols = 256;
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();
  private _dv!: DataView;

  constructor(instance: WebAssembly.Instance) {
    this.exports = instance.exports as unknown as WasmExports;
    this.memory = this.exports.memory;
  }

  static async load(url?: string): Promise<WasmBridge> {
    let bytes: ArrayBuffer;
    if (url) {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(
          `[wterm] Failed to load WASM from ${url}: ${response.status} ${response.statusText}`,
        );
      }
      bytes = await response.arrayBuffer();
    } else {
      bytes = decodeBase64(WASM_BASE64);
    }
    const { instance } = await WebAssembly.instantiate(bytes);
    return new WasmBridge(instance);
  }

  init(cols: number, rows: number): void {
    this.exports.init(cols, rows);
    this._updatePointers();
  }

  /** Copy the complete WASM linear memory for server-side history checkpoints. */
  exportCheckpoint(): Uint8Array {
    return new Uint8Array(this.memory.buffer).slice();
  }

  /** Restore a checkpoint created from the same WTerm WASM build. */
  importCheckpoint(checkpoint: Uint8Array): void {
    const pageSize = 64 * 1024;
    if (checkpoint.byteLength > this.memory.buffer.byteLength) {
      this.memory.grow(Math.ceil((checkpoint.byteLength - this.memory.buffer.byteLength) / pageSize));
    }
    new Uint8Array(this.memory.buffer).fill(0);
    new Uint8Array(this.memory.buffer, 0, checkpoint.byteLength).set(checkpoint);
    this._updatePointers();
  }

  private _updatePointers(): void {
    this.gridPtr = this.exports.getGridPtr();
    this.dirtyPtr = this.exports.getDirtyPtr();
    this.writeBufferPtr = this.exports.getWriteBuffer();
    this.cellSize = this.exports.getCellSize();
    this.maxCols = this.exports.getMaxCols();
    this._dv = new DataView(this.memory.buffer);
  }

  writeString(str: string): void {
    const encoded = this.encoder.encode(str);
    this.writeRaw(encoded);
  }

  writeRaw(data: Uint8Array): void {
    const buf = new Uint8Array(this.memory.buffer, this.writeBufferPtr, 8192);
    let offset = 0;
    while (offset < data.length) {
      const chunk = Math.min(data.length - offset, 8192);
      buf.set(data.subarray(offset, offset + chunk));
      this.exports.writeBytes(chunk);
      offset += chunk;
    }
  }

  getCell(row: number, col: number): CellData {
    const offset = this.gridPtr + (row * this.maxCols + col) * this.cellSize;
    const dv = this._dv;
    const fgRgb = dv.getUint32(offset + 12, true);
    const bgRgb = dv.getUint32(offset + 16, true);
    return {
      char: dv.getUint32(offset, true),
      fg: dv.getUint16(offset + 4, true),
      bg: dv.getUint16(offset + 6, true),
      flags: dv.getUint8(offset + 8),
      wide: dv.getUint8(offset + 9),
      linkId: dv.getUint16(offset + 10, true),
      fgRgb: fgRgb || undefined,
      bgRgb: bgRgb || undefined,
    };
  }

  isDirtyRow(row: number): boolean {
    return new Uint8Array(this.memory.buffer, this.dirtyPtr, 256)[row] !== 0;
  }

  clearDirty(): void {
    this.exports.clearDirty();
  }

  getCursor(): CursorState {
    return {
      row: this.exports.getCursorRow(),
      col: this.exports.getCursorCol(),
      visible: this.exports.getCursorVisible() !== 0,
      style: this.exports.getCursorStyle(),
    };
  }

  cursorStyle(): number {
    return this.exports.getCursorStyle();
  }

  getCols(): number {
    return this.exports.getCols();
  }
  getRows(): number {
    return this.exports.getRows();
  }

  cursorKeysApp(): boolean {
    return this.exports.getCursorKeysApp() !== 0;
  }
  bracketedPaste(): boolean {
    return this.exports.getBracketedPaste() !== 0;
  }
  mouseMode(): number {
    return this.exports.getMouseMode();
  }
  mouseSGR(): boolean {
    return this.exports.getMouseSGR() !== 0;
  }
  mouseAltScroll(): boolean {
    return this.exports.getMouseAltScroll() !== 0;
  }
  reverseWrap(): boolean {
    return this.exports.getReverseWrap() !== 0;
  }
  column132(): boolean {
    return this.exports.getColumn132() !== 0;
  }
  bellPending(): boolean {
    return this.exports.getBellPending() !== 0;
  }
  clearBell(): void {
    this.exports.clearBell();
  }
  syncOutput(): boolean {
    return this.exports.getSyncOutput() !== 0;
  }
  focusReporting(): boolean { return this.exports.getFocusReporting() !== 0; }
  reverseScreen(): boolean { return this.exports.getReverseScreen() !== 0; }
  kittyKeyboardFlags(): number { return this.exports.getKittyKeyboardFlags(); }
  keypadApp(): boolean { return this.exports.getKeypadApp() !== 0; }
  insertMode(): boolean { return this.exports.getInsertMode() !== 0; }
  getImages(): Array<{ id: number; x: number; y: number; width: number; height: number; cols: number; rows: number; pixels: Uint8ClampedArray; stride: number }> {
    const n = this.exports.getImageCount();
    const stride = this.exports.getImageStride();
    const out = [];
    for (let i = 0; i < n; i++) {
      const width = this.exports.getImageWidth(i);
      const height = this.exports.getImageHeight(i);
      const ptr = this.exports.getImagePtr(i);
      // pixels are stored at stride MAX_WIDTH*4; copy visible sub-rect tightly for canvas upload convenience.
      const tight = new Uint8ClampedArray(width * height * 4);
      const src = new Uint8Array(this.memory.buffer, ptr, stride * Math.max(height, 1));
      for (let y = 0; y < height; y++) {
        const row = src.subarray(y * stride, y * stride + width * 4);
        tight.set(row, y * width * 4);
      }
      out.push({
        id: this.exports.getImageId(i),
        x: this.exports.getImageX(i),
        y: this.exports.getImageY(i),
        width,
        height,
        cols: this.exports.getImageCols(i),
        rows: this.exports.getImageRows(i),
        pixels: tight,
        stride: width * 4,
      });
    }
    return out;
  }
  usingAltScreen(): boolean {
    return this.exports.getUsingAltScreen() !== 0;
  }

  getTitle(): string | null {
    if (this.exports.getTitleChanged() === 0) return null;
    const ptr = this.exports.getTitlePtr();
    const len = this.exports.getTitleLen();
    const bytes = new Uint8Array(this.memory.buffer, ptr, len);
    return this.decoder.decode(bytes);
  }

  getHyperlink(id: number): string | null {
    if (!id) return null;
    const len = this.exports.getHyperlinkLen(id);
    if (!len) return null;
    return this.decoder.decode(new Uint8Array(this.memory.buffer, this.exports.getHyperlinkPtr(id), len));
  }

  takeColorChanges(): Array<{ kind: number; index: number; value: string }> {
    const out: Array<{ kind: number; index: number; value: string }> = [];
    while (this.exports.getColorChangeCount() > 0 && out.length < 32) {
      const len = this.exports.getColorChangeLen();
      out.push({ kind: this.exports.getColorChangeKind(), index: this.exports.getColorChangeIndex(), value: this.decoder.decode(new Uint8Array(this.memory.buffer, this.exports.getColorChangePtr(), len)) });
      this.exports.shiftColorChange();
    }
    return out;
  }

  takeColorQueries(): Array<{ kind: number; index: number }> {
    const out: Array<{ kind: number; index: number }> = [];
    while (this.exports.getColorQueryCount() > 0 && out.length < 32) {
      out.push({ kind: this.exports.getColorQueryKind(), index: this.exports.getColorQueryIndex() });
      this.exports.shiftColorQuery();
    }
    return out;
  }

  getGrapheme(char: number): string | null {
    if ((char & 0x80000000) === 0) return null;
    const id = (char & 0x7fffffff) >>> 0, len = this.exports.getGraphemeLen(id);
    if (!len) return null;
    return this.decoder.decode(new Uint8Array(this.memory.buffer, this.exports.getGraphemePtr(id), len));
  }

  takeClipboardRequest(): { selection: string; base64: string; query: boolean } | null {
    if (this.exports.getClipboardPending() === 0) return null;
    const len = this.exports.getClipboardLen();
    const base64 = this.decoder.decode(new Uint8Array(this.memory.buffer, this.exports.getClipboardPtr(), len));
    const request = { selection: String.fromCharCode(this.exports.getClipboardSelection()), base64, query: this.exports.getClipboardQuery() !== 0 };
    this.exports.clearClipboard();
    return request;
  }

  getResponse(): string | null {
    const len = this.exports.getResponseLen();
    if (len === 0) return null;
    const ptr = this.exports.getResponsePtr();
    const bytes = new Uint8Array(this.memory.buffer, ptr, len);
    const str = this.decoder.decode(bytes);
    this.exports.clearResponse();
    return str;
  }

  getScrollbackCount(): number {
    return this.exports.getScrollbackCount();
  }

  getScrollbackCell(offset: number, col: number): CellData {
    const ptr = this.exports.getScrollbackLine(offset);
    const off = ptr + col * this.cellSize;
    const dv = this._dv;
    const fgRgb = dv.getUint32(off + 12, true);
    const bgRgb = dv.getUint32(off + 16, true);
    return {
      char: dv.getUint32(off, true),
      fg: dv.getUint16(off + 4, true),
      bg: dv.getUint16(off + 6, true),
      flags: dv.getUint8(off + 8),
      wide: dv.getUint8(off + 9),
      linkId: dv.getUint16(off + 10, true),
      fgRgb: fgRgb || undefined,
      bgRgb: bgRgb || undefined,
    };
  }

  getScrollbackLineLen(offset: number): number {
    return this.exports.getScrollbackLineLen(offset);
  }

  setCaptureEvicted(enabled: boolean): void {
    this.exports.setCaptureEvicted(enabled ? 1 : 0);
  }
  getEvictedCount(): number { return this.exports.getEvictedCount(); }
  getEvictedLineLen(): number { return this.exports.getEvictedLineLen(); }
  getEvictedLineWrapped(): boolean { return this.exports.getEvictedLineWrapped() !== 0; }
  getEvictedCell(col: number): CellData {
    const ptr = this.exports.getEvictedLine();
    const off = ptr + col * this.cellSize;
    const dv = this._dv;
    const fgRgb = dv.getUint32(off + 12, true);
    const bgRgb = dv.getUint32(off + 16, true);
    return { char: dv.getUint32(off, true), fg: dv.getUint16(off + 4, true), bg: dv.getUint16(off + 6, true), flags: dv.getUint8(off + 8), wide: dv.getUint8(off + 9), fgRgb: fgRgb || undefined, bgRgb: bgRgb || undefined };
  }
  popEvictedLine(): void { this.exports.popEvictedLine(); }

  getUnhandledSequences(): UnhandledSequence[] {
    const count = this.exports.getDebugLogCount();
    if (count === 0) return [];
    const ptr = this.exports.getDebugLogPtr();
    const entrySize = this.exports.getDebugLogEntrySize();
    const maxEntries = this.exports.getDebugLogMax();
    const total = Math.min(count, maxEntries);
    const dv = new DataView(this.memory.buffer);
    const entries: UnhandledSequence[] = [];
    const startIdx = count >= maxEntries ? count % maxEntries : 0;
    for (let i = 0; i < total; i++) {
      const idx = (startIdx + i) % maxEntries;
      const off = ptr + idx * entrySize;
      const finalByte = dv.getUint8(off);
      if (finalByte === 0) continue;
      const privateByte = dv.getUint8(off + 1);
      const paramCount = dv.getUint8(off + 2);
      const params: number[] = [];
      for (let p = 0; p < Math.min(paramCount, 4); p++) {
        params.push(dv.getUint16(off + 4 + p * 2, true));
      }
      entries.push({
        final: String.fromCharCode(finalByte),
        private: privateByte ? String.fromCharCode(privateByte) : "",
        paramCount,
        params,
      });
    }
    return entries;
  }

  resize(cols: number, rows: number): void {
    this.exports.resizeTerminal(cols, rows);
    this._updatePointers();
  }
}
