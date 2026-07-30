function hexByte(value) { return Number(value).toString(16).padStart(2, '0').toUpperCase(); }

export function h264CodecFromAnnexB(data, fallback = 'avc1.640033') {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data || 0);
    for (let i = 0; i + 4 < bytes.length; i++) {
        let nal = -1;
        if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) nal = i + 3;
        else if (i + 5 < bytes.length && bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 0 && bytes[i + 3] === 1) nal = i + 4;
        if (nal < 0 || (bytes[nal] & 0x1f) !== 7 || nal + 3 >= bytes.length) continue;
        return `avc1.${hexByte(bytes[nal + 1])}${hexByte(bytes[nal + 2])}${hexByte(bytes[nal + 3])}`;
    }
    return fallback;
}

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
            const codec = h264CodecFromAnnexB(stream.data, state.codec);
            if (codec !== state.codec) {
                if (state.decoder.decodeQueueSize || state.metadata.size > 1) throw new Error(`AVC420 codec changed with pending frames: ${state.codec} -> ${codec}`);
                state.decoder.configure({ codec, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' });
                state.codec = codec;
            }
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
        const codec = 'avc1.640033';
        decoder.configure({ codec, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' });
        state = { decoder, metadata, codec };
        this.decoders.set(key, state);
        return state;
    }

    resetSurface(surfaceId) {
        const prefix = `${Number(surfaceId)}:`;
        for (const [key, state] of this.decoders) {
            if (!key.startsWith(prefix)) continue;
            try { state.decoder.close(); } catch {}
            const error = new Error('decoder reset');
            for (const item of state.metadata.values()) this.onError(error, item.event, item.token);
            state.metadata.clear();
            this.decoders.delete(key);
        }
    }

    close() {
        const error = new Error('decoder closed');
        for (const state of this.decoders.values()) {
            try { state.decoder.close(); } catch {}
            for (const item of state.metadata.values()) this.onError(error, item.event, item.token);
            state.metadata.clear();
        }
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

function planeRegionLooksCorrupt(data, stride, x0, y0, width, height, { low = 72, high = 235 } = {}) {
    if (!data?.length || stride <= 0 || width <= 0 || height <= 0) return false;
    let nearLow = 0, nearHigh = 0, total = 0;
    for (let iy = 1; iy <= 3; iy++) {
        const row = y0 + Math.floor((iy * height) / 4);
        if (row < y0 || row >= y0 + height) continue;
        for (let ix = 1; ix <= 3; ix++) {
            const col = x0 + Math.floor((ix * width) / 4);
            if (col < x0 || col >= x0 + width) continue;
            const value = data[row * stride + col];
            if (!Number.isFinite(value)) continue;
            total++;
            if (value < low) nearLow++;
            else if (value >= high) nearHigh++;
        }
    }
    return total > 0 && (nearLow * 2 > total || nearHigh * 2 > total);
}

export function avc444AuxLooksCorrupt(aux) {
    if (!aux || aux.width < 16 || aux.height < 4) return false;
    const halfWidth = Math.floor(aux.width / 2);
    const quarterWidth = Math.floor(aux.width / 4);
    const uvHeight = Math.ceil(aux.height / 2);
    return planeRegionLooksCorrupt(aux.Y, aux.yStride, 0, 0, halfWidth, aux.height, { low: 20 })
        || planeRegionLooksCorrupt(aux.Y, aux.yStride, halfWidth, 0, halfWidth, aux.height, { low: 20 })
        || planeRegionLooksCorrupt(aux.U, aux.uStride, 0, 0, quarterWidth, uvHeight, { low: 20 })
        || planeRegionLooksCorrupt(aux.V, aux.vStride, 0, 0, quarterWidth, uvHeight, { low: 20 });
}

export function avc444MainLooksCorrupt(main) {
    if (!main || main.width < 16 || main.height < 4) return false;
    const uvHeight = Math.ceil(main.height / 2);
    let nearLow = 0, nearHigh = 0, total = 0;
    for (let iy = 1; iy <= 3; iy++) {
        const row = Math.floor((iy * uvHeight) / 4);
        for (let ix = 1; ix <= 3; ix++) {
            const col = Math.floor((ix * main.uStride) / 4);
            if (row >= uvHeight || col >= main.uStride) continue;
            const u = main.U[row * main.uStride + col];
            const v = main.V[row * main.vStride + Math.min(col, main.vStride - 1)];
            total++;
            if (u < 72 && v < 72) nearLow++;
            else if (u >= 235 && v >= 235) nearHigh++;
        }
    }
    return total > 0 && (nearLow * 2 > total || nearHigh * 2 > total);
}

export function normalizeAvcRegions(regions, width, height) {
    const out = [];
    for (const region of regions || []) {
        const left = Math.max(0, Math.min(width, Math.floor(Number(region?.left) || 0)));
        const top = Math.max(0, Math.min(height, Math.floor(Number(region?.top) || 0)));
        const right = Math.max(left, Math.min(width, Math.ceil(Number(region?.right) || 0)));
        const bottom = Math.max(top, Math.min(height, Math.ceil(Number(region?.bottom) || 0)));
        if (right > left && bottom > top) out.push({ left, top, right, bottom });
    }
    return out;
}

function sampleAuxPair(aux, x, y) {
    const halfWidth = Math.floor(aux.width / 2);
    const quarterWidth = Math.floor(aux.width / 4);
    if ((x & 1) === 1) {
        const k = x >> 1;
        return [aux.Y[y * aux.yStride + k], aux.Y[y * aux.yStride + halfWidth + k]];
    }
    if ((y & 1) === 1) {
        const row = y >> 1;
        const k = x >> 2;
        if ((x & 2) === 0) return [aux.U[row * aux.uStride + k], aux.U[row * aux.uStride + quarterWidth + k]];
        return [aux.V[row * aux.vStride + k], aux.V[row * aux.vStride + quarterWidth + k]];
    }
    return null;
}

export function avc444AuxRegionLooksCorrupt(aux, region) {
    if (!aux || aux.width < 16 || aux.height < 4) return false;
    const [low, high] = [20, 235];
    let nearLow = 0, nearHigh = 0, total = 0;
    for (let iy = 1; iy <= 5; iy++) {
        let y = region.top + Math.floor((iy * (region.bottom - region.top)) / 6);
        y = Math.max(region.top, Math.min(region.bottom - 1, y));
        for (let ix = 1; ix <= 5; ix++) {
            let x = region.left + Math.floor((ix * (region.right - region.left)) / 6);
            x = Math.max(region.left, Math.min(region.right - 1, x));
            // Odd columns always carry auxiliary Cb/Cr in the Y plane.
            let oddX = x | 1;
            if (oddX >= region.right) oddX -= 2;
            if (oddX >= region.left) {
                const pair = sampleAuxPair(aux, oddX, y);
                if (pair && Number.isFinite(pair[0]) && Number.isFinite(pair[1])) {
                    total++;
                    if (pair[0] < low && pair[1] < low) nearLow++;
                    else if (pair[0] >= high && pair[1] >= high) nearHigh++;
                }
            }
            // Even columns on odd rows carry the remaining auxiliary chroma.
            let oddY = y | 1;
            if (oddY >= region.bottom) oddY -= 2;
            const evenX = x & ~1;
            if (oddY >= region.top && evenX >= region.left && evenX < region.right) {
                const pair = sampleAuxPair(aux, evenX, oddY);
                if (pair && Number.isFinite(pair[0]) && Number.isFinite(pair[1])) {
                    total++;
                    if (pair[0] < low && pair[1] < low) nearLow++;
                    else if (pair[0] >= high && pair[1] >= high) nearHigh++;
                }
            }
        }
    }
    return total > 0 && (nearLow * 2 > total || nearHigh * 2 > total);
}

export function filterAvc444Regions(aux, regions, width, height, tileSize = 128) {
    const requested = normalizeAvcRegions(regions, width, height);
    if (!requested.length) return { regions: null, rejected: 0, requested: 0 };
    const valid = [];
    let rejected = 0;
    for (const region of requested) {
        for (let top = region.top; top < region.bottom; top += tileSize) {
            for (let left = region.left; left < region.right; left += tileSize) {
                const tile = {
                    left,
                    top,
                    right: Math.min(region.right, left + tileSize),
                    bottom: Math.min(region.bottom, top + tileSize),
                };
                if (avc444AuxRegionLooksCorrupt(aux, tile)) rejected++;
                else valid.push(tile);
            }
        }
    }
    return { regions: valid, rejected, requested: requested.length };
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
        this.surfaceChains = new Map();
        this.nextToken = 0;
        this.maxMainAgeMs = 500;
    }

    decode(event) {
        const surfaceId = Number(event.surfaceId);
        // Submit compressed chunks immediately. Serialising decode() calls can
        // deadlock codecs that need a later chunk before emitting the current
        // frame. Only the cache/combine stage is ordered per surface.
        const prepared = this._prepare(event);
        const previous = this.surfaceChains.get(surfaceId) || Promise.resolve();
        const current = previous.catch(() => {}).then(async () => this._applyPrepared(await prepared, event));
        this.surfaceChains.set(surfaceId, current);
        current.finally(() => {
            if (this.surfaceChains.get(surfaceId) === current) this.surfaceChains.delete(surfaceId);
        }).catch(() => {});
        return current;
    }

    async _prepare(event) {
        const surfaceId = Number(event.surfaceId);
        const lc = Number(event.lc);
        if (lc === 0) {
            if (!event.stream1 || !event.stream2) throw new Error('AVC444 LC=0 requires stream1 and stream2');
            const [mainFrame, auxFrame] = await Promise.all([this._submit(surfaceId, 1, event.stream1), this._submit(surfaceId, 2, event.stream2)]);
            try {
                // Match the proven Go renderer: LC=0 displays stream1 as the
                // safe 4:2:0 base frame and only feeds stream2 into its decoder
                // to establish the auxiliary DPB. Applying LC=0 auxiliary
                // pixels directly exposes the undefined area outside its dirty
                // regions as large green blocks.
                auxFrame.close?.();
                return { lc, main: await copyFrameI420(mainFrame), mainFrame };
            } catch (error) {
                mainFrame.close?.();
                try { auxFrame.close?.(); } catch {}
                throw error;
            }
        }
        if (lc === 1) {
            if (!event.stream1) throw new Error('AVC444 LC=1 requires stream1');
            const mainFrame = await this._submit(surfaceId, 1, event.stream1);
            try {
                return { lc, main: await copyFrameI420(mainFrame), mainFrame };
            } catch (error) {
                mainFrame.close?.();
                throw error;
            }
        }
        if (lc === 2) {
            if (!event.stream2) throw new Error('AVC444 LC=2 requires stream2');
            const auxFrame = await this._submit(surfaceId, 2, event.stream2);
            try { return { lc, aux: await copyFrameI420(auxFrame) }; }
            finally { auxFrame.close?.(); }
        }
        throw new Error(`invalid AVC444 LC=${lc}`);
    }

    _applyPrepared(prepared, event) {
        const surfaceId = Number(event.surfaceId);
        if (prepared.lc === 0) {
            if (avc444MainLooksCorrupt(prepared.main)) { prepared.mainFrame?.close?.(); return false; }
            prepared.main.updatedAt = performance.now();
            prepared.main.key = !!event.stream1?.key;
            this.mainPlanes.set(surfaceId, prepared.main);
            this.onMainFrame?.(prepared.mainFrame, event);
            return true;
        }
        if (prepared.lc === 1) {
            if (avc444MainLooksCorrupt(prepared.main)) { prepared.mainFrame?.close?.(); return false; }
            prepared.main.updatedAt = performance.now();
            prepared.main.key = !!event.stream1?.key;
            this.mainPlanes.set(surfaceId, prepared.main);
            this.onMainFrame?.(prepared.mainFrame, event);
            return true;
        }
        const main = this.mainPlanes.get(surfaceId);
        if (!main || !Number.isFinite(main.updatedAt) || performance.now() - main.updatedAt > this.maxMainAgeMs) return false;
        if (avc444MainLooksCorrupt(main)) return false;
        const width = Number(event.rect?.right) - Number(event.rect?.left) || main.width;
        const height = Number(event.rect?.bottom) - Number(event.rect?.top) || main.height;
        const filtered = filterAvc444Regions(prepared.aux, event.stream2?.regions, width, height);
        if (filtered.regions && !filtered.regions.length) return false;
        if (!filtered.regions && avc444AuxLooksCorrupt(prepared.aux)) return false;
        this.onCombinedBitmap?.(combineAvc444Planes(main, prepared.aux, width, height), event, filtered.regions, filtered.rejected);
        return true;
    }

    _submit(surfaceId, role, stream) {
        const state = this._state(surfaceId, role);
        const token = ++this.nextToken;
        return new Promise((resolve, reject) => {
            state.pending.set(token, { resolve, reject });
            try {
                const codec = h264CodecFromAnnexB(stream.data, state.codec);
                if (codec !== state.codec) {
                    if (state.decoder.decodeQueueSize || state.pending.size > 1) throw new Error(`AVC444 codec changed with pending frames: ${state.codec} -> ${codec}`);
                    state.decoder.configure({ codec, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' });
                    state.codec = codec;
                }
                state.decoder.decode(new this.Chunk({ type: stream.key ? 'key' : 'delta', timestamp: token, data: stream.data }));
            } catch (error) {
                state.pending.delete(token);
                reject(error);
            }
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
        const codec = 'avc1.640033';
        decoder.configure({ codec, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' });
        state = { decoder, pending, codec };
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
        this.surfaceChains.delete(Number(surfaceId));
    }

    close() {
        const error = new Error('decoder closed');
        for (const state of this.states.values()) {
            try { state.decoder.close(); } catch {}
            for (const item of state.pending.values()) item.reject(error);
            state.pending.clear();
        }
        this.states.clear();
        this.mainPlanes.clear();
        this.surfaceChains.clear();
    }
}
