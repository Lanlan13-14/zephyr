import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

test('app module parses without duplicate lexical declarations', () => {
  const result = spawnSync(process.execPath, ['--check', '--input-type=module'], {
    input: source,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('AI provider save has one persistence implementation', () => {
  const start = source.indexOf('async function saveAiProvider');
  const end = source.indexOf('\nfunction renderAiProviderList', start);
  const body = source.slice(start, end);
  assert.equal((body.match(/const providerTypeValue/g) || []).length, 1);
  assert.equal((body.match(/const shouldAutoFetchModels/g) || []).length, 1);
  assert.doesNotMatch(body, /\breturn;\s*const\s+ai\b/);
});
