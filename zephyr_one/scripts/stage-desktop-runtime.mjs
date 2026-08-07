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

console.log(`Staged desktop Node ${version}: ${outFile}`);
