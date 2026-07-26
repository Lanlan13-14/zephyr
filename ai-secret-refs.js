'use strict';

const crypto = require('crypto');
const { HttpError, CAP } = require('./authz');

const SECRET_REF_LIST_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
        kind: { type: 'string', enum: ['ssh_key', 'proxy'] },
        query: { type: 'string', maxLength: 200 },
        limit: { type: 'number', minimum: 1, maximum: 200 },
    },
    additionalProperties: false,
});

const REF_PREFIX = 'sref_v1_';

function b64url(input) { return Buffer.from(input).toString('base64url'); }
function unb64url(input) { return Buffer.from(String(input || ''), 'base64url'); }

function signingKey() {
    const source = process.env.ZEPHYR_SECRET_REF_KEY || process.env.ENCRYPTION_KEY || process.env.ZEPHYR_AI_PLATFORM_HOST_TOKEN || '';
    if (!source) throw new Error('secretRef signing key is not configured');
    return crypto.createHash('sha256').update(`zephyr-secret-ref-v1:${source}`).digest();
}

function sign(encoded) { return crypto.createHmac('sha256', signingKey()).update(encoded).digest('base64url'); }

function issueSecretRef(user, kind, resourceId, { ttlMs = 15 * 60 * 1000 } = {}) {
    if (!user?.userId || !['ssh_key', 'proxy'].includes(kind) || !resourceId) throw new HttpError(400, 'invalid_secret_ref', '无法签发 secretRef');
    const payload = { v: 1, userId: String(user.userId), kind, resourceId: String(resourceId), exp: Date.now() + Math.max(60000, Math.min(60 * 60 * 1000, Number(ttlMs) || 900000)), nonce: crypto.randomBytes(8).toString('hex') };
    const encoded = b64url(JSON.stringify(payload));
    return `${REF_PREFIX}${encoded}.${sign(encoded)}`;
}

function parseSecretRef(ref, user, expectedKind = '') {
    const text = String(ref || '');
    if (!text.startsWith(REF_PREFIX)) throw new HttpError(400, 'invalid_secret_ref', 'secretRef 格式无效');
    const [encoded, signature] = text.slice(REF_PREFIX.length).split('.');
    const expected = sign(encoded);
    const a = Buffer.from(String(signature || ''));
    const b = Buffer.from(expected);
    if (!a.length || a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new HttpError(400, 'invalid_secret_ref', 'secretRef 签名无效');
    let payload;
    try { payload = JSON.parse(unb64url(encoded).toString('utf8')); } catch { throw new HttpError(400, 'invalid_secret_ref', 'secretRef 载荷无效'); }
    if (payload.v !== 1 || payload.userId !== String(user?.userId || '')) throw new HttpError(403, 'secret_ref_forbidden', 'secretRef 不属于当前用户');
    if (Number(payload.exp || 0) < Date.now()) throw new HttpError(410, 'secret_ref_expired', 'secretRef 已过期，请重新发现');
    if (expectedKind && payload.kind !== expectedKind) throw new HttpError(400, 'secret_ref_kind_mismatch', 'secretRef 类型不匹配');
    return payload;
}

function canUse(user, resourceType, raw, resourceService) {
    if (!raw) return false;
    if (raw.ownerUserId === user.userId) return true;
    return resourceService.authz.can(user, CAP.USE, resourceType, raw.id, raw);
}

function listSecretRefs(user, args, resourceService) {
    const kind = String(args.kind || '');
    const query = String(args.query || '').trim().toLowerCase();
    const limit = Math.max(1, Math.min(200, Number(args.limit) || 100));
    const kinds = kind ? [kind] : ['ssh_key', 'proxy'];
    const refs = [];
    for (const currentKind of kinds) {
        const resourceType = currentKind === 'ssh_key' ? 'sshKey' : 'proxy';
        for (const item of resourceService.listOwned(user, resourceType)) {
            const raw = resourceService._rawResource(resourceType, item.id);
            if (!canUse(user, resourceType, raw, resourceService)) continue;
            const name = String(item.name || '');
            if (query && ![name, item.host, item.username, item.remark].some((value) => String(value || '').toLowerCase().includes(query))) continue;
            const available = currentKind === 'ssh_key' ? !!raw?.privateKey : !!raw?.password;
            if (!available) continue;
            refs.push({ kind: currentKind, resourceId: String(item.id), name, secretRef: issueSecretRef(user, currentKind, item.id), hasSecret: true, expiresInMs: 15 * 60 * 1000 });
            if (refs.length >= limit) return refs;
        }
    }
    return refs;
}

function resolveResourceId(ref, user, expectedKind, resourceService) {
    const payload = parseSecretRef(ref, user, expectedKind);
    const resourceType = expectedKind === 'ssh_key' ? 'sshKey' : 'proxy';
    const raw = resourceService._rawResource(resourceType, payload.resourceId);
    if (!canUse(user, resourceType, raw, resourceService)) throw new HttpError(404, 'resource_not_found_or_inaccessible', 'secretRef 指向的资源不存在或无权使用');
    return payload.resourceId;
}

module.exports = {
    SECRET_REF_LIST_SCHEMA,
    issueSecretRef,
    parseSecretRef,
    listSecretRefs,
    resolveResourceId,
};
