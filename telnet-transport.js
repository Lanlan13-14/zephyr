'use strict';
/*
 * telnet-transport.js — Telnet IAC helpers + stateful engine (FREEZE plan §5.6).
 *
 * Pure protocol helpers shared by Node /ssh (default path) and tests.
 * Full session pump lives in server.js WS handler; Go worker has a
 * parallel (older) implementation in zephyr-worker/telnet.go.
 *
 * Phase 1 upgrades:
 *   - TelnetIacEngine: cross-packet buffering, DO/DONT/WILL/WONT replies
 *     (RFC 855), TTYPE subnegotiation (RFC 1091), IAC NOP keepalive.
 *   - filterIac remains a pure one-shot stripper for unit tests / legacy.
 */

const net = require('net');

const IAC = 255;
const DONT = 254;
const DO = 253;
const WONT = 252;
const WILL = 251;
const SB = 250;
const SE = 240;
const NOP = 241;
const GA = 249;

const OPT_ECHO = 1;
const OPT_SGA = 3;
const OPT_STATUS = 5;
const OPT_TTYPE = 24;
const OPT_NAWS = 31;
const OPT_BINARY = 0;

const TTYPE_IS = 0;
const TTYPE_SEND = 1;

const DEFAULT_TERM = 'xterm-256color';

function defaultPort(protocol) {
    const p = String(protocol || 'SSH').toUpperCase();
    if (p === 'RDP') return 3389;
    if (p === 'VNC') return 5900;
    if (p === 'TELNET') return 23;
    return 22;
}

function sendNaws(socket, cols, rows) {
    const c = Math.max(1, Math.min(500, Number(cols) || 80));
    const r = Math.max(1, Math.min(200, Number(rows) || 24));
    const pkt = Buffer.from([
        IAC, SB, OPT_NAWS,
        (c >> 8) & 0xff, c & 0xff,
        (r >> 8) & 0xff, r & 0xff,
        IAC, SE,
    ]);
    socket.write(pkt);
}

function negotiate(socket, cols = 80, rows = 24) {
    // WILL NAWS, WILL TTYPE, DO SGA, DO ECHO — same set as Go worker.
    const packets = [
        Buffer.from([IAC, WILL, OPT_NAWS]),
        Buffer.from([IAC, WILL, OPT_TTYPE]),
        Buffer.from([IAC, DO, OPT_SGA]),
        Buffer.from([IAC, DO, OPT_ECHO]),
    ];
    for (const p of packets) socket.write(p);
    sendNaws(socket, cols, rows);
}

/**
 * Strip IAC option negotiations from server→client stream so the terminal
 * emulator only sees printable payload. Handles IAC IAC (literal 0xFF).
 * Incomplete trailing IAC sequences are dropped (one-shot, no hangover).
 * Prefer TelnetIacEngine for live sessions (cross-packet + replies).
 */
function filterIac(data) {
    const engine = new TelnetIacEngine({ write: null, respond: false });
    return engine.feed(data);
}

/**
 * Stateful Telnet IAC processor.
 *
 * - Buffers incomplete IAC/SB sequences across TCP chunks.
 * - Replies to DO/DONT/WILL/WONT per a simplified RFC 855 queue (no loops).
 * - Answers TTYPE SEND with termType (default xterm-256color).
 * - Optionally emits IAC NOP keepalives.
 */
class TelnetIacEngine {
    /**
     * @param {object} opts
     * @param {(buf: Buffer) => void} [opts.write]  socket write for replies
     * @param {string} [opts.termType]
     * @param {boolean} [opts.respond=true]  when false, pure strip (filterIac)
     * @param {Set<number>|number[]} [opts.wantUs]   options we will enable
     * @param {Set<number>|number[]} [opts.wantHim]  options we want peer to enable
     */
    constructor({
        write = null,
        termType = DEFAULT_TERM,
        respond = true,
        wantUs = [OPT_NAWS, OPT_TTYPE],
        wantHim = [OPT_SGA, OPT_ECHO],
    } = {}) {
        this._write = typeof write === 'function' ? write : null;
        this.termType = String(termType || DEFAULT_TERM).slice(0, 40) || DEFAULT_TERM;
        this.respond = respond !== false;
        this.wantUs = new Set(wantUs);
        this.wantHim = new Set(wantHim);
        /** @type {Map<number, boolean>} */
        this.us = new Map();   // local (us) option enabled?
        /** @type {Map<number, boolean>} */
        this.him = new Map();  // remote (him) option enabled?
        /** @type {Buffer} incomplete hangover from previous chunk */
        this.pending = Buffer.alloc(0);
        this._keepaliveTimer = null;
        this.destroyed = false;
        // Seed: we already announced WILL NAWS / WILL TTYPE on dial.
        for (const opt of this.wantUs) this.us.set(opt, true);
        for (const opt of this.wantHim) this.him.set(opt, false); // until peer confirms
    }

    /** Soft destroy: stop keepalive, drop hangover. Does not touch socket. */
    destroy() {
        this.destroyed = true;
        this.stopKeepalive();
        this.pending = Buffer.alloc(0);
    }

    /**
     * Start periodic IAC NOP keepalive. No-op if write is missing.
     * @param {number} [intervalMs=60000]
     */
    startKeepalive(intervalMs = 60000) {
        this.stopKeepalive();
        if (!this._write || this.destroyed) return;
        // Floor at 50ms so tests can exercise the path; production uses 60s.
        const ms = Math.max(50, Number(intervalMs) || 60000);
        this._keepaliveTimer = setInterval(() => {
            if (this.destroyed || !this._write) return;
            try { this._write(Buffer.from([IAC, NOP])); } catch {}
        }, ms);
        // Keep the timer ref'd so short-lived tests / idle sessions still fire
        // at least once; long-lived production servers already hold other refs
        // (the TCP socket / WS). Callers that need unref can do it externally.
    }

    stopKeepalive() {
        if (this._keepaliveTimer) {
            clearInterval(this._keepaliveTimer);
            this._keepaliveTimer = null;
        }
    }

    _emit(buf) {
        if (!this.respond || !this._write || !buf || !buf.length) return;
        try { this._write(buf); } catch {}
    }

    _reply(cmd, opt) {
        this._emit(Buffer.from([IAC, cmd, opt & 0xff]));
    }

    _onDo(opt) {
        if (!this.respond) return;
        const enabled = this.us.get(opt) === true;
        if (this.wantUs.has(opt)) {
            if (!enabled) {
                this.us.set(opt, true);
                this._reply(WILL, opt);
                if (opt === OPT_NAWS) {
                    // Peer accepted NAWS; re-send size if we know it.
                    // (size is owned by dialer; skip here — resize path sends NAWS.)
                }
            }
            // already enabled → ignore (prevents loop)
        } else {
            if (enabled) this.us.set(opt, false);
            this._reply(WONT, opt);
        }
    }

    _onDont(opt) {
        if (!this.respond) return;
        if (this.us.get(opt) === true) {
            this.us.set(opt, false);
            this._reply(WONT, opt);
        }
        // already off → ignore
    }

    _onWill(opt) {
        if (!this.respond) return;
        const enabled = this.him.get(opt) === true;
        if (this.wantHim.has(opt) || opt === OPT_BINARY) {
            // Accept BINARY if offered; SGA/ECHO via wantHim.
            if (!enabled) {
                this.him.set(opt, true);
                this._reply(DO, opt);
            }
        } else {
            if (enabled) this.him.set(opt, false);
            this._reply(DONT, opt);
        }
    }

    _onWont(opt) {
        if (!this.respond) return;
        if (this.him.get(opt) === true) {
            this.him.set(opt, false);
            this._reply(DONT, opt);
        }
    }

    _onSubnegotiation(opt, body) {
        if (!this.respond) return;
        if (opt === OPT_TTYPE) {
            // IAC SB TTYPE SEND IAC SE  →  reply IS <term>
            // Frame: IAC SB TTYPE IS <term...> IAC SE  = 4 + term.length + 2
            if (body.length >= 1 && body[0] === TTYPE_SEND) {
                const term = Buffer.from(this.termType, 'ascii');
                const pkt = Buffer.alloc(6 + term.length);
                let i = 0;
                pkt[i++] = IAC;
                pkt[i++] = SB;
                pkt[i++] = OPT_TTYPE;
                pkt[i++] = TTYPE_IS;
                term.copy(pkt, i);
                i += term.length;
                pkt[i++] = IAC;
                pkt[i++] = SE;
                this._emit(pkt);
            }
        }
        // Other SB options (NAWS is client→server only) are ignored.
    }

    /**
     * Feed a TCP chunk. Returns payload bytes for the terminal emulator.
     * Incomplete trailing IAC sequences stay in `pending` for the next feed.
     * @param {Buffer|string|Uint8Array} data
     * @returns {Buffer}
     */
    feed(data) {
        if (this.destroyed) return Buffer.alloc(0);
        const incoming = Buffer.isBuffer(data) ? data : Buffer.from(data);
        const buf = this.pending.length
            ? Buffer.concat([this.pending, incoming])
            : incoming;
        this.pending = Buffer.alloc(0);

        const out = [];
        let i = 0;
        while (i < buf.length) {
            if (buf[i] !== IAC) {
                // RFC 854 NVT: CR NUL → CR when peer is not BINARY.
                if (buf[i] === 0x0d && this.him.get(OPT_BINARY) !== true) {
                    if (i + 1 < buf.length) {
                        if (buf[i + 1] === 0x00) {
                            out.push(0x0d);
                            i += 2;
                            continue;
                        }
                    } else {
                        // Lone CR at end — hold in case next byte is NUL.
                        this.pending = buf.subarray(i);
                        i = buf.length;
                        break;
                    }
                }
                out.push(buf[i]);
                i += 1;
                continue;
            }
            // Need at least IAC + cmd
            if (i + 1 >= buf.length) {
                this.pending = buf.subarray(i);
                break;
            }
            const cmd = buf[i + 1];
            if (cmd === IAC) {
                // escaped 0xFF
                out.push(IAC);
                i += 2;
                continue;
            }
            if (cmd === NOP || cmd === GA) {
                // keepalives / go-ahead — strip
                i += 2;
                continue;
            }
            if (cmd === DO || cmd === DONT || cmd === WILL || cmd === WONT) {
                if (i + 2 >= buf.length) {
                    this.pending = buf.subarray(i);
                    break;
                }
                const opt = buf[i + 2];
                if (cmd === DO) this._onDo(opt);
                else if (cmd === DONT) this._onDont(opt);
                else if (cmd === WILL) this._onWill(opt);
                else this._onWont(opt);
                i += 3;
                continue;
            }
            if (cmd === SB) {
                // Find IAC SE; careful with escaped IAC IAC inside body.
                let end = i + 2;
                let found = false;
                while (end < buf.length - 1) {
                    if (buf[end] === IAC) {
                        if (buf[end + 1] === SE) {
                            found = true;
                            break;
                        }
                        if (buf[end + 1] === IAC) {
                            end += 2; // escaped
                            continue;
                        }
                    }
                    end += 1;
                }
                if (!found) {
                    this.pending = buf.subarray(i);
                    break;
                }
                const opt = i + 2 < end ? buf[i + 2] : 0;
                // body is between opt and IAC SE
                const bodyStart = i + 3;
                const bodyEnd = end;
                const body = bodyStart < bodyEnd ? buf.subarray(bodyStart, bodyEnd) : Buffer.alloc(0);
                this._onSubnegotiation(opt, body);
                i = end + 2;
                continue;
            }
            // Unknown 2-byte command (e.g. IP, AO, AYT, EC, EL, BRK) — strip
            i += 2;
        }
        return Buffer.from(out);
    }
}

/**
 * Attach a TelnetIacEngine to a live socket. Returns the engine.
 * Caller should use engine.feed(chunk) on 'data' instead of filterIac.
 */
function attachIacEngine(socket, {
    termType = DEFAULT_TERM,
    keepaliveMs = 60000,
    cols = 80,
    rows = 24,
} = {}) {
    const engine = new TelnetIacEngine({
        write: (buf) => {
            if (socket && !socket.destroyed) socket.write(buf);
        },
        termType,
        respond: true,
    });
    // Mark NAWS size known so future DO NAWS can re-report if needed.
    engine._cols = cols;
    engine._rows = rows;
    if (keepaliveMs > 0) engine.startKeepalive(keepaliveMs);
    return engine;
}

/**
 * Open a raw TCP Telnet connection and run initial option negotiation.
 * Auth is in-band (username/password typed into the terminal).
 * Returns the raw socket; attachIacEngine separately for live sessions.
 */
function dialTelnet(conn, { timeout = 10000, cols = 80, rows = 24 } = {}) {
    return new Promise((resolve, reject) => {
        const host = String(conn.host || '');
        const port = Number(conn.port) || 23;
        if (!host) {
            reject(new Error('主机不能为空'));
            return;
        }
        const socket = new net.Socket();
        let settled = false;
        const finish = (err, result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (err) {
                try { socket.destroy(); } catch {}
                reject(err);
            } else resolve(result);
        };
        const timer = setTimeout(() => finish(new Error('Telnet 连接超时')), timeout + 500);
        socket.setTimeout(timeout);
        socket.once('connect', () => {
            try {
                negotiate(socket, cols, rows);
            } catch (err) {
                finish(err);
                return;
            }
            finish(null, socket);
        });
        socket.once('timeout', () => finish(new Error('Telnet 连接超时')));
        socket.once('error', (err) => finish(err instanceof Error ? err : new Error(String(err))));
        try {
            socket.connect(port, host);
        } catch (err) {
            finish(err instanceof Error ? err : new Error(String(err)));
        }
    });
}


/**
 * In-band auto-login watcher for Telnet.
 * Watches terminal output for login/password prompts and feeds credentials.
 * Returns a feed(text) that may write to the socket; call cancel() to abort.
 */
function createTelnetAutoLogin({
    write,
    username = '',
    password = '',
    timeoutMs = 15000,
    loginRe = /(?:login|username|user)\s*[:：]\s*$/i,
    passwordRe = /(?:password|passwd|口令)\s*[:：]\s*$/i,
    onDone = null,
} = {}) {
    const user = String(username || '');
    const pass = String(password || '');
    if ((!user && !pass) || typeof write !== 'function') {
        return { feed() {}, cancel() {}, get state() { return 'idle'; } };
    }
    let state = user ? 'wait-login' : 'wait-password';
    let buf = '';
    let timer = null;
    let done = false;
    const finish = (reason) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        timer = null;
        state = reason;
        try { onDone?.(reason); } catch {}
    };
    if (timeoutMs > 0) {
        timer = setTimeout(() => finish('timeout'), timeoutMs);
        timer.unref?.();
    }
    const feed = (text) => {
        if (done) return;
        buf += String(text || '');
        // Keep a short trailing window so multi-chunk prompts still match.
        if (buf.length > 512) buf = buf.slice(-512);
        if (state === 'wait-login' && loginRe.test(buf)) {
            try { write(user + '\r\n'); } catch {}
            buf = '';
            state = pass ? 'wait-password' : 'done';
            if (state === 'done') finish('ok');
            return;
        }
        if (state === 'wait-password' && passwordRe.test(buf)) {
            try { write(pass + '\r\n'); } catch {}
            buf = '';
            finish('ok');
        }
    };
    return {
        feed,
        cancel: () => finish('cancelled'),
        get state() { return state; },
    };
}


/**
 * Streaming text decoder for telnet payloads.
 * iconv-lite does not expose a true streaming DecoderStream for every
 * encoding, so we keep a small hangover of trailing incomplete multi-byte
 * sequences (max 4 bytes) and re-decode them with the next chunk.
 */
/**
 * Streaming text decoder for telnet payloads.
 *
 * Strategy: keep the previous chunk's last few bytes and re-decode overlapping
 * windows. For CJK multi-byte encodings (GBK/Big5 max 2), we hold back at most
 * 1 trailing high-byte when it could be a lead byte; for UTF-8 up to 3.
 * On flush(), any remaining hangover is force-decoded.
 */
function createTelnetDecoder(encoding = 'utf-8') {
    let enc = String(encoding || 'utf-8').toLowerCase();
    if (enc === 'utf8') enc = 'utf-8';
    if (enc === 'gb2312' || enc === 'gb18030') enc = 'gbk';
    let hangover = Buffer.alloc(0);
    let iconv = null;
    const needIconv = enc !== 'utf-8' && enc !== 'latin1' && enc !== 'ascii';
    if (needIconv) {
        try { iconv = require('iconv-lite'); }
        catch { enc = 'utf-8'; }
        if (iconv && !iconv.encodingExists(enc)) enc = 'utf-8';
    }

    function decodeBuf(buf) {
        if (!buf.length) return '';
        if (enc === 'utf-8') return buf.toString('utf8');
        if (enc === 'latin1') return buf.toString('latin1');
        if (enc === 'ascii') return buf.toString('ascii');
        if (iconv) return iconv.decode(buf, enc);
        return buf.toString('utf8');
    }

    function incompleteTailLen(buf) {
        if (!buf.length) return 0;
        if (enc === 'utf-8') {
            // Walk back over continuation bytes to find a lead.
            let i = buf.length - 1;
            let cont = 0;
            while (i >= 0 && (buf[i] & 0xc0) === 0x80 && cont < 3) {
                cont += 1;
                i -= 1;
            }
            if (i < 0) return buf.length; // all continuations
            const lead = buf[i];
            let need = 1;
            if ((lead & 0xe0) === 0xc0) need = 2;
            else if ((lead & 0xf0) === 0xe0) need = 3;
            else if ((lead & 0xf8) === 0xf0) need = 4;
            else return 0; // ASCII lead — complete
            const have = buf.length - i;
            return have < need ? have : 0;
        }
        // GBK/Big5/Shift_JIS-style: lead is high-bit, trail is any following.
        // If last byte looks like a lead (high bit) and we cannot prove a pair,
        // hold it. Heuristic: if length is odd counting from last ASCII boundary.
        // Safer: if last byte >= 0x80, hold 1 byte (worst-case 1-char delay).
        if (iconv && buf[buf.length - 1] >= 0x80) {
            // Only hold if it's likely a lead (not a trail completing a pair).
            // Count runs of high bytes from the end.
            let high = 0;
            for (let i = buf.length - 1; i >= 0 && buf[i] >= 0x80; i--) high += 1;
            // Odd number of trailing high bytes → last is an unpaired lead.
            return (high % 2 === 1) ? 1 : 0;
        }
        return 0;
    }

    return {
        get encoding() { return enc; },
        decode(buf) {
            const input = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
            const data = hangover.length ? Buffer.concat([hangover, input]) : input;
            hangover = Buffer.alloc(0);
            if (!data.length) return '';
            const keep = incompleteTailLen(data);
            if (keep > 0) {
                hangover = data.subarray(data.length - keep);
                return decodeBuf(data.subarray(0, data.length - keep));
            }
            return decodeBuf(data);
        },
        encode(text) {
            const s = String(text ?? '');
            if (enc === 'utf-8') return Buffer.from(s, 'utf8');
            if (enc === 'latin1') return Buffer.from(s, 'latin1');
            if (enc === 'ascii') return Buffer.from(s, 'ascii');
            if (iconv) return iconv.encode(s, enc);
            return Buffer.from(s, 'utf8');
        },
        flush() {
            if (!hangover.length) return '';
            const left = hangover;
            hangover = Buffer.alloc(0);
            return decodeBuf(left);
        },
    };
}


/**
 * Map internal destroy/close reasons to a stable close envelope for the client.
 * @param {string} reason
 * @param {'TELNET'|'SSH'|string} [protocol='SSH']
 */
function classifyTerminalClose(reason, protocol = 'SSH') {
    const r = String(reason || '');
    const proto = String(protocol || 'SSH').toUpperCase();
    const label = proto === 'TELNET' ? 'Telnet' : 'SSH';
    if (r === 'client-disconnect' || r === 'ws-close' || r === 'ws-error') {
        return { code: 'client_disconnect', message: '会话已断开', remote: false };
    }
    if (r === 'detached-ttl') {
        return { code: 'detached_ttl', message: `${label} 会话因空闲超时已关闭`, remote: false };
    }
    if (r === 'telnet-close' || r === 'ssh-close' || r.startsWith('shell-close')) {
        return { code: 'remote_close', message: `对端关闭了 ${label} 连接`, remote: true };
    }
    if (r === 'telnet-error' || r === 'ssh-error') {
        return { code: 'remote_error', message: `${label} 连接异常断开`, remote: true };
    }
    if (r === 'session-destroy') {
        return { code: 'session_destroy', message: `${label} 会话已关闭`, remote: false };
    }
    return { code: 'session_closed', message: `${label} 会话已关闭`, remote: false };
}

module.exports = {
    IAC, DO, DONT, WILL, WONT, SB, SE, NOP, GA,
    OPT_ECHO, OPT_SGA, OPT_TTYPE, OPT_NAWS, OPT_BINARY, OPT_STATUS,
    TTYPE_IS, TTYPE_SEND,
    DEFAULT_TERM,
    defaultPort,
    sendNaws,
    negotiate,
    filterIac,
    TelnetIacEngine,
    attachIacEngine,
    dialTelnet,
    createTelnetAutoLogin,
    createTelnetDecoder,
    classifyTerminalClose,
};
