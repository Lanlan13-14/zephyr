var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
import { WASM_BASE64 } from "./wasm-inline.js";
function decodeBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
class WasmBridge {
  constructor(instance) {
    __publicField(this, "exports");
    __publicField(this, "memory");
    __publicField(this, "gridPtr", 0);
    __publicField(this, "dirtyPtr", 0);
    __publicField(this, "writeBufferPtr", 0);
    __publicField(this, "cellSize", 12);
    __publicField(this, "maxCols", 256);
    __publicField(this, "encoder", new TextEncoder());
    __publicField(this, "decoder", new TextDecoder());
    __publicField(this, "_dv");
    this.exports = instance.exports;
    this.memory = this.exports.memory;
  }
  static async load(url) {
    let bytes;
    if (url) {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(
          `[wterm] Failed to load WASM from ${url}: ${response.status} ${response.statusText}`
        );
      }
      bytes = await response.arrayBuffer();
    } else {
      bytes = decodeBase64(WASM_BASE64);
    }
    const { instance } = await WebAssembly.instantiate(bytes);
    return new WasmBridge(instance);
  }
  init(cols, rows) {
    this.exports.init(cols, rows);
    this._updatePointers();
  }
  /** Copy the complete WASM linear memory for server-side history checkpoints. */
  exportCheckpoint() {
    return new Uint8Array(this.memory.buffer).slice();
  }
  /** Restore a checkpoint created from the same WTerm WASM build. */
  importCheckpoint(checkpoint) {
    const pageSize = 64 * 1024;
    if (checkpoint.byteLength > this.memory.buffer.byteLength) {
      this.memory.grow(Math.ceil((checkpoint.byteLength - this.memory.buffer.byteLength) / pageSize));
    }
    new Uint8Array(this.memory.buffer).fill(0);
    new Uint8Array(this.memory.buffer, 0, checkpoint.byteLength).set(checkpoint);
    this._updatePointers();
  }
  _updatePointers() {
    this.gridPtr = this.exports.getGridPtr();
    this.dirtyPtr = this.exports.getDirtyPtr();
    this.writeBufferPtr = this.exports.getWriteBuffer();
    this.cellSize = this.exports.getCellSize();
    this.maxCols = this.exports.getMaxCols();
    this._dv = new DataView(this.memory.buffer);
  }
  writeString(str) {
    const encoded = this.encoder.encode(str);
    this.writeRaw(encoded);
  }
  writeRaw(data) {
    const buf = new Uint8Array(this.memory.buffer, this.writeBufferPtr, 8192);
    let offset = 0;
    while (offset < data.length) {
      const chunk = Math.min(data.length - offset, 8192);
      buf.set(data.subarray(offset, offset + chunk));
      this.exports.writeBytes(chunk);
      offset += chunk;
    }
  }
  getCell(row, col) {
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
      fgRgb: fgRgb || void 0,
      bgRgb: bgRgb || void 0
    };
  }
  isDirtyRow(row) {
    return new Uint8Array(this.memory.buffer, this.dirtyPtr, 256)[row] !== 0;
  }
  clearDirty() {
    this.exports.clearDirty();
  }
  getCursor() {
    return {
      row: this.exports.getCursorRow(),
      col: this.exports.getCursorCol(),
      visible: this.exports.getCursorVisible() !== 0,
      style: this.exports.getCursorStyle()
    };
  }
  cursorStyle() {
    return this.exports.getCursorStyle();
  }
  getCols() {
    return this.exports.getCols();
  }
  getRows() {
    return this.exports.getRows();
  }
  cursorKeysApp() {
    return this.exports.getCursorKeysApp() !== 0;
  }
  bracketedPaste() {
    return this.exports.getBracketedPaste() !== 0;
  }
  mouseMode() {
    return this.exports.getMouseMode();
  }
  mouseSGR() {
    return this.exports.getMouseSGR() !== 0;
  }
  bellPending() {
    return this.exports.getBellPending() !== 0;
  }
  clearBell() {
    this.exports.clearBell();
  }
  syncOutput() {
    return this.exports.getSyncOutput() !== 0;
  }
  focusReporting() {
    return this.exports.getFocusReporting() !== 0;
  }
  reverseScreen() {
    return this.exports.getReverseScreen() !== 0;
  }
  usingAltScreen() {
    return this.exports.getUsingAltScreen() !== 0;
  }
  getTitle() {
    if (this.exports.getTitleChanged() === 0) return null;
    const ptr = this.exports.getTitlePtr();
    const len = this.exports.getTitleLen();
    const bytes = new Uint8Array(this.memory.buffer, ptr, len);
    return this.decoder.decode(bytes);
  }
  getHyperlink(id) {
    if (!id) return null;
    const len = this.exports.getHyperlinkLen(id);
    if (!len) return null;
    return this.decoder.decode(new Uint8Array(this.memory.buffer, this.exports.getHyperlinkPtr(id), len));
  }
  getGrapheme(char) {
    if ((char & 2147483648) === 0) return null;
    const id = (char & 2147483647) >>> 0, len = this.exports.getGraphemeLen(id);
    if (!len) return null;
    return this.decoder.decode(new Uint8Array(this.memory.buffer, this.exports.getGraphemePtr(id), len));
  }
  takeClipboardRequest() {
    if (this.exports.getClipboardPending() === 0) return null;
    const len = this.exports.getClipboardLen();
    const base64 = this.decoder.decode(new Uint8Array(this.memory.buffer, this.exports.getClipboardPtr(), len));
    const request = { selection: String.fromCharCode(this.exports.getClipboardSelection()), base64, query: this.exports.getClipboardQuery() !== 0 };
    this.exports.clearClipboard();
    return request;
  }
  getResponse() {
    const len = this.exports.getResponseLen();
    if (len === 0) return null;
    const ptr = this.exports.getResponsePtr();
    const bytes = new Uint8Array(this.memory.buffer, ptr, len);
    const str = this.decoder.decode(bytes);
    this.exports.clearResponse();
    return str;
  }
  getScrollbackCount() {
    return this.exports.getScrollbackCount();
  }
  getScrollbackCell(offset, col) {
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
      fgRgb: fgRgb || void 0,
      bgRgb: bgRgb || void 0
    };
  }
  getScrollbackLineLen(offset) {
    return this.exports.getScrollbackLineLen(offset);
  }
  setCaptureEvicted(enabled) {
    this.exports.setCaptureEvicted(enabled ? 1 : 0);
  }
  getEvictedCount() {
    return this.exports.getEvictedCount();
  }
  getEvictedLineLen() {
    return this.exports.getEvictedLineLen();
  }
  getEvictedLineWrapped() {
    return this.exports.getEvictedLineWrapped() !== 0;
  }
  getEvictedCell(col) {
    const ptr = this.exports.getEvictedLine();
    const off = ptr + col * this.cellSize;
    const dv = this._dv;
    const fgRgb = dv.getUint32(off + 12, true);
    const bgRgb = dv.getUint32(off + 16, true);
    return { char: dv.getUint32(off, true), fg: dv.getUint16(off + 4, true), bg: dv.getUint16(off + 6, true), flags: dv.getUint8(off + 8), wide: dv.getUint8(off + 9), fgRgb: fgRgb || void 0, bgRgb: bgRgb || void 0 };
  }
  popEvictedLine() {
    this.exports.popEvictedLine();
  }
  getUnhandledSequences() {
    const count = this.exports.getDebugLogCount();
    if (count === 0) return [];
    const ptr = this.exports.getDebugLogPtr();
    const entrySize = this.exports.getDebugLogEntrySize();
    const maxEntries = this.exports.getDebugLogMax();
    const total = Math.min(count, maxEntries);
    const dv = new DataView(this.memory.buffer);
    const entries = [];
    const startIdx = count >= maxEntries ? count % maxEntries : 0;
    for (let i = 0; i < total; i++) {
      const idx = (startIdx + i) % maxEntries;
      const off = ptr + idx * entrySize;
      const finalByte = dv.getUint8(off);
      if (finalByte === 0) continue;
      const privateByte = dv.getUint8(off + 1);
      const paramCount = dv.getUint8(off + 2);
      const params = [];
      for (let p = 0; p < Math.min(paramCount, 4); p++) {
        params.push(dv.getUint16(off + 4 + p * 2, true));
      }
      entries.push({
        final: String.fromCharCode(finalByte),
        private: privateByte ? String.fromCharCode(privateByte) : "",
        paramCount,
        params
      });
    }
    return entries;
  }
  resize(cols, rows) {
    this.exports.resizeTerminal(cols, rows);
    this._updatePointers();
  }
}
export {
  WasmBridge
};
