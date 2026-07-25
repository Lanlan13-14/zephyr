'use strict';

const WebSocket = require('ws');
const {
    OP, FLAG_RESPONSE, FLAG_ERROR, MAX_PAYLOAD_BYTES,
    Zft2ProtocolError, decodeFrame, responseFrame, errorFrame,
} = require('./file-transfer-protocol');
const { asString, asSafeInteger, mapRequest } = require('./file-transfer-operations');

const MAX_INFLIGHT_REQUESTS = 8;
const MAX_INFLIGHT_BYTES = 32 * 1024 * 1024;
const SEND_HIGH_WATER = 8 * 1024 * 1024;
const SEND_LOW_WATER = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60000;
// Match browser-side budget: block the IRP on backpressure instead of failing
// a multi-GB copy after 30s of socket drain.
const SEND_WAIT_TIMEOUT_MS = 60000;

function wsOpen(ws) {
    return ws && ws.readyState === WebSocket.OPEN;
}

function waitForSendBudget(ws, byteLength, timeoutMs = SEND_WAIT_TIMEOUT_MS) {
    if (!wsOpen(ws)) return Promise.reject(new Error('file transfer websocket is closed'));
    if ((ws.bufferedAmount || 0) + byteLength <= SEND_HIGH_WATER) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const timer = setInterval(() => {
            if (!wsOpen(ws)) {
                clearInterval(timer);
                reject(new Error('file transfer websocket closed during backpressure wait'));
                return;
            }
            if ((ws.bufferedAmount || 0) <= SEND_LOW_WATER) {
                clearInterval(timer);
                resolve();
                return;
            }
            if (Date.now() - started >= timeoutMs) {
                clearInterval(timer);
                reject(new Error('file transfer websocket backpressure timeout'));
            }
        }, 4);
        timer.unref?.();
    });
}

function sendBinary(ws, frame) {
    return waitForSendBudget(ws, frame.length).then(() => new Promise((resolve, reject) => {
        if (!wsOpen(ws)) return reject(new Error('file transfer websocket is closed'));
        ws.send(frame, { binary: true }, (err) => err ? reject(err) : resolve());
    }));
}

class FileTransferGateway {
    constructor({ fileAgentManager, authz, storage, now = () => Date.now(), log = console.log } = {}) {
        if (!fileAgentManager) throw new Error('FileTransferGateway requires fileAgentManager');
        this.fileAgentManager = fileAgentManager;
        this.authz = authz;
        this.storage = storage;
        this.now = now;
        this.log = log;
    }

    authorize(req) {
        const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        const agentId = asString(url.searchParams.get('agentId'), 256);
        const connectionId = asString(url.searchParams.get('connectionId'), 256);
        const session = req.authSession;
        if (!session || !agentId) throw new Zft2ProtocolError('unauthorized', 'Missing file transfer session binding');
        const user = this.storage?.getUserBrief?.(session.userId);
        if (!user || user.status !== 'active') throw new Zft2ProtocolError('unauthorized', 'Account is unavailable');
        const raw = connectionId ? this.storage?.getConnectionById?.(connectionId) : null;
        if (connectionId && !raw) throw new Zft2ProtocolError('forbidden', 'Connection is unavailable');
        if (raw) this.authz?.assertCan?.(user, 'fileRead', 'connection', connectionId, raw, { resourceExists: true });
        if (!this.fileAgentManager.isAgentOwnedByUser(agentId, user)) throw new Zft2ProtocolError('forbidden', 'Agent is not accessible to this user');
        const canWrite = raw
            ? this.authz?.can?.(user, 'fileWrite', 'connection', connectionId, raw) !== false
            : true;
        return { user, agentId, connectionId, canWrite };
    }

    handleConnection(ws, req) {
        let binding;
        try {
            binding = this.authorize(req);
        } catch (error) {
            try { ws.close(1008, error.code || 'unauthorized'); } catch {}
            return;
        }
        const state = { inflight: new Map(), inflightBytes: 0, closed: false };
        const failAll = () => {
            if (state.closed) return;
            state.closed = true;
            for (const pending of state.inflight.values()) pending.cancel?.();
            state.inflight.clear();
            state.inflightBytes = 0;
        };
        ws.on('close', failAll);
        ws.on('error', failAll);
        ws.on('message', (raw, isBinary) => {
            if (!isBinary || state.closed) {
                try { ws.close(1003, 'ZFT2 requires binary frames'); } catch {}
                return;
            }
            this._handleFrame(ws, binding, state, raw).catch((error) => {
                this.log('[file-transfer] request failed:', error.message);
            });
        });
    }

    async _handleFrame(ws, binding, state, raw) {
        let frame;
        try {
            frame = decodeFrame(raw);
            if (frame.flags & FLAG_RESPONSE) throw new Zft2ProtocolError('invalid_direction', 'Client sent a response frame');
            if (frame.type === OP.CANCEL) {
                const pending = state.inflight.get(asSafeInteger(frame.meta?.targetRequestId));
                pending?.cancel?.();
                return;
            }
            if (state.inflight.has(frame.requestId)) throw new Zft2ProtocolError('duplicate_request_id', 'Duplicate in-flight request id');
            if (state.inflight.size >= MAX_INFLIGHT_REQUESTS || state.inflightBytes + frame.payload.length > MAX_INFLIGHT_BYTES) {
                await sendBinary(ws, errorFrame(frame, 'busy', 'File transfer window is full', true));
                return;
            }
            const mapped = mapRequest(frame);
            if ((mapped.method === 'writeBinary' || ['mkdir', 'delete', 'rename', 'truncate'].includes(mapped.method)) && !binding.canWrite) {
                await sendBinary(ws, errorFrame(frame, 'read_only', 'File transfer write capability is denied'));
                return;
            }
            if (mapped.local) {
                await sendBinary(ws, responseFrame(frame, { serverTime: this.now() }));
                return;
            }
            const operation = this.fileAgentManager.callAgentV2(binding.agentId, mapped.method, mapped.params, REQUEST_TIMEOUT_MS);
            state.inflight.set(frame.requestId, operation);
            state.inflightBytes += frame.payload.length;
            try {
                const result = await operation.promise;
                if (mapped.binaryRead) {
                    await sendBinary(ws, responseFrame(frame, { bytesRead: result.length, eof: result.length === 0 }, result));
                } else {
                    await sendBinary(ws, responseFrame(frame, result || {}));
                }
            } catch (error) {
                if (wsOpen(ws)) await sendBinary(ws, errorFrame(frame, error.code || 'internal_error', error.message || 'File transfer failed', error.code === 'timeout'));
            } finally {
                state.inflight.delete(frame.requestId);
                state.inflightBytes = Math.max(0, state.inflightBytes - frame.payload.length);
            }
        } catch (error) {
            if (wsOpen(ws)) {
                await sendBinary(ws, errorFrame(frame, error.code || 'protocol_error', error.message || 'Invalid ZFT2 frame'));
            }
        }
    }
}

module.exports = { FileTransferGateway, waitForSendBudget, sendBinary, mapRequest };
