'use strict';
/*
 * telnet-transport.js — Telnet IAC helpers (FREEZE plan §5.6).
 *
 * Pure protocol helpers shared by Node /ssh (default path) and tests.
 * Full session pump lives in server.js WS handler; Go worker has a
 * parallel implementation in zephyr-worker/telnet.go.
 */

const net = require('net');

const IAC = 255;
const DONT = 254;
const DO = 253;
const WONT = 252;
const WILL = 251;
const SB = 250;
const SE = 240;

const OPT_ECHO = 1;
const OPT_SGA = 3;
const OPT_TTYPE = 24;
const OPT_NAWS = 31;

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
 * Incomplete trailing IAC sequences are dropped (caller should not need
 * them for display).
 */
function filterIac(data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const out = [];
    let i = 0;
    while (i < buf.length) {
        if (buf[i] !== IAC) {
            out.push(buf[i]);
            i += 1;
            continue;
        }
        if (i + 1 >= buf.length) break;
        const cmd = buf[i + 1];
        if (cmd === IAC) {
            out.push(IAC);
            i += 2;
            continue;
        }
        if (cmd === DO || cmd === DONT || cmd === WILL || cmd === WONT) {
            i += 3;
            continue;
        }
        if (cmd === SB) {
            let end = i + 2;
            while (end < buf.length - 1) {
                if (buf[end] === IAC && buf[end + 1] === SE) break;
                end += 1;
            }
            i = end + 2;
            continue;
        }
        i += 2;
    }
    return Buffer.from(out);
}

/**
 * Open a raw TCP Telnet connection and run initial option negotiation.
 * Auth is in-band (username/password typed into the terminal).
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

module.exports = {
    IAC, DO, DONT, WILL, WONT, SB, SE,
    OPT_ECHO, OPT_SGA, OPT_TTYPE, OPT_NAWS,
    defaultPort,
    sendNaws,
    negotiate,
    filterIac,
    dialTelnet,
};
