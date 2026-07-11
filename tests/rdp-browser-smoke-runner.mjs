import { spawn, spawnSync } from 'node:child_process';

const chromium = ['chromium', 'chromium-browser', 'google-chrome'].find((name) => spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).status === 0);
if (!chromium) { console.error('Chromium is required for test:browser-smoke'); process.exit(2); }
const port = 18765;
const server = spawn(process.execPath, ['tests/static-smoke-server.mjs', String(port)], { stdio: 'ignore' });
try {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const result = spawnSync(chromium, ['--headless', '--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--virtual-time-budget=3000', '--dump-dom', `http://127.0.0.1:${port}/tests/rdp-renderer-browser-smoke.html`], { encoding: 'utf8', timeout: 30000 });
    if (result.error) throw result.error;
    const match = result.stdout.match(/<pre id="out">([^<]+)<\/pre>/);
    if (!match) throw new Error(`smoke result missing: ${result.stderr}`);
    const value = JSON.parse(match[1].replaceAll('&quot;', '"'));
    if (!value.ok || value.presents?.[0] !== 1 || value.pixels?.length !== 32) throw new Error(`smoke failed: ${JSON.stringify(value)}`);
    console.log(JSON.stringify(value));
} finally {
    server.kill('SIGTERM');
}
