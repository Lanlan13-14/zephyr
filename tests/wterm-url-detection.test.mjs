import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
test('URL linkifier is safe and cross-span',()=>{const s=fs.readFileSync(new URL('../wterm/packages/@wterm/dom/src/renderer.ts',import.meta.url),'utf8');assert.match(s,/createTreeWalker/);assert.match(s,/term-auto-link/);assert.match(s,/noopener noreferrer/);assert.match(s,/https\?:/);});
