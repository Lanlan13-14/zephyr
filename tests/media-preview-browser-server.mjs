import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const fixtures = path.resolve(process.env.MEDIA_FIXTURES || path.join(root, 'tests/fixtures/media'));
const port = Number(process.argv[2]) || 18769;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.wasm': 'application/wasm', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.avi': 'video/x-msvideo', '.aiff': 'audio/aiff' };
http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (req.method === 'POST' && pathname === '/result') {
        let body = ''; req.on('data', chunk => { body += chunk; });
        req.on('end', () => { console.log(body); res.end('ok'); }); return;
    }
    const base = pathname.startsWith('/fixtures/') ? fixtures : root;
    const relative = pathname === '/tests' ? 'tests/media-preview-browser.html' : pathname.startsWith('/fixtures/') ? pathname.slice(10) : 'public'+pathname;
    const file = path.resolve(base, relative);
    if (!file.startsWith(base+path.sep)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404).end(); return; }
        res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
        res.setHeader('Cache-Control','no-store'); res.end(data);
    });
}).listen(port, '127.0.0.1', () => console.error('Media browser tests listening on '+port));
