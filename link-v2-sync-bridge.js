'use strict';

/**
 * Link owned-sync bridge: the seam between the ZSL/2 channel and the single
 * mobile-v1 sync business core.
 *
 * Why this exists. Zephyr One (mobile and desktop) carries its sync business
 * frames over the encrypted Link channel, not plaintext HTTPS. But there is
 * exactly ONE sync business implementation — the mature MobileV1Api entity
 * registry with tombstone/conflict/idempotency/paged-bootstrap. This bridge
 * lets the Go Link node's owned-sync handler hand a frame to that same core
 * without duplicating any business logic, so the browser, the mobile app and
 * the desktop app all converge on identical sync semantics.
 *
 * Trust model. The Go node has ALREADY authenticated the device at handshake
 * (ZSL/2 + enrollment gate) and anchored the session to an enrolled deviceId.
 * So the bridge does not re-run device-token+proof auth — that would be
 * redundant and would force the proof nonce machinery across the channel.
 * Instead it trusts the Go node's attested deviceId, but ONLY over loopback
 * with a shared admin token, so no external caller can assert a deviceId.
 *
 * The bridge exposes a single loopback endpoint consumed by the Go handler:
 *   POST /internal/link/sync   { deviceId, kind, body } -> sync result JSON
 * It maps the Link frame kind onto the matching business operation and returns
 * the exact payload the business core produces, which the Go handler seals back.
 */

const { KIND } = require('./link-v2-codec');
const { MobileStoreError } = require('./mobile-v1-store');

/**
 * @param {object} opts
 * @param {object} opts.api        the MobileV1Api instance (single sync core)
 * @param {object} opts.storage    the account storage (getUserBrief for the owner)
 * @param {string} opts.adminToken loopback-only shared secret, constant-time compared
 */
function createLinkSyncBridge({ api, storage, adminToken }) {
    if (!api) throw new Error('link sync bridge requires the MobileV1Api instance');
    if (!api.store) throw new Error('link sync bridge requires the MobileV1 store on the api');
    if (!storage || typeof storage.getUserBrief !== 'function') {
        throw new Error('link sync bridge requires account storage');
    }
    if (typeof adminToken !== 'string' || adminToken.length < 16) {
        throw new Error('link sync bridge requires a strong admin token');
    }
    const store = api.store;

    function tokenEqual(got) {
        if (typeof got !== 'string' || got.length !== adminToken.length) return false;
        let diff = 0;
        for (let i = 0; i < got.length; i += 1) diff |= got.charCodeAt(i) ^ adminToken.charCodeAt(i);
        return diff === 0;
    }

    /* Resolve the device row the Go node attested, mirroring requireDeviceAccess.
     * The device must still be enabled and its owner still active — a revoked
     * device's sessions are dropped by the Go node separately, but the bridge
     * double-checks so a stale session cannot sync for a just-revoked device. */
    function resolveAuth(deviceId) {
        const device = store.getDeviceRow(deviceId);
        if (!device || device.revoked_at || !device.enabled) {
            throw new MobileStoreError('client_revoked', '设备不存在、已停用或已撤销', 403, {
                retryable: false,
            });
        }
        const user = storage.getUserBrief(device.owner_user_id);
        if (!user || user.status === 'deleted' || user.status === 'disabled') {
            throw new MobileStoreError('account_unavailable', '账号不可用', 403, {
                retryable: false,
            });
        }
        return { user, device };
    }

    /* Dispatch one Link owned-sync frame to the matching business operation and
     * return the exact result payload the HTTP route would have produced. The
     * frame body carries an `op` discriminator because one wire kind (SYNC_OP)
     * covers every sync verb; each verb runs the SAME transport-independent core
     * method the HTTP route uses, so semantics never diverge across clients. */
    function dispatch(auth, kind, body) {
        if (kind !== KIND.SYNC_OP) {
            const err = new Error('不支持的同步帧类型 ' + kind);
            err.status = 400; err.code = 'unsupported_kind'; err.retryable = false; err.expose = true;
            throw err;
        }
        const b = body || {};
        switch (b.op) {
            case 'bootstrap':
                return { kind: KIND.SYNC_ACK, body: api.executeBootstrapForDevice(auth, b) };
            case 'push': {
                const { op: _op, ...request } = b;
                return { kind: KIND.SYNC_ACK, body: api.executePushForDevice(auth, request) };
            }
            case 'changes':
                return { kind: KIND.SYNC_ACK, body: api.executeChangesForDevice(auth, b) };
            case 'ack':
                return { kind: KIND.SYNC_ACK, body: api.executeAckForDevice(auth, b.cursor) };
            case 'status':
                return { kind: KIND.SYNC_ACK, body: api.executeSyncStatusForDevice(auth) };
            default: {
                const err = new Error('缺少或不支持的同步操作: ' + String(b.op));
                err.status = 400; err.code = 'unsupported_op'; err.retryable = false; err.expose = true;
                throw err;
            }
        }
    }

    /** Express-style handler mounted on the loopback-only internal surface. */
    function handle(req, res) {
        if (!tokenEqual(req.get('X-Link-Admin') || '')) {
            res.status(401).json({ ok: false, error: { code: 'unauthorized', message: '内部通道未授权' } });
            return;
        }
        const { deviceId, kind, body } = req.body || {};
        if (typeof deviceId !== 'string' || !deviceId) {
            res.status(400).json({ ok: false, error: { code: 'bad_request', message: '缺少 deviceId' } });
            return;
        }
        try {
            const auth = resolveAuth(deviceId);
            const out = dispatch(auth, Number(kind), body);
            res.json({ ok: true, ...out });
        } catch (err) {
            const typed = err instanceof MobileStoreError;
            const status = typed ? (Number(err.status) || 400) : 500;
            res.status(status).json({
                ok: false,
                error: {
                    code: typed ? String(err.code || 'internal_error') : 'internal_error',
                    message: typed ? String(err.message || '请求失败') : '服务器内部错误',
                    retryable: typed ? err.retryable === true : true,
                    details: typed ? (err.details || null) : null,
                },
            });
        }
    }

    return { handle, resolveAuth };
}

module.exports = { createLinkSyncBridge };
