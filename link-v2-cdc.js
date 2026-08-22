/**
 * Content-defined chunking, keyed chunk IDs, and Merkle manifests for Link v2 blobs.
 *
 * Fixed-size chunks cannot skip unchanged interiors of a large file after an
 * insert. FastCDC-style rolling hash cuts on content, so a prefix insert only
 * perturbs the chunks around the edit. Chunk IDs are HMAC-SHA256(accountKey,
 * chunkBytes) so two accounts with the same file do not share an ID and cannot
 * probe each other's existence.
 */
'use strict';

const crypto = require('crypto');

const GEAR_TABLE = (() => {
    const table = new Uint32Array(256);
    const seed = Buffer.from('zephyr-link-v2-cdc-gear-v1', 'utf8');
    for (let i = 0; i < 256; i += 1) {
        const digest = crypto.createHash('sha256').update(seed).update(Buffer.from([i])).digest();
        table[i] = digest.readUInt32BE(0) | 1;
    }
    return table;
})();

const DEFAULTS = Object.freeze({
    minChunk: 8 * 1024,
    avgChunk: 16 * 1024,
    maxChunk: 64 * 1024,
});

function maskForAvg(avgChunk) {
    let bits = Math.round(Math.log2(avgChunk)) - 1;
    if (!Number.isFinite(bits) || bits < 8) bits = 13;
    if (bits > 20) bits = 20;
    return (1 << bits) - 1;
}

function normalizeOptions(options = {}) {
    const minChunk = Math.max(1024, Number(options.minChunk) || DEFAULTS.minChunk);
    const avgChunk = Math.max(minChunk, Number(options.avgChunk) || DEFAULTS.avgChunk);
    const maxChunk = Math.max(avgChunk, Number(options.maxChunk) || DEFAULTS.maxChunk);
    return { minChunk, avgChunk, maxChunk, mask: maskForAvg(avgChunk) };
}

function rotateLeft(value, bits) {
    return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function chunkBuffer(bytes, options = {}) {
    const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
    const { minChunk, avgChunk, maxChunk } = normalizeOptions(options);
    if (body.length === 0) return [];
    const modulus = Math.max(2, avgChunk - minChunk);
    const chunks = [];
    let start = 0;
    let hash = 0;
    for (let i = 0; i < body.length; i += 1) {
        hash = (rotateLeft(hash, 1) ^ GEAR_TABLE[body[i]]) >>> 0;
        const size = i - start + 1;
        if (size < minChunk) continue;
        if ((hash % modulus) === 0 || size >= maxChunk || i === body.length - 1) {
            chunks.push(body.subarray(start, i + 1));
            start = i + 1;
            hash = 0;
        }
    }
    if (start < body.length) chunks.push(body.subarray(start));
    return chunks;
}

function sha256Hex(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function keyedChunkId(accountKey, chunkBytes) {
    if (!accountKey || !accountKey.length) {
        throw new TypeError('accountKey is required for keyed chunk IDs');
    }
    return crypto.createHmac('sha256', accountKey).update(chunkBytes).digest('hex');
}

function merkleRoot(leaves) {
    if (!Array.isArray(leaves) || leaves.length === 0) {
        return sha256Hex(Buffer.alloc(0));
    }
    let level = leaves.map((leaf) => Buffer.from(String(leaf), 'hex'));
    while (level.length > 1) {
        const next = [];
        for (let i = 0; i < level.length; i += 2) {
            const left = level[i];
            const right = i + 1 < level.length ? level[i + 1] : left;
            next.push(crypto.createHash('sha256').update(left).update(right).digest());
        }
        level = next;
    }
    return level[0].toString('hex');
}

function buildManifest(bytes, { accountKey, options } = {}) {
    const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
    const parts = chunkBuffer(body, options);
    const chunks = parts.map((part, index) => ({
        index,
        size: part.length,
        sha256: sha256Hex(part),
        keyedId: keyedChunkId(accountKey, part),
    }));
    return {
        v: 2,
        algorithm: 'fastcdc-gear-v1',
        size: body.length,
        sha256: sha256Hex(body),
        merkle: merkleRoot(chunks.map((chunk) => chunk.sha256)),
        minChunk: normalizeOptions(options).minChunk,
        avgChunk: normalizeOptions(options).avgChunk,
        maxChunk: normalizeOptions(options).maxChunk,
        chunks,
    };
}

function missingChunks(manifest, knownKeyedIds) {
    const known = knownKeyedIds instanceof Set
        ? knownKeyedIds
        : new Set(knownKeyedIds || []);
    return (manifest.chunks || []).filter((chunk) => !known.has(chunk.keyedId));
}

module.exports = {
    DEFAULTS,
    chunkBuffer,
    sha256Hex,
    keyedChunkId,
    merkleRoot,
    buildManifest,
    missingChunks,
    normalizeOptions,
};
