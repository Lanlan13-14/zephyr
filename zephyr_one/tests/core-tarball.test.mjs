/**
 * Validates the Android packaging strategy:
 * pack zephyr-core/ contents into a single .tar.gz (as prepare-android.sh does),
 * then extract and confirm nested trees (public/, etc.) survive.
 *
 * This is the contract the Rust runtime depends on after AAssetDir was abandoned
 * (AAssetDir_getNextFileName does not list subdirectories).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

describe('zephyr-core tarball pack/extract contract', () => {
  let tmp;
  let coreSrc;
  let tarball;
  let extractDir;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-one-tarball-'));
    coreSrc = path.join(tmp, 'zephyr-core');
    tarball = path.join(tmp, 'zephyr-core.tar.gz');
    extractDir = path.join(tmp, 'out');
    fs.mkdirSync(path.join(coreSrc, 'public', 'nested'), { recursive: true });
    fs.mkdirSync(path.join(coreSrc, 'node_modules', 'foo'), { recursive: true });
    fs.writeFileSync(path.join(coreSrc, 'server.js'), 'console.log("ok")\n');
    fs.writeFileSync(path.join(coreSrc, 'public', 'app.html'), '<html></html>\n');
    fs.writeFileSync(path.join(coreSrc, 'public', 'nested', 'x.txt'), 'nested\n');
    fs.writeFileSync(path.join(coreSrc, 'node_modules', 'foo', 'index.js'), 'module.exports=1\n');
    fs.writeFileSync(
      path.join(coreSrc, 'ZEPHYR_ONE_CORE.json'),
      JSON.stringify({ role: 'test' }),
    );
  });

  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('packs contents at archive root and restores nested dirs', () => {
    // Same layout as prepare-android.sh: (cd core && tar -czf dest .)
    const r = spawnSync(
      'tar',
      ['-czf', tarball, '.'],
      { cwd: coreSrc, encoding: 'utf8' },
    );
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const st = fs.statSync(tarball);
    assert.ok(st.size > 100, `tarball too small: ${st.size}`);

    // list must include nested paths (proves we are not flat-file-only)
    const list = spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8' });
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /server\.js/);
    assert.match(list.stdout, /public\/app\.html|public\/\.\/app\.html|\.\/public\/app\.html/);
    assert.match(list.stdout, /node_modules\/foo\/index\.js/);

    fs.mkdirSync(extractDir, { recursive: true });
    const x = spawnSync('tar', ['-xzf', tarball, '-C', extractDir], { encoding: 'utf8' });
    assert.equal(x.status, 0, x.stderr);

    assert.ok(fs.existsSync(path.join(extractDir, 'server.js')));
    assert.ok(fs.existsSync(path.join(extractDir, 'public', 'app.html')));
    assert.ok(fs.existsSync(path.join(extractDir, 'public', 'nested', 'x.txt')));
    assert.ok(fs.existsSync(path.join(extractDir, 'node_modules', 'foo', 'index.js')));
    assert.ok(fs.existsSync(path.join(extractDir, 'ZEPHYR_ONE_CORE.json')));
  });

  it('prepare-android.sh packing snippet produces a valid asset name', () => {
    // Smoke: script exists and documents tarball, not directory copy
    const sh = fs.readFileSync(path.join(ROOT, 'scripts', 'prepare-android.sh'), 'utf8');
    assert.match(sh, /zephyr-core\.tar\.gz/);
    assert.match(sh, /AAssetDir/);
    assert.doesNotMatch(
      sh,
      /cp -a "\$CORE_SRC" "\$ASSETS_DIR\/zephyr-core"/,
    );
  });
});
