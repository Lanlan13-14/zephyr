import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'desktop-runtime');
const outName = process.platform === 'win32' ? 'node.exe' : 'node';
const outFile = path.join(outDir, outName);

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(process.execPath, outFile);
if (process.platform !== 'win32') fs.chmodSync(outFile, 0o755);

const version = process.version;
fs.writeFileSync(
  path.join(outDir, 'runtime.json'),
  `${JSON.stringify({ runtime: 'node', version, platform: process.platform, arch: process.arch }, null, 2)}\n`,
);

/* Agent bastion dials need the same loopback Link child Android ships.
 * Without it a desktop One bound to a main has no process that can hold a
 * ZSL/2 session and splice one-relay, so `agent:<id>` jumps fail closed. */
const { spawnSync } = await import('node:child_process');
const linkName = process.platform === 'win32' ? 'zephyr-link-embed.exe' : 'zephyr-link-embed';
const linkOut = path.join(outDir, linkName);
const linkMod = path.resolve(root, '..', 'zephyr-link');
const goos = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux';
const goarch = process.arch === 'arm64' ? 'arm64' : 'amd64';
const built = spawnSync('go', ['build', '-C', linkMod, '-trimpath', '-ldflags=-s -w', '-o', linkOut, './cmd/zephyr-link-embed'], {
  env: { ...process.env, CGO_ENABLED: '0', GOOS: goos, GOARCH: goarch },
  stdio: 'inherit',
});
if (built.status !== 0) {
  throw new Error('zephyr-link-embed 构建失败，桌面 One 将无法经由 Agent 跳板');
}
if (process.platform !== 'win32') fs.chmodSync(linkOut, 0o755);

console.log(`Staged desktop Node ${version}: ${outFile}`);
console.log(`Staged zephyr-link-embed: ${linkOut}`);
