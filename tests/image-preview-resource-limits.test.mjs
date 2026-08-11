import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import test from 'node:test';

const require = createRequire(import.meta.url);
const sharp = require('sharp');
const {
    PREVIEW_IMAGE_LIMITS,
    PreviewResourceError,
    cleanupPreviewCache,
    convertImageToWebp,
    ensurePreviewCacheFile,
    previewErrorResponse,
    validateImageMetadata,
    writePreviewSourceFile,
} = require('../preview/image/preview-service');

async function temporaryDirectory(t) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'zephyr-preview-test-'));
    t.after(async () => {
        for (let attempt = 0; attempt < 4; attempt += 1) {
            try {
                await rm(directory, { recursive: true, force: true });
                return;
            } catch (error) {
                if (error?.code !== 'EBUSY' || attempt === 3) return;
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
        }
    });
    return directory;
}

function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
    const kind = Buffer.from(type, 'ascii');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([kind, data])));
    return Buffer.concat([length, kind, data, crc]);
}

// A tiny file that claims to decode to 100,000 x 100,000 pixels.
function compressedPixelBombPng() {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(100000, 0);
    header.writeUInt32BE(100000, 4);
    header[8] = 8;
    header[9] = 2;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', header),
        pngChunk('IDAT', Buffer.from([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01])),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
}

function cacheIdentity(ownerUserId = 'user-a', connectionId = 'connection-a', serverIdentity = 'SSH|host-a.example|22|alice') {
    return { ownerUserId, connectionId, serverIdentity };
}

function cacheRequest(directory, overrides = {}) {
    return {
        cache: { ttl: 1000 },
        cacheMap: new Map(),
        inFlightMap: new Map(),
        cacheDir: directory,
        sourcePath: '/remote/preview.png',
        sourceSize: 128,
        sourceMtime: 1,
        ext: 'png',
        cacheIdentity: cacheIdentity(),
        readSourceFile: async () => {},
        ...overrides,
    };
}

test('converts ordinary PNG, JPEG, and WebP previews within bounded output dimensions', async (t) => {
    const directory = await temporaryDirectory(t);
    const source = sharp({
        create: { width: 32, height: 24, channels: 3, background: { r: 48, g: 96, b: 144 } },
    });
    for (const extension of ['png', 'jpeg', 'webp']) {
        const input = path.join(directory, `normal.${extension}`);
        const output = path.join(directory, `normal.${extension}.webp`);
        await source.clone().toFormat(extension).toFile(input);

        const result = await convertImageToWebp(input, output, extension);
        const outputMetadata = await sharp(output).metadata();
        assert.equal(result.engine, 'sharp');
        assert.equal(outputMetadata.format, 'webp');
        assert.ok(outputMetadata.width <= PREVIEW_IMAGE_LIMITS.maxOutputWidth);
        assert.ok(outputMetadata.height <= PREVIEW_IMAGE_LIMITS.maxOutputHeight);
    }
});

test('rejects a tiny compressed pixel bomb before producing a cache artifact', async (t) => {
    const directory = await temporaryDirectory(t);
    const input = path.join(directory, 'bomb.png');
    const output = path.join(directory, 'bomb.webp');
    await writeFile(input, compressedPixelBombPng());

    await assert.rejects(
        convertImageToWebp(input, output, 'png'),
        (error) => error instanceof PreviewResourceError
            && ['preview_image_limits', 'preview_decode_failed'].includes(error.code),
    );
    assert.equal(existsSync(output), false);
});

test('rejects TIFF before reading or passing it to a decoder', async (t) => {
    const directory = await temporaryDirectory(t);
    let readAttempted = false;
    await assert.rejects(
        ensurePreviewCacheFile(cacheRequest(directory, {
            sourcePath: '/remote/huge-pixels.tiff',
            sourceSize: 96,
            sourceMtime: 1,
            ext: 'tiff',
            readSourceFile: async () => { readAttempted = true; },
        })),
        (error) => error instanceof PreviewResourceError && error.code === 'preview_tiff_unsupported',
    );
    assert.equal(readAttempted, false);
});

test('rejects multi-page metadata and oversized sources without caching a partial preview', async (t) => {
    const directory = await temporaryDirectory(t);
    assert.throws(
        () => validateImageMetadata({ width: 16, height: 32, pageHeight: 16, pages: 2, delay: [0, 0] }),
        (error) => error instanceof PreviewResourceError && error.code === 'preview_image_limits',
    );

    let readAttempted = false;
    await assert.rejects(
        ensurePreviewCacheFile(cacheRequest(directory, {
            sourcePath: '/remote/oversize.png',
            sourceSize: PREVIEW_IMAGE_LIMITS.maxInputBytes + 1,
            sourceMtime: 1,
            ext: 'png',
            readSourceFile: async () => { readAttempted = true; },
        })),
        (error) => error instanceof PreviewResourceError && error.code === 'preview_input_too_large',
    );
    assert.equal(readAttempted, false);
});

test('bounded source reads abort and remove partial downloads', async (t) => {
    const directory = await temporaryDirectory(t);
    const input = path.join(directory, 'partial.source');
    await assert.rejects(
        writePreviewSourceFile({
            createReadStream: () => Readable.from([Buffer.from('1234')]),
            inputPath: input,
            maxBytes: 3,
            timeoutMs: 1000,
        }),
        (error) => error instanceof PreviewResourceError && error.code === 'preview_input_too_large',
    );
    assert.equal(existsSync(input), false);
});

test('timed-out source streams are destroyed and leave no partial download', async (t) => {
    const directory = await temporaryDirectory(t);
    const input = path.join(directory, 'timed-out.source');
    let closed = false;
    const keepProcessAlive = setInterval(() => {}, 1000);
    const source = new Readable({ read() {} });
    source.once('close', () => {
        closed = true;
        clearInterval(keepProcessAlive);
    });
    try {
        await assert.rejects(
            writePreviewSourceFile({
                createReadStream: () => source,
                inputPath: input,
                maxBytes: 1024,
                timeoutMs: 20,
            }),
            (error) => error instanceof PreviewResourceError && error.code === 'preview_input_timeout',
        );
    } finally {
        clearInterval(keepProcessAlive);
    }
    assert.equal(closed, true);
    assert.equal(existsSync(input), false);
});

test('cache identity is mandatory before an image source is read', async (t) => {
    const directory = await temporaryDirectory(t);
    let readAttempted = false;
    await assert.rejects(
        ensurePreviewCacheFile(cacheRequest(directory, {
            cacheIdentity: null,
            readSourceFile: async () => { readAttempted = true; },
        })),
        (error) => error instanceof PreviewResourceError && error.code === 'preview_cache_identity_required',
    );
    assert.equal(readAttempted, false);
});

test('cache entries isolate identical paths across users and remote servers', async (t) => {
    const directory = await temporaryDirectory(t);
    const source = await sharp({
        create: { width: 12, height: 8, channels: 3, background: { r: 32, g: 96, b: 160 } },
    }).png().toBuffer();
    const cacheMap = new Map();
    const inFlightMap = new Map();
    const identities = [
        cacheIdentity('user-a', 'connection-a', 'SSH|host-a.example|22|alice'),
        cacheIdentity('user-a', 'connection-b', 'SSH|host-b.example|22|alice'),
        cacheIdentity('user-b', 'connection-a', 'SSH|host-a.example|22|alice'),
        cacheIdentity('user-b', 'connection-b', 'SSH|host-b.example|22|alice'),
    ];
    const previews = [];
    for (const identity of identities) {
        previews.push(await ensurePreviewCacheFile(cacheRequest(directory, {
            cacheMap,
            inFlightMap,
            cacheIdentity: identity,
            sourceSize: source.length,
            readSourceFile: (inputPath) => writeFile(inputPath, source),
        })));
    }
    assert.equal(new Set(previews.map((preview) => preview.outputPath)).size, 4);
    assert.equal(cacheMap.size, 4);
    assert.equal(inFlightMap.size, 0);
    for (const preview of previews) assert.equal(existsSync(preview.outputPath), true);
});

test('singleflight shares one winner and a concurrent failing contender cannot remove it', async (t) => {
    const directory = await temporaryDirectory(t);
    const source = await sharp({
        create: { width: 10, height: 10, channels: 3, background: { r: 48, g: 80, b: 112 } },
    }).png().toBuffer();
    const cacheMap = new Map();
    const inFlightMap = new Map();
    const identity = cacheIdentity();
    let readCount = 0;
    const winner = ensurePreviewCacheFile(cacheRequest(directory, {
        cacheMap,
        inFlightMap,
        cacheIdentity: identity,
        sourceSize: source.length,
        readSourceFile: async (inputPath) => {
            readCount += 1;
            await new Promise((resolve) => setTimeout(resolve, 20));
            await writeFile(inputPath, source);
        },
    }));
    const contender = ensurePreviewCacheFile(cacheRequest(directory, {
        cacheMap,
        inFlightMap,
        cacheIdentity: identity,
        sourceSize: source.length,
        readSourceFile: async () => { throw new Error('concurrent contender must not read'); },
    }));
    const [first, second] = await Promise.all([winner, contender]);
    assert.equal(readCount, 1);
    assert.equal(first.outputPath, second.outputPath);
    assert.equal(existsSync(first.outputPath), true);
    assert.equal(cacheMap.size, 1);
    assert.equal(inFlightMap.size, 0);
});

test('a failing cache owner cannot remove a concurrent winner it does not own', async (t) => {
    const directory = await temporaryDirectory(t);
    const cacheMap = new Map();
    const inFlightMap = new Map();
    let rejectRead;
    let readStarted = false;
    const failing = ensurePreviewCacheFile(cacheRequest(directory, {
        cacheMap,
        inFlightMap,
        readSourceFile: () => new Promise((resolve, reject) => {
            readStarted = true;
            rejectRead = reject;
        }),
    }));
    for (let attempt = 0; attempt < 20 && !readStarted; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.equal(readStarted, true);
    const [key] = inFlightMap.keys();
    const winningOutput = path.join(directory, `${key}.webp`);
    await writeFile(winningOutput, Buffer.from('winner'));
    cacheMap.set(key, { outputPath: winningOutput, engine: 'sharp', expiresAt: Date.now() + 1000, ownerToken: 'winner' });
    rejectRead(new Error('losing decoder'));

    await assert.rejects(failing, (error) => error instanceof PreviewResourceError);
    assert.equal(cacheMap.get(key)?.ownerToken, 'winner');
    assert.equal(existsSync(winningOutput), true);
});

test('late expiry cleanup cannot unlink a rebuilt generation for the same cache key', async (t) => {
    const directory = await temporaryDirectory(t);
    const source = await sharp({
        create: { width: 9, height: 7, channels: 3, background: { r: 96, g: 48, b: 16 } },
    }).png().toBuffer();
    const cacheMap = new Map();
    const inFlightMap = new Map();
    const request = {
        cacheMap,
        inFlightMap,
        sourceSize: source.length,
        readSourceFile: (inputPath) => writeFile(inputPath, source),
    };
    const oldPreview = await ensurePreviewCacheFile(cacheRequest(directory, request));
    const oldEntry = [...cacheMap.values()][0];
    oldEntry.expiresAt = 0;

    let releaseOldUnlink;
    let oldUnlinkStarted;
    const oldUnlinkBarrier = new Promise((resolve) => { releaseOldUnlink = resolve; });
    const oldUnlinkStartedBarrier = new Promise((resolve) => { oldUnlinkStarted = resolve; });
    const cleanup = cleanupPreviewCache(cacheMap, {
        unlink: async (filePath) => {
            oldUnlinkStarted(filePath);
            await oldUnlinkBarrier;
            await rm(filePath, { force: true });
        },
    });
    const retiredPath = await oldUnlinkStartedBarrier;
    assert.equal(retiredPath, oldPreview.outputPath);
    assert.equal(cacheMap.size, 0);

    const rebuiltPreview = await ensurePreviewCacheFile(cacheRequest(directory, request));
    assert.notEqual(rebuiltPreview.outputPath, oldPreview.outputPath);
    assert.equal(existsSync(rebuiltPreview.outputPath), true);

    let duplicateUnlinks = 0;
    await cleanupPreviewCache(cacheMap, { unlink: async () => { duplicateUnlinks += 1; } });
    assert.equal(duplicateUnlinks, 0);

    releaseOldUnlink();
    await cleanup;
    assert.equal(existsSync(rebuiltPreview.outputPath), true);
});

test('rejects TIFF magic disguised as PNG and ordinary extension mismatches', async (t) => {
    const directory = await temporaryDirectory(t);
    const fakeTiff = path.join(directory, 'masquerading.png');
    const fakeTiffOutput = path.join(directory, 'masquerading.webp');
    await writeFile(fakeTiff, Buffer.from([0x49, 0x49, 0x2a, 0x00]));
    await assert.rejects(
        convertImageToWebp(fakeTiff, fakeTiffOutput, 'png'),
        (error) => error instanceof PreviewResourceError && error.code === 'preview_tiff_unsupported',
    );

    const jpegNamedPng = path.join(directory, 'mismatch.png');
    await sharp({
        create: { width: 4, height: 4, channels: 3, background: { r: 255, g: 0, b: 0 } },
    }).jpeg().toFile(jpegNamedPng);
    await assert.rejects(
        convertImageToWebp(jpegNamedPng, path.join(directory, 'mismatch.webp'), 'png'),
        (error) => error instanceof PreviewResourceError && error.code === 'preview_format_mismatch',
    );
});

test('safe preview errors never echo a path or decoder failure', async () => {
    const response = previewErrorResponse(new Error('/private/path.tiff: decoder exploded'));
    assert.equal(response.statusCode, 422);
    assert.equal(response.body.code, 'preview_decode_failed');
    assert.equal(JSON.stringify(response.body).includes('/private/path.tiff'), false);
    assert.equal(JSON.stringify(response.body).includes('decoder exploded'), false);
});
