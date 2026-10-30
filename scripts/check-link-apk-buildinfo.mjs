import fs from 'node:fs';
import path from 'node:path';

// Inspect real files extracted from the APK, never source-only substitutes.
const directory = process.argv[2];
const expected = fs.readFileSync(process.argv[3], 'utf8').trim();
for (const name of ['libzephyr_link.so', 'libzephyr_ai_runtime.so', 'libzephyr_ai_runtime_jni.so']) {
  const text = fs.readFileSync(path.join(directory, `${name}.buildinfo.txt`), 'utf8');
  if (!text.includes('go1.26.10')) throw new Error(`${name}: unexpected toolchain`);
  if (!text.includes(`vcs.revision=${expected}`)) throw new Error(`${name}: wrong source revision`);
  if (!text.includes('vcs.modified=false')) throw new Error(`${name}: dirty source tree`);
  if (name === 'libzephyr_link.so' && !/github\.com\/klauspost\/compress\s+v1\.18\.7\b/.test(text)) {
    throw new Error(`${name}: expected audited compression dependency v1.18.7`);
  }
  if (!text.includes('GOOS=android') || !text.includes('GOARCH=arm64')) throw new Error(`${name}: wrong target`);
}
