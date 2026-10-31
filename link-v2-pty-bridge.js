'use strict';
const crypto = require('node:crypto');
const { KIND } = require('./link-v2-codec');
const { fault } = require('./link-pty-handoff');
const shapes = Object.freeze({
    'handoff.list': ['op'],
    'handoff.prepare': ['op', 'sessionId'],
    'handoff.commit': ['op', 'prepareId', 'snapshotHash', 'appliedSequence'],
    'handoff.abort': ['op', 'prepareId'],
    'pty.read': ['op', 'sessionId', 'sessionEpoch', 'afterSeq'],
    'pty.input': ['op', 'sessionId', 'sessionEpoch', 'inputSeq', 'data'],
    'pty.resize': ['op', 'sessionId', 'sessionEpoch', 'cols', 'rows'],
});
async function dispatchPty(handoff, auth, body) {
    const keys = body && shapes[body.op];
    if (!keys || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !keys.includes(k)) ||
        keys.some(k => !Object.hasOwn(body, k))) throw fault('invalid_request', 400);
    for (const key of ['sessionId', 'prepareId']) if (keys.includes(key) &&
        (typeof body[key] !== 'string' || !body[key] || body[key].length > 200)) throw fault('invalid_request', 400);
    if (keys.includes('sessionEpoch') && (!Number.isSafeInteger(body.sessionEpoch) || body.sessionEpoch < 1)) throw fault('invalid_request', 400);
    if (body.op === 'handoff.commit' && (!/^[a-f0-9]{64}$/.test(body.snapshotHash || '') ||
        !Number.isSafeInteger(body.appliedSequence) || body.appliedSequence < 0)) throw fault('snapshot_not_applied', 400);
    switch (body.op) {
        case 'handoff.list': return handoff.list(auth);
        case 'handoff.prepare': return handoff.prepare(auth, body.sessionId);
        case 'handoff.commit': return handoff.commit(auth, body);
        case 'handoff.abort': return handoff.abort(auth, body.prepareId);
        case 'pty.read': return handoff.read(auth, body);
        case 'pty.input': return handoff.input(auth, body);
        case 'pty.resize': return handoff.setSize(auth, body);
    }
}
function createLinkPtyBridge({ handoff, resolveAuth, adminToken, operational = () => true }) {
    function authFor(deviceId, expected) {
        if (!operational()) throw fault('database_maintenance', 503);
        const { user, device } = resolveAuth(deviceId);
        if (user.status !== 'active' || !Number.isSafeInteger(device.binding_revision) || device.binding_revision < 1 ||
            typeof device.signing_public_jwk !== 'string' || !device.signing_public_jwk) throw fault('binding_expired', 403);
        const leaseId = 'device:' + crypto.createHash('sha256').update(JSON.stringify([
            String(user.userId), deviceId, device.binding_revision, device.signing_public_jwk,
        ])).digest('hex');
        if (expected && leaseId !== expected) throw fault('binding_expired', 403);
        return { userId: String(user.userId), user, leaseId, assertLive: () => authFor(deviceId, leaseId) };
    }
    async function handle(req, res) {
        const a = Buffer.from(String(adminToken || '')), b = Buffer.from(String(req.get('X-Link-Admin') || ''));
        if (!a.length || a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ ok: false, error: { code: 'unauthorized' } });
        try {
            if (req.body?.kind !== KIND.SHARED_TERMINAL || typeof req.body?.deviceId !== 'string') throw fault('invalid_request', 400);
            const auth = authFor(req.body.deviceId);
            const body = await dispatchPty(handoff, auth, req.body.body);
            auth.assertLive();
            return res.json({ ok: true, kind: KIND.SHARED_TERMINAL, body });
        } catch (error) {
            return res.status(Number(error.status) || 500).json({ ok: false, error: {
                code: error.code || 'internal_error', message: 'PTY handoff rejected', retryable: false,
            } });
        }
    }
    return { handle, authFor };
}
module.exports = { createLinkPtyBridge, dispatchPty };
