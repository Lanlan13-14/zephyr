#!/usr/bin/env node
// Direct RDP protocol test: connect to XRDP target through the zephyr proxy
// and capture what the server sends after the protocol handshake.

const WebSocket = require('ws');
const tls = require('tls');
const net = require('net');
const crypto = require('crypto');

const TARGET = process.argv[2] || 'zephyr-rdp-target:3389';
const PROXY_URL = process.argv[3] || 'ws://127.0.0.1:3443/rdp-proxy';
const USER = process.argv[4] || 'ubuntu';
const PASS = process.argv[5] || 'ubuntu';

// We need a cookie. Let's get one first.
const http = require('https');
const cookieJar = {};

function login() {
    return new Promise((resolve, reject) => {
        const req = http.request('https://127.0.0.1:3443/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            rejectUnauthorized: false,
        }, (res) => {
            const cookies = res.headers['set-cookie'] || [];
            for (const c of cookies) {
                const m = c.match(/^([^=]+)=([^;]+)/);
                if (m) cookieJar[m[1]] = m[2];
            }
            let body = '';
            res.on('data', d => body += d);
            res.on('end', () => resolve(cookieJar));
        });
        req.on('error', reject);
        req.write(JSON.stringify({ username: 'admin', password: 'be81e55a1bb073e7f6f0' }));
        req.end();
    });
}

async function main() {
    await login();
    const cookieStr = Object.entries(cookieJar).map(([k,v]) => `${k}=${v}`).join('; ');
    console.log('[TEST] Got cookie:', cookieStr.substring(0, 50) + '...');

    const wsUrl = `${PROXY_URL}?flow=v2&target=${TARGET}`;
    console.log('[TEST] Connecting to:', wsUrl);

    const ws = new WebSocket(wsUrl, {
        headers: { Cookie: cookieStr },
        rejectUnauthorized: false,
    });
    ws.binaryType = 'arraybuffer';

    let totalRx = 0;
    let totalTx = 0;
    let stage = 'ws-connecting';

    ws.on('open', () => {
        console.log('[TEST] WebSocket connected');
        stage = 'x224-cr';

        // Send X.224 Connection Request with SSL|HYBRID
        const cr = Buffer.from([
            3, 0, 0, 19,        // TPKT
            11, 0xE0, 0, 0, 0,  // X.224 CR
            1, 0, 8, 0x03, 0, 0, 0, 0  // Negotiation: SSL|HYBRID
        ]);
        ws.send(cr);
        totalTx += cr.length;
        console.log('[TEST] Sent X.224 CR (SSL|HYBRID)');
    });

    ws.on('message', (data, isBinary) => {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        totalRx += buf.length;

        if (stage === 'x224-cr') {
            console.log('[TEST] X.224 Response:', buf.length, 'bytes');
            console.log('[TEST]   hex:', buf.toString('hex'));
            if (buf.length >= 19) {
                const negType = buf[11];
                const selectedProto = buf.readUInt32LE(15);
                const protoNames = {0:'STANDARD',1:'SSL',2:'HYBRID',3:'SSL|HYBRID',4:'HYBRID_EX'};
                console.log('[TEST]   Negotiation: type=' + negType + ' proto=' + selectedProto + ' (' + (protoNames[selectedProto]||'?') + ')');
                stage = 'tls-handshake';
                console.log('[TEST] Server selected protocol, TLS handshake needed (not doing TLS, will fail)');
                // We can't do TLS over WebSocket easily - the Go WASM does it internally
                // Let's just observe what comes
            }
            return;
        }

        // Just log data
        if (totalRx % 10000 < buf.length) {
            console.log(`[TEST] Data: rx=${totalRx} tx=${totalTx} stage=${stage} chunk=${buf.length}`);
        }
    });

    ws.on('close', (code, reason) => {
        console.log('[TEST] WebSocket closed:', code, reason.toString());
        console.log('[TEST] Total: rx=' + totalRx + ' tx=' + totalTx);
    });

    ws.on('error', (err) => {
        console.error('[TEST] WebSocket error:', err.message);
    });

    // Close after 15 seconds
    setTimeout(() => {
        console.log('[TEST] Timeout, closing. rx=' + totalRx + ' tx=' + totalTx);
        ws.close();
        process.exit(0);
    }, 15000);
}

main().catch(console.error);
