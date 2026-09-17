import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

// Tiny replica of server.js proxyLinkV2Stream, used by the Go test
// TestAgentTunnelThroughNodeWs to prove the Agent can attach a stream
// through Node's `ws` library — the hop the Go unit tests never take.

const target = process.argv[2];
if (!target) {
    process.stderr.write('usage: node ws-stream-proxy.mjs <go-httptest-url>\n');
    process.exit(2);
}

const server = createServer();
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
    const u = new URL(req.url || '/', 'http://localhost');
    const sessionId = u.searchParams.get('sessionId') || '';
    if (!sessionId) {
        socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
    }
    const dest = `${target.replace(/^http/, 'ws')}/stream?sessionId=${encodeURIComponent(sessionId)}`;
    const upstream = new WebSocket(dest);
    const queue = [];
    upstream.on('open', () => {
        for (const m of queue) upstream.send(m);
        queue.length = 0;
    });
    wss.handleUpgrade(req, socket, head, (ws) => {
        upstream.on('message', (data) => {
            if (ws.readyState === ws.OPEN) ws.send(data);
        });
        upstream.on('close', () => { try { ws.close(); } catch {} });
        upstream.on('error', () => { try { ws.close(); } catch {} });
        ws.on('message', (data) => {
            if (upstream.readyState === WebSocket.OPEN) upstream.send(data);
            else queue.push(data);
        });
        ws.on('close', () => { try { upstream.close(); } catch {} });
        ws.on('error', () => { try { upstream.close(); } catch {} });
    });
});

server.listen(0, '127.0.0.1', () => {
    process.stdout.write(`${server.address().port}\n`);
});
