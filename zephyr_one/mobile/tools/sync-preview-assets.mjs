import { cp, mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const mobile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(mobile, '../..');
const source = path.join(root, 'public/vendor/wasm-vips');
const target = path.join(mobile, 'android/feature-notes/src/main/assets/mobile-preview/vendor/wasm-vips');
const files = ['vips-es6.js', 'vips.wasm', 'vips-jxl.wasm', 'vips-heif.wasm', 'vips-resvg.wasm', 'LICENSE', 'THIRD-PARTY-NOTICES.md'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
if (!process.argv.includes('--check')) { await mkdir(target, {recursive:true}); for (const file of files) await cp(path.join(source,file),path.join(target,file)); }
for (const file of files) {
    const [a,b] = await Promise.all([readFile(path.join(source,file)),readFile(path.join(target,file))]);
    if (hash(a) !== hash(b)) throw new Error(`Mobile image asset drift: ${file}; run node tools/sync-preview-assets.mjs`);
}
console.log(`Mobile preview assets match desktop source (${files.length} files, licences included).`);
