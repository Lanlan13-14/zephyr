import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import aiAgent from '../ai-agent-service.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mobile = path.join(root, 'FREEZE', 'zephyr one for mobile');
const read = (relative) => fs.readFileSync(path.join(mobile, relative), 'utf8');
const json = (relative) => JSON.parse(read(relative));

const requiredDocs = [
  'README.md', 'PRODUCT_REQUIREMENTS.md', 'DEVELOPMENT.md',
  'ZEPHYR_PARITY.md', 'SCREEN_CATALOG.md', 'SYNC_STATE_MACHINE.md',
  'DATA_AND_MIGRATION.md', 'NATIVE_ENGINE_DECISIONS.md',
  'MOBILE_EXPERIENCE.md', 'TERMINAL_EXPERIENCE.md',
  'REMOTE_DESKTOP_EXPERIENCE.md', 'AI_FLOATING_WORKSPACE.md',
  'SHARED_RESOURCE_RESIDENCY.md',
  'TRACEABILITY.md', 'IMPLEMENTATION_STATUS.md',
];
const requiredContracts = [
  'contracts/openapi-mobile-v1.json',
  'contracts/ai-capability-baseline.json',
  'contracts/entity-registry.json',
  'contracts/error-registry.json',
  'contracts/schemas/error.schema.json',
  'contracts/schemas/sync-operation.schema.json',
  'contracts/schemas/sync-change.schema.json',
  'contracts/schemas/secret-envelope.schema.json',
  'contracts/schemas/shared-use-envelope.schema.json',
  'contracts/test-vectors/sync-v1.json',
  'contracts/test-vectors/shared-use-v1.json',
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

  // Routes marked implemented must (a) carry an implemented-<sha> marker and
  // (b) actually exist in server.js. Freezing one SHA string only breaks on
  // every rebase while proving nothing about the real server.
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const implemented = Object.entries(api.paths).filter(([, item]) => Object.values(item)
    .some((op) => op && typeof op === 'object' && String(op['x-zephyr-implementation'] || '').startsWith('implemented-')));
  assert.ok(implemented.length >= 2, 'pre-existing Zephyr auth routes must be marked implemented');
  for (const [route, item] of implemented) {
    for (const [method, op] of Object.entries(item)) {
      if (!op || typeof op !== 'object' || !op['x-zephyr-implementation']) continue;
      assert.match(op['x-zephyr-implementation'], /^implemented-[0-9a-f]{7,40}$/, `${route} marker must pin a commit`);
      assert.ok(server.includes(`app.${method}('${route}'`), `${route} claims implemented but is absent from server.js`);
    }
  }

  // Everything under /api/mobile/v1 is still an unbuilt server extension.
  for (const [route, item] of Object.entries(api.paths)) {
    if (!route.startsWith('/api/mobile/v1')) continue;
    for (const [method, op] of Object.entries(item)) {
      if (!op || typeof op !== 'object' || !op.responses) continue;
      assert.equal(op['x-zephyr-implementation'], 'required-server-extension', `${method} ${route} must not claim implemented`);
    }
  }
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

test('mobile experience freezes custom Android back and universal iOS swipe back', () => {
  const product = read('PRODUCT_REQUIREMENTS.md');
  const experience = read('MOBILE_EXPERIENCE.md');
  assert.match(product, /完整移动端原生客户端/);
  assert.match(product, /系统 back progress\/commit\/cancel/);
  assert.match(product, /所有 push 进入的普通页面/);
  assert.match(experience, /默认应用内 predictive-back/);
  assert.match(experience, /根 Activity 返回系统主页\/跨任务时交还系统动画/);
  assert.match(experience, /interactivePopGestureRecognizer/);
  assert.match(experience, /每个 push route/);
  assert.match(experience, /物理左边缘/);
});

test('terminal and remote desktop specs preserve complete mobile interaction', () => {
  const terminal = read('TERMINAL_EXPERIENCE.md');
  const remote = read('REMOTE_DESKTOP_EXPERIENCE.md');
  const engines = read('NATIVE_ENGINE_DECISIONS.md');
  for (const term of ['Termux', 'scrollback', 'selection', 'extra keys', 'PTY resize', 'hardware keyboard']) assert.match(terminal, new RegExp(term));
  for (const term of ['Direct touch', 'Trackpad', 'FreeRDP', 'VNC', 'clipboard', '弱网']) assert.match(remote, new RegExp(term));
  assert.match(engines, /FreeRDP.*Apache-2\.0/s);
  assert.doesNotMatch(engines, /FreeRDP 使用 LGPL/);
  assert.match(engines, /SwiftTerm/);
  assert.match(engines, /LibVNCClient/);
});

test('Zephyr AI is a visible floating workspace with complete live catalog parity', () => {
  const product = read('PRODUCT_REQUIREMENTS.md');
  const ai = read('AI_FLOATING_WORKSPACE.md');
  const screens = read('SCREEN_CATALOG.md');
  assert.match(product, /原生浮窗\/detent\/side panel/);
  assert.match(product, /全部 model-visible AI capability\/tool/);
  assert.match(ai, /116 个模型可见 tool/);
  assert.match(ai, /peek \/ half \/ expanded/);
  assert.match(ai, /observation → proposed action → confirmation → execution → verification/);
  assert.match(ai, /NativeSurfaceBridge/);
  assert.match(ai, /terminal_read_v1 \/ terminal_send_v1 \/ terminal_wait_v1/);
  assert.match(ai, /capture\/action\/verify\/cert/);
  assert.match(ai, /CI 与 Zephyr catalog 动态 diff/);
  assert.match(screens, /S44 AI 浮动 Workspace/);
  assert.match(screens, /底层 connection\/terminal\/RDP\/VNC/);
});

test('AI mobile baseline exactly matches the live Zephyr model-visible catalog', () => {
  const baseline = json('contracts/ai-capability-baseline.json');
  const live = aiAgent.listToolCatalog({ permissions: baseline.permissionFixture }).map((tool) => ({
    toolId: tool.name,
    capabilityId: tool.capabilityId,
    risk: tool.risk,
    confirmation: tool.confirmation,
    playbookId: tool.playbookId || null,
    parameters: tool.parameters,
  })).sort((a, b) => a.toolId.localeCompare(b.toolId));
  assert.equal(baseline.count, baseline.tools.length);
  assert.equal(baseline.count, 116, 'update the reviewed mobile AI parity baseline when Zephyr changes');
  assert.deepEqual(baseline.tools, live);
});

test('shared-to-me resources are excluded from the mobile mirror and served online only', () => {
  const product = read('PRODUCT_REQUIREMENTS.md');
  const residency = read('SHARED_RESOURCE_RESIDENCY.md');
  const parity = read('ZEPHYR_PARITY.md');
  const api = json('contracts/openapi-mobile-v1.json');

  // Product contract must scope sync to owned entities and forbid shared persistence.
  assert.match(product, /当前绑定账号\*\*自己拥有\*\*的数据进入 One 完整双向镜像/);
  assert.match(product, /分享给当前账号的资源不属于其镜像/);
  assert.match(product, /每次查看\/使用都在线请求 Zephyr 并实时重验权限/);
  assert.match(product, /其他用户共享给当前账号的资源全部排除在镜像之外/);

  // Control-plane secrets must never be delivered to the device.
  for (const forbidden of ['Client Token', 'AI Provider', 'Env secret']) {
    assert.match(residency, new RegExp(forbidden), `residency spec must forbid ${forbidden}`);
  }
  // The honest security statement must survive: encryption is not a proof of non-delivery.
  assert.match(residency, /best-effort memory zeroization/);
  assert.match(residency, /不能被描述为数学上保证秘密从未出现在设备/);
  assert.match(residency, /native direct connection 与“秘密不进入设备”不能同时成立/);
  assert.match(residency, /relay-strict/);
  assert.doesNotMatch(residency, /保证秘密从未到达设备/);

  // Sync boundary is enforced on both sides, not only in the UI.
  assert.match(residency, /ownerUserId == authenticated userId/);
  assert.match(residency, /shared_residency_violation/);
  assert.match(parity, /shared-to-me/);

  // Online-only shared endpoints exist and are separated from the sync feed.
  const paths = Object.keys(api.paths);
  for (const expected of [
    '/api/mobile/v1/shared',
    '/api/mobile/v1/shared/{resourceType}/{resourceId}',
    '/api/mobile/v1/shared/{resourceType}/{resourceId}/invoke',
    '/api/mobile/v1/shared/connections/{connectionId}/sessions',
    '/api/mobile/v1/shared/sessions/{sessionId}/refresh',
    '/api/mobile/v1/shared/sessions/{sessionId}',
  ]) {
    assert.ok(paths.includes(expected), `OpenAPI missing ${expected}`);
  }
  const listGet = api.paths['/api/mobile/v1/shared'].get;
  assert.equal(listGet['x-zephyr-no-store'], true, 'shared list must be declared no-store');
  const sessionPost = api.paths['/api/mobile/v1/shared/connections/{connectionId}/sessions'].post;
  assert.equal(sessionPost['x-zephyr-no-store'], true, 'shared session mint must be declared no-store');
});

test('shared use envelope schema binds device, session, resource and purpose', () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const schema = json('contracts/schemas/shared-use-envelope.schema.json');
  ajv.addSchema(schema);
  const validate = ajv.getSchema(schema.$id);
  assert.equal(typeof validate, 'function', 'shared use envelope schema failed to compile');

  const vectors = json('contracts/test-vectors/shared-use-v1.json');
  assert.equal(validate(vectors.envelopes.acceptedSsh), true, JSON.stringify(validate.errors));
  assert.equal(validate(vectors.envelopes.invalidPurpose), false, 'sftp purpose must be rejected by the session envelope');
  assert.equal(validate(vectors.envelopes.forbiddenControlPlaneField), false, 'control-plane fields must be rejected');

  // AAD must bind every scope field; a shared envelope reused elsewhere has to fail.
  const aad = Buffer.from(vectors.aad.base64, 'base64');
  assert.equal(aad.toString('hex'), vectors.aad.hex, 'aad hex and base64 disagree');
  assert.deepEqual(aad.toString('utf8').split('\0'), vectors.aad.values);
  for (const field of ['deviceId', 'sessionId', 'resourceId', 'purpose', 'expiresAt', 'clientNonce']) {
    assert.ok(vectors.aad.fields.includes(field), `aad must bind ${field}`);
  }
  const negatives = new Set(vectors.negativeCases.map((item) => item.id));
  for (const id of ['wrong-device', 'wrong-session', 'wrong-resource', 'wrong-purpose', 'expired', 'replay']) {
    assert.ok(negatives.has(id), `missing negative case ${id}`);
  }

  // Control-plane secrets are named explicitly so a future payload change trips the test.
  for (const key of ['clientToken', 'aiProviderApiKey', 'aiEnvValue', 'serverDataKey', 'ownerSid', 'refreshCredential']) {
    assert.ok(vectors.forbiddenPayloadKeys.includes(key), `forbidden payload key list must contain ${key}`);
    assert.equal(Object.prototype.hasOwnProperty.call(schema.properties, key), false, `${key} must not be a schema property`);
  }
});

test('shared residency errors are registered with deterministic client actions', () => {
  const registry = json('contracts/error-registry.json');
  const byCode = new Map(registry.errors.map((item) => [item.code, item]));
  const expected = {
    shared_online_required: 503,
    shared_grant_expired: 410,
    shared_grant_revoked: 410,
    shared_residency_violation: 409,
    shared_direct_forbidden: 403,
    shared_session_expired: 410,
    shared_session_consumed: 409,
    shared_relay_unavailable: 503,
    shared_content_export_forbidden: 403,
  };
  for (const [code, status] of Object.entries(expected)) {
    const entry = byCode.get(code);
    assert.ok(entry, `error registry missing ${code}`);
    assert.equal(entry.httpStatus, status, `${code} http status drift`);
    assert.ok(entry.clientAction && entry.clientAction.length > 2, `${code} needs a client action`);
  }
  assert.equal(byCode.get('shared_residency_violation').clientAction, 'abortSyncAndPurgeShared');
  assert.equal(byCode.get('shared_session_consumed').clientAction, 'mintFreshSessionEnvelope');
});

test('legacy One and current server still visibly lack mobile v1 implementation', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const one = fs.readFileSync(path.join(root, 'one-client-manager.js'), 'utf8');
  assert.doesNotMatch(server, /app\.(?:get|post|patch|delete)\('\/api\/mobile\/v1/);
  assert.match(one, /\/api\/one\/sync\/pull/);
  assert.match(one, /Build a user-scoped sync snapshot/);
});
