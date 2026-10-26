import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const read = (name) => fs.readFileSync(path.join(here, name), 'utf8');
const readJson = (name) => JSON.parse(read(name));
const spec = read('ZEPHYR-LINK-INTERCONNECTION-SPEC.md');
const gates = read('TESTING-AND-RELEASE-GATES.md');
const decisions = readJson('contracts/decision-record-v1.json');

assert.equal(Object.keys(decisions.decisions).length, 15, 'D1-D15 must be complete');
for (let i = 1; i <= 15; i += 1) {
  assert.ok(decisions.decisions[`D${i}`], `missing D${i}`);
  assert.match(spec, new RegExp(`\\bD${i}\\b`), `D${i} missing from specification`);
}
assert.match(spec, /Agent 本机用户策略（最终上限）/);
assert.match(spec, /必须取交集，不得取并集/);
assert.match(spec, /最终授权裁决在 Agent 本机/);
assert.equal(decisions.agentAuthority.finalDecision, 'agent_device');
assert.equal(decisions.agentAuthority.primaryMayNotEscalateBeyondAgentLocalPolicy, true);

const codec = fs.readFileSync(path.join(repo, 'link-v2-codec.js'), 'utf8');
const goCodec = fs.readFileSync(path.join(repo, 'zephyr-link/internal/codec/codec.go'), 'utf8');
const expectedKinds = [
  ['SYNC_OP', 'SyncOp', 'owned-sync', 'OwnedSync'],
  ['SYNC_ACK', 'SyncAck', 'owned-sync', 'OwnedSync'],
  ['BLOB_MANIFEST', 'BlobManifest', 'blob', 'Blob'],
  ['BLOB_CHUNK', 'BlobChunk', 'blob', 'Blob'],
  ['BLOB_HAVE', 'BlobHave', 'blob', 'Blob'],
  ['WAKE', 'Wake', 'control', 'Control'],
  ['RELAY', 'Relay', 'shared-terminal', 'SharedTerminal'],
  ['CONTROL', 'Control', 'control', 'Control'],
  ['SECRET', 'Secret', 'secret', 'Secret'],
  ['FILE_BRIDGE', 'FileBridge', 'file-bridge', 'FileBridge'],
  ['SHARED_TERMINAL', 'SharedTerminal', 'shared-terminal', 'SharedTerminal'],
  ['SHARED_REMOTE', 'SharedRemote', 'shared-remote', 'SharedRemote'],
  ['SHARED_NOTE', 'SharedNote', 'shared-note', 'SharedNote'],
  ['SHARED_FILE', 'SharedFile', 'shared-file', 'SharedFile'],
  ['AI', 'AI', 'ai', 'AI'],
  ['AGENT_TUNNEL', 'AgentTunnel', 'agent-tunnel', 'AgentTunnel'],
];
const expectedChannels = new Map(expectedKinds.map(([, , channel]) => [channel, true]));
const nodeMappings = new Map([...codec.matchAll(/\[KIND\.([A-Z_]+)\]: CHANNEL\.([A-Z_]+)/g)]
  .map(([, kind, channel]) => [kind, channel]));
const goMappings = new Map([...goCodec.matchAll(/Kind([A-Za-z]+):\s+Channel([A-Za-z]+),/g)]
  .map(([, kind, channel]) => [kind, channel]));
assert.equal(nodeMappings.size, expectedKinds.length, 'Node mapping must cover every kind exactly once');
assert.equal(goMappings.size, expectedKinds.length, 'Go mapping must cover every kind exactly once');
expectedKinds.forEach(([kind, goKind, channel, goChannel], index) => {
  assert.match(codec, new RegExp(`${kind}: ${index + 1}\\b`), `Node kind ${kind}`);
  assert.match(goCodec, new RegExp(`Kind${goKind}\\s*=\\s*${index + 1}\\b`), `Go kind ${goKind}`);
  const nodeChannel = nodeMappings.get(kind);
  assert.ok(nodeChannel, `Node mapping ${kind} missing`);
  assert.ok(codec.includes(`${nodeChannel}: '${channel}'`), `Node mapping ${kind} must be ${channel}`);
  assert.equal(goMappings.get(goKind), goChannel, `Go mapping ${goKind} must be ${goChannel}`);
});
function assertKindRegistry(nodeSource, goSource) {
  expectedKinds.forEach(([kind, goKind], index) => {
    assert.match(nodeSource, new RegExp(`${kind}: ${index + 1}\\b`), `Node kind ${kind}`);
    assert.match(goSource, new RegExp(`Kind${goKind}\\s*=\\s*${index + 1}\\b`), `Go kind ${goKind}`);
  });
}
assertKindRegistry(codec, goCodec);
assert.throws(
  () => assertKindRegistry(codec.replace('SYNC_OP: 1', 'SYNC_OP: 99'), goCodec),
  /Node kind SYNC_OP/,
  'a deliberately corrupted Node kind must fail the registry check',
);
assert.throws(
  () => assertKindRegistry(codec, goCodec.replace('KindAI = 15', 'KindAI = 99')),
  /Go kind AI/,
  'a deliberately corrupted Go kind must fail the registry check',
);
assert.equal(goMappings.has('NotAKind'), false, 'unknown Go kind must not be accepted');
assert.equal(expectedChannels.size, 11, 'the eleven isolated channel names must remain distinct');

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validators = {};
for (const name of ['link-frame-envelope-v1.example.json', 'agent-policy-v1.example.json', 'change-impact-v1.example.json']) {
  const schema = readJson(`contracts/${name}`);
  const validate = ajv.compile(schema);
  validators[name] = validate;
  assert.equal(validate({}), false, 'empty document must fail required properties');
}

const validateFrame = validators['link-frame-envelope-v1.example.json'];
const validFrame = {
  protocol: 'zephyr-link', protocolVersion: 2, schemaVersion: 1, kind: 15,
  operation: 'ai.command.dispatch', requestId: 'req_12345678', idempotencyKey: 'idem_12345678',
  deviceId: 'dev-1', bindingGeneration: 'gen-1', capability: 'ai.execute',
  sessionId: null, sessionEpoch: null, deadlineAt: 0, body: { prompt: 'status' },
};
assert.ok(validateFrame(validFrame), JSON.stringify(validateFrame.errors));
assert.equal(validateFrame({ ...validFrame, kind: 17 }), false, 'unregistered kind must fail');
assert.equal(validateFrame({ ...validFrame, extra: true }), false, 'unknown envelope field must fail');

const validatePolicy = validators['agent-policy-v1.example.json'];
const validPolicy = {
  schemaVersion: 1, agentId: 'agent-1', policyGeneration: 1, defaultEffect: 'deny',
  rules: [{ ruleId: 'rule_read', subjects: ['user:alice'], channels: ['file-bridge'], operations: ['read'], shares: ['projects'], effect: 'allow', limits: { maxInflight: 4, maxChunkBytes: 262144 } }],
};
assert.ok(validatePolicy(validPolicy), JSON.stringify(validatePolicy.errors));
assert.equal(validatePolicy({ ...validPolicy, defaultEffect: 'allow' }), false, 'default allow must fail');
assert.equal(validatePolicy({ ...validPolicy, rules: [{ ...validPolicy.rules[0], channels: ['private'] }] }), false);

function evaluateAgentAuthority(input) {
  const { request, agentLocal, primaryAcl, systemGrant, session } = input;
  if (request.operation === 'delete' && session.confirmed !== true) return 'delete_requires_confirmation';
  if (session.policyGeneration !== agentLocal.policyGeneration) return 'agent_policy_generation_stale';
  if (agentLocal.effect !== 'allow'
    || !agentLocal.operations.includes(request.operation)
    || (request.share && !agentLocal.shares.includes(request.share))) return 'agent_local_policy_denied';
  if (primaryAcl.effect !== 'allow' || !primaryAcl.operations.includes(request.operation)) return 'primary_acl_denied';
  if (systemGrant.effect !== 'allow' || !systemGrant.operations.includes(request.operation)) return 'system_grant_denied';
  return null;
}
const authorityCases = readJson('contracts/agent-authorization-v1.cases.json');
assert.deepEqual(authorityCases.map((test) => test.id), [
  'AGENT-ACL-001', 'AGENT-ACL-002', 'AGENT-ACL-003', 'AGENT-ACL-005', 'AGENT-ACL-ALLOW-001',
]);
for (const test of authorityCases) {
  const rejection = evaluateAgentAuthority(test);
  assert.equal(rejection ?? 'allow', test.expected.effect === 'allow' ? 'allow' : test.expected.effect === 'deny' ? test.expected.code : 'unexpected', test.id);
}
assert.equal(evaluateAgentAuthority({
  request: { channel: 'file-bridge', operation: 'delete', share: 'projects' },
  agentLocal: { effect: 'allow', operations: ['read', 'delete'], shares: ['projects'], policyGeneration: 5 },
  primaryAcl: { effect: 'allow', operations: ['delete'] },
  systemGrant: { effect: 'allow', operations: ['delete'] },
  session: { policyGeneration: 5, confirmed: false },
}) ?? 'delete_requires_confirmation', 'delete_requires_confirmation', 'high-level delete confirmation must be explicit');

const validateImpact = validators['change-impact-v1.example.json'];
const validImpact = {
  channels: ['owned-sync'], platforms: ['server', 'desktop'], dataDomains: ['owned'],
  states: ['bound', 'offline'], protocolImpact: ['additive'], dataImpact: ['cursor'],
  requiredEvidence: ['L1', 'L2', 'L4', 'L6'], failureInjections: ['kill', 'offline'],
  compatibility: ['old-client-new-server'], rollback: ['restore database backup'], evidenceLinks: [],
};
assert.ok(validateImpact(validImpact), JSON.stringify(validateImpact.errors));
assert.equal(validateImpact({ ...validImpact, requiredEvidence: ['unit'] }), false);

const markdownLinks = [...spec.matchAll(/\[[^\]]+\]\(([^)]+)\)/g), ...gates.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)];
for (const [, link] of markdownLinks) {
  if (/^(https?:|#)/.test(link)) continue;
  assert.ok(fs.existsSync(path.resolve(here, link)), `broken documentation link: ${link}`);
}
for (const required of [
  'SYNC-CAS-001', 'SYNC-CUR-001', 'SYNC-CON-005', 'SYNC-SEC-001',
  'AGENT-ACL-001', 'AGENT-ACL-008', 'L0', 'L8', 'NO-GO',
]) assert.ok(gates.includes(required), `missing mandatory test item ${required}`);
assert.ok(fs.existsSync(path.join(here, 'verify-docs.mjs')));

console.log(JSON.stringify({
  ok: true,
  decisions: Object.keys(decisions.decisions).length,
  frozenKinds: expectedKinds.length,
  schemas: 3,
  documentationLinks: markdownLinks.length,
  mandatoryRegressionAnchors: 7,
  intentionalFailureCases: ['node-kind-drift', 'go-kind-drift', 'empty-schema-document', 'invalid-frame', 'invalid-policy', 'invalid-impact', 'agent-authority-intersection', 'delete-without-confirmation'],
  agentAuthorityCases: authorityCases.length,
  agentAuthority: decisions.agentAuthority.rule,
}, null, 2));
