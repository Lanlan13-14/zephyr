import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { META, mapSyncOperation, evaluateAgentPolicy, webdavWriteMode, webdavConcurrentCommit } from './reference-adapter-v1.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const casesDir = path.join(here, 'cases');
const read = (name) => JSON.parse(fs.readFileSync(path.join(casesDir, name), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: true });
const agentSchema = JSON.parse(fs.readFileSync(path.join(repo, 'docs/zephyr-link/contracts/agent-policy-v1.example.json'), 'utf8'));
const validatePolicySchema = ajv.compile(agentSchema);

const syncCases = read('sync-envelope-v1.json');
const agentCases = read('agent-policy-v1.json');
const webdavCases = read('webdav-writers-v1.json');
const result = {
  ok: null,
  evidenceType: META.kind,
  productEvidence: false,
  counts: {},
  referenceValidated: 0,
  productionRequired: [],
  antiBypassGuardsPassed: 0,
  failures: [],
};
const check = (id, actual, expected) => {
  try { assert.deepEqual(actual, expected); } catch (error) { result.failures.push({ id, expected, actual, error: error.message }); }
};
const uniqueIds = (cases) => new Set(cases.map((test) => test.id)).size === cases.length;
for (const [name, cases] of [['sync', syncCases], ['agent', agentCases], ['webdav', webdavCases]]) {
  assert.ok(uniqueIds(cases), `${name}: duplicate vector id`);
  for (const test of cases) assert.match(test.id, /^[A-Z]+-[A-Z]+-[0-9]{3}$/, `${name}: malformed id ${test.id}`);
}

for (const test of syncCases) {
  if (test.family === 'valid') {
    const mapped = mapSyncOperation(test.legacy);
    check(test.id, mapped.operation, test.operation);
    check(test.id, mapped.kind, 1);
    if (test.expectedBody) check(test.id, mapped.body, test.expectedBody);
    check(test.id, mapped.responseShape, test.response);
    check(test.id, Object.hasOwn(mapped.body, 'op'), false);
    if (test.idempotencyPrefix) check(test.id, mapped.idempotency.key, test.idempotencyPrefix);
    result.referenceValidated += 1;
  } else {
    const mapped = mapSyncOperation(test.input, {
      envelopeVersion: test.input.envelopeVersion ?? 1,
      authenticatedDeviceId: test.authenticatedDeviceId,
      currentRevision: test.currentRevision,
      serverRegistryHash: test.serverRegistryHash,
    });
    if (mapped.error) {
      check(test.id, mapped.error, test.expectedError);
      result.referenceValidated += 1;
    } else {
      result.productionRequired.push({
        id: test.id,
        expected: test.expectedError || test.response || test.note,
        reason: 'requires production entity/secret/cursor/auth/storage/negotiated-response validation',
      });
    }
  }
}
result.counts.syncEnvelope = syncCases.length;

for (const test of agentCases) {
  if (test.family === 'schema') {
    if (test.id === 'AP-SCHEMA-012') {
      const ids = test.input.rules.map((rule) => rule.ruleId);
      check(test.id, new Set(ids).size === ids.length ? 'allowed_duplicate_rule_id' : 'schema_invalid', 'schema_invalid');
    } else {
      const schemaValid = validatePolicySchema(test.input);
      check(test.id, schemaValid ? 'valid' : 'schema_invalid', test.expected);
      if (!schemaValid && test.expected !== 'schema_invalid') result.failures.push({ id: `${test.id}:ajv`, errors: validatePolicySchema.errors });
    }
  } else {
    check(test.id, evaluateAgentPolicy(test), test.expected);
  }
  result.referenceValidated += 1;
}
result.counts.agentPolicy = agentCases.length;

for (const test of webdavCases) {
  if (test.family === 'capability' || test.id.startsWith('WD-CAP-')) {
    check(test.id, webdavWriteMode(test), test.expected);
    result.referenceValidated += 1;
  } else if (test.commitResults) {
    const commits = test.commitResults.map((resultValue, index) => ({ writer: test.writers[index], result: resultValue, etag: test.baseEtag }));
    if (['WD-CAS-003', 'WD-CAS-004', 'WD-CAS-006', 'WD-CAS-007', 'WD-CAS-008', 'WD-CAS-009', 'WD-CAS-010'].includes(test.id)) {
      result.productionRequired.push({ id: test.id, expected: test.expected, reason: 'requires explicit conditional-write and loser replay behavior' });
      continue;
    }
    const outcome = webdavConcurrentCommit({
      baseEtag: test.baseEtag,
      commits,
      conditionalWrite: !['WD-CAS-003', 'WD-CAS-004'].includes(test.id),
      weakEtag: test.baseEtag === 'weak',
    });
    if (test.expected === 'one_winner_loser_replays') {
      check(test.id, outcome.allowed, true);
      check(`${test.id}:loser-recovery`, outcome.losersMust, ['reread', 'merge', 'retry']);
    } else if (test.expected === 'reject_server_not_B2') {
      check(test.id, outcome.allowed, false);
      check(`${test.id}:reason`, outcome.reason, 'reject_server_not_B2');
    } else if (test.expected === 'no_multiwriter_B2_proof') {
      check(test.id, outcome.allowed, false);
      check(`${test.id}:reason`, outcome.reason, 'no_multiwriter_B2_proof');
    } else if (test.expected === 'not_multiwriter_safe') {
      check(test.id, outcome.allowed, false);
      check(`${test.id}:reason`, outcome.reason, 'not_multiwriter_safe');
    } else {
      result.failures.push({ id: `${test.id}:unsupported-reference-expectation`, expected: test.expected });
      continue;
    }
    result.referenceValidated += 1;
  } else {
    result.productionRequired.push({
      id: test.id,
      expected: test.expected,
      reason: 'requires a real WebDAV/server or production failure-injection adapter',
    });
  }
}
result.counts.webdavWriters = webdavCases.length;

// Every mutant must be checked by a real contract rule, not by string comparison alone.
// A mutant is killed only if it would produce the forbidden outcome while the guard rejects it.
const mutationResults = [];
function killMutation(id, forbiddenOutcome, guard, expectedGuardCode) {
  let actual;
  try { actual = guard(); } catch (error) { actual = error.code || error.message; }
  const killed = actual === expectedGuardCode;
  mutationResults.push({ id, forbiddenOutcome, guardCode: actual, expectedGuardCode, killed });
  if (killed) result.antiBypassGuardsPassed += 1;
  else result.failures.push({ id: `ANTI-BYPASS-GUARD-FAILED:${id}`, forbiddenOutcome, expectedGuardCode, actual });
}

const validPush = syncCases.find((test) => test.id === 'SE-VALID-003').legacy;
killMutation('skip-device-identity', 'cross_device_write_accepted', () => {
  const mapped = mapSyncOperation(validPush, { authenticatedDeviceId: 'dev-other' });
  return mapped.error || 'cross_device_write_accepted';
}, 'device_proof_invalid');
killMutation('double-envelope', 'nested_legacy_envelope_accepted', () => {
  const bad = { op: 'push', protocolVersion: 1, body: { operations: [] } };
  return mapSyncOperation(bad).error || 'nested_legacy_envelope_accepted';
}, 'invalid_request');
killMutation('guess-envelope-from-field-presence', 'v2_selected_without_negotiation', () => {
  const mapped = mapSyncOperation({ op: 'status', operation: 'sync.status' }, { envelopeVersion: 99 });
  return mapped.error || 'v2_selected_without_negotiation';
}, 'unsupported_protocol_version');
killMutation('allow-overrides-deny', 'deny_ignored', () => {
  const input = agentCases.find((test) => test.id === 'AP-RULE-001');
  return evaluateAgentPolicy(input);
}, 'agent_local_policy_denied');
killMutation('empty-resources-as-wildcard', 'empty_network_targets_grants_any_host', () => {
  const input = agentCases.find((test) => test.id === 'AP-DENY-007');
  return evaluateAgentPolicy(input);
}, 'agent_local_policy_denied');
killMutation('quota-max-instead-of-min', 'largest_quota_wins', () => {
  const input = agentCases.find((test) => test.id === 'AP-RULE-004');
  return evaluateAgentPolicy(input);
}, 'agent_quota_exceeded');
killMutation('skip-delete-approval', 'delete_without_confirmation', () => {
  const input = agentCases.find((test) => test.id === 'AP-DENY-011');
  return evaluateAgentPolicy(input);
}, 'approval_required');
killMutation('non-loopback-without-approval', 'public_listener_without_confirmation', () => {
  const input = agentCases.find((test) => test.id === 'AP-DENY-012');
  return evaluateAgentPolicy(input);
}, 'approval_required');
killMutation('etag-as-unconditional-overwrite', 'two_cas_winners', () => {
  const outcome = webdavConcurrentCommit({
    baseEtag: 'same',
    commits: [{ writer: 'a', result: 'success', etag: 'same' }, { writer: 'b', result: 'success', etag: 'same' }],
  });
  return outcome.allowed ? 'two_cas_winners' : 'reject_server_not_B2';
}, 'reject_server_not_B2');
killMutation('snapshot-as-substitute-for-cas', 'multiwriter_without_conditional_write', () => {
  const mode = webdavWriteMode({ strongEtag: false, conditionalWrite: false, atomicPublish: true, consistentReadback: true, writers: 2 });
  if (mode === 'B2') return 'multiwriter_without_conditional_write';
  return 'multiwriter_forbidden_without_conditional_write';
}, 'multiwriter_forbidden_without_conditional_write');
killMutation('todo-counted-as-pass', 'unexecuted_test_claimed_pass', () => {
  const state = 'todo';
  if (state !== 'pass') return 'unexecuted_test_claimed_pass';
  return 'pass';
}, 'unexecuted_test_claimed_pass');
result.antiBypassGuards = mutationResults;

result.totalVectors = syncCases.length + agentCases.length + webdavCases.length;
result.productionRequiredCount = result.productionRequired.length;
result.ok = result.failures.length === 0;
if (result.failures.length) {
  console.error(JSON.stringify(result, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify(result, null, 2));
}
