/**
 * Real-Chromium runner for the RDP folder-mapping collapse.
 *
 * Static contract tests can prove the CSS rules and the JS toggle exist. They
 * cannot prove that `grid-template-rows: 0fr -> 1fr` actually resolves to the
 * content height and interpolates, because that is a layout result. This runner
 * loads the real public/style.css and the real markup in Chromium and asserts
 * measured geometry.
 *
 * Deliberately mirrors tests/terminal-split-grid-browser-runner.mjs: same static
 * server, same flag set, same --dump-dom capture. Two flags matter and are not
 * cosmetic:
 *   --disable-gpu      : software raster; the container has no GPU.
 *   no --virtual-time-budget : it expires before the ~600KB stylesheet finishes
 *                        loading, and --dump-dom then returns an empty body.
 *
 * Not part of `npm test` for the same reason the split-grid one is not: it needs
 * a Chromium binary. Run with `npm run test:rdp-fold-browser`.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const candidates = [
    process.env.CHROMIUM_BIN,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
].filter(Boolean);
const chromium = candidates.find(existsSync);
if (!chromium) {
    console.error('Chromium is required for test:rdp-fold-browser');
    process.exit(2);
}

const port = 18700 + (process.pid % 900);
const url = `http://127.0.0.1:${port}/tests/rdp-folder-mapping-browser-smoke.html`;
const server = spawn(process.execPath, ['tests/static-smoke-server.mjs', String(port)], { stdio: 'ignore' });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForServer() {
    for (let i = 0; i < 60; i++) {
        try {
            const response = await fetch(`http://127.0.0.1:${port}/public/style.css`);
            if (response.ok) return;
        } catch { /* not up yet */ }
        await wait(100);
    }
    throw new Error('static smoke server did not become ready');
}

function runChromium() {
    const profile = mkdtempSync(join(tmpdir(), 'zephyr-rdpfold-'));
    try {
        return spawnSync(chromium, [
            '--headless', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
            `--user-data-dir=${profile}`,
            '--window-size=1440,900',
            '--force-device-scale-factor=1',
            '--hide-scrollbars',
            '--dump-dom', url,
        ], { encoding: 'utf8', timeout: 90000 });
    } finally {
        rmSync(profile, { recursive: true, force: true });
    }
}

let exitCode = 0;
try {
    await waitForServer();
    const result = runChromium();
    const dom = String(result.stdout || '');
    if (!dom.trim()) {
        console.error('Chromium produced an empty DOM dump');
        console.error(String(result.stderr || '').slice(-2000));
        process.exit(1);
    }

    /* The smoke page writes its report into #results. Pull it back out. */
    const at = dom.indexOf('<pre id="results">');
    if (at === -1) {
        console.error('#results element missing from the DOM dump');
        console.error(dom.slice(0, 1500));
        process.exit(1);
    }
    const raw = dom.slice(at + '<pre id="results">'.length, dom.indexOf('</pre>', at));
    const report = raw
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&');

    console.log(report);

    if (report.startsWith('runner did not execute')) {
        console.error('\nthe smoke script never ran (check for a thrown error above)');
        exitCode = 1;
    } else {
        const header = report.split('\n')[0];
        const failures = Number((header.match(/FAILURES (\d+)/) || [])[1] ?? -1);
        const checks = Number((header.match(/CHECKS (\d+)/) || [])[1] ?? -1);
        if (checks <= 0) {
            console.error('\nno checks ran');
            exitCode = 1;
        } else if (failures !== 0) {
            console.error(`\n${failures} check(s) failed`);
            exitCode = 1;
        } else {
            console.log(`\nall ${checks} browser checks passed`);
        }
    }
} catch (error) {
    console.error(error);
    exitCode = 1;
} finally {
    server.kill();
}
process.exit(exitCode);
