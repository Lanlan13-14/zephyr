import { WASM_BASE64 } from "./wasm-inline.js";
function decodeBase64(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++)
        bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
}
export class WasmBridge {
    constructor(instance) {
        this.gridPtr = 0;
        this.dirtyPtr = 0;
        this.writeBufferPtr = 0;
        this.cellSize = 12;
        this.maxCols = 256;
        this.encoder = new TextEncoder();
        this.decoder = new TextDecoder();
        this.exports = instance.exports;
        this.memory = this.exports.memory;
    }
    static async load(url) {
        let bytes;
        if (url) {
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`[wterm] Failed to load WASM from ${url}: ${response.status} ${response.statusText}`);
            }
            bytes = await response.arrayBuffer();
        }
        else {
            bytes = decodeBase64(WASM_BASE64);
        }
        const { instance } = await WebAssembly.instantiate(bytes);
        return new WasmBridge(instance);
    }
    init(cols, rows) {
        this.exports.init(cols, rows);
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
        return {
            char: dv.getUint32(offset, true),
            fg: dv.getUint16(offset + 4, true),
            bg: dv.getUint16(offset + 6, true),
            flags: dv.getUint8(offset + 8),
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
        };
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
    usingAltScreen() {
        return this.exports.getUsingAltScreen() !== 0;
    }
    getTitle() {
        if (this.exports.getTitleChanged() === 0)
            return null;
        const ptr = this.exports.getTitlePtr();
        const len = this.exports.getTitleLen();
        const bytes = new Uint8Array(this.memory.buffer, ptr, len);
        return this.decoder.decode(bytes);
    }
    getResponse() {
        const len = this.exports.getResponseLen();
        if (len === 0)
            return null;
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
        return {
            char: dv.getUint32(off, true),
            fg: dv.getUint16(off + 4, true),
            bg: dv.getUint16(off + 6, true),
            flags: dv.getUint8(off + 8),
        };
    }
    getScrollbackLineLen(offset) {
        return this.exports.getScrollbackLineLen(offset);
    }
    getUnhandledSequences() {
        const count = this.exports.getDebugLogCount();
        if (count === 0)
            return [];
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
            if (finalByte === 0)
                continue;
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
                params,
            });
        }
        return entries;
    }
    resize(cols, rows) {
        this.exports.resizeTerminal(cols, rows);
        this._updatePointers();
    }
}
//# sourceMappingURL=wasm-bridge.js.map