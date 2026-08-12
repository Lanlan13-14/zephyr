import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { applyEmbeddedSurface } = require('../zephyr-one-embed-surface.js');

const root = process.cwd();
const port = Number(process.argv[2]) || 18765;
const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    // Chrome refuses a stylesheet served with a non-CSS MIME in standards mode,
    // so layout smokes that load the real public/style.css need this entry.
    '.css': 'text/css; charset=utf-8',
    '.wasm': 'application/wasm',
};
http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname === '/__zephyr-one-app.html') {
        fs.readFile(path.join(root, 'public', 'app.html'), 'utf8', (error, source) => {
            if (error) { res.writeHead(404).end(); return; }
            try {
                res.setHeader('Content-Type', types['.html']);
                res.end(applyEmbeddedSurface(source).html);
            } catch (transformError) {
                res.writeHead(500).end(String(transformError && transformError.message));
            }
        });
        return;
    }
    if (pathname === '/zephyr-one-embed.css' || pathname === '/zephyr-one-rdp-settings.js') {
        const file = path.join(root, pathname.slice(1));
        fs.readFile(file, (error, data) => {
            if (error) { res.writeHead(404).end(); return; }
            res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
            res.end(data);
        });
        return;
    }
    const file = path.resolve(root, `.${pathname}`);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (error, data) => {
        if (error) { res.writeHead(404).end(); return; }
        res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
        res.end(data);
    });
}).listen(port, '127.0.0.1');
