import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Desktop-surface contracts for Zephyr One (Electron).
 *
 * These cover the defects reported against the old Tauri Windows build that
 * must still hold after the shell moved to Electron:
 *   1. A bare console window must not appear next to the app frame.
 *   2. The core listens on loopback only.
 *   3. Android/iOS release jobs must not stall a desktop publish.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

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

const runtimeJs = read('zephyr_one/electron/runtime.mjs');
const mainJs = read('zephyr_one/src/main.js');
const electronMain = read('zephyr_one/electron/main.mjs');
const serverJs = read('server.js');
const workflow = read('.github/workflows/zephyr-one.yml');

test('Windows spawns Node with windowsHide so no console window appears', () => {
    assert.match(runtimeJs, /windowsHide:\s*true/);
    const flagAt = runtimeJs.indexOf('windowsHide: true');
    const spawnAt = runtimeJs.indexOf('spawn(node');
    assert.ok(flagAt > 0 && spawnAt > 0);
    assert.ok(flagAt < spawnAt, 'windowsHide must be set before spawn()');
    assert.match(runtimeJs, /zephyr-autostart\.log/);
});

test('embedded mode pins the listener to loopback', () => {
    assert.match(serverJs, /const ZEPHYR_ONE_EMBEDDED = process\.env\.ZEPHYR_ONE_EMBEDDED === '1';/);
    assert.match(
        serverJs,
        /const EMBEDDED_LISTEN_HOST = ZEPHYR_ONE_EMBEDDED\s*\?\s*'127\.0\.0\.1'/,
        'embedded mode must resolve to 127.0.0.1',
    );
    assert.match(serverJs, /server\.listen\(PORT, listenHost, resolve\)/);
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
    assert.match(runtimeJs, /STARTUP_CHALLENGE_ENV/);
    assert.match(runtimeJs, /ZEPHYR_ONE_STARTUP_CHALLENGE/);
    assert.match(runtimeJs, /BOOTSTRAP_HEADER/);
    assert.match(runtimeJs, /sessionCookie/);
    assert.match(runtimeJs, /httpOnly:\s*true/);
    assert.match(electronMain, /cookies\.set\(cookie\)/);
    assert.match(mainJs, /state\.runtime = \{ \.\.\.info, baseUrl: cleanOrigin \}/);
    assert.doesNotMatch(runtimeJs, /bootstrap\?nonce|nonce=\{bootstrap/i);
    assert.doesNotMatch(mainJs, /startupChallenge|bootstrapChallenge|bootstrapNonce/,
        'the renderer must never receive or persist the startup challenge');
});

test('embedded mode keeps the Web WASM RDP proxy', () => {
    const upgradeAt = serverJs.indexOf('function handleHttpUpgrade');
    const targetAt = serverJs.indexOf("const targetWss = pathname === '/ssh'", upgradeAt);
    assert.ok(upgradeAt > 0 && targetAt > upgradeAt);
    assert.doesNotMatch(
        serverJs.slice(upgradeAt, targetAt),
        /ZEPHYR_ONE_EMBEDDED && pathname === '\/rdp-proxy'/,
        'embedded One must not 404 the Web RDP proxy',
    );
    assert.match(serverJs.slice(targetAt, targetAt + 500), /pathname === '\/rdp-proxy'/);
});

test('the workflow builds only the three desktop platforms', () => {
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
    assert.match(block, /always\(\)/);
    assert.match(block, /needs\.test\.result == 'success'/);
    assert.match(block, /needs: \[test, build-windows, build-macos, build-linux\]/);
});

test('release packaging and notes cover desktop artifacts only', () => {
    const packAt = workflow.indexOf('Pack all platforms');
    assert.ok(packAt > 0, 'the packaging step must exist');
    const pack = workflow.slice(packAt, workflow.indexOf('- uses: softprops/action-gh-release', packAt));
    for (const desktop of ['*.exe', '*.dmg', '*.deb', '*.rpm']) {
        assert.ok(pack.includes(desktop), `${desktop} must still be collected`);
    }
    for (const mobile of ['*.apk', '*.aab', '*.ipa']) {
        assert.ok(!pack.includes(mobile), `${mobile} must no longer be collected`);
    }

    const bodyAt = workflow.indexOf('## Zephyr One ${{ env.ZEPHYR_ONE_RELEASE_TAG }}');
    assert.ok(bodyAt > 0, 'release body must exist');
    const body = workflow.slice(bodyAt, workflow.indexOf('files: dist-one/*'));
    for (const platform of ['Windows', 'macOS', 'Linux']) {
        assert.ok(body.includes(platform), `${platform} must be listed`);
    }
    assert.doesNotMatch(body, /\|\s*(Android|iOS)\s*(APK)?\s*\|/, 'no mobile artifact row');
});

test('electron-builder metadata and publish flags are complete enough to ship', () => {
    const pkg = JSON.parse(read('zephyr_one/package.json'));
    assert.match(String(pkg.author), /@/);
    assert.match(String(pkg.homepage), /^https:\/\//);
    assert.equal(pkg.build.linux.maintainer.includes('@'), true);
    assert.equal(pkg.build.executableName, 'zephyr-one');
    const coreModules = pkg.build.extraResources.find((item) => item.to === 'zephyr-core/node_modules');
    assert.equal(coreModules.from, 'zephyr-core/node_modules');
    assert.match(workflow, /electron-builder --win nsis portable zip --x64 --publish never/);
    assert.match(workflow, /electron-builder --mac dmg zip --arm64 --publish never/);
    assert.match(workflow, /electron-builder --linux deb rpm --x64 --publish never/);
    assert.match(workflow, /name: macos-arm64/);
    assert.doesNotMatch(workflow, /--mac dmg zip --universal/);
});

test('desktop dispatch has a Mobile-style prerelease_label and stamps SHA not a pre-existing tag', () => {
    assert.match(workflow, /prerelease_label:/);
    assert.match(workflow, /ZEPHYR_ONE_RELEASE_TAG: \$\{\{ github\.event\.inputs\.tag \}\}\$\{\{ github\.event\.inputs\.prerelease_label \}\}/);
    const windows = workflow.slice(workflow.indexOf('\n  build-windows:'), workflow.indexOf('\n  build-macos:'));
    assert.match(windows, /ref: \$\{\{ github\.sha \}\}/);
    assert.doesNotMatch(windows, /git rev-list -n 1/);
    const release = workflow.slice(workflow.indexOf('\n  release:'));
    assert.match(release, /tag_name: \$\{\{ env\.ZEPHYR_ONE_RELEASE_TAG \}\}/);
    assert.match(release, /target_commitish: \$\{\{ github\.sha \}\}/);
    assert.match(release, /prerelease: \$\{\{ github\.event\.inputs\.prerelease_label != '' \}\}/);
    assert.match(release, /gh release delete "\$TARGET_TAG" --cleanup-tag --yes/);
});

test('the built-in SQLite flag is set unconditionally for every desktop platform', () => {
    const occurrences = runtimeJs.split('ZEPHYR_ONE_USE_BUILTIN_SQLITE').length - 1;
    assert.equal(occurrences, 1, 'the flag must be set exactly once, not per-OS');
    assert.match(runtimeJs, /ZEPHYR_ONE_USE_BUILTIN_SQLITE: '1'/);
    assert.match(
        read('sqlite-driver.js'),
        /ZEPHYR_ONE_USE_BUILTIN_SQLITE === '1'/,
        'the driver must honour the flag',
    );
});

test('no Android or iOS surface remains anywhere in the Zephyr One tree', () => {
    const oneRoot = path.join(root, 'zephyr_one');
    const skip = new Set(['node_modules', 'dist', 'target', 'gen', '.git', 'mobile', 'release']);
    const offenders = [];

    const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (skip.has(entry.name)) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(full); continue; }
            if (!/\.(rs|toml|json|mjs|js|sh|py)$/.test(entry.name)) continue;
            const code = stripComments(full, readFileSync(full, 'utf8'));
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

    const pkg = JSON.parse(read('zephyr_one/package.json'));
    const mobileScripts = Object.keys(pkg.scripts || {}).filter((k) => /android|ios/i.test(k));
    assert.deepEqual(mobileScripts, [], 'no mobile npm scripts may remain');
    assert.equal(pkg.main, 'electron/main.mjs');
    assert.ok(pkg.scripts['electron:build']);
});
