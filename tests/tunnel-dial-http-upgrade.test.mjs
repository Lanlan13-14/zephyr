import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { test } from 'node:test';

/*
 * After #164 the Agent stream actually attaches. The next hop is Node's
 * linkTunnelDial: a loopback HTTP POST that expects an `upgrade` event, then
 * a raw TCP socket to the Agent tunnel.
 *
 * Go used to Hijack and immediately copy tunnel bytes onto that connection
 * without writing a 101. Node's HTTP parser is still waiting for "HTTP/"
 * and treats the first tunnel byte as a new response →
 * "Parse Error: Expected HTTP/". That is the new user-visible error.
 *
 * This file talks to a fake Go dial endpoint that reproduces both sides.
 */

function dial(port, { upgradeHeaders, hijackWrites101 }) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ sessionId: 's1', host: '127.0.0.1', port: 1 });
        const headers = {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
        };
        if (upgradeHeaders) {
            headers.Connection = 'Upgrade';
            headers.Upgrade = 'tcp';
        }
        const req = http.request({
            host: '127.0.0.1', port, path: '/internal/tunnel/dial', method: 'POST', headers,
        });
        req.on('upgrade', (res, socket, head) => {
            socket.setTimeout(0);
            if (head && head.length) socket.unshift(head);
            resolve({ how: 'upgrade', status: res.statusCode, socket });
        });
        req.on('response', (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({
                how: 'response',
                status: res.statusCode,
                body: Buffer.concat(chunks).toString('utf8'),
            }));
        });
        req.on('error', (err) => reject(err));
        req.setTimeout(2000, () => req.destroy(new Error('timeout')));
        req.write(body);
        req.end();
    });
}

function listenFakeGo({ write101 }) {
    return new Promise((resolve) => {
        const server = http.createServer();
        server.on('request', (req, res) => {
            if (req.url !== '/internal/tunnel/dial') {
                res.statusCode = 404;
                res.end();
                return;
            }
            const hj = res.socket ? req : req;
            // Always hijack like the Go handler does after a successful dial.
            const { socket } = req;
            // Consume the body then hijack the same way Go does: no more HTTP.
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => {
                // Hijack: Node's http.Server stops owning the socket once we
                // prevent the default response. We grab res.socket via the
                // documented HTTP hijack path.
            });
        });
        // Use a raw TCP server so we can exactly match Go: read HTTP POST,
        // then either write 101 or start sending binary.
        const raw = net.createServer((socket) => {
            let buf = Buffer.alloc(0);
            const onData = (c) => {
                buf = Buffer.concat([buf, c]);
                if (!buf.includes('\r\n\r\n')) return;
                socket.off('data', onData);
                if (write101) {
                    socket.write(
                        'HTTP/1.1 101 Switching Protocols\r\n'
                        + 'Connection: Upgrade\r\n'
                        + 'Upgrade: tcp\r\n'
                        + '\r\n'
                        + 'HELLO-TUNNEL',
                    );
                } else {
                    // Pre-fix Go: hijack and dump tunnel bytes with no HTTP
                    // status line. Node's parser emits Parse Error: Expected HTTP/.
                    socket.write(Buffer.from('HELLO-TUNNEL'));
                }
            };
            socket.on('data', onData);
        });
        raw.listen(0, '127.0.0.1', () => {
            resolve({
                port: raw.address().port,
                close: () => new Promise((r) => raw.close(r)),
            });
        });
    });
}

test('Node http.request without a 101 surfaces Parse Error: Expected HTTP/', async () => {
    const fake = await listenFakeGo({ write101: false });
    try {
        await assert.rejects(
            () => dial(fake.port, { upgradeHeaders: false }),
            (err) => {
                assert.match(String(err.message), /Parse Error: Expected HTTP/);
                return true;
            },
        );
    } finally {
        await fake.close();
    }
});

test('Node http.request with Connection: Upgrade + a 101 yields the raw tunnel socket', async () => {
    const fake = await listenFakeGo({ write101: true });
    try {
        const result = await dial(fake.port, { upgradeHeaders: true });
        assert.equal(result.how, 'upgrade');
        assert.equal(result.status, 101);
        const got = await new Promise((resolve, reject) => {
            const chunks = [];
            result.socket.on('data', (c) => {
                chunks.push(c);
                const all = Buffer.concat(chunks);
                if (all.includes('HELLO-TUNNEL')) resolve(all.toString());
            });
            result.socket.on('error', reject);
            setTimeout(() => reject(new Error('no tunnel bytes')), 1500);
        });
        assert.match(got, /HELLO-TUNNEL/);
        result.socket.destroy();
    } finally {
        await fake.close();
    }
});
