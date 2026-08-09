#!/usr/bin/env node
// Regenerates every derived mobile artifact from mobile/contracts.
//   node mobile/tools/generate.mjs           write files
//   node mobile/tools/generate.mjs --check   fail on drift (CI gate)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { MOBILE_ROOT } from './lib/contracts.mjs';
import { kotlinSources, KOTLIN_PACKAGE } from './lib/codegen-kotlin.mjs';
import { swiftSources } from './lib/codegen-swift.mjs';
import { fixtureFiles } from './lib/fixtures.mjs';

const KOTLIN_DIR = path.join('android', 'core-contracts', 'src', 'main', 'kotlin', ...KOTLIN_PACKAGE.split('.'));
const SWIFT_DIR = path.join('ios', 'Sources', 'ZephyrContracts', 'Generated');
const FIXTURE_DIR = path.join('contracts', 'generated');

function collect() {
  const files = new Map();
  for (const [name, body] of Object.entries(kotlinSources())) files.set(path.join(KOTLIN_DIR, name), body);
  for (const [name, body] of Object.entries(swiftSources())) files.set(path.join(SWIFT_DIR, name), body);
  for (const [name, body] of Object.entries(fixtureFiles())) files.set(path.join(FIXTURE_DIR, name), body);
  return files;
}

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

function main() {
  const check = process.argv.includes('--check');
  const files = collect();
  const manifest = { generator: 'mobile/tools/generate.mjs', files: {} };
  const drift = [];

  for (const [rel, body] of [...files.entries()].sort()) {
    const abs = path.join(MOBILE_ROOT, rel);
    const posix = rel.split(path.sep).join('/');
    manifest.files[posix] = sha256(body);
    const current = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
    if (current === body) continue;
    if (check) {
      drift.push(current === null ? posix + ' (missing)' : posix + ' (stale)');
      continue;
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, 'utf8');
  }

  const manifestRel = path.join('contracts', 'GENERATED_MANIFEST.json');
  const manifestBody = JSON.stringify(manifest, null, 2) + '\n';
  const manifestAbs = path.join(MOBILE_ROOT, manifestRel);
  const manifestCurrent = fs.existsSync(manifestAbs) ? fs.readFileSync(manifestAbs, 'utf8') : null;
  if (manifestCurrent !== manifestBody) {
    if (check) drift.push('contracts/GENERATED_MANIFEST.json (stale)');
    else fs.writeFileSync(manifestAbs, manifestBody, 'utf8');
  }

  if (check) {
    if (drift.length > 0) {
      console.error('generated artifacts are out of date:');
      for (const item of drift) console.error('  - ' + item);
      console.error('run: node mobile/tools/generate.mjs');
      process.exitCode = 1;
      return;
    }
    console.log('generated artifacts match contracts (' + files.size + ' files)');
    return;
  }
  console.log('generated ' + files.size + ' files from mobile/contracts');
}

main();
