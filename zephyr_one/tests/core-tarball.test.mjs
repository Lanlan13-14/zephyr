import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

describe('Android no-extract embedded core contract', () => {
  it('streams one bundled server entry to Node instead of unpacking app data', () => {
    const runtime = fs.readFileSync(path.join(ROOT, 'src-tauri', 'src', 'runtime', 'mod.rs'), 'utf8');
    assert.match(runtime, /open_asset_reader\("zephyr-core\.cjs"\)/);
    assert.match(runtime, /cmd\.current_dir\(&data_dir\)\.arg\("-"\)/);
    assert.match(runtime, /std::io::copy\(&mut source, &mut stdin\)/);
    assert.match(runtime, /ZEPHYR_ANDROID_APK_PATH/);
    assert.doesNotMatch(runtime, /extract_assets_core_tarball|\.zephyr-one-app-version|zephyr-core\.extracting/);
  });

  it('builds direct APK assets and rejects the legacy tar', () => {
    const prepare = fs.readFileSync(path.join(ROOT, 'scripts', 'prepare-android.sh'), 'utf8');
    const build = fs.readFileSync(path.join(ROOT, 'scripts', 'build-android-embedded-core.mjs'), 'utf8');
    const verify = fs.readFileSync(path.join(ROOT, 'scripts', 'verify-android-apk.sh'), 'utf8');
    assert.match(prepare, /build-android-embedded-core\.mjs/);
    assert.match(build, /zephyr-core\.cjs/);
    assert.match(build, /zephyr-public/);
    assert.match(build, /fs\.cpSync\(publicSource, publicTarget/);
    assert.match(verify, /assets\/zephyr-core\.cjs/);
    assert.match(verify, /assets\/zephyr-public\/app\.html/);
    assert.doesNotMatch(prepare, /tar -cf|tar -xf/);
  });
});
