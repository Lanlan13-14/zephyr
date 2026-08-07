import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mobile = path.join(root, 'FREEZE', 'zephyr one for mobile');
const read = (relative) => fs.readFileSync(path.join(mobile, relative), 'utf8');
const json = (relative) => JSON.parse(read(relative));

const requiredDocs = [
  'README.md', 'PRODUCT_REQUIREMENTS.md', 'DEVELOPMENT.md',
  'ZEPHYR_PARITY.md', 'SCREEN_CATALOG.md', 'SYNC_STATE_MACHINE.md',
  'DATA_AND_MIGRATION.md', 'NATIVE_ENGINE_DECISIONS.md',
  'TRACEABILITY.md', 'IMPLEMENTATION_STATUS.md',
];
const requiredContracts = [
  'contracts/openapi-mobile-v1.json',
  'contracts/entity-registry.json',
  'contracts/error-registry.json',
  'contracts/schemas/error.schema.json',
  'contracts/schemas/sync-operation.schema.json',
  'contracts/schemas/sync-change.schema.json',
  'contracts/schemas/secret-envelope.schema.json',
  'contracts/test-vectors/sync-v1.json',
];

test('native mobile spec has all narrative and machine artifacts', () => {
  for (const relative of [...requiredDocs, ...requiredContracts]) {
    const file = path.join(mobile, relative);
    assert.ok(fs.existsSync(file), `missing ${relative}`);
    assert.ok(fs.statSync(file).size > 100, `empty ${relative}`);
  }
});

test('README is a project dashboard and links every executable spec', () => {
  const text = read('README.md');
  for (const relative of [...requiredDocs.slice(1), ...requiredContracts]) {
    assert.match(text, new RegExp(relative.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `README missing ${relative}`);
  }
  assert.match(text, /没有新的 Kotlin\/Swift 原生项目/);
  assert.match(text, /pull-only/);
  assert.match(text, /工具 → 服务器/);
});

test('OpenAPI covers auth, binding, bidirectional sync and sensitive grants', () => {
  const api = json('contracts/openapi-mobile-v1.json');
  assert.equal(api.openapi, '3.1.0');
  const expected = [
    '/api/auth/login', '/api/auth/totp/verify',
    '/api/mobile/v1/capabilities', '/api/mobile/v1/devices/bind',
    '/api/mobile/v1/devices/refresh', '/api/mobile/v1/sync/bootstrap',
    '/api/mobile/v1/sync/changes', '/api/mobile/v1/sync/push',
    '/api/mobile/v1/sync/ack', '/api/mobile/v1/sync/status',
    '/api/mobile/v1/sensitive/verify', '/api/mobile/v1/file-bridge/lease',
  ];
  for (const route of expected) assert.ok(api.paths[route], `OpenAPI missing ${route}`);
  assert.equal(api.paths['/api/auth/login'].post['x-zephyr-implementation'], 'implemented-3a61d2f');
  assert.equal(api.paths['/api/mobile/v1/sync/push'].post['x-zephyr-implementation'], 'required-server-extension');
});

test('entity registry covers every product-required mirror family', () => {
  const registry = json('contracts/entity-registry.json');
  const byType = new Map(registry.entities.map((entity) => [entity.type, entity]));
  const expected = [
    'connection', 'proxy', 'sshKey', 'jumpHost', 'note', 'snippet',
    'aiProvider', 'aiMemory', 'aiSkill', 'aiEnv', 'aiConversation', 'aiMessage',
    'oneUserSettings', 'serverSettings', 'backupMetadata', 'activityEvent',
    'resourceAcl', 'clientToken', 'workspaceState', 'fileSyncConfig',
  ];
  for (const type of expected) assert.ok(byType.has(type), `registry missing ${type}`);
  assert.deepEqual(byType.get('connection').secretFields, ['password', 'privateKey']);
  assert.ok(byType.get('clientToken').status.includes('blocked'));
  assert.ok(byType.get('aiConversation').status.includes('blocked'));
  assert.ok(registry.excludedEditableScopes.includes('accountSecurity'));
  assert.ok(registry.excludedEditableScopes.includes('smtp'));
});

test('every entity field has exactly one storage/sync classification', () => {
  const registry = json('contracts/entity-registry.json');
  const buckets = ['editableFields', 'secretFields', 'serverAuthorityFields', 'opaquePreserveFields', 'deviceLocalFields'];
  for (const entity of registry.entities) {
    const owner = new Map();
    for (const bucket of buckets) {
      assert.ok(Array.isArray(entity[bucket]), `${entity.type}.${bucket} must be array`);
      for (const field of entity[bucket]) {
        assert.ok(!owner.has(field), `${entity.type}.${field} in ${owner.get(field)} and ${bucket}`);
        owner.set(field, bucket);
      }
    }
  }
});

test('error registry is unique and carries deterministic client action', () => {
  const registry = json('contracts/error-registry.json');
  const seen = new Set();
  for (const error of registry.errors) {
    assert.ok(!seen.has(error.code), `duplicate error ${error.code}`);
    seen.add(error.code);
    assert.ok(Number.isInteger(error.httpStatus));
    assert.equal(typeof error.retryable, 'boolean');
    assert.ok(error.clientAction);
  }
  for (const code of ['app_session_expired', 'token_required', 'sync_conflict', 'cursor_expired', 'sensitive_grant_consumed', 'rate_limited']) {
    assert.ok(seen.has(code), `missing error ${code}`);
  }
});

test('secret schema and AAD vector freeze byte-level interoperability', () => {
  const schema = json('contracts/schemas/secret-envelope.schema.json');
  const vector = json('contracts/test-vectors/sync-v1.json');
  assert.equal(schema.properties.alg.const, 'ML-KEM-768+HKDF-SHA256+AES-256-GCM');
  assert.deepEqual(schema.required, ['v', 'alg', 'kem', 'aead', 'ct', 'iv', 'tag', 'data', 'aad', 'keyVersion', 'entityRevision']);
  const bytes = Buffer.from(vector.aad.hex, 'hex');
  const expected = Buffer.from(vector.aad.utf8Text.replaceAll('\\0', '\0'), 'utf8');
  assert.deepEqual(bytes, expected);
  assert.equal(bytes.filter((byte) => byte === 0).length, vector.aad.fields.length - 1);
});

test('sync state machine resolves bootstrap ordering and crash recovery', () => {
  const text = read('SYNC_STATE_MACHINE.md');
  assert.match(text, /BOOTSTRAP_PAGE until complete/);
  assert.match(text, /CATCH_UP_PULL from snapshotCursor/);
  assert.match(text, /PUSH_PENDING collected during bootstrap/);
  assert.match(text, /PULL_CHANGES again/);
  assert.match(text, /同 opId 重放 100 次/);
  assert.match(text, /mobile_entity_field_revisions/);
  assert.match(text, /cursor 与一页业务变更处于同一事务/);
});

test('screen catalog places retained server settings and backup restore', () => {
  const text = read('SCREEN_CATALOG.md');
  assert.match(text, /工具 → 服务器 → 设置/);
  assert.match(text, /工具 → 服务器 → 备份与恢复/);
  assert.match(text, /S48 服务器设置/);
  assert.match(text, /S49 备份与恢复/);
  assert.doesNotMatch(text, /账号安全[^\n]*一级内容/);
});

test('parity spec inherits Zephyr facts without inheriting Web UI', () => {
  const text = read('ZEPHYR_PARITY.md');
  for (const source of ['authz.js', 'resource-service.js', 'notes-service.js', 'workspace-service.js', 'deeplink-service.js', 'file-transfer-protocol.js']) {
    assert.match(text, new RegExp(source.replace('.', '\\.')));
  }
  assert.match(text, /不能机械搬/);
  assert.match(text, /WebView/);
  assert.match(text, /readOnly.*provider/s);
});

test('implementation status does not falsely claim native code exists', () => {
  const status = read('IMPLEMENTATION_STATUS.md');
  assert.match(status, /Android Kotlin\/Compose[^\n]*`missing`/);
  assert.match(status, /iOS Swift\/SwiftUI[^\n]*`missing`/);
  assert.match(status, /mobile v1 server API[^\n]*`missing`/);
  assert.match(status, /完整双向同步[^\n]*`specified`/);
});

test('JSON Schemas compile strictly and reject the negative operation vector', () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const schemas = [
    'contracts/schemas/error.schema.json',
    'contracts/schemas/secret-envelope.schema.json',
    'contracts/schemas/sync-operation.schema.json',
    'contracts/schemas/sync-change.schema.json',
  ].map(json);
  for (const schema of schemas) ajv.addSchema(schema);
  for (const schema of schemas) assert.equal(typeof ajv.getSchema(schema.$id), 'function', `failed to compile ${schema.$id}`);
  const validate = ajv.getSchema('https://zephyr.local/contracts/sync-operation.schema.json');
  const vectors = json('contracts/test-vectors/sync-v1.json');
  assert.equal(validate(vectors.operations.acceptedUpsert), true, JSON.stringify(validate.errors));
  assert.equal(validate(vectors.operations.invalidMissingMask), false, 'negative vector unexpectedly passed');
});

test('legacy One and current server still visibly lack mobile v1 implementation', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const one = fs.readFileSync(path.join(root, 'one-client-manager.js'), 'utf8');
  assert.doesNotMatch(server, /app\.(?:get|post|patch|delete)\('\/api\/mobile\/v1/);
  assert.match(one, /\/api\/one\/sync\/pull/);
  assert.match(one, /Build a user-scoped sync snapshot/);
});
