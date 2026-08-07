import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');

function read(relative) {
  return fs.readFileSync(path.join(REPO, relative), 'utf8');
}

describe('Android embedded core compatibility', () => {
  it('uses Node built-in SQLite on Android rather than a Linux native addon', () => {
    const driver = read('sqlite-driver.js');
    const storage = read('storage.js');
    assert.match(driver, /process\.platform === 'android'/);
    assert.match(driver, /require\('node:sqlite'\)/);
    assert.match(driver, /DatabaseSync/);
    assert.match(storage, /require\('\.\/sqlite-driver'\)/);
    assert.match(storage, /createDatabase\(DB_FILE\)/);
  });

  it('does not load sharp during Android server startup', () => {
    const preview = read('preview/image/preview-service.js');
    assert.match(preview, /function loadSharp\(\)/);
    assert.match(preview, /process\.platform === 'android'/);
    assert.doesNotMatch(preview, /^const sharp = require\('sharp'\);/m);
  });

  it('removes host-native addons and verifies Android core staging', () => {
    const stage = read('zephyr_one/scripts/stage-zephyr-core.sh');
    const cargo = read('zephyr_one/src-tauri/Cargo.toml');
    const verify = read('zephyr_one/scripts/verify-android-core.sh');
    const verifyNode = read('zephyr_one/scripts/verify-android-node-binary.sh');
    const bundleNode = read('zephyr_one/scripts/bundle-node-android.sh');
    const verifyApk = read('zephyr_one/scripts/verify-android-apk.sh');
    assert.match(stage, /npm ci --omit=dev --ignore-scripts/);
    assert.match(stage, /ERROR: npm ci failed in Android zephyr-core/);
    assert.match(stage, /ERROR: npm ci failed in desktop zephyr-core/);
    assert.match(stage, /ZEPHYR_ONE_ANDROID/);
    assert.match(cargo, /rust-version = "1\.88"/);
    assert.match(cargo, /codegen-units = 8/);
    assert.match(cargo, /lto = "thin"/);
    assert.match(stage, /node_modules\/better-sqlite3/);
    assert.match(stage, /node_modules\/sharp/);
    assert.match(stage, /node_modules\/@img/);
    assert.match(stage, /-name '\*\.node' -delete/);
    const smoke = read('tests/android-core-startup-smoke.test.mjs');
    const child = read('tests/android-core-startup-child.cjs');
    assert.match(verify, /node:sqlite/);
    assert.match(verify, /-name '\*\.node'/);
    assert.match(verifyNode, /DatabaseSync/);
    assert.match(verifyNode, /ARM aarch64/);
    assert.match(verifyNode, /x86-64\|x86_64/);
    assert.match(bundleNode, /NODE_ANDROID_ABIS="\$\{NODE_ANDROID_ABIS:-arm64-v8a\}"/);
    assert.match(bundleNode, /rm -rf "\$LIBS_ROOT\/\$abi"/);
    assert.match(bundleNode, /verify-android-node-binary/);
    assert.match(verifyApk, /unzip -l/);
    assert.match(verifyApk, /assets\/zephyr-core\.cjs/);
    assert.match(verifyApk, /assets\/zephyr-public\/app\.html/);
    assert.match(verifyApk, /ABI="\$\{2:-arm64-v8a\}"/);
    assert.match(verifyApk, /lib\/\$ABI\/libnode\.so/);
    assert.match(verifyApk, /unsupported host-native \.node addon|unsupported host-native \.node/);
    const runtime = read('zephyr_one/src-tauri/src/runtime/mod.rs');
    assert.match(runtime, /open_asset_reader\(app, "zephyr-core\.cjs"\)/);
    assert.match(runtime, /\.jni_handle\(\)/);
    assert.match(runtime, /get_webview_window\("main"\)/);
    assert.match(runtime, /nativeLibraryDir/);
    assert.doesNotMatch(runtime, /\.webviews\(\)/);
    assert.doesNotMatch(runtime, /ndk_context::android_context/);
    assert.doesNotMatch(runtime, /extract_assets_core_tarball/);
    assert.match(smoke, /ZEPHYR_ONE_SMOKE_NODE/);
    assert.match(smoke, /android-core-startup-child/);
    assert.match(smoke, /node_modules', 'better-sqlite3/);
    assert.match(child, /process, 'platform'/);
    assert.match(child, /node:sqlite/);
  });
});
