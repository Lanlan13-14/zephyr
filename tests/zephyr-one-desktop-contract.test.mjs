import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Desktop-surface contracts for Zephyr One.
 *
 * These cover the three defects reported against the shipped 0.1.9 Windows
 * build that are not reachable from a Node test process:
 *   1. A bare console window appeared next to the app frame (node.exe was
 *      spawned by a GUI-subsystem parent with no console to inherit).
 *   2. The core listened on all interfaces, which is unacceptable once the
 *      embedded build adopts the local account without credentials.
 *   3. Android/iOS release jobs could stall a desktop publish.
 *
 * Source-level assertions, because the behaviour lives in Rust and in workflow
 * YAML. They are written to fail loudly if the mechanism is removed rather than
 * merely reworded.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

/**
 * Remove comments so a residue scan matches code rather than prose.
 *
 * Deleting a platform means the remaining comments have to name what went away
 * and why; without this, those explanations register as leftovers. Deliberately
 * crude — it only has to be good enough for negative matching, and mangling a
 * URL inside a stripped string cannot produce a false *pass*.
 *
 * @param {string} file path, used only to pick the comment syntax
 * @param {string} text file contents
 * @returns {string} contents with comments blanked out
 */
function stripComments(file, text) {
    if (/\.(toml|sh|py)$/.test(file)) {
        return text.replace(/^\s*#.*$/gm, '').replace(/\s+#.*$/gm, '');
    }
    return text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/^\s*\/\/\/.*$/gm, '')
        .replace(/^\s*\/\/!.*$/gm, '');
}

const runtimeRs = read('zephyr_one/src-tauri/src/runtime/mod.rs');
const mainJs = read('zephyr_one/src/main.js');
const serverJs = read('server.js');
const workflow = read('.github/workflows/zephyr-one.yml');

test('Windows spawns Node with CREATE_NO_WINDOW so no console window appears', () => {
    // windows_subsystem="windows" only detaches the shell's own console; a GUI
    // parent spawning a console-subsystem child still gets a fresh window.
    assert.match(
        read('zephyr_one/src-tauri/src/main.rs'),
        /windows_subsystem\s*=\s*"windows"/,
        'the shell must stay a GUI subsystem binary',
    );

    assert.match(runtimeRs, /use std::os::windows::process::CommandExt;/);
    assert.match(runtimeRs, /const CREATE_NO_WINDOW: u32 = 0x0800_0000;/);
    assert.match(runtimeRs, /cmd\.creation_flags\(CREATE_NO_WINDOW\)/);

    // The flag has to be applied before spawn() or it does nothing.
    const flagAt = runtimeRs.indexOf('cmd.creation_flags(CREATE_NO_WINDOW)');
    const spawnAt = runtimeRs.indexOf('cmd.spawn()');
    assert.ok(flagAt > 0 && spawnAt > 0, 'both sites must exist');
    assert.ok(flagAt < spawnAt, 'creation_flags must be set before spawn()');

    // Windows-only: CommandExt does not exist elsewhere, so an unguarded
    // import would break the Linux/macOS/Android builds.
    const guardAt = runtimeRs.lastIndexOf('#[cfg(target_os = "windows")]', flagAt);
    assert.ok(guardAt > 0 && guardAt < flagAt, 'the flag must sit under a windows cfg guard');

    // Suppressing the console must not cost diagnostics.
    assert.match(runtimeRs, /zephyr-node\.log/);
});

test('embedded mode pins the listener to loopback', () => {
    // Auto-adopting the local account is only defensible while the socket is
    // unreachable from the network.
    assert.match(serverJs, /const ZEPHYR_ONE_EMBEDDED = process\.env\.ZEPHYR_ONE_EMBEDDED === '1';/);
    assert.match(
        serverJs,
        /const EMBEDDED_LISTEN_HOST = ZEPHYR_ONE_EMBEDDED\s*\?\s*'127\.0\.0\.1'/,
        'embedded mode must resolve to 127.0.0.1',
    );
    assert.match(serverJs, /server\.listen\(PORT, listenHost, resolve\)/);
    assert.match(serverJs, /httpsServer\.listen\(HTTPS_PORT, listenHost, resolve\)/);

    // Plain web deployments must keep the previous all-interfaces default,
    // otherwise this change silently breaks every existing install.
    assert.match(serverJs, /process\.env\.ZEPHYR_BIND_HOST/);
    assert.match(serverJs, /server\.listen\(PORT, resolve\)/);
});

test('embedded local session requires a one-time parent-process challenge', () => {
    const exchangeAt = serverJs.indexOf('function exchangeEmbeddedBootstrap');
    assert.ok(exchangeAt > 0, 'bootstrap exchange endpoint must exist');
    const body = serverJs.slice(exchangeAt, exchangeAt + 2400);
    assert.match(body, /mustChangePassword:\s*false/);
    assert.match(body, /storage\.getFirstUser\(\)/);
    assert.match(body, /revokeAllForUser\(user\.userId, 'embedded-session-replaced'/);
    assert.match(body, /consumeEmbeddedStartupChallenge\(\)/);
    assert.match(body, /SameSite=Strict/);
    assert.match(serverJs, /crypto\.timingSafeEqual/);
    assert.match(serverJs, /ZEPHYR_ONE_STARTUP_CHALLENGE/);
    assert.match(serverJs, /createHmac\('sha256', embeddedStartupChallenge\)/);
    assert.match(serverJs, /app\.post\(EMBEDDED_BOOTSTRAP_PATH, exchangeEmbeddedBootstrap\)/);
    assert.doesNotMatch(serverJs, /req\.query\.nonce/);
    assert.doesNotMatch(serverJs, /adoptEmbeddedLocalSession/);
});

test('the shell keeps the startup challenge out of URLs and renderer state', () => {
    assert.match(runtimeRs, /\.env\(STARTUP_CHALLENGE_ENV, &startup_challenge_encoded\)/);
    assert.match(runtimeRs, /ensure_started_inner\(&app, false\)/,
        'autostart must preserve the challenge for the later native handoff');
    assert.match(runtimeRs, /st\.startup_challenge\.take\(\)/,
        'the runtime must consume the challenge during native handoff');
    assert.match(runtimeRs, /\.set\(BOOTSTRAP_HEADER, &challenge\.encoded\(\)\)/);
    assert.match(runtimeRs, /\.set_cookie\(cookie\)/,
        'the native shell must install the HttpOnly session without renderer access');
    assert.match(runtimeRs, /"runtime ready port=\{\} node=\{\}"/,
        'autostart diagnostics may log the port but never the challenge');
    assert.match(mainJs, /state\.runtime = \{ \.\.\.info, baseUrl: cleanOrigin \}/);
    assert.doesNotMatch(runtimeRs, /bootstrap\?nonce|nonce=\{bootstrap/i);
    assert.doesNotMatch(mainJs, /startupChallenge|bootstrapChallenge|bootstrapNonce/,
        'the renderer must never receive or persist the startup challenge');
});

test('embedded mode cannot fall back to the browser RDP proxy', () => {
    const upgradeAt = serverJs.indexOf('function handleHttpUpgrade');
    const targetAt = serverJs.indexOf("const targetWss = pathname === '/ssh'", upgradeAt);
    const embeddedRejectAt = serverJs.indexOf(
        "if (ZEPHYR_ONE_EMBEDDED && pathname === '/rdp-proxy')",
        upgradeAt,
    );
    assert.ok(embeddedRejectAt > upgradeAt && embeddedRejectAt < targetAt,
        'embedded /rdp-proxy must be rejected before WebSocket dispatch');
    assert.match(serverJs.slice(embeddedRejectAt, targetAt), /rejectSocket\(socket, 404, 'Not Found'\)/);
    assert.match(serverJs.slice(targetAt, targetAt + 500), /pathname === '\/rdp-proxy'/,
        'hosted mode must retain the browser RDP proxy dispatch');
});

test('the workflow builds only the three desktop platforms', () => {
    /* Zephyr One is desktop-only. Android and iOS were not merely disabled —
     * their jobs, scripts, configs and Rust branches were deleted, because iOS
     * cannot spawn the Node core at all and Android's libnode.so + APK-asset
     * pipeline is not worth carrying beside the desktop product. A leftover
     * `needs:` entry pointing at a deleted job makes GitHub Actions reject the
     * whole workflow, so this asserts the graph, not just the text. */
    /* Scope to the jobs: block. A bare 2-space-indent match also picks up
     * `push:` under `on:` and `run:` under `defaults:`. */
    const jobsAt = workflow.indexOf('\njobs:');
    assert.ok(jobsAt > 0, 'workflow must declare a jobs: block');
    const jobsBlock = workflow.slice(jobsAt);
    const jobNames = [...jobsBlock.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((m) => m[1]);
    assert.deepEqual(
        jobNames,
        ['test', 'build-windows', 'build-macos', 'build-linux', 'release'],
        'only desktop jobs may exist',
    );

    for (const gone of ['build-android', 'build-ios', 'include_mobile', 'validation_platform']) {
        assert.ok(!jobNames.includes(gone), `${gone} must not be a job`);
    }

    // Every `needs:` target must resolve to a real job.
    for (const match of workflow.matchAll(/needs:\s*(\[[^\]]*\]|[a-z][a-z0-9-]*)/g)) {
        const targets = match[1].startsWith('[')
            ? match[1].slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean)
            : [match[1]];
        for (const target of targets) {
            assert.ok(jobNames.includes(target), `needs: ${target} references a missing job`);
        }
    }
});

test('release depends on the desktop jobs and still tolerates one failing', () => {
    const at = workflow.indexOf('\n  release:');
    assert.ok(at > 0);
    const block = workflow.slice(at, at + 900);
    // always() lets a single failed desktop platform through so the other two
    // still publish; needs.test.result gates on the suite actually passing.
    assert.match(block, /always\(\)/);
    assert.match(block, /needs\.test\.result == 'success'/);
    assert.match(block, /needs: \[test, build-windows, build-macos, build-linux\]/);
});

test('release packaging and notes cover desktop artifacts only', () => {
    const packAt = workflow.indexOf('Pack all platforms');
    assert.ok(packAt > 0, 'the packaging step must exist');
    const pack = workflow.slice(packAt, workflow.indexOf('- uses: softprops/action-gh-release', packAt));
    for (const desktop of ['*.msi', '*.exe', '*.dmg', '*.deb', '*.rpm']) {
        assert.ok(pack.includes(desktop), `${desktop} must still be collected`);
    }
    for (const mobile of ['*.apk', '*.aab', '*.ipa']) {
        assert.ok(!pack.includes(mobile), `${mobile} must no longer be collected`);
    }

    const bodyAt = workflow.indexOf('## Zephyr One ${{ github.event.inputs.tag }}');
    assert.ok(bodyAt > 0, 'release body must exist');
    const body = workflow.slice(bodyAt, workflow.indexOf('files: dist-one/*'));
    for (const platform of ['Windows', 'macOS', 'Linux']) {
        assert.ok(body.includes(platform), `${platform} must be listed`);
    }
    // Mobile may only appear as an explicit removal note, never as an artifact row.
    assert.doesNotMatch(body, /\|\s*(Android|iOS)\s*(APK)?\s*\|/, 'no mobile artifact row');
});

test('the built-in SQLite flag is set unconditionally for every desktop platform', () => {
    /* This flag is why desktop hit the node:sqlite binding divergence at all.
     * It has to stay unconditional: better-sqlite3's addon is compiled for the
     * CI runner's ABI and architecture, which does not match the bundled Node
     * on macOS universal builds. Guarding it per-OS would silently send one
     * platform down the native path. */
    const occurrences = runtimeRs.split('ZEPHYR_ONE_USE_BUILTIN_SQLITE').length - 1;
    assert.equal(occurrences, 1, 'the flag must be set exactly once, not per-OS');

    const flagAt = runtimeRs.indexOf('.env("ZEPHYR_ONE_USE_BUILTIN_SQLITE", "1")');
    assert.ok(flagAt > 0, 'the shared env block must set the built-in SQLite flag');

    // It must not sit inside any cfg-gated block.
    const before = runtimeRs.slice(0, flagAt);
    const lastCfg = before.lastIndexOf('#[cfg(');
    const lastEnvChainStart = before.lastIndexOf('cmd.env("ZEPHYR_DATA_DIR"');
    assert.ok(
        lastEnvChainStart > lastCfg,
        'the flag must be part of the unconditional env chain, not a cfg block',
    );

    assert.match(
        read('sqlite-driver.js'),
        /ZEPHYR_ONE_USE_BUILTIN_SQLITE === '1'/,
        'the driver must honour the flag',
    );
});

test('no Android or iOS surface remains anywhere in the Zephyr One tree', () => {
    /* A deletion this wide fails quietly: a leftover script, capability file or
     * cfg branch keeps building until someone trips over it. Walk the tree. */
    const oneRoot = path.join(root, 'zephyr_one');
    const skip = new Set(['node_modules', 'dist', 'target', 'gen', '.git']);
    const offenders = [];

    const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (skip.has(entry.name)) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(full); continue; }
            if (!/\.(rs|toml|json|mjs|js|sh|py)$/.test(entry.name)) continue;
            /* Comments are stripped first. Explaining *why* mobile was removed
             * necessarily names the things that were removed, and a raw text
             * match would flag that prose as residue — turning every honest
             * comment into a test failure. Only code counts. */
            const code = stripComments(full, readFileSync(full, 'utf8'));
            // Identifiers that would actually still build or link something.
            const hits = [
                /target_os = "android"/,
                /target_os = "ios"/,
                /tauri_plugin_biometric/,
                /libnode\.so/,
                /jniLibs/,
                /AAssetManager/,
                /zephyr-core\.cjs/,
            ].filter((re) => re.test(code));
            if (hits.length) offenders.push(`${path.relative(root, full)} → ${hits.join(', ')}`);
        }
    };
    walk(oneRoot);

    assert.deepEqual(offenders, [], `mobile surface still present:\n${offenders.join('\n')}`);
});

test('mobile-only scripts, configs and assets are gone', () => {
    const gone = [
        'zephyr_one/scripts/prepare-android.sh',
        'zephyr_one/scripts/build-android-embedded-core.mjs',
        'zephyr_one/scripts/bundle-node-android.sh',
        'zephyr_one/scripts/fetch-node-android.sh',
        'zephyr_one/scripts/patch-android-manifest.sh',
        'zephyr_one/scripts/stamp-android-icons.py',
        'zephyr_one/scripts/verify-android-apk.sh',
        'zephyr_one/scripts/verify-android-core.sh',
        'zephyr_one/scripts/verify-android-node-binary.sh',
        'zephyr_one/scripts/android-emulator-smoke.sh',
        'zephyr_one/src-tauri/tauri.android.conf.json',
        'zephyr_one/src-tauri/capabilities/mobile.json',
        'zephyr_one/platform_assets/android',
    ];
    for (const rel of gone) {
        assert.ok(!existsSync(path.join(root, rel)), `${rel} must be deleted`);
    }

    // package.json must not advertise android:* scripts any more.
    const pkg = JSON.parse(read('zephyr_one/package.json'));
    const mobileScripts = Object.keys(pkg.scripts || {}).filter((k) => /android|ios/i.test(k));
    assert.deepEqual(mobileScripts, [], 'no mobile npm scripts may remain');

    /* The crate is desktop-only, so assert the declared crate-type positively.
     * A `doesNotMatch(/staticlib/)` would trip over the comment that records
     * why those link kinds were dropped. */
    const cargo = read('zephyr_one/src-tauri/Cargo.toml');
    assert.match(
        cargo,
        /crate-type = \["rlib"\]/,
        'main.rs links the lib normally; staticlib (iOS) and cdylib (Android JNI) cost link time for nothing',
    );
    const cargoCode = stripComments('Cargo.toml', cargo);
    assert.doesNotMatch(cargoCode, /^jni\s*=/m, 'the jni dependency was Android-only');
    assert.doesNotMatch(cargoCode, /tauri-plugin-biometric/, 'biometric plugin was mobile-only');
    assert.doesNotMatch(cargoCode, /target_os = "(android|ios)"/, 'no mobile target blocks may remain');
});
