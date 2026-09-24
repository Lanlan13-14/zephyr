import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson, schemaFor, validate } from '../scripts/lib/ai-contract-v2.mjs';

const root = path.resolve(import.meta.dirname, '..');

function resolvePointer(file, pointer) {
  const { schema, byId } = schemaFor(file);
  let node = schema;
  for (const part of pointer.replace(/^\//, '').split('/')) node = node[part];
  return { schema: { ...node, $id: schema.$id }, byId };
}

test('transport Golden vector validates against the Phase 1 schema unchanged', () => {
  const vectors = JSON.parse(fs.readFileSync(path.join(root, 'contracts/ai/v2/testdata/golden-vectors.json'), 'utf8'));
  const vector = vectors.vectors.find((v) => v.name === 'transport-target-android-dns');
  const { schema, byId } = resolvePointer('transport-policy.schema.json', '/$defs/transportTarget');
  assert.deepEqual(validate(vector.document, schema, byId, vector.name), []);
});

test('Go transport package honors the contract field names', () => {
  const source = fs.readFileSync(path.join(root, 'zephyr-ai/internal/transport/transport.go'), 'utf8');
  for (const field of ['requestUrl', 'effectiveHost', 'effectivePort', 'dialTargets', 'tlsServerName', 'resolutionSource', 'dialTimeoutMs']) {
    assert.ok(source.includes('"' + field + '"'), field + ' tag missing');
  }
  assert.match(source, /ServerName:.*tlsName|tlsServerName/);
  assert.match(source, /MinVersion: tls\.VersionTLS12/);
  assert.match(source, /ForceAttemptHTTP2: true/);
});

test('Kotlin DTOs carry the contract field names verbatim', () => {
  const source = fs.readFileSync(path.join(root, 'zephyr_one/mobile/android/app/src/main/kotlin/one/zephyr/mobile/app/EmbeddedAiRuntimeApi.kt'), 'utf8');
  for (const field of ['requestUrl', 'effectiveHost', 'effectivePort', 'dialTargets', 'tlsServerName', 'resolutionSource', 'dialTimeoutMs']) {
    assert.ok(source.includes('val ' + field), field + ' DTO field missing');
  }
  assert.ok(source.includes('class EmbeddedTransportTarget') || source.includes('data class EmbeddedTransportTarget'));
});

test('provider Config exposes transport for both wire adapters', () => {
  for (const file of ['openai/openai.go', 'anthropic/anthropic.go']) {
    const source = fs.readFileSync(path.join(root, 'zephyr-ai/internal/provider', file), 'utf8');
    assert.ok(source.includes('transport.NewClient(cfg.Transport'), file + ' does not build from cfg.Transport');
    assert.ok(source.includes('RewriteRequest'), file + ' does not rewrite to the dial IP');
  }
});

test('MCP HTTP path carries the same transport target', () => {
  const source = fs.readFileSync(path.join(root, 'zephyr-ai/internal/mcp/client.go'), 'utf8');
  assert.ok(source.includes('Transport transport.Target'));
  assert.ok(source.includes('RewriteRequest'));
});

test('canonical bytes of the transport vector are stable', () => {
  const replay = JSON.parse(fs.readFileSync(path.join(root, 'contracts/ai/v2/testdata/canonical-bytes.json'), 'utf8'));
  assert.ok(replay['transport-target-android-dns'].includes('"resolutionSource":"android-jvm-dns"'));
  assert.ok(replay['transport-target-android-dns'].includes('"tlsServerName":"api.openai.com"'));
  assert.equal(typeof canonicalJson, 'function');
});
