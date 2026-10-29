'use strict';

/**
 * ZSL-HANDOFF/1 control-plane kernel (spec §7.2).
 *
 * This is epoch + ownership + stale-input rejection. It does not open a PTY,
 * does not replay VT, and does not claim cross-device session recovery.
 */

const OPERATIONS = Object.freeze([
    'HANDOFF_REQUEST',
    'HANDOFF_COMMIT',
    'HANDOFF_TRANSFERRED',
    'input',
    'relay_attach',
    'tool_call',
    'approve',
]);

class LinkHandoffError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'LinkHandoffError';
    }
}

function fail(code, message) {
    throw new LinkHandoffError(code, message);
}

/**
 * Gate a live SSH/Telnet input/resize against the session's current epoch.
 * Sessions without an epoch (pre-P6) stay open so existing clients keep working.
 */
function assertLiveSessionEpoch(session, msg = {}) {
    if (!session || typeof session !== 'object') return true;
    if (!Number.isInteger(session.sessionEpoch) || session.sessionEpoch < 1) return true;
    if (msg.sessionEpoch == null && !msg.deviceId) return true;
    const claimedEpoch = msg.sessionEpoch == null ? session.sessionEpoch : Number(msg.sessionEpoch);
    if (claimedEpoch !== session.sessionEpoch) {
        fail('stale_epoch', 'input belongs to a previous handoff epoch');
    }
    if (session.ownerDeviceId && msg.deviceId && String(msg.deviceId) !== String(session.ownerDeviceId)) {
        fail('stale_owner', 'device is not the current session owner');
    }
    return true;
}

function nonEmpty(value, max = 160) {
    return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

class LinkHandoffRegistry {
    constructor({ now = () => Date.now() } = {}) {
        this.now = now;
        this.sessions = new Map();
    }

    register(session) {
        const sessionId = String(session?.sessionId || '');
        if (!nonEmpty(sessionId)) fail('invalid_request', 'sessionId required');
        const ownerUserId = String(session.ownerUserId || '');
        const ownerDeviceId = String(session.ownerDeviceId || '');
        if (!nonEmpty(ownerUserId) || !nonEmpty(ownerDeviceId)) {
            fail('invalid_request', 'owner identity required');
        }
        const record = {
            sessionId,
            ownerUserId,
            ownerDeviceId,
            sessionEpoch: Number.isInteger(session.sessionEpoch) && session.sessionEpoch >= 1
                ? session.sessionEpoch
                : 1,
            protocol: String(session.protocol || 'SSH'),
            snapshotRevision: Number(session.snapshotRevision) || 0,
            closed: false,
        };
        this.sessions.set(sessionId, record);
        return { ...record };
    }

    get(sessionId) {
        return this.sessions.get(String(sessionId || '')) || null;
    }

    requestHandoff({
        sessionId,
        requestId,
        fromDeviceId,
        toDeviceId,
        toUserId,
        sameAccount = true,
        highRisk = false,
        approved = false,
    } = {}) {
        if (!nonEmpty(requestId, 200)) fail('invalid_request', 'requestId required');
        const session = this.sessions.get(String(sessionId || ''));
        if (!session || session.closed) fail('session_not_found', 'session is gone');
        if (session.ownerDeviceId !== String(fromDeviceId || '')) {
            fail('not_session_owner', 'only the current owner can release the session');
        }
        if (!nonEmpty(toDeviceId)) fail('invalid_request', 'toDeviceId required');
        if (toDeviceId === session.ownerDeviceId) {
            fail('invalid_request', 'handoff target is already the owner');
        }
        if (!sameAccount || String(toUserId || '') !== session.ownerUserId) {
            if (!approved) fail('approval_required', 'cross-user handoff requires approval');
        }
        if (highRisk && !approved) fail('approval_required', 'high-risk handoff requires approval');

        session.sessionEpoch += 1;
        const previousOwner = session.ownerDeviceId;
        session.ownerDeviceId = toDeviceId;
        return {
            requestId: String(requestId),
            sessionId: session.sessionId,
            sessionEpoch: session.sessionEpoch,
            previousOwnerDeviceId: previousOwner,
            ownerDeviceId: session.ownerDeviceId,
            transferred: {
                kind: 'HANDOFF_TRANSFERRED',
                sessionId: session.sessionId,
                sessionEpoch: session.sessionEpoch,
            },
            commit: {
                kind: 'HANDOFF_COMMIT',
                sessionId: session.sessionId,
                sessionEpoch: session.sessionEpoch,
                ownerDeviceId: session.ownerDeviceId,
            },
        };
    }

    acceptInput({ sessionId, deviceId, sessionEpoch, operation = 'input' } = {}) {
        const session = this.sessions.get(String(sessionId || ''));
        if (!session || session.closed) fail('session_not_found', 'session is gone');
        if (!OPERATIONS.includes(operation) && operation !== 'input') {
            fail('invalid_request', 'unknown operation');
        }
        if (String(deviceId || '') !== session.ownerDeviceId) {
            fail('stale_owner', 'device is not the current session owner');
        }
        if (Number(sessionEpoch) !== session.sessionEpoch) {
            fail('stale_epoch', 'input belongs to a previous handoff epoch');
        }
        return { ok: true, sessionEpoch: session.sessionEpoch };
    }

    close(sessionId) {
        const session = this.sessions.get(String(sessionId || ''));
        if (!session) return false;
        session.closed = true;
        return true;
    }
}

function createLinkHandoffRegistry(opts) {
    return new LinkHandoffRegistry(opts);
}

module.exports = {
    LinkHandoffError,
    LinkHandoffRegistry,
    createLinkHandoffRegistry,
    assertLiveSessionEpoch,
    OPERATIONS,
};
