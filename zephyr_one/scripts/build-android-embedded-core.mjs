import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const core = path.resolve(process.argv[2] || path.join(root, 'zephyr-core'));
const assets = path.resolve(
  process.argv[3] || path.join(root, 'src-tauri', 'gen', 'android', 'app', 'src', 'main', 'assets'),
);
const publicSource = path.join(core, 'public');
const publicTarget = path.join(assets, 'zephyr-public');
const bundleTarget = path.join(assets, 'zephyr-core.cjs');

if (!fs.existsSync(path.join(core, 'server.js')) || !fs.existsSync(publicSource)) {
  throw new Error(`Android core is not staged at ${core}`);
}

fs.mkdirSync(assets, { recursive: true });
fs.rmSync(path.join(assets, 'zephyr-core.tar'), { force: true });
fs.rmSync(path.join(assets, 'zephyr-core.tar.gz'), { force: true });
fs.rmSync(publicTarget, { recursive: true, force: true });
fs.cpSync(publicSource, publicTarget, { recursive: true, force: true });

await build({
  absWorkingDir: core,
  entryPoints: [path.join(core, 'server.js')],
  outfile: bundleTarget,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  packages: 'bundle',
  // These are optional paths that are never used by the Android runtime:
  // SQLite is built into Node, sharp has a platform fallback, cpu-features is
  // guarded by ssh2, and unzipper's S3 adapter is unrelated to APK reads.
  external: [
    'better-sqlite3',
    'sharp',
    'cpu-features',
    '@aws-sdk/client-s3',
    'vscode-json-languageservice',
    'vscode-languageserver/node',
    'vscode-jsonrpc/node',
  ],
  logLevel: 'info',
  legalComments: 'none',
  sourcemap: false,
});

const stat = fs.statSync(bundleTarget);
if (stat.size < 1000) throw new Error(`Android core bundle is unexpectedly small: ${stat.size}`);
for (const required of ['index.html', 'app.html', 'app.js']) {
  if (!fs.existsSync(path.join(publicTarget, required))) {
    throw new Error(`Android public assets are missing ${required}`);
  }
}

console.log(`Bundled Android core without first-run extraction: ${bundleTarget} (${stat.size} bytes)`);
console.log(`Copied public assets for direct APK reads: ${publicTarget}`);
