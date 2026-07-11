export class RdpAvc420Decoder {
    constructor({ Decoder = globalThis.VideoDecoder, Chunk = globalThis.EncodedVideoChunk, onFrame, onError = () => {}, maxQueue = 64 } = {}) {
        if (!Decoder || !Chunk) throw new Error('WebCodecs VideoDecoder is unavailable');
        this.Decoder = Decoder;
        this.Chunk = Chunk;
        this.onFrame = onFrame;
        this.onError = onError;
        this.maxQueue = maxQueue;
        this.decoders = new Map();
        this.nextToken = 0;
    }

    static async probe({ Decoder = globalThis.VideoDecoder } = {}) {
        if (!Decoder?.isConfigSupported) return { supported: false, reason: 'NO_VIDEO_DECODER' };
        try {
            const result = await Decoder.isConfigSupported({ codec: 'avc1.42E01E', optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' });
            return { supported: !!result?.supported, config: result?.config || null, reason: result?.supported ? '' : 'AVC420_CONFIG_UNSUPPORTED' };
        } catch (error) {
            return { supported: false, reason: 'AVC420_PROBE_FAILED', error: error.message };
        }
    }

    decode(event) {
        const stream = event.stream1;
        if (!stream?.data?.byteLength) throw new Error('AVC420 event has no stream1 data');
        const key = `${Number(event.surfaceId)}:1`;
        const state = this._state(key);
        if (state.decoder.decodeQueueSize >= this.maxQueue) {
            // Never drop a reference-bearing chunk. Fail explicitly so the
            // caller can apply RDPGFX backpressure/recovery.
            throw new Error(`AVC420 decode queue exceeded ${this.maxQueue}`);
        }
        const token = ++this.nextToken;
        state.metadata.set(token, { event, token });
        try {
            state.decoder.decode(new this.Chunk({ type: stream.key ? 'key' : 'delta', timestamp: token, data: stream.data }));
        } catch (error) {
            state.metadata.delete(token);
            throw error;
        }
        return token;
    }

    _state(key) {
        let state = this.decoders.get(key);
        if (state) return state;
        const metadata = new Map();
        const decoder = new this.Decoder({
            output: (frame) => {
                const item = metadata.get(Number(frame.timestamp));
                metadata.delete(Number(frame.timestamp));
                if (!item) { frame.close?.(); return; }
                this.onFrame?.(frame, item.event, item.token);
            },
            error: (error) => {
                for (const item of metadata.values()) this.onError(error, item.event, item.token);
                metadata.clear();
            },
        });
        decoder.configure({ codec: 'avc1.42E01E', optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' });
        state = { decoder, metadata };
        this.decoders.set(key, state);
        return state;
    }

    resetSurface(surfaceId) {
        const prefix = `${Number(surfaceId)}:`;
        for (const [key, state] of this.decoders) {
            if (!key.startsWith(prefix)) continue;
            try { state.decoder.reset(); } catch {}
            for (const item of state.metadata.values()) this.onError(new Error('decoder reset'), item.event, item.token);
            state.metadata.clear();
            this.decoders.delete(key);
        }
    }

    close() {
        for (const state of this.decoders.values()) { try { state.decoder.close(); } catch {} }
        this.decoders.clear();
    }
}


function clampByte(value) { return Math.max(0, Math.min(255, value)); }

export function combineAvc444Planes(main, aux, width, height) {
    if (!main?.Y || !main?.U || !main?.V || !aux?.Y || !aux?.U || !aux?.V) throw new Error('AVC444 planes are incomplete');
    const output = new Uint8Array(width * height * 4);
    const halfWidth = Math.floor(width / 2);
    const quarterWidth = Math.floor(width / 4);
    for (let row = 0; row < height; row++) {
        const yOffset = row * main.yStride;
        const uvRow = row >> 1;
        const uvOffset = uvRow * main.uStride;
        const auxYOffset = row * aux.yStride;
        const auxUOffset = uvRow * aux.uStride;
        const auxVOffset = uvRow * aux.vStride;
        let out = row * width * 4;
        for (let col = 0; col < width; col++) {
            const Y = main.Y[yOffset + col];
            let Cb, Cr;
            if ((col & 1) === 1) {
                const k = col >> 1;
                Cb = aux.Y[auxYOffset + k];
                Cr = aux.Y[auxYOffset + halfWidth + k];
            } else if ((row & 1) === 0) {
                const k = col >> 1;
                Cb = main.U[uvOffset + k];
                Cr = main.V[uvOffset + k];
            } else {
                const k = col >> 2;
                if ((col & 2) === 0) {
                    Cb = aux.U[auxUOffset + k];
                    Cr = aux.U[auxUOffset + quarterWidth + k];
                } else {
                    Cb = aux.V[auxVOffset + k];
                    Cr = aux.V[auxVOffset + quarterWidth + k];
                }
            }
            const u = Cb - 128, v = Cr - 128;
            let r, g, b;
            if (main.fullRange) {
                r = (256 * Y + 403 * v + 128) >> 8;
                g = (256 * Y - 48 * u - 120 * v + 128) >> 8;
                b = (256 * Y + 475 * u + 128) >> 8;
            } else {
                const c = Y - 16;
                r = (298 * c + 459 * v + 128) >> 8;
                g = (298 * c - 55 * u - 136 * v + 128) >> 8;
                b = (298 * c + 541 * u + 128) >> 8;
            }
            output[out] = clampByte(b);
            output[out + 1] = clampByte(g);
            output[out + 2] = clampByte(r);
            output[out + 3] = 255;
            out += 4;
        }
    }
    return output;
}

async function copyFrameI420(frame) {
    if (!frame.allocationSize || !frame.copyTo) throw new Error('VideoFrame I420 copyTo is unavailable');
    const options = { format: 'I420' };
    const buffer = new Uint8Array(frame.allocationSize(options));
    const layout = await frame.copyTo(buffer, options);
    if (!Array.isArray(layout) || layout.length < 3) throw new Error('VideoFrame returned invalid I420 layout');
    const width = frame.displayWidth || frame.codedWidth;
    const height = frame.displayHeight || frame.codedHeight;
    const yRows = height, uvRows = Math.ceil(height / 2);
    return {
        width, height,
        Y: buffer.slice(layout[0].offset, layout[0].offset + layout[0].stride * yRows),
        U: buffer.slice(layout[1].offset, layout[1].offset + layout[1].stride * uvRows),
        V: buffer.slice(layout[2].offset, layout[2].offset + layout[2].stride * uvRows),
        yStride: layout[0].stride,
        uStride: layout[1].stride,
        vStride: layout[2].stride,
        fullRange: !!frame.colorSpace?.fullRange,
    };
}

export class RdpAvc444Decoder {
    constructor({ Decoder = globalThis.VideoDecoder, Chunk = globalThis.EncodedVideoChunk, onMainFrame, onCombinedBitmap } = {}) {
        if (!Decoder || !Chunk) throw new Error('WebCodecs VideoDecoder is unavailable');
        this.Decoder = Decoder;
        this.Chunk = Chunk;
        this.onMainFrame = onMainFrame;
        this.onCombinedBitmap = onCombinedBitmap;
        this.states = new Map();
        this.mainPlanes = new Map();
        this.nextToken = 0;
    }

    async decode(event) {
        const surfaceId = Number(event.surfaceId);
        const lc = Number(event.lc);
        if (lc === 0) {
            if (!event.stream1 || !event.stream2) throw new Error('AVC444 LC=0 requires stream1 and stream2');
            const [mainFrame, auxFrame] = await Promise.all([this._submit(surfaceId, 1, event.stream1), this._submit(surfaceId, 2, event.stream2)]);
            try {
                const planes = await copyFrameI420(mainFrame);
                this.mainPlanes.set(surfaceId, planes);
                this.onMainFrame?.(mainFrame, event);
            } finally {
                mainFrame.close?.();
                auxFrame.close?.();
            }
            return;
        }
        if (lc === 1) {
            if (!event.stream1) throw new Error('AVC444 LC=1 requires stream1');
            const mainFrame = await this._submit(surfaceId, 1, event.stream1);
            try {
                const planes = await copyFrameI420(mainFrame);
                this.mainPlanes.set(surfaceId, planes);
                this.onMainFrame?.(mainFrame, event);
            } finally { mainFrame.close?.(); }
            return;
        }
        if (lc === 2) {
            if (!event.stream2) throw new Error('AVC444 LC=2 requires stream2');
            const main = this.mainPlanes.get(surfaceId);
            if (!main) throw new Error(`AVC444 LC=2 has no cached main planes for surface ${surfaceId}`);
            const auxFrame = await this._submit(surfaceId, 2, event.stream2);
            try {
                const aux = await copyFrameI420(auxFrame);
                const width = Number(event.rect?.right) - Number(event.rect?.left) || main.width;
                const height = Number(event.rect?.bottom) - Number(event.rect?.top) || main.height;
                this.onCombinedBitmap?.(combineAvc444Planes(main, aux, width, height), event);
            } finally { auxFrame.close?.(); }
            return;
        }
        throw new Error(`invalid AVC444 LC=${lc}`);
    }

    _submit(surfaceId, role, stream) {
        const state = this._state(surfaceId, role);
        const token = ++this.nextToken;
        return new Promise((resolve, reject) => {
            state.pending.set(token, { resolve, reject });
            try { state.decoder.decode(new this.Chunk({ type: stream.key ? 'key' : 'delta', timestamp: token, data: stream.data })); }
            catch (error) { state.pending.delete(token); reject(error); }
        });
    }

    _state(surfaceId, role) {
        const key = `${surfaceId}:${role}`;
        let state = this.states.get(key);
        if (state) return state;
        const pending = new Map();
        const decoder = new this.Decoder({
            output(frame) {
                const item = pending.get(Number(frame.timestamp));
                pending.delete(Number(frame.timestamp));
                if (item) item.resolve(frame); else frame.close?.();
            },
            error(error) {
                for (const item of pending.values()) item.reject(error);
                pending.clear();
            },
        });
        decoder.configure({ codec: 'avc1.42E01E', optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' });
        state = { decoder, pending };
        this.states.set(key, state);
        return state;
    }

    resetSurface(surfaceId) {
        const prefix = `${Number(surfaceId)}:`;
        for (const [key, state] of this.states) {
            if (!key.startsWith(prefix)) continue;
            try { state.decoder.close(); } catch {}
            for (const item of state.pending.values()) item.reject(new Error('decoder reset'));
            this.states.delete(key);
        }
        this.mainPlanes.delete(Number(surfaceId));
    }

    close() {
        for (const state of this.states.values()) { try { state.decoder.close(); } catch {} }
        this.states.clear();
        this.mainPlanes.clear();
    }
}
