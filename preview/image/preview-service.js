const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');

const PREVIEW_IMAGE_LIMITS = Object.freeze({
    maxInputBytes: 32 * 1024 * 1024,
    maxInputPixels: 32 * 1024 * 1024,
    maxWidth: 8192,
    maxHeight: 8192,
    maxPages: 1,
    maxFrames: 1,
    maxMetadataBytes: 1024 * 1024,
    maxOutputWidth: 4096,
    maxOutputHeight: 4096,
    inputReadTimeoutMs: 20 * 1000,
    decodeTimeoutMs: 30 * 1000,
});

const HIGH_RISK_IMAGE_FORMATS = new Set(['tiff']);
const EXTENSION_FORMATS = new Map([
    ['jpg', new Set(['jpeg'])],
    ['jpeg', new Set(['jpeg'])],
    ['png', new Set(['png'])],
    ['webp', new Set(['webp'])],
    ['gif', new Set(['gif'])],
    ['avif', new Set(['heif'])],
    ['heic', new Set(['heif'])],
    ['heif', new Set(['heif'])],
    ['tif', new Set(['tiff'])],
    ['tiff', new Set(['tiff'])],
    ['bmp', new Set(['bmp'])],
    ['dib', new Set(['bmp'])],
    ['ico', new Set(['ico'])],
    ['cur', new Set(['ico'])],
    ['icns', new Set(['icns'])],
    ['jp2', new Set(['jp2'])],
    ['j2k', new Set(['jp2'])],
    ['jxl', new Set(['jxl'])],
    ['pnm', new Set(['pnm'])],
    ['pbm', new Set(['pnm'])],
    ['pgm', new Set(['pnm'])],
    ['ppm', new Set(['pnm'])],
    ['pam', new Set(['pnm'])],
]);

const PREVIEW_ERROR_DETAILS = Object.freeze({
    preview_input_too_large: { statusCode: 413, message: 'Image preview exceeds the size limit.' },
    preview_input_timeout: { statusCode: 408, message: 'Image preview timed out.' },
    preview_input_aborted: { statusCode: 408, message: 'Image preview was cancelled.' },
    preview_image_limits: { statusCode: 422, message: 'Image preview exceeds decoder safety limits.' },
    preview_tiff_unsupported: { statusCode: 415, message: 'TIFF previews are not supported.' },
    preview_svg_unsupported: { statusCode: 415, message: 'SVG previews are not supported.' },
    preview_format_mismatch: { statusCode: 415, message: 'Image content does not match its filename.' },
    preview_cache_identity_required: { statusCode: 503, message: 'Image preview is temporarily unavailable.' },
    preview_decoder_unavailable: { statusCode: 503, message: 'Image preview is temporarily unavailable.' },
    preview_decode_failed: { statusCode: 422, message: 'Image preview could not be processed.' },
});

class PreviewResourceError extends Error {
    constructor(code) {
        const detail = PREVIEW_ERROR_DETAILS[code] || PREVIEW_ERROR_DETAILS.preview_decode_failed;
        super(detail.message);
        this.name = 'PreviewResourceError';
        this.code = code in PREVIEW_ERROR_DETAILS ? code : 'preview_decode_failed';
        this.statusCode = detail.statusCode;
        this.publicMessage = detail.message;
    }
}

// sharp ships native addons and is resolved only for an actual conversion.
let sharpLoader;
function loadSharp() {
    if (process.platform === 'android') return null;
    if (sharpLoader === undefined) {
        try { sharpLoader = require('sharp'); } catch { sharpLoader = null; }
    }
    return sharpLoader;
}

function previewError(code) {
    return new PreviewResourceError(code);
}

function asPreviewError(error) {
    if (error instanceof PreviewResourceError) return error;
    // Decoder text is never returned to callers, but known limit failures keep
    // a stable resource-limit response instead of looking like a bad image.
    if (/pixel|dimension|image limit/i.test(String(error?.message || ''))) {
        return previewError('preview_image_limits');
    }
    return previewError('preview_decode_failed');
}

function previewErrorResponse(error) {
    const safe = asPreviewError(error);
    return {
        statusCode: safe.statusCode,
        body: { error: safe.publicMessage, code: safe.code },
    };
}

function getImageExt(filePath = '') {
    const base = String(filePath || '').split(/[\\/]/).pop() || '';
    const idx = base.lastIndexOf('.');
    return idx > -1 ? base.slice(idx + 1).toLowerCase() : '';
}

function safeCacheKey(parts) {
    return cryptoHash(parts).replace(/[^a-f0-9]/gi, '');
}

function cryptoHash(parts) {
    return crypto.createHash('sha256').update(parts.join('\0')).digest('hex');
}

function isBrowserImageExt(ext, browserExts) {
    return browserExts.has(String(ext || '').toLowerCase());
}

function isPreviewImageExt(ext, previewExts) {
    return previewExts.has(String(ext || '').toLowerCase());
}

function getBrowserImageContentType(ext, contentTypes) {
    return contentTypes.get(String(ext || '').toLowerCase()) || 'application/octet-stream';
}

function normalizedExtension(ext) {
    return String(ext || '').trim().toLowerCase();
}

function normalizeCacheIdentity(identity) {
    const normalized = {
        ownerUserId: String(identity?.ownerUserId || '').trim(),
        connectionId: String(identity?.connectionId || '').trim(),
        serverIdentity: String(identity?.serverIdentity || '').trim(),
    };
    if (Object.values(normalized).some((value) => !value || value.length > 512)) {
        throw previewError('preview_cache_identity_required');
    }
    return normalized;
}

function sniffImageBuffer(input) {
    const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input || '');
    if (buffer.length >= 4 && (
        (buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a && buffer[3] === 0x00)
        || (buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && buffer[3] === 0x2a)
        || (buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2b && buffer[3] === 0x00)
        || (buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && buffer[3] === 0x2b)
    )) return 'tiff';
    if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
    if (buffer.length >= 6 && (buffer.subarray(0, 6).equals(Buffer.from('GIF87a')) || buffer.subarray(0, 6).equals(Buffer.from('GIF89a')))) return 'gif';
    if (buffer.length >= 12 && buffer.subarray(0, 4).equals(Buffer.from('RIFF')) && buffer.subarray(8, 12).equals(Buffer.from('WEBP'))) return 'webp';
    if (buffer.length >= 12 && buffer.subarray(4, 8).equals(Buffer.from('ftyp'))) {
        const brand = buffer.subarray(8, 12).toString('ascii').toLowerCase();
        if (brand === 'avif' || brand === 'avis' || brand === 'heic' || brand === 'heix' || brand === 'hevc' || brand === 'hevx') return 'heif';
    }
    const text = buffer.subarray(0, 64 * 1024).toString('utf8').replace(/^\uFEFF/, '').trimStart();
    if (/^(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/i.test(text)) return 'svg';
    return '';
}

async function sniffImageFile(inputPath) {
    let handle = null;
    try {
        handle = await fs.promises.open(inputPath, 'r');
        const buffer = Buffer.alloc(64 * 1024);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        return sniffImageBuffer(buffer.subarray(0, bytesRead));
    } catch (error) {
        throw asPreviewError(error);
    } finally {
        await handle?.close?.().catch(() => {});
    }
}

function assertExpectedImageFormat(ext, metadataFormat, magicFormat) {
    const normalizedExt = normalizedExtension(ext);
    const actualFormat = String(metadataFormat || '').toLowerCase();
    const expectedFormats = EXTENSION_FORMATS.get(normalizedExt);
    if (magicFormat === 'tiff' || actualFormat === 'tiff') throw previewError('preview_tiff_unsupported');
    if (magicFormat === 'svg' || actualFormat === 'svg') throw previewError('preview_svg_unsupported');
    if (!magicFormat || !actualFormat || magicFormat !== actualFormat || !expectedFormats?.has(actualFormat)) {
        throw previewError('preview_format_mismatch');
    }
}

function isVersionedPreviewCacheEntry(key, item) {
    const generation = String(item?.generation || '');
    return item?.key === key
        && generation.length > 0
        && item.ownerToken === generation
        && path.basename(String(item.outputPath || '')) === `${key}.${generation}.webp`;
}

function resolveLimits(overrides = {}) {
    return { ...PREVIEW_IMAGE_LIMITS, ...(overrides || {}) };
}

function assertPreviewSourceSize(sourceSize, limits = PREVIEW_IMAGE_LIMITS) {
    const size = Number(sourceSize);
    if (!Number.isFinite(size) || size < 0) return;
    if (size > limits.maxInputBytes) throw previewError('preview_input_too_large');
}

function metadataByteLength(value) {
    if (Buffer.isBuffer(value)) return value.length;
    if (value instanceof Uint8Array) return value.byteLength;
    if (typeof value === 'string') return Buffer.byteLength(value);
    return 0;
}

function positiveInteger(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function validateImageMetadata(metadata, limits = PREVIEW_IMAGE_LIMITS) {
    const width = positiveInteger(metadata?.width);
    const height = positiveInteger(metadata?.height);
    const pages = metadata?.pages === undefined ? 1 : positiveInteger(metadata.pages);
    const pageHeight = metadata?.pageHeight === undefined ? height : positiveInteger(metadata.pageHeight);
    const frameCount = Array.isArray(metadata?.delay) ? metadata.delay.length : pages;

    if (!width || !height || !pages || !pageHeight || !frameCount) {
        throw previewError('preview_image_limits');
    }
    if (
        width > limits.maxWidth
        || height > limits.maxHeight
        || pageHeight > limits.maxHeight
        || pages > limits.maxPages
        || frameCount > limits.maxFrames
    ) {
        throw previewError('preview_image_limits');
    }
    const framePixels = width * pageHeight;
    const totalPixels = framePixels * pages;
    if (!Number.isSafeInteger(framePixels) || !Number.isSafeInteger(totalPixels)
        || framePixels > limits.maxInputPixels || totalPixels > limits.maxInputPixels) {
        throw previewError('preview_image_limits');
    }

    const metadataBytes = ['exif', 'icc', 'iptc', 'xmp'].reduce(
        (total, field) => total + metadataByteLength(metadata?.[field]),
        0,
    );
    if (!Number.isSafeInteger(metadataBytes) || metadataBytes > limits.maxMetadataBytes) {
        throw previewError('preview_image_limits');
    }
    return { width, height, pages, pageHeight, frameCount };
}

function createLimitedPreviewReadStream(source, {
    maxBytes = PREVIEW_IMAGE_LIMITS.maxInputBytes,
    timeoutMs = PREVIEW_IMAGE_LIMITS.inputReadTimeoutMs,
    signal,
} = {}) {
    if (!source || typeof source.pipe !== 'function') throw previewError('preview_decode_failed');
    let bytesRead = 0;
    let timer = null;
    let stopped = false;
    const limited = new Transform({
        transform(chunk, encoding, callback) {
            const chunkSize = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, encoding);
            bytesRead += chunkSize;
            if (bytesRead > maxBytes) return callback(previewError('preview_input_too_large'));
            return callback(null, chunk);
        },
    });
    const stop = (error) => {
        if (stopped) return;
        stopped = true;
        try { source.destroy(error); } catch {}
        try { limited.destroy(error); } catch {}
    };
    const cleanup = () => {
        if (timer) clearTimeout(timer);
        timer = null;
        signal?.removeEventListener?.('abort', onAbort);
    };
    const onAbort = () => stop(previewError('preview_input_aborted'));
    source.once('error', (error) => {
        if (!limited.destroyed) limited.destroy(error instanceof PreviewResourceError ? error : previewError('preview_decode_failed'));
    });
    limited.once('error', (error) => {
        if (!source.destroyed) source.destroy(error);
    });
    limited.once('close', cleanup);
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(() => stop(previewError('preview_input_timeout')), timeoutMs);
        timer.unref?.();
    }
    if (signal?.aborted) onAbort();
    else signal?.addEventListener?.('abort', onAbort, { once: true });
    return source.pipe(limited);
}

async function writePreviewSourceFile({
    createReadStream,
    inputPath,
    maxBytes = PREVIEW_IMAGE_LIMITS.maxInputBytes,
    timeoutMs = PREVIEW_IMAGE_LIMITS.inputReadTimeoutMs,
    signal,
}) {
    let source = null;
    try {
        source = createReadStream();
        const limited = createLimitedPreviewReadStream(source, { maxBytes, timeoutMs, signal });
        await pipeline(limited, fs.createWriteStream(inputPath, { flags: 'wx', mode: 0o600 }));
        const stats = await fs.promises.stat(inputPath);
        assertPreviewSourceSize(stats.size, { maxInputBytes: maxBytes });
        return stats.size;
    } catch (error) {
        try { source?.destroy?.(); } catch {}
        await fs.promises.unlink(inputPath).catch(() => {});
        throw asPreviewError(error);
    }
}

function withPreviewTimeout(operation, timeoutMs, onTimeout) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const done = (callback, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            callback(value);
        };
        const timer = setTimeout(() => {
            try { onTimeout?.(); } catch {}
            done(reject, previewError('preview_input_timeout'));
        }, timeoutMs);
        timer.unref?.();
        Promise.resolve()
            .then(operation)
            .then((value) => done(resolve, value), (error) => done(reject, error));
    });
}

async function convertImageToWebp(inputPath, outputPath, ext = '', limits = PREVIEW_IMAGE_LIMITS) {
    const sourceExt = normalizedExtension(ext);
    if (sourceExt === 'tif' || sourceExt === 'tiff') {
        throw previewError('preview_tiff_unsupported');
    }
    if (sourceExt === 'svg') throw previewError('preview_svg_unsupported');
    const sharp = loadSharp();
    if (!sharp) throw previewError('preview_decoder_unavailable');

    const configuredLimits = resolveLimits(limits);
    const stagedOutputPath = `${outputPath}.${crypto.randomBytes(12).toString('hex')}.partial`;
    let image = null;
    try {
        const magicFormat = await sniffImageFile(inputPath);
        if (magicFormat === 'tiff') throw previewError('preview_tiff_unsupported');
        if (magicFormat === 'svg') throw previewError('preview_svg_unsupported');
        image = sharp(inputPath, {
            animated: false,
            page: 0,
            pages: 1,
            sequentialRead: true,
            failOn: 'error',
            limitInputPixels: configuredLimits.maxInputPixels,
        });
        const metadata = await withPreviewTimeout(
            () => image.metadata(),
            configuredLimits.decodeTimeoutMs,
            () => image.destroy?.(),
        );
        validateImageMetadata(metadata, configuredLimits);
        if (HIGH_RISK_IMAGE_FORMATS.has(String(metadata.format || '').toLowerCase())) {
            throw previewError('preview_tiff_unsupported');
        }
        assertExpectedImageFormat(sourceExt, metadata.format, magicFormat);
        await withPreviewTimeout(
            () => image
                .rotate()
                .resize({
                    width: configuredLimits.maxOutputWidth,
                    height: configuredLimits.maxOutputHeight,
                    fit: 'inside',
                    withoutEnlargement: true,
                })
                .webp({ quality: 82, effort: 4 })
                .toFile(stagedOutputPath),
            configuredLimits.decodeTimeoutMs,
            () => image.destroy?.(),
        );
        await fs.promises.unlink(outputPath).catch(() => {});
        await fs.promises.rename(stagedOutputPath, outputPath);
        return { engine: 'sharp' };
    } catch (error) {
        try { image?.destroy?.(); } catch {}
        await fs.promises.unlink(stagedOutputPath).catch(() => {});
        throw asPreviewError(error);
    }
}

async function ensurePreviewCacheFile({
    cache,
    cacheMap,
    inFlightMap,
    cacheDir,
    sourcePath,
    sourceSize,
    sourceMtime,
    ext,
    readSourceFile,
    limits,
    cacheIdentity,
}) {
    if (!(cacheMap instanceof Map) || !(inFlightMap instanceof Map)) {
        throw previewError('preview_cache_identity_required');
    }
    const identity = normalizeCacheIdentity(cacheIdentity);
    const configuredLimits = resolveLimits(limits);
    assertPreviewSourceSize(sourceSize, configuredLimits);
    const sourceExt = normalizedExtension(ext);
    if (sourceExt === 'tif' || sourceExt === 'tiff') {
        throw previewError('preview_tiff_unsupported');
    }
    if (sourceExt === 'svg') throw previewError('preview_svg_unsupported');
    const key = safeCacheKey([
        identity.ownerUserId,
        identity.connectionId,
        identity.serverIdentity,
        sourcePath,
        String(sourceSize || 0),
        String(sourceMtime || 0),
        sourceExt,
    ]);
    const now = Date.now();
    const cached = cacheMap.get(key);
    if (isVersionedPreviewCacheEntry(key, cached)
        && cached.expiresAt > now
        && fs.existsSync(cached.outputPath)) {
        cached.expiresAt = now + cache.ttl;
        return { outputPath: cached.outputPath, cached: true, engine: cached.engine || 'cache' };
    }
    const inFlight = inFlightMap.get(key);
    if (inFlight?.promise) return inFlight.promise;

    const ownerToken = crypto.randomBytes(18).toString('hex');
    const generation = ownerToken;
    const outputPath = path.join(cacheDir, `${key}.${generation}.webp`);
    const safeExt = /^[a-z0-9]{1,16}$/.test(sourceExt) ? sourceExt : 'img';
    const task = (async () => {
        await fs.promises.mkdir(cacheDir, { recursive: true });
        const inputPath = path.join(cacheDir, `${key}.${ownerToken}.source.${safeExt}`);
        const controller = new AbortController();
        try {
            await withPreviewTimeout(
                () => readSourceFile(inputPath, {
                    maxBytes: configuredLimits.maxInputBytes,
                    timeoutMs: configuredLimits.inputReadTimeoutMs,
                    signal: controller.signal,
                }),
                configuredLimits.inputReadTimeoutMs,
                () => controller.abort(),
            );
            const inputStats = await fs.promises.stat(inputPath);
            assertPreviewSourceSize(inputStats.size, configuredLimits);
            const result = await convertImageToWebp(inputPath, outputPath, sourceExt, configuredLimits);
            cacheMap.set(key, {
                key,
                outputPath,
                engine: result.engine,
                expiresAt: now + cache.ttl,
                ownerToken,
                generation,
            });
            return { outputPath, cached: false, engine: result.engine };
        } catch (error) {
            const ownedCache = cacheMap.get(key);
            if (ownedCache?.ownerToken === ownerToken) {
                cacheMap.delete(key);
                await fs.promises.unlink(outputPath).catch(() => {});
            }
            throw asPreviewError(error);
        } finally {
            controller.abort();
            await fs.promises.unlink(inputPath).catch(() => {});
        }
    })();
    inFlightMap.set(key, { ownerToken, promise: task });
    try {
        return await task;
    } finally {
        if (inFlightMap.get(key)?.ownerToken === ownerToken) inFlightMap.delete(key);
    }
}

function cleanupPreviewCache(cacheMap, { unlink = (filePath) => fs.promises.unlink(filePath) } = {}) {
    const now = Date.now();
    const removals = [];
    for (const [key, item] of cacheMap.entries()) {
        if (item.expiresAt > now) continue;
        // Compare the exact entry before retiring it. A newer generation under
        // the same key must remain live even if this cleanup runs late.
        if (cacheMap.get(key) !== item) continue;
        cacheMap.delete(key);
        if (isVersionedPreviewCacheEntry(key, item)) {
            removals.push(Promise.resolve(unlink(item.outputPath)).catch(() => {}));
        }
    }
    return Promise.all(removals).then(() => undefined);
}

module.exports = {
    PREVIEW_IMAGE_LIMITS,
    PreviewResourceError,
    getImageExt,
    isBrowserImageExt,
    isPreviewImageExt,
    getBrowserImageContentType,
    assertPreviewSourceSize,
    sniffImageBuffer,
    createLimitedPreviewReadStream,
    writePreviewSourceFile,
    validateImageMetadata,
    convertImageToWebp,
    ensurePreviewCacheFile,
    cleanupPreviewCache,
    previewErrorResponse,
};
