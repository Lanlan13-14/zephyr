import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalJson, errorTaxonomy, loadSchemas, schemaFor, validate } from '../scripts/lib/ai-contract-v2.mjs';
import { generatedFiles } from '../scripts/generate-ai-contracts.mjs';

const root = path.resolve(import.meta.dirname, '..');
const vectors = JSON.parse(fs.readFileSync(path.join(root, 'contracts/ai/v2/testdata/golden-vectors.json'), 'utf8'));

function resolveSchema(selector) {
  const [file, pointer] = selector.split('#');
  const { schema, byId } = schemaFor(file);
  if (!pointer) return { schema, byId };
  let node = schema;
  for (const part of pointer.replace(/^\//, '').split('/')) node = node[part];
  return { schema: { ...node, $id: schema.$id }, byId };
}

test('every contract schema is draft 2020-12 and closed', () => {
  const { files, byFile } = loadSchemas();
  assert.ok(files.length >= 9);
  for (const [file, schema] of byFile) {
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema', file);
    assert.equal(schema.$id.startsWith('https://zephyr.local/contracts/ai/v2/'), true, file);
  }
});

test('golden vectors validate and have stable canonical bytes', () => {
  const seen = new Map();
  for (const vector of vectors.vectors) {
    const { schema, byId } = resolveSchema(vector.schema);
    const problems = validate(vector.document, schema, byId, vector.name);
    assert.deepEqual(problems, [], vector.name);
    const encoded = canonicalJson(vector.document);
    assert.equal(seen.has(encoded), false, vector.name + ' duplicates another canonical document');
    seen.set(vector.name, encoded);
    assert.equal(/[{}[\]:,] /.test(encoded) || / [{\[\]}]/.test(encoded), false, 'canonical JSON must not contain insignificant whitespace');
  }
  const replay = JSON.parse(fs.readFileSync(path.join(root, 'contracts/ai/v2/testdata/canonical-bytes.json'), 'utf8'));
  for (const [name, bytes] of Object.entries(replay)) assert.equal(seen.get(name), bytes, name);
});

test('rejected vectors fail closed', () => {
  for (const vector of vectors.rejected) {
    const { schema, byId } = resolveSchema(vector.schema);
    const problems = validate(vector.document, schema, byId, vector.reason);
    assert.ok(problems.length > 0, vector.reason + ' was accepted');
  }
});

test('error taxonomy codes are unique and classified', () => {
  const taxonomy = errorTaxonomy();
  assert.equal(taxonomy.version, 2);
  assert.ok(taxonomy.errors.some((item) => item.code === 'ai_dns_failed' && item.retryable));
  assert.ok(taxonomy.errors.some((item) => item.code === 'ai_tls_hostname_mismatch' && !item.retryable));
  assert.ok(taxonomy.errors.some((item) => item.code === 'ai_sync_quarantined' && !item.retryable));
});

test('generated Node, Go, Kotlin and Swift artifacts match the generator', () => {
  const files = generatedFiles();
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    assert.equal(fs.existsSync(abs), true, rel + ' missing');
    assert.equal(fs.readFileSync(abs, 'utf8'), body, rel + ' is stale');
  }
});

test('all four languages expose the same error codes in the same order', () => {
  const codes = errorTaxonomy().errors.map((item) => item.code);
  const files = generatedFiles();
  for (const body of Object.values(files)) {
    let cursor = -1;
    for (const code of codes) {
      const next = body.indexOf(JSON.stringify(code));
      assert.ok(next > cursor, code + ' missing or reordered');
      cursor = next;
    }
  }
});

test('generated Node enums reject a sentinel temperature masquerading as a mode', async () => {
  const href = pathToFileURL(path.join(root, 'src/generated/ai-contract-v2.js')).href;
  const contract = await import(href);
  assert.equal(contract.AI_CONTRACT_SCHEMA_VERSION, 2);
  assert.equal(contract.isRetryableAIError('ai_dns_failed'), true);
  assert.equal(contract.isRetryableAIError('ai_auth_failed'), false);
  assert.throws(() => contract.aiErrorSpec('not-a-code'));
  assert.throws(() => contract.assertProviderAccountEnums({ family: 'openai', api: 'openai-responses', auth: { kind: 'sentinel' } }));
});

test('Go contract package builds and answers the same taxonomy', () => {
  const source = fs.readFileSync(path.join(root, 'zephyr-ai/contracts/v2/contract.go'), 'utf8');
  assert.match(source, /package contractv2/);
  assert.match(source, /func AIErrorByCode/);
  assert.match(source, /ProviderAPIOpenAIResponses ProviderAPI = "openai-responses"/);
  assert.match(source, /TLSMinVersionV12 TLSMinVersion = "1.2"/);
});
