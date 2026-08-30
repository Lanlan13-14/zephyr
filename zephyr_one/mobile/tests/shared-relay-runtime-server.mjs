import http from 'node:http';
import net from 'node:net';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

export async function startSharedRelayRuntimeServer() {
  let attach = null;
  const target = net.createServer((socket) => {
    socket.write('banner');
    socket.on('data', (bytes) => socket.write(Buffer.from('echo:' + bytes.toString('utf8'))));
  });
  const targetPort = await listen(target);

  const httpServer = http.createServer();
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => protocols.has('zephyr-shared-relay-v1')
      ? 'zephyr-shared-relay-v1'
      : false,
  });
  httpServer.on('upgrade', (req, socket, head) => {
    if (req.url !== '/relay') return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });
  wss.on('connection', (ws, req) => {
    const protocols = String(req.headers['sec-websocket-protocol'] || '').split(',').map((v) => v.trim());
    attach = { path: req.url, credential: protocols.find((v) => v !== 'zephyr-shared-relay-v1') || '' };
    const upstream = net.createConnection({ host: '127.0.0.1', port: targetPort });
    upstream.on('data', (bytes) => ws.send(bytes));
    ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString('utf8'));
      if (frame.type === 'input') upstream.write(String(frame.data || ''));
      else if (frame.type === 'resize') ws.send(JSON.stringify({ type: 'resized', cols: frame.cols, rows: frame.rows }));
    });
    ws.on('close', () => upstream.destroy());
    upstream.on('close', () => ws.close());
  });
  const relayPort = await listen(httpServer);
  return {
    relayUrl: `ws://127.0.0.1:${relayPort}/relay`,
    attach: () => attach,
    close: async () => {
      for (const client of wss.clients) client.terminate();
      await Promise.all([
        new Promise((resolve) => httpServer.close(resolve)),
        new Promise((resolve) => target.close(resolve)),
      ]);
    },
  };
}
