const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SAFE_ID = /[^a-zA-Z0-9._-]/g;
const MAX_RECORD_DATA_BYTES = 64 * 1024;
function safeId(value) {
    const raw = String(value || '').replace(SAFE_ID, '_').slice(0, 120);
    return raw || crypto.randomUUID();
}
function clamp(value, min, max, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback;
}

/**
 * Append-only, per-session PTY journal.
 *
 * Format: UTF-8 NDJSON. Output bytes are base64 encoded so arbitrary PTY data,
 * including partial UTF-8 sequences and NULs, is preserved exactly.
 * Records:
 *   {v:1,t:<ms>,seq:<u64>,type:"output",data:"<base64>"}
 *   {v:1,t:<ms>,seq:<u64>,type:"resize",cols:<n>,rows:<n>}
 *   {v:1,t:<ms>,seq:<u64>,type:"close",reason:"..."}
 */
class TerminalHistoryService {
    constructor(options = {}) {
        this.root = path.resolve(options.root || './data/terminal-history');
        this.maxSessionBytes = clamp(options.maxSessionBytes, 1024 * 1024, 128 * 1024 * 1024, 16 * 1024 * 1024);
        this.maxReplayBytes = clamp(options.maxReplayBytes, 64 * 1024, 16 * 1024 * 1024, 2 * 1024 * 1024);
        this.maxSegments = clamp(options.maxSegments, 2, 32, 8);
        this.maxUserBytes = clamp(options.maxUserBytes, 16 * 1024 * 1024, 4 * 1024 * 1024 * 1024, 512 * 1024 * 1024);
        this.retentionMs = clamp(options.retentionMs, 60_000, 90 * 24 * 60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000);
        this._states = new Map();
        fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    }

    _key(userId, sessionId) { return `${safeId(userId)}/${safeId(sessionId)}`; }
    _dir(userId) { return path.join(this.root, safeId(userId)); }
    _base(userId, sessionId) { return crypto.createHash('sha256').update(`${userId}:${sessionId}`).digest('hex').slice(0, 24); }
    _journal(userId, sessionId) { return path.join(this._dir(userId), `${this._base(userId, sessionId)}.ndjson`); }
    _meta(userId, sessionId) { return path.join(this._dir(userId), `${this._base(userId, sessionId)}.meta.json`); }

    open({ userId, sessionId, connectionId = '', cols = 80, rows = 24, createdAt = Date.now() }) {
        if (!userId || !sessionId) throw new Error('terminal history requires userId and sessionId');
        const dir = this._dir(userId);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const state = {
            userId: String(userId), sessionId: String(sessionId), connectionId: String(connectionId || ''),
            journalPath: this._journal(userId, sessionId), metaPath: this._meta(userId, sessionId),
            seq: 0, bytes: 0, createdAt: Number(createdAt) || Date.now(), updatedAt: Date.now(), cols, rows,
        };
        try {
            const stat = fs.statSync(state.journalPath);
            state.bytes = stat.size;
        } catch {}
        try {
            const old = JSON.parse(fs.readFileSync(state.metaPath, 'utf8'));
            state.seq = Number(old.seq) || 0;
            state.createdAt = Number(old.createdAt) || state.createdAt;
            state.updatedAt = Number(old.updatedAt) || state.updatedAt;
            state.connectionId = String(old.connectionId || state.connectionId);
            state.cols = Number(old.cols) || state.cols;
            state.rows = Number(old.rows) || state.rows;
        } catch {}
        try { state.bytes = fs.statSync(state.journalPath).size; } catch { state.bytes = 0; }
        this._states.set(this._key(userId, sessionId), state);
        this._writeMeta(state);
        return state;
    }

    _state(userId, sessionId) {
        return this._states.get(this._key(userId, sessionId)) || this.open({ userId, sessionId });
    }

    _writeMeta(state) {
        const tmp = `${state.metaPath}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({
            version: 1, userId: state.userId, sessionId: state.sessionId,
            connectionId: state.connectionId, seq: state.seq, bytes: state.bytes,
            createdAt: state.createdAt, updatedAt: state.updatedAt, cols: state.cols, rows: state.rows,
        }), { mode: 0o600 });
        fs.renameSync(tmp, state.metaPath);
    }

    _append(state, record) {
        const line = `${JSON.stringify({ v: 1, t: Date.now(), seq: ++state.seq, ...record })}\n`;
        fs.appendFileSync(state.journalPath, line, { mode: 0o600 });
        state.bytes += Buffer.byteLength(line);
        state.updatedAt = Date.now();
        if (state.bytes > this.maxSessionBytes) this._compact(state);
        this._writeMeta(state);
        return state.seq;
    }

    appendOutput(userId, sessionId, data) {
        const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data ?? ''), 'utf8');
        if (!bytes.length) return 0;
        const state = this._state(userId, sessionId);
        let seq = 0;
        for (let offset = 0; offset < bytes.length; offset += MAX_RECORD_DATA_BYTES) {
            const chunk = bytes.subarray(offset, offset + MAX_RECORD_DATA_BYTES);
            seq = this._append(state, { type: 'output', data: chunk.toString('base64') });
        }
        return seq;
    }

    appendResize(userId, sessionId, cols, rows) {
        const state = this._state(userId, sessionId);
        state.cols = clamp(cols, 1, 1000, state.cols || 80);
        state.rows = clamp(rows, 1, 500, state.rows || 24);
        return this._append(state, { type: 'resize', cols: state.cols, rows: state.rows });
    }

    appendClose(userId, sessionId, reason = '') {
        return this._append(this._state(userId, sessionId), { type: 'close', reason: String(reason).slice(0, 500) });
    }

    close(userId, sessionId, reason = '') {
        const seq = this.appendClose(userId, sessionId, reason);
        this._states.delete(this._key(userId, sessionId));
        return seq;
    }

    _journalFiles(userId, sessionId) {
        const current = this._journal(userId, sessionId);
        const files = [];
        for (let i = this.maxSegments; i >= 1; i--) {
            const file = `${current}.${i}`;
            if (fs.existsSync(file)) files.push(file);
        }
        if (fs.existsSync(current)) files.push(current);
        return files;
    }

    /** Return decoded output bytes from the journal tail. */
    replayTail(userId, sessionId, maxBytes = this.maxReplayBytes) {
        maxBytes = clamp(maxBytes, 1, this.maxReplayBytes, this.maxReplayBytes);
        const file = this._journal(userId, sessionId);
        let raw;
        try { raw = this._journalFiles(userId, sessionId).map((item) => fs.readFileSync(item, 'utf8')).join(''); } catch { return { data: '', bytes: 0, truncated: false }; }
        const output = [];
        let used = 0;
        const lines = raw.trimEnd().split('\n');
        for (let i = lines.length - 1; i >= 0 && used < maxBytes; i--) {
            let rec;
            try { rec = JSON.parse(lines[i]); } catch { continue; }
            if (rec.type !== 'output' || typeof rec.data !== 'string') continue;
            let chunk;
            try { chunk = Buffer.from(rec.data, 'base64'); } catch { continue; }
            if (used + chunk.length > maxBytes) chunk = chunk.subarray(chunk.length - (maxBytes - used));
            output.push(chunk); used += chunk.length;
        }
        output.reverse();
        const data = Buffer.concat(output).toString('utf8');
        return { data, bytes: used, truncated: lines.length > output.length };
    }

    readRecords(userId, sessionId, { after = 0, beforeSeq = Infinity, limit = 500 } = {}) {
        limit = clamp(limit, 1, 2000, 500);
        const file = this._journal(userId, sessionId);
        let raw;
        try { raw = this._journalFiles(userId, sessionId).map((item) => fs.readFileSync(item, 'utf8')).join(''); } catch { return []; }
        const parsed = [];
        for (const line of raw.split('\n')) {
            if (!line) continue;
            try {
                const rec = JSON.parse(line);
                const seq = Number(rec.seq) || 0;
                if (seq <= Number(after || 0) || seq >= Number(beforeSeq)) continue;
                parsed.push(rec);
            } catch {}
        }
        return Number.isFinite(Number(beforeSeq)) ? parsed.slice(-limit) : parsed.slice(0, limit);
    }

    _compact(state) {
        // Rotate complete NDJSON segments instead of truncating unindexed
        // records. The logical-line indexer consumes records by sequence;
        // eight 16 MiB segments provide a bounded 128 MiB catch-up window.
        fs.rmSync(`${state.journalPath}.${this.maxSegments}`, { force: true });
        for (let i = this.maxSegments - 1; i >= 1; i--) {
            const from = `${state.journalPath}.${i}`;
            if (fs.existsSync(from)) fs.renameSync(from, `${state.journalPath}.${i + 1}`);
        }
        if (fs.existsSync(state.journalPath)) fs.renameSync(state.journalPath, `${state.journalPath}.1`);
        fs.writeFileSync(state.journalPath, '', { mode: 0o600 });
        state.bytes = 0;
        this._enforceUserQuota(path.dirname(state.journalPath), path.basename(state.journalPath, '.ndjson'));
    }

    _removeSessionArtifacts(dir, base) {
        for (const entry of fs.readdirSync(dir)) {
            if (entry === `${base}.meta.json` || entry === `${base}.lines.ndjson` || entry === `${base}.lines.idx` || entry === `${base}.index.json` || entry === `${base}.ndjson` || entry.startsWith(`${base}.ndjson.`) || entry.startsWith(`${base}.checkpoint.`)) {
                fs.rmSync(path.join(dir, entry), { force: true });
            }
        }
    }

    _enforceUserQuota(dir, protectedBase = '') {
        const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile());
        let total = 0;
        for (const entry of entries) { try { total += fs.statSync(path.join(dir, entry.name)).size; } catch {} }
        if (total <= this.maxUserBytes) return 0;
        const sessions = [];
        for (const entry of entries) {
            if (!entry.name.endsWith('.meta.json')) continue;
            try { const meta = JSON.parse(fs.readFileSync(path.join(dir, entry.name), 'utf8')); sessions.push({ base: entry.name.slice(0, -10), updatedAt: Number(meta.updatedAt) || 0 }); } catch {}
        }
        sessions.sort((a, b) => a.updatedAt - b.updatedAt);
        let removed = 0;
        for (const session of sessions) {
            if (total <= this.maxUserBytes) break;
            if (session.base === protectedBase) continue;
            if ([...this._states.values()].some((state) => path.dirname(state.journalPath) === dir && path.basename(state.journalPath, '.ndjson') === session.base)) continue;
            let bytes = 0;
            for (const entry of fs.readdirSync(dir)) if (entry.startsWith(`${session.base}.`)) { try { bytes += fs.statSync(path.join(dir, entry)).size; } catch {} }
            this._removeSessionArtifacts(dir, session.base); total -= bytes; removed++;
        }
        return removed;
    }

    cleanupExpired(now = Date.now()) {
        let deleted = 0;
        for (const user of fs.readdirSync(this.root, { withFileTypes: true })) {
            if (!user.isDirectory()) continue;
            const dir = path.join(this.root, user.name);
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                if (!entry.isFile() || !entry.name.endsWith('.meta.json')) continue;
                const metaPath = path.join(dir, entry.name);
                try {
                    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
                    if (now - (Number(meta.updatedAt) || 0) <= this.retentionMs) continue;
                    const base = entry.name.slice(0, -10);
                    this._removeSessionArtifacts(dir, base);
                    this._states.delete(this._key(meta.userId, meta.sessionId));
                    deleted++;
                } catch {}
            }
            this._enforceUserQuota(dir);
            try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch {}
        }
        return deleted;
    }
}

module.exports = { TerminalHistoryService };
