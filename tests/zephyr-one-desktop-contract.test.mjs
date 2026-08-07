import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

const runtimeRs = read('zephyr_one/src-tauri/src/runtime/mod.rs');
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

test('adopted local session cannot be reached without the embedded flag', () => {
    const guardAt = serverJs.indexOf('if (!ZEPHYR_ONE_EMBEDDED) return next();');
    const adoptAt = serverJs.indexOf('function adoptEmbeddedLocalSession');
    assert.ok(adoptAt > 0, 'adoption middleware must exist');
    assert.ok(guardAt > adoptAt, 'adoption must bail out first when not embedded');

    // mustChangePassword=false is the point: the rotation wall is what crashed
    // and it has no meaning when the OS unlock is the gate.
    const body = serverJs.slice(adoptAt, adoptAt + 1800);
    assert.match(body, /mustChangePassword:\s*false/);
    assert.match(body, /storage\.getFirstUser\(\)/);
});

test('release builds skip Android and iOS unless explicitly requested', () => {
    assert.match(workflow, /include_mobile:/);
    assert.match(workflow, /description: 'Also build Android \+ iOS \(off by default; desktop-only release\)'/);

    /* Default must be off, so a mobile break cannot stall a desktop publish.
     * The block is delimited by the next top-level key rather than a byte
     * offset — a fixed slice silently truncates when the comment above the
     * input grows, which turns this assertion into a false failure. */
    const inputAt = workflow.indexOf('include_mobile:');
    const afterInput = workflow.slice(inputAt);
    const blockEnd = afterInput.search(/\n[a-z]/);
    const inputBlock = blockEnd === -1 ? afterInput : afterInput.slice(0, blockEnd);
    assert.match(inputBlock, /type: boolean/);
    assert.match(inputBlock, /default: false/);

    // Both mobile jobs gated; all three desktop jobs untouched.
    const jobCondition = (name) => {
        const at = workflow.indexOf(`\n  ${name}:`);
        assert.ok(at > 0, `job ${name} must exist`);
        const block = workflow.slice(at, at + 700);
        const line = block.split('\n').find((l) => l.trimStart().startsWith('if:'));
        assert.ok(line, `job ${name} must have an if: condition`);
        return line;
    };

    for (const mobile of ['build-android', 'build-ios']) {
        assert.match(
            jobCondition(mobile),
            /inputs\.include_mobile == 'true'/,
            `${mobile} must be gated behind include_mobile`,
        );
    }
    for (const desktop of ['build-windows', 'build-macos', 'build-linux']) {
        assert.doesNotMatch(
            jobCondition(desktop),
            /include_mobile/,
            `${desktop} must not depend on the mobile gate`,
        );
    }
});

test('release job still publishes when the mobile jobs are skipped', () => {
    const at = workflow.indexOf('\n  release:');
    assert.ok(at > 0);
    const block = workflow.slice(at, at + 900);
    // always() is what lets skipped needs through; without it a skipped
    // build-android would block the whole release.
    assert.match(block, /always\(\)/);
    assert.match(block, /needs\.test\.result == 'success'/);
    assert.match(block, /needs: \[test, build-android, build-windows, build-macos, build-linux, build-ios\]/);
});

test('release notes do not advertise platforms the default build omits', () => {
    const at = workflow.indexOf('## Zephyr One ${{ github.event.inputs.tag }}');
    assert.ok(at > 0, 'release body must exist');
    const body = workflow.slice(at, workflow.indexOf('files: dist-one/*'));

    // Desktop is what a default run produces.
    for (const platform of ['Windows', 'macOS', 'Linux']) {
        assert.ok(body.includes(platform), `${platform} must be listed`);
    }
    // Mobile must be marked opt-in rather than presented as shipped.
    assert.match(body, /include_mobile/, 'mobile rows must reference the opt-in input');
});

test('the built-in SQLite flag is set once, for every platform, not per-OS', () => {
    // This flag is why desktop hit the node:sqlite binding divergence at all:
    // it lives in the shared block, so Windows/macOS/Linux use the built-in
    // driver too. Asserted so the parity tests are known to cover desktop.
    const shared = runtimeRs.indexOf('.env("ZEPHYR_ONE_USE_BUILTIN_SQLITE", "1")');
    assert.ok(shared > 0, 'the shared env block must set the built-in SQLite flag');

    const androidBlockAt = runtimeRs.indexOf('cmd.env("ZEPHYR_ANDROID_APK_PATH"');
    assert.ok(
        shared < androidBlockAt,
        'the flag must be set in the shared block, before the Android-only block',
    );

    assert.match(
        read('sqlite-driver.js'),
        /ZEPHYR_ONE_USE_BUILTIN_SQLITE === '1'/,
        'the driver must honour the flag',
    );
});
