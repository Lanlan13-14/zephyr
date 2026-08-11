import fs from 'node:fs';
import path from 'node:path';

const [sourceArg, destinationArg] = process.argv.slice(2);
if (!sourceArg || !destinationArg) {
  console.error('usage: stage-windows-freerdp.mjs <vcpkg-bin-dir> <destination-dir>');
  process.exit(2);
}

const source = path.resolve(sourceArg);
const destination = path.resolve(destinationArg);
if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
  throw new Error(`FreeRDP DLL source directory does not exist: ${source}`);
}

const dlls = fs.readdirSync(source, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.dll'))
  .map((entry) => entry.name);
const required = [
  ['FreeRDP core', /^freerdp3\.dll$/i],
  ['FreeRDP client', /^freerdp-client3\.dll$/i],
  ['WinPR', /^winpr3\.dll$/i],
];
const invalidNativeDlls = dlls.filter((name) => {
  if (!/^(?:lib)?(?:freerdp|winpr)/i.test(name)) return false;
  const match = name.match(/^(?:lib)?(?:freerdp(?:-[a-z-]+)?|winpr(?:-[a-z-]+)?)(\d+)/i);
  return !match || match[1] !== '3';
});
if (invalidNativeDlls.length) {
  throw new Error(
    `FreeRDP DLL source contains non-v3 native libraries at ${source}: ${invalidNativeDlls.join(', ')}`,
  );
}
const missing = required.filter(([, pattern]) => !dlls.some((name) => pattern.test(name)));
if (missing.length) {
  throw new Error(
    `FreeRDP DLL source is incomplete at ${source}; missing ${missing.map(([name]) => name).join(', ')}. ` +
    `Found: ${dlls.join(', ') || '(no DLLs)'}`,
  );
}

fs.rmSync(destination, { recursive: true, force: true });
fs.mkdirSync(destination, { recursive: true });
for (const name of dlls) fs.copyFileSync(path.join(source, name), path.join(destination, name));
fs.writeFileSync(
  path.join(destination, 'FREERDP_RUNTIME.json'),
  `${JSON.stringify({ source: 'vcpkg', files: dlls.sort() }, null, 2)}\n`,
);
console.log(`Staged ${dlls.length} Windows runtime DLLs into ${destination}`);
