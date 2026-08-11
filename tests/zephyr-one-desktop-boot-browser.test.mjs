/*
 * Boots the staged Zephyr One core and loads the app in a real browser.
 *
 * Every other test in this repository reasons about source text or about HTTP
 * status codes. Neither can catch the defect that actually shipped: app.js threw
 * `Cannot read properties of null` inside bindEvents() because the embed
 * transform removes the credential surface app.js binds to non-optionally. The
 * throw aborted init(), so the static shell painted, every asset returned 200,
 * and the app never finished loading. That is what the packaged desktop app
 * showed as a failed load, and it is why the header kept the emoji placeholder
 * and the window title stayed 'Zephyr'.
 *
 * So this executes the page. A console error or an uncaught exception fails the
 * test, and the brand is read back out of the live DOM rather than inferred.
 *
 * Skipped when no Chromium-family browser is present, because CI images vary.
 * The static gate in zephyr-one-embed-dom-contract.test.mjs is what runs
 * everywhere; this is the one that proves the page really boots.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, closeBrowser, collectPageDiagnostics, findBrowser } from './helpers/cdp-harness.mjs';
import { createSecureTestDataDir, removeSecureTestDataDir } from './helpers/secure-data-dir.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CORE = join(ROOT, 'zephyr_one', 'zephyr-core');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browserBin = findBrowser();
/* A source-tree stage can resolve dependencies from the repository's parent
 * node_modules; release staging installs its own copy. Accept both layouts so
 * the browser test does not skip after a dependency-free local restage. */
const coreDependencies = existsSync(join(CORE, 'node_modules')) || existsSync(join(ROOT, 'node_modules'));
const coreStaged = existsSync(join(CORE, 'server.js')) && coreDependencies;

/* Both preconditions are environmental, so they skip rather than fail: a
 * developer without a staged core should not see a red suite for it. */
const skip = !browserBin
    ? 'no Chromium-family browser found'
    : (!coreStaged ? 'zephyr_one/zephyr-core is not staged (run scripts/stage-zephyr-core.sh)' : false);

test('the packaged Zephyr One shell boots without a load failure', { skip }, async () => {
    const dataFixture = createSecureTestDataDir('zephyr-boot-data-');
    const dataDir = dataFixture.dataDir;
    const port = 39000 + Math.floor(Math.random() * 2000);
    const startupChallenge = crypto.randomBytes(32).toString('hex');
    const encryptionKey = crypto.randomBytes(32).toString('base64url');
    const webDavBackupKey = crypto.randomBytes(32).toString('base64url');
    const webDavCredentialKey = crypto.randomBytes(32).toString('base64url');

    const core = spawn(process.execPath, ['server.js'], {
        cwd: CORE,
        env: {
            ...process.env,
            ZEPHYR_DATA_DIR: dataDir,
            HTTP_ENABLED: 'true',
            HTTPS_ENABLED: 'false',
            PORT: String(port),
            PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
            ZEPHYR_ONE_EMBEDDED: '1',
            ZEPHYR_ONE_STARTUP_CHALLENGE: startupChallenge,
            ZEPHYR_ONE_USE_BUILTIN_SQLITE: '1',
            ENCRYPTION_KEY: encryptionKey,
            WEBDAV_BACKUP_KEY: webDavBackupKey,
            WEBDAV_CREDENTIAL_KEY: webDavCredentialKey,
            /* The AI tool host binds a FIXED loopback port (127.0.0.1:3080 by
             * default), so two cores in one test run collide with EADDRINUSE and
             * the second never becomes healthy. Observed directly: running this
             * beside zephyr-one-desktop-surface-live.test.mjs failed five of its
             * assertions with `listen EADDRINUSE 127.0.0.1:3080`, which reads as a
             * product defect but is purely test contention. Derived from this
             * test's own port so the two can never overlap. */
            ZEPHYR_AI_HOST_LISTEN: `127.0.0.1:${port + 2}`,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let coreLog = '';
    core.stdout.on('data', (d) => { coreLog += d.toString(); });
    core.stderr.on('data', (d) => { coreLog += d.toString(); });

    let browser = null;
    let page = null;
    try {
        const deadline = Date.now() + 60000;
        let up = false;
        while (Date.now() < deadline) {
            try {
                if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) { up = true; break; }
            } catch { /* not listening yet */ }
            await sleep(300);
        }
        assert.ok(up, 'the staged core must start\n' + coreLog.slice(-1500));

        const bootstrap = await fetch(`http://127.0.0.1:${port}/__zephyr_one/bootstrap`, {
            method: 'POST',
            headers: { 'x-zephyr-one-bootstrap-challenge': startupChallenge },
        });
        assert.equal(bootstrap.status, 204);
        const sid = (bootstrap.headers.get('set-cookie') || '').split(';')[0].split('=')[1];
        assert.match(sid, /^[A-Za-z0-9_-]{43,128}$/);

        browser = await launchBrowser({ port: port + 1 });
        page = await collectPageDiagnostics(
            browser.wsUrl,
            `http://127.0.0.1:${port}/app.html?zephyrOne=1`,
            {
                settleMs: 6000,
                cookies: [{
                    name: 'zephyr_sid',
                    value: sid,
                    url: `http://127.0.0.1:${port}/`,
                    path: '/',
                    httpOnly: true,
                    sameSite: 'Strict',
                }],
            },
        );

        /* The assertion that would have caught the shipped defect. */
        assert.deepEqual(
            page.exceptions,
            [],
            'the page must not throw:\n' + page.exceptions.join('\n')
                + '\nfailed requests: ' + JSON.stringify(page.failedRequests)
                + '\nscript responses: ' + JSON.stringify(page.scriptResponses),
        );
        assert.deepEqual(
            page.consoleErrors,
            [],
            'the page must log no errors:\n' + page.consoleErrors.join('\n'),
        );

        /* A 404 from the workspace restore is expected on a fresh database and is
         * explicitly tolerated by app.js; anything else is a real failure. */
        const unexpected = page.failedRequests.filter((f) => !/\/restore$/.test(f.url));
        assert.deepEqual(unexpected, [], 'unexpected failed requests: ' + JSON.stringify(unexpected));

        /* init() must have run to completion. Read from the live DOM: this is the
         * evidence that the branding code executed, not merely that it exists. */
        const state = await page.evaluate(`(() => ({
            title: document.title,
            brandName: document.querySelector('#brandName')?.textContent || '',
            brandHasSvg: !!document.querySelector('#brandIcon svg'),
            brandHasWordmark: /<text/.test(document.querySelector('#brandIcon')?.innerHTML || ''),
            productMarker: document.documentElement.dataset.zephyrProduct || '',
            visibleViews: [...document.querySelectorAll('.view')].filter((v) => v.offsetParent !== null).map((v) => v.id),
        }))()`);

        assert.equal(state.productMarker, 'one', 'the embed transform must mark the document as One');
        assert.equal(state.brandName, 'Zephyr One', 'the header must name this product, not Zephyr');
        assert.equal(state.title, 'Zephyr One', 'and so must the window title');

        /* The mark must be the real artwork rather than the seeded emoji, and at
         * the header's 24px it must be the compact form: the wordmark is 1.8px
         * tall there, which is what read as a blurry logo. */
        assert.ok(state.brandHasSvg, 'the header mark must be the product artwork, not the emoji placeholder');
        assert.equal(state.brandHasWordmark, false, 'the 24px header mark must drop the sub-pixel wordmark');

        assert.ok(state.visibleViews.length > 0, 'a view must be visible; an aborted init leaves none');
    } finally {
        if (page) page.close();
        if (browser) closeBrowser(browser);
        core.kill();
        try { removeSecureTestDataDir(dataFixture); } catch { /* best effort */ }
    }
});
