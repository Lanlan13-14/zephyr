// Generated Kotlin/Swift sources are checked in. If contracts change without regenerating, fail here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { MOBILE_ROOT, entityRegistry, errorRegistry } from '../tools/lib/contracts.mjs';
import { kotlinSources, KOTLIN_PACKAGE } from '../tools/lib/codegen-kotlin.mjs';
import { swiftSources } from '../tools/lib/codegen-swift.mjs';
import { fixtureFiles } from '../tools/lib/fixtures.mjs';

const KOTLIN_DIR = path.join(MOBILE_ROOT, 'android', 'core-contracts', 'src', 'main', 'kotlin', ...KOTLIN_PACKAGE.split('.'));
const SWIFT_DIR = path.join(MOBILE_ROOT, 'ios', 'Sources', 'ZephyrContracts', 'Generated');
const FIXTURE_DIR = path.join(MOBILE_ROOT, 'contracts', 'generated');
const MANIFEST = path.join(MOBILE_ROOT, 'contracts', 'GENERATED_MANIFEST.json');

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

test('checked-in Kotlin sources match the generator output', () => {
  for (const [name, body] of Object.entries(kotlinSources())) {
    const file = path.join(KOTLIN_DIR, name);
    assert.ok(fs.existsSync(file), name + ' has not been generated');
    assert.equal(fs.readFileSync(file, 'utf8'), body, name + ' is stale; run node mobile/tools/generate.mjs');
  }
});

test('checked-in Swift sources match the generator output', () => {
  for (const [name, body] of Object.entries(swiftSources())) {
    const file = path.join(SWIFT_DIR, name);
    assert.ok(fs.existsSync(file), name + ' has not been generated');
    assert.equal(fs.readFileSync(file, 'utf8'), body, name + ' is stale; run node mobile/tools/generate.mjs');
  }
});

test('checked-in fixtures match the generator output', () => {
  for (const [name, body] of Object.entries(fixtureFiles())) {
    const file = path.join(FIXTURE_DIR, name);
    assert.ok(fs.existsSync(file), name + ' has not been generated');
    assert.equal(fs.readFileSync(file, 'utf8'), body, name + ' is stale; run node mobile/tools/generate.mjs');
  }
});

test('the manifest hashes every generated artifact', () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const expected = new Map();
  for (const [name, body] of Object.entries(kotlinSources())) {
    expected.set(['android', 'core-contracts', 'src', 'main', 'kotlin', ...KOTLIN_PACKAGE.split('.'), name].join('/'), sha256(body));
  }
  for (const [name, body] of Object.entries(swiftSources())) {
    expected.set(['ios', 'Sources', 'ZephyrContracts', 'Generated', name].join('/'), sha256(body));
  }
  for (const [name, body] of Object.entries(fixtureFiles())) {
    expected.set(['contracts', 'generated', name].join('/'), sha256(body));
  }
  assert.deepEqual(Object.keys(manifest.files).sort(), [...expected.keys()].sort());
  for (const [rel, hash] of expected) {
    assert.equal(manifest.files[rel], hash, rel + ' hash drifted');
  }
});

test('both platforms declare the same entity types in the same push order', () => {
  const kotlin = kotlinSources()['EntityRegistry.kt'];
  const swift = swiftSources()['EntityRegistry.swift'];
  for (const entity of entityRegistry().entities) {
    assert.ok(kotlin.includes('"' + entity.type + '"'), 'Kotlin is missing ' + entity.type);
    assert.ok(swift.includes('"' + entity.type + '"'), 'Swift is missing ' + entity.type);
  }
  const kotlinOrder = /val pushOrder: List<String> = listOf\(([^)]*)\)/.exec(kotlin)[1];
  const swiftOrder = /public static let pushOrder: \[String\] = \[([^\]]*)\]/.exec(swift)[1];
  const normalize = (text) => text.split(',').map((s) => s.trim().replace(/"/g, '')).filter(Boolean);
  assert.deepEqual(normalize(kotlinOrder), normalize(swiftOrder), 'push order diverged between platforms');
});

test('both platforms declare every error code', () => {
  const kotlin = kotlinSources()['ErrorRegistry.kt'];
  const swift = swiftSources()['ErrorRegistry.swift'];
  for (const spec of errorRegistry().errors) {
    assert.ok(kotlin.includes('"' + spec.code + '"'), 'Kotlin is missing ' + spec.code);
    assert.ok(swift.includes('"' + spec.code + '"'), 'Swift is missing ' + spec.code);
  }
});

test('generated Kotlin never emits an accidental string template', () => {
  for (const [name, body] of Object.entries(kotlinSources())) {
    const stripped = body.replace(/\\\$/g, '');
    assert.equal(stripped.includes('${'), false, name + ' contains an unescaped Kotlin template');
  }
});

test('generated Swift enum cases are lowerCamelCase', () => {
  const swift = swiftSources()['SyncContract.swift'];
  const cases = [...swift.matchAll(/case ([A-Za-z0-9]+)/g)].map((m) => m[1]);
  assert.ok(cases.length > 0);
  for (const name of cases) {
    assert.match(name, /^[a-z][A-Za-z0-9]*$/, name + ' is not a valid Swift case name');
  }
  assert.ok(swift.includes('case unbound = "UNBOUND"'));
  assert.ok(swift.includes('case boundNeedsBootstrap = "BOUND_NEEDS_BOOTSTRAP"'));
});
