import fs from 'node:fs';

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('usage: node build-go-wasm-esm.mjs <wasm_exec.js> <wasm_exec.mjs>');
let source = fs.readFileSync(input, 'utf8');
if (!source.includes('globalThis.Go = class')) throw new Error('unsupported wasm_exec.js: globalThis.Go class not found');
source = source.replace(/^\(\(\) => \{\s*/m, '').replace(/\s*\}\)\(\);\s*$/m, '\n');
source = source.replace('globalThis.Go = class', 'export class Go');
if (source.includes('globalThis.Go = class') || !source.includes('export class Go')) throw new Error('wasm_exec ESM conversion failed');
fs.writeFileSync(output, source);
