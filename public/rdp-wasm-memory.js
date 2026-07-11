export class WasmMemoryViewCache {
    constructor(memoryProvider) {
        this.memoryProvider = memoryProvider;
        this.buffer = null;
        this.generation = 0;
    }

    view(pointer, length) {
        const memory = this.memoryProvider();
        const buffer = memory?.buffer;
        if (!(buffer instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && buffer instanceof SharedArrayBuffer))) throw new Error('WASM memory buffer is unavailable');
        if (this.buffer !== buffer) {
            this.buffer = buffer;
            this.generation++;
        }
        const start = Number(pointer);
        const size = Number(length);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(size) || start < 0 || size < 0 || start + size > buffer.byteLength) throw new RangeError('WASM pixel view is outside linear memory');
        return { bytes: new Uint8Array(buffer, start, size), generation: this.generation };
    }
}

export function createSynchronousBitmapUploader({ memoryProvider, upload }) {
    const cache = new WasmMemoryViewCache(memoryProvider);
    return function uploadWasmBitmap(event) {
        const { bytes, generation } = cache.view(event.pointer, event.length);
        // upload must consume the view synchronously. The view is never stored
        // past this call because Go may reuse its pool and memory.grow detaches
        // the previous ArrayBuffer.
        upload({ ...event, data: bytes, memoryGeneration: generation });
        return generation;
    };
}
