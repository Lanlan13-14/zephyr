'use strict';
const crypto = require('node:crypto');
const fault = (code, status = 409) => Object.assign(new Error('PTY handoff rejected'), { code, status, retryable: false });
const text = (v, max = 200) => typeof v === 'string' && v.length > 0 && v.length <= max && !v.includes('\0');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const RESET = '\x1bc';

/** In-memory, primary-anchored SSH PTYs, not credential export or process migration.
 * A renderer ACK precedes the synchronous ownership CAS. Input receipts are consumed before
 * write: an uncertain write can be queried/repeated with the SAME sequence, never executed twice.
 * Leases come exclusively from an authenticated socket or attested device binding, not the body. */
class PrimaryPtyHandoff {
    constructor({ sessions, authorize, capture, writeInput, resize, clock = Date.now }) {
        Object.assign(this, { sessions, authorize, capture, writeInput, resize, clock });
        this.pending = new Map();
        this.preparing = 0;
    }
    session(id) {
        const session = this.sessions.get(id);
        if (!session || session.closed || session.protocol !== 'SSH' || !session.connectionId) throw fault('session_not_found', 404);
        return session;
    }
    live(auth, session) {
        if (!auth || !text(auth.leaseId, 512) || typeof auth.assertLive !== 'function') throw fault('invalid_owner', 403);
        auth.assertLive();
        if (String(auth.userId) !== String(session.userId)) throw fault('session_not_found', 404);
        this.authorize(auth, session);
    }
    enable(session, source) {
        this.live(source, session);
        if (session.protocol !== 'SSH' || !session.connectionId) throw fault('unsupported_session');
        if (session.handoff) {
            this.assertOwner(source, session.id, session.handoff.epoch);
        } else {
            session.handoff = { owner: source.leaseId, userId: String(source.userId), epoch: session.sessionEpoch || 1,
                source, output: [], outputBytes: 0, inputSeq: 0, receipts: new Map(), enabled: true };
            session.sessionEpoch = session.handoff.epoch;
        }
        return { ok: true, sessionId: session.id, sessionEpoch: session.handoff.epoch, trustModel: 'trusted-primary' };
    }
    assertOwner(auth, id, epoch) {
        const { session, state } = this.check(auth, id);
        if (state.owner !== auth.leaseId || epoch !== state.epoch) throw fault('stale_owner', 403);
        session.lastActive = this.clock();
        session.lastDetachedAt = 0;
        return { session, state };
    }
    assertSocket(auth, session, epoch) {
        if (session?.handoff) return this.assertOwner(auth, session.id, epoch);
    }
    append(session, data, sequence) {
        const state = session?.handoff;
        if (!state || !Number.isSafeInteger(sequence)) return;
        // Preserve split UTF-8 sequences, binary controls and escape bytes exactly.
        const bytes = Buffer.from(data);
        state.output.push({ sequence, data: bytes.toString('base64'), bytes: bytes.length });
        state.outputBytes += bytes.length;
        while (state.outputBytes > 512 * 1024 && state.output.length) state.outputBytes -= state.output.shift().bytes;
    }
    check(auth, id) {
        const session = this.session(id), state = session.handoff;
        if (!state?.enabled) throw fault('session_not_found', 404);
        this.live(auth, session);
        return { session, state };
    }
    list(auth) {
        auth.assertLive();
        const sessions = [];
        for (const session of this.sessions.values()) {
            try {
                const { state } = this.check(auth, session.id);
                sessions.push({ sessionId: session.id, connectionId: session.connectionId, protocol: 'SSH',
                    sessionEpoch: state.epoch, executionTarget: 'primary_pty', trustModel: 'trusted-primary',
                    name: String(session.connectionConfig?.name || 'SSH').slice(0, 200) });
            } catch (error) { if (error.code !== 'session_not_found' && error.code !== 'resource_not_found_or_inaccessible') throw error; }
            if (sessions.length === 100) break;
        }
        return { ok: true, sessions };
    }
    delta(session, state, after, maxBytes = 128 * 1024) {
        const current = session.outputSequence || 0;
        if (!Number.isSafeInteger(after) || after < 0 || after > current) throw fault('invalid_output_cursor', 400);
        if (after < current && (!state.output.length || state.output[0].sequence > after + 1)) throw fault('snapshot_required');
        const frames = [];
        let size = 0, nextSeq = after;
        for (const frame of state.output) if (frame.sequence > after) {
            if (size + frame.bytes > maxBytes) break;
            size += frame.bytes;
            frames.push({ sequence: frame.sequence, data: frame.data });
            nextSeq = frame.sequence;
        }
        if (nextSeq === after && after < current) throw fault('snapshot_required');
        return { frames, nextSeq, hasMore: nextSeq < current };
    }
    prune() {
        for (const [id, entry] of this.pending) if (entry.expiresAt <= this.clock() || entry.session.closed) this.pending.delete(id);
    }
    async prepare(auth, id) {
        this.prune();
        if (this.pending.size + this.preparing >= 128 || this.preparing >= 4) throw fault('handoff_capacity', 429);
        this.preparing++;
        try {
        const { session, state } = this.check(auth, id);
        const epoch = state.epoch, owner = state.owner;
        const snapshot = await this.capture(session);
        this.live(auth, session);
        if (session.closed || state !== session.handoff || state.epoch !== epoch || state.owner !== owner) throw fault('handoff_conflict');
        if (!snapshot || typeof snapshot.data !== 'string' || Buffer.byteLength(snapshot.data) > 2 * 1024 * 1024 ||
            !Number.isSafeInteger(snapshot.outputSequence) || snapshot.outputSequence > (session.outputSequence || 0)) throw fault('snapshot_unavailable');
        const data = RESET + snapshot.data;
        const snapshotHash = hash(data);
        const prepareId = crypto.randomUUID(), expiresAt = this.clock() + 30000;
        // Retain metadata only; the snapshot is delivered to the renderer, not held twice in memory.
        if (this.pending.size >= 128) throw fault('handoff_capacity', 429);
        this.pending.set(prepareId, { session, epoch, owner, target: auth.leaseId, snapshotHash,
            cols: snapshot.cols, rows: snapshot.rows,
            outputSequence: snapshot.outputSequence, expiresAt, result: null });
        return { ok: true, prepareId, sessionId: id, sessionEpoch: epoch, expiresAt,
            snapshot: { data, snapshotHash, outputSequence: snapshot.outputSequence, cols: snapshot.cols,
                rows: snapshot.rows, truncated: snapshot.truncated === true }, trustModel: 'trusted-primary' };
        } finally { this.preparing--; }
    }
    commit(auth, body) {
        this.prune();
        const entry = this.pending.get(body.prepareId);
        if (!entry || entry.target !== auth.leaseId) throw fault('handoff_expired');
        const { session, state } = this.check(auth, entry.session.id);
        if (session !== entry.session || body.snapshotHash !== entry.snapshotHash || body.appliedSequence !== entry.outputSequence) throw fault('snapshot_not_applied');
        if (entry.result) {
            this.assertOwner(auth, session.id, entry.result.sessionEpoch);
            return entry.result;
        }
        if (state.epoch !== entry.epoch || state.owner !== entry.owner) throw fault('handoff_conflict');
        if (session.pty?.cols !== entry.cols || session.pty?.rows !== entry.rows) throw fault('snapshot_required');
        const output = this.delta(session, state, entry.outputSequence);
        if (state.epoch >= Number.MAX_SAFE_INTEGER) throw fault('epoch_exhausted');
        const previous = state.source;
        // No await between CAS and publication. At most one preparation can win this epoch.
        state.owner = auth.leaseId;
        state.source = auth;
        state.epoch += 1;
        state.inputSeq = 0;
        state.receipts.clear();
        session.sessionEpoch = state.epoch;
        session.lastActive = this.clock();
        session.lastDetachedAt = 0;
        entry.result = { ok: true, sessionId: session.id, sessionEpoch: state.epoch, ...output,
            trustModel: 'trusted-primary', executionTarget: 'primary_pty' };
        try { if (previous?.leaseId !== auth.leaseId) previous?.transferred?.({ type: 'HANDOFF_TRANSFERRED', sessionId: session.id, sessionEpoch: state.epoch }); } catch {}
        for (const socket of [...(session.attachedWs || [])]) {
            try { if (socket._ptyLeaseId !== auth.leaseId) socket._onPtyHandoff?.({ type: 'HANDOFF_TRANSFERRED', sessionId: session.id, sessionEpoch: state.epoch }); } catch {}
            session.attachedWs.delete(socket);
        }
        return entry.result;
    }
    abort(auth, prepareId) {
        const entry = this.pending.get(prepareId);
        if (entry) {
            this.live(auth, entry.session);
            if (entry.target !== auth.leaseId || entry.result) throw fault('handoff_conflict');
            this.pending.delete(prepareId);
        }
        return { ok: true };
    }
    read(auth, body) {
        const { session, state } = this.assertOwner(auth, body.sessionId, body.sessionEpoch);
        return { ok: true, sessionEpoch: state.epoch, ...this.delta(session, state, body.afterSeq) };
    }
    input(auth, body) {
        const { session, state } = this.assertOwner(auth, body.sessionId, body.sessionEpoch);
        if (!Number.isSafeInteger(body.inputSeq) || body.inputSeq < 1 || typeof body.data !== 'string' ||
            body.data.length > 87384 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.data)) throw fault('invalid_input', 400);
        const bytes = Buffer.from(body.data, 'base64');
        if (bytes.length > 65536) throw fault('invalid_input', 400);
        const digest = hash(bytes), previous = state.receipts.get(body.inputSeq);
        if (previous) {
            if (previous.digest !== digest) throw fault('input_conflict');
            return previous.result;
        }
        if (body.inputSeq !== state.inputSeq + 1) throw fault('input_sequence_gap');
        const result = { ok: false, inputSeq: body.inputSeq, error: { code: 'input_uncertain', retryable: false } };
        state.receipts.set(body.inputSeq, { digest, result });
        state.inputSeq = body.inputSeq;
        while (state.receipts.size > 256) state.receipts.delete(state.receipts.keys().next().value);
        try { this.writeInput(session, bytes); result.ok = true; delete result.error; } catch {}
        return result;
    }
    setSize(auth, body) {
        const { session } = this.assertOwner(auth, body.sessionId, body.sessionEpoch);
        if (!Number.isSafeInteger(body.cols) || !Number.isSafeInteger(body.rows) || body.cols < 20 || body.cols > 500 || body.rows < 2 || body.rows > 200) throw fault('invalid_size', 400);
        this.resize(session, body.cols, body.rows);
        return { ok: true, sessionEpoch: body.sessionEpoch };
    }
}
module.exports = { PrimaryPtyHandoff, fault };
