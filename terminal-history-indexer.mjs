import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import historyModule from './terminal-history-service.js';
import { WasmBridge } from './public/vendor/wterm-fork/core/index.js';
const { TerminalHistoryService } = historyModule;
const CHECKPOINT_SCHEMA = 1;

function styleKey(cell, link) {
  return [cell.fg, cell.bg, cell.flags, cell.fgRgb ?? '', cell.bgRgb ?? '', link || ''].join(',');
}
function cellStyle(cell, link) {
  const out = { fg: cell.fg, bg: cell.bg, flags: cell.flags };
  if (cell.fgRgb !== undefined) out.fgRgb = cell.fgRgb;
  if (cell.bgRgb !== undefined) out.bgRgb = cell.bgRgb;
  if (link) out.link = link;
  return out;
}
function appendCell(pending, cell, link = null, screenReverse = false, grapheme = null) {
  if (cell.wide === 2 || cell.char === 0) return;
  if (screenReverse) cell = { ...cell, flags: cell.flags ^ 0x20 };
  const char = grapheme || (cell.char >= 32 ? String.fromCodePoint(cell.char) : ' ');
  const key = styleKey(cell, link);
  let run = pending.runs[pending.runs.length - 1];
  if (!run || run.key !== key) {
    run = { key, text: '', ...cellStyle(cell, link) };
    pending.runs.push(run);
  }
  run.text += char;
}
function trimPending(pending) {
  while (pending.runs.length) {
    const run = pending.runs[pending.runs.length - 1];
    run.text = run.text.replace(/\s+$/, '');
    if (run.text) break;
    pending.runs.pop();
  }
}

export class TerminalHistoryIndexer {
  constructor({ history, root, checkpointEvery = 256 } = {}) {
    this.history = history || new TerminalHistoryService({ root });
    this.root = root || this.history.root;
    this.checkpointEvery = checkpointEvery;
    this.inflight = new Map();
  }
  _base(userId, sessionId) {
    const state = this.history._state(userId, sessionId);
    return state.journalPath.replace(/\.ndjson$/, '');
  }
  _paths(userId, sessionId) {
    const base = this._base(userId, sessionId);
    return { base, lines: `${base}.lines.ndjson`, sparse: `${base}.lines.idx`, checkpoint: `${base}.checkpoint.gz`, state: `${base}.index.json` };
  }
  _readState(paths, userId, sessionId) {
    try {
      const state = JSON.parse(fs.readFileSync(paths.state, 'utf8'));
      state.idxBytes = Number(state.idxBytes) || 0;
      if (state.checkpointFile && state.checkpointSchema !== CHECKPOINT_SCHEMA) throw new Error('unsupported checkpoint schema');
      return state;
    }
    catch {
      const session = this.history._state(userId, sessionId);
      return { lastSeq: 0, lineSeq: 0, pending: { runs: [] }, cols: session.cols || 80, rows: session.rows || 24, sinceCheckpoint: 0, linesBytes: 0, idxBytes: 0, checkpointFile: null, journalIno: 0, journalOffset: 0 };
    }
  }

  async _loadBridge(paths, state) {
    const bridge = await WasmBridge.load();
    bridge.init(state.cols || 80, state.rows || 24);
    try {
      const checkpointPath = state.checkpointFile ? `${paths.base}.${state.checkpointFile}` : paths.checkpoint;
      const raw = zlib.gunzipSync(fs.readFileSync(checkpointPath));
      bridge.importCheckpoint(raw);
    } catch {}
    bridge.setCaptureEvicted(true);
    return bridge;
  }
  _drain(bridge, state, paths) {
    const output = [];
    while (bridge.getEvictedCount() > 0) {
      const len = bridge.getEvictedLineLen();
      for (let col = 0; col < len; col++) {
        const cell = bridge.getEvictedCell(col);
        appendCell(state.pending, cell, bridge.getHyperlink(cell.linkId || 0), bridge.reverseScreen(), bridge.getGrapheme(cell.char));
      }
      const wrapped = bridge.getEvictedLineWrapped();
      bridge.popEvictedLine();
      if (!wrapped) {
        trimPending(state.pending);
        state.lineSeq += 1;
        const record = JSON.stringify({ seq: state.lineSeq, runs: state.pending.runs.map(({ key, ...run }) => run) });
        if ((state.lineSeq - 1) % 256 === 0) {
          let offset = 0;
          try { offset = fs.statSync(paths.lines).size; } catch {}
          for (const queued of output) offset += Buffer.byteLength(queued) + 1;
          fs.appendFileSync(paths.sparse, `${JSON.stringify({ seq: state.lineSeq, offset })}\n`, { mode: 0o600 });
        }
        output.push(record);
        state.pending = { runs: [] };
      }
    }
    if (output.length) fs.appendFileSync(paths.lines, `${output.join('\n')}\n`, { mode: 0o600 });
    return output.length;
  }
  _save(paths, bridge, state) {
    const checkpointName = `checkpoint.${state.lastSeq}.gz`;
    const checkpointPath = `${paths.base}.${checkpointName}`;
    const checkpoint = zlib.gzipSync(bridge.exportCheckpoint(), { level: 1 });
    fs.writeFileSync(`${checkpointPath}.tmp`, checkpoint, { mode: 0o600 });
    fs.renameSync(`${checkpointPath}.tmp`, checkpointPath);
    try { state.linesBytes = fs.statSync(paths.lines).size; } catch { state.linesBytes = 0; }
    try { state.idxBytes = fs.statSync(paths.sparse).size; } catch { state.idxBytes = 0; }
    state.checkpointFile = checkpointName;
    state.checkpointSchema = CHECKPOINT_SCHEMA;
    fs.writeFileSync(`${paths.state}.tmp`, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(`${paths.state}.tmp`, paths.state);
    // State is now durable and points at the new checkpoint. Old checkpoints
    // can be removed without creating a torn state after a crash.
    for (const entry of fs.readdirSync(path.dirname(paths.base))) {
      if (!entry.startsWith(`${path.basename(paths.base)}.checkpoint.`) || entry === `${path.basename(paths.base)}.${checkpointName}`) continue;
      try { fs.rmSync(path.join(path.dirname(paths.base), entry)); } catch {}
    }
  }
  async index(userId, sessionId) {
    const key = `${userId}:${sessionId}`;
    const active = this.inflight.get(key);
    if (active) return active;
    const task = this._indexAll(userId, sessionId).finally(() => this.inflight.delete(key));
    this.inflight.set(key, task);
    return task;
  }
  async _indexAll(userId, sessionId) {
    let indexed = 0, lines = 0, lastSeq = 0;
    for (;;) {
      const result = await this._indexBatch(userId, sessionId);
      indexed += result.indexed; lines += result.lines; lastSeq = result.lastSeq;
      if (result.indexed < 2000) return { indexed, lines, lastSeq };
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  _readIncremental(userId, sessionId, state, limit = 2000) {
    const journal = this.history._journal(userId, sessionId);
    let stat;
    try { stat = fs.statSync(journal); } catch { return []; }
    const same = state.journalIno === stat.ino && Number(state.journalOffset || 0) <= stat.size;
    if (!same) {
      const records = this.history.readRecords(userId, sessionId, { after: state.lastSeq, limit });
      // Enter byte-offset steady state only after all archived/current records
      // have been consumed. Otherwise the next batch must continue by seq.
      if (records.length < limit) { state.journalIno = stat.ino; state.journalOffset = stat.size; }
      else { state.journalIno = 0; state.journalOffset = 0; }
      return records;
    }
    if (Number(state.journalOffset || 0) === stat.size) return [];
    const fd = fs.openSync(journal, 'r');
    const length = stat.size - Number(state.journalOffset || 0);
    const buffer = Buffer.allocUnsafe(length);
    try { fs.readSync(fd, buffer, 0, length, Number(state.journalOffset || 0)); } finally { fs.closeSync(fd); }
    const out = [];
    let cursor = 0, consumed = 0;
    while (cursor < buffer.length && out.length < limit) {
      const newline = buffer.indexOf(10, cursor);
      if (newline < 0) break; // append in progress; retry the partial record later
      const line = buffer.subarray(cursor, newline).toString('utf8');
      consumed = newline + 1;
      cursor = newline + 1;
      if (!line) continue;
      try { const rec = JSON.parse(line); if (Number(rec.seq) > state.lastSeq) out.push(rec); } catch {}
    }
    state.journalOffset = Number(state.journalOffset || 0) + consumed;
    return out;
  }

  async _indexBatch(userId, sessionId) {
    const paths = this._paths(userId, sessionId);
    const state = this._readState(paths, userId, sessionId);
    try { fs.truncateSync(paths.lines, Number(state.linesBytes) || 0); } catch {}
    try { fs.truncateSync(paths.sparse, Number(state.idxBytes) || 0); } catch {}
    const records = this._readIncremental(userId, sessionId, state, 2000);
    if (!records.length) return { indexed: 0, lines: 0, lastSeq: state.lastSeq };
    const bridge = await this._loadBridge(paths, state);
    let lines = 0;
    for (const rec of records) {
      if (rec.type === 'output' && rec.data) {
        const data = Buffer.from(rec.data, 'base64');
        for (let offset = 0; offset < data.length; offset += 256) {
          bridge.writeRaw(data.subarray(offset, offset + 256));
          lines += this._drain(bridge, state, paths);
        }
      }
      else if (rec.type === 'resize') {
        state.cols = Math.max(1, Number(rec.cols) || state.cols);
        state.rows = Math.max(1, Number(rec.rows) || state.rows);
        bridge.resize(state.cols, state.rows);
      }
      state.lastSeq = Math.max(state.lastSeq, Number(rec.seq) || 0);
      state.sinceCheckpoint += 1;
      lines += this._drain(bridge, state, paths);
    }
    this._save(paths, bridge, state);
    return { indexed: records.length, lines, lastSeq: state.lastSeq };
  }

  async indexAllSessions() {
    const tasks = [];
    let users;
    try { users = fs.readdirSync(this.root, { withFileTypes: true }); } catch { return []; }
    for (const user of users) {
      if (!user.isDirectory()) continue;
      const dir = path.join(this.root, user.name);
      for (const entry of fs.readdirSync(dir)) {
        if (!entry.endsWith('.meta.json')) continue;
        try {
          const meta = JSON.parse(fs.readFileSync(path.join(dir, entry), 'utf8'));
          if (meta.userId && meta.sessionId) tasks.push(this.index(meta.userId, meta.sessionId));
        } catch {}
      }
    }
    return Promise.allSettled(tasks);
  }

  async readPage(userId, sessionId, { beforeSeq = Infinity, afterSeq = null, limit = 200 } = {}) {
    await this.index(userId, sessionId);
    const { lines, sparse } = this._paths(userId, sessionId);
    const requested = Math.max(1, Math.min(500, Number(limit) || 200));
    const after = afterSeq == null ? NaN : Number(afterSeq);
    if (Number.isFinite(after) && after >= 0) {
      let checkpoints = [];
      try { checkpoints = fs.readFileSync(sparse, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)); } catch {}
      let start = { seq: 1, offset: 0 };
      for (const point of checkpoints) { if (point.seq <= after + 1) start = point; else break; }
      let raw = '';
      let fd;
      try {
        fd = fs.openSync(lines, 'r');
        const stat = fs.fstatSync(fd), length = Math.max(0, stat.size - Number(start.offset || 0));
        const buffer = Buffer.allocUnsafe(length);
        fs.readSync(fd, buffer, 0, length, Number(start.offset || 0));
        raw = buffer.toString('utf8');
      } catch { return { lines: [], beforeSeq: null, hasMore: false }; }
      finally { if (fd !== undefined) fs.closeSync(fd); }
      const page = [];
      for (const line of raw.split('\n')) {
        if (!line) continue;
        try { const item = JSON.parse(line); if (item.seq > after) page.push(item); } catch {}
        if (page.length >= requested) break;
      }
      return { lines: page, beforeSeq: page.length ? page[0].seq : null, hasMore: page.length >= requested };
    }
    const before = Number.isFinite(Number(beforeSeq)) ? Number(beforeSeq) : Infinity;
    let checkpoints = [];
    try {
      checkpoints = fs.readFileSync(sparse, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    } catch {}
    const target = before === Infinity ? Infinity : Math.max(1, before - requested - 256);
    let start = { seq: 1, offset: 0 };
    for (const point of checkpoints) {
      if (point.seq <= target || target === Infinity) start = point;
      else break;
    }
    let fd;
    try { fd = fs.openSync(lines, 'r'); } catch { return { lines: [], beforeSeq: null, hasMore: false }; }
    let raw = '';
    try {
      const stat = fs.fstatSync(fd);
      const length = Math.max(0, stat.size - Number(start.offset || 0));
      const buffer = Buffer.allocUnsafe(length);
      fs.readSync(fd, buffer, 0, length, Number(start.offset || 0));
      raw = buffer.toString('utf8');
    } finally { fs.closeSync(fd); }
    const candidates = [];
    for (const line of raw.trim().split('\n')) {
      if (!line) continue;
      try { const item = JSON.parse(line); if (item.seq < before) candidates.push(item); } catch {}
    }
    const page = candidates.slice(-requested);
    const firstSeq = page.length ? page[0].seq : null;
    return { lines: page, beforeSeq: firstSeq, hasMore: firstSeq != null && firstSeq > 1 };
  }
}
