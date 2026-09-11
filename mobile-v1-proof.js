/**
 * Canonical request binding for the mobile v1 device-proof protocol.
 *
 * The server issues the nonce and timestamp. A device signs the exact values
 * returned by the challenge endpoint; the request handler independently
 * derives the path, body digest and usage before consuming that challenge.
 */
'use strict';

const crypto = require('crypto');

const PROOF_VERSION = 'zephyr-one-device-proof-v2';
const PROOF_ALGORITHM = 'ES256';
const PROOF_SIGNATURE_BYTES = 64;
const EMPTY_BODY_SHA256 = crypto.createHash('sha256').update(Buffer.alloc(0)).digest('base64');

function bodySha256(bytes) {
    return crypto.createHash('sha256').update(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || '')).digest('base64');
}

function decodeSha256(value) {
    const encoded = String(value || '').trim();
    if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) return null;
    const decoded = Buffer.from(encoded, 'base64');
    if (decoded.length !== 32 || decoded.toString('base64') !== encoded) return null;
    return decoded;
}

/**
 * Canonical origin-form target: normalised encoded path and sorted query
 * pairs. Fragments, credentials and absolute/network-path targets are refused.
 */
function canonicalPath(value) {
    const raw = String(value || '');
    if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('#')) return null;
    let parsed;
    try {
        parsed = new URL(raw, 'https://mobile.invalid');
    } catch {
        return null;
    }
    if (parsed.origin !== 'https://mobile.invalid' || parsed.username || parsed.password) return null;
    const pairs = [...parsed.searchParams.entries()];
    const seenKeys = new Set();
    for (const [key] of pairs) {
        if (seenKeys.has(key)) return null;
        seenKeys.add(key);
    }
    pairs.sort(([ak, av], [bk, bv]) => {
        const byKey = ak < bk ? -1 : (ak > bk ? 1 : 0);
        return byKey || (av < bv ? -1 : (av > bv ? 1 : 0));
    });
    const query = new URLSearchParams();
    for (const [key, item] of pairs) query.append(key, item);
    const encodedQuery = query.toString();
    return parsed.pathname + (encodedQuery ? '?' + encodedQuery : '');
}

function pathnameOf(target) {
    const index = target.indexOf('?');
    return index < 0 ? target : target.slice(0, index);
}

/** Returns the server-owned purpose for every device data-plane operation. */
function proofUsage(methodValue, targetValue) {
    const method = String(methodValue || '').toUpperCase();
    const target = canonicalPath(targetValue);
    if (!target) return null;
    const pathname = pathnameOf(target);

    const exact = new Map([
        ['GET /api/mobile/v1/sync/bootstrap', 'sync.bootstrap'],
        ['GET /api/mobile/v1/sync/changes', 'sync.changes'],
        ['GET /api/mobile/v1/sync/wake', 'sync.wake'],
        ['POST /api/mobile/v1/sync/push', 'sync.push'],
        ['POST /api/mobile/v1/sync/ack', 'sync.ack'],
        ['POST /api/mobile/v1/sync/now', 'sync.now'],
        ['GET /api/mobile/v1/sync/status', 'sync.status'],
        ['POST /api/mobile/v1/blobs/uploads', 'blob.upload.create'],
        ['GET /api/mobile/v1/shared', 'shared.list'],
        ['POST /api/mobile/v1/file-bridge/lease', 'file-bridge.lease'],
    ]).get(method + ' ' + pathname);
    if (exact) return exact;

    if (method === 'GET' && /^\/api\/mobile\/v1\/blobs\/uploads\/[^/]+$/.test(pathname)) {
        return 'blob.upload.status';
    }
    if (method === 'PUT' && /^\/api\/mobile\/v1\/blobs\/uploads\/[^/]+\/chunks\/[^/]+$/.test(pathname)) {
        return 'blob.chunk.upload';
    }
    if (method === 'GET' && /^\/api\/mobile\/v1\/blobs\/[^/]+\/chunks\/[^/]+$/.test(pathname)) {
        return 'blob.chunk.download';
    }
    if (method === 'GET' && /^\/api\/mobile\/v1\/blobs\/[^/]+$/.test(pathname)) {
        return 'blob.download';
    }
    if (method === 'GET' && /^\/api\/mobile\/v1\/shared\/[^/]+\/[^/]+$/.test(pathname)) {
        return 'shared.read';
    }
    if (method === 'POST' && /^\/api\/mobile\/v1\/shared\/[^/]+\/[^/]+\/invoke$/.test(pathname)) {
        return 'shared.invoke';
    }
    if (method === 'POST' && /^\/api\/mobile\/v1\/shared\/connections\/[^/]+\/sessions$/.test(pathname)) {
        return 'shared.session.open';
    }
    if (method === 'POST' && /^\/api\/mobile\/v1\/shared\/sessions\/[^/]+\/refresh$/.test(pathname)) {
        return 'shared.session.refresh';
    }
    if (method === 'DELETE' && /^\/api\/mobile\/v1\/shared\/sessions\/[^/]+$/.test(pathname)) {
        return 'shared.session.close';
    }
    return null;
}

function requestBodyBytes(req) {
    if (req.rawBody instanceof Buffer) return req.rawBody;
    const contentLength = String(req.headers?.['content-length'] || '').trim();
    const transferEncoding = String(req.headers?.['transfer-encoding'] || '').trim();
    if ((!contentLength || contentLength === '0') && !transferEncoding) return Buffer.alloc(0);
    if (req.body === undefined || req.body === null) return Buffer.alloc(0);
    if (Buffer.isBuffer(req.body)) return req.body;
    return Buffer.from(JSON.stringify(req.body), 'utf8');
}

function requestBinding(req) {
    const target = canonicalPath(req.originalUrl || req.url || req.path || '');
    if (!target) return null;
    const method = String(req.method || '').toUpperCase();
    const usage = proofUsage(method, target);
    if (!usage) return null;
    return {
        method,
        canonicalPath: target,
        bodySha256: bodySha256(requestBodyBytes(req)),
        usage,
    };
}

function signedProofPayload({ deviceId, method, canonicalPath: target, bodySha256: digest, usage, timestamp, nonce }) {
    return Buffer.from([
        PROOF_VERSION,
        String(deviceId),
        String(method).toUpperCase(),
        String(target),
        String(digest),
        String(usage),
        String(timestamp),
        String(nonce),
    ].join('\u0000'), 'utf8');
}

/** Strict standard Base64 plus fixed P1363 length; DER never reaches verify. */
function decodeP1363Proof(value) {
    const encoded = String(value || '').trim();
    if (!/^[A-Za-z0-9+/]{86}==$/.test(encoded)) return null;
    const decoded = Buffer.from(encoded, 'base64');
    if (decoded.length !== PROOF_SIGNATURE_BYTES || decoded.toString('base64') !== encoded) return null;
    return decoded;
}

function verifyP1363({ jwk, payload, proof }) {
    if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256') return false;
    const signature = decodeP1363Proof(proof);
    if (!signature) return false;
    try {
        const key = crypto.createPublicKey({ key: { ...jwk, kty: 'EC', crv: 'P-256' }, format: 'jwk' });
        return crypto.verify('sha256', payload, { key, dsaEncoding: 'ieee-p1363' }, signature);
    } catch {
        return false;
    }
}

module.exports = {
    PROOF_VERSION,
    PROOF_ALGORITHM,
    PROOF_SIGNATURE_BYTES,
    EMPTY_BODY_SHA256,
    bodySha256,
    decodeSha256,
    canonicalPath,
    proofUsage,
    requestBinding,
    signedProofPayload,
    decodeP1363Proof,
    verifyP1363,
};
