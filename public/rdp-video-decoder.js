function hexByte(value) { return Number(value).toString(16).padStart(2, '0').toUpperCase(); }

function recoverableVideoError(code, detail = '') {
    const error = new Error(detail ? `${code}: ${detail}` : code);
    error.code = code;
    error.recoverable = true;
    return error;
}

// Sparse RGBA inspection for field diagnostics. This deliberately samples a
// clone of an occasional decoded frame; the hot WebGL VideoFrame upload path
// remains zero-copy. A large number of near-solid green rows is the signature
// of an orphaned MS-RDPEVOR chroma-key surface, while a clean copyTo result
// paired with a green canvas points at the GPU import/compositor instead.
export async function inspectVideoFrameGreen(frame, { sampleStep = 4 } = {}) {
    if (!frame || typeof frame.copyTo !== 'function') throw new Error('VideoFrame.copyTo is unavailable');
    const width = Math.max(1, Math.trunc(Number(frame.displayWidth || frame.codedWidth || 0)));
    const height = Math.max(1, Math.trunc(Number(frame.displayHeight || frame.codedHeight || 0)));
    const options = { format: 'RGBA' };
    const size = typeof frame.allocationSize === 'function'
        ? Number(frame.allocationSize(options))
        : width * height * 4;
    if (!Number.isFinite(size) || size < width * height * 4) throw new Error(`invalid RGBA allocation size ${size}`);
    const pixels = new Uint8Array(size);
    const layouts = await frame.copyTo(pixels, options);
    const layout = layouts?.[0] || {};
    const offset = Math.max(0, Math.trunc(Number(layout.offset) || 0));
    const stride = Math.max(width * 4, Math.trunc(Number(layout.stride) || width * 4));
    const step = Math.max(1, Math.trunc(Number(sampleStep) || 1));
    let samples = 0;
    let keyGreen = 0;
    let solidGreenRows = 0;
    let maxGreenPermille = 0;
    for (let y = 0; y < height; y += step) {
        let rowSamples = 0;
        let rowGreen = 0;
        for (let x = 0; x < width; x += step) {
            const i = offset + y * stride + x * 4;
            const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
            if (![r, g, b].every(Number.isFinite)) continue;
            rowSamples++;
            samples++;
            // Windows VOR uses a dark, nearly pure green key. Keep this much
            // stricter than ordinary "green dominant" content so forests and
            // UI accents do not look like protocol failures.
            if (r <= 48 && b <= 48 && g >= 64 && g >= r + 32 && g >= b + 32) {
                rowGreen++;
                keyGreen++;
            }
        }
        const permille = rowSamples ? Math.round((rowGreen * 1000) / rowSamples) : 0;
        maxGreenPermille = Math.max(maxGreenPermille, permille);
        if (rowSamples >= 8 && permille >= 750) solidGreenRows++;
    }
    return { width, height, samples, keyGreen, solidGreenRows, maxGreenPermille };
}

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
    constructor({ Decoder = globalThis.VideoDecoder, Chunk = globalThis.EncodedVideoChunk, onFrame, onError = () => {}, maxQueue = 64, outputTimeoutMs = 750 } = {}) {
        if (!Decoder || !Chunk) throw new Error('WebCodecs VideoDecoder is unavailable');
        this.Decoder = Decoder;
        this.Chunk = Chunk;
        this.onFrame = onFrame;
        this.onError = onError;
        this.maxQueue = maxQueue;
        this.outputTimeoutMs = Math.max(0, Number(outputTimeoutMs) || 0);
        this.decoders = new Map();
        this.waitingForKey = new Set();
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
        const surfaceId = Number(event.surfaceId);
        if (this.waitingForKey.has(surfaceId)) {
            if (!stream.key) throw recoverableVideoError('AVC420_WAITING_FOR_KEYFRAME');
            this.waitingForKey.delete(surfaceId);
        }
        const key = `${surfaceId}:1`;
        const state = this._state(key, surfaceId);
        if (state.decoder.decodeQueueSize >= this.maxQueue) {
            // Never drop a reference-bearing chunk. Fail explicitly so the
            // caller can apply RDPGFX backpressure/recovery.
            throw recoverableVideoError('AVC420_QUEUE_SATURATED', `decode queue exceeded ${this.maxQueue}`);
        }
        const token = ++this.nextToken;
        const item = { event, token, timer: null };
        state.metadata.set(token, item);
        if (this.outputTimeoutMs > 0) {
            item.timer = setTimeout(() => {
                if (!state.metadata.delete(token)) return;
                this.onError(recoverableVideoError('AVC420_OUTPUT_TIMEOUT', `decoder produced no frame for ${this.outputTimeoutMs}ms`), event, token);
            }, this.outputTimeoutMs);
            item.timer?.unref?.();
        }
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
            if (item.timer != null) clearTimeout(item.timer);
            throw error;
        }
        return token;
    }

    _state(key, surfaceId) {
        let state = this.decoders.get(key);
        if (state) return state;
        const metadata = new Map();
        const decoder = new this.Decoder({
            output: (frame) => {
                const outputToken = Number(frame.timestamp);
                // WebCodecs may consume an EncodedVideoChunk without emitting
                // a VideoFrame. Retire older unresolved inputs as soon as a
                // later timestamp appears; otherwise one missing output blocks
                // the ordered compositor queue forever.
                for (const [token, pending] of metadata) {
                    if (token >= outputToken) break;
                    metadata.delete(token);
                    if (pending.timer != null) clearTimeout(pending.timer);
                    this.onError(recoverableVideoError('AVC420_OUTPUT_DROPPED', `decoder advanced from ${token} to ${outputToken}`), pending.event, pending.token);
                }
                const item = metadata.get(outputToken);
                metadata.delete(outputToken);
                if (!item) { frame.close?.(); return; }
                if (item.timer != null) clearTimeout(item.timer);
                this.onFrame?.(frame, item.event, item.token);
            },
            error: (error) => {
                const items = [...metadata.values()];
                metadata.clear();
                this.decoders.delete(key);
                this.waitingForKey.add(surfaceId);
                const recoverable = recoverableVideoError('AVC420_DECODER_ERROR', error?.message || String(error));
                for (const item of items) {
                    if (item.timer != null) clearTimeout(item.timer);
                    this.onError(recoverable, item.event, item.token);
                }
            },
        });
        const codec = 'avc1.640033';
        decoder.configure({ codec, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' });
        state = { decoder, metadata, codec };
        this.decoders.set(key, state);
        return state;
    }

    resetSurface(surfaceId) {
        const id = Number(surfaceId);
        this.waitingForKey.delete(id);
        const prefix = `${id}:`;
        for (const [key, state] of this.decoders) {
            if (!key.startsWith(prefix)) continue;
            try { state.decoder.close(); } catch {}
            const error = new Error('decoder reset');
            for (const item of state.metadata.values()) {
                if (item.timer != null) clearTimeout(item.timer);
                this.onError(error, item.event, item.token);
            }
            state.metadata.clear();
            this.decoders.delete(key);
        }
    }

    recoverSurface(surfaceId) {
        const id = Number(surfaceId);
        this.resetSurface(id);
        this.waitingForKey.add(id);
    }

    close() {
        const error = new Error('decoder closed');
        for (const state of this.decoders.values()) {
            try { state.decoder.close(); } catch {}
            for (const item of state.metadata.values()) {
                if (item.timer != null) clearTimeout(item.timer);
                this.onError(error, item.event, item.token);
            }
            state.metadata.clear();
        }
        this.decoders.clear();
        this.waitingForKey.clear();
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

function cloneI420Planes(planes) {
    if (!planes) return null;
    return {
        ...planes,
        Y: planes.Y?.slice?.() || planes.Y,
        U: planes.U?.slice?.() || planes.U,
        V: planes.V?.slice?.() || planes.V,
    };
}

export class RdpAvc444Decoder {
    constructor({ Decoder = globalThis.VideoDecoder, Chunk = globalThis.EncodedVideoChunk, onMainFrame, onCombinedBitmap, maxQueue = 64 } = {}) {
        if (!Decoder || !Chunk) throw new Error('WebCodecs VideoDecoder is unavailable');
        this.Decoder = Decoder;
        this.Chunk = Chunk;
        this.onMainFrame = onMainFrame;
        this.onCombinedBitmap = onCombinedBitmap;
        this.maxQueue = maxQueue;
        this.states = new Map();
        this.waitingForKey = new Set();
        this.mainPlanes = new Map();
        // A stream2 IDR belongs with the main-stream IDR, not with a newer
        // stream1 delta that may have arrived while the auxiliary decoder was
        // producing output. Keep an immutable IDR snapshot per surface.
        this.idrMainPlanes = new Map();
        this.surfaceChains = new Map();
        this.surfaceGenerations = new Map();
        this.nextToken = 0;
        this.maxMainAgeMs = 500;
        this.closed = false;
    }

    decode(event) {
        if (this.closed) throw new Error('AVC444 decoder is closed');
        const surfaceId = Number(event.surfaceId);
        const generation = this.surfaceGenerations.get(surfaceId) || 0;
        // Submit compressed chunks immediately. Serialising decode() calls can
        // deadlock codecs that need a later chunk before emitting the current
        // frame. Only the cache/combine stage is ordered per surface.
        const prepared = this._prepare(event);
        const previous = this.surfaceChains.get(surfaceId) || Promise.resolve();
        const current = previous.catch(() => {}).then(async () => {
            const value = await prepared;
            // ResetGraphics and DELETE_SURFACE invalidate every in-flight decode
            // for that surface. Closing VideoDecoder rejects chunks that have not
            // produced output yet, but a frame may already be inside copyTo() or
            // waiting behind the ordered surface chain. Never let such a frame
            // repopulate mainPlanes for a newly-created surface with the same id.
            if (this.closed || generation !== (this.surfaceGenerations.get(surfaceId) || 0)) {
                this._disposePrepared(value);
                return false;
            }
            return this._applyPrepared(value, event);
        });
        this.surfaceChains.set(surfaceId, current);
        current.finally(() => {
            if (this.surfaceChains.get(surfaceId) === current) this.surfaceChains.delete(surfaceId);
        }).catch(() => {});
        return current;
    }

    _disposePrepared(prepared) {
        try { prepared?.mainFrame?.close?.(); } catch {}
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
            if (prepared.main.key) this.idrMainPlanes.set(surfaceId, cloneI420Planes(prepared.main));
            this.onMainFrame?.(prepared.mainFrame, event);
            return true;
        }
        if (prepared.lc === 1) {
            if (avc444MainLooksCorrupt(prepared.main)) { prepared.mainFrame?.close?.(); return false; }
            prepared.main.updatedAt = performance.now();
            prepared.main.key = !!event.stream1?.key;
            this.mainPlanes.set(surfaceId, prepared.main);
            if (prepared.main.key) this.idrMainPlanes.set(surfaceId, cloneI420Planes(prepared.main));
            this.onMainFrame?.(prepared.mainFrame, event);
            return true;
        }
        const auxiliaryIsIdr = !!event.stream2?.key;
        const main = auxiliaryIsIdr ? this.idrMainPlanes.get(surfaceId) : this.mainPlanes.get(surfaceId);
        if (!main || !Number.isFinite(main.updatedAt)) return false;
        if (!auxiliaryIsIdr && performance.now() - main.updatedAt > this.maxMainAgeMs) return false;
        if (avc444MainLooksCorrupt(main)) return false;
        const width = Number(event.rect?.right) - Number(event.rect?.left) || main.width;
        const height = Number(event.rect?.bottom) - Number(event.rect?.top) || main.height;
        const filtered = filterAvc444Regions(prepared.aux, event.stream2?.regions, width, height);
        // Never apply only the accepted subset of an AVC444 update. That
        // produces a visible quilt of fresh and stale chroma. Preserve the
        // previous complete surface and request a fresh reference frame.
        if (filtered.rejected > 0) {
            event.__avc444RejectedRegions = filtered.rejected;
            return false;
        }
        if (filtered.regions && !filtered.regions.length) return false;
        if (!filtered.regions && avc444AuxLooksCorrupt(prepared.aux)) return false;
        this.onCombinedBitmap?.(combineAvc444Planes(main, prepared.aux, width, height), event, filtered.regions, filtered.rejected);
        return true;
    }

    _submit(surfaceId, role, stream) {
        const key = `${surfaceId}:${role}`;
        if (this.waitingForKey.has(key)) {
            if (!stream.key) return Promise.reject(recoverableVideoError('AVC444_WAITING_FOR_KEYFRAME', `surface ${surfaceId} stream ${role}`));
            this.waitingForKey.delete(key);
        }
        const state = this._state(surfaceId, role);
        if (state.decoder.decodeQueueSize >= this.maxQueue) {
            const error = recoverableVideoError('AVC444_QUEUE_SATURATED', `surface ${surfaceId} stream ${role} exceeded ${this.maxQueue}`);
            this._recoverState(surfaceId, role, error);
            return Promise.reject(error);
        }
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
            error: (error) => {
                const items = [...pending.values()];
                pending.clear();
                this.states.delete(key);
                this.waitingForKey.add(key);
                const recoverable = recoverableVideoError('AVC444_DECODER_ERROR', error?.message || String(error));
                for (const item of items) item.reject(recoverable);
            },
        });
        const codec = 'avc1.640033';
        decoder.configure({ codec, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' });
        state = { decoder, pending, codec };
        this.states.set(key, state);
        return state;
    }

    _recoverState(surfaceId, role, error) {
        const key = `${surfaceId}:${role}`;
        const state = this.states.get(key);
        if (state) {
            try { state.decoder.close(); } catch {}
            const items = [...state.pending.values()];
            state.pending.clear();
            this.states.delete(key);
            for (const item of items) item.reject(error);
        }
        this.waitingForKey.add(key);
    }

    resetSurface(surfaceId) {
        const id = Number(surfaceId);
        this.surfaceGenerations.set(id, (this.surfaceGenerations.get(id) || 0) + 1);
        const prefix = `${id}:`;
        for (const key of this.waitingForKey) {
            if (key.startsWith(prefix)) this.waitingForKey.delete(key);
        }
        for (const [key, state] of this.states) {
            if (!key.startsWith(prefix)) continue;
            try { state.decoder.close(); } catch {}
            for (const item of state.pending.values()) item.reject(new Error('decoder reset'));
            state.pending.clear();
            this.states.delete(key);
        }
        this.mainPlanes.delete(id);
        this.idrMainPlanes.delete(id);
        this.surfaceChains.delete(id);
    }

    close() {
        this.closed = true;
        const error = new Error('decoder closed');
        for (const state of this.states.values()) {
            try { state.decoder.close(); } catch {}
            for (const item of state.pending.values()) item.reject(error);
            state.pending.clear();
        }
        this.states.clear();
        this.waitingForKey.clear();
        this.mainPlanes.clear();
        this.idrMainPlanes.clear();
        this.surfaceChains.clear();
        this.surfaceGenerations.clear();
    }
}
