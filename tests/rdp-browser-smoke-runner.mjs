import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const chromium = ['chromium', 'chromium-browser', 'google-chrome'].find((name) => spawnSync('sh', ['-c', `command -v ${name}`]).status === 0);
if (!chromium) {
    console.error('Chromium is required for test:browser-smoke');
    process.exit(2);
}
const port = 18765;
const server = spawn(process.execPath, ['tests/static-smoke-server.mjs', String(port)], { stdio: 'ignore' });
try {
    await new Promise((resolve) => setTimeout(resolve, 500));
    for (const page of [
        { path: 'tests/rdp-renderer-browser-smoke.html', validate(value) { return value.ok && value.presents?.[0] === 1 && value.pixels?.length === 32; } },
        { path: 'tests/go-worker-runtime-smoke.html', validate(value) { return value.ok && value.hasImportObject === true; } },
    ]) {
        const result = spawnSync(chromium, ['--headless', '--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--virtual-time-budget=12000', '--dump-dom', `http://127.0.0.1:${port}/${page.path}`], { encoding: 'utf8', timeout: 30000 });
        if (result.error) throw result.error;
        const match = result.stdout.match(/<pre id="out">([^<]+)<\/pre>/);
        if (!match) throw new Error(`${page.path} result missing: ${result.stderr}`);
        const raw = match[1].replaceAll('&quot;', '"');
        if (raw === 'running') throw new Error(`${page.path} did not complete before Chromium exited`);
        const value = JSON.parse(raw);
        if (!page.validate(value)) throw new Error(`${page.path} failed: ${JSON.stringify(value)}`);
        console.log(`${page.path}: ${JSON.stringify(value)}`);
    }
} finally {
    server.kill('SIGTERM');
}
